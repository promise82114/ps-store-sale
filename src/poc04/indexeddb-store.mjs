import * as state from './sync-state.mjs';
import { productInfo, rememberProductInfo } from '../personal-list.mjs';

export class StorageError extends Error {
  constructor(code) { super(code); this.code = code; }
}
// One aggregate record: marks, Base, outbox and journal commit atomically together.
// Callbacks are synchronous IDB request handlers: never await network inside a tx.
export async function openPersonalStore({ factory = globalThis.indexedDB,
  name = 'ps-store-sale-filter-poc04' } = {}) {
  if (!factory?.open) throw new StorageError('INDEXEDDB_UNAVAILABLE');
  const db = await new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
    };
    request.onblocked = () => { blocked = true; reject(new StorageError('DATABASE_BLOCKED')); };
    request.onerror = () => reject(new StorageError('DATABASE_OPEN_FAILED'));
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
  });
  db.onversionchange = () => db.close();
  function transaction(mutator, backup = false, product = null) {
    return new Promise((resolve, reject) => {
      let tx, result, failure;
      try {
        tx = db.transaction('state', mutator ? 'readwrite' : 'readonly');
        tx.oncomplete = () => resolve(structuredClone(result));
        tx.onabort = () => reject(failure ?? new StorageError('STORAGE_TRANSACTION_FAILED'));
        tx.onerror = () => {}; // onabort is the terminal failure; no early success.
        const store = tx.objectStore('state'), request = store.get('personal');
        request.onsuccess = () => {
          try {
            const current = state.validateState(request.result ?? state.emptyState());
            result = mutator ? mutator(current) : current;
            if (mutator) {
              const validated = state.validateState(result);
              if (backup && JSON.stringify(current.document) !== JSON.stringify(validated.document))
                store.put(current.document, 'before-import');
              store.put(validated, 'personal');
              if (product) {
                const infoRequest = store.get('product-info');
                infoRequest.onsuccess = () => {
                  try { store.put(rememberProductInfo(infoRequest.result, [product], validated.document.data.marks), 'product-info'); }
                  catch { failure = new StorageError('STORAGE_TRANSACTION_FAILED'); tx.abort(); }
                };
              }
            }
          } catch (error) {
            failure = typeof error.code === 'string' ? error : new StorageError('STORAGE_TRANSACTION_FAILED');
            tx.abort();
          }
        };
      } catch { reject(new StorageError('STORAGE_TRANSACTION_FAILED')); }
    });
  }
  try { await transaction(value => value); } catch (error) { db.close(); throw error; }
  const adapter = { read: () => transaction(), close: () => db.close() };
  // Separate metadata record in the existing store: no personal schema/version change.
  function productCache(products) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', products ? 'readwrite' : 'readonly'), store = tx.objectStore('state');
      let current, cached, result, loaded = 0, failure;
      const finish = () => {
        if (++loaded !== 2) return;
        try {
          const marks = state.validateState(current ?? state.emptyState()).document.data.marks;
          result = rememberProductInfo(cached, products ?? [], marks);
          if (products && JSON.stringify(result) !== JSON.stringify(cached ?? {})) store.put(result, 'product-info');
        } catch { failure = new StorageError('STORAGE_TRANSACTION_FAILED'); tx.abort(); }
      };
      const personalRequest = store.get('personal'), infoRequest = store.get('product-info');
      personalRequest.onsuccess = () => { current = personalRequest.result; finish(); };
      infoRequest.onsuccess = () => { cached = infoRequest.result; finish(); };
      tx.oncomplete = () => resolve(structuredClone(result));
      tx.onabort = () => reject(failure ?? new StorageError('STORAGE_TRANSACTION_FAILED'));
      tx.onerror = () => {};
    });
  }
  adapter.readProductInfo = () => productCache();
  adapter.rememberProducts = products => productCache(products);
  adapter.classifyProduct = (product, ...args) => {
    const info = productInfo(product);
    return transaction(value => state.classify(value, info.key, ...args), false, info);
  };
  adapter.toggleProduct = (product, status, metadata) => {
    const info = productInfo(product); let undo;
    return transaction(value => {
      const changed = state.toggleClassification(value, info.key, status, metadata);
      undo = changed.undo; return changed.state;
    }, false, info).then(current => ({ state: current, undo }));
  };
  adapter.undoProduct = (product, undo, metadata) => {
    const info = productInfo(product);
    if (info.key !== undo?.key) throw new StorageError('INVALID_UNDO_PRODUCT');
    return transaction(value => state.undoClassification(value, undo, metadata), false, info);
  };
  adapter.importBackup = (...args) => transaction(value => state.mergeLocalBackup(value, ...args), true);
  adapter.readImportBackup = () => new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readonly'); let backup = null;
    const request = tx.objectStore('state').get('before-import');
    request.onsuccess = () => { backup = request.result ?? null; };
    tx.oncomplete = () => resolve(backup);
    tx.onabort = () => reject(new StorageError('STORAGE_TRANSACTION_FAILED'));
    tx.onerror = () => {};
  });
  for (const method of ['classify', 'begin', 'stage', 'sending', 'failed', 'cancelPrepared', 'acknowledge'])
    adapter[method] = (...args) => transaction(value => state[method](value, ...args));
  return adapter;
}
