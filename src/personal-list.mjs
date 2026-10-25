import { validateKey } from './poc04/personal-data.mjs';
import { catalogForDisplay } from './catalog.mjs';

const processed = mark => ['tracked', 'ignored'].includes(mark?.status);
function imageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['image.api.playstation.com', 'gmedia.playstation.com'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}
export function productInfo(product) {
  validateKey(product?.key);
  const [locale, id] = product.key.split(':');
  if (product.id !== id || typeof product.name !== 'string' || !product.name.trim()) throw Error('INVALID_PRODUCT_INFO');
  // Only basic public metadata. Prices and campaign membership are never cached.
  return { key: product.key, id, name: product.name.trim().slice(0, 1000),
    url: `https://store.playstation.com/${locale}/product/${id}`,
    imageUrl: imageUrl(product.imageUrl),
    platforms: [...new Set((Array.isArray(product.platforms) ? product.platforms : [])
      .filter(value => typeof value === 'string' && value.length > 0 && value.length <= 40))].slice(0, 20) };
}
function cachedInfo(cache, key) {
  try { return cache?.[key]?.key === key ? productInfo(cache[key]) : null; }
  catch { return null; }
}
export function rememberProductInfo(cache, products, marks) {
  const known = new Map(products.map(product => [product.key, product])), result = {};
  for (const [key, mark] of Object.entries(marks)) {
    if (!processed(mark)) continue;
    let info = cachedInfo(cache, key);
    if (known.has(key)) {
      try {
        const incoming = productInfo(known.get(key));
        if (!info || incoming.name !== incoming.id || info.name === info.id) info = incoming;
      } catch { /* retain valid prior metadata */ }
    }
    if (info) result[key] = info;
  }
  return result;
}
export function personalProducts(catalog, marks, cache = {}, now = Date.now()) {
  const active = new Map(catalogForDisplay(catalog, { now }).products.map(product => [product.key, product]));
  const known = new Map(catalog.products.map(product => [product.key, product]));
  return Object.entries(marks).filter(([, mark]) => processed(mark)).map(([key]) => {
    validateKey(key);
    const current = active.get(key), source = current ?? known.get(key);
    const id = key.split(':')[1];
    const info = source ? productInfo(source) : cachedInfo(cache, key) ?? productInfo({ key, id, name: id });
    return { ...info, campaignIds: current?.campaignIds ?? [], offers: current?.offers ?? [], price: current?.price ?? null };
  });
}
