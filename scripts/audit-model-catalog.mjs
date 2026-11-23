import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = process.cwd();
const found = new Map();
const failures = [];

function labelCount(model) {
  // Only repository labels; never infer trained parameters from model-file bytes.
  for (const value of [model.name, model.description, model.modelType, model.id]) {
    if (typeof value !== 'string') continue;
    const match = value.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*B\b/i);
    if (match) return match[1] + 'B (repository label; not independently verified)';
  }
  return null;
}

function inspect(node, source, mode, depth = 0, seen = new WeakSet()) {
  if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return;
  seen.add(node);
  if (typeof node.id === 'string' && (node.name || node.inputs || node.modelType)) {
    let row = found.get(node.id);
    if (!row) {
      row = { id: node.id, name: String(node.name || node.id), providers: new Set(),
        sources: new Set(), modes: new Set(), fields: new Set(), hasSchema: false,
        counts: new Set() };
      found.set(node.id, row);
    }
    row.sources.add(source);
    row.modes.add(mode === 'LOCAL_MODEL_CATALOG' ? 'local:' + (node.type || 'unknown') : mode);
    if (node.provider_name || node.provider) row.providers.add(node.provider_name || node.provider);
    if (node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs)) {
      row.hasSchema = true;
      for (const key of Object.keys(node.inputs)) row.fields.add(key);
    }
    const claim = labelCount(node);
    if (claim) row.counts.add(claim + ' [' + source + ']');
    return;
  }
  if (Array.isArray(node)) {
    for (const value of node) inspect(value, source, mode, depth + 1, seen);
  } else {
    for (const [key, value] of Object.entries(node)) {
      if (!['inputs', 'examples', 'schema'].includes(key)) {
        inspect(value, source, mode === 'all' ? key : mode, depth + 1, seen);
      }
    }
  }
}

async function readSource(source, load, expectedModels = false) {
  try {
    const before = found.size;
    const data = await load();
    for (const [key, value] of Object.entries(data)) inspect(value, source, key);
    if (expectedModels && found.size === before) throw new Error('No model IDs discovered');
  } catch (error) {
    failures.push({ source, error: String(error.message || error) });
    process.exitCode = 1;
  }
}

const importFile = file => import(pathToFileURL(resolve(root, file)).href);
await readSource('packages/studio/src/models.js', () => importFile('packages/studio/src/models.js'), true);
await readSource('models_dump.json', async () => JSON.parse(await readFile('models_dump.json', 'utf8')));
await readSource('src/lib/localModels.js', () => importFile('src/lib/localModels.js'));
await readSource('electron/lib/modelCatalog.js', async () => require(resolve(root, 'electron/lib/modelCatalog.js')));
await readSource('electron/lib/wan2gpCatalog.js', async () => require(resolve(root, 'electron/lib/wan2gpCatalog.js')));

const models = [...found.values()].map(row => ({
  id: row.id, name: row.name, providers: [...row.providers].sort(),
  sources: [...row.sources].sort(), modes: [...row.modes].sort(),
  apiInputFieldCount: row.hasSchema ? row.fields.size : null,
  apiInputFields: [...row.fields].sort(), trainedParameters: [...row.counts].sort(),
})).sort((a, b) => a.id.localeCompare(b.id));
const output = resolve(root, 'artifacts/model-audit');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'all-models.json'), JSON.stringify({ count: models.length, failures, models }, null, 2) + '\n');

const cols = ['id', 'name', 'providers', 'modes', 'sources', 'apiInputFieldCount', 'apiInputFields', 'trainedParameters'];
const cell = x => '"' + String(x ?? '').replaceAll('"', '""') + '"';
const csv = [cols.map(cell).join(',')].concat(models.map(model =>
  cols.map(key => cell(Array.isArray(model[key]) ? model[key].join('; ') : model[key])).join(',')
)).join('\n') + '\n';
await writeFile(resolve(output, 'all-models.csv'), csv);
const byMode = {};
for (const model of models) for (const mode of model.modes) byMode[mode] = (byMode[mode] || 0) + 1;
const labelled = models.filter(model => model.trainedParameters.length).length;
const markdown = [
  '# AI models discovered from the checked-in registries',
  '',
  'Unique IDs: **' + models.length + '**; repository-labelled parameter counts: **' + labelled + '**.',
  '',
  'A model parameter count is learned-weight size, not the number of API input fields. Repo labels are not externally verified. A dash in input-field count means no structured inputs schema was provided. Registered hosted models are not downloaded or run by this check.',
  '',
  '## Models by exported mode / source type',
  ...Object.entries(byMode).sort((a, b) => a[0].localeCompare(b[0])).map(([key, count]) => '- ' + key + ': ' + count),
  '',
  '## Full inventory',
  '',
  '| ID | Provider | Modes | API fields | Trained parameters (repository claims only) |',
  '| --- | --- | --- | ---: | --- |',
  ...models.map(model => '| ' + model.id + ' | ' + (model.providers.join(', ') || '—') +
    ' | ' + model.modes.join(', ') + ' | ' + (model.apiInputFieldCount ?? '—') +
    ' | ' + (model.trainedParameters.join('; ') || 'Not disclosed') + ' |'),
  '',
  ...failures.map(failure => 'ERROR reading ' + failure.source + ': ' + failure.error),
  '',
].join('\n');
await writeFile(resolve(output, 'all-models.md'), markdown);

const report = 'Found ' + models.length + ' unique models; ' + labelled +
  ' have unverified size labels; source errors: ' + failures.length;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '## Model inventory\n\n' + report +
    '\n\nDownload the model-audit artifact for a complete row-by-row CSV, JSON and Markdown report.\n\n' +
    Object.entries(byMode).map(([key, count]) => '- ' + key + ': ' + count).join('\n') + '\n');
}
