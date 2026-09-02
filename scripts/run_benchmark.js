#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNS_ROOT = path.join(PROJECT_ROOT, 'runs');
const DEFAULT_COHORT = path.join(PROJECT_ROOT, 'data', 'YC_Active_Companies_With_LinkedIn.csv');
const DEFAULT_ENV_FILE = path.join(PROJECT_ROOT, '.env');
const STAGES = Object.freeze(['providers', 'consolidate', 'harvest', 'compare']);
const PROVIDERS = Object.freeze([
  {
    name: 'companyenrich',
    script: 'benchmark_companyenrich_people_search.js',
    apiKey: 'COMPANYENRICH_API_KEY',
  },
  {
    name: 'crustdata',
    script: 'benchmark_crustdata_people_search.js',
    apiKey: 'CRUSTDATA_API_KEY',
  },
  {
    name: 'fullenrich',
    script: 'benchmark_fullenrich_people_search.js',
    apiKey: 'FULLENRICH_API_KEY',
  },
  {
    name: 'apollo',
    script: 'benchmark_apollo_people_search.js',
    apiKey: 'APOLLO_API_KEY',
  },
  {
    name: 'pdl',
    script: 'benchmark_pdl_people_search.js',
    apiKey: 'PDL_API_KEY',
  },
  {
    name: 'coresignal',
    script: 'benchmark_coresignal_people_search.js',
    apiKey: 'CORESIGNAL_API_KEY',
  },
  {
    name: 'prospeo',
    script: 'benchmark_prospeo_people_search.js',
    apiKey: 'PROSPEO_API_KEY',
  },
]);
const PROVIDER_BY_NAME = new Map(PROVIDERS.map((provider) => [provider.name, provider]));

function timestampForPath(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '').replace('T', '_');
}

function requireValue(argument, value) {
  if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
  return value;
}

