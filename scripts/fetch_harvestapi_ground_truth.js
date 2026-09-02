const fs = require('fs');
const https = require('https');
const path = require('path');

// Fetches real-time LinkedIn profile data from HarvestAPI for every unique
// linkedin_url in results/all_linkedin_profiles.csv, so provider claims (title,
// company) can later be checked against live ground truth.
// Confirmed live: GET https://api.harvestapi.io/linkedin/profile?url=<url>,
// auth via X-API-Key header, cost ~0.0064 credits/profile (extremely cheap —
// 1275 profiles ~= 8 credits), concurrency capped by plan (5 on starter,
// confirmed via response.user.requestsConcurrency).
const API_URL = 'https://api.harvestapi.io/linkedin/profile';
const DEFAULT_INPUT = path.join(__dirname, '..', 'results', 'all_linkedin_profiles.csv');
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'results', 'harvestapi_ground_truth.csv');
const DEFAULT_JSON_OUTPUT = path.join(__dirname, '..', 'results', 'harvestapi_full_profiles.json');
const DEFAULT_CACHE = path.join(__dirname, '..', 'cache', 'harvestapi_ground_truth.cache.jsonl');
const DEFAULT_CONCURRENCY = 5; // matches confirmed starter-plan concurrency limit

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    jsonOutput: DEFAULT_JSON_OUTPUT,
    cache: DEFAULT_CACHE,
    concurrency: DEFAULT_CONCURRENCY,
    limit: null,
    offset: 0,
    force: false,
    requireRaw: false,
    apiKeyStdin: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--input' || arg === '-i') {
      args.input = next;
      i += 1;
    } else if (arg === '--output' || arg === '-o') {
      args.output = next;
      i += 1;
    } else if (arg === '--json-output') {
      args.jsonOutput = next;
      i += 1;
    } else if (arg === '--cache') {
      args.cache = next;
      i += 1;
    } else if (arg === '-c' || arg === '--concurrency') {
      args.concurrency = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--limit') {
      args.limit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--offset') {
      args.offset = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--require-raw') {
      args.requireRaw = true;
    } else if (arg === '--api-key-stdin') {
      args.apiKeyStdin = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  HARVESTAPI_KEY=... node fetch_harvestapi_ground_truth.js [options]

Fetches real-time LinkedIn profile ground truth from HarvestAPI for every
unique linkedin_url in the input CSV (default: results/all_linkedin_profiles.csv,
i.e. the deduplicated list from consolidate_linkedin_profiles.js).

Options:
  -i, --input <file>    Input CSV with a linkedin_url column. Default: ../results/all_linkedin_profiles.csv
  -o, --output <file>   Output CSV (flattened summary: current title/company only).
                        Default: ../results/harvestapi_ground_truth.csv
      --json-output <file> Full raw profile JSON, keyed by linkedin_url — includes
                        complete experience history, education, skills, certifications,
                        etc, not just the current-position summary in the CSV.
                        Default: ../results/harvestapi_full_profiles.json
      --cache <file>    JSONL cache for resumable runs (stores both the flattened
                        summary AND the full raw profile). Default: ../cache/harvestapi_ground_truth.cache.jsonl
  -c, --concurrency <n> Concurrent requests. Default: 5 (matches confirmed starter-plan limit —
                        raise only if your HarvestAPI plan supports more).
      --limit <n>       Process only n rows, useful for smoke tests
      --offset <n>      Start after n rows
      --force           Refetch rows even if cache already has data
      --require-raw     Fetch rows whose flattened CSV summary exists but whose
                        complete raw profile is missing from cache/JSON output
      --api-key-stdin   Read HarvestAPI key from the first stdin line

Confirmed live: ~0.0064 credits per profile fetched. No documented per-minute
rate limit — throughput is capped by plan concurrency instead (5 for starter).
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isInteger(args.offset) || args.offset < 0) {
    throw new Error('--offset must be a non-negative integer');
  }

  return args;
}

function readApiKey(args) {
  if (!args.apiKeyStdin) {
    return Promise.resolve(process.env.HARVESTAPI_KEY || '');
  }
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(true);

    const finish = (apiKey) => {
      if (settled) return;
      settled = true;
      stdin.pause();
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(Boolean(wasRaw));
      resolve(apiKey);
    };

    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      text += chunk;
      const newlineIndex = text.indexOf('\n');
      if (newlineIndex !== -1) {
        finish(text.slice(0, newlineIndex).trim());
      }
    });
    stdin.on('end', () => finish(text.trim()));
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      if (next === '\n') continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows
    .slice(1)
    .filter((row) => row.some((value) => value.trim() !== ''))
    .map((row) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = row[index] || '';
      });
      return record;
    });
}

