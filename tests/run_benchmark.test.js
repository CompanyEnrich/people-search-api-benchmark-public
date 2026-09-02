'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { main: consolidateProfiles } = require('../scripts/consolidate_linkedin_profiles');
const {
  PROVIDERS,
  buildPipeline,
  formatCommand,
  parseArgs,
  parseEnvFile,
  requiredApiKeys,
  timestampForPath,
} = require('../scripts/run_benchmark');

const PROJECT_ROOT = path.join(__dirname, '..');

test('creates stable timestamped defaults for all seven providers', () => {
  const now = new Date('2026-09-02T09:10:11.123Z');
  const args = parseArgs(['node', 'run_benchmark.js'], now);

  assert.equal(timestampForPath(now), '2026-09-02_091011Z');
  assert.equal(args.runDir, path.join(PROJECT_ROOT, 'runs', '2026-09-02_091011Z'));
  assert.deepEqual(args.providers, PROVIDERS.map((provider) => provider.name));
  assert.equal(args.from, 'providers');
  assert.equal(args.limit, null);
  assert.equal(args.force, false);
});

test('builds an auditable subset pipeline with smoke and force flags', () => {
  const args = parseArgs([
    'node',
    'run_benchmark.js',
    '--run-dir',
    'runs/fixture-run',
    '--provider',
    'companyenrich',
    '--provider',
    'apollo',
    '--provider',
    'apollo',
    '--limit',
    '3',
    '--force',
  ]);
  const pipeline = buildPipeline(args);

  assert.deepEqual(args.providers, ['companyenrich', 'apollo']);
  assert.deepEqual(pipeline.map((step) => step.stage), [
    'providers',
    'providers',
    'consolidate',
    'harvest',
    'compare',
  ]);
  assert.deepEqual(pipeline.map((step) => step.label), [
    'Search companyenrich',
    'Search apollo',
    'Consolidate provider candidates',
    'Refresh HarvestAPI ground truth',
    'Generate comparison',
  ]);

  for (const providerStep of pipeline.filter((step) => step.stage === 'providers')) {
    assert.equal(providerStep.command.includes('--limit'), true);
    assert.equal(providerStep.command.includes('3'), true);
    assert.equal(providerStep.command.includes('--force'), true);
  }

  const consolidate = pipeline.find((step) => step.stage === 'consolidate');
  assert.equal(formatCommand(consolidate.command).includes('--provider companyenrich'), true);
  assert.equal(formatCommand(consolidate.command).includes('--provider apollo'), true);

  const harvest = pipeline.find((step) => step.stage === 'harvest');
  assert.equal(harvest.command.includes('--limit'), true);
  assert.equal(harvest.command.includes('--force'), true);

  const compare = pipeline.find((step) => step.stage === 'compare');
  assert.equal(formatCommand(compare.command).includes('--provider companyenrich'), true);
  assert.equal(formatCommand(compare.command).includes('--provider apollo'), true);

  assert.deepEqual(requiredApiKeys(args), [
    'COMPANYENRICH_API_KEY',
    'APOLLO_API_KEY',
    'HARVESTAPI_KEY',
  ]);
});

test('resume stages skip completed commands and no longer require their keys', () => {
  const harvestArgs = parseArgs([
    'node',
    'run_benchmark.js',
    '--run-dir',
    'runs/resume-harvest',
    '--provider',
    'pdl',
    '--from',
    'harvest',
  ]);
  assert.deepEqual(buildPipeline(harvestArgs).map((step) => step.stage), ['harvest', 'compare']);
  assert.deepEqual(requiredApiKeys(harvestArgs), ['HARVESTAPI_KEY']);

  const compareArgs = parseArgs([
    'node',
    'run_benchmark.js',
    '--run-dir',
    'runs/resume-compare',
    '--provider',
    'pdl',
    '--from',
    'compare',
  ]);
  assert.deepEqual(buildPipeline(compareArgs).map((step) => step.stage), ['compare']);
  assert.deepEqual(requiredApiKeys(compareArgs), []);
});

test('rejects unknown providers, invalid stages, and unsafe run directories', () => {
  assert.throws(
    () => parseArgs(['node', 'run_benchmark.js', '--provider', 'blitz']),
    /Unknown provider\(s\): blitz/,
  );
  assert.throws(
    () => parseArgs(['node', 'run_benchmark.js', '--from', 'publish']),
    /--from must be one of/,
  );
  assert.throws(
    () => parseArgs(['node', 'run_benchmark.js', '--run-dir', '.']),
    /--run-dir must be a child of runs\//,
  );
});

test('parses a local env file without exposing or expanding key values', () => {
  assert.deepEqual(parseEnvFile([
    '# benchmark keys',
    'COMPANYENRICH_API_KEY=plain-value',
    'export APOLLO_API_KEY="quoted # value"',
    "PDL_API_KEY='literal-value'",
    'HARVESTAPI_KEY=harvest-value # local note',
    'INVALID LINE',
    '',
  ].join('\n')), {
    COMPANYENRICH_API_KEY: 'plain-value',
    APOLLO_API_KEY: 'quoted # value',
    PDL_API_KEY: 'literal-value',
    HARVESTAPI_KEY: 'harvest-value',
  });
});

test('CLI dry-run performs no writes and makes no API calls', () => {
  const runName = `dry-run-test-${process.pid}-${Date.now()}`;
  const runDir = path.join(PROJECT_ROOT, 'runs', runName);
  assert.equal(fs.existsSync(runDir), false);

  const result = spawnSync(process.execPath, [
    path.join(PROJECT_ROOT, 'scripts', 'run_benchmark.js'),
    '--run-dir', runDir,
    '--provider', 'companyenrich',
    '--no-env-file',
    '--dry-run',
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing API keys: COMPANYENRICH_API_KEY, HARVESTAPI_KEY/);
  assert.match(result.stdout, /Dry run complete\. No files were written and no API calls were made\./);
  assert.equal(fs.existsSync(runDir), false);
});

test('selected-provider consolidation excludes unselected result files', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-consolidation-test-'));
  const output = path.join(temporaryRoot, 'all_linkedin_profiles.csv');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  fs.writeFileSync(path.join(temporaryRoot, 'companyenrich_people_search_benchmark.csv'), [
    'domain,provider,linkedin_profiles',
    'acme.test,companyenrich,https://www.linkedin.com/in/alice',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(temporaryRoot, 'apollo_people_search_benchmark.csv'), [
    'domain,provider,linkedin_profiles',
    'beta.test,apollo,https://www.linkedin.com/in/bob',
    '',
  ].join('\n'));

  const originalConsoleLog = console.log;
  try {
    console.log = () => {};
    consolidateProfiles([
      'node',
      'consolidate_linkedin_profiles.js',
      '--input-dir', temporaryRoot,
      '--output', output,
      '--provider', 'companyenrich',
    ]);
  } finally {
    console.log = originalConsoleLog;
  }

  const consolidated = fs.readFileSync(output, 'utf8');
  assert.match(consolidated, /https:\/\/www\.linkedin\.com\/in\/alice/);
  assert.doesNotMatch(consolidated, /linkedin\.com\/in\/bob/);
});
