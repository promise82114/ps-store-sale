import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCatalog } from '../src/catalog.mjs';
import { loadSavedState } from '../src/campaign-store.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const siteFiles = Object.freeze([
  'index.html', 'app.mjs', 'style.css', '.nojekyll', 'build-info.json',
  'cloud-config.js', 'shared/google-auth.js', 'src/google-login.mjs', 'src/cloud-backup.mjs', 'src/personal-list.mjs',
  'data/catalog.json', 'data/refresh-status.json', 'src/catalog.mjs', 'src/campaigns.mjs',
  ...['personal-data', 'merge', 'sync-state', 'indexeddb-store', 'drive-transport'].map(name => `src/poc04/${name}.mjs`),
]);
export async function buildSite({ projectRoot = root } = {}) {
  const base = await realpath(projectRoot), output = resolve(base, 'artifacts/site');
  // Only this explicitly generated descendant may be replaced; never the source tree.
  const descendant = relative(base, output);
  if (isAbsolute(descendant) || descendant.startsWith('..') || descendant !== ['artifacts', 'site'].join(sep)) throw Error('INVALID_BUILD_DIRECTORY');
  const content = new Map();
  for (const name of siteFiles.filter(name => !['.nojekyll', 'build-info.json'].includes(name)))
    content.set(name, await readFile(resolve(base, ['index.html', 'app.mjs', 'style.css', 'cloud-config.js', 'shared/google-auth.js'].includes(name) ? `web/${name}` : name), 'utf8'));
  const catalog = validateCatalog(JSON.parse(content.get('data/catalog.json')));
  const saved = await loadSavedState(pathToFileURL(resolve(base, 'data') + sep));
  if (JSON.stringify(saved.catalog) !== JSON.stringify(catalog)) throw Error('CATALOG_REBUILD_REQUIRED');
  const refresh = JSON.parse(content.get('data/refresh-status.json'));
  if (refresh.state !== 'success' || !refresh.complete || refresh.uniqueProductCount !== catalog.uniqueProductCount)
    throw Error('INVALID_PUBLISHED_SNAPSHOT');
  const hash = createHash('sha256');
  for (const [name, value] of content) hash.update(name).update(value);
  const version = hash.digest('hex').slice(0, 16);
  content.set('index.html', content.get('index.html')
    .replace('href="./style.css"', `href="./style.css?v=${version}"`)
    .replace('src="./app.mjs"', `src="./app.mjs?v=${version}"`)
    .replace('src="./cloud-config.js"', `src="./cloud-config.js?v=${version}"`)
    .replace('src="./shared/google-auth.js"', `src="./shared/google-auth.js?v=${version}"`));
  for (const [name, value] of content) if (name.endsWith('.mjs'))
    content.set(name, value.replace(/(from\s+['"])(\.[^'"]+\.mjs)(['"])/g, `$1$2?v=${version}$3`));
  content.set('.nojekyll', '');
  content.set('build-info.json', JSON.stringify({ version, builtAt: new Date().toISOString(),
    catalogFetchedAt: catalog.fetchedAt, uniqueProductCount: catalog.uniqueProductCount }));
  // Validate all inputs before replacing the generated output; no private test files are copied.
  await mkdir(resolve(base, 'artifacts'), { recursive: true });
  if (await realpath(resolve(base, 'artifacts')) !== resolve(base, 'artifacts')) throw Error('INVALID_BUILD_DIRECTORY');
  await rm(output, { recursive: true, force: true });
  for (const [name, value] of content) {
    const target = resolve(output, name); await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, value);
  }
  return { directory: output, version, files: [...content.keys()], products: catalog.uniqueProductCount };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await buildSite(), null, 2));
