const fs = require('fs');
const https = require('https');
const path = require('path');

const API_URL = 'https://api.crustdata.com/person/search';
const DEFAULT_PROVIDER = 'crustdata';
const DEFAULT_API_VERSION = '2025-11-01';
const DEFAULT_JOB_TITLES = ['ceo', 'chief executive', 'founder'];
// Scoped to "current" employment: confirmed this correctly excludes people whose
// role at the domain is an investor/advisory affiliation rather than an actual
// current job (e.g. an investor whose Crustdata record shows domain association
// from a portfolio-company board seat, not employment). The unscoped, all-history
// version of this field pulls in that kind of investor/advisor noise.
const DEFAULT_DOMAIN_FIELD = 'experience.employment_details.current.company_website_domain';
const DEFAULT_TITLE_FIELD = 'experience.employment_details.current.title';
// "[.]" confirmed more precise than "(.)" for multi-word values like "chief executive":
// "(.)" fuzzy-matches on individual tokens anywhere in the title (so "chief executive"
// matches "Executive Assistant to Chief Financial Officer" via scattered token hits),
// while "[.]" requires the phrase itself to actually appear. Verified no recall loss
// on known-good cases (gumloop.com, driver.ai, greptile.com gave identical results).
const DEFAULT_TITLE_MATCH_TYPE = '[.]';
const DEFAULT_FIELDS = ['basic_profile', 'social_handles'];
// Confirmed via /person/search/autocomplete on basic_profile.normalized_title.sub_department:
// these two buckets cover CEO/founder-type roles far more precisely than the fuzzy "(.)"
// title-text operator, which is documented as typo-tolerant fuzzy matching (not substring).
const DEFAULT_SUB_DEPARTMENTS = ['Founder & Entrepreneurship Leadership', 'Executive & C-Suite Leadership'];
const SUB_DEPARTMENT_FIELD = 'basic_profile.normalized_title.sub_department';
// Confirmed live: 30 requests / 60s window (x-ratelimit-limit/remaining/reset headers).
const DEFAULT_RATE_LIMIT = 30;
const DEFAULT_RATE_WINDOW_MS = 60000;

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, '..', 'data', 'YC_Active_Companies_With_LinkedIn.csv'),
    output: path.join(__dirname, '..', 'results', 'crustdata_people_search_benchmark.csv'),
    cache: null,
    provider: DEFAULT_PROVIDER,
    apiVersion: DEFAULT_API_VERSION,
    jobTitles: DEFAULT_JOB_TITLES,
    titleMatchType: DEFAULT_TITLE_MATCH_TYPE,
    filterMode: 'fuzzy-title',
    subDepartments: DEFAULT_SUB_DEPARTMENTS,
    resultLimit: 100,
    concurrency: 3,
    rateLimit: DEFAULT_RATE_LIMIT,
    rateWindowMs: DEFAULT_RATE_WINDOW_MS,
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
    } else if (arg === '--api-version') {
      args.apiVersion = next;
      i += 1;
    } else if (arg === '--job-titles') {
      args.jobTitles = next.split(',').map((title) => title.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--title-match-type') {
      args.titleMatchType = next;
      i += 1;
    } else if (arg === '--filter-mode') {
      args.filterMode = next;
      i += 1;
    } else if (arg === '--sub-departments') {
      args.subDepartments = next.split(',').map((value) => value.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--result-limit') {
      args.resultLimit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '-c' || arg === '--concurrency') {
      args.concurrency = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--rate-limit') {
      args.rateLimit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--rate-window-ms') {
      args.rateWindowMs = Number.parseInt(next, 10);
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
  if (args.filterMode !== 'categorical' && args.filterMode !== 'fuzzy-title') {
    throw new Error('--filter-mode must be "categorical" or "fuzzy-title"');
  }
  if (args.filterMode === 'categorical' && args.subDepartments.length === 0) {
    throw new Error('--sub-departments must include at least one value when --filter-mode=categorical');
  }
  if (!Number.isInteger(args.resultLimit) || args.resultLimit < 1) {
    throw new Error('--result-limit must be a positive integer');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  if (!Number.isInteger(args.rateLimit) || args.rateLimit < 1) {
    throw new Error('--rate-limit must be a positive integer');
  }
  if (!Number.isInteger(args.rateWindowMs) || args.rateWindowMs < 1) {
    throw new Error('--rate-window-ms must be a positive integer');
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
  CRUSTDATA_API_KEY=... node benchmark_crustdata_people_search.js [options]

Options:
  -i, --input <file>          Input CSV. Default: ../data/YC_Active_Companies_With_LinkedIn.csv (relative to this script's own location)
  -o, --output <file>         Output CSV. Default: ../results/crustdata_people_search_benchmark.csv (relative to this script's own location)
      --cache <file>          JSONL cache for resumable runs. Default: ../cache/<output-basename>.cache.jsonl
      --provider <name>       Provider label for output rows. Default: crustdata
      --api-version <value>   x-api-version header. Default: 2025-11-01
      --job-titles <csv>      Comma-separated job title filters (OR'd). Default: "ceo,chief executive,founder"
                              Used for the client-side strict post-filter in both modes, and as
                              the server-side fuzzy title query when --filter-mode=fuzzy-title.
      --title-match-type <v>  Match operator for fuzzy-title mode. Default: [.]
                              [.] requires the value to appear as a phrase; (.) fuzzy-matches individual
                              tokens anywhere in the title (e.g. (.) "chief executive" false-positives on
                              "Executive Assistant to Chief Financial Officer" — [.] correctly rejects it).
      --filter-mode <mode>    "fuzzy-title" (default) or "categorical".
                              fuzzy-title: filters server-side on experience.employment_details.current.title
                              using --title-match-type, scoped against the *current*-employment domain field
                              (see note below) — confirmed to correctly exclude investors/advisors whose
                              Crustdata record ties them to a company via a non-employment (e.g. board/
                              advisory) relationship rather than an actual current job.
                              categorical: filters server-side on the normalized
                              basic_profile.normalized_title.sub_department field (see --sub-departments)
                              instead of title text — an alternative worth comparing, but empirically still
                              leaks some investor/advisor false positives that fuzzy-title + current-domain
                              scoping catches (see DEFAULT_DOMAIN_FIELD comment in source).
      --sub-departments <csv> Comma-separated basic_profile.normalized_title.sub_department values
                              (categorical mode only). Default: "Founder & Entrepreneurship Leadership,
                              Executive & C-Suite Leadership" (discovered via /person/search/autocomplete).
      --result-limit <n>      "limit" field in the search body (max profiles per search). Default: 100
  -c, --concurrency <n>       Concurrent API calls (in-flight workers). Default: 3
      --rate-limit <n>        Requests allowed per rate window (preemptive pacing). Default: 30
      --rate-window-ms <n>    Rate window length in ms. Default: 60000
      --limit <n>             Process only n rows, useful for smoke tests
      --offset <n>            Start after n data rows
      --force                 Refetch rows even if output/cache already has data
      --api-key-stdin         Read Crustdata API key from the first stdin line

Rate limits (confirmed live via x-ratelimit-* headers): 30 requests / 60s window.
The script paces requests preemptively against --rate-limit/--rate-window-ms, and
also reacts to live x-ratelimit-remaining/x-ratelimit-reset/HTTP 429 responses by
pausing for the server-reported reset window before resuming.

Credits are billed per request; credit_cost in the output CSV is read directly
from the x-credits-used response header (no local estimation needed).

Note on title matching: Crustdata's docs describe the "(.)" title operator as
a *fuzzy, typo-tolerant token match*, not literal substring matching, so raw
fuzzy-title-mode results can include unrelated titles (e.g. a search for "ceo"
matching "CISO" or "Copywriter"). categorical mode avoids most of this by
filtering server-side on Crustdata's normalized title classification instead,
but that classifier itself still occasionally miscategorizes support/intern/
freelancer titles as Founder/C-Suite. Either way, this script re-filters
results client-side afterward, keeping only people whose current_title
literally contains one of --job-titles (case-insensitive), as a precision
safety net. raw_returned_count in the output CSV is what Crustdata's API
itself returned before this client-side filter; returned_count/linkedin_profiles
are the corrected, strictly-matched values.
`);
}

function readApiKey(args) {
  if (!args.apiKeyStdin) {
    return Promise.resolve(process.env.CRUSTDATA_API_KEY || '');
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

function makeCacheKey(domain, jobTitles, titleMatchType, filterMode, subDepartments, resultLimit) {
  return `${domain}|${jobTitles.join('+')}|${titleMatchType}|${filterMode}|${subDepartments.join('+')}|${resultLimit}`;
}

function buildFilters(domain, jobTitles, titleMatchType, filterMode, subDepartments) {
  const roleCondition = filterMode === 'categorical'
    ? {
      field: SUB_DEPARTMENT_FIELD,
      type: 'in',
      value: subDepartments,
    }
    : {
      op: 'or',
      conditions: jobTitles.map((title) => ({
        field: DEFAULT_TITLE_FIELD,
        type: titleMatchType,
        value: title,
      })),
    };

  return {
    op: 'and',
    conditions: [
      {
        field: DEFAULT_DOMAIN_FIELD,
        type: '=',
        value: domain,
      },
      roleCondition,
    ],
  };
}

function searchPeople(apiKey, domain, jobTitles, titleMatchType, filterMode, subDepartments, resultLimit, apiVersion, rateLimiter) {
  const body = JSON.stringify({
    filters: buildFilters(domain, jobTitles, titleMatchType, filterMode, subDepartments),
    fields: DEFAULT_FIELDS,
    limit: resultLimit,
  });

  const requestOptions = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-api-version': apiVersion,
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
        rateLimiter.observe(res.headers, res.statusCode);

        let parsed;
        try {
          parsed = responseText ? JSON.parse(responseText) : {};
        } catch (_error) {
          reject(new Error(`Invalid JSON response (${res.statusCode}): ${responseText.slice(0, 240)}`));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = parsed.error_code
            || parsed.message
            || (typeof parsed.error === 'string' ? parsed.error : '')
            || responseText.slice(0, 240);
          reject(new Error(`HTTP ${res.statusCode}: ${message}`));
          return;
        }

        const rawPeople = extractPeople(parsed);
        // Crustdata's "(.)" operator is documented as a fuzzy/typo-tolerant
        // token match, not a literal substring match, so it leaks titles
        // that don't actually contain any target keyword (e.g. "Copywriter"
        // or "CISO" matching a search for "ceo"). Re-filter client-side for
        // a strict, comparable count against the other providers.
        const people = rawPeople.filter((person) => titleMatchesAny(person, jobTitles));
        const linkedinProfiles = uniqueStrings(people.map(extractLinkedInProfile).filter(Boolean));
        const totalResults = extractTotalResults(parsed, rawPeople.length);
        const rateLimitInfo = extractRateLimitInfo(res.headers);

        resolve({
          total_results: totalResults,
          raw_returned_count: rawPeople.length,
          returned_count: people.length,
          linkedin_profile_count: linkedinProfiles.length,
          linkedin_profiles: linkedinProfiles.join('; '),
          credit_cost: res.headers['x-credits-used'] || '',
          rate_limit_limit: rateLimitInfo.limit,
          rate_limit_remaining: rateLimitInfo.remaining,
          rate_limit_reset_seconds: rateLimitInfo.resetSeconds,
        });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractPeople(response) {
  // Confirmed live shape: { profiles: [{ basic_profile: {...}, social_handles: {...} }], total_count, next_cursor }
  const candidates = [
    response.profiles,
    response.results,
    response.people,
    response.persons,
    response.items,
    response.data,
    response.data && response.data.profiles,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function extractTotalResults(response, fallback) {
  const candidates = [
    response.total_count,
    response.total,
    response.totalResults,
    response.total_results,
    response.data && response.data.total_count,
    response.meta && response.meta.total_count,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== '') {
      const parsed = Number(candidate);
      return Number.isFinite(parsed) ? parsed : candidate;
    }
  }

  return fallback;
}

function extractRateLimitInfo(headers) {
  return {
    limit: headers['x-ratelimit-limit'] || '',
    remaining: headers['x-ratelimit-remaining'] || '',
    resetSeconds: headers['x-ratelimit-reset'] || '',
  };
}

function titleMatchesAny(person, jobTitles) {
  const title = (person.basic_profile && person.basic_profile.current_title || '').toLowerCase();
  if (!title) return false;
  return jobTitles.some((keyword) => title.includes(keyword.toLowerCase()));
}

function extractLinkedInProfile(person) {
  const socialHandles = person.social_handles || {};
  const basicProfile = person.basic_profile || {};

  const candidates = [
    socialHandles.professional_network_identifier && socialHandles.professional_network_identifier.profile_url,
    socialHandles.linkedin && socialHandles.linkedin.profile_url,
    socialHandles.linkedin_url,
    socialHandles.linkedin,
    basicProfile.linkedin_profile_url,
    basicProfile.linkedin_flagship_url,
    basicProfile.linkedin_url,
    person.linkedin_profile_url,
    person.linkedin_url,
    person.linkedinUrl,
    person.profile_url,
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

async function searchWithRetries(apiKey, domain, jobTitles, titleMatchType, filterMode, subDepartments, resultLimit, apiVersion, rateLimiter, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rateLimiter.acquire();
      return await searchPeople(apiKey, domain, jobTitles, titleMatchType, filterMode, subDepartments, resultLimit, apiVersion, rateLimiter);
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
  constructor({ maxRequests, windowMs }) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.timestamps = [];
    this.blockedUntil = 0;
  }

  async acquire() {
    for (;;) {
      const now = Date.now();
      if (now < this.blockedUntil) {
        await sleep(Math.min(this.blockedUntil - now, 1000));
        continue;
      }
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }
      await sleep(200);
    }
  }

  observe(headers, statusCode) {
    const remaining = Number(headers['x-ratelimit-remaining']);
    const resetSeconds = Number(headers['x-ratelimit-reset']);
    const limit = Number(headers['x-ratelimit-limit']);

    if (Number.isFinite(limit) && limit > 0) {
      this.maxRequests = limit;
    }
    if (statusCode === 429 || (Number.isFinite(remaining) && remaining <= 0)) {
      const waitMs = (Number.isFinite(resetSeconds) ? resetSeconds : 5) * 1000 + 250;
      this.blockedUntil = Math.max(this.blockedUntil, Date.now() + waitMs);
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
    title_match_type: args.titleMatchType,
    filter_mode: args.filterMode,
    sub_departments: args.subDepartments.join('|'),
    result_limit: args.resultLimit,
    total_results: result.total_results ?? '',
    raw_returned_count: result.raw_returned_count ?? '',
    returned_count: result.returned_count ?? '',
    linkedin_profile_count: result.linkedin_profile_count ?? '',
    linkedin_profiles: result.linkedin_profiles || '',
    credit_cost: result.credit_cost || '',
    rate_limit_limit: result.rate_limit_limit || '',
    rate_limit_remaining: result.rate_limit_remaining || '',
    rate_limit_reset_seconds: result.rate_limit_reset_seconds || '',
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

    const cacheKey = makeCacheKey(domain, args.jobTitles, args.titleMatchType, args.filterMode, args.subDepartments, args.resultLimit);
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
  console.log(`Rate limit: ${args.rateLimit} requests / ${args.rateWindowMs}ms (adaptive from live headers)`);

  let apiKey = '';
  if (tasks.length > 0) {
    apiKey = await readApiKey(args);
    if (!apiKey) {
      throw new Error('Set CRUSTDATA_API_KEY or pass --api-key-stdin before running this script.');
    }
  }

  const rateLimiter = new RateLimiter({ maxRequests: args.rateLimit, windowMs: args.rateWindowMs });
  let completed = 0;
  let failed = 0;

  await runPool(tasks, args.concurrency, async (task) => {
    try {
      const result = await searchWithRetries(
        apiKey,
        task.source.domain,
        args.jobTitles,
        args.titleMatchType,
        args.filterMode,
        args.subDepartments,
        args.resultLimit,
        args.apiVersion,
        rateLimiter,
      );
      outputByRow.set(task.rowIndex, buildOutputRecord(task.source, args, result));
      appendCache(args.cache, {
        cacheKey: task.cacheKey,
        domain: task.source.domain,
        jobTitles: args.jobTitles,
        titleMatchType: args.titleMatchType,
        filterMode: args.filterMode,
        subDepartments: args.subDepartments,
        resultLimit: args.resultLimit,
        result,
      });
      completed += 1;
      console.log(`[${completed + failed}/${tasks.length}] ${task.source.domain} ok (${result.returned_count} matched / ${result.raw_returned_count} raw)`);
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
        titleMatchType: args.titleMatchType,
        filterMode: args.filterMode,
        subDepartments: args.subDepartments,
        resultLimit: args.resultLimit,
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
    'title_match_type',
    'filter_mode',
    'sub_departments',
    'result_limit',
    'total_results',
    'raw_returned_count',
    'returned_count',
    'linkedin_profile_count',
    'linkedin_profiles',
    'credit_cost',
    'rate_limit_limit',
    'rate_limit_remaining',
    'rate_limit_reset_seconds',
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
