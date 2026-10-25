import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCatalog, classificationCounts, selectProducts, validateCatalog } from '../src/catalog.mjs';
import { currentCampaigns } from './fixtures/campaigns.mjs';
import { publishSnapshot } from '../src/snapshot.mjs';
import { buildSite, siteFiles, root } from '../tools/build-site.mjs';
import * as state from '../src/poc04/sync-state.mjs';
import { fixture, a, b, id, mark, tombstone } from './fixtures/poc04.mjs';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ps-sale-site-'));
  t.after(async () => {
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('ps-sale-site-'));
    await rm(directory, { recursive: true });
  }); return directory;
}
function catalogFixture() {
  return buildCatalog(currentCampaigns.map((campaign, index) => ({
    schemaVersion: 1, scope: 'full-activity', complete: true, saleId: campaign.id,
    locale: 'zh-hant-tw', sourceUrl: campaign.sourceUrl, fetchedAt: '2026-10-25T00:00:00.000Z',
    totalCount: 1, reportedTotalCount: 1, rawProductCount: 1, uniqueProductCount: 1, duplicateProductCount: 0,
    products: [{ id: `JP0000-PPSA00001_00-${index}`, key: `zh-hant-tw:JP0000-PPSA00001_00-${index}`,
      name: 'Synthetic product', price: null, imageUrl: null, url: null, platforms: ['PS5'] }],
  })));
}
const successfulStatus = catalog => ({ state: 'success', complete: true, uniqueProductCount: catalog.uniqueProductCount,
  reports: currentCampaigns.map(campaign => ({ saleId: campaign.id, complete: true, fullValidation: 'PASS', error: null })) });

test('classification checkboxes use a union and clearing every checkbox restores all products', () => {
  const catalog = catalogFixture(), keys = catalog.products.map(product => product.key);
  const marks = { [keys[0]]: { status: 'tracked' }, [keys[1]]: { status: 'ignored' } };
  const before = structuredClone({ catalog, marks });
  for (const [statuses, indexes] of [[[], [0, 1, 2]], [['tracked'], [0]], [['ignored'], [1]],
    [['unclassified'], [2]], [['tracked', 'ignored'], [0, 1]], [['tracked', 'unclassified'], [0, 2]],
    [['ignored', 'unclassified'], [1, 2]], [['tracked', 'ignored', 'unclassified'], [0, 1, 2]],
    [['tracked', 'tracked'], [0]]]) {
    assert.deepEqual(selectProducts(catalog, marks, { statuses }).map(product => product.key), indexes.map(index => keys[index]));
  }
  assert.deepEqual({ catalog, marks }, before);
});

test('multiple classifications still intersect with campaign, search and platform filters', () => {
  const catalog = catalogFixture(), keys = catalog.products.map(product => product.key);
  const marks = { [keys[0]]: { status: 'tracked' }, [keys[1]]: { status: 'ignored' } };
  const options = { statuses: ['tracked', 'ignored'], campaign: currentCampaigns[1].id, search: '_00-1', platform: 'PS5', sort: 'price' };
  assert.deepEqual(selectProducts(catalog, marks, options).map(product => product.key), [keys[1]]);
  assert.equal(selectProducts(catalog, marks, { ...options, platform: 'PS4' }).length, 0);
  assert.equal(selectProducts(catalog, marks, { ...options, statuses: ['unclassified'] }).length, 0);
});

test('scope statistics partition products while text and checkbox filtering leaves them unchanged', () => {
  const catalog = catalogFixture(), keys = catalog.products.map(product => product.key);
  const marks = { [keys[0]]: { status: 'tracked' }, [keys[1]]: { status: 'ignored' } };
  const expected = { total: 3, unclassified: 1, tracked: 1, ignored: 1 };
  assert.deepEqual(classificationCounts(catalog.products, marks), expected);
  assert.equal(selectProducts(catalog, marks, { statuses: ['unclassified'], search: '_00-2' }).length, 1);
  assert.deepEqual(classificationCounts(catalog.products, marks), expected);
  assert.deepEqual(classificationCounts(catalog.products.filter(product => product.campaignIds.includes(currentCampaigns[0].id)), marks),
    { total: 1, unclassified: 0, tracked: 1, ignored: 0 });
  assert.deepEqual(classificationCounts([], marks), { total: 0, unclassified: 0, tracked: 0, ignored: 0 });
});

