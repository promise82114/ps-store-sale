import { runDiagnostic } from './runner.mjs';

const { report, exitCode } = await runDiagnostic();
console.log(`Environment: ${report.environmentCheck}; first page: ${report.firstPageValidation}; full: ${report.fullValidation}; conclusion: ${report.conclusion}`);
if (report.error) console.error(`Failure: ${report.error.code}; stage: ${report.error.stage}; HTTP: ${report.error.httpStatus ?? 'n/a'}`);
process.exitCode = exitCode;
