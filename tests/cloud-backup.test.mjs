import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudBackup, accountUrl, validateCloudExport } from '../src/cloud-backup.mjs';
import * as state from '../src/poc04/sync-state.mjs';
import { exportBackup } from '../src/poc04/personal-data.mjs';
import { a, b, id, mark, fixture } from './fixtures/poc04.mjs';
import { mockBackend, jsonResponse, deferred } from './fixtures/mock-drive.mjs';

function harness(remote = null) {
  const backend = mockBackend(remote), original = state.classify(state.emptyState(), a, 'tracked', { changeId: id(1), updatedAt: 1 });
  let local = structuredClone(original), journal = null, backup = null, number = 1000;
  const calls = [];
  const store = {
    read: async () => structuredClone(local),
    readCloudExport: async guard => { guard?.(); return structuredClone(journal); },
    beginCloudExport: async (value, revision, guard) => {
      guard?.(); if (journal) throw Object.assign(Error(), { code: 'UNCONFIRMED_EXPORT' });
      if (local.localRevision !== revision) throw Object.assign(Error(), { code: 'STALE_SNAPSHOT' });
      journal = validateCloudExport(value);
    },
    clearCloudExport: async (expected, guard) => {
      guard?.(); if (journal && journal.id !== expected) throw Object.assign(Error(), { code: 'STALE_CLOUD_EXPORT' }); journal = null;
    },
    importBackup: async (incoming, revision, choice, guard) => {
      guard?.(); const merged = state.mergeLocalBackup(local, incoming, revision, choice);
      if (exportBackup(local.document) !== exportBackup(merged.document)) backup = structuredClone(local.document);
      local = merged; return structuredClone(local);
    },
  };
  const login = { sessionId: 1, state: { connected: true }, request: async (url, options = {}, session) => {
    if (session !== login.sessionId || !login.state.connected) throw Object.assign(Error(), { code: 'SESSION_CHANGED' });
    calls.push(url);
    const response = url === accountUrl ? jsonResponse({ user: { permissionId: login.account ?? 'account_A', emailAddress: 'demo@example.test' } }) : await backend.request(url, options);
    if (session !== login.sessionId || !login.state.connected) throw Object.assign(Error(), { code: 'SESSION_CHANGED' });
    return { ...response, json: async () => JSON.parse(await response.text()) };
  } };
  const controller = () => new CloudBackup({ store, login, uuid: () => id(++number), now: () => 100 });
  return { backend, original, store, login, calls, controller, cloud: controller(),
    local: () => structuredClone(local), journal: () => structuredClone(journal), backup: () => backup,
    edit: (key, status, n) => { local = state.classify(local, key, status, { changeId: id(n), updatedAt: n }); } };
}
const fails = (promise, code) => assert.rejects(promise, error => error.code === code);

