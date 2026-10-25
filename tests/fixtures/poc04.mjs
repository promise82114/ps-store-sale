import { createDocument } from '../../src/poc04/personal-data.mjs';

export const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const a = 'zh-hant-tw:JP0000-PPSA00001_00-EDITION_A';
export const b = 'zh-hant-tw:JP0000-PPSA00001_00-EDITION_B';
export const otherLocale = 'en-us:JP0000-PPSA00001_00-EDITION_A';
export const mark = (status, n, updatedAt = n) => ({ status, changeId: id(n), updatedAt });
export const tombstone = (n, updatedAt = n) => ({ changeId: id(n), updatedAt });
export function fixture(marks = {}, tombstones = {}, bound = true) {
  const document = createDocument(bound ? { datasetId: id(900), revisionId: id(901) } : {});
  document.data.marks = structuredClone(marks);
  document.data.tombstones = structuredClone(tombstones);
  return document;
}
export const finishOptions = { revisionId: id(902) };