test('release snapshot validates membership, exact activities and unique product identities', async () => {
  const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(new Set(catalog.products.map(product => product.key)).size, catalog.uniqueProductCount);
});
test('publication rejects duplicated products, wrong counts and an incomplete activity list', () => {
  for (const mutate of [catalog => { catalog.products[1] = catalog.products[0]; },
    catalog => { catalog.membershipCount++; }, catalog => { catalog.campaigns.pop(); },
    catalog => { catalog.products[0].offers[0].campaignId = 'unknown'; }]) {
    const catalog = catalogFixture(); mutate(catalog); assert.throws(() => validateCatalog(catalog));
  }
});
test('failed refresh cannot change either previously published data file', async t => {
  const directory = await temporary(t), output = pathToFileURL(directory + '/');
  await writeFile(new URL('catalog.json', output), 'previous');
  await writeFile(new URL('refresh-status.json', output), 'previous-status');
  await assert.rejects(publishSnapshot(catalogFixture(), { state: 'failed' }, output));
  assert.equal(await readFile(new URL('catalog.json', output), 'utf8'), 'previous');
  assert.equal(await readFile(new URL('refresh-status.json', output), 'utf8'), 'previous-status');
});
test('successful refresh publishes only an entirely validated snapshot', async t => {
  const directory = await temporary(t), output = pathToFileURL(directory + '/'), catalog = catalogFixture();
  await publishSnapshot(catalog, successfulStatus(catalog), output);
  assert.deepEqual(JSON.parse(await readFile(new URL('catalog.json', output), 'utf8')), catalog);
});
test('static package has only public allowlisted files, relative assets and versioned module imports', async t => {
  const directory = await temporary(t);
  for (const name of ['web', 'src', 'data']) await cp(join(root, name), join(directory, name), { recursive: true });
  await mkdir(join(directory, '.local')); await writeFile(join(directory, '.local/private.txt'), 'synthetic private sentinel');
  const result = await buildSite({ projectRoot: directory });
  assert.deepEqual(result.files.sort(), [...siteFiles].sort());
  assert.ok(!result.files.some(path => /tests|\.local|google-session|node_modules/.test(path)));
  const html = await readFile(join(result.directory, 'index.html'), 'utf8');
  assert.ok(html.includes(`src="./app.mjs?v=${result.version}"`));
  assert.ok(html.includes(`src="./shared/google-auth.js?v=${result.version}"`));
  assert.ok(html.includes(`src="./cloud-config.js?v=${result.version}"`));
  const app = await readFile(join(result.directory, 'app.mjs'), 'utf8');
  assert.ok(app.includes(`'./src/catalog.mjs?v=${result.version}'`));
  const shared = await readFile(join(result.directory, 'src/poc04/sync-state.mjs'), 'utf8');
  assert.ok(shared.includes(`'./personal-data.mjs?v=${result.version}'`));
  assert.ok(!app.includes('google-session'));
  await writeFile(join(directory, 'data/catalog.json'), '{}');
  await assert.rejects(buildSite({ projectRoot: directory }));
  assert.equal(await readFile(join(result.directory, 'index.html'), 'utf8'), html);
});
test('personal backup merge preserves independent marks, clear history and pending operations', () => {
  const local = state.classify(state.emptyState(), a, 'tracked', { changeId: id(1), updatedAt: 1 });
  const incoming = fixture({ [b]: mark('ignored', 2) }, { 'en-us:ORPHAN_PRODUCT': tombstone(3) });
  const merged = state.mergeLocalBackup(local, incoming, local.localRevision);
  assert.equal(merged.document.data.marks[a].status, 'tracked');
  assert.equal(merged.document.data.marks[b].status, 'ignored');
  assert.ok(merged.document.data.tombstones['en-us:ORPHAN_PRODUCT']);
  assert.equal(merged.document.data.datasetId, null);
  assert.equal(Object.keys(merged.outbox).length, 3);
  assert.equal(state.validateState(merged).base, null);
});
test('personal backup conflicts follow the explicit choice and never silently resurrect a clear', () => {
  const local = state.classify(state.classify(state.emptyState(), a, 'tracked', { changeId: id(1), updatedAt: 1 }),
    a, 'unclassified', { changeId: id(2), updatedAt: 2 });
  const incoming = fixture({ [a]: mark('ignored', 3) });
  assert.equal(state.planLocalBackup(local, incoming).conflicts.length, 1);
  assert.ok(state.mergeLocalBackup(local, incoming, local.localRevision, 'local').document.data.tombstones[a]);
  assert.equal(state.mergeLocalBackup(local, incoming, local.localRevision, 'remote').document.data.marks[a].status, 'ignored');
});
test('personal import rejects a stale preview and never changes the input', () => {
  const local = state.emptyState(), incoming = fixture({ [a]: mark('tracked', 1) });
  const changed = state.classify(local, b, 'ignored', { changeId: id(2), updatedAt: 2 });
  assert.throws(() => state.mergeLocalBackup(changed, incoming, local.localRevision), error => error.code === 'STALE_SNAPSHOT');
  assert.equal(Object.keys(local.document.data.marks).length, 0);
  assert.equal(Object.keys(changed.document.data.marks).length, 1);
});