test('cloud initialization performs no requests, writes or local changes', () => {
  const h = harness(); assert.deepEqual(h.calls, []); assert.equal(h.journal(), null); assert.deepEqual(h.local(), h.original);
});
test('empty cloud import leaves local data untouched and does not create a file', async () => {
  const h = harness(); assert.equal((await h.cloud.preview('import')).empty, true);
  assert.equal(h.backend.writes().length, 0); assert.deepEqual(h.local(), h.original);
});
test('export previews before creating and preserves local format, outbox and metadata', async () => {
  const h = harness(), preview = await h.cloud.preview('export');
  assert.equal(preview.creating, true); assert.equal(h.backend.writes().length, 0);
  assert.equal(preview.account, 'demo@example.test');
  await h.cloud.confirm(); assert.equal(h.backend.files.length, 1); assert.equal(h.journal(), null);
  assert.equal(h.backend.files[0].document.data.marks[a].status, 'tracked');
  assert.ok(h.backend.files[0].document.data.datasetId); assert.deepEqual(h.local(), h.original);
});
test('cloud export merges independent remote marks and uses protected update', async () => {
  const h = harness(fixture({ [b]: mark('ignored', 2) }));
  await h.cloud.preview('export'); await h.cloud.confirm();
  assert.equal(h.backend.files[0].document.data.marks[b].status, 'ignored');
  assert.equal(h.backend.files[0].document.data.marks[a].status, 'tracked');
  assert.equal(h.backend.writes()[0].headers['If-Match'], '"etag-1"'); assert.deepEqual(h.local(), h.original);
});
for (const choice of ['local', 'remote']) test(`import conflict follows explicit ${choice} choice and keeps backup`, async () => {
  const h = harness(fixture({ [a]: mark('ignored', 2), [b]: mark('tracked', 3) }));
  const preview = await h.cloud.preview('import'); assert.equal(preview.conflicts.length, 1);
  await h.cloud.confirm(choice);
  assert.equal(h.local().document.data.marks[a].status, choice === 'local' ? 'tracked' : 'ignored');
  assert.equal(h.local().document.data.marks[b].status, 'tracked');
  assert.equal(h.local().document.data.datasetId, null); assert.equal(h.local().base, null);
  assert.deepEqual(h.backup(), h.original.document); assert.equal(h.backend.writes().length, 0);
});
test('cloud import preserves cancellation intent instead of silently reviving a mark', async () => {
  const h = harness(fixture({ [a]: mark('tracked', 1) })); h.edit(a, 'unclassified', 2);
  assert.equal((await h.cloud.preview('import')).conflicts[0].local, 'unclassified');
  await h.cloud.confirm('local'); assert.ok(h.local().document.data.tombstones[a]);
});
for (const mode of ['import', 'export']) test(`${mode} rejects local edits after preview without losing new marks`, async () => {
  const h = harness(fixture()); await h.cloud.preview(mode); h.edit(b, 'ignored', 10);
  await fails(h.cloud.confirm(), 'STALE_SNAPSHOT');
  assert.equal(h.local().document.data.marks[b].status, 'ignored'); assert.equal(h.backend.writes().length, 0);
});
test('import rechecks remote before applying and rejects changed content', async () => {
  const h = harness(fixture()); await h.cloud.preview('import'); h.backend.files[0].version++;
  await fails(h.cloud.confirm(), 'REMOTE_CHANGED'); assert.deepEqual(h.local(), h.original);
});
test('export remote change before dispatch cancels journal without overwriting', async () => {
  const h = harness(fixture()); await h.cloud.preview('export'); h.backend.files[0].version++;
  await fails(h.cloud.confirm(), 'REMOTE_CHANGED'); assert.equal(h.journal(), null); assert.equal(h.backend.writes().length, 0);
});
test('explicit conditional rejection frees the journal for a new comparison', async () => {
  const h = harness(fixture()); await h.cloud.preview('export');
  h.backend.before = (url, options) => options.method === 'PUT' ? jsonResponse({}, 412) : null;
  await fails(h.cloud.confirm(), 'HTTP_412'); assert.equal(h.journal(), null); assert.deepEqual(h.local(), h.original);
});
test('lost create response persists journal and recovery after reload never creates a second file', async () => {
  const h = harness(); await h.cloud.preview('export');
  h.backend.afterWrite = () => { throw Error('synthetic lost response'); };
  await fails(h.cloud.confirm(), 'NETWORK_ERROR'); assert.ok(h.journal()); assert.equal(h.backend.files.length, 1);
  const reloaded = h.controller(); await fails(reloaded.preview('export'), 'UNCONFIRMED_EXPORT');
  await reloaded.recover(); assert.equal(h.journal(), null); assert.equal(h.backend.writes().length, 1);
});
test('unmatched recovery stays blocked and never retries a potentially dispatched write', async () => {
  const h = harness(); await h.cloud.preview('export'); h.backend.afterWrite = () => { throw Error(); };
  await fails(h.cloud.confirm(), 'NETWORK_ERROR'); h.backend.files[0].document = fixture({ [b]: mark('ignored', 9) });
  await fails(h.cloud.recover(), 'RECOVERY_REQUIRED'); assert.ok(h.journal()); assert.equal(h.backend.writes().length, 1);
});
test('wrong account cannot acknowledge another account pending export', async () => {
  const h = harness(); await h.cloud.preview('export'); h.backend.afterWrite = () => { throw Error(); };
  await fails(h.cloud.confirm(), 'NETWORK_ERROR'); h.login.account = 'account_B';
  await fails(h.cloud.recover(), 'CLOUD_ACCOUNT_CHANGED'); assert.ok(h.journal());
});
for (const cancel of ['cancel', 'disconnect']) test(`${cancel} invalidates preview without applying or uploading`, async () => {
  const h = harness(fixture()); await h.cloud.preview('export');
  if (cancel === 'cancel') h.cloud.cancel(); else { h.login.sessionId++; h.login.state.connected = false; }
  await fails(h.cloud.confirm(), cancel === 'cancel' ? 'CLOUD_PREVIEW_REQUIRED' : 'AUTH_REQUIRED');
  assert.equal(h.backend.writes().length, 0); assert.deepEqual(h.local(), h.original);
});
test('delayed remote response after cancel cannot create an actionable preview', async () => {
  const h = harness(fixture()), held = deferred();
  h.backend.before = async () => { await held.promise; return null; };
  const pending = h.cloud.preview('import'); await new Promise(resolve => setImmediate(resolve));
  h.cloud.cancel(); held.resolve(); await fails(pending, 'SESSION_CHANGED');
  await fails(h.cloud.confirm(), 'CLOUD_PREVIEW_REQUIRED'); assert.deepEqual(h.local(), h.original);
});
test('edits made while an export is in flight are retained locally', async () => {
  const h = harness(); await h.cloud.preview('export');
  h.backend.afterWrite = () => { h.edit(b, 'ignored', 77); };
  await h.cloud.confirm(); assert.equal(h.local().document.data.marks[b].status, 'ignored');
  assert.equal(h.backend.files[0].document.data.marks[b], undefined);
});
test('duplicate cloud files fail closed before any write', async () => {
  const h = harness(fixture()); h.backend.add(fixture());
  await fails(h.cloud.preview('export'), 'DUPLICATE_FILES'); assert.equal(h.backend.writes().length, 0);
});
test('local commit failure after confirmed upload retains a recoverable candidate', async () => {
  const h = harness(); await h.cloud.preview('export'); const clear = h.store.clearCloudExport;
  h.store.clearCloudExport = async () => { throw Error('synthetic local commit failure'); };
  await assert.rejects(h.cloud.confirm()); assert.ok(h.journal());
  h.store.clearCloudExport = clear; await h.cloud.recover(); assert.equal(h.journal(), null);
});
test('cloud export journal rejects unknown fields including credentials', () => {
  assert.throws(() => validateCloudExport({ schemaVersion: 1, id: id(9), account: 'A', candidate: fixture(), expected: null, token: 'synthetic' }));
});

