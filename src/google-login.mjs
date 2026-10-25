// Wrap the unchanged shared GoogleAuth. This integration does not call Drive,
// expose tokens, bind an account to local marks or persist authorization.
export class GoogleLogin {
  #auth; #generation = 0; #phase = 'idle'; #ready = false; #error = '';
  constructor({ Auth, clientId, onChange = () => {} } = {}) {
    this.Auth = Auth; this.clientId = clientId; this.onChange = onChange;
  }
  get state() {
    const connected = this.#auth?.connected === true;
    return { phase: this.#phase === 'connected' && !connected ? 'expired' : this.#phase,
      ready: this.#ready && (this.#phase !== 'connected' || connected), connected, error: this.#error,
      expiresAt: connected ? this.#auth.info?.expiresAt ?? 0 : 0 };
  }
  #emit() { this.onChange(this.state); }
  #discard() {
    ++this.#generation;
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
  disconnect() { this.#discard(); this.#phase = 'idle'; this.#error = ''; this.#emit(); }
}
