import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'graphql';
import { apiUrl, defaultUrl, saleId, validatePage } from '../src/diagnostic.mjs';
import { createClient, DiagnosticError } from '../src/http.mjs';
import { fetchFullActivity, readPage } from '../src/pagination.mjs';
import { runDiagnostic } from '../src/runner.mjs';
import { currentCampaigns } from './fixtures/campaigns.mjs';
import { buildCatalog, priceNumber, selectProducts } from '../src/catalog.mjs';


function campaignSource(campaign, index) {
  const data = payload(0, 1);
  data.data.categoryGridRetrieve.id = campaign.id;
  data.data.categoryGridRetrieve.products[0].id = `JP0000-PPSA00001_00-${index < 2 ? 'SHARED' : 'EDITION_B'}`;
  const page = validatePage(data, { expectedSaleId: campaign.id, deriveProductUrls: true });
  return { schemaVersion: 1, scope: 'full-activity', complete: true, saleId: campaign.id,
    locale: 'zh-hant-tw', sourceUrl: campaign.sourceUrl, fetchedAt: '2026-10-25T00:00:00.000Z',
    totalCount: 1, reportedTotalCount: 1, ...page };
}
const currentSources = () => currentCampaigns.map(campaignSource);

test('current campaign ID is used for every page and both boundary checks', async () => {
  const selected = currentCampaigns[2], calls = [], report = {};
  const result = await fetchFullActivity(async url => {
    const variables = JSON.parse(new URL(url).searchParams.get('variables'));
    calls.push(variables.id); const data = payload(variables.pageArgs.offset, 25);
    data.data.categoryGridRetrieve.id = selected.id;
    return { text: JSON.stringify(data), httpStatus: 200 };
  }, 'a'.repeat(64), report, { expectedSaleId: selected.id });
  assert.equal(result.totalCount, 25); assert.deepEqual(calls, Array(4).fill(selected.id));
  assert.throws(() => validatePage(payload(0, 1), { expectedSaleId: selected.id }), error => error.code === 'SCHEMA_MISMATCH');
});
test('three-campaign catalog keeps overlapping membership and distinct same-name editions', () => {
  const sources = currentSources(), before = structuredClone(sources), catalog = buildCatalog(sources, currentCampaigns);
  assert.equal(catalog.uniqueProductCount, 2); assert.equal(catalog.membershipCount, 3);
  assert.equal(catalog.overlappingMembershipCount, 1);
  assert.deepEqual(catalog.products[0].campaignIds, currentCampaigns.slice(0, 2).map(campaign => campaign.id));
  assert.equal(catalog.products[0].offers.length, 2);
  assert.equal(catalog.products[0].name, catalog.products[1].name);
  assert.deepEqual(sources, before);
});
test('incomplete, wrong-campaign and duplicate source data cannot become a complete catalog', () => {
  for (const mutate of [sources => sources.pop(), sources => { sources[0].complete = false; },
    sources => { sources[0].saleId = sources[1].saleId; }, sources => { sources[0].totalCount = 2; },
    sources => { sources[0].products[0].key = 'wrong'; }]) {
    const sources = currentSources(); mutate(sources); assert.throws(() => buildCatalog(sources, currentCampaigns));
  }
});
test('local catalog filtering preserves personal marks and handles unknown prices last', () => {
  const catalog = buildCatalog(currentSources(), currentCampaigns), first = catalog.products[0], second = catalog.products[1];
  first.price = { discountedPrice: 'NT$1,234', discountText: '-75%' }; second.price = null;
  const marks = { [first.key]: { status: 'tracked' }, orphan: { status: 'ignored' } }, before = structuredClone(marks);
  assert.equal(priceNumber(first.price), 1234); assert.equal(priceNumber({ discountedPrice: '???' }), null);
  assert.equal(priceNumber({ discountedPrice: '免費' }), 0);
  assert.deepEqual(selectProducts(catalog, marks, { status: 'tracked' }).map(item => item.key), [first.key]);
  assert.deepEqual(selectProducts(catalog, marks, { campaign: currentCampaigns[2].id }).map(item => item.key), [second.key]);
  assert.deepEqual(selectProducts(catalog, marks, { sort: 'price' }).map(item => item.key), [first.key, second.key]);
  assert.equal(selectProducts(catalog, marks, { search: 'EDITION_B' }).length, 1);
  first.offers[1].price = { discountedPrice: 'NT$99' };
  assert.equal(selectProducts(catalog, marks, { campaign: currentCampaigns[1].id })[0].price.discountedPrice, 'NT$99');
  assert.equal(first.price.discountedPrice, 'NT$1,234');
  assert.deepEqual(marks, before);
});
const hash = 'a'.repeat(64);
const noWait = async () => {};
function payload(offset, totalCount, size = 24, prefix = 'A') {
  const count = Math.max(0, Math.min(size, totalCount - offset));
  return { data: { categoryGridRetrieve: {
    id: saleId, pageInfo: { offset, size, totalCount, isLast: offset + count === totalCount },
    products: Array.from({ length: count }, (_, index) => ({
      id: `JP0000-PPSA00001_00-${prefix}${offset + index}`, name: 'Same name',
      price: { basePrice: 'NT$100', discountedPrice: 'NT$70', discountText: '-30%' },
      media: [{ type: 'IMAGE', role: 'MASTER', url: `https://image.api.playstation.com/${offset + index}.jpg` }],
    })),
  } } };
}
const response = (data, status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
});
const variables = url => JSON.parse(new URL(url).searchParams.get('variables'));
const jsonGet = getPayload => async url => ({ text: JSON.stringify(await getPayload(variables(url))), httpStatus: 200 });

