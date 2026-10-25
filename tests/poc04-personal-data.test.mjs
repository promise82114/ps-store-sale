import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocument, exportBackup, getClassification, importBackup, limits,
  personalKey, setClassification, validateDocument } from '../src/poc04/personal-data.mjs';
import { a, b, otherLocale, fixture, id, mark, tombstone } from './fixtures/poc04.mjs';

const fails = (action, code) => assert.throws(action, error => error.code === code);
const edit = (document, key, status, n) => setClassification(document, key, status, { changeId: id(n), updatedAt: n });

test('P04-02 never-classified remains sparse; no fourth stored category', () => {
  const empty = createDocument();
  assert.equal(getClassification(empty, a), 'unclassified');
  assert.deepEqual(edit(empty, a, 'unclassified', 1), empty);
  assert.equal(exportBackup(empty).includes('unclassified'), false);
});
test('P04-02 tracked -> ignored -> unclassified writes a persistent tombstone', () => {
  const empty = createDocument();
  const tracked = edit(empty, a, 'tracked', 1);
  const ignored = edit(tracked, a, 'ignored', 2);
  const cleared = edit(ignored, a, 'unclassified', 3);
  assert.equal(getClassification(tracked, a), 'tracked');
  assert.equal(getClassification(ignored, a), 'ignored');
  assert.equal(getClassification(cleared, a), 'unclassified');
  assert.deepEqual(cleared.data.marks, {});
  assert.deepEqual(cleared.data.tombstones, { [a]: tombstone(3) });
  assert.deepEqual(edit(cleared, a, 'unclassified', 4), cleared);
  assert.deepEqual(empty, createDocument());
});
test('P04-02 explicit reclassification replaces a tombstone with a new operation', () => {
  const cleared = fixture({}, { [a]: tombstone(1) });
  const tracked = edit(cleared, a, 'tracked', 2);
  assert.deepEqual(tracked.data.tombstones, {});
  assert.equal(tracked.data.marks[a].changeId, id(2));
  fails(() => edit(cleared, a, 'tracked', 1), 'CHANGE_ID_REUSED');
});
test('P04-02 unchanged classifications preserve operation identity', () => {
  const document = fixture({ [a]: mark('tracked', 1) });
  assert.deepEqual(edit(document, a, 'tracked', 99), document);
});
test('P04-02 locale and Product ID are independent; editions never inherit marks', () => {
  const document = edit(fixture(), a, 'tracked', 1);
  assert.equal(personalKey('zh-hant-tw', a.split(':')[1]), a);
  assert.equal(getClassification(document, b), 'unclassified');
  assert.equal(getClassification(document, otherLocale), 'unclassified');
  const next = edit(document, b, 'ignored', 2);
  assert.equal(getClassification(next, a), 'tracked');
  assert.equal(getClassification(next, b), 'ignored');
});
test('P04-02 backup round-trip preserves orphan marks, tombstones and unbound lineage', () => {
  for (const bound of [false, true]) {
    const document = fixture({ [a]: mark('tracked', 1) }, { [b]: tombstone(2) }, bound);
    assert.deepEqual(importBackup(exportBackup(document)), document);
    // No catalog is supplied: activity removal cannot discard either record.
    assert.deepEqual(Object.keys(importBackup(exportBackup(document)).data.marks), [a]);
  }
});
test('P04-02 canonical exports ignore map insertion order and are detached copies', () => {
  const x = fixture({ [b]: mark('ignored', 2), [a]: mark('tracked', 1) });
  const y = fixture({ [a]: mark('tracked', 1), [b]: mark('ignored', 2) });
  assert.equal(exportBackup(x), exportBackup(y));
  const copy = validateDocument(x);
  copy.data.marks[a].status = 'ignored';
  assert.equal(x.data.marks[a].status, 'tracked');
});
test('P04-02 timestamps may run backwards without suppressing an explicit edit', () => {
  const document = fixture({ [a]: mark('tracked', 1, 10000) });
  const next = edit(document, a, 'ignored', 2);
  assert.equal(next.data.marks[a].status, 'ignored');
  assert.equal(next.data.marks[a].updatedAt, 2);
});