function parseArgs(argv, now = new Date()) {
  const args = {
    cohort: DEFAULT_COHORT,
    runDir: path.join(RUNS_ROOT, timestampForPath(now)),
    providers: [],
    limit: null,
    force: false,
    dryRun: false,
    from: 'providers',
    envFile: DEFAULT_ENV_FILE,
    useEnvFile: true,
    help: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--cohort') {
      args.cohort = path.resolve(requireValue(argument, next));
      index += 1;
    } else if (argument === '--run-dir') {
      args.runDir = path.resolve(requireValue(argument, next));
      index += 1;
    } else if (argument === '--provider') {
      args.providers.push(requireValue(argument, next).trim().toLowerCase());
      index += 1;
    } else if (argument === '--limit') {
      args.limit = Number.parseInt(requireValue(argument, next), 10);
      index += 1;
    } else if (argument === '--from') {
      args.from = requireValue(argument, next).trim().toLowerCase();
      index += 1;
    } else if (argument === '--env-file') {
      args.envFile = path.resolve(requireValue(argument, next));
      args.useEnvFile = true;
      index += 1;
    } else if (argument === '--no-env-file') {
      args.useEnvFile = false;
    } else if (argument === '--force') {
      args.force = true;
    } else if (argument === '--dry-run') {
      args.dryRun = true;
    } else if (argument === '--help' || argument === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }
  if (!STAGES.includes(args.from)) {
    throw new Error(`--from must be one of: ${STAGES.join(', ')}.`);
  }

  args.providers = args.providers.length > 0
    ? [...new Set(args.providers)]
    : PROVIDERS.map((provider) => provider.name);
  const unknownProviders = args.providers.filter((provider) => !PROVIDER_BY_NAME.has(provider));
  if (unknownProviders.length > 0) {
    throw new Error(`Unknown provider(s): ${unknownProviders.join(', ')}.`);
  }

  const relativeRunDir = path.relative(RUNS_ROOT, args.runDir);
  if (!relativeRunDir || relativeRunDir.startsWith('..') || path.isAbsolute(relativeRunDir)) {
    throw new Error(`--run-dir must be a child of ${path.relative(PROJECT_ROOT, RUNS_ROOT)}/.`);
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  npm run benchmark -- [options]

Runs the complete people-search benchmark in order: provider searches,
candidate consolidation, HarvestAPI refresh, and comparison generation.

Options:
  --run-dir <dir>       Run directory beneath runs/. A timestamped directory is
                        created by default. Reuse a directory to resume.
  --cohort <csv>        Cohort to freeze into the run. Default: data/YC_Active_Companies_With_LinkedIn.csv
  --provider <name>     Run one provider; repeat to select several. Default: all seven
  --limit <n>           Limit every provider and Harvest step for a smoke run
  --from <stage>        Resume at providers, consolidate, harvest, or compare
  --env-file <file>     API-key file. Default: .env when present
  --no-env-file         Read API keys only from the process environment
  --force               Bypass runner caches and refetch; this can rebill API calls
  --dry-run             Print paths, missing keys, and commands without writing or calling APIs
  -h, --help            Show this help

Providers:
  ${PROVIDERS.map((provider) => provider.name).join(', ')}
`);
}

function parseEnvFile(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[key] = value;
  }
  return values;
}

function loadEnvFile(filePath, environment) {
  if (!fs.existsSync(filePath)) return false;
  const values = parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (environment[key] === undefined) environment[key] = value;
  }
  return true;
}

function commandForScript(scriptName, scriptArgs) {
  return [process.execPath, path.join(PROJECT_ROOT, 'scripts', scriptName), ...scriptArgs];
}

function buildPipeline(args) {
  const cohort = path.join(args.runDir, 'cohort.csv');
  const resultsDir = path.join(args.runDir, 'results');
  const cacheDir = path.join(args.runDir, 'cache');
  const comparisonDir = path.join(args.runDir, 'comparison');
  const startIndex = STAGES.indexOf(args.from);
  const steps = [];

  if (startIndex <= STAGES.indexOf('providers')) {
    for (const providerName of args.providers) {
      const provider = PROVIDER_BY_NAME.get(providerName);
      const scriptArgs = [
        '--input', cohort,
        '--output', path.join(resultsDir, `${provider.name}_people_search_benchmark.csv`),
        '--cache', path.join(cacheDir, `${provider.name}.jsonl`),
      ];
      if (args.limit !== null) scriptArgs.push('--limit', String(args.limit));
      if (args.force) scriptArgs.push('--force');
      steps.push({
        stage: 'providers',
        label: `Search ${provider.name}`,
        command: commandForScript(provider.script, scriptArgs),
      });
    }
  }

  if (startIndex <= STAGES.indexOf('consolidate')) {
    const scriptArgs = [
      '--input-dir', resultsDir,
      '--output', path.join(resultsDir, 'all_linkedin_profiles.csv'),
    ];
    for (const providerName of args.providers) scriptArgs.push('--provider', providerName);
    steps.push({
      stage: 'consolidate',
      label: 'Consolidate provider candidates',
      command: commandForScript('consolidate_linkedin_profiles.js', scriptArgs),
    });
  }

  if (startIndex <= STAGES.indexOf('harvest')) {
    const scriptArgs = [
      '--input', path.join(resultsDir, 'all_linkedin_profiles.csv'),
      '--output', path.join(resultsDir, 'harvestapi_ground_truth.csv'),
      '--json-output', path.join(resultsDir, 'harvestapi_full_profiles.json'),
      '--cache', path.join(cacheDir, 'harvestapi.jsonl'),
    ];
    if (args.limit !== null) scriptArgs.push('--limit', String(args.limit));
    if (args.force) scriptArgs.push('--force');
    steps.push({
      stage: 'harvest',
      label: 'Refresh HarvestAPI ground truth',
      command: commandForScript('fetch_harvestapi_ground_truth.js', scriptArgs),
    });
  }

  if (startIndex <= STAGES.indexOf('compare')) {
    const scriptArgs = [
      '--cohort', cohort,
      '--results-dir', resultsDir,
      '--harvest', path.join(resultsDir, 'harvestapi_full_profiles.json'),
      '--output-dir', comparisonDir,
    ];
    for (const providerName of args.providers) scriptArgs.push('--provider', providerName);
    steps.push({
      stage: 'compare',
      label: 'Generate comparison',
      command: commandForScript('compare_people_search_with_harvest.js', scriptArgs),
    });
  }

  return steps;
}

function requiredApiKeys(args) {
  const startIndex = STAGES.indexOf(args.from);
  const keys = [];
  if (startIndex <= STAGES.indexOf('providers')) {
    for (const providerName of args.providers) keys.push(PROVIDER_BY_NAME.get(providerName).apiKey);
  }
  if (startIndex <= STAGES.indexOf('harvest')) keys.push('HARVESTAPI_KEY');
  return keys;
}

function shellQuote(value) {
  const stringValue = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(stringValue)) return stringValue;
  return `'${stringValue.replace(/'/g, `'"'"'`)}'`;
}

