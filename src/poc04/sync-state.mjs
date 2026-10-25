import { createDocument, exportBackup, requireData, setClassification, validateDocument,
  validateId } from './personal-data.mjs';
import { planMerge, resolveMerge } from './merge.mjs';
import { validateFile } from './drive-transport.mjs';

const record = (doc, key) => doc.data.marks[key] ?? doc.data.tombstones[key] ?? null;
const copy = value => structuredClone(value);
const bump = state => {
  requireData(Number.isSafeInteger(state.localRevision + 1), 'REVISION_EXHAUSTED');
  return ++state.localRevision;
};
export function emptyState() {
  return { schemaVersion: 1, document: createDocument(), base: null, remote: null,
    localRevision: 0, outbox: {}, attempt: null, lastConfirmed: null };
}
export function validateState(value) {
  const plain = data => data !== null && typeof data === 'object' && !Array.isArray(data)
    && Object.getPrototypeOf(data) === Object.prototype;
  requireData(plain(value) && Object.keys(value).length === 8
    && ['schemaVersion', 'document', 'base', 'remote', 'localRevision', 'outbox', 'attempt', 'lastConfirmed']
      .every(key => Object.hasOwn(value, key)), 'INVALID_STORAGE_STATE');
  requireData(value.schemaVersion === 1 && Number.isSafeInteger(value.localRevision)
    && value.localRevision >= 0 && plain(value.outbox), 'INVALID_STORAGE_STATE');
  validateDocument(value.document);
  if (value.base !== null) validateDocument(value.base);
  requireData((value.base === null) === (value.remote === null), 'INVALID_STORAGE_STATE');
  if (value.base) {
    validateFile(value.remote, true);
    requireData(value.base.data.datasetId !== null
      && value.document.data.datasetId === value.base.data.datasetId, 'INVALID_STORAGE_STATE');
  }
  for (const [key, op] of Object.entries(value.outbox)) {
    requireData(plain(op) && Object.keys(op).length === 2 && record(value.document, key)?.changeId === op.changeId
      && Number.isSafeInteger(op.localRevision) && op.localRevision > 0
      && op.localRevision <= value.localRevision, 'INVALID_OUTBOX');
  }
  const allKeys = new Set([...[value.document, value.base].filter(Boolean)
    .flatMap(doc => [...Object.keys(doc.data.marks), ...Object.keys(doc.data.tombstones)])]);
  for (const key of allKeys) {
    const current = record(value.document, key), baseRecord = value.base && record(value.base, key);
    requireData(current !== null, 'INVALID_STORAGE_STATE');
    requireData(current.changeId === baseRecord?.changeId || Object.hasOwn(value.outbox, key), 'MISSING_OUTBOX');
  }
  if (value.lastConfirmed !== null) {
    requireData(plain(value.lastConfirmed) && Object.keys(value.lastConfirmed).length === 2, 'INVALID_STORAGE_STATE');
    validateId(value.lastConfirmed.attemptId); validateId(value.lastConfirmed.revisionId);
  }
  if (value.attempt !== null) {
    const attempt = value.attempt;
    requireData(plain(attempt) && Object.keys(attempt).length === 6
      && ['snapshot', 'prepared', 'sending', 'uncertain'].includes(attempt.stage), 'INVALID_JOURNAL');
    validateId(attempt.id);
    const snapshot = attempt.snapshot;
    requireData(plain(snapshot) && Object.keys(snapshot).length === 5
      && Number.isSafeInteger(snapshot.localRevision) && snapshot.localRevision <= value.localRevision, 'INVALID_JOURNAL');
    // Validate the captured aggregate with the same core invariants, without recursion.
    validateState({ schemaVersion: 1, document: snapshot.local, base: snapshot.base, remote: snapshot.remote,
      localRevision: snapshot.localRevision, outbox: snapshot.outbox, attempt: null, lastConfirmed: null });
    requireData(JSON.stringify(snapshot.base) === JSON.stringify(value.base)
      && JSON.stringify(snapshot.remote) === JSON.stringify(value.remote), 'INVALID_JOURNAL');
    if (attempt.stage === 'snapshot') requireData(attempt.candidate === null && attempt.expected === null, 'INVALID_JOURNAL');
    else {
      validateDocument(attempt.candidate);
      requireData(attempt.candidate.data.datasetId !== null, 'INVALID_JOURNAL');
      if (attempt.expected !== null) {
        validateFile(attempt.expected?.file, true); validateDocument(attempt.expected.document);
      }
    }
  }
  return copy(value);
}
function attemptFor(state, id, stages) {
  requireData(state.attempt?.id === id, 'STALE_ATTEMPT');
  requireData(stages.includes(state.attempt.stage), 'INVALID_SYNC_STAGE');
  return state.attempt;
}
export function classify(state, key, status, metadata) {
  const next = validateState(state);
  const document = setClassification(next.document, key, status, metadata);
  if (exportBackup(document) === exportBackup(next.document)) return next;
  const known = [next.base, next.attempt?.snapshot.local, next.attempt?.snapshot.base,
    next.attempt?.candidate, next.attempt?.expected?.document].filter(Boolean);
  requireData(!known.some(doc => [...Object.values(doc.data.marks), ...Object.values(doc.data.tombstones)]
    .some(op => op.changeId === metadata.changeId)), 'CHANGE_ID_REUSED');
  next.document = document;
  next.outbox[key] = { changeId: record(document, key).changeId, localRevision: bump(next) };
  return next;
}
export function planLocalBackup(state, incoming) {
  const current = validateState(state);
  requireData(current.base === null && current.remote === null && current.attempt === null, 'IMPORT_REQUIRES_LOCAL_WORKSPACE');
  const local = validateDocument(current.document), remote = validateDocument(incoming);
  // Personal backup import does not import a cloud binding or synchronization Base.
  for (const document of [local, remote]) { document.data.datasetId = null; document.data.revisionId = null; }
  return planMerge({ base: null, local, remote });
}
export function mergeLocalBackup(state, incoming, expectedRevision, all = 'local') {
  const next = validateState(state);
  requireData(next.localRevision === expectedRevision, 'STALE_SNAPSHOT');
  const merged = resolveMerge(planLocalBackup(next, incoming), { all });
  if (exportBackup(merged) === exportBackup(next.document)) return next;
  const revision = bump(next);
  for (const key of [...Object.keys(merged.data.marks), ...Object.keys(merged.data.tombstones)]) {
    const operation = record(merged, key);
    if (operation.changeId !== record(next.document, key)?.changeId)
      next.outbox[key] = { changeId: operation.changeId, localRevision: revision };
  }
  next.document = merged;
  return validateState(next);
}
export function begin(state, id) {
  validateId(id);
  const next = validateState(state);
  requireData(next.attempt === null, 'SYNC_IN_PROGRESS');
  requireData(next.lastConfirmed?.attemptId !== id, 'ATTEMPT_ID_REUSED');
  next.attempt = { id, stage: 'snapshot', snapshot: {
    local: copy(next.document), base: copy(next.base), remote: copy(next.remote),
    localRevision: next.localRevision, outbox: copy(next.outbox),
  }, candidate: null, expected: null, error: null };
  return next;
}
export function stage(state, id, expected, { revisionId, datasetId, decisions = {}, updatedAt } = {}) {
  const next = validateState(state), attempt = attemptFor(next, id, ['snapshot']);
  const snapshot = attempt.snapshot;
  requireData(next.localRevision === snapshot.localRevision, 'STALE_SNAPSHOT');
  if (snapshot.base) {
    requireData(expected !== null, 'REMOTE_MISSING');
    requireData(expected.file.id === snapshot.remote.id, 'REMOTE_REPLACED');
  }
  const remote = expected?.document ?? createDocument();
  const plan = planMerge({ base: snapshot.base, local: snapshot.local, remote });
  let candidate = resolveMerge(plan, decisions, {
    revisionId: plan.datasetId === null ? null : revisionId, updatedAt,
  });
  if (candidate.data.datasetId === null) {
    validateId(datasetId); validateId(revisionId);
    candidate.data.datasetId = datasetId;
    candidate.data.revisionId = revisionId;
    candidate = validateDocument(candidate);
  }
  requireData(candidate.data.revisionId !== snapshot.base?.data.revisionId
    && candidate.data.revisionId !== expected?.document.data.revisionId, 'REVISION_ID_REUSED');
  attempt.candidate = candidate;
  attempt.expected = copy(expected);
  attempt.stage = 'prepared';
  return next;
}
export function sending(state, id) {
  const next = validateState(state), attempt = attemptFor(next, id, ['prepared']);
  requireData(next.localRevision === attempt.snapshot.localRevision, 'STALE_SNAPSHOT');
  attempt.stage = 'sending'; // Durable before a request is dispatched.
  return next;
}
export function failed(state, id, code) {
  const next = validateState(state), attempt = attemptFor(next, id, ['sending', 'uncertain']);
  attempt.stage = 'uncertain';
  // Fixed codes only: no raw server bodies, tokens or exception text in storage.
  attempt.error = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'TRANSPORT_FAILED';
  return next;
}
export function cancelPrepared(state, id) {
  const next = validateState(state);
  attemptFor(next, id, ['snapshot', 'prepared']);
  next.attempt = null; // Never cancel a potentially dispatched write.
  return next;
}
export function acknowledge(state, id, receipt) {
  const next = validateState(state);
  if (next.attempt === null && next.lastConfirmed?.attemptId === id) return next;
  const attempt = attemptFor(next, id, ['sending', 'uncertain']);
  validateFile(receipt?.file, true);
  requireData(!attempt.expected || receipt.file.id === attempt.expected.file.id, 'REMOTE_REPLACED');
  requireData(receipt && exportBackup(receipt.document) === exportBackup(attempt.candidate), 'RECEIPT_MISMATCH');
  const document = copy(attempt.candidate), remaining = {};
  for (const [key, op] of Object.entries(next.outbox)) {
    const captured = attempt.snapshot.outbox[key];
    if (captured?.changeId === op.changeId && captured.localRevision === op.localRevision) continue;
    // Replay only operations created after the captured snapshot, including clears.
    delete document.data.marks[key]; delete document.data.tombstones[key];
    if (next.document.data.marks[key]) document.data.marks[key] = copy(next.document.data.marks[key]);
    else document.data.tombstones[key] = copy(next.document.data.tombstones[key]);
    remaining[key] = copy(op);
  }
  document.data.updatedAt = Math.max(document.data.updatedAt, next.document.data.updatedAt);
  document.updatedAt = new Date(document.data.updatedAt).toISOString();
  next.document = validateDocument(document);
  next.base = validateDocument(receipt.document); // Exactly confirmed M, never current Local.
  next.remote = copy(receipt.file);
  next.outbox = remaining;
  next.lastConfirmed = { attemptId: id, revisionId: next.base.data.revisionId };
  next.attempt = null;
  bump(next);
  return validateState(next);
}
