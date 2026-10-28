import { exportBackup, importBackup, limits, requireData, validateDocument } from './personal-data.mjs';

export const fileName = 'ps-store-sale-filter.json';
export const strongETag = value => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]+"$/.test(value);
export class DriveError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const sameVersion = (a, b) => a?.id === b?.id && a?.version === b?.version;
export function validateFile(file, protectedWrite = false) {
  requireData(file && typeof file.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(file.id)
    && file.name === fileName && typeof file.version === 'string' && /^\d+$/.test(file.version)
    && typeof file.size === 'string' && /^\d+$/.test(file.size)
    && Number.isSafeInteger(Number(file.size)) && Number(file.size) <= limits.bytes, 'INVALID_REMOTE_METADATA');
  if (protectedWrite) requireData(strongETag(file.etag), 'INVALID_ETAG');
  return file;
}

// Intentionally requires injected transport. There is no fetch/OAuth fallback.
// Mirrors PS Game Base's v2 resource ETag + v2 PUT / If-Match boundary.
export function createMockableDrive({ request, timeoutMs = 20_000 } = {}) {
  requireData(typeof request === 'function', 'TRANSPORT_REQUIRED');
  requireData(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'INVALID_TIMEOUT');
  async function call(url, options = {}) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await request(url, { ...options, signal: controller.signal,
            redirect: 'error', cache: 'no-store' });
          if (!response.ok) throw new DriveError(`HTTP_${response.status}`);
          const text = await response.text();
          if (new TextEncoder().encode(text).byteLength > limits.bytes) throw new DriveError('REMOTE_TOO_LARGE');
          return text;
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new DriveError('TIMEOUT'));
        }, timeoutMs); }),
      ]);
    } catch (error) {
      if (error instanceof DriveError) throw error;
      if (['SESSION_CHANGED', 'AUTH_REQUIRED', 'HTTP_401', 'TIMEOUT', 'REMOTE_TOO_LARGE', 'INVALID_DRIVE_ENDPOINT'].includes(error?.code))
        throw new DriveError(error.code);
      throw new DriveError('NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }
  function json(text) {
    try { return JSON.parse(text); } catch { throw new DriveError('INVALID_REMOTE_JSON'); }
  }
  async function find() {
    let token;
    const seen = new Set(), files = [];
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ spaces: 'appDataFolder',
        q: `name = '${fileName}' and trashed = false`, fields: 'nextPageToken,files(id,name,version,size)', pageSize: '100' });
      if (token) params.set('pageToken', token);
      const result = json(await call(`https://www.googleapis.com/drive/v3/files?${params}`));
      requireData(Array.isArray(result.files), 'INVALID_REMOTE_LIST');
      result.files.forEach(file => validateFile(file));
      files.push(...result.files);
      requireData(files.length <= 1, 'DUPLICATE_FILES');
      token = result.nextPageToken;
      if (token === undefined) return files[0] ?? null;
      requireData(typeof token === 'string' && token.length > 0 && !seen.has(token), 'INVALID_PAGE_TOKEN');
      seen.add(token);
    }
    throw new DriveError('LIST_PAGE_LIMIT');
  }
  async function metadata(id) {
    const data = json(await call(`https://www.googleapis.com/drive/v2/files/${encodeURIComponent(id)}?fields=id,title,version,fileSize,etag`));
    return validateFile({ id: data.id, name: data.title, version: data.version, size: data.fileSize, etag: data.etag ?? null });
  }
  async function read() {
    const listed = await find();
    if (!listed) return null;
    const before = await metadata(listed.id);
    requireData(sameVersion(listed, before), 'REMOTE_CHANGED');
    const text = await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(listed.id)}?alt=media`);
    const after = await metadata(listed.id);
    requireData(sameVersion(before, after) && before.etag === after.etag, 'REMOTE_CHANGED');
    const document = importBackup(text);
    requireData(document.data.datasetId !== null, 'REMOTE_UNBOUND');
    return { file: after, document };
  }
  async function write(document, expected) {
    const candidate = validateDocument(document);
    requireData(candidate.data.datasetId !== null, 'REMOTE_UNBOUND');
    if (expected) {
      validateFile(expected.file, true);
      const previous = validateDocument(expected.document);
      requireData(previous.data.datasetId === candidate.data.datasetId, 'LINEAGE_CHANGED');
    }
    const current = await find();
    requireData(expected ? current && sameVersion(current, expected.file) : current === null, 'REMOTE_CHANGED');
    const body = exportBackup(candidate);
    let writtenId;
    if (current) {
      const latest = await metadata(current.id);
      validateFile(latest, true);
      requireData(sameVersion(latest, expected.file) && latest.etag === expected.file.etag, 'REMOTE_CHANGED');
      await call(`https://www.googleapis.com/upload/drive/v2/files/${encodeURIComponent(current.id)}?uploadType=media`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': expected.file.etag }, body,
      });
      writtenId = current.id;
    } else {
      const boundary = 'poc04_json_boundary';
      const meta = { name: fileName, mimeType: 'application/json', parents: ['appDataFolder'] };
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const created = json(await call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
      }));
      requireData(typeof created.id === 'string', 'INVALID_CREATE_RECEIPT');
      writtenId = created.id;
    }
    // Check uniqueness again after creation and verify the exact candidate content.
    const receipt = await read();
    requireData(receipt?.file.id === writtenId && exportBackup(receipt.document) === body, 'WRITE_UNCONFIRMED');
    validateFile(receipt.file, true);
    return receipt;
  }
  return Object.freeze({ read, write });
}