for (const total of [1, 23, 24, 25, 48, 73]) {
  test(`complete pagination uses runtime total ${total}, including exact-multiple last pages`, async () => {
    const calls = [], report = {};
    const result = await fetchFullActivity(jsonGet(({ pageArgs }) => {
      calls.push(pageArgs); return payload(pageArgs.offset, total, pageArgs.size);
    }), hash, report);
    const pageCount = Math.ceil(total / 24);
    assert.equal(result.products.length, total);
    assert.equal(result.uniqueProductCount, total);
    assert.equal(result.totalCount, total);
    assert.equal(report.pageCount, pageCount);
    assert.equal(report.sweeps[0].boundaryVerification, 'PASS');
    assert.equal(report.sweeps[0].accepted, true);
    assert.deepEqual(calls.slice(0, pageCount).map(call => call.offset), Array.from({ length: pageCount }, (_, i) => i * 24));
    assert.equal(calls.length, pageCount + (pageCount === 1 ? 1 : 2));
  });
}

test('effective API page size controls subsequent offsets and request sizes', async () => {
  const calls = [], report = {};
  await fetchFullActivity(jsonGet(({ pageArgs }) => {
    calls.push(pageArgs);
    return payload(pageArgs.offset, 17, pageArgs.offset === 14 ? 3 : 7);
  }), hash, report);
  assert.deepEqual(calls.slice(0, 3), [{ offset: 0, size: 24 }, { offset: 7, size: 7 }, { offset: 14, size: 7 }]);
  assert.equal(report.uniqueProductCount, 17);
});

test('missing optional isLast still requires exact coverage and total agreement', async () => {
  const report = {};
  const result = await fetchFullActivity(jsonGet(({ pageArgs }) => {
    const data = payload(pageArgs.offset, 26); delete data.data.categoryGridRetrieve.pageInfo.isLast; return data;
  }), hash, report);
  assert.equal(result.totalCount, 26);
  assert.equal(report.sweeps[0].pages.length, 4);
});

test('total changes trigger one fresh sweep without mixing products from the discarded sweep', async () => {
  const report = {};
  const result = await fetchFullActivity(jsonGet(({ pageArgs }) => {
    const attempt = report.sweeps.length;
    return payload(pageArgs.offset, attempt === 1 && pageArgs.offset === 0 ? 25 : 26, pageArgs.size, attempt === 1 ? 'OLD' : 'NEW');
  }), hash, report);
  assert.equal(report.sweeps.length, 2);
  assert.equal(report.sweeps[0].error.code, 'TOTAL_COUNT_CHANGED');
  assert.equal(report.sweeps[0].accepted, false);
  assert.equal(report.sweeps[1].accepted, true);
  assert.equal(result.products.length, 26);
  assert.ok(result.products.every(product => product.id.includes('NEW')));
});

test('persistent total changes fail after two sweeps and retain classified partial statistics', async () => {
  const report = {};
  await assert.rejects(fetchFullActivity(jsonGet(({ pageArgs }) => payload(pageArgs.offset, pageArgs.offset === 0 ? 25 : 26)), hash, report), error => {
    assert.equal(error.code, 'TOTAL_COUNT_CHANGED');
    assert.equal(error.partial.products.length, 24);
    return true;
  });
  assert.equal(report.sweeps.length, 2);
  assert.ok(report.sweeps.every(sweep => !sweep.accepted));
  assert.equal(report.fullValidation, 'FAIL');
});