function stringifyCsv(headers, records) {
  const lines = [headers.map(escapeCsvValue).join(',')];
  for (const record of records) {
    lines.push(headers.map((header) => escapeCsvValue(record[header] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function escapeCsvValue(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeLinkedInUrl(raw) {
  let value = String(raw || '').trim().toLowerCase();
  if (!value) return '';

  value = value.replace(/^https?:\/\//, '').replace(/^www\./, '');
  value = value.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  return value;
}

function loadCache(cachePath) {
  const cache = new Map();
  if (!fs.existsSync(cachePath)) return cache;
  const lines = fs.readFileSync(cachePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const key = normalizeLinkedInUrl(entry.linkedinUrl || entry.summary?.linkedin_url);
      if (key) cache.set(key, entry);
    } catch (error) {
      console.warn(`Skipping invalid cache line: ${error.message}`);
    }
  }
  return cache;
}

function appendCache(cachePath, entry) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.appendFileSync(cachePath, `${JSON.stringify(entry)}\n`);
}

function loadExistingSummaries(outputPath) {
  const summaries = new Map();
  if (!fs.existsSync(outputPath)) return summaries;

  for (const summary of readCsv(outputPath)) {
    const key = normalizeLinkedInUrl(summary.linkedin_url);
    if (key && summary.request_status === 'ok') summaries.set(key, summary);
  }
  return summaries;
}

function loadExistingRawProfiles(jsonOutputPath) {
  const profiles = new Map();
  if (!fs.existsSync(jsonOutputPath)) return profiles;

  try {
    const json = JSON.parse(fs.readFileSync(jsonOutputPath, 'utf8'));
    for (const [linkedinUrl, profile] of Object.entries(json)) {
      const key = normalizeLinkedInUrl(linkedinUrl);
      if (key && profile) profiles.set(key, profile);
    }
  } catch (error) {
    console.warn(`Ignoring invalid existing JSON output: ${error.message}`);
  }
  return profiles;
}

function httpRequestJson(url, apiKey, onHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers: { 'X-API-Key': apiKey } }, (res) => {
      let responseText = '';
      res.on('data', (chunk) => {
        responseText += chunk;
      });
      res.on('end', () => {
        onHeaders(res.headers, res.statusCode);
        let parsed;
        try {
          parsed = responseText ? JSON.parse(responseText) : null;
        } catch (_error) {
          reject(new Error(`Invalid JSON response (${res.statusCode}): ${responseText.slice(0, 240)}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = (parsed && (parsed.error?.error || parsed.error || parsed.message)) || responseText.slice(0, 240);
          reject(new Error(`HTTP ${res.statusCode}: ${message}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out after 30s')));
    req.end();
  });
}

async function fetchProfile(apiKey, linkedinUrl, rateLimiter) {
  const url = `${API_URL}?url=${encodeURIComponent(linkedinUrl)}`;
  const parsed = await httpRequestJson(url, apiKey, (h, s) => rateLimiter.observe(h, s));

  const el = parsed?.element || {};
  const current = Array.isArray(el.currentPosition) && el.currentPosition.length > 0 ? el.currentPosition[0] : {};

  const summary = {
    linkedin_url: linkedinUrl,
    resolved_linkedin_url: el.linkedinUrl || '',
    first_name: el.firstName || '',
    last_name: el.lastName || '',
    headline: el.headline || '',
    current_title: current.position || '',
    current_company_name: current.companyName || '',
    current_company_linkedin_url: current.companyLinkedinUrl || '',
    location: el.location?.parsed?.text || el.location?.linkedinText || '',
    cost: parsed?.cost ?? '',
    request_status: 'ok',
    error: '',
  };

  // Full raw profile (experience, education, skills, certifications, etc.) —
  // kept separately for JSON export, since the CSV summary above only covers
  // current position for quick lookups.
  return { summary, raw: el };
}

class RateLimiter {
  constructor({ maxConcurrent }) {
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  observe() {
    // No documented per-minute limit; concurrency is enforced by acquire/release above.
  }
}

async function fetchWithRetries(apiKey, linkedinUrl, rateLimiter, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await rateLimiter.acquire();
    try {
      return await fetchProfile(apiKey, linkedinUrl, rateLimiter);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(750 * attempt);
    } finally {
      rateLimiter.release();
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPool(tasks, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(tasks[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv);
  const records = readCsv(args.input);
  if (records.length === 0 || !('linkedin_url' in records[0])) {
    throw new Error(`Input CSV must contain a linkedin_url column: ${args.input}`);
  }

  const uniqueUrlsByNormalizedUrl = new Map();
  for (const record of records) {
    const url = String(record.linkedin_url || '').trim();
    const normalizedUrl = normalizeLinkedInUrl(url);
    if (normalizedUrl && !uniqueUrlsByNormalizedUrl.has(normalizedUrl)) {
      uniqueUrlsByNormalizedUrl.set(normalizedUrl, url);
    }
  }
  const uniqueUrls = Array.from(uniqueUrlsByNormalizedUrl.values());
  const selected = uniqueUrls.slice(args.offset, args.limit ? args.offset + args.limit : undefined);

  console.log(`Unique LinkedIn URLs in input: ${uniqueUrls.length}`);
  console.log(`Rows selected: ${selected.length}`);

  const cache = loadCache(args.cache);
  const existingSummaries = args.force ? new Map() : loadExistingSummaries(args.output);
  const existingRawProfiles = args.force ? new Map() : loadExistingRawProfiles(args.jsonOutput);
  const results = new Map();
  const tasks = [];
  let cacheHits = 0;
  let csvHits = 0;

  for (const url of selected) {
    const normalizedUrl = normalizeLinkedInUrl(url);
    const cached = cache.get(normalizedUrl);
    const cachedSummary = cached?.summary?.request_status === 'ok'
      ? { ...cached.summary, linkedin_url: url }
      : null;
    const existingSummary = existingSummaries.get(normalizedUrl);
    const existingRaw = existingRawProfiles.get(normalizedUrl) || null;
    const cachedRaw = cached?.raw || existingRaw;

    if (!args.force && cachedSummary && (!args.requireRaw || cachedRaw)) {
      results.set(url, {
        summary: cachedSummary,
        raw: cachedRaw,
      });
      cacheHits += 1;
      continue;
    }

    if (existingSummary && (!args.requireRaw || existingRaw)) {
      results.set(url, {
        summary: { ...existingSummary, linkedin_url: url },
        raw: existingRaw,
      });
      csvHits += 1;
      continue;
    }
    tasks.push({
      url,
      fallbackSummary: cachedSummary || (existingSummary
        ? { ...existingSummary, linkedin_url: url }
        : null),
    });
  }

  console.log(`Rows to call: ${tasks.length} (${cacheHits} from raw cache, ${csvHits} from existing CSV)`);
  console.log(`Concurrency: ${args.concurrency}`);
  console.log(`Require full raw profile: ${args.requireRaw ? 'yes' : 'no'}`);

  let apiKey = '';
  if (tasks.length > 0) {
    apiKey = await readApiKey(args);
    if (!apiKey) {
      throw new Error('Set HARVESTAPI_KEY or pass --api-key-stdin before running this script.');
    }
  }

  const rateLimiter = new RateLimiter({ maxConcurrent: args.concurrency });
  let completed = 0;
  let failed = 0;
  let totalCost = 0;

  await runPool(tasks, args.concurrency, async ({ url, fallbackSummary }) => {
    try {
      const { summary, raw } = await fetchWithRetries(apiKey, url, rateLimiter);
      results.set(url, { summary, raw });
      const entry = { linkedinUrl: url, summary, raw };
      appendCache(args.cache, entry);
      cache.set(normalizeLinkedInUrl(url), entry);
      completed += 1;
      if (typeof summary.cost === 'number') totalCost += summary.cost;
      console.log(`[${completed + failed}/${tasks.length}] ${url} -> ${summary.current_title || '(no title)'} @ ${summary.current_company_name || '(no company)'}`);
    } catch (error) {
      const failureSummary = {
        linkedin_url: url,
        resolved_linkedin_url: '',
        first_name: '',
        last_name: '',
        headline: '',
        current_title: '',
        current_company_name: '',
        current_company_linkedin_url: '',
        location: '',
        cost: '',
        request_status: 'error',
        error: error.message,
      };
      results.set(url, { summary: fallbackSummary || failureSummary, raw: null });
      const entry = { linkedinUrl: url, summary: failureSummary, raw: null };
      appendCache(args.cache, entry);
      cache.set(normalizeLinkedInUrl(url), entry);
      failed += 1;
      console.error(`[${completed + failed}/${tasks.length}] ${url} failed: ${error.message}`);
    }
  });

  const outputHeaders = [
    'linkedin_url',
    'resolved_linkedin_url',
    'first_name',
    'last_name',
    'headline',
    'current_title',
    'current_company_name',
    'current_company_linkedin_url',
    'location',
    'cost',
    'request_status',
    'error',
  ];

  const outputRows = selected.map((url) => results.get(url)?.summary).filter(Boolean);

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, stringifyCsv(outputHeaders, outputRows));

  const jsonOutput = {};
  for (const url of selected) {
    const entry = results.get(url);
    if (entry && entry.raw) jsonOutput[url] = entry.raw;
  }
  fs.mkdirSync(path.dirname(args.jsonOutput), { recursive: true });
  fs.writeFileSync(args.jsonOutput, JSON.stringify(jsonOutput, null, 2));

  console.log('');
  console.log(`Done. Called: ${completed}. Failed: ${failed}.`);
  console.log(`Total cost this run: ~${totalCost.toFixed(4)} credits`);
  console.log(`Wrote: ${args.output}`);
  console.log(`Wrote full profiles (experience, education, etc.): ${args.jsonOutput} (${Object.keys(jsonOutput).length} profiles)`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
