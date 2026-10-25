import assert from 'node:assert/strict';
import test from 'node:test';
import { exportBackup, getClassification, importBackup } from '../src/poc04/personal-data.mjs';
import { planMerge, resolveMerge } from '../src/poc04/merge.mjs';
import { a, b, otherLocale, fixture, finishOptions, id, mark, tombstone } from './fixtures/poc04.mjs';

const fails = (action, code) => assert.throws(action, error => error.code === code);
const finish = (plan, choices) => resolveMerge(plan, choices, finishOptions);

test('P04-01 first sync explicitly has no Base and unions independent products', () => {
  const local = fixture({ [a]: mark('tracked', 1) }, {}, false);
  const remote = fixture({ [b]: mark('ignored', 2) }, { [otherLocale]: tombstone(3) });
  const plan = planMerge({ base: null, local, remote });
  assert.equal(plan.mode, 'first-sync');
  assert.equal(plan.ready, true);
  assert.equal(plan.datasetId, remote.data.datasetId);
  const result = finish(plan);
  assert.deepEqual(result.data.marks, { ...local.data.marks, ...remote.data.marks });
  assert.deepEqual(result.data.tombstones, remote.data.tombstones);
});
test('P04-01 two empty unbound documents stay sparse without inventing cloud metadata', () => {
  const plan = planMerge({ base: null, local: fixture({}, {}, false), remote: fixture({}, {}, false) });
  const result = resolveMerge(plan);
  assert.equal(result.data.datasetId, null);
  assert.equal(result.data.revisionId, null);
  assert.deepEqual(result.data.marks, {});
});
test('P04-01 daily merge uses Base for one-sided classification changes in either direction', () => {
  const base = fixture({ [a]: mark('tracked', 1) });
  const changed = fixture({ [a]: mark('ignored', 2) });
  for (const [local, remote] of [[base, changed], [changed, base]]) {
    const plan = planMerge({ base, local, remote });
    assert.equal(plan.mode, 'three-way');
    assert.equal(plan.ready, true);
    assert.deepEqual(finish(plan).data.marks, changed.data.marks);
  }
});
test('P04-01 daily independent edits merge automatically across product and locale keys', () => {
  const base = fixture({ [a]: mark('tracked', 1), [b]: mark('tracked', 2) });
  const local = fixture({ [a]: mark('ignored', 3), [b]: mark('tracked', 2) });
  const remote = fixture({ [a]: mark('tracked', 1), [b]: mark('ignored', 4), [otherLocale]: mark('tracked', 5) });
  const plan = planMerge({ base, local, remote });
  assert.equal(plan.ready, true);
  assert.deepEqual(finish(plan).data.marks, {
    [otherLocale]: remote.data.marks[otherLocale], [a]: local.data.marks[a], [b]: remote.data.marks[b],
  });
});
test('P04-01 equal intentions select the lexically smaller operation, not newest time', () => {
  for (const status of ['tracked', 'ignored', 'tombstone']) {
    const local = status === 'tombstone' ? fixture({}, { [a]: tombstone(1, 1) })
      : fixture({ [a]: mark(status, 1, 1) });
    const remote = status === 'tombstone' ? fixture({}, { [a]: tombstone(2, 999999) })
      : fixture({ [a]: mark(status, 2, 999999) });
    for (const [l, r] of [[local, remote], [remote, local]]) {
      const plan = planMerge({ base: null, local: l, remote: r });
      assert.equal(plan.ready, true);
      const result = finish(plan);
      assert.deepEqual(result.data.marks, local.data.marks);
      assert.deepEqual(result.data.tombstones, local.data.tombstones);
    }
  }
});
test('P04-01 first-sync conflicting classifications return a list, no silent default', () => {
  const plan = planMerge({ base: null,
    local: fixture({ [a]: mark('tracked', 1) }), remote: fixture({ [a]: mark('ignored', 2) }) });
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.marks, {});
  assert.deepEqual(plan.conflicts.map(c => [c.key, c.reason]), [[a, 'DIFFERENT_CLASSIFICATIONS']]);
  fails(() => finish(plan), 'UNRESOLVED_CONFLICT');
});
test('P04-01 daily changed operation identity is not mistaken for unchanged classification', () => {
  const base = fixture({ [a]: mark('tracked', 1) });
  const local = fixture({ [a]: mark('tracked', 2) });
  const remote = fixture({ [a]: mark('ignored', 3) });
  const plan = planMerge({ base, local, remote });
  assert.equal(plan.conflicts[0].reason, 'BOTH_CHANGED');
});
test('P04-01 conflict resolution supports per-item and both batch directions', () => {
  const local = fixture({ [a]: mark('tracked', 1), [b]: mark('ignored', 2) });
  const remote = fixture({ [a]: mark('ignored', 3), [b]: mark('tracked', 4) });
  const plan = planMerge({ base: null, local, remote });
  assert.deepEqual(plan.conflicts.map(c => c.key), [a, b]);
  assert.deepEqual(finish(plan, { choices: { [a]: 'local', [b]: 'remote' } }).data.marks,
    { [a]: local.data.marks[a], [b]: remote.data.marks[b] });
  assert.deepEqual(finish(plan, { all: 'local' }).data.marks, local.data.marks);
  assert.deepEqual(finish(plan, { all: 'remote' }).data.marks, remote.data.marks);
});
test('P04-01 incomplete, unknown, mixed or invalid conflict choices cannot produce results', () => {
  const plan = planMerge({ base: null,
    local: fixture({ [a]: mark('tracked', 1), [b]: mark('tracked', 2) }),
    remote: fixture({ [a]: mark('ignored', 3), [b]: mark('ignored', 4) }) });
  fails(() => finish(plan, { choices: { [a]: 'local' } }), 'UNRESOLVED_CONFLICT');
  fails(() => finish(plan, { choices: { [otherLocale]: 'local' } }), 'UNKNOWN_CHOICE_KEY');
  fails(() => finish(plan, { all: 'local', choices: { [a]: 'remote' } }), 'AMBIGUOUS_CHOICES');
  fails(() => finish(plan, { all: 'newest' }), 'INVALID_CHOICE');
  fails(() => finish(plan, { choices: { [a]: 'tracked', [b]: 'remote' } }), 'UNRESOLVED_CONFLICT');
  fails(() => finish({ ...plan }, { all: 'local' }), 'INVALID_PLAN');
});
test('P04-01 clear versus an old mark always conflicts at first sync and daily sync', () => {
  const old = fixture({ [a]: mark('tracked', 1) });
  const cleared = fixture({}, { [a]: tombstone(2) });
  for (const base of [null, old, cleared]) for (const [local, remote, clearChoice] of
    [[cleared, old, 'local'], [old, cleared, 'remote']]) {
    const plan = planMerge({ base, local, remote });
    assert.equal(plan.ready, false);
    assert.equal(plan.conflicts[0].reason, 'TOMBSTONE_VS_MARK');
    fails(() => finish(plan), 'UNRESOLVED_CONFLICT');
    const result = finish(plan, { all: clearChoice });
    assert.deepEqual(result.data.marks, {});
    assert.deepEqual(result.data.tombstones, cleared.data.tombstones);
    assert.deepEqual(importBackup(exportBackup(result)).data.tombstones, cleared.data.tombstones);
  }
});
test('P04-01 two matching old marks cannot override a Tombstone already recorded in Base', () => {
  const base = fixture({}, { [a]: tombstone(3) });
  const old = fixture({ [a]: mark('tracked', 1) });
  const plan = planMerge({ base, local: old, remote: old });
  assert.equal(plan.ready, false);
  assert.equal(plan.conflicts[0].base.type, 'tombstone');
  fails(() => finish(plan), 'UNRESOLVED_CONFLICT');
});
test('P04-01 explicit user choice may restore a mark; automatic restoration stays blocked', () => {
  const plan = planMerge({ base: null, local: fixture({}, { [a]: tombstone(2) }),
    remote: fixture({ [a]: mark('tracked', 1) }) });
  const result = finish(plan, { choices: { [a]: 'remote' } });
  assert.equal(getClassification(result, a), 'tracked');
  assert.deepEqual(result.data.tombstones, {});
});
test('P04-01 old backups repeatedly encounter the retained clear and cannot silently resurrect it', () => {
  const old = fixture({ [a]: mark('ignored', 1) });
  const cleared = fixture({}, { [a]: tombstone(2) });
  const first = finish(planMerge({ base: null, local: cleared, remote: old }), { all: 'local' });
  const next = planMerge({ base: first, local: first, remote: old });
  assert.equal(next.ready, false);
  fails(() => finish(next), 'UNRESOLVED_CONFLICT');
  assert.deepEqual(finish(next, { all: 'local' }).data.tombstones, cleared.data.tombstones);
});
test('P04-01 daily missing records are rejected instead of interpreted as clears', () => {
  for (const base of [fixture({ [a]: mark('tracked', 1) }), fixture({}, { [a]: tombstone(1) })]) {
    for (const [local, remote] of [[fixture(), base], [base, fixture()], [fixture(), fixture()]])
      fails(() => planMerge({ base, local, remote }), 'MISSING_DELETION_INTENT');
  }
});
test('P04-01 omitting Base, unbound daily Base and changed dataset lineage fail safely', () => {
  const bound = fixture(), unbound = fixture({}, {}, false), changed = fixture();
  changed.data.datasetId = id(999);
  fails(() => planMerge({ local: bound, remote: bound }), 'BASE_REQUIRED');
  fails(() => planMerge({ base: unbound, local: unbound, remote: unbound }), 'BASE_UNBOUND');
  fails(() => planMerge({ base: bound, local: bound, remote: changed }), 'LINEAGE_CHANGED');
  fails(() => planMerge({ base: bound, local: changed, remote: bound }), 'LINEAGE_CHANGED');
  fails(() => planMerge({ base: null, local: bound, remote: changed }), 'LINEAGE_CHANGED');
});
test('P04-01 operation IDs cannot be reused across keys, classifications or timestamps', () => {
  const local = fixture({ [a]: mark('tracked', 1) });
  for (const remote of [fixture({ [b]: mark('tracked', 1) }), fixture({ [a]: mark('ignored', 1) }),
    fixture({ [a]: mark('tracked', 1, 999) }), fixture({}, { [a]: tombstone(1) })])
    fails(() => planMerge({ base: null, local, remote }), 'CHANGE_ID_REUSED');
});
test('P04-01 planning and resolving are immutable and bind choices to captured snapshots', () => {
  const base = fixture(), local = fixture({ [a]: mark('tracked', 1) }), remote = fixture({ [a]: mark('ignored', 2) });
  const before = JSON.stringify([base, local, remote]);
  const plan = planMerge({ base, local, remote });
  const result = finish(plan, { all: 'local' });
  assert.equal(JSON.stringify([base, local, remote]), before);
  assert.throws(() => { plan.conflicts[0].local.status = 'ignored'; }, TypeError);
  local.data.marks[a].status = 'ignored';
  assert.equal(finish(plan, { all: 'local' }).data.marks[a].status, 'tracked');
  result.data.marks[a].status = 'ignored';
  assert.equal(plan.conflicts[0].local.status, 'tracked');
  // Applying this snapshot to an actively edited store is P04-03, not implemented here.
});
test('P04-01 rejects a merged union beyond the schema record limit', () => {
  const local = fixture(), remote = fixture();
  for (let i = 0; i < 50_001; i++) {
    local.data.marks[`en-us:L${i}`] = mark('tracked', i + 1);
    remote.data.marks[`en-us:R${i}`] = mark('ignored', i + 100_001);
  }
  fails(() => finish(planMerge({ base: null, local, remote })), 'TOO_MANY_RECORDS');
});

