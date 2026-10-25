import { setTimeout as sleep } from 'node:timers/promises';

export class DiagnosticError extends Error {
  constructor(code, stage, httpStatus = null) {
    super(code);
    this.code = code;
    this.stage = stage;
    this.httpStatus = httpStatus;
  }
}

export function responseProblem(status, text, contentType = '') {
  if (status === 401 || /unauthenticated|authentication required|sign.?in required/i.test(text)) return 'AUTH_REQUIRED';
  if (status === 403) return 'ACCESS_DENIED';
  if (/captcha|verify you are human|access denied|akamai bot|challenge-platform/i.test(text)) return 'ACCESS_CHALLENGE';
  if (/Cross-Site Request Forgery|CSRF/i.test(text)) return 'CSRF_HEADER_REQUIRED';
  if (/persisted.?query.?not.?found|persisted.?query.?not.?supported|not whitelisted|query.+not allowed/i.test(text)) return 'QUERY_UNAVAILABLE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  if (status >= 300 && status < 400) return 'REDIRECT_REJECTED';
  if (status < 200 || status >= 300) return 'HTTP_ERROR';
  if (contentType.includes('text/html')) return 'NON_JSON_RESPONSE';
  return null;
}

export function retryDelay(value, now = Date.now()) {
  if (value === null) return 1000;
  const seconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 30 ? Math.max(1000, seconds * 1000) : null;
}

export function createClient(requests, { fetchImpl = fetch, wait = sleep, minimumIntervalMs = 750 } = {}) {
  let lastRequest = 0;
  return async function get(url, stage, { json = false, offset, size, deadlineAt = Infinity } = {}) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await wait(Math.max(0, minimumIntervalMs - (Date.now() - lastRequest)));
      if (Date.now() >= deadlineAt) throw new DiagnosticError('RUN_BUDGET_EXCEEDED', stage);
      lastRequest = Date.now();
      const started = Date.now();
      const event = { stage, attempt, httpStatus: null, durationMs: null, failureCode: null };
      if (Number.isSafeInteger(offset)) event.offset = offset;
      if (Number.isSafeInteger(size)) event.requestedSize = size;
      requests.push(event);
      let response, text;
      try {
        response = await fetchImpl(url, {
          method: 'GET', redirect: 'manual', credentials: 'omit',
          signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadlineAt - Date.now()))),
          headers: { Accept: json ? 'application/json' : '*/*',
            'User-Agent': 'ps-store-poc01/0.1',
            ...(json ? { 'Content-Type': 'application/json', 'X-PSN-Store-Locale-Override': 'zh-hant-tw' } : {}) },
        });
        event.httpStatus = response.status;
        const reader = response.body?.getReader();
        const chunks = [];
        let length = 0;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > 8 * 1024 * 1024) {
              await reader.cancel();
              throw new DiagnosticError('RESPONSE_TOO_LARGE', stage, response.status);
            }
            chunks.push(Buffer.from(value));
          }
        }
        text = Buffer.concat(chunks).toString('utf8');
      } catch (error) {
        event.durationMs = Date.now() - started;
        event.failureCode = error instanceof DiagnosticError ? error.code :
          ['TimeoutError', 'AbortError'].includes(error.name) ? 'TIMEOUT' : 'NETWORK_ERROR';
        if (error instanceof DiagnosticError || attempt === 3) throw new DiagnosticError(event.failureCode, stage, event.httpStatus);
        await wait(1000 * 2 ** (attempt - 1));
        continue;
      }
      event.durationMs = Date.now() - started;
      const contentType = response.headers.get('content-type') ?? '';
      // Client bundles contain error-handler strings; those are not API errors.
      let errorText = contentType.includes('text/html') ? text : '';
      if (json || response.status >= 400) {
        try {
          const payload = JSON.parse(text);
          errorText = JSON.stringify({ errors: payload?.errors, message: payload?.message });
        } catch { errorText = text.slice(0, 8192); }
      }
      const problem = responseProblem(response.status, errorText, json ? contentType : '');
      if (!problem) return { text, httpStatus: response.status };
      event.failureCode = problem;
      if (['UPSTREAM_ERROR', 'RATE_LIMITED'].includes(problem) && attempt < 3) {
        const delay = problem === 'RATE_LIMITED' ? retryDelay(response.headers.get('retry-after')) : 1000 * 2 ** (attempt - 1);
        if (delay !== null) { await wait(delay); continue; }
      }
      throw new DiagnosticError(problem, stage, response.status);
    }
  };
}
