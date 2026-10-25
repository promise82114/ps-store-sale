import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'graphql';
import { apiUrl, defaultUrl, discoverQuery, saleId, scriptUrls, validateFirstPage, validateSaleUrl } from '../src/diagnostic.mjs';
import { createClient, DiagnosticError, responseProblem, retryDelay } from '../src/http.mjs';
import { buildQuery, publicDefinitions } from '../src/query.mjs';
import { currentCampaigns } from './fixtures/campaigns.mjs';

const fixture = readFileSync(new URL('./fixtures/category-query.graphql', import.meta.url), 'utf8');
const expectedHash = '88c0b9a1273c6d320c51cd73e390924e21ae28bf09f01cde8b84b1034b16cd03';
const payload = (count = 24, totalCount = 2304) => ({ data: { categoryGridRetrieve: {
  id: saleId,
  pageInfo: { size: 24, offset: 0, totalCount, isLast: count === totalCount },
  products: Array.from({ length: count }, (_, i) => ({ id: `product-${i}`, name: 'Same name', npTitleId: 'SAME_TITLE' })),
} } });
const fails = (fn, code) => assert.throws(fn, error => error instanceof DiagnosticError && error.code === code);
const noWait = async () => {};
const response = (text = '{}', status = 200, headers = {}) => new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });

test('current campaign URL allowlist is exact and cannot expand host, locale or query scope', () => {
  for (const campaign of currentCampaigns) {
    assert.equal(validateSaleUrl(campaign.sourceUrl, campaign.id), campaign.sourceUrl);
    assert.equal(JSON.parse(new URL(apiUrl('a'.repeat(64), 0, 24, campaign.id)).searchParams.get('variables')).id, campaign.id);
    for (const url of [campaign.sourceUrl + '?page=2', campaign.sourceUrl + '/',
      campaign.sourceUrl.replace('/1', '/2'), campaign.sourceUrl.replace('https:', 'http:'),
      campaign.sourceUrl.replace('zh-hant-tw', 'en-us'), campaign.sourceUrl.replace('.com/', '.com:443/')])
      fails(() => validateSaleUrl(url), 'INVALID_SALE_URL');
  }
});

test('sale URL allowlist rejects alternative hosts, credentials and normalized paths', () => {
  assert.equal(validateSaleUrl(defaultUrl), defaultUrl);
  for (const url of [defaultUrl.replace('https:', 'http:'), defaultUrl + '?a=1', defaultUrl + '#fragment',
    defaultUrl.replace('store.playstation.com', 'store.playstation.com.evil.test'),
    defaultUrl.replace('store.playstation.com', 'user:private@store.playstation.com'),
    defaultUrl.replace('.com/', '.com:443/'), defaultUrl.replace('/1', '/2'),
    defaultUrl.replace('/zh-hant-tw/', '/en-us/'), defaultUrl.replace('/category/', '/x/../category/'),
    defaultUrl.replace('/category/', '/%63ategory/'), defaultUrl.replace(saleId, '00000000-0000-0000-0000-000000000000')]) {
    fails(() => validateSaleUrl(url), 'INVALID_SALE_URL');
  }
});

test('script discovery permits only bounded same-origin application chunks', () => {
  const html = ['/_next/static/chunks/pages/_app-abc123.js', '/_next/static/chunks/890-abc123.js',
    '/_next/static/chunks/framework-abc123.js', 'https://evil.test/_next/static/chunks/890-abcd.js',
    '//evil.test/890-abcd.js', '/captcha/script.js', '/_next/static/chunks/../890-abcd.js']
    .map(src => `<script src="${src}"></script>`).join('');
  assert.deepEqual(scriptUrls(html), [
    'https://store.playstation.com/_next/static/chunks/pages/_app-abc123.js',
    'https://store.playstation.com/_next/static/chunks/890-abc123.js',
  ]);
  assert.equal(scriptUrls(Array.from({ length: 40 }, (_, i) => `<script src="/_next/static/chunks/${i}-abcdef.js"></script>`).join('')).length, 12);
});

