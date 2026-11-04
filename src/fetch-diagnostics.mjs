import { createHash } from 'node:crypto';

// Only fixed codes, query field names and message templates may leave an API response.
const knownCodes = new Set([
  'INTERNAL_SERVER_ERROR', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'UPSTREAM_ERROR',
  'TIMEOUT', 'GATEWAY_TIMEOUT', 'BAD_GATEWAY', 'BAD_REQUEST', 'NOT_FOUND',
  'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN',
  'RATE_LIMITED', 'TOO_MANY_REQUESTS', 'PERSISTED_QUERY_NOT_FOUND', 'PERSISTED_QUERY_NOT_SUPPORTED',
  'PersistedQueryNotFound', 'PersistedQueryNotSupported',
]);
const knownFields = new Set(('categoryGridRetrieve id sortedBy name isAscending displayName sortingOptions '
  + 'facetOptions values count key pageInfo totalCount offset size isLast products npTitleId telemetryData '
  + 'price basePrice discountedPrice discountText isFree isExclusive isTiedToSubscription serviceBranding '
  + 'upsellServiceBranding upsellText includesBundleOffer platforms localizedStoreDisplayClassification '
  + 'storeDisplayClassification media type url role personalizedMeta hasMediaOverrides skus concepts '
  + 'localizedName reportingName __typename').split(' '));
const messageTemplates = [
  [/cannot return null for non-nullable field/i, 'Non-nullable field returned null'],
  [/persisted.?query.?not.?found/i, 'Persisted query not found'],
  [/persisted.?query.?not.?supported/i, 'Persisted query not supported'],
  [/internal server error/i, 'Internal server error'],
  [/timed? ?out|timeout/i, 'Timeout'],
  [/service unavailable/i, 'Service unavailable'],
  [/too many requests|rate limit/i, 'Rate limit reported'],
  [/unauthenticated|authentication required/i, 'Authentication required'],
  [/access denied|forbidden/i, 'Access denied'],
];
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export function summarizeGraphqlErrors(payload) {
  if (!Array.isArray(payload?.errors) || !payload.errors.length) return null;
  const grid = payload.data?.categoryGridRetrieve;
  return {
    errorCount: payload.errors.length, omittedErrorCount: Math.max(0, payload.errors.length - 5),
    dataPresent: payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data),
    categoryPresent: grid !== null && typeof grid === 'object' && !Array.isArray(grid),
    returnedProductCount: Array.isArray(grid?.products) ? grid.products.length : null,
    errors: payload.errors.slice(0, 5).map(error => {
      const code = typeof error?.extensions?.code === 'string' ? error.extensions.code : null;
      const message = typeof error?.message === 'string' ? error.message : '';
      const path = Array.isArray(error?.path) ? error.path : [];
      return {
        code: code === null ? null : knownCodes.has(code) ? code : 'UNRECOGNIZED',
        message: messageTemplates.find(([pattern]) => pattern.test(message))?.[1] ?? 'Message omitted',
        fingerprint: fingerprint([code, message, path]),
        path: path.slice(0, 12).map(part => Number.isSafeInteger(part) && part >= 0 ? part
          : knownFields.has(part) ? part : '[REDACTED]'),
        pathTruncated: path.length > 12,
      };
    }),
  };
}

export function diagnosticErrorInfo(error) {
  const result = { code: error.code, stage: error.stage, httpStatus: error.httpStatus };
  for (const key of ['offset', 'requestedSize', 'attempt', 'purpose', 'graphql'])
    if (error[key] !== undefined) result[key] = error[key];
  return result;
}

export function graphqlReportText(graphql) {
  if (!graphql) return '';
  const rows = [
    ['GraphQL errors / omitted', `${graphql.errorCount} / ${graphql.omittedErrorCount}`],
    ['Data / category present', `${graphql.dataPresent} / ${graphql.categoryPresent}`],
    ['Returned products (not accepted)', graphql.returnedProductCount ?? 'unknown'],
  ];
  let text = '| Field | Value |\n|---|---|\n' + rows.map(row => `| ${row.join(' | ')} |`).join('\n') + '\n\n';
  text += '| Code | Safe message | Path | Fingerprint |\n|---|---|---|---|\n';
  text += graphql.errors.map(error => `| ${error.code ?? 'absent'} | ${error.message} | ${error.path.join('.')}${error.pathTruncated ? ' …' : ''} | ${error.fingerprint} |`).join('\n') + '\n';
  return text;
}

export function fetchSummary(report) {
  const error = report.error;
  const offset = Number.isSafeInteger(error?.offset) ? error.offset : null;
  const size = Number.isSafeInteger(error?.requestedSize) ? error.requestedSize : null;
  const pages = report.sweeps?.at(-1)?.pages?.filter(page => page.purpose === 'fetch') ?? [];
  const pageIndex = pages.findIndex(page => page.expectedOffset === offset);
  const pageNumber = pageIndex >= 0 ? pageIndex + 1 : offset === 0 ? 1 : 'unknown';
  const rows = [
    ['抓取結果（不代表部署結果）', report.complete ? '完整驗證通過' : '未完成'],
    ['已取得／預期商品數', `${report.uniqueProductCount ?? 0} / ${report.reportedTotalCount ?? report.pageInfo?.totalCount ?? 'unknown'}`],
    ['失敗頁碼／offset／size', offset === null ? 'n/a' : `${pageNumber} / ${offset} / ${size ?? 'unknown'}`],
    ['失敗請求用途', error?.purpose ?? 'n/a'],
    ['錯誤分類／階段', error ? `${error.code} / ${error.stage}` : 'none'],
    ['HTTP 狀態', error?.httpStatus ?? 'n/a'],
    ['失敗請求嘗試次數', error?.attempt ?? 'n/a'],
    ['HTTP 總嘗試／重試次數', `${report.requests?.length ?? 0} / ${report.retryCount ?? 0}`],
    ['停止原因', error?.code === 'GRAPHQL_ERROR' ? 'GraphQL 錯誤；現行策略不重試此類錯誤' : error?.code ?? 'none'],
  ];
  let text = '| 項目 | 結果 |\n|---|---|\n' + rows.map(row => `| ${row.join(' | ')} |`).join('\n') + '\n\n';
  text += graphqlReportText(error?.graphql);
  text += '\n原始錯誤訊息、未知 code／path 與其他 extensions 不公開；指紋用於比對重複錯誤。\n';
  return text;
}