// Enumerate finite states for algebraic invariants, in addition to concrete scenarios.
const states = ['absent', 'tracked', 'ignored', 'tombstone'];
function stateFixture(state, n) {
  return state === 'absent' ? fixture() : state === 'tombstone'
    ? fixture({}, { [a]: tombstone(n) }) : fixture({ [a]: mark(state, n) });
}
test('P04-01 state matrix: all 16 first-sync pairs are symmetric, stable and immutable', () => {
  let checked = 0;
  for (const l of states) for (const r of states) {
    const local = stateFixture(l, 10), remote = stateFixture(r, 20);
    const inputs = JSON.stringify([local, remote]);
    const plan = planMerge({ base: null, local, remote });
    const swapped = planMerge({ base: null, local: remote, remote: local });
    assert.equal(plan.ready, swapped.ready, `${l}/${r}`);
    if (plan.ready) {
      const result = finish(plan);
      assert.deepEqual(result, finish(swapped));
      assert.deepEqual(result, finish(planMerge({ base: result, local: result, remote: result })));
    } else {
      assert.equal(plan.conflicts.length, 1);
      assert.deepEqual(finish(plan, { all: 'local' }), finish(swapped, { all: 'remote' }));
      fails(() => finish(plan), 'UNRESOLVED_CONFLICT');
    }
    assert.equal(JSON.stringify([local, remote]), inputs);
    checked++;
  }
  assert.equal(checked, 16);
});
test('P04-01 state matrix: all 64 Base/Local/Remote states reject missing history or converge safely', () => {
  let rejected = 0, completed = 0, conflicted = 0;
  for (const bState of states) for (const l of states) for (const r of states) {
    const base = stateFixture(bState, 1);
    const local = stateFixture(l, l === bState ? 1 : 2);
    const remote = stateFixture(r, r === bState ? 1 : 3);
    const inputs = JSON.stringify([base, local, remote]);
    if (bState !== 'absent' && (l === 'absent' || r === 'absent')) {
      fails(() => planMerge({ base, local, remote }), 'MISSING_DELETION_INTENT');
      rejected++;
    } else {
      const plan = planMerge({ base, local, remote });
      const swapped = planMerge({ base, local: remote, remote: local });
      assert.equal(plan.ready, swapped.ready);
      if (plan.ready) {
        const result = finish(plan);
        assert.deepEqual(result, finish(swapped));
        assert.deepEqual(result, finish(planMerge({ base: result, local: result, remote: result })));
        if (bState === 'tombstone') assert.equal(getClassification(result, a), 'unclassified');
        completed++;
      } else {
        assert.deepEqual(finish(plan, { all: 'local' }), finish(swapped, { all: 'remote' }));
        fails(() => finish(plan), 'UNRESOLVED_CONFLICT');
        conflicted++;
      }
    }
    assert.equal(JSON.stringify([base, local, remote]), inputs);
  }
  assert.equal(rejected, 21);
  assert.equal(completed + conflicted, 43);
});
test('P04-01/P04-02 pure modules and backup operations execute with network and browser storage disabled', () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls++; throw Error('network forbidden in P04-01/02'); };
  try {
    assert.equal(globalThis.indexedDB, undefined);
    assert.equal(globalThis.localStorage, undefined);
    const plan = planMerge({ base: null, local: fixture({ [a]: mark('tracked', 1) }), remote: fixture() });
    assert.deepEqual(importBackup(exportBackup(finish(plan))).data.marks, plan.marks);
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
