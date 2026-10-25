import { manageCampaign } from './campaign-store.mjs';
import { appendFile } from 'node:fs/promises';
try {
  const result = await manageCampaign({ operation: process.env.CAMPAIGN_OPERATION,
    id: process.env.CAMPAIGN_ID, name: process.env.CAMPAIGN_NAME,
    startsAt: process.env.CAMPAIGN_START, endsAt: process.env.CAMPAIGN_END });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `campaign_id=${result.id}\n`);
} catch (error) {
  console.error(JSON.stringify({ success: false, code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'CAMPAIGN_OPERATION_FAILED' }));
  process.exitCode = 1;
}
