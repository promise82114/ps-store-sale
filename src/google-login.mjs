import { strongETag, fileName } from './poc04/drive-transport.mjs';

// Shared GoogleAuth keeps tokens private. Only this guarded request facade uses them.
export class GoogleLogin {
  #auth; #generation = 0; #phase = 'idle'; #ready = false; #error = '';
  #controllers = new Set();
  constructor({ Auth, clientId, request = globalThis.fetch, onChange = () => {} } = {}) {
    this.Auth = Auth; this.clientId = clientId; this.fetch = request; this.onChange = onChange;
  }
  get sessionId() { return this.#generation; }
  get state() {
    const connected = this.#auth?.connected === true;
    return { phase: this.#phase === 'connected' && !connected ? 'expired' : this.#phase,
      ready: this.#ready && (this.#phase !== 'connected' || connected), connected, error: this.#error,
      expiresAt: connected ? this.#auth.info?.expiresAt ?? 0 : 0 };
  }
  #emit() { this.onChange(this.state); }
  #discard() {
    ++this.#generation;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    const previous = this.#auth; this.#auth = undefined; this.#ready = false;
    previous?.disconnect();
  }
  #failed(error) {
    this.#discard(); this.#phase = 'error';
    this.#error = ['load', 'config', 'denied', 'scope', 'popup', 'cancelled', 'expired'].includes(error?.code) ? error.code : 'auth';
    this.#emit(); return false;
  }
  async prepare() {
    if (['preparing', 'authorizing', 'connected'].includes(this.state.phase)) return false;
    this.#discard(); this.#phase = 'preparing'; this.#error = '';
    const generation = this.#generation; this.#emit();
    try {
      if (typeof this.Auth !== 'function' || !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(this.clientId ?? ''))
        return this.#failed({ code: 'config' });
      const auth = new this.Auth(this.clientId, () => {
        if (generation !== this.#generation || this.#auth !== auth) return;
        if (auth.connected) this.#phase = 'connected';
        else if (this.#phase === 'connected') {
          this.#discard(); this.#phase = 'expired';
        }
        this.#emit();
      });
      this.#auth = auth;
      await auth.prepare();
      if (generation !== this.#generation) return false;
      this.#ready = true; this.#phase = 'ready'; this.#emit(); return true;
    } catch (error) { return generation === this.#generation ? this.#failed(error) : false; }
  }
  // No await before auth.connect(): Google popup retains the actual click gesture.
  connect() {
    if (!this.#ready || !['ready', 'expired'].includes(this.state.phase)) return Promise.resolve(false);
    const generation = this.#generation; this.#phase = 'authorizing'; this.#error = ''; this.#emit();
    try {
      const pending = this.#auth.connect({ selectAccount: true });
      return Promise.resolve(pending).then(() => {
        if (generation !== this.#generation) return false;
        if (!this.#auth.connected) return this.#failed({ code: 'auth' });
        this.#phase = 'connected'; this.#emit(); return true;
      }, error => generation === this.#generation ? this.#failed(error) : false);
    } catch (error) { return Promise.resolve(generation === this.#generation ? this.#failed(error) : false); }
  }
  async request(url, options = {}, session = this.sessionId) {
    const fail = code => { const error = new Error(code); error.code = code; throw error; };
    const guard = () => {
      if (session !== this.sessionId) fail('SESSION_CHANGED');
      if (!this.state.connected) fail('AUTH_REQUIRED');
    };
    guard();
    const parsed = new URL(url), method = options.method ?? 'GET';
    const path = parsed.pathname, id = '[A-Za-z0-9_-]{1,200}';
    const allowed = method === 'GET' && (path === '/drive/v3/about' || path === '/drive/v3/files'
      || new RegExp(`^/drive/v[23]/files/${id}$`).test(path))
      || method === 'POST' && path === '/upload/drive/v3/files' && parsed.searchParams.get('uploadType') === 'multipart'
      || method === 'PUT' && new RegExp(`^/upload/drive/v2/files/${id}$`).test(path) && parsed.searchParams.get('uploadType') === 'media';
    if (parsed.origin !== 'https://www.googleapis.com' || parsed.username || parsed.password || parsed.hash || !allowed
      || Object.keys(options.headers ?? {}).some(key => key.toLowerCase() === 'authorization')) fail('INVALID_DRIVE_ENDPOINT');
    if (method === 'PUT' && !strongETag(options.headers?.['If-Match'])) fail('INVALID_ETAG');
    if (path === '/drive/v3/files' && (parsed.searchParams.get('spaces') !== 'appDataFolder'
      || parsed.searchParams.get('q') !== `name = '${fileName}' and trashed = false`)) fail('INVALID_DRIVE_ENDPOINT');
    const controller = new AbortController(), cancel = () => controller.abort();
    this.#controllers.add(controller); options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetch(url, { method, body: options.body, signal: controller.signal,
            headers: { ...options.headers, Authorization: `Bearer ${this.#auth.token()}` },
            credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
          const text = await response.text(); guard();
          if (response.status === 401) { this.disconnect(); fail('HTTP_401'); }
          if (new TextEncoder().encode(text).byteLength > 16 * 1024 * 1024) fail('REMOTE_TOO_LARGE');
          return new Response([204, 205, 304].includes(response.status) ? null : text, { status: response.status });
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); const error = new Error('TIMEOUT'); error.code = 'TIMEOUT'; reject(error);
        }, 20_000); }),
      ]);
    } catch (error) {
      if (error.code === 'HTTP_401') throw error;
      guard();
      if (error.code) throw error;
      fail('NETWORK_ERROR');
    } finally {
      clearTimeout(timer); this.#controllers.delete(controller);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
  disconnect() { this.#discard(); this.#phase = 'idle'; this.#error = ''; this.#emit(); }
}
