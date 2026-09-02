const fs = require('fs');
const https = require('https');
const path = require('path');

const API_URL = 'https://api.prospeo.io/search-person';
const DEFAULT_PROVIDER = 'prospeo';
const DEFAULT_AUTH_HEADER = 'X-KEY';
const DEFAULT_JOB_TITLES = ['ceo', 'chief executive', 'founder'];
const RESULTS_PER_CREDIT = 25;
// Prospeo search-person rate limits (per their dashboard): 2 req/s, 60 req/min, 4000 req/day.
const DEFAULT_RPS = 2;
const DEFAULT_RPM = 60;
const DEFAULT_RPD = 4000;

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, '..', 'data', 'YC_Active_Companies_With_LinkedIn.csv'),
    output: path.join(__dirname, '..', 'results', 'prospeo_people_search_benchmark.csv'),
    cache: null,
    provider: DEFAULT_PROVIDER,
    jobTitles: DEFAULT_JOB_TITLES,
    matchMode: 'CONTAINS',
    smartIntensity: 'LOOSE',
    page: 1,
    authHeader: DEFAULT_AUTH_HEADER,
    concurrency: 5,
    rps: DEFAULT_RPS,
    rpm: DEFAULT_RPM,
    rpd: DEFAULT_RPD,
    limit: null,
    offset: 0,
    force: false,
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
    } else if (arg === '--cache') {
      args.cache = next;
      i += 1;
    } else if (arg === '--provider') {
      args.provider = next;
      i += 1;
    } else if (arg === '--job-titles') {
      args.jobTitles = next.split(',').map((title) => title.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--match-mode') {
      args.matchMode = next;
      i += 1;
    } else if (arg === '--smart-intensity') {
      args.smartIntensity = next;
      i += 1;
    } else if (arg === '--page') {
      args.page = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--auth-header') {
      args.authHeader = next;
      i += 1;
    } else if (arg === '-c' || arg === '--concurrency') {
      args.concurrency = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--rps') {
      args.rps = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--rpm') {
      args.rpm = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--rpd') {
      args.rpd = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--limit') {
      args.limit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--offset') {
      args.offset = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--api-key-stdin') {
      args.apiKeyStdin = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.jobTitles.length === 0) {
    throw new Error('--job-titles must include at least one title');
  }
  if (!Number.isInteger(args.page) || args.page < 1) {
    throw new Error('--page must be a positive integer');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  if (!Number.isInteger(args.rps) || args.rps < 1) {
    throw new Error('--rps must be a positive integer');
  }
  if (!Number.isInteger(args.rpm) || args.rpm < 1) {
    throw new Error('--rpm must be a positive integer');
  }
  if (!Number.isInteger(args.rpd) || args.rpd < 1) {
    throw new Error('--rpd must be a positive integer');
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isInteger(args.offset) || args.offset < 0) {
    throw new Error('--offset must be a non-negative integer');
  }

  args.cache = args.cache || path.join(__dirname, '..', 'cache', `${path.basename(args.output)}.cache.jsonl`);
  fs.mkdirSync(path.dirname(args.cache), { recursive: true });
  return args;
}

function printUsage() {
  console.log(`Usage:
  PROSPEO_API_KEY=... node benchmark_prospeo_people_search.js [options]

Options:
  -i, --input <file>          Input CSV. Default: ../data/YC_Active_Companies_With_LinkedIn.csv (relative to this script's own location)
  -o, --output <file>         Output CSV. Default: ../results/prospeo_people_search_benchmark.csv (relative to this script's own location)
      --cache <file>          JSONL cache for resumable runs. Default: ../cache/<output-basename>.cache.jsonl
      --provider <name>       Provider label for output rows. Default: prospeo
      --job-titles <csv>      Comma-separated job title filters. Default: "ceo,chief executive,founder"
      --match-mode <value>    person_job_title.match_mode. Default: CONTAINS
      --smart-intensity <v>   person_job_title.smart_intensity. Default: LOOSE
      --page <n>              filters page number. Default: 1
      --auth-header <name>    HTTP header used to send the API key. Default: X-KEY
  -c, --concurrency <n>       Concurrent API calls (in-flight workers). Default: 5
      --rps <n>               Max requests/second, hard-gated. Default: 2
      --rpm <n>               Max requests/minute, hard-gated. Default: 60
      --rpd <n>               Max requests/day, hard-gated (throws once hit). Default: 4000
      --limit <n>             Process only n rows, useful for smoke tests
      --offset <n>            Start after n data rows
      --force                 Refetch rows even if output/cache already has data
      --api-key-stdin         Read Prospeo API key from the first stdin line

Note: Prospeo's auth header is assumed to be "X-KEY: <api_key>" based on their
public API docs. If requests fail with 401/403, re-check the docs and pass
--auth-header to override (e.g. --auth-header Authorization if it expects a
Bearer token instead).

Rate limits (from Prospeo dashboard): 2 req/s, 60 req/min, 4,000 req/day.
--concurrency only controls how many workers are in flight; actual request
pacing is throttled by --rps/--rpm/--rpd regardless of concurrency, so it's
safe to leave concurrency higher than the rate limit. Credits are billed at
1 credit per 25 retrieved results; credit_cost_estimated in the output CSV
is ceil(returned_count / 25) computed locally, used as a fallback whenever
the API response/headers don't report an explicit credit cost.
`);
}

function readApiKey(args) {
  if (!args.apiKeyStdin) {
    return Promise.resolve(process.env.PROSPEO_API_KEY || '');
  }

  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      text += chunk;
      const newlineIndex = text.indexOf('\n');
      if (newlineIndex !== -1) {
        process.stdin.pause();
        resolve(text.slice(0, newlineIndex).trim());
      }
    });
    process.stdin.on('end', () => {
      resolve(text.trim());
    });
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
  if (rows.length === 0) {
    throw new Error(`CSV is empty: ${filePath}`);
  }

  const headers = rows[0];
  const records = rows
    .slice(1)
    .filter((row) => row.some((value) => value.trim() !== ''))
    .map((row) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = row[index] || '';
      });
      return record;
    });

  return { headers, records };
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

