import { appendFile, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchSummary } from '../src/fetch-diagnostics.mjs';

const defaultDirectory = new URL('../artifacts/campaign-management/', import.meta.url);
async function entries(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function writeCampaignSummary({ directory = defaultDirectory, env = process.env } = {}) {
  const operation = ['add', 'edit', 'refetch', 'archive', 'restore'].includes(env.CAMPAIGN_OPERATION)
    ? env.CAMPAIGN_OPERATION : 'unknown';
  const outcome = ['success', 'failure', 'cancelled', 'skipped'].includes(env.CAMPAIGN_OUTCOME)
    ? env.CAMPAIGN_OUTCOME : 'unknown';
  let text = `# 活動操作診斷\n\n操作：${operation}；操作步驟結果：${outcome}。此摘要不代表部署已成功。\n\n`;
  let reportCount = 0;
  for (const run of (await entries(directory)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!run.isDirectory() || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(run.name)) continue;
    const runDirectory = new URL(run.name + '/', directory);
    for (const campaign of await entries(runDirectory)) {
      if (!campaign.isDirectory() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(campaign.name)) continue;
      let report;
      try { report = JSON.parse(await readFile(new URL(`${campaign.name}/fetch-report.json`, runDirectory), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      reportCount++;
      text += `## ${campaign.name}\n\n` + fetchSummary(report) + '\n';
    }
  }
  if (!reportCount) text += outcome === 'success' && ['edit', 'archive', 'restore'].includes(operation)
    ? '本次操作使用已保存資料，未執行商品抓取。\n'
    : '尚未產生抓取報告。請查看操作步驟及先前安裝／離線測試／輸入驗證的日誌。\n';
  if (reportCount) {
    const artifact = /^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
      ? `campaign-operation-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` : 'campaign-operation-<run ID>-<attempt>';
    text += `\n診斷 Artifact：\`${artifact}\`（保留 7 天）；內含 \`fetch-report.json\`、\`POC_REPORT.md\`，失敗且已有有效商品時另有 \`partial-products.json\`。\n`;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') && /^\d+$/.test(env.GITHUB_RUN_ID ?? ''))
      text += `\n[前往本次 Run 的 Artifacts](https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}#artifacts)\n`;
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text);
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await writeCampaignSummary(); console.log('Campaign diagnostic summary generated.'); }
  catch { console.error('CAMPAIGN_SUMMARY_FAILED: inspect the diagnostic artifact and failed step logs.'); process.exitCode = 1; }
}