test('query hash reproduces the currently API-verified official query, including legacy formatting', () => {
  const result = buildQuery(parse(fixture).definitions);
  assert.equal(result.sha256Hash, expectedHash);
  assert.ok(result.document.endsWith('\n'));
  assert.match(result.document, /categoryGridRetrieve\(facetOptions: \$facetOptions, filterBy:/);
  assert.match(result.document, /\n  __typename\n/);
  assert.equal(buildQuery(parse(result.document).definitions).sha256Hash, expectedHash);
});

test('public query extraction parses literals without executing downloaded JavaScript', () => {
  const definitions = parse(fixture).definitions;
  const source = 'throw new Error("never run");' + definitions.map(definition => {
    const text = fixture.slice(definition.loc.start, definition.loc.end);
    return `const template=${JSON.stringify(text)};`;
  }).join('');
  assert.equal(buildQuery(publicDefinitions(source)).sha256Hash, expectedHash);
  assert.deepEqual(publicDefinitions('const s="not a query"'), []);
});

test('missing or conflicting current definitions stop instead of using a fixture/hash fallback', () => {
  assert.throws(() => buildQuery([]), /QUERY_UNAVAILABLE/);
  const defs = parse(fixture).definitions;
  assert.throws(() => buildQuery([...defs, ...parse('fragment priceFragment on SkuPrice { changed }').definitions]), /QUERY_UNAVAILABLE/);
});

test('discovery reads current page and scripts once and never fetches products itself', async () => {
  const requested = [];
  const report = {};
  const query = await discoverQuery(async (url, stage) => {
    requested.push({ url, stage });
    return { text: stage === 'store-page' ? '<script src="/_next/static/chunks/pages/_app-abcd.js"></script>' :
      parse(fixture).definitions.map(definition => JSON.stringify(fixture.slice(definition.loc.start, definition.loc.end))).join(';') };
  }, defaultUrl, report);
  assert.equal(query.sha256Hash, expectedHash);
  assert.equal(requested.length, 2);
  assert.equal(report.querySources.length, 1);
});

test('unavailable discovery stops with a classified error', async () => {
  await assert.rejects(discoverQuery(async () => ({ text: '<html>no query</html>' }), defaultUrl, {}), { code: 'QUERY_UNAVAILABLE' });
});

test('API request has fixed endpoint, first-page variables and current hash only', () => {
  const url = new URL(apiUrl(expectedHash));
  assert.equal(url.origin + url.pathname, 'https://web.np.playstation.com/api/graphql/v1/op');
  const variables = JSON.parse(url.searchParams.get('variables'));
  assert.equal(variables.id, saleId);
  assert.deepEqual(variables.pageArgs, { size: 24, offset: 0 });
  assert.equal(JSON.parse(url.searchParams.get('extensions')).persistedQuery.sha256Hash, expectedHash);
  assert.equal(url.searchParams.has('query'), false);
});

test('first page preserves different product IDs even with identical names and npTitleId', () => {
  const result = validateFirstPage(payload());
  assert.equal(result.products.length, 24);
  assert.equal(result.uniqueProductCount, 24);
  assert.equal(result.duplicateProductCount, 0);
  assert.equal(result.products[0].key, 'zh-hant-tw:product-0');
  assert.equal(result.products[0].price, null);
  assert.equal(result.products[0].url, null);
});

test('reported totals are dynamic and a short first/last page can be valid', () => {
  const data = payload(3, 3);
  assert.equal(validateFirstPage(data).rawProductCount, 3);
  delete data.data.categoryGridRetrieve.pageInfo.isLast;
  assert.equal(validateFirstPage(data).rawProductCount, 3);
});

test('duplicate IDs are counted without falsely merging versions or claiming completeness', () => {
  const data = payload();
  data.data.categoryGridRetrieve.products[1].id = 'product-0';
  const result = validateFirstPage(data);
  assert.equal(result.rawProductCount, 24);
  assert.equal(result.uniqueProductCount, 23);
  assert.equal(result.duplicateProductCount, 1);
});

test('empty/ended categories remain inconclusive rather than demonstrating successful API products', () => {
  fails(() => validateFirstPage(payload(0, 0)), 'EMPTY_CATEGORY');
});

test('malformed root, wrong campaign, missing required product fields fail', () => {
  for (const data of [null, [], {}, { data: { categoryGridRetrieve: { id: 'wrong' } } }]) {
    fails(() => validateFirstPage(data), 'SCHEMA_MISMATCH');
  }
  for (const product of [{ name: 'name' }, { id: ' ', name: 'name' }, { id: 'id' }, { id: 1, name: 'name' }, null]) {
    const data = payload(); data.data.categoryGridRetrieve.products[0] = product;
    fails(() => validateFirstPage(data), 'INVALID_PRODUCT');
  }
});

test('invalid pagination and non-integer counters fail', () => {
  for (const info of [{ offset: 24 }, { size: 12 }, { totalCount: '2304' }, { totalCount: -1 },
    { totalCount: 3.5 }, { isLast: 'false' }, { offset: true }]) {
    const data = payload(); Object.assign(data.data.categoryGridRetrieve.pageInfo, info);
    fails(() => validateFirstPage(data), 'INVALID_PAGE_INFO');
  }
});

test('short/empty nonfinal pages and contradictory end markers fail', () => {
  fails(() => validateFirstPage(payload(0, 2304)), 'INCONSISTENT_FIRST_PAGE');
  fails(() => validateFirstPage(payload(23, 2304)), 'INCONSISTENT_FIRST_PAGE');
  const data = payload(); data.data.categoryGridRetrieve.pageInfo.isLast = true;
  fails(() => validateFirstPage(data), 'INCONSISTENT_FIRST_PAGE');
});

test('GraphQL errors fail even when a partial data object is present', () => {
  const data = payload(); data.errors = [{ message: 'PersistedQueryNotFound' }];
  fails(() => validateFirstPage(data), 'QUERY_UNAVAILABLE');
  data.errors = [{ message: 'other failure' }];
  fails(() => validateFirstPage(data), 'GRAPHQL_ERROR');
});

test('HTTP/API failure reasons distinguish access, authentication, query and schema boundaries', () => {
  for (const [status, text, contentType, expected] of [
    [403, 'forbidden', '', 'ACCESS_DENIED'], [401, '', '', 'AUTH_REQUIRED'],
    [200, 'UNAUTHENTICATED', '', 'AUTH_REQUIRED'], [200, 'captcha', '', 'ACCESS_CHALLENGE'],
    [400, 'Query abc not whitelisted', '', 'QUERY_UNAVAILABLE'],
    [400, 'Cross-Site Request Forgery (CSRF)', '', 'CSRF_HEADER_REQUIRED'],
    [429, '', '', 'RATE_LIMITED'], [502, '', '', 'UPSTREAM_ERROR'],
    [302, '', '', 'REDIRECT_REJECTED'], [400, 'unknown', '', 'HTTP_ERROR'],
    [200, '<html>login</html>', 'text/html', 'NON_JSON_RESPONSE'],
  ]) assert.equal(responseProblem(status, text, contentType), expected);
});

test('HTTP client sends no credentials, rejects redirects, and retains only safe request metrics', async () => {
  const events = [];
  const get = createClient(events, { wait: noWait, fetchImpl: async (url, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-PSN-Store-Locale-Override'], 'zh-hant-tw');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(Object.keys(options.headers).some(key => /cookie|authorization/i.test(key)), false);
    return response('{}', 302, { location: 'https://evil.test/?token=private' });
  } });
  await assert.rejects(get(apiUrl(expectedHash), 'api', { json: true }), { code: 'REDIRECT_REJECTED' });
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes('private'), false);
});

