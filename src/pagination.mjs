import { apiUrl, pageSize, saleId, validatePage } from './diagnostic.mjs';
import { DiagnosticError } from './http.mjs';

export const fullFetchLimits = { maxPages: 500, maxSweeps: 2, maxDurationMs: 8 * 60 * 1000 };

export async function readPage(get, hash, offset, size, pages, { purpose = 'fetch', deadlineAt = Infinity, expectedTotalCount = null, expectedSaleId = saleId } = {}) {
  const started = Date.now();
  const record = { purpose, expectedOffset: offset, requestedSize: size, offset: null, size: null,
    totalCount: null, isLast: null, returnedProductCount: null, httpStatus: null,
    durationMs: null, validated: false, failureCode: null };
  pages.push(record);
  try {
    const response = await get(apiUrl(hash, offset, size, expectedSaleId), 'graphql-page', { json: true, offset, size, deadlineAt });
    record.httpStatus = response.httpStatus;
    let payload;
    try { payload = JSON.parse(response.text); }
    catch { throw new DiagnosticError('INVALID_JSON', 'graphql-page', response.httpStatus); }
    const grid = payload?.data?.categoryGridRetrieve;
    if (grid && typeof grid === 'object') {
      for (const key of ['offset', 'size', 'totalCount']) {
        if (Number.isSafeInteger(grid.pageInfo?.[key])) record[key] = grid.pageInfo[key];
      }
      if (typeof grid.pageInfo?.isLast === 'boolean') record.isLast = grid.pageInfo.isLast;
      if (Array.isArray(grid.products)) record.returnedProductCount = grid.products.length;
    }
    const page = validatePage(payload, { offset, requestedSize: size, deriveProductUrls: true, expectedTotalCount, expectedSaleId });
    record.validated = true;
    return page;
  } catch (error) {
    record.failureCode = error instanceof DiagnosticError ? error.code : 'INTERNAL_ERROR';
    record.httpStatus ??= error.httpStatus ?? null;
    throw error;
  } finally {
    record.durationMs = Date.now() - started;
  }
}

const sameIds = (left, right) => left.products.length === right.products.length &&
  left.products.every((product, index) => product.id === right.products[index].id);

