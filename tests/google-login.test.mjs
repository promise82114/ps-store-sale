import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { GoogleLogin } from '../src/google-login.mjs';

const sharedSource = await readFile(new URL('../web/shared/google-auth.js', import.meta.url), 'utf8');
const configSource = await readFile(new URL('../web/cloud-config.js', import.meta.url), 'utf8');
function harness({ loaded = true, request } = {}) {
  let clock = 1_000_000, timerId = 0, externalRequests = 0, storageAccesses = 0;
  const timers = new Map(), clients = [], requests = [], scripts = [], changes = [];
  const google = { accounts: { oauth2: {
    initTokenClient(options) {
      const client = { options, requestAccessToken(request) { requests.push(request); } };
      clients.push(client); return client;
    },
    hasGrantedAllScopes(response, scope) { return response.scope === scope; }
  } } };
  const window = loaded ? { google } : {};
  const blockedStorage = new Proxy({}, { get() { storageAccesses++; throw Error('Unexpected persistence'); } });
  runInNewContext(configSource, { window });
  runInNewContext(sharedSource, { window, Date: { now: () => clock },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); }, localStorage: blockedStorage, sessionStorage: blockedStorage,
    fetch() { externalRequests++; throw Error('Unexpected external request'); },
    document: { createElement() { return { remove() {} }; }, head: { append(script) { scripts.push(script); } } } });
  const login = new GoogleLogin({ Auth: window.SideProjectAuth.GoogleAuth,
    clientId: window.SIDE_PROJECT_CLOUD_CONFIG.clientId, request, onChange: state => changes.push(state) });
  function reply(response = {}) {
    clients.at(-1).options.callback({ access_token: 'synthetic-test-token', expires_in: 3600,
      scope: window.SideProjectAuth.scope, ...response });
  }
  return { login, clients, requests, scripts, changes, timers, window, google, reply,
    advance(ms) { clock += ms; }, counters: () => ({ externalRequests, storageAccesses }) };
}
test('opening the page or controller does not load GIS, contact APIs or access storage', () => {
  const h = harness({ loaded: false });
  assert.equal(h.login.state.phase, 'idle'); assert.equal(h.scripts.length, 0);
  assert.equal(h.clients.length, 0); assert.equal(h.requests.length, 0);
  assert.deepEqual(h.counters(), { externalRequests: 0, storageAccesses: 0 });
});
test('preparation loads official GIS only when requested and leaves popup for a separate click', async () => {
  const h = harness({ loaded: false }), prepared = h.login.prepare();
  assert.equal(h.scripts.length, 1); assert.equal(h.scripts[0].src, 'https://accounts.google.com/gsi/client');
  h.window.google = h.google; h.scripts[0].onload();
  assert.equal(await prepared, true); assert.equal(h.login.state.ready, true);
  assert.equal(h.requests.length, 0);
});
test('popup is requested synchronously by connect using the existing client and appdata scope', async () => {
  const h = harness(); await h.login.prepare();
  const pending = h.login.connect();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].prompt, 'select_account');
  assert.equal(h.clients[0].options.client_id, h.window.SIDE_PROJECT_CLOUD_CONFIG.clientId);
  assert.equal(h.clients[0].options.include_granted_scopes, false);
  assert.equal(h.clients[0].options.scope, 'https://www.googleapis.com/auth/drive.appdata');
  h.reply(); assert.equal(await pending, true);
  assert.equal(h.login.state.connected, true); assert.ok(h.login.state.expiresAt > 0);
  assert.ok(!JSON.stringify(h.changes).includes('synthetic-test-token'));
  assert.deepEqual(h.counters(), { externalRequests: 0, storageAccesses: 0 });
  h.login.disconnect(); assert.equal(h.login.state.connected, false);
});
for (const [name, response, code] of [['declined permission', { error: 'access_denied' }, 'denied'],
  ['missing scope', { scope: '' }, 'scope'], ['invalid lifetime', { expires_in: 'invalid' }, 'auth']]) {
  test(`${name} never produces a connected state`, async () => {
    const h = harness(); await h.login.prepare(); const pending = h.login.connect(); h.reply(response);
    assert.equal(await pending, false); assert.equal(h.login.state.error, code);
    assert.equal(h.login.state.connected, false); assert.equal(h.login.state.ready, false);
  });
}
test('popup rejection has a safe fixed code and allows a fresh retry', async () => {
  const h = harness(); await h.login.prepare(); const pending = h.login.connect();
  h.clients[0].options.error_callback({ type: 'popup_failed_to_open', message: 'private external detail' });
  assert.equal(await pending, false); assert.equal(h.login.state.error, 'popup');
  assert.ok(!JSON.stringify(h.changes).includes('private external detail'));
  assert.equal(await h.login.prepare(), true); assert.equal(h.clients.length, 2); h.login.disconnect();
});
test('cancelled prepare cannot later make the panel ready', async () => {
  const h = harness({ loaded: false }), pending = h.login.prepare(); h.login.disconnect();
  h.window.google = h.google; h.scripts[0].onload();
  assert.equal(await pending, false); assert.equal(h.login.state.phase, 'idle');
  assert.equal(h.login.state.ready, false); assert.equal(h.requests.length, 0);
});
test('late authorization after disconnect cannot revive the connection or cross into another attempt', async () => {
  const h = harness(); await h.login.prepare(); const first = h.login.connect(), oldClient = h.clients[0];
  h.login.disconnect(); assert.equal(await first, false);
  await h.login.prepare(); const second = h.login.connect();
  oldClient.options.callback({ access_token: 'synthetic-old-token', expires_in: 3600, scope: h.window.SideProjectAuth.scope });
  assert.equal(h.login.state.connected, false); assert.equal(h.login.state.phase, 'authorizing');
  h.reply(); assert.equal(await second, true); h.login.disconnect();
});
test('authorization expiry clears the connection and requires a new prepared instance', async () => {
  const h = harness(); await h.login.prepare(); const pending = h.login.connect(); h.reply(); await pending;
  const expiry = [...h.timers.values()].find(timer => timer.delay === 3_600_000);
  h.advance(3_600_001); expiry.callback();
  assert.equal(h.login.state.phase, 'expired'); assert.equal(h.login.state.ready, false);
  assert.equal(h.login.state.connected, false); assert.equal(h.login.state.expiresAt, 0);
  await h.login.prepare(); assert.equal(h.clients.length, 2); h.login.disconnect();
});
test('repeated clicks cannot create concurrent popup requests', async () => {
  const h = harness(); await h.login.prepare(); const first = h.login.connect();
  assert.equal(await h.login.connect(), false); assert.equal(h.requests.length, 1);
  h.login.disconnect(); assert.equal(await first, false);
});
test('missing configuration fails without loading Google or exposing exception text', async () => {
  const login = new GoogleLogin(); assert.equal(await login.prepare(), false);
  assert.equal(login.state.error, 'config'); assert.equal(login.state.connected, false);
});