test('shrinking totals are classified before an out-of-range offset can masquerade as an ordinary empty page', async () => {
  const report = {};
  await assert.rejects(fetchFullActivity(jsonGet(({ pageArgs }) => payload(pageArgs.offset, pageArgs.offset === 0 ? 25 : 10)), hash, report), { code: 'TOTAL_COUNT_CHANGED' });
  assert.equal(report.sweeps.length, 2);
});

test('boundary ID changes trigger a bounded retry and a stable second sweep is accepted', async () => {
  const report = {};
  const result = await fetchFullActivity(jsonGet(({ pageArgs }) => {
    const sweep = report.sweeps.at(-1);
    const verifying = sweep.pages.at(-1).purpose !== 'fetch';
    return payload(pageArgs.offset, 25, pageArgs.size, sweep.attempt === 1 && !verifying ? 'OLD' : 'NEW');
  }), hash, report);
  assert.equal(report.sweeps[0].error.code, 'BOUNDARY_CHANGED');
  assert.equal(report.sweeps.length, 2);
  assert.ok(result.products.every(product => product.id.includes('NEW')));
});

test('last boundary changes also fail, even if all initial coverage and unique counts matched', async () => {
  const report = {};
  await assert.rejects(fetchFullActivity(jsonGet(({ pageArgs }) => {
    const purpose = report.sweeps.at(-1).pages.at(-1).purpose;
    return payload(pageArgs.offset, 25, pageArgs.size, purpose === 'verify-last' ? 'CHANGED' : 'BASE');
  }), hash, report), { code: 'BOUNDARY_CHANGED' });
  assert.equal(report.sweeps.length, 2);
  assert.equal(report.uniqueProductCount, 25);
  assert.equal(report.fullValidation, 'FAIL');
});

test('duplicate IDs across pages retain occurrence counts and cannot produce full success', async () => {
  const report = {};
  await assert.rejects(fetchFullActivity(jsonGet(({ pageArgs }) => {
    const data = payload(pageArgs.offset, 48);
    if (pageArgs.offset === 24) data.data.categoryGridRetrieve.products[0].id = 'JP0000-PPSA00001_00-A0';
    return data;
  }), hash, report), error => {
    assert.equal(error.code, 'DUPLICATE_PRODUCT_ID');
    assert.equal(error.partial.products.length, 47);
    return true;
  });
  assert.equal(report.rawProductCount, 48);
  assert.equal(report.uniqueProductCount, 47);
  assert.equal(report.duplicateProductCount, 1);
  assert.equal(report.duplicateIdCount, 1);
  assert.deepEqual(report.duplicateIds, [{ id: 'JP0000-PPSA00001_00-A0', occurrences: 2 }]);
});

test('repeated products with increasing offsets are detected as no progress', async () => {
  const report = {};
  await assert.rejects(fetchFullActivity(jsonGet(({ pageArgs }) => {
    const data = payload(pageArgs.offset, 48);
    if (pageArgs.offset) data.data.categoryGridRetrieve.products = payload(0, 48).data.categoryGridRetrieve.products;
    return data;
  }), hash, report), { code: 'NO_PROGRESS' });
  assert.equal(report.duplicateProductCount, 24);
  assert.equal(report.pageCount, 2);
});

test('wrong returned offsets, zero/oversized page sizes, empty nonfinal pages and contradictory isLast stop safely', async () => {
  for (const mutation of [
    grid => { grid.pageInfo.offset = 0; },
    grid => { grid.pageInfo.size = 0; },
    grid => { grid.pageInfo.size = 25; },
    grid => { grid.products = []; },
    grid => { grid.pageInfo.isLast = true; },
  ]) {
    const report = {};
    await assert.rejects(fetchFullActivity(jsonGet(({ pageArgs }) => {
      const data = payload(pageArgs.offset, 73);
      if (pageArgs.offset) mutation(data.data.categoryGridRetrieve);
      return data;
    }), hash, report), error => ['INVALID_PAGE_INFO', 'INCONSISTENT_PAGE'].includes(error.code));
    assert.equal(report.sweeps.length, 1);
    assert.equal(report.pageCount, 1);
  }
});

test('page count and total-duration limits prevent unbounded activity loops', async () => {
  const report = {};
  await assert.rejects(fetchFullActivity(jsonGet(({ pageArgs }) => payload(pageArgs.offset, 73)), hash, report, { maxPages: 2 }), { code: 'MAX_PAGES_EXCEEDED' });
  assert.equal(report.pageCount, 2);
  let calls = 0;
  await assert.rejects(fetchFullActivity(async () => { calls++; }, hash, {}, { maxDurationMs: 0 }), { code: 'RUN_BUDGET_EXCEEDED' });
  assert.equal(calls, 0);
});

