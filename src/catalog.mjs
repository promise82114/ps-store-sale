import { campaignById, campaignState, locale, validateRegistry } from './campaigns.mjs';

function requireCatalog(condition, code) {
  if (!condition) { const error = new Error(code); error.code = code; throw error; }
}
export function validateCatalog(catalog) {
  requireCatalog(catalog?.schemaVersion === 1 && catalog.scope === 'multi-activity' && catalog.complete === true
    && catalog.locale === locale && (catalog.fetchedAt === null || Number.isFinite(Date.parse(catalog.fetchedAt)))
    && Array.isArray(catalog.campaigns)
    && Array.isArray(catalog.products) && catalog.products.length <= 100_000
    && catalog.uniqueProductCount === catalog.products.length, 'INVALID_CATALOG');
  const campaigns = new Map(), counts = new Map(), keys = new Set();
  for (const expected of validateRegistry({ schemaVersion: 1, campaigns: catalog.campaigns }).campaigns) {
    const matched = catalog.campaigns.filter(item => item?.id === expected.id);
    requireCatalog(matched.length === 1 && matched[0].sourceUrl === expected.sourceUrl
      && typeof matched[0].label === 'string' && Number.isSafeInteger(matched[0].totalCount)
      && matched[0].totalCount > 0 && Number.isFinite(Date.parse(matched[0].fetchedAt)), 'INVALID_CATALOG_CAMPAIGN');
    campaigns.set(expected.id, matched[0]); counts.set(expected.id, 0);
  }
  for (const product of catalog.products) {
    requireCatalog(typeof product?.id === 'string' && /^[A-Z0-9][A-Z0-9_-]{0,127}$/.test(product.id)
      && product.key === `${locale}:${product.id}` && !keys.has(product.key)
      && typeof product.name === 'string' && product.name.trim()
      && Array.isArray(product.campaignIds) && product.campaignIds.length > 0
      && new Set(product.campaignIds).size === product.campaignIds.length
      && Array.isArray(product.offers) && product.offers.length === product.campaignIds.length, 'INVALID_CATALOG_PRODUCT');
    keys.add(product.key);
    for (const id of product.campaignIds) {
      const matches = product.offers.filter(offer => offer?.campaignId === id);
      requireCatalog(campaigns.has(id) && matches.length === 1
        && matches[0].fetchedAt === campaigns.get(id).fetchedAt, 'INVALID_CATALOG_OFFER');
      counts.set(id, counts.get(id) + 1);
    }
  }
  requireCatalog([...counts].every(([id, count]) => count === campaigns.get(id).totalCount), 'CATALOG_COUNT_MISMATCH');
  const memberships = [...counts.values()].reduce((sum, count) => sum + count, 0);
  requireCatalog(catalog.membershipCount === memberships
    && catalog.overlappingMembershipCount === memberships - catalog.products.length
    && (catalog.campaigns.length === 0 ? catalog.fetchedAt === null
      : Date.parse(catalog.fetchedAt) === Math.max(...catalog.campaigns.map(item => Date.parse(item.fetchedAt)))), 'CATALOG_COUNT_MISMATCH');
  return catalog;
}
export function buildCatalog(sources, definitions) {
  requireCatalog(Array.isArray(sources), 'INCOMPLETE_CAMPAIGNS');
  if (definitions === undefined) definitions = sources.map(source => ({ ...campaignById(source?.saleId), label: source?.saleId }));
  const registered = validateRegistry({ schemaVersion: 1, campaigns: definitions }).campaigns;
  requireCatalog(Array.isArray(sources) && sources.length === registered.length, 'INCOMPLETE_CAMPAIGNS');
  const products = new Map(), campaigns = [];
  let membershipCount = 0;
  for (const campaign of registered) {
    const matches = sources.filter(source => source?.saleId === campaign.id);
    requireCatalog(matches.length === 1, 'CAMPAIGN_MISMATCH');
    const source = matches[0];
    requireCatalog(source.schemaVersion === 1 && source.scope === 'full-activity' && source.complete === true
      && source.locale === locale && source.sourceUrl === campaign.sourceUrl
      && Number.isFinite(Date.parse(source.fetchedAt)) && Array.isArray(source.products)
      && source.products.length > 0 && source.products.length === source.totalCount
      && source.totalCount === source.reportedTotalCount && source.totalCount === source.rawProductCount
      && source.totalCount === source.uniqueProductCount && source.duplicateProductCount === 0, 'INCOMPLETE_SOURCE');
    const seen = new Set();
    for (const product of source.products) {
      requireCatalog(product && typeof product.id === 'string' && /^[A-Z0-9][A-Z0-9_-]{0,127}$/.test(product.id)
        && product.key === `${locale}:${product.id}` && typeof product.name === 'string' && product.name.trim()
        && !seen.has(product.key), 'INVALID_CATALOG_PRODUCT');
      seen.add(product.key);
      if (!products.has(product.key)) {
        // Full media stays in each verified source artifact; the UI needs one image.
        const { media, ...summary } = structuredClone(product);
        products.set(product.key, { ...summary, campaignIds: [], offers: [] });
      }
      const entry = products.get(product.key);
      entry.campaignIds.push(campaign.id);
      entry.offers.push({ campaignId: campaign.id, price: structuredClone(product.price), fetchedAt: source.fetchedAt });
    }
    campaigns.push({ ...campaign, fetchedAt: source.fetchedAt, totalCount: source.totalCount });
    membershipCount += source.totalCount;
  }
  return { schemaVersion: 1, scope: 'multi-activity', complete: true, locale,
    fetchedAt: sources.length ? new Date(Math.max(...sources.map(source => Date.parse(source.fetchedAt)))).toISOString() : null,
    campaigns, membershipCount, uniqueProductCount: products.size,
    overlappingMembershipCount: membershipCount - products.size, products: [...products.values()] };
}