const aboutEndpoint = 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)';
async function connectedHarness(request) {
  const h = harness({ request }); await h.login.prepare(); const pending = h.login.connect(); h.reply(); await pending; return h;
}
test('Drive requests require explicit connected authorization', async () => {
  let calls = 0; const h = harness({ request: () => { calls++; } });
  await assert.rejects(h.login.request(aboutEndpoint), error => error.code === 'AUTH_REQUIRED'); assert.equal(calls, 0);
});
test('Drive facade supplies only in-memory credentials and strict network options', async () => {
  let captured;
  const h = await connectedHarness(async (url, options) => { captured = { url, options }; return new Response('{}'); });
  const response = await h.login.request(aboutEndpoint); assert.equal(response.status, 200);
  assert.equal(captured.options.headers.Authorization, 'Bearer synthetic-test-token');
  assert.equal(captured.options.credentials, 'omit'); assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.referrerPolicy, 'no-referrer'); assert.equal(captured.options.cache, 'no-store');
  assert.ok(!JSON.stringify(h.login.state).includes('synthetic-test-token')); h.login.disconnect();
});
for (const [name, url, options, code] of [
  ['other host', 'https://example.test/drive/v3/about', {}, 'INVALID_DRIVE_ENDPOINT'],
  ['plain HTTP', 'http://www.googleapis.com/drive/v3/about', {}, 'INVALID_DRIVE_ENDPOINT'],
  ['delete', 'https://www.googleapis.com/drive/v3/files/id', { method: 'DELETE' }, 'INVALID_DRIVE_ENDPOINT'],
  ['outside appDataFolder', 'https://www.googleapis.com/drive/v3/files', {}, 'INVALID_DRIVE_ENDPOINT'],
  ['unconditional write', 'https://www.googleapis.com/upload/drive/v2/files/id?uploadType=media', { method: 'PUT' }, 'INVALID_ETAG'],
  ['weak ETag', 'https://www.googleapis.com/upload/drive/v2/files/id?uploadType=media', { method: 'PUT', headers: { 'If-Match': 'W/"version"' } }, 'INVALID_ETAG'],
  ['credential override', aboutEndpoint, { headers: { Authorization: 'synthetic-override' } }, 'INVALID_DRIVE_ENDPOINT'],
]) test('Drive facade rejects ' + name + ' before dispatch', async () => {
  let calls = 0; const h = await connectedHarness(async () => { calls++; return new Response('{}'); });
  await assert.rejects(h.login.request(url, options), error => error.code === code);
  assert.equal(calls, 0); h.login.disconnect();
});
test('disconnect aborts a request and rejects its late response', async () => {
  let resolve, signal; const h = await connectedHarness((url, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); });
  const pending = h.login.request(aboutEndpoint); h.login.disconnect(); assert.equal(signal.aborted, true);
  resolve(new Response('{}')); await assert.rejects(pending, error => error.code === 'SESSION_CHANGED');
});
test('expired authorization cannot dispatch a Drive request', async () => {
  let calls = 0; const h = await connectedHarness(async () => { calls++; return new Response('{}'); }); h.advance(3_600_001);
  await assert.rejects(h.login.request(aboutEndpoint), error => error.code === 'AUTH_REQUIRED'); assert.equal(calls, 0); h.login.disconnect();
});
test('Drive authorization rejection disconnects without exposing the response body', async () => {
  const h = await connectedHarness(async () => new Response('synthetic private error detail', { status: 401 }));
  await assert.rejects(h.login.request(aboutEndpoint), error => error.code === 'HTTP_401' && !error.message.includes('private'));
  assert.equal(h.login.state.connected, false);
});