test('invalid JSON retains HTTP/page metrics without accepting any products', async () => {
  const pages = [];
  await assert.rejects(readPage(async () => ({ text: 'not json', httpStatus: 200 }), hash, 0, 24, pages), { code: 'INVALID_JSON' });
  assert.equal(pages[0].httpStatus, 200);
  assert.equal(pages[0].validated, false);
  assert.equal(pages[0].failureCode, 'INVALID_JSON');
});

test('HTTP deadline exhaustion does not send another request', async () => {
  let calls = 0;
  const get = createClient([], { wait: noWait, fetchImpl: async () => { calls++; return response({}); } });
  await assert.rejects(get(defaultUrl, 'page', { deadlineAt: Date.now() - 1 }), { code: 'RUN_BUDGET_EXCEEDED' });
  assert.equal(calls, 0);
});

test('full product mapping retains actual price/discount/image and derives only verified safe Store routes', () => {
  const data = payload(0, 1);
  const product = validatePage(data, { deriveProductUrls: true }).products[0];
  assert.equal(product.url, 'https://store.playstation.com/zh-hant-tw/product/JP0000-PPSA00001_00-A0');
  assert.equal(product.urlSource, 'verified-product-route');
  assert.equal(product.imageUrl, 'https://image.api.playstation.com/0.jpg');
  assert.equal(product.price.discountText, '-30%');
  data.data.categoryGridRetrieve.products[0] = { id: '../unsafe', name: 'valid name' };
  const missing = validatePage(data, { deriveProductUrls: true }).products[0];
  assert.equal(missing.url, null); assert.equal(missing.price, null); assert.equal(missing.imageUrl, null);
});

test('invalid API offsets and sizes are rejected before constructing a request', () => {
  for (const [offset, size] of [[-1, 24], [0.5, 24], [0, 0], [0, 25], [0, '24']]) {
    assert.throws(() => apiUrl(hash, offset, size), { code: 'INVALID_PAGE_REQUEST' });
  }
});

const fixture = readFileSync(new URL('./fixtures/category-query.graphql', import.meta.url), 'utf8');
const script = parse(fixture).definitions.map(definition => JSON.stringify(fixture.slice(definition.loc.start, definition.loc.end))).join(';');
function mockFetch(total, failure) {
  return async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(Object.keys(options.headers).some(key => /cookie|authorization/i.test(key)), false);
    if (url === defaultUrl) return new Response('<script src="/_next/static/chunks/pages/_app-abcd.js"></script>', { headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/_app-abcd.js')) return new Response(script, { headers: { 'content-type': 'application/javascript' } });
    const { pageArgs } = variables(url);
    return failure?.(pageArgs) ?? response(payload(pageArgs.offset, total, pageArgs.size));
  };
}
async function outputDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ps-store-poc01-'));
  t.after(async () => {
    assert.equal(dirname(directory), tmpdir());
    assert.ok(basename(directory).startsWith('ps-store-poc01-'));
    await rm(directory, { recursive: true });
  });
  return pathToFileURL(directory + '/');
}
const readJson = async (output, filename) => JSON.parse(await readFile(new URL(filename, output), 'utf8'));

test('full offline execution writes only verified complete JSON with requested schema and leaves no temporary files', async t => {
  const output = await outputDirectory(t);
  const { report, exitCode } = await runDiagnostic({ args: ['--mode', 'full'], env: {}, output,
    clientOptions: { fetchImpl: mockFetch(49), wait: noWait } });
  const file = await readJson(output, 'sale-products.json');
  assert.equal(exitCode, 0);
  assert.equal(file.complete, true);
  assert.equal(file.schemaVersion, 1);
  assert.equal(file.saleId, saleId);
  assert.equal(file.locale, 'zh-hant-tw');
  assert.ok(Number.isFinite(Date.parse(file.fetchedAt)));
  assert.equal(file.totalCount, 49);
  assert.equal(file.products.length, 49);
  assert.equal(new Set(file.products.map(product => product.id)).size, 49);
  assert.equal(report.fullValidation, 'PASS');
  assert.equal(report.conclusion, 'INCONCLUSIVE');
  assert.equal(report.environment.githubHostedRunner, false);
  assert.deepEqual((await readdir(output)).sort(), ['POC_REPORT.md', 'fetch-report.json', 'sale-products.json']);
});

