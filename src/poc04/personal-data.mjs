// P04-02: pure JSON data only. No storage, network, clock or UUID generation.
export const limits = Object.freeze({ records: 100_000, bytes: 16 * 1024 * 1024 });
const projectId = 'ps-store-sale-filter';
const kind = 'ps-store-sale-filter-personal';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const localePattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/;
const productPattern = /^[A-Z0-9][A-Z0-9_-]{0,127}$/;
const encoder = new TextEncoder();

export class PersonalDataError extends Error {
  constructor(code) { super(code); this.name = 'PersonalDataError'; this.code = code; }
}
export function requireData(condition, code) {
  if (!condition) throw new PersonalDataError(code);
}
function object(value) {
  requireData(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT');
  requireData([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INVALID_OBJECT');
  requireData(Reflect.ownKeys(value).every(key => typeof key === 'string'
    && Object.getOwnPropertyDescriptor(value, key).enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), 'INVALID_OBJECT');
}
function fields(value, expected) {
  object(value);
  const actual = Object.keys(value);
  requireData(actual.length === expected.length && expected.every(key => Object.hasOwn(value, key)), 'INVALID_FIELDS');
}
export function validateId(value) {
  requireData(typeof value === 'string' && uuid.test(value), 'INVALID_ID');
}
export function validateTime(value) {
  requireData(Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000, 'INVALID_TIME');
}
export function personalKey(locale, productId) {
  requireData(typeof locale === 'string' && localePattern.test(locale)
    && typeof productId === 'string' && productPattern.test(productId), 'INVALID_PRODUCT_KEY');
  return `${locale}:${productId}`;
}
export function validateKey(key) {
  requireData(typeof key === 'string', 'INVALID_PRODUCT_KEY');
  const parts = key.split(':');
  requireData(parts.length === 2, 'INVALID_PRODUCT_KEY');
  personalKey(...parts);
}
function canonicalMap(source, isMark, seen) {
  object(source);
  const result = {};
  for (const key of Object.keys(source).sort()) {
    validateKey(key);
    const record = source[key];
    fields(record, isMark ? ['status', 'changeId', 'updatedAt'] : ['changeId', 'updatedAt']);
    if (isMark) requireData(['tracked', 'ignored'].includes(record.status), 'INVALID_STATUS');
    validateId(record.changeId);
    validateTime(record.updatedAt);
    requireData(!seen.has(record.changeId), 'DUPLICATE_CHANGE_ID');
    seen.add(record.changeId);
    result[key] = isMark
      ? { status: record.status, changeId: record.changeId, updatedAt: record.updatedAt }
      : { changeId: record.changeId, updatedAt: record.updatedAt };
  }
  return result;
}

// Return a detached, canonical copy. Unknown fields are rejected, never stripped.
export function validateDocument(document) {
  fields(document, ['schemaVersion', 'projectId', 'updatedAt', 'data']);
  requireData(document.schemaVersion === 1, 'UNSUPPORTED_SCHEMA');
  requireData(document.projectId === projectId, 'WRONG_PROJECT');
  const data = document.data;
  fields(data, ['schemaVersion', 'kind', 'datasetId', 'revisionId', 'updatedAt', 'marks', 'tombstones']);
  requireData(data.schemaVersion === 1, 'UNSUPPORTED_SCHEMA');
  requireData(data.kind === kind, 'WRONG_KIND');
  validateTime(data.updatedAt);
  requireData(document.updatedAt === new Date(data.updatedAt).toISOString(), 'INVALID_ENVELOPE_TIME');
  requireData((data.datasetId === null) === (data.revisionId === null), 'INVALID_LINEAGE');
  if (data.datasetId !== null) { validateId(data.datasetId); validateId(data.revisionId); }
  object(data.marks);
  object(data.tombstones);
  requireData(Object.keys(data.marks).length + Object.keys(data.tombstones).length <= limits.records, 'TOO_MANY_RECORDS');
  const seen = new Set();
  const marks = canonicalMap(data.marks, true, seen);
  const tombstones = canonicalMap(data.tombstones, false, seen);
  requireData(Object.keys(marks).every(key => !Object.hasOwn(tombstones, key)), 'OVERLAPPING_RECORDS');
  const result = {
    schemaVersion: 1, projectId, updatedAt: document.updatedAt,
    data: { schemaVersion: 1, kind, datasetId: data.datasetId, revisionId: data.revisionId,
      updatedAt: data.updatedAt, marks, tombstones },
  };
  requireData(encoder.encode(JSON.stringify(result)).byteLength <= limits.bytes, 'DOCUMENT_TOO_LARGE');
  return result;
}

export function createDocument({ datasetId = null, revisionId = null, updatedAt = 0 } = {}) {
  validateTime(updatedAt);
  return validateDocument({ schemaVersion: 1, projectId, updatedAt: new Date(updatedAt).toISOString(),
    data: { schemaVersion: 1, kind, datasetId, revisionId, updatedAt, marks: {}, tombstones: {} } });
}

export function getClassification(document, key) {
  validateKey(key);
  return validateDocument(document).data.marks[key]?.status ?? 'unclassified';
}

// Metadata is injected by the caller; updatedAt never selects a merge winner.
export function setClassification(document, key, status, { changeId, updatedAt }) {
  const next = validateDocument(document);
  validateKey(key);
  requireData(['tracked', 'ignored', 'unclassified'].includes(status), 'INVALID_STATUS');
  validateId(changeId);
  validateTime(updatedAt);
  const current = next.data.marks[key]?.status ?? 'unclassified';
  if (current === status) return next; // Includes never-marked and already cleared.
  requireData(![...Object.values(next.data.marks), ...Object.values(next.data.tombstones)]
    .some(record => record.changeId === changeId), 'CHANGE_ID_REUSED');
  delete next.data.marks[key];
  delete next.data.tombstones[key];
  if (status === 'unclassified') next.data.tombstones[key] = { changeId, updatedAt };
  else next.data.marks[key] = { status, changeId, updatedAt };
  next.data.updatedAt = Math.max(next.data.updatedAt, updatedAt);
  next.updatedAt = new Date(next.data.updatedAt).toISOString();
  return validateDocument(next);
}

// Compact canonical JSON keeps every valid export within the same import byte limit.
export function exportBackup(document) { return JSON.stringify(validateDocument(document)); }
export function importBackup(text) {
  requireData(typeof text === 'string', 'INVALID_JSON');
  requireData(encoder.encode(text).byteLength <= limits.bytes, 'DOCUMENT_TOO_LARGE');
  let document;
  try { document = JSON.parse(text); } catch { throw new PersonalDataError('INVALID_JSON'); }
  return validateDocument(document);
}
