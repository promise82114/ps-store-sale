import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { campaignById, parseCampaignId, taiwanDateTime, validateRegistry, campaignState } from '../src/campaigns.mjs';
import { buildCatalog, catalogForDisplay, validateCatalog } from '../src/catalog.mjs';
import { loadSavedState, manageCampaign, rebuildSavedCatalog } from '../src/campaign-store.mjs';
import { currentCampaigns } from './fixtures/campaigns.mjs';

const newId = '11111111-2222-4333-8444-555555555555';
const input = { operation: 'add', id: newId, name: '週末活動', startsAt: '2026-10-25 00:00', endsAt: '2026-10-28 00:00' };
function source(campaign, index = 0) {
  return { schemaVersion: 1, scope: 'full-activity', complete: true, saleId: campaign.id,
    locale: 'zh-hant-tw', sourceUrl: campaign.sourceUrl, fetchedAt: '2026-10-25T00:00:00.000Z',
    totalCount: 1, reportedTotalCount: 1, rawProductCount: 1, uniqueProductCount: 1, duplicateProductCount: 0,
    products: [{ id: `JP0000-PPSA00001_00-C${index}`, key: `zh-hant-tw:JP0000-PPSA00001_00-C${index}`,
      name: 'Synthetic product', price: { discountedPrice: 'NT$50' }, imageUrl: null, url: null, platforms: ['PS5'] }] };
}
async function setup(t, campaigns = currentCampaigns.slice(0, 2)) {
  const root = await mkdtemp(join(tmpdir(), 'ps-sale-campaign-'));
  t.after(async () => {
    assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith('ps-sale-campaign-'));
    await rm(root, { recursive: true });
  });
  const directory = pathToFileURL(join(root, 'data') + '/'), artifacts = pathToFileURL(join(root, 'artifacts') + '/');
  await mkdir(new URL('campaign-snapshots/', directory), { recursive: true });
  await writeFile(new URL('campaigns.json', directory), JSON.stringify({ schemaVersion: 1, campaigns }));
  for (const [index, campaign] of campaigns.entries())
    await writeFile(new URL(`campaign-snapshots/${campaign.id}.json`, directory), JSON.stringify(source(campaign, index)));
  await rebuildSavedCatalog({ directory });
  return { directory, artifacts };
}
async function contents(directory) {
  const files = {};
  async function walk(url, prefix = '') {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(new URL(entry.name + '/', url), prefix + entry.name + '/');
      else files[prefix + entry.name] = await readFile(new URL(entry.name, url), 'utf8');
    }
  }
  await walk(directory); return files;
}
function runner(calls, failure = null) {
  return async options => {
    calls.push(options.campaign.id);
    assert.deepEqual(options.args, ['--mode', 'full', '--sale-url', options.campaign.sourceUrl]);
    if (failure) return { exitCode: 1, report: { complete: false, error: { code: failure } } };
    await mkdir(options.output, { recursive: true });
    await writeFile(new URL('sale-products.json', options.output), JSON.stringify(source(options.campaign, 99)));
    return { exitCode: 0, report: { complete: true, fullValidation: 'PASS', error: null } };
  };
}

