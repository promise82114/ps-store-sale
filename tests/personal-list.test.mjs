import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalog, selectProducts } from '../src/catalog.mjs';
import { campaignById } from '../src/campaigns.mjs';
import { productInfo, rememberProductInfo, personalProducts } from '../src/personal-list.mjs';
import { a, b, mark } from './fixtures/poc04.mjs';

const product = (key = a, name = 'Saved game') => ({ key, id: key.split(':')[1], name,
  url: 'https://evil.invalid/', imageUrl: 'https://image.api.playstation.com/synthetic.png', platforms: ['PS5'],
  price: { basePrice: 'NT$100', discountedPrice: 'NT$50', discountText: '-50%' }, offers: ['must not be cached'] });
const campaign = () => ({ ...campaignById('11111111-2222-4333-8444-555555555555'), label: '活動',
  startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z' });
function catalog(definition = campaign()) {
  return buildCatalog([{ schemaVersion: 1, scope: 'full-activity', complete: true, saleId: definition.id,
    locale: 'zh-hant-tw', sourceUrl: definition.sourceUrl, fetchedAt: '2026-10-25T00:00:00.000Z',
    totalCount: 1, reportedTotalCount: 1, rawProductCount: 1, uniqueProductCount: 1, duplicateProductCount: 0,
    products: [product()] }], [definition]);
}
const now = Date.parse('2026-10-25T00:00:00.000Z');
test('basic metadata retains identity and safe links but never price or campaign history', () => {
  const info = productInfo(product());
  assert.deepEqual(Object.keys(info).sort(), ['key', 'id', 'name', 'url', 'imageUrl', 'platforms'].sort());
  assert.equal(info.url, 'https://store.playstation.com/zh-hant-tw/product/'+product().id);
  assert.equal(info.name, 'Saved game'); assert.equal(info.price, undefined);
});
test('unsafe images and invalid identity cannot enter the local metadata cache', () => {
  assert.equal(productInfo({ ...product(), imageUrl: 'https://evil.invalid/image.png' }).imageUrl, null);
  assert.equal(productInfo({ ...product(), imageUrl: 'https://user:secret@image.api.playstation.com/a' }).imageUrl, null);
  assert.throws(() => productInfo({ ...product(), id: 'DIFFERENT' }));
});
test('remembering metadata preserves absent marked products and prunes cleared entries', () => {
  const saved = { [a]: productInfo(product()), [b]: productInfo(product(b, 'Ignored')) };
  const before = structuredClone(saved), marks = { [a]: mark('tracked', 1) };
  const updated = rememberProductInfo(saved, [], marks);
  assert.equal(updated[a].name, 'Saved game'); assert.equal(updated[b], undefined);
  assert.deepEqual(saved, before);
});
test('current metadata replaces old titles while an ID-only fallback cannot erase a known title', () => {
  const saved = { [a]: productInfo(product()) }, marks = { [a]: mark('tracked', 1) };
  assert.equal(rememberProductInfo(saved, [product(a, 'New title')], marks)[a].name, 'New title');
  assert.equal(rememberProductInfo(saved, [product(a, product().id)], marks)[a].name, 'Saved game');
});
test('my list includes only processed products and can filter tracked and ignored independently of active offers', () => {
  const marks = { [a]: mark('tracked', 1), [b]: mark('ignored', 2) };
  const products = personalProducts(buildCatalog([]), marks, { [a]: productInfo(product()), [b]: productInfo(product(b, 'Other')) }, now);
  assert.equal(products.length, 2);
  assert.deepEqual(selectProducts({ products }, marks, { status: 'tracked' }).map(p => p.key), [a]);
  assert.deepEqual(selectProducts({ products }, marks, { status: 'ignored' }).map(p => p.key), [b]);
  assert.deepEqual(personalProducts(catalog(), {}, {}, now), []);
});
test('active campaign membership supplies current prices without trusting cached prices', () => {
  const marks = { [a]: mark('tracked', 1) }, cache = { [a]: { ...productInfo(product()), price: { discountedPrice: 'NT$1' } } };
  const [entry] = personalProducts(catalog(), marks, cache, now);
  assert.equal(entry.price.discountedPrice, 'NT$50'); assert.equal(entry.offers.length, 1);
});
for (const state of ['ended', 'upcoming', 'archived']) test(`${state} activity cannot expose old prices or badges in my list`, () => {
  const definition = campaign();
  if (state === 'ended') definition.endsAt = '2026-10-20T00:00:00.000Z';
  if (state === 'upcoming') definition.startsAt = '2026-10-26T00:00:00.000Z';
  if (state === 'archived') definition.enabled = false;
  const [entry] = personalProducts(catalog(definition), { [a]: mark('tracked', 1) }, {}, now);
  assert.equal(entry.name, 'Saved game'); assert.equal(entry.price, null);
  assert.deepEqual(entry.offers, []); assert.deepEqual(entry.campaignIds, []);
});
test('removed product remains searchable using cached basic info with no sale text', () => {
  const marks = { [a]: mark('tracked', 1) }, cache = { [a]: productInfo(product()) };
  const products = personalProducts(buildCatalog([]), marks, cache, now);
  assert.equal(products[0].name, 'Saved game'); assert.equal(products[0].price, null);
  assert.equal(selectProducts({ products }, marks, { search: 'Saved' }).length, 1);
});
test('legacy or imported marks with no metadata remain editable via a product ID and official link', () => {
  const [entry] = personalProducts(buildCatalog([]), { [a]: mark('tracked', 1) }, {}, now);
  assert.equal(entry.name, product().id); assert.match(entry.url, /^https:\/\/store\.playstation\.com\/zh-hant-tw\/product\//);
  assert.equal(entry.imageUrl, null); assert.equal(entry.price, null);
});
test('returning product inherits the prior status and is not added to unclassified', () => {
  const marks = { [a]: mark('ignored', 1) }, saved = catalog();
  assert.deepEqual(selectProducts(saved, marks, { status: 'unclassified' }), []);
  assert.equal(personalProducts(saved, marks, {}, now)[0].offers.length, 1);
});