test('cloud deletion after preview never recreates or overwrites automatically', async () => {
  const h = harness(fixture()); await h.cloud.preview('export'); h.backend.files.length = 0;
  await fails(h.cloud.confirm(), 'REMOTE_CHANGED'); assert.equal(h.backend.writes().length, 0); assert.equal(h.journal(), null);
});
test('missing strong cloud version blocks export but allows read-only import', async () => {
  const h = harness(fixture({ [b]: mark('ignored', 2) })); h.backend.files[0].etag = null;
  await fails(h.cloud.preview('export'), 'INVALID_ETAG'); assert.equal(h.backend.writes().length, 0);
  await h.cloud.preview('import'); await h.cloud.confirm(); assert.equal(h.local().document.data.marks[b].status, 'ignored');
});
test('a document from another project is rejected without modifying local state', async () => {
  const remote = fixture(); remote.projectId = 'another-project'; const h = harness(remote);
  await fails(h.cloud.preview('import'), 'WRONG_PROJECT'); assert.deepEqual(h.local(), h.original);
});
test('nested credentials cannot enter a durable cloud export record', async () => {
  const h = harness(fixture()); await h.cloud.preview('export');
  h.backend.afterWrite = () => { throw Error(); }; await fails(h.cloud.confirm(), 'NETWORK_ERROR');
  const journal = h.journal(); journal.expected.file.token = 'synthetic';
  assert.throws(() => validateCloudExport(journal), error => error.code === 'INVALID_CLOUD_EXPORT');
});
