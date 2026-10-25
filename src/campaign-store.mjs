import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { buildCatalog, validateCatalog } from './catalog.mjs';
import { campaignById, parseCampaignId, taiwanDateTime, validateCampaign, validateRegistry } from './campaigns.mjs';
import { runDiagnostic } from './runner.mjs';

export const defaultDataDirectory = new URL('../data/', import.meta.url);
const jsonFile = async url => JSON.parse(await readFile(url, 'utf8'));
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const sourcePath = id => `campaign-snapshots/${id}.json`;
async function writeFiles(directory, files) {
  // All data is validated before writing. A failed fetch never reaches this phase.
  for (const [name, value] of files) {
    const url = new URL(name + '.tmp', directory);
    await mkdir(new URL('./', url), { recursive: true });
    await writeFile(url, JSON.stringify(value) + '\n');
  }
  for (const [name] of files) await rename(new URL(name + '.tmp', directory), new URL(name, directory));
}
export async function loadSavedState(directory = defaultDataDirectory) {
  const registry = validateRegistry(await jsonFile(new URL('campaigns.json', directory)));
  const sources = await Promise.all(registry.campaigns.map(campaign => jsonFile(new URL(sourcePath(campaign.id), directory))));
  const catalog = validateCatalog(buildCatalog(sources, registry.campaigns));
  return { registry, sources, catalog };
}
function savedStatus(catalog, operation) {
  return { state: 'success', complete: true, mode: 'saved-campaigns',
    updatedAt: new Date().toISOString(), operation,
    uniqueProductCount: catalog.uniqueProductCount, membershipCount: catalog.membershipCount,
    reports: catalog.campaigns.map(campaign => ({ saleId: campaign.id, complete: true,
      fullValidation: 'PASS', fetchedAt: campaign.fetchedAt, error: null })) };
}
export async function rebuildSavedCatalog({ directory = defaultDataDirectory } = {}) {
  const saved = await loadSavedState(directory);
  const status = savedStatus(saved.catalog, 'rebuild');
  await writeFiles(directory, [['catalog.json', saved.catalog], ['refresh-status.json', status]]);
  return { ...saved, status };
}
export async function manageCampaign({ operation, id: input, name = '', startsAt = '', endsAt = '',
  directory = defaultDataDirectory, run = runDiagnostic,
  artifacts = new URL('../artifacts/campaign-management/', import.meta.url) } = {}) {
  if (!['add', 'edit', 'refetch', 'archive', 'restore'].includes(operation)) fail('INVALID_OPERATION');
  const id = parseCampaignId(input), saved = await loadSavedState(directory);
  const index = saved.registry.campaigns.findIndex(campaign => campaign.id === id);
  if (operation === 'add' && index !== -1) fail('CAMPAIGN_ALREADY_EXISTS');
  if (operation !== 'add' && index === -1) fail('CAMPAIGN_NOT_FOUND');
  const previous = saved.registry.campaigns[index];
  let selected;
  if (operation === 'add' || operation === 'edit') {
    if (operation === 'add' && (!name.trim() || !startsAt || !endsAt)) fail('CAMPAIGN_FIELDS_REQUIRED');
    if (operation === 'edit' && !name && !startsAt && !endsAt) fail('NO_METADATA_CHANGE');
    selected = validateCampaign({ ...(previous ?? campaignById(id)),
      label: name ? name.trim() : previous.label,
      startsAt: startsAt ? taiwanDateTime(startsAt) : previous?.startsAt ?? null,
      endsAt: endsAt ? taiwanDateTime(endsAt) : previous?.endsAt ?? null });
  } else {
    if (name || startsAt || endsAt) fail('METADATA_NOT_APPLICABLE');
    selected = { ...previous, enabled: operation === 'archive' ? false : operation === 'restore' ? true : previous.enabled };
  }
  const campaigns = saved.registry.campaigns.map(campaign => campaign.id === id ? selected : campaign);
  if (index === -1) campaigns.push(selected);
  const registry = validateRegistry({ schemaVersion: 1, campaigns });
  let replacement;
  if (operation === 'add' || operation === 'refetch') {
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const output = new URL(`${runId}/${id}/`, artifacts);
    const result = await run({ campaign: selected, args: ['--mode', 'full', '--sale-url', selected.sourceUrl], output });
    if (result.exitCode !== 0 || !result.report?.complete || result.report.fullValidation !== 'PASS')
      fail(/^[A-Z0-9_]+$/.test(result.report?.error?.code ?? '') ? result.report.error.code : 'CAMPAIGN_FETCH_FAILED');
    const raw = await jsonFile(new URL('sale-products.json', output));
    // A durable complete product snapshot; large raw media remains in the diagnostic artifact.
    replacement = { ...raw, products: raw.products?.map(({ media, ...product }) => product) };
  }
  const sources = saved.sources.filter(source => source.saleId !== id);
  sources.push(replacement ?? saved.sources[index]);
  const catalog = validateCatalog(buildCatalog(sources, registry.campaigns));
  const status = savedStatus(catalog, operation);
  const files = [...(replacement ? [[sourcePath(id), replacement]] : []),
    ['campaigns.json', registry], ['catalog.json', catalog], ['refresh-status.json', status]];
  await writeFiles(directory, files);
  return { operation, id, fetched: !!replacement, registeredCount: registry.campaigns.length,
    uniqueProductCount: catalog.uniqueProductCount };
}
