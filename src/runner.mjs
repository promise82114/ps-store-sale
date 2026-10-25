import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { platform, arch } from 'node:os';
import { createClient, DiagnosticError } from './http.mjs';
import { apiUrl, defaultUrl, discoverQuery, endpoint, locale, saleId, validateFirstPage, validateSaleUrl } from './diagnostic.mjs';
import { fetchFullActivity } from './pagination.mjs';
import { campaignByUrl } from './campaigns.mjs';

const filenames = ['first-page-products.json', 'sale-products.json', 'partial-products.json'];

async function writeJson(output, filename, value) {
  const temporary = new URL(filename + '.tmp', output);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, new URL(filename, output));
}

function readableReport(report) {
  const rows = [
    ['Started / finished (UTC)', `${report.startedAt} / ${report.finishedAt}`],
    ['Mode', report.mode ?? 'invalid'], ['Source', report.sourceUrl ?? 'rejected input'],
    ['Environment check', report.environmentCheck], ['First page', report.firstPageValidation],
    ['Full activity validation', report.fullValidation], ['Complete', report.complete],
    ['GitHub-hosted runner', report.environment.githubHostedRunner], ['Actions run', report.environment.runUrl ?? 'not run in Actions'],
    ['Authentication used', false], ['API', endpoint], ['Operation', 'categoryGridRetrieve'],
    ['Query hash', report.queryHash ?? 'not discovered'],
    ['Reported total', report.reportedTotalCount ?? report.pageInfo?.totalCount ?? 'unknown'],
    ['Pages / sweeps', `${report.pageCount ?? 0} / ${report.sweeps?.length ?? 0}`],
    ['Raw / unique / duplicate products', `${report.rawProductCount ?? 0} / ${report.uniqueProductCount ?? 0} / ${report.duplicateProductCount ?? 0}`],
    ['Elapsed / fetch milliseconds', `${report.elapsedMs} / ${report.fetchDurationMs ?? 'n/a'}`],
    ['HTTP attempts / retries', `${report.requests.length} / ${report.retryCount}`],
    ['Error', report.error ? `${report.error.code} (${report.error.stage}, HTTP ${report.error.httpStatus ?? 'n/a'})` : 'none'],
    ['Conclusion', report.conclusion],
  ];
  let text = '# PS Store POC-01 diagnostic\n\n| Field | Value |\n|---|---|\n' +
    rows.map(([key, value]) => `| ${key} | ${value} |`).join('\n') + '\n\n';
  text += 'PASS is limited to this POC and selected mode. Local execution does not establish GitHub-hosted access.\n';
  text += 'Full success requires all pages, unique count matching the current total, and stable first/last-page revalidation.\n';
  text += 'This checks consistency signals; the API does not provide a point-in-time snapshot guarantee.\n';
  if (report.limits) text += `\nLimits: ${report.limits.maxPages} pages per sweep, ${report.limits.maxSweeps} sweeps, ${report.limits.maxDurationMs}ms fetch budget.\n`;
  for (const sweep of report.sweeps ?? []) {
    text += `\n## Sweep ${sweep.attempt}\n\nAccepted: ${sweep.accepted}; boundary check: ${sweep.boundaryVerification}; error: ${sweep.error?.code ?? 'none'}.\n\n`;
    text += '| Purpose | Expected offset | Offset | Size | Total | Products | HTTP | ms | Validated | Error |\n|---|---|---|---|---|---|---|---|---|---|\n';
    text += sweep.pages.map(page => `| ${[page.purpose, page.expectedOffset, page.offset, page.size, page.totalCount,
      page.returnedProductCount, page.httpStatus, page.durationMs, page.validated, page.failureCode ?? 'none'].join(' | ')} |`).join('\n') + '\n';
  }
  return text;
}