test('full failure removes stale successes and writes a separate partial artifact, never a complete product file', async t => {
  const output = await outputDirectory(t);
  for (const filename of ['sale-products.json', 'sale-products.json.tmp', 'first-page-products.json', 'partial-products.json']) {
    await writeFile(new URL(filename, output), '{"complete":true,"stale":true}');
  }
  const { report, exitCode } = await runDiagnostic({ args: ['--mode', 'full'], env: { PSN_TOKEN: 'private-cookie' }, output,
    clientOptions: { wait: noWait, fetchImpl: mockFetch(48, ({ offset }) => offset === 24 ? response('private-cookie', 403) : null) } });
  assert.equal(exitCode, 1);
  assert.equal(report.error.code, 'ACCESS_DENIED');
  assert.equal(report.complete, false);
  const partial = await readJson(output, 'partial-products.json');
  assert.equal(partial.complete, false); assert.equal(partial.scope, 'partial');
  assert.equal(partial.products.length, 24);
  assert.equal(report.requests.filter(request => request.offset === 24).length, 1);
  assert.deepEqual((await readdir(output)).sort(), ['POC_REPORT.md', 'fetch-report.json', 'partial-products.json']);
  for (const filename of await readdir(output)) assert.equal((await readFile(new URL(filename, output), 'utf8')).includes('private-cookie'), false);
});

test('persistent server errors stop after the retry cap and retain partial diagnostics', async t => {
  const output = await outputDirectory(t);
  const { report, exitCode } = await runDiagnostic({ args: ['--mode', 'full'], env: {}, output,
    clientOptions: { wait: noWait, fetchImpl: mockFetch(48, ({ offset }) => offset === 24 ? response('temporary', 503) : null) } });
  assert.equal(exitCode, 1); assert.equal(report.error.code, 'UPSTREAM_ERROR');
  assert.equal(report.retryCount, 2);
  assert.equal(report.requests.filter(request => request.offset === 24).length, 3);
  assert.equal((await readJson(output, 'partial-products.json')).complete, false);
  assert.equal((await readdir(output)).includes('sale-products.json'), false);
});

test('failed boundary revalidation cannot publish complete JSON even when all products were fetched', async t => {
  const output = await outputDirectory(t);
  let firstCalls = 0;
  const { report, exitCode } = await runDiagnostic({ args: ['--mode', 'full'], env: {}, output,
    clientOptions: { wait: noWait, fetchImpl: mockFetch(25, ({ offset }) => {
      if (offset === 0 && ++firstCalls % 2 === 0) return response(payload(0, 25, 24, 'CHANGED'));
      return null;
    }) } });
  assert.equal(exitCode, 1); assert.equal(report.error.code, 'BOUNDARY_CHANGED');
  assert.equal(report.sweeps.length, 2);
  const partial = await readJson(output, 'partial-products.json');
  assert.equal(partial.products.length, 25); assert.equal(partial.complete, false);
  assert.equal((await readdir(output)).includes('sale-products.json'), false);
});

test('environment and invalid-input paths are offline and clean stale complete artifacts', async t => {
  const output = await outputDirectory(t);
  const clientOptions = { fetchImpl: async () => { assert.fail('Must not access the network'); } };
  await writeFile(new URL('sale-products.json', output), '{"complete":true}');
  const invalid = await runDiagnostic({ args: ['--mode', 'full', '--sale-url', 'https://evil.test/'], env: {}, output, clientOptions });
  assert.equal(invalid.exitCode, 1); assert.equal(invalid.report.error.code, 'INVALID_SALE_URL');
  assert.equal(invalid.report.requests.length, 0);
  assert.equal((await readdir(output)).includes('sale-products.json'), false);
  const environment = await runDiagnostic({ args: ['--mode', 'environment'], env: {}, output, clientOptions });
  assert.equal(environment.exitCode, 0); assert.equal(environment.report.environmentCheck, 'PASS');
  assert.equal(environment.report.requests.length, 0);
});

test('first-page mode remains diagnostic-only after full-mode support', async t => {
  const output = await outputDirectory(t);
  const result = await runDiagnostic({ args: ['--mode', 'first-page'], env: {}, output,
    clientOptions: { fetchImpl: mockFetch(49), wait: noWait } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.fullValidation, 'NOT_RUN');
  const first = await readJson(output, 'first-page-products.json');
  assert.equal(first.complete, false); assert.equal(first.products.length, 24);
  assert.equal((await readdir(output)).includes('sale-products.json'), false);
});