const invalidCases = [
  ['future outer schema', d => { d.schemaVersion = 2; }, 'UNSUPPORTED_SCHEMA'],
  ['future inner schema', d => { d.data.schemaVersion = 2; }, 'UNSUPPORTED_SCHEMA'],
  ['another project', d => { d.projectId = 'edfwb2-checklist'; }, 'WRONG_PROJECT'],
  ['another kind', d => { d.data.kind = 'ps-game-base'; }, 'WRONG_KIND'],
  ['missing marks', d => { delete d.data.marks; }, 'INVALID_FIELDS'],
  ['missing tombstones', d => { delete d.data.tombstones; }, 'INVALID_FIELDS'],
  ['missing lineage field', d => { delete d.data.datasetId; }, 'INVALID_FIELDS'],
  ['partial null lineage', d => { d.data.datasetId = null; }, 'INVALID_LINEAGE'],
  ['invalid UUID', d => { d.data.revisionId = 'revision'; }, 'INVALID_ID'],
  ['negative time', d => { d.data.updatedAt = -1; }, 'INVALID_TIME'],
  ['non-integer time', d => { d.data.marks[a].updatedAt = 0.1; }, 'INVALID_TIME'],
  ['non-finite time', d => { d.data.updatedAt = Infinity; }, 'INVALID_TIME'],
  ['envelope time mismatch', d => { d.updatedAt = '2026-10-20'; }, 'INVALID_ENVELOPE_TIME'],
  ['stored unclassified', d => { d.data.marks[a].status = 'unclassified'; }, 'INVALID_STATUS'],
  ['extra category', d => { d.data.marks[a].status = 'purchased'; }, 'INVALID_STATUS'],
  ['mark without operation', d => { delete d.data.marks[a].changeId; }, 'INVALID_FIELDS'],
  ['invalid operation UUID', d => { d.data.marks[a].changeId = 'x'; }, 'INVALID_ID'],
  ['duplicate operation IDs', d => { d.data.marks[b] = { ...d.data.marks[a] }; }, 'DUPLICATE_CHANGE_ID'],
  ['mark and tombstone overlap', d => { d.data.tombstones[a] = tombstone(2); }, 'OVERLAPPING_RECORDS'],
  ['malformed locale key', d => { d.data.marks['ZH-hant-tw:PRODUCT_A'] = mark('tracked', 2); }, 'INVALID_PRODUCT_KEY'],
  ['URL instead of product ID', d => { d.data.marks['zh-hant-tw:https://example.com'] = mark('tracked', 2); }, 'INVALID_PRODUCT_KEY'],
  ['prototype key', d => { Object.defineProperty(d.data.marks, '__proto__', { value: mark('tracked', 2), enumerable: true }); }, 'INVALID_PRODUCT_KEY'],
  ['array map', d => { d.data.tombstones = []; }, 'INVALID_OBJECT'],
  ['unknown field', d => { d.data.surprise = true; }, 'INVALID_FIELDS'],
  ['token', d => { d.accessToken = 'synthetic-not-a-token'; }, 'INVALID_FIELDS'],
  ['cookie', d => { d.data.cookie = 'synthetic'; }, 'INVALID_FIELDS'],
  ['price', d => { d.data.marks[a].price = 100; }, 'INVALID_FIELDS'],
  ['image URL', d => { d.data.marks[a].imageUrl = 'https://example.com'; }, 'INVALID_FIELDS'],
  ['play history', d => { d.data.marks[a].playTime = 50; }, 'INVALID_FIELDS'],
  ['purchase state', d => { d.data.marks[a].purchased = true; }, 'INVALID_FIELDS'],
];
for (const [name, mutate, code] of invalidCases) test(`P04-02 rejects ${name} without mutating input`, () => {
  const document = fixture({ [a]: mark('tracked', 1) });
  mutate(document);
  const before = structuredClone(document);
  fails(() => validateDocument(document), code);
  assert.deepEqual(document, before);
});
test('P04-02 rejects malformed JSON and oversized UTF-8 backup text', () => {
  fails(() => importBackup('{'), 'INVALID_JSON');
  fails(() => importBackup(null), 'INVALID_JSON');
  fails(() => importBackup('界'.repeat(Math.floor(limits.bytes / 3) + 1)), 'DOCUMENT_TOO_LARGE');
});
test('P04-02 rejects excessive record counts before applying data', () => {
  const document = fixture();
  for (let i = 0; i <= limits.records; i++) document.data.marks[`en-us:P${i}`] = mark('tracked', i + 1);
  fails(() => validateDocument(document), 'TOO_MANY_RECORDS');
});
test('P04-02 does not evaluate accessors on untrusted objects', () => {
  const document = fixture();
  Object.defineProperty(document.data, 'marks', { enumerable: true, get() { throw Error('getter must not run'); } });
  fails(() => validateDocument(document), 'INVALID_OBJECT');
});
