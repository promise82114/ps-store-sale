import { mkdir, writeFile, rename } from 'node:fs/promises';
import { validateCatalog } from './catalog.mjs';

// Called only after every activity passed full validation. Failure never writes data/.
export async function publishSnapshot(catalog, status, output = new URL('../data/', import.meta.url)) {
  validateCatalog(catalog);
  if (status?.state !== 'success' || status.complete !== true
    || status.uniqueProductCount !== catalog.uniqueProductCount
    || status.reports?.length !== catalog.campaigns.length
    || catalog.campaigns.some(campaign => status.reports.filter(report => report.saleId === campaign.id
      && report.complete === true && report.fullValidation === 'PASS' && !report.error).length !== 1))
    throw Error('INCOMPLETE_REFRESH');
  await mkdir(output, { recursive: true });
  for (const [name, value] of [['catalog.json', catalog], ['refresh-status.json', status]]) {
    await writeFile(new URL(name + '.tmp', output), JSON.stringify(value) + '\n');
    await rename(new URL(name + '.tmp', output), new URL(name, output));
  }
}