test('HTTP 403, challenges and invalid persisted queries are never retried', async () => {
  for (const [body, status, code] of [['denied', 403, 'ACCESS_DENIED'],
    ['{"message":"Query abc not whitelisted"}', 400, 'QUERY_UNAVAILABLE'],
    ['{"errors":[{"message":"PersistedQueryNotFound"}]}', 200, 'QUERY_UNAVAILABLE'],
    ['{"errors":[{"message":"authentication required"}]}', 200, 'AUTH_REQUIRED']]) {
    const events = [];
    const get = createClient(events, { wait: noWait, fetchImpl: async () => response(body, status) });
    await assert.rejects(get('https://web.np.playstation.com/', 'api', { json: true }), { code });
    assert.equal(events.length, 1);
  }
});

test('public JavaScript error-handler strings are not mistaken for API errors', async () => {
  const get = createClient([], { wait: noWait, fetchImpl: async () => response('const s="PersistedQueryNotFound";', 200, { 'content-type': 'application/javascript' }) });
  assert.match((await get('https://store.playstation.com/script.js', 'public-script')).text, /PersistedQuery/);
});

test('temporary network and 5xx failures have a maximum of three attempts', async () => {
  for (const failure of [async () => { throw new TypeError('private network detail'); }, async () => response('temporary', 503)]) {
    const events = [], waits = [];
    const get = createClient(events, { wait: async ms => { waits.push(ms); }, fetchImpl: failure });
    await assert.rejects(get('https://store.playstation.com/', 'page'));
    assert.equal(events.length, 3);
    assert.ok(waits.includes(1000)); assert.ok(waits.includes(2000));
    assert.equal(JSON.stringify(events).includes('private'), false);
  }
});

test('a temporary failure can recover without multiplying successful requests', async () => {
  let calls = 0;
  const events = [];
  const get = createClient(events, { wait: noWait, fetchImpl: async () => ++calls === 1 ? response('', 502) : response('{"ok":true}') });
  assert.equal((await get('https://store.playstation.com/', 'page')).httpStatus, 200);
  assert.equal(events.length, 2);
});

test('Retry-After supports seconds and HTTP dates, and refuses excessive waits', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  assert.equal(retryDelay('3', now), 3000);
  assert.equal(retryDelay('Tue, 20 Oct 2026 00:00:05 GMT', now), 5000);
  assert.equal(retryDelay(null, now), 1000);
  for (const value of ['31', '-1', 'invalid']) assert.equal(retryDelay(value, now), null);
});

test('rate limit waits are respected and capped; long server limits stop immediately', async () => {
  for (const [retryAfter, expectedAttempts] of [['2', 3], ['31', 1]]) {
    const events = [], waits = [];
    const get = createClient(events, { wait: async ms => { waits.push(ms); }, fetchImpl: async () => response('', 429, { 'retry-after': retryAfter }) });
    await assert.rejects(get('https://store.playstation.com/', 'page'), { code: 'RATE_LIMITED' });
    assert.equal(events.length, expectedAttempts);
    if (expectedAttempts > 1) assert.ok(waits.includes(2000));
  }
});

test('oversized bodies stop once and are never retained as diagnostics', async () => {
  const events = [];
  const get = createClient(events, { wait: noWait, fetchImpl: async () => response('x'.repeat(8 * 1024 * 1024 + 1)) });
  await assert.rejects(get('https://store.playstation.com/', 'page'), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(events.length, 1);
});
