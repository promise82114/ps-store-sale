import assert from 'node:assert/strict';
import test from 'node:test';
import * as state from '../src/poc04/sync-state.mjs';
import { createMockableDrive } from '../src/poc04/drive-transport.mjs';
import { fixture, a, b, id, mark } from './fixtures/poc04.mjs';
import { mockBackend } from './fixtures/mock-drive.mjs';
const fails = (fn, code) => assert.throws(fn, e => e.code === code);
const edited = () => state.classify(state.emptyState(), a, 'tracked', { changeId: id(1), updatedAt: 1 });
const config = { revisionId: id(902), datasetId: id(900), decisions: { all: 'local' } };
async function staged(remote = fixture(), decisions = config.decisions) {
  const backend = mockBackend(remote), drive = createMockableDrive({ request: backend.request });
  const expected = await drive.read();
  const value = state.stage(state.begin(edited(), id(100)), id(100), expected, { ...config, decisions });
  return { value, backend, drive };
}
for (const previous of ['unclassified', 'tracked', 'ignored']) for (const action of ['tracked', 'ignored'])
  test(`manual ${previous} to ${action} toggles atomically and undoes with a fresh operation`, () => {
    const original = previous === 'unclassified' ? state.emptyState() : state.classify(state.emptyState(), a, previous, { changeId: id(1), updatedAt: 1 });
    const saved = structuredClone(original);
    const changed = state.toggleClassification(original, a, action, { changeId: id(2), updatedAt: 2 });
    assert.equal(changed.state.document.data.marks[a]?.status ?? 'unclassified', previous === action ? 'unclassified' : action);
    const restored = state.undoClassification(changed.state, changed.undo, { changeId: id(3), updatedAt: 3 });
    assert.equal(restored.document.data.marks[a]?.status ?? 'unclassified', previous);
    assert.equal(restored.outbox[a].changeId, id(3));
    assert.equal(restored.localRevision, changed.state.localRevision + 1);
    if (previous === 'unclassified') assert.equal(restored.document.data.tombstones[a].changeId, id(3));
    else assert.equal(restored.document.data.marks[a].changeId, id(3));
    assert.deepEqual(original, saved); state.validateState(restored);
  });
test('undo rejects a later change on the same product without overwriting it', () => {
  const changed = state.toggleClassification(state.emptyState(), a, 'ignored', { changeId: id(1), updatedAt: 1 });
  const newer = state.classify(changed.state, a, 'tracked', { changeId: id(2), updatedAt: 2 }), saved = structuredClone(newer);
  fails(() => state.undoClassification(newer, changed.undo, { changeId: id(3), updatedAt: 3 }), 'STALE_UNDO');
  assert.deepEqual(newer, saved);
});
test('undo preserves independent edits from another tab and their pending operations', () => {
  const changed = state.toggleClassification(edited(), a, 'ignored', { changeId: id(2), updatedAt: 2 });
  const newer = state.classify(changed.state, b, 'ignored', { changeId: id(3), updatedAt: 3 });
  const restored = state.undoClassification(newer, changed.undo, { changeId: id(4), updatedAt: 4 });
  assert.equal(restored.document.data.marks[a].status, 'tracked');
  assert.deepEqual(restored.document.data.marks[b], newer.document.data.marks[b]);
  assert.deepEqual(restored.outbox[b], newer.outbox[b]);
});
test('undo preserves a prepared synchronization snapshot and cannot be applied twice', () => {
  const changed = state.toggleClassification(edited(), a, 'ignored', { changeId: id(2), updatedAt: 2 });
  const active = state.begin(changed.state, id(100));
  const restored = state.undoClassification(active, changed.undo, { changeId: id(3), updatedAt: 3 });
  assert.deepEqual(restored.attempt, active.attempt);
  assert.deepEqual(restored.base, active.base); assert.deepEqual(restored.remote, active.remote);
  fails(() => state.undoClassification(restored, changed.undo, { changeId: id(4), updatedAt: 4 }), 'STALE_UNDO');
});
test('undo checks the complete expected operation, not only its identifier', () => {
  const changed = state.toggleClassification(edited(), a, 'ignored', { changeId: id(2), updatedAt: 2 });
  for (const patch of [{ updatedAt: 999 }, { status: 'tracked' }]) {
    const undo = structuredClone(changed.undo); Object.assign(undo.after, patch);
    fails(() => state.undoClassification(changed.state, undo, { changeId: id(3), updatedAt: 3 }), 'STALE_UNDO');
  }
});