function extractDomain(rawWebsite) {
  const raw = String(rawWebsite || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_error) {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .split('?')[0]
      .trim()
      .toLowerCase();
  }
}

function loadCache(cachePath) {
  const cache = new Map();
  if (!fs.existsSync(cachePath)) return cache;

  const lines = fs.readFileSync(cachePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.cacheKey) {
        cache.set(entry.cacheKey, entry);
      }
    } catch (error) {
      console.warn(`Skipping invalid cache line: ${error.message}`);
    }
  }
  return cache;
}

function appendCache(cachePath, entry) {
  fs.appendFileSync(cachePath, `${JSON.stringify(entry)}\n`);
}

function makeCacheKey(domain, jobTitles, matchMode, smartIntensity, page) {
  return `${domain}|${jobTitles.join('+')}|${matchMode}|${smartIntensity}|${page}`;
}

function searchPeople(apiKey, domain, jobTitles, matchMode, smartIntensity, page, authHeader) {
  const body = JSON.stringify({
    filters: {
      company: {
        websites: {
          include: [domain],
          exclude: [],
        },
      },
      person_job_title: {
        include: jobTitles,
        exclude: [],
        match_mode: matchMode,
        smart_intensity: smartIntensity,
      },
    },
    page,
  });

  const requestOptions = {
    method: 'POST',
    headers: {
      [authHeader]: apiKey,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(API_URL, requestOptions, (res) => {
      let responseText = '';
      res.on('data', (chunk) => {
        responseText += chunk;
      });
      res.on('end', () => {
        let parsed;
        try {
          parsed = responseText ? JSON.parse(responseText) : {};
        } catch (_error) {
          reject(new Error(`Invalid JSON response (${res.statusCode}): ${responseText.slice(0, 240)}`));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          // Prospeo returns HTTP 400 + error_code "NO_RESULTS" for legitimate
          // zero-match searches, instead of a 200 with an empty array. Treat
          // that as a valid zero-result response rather than a failure.
          if (res.statusCode === 400 && parsed && parsed.error_code === 'NO_RESULTS') {
            const rateLimits = extractRateLimits(res.headers);
            resolve({
              total_results: 0,
              returned_count: 0,
              linkedin_profile_count: 0,
              linkedin_profiles: '',
              credit_cost: '',
              credit_remaining: '',
              free_request: extractFreeFlag(parsed),
              rate_limit_second_left: rateLimits.second_left,
              rate_limit_minute_left: rateLimits.minute_left,
              rate_limit_daily_left: rateLimits.daily_left,
            });
            return;
          }

          const message = parsed.error_code
            || parsed.message
            || (typeof parsed.error === 'string' ? parsed.error : '')
            || responseText.slice(0, 240);
          reject(new Error(`HTTP ${res.statusCode}: ${message}`));
          return;
        }

        const people = extractPeople(parsed);
        const linkedinProfiles = uniqueStrings(people.map(extractLinkedInProfile).filter(Boolean));
        const totalResults = extractTotalResults(parsed, people.length);
        const credits = extractCredits(parsed, res.headers);
        const rateLimits = extractRateLimits(res.headers);

        resolve({
          total_results: totalResults,
          returned_count: people.length,
          linkedin_profile_count: linkedinProfiles.length,
          linkedin_profiles: linkedinProfiles.join('; '),
          credit_cost: credits.cost,
          credit_remaining: credits.remaining,
          free_request: extractFreeFlag(parsed),
          rate_limit_second_left: rateLimits.second_left,
          rate_limit_minute_left: rateLimits.minute_left,
          rate_limit_daily_left: rateLimits.daily_left,
        });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractPeople(response) {
  // Confirmed live shape: { error, results: [{ person: {...}, company: {...} }], pagination, free }
  const candidates = [
    response.results,
    response.persons,
    response.people,
    response.items,
    response.data,
    response.response,
    response.data && response.data.persons,
    response.data && response.data.people,
    response.data && response.data.results,
    response.response && response.response.persons,
    response.response && response.response.people,
    response.response && response.response.results,
    response.response && response.response.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map((item) => (item && typeof item === 'object' && item.person) ? item.person : item);
    }
  }

  return [];
}

function extractTotalResults(response, fallback) {
  const candidates = [
    response.pagination && response.pagination.total_count,
    response.total,
    response.totalResults,
    response.total_results,
    response.totalItems,
    response.count,
    response.data && response.data.total,
    response.data && response.data.totalResults,
    response.data && response.data.total_results,
    response.data && response.data.totalItems,
    response.data && response.data.count,
    response.response && response.response.total,
    response.response && response.response.total_results,
    response.response && response.response.count,
    response.meta && response.meta.total,
    response.meta && response.meta.totalResults,
    response.meta && response.meta.totalItems,
    response.pagination && response.pagination.total,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== '') {
      const parsed = Number(candidate);
      return Number.isFinite(parsed) ? parsed : candidate;
    }
  }

  return fallback;
}

function extractCredits(response, headers) {
  // Prospeo's search-person headers only expose rate-limit counters, not credit
  // cost/remaining directly. Fall back to a locally computed estimate elsewhere.
  const costCandidates = [
    headers['x-credit-cost'],
    response.credits_used,
    response.creditsUsed,
    response.credit_cost,
    response.response && response.response.credits_used,
  ];
  const remainingCandidates = [
    headers['x-credit-remaining'],
    response.credits_left,
    response.creditsLeft,
    response.credits_remaining,
    response.remaining_credits,
    response.response && response.response.credits_left,
  ];

  const cost = costCandidates.find((v) => v !== undefined && v !== null && v !== '');
  const remaining = remainingCandidates.find((v) => v !== undefined && v !== null && v !== '');

  return {
    cost: cost !== undefined ? cost : '',
    remaining: remaining !== undefined ? remaining : '',
  };
}

function extractFreeFlag(response) {
  return typeof response.free === 'boolean' ? String(response.free) : '';
}

function extractRateLimits(headers) {
  return {
    second_left: headers['x-second-request-left'] || '',
    minute_left: headers['x-minute-request-left'] || '',
    daily_left: headers['x-daily-request-left'] || '',
  };
}

function extractLinkedInProfile(person) {
  const candidates = [
    person.linkedin_profile,
    person.linkedin_profile_url,
    person.linkedinProfile,
    person.linkedinProfileUrl,
    person.linkedin_url,
    person.linkedinUrl,
    person.linkedin,
    person.profile_url,
    person.profileUrl,
    person.url,
    person.socials && person.socials.linkedin,
    person.socials && person.socials.linkedin_url,
    person.socials && person.socials.linkedinUrl,
    person.social_profiles && person.social_profiles.linkedin,
    person.social_profiles && person.social_profiles.linkedin_url,
  ];

  for (const candidate of candidates) {
    const value = normalizeLinkedInProfile(candidate);
    if (value) return value;
  }

  return '';
}

function normalizeLinkedInProfile(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    return normalizeLinkedInProfile(value.url || value.profile_url || value.profileUrl || value.value);
  }

  const text = String(value).trim();
  if (!text || !text.toLowerCase().includes('linkedin.com/in/')) return '';
  return text;
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

async function searchWithRetries(apiKey, domain, jobTitles, matchMode, smartIntensity, page, authHeader, rateLimiter, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rateLimiter.acquire();
      return await searchPeople(apiKey, domain, jobTitles, matchMode, smartIntensity, page, authHeader);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(750 * attempt);
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateLimiter {
  constructor({ perSecond, perMinute, perDay }) {
    this.perSecond = perSecond;
    this.perMinute = perMinute;
    this.perDay = perDay;
    this.timestamps = [];
    this.dayCount = 0;
    this.dayWindowStart = Date.now();
  }

  async acquire() {
    const now0 = Date.now();
    if (now0 - this.dayWindowStart >= 86400000) {
      this.dayWindowStart = now0;
      this.dayCount = 0;
    }
    if (this.dayCount >= this.perDay) {
      throw new Error(`Daily rate limit reached (${this.perDay} requests/day)`);
    }

    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 60000);
      const lastSecond = this.timestamps.filter((t) => now - t < 1000).length;
      const lastMinute = this.timestamps.length;
      if (lastSecond < this.perSecond && lastMinute < this.perMinute) {
        this.timestamps.push(now);
        this.dayCount += 1;
        return;
      }
      await sleep(50);
    }
  }
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

function buildOutputRecord(source, args, result) {
  return {
    provider: args.provider,
    slug: source.slug || '',
    company_name: source.company_name || '',
    domain: source.domain || '',
    company_website: source.company_website || '',
    company_linkedin_url: source.company_linkedin_url || '',
    job_titles: args.jobTitles.join('|'),
    match_mode: args.matchMode,
    smart_intensity: args.smartIntensity,
    page: args.page,
    total_results: result.total_results ?? '',
    returned_count: result.returned_count ?? '',
    linkedin_profile_count: result.linkedin_profile_count ?? '',
    linkedin_profiles: result.linkedin_profiles || '',
    credit_cost: result.credit_cost || '',
    credit_cost_estimated: result.credit_cost !== undefined && result.credit_cost !== ''
      ? ''
      : (Number.isFinite(result.returned_count) ? Math.ceil(result.returned_count / RESULTS_PER_CREDIT) : ''),
    credit_remaining: result.credit_remaining || '',
    free_request: result.free_request || '',
    rate_limit_second_left: result.rate_limit_second_left || '',
    rate_limit_minute_left: result.rate_limit_minute_left || '',
    rate_limit_daily_left: result.rate_limit_daily_left || '',
    request_status: result.request_status || 'ok',
    error: result.error || '',
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const { headers, records } = readCsv(args.input);
  if (!headers.includes('company_website')) {
    throw new Error('Input CSV must contain company_website');
  }

  const cache = loadCache(args.cache);
  const outputByRow = new Map();
  const tasks = [];

  records.forEach((record, rowIndex) => {
    if (rowIndex < args.offset) return;
    if (args.limit && rowIndex >= args.offset + args.limit) return;

    const domain = extractDomain(record.company_website);
    const source = { ...record, domain };

    if (!domain) {
      outputByRow.set(rowIndex, buildOutputRecord(source, args, {
        request_status: 'skipped',
        error: 'missing company_website domain',
      }));
      return;
    }

    const cacheKey = makeCacheKey(domain, args.jobTitles, args.matchMode, args.smartIntensity, args.page);
    const cached = cache.get(cacheKey);
    if (!args.force && cached && cached.result) {
      outputByRow.set(rowIndex, buildOutputRecord(source, args, cached.result));
      return;
    }

    tasks.push({ rowIndex, source, cacheKey });
  });

  console.log(`Input rows: ${records.length}`);
  console.log(`Rows selected: ${records.slice(args.offset, args.limit ? args.offset + args.limit : undefined).length}`);
  console.log(`Rows to call: ${tasks.length}`);
  console.log(`Concurrency: ${args.concurrency}`);
  console.log(`Rate limits: ${args.rps}/s, ${args.rpm}/min, ${args.rpd}/day`);

  let apiKey = '';
  if (tasks.length > 0) {
    apiKey = await readApiKey(args);
    if (!apiKey) {
      throw new Error('Set PROSPEO_API_KEY or pass --api-key-stdin before running this script.');
    }
  }

  const rateLimiter = new RateLimiter({ perSecond: args.rps, perMinute: args.rpm, perDay: args.rpd });
  let completed = 0;
  let failed = 0;

  await runPool(tasks, args.concurrency, async (task) => {
    try {
      const result = await searchWithRetries(
        apiKey,
        task.source.domain,
        args.jobTitles,
        args.matchMode,
        args.smartIntensity,
        args.page,
        args.authHeader,
        rateLimiter,
      );
      outputByRow.set(task.rowIndex, buildOutputRecord(task.source, args, result));
      appendCache(args.cache, {
        cacheKey: task.cacheKey,
        domain: task.source.domain,
        jobTitles: args.jobTitles,
        matchMode: args.matchMode,
        smartIntensity: args.smartIntensity,
        page: args.page,
        result,
      });
      completed += 1;
      console.log(`[${completed + failed}/${tasks.length}] ${task.source.domain} ok (${result.returned_count} returned)`);
    } catch (error) {
      const result = {
        request_status: 'error',
        error: error.message,
      };
      outputByRow.set(task.rowIndex, buildOutputRecord(task.source, args, result));
      appendCache(args.cache, {
        cacheKey: task.cacheKey,
        domain: task.source.domain,
        jobTitles: args.jobTitles,
        matchMode: args.matchMode,
        smartIntensity: args.smartIntensity,
        page: args.page,
        result,
      });
      failed += 1;
      console.error(`[${completed + failed}/${tasks.length}] ${task.source.domain} failed: ${error.message}`);
    }
  });

  const selectedOutputRows = [];
  records.forEach((_record, rowIndex) => {
    if (outputByRow.has(rowIndex)) {
      selectedOutputRows.push(outputByRow.get(rowIndex));
    }
  });

  const outputHeaders = [
    'provider',
    'slug',
    'company_name',
    'domain',
    'company_website',
    'company_linkedin_url',
    'job_titles',
    'match_mode',
    'smart_intensity',
    'page',
    'total_results',
    'returned_count',
    'linkedin_profile_count',
    'linkedin_profiles',
    'credit_cost',
    'credit_cost_estimated',
    'credit_remaining',
    'free_request',
    'rate_limit_second_left',
    'rate_limit_minute_left',
    'rate_limit_daily_left',
    'request_status',
    'error',
  ];

  const outputDir = path.dirname(path.resolve(args.output));
  fs.mkdirSync(outputDir, { recursive: true });
  const tempOutput = `${args.output}.tmp`;
  fs.writeFileSync(tempOutput, stringifyCsv(outputHeaders, selectedOutputRows));
  fs.renameSync(tempOutput, args.output);

  console.log(`Done. Called: ${completed}. Failed: ${failed}.`);
  console.log(`Wrote: ${args.output}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
