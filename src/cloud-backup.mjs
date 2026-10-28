import { createDocument, exportBackup, requireData, validateDocument, validateId } from './poc04/personal-data.mjs';
import { planLocalBackup } from './poc04/sync-state.mjs';
import { resolveMerge } from './poc04/merge.mjs';
import { createMockableDrive, validateFile } from './poc04/drive-transport.mjs';

export const accountUrl = 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)';
const sameReceipt = (a, b) => a === null && b === null || !!a && !!b && a.file.id === b.file.id
  && a.file.version === b.file.version && a.file.etag === b.file.etag && exportBackup(a.document) === exportBackup(b.document);
export function validateCloudExport(value) {
  requireData(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 5
    && ['schemaVersion', 'id', 'account', 'candidate', 'expected'].every(key => Object.hasOwn(value, key))
    && value.schemaVersion === 1 && typeof value.account === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value.account), 'INVALID_CLOUD_EXPORT');
  validateId(value.id); validateDocument(value.candidate);
  requireData(value.candidate.data.datasetId !== null, 'REMOTE_UNBOUND');
  if (value.expected !== null) {
    requireData(value.expected && Object.getPrototypeOf(value.expected) === Object.prototype && Object.keys(value.expected).length === 2
      && Object.hasOwn(value.expected, 'file') && Object.hasOwn(value.expected, 'document')
      && Object.keys(value.expected.file ?? {}).length === 5
      && ['id', 'name', 'version', 'size', 'etag'].every(key => Object.hasOwn(value.expected.file, key)), 'INVALID_CLOUD_EXPORT');
    validateFile(value.expected?.file, true); validateDocument(value.expected.document);
    requireData(value.expected.document.data.datasetId === value.candidate.data.datasetId, 'LINEAGE_CHANGED');
  }
  return structuredClone(value);
}

// Manual backups leave the local document, Base, outbox and synchronization journal intact.
export class CloudBackup {
  #pending = null; #busy = false; #generation = 0;
  constructor({ store, login, createDrive = createMockableDrive, uuid = () => crypto.randomUUID(), now = Date.now } = {}) {
    this.store = store; this.login = login; this.createDrive = createDrive; this.uuid = uuid; this.now = now;
  }
  get busy() { return this.#busy; }
  cancel() { ++this.#generation; this.#pending = null; }
  #context() {
    const generation = this.#generation, session = this.login.sessionId;
    const guard = () => {
      requireData(generation === this.#generation && session === this.login.sessionId, 'SESSION_CHANGED');
      requireData(this.login.state.connected, 'AUTH_REQUIRED');
    };
    guard(); return { session, guard };
  }
  async #run(work) {
    requireData(!this.#busy, 'CLOUD_BUSY'); this.#busy = true;
    try { return await work(this.#context()); } finally { this.#busy = false; }
  }
  async #account(context) {
    const response = await this.login.request(accountUrl, {}, context.session);
    requireData(response.ok, `HTTP_${response.status}`);
    const user = (await response.json()).user;
    requireData(typeof user?.permissionId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(user.permissionId), 'ACCOUNT_KEY_UNAVAILABLE');
    context.guard();
    return { key: user.permissionId, label: typeof user.emailAddress === 'string' && user.emailAddress.length <= 254 ? user.emailAddress : '目前 Google 帳號' };
  }
  #drive(context, onWrite = () => {}) {
    return this.createDrive({ request: async (url, options) => {
      context.guard(); const writing = (options.method ?? 'GET') !== 'GET';
      if (writing) onWrite('dispatched');
      try {
        const response = await this.login.request(url, options, context.session);
        if (writing && [400, 401, 403, 404, 409, 412, 413, 415, 422, 429].includes(response.status)) onWrite('rejected');
        return response;
      } catch (error) { if (writing && error.code === 'HTTP_401') onWrite('rejected'); throw error; }
    } });
  }
  async preview(mode) {
    this.#pending = null;
    return this.#run(async context => {
      requireData(['import', 'export'].includes(mode), 'INVALID_CLOUD_ACTION');
      const account = await this.#account(context);
      const uncertain = await this.store.readCloudExport(context.guard);
      requireData(!uncertain, 'UNCONFIRMED_EXPORT');
      const local = await this.store.read(); context.guard();
      const remote = await this.#drive(context).read(); context.guard();
      if (mode === 'import' && !remote) return { empty: true, account: account.label };
      if (remote && mode === 'export') validateFile(remote.file, true);
      const plan = planLocalBackup(local, remote?.document ?? createDocument());
      this.#pending = { mode, account, local, remote, plan, context };
      const counts = document => ({ tracked: Object.values(document.data.marks).filter(mark => mark.status === 'tracked').length,
        ignored: Object.values(document.data.marks).filter(mark => mark.status === 'ignored').length,
        cleared: Object.keys(document.data.tombstones).length });
      return { mode, account: account.label, local: counts(local.document), remote: counts(remote?.document ?? createDocument()),
        conflicts: plan.conflicts.map(conflict => ({ key: conflict.key, local: conflict.local?.status ?? 'unclassified',
          remote: conflict.remote?.status ?? 'unclassified' })), creating: remote === null };
    });
  }
  async confirm(choice = 'local') {
    const pending = this.#pending; this.#pending = null;
    requireData(pending, 'CLOUD_PREVIEW_REQUIRED');
    return this.#run(async context => {
      pending.context.guard(); requireData(choice === 'local' || choice === 'remote', 'INVALID_CHOICE');
      if (pending.mode === 'import') {
        const latest = await this.#drive(context).read(); context.guard();
        requireData(sameReceipt(pending.remote, latest), 'REMOTE_CHANGED');
        const local = await this.store.importBackup(latest.document, pending.local.localRevision, choice, context.guard);
        return { mode: 'import', local };
      }
      const candidate = resolveMerge(pending.plan, { all: choice });
      candidate.data.datasetId = pending.remote?.document.data.datasetId ?? this.uuid();
      candidate.data.revisionId = this.uuid();
      candidate.data.updatedAt = Math.max(candidate.data.updatedAt, this.now());
      candidate.updatedAt = new Date(candidate.data.updatedAt).toISOString();
      const journal = validateCloudExport({ schemaVersion: 1, id: this.uuid(), account: pending.account.key,
        candidate, expected: pending.remote });
      await this.store.beginCloudExport(journal, pending.local.localRevision, context.guard);
      let dispatched = false, rejected = false;
      try {
        context.guard();
        await this.#drive(context, phase => { if (phase === 'dispatched') dispatched = true; else rejected = true; }).write(candidate, pending.remote);
        context.guard(); await this.store.clearCloudExport(journal.id, context.guard);
        return { mode: 'export' };
      } catch (error) {
        if (!dispatched || rejected) { try { await this.store.clearCloudExport(journal.id); } catch { /* retain recovery record */ } }
        throw error;
      }
    });
  }
  async recover() {
    return this.#run(async context => {
      const account = await this.#account(context), journal = await this.store.readCloudExport(context.guard);
      requireData(journal, 'NO_UNCERTAIN_EXPORT');
      requireData(account.key === journal.account, 'CLOUD_ACCOUNT_CHANGED');
      const receipt = await this.#drive(context).read(); context.guard();
      requireData(receipt && (!journal.expected || receipt.file.id === journal.expected.file.id)
        && exportBackup(receipt.document) === exportBackup(journal.candidate), 'RECOVERY_REQUIRED');
      await this.store.clearCloudExport(journal.id, context.guard);
      return { mode: 'recovered' };
    });
  }
}
