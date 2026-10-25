import { fileName } from '../../src/poc04/drive-transport.mjs';

export const jsonResponse = (value, status = 200) => ({ ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(value) });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Offline HTTP-shaped fake only. Neither fetch nor OAuth is used anywhere here.
export function mockBackend(document = null) {
  const backend = { files: [], calls: [], before: null, afterWrite: null };
  backend.add = (doc, id = `file_${backend.files.length + 1}`) => {
    const file = { id, document: structuredClone(doc), version: 1, etag: '"etag-1"' };
    backend.files.push(file); return file;
  };
  if (document) backend.add(document);
  const info = f => ({ id: f.id, name: fileName, version: String(f.version),
    size: String(new TextEncoder().encode(JSON.stringify(f.document)).byteLength) });
  backend.request = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    backend.calls.push({ url, method, headers: { ...options.headers } });
    if (backend.before) {
      const intercepted = await backend.before(url, options);
      if (intercepted) return intercepted;
    }
    const parsed = new URL(url);
    if (parsed.origin !== 'https://www.googleapis.com') throw Error('unexpected mock host');
    if (method === 'GET' && parsed.pathname === '/drive/v3/files')
      return jsonResponse({ files: backend.files.map(info) });
    const file = backend.files.find(f => parsed.pathname.endsWith(`/${f.id}`));
    if (method === 'GET' && file) {
      if (parsed.searchParams.get('alt') === 'media') return jsonResponse(file.document);
      const meta = info(file);
      return jsonResponse({ id: meta.id, title: meta.name, version: meta.version, fileSize: meta.size, etag: file.etag });
    }
    if (method === 'PUT' && file) {
      if (options.headers['If-Match'] !== file.etag) return jsonResponse({}, 412);
      file.document = JSON.parse(options.body); file.version++; file.etag = `"etag-${file.version}"`;
      if (backend.afterWrite) await backend.afterWrite(file);
      return jsonResponse({ id: file.id });
    }
    if (method === 'POST' && parsed.pathname === '/upload/drive/v3/files') {
      const parts = options.body.split('--poc04_json_boundary');
      const meta = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
      if (meta.name !== fileName || JSON.stringify(meta.parents) !== '["appDataFolder"]') throw Error('invalid create');
      const created = backend.add(JSON.parse(parts[2].split('\r\n\r\n')[1].trim()));
      if (backend.afterWrite) await backend.afterWrite(created);
      return jsonResponse({ id: created.id });
    }
    return jsonResponse({}, 404);
  };
  backend.writes = () => backend.calls.filter(call => call.method !== 'GET');
  return backend;
}
