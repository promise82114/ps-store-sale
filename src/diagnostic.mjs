import { DiagnosticError, responseProblem } from './http.mjs';
import { buildQuery, publicDefinitions } from './query.mjs';
import { campaignById, campaignByUrl } from './campaigns.mjs';

export const saleId = '10f8c20b-f1b4-4814-ad6a-acb122e4ab04';
export const locale = 'zh-hant-tw';
export const defaultUrl = `https://store.playstation.com/${locale}/category/${saleId}/1`;
export const endpoint = 'https://web.np.playstation.com/api/graphql/v1/op';
export const pageSize = 24;

export function validateSaleUrl(value, approvedId = saleId) {
  // Exact approved campaigns, locale and first page; no URL normalization.
  if (!campaignByUrl(value) || campaignByUrl(value).id !== approvedId) throw new DiagnosticError('INVALID_SALE_URL', 'input');
  return value;
}

export function scriptUrls(html) {
  const paths = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map(match => match[1]);
  const app = paths.filter(path => /^\/_next\/static\/chunks\/pages\/_app-[a-z0-9]+\.js$/.test(path));
  const chunks = paths.filter(path => /^\/_next\/static\/chunks\/(?:\d+|[a-f0-9]{8})-[a-z0-9]+\.js$/.test(path)).reverse();
  // Skip framework, telemetry, consent and anti-bot scripts entirely.
  return [...new Set([...app, ...chunks])].slice(0, 12).map(path => 'https://store.playstation.com' + path);
}

export async function discoverQuery(get, sourceUrl, report) {
  const page = await get(sourceUrl, 'store-page');
  const urls = scriptUrls(page.text);
  if (!urls.length) throw new DiagnosticError('QUERY_UNAVAILABLE', 'query-discovery');
  const definitions = [];
  report.querySources = [];
  for (const url of urls) {
    const asset = await get(url, 'public-script');
    const found = publicDefinitions(asset.text);
    if (found.length) report.querySources.push(url);
    definitions.push(...found);
    const names = new Set(definitions.map(item => item.name?.value));
    if (['categoryGridRetrieve', 'priceFragment', 'personalizedMetaFragment'].every(value => names.has(value))) {
      try { return buildQuery(definitions); }
      catch { throw new DiagnosticError('QUERY_UNAVAILABLE', 'query-discovery'); }
    }
  }
  throw new DiagnosticError('QUERY_UNAVAILABLE', 'query-discovery');
}

export function apiUrl(sha256Hash, offset = 0, size = pageSize, targetSaleId = saleId) {
  if (!campaignById(targetSaleId)) throw new DiagnosticError('INVALID_SALE_URL', 'input');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 1 || size > pageSize) {
    throw new DiagnosticError('INVALID_PAGE_REQUEST', 'input');
  }
  const variables = { id: targetSaleId, pageArgs: { size, offset },
    sortBy: null, filterBy: [], facetOptions: [], maxResults: null };
  const query = new URLSearchParams({ operationName: 'categoryGridRetrieve',
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash } }) });
  return `${endpoint}?${query}`;
}

export function validatePage(payload, { offset = 0, requestedSize = pageSize, firstPageOnly = false,
  deriveProductUrls = false, expectedTotalCount = null, expectedSaleId = saleId } = {}) {
  const fail = code => { throw new DiagnosticError(code, firstPageOnly ? 'first-page-validation' : 'page-validation'); };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('SCHEMA_MISMATCH');
  if (payload.errors !== undefined) {
    if (!Array.isArray(payload.errors)) fail('SCHEMA_MISMATCH');
    if (payload.errors.length) fail(responseProblem(200, JSON.stringify(payload.errors)) ?? 'GRAPHQL_ERROR');
  }
  const grid = payload.data?.categoryGridRetrieve;
  if (!campaignById(expectedSaleId) || !grid || grid.id !== expectedSaleId || !Array.isArray(grid.products)) fail('SCHEMA_MISMATCH');
  const info = grid.pageInfo;
  if (!info || !['totalCount', 'size', 'offset'].every(key => Number.isSafeInteger(info[key]) && info[key] >= 0) ||
      info.offset !== offset || info.size < 1 || info.size > requestedSize ||
      (firstPageOnly && info.size !== requestedSize) ||
      (info.isLast !== undefined && typeof info.isLast !== 'boolean')) fail('INVALID_PAGE_INFO');
  if (expectedTotalCount !== null && info.totalCount !== expectedTotalCount) fail('TOTAL_COUNT_CHANGED');
  if (info.totalCount === 0 && grid.products.length === 0) fail('EMPTY_CATEGORY');
  if (offset >= info.totalCount || grid.products.length !== Math.min(info.totalCount - offset, info.size)) {
    fail(firstPageOnly ? 'INCONSISTENT_FIRST_PAGE' : 'INCONSISTENT_PAGE');
  }
  if (info.isLast !== undefined && info.isLast !== (offset + grid.products.length === info.totalCount)) {
    fail(firstPageOnly ? 'INCONSISTENT_FIRST_PAGE' : 'INCONSISTENT_PAGE');
  }
  const products = grid.products.map(product => {
    if (!product || typeof product.id !== 'string' || !product.id.trim() ||
        typeof product.name !== 'string' || !product.name.trim()) fail('INVALID_PRODUCT');
    const media = Array.isArray(product.media) ? product.media.map(item => ({
      type: item?.type ?? null, role: item?.role ?? null, url: item?.url ?? null,
    })) : null;
    const apiProductUrl = typeof product.url === 'string' && /^https:\/\//.test(product.url) ? product.url : null;
    // Official /[locale]/product/[productId] route verified on 2026-10-20:
    // HTTP 200 and matching Next.js productId/statusCode (docs/POC_REPORT.md).
    const derivedUrl = deriveProductUrls && /^[A-Z0-9]+-[A-Z0-9_-]+$/.test(product.id) ?
      `https://store.playstation.com/${locale}/product/${product.id}` : null;
    const image = media?.find(item => item.type === 'IMAGE' && item.role === 'MASTER' && /^https:\/\//.test(item.url)) ??
      media?.find(item => item.type === 'IMAGE' && /^https:\/\//.test(item.url));
    return {
      key: `${locale}:${product.id}`, id: product.id, name: product.name,
      url: apiProductUrl ?? derivedUrl,
      urlSource: apiProductUrl ? 'api' : derivedUrl ? 'verified-product-route' : null,
      imageUrl: image?.url ?? null,
      platforms: Array.isArray(product.platforms) ? product.platforms : null,
      price: product.price && typeof product.price === 'object' ? {
        basePrice: product.price.basePrice ?? null,
        discountedPrice: product.price.discountedPrice ?? null,
        discountText: product.price.discountText ?? null,
      } : null,
      media,
    };
  });
  const uniqueProductCount = new Set(products.map(product => product.key)).size;
  return { pageInfo: info, rawProductCount: products.length, uniqueProductCount,
    duplicateProductCount: products.length - uniqueProductCount, products };
}

export function validateFirstPage(payload, expectedSaleId = saleId) {
  return validatePage(payload, { firstPageOnly: true, expectedSaleId });
}