test('activity input accepts canonical ID or exact official URL, rejects path and host injection', () => {
  assert.equal(parseCampaignId(newId), newId);
  assert.equal(parseCampaignId(campaignById(newId).sourceUrl), newId);
  for (const value of ['../../data', currentCampaigns[0].id.toUpperCase(), campaignById(newId).sourceUrl + '?x=1',
    campaignById(newId).sourceUrl.replace('.com/', '.com.evil/'), campaignById(newId).sourceUrl.replace(/\/1$/, '/2')])
    assert.throws(() => parseCampaignId(value));
});
test('Taiwan period conversion is explicit and invalid calendar dates are rejected', () => {
  assert.equal(taiwanDateTime('2026-10-25 00:00'), '2026-10-24T16:00:00.000Z');
  assert.equal(taiwanDateTime('2026-10-25T22:59'), '2026-10-25T14:59:00.000Z');
  for (const value of ['2026-02-30 00:00', '2026-10-25 24:00', '2026-10-25', '2026-10-25T00:00Z'])
    assert.throws(() => taiwanDateTime(value));
});
test('new activity requires name and both period boundaries before any fetch', async t => {
  const config = await setup(t), calls = [];
  for (const override of [{ name: '' }, { startsAt: '' }, { endsAt: '' }, { endsAt: input.startsAt }])
    await assert.rejects(manageCampaign({ ...input, ...config, ...override, run: runner(calls) }));
  assert.equal(calls.length, 0);
});
test('add fetches only the new activity once and preserves all prior snapshot bytes', async t => {
  const config = await setup(t), before = await contents(config.directory), calls = [];
  const result = await manageCampaign({ ...input, ...config, run: runner(calls) });
  assert.deepEqual(calls, [newId]); assert.equal(result.fetched, true);
  const after = await contents(config.directory);
  for (const key of Object.keys(before).filter(key => key.startsWith('campaign-snapshots/'))) assert.equal(after[key], before[key]);
  const saved = await loadSavedState(config.directory);
  assert.equal(saved.registry.campaigns.length, 3);
  assert.equal(saved.registry.campaigns[2].startsAt, '2026-10-24T16:00:00.000Z');
});
test('a duplicate add is rejected without fetching or rewriting saved files', async t => {
  const config = await setup(t), before = await contents(config.directory), calls = [];
  await assert.rejects(manageCampaign({ ...input, ...config, id: currentCampaigns[0].id, run: runner(calls) }), error => error.code === 'CAMPAIGN_ALREADY_EXISTS');
  assert.equal(calls.length, 0); assert.deepEqual(await contents(config.directory), before);
});
test('failed add preserves registry, complete catalog and every existing snapshot', async t => {
  const config = await setup(t), before = await contents(config.directory), calls = [];
  await assert.rejects(manageCampaign({ ...input, ...config, run: runner(calls, 'ACCESS_DENIED') }), error => error.code === 'ACCESS_DENIED');
  assert.deepEqual(calls, [newId]); assert.deepEqual(await contents(config.directory), before);
});
test('invalid fetched source cannot be persisted or replace the catalog', async t => {
  const config = await setup(t), before = await contents(config.directory);
  await assert.rejects(manageCampaign({ ...input, ...config, run: async options => {
    await mkdir(options.output, { recursive: true });
    await writeFile(new URL('sale-products.json', options.output), JSON.stringify({ ...source(options.campaign), complete: false }));
    return { exitCode: 0, report: { complete: true, fullValidation: 'PASS' } };
  } }));
  assert.deepEqual(await contents(config.directory), before);
});
test('metadata edit changes the label and dates with zero fetches and unchanged snapshots', async t => {
  const config = await setup(t), before = await contents(config.directory), calls = [];
  const result = await manageCampaign({ ...input, ...config, operation: 'edit', id: currentCampaigns[0].id, run: runner(calls) });
  assert.equal(result.fetched, false); assert.equal(calls.length, 0);
  const after = await contents(config.directory);
  for (const key of Object.keys(before).filter(key => key.startsWith('campaign-snapshots/'))) assert.equal(after[key], before[key]);
  assert.equal((await loadSavedState(config.directory)).catalog.campaigns[0].label, input.name);
});
test('explicit refetch replaces only the chosen snapshot', async t => {
  const config = await setup(t), before = await contents(config.directory), calls = [], id = currentCampaigns[0].id;
  await manageCampaign({ ...config, operation: 'refetch', id, run: runner(calls) });
  assert.deepEqual(calls, [id]);
  const after = await contents(config.directory);
  assert.notEqual(after[`campaign-snapshots/${id}.json`], before[`campaign-snapshots/${id}.json`]);
  assert.equal(after[`campaign-snapshots/${currentCampaigns[1].id}.json`], before[`campaign-snapshots/${currentCampaigns[1].id}.json`]);
});
test('saved-only rebuild preserves product data and fetch timestamps with no transport', async t => {
  const config = await setup(t), before = await contents(config.directory);
  const rebuilt = await rebuildSavedCatalog(config);
  assert.equal(rebuilt.status.mode, 'saved-campaigns');
  assert.equal((await contents(config.directory))['catalog.json'], before['catalog.json']);
});
test('catalog supports zero, one and five activities instead of an exact three', () => {
  for (const count of [0, 1, 5]) {
    const campaigns = Array.from({ length: count }, (_, index) => ({ ...campaignById(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`), label: `活動 ${index}` }));
    const catalog = buildCatalog(campaigns.map(source), campaigns);
    assert.equal(validateCatalog(catalog).campaigns.length, count);
    assert.equal(catalog.products.length, count);
  }
});
test('period boundaries exclude ended activity prices and retain history without altering saved data', () => {
  const campaigns = currentCampaigns.slice(0, 2).map(campaign => ({ ...campaign,
    startsAt: '2026-10-24T16:00:00.000Z', endsAt: '2026-10-26T16:00:00.000Z' }));
  campaigns[0].endsAt = '2026-10-25T16:00:00.000Z';
  const sources = campaigns.map(campaign => source(campaign)); sources[0].products[0].price.discountedPrice = 'NT$10';
  const catalog = buildCatalog(sources, campaigns), before = structuredClone(catalog), now = Date.parse('2026-10-25T16:00:00.000Z');
  assert.equal(campaignState(campaigns[0], now), 'ended');
  const active = catalogForDisplay(catalog, { now });
  assert.equal(active.campaigns.length, 1); assert.equal(active.products[0].price.discountedPrice, 'NT$50');
  assert.equal(catalogForDisplay(catalog, { now, includeHistory: true }).campaigns.length, 2);
  assert.deepEqual(catalog, before);
});
test('archive and restore use saved snapshots without a network operation', async t => {
  const config = await setup(t), calls = [], id = currentCampaigns[0].id;
  await manageCampaign({ ...config, operation: 'archive', id, run: runner(calls) });
  assert.equal((await loadSavedState(config.directory)).registry.campaigns[0].enabled, false);
  await manageCampaign({ ...config, operation: 'restore', id, run: runner(calls) });
  assert.equal((await loadSavedState(config.directory)).registry.campaigns[0].enabled, true);
  assert.equal(calls.length, 0);
});
test('registry rejects duplicate IDs and reversed periods', () => {
  assert.throws(() => validateRegistry({ schemaVersion: 1, campaigns: [currentCampaigns[0], currentCampaigns[0]] }));
  assert.throws(() => validateRegistry({ schemaVersion: 1, campaigns: [{ ...currentCampaigns[0],
    startsAt: '2026-10-26T00:00:00.000Z', endsAt: '2026-10-25T00:00:00.000Z' }] }));
});
