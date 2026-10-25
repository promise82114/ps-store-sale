import { createDocument, requireData, validateDocument } from './personal-data.mjs';

const plans = new WeakMap();
const keysOf = document => document
  ? [...Object.keys(document.data.marks), ...Object.keys(document.data.tombstones)] : [];
const stateAt = (document, key) => !document ? null
  : document.data.marks[key] ? { type: 'mark', ...document.data.marks[key] }
    : document.data.tombstones[key] ? { type: 'tombstone', ...document.data.tombstones[key] } : null;
const sameOperation = (a, b) => a === b || (!!a && !!b && a.changeId === b.changeId);
const sameIntent = (a, b) => a === b || (!!a && !!b && a.type === b.type && a.status === b.status);
const chooseSame = (a, b) => a === null ? null : a.changeId < b.changeId ? a : b;
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function store(data, key, state) {
  if (state?.type === 'mark') data.marks[key] = {
    status: state.status, changeId: state.changeId, updatedAt: state.updatedAt,
  };
  else if (state?.type === 'tombstone') data.tombstones[key] = {
    changeId: state.changeId, updatedAt: state.updatedAt,
  };
}
function validateOperations(documents) {
  const seen = new Map();
  for (const document of documents) for (const key of keysOf(document)) {
    const state = stateAt(document, key);
    const signature = JSON.stringify([key, state.type, state.status ?? null, state.updatedAt]);
    requireData(!seen.has(state.changeId) || seen.get(state.changeId) === signature, 'CHANGE_ID_REUSED');
    seen.set(state.changeId, signature);
  }
}

// base=null explicitly means first sync, never an inferred missing/deleted cloud file.
export function planMerge({ base, local, remote }) {
  requireData(base !== undefined, 'BASE_REQUIRED');
  const b = base === null ? null : validateDocument(base);
  const l = validateDocument(local), r = validateDocument(remote);
  if (b) {
    requireData(b.data.datasetId !== null, 'BASE_UNBOUND');
    requireData(l.data.datasetId === b.data.datasetId && r.data.datasetId === b.data.datasetId, 'LINEAGE_CHANGED');
  } else {
    requireData(l.data.datasetId === null || r.data.datasetId === null
      || l.data.datasetId === r.data.datasetId, 'LINEAGE_CHANGED');
  }
  validateOperations([b, l, r]);
  const datasetId = r.data.datasetId ?? l.data.datasetId;
  const data = { marks: {}, tombstones: {} }, conflicts = [];
  for (const key of [...new Set([...keysOf(b), ...keysOf(l), ...keysOf(r)])].sort()) {
    const bs = stateAt(b, key), ls = stateAt(l, key), rs = stateAt(r, key);
    if (bs) requireData(ls !== null && rs !== null, 'MISSING_DELETION_INTENT');
    let selected;
    if (bs?.type === 'tombstone' && (ls?.type === 'mark' || rs?.type === 'mark')) {
      // A stale pair of matching marks must not override a clear recorded in Base.
      conflicts.push({ key, reason: 'TOMBSTONE_VS_MARK', base: bs, local: ls, remote: rs });
      continue;
    } else if (sameIntent(ls, rs)) selected = chooseSame(ls, rs);
    // Confirmed conservative policy: even a one-sided clear needs explicit choice.
    else if (ls && rs && ls.type !== rs.type) {
      conflicts.push({ key, reason: 'TOMBSTONE_VS_MARK', base: bs, local: ls, remote: rs });
      continue;
    } else if (!b) {
      if (ls === null) selected = rs;
      else if (rs === null) selected = ls;
      else {
        conflicts.push({ key, reason: 'DIFFERENT_CLASSIFICATIONS', base: null, local: ls, remote: rs });
        continue;
      }
    } else if (sameOperation(ls, bs)) selected = rs;
    else if (sameOperation(rs, bs)) selected = ls;
    else {
      conflicts.push({ key, reason: 'BOTH_CHANGED', base: bs, local: ls, remote: rs });
      continue;
    }
    store(data, key, selected);
  }
  const plan = freeze({ mode: b ? 'three-way' : 'first-sync', datasetId,
    ready: conflicts.length === 0, ...data, conflicts });
  plans.set(plan, { updatedAt: Math.max(l.data.updatedAt, r.data.updatedAt, b?.data.updatedAt ?? 0) });
  return plan;
}

// Unresolved or invalid choices cannot be exported as a completed merged document.
// The immutable plan binds all choices to the captured input snapshots (no live store).
export function resolveMerge(plan, { choices = {}, all } = {}, { revisionId = null, updatedAt } = {}) {
  requireData(plans.has(plan), 'INVALID_PLAN');
  requireData(choices !== null && typeof choices === 'object' && !Array.isArray(choices)
    && [Object.prototype, null].includes(Object.getPrototypeOf(choices)), 'INVALID_CHOICES');
  requireData(all === undefined || ['local', 'remote'].includes(all), 'INVALID_CHOICE');
  const expectedKeys = new Set(plan.conflicts.map(conflict => conflict.key));
  requireData(Object.keys(choices).every(key => expectedKeys.has(key)), 'UNKNOWN_CHOICE_KEY');
  requireData(all === undefined || Object.keys(choices).length === 0, 'AMBIGUOUS_CHOICES');
  const document = createDocument({ datasetId: plan.datasetId, revisionId,
    updatedAt: updatedAt ?? plans.get(plan).updatedAt });
  document.data.marks = structuredClone(plan.marks);
  document.data.tombstones = structuredClone(plan.tombstones);
  for (const conflict of plan.conflicts) {
    const choice = all ?? (Object.hasOwn(choices, conflict.key) ? choices[conflict.key] : undefined);
    requireData(['local', 'remote'].includes(choice), 'UNRESOLVED_CONFLICT');
    store(document.data, conflict.key, conflict[choice]);
  }
  return validateDocument(document);
}