export async function runDiagnostic({ args = process.argv.slice(2), env = process.env,
  output = new URL('../artifacts/', import.meta.url), clientOptions = {}, fullLimits = {}, campaign = null } = {}) {
  const startedAt = new Date().toISOString();
  const hostedRunner = env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  const runUrl = env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ?
    `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const report = {
    schemaVersion: 1, scope: 'poc-01', startedAt, finishedAt: null, elapsedMs: null,
    mode: null, sourceUrl: null, saleId, locale, apiEndpoint: endpoint,
    operationName: 'categoryGridRetrieve', authenticationUsed: false,
    environment: { node: process.version, os: platform(), arch: arch(), githubHostedRunner: hostedRunner, runUrl },
    environmentCheck: 'NOT_RUN', firstPageValidation: 'NOT_RUN', fullValidation: 'NOT_RUN', conclusion: 'INCONCLUSIVE',
    complete: false, requests: [], error: null, partialFile: null,
  };
  let exitCode = 0;
  await mkdir(output, { recursive: true });
  for (const filename of filenames) {
    await rm(new URL(filename, output), { force: true });
    await rm(new URL(filename + '.tmp', output), { force: true });
  }
  try {
    let mode = 'environment';
    let sourceUrl = env.SALE_URL ?? campaign?.sourceUrl ?? defaultUrl;
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i + 1]) throw new DiagnosticError('INVALID_ARGUMENT', 'input');
      if (args[i] === '--mode') mode = args[i + 1];
      else if (args[i] === '--sale-url') sourceUrl = args[i + 1];
      else throw new DiagnosticError('INVALID_ARGUMENT', 'input');
    }
    if (!['environment', 'first-page', 'full'].includes(mode)) throw new DiagnosticError('INVALID_MODE', 'input');
    report.mode = mode;
    validateSaleUrl(sourceUrl, campaign?.id ?? saleId);
    const selected = campaignByUrl(sourceUrl);
    report.saleId = selected.id;
    report.sourceUrl = sourceUrl;
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 20 || (major === 20 && minor < 18)) throw new DiagnosticError('UNSUPPORTED_RUNTIME', 'environment');
    report.environmentCheck = 'PASS';
    if (mode !== 'environment') {
      const get = createClient(report.requests, clientOptions);
      const query = await discoverQuery(get, sourceUrl, report);
      report.queryHash = query.sha256Hash;
      report.queryHashMethod = 'current official query + Apollo typename + sorted AST + legacy Store printer';
      if (mode === 'full') {
        report.productUrlRule = 'https://store.playstation.com/zh-hant-tw/product/{id} (verified 2026-10-20; restricted ID characters)';
        const full = await fetchFullActivity(get, query.sha256Hash, report, { ...fullLimits, expectedSaleId: selected.id });
        await writeJson(output, 'sale-products.json', {
          schemaVersion: 1, scope: 'full-activity', complete: true,
          saleId: selected.id, locale, sourceUrl, fetchedAt: new Date().toISOString(), ...full,
        });
        report.complete = true;
      } else {
        const response = await get(apiUrl(query.sha256Hash, 0, 24, selected.id), 'graphql-first-page', { json: true, offset: 0, size: 24 });
        let payload;
        try { payload = JSON.parse(response.text); }
        catch { throw new DiagnosticError('INVALID_JSON', 'graphql-first-page', response.httpStatus); }
        const firstPage = validateFirstPage(payload, selected.id);
        report.firstPageValidation = 'PASS';
        const { products, ...counts } = firstPage;
        Object.assign(report, counts, { pageCount: 1 });
        await writeJson(output, 'first-page-products.json', {
          schemaVersion: 1, scope: 'first-page-only', complete: false,
          saleId: selected.id, locale, fetchedAt: new Date().toISOString(), ...firstPage,
        });
      }
      report.conclusion = hostedRunner ? 'PASS' : 'INCONCLUSIVE';
    }
  } catch (error) {
    const failure = error instanceof DiagnosticError ? error : new DiagnosticError('INTERNAL_ERROR', 'runtime');
    report.complete = false;
    report.error = { code: failure.code, stage: failure.stage, httpStatus: failure.httpStatus };
    if (report.mode === 'full') report.fullValidation = 'FAIL';
    if (report.mode === 'first-page' || (report.mode === 'full' && report.firstPageValidation === 'NOT_RUN')) report.firstPageValidation = 'FAIL';
    report.conclusion = ['NETWORK_ERROR', 'TIMEOUT', 'UPSTREAM_ERROR', 'RATE_LIMITED', 'EMPTY_CATEGORY',
      'TOTAL_COUNT_CHANGED', 'BOUNDARY_CHANGED', 'RUN_BUDGET_EXCEEDED', 'INTERNAL_ERROR'].includes(failure.code) ? 'INCONCLUSIVE' : 'FAIL';
    await rm(new URL('sale-products.json', output), { force: true });
    await rm(new URL('sale-products.json.tmp', output), { force: true });
    if (failure.partial?.products.length) {
      report.partialFile = 'partial-products.json';
      await writeJson(output, report.partialFile, {
        schemaVersion: 1, scope: 'partial', complete: false, saleId: report.saleId, locale,
        fetchedAt: new Date().toISOString(), sourceUrl: report.sourceUrl, ...failure.partial,
      });
    }
    exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.retryCount = report.requests.filter(request => request.attempt > 1).length;
    await writeJson(output, 'fetch-report.json', report);
    await writeFile(new URL('POC_REPORT.md', output), readableReport(report));
  }
  return { report, exitCode };
}