test('P04-03 no-op classification does not consume a revision or replace the outbox operation', () => {
  const value = edited();
  assert.deepEqual(state.classify(value, a, 'tracked', { changeId: id(2), updatedAt: 2 }), value);
});
test('P04-03 initial snapshot and later edits are independent immutable values', () => {
  const value = state.begin(edited(), id(100)), before = structuredClone(value);
  const changed = state.classify(value, a, 'ignored', { changeId: id(2), updatedAt: 2 });
  assert.deepEqual(value, before);
  assert.equal(changed.attempt.snapshot.outbox[a].changeId, id(1));
  assert.equal(changed.outbox[a].changeId, id(2));
});
test('P04-03 a captured changeId cannot be reused after toggling away from that state', () => {
  const value = state.begin(edited(), id(100));
  const changed = state.classify(value, a, 'ignored', { changeId: id(2), updatedAt: 2 });
  fails(() => state.classify(changed, a, 'tracked', { changeId: id(1), updatedAt: 1 }), 'CHANGE_ID_REUSED');
});
test('P04-03 revision exhaustion rejects without modifying the saved state', () => {
  const value = edited(); value.localRevision = Number.MAX_SAFE_INTEGER;
  const before = structuredClone(value);
  fails(() => state.classify(value, b, 'ignored', { changeId: id(2), updatedAt: 2 }), 'REVISION_EXHAUSTED');
  assert.deepEqual(value, before);
});
for (const [name, mutate, code] of [
  ['future storage schema', s => { s.schemaVersion = 2; }, 'INVALID_STORAGE_STATE'],
  ['array outbox', s => { s.outbox = []; }, 'INVALID_STORAGE_STATE'],
  ['outbox not matching saved mark', s => { s.outbox[a].changeId = id(99); }, 'INVALID_OUTBOX'],
  ['lost outbox revision', s => { delete s.outbox[a].localRevision; }, 'INVALID_OUTBOX'],
  ['missing pending operation', s => { delete s.outbox[a]; }, 'MISSING_OUTBOX'],
  ['unknown storage property', s => { s.token = 'synthetic'; }, 'INVALID_STORAGE_STATE'],
  ['corrupt active journal', s => { s.attempt = {}; }, 'INVALID_JOURNAL'],
]) test(`P04-03 rejects ${name} without overwriting input`, () => {
  const value = edited(); mutate(value); const before = structuredClone(value);
  fails(() => state.validateState(value), code); assert.deepEqual(value, before);
});
test('P04-03 cancelled never-sent attempt preserves all data; dispatched attempt cannot be cancelled', async () => {
  const { value } = await staged(), prepared = structuredClone(value);
  const cancelled = state.cancelPrepared(value, id(100));
  assert.deepEqual(cancelled.document, value.document); assert.deepEqual(cancelled.outbox, value.outbox);
  assert.deepEqual(value, prepared);
  fails(() => state.cancelPrepared(state.sending(value, id(100)), id(100)), 'INVALID_SYNC_STAGE');
});
test('P04-03 unconfirmed or mismatched receipts cannot advance Base or clear outbox', async () => {
  const { value } = await staged(), sending = state.sending(value, id(100));
  const receipt = { document: fixture(), file: value.attempt.expected.file };
  fails(() => state.acknowledge(sending, id(100), receipt), 'RECEIPT_MISMATCH');
  fails(() => state.acknowledge(value, id(100), receipt), 'INVALID_SYNC_STAGE');
  assert.equal(sending.base, null); assert.equal(sending.outbox[a].changeId, id(1));
});
test('P04-03 remote conflict choice intentionally settles captured local operation', async () => {
  const { value, drive } = await staged(fixture({ [a]: mark('ignored', 2) }), { all: 'remote' });
  const sending = state.sending(value, id(100));
  const receipt = await drive.write(sending.attempt.candidate, sending.attempt.expected);
  const result = state.acknowledge(sending, id(100), receipt);
  assert.equal(result.document.data.marks[a].status, 'ignored');
  assert.deepEqual(result.outbox, {}); assert.deepEqual(result.document, result.base);
});
test('P04-03 Base exactly matches confirmed upload while newer local clear stays pending', async () => {
  const { value, drive } = await staged(), sending = state.sending(value, id(100));
  const latest = state.classify(sending, a, 'unclassified', { changeId: id(3), updatedAt: 3 });
  const receipt = await drive.write(sending.attempt.candidate, sending.attempt.expected);
  const result = state.acknowledge(latest, id(100), receipt);
  assert.deepEqual(result.base, receipt.document);
  assert.equal(result.base.data.marks[a].status, 'tracked');
  assert.equal(result.document.data.tombstones[a].changeId, id(3));
  assert.equal(result.outbox[a].changeId, id(3));
});
test('P04-04 failed journal records bounded safe error codes, never exception text', async () => {
  const { value } = await staged(), sending = state.sending(value, id(100));
  const result = state.failed(sending, id(100), 'arbitrary remote exception text');
  assert.equal(result.attempt.error, 'TRANSPORT_FAILED');
  assert.deepEqual(result.document, sending.document); assert.deepEqual(result.outbox, sending.outbox);
});
test('P04-04 wrong file receipt cannot settle a valid candidate', async () => {
  const { value } = await staged(), sending = state.sending(value, id(100));
  fails(() => state.acknowledge(sending, id(100), {
    document: value.attempt.candidate, file: { ...value.attempt.expected.file, id: 'replacement' },
  }), 'REMOTE_REPLACED');
});