export function catalogForDisplay(catalog, { includeHistory = false, now = Date.now() } = {}) {
  const campaigns = catalog.campaigns.filter(campaign => includeHistory || campaignState(campaign, now) === 'active');
  const ids = new Set(campaigns.map(campaign => campaign.id));
  const products = catalog.products.filter(product => product.campaignIds.some(id => ids.has(id))).map(product => {
    const offers = product.offers.filter(offer => ids.has(offer.campaignId));
    return { ...product, campaignIds: product.campaignIds.filter(id => ids.has(id)), offers, price: offers[0].price };
  });
  const membershipCount = products.reduce((total, product) => total + product.campaignIds.length, 0);
  return { ...catalog, campaigns, products, membershipCount, uniqueProductCount: products.length,
    overlappingMembershipCount: membershipCount - products.length };
}

export function priceNumber(price) {
  const value = price?.discountedPrice ?? price?.basePrice;
  if (typeof value !== 'string') return null;
  if (/^(?:免費|Free)$/i.test(value.trim())) return 0;
  if (!/^(?:NT\$|NTD|TWD)\s*[\d,]+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const number = Number(value.trim().replace(/^(?:NT\$|NTD|TWD)\s*/, '').replaceAll(',', ''));
  return Number.isFinite(number) ? number : null;
}
export function discountNumber(price) {
  const match = typeof price?.discountText === 'string' && price.discountText.match(/^-(\d{1,3})%$/);
  return match && Number(match[1]) <= 100 ? Number(match[1]) : null;
}
// A view only: personal marks remain independent of whichever campaigns are loaded.
export function classificationCounts(products, marks) {
  const counts = { total: products.length, unclassified: 0, tracked: 0, ignored: 0 };
  for (const product of products) {
    const status = marks[product.key]?.status;
    counts[status === 'tracked' || status === 'ignored' ? status : 'unclassified']++;
  }
  return counts;
}
export function selectProducts(catalog, marks, { search = '', campaign = '', platform = '', status = '', statuses = [], sort = 'name', hideIgnored = false } = {}) {
  const needle = search.trim().toLocaleLowerCase();
  const selectedStatuses = new Set([...(Array.isArray(statuses) ? statuses : []), ...(status ? [status] : [])]);
  const selected = catalog.products.filter(product => (!needle || `${product.name} ${product.id}`.toLocaleLowerCase().includes(needle))
    && (!campaign || product.campaignIds.includes(campaign))
    && (!platform || product.platforms?.includes(platform))
    && (!hideIgnored || selectedStatuses.has('ignored') || marks[product.key]?.status !== 'ignored')
    && (!selectedStatuses.size || selectedStatuses.has(marks[product.key]?.status ?? 'unclassified')))
    .map(product => campaign ? { ...product, price: product.offers.find(offer => offer.campaignId === campaign)?.price ?? product.price } : product);
  const collator = new Intl.Collator('zh-Hant', { numeric: true });
  const score = product => sort === 'discount' ? discountNumber(product.price) : priceNumber(product.price);
  return selected.sort((a, b) => {
    if (sort !== 'name') {
      const left = score(a), right = score(b);
      if (left === null || right === null) { if (left !== right) return left === null ? 1 : -1; }
      else if (left !== right) return sort === 'price' ? left - right : right - left;
    }
    return collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });
}