function formatCommand(command) {
  return ['node', ...command.slice(1)].map(shellQuote).join(' ');
}

function prepareRun(args) {
  if (!fs.existsSync(args.cohort)) throw new Error(`Cohort does not exist: ${args.cohort}`);
  fs.mkdirSync(path.join(args.runDir, 'results'), { recursive: true });
  fs.mkdirSync(path.join(args.runDir, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(args.runDir, 'comparison'), { recursive: true });

  const frozenCohort = path.join(args.runDir, 'cohort.csv');
  if (!fs.existsSync(frozenCohort)) fs.copyFileSync(args.cohort, frozenCohort);

  const commitPath = path.join(args.runDir, 'git_commit.txt');
  if (!fs.existsSync(commitPath)) {
    const gitResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    const commit = gitResult.status === 0 ? gitResult.stdout.trim() : 'unknown';
    fs.writeFileSync(commitPath, `${commit}\n`);
  }

  const manifestPath = path.join(args.runDir, 'run_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    const manifest = {
      created_at: new Date().toISOString(),
      cohort_source: path.relative(PROJECT_ROOT, args.cohort),
      providers: args.providers,
      initial_limit: args.limit,
      initial_stage: args.from,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function executeStep(step, environment) {
  console.log(`\n==> ${step.label}`);
  console.log(formatCommand(step.command));
  const result = spawnSync(step.command[0], step.command.slice(1), {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${step.label} terminated by ${result.signal}.`);
  if (result.status !== 0) throw new Error(`${step.label} failed with exit code ${result.status}.`);
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return null;
  }

  const environment = { ...process.env };
  const loadedEnvFile = args.useEnvFile ? loadEnvFile(args.envFile, environment) : false;
  const pipeline = buildPipeline(args);
  const missingKeys = requiredApiKeys(args).filter((key) => !environment[key]);

  console.log(`Run directory: ${path.relative(PROJECT_ROOT, args.runDir)}`);
  console.log(`Providers: ${args.providers.join(', ')}`);
  console.log(`Starting stage: ${args.from}`);
  if (args.limit !== null) console.log(`Smoke limit: ${args.limit}`);
  if (loadedEnvFile) console.log(`API keys: loaded from ${path.relative(PROJECT_ROOT, args.envFile)}`);
  if (missingKeys.length > 0) console.log(`Missing API keys: ${missingKeys.join(', ')}`);
  if (args.force) console.log('Warning: --force bypasses caches and can rebill API calls.');

  console.log('\nCommand plan:');
  pipeline.forEach((step, index) => console.log(`${index + 1}. ${step.label}\n   ${formatCommand(step.command)}`));

  if (args.dryRun) {
    console.log('\nDry run complete. No files were written and no API calls were made.');
    return { args, pipeline, missingKeys };
  }
  if (missingKeys.length > 0) {
    throw new Error(`Set the missing API keys in .env or the process environment: ${missingKeys.join(', ')}`);
  }

  prepareRun(args);
  for (const step of pipeline) executeStep(step, environment);

  console.log(`\nBenchmark complete: ${path.relative(PROJECT_ROOT, args.runDir)}`);
  console.log(`Report: ${path.relative(PROJECT_ROOT, path.join(args.runDir, 'comparison', 'report.md'))}`);
  return { args, pipeline, missingKeys };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = {
  PROVIDERS,
  STAGES,
  buildPipeline,
  formatCommand,
  main,
  parseArgs,
  parseEnvFile,
  requiredApiKeys,
  timestampForPath,
};