export async function fetchFullActivity(get, hash, report, options = {}) {
  const { expectedSaleId = saleId, ...overrides } = options;
  const limits = { ...fullFetchLimits, ...overrides };
  const started = Date.now();
  const deadlineAt = started + limits.maxDurationMs;
  report.sweeps = [];
  report.limits = limits;
  for (let attempt = 1; attempt <= limits.maxSweeps; attempt++) {
    const sweep = { attempt, startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
      reportedTotalCount: null, pageCount: 0, rawProductCount: 0, uniqueProductCount: 0,
      duplicateProductCount: 0, duplicateIdCount: 0, duplicateIds: [], pages: [],
      boundaryVerification: 'NOT_RUN', accepted: false, error: null };
    report.sweeps.push(sweep);
    const products = new Map();
    const frequencies = new Map();
    const visitedOffsets = new Set();
    let offset = 0, size = pageSize, first, last;
    const publishCounts = () => {
      sweep.uniqueProductCount = products.size;
      sweep.duplicateProductCount = sweep.rawProductCount - products.size;
      sweep.duplicateIds = [...frequencies].filter(([, count]) => count > 1).map(([id, occurrences]) => ({ id, occurrences }));
      sweep.duplicateIdCount = sweep.duplicateIds.length;
      for (const key of ['reportedTotalCount', 'pageCount', 'rawProductCount', 'uniqueProductCount',
        'duplicateProductCount', 'duplicateIdCount', 'duplicateIds']) report[key] = sweep[key];
      report.pageInfo = last?.pageInfo ?? null;
    };
    try {
      for (;;) {
        if (Date.now() >= deadlineAt) throw new DiagnosticError('RUN_BUDGET_EXCEEDED', 'pagination');
        if (sweep.pageCount >= limits.maxPages) throw new DiagnosticError('MAX_PAGES_EXCEEDED', 'pagination');
        if (visitedOffsets.has(offset)) throw new DiagnosticError('REPEATED_OFFSET', 'pagination');
        visitedOffsets.add(offset);
        const page = await readPage(get, hash, offset, size, sweep.pages, { deadlineAt, expectedTotalCount: sweep.reportedTotalCount, expectedSaleId });
        if (offset === 0) report.firstPageValidation = 'PASS';
        if (sweep.reportedTotalCount === null) sweep.reportedTotalCount = page.pageInfo.totalCount;
        if (page.pageInfo.totalCount !== sweep.reportedTotalCount) throw new DiagnosticError('TOTAL_COUNT_CHANGED', 'pagination');
        first ??= page;
        last = page;
        sweep.pageCount++;
        sweep.rawProductCount += page.rawProductCount;
        const previousUnique = products.size;
        for (const product of page.products) {
          frequencies.set(product.id, (frequencies.get(product.id) ?? 0) + 1);
          if (!products.has(product.key)) products.set(product.key, product);
        }
        publishCounts();
        if (products.size === previousUnique) throw new DiagnosticError('NO_PROGRESS', 'pagination');
        if (sweep.duplicateProductCount > 0) throw new DiagnosticError('DUPLICATE_PRODUCT_ID', 'pagination');
        const covered = offset + page.products.length;
        if (covered === sweep.reportedTotalCount) break;
        const next = page.pageInfo.offset + page.pageInfo.size;
        if (!Number.isSafeInteger(next) || next <= offset) throw new DiagnosticError('NO_PROGRESS', 'pagination');
        offset = next;
        size = page.pageInfo.size;
      }
      if (sweep.rawProductCount !== sweep.reportedTotalCount || products.size !== sweep.reportedTotalCount) {
        throw new DiagnosticError('UNIQUE_COUNT_MISMATCH', 'pagination');
      }
      sweep.boundaryVerification = 'RUNNING';
      for (const [original, purpose] of [[first, 'verify-first'], ...(sweep.pageCount > 1 ? [[last, 'verify-last']] : [])]) {
        const verified = await readPage(get, hash, original.pageInfo.offset, original.pageInfo.size, sweep.pages,
          { purpose, deadlineAt, expectedTotalCount: sweep.reportedTotalCount, expectedSaleId });
        if (verified.pageInfo.totalCount !== sweep.reportedTotalCount) throw new DiagnosticError('TOTAL_COUNT_CHANGED', 'boundary-verification');
        if (!sameIds(original, verified)) throw new DiagnosticError('BOUNDARY_CHANGED', 'boundary-verification');
      }
      if (Date.now() >= deadlineAt) throw new DiagnosticError('RUN_BUDGET_EXCEEDED', 'pagination');
      sweep.boundaryVerification = 'PASS';
      sweep.accepted = true;
      publishCounts();
      report.fullValidation = 'PASS';
      return { totalCount: sweep.reportedTotalCount, reportedTotalCount: sweep.reportedTotalCount,
        rawProductCount: sweep.rawProductCount, uniqueProductCount: products.size,
        duplicateProductCount: sweep.duplicateProductCount, duplicateIdCount: sweep.duplicateIdCount,
        products: [...products.values()] };
    } catch (error) {
      const failure = error instanceof DiagnosticError ? error : new DiagnosticError('INTERNAL_ERROR', 'pagination');
      sweep.error = { code: failure.code, stage: failure.stage, httpStatus: failure.httpStatus };
      if (sweep.boundaryVerification === 'RUNNING') sweep.boundaryVerification = 'FAIL';
      publishCounts();
      if (['TOTAL_COUNT_CHANGED', 'BOUNDARY_CHANGED'].includes(failure.code) && attempt < limits.maxSweeps && Date.now() < deadlineAt) continue;
      failure.partial = { totalCount: sweep.reportedTotalCount, ...Object.fromEntries(
        ['rawProductCount', 'uniqueProductCount', 'duplicateProductCount', 'duplicateIdCount'].map(key => [key, sweep[key]])),
        products: [...products.values()] };
      report.fullValidation = 'FAIL';
      throw failure;
    } finally {
      sweep.finishedAt = new Date().toISOString();
      sweep.durationMs = Date.parse(sweep.finishedAt) - Date.parse(sweep.startedAt);
      report.fetchDurationMs = Date.now() - started;
    }
  }
}
