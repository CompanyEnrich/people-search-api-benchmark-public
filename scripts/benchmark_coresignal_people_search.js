const fs = require('fs');
const https = require('https');
const path = require('path');

// /search/es_dsl (no "/preview") — the preview endpoint isn't available on all
// plans, and is capped at 20 results with no way to raise it. This endpoint
// returns an uncapped array of person IDs instead (confirmed: 628/628 true
// matches returned for a company with no title filter, vs 20/630 on preview),
// and appears to be FREE (credits unchanged across multiple search calls).
// Each matched ID must then be fetched individually via /collect/{id}, which
// DOES cost credits (confirmed 10 credits per collect call).
const SEARCH_API_URL = 'https://api.coresignal.com/cdapi/v2/employee_base/search/es_dsl';
const COLLECT_API_URL = (id) => `https://api.coresignal.com/cdapi/v2/employee_base/collect/${id}`;
const DEFAULT_PROVIDER = 'coresignal';
const DEFAULT_JOB_TITLES = ['ceo', 'chief executive', 'founder'];
// Confirmed live: 18 requests/second (ratelimit-limit/remaining/reset headers).
const DEFAULT_RATE_LIMIT = 18;
const DEFAULT_RATE_WINDOW_MS = 1000;

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, '..', 'data', 'YC_Active_Companies_With_LinkedIn.csv'),
    output: path.join(__dirname, '..', 'results', 'coresignal_people_search_benchmark.csv'),
    cache: null,
    provider: DEFAULT_PROVIDER,
    jobTitles: DEFAULT_JOB_TITLES,
    concurrency: 3,
    rateLimit: DEFAULT_RATE_LIMIT,
    rateWindowMs: DEFAULT_RATE_WINDOW_MS,
    limit: null,
    offset: 0,
    force: false,
    apiKeyStdin: false,
    dryRun: false,
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
    } else if (arg === '--dry-run') {
      args.dryRun = true;
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
  CORESIGNAL_API_KEY=... node benchmark_coresignal_people_search.js [options]

Options:
  -i, --input <file>        Input CSV. Default: ../data/YC_Active_Companies_With_LinkedIn.csv (relative to this script's own location)
  -o, --output <file>       Output CSV. Default: ../results/coresignal_people_search_benchmark.csv (relative to this script's own location)
      --cache <file>        JSONL cache for resumable runs. Default: ../cache/<output-basename>.cache.jsonl
      --provider <name>     Provider label for output rows. Default: coresignal
      --job-titles <csv>    Comma-separated job title filters (OR'd). Default: "ceo,chief executive,founder"
                            Multi-word terms are auto-quoted as an exact phrase in the
                            query_string query (see note below on why this matters).
  -c, --concurrency <n>     Concurrent API calls (in-flight workers). Default: 3
      --rate-limit <n>      Requests allowed per rate window (preemptive pacing). Default: 18
      --rate-window-ms <n>  Rate window length in ms. Default: 1000
      --limit <n>           Process only n rows, useful for smoke tests
      --offset <n>          Start after n data rows
      --force               Refetch rows even if output/cache already has data
      --api-key-stdin       Read Coresignal API key from the first stdin line
      --dry-run             Run the FREE /search/es_dsl step only for every row (no
                            /collect calls, so no credits spent) and print the total
                            match count + exact credits a full run would cost
                            (matches x 10). No output CSV is written in this mode.

Rate limits (confirmed live via ratelimit-* headers): 18 requests/second.

This script uses a two-step flow, since /search/es_dsl/preview isn't available
on all plans:
  1. POST /search/es_dsl with the query -> returns an array of matched person
     IDs. Confirmed FREE (credits unchanged across repeated calls), and
     uncapped (628/628 true matches returned for a company with no title
     filter, vs. only 20/630 on the capped /preview endpoint).
  2. GET /collect/{id} for each matched ID -> returns that person's full
     profile (career history, LinkedIn URL, etc). Confirmed to cost 10
     credits PER PERSON collected.

IMPORTANT — credit cost model: because search is free but each collected
person costs 10 credits, cost now scales with how many people actually match
per company, not a flat per-call rate. A company with 0 matches is now FREE
(previously flat 10 credits on /preview); a company with 3 matches now costs
30 credits (previously still flat 10 on /preview). Budget for roughly
10 x (avg matches/company) credits per row, not a flat per-row rate.

Note on title matching: the sample query used bare "chief" in a query_string
OR clause, which matches ANY title containing that token — not just "CEO",
but "Chief Financial Officer", "Chief of Staff", "Chief Marketing Officer",
etc. This script instead quotes multi-word terms (e.g. "chief executive") as
an exact phrase, which was confirmed live to cut a noisy 10-result company
down to 3 relevant ones. A client-side strict substring re-filter (checking
the collected person's title, extracted from the matching current-employment
experience entry, literally contains one of --job-titles) is also applied as
a safety net, matching the approach used for the other provider scripts.

Note on domain matching: uses match_phrase on the purpose-built
experience.company_website.domain_only field, confirmed to give identical
results to an earlier dual-wildcard should/minimum_should_match approach,
with less false-positive substring-match risk.
`);
}

function readApiKey(args) {
  if (!args.apiKeyStdin) {
    return Promise.resolve(process.env.CORESIGNAL_API_KEY || '');
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

function makeCacheKey(domain, jobTitles) {
  return `${domain}|${jobTitles.join('+')}`;
}

function buildTitleQueryString(jobTitles) {
  return jobTitles
    .map((title) => (title.includes(' ') ? `"${title}"` : title))
    .join(' OR ');
}

function buildQuery(domain, jobTitles) {
  // match_phrase on the purpose-built domain_only field alone (confirmed identical
  // results to the earlier dual-wildcard should/minimum_should_match approach on
  // company_website.exact + .domain_only) — simpler and avoids wildcard substring
  // false-positive risk (e.g. "*legora.com*" could theoretically match unrelated
  // strings containing that substring).
  return {
    query: {
      bool: {
        must: [
          {
            nested: {
              path: 'experience',
              query: {
                bool: {
                  must: [
                    { term: { 'experience.is_current': 1 } },
                    { term: { 'experience.deleted': 0 } },
                    { match_phrase: { 'experience.company_website.domain_only': domain } },
                    {
                      query_string: {
                        query: buildTitleQueryString(jobTitles),
                        fields: ['experience.title'],
                        default_operator: 'OR',
                      },
                    },
                  ],
                },
              },
            },
          },
          { term: { deleted: 0 } },
        ],
      },
    },
  };
}

function httpRequestJson(url, method, apiKey, body, onHeaders) {
  const requestOptions = {
    method,
    headers: {
      apikey: apiKey,
      accept: 'application/json',
    },
  };
  if (body !== undefined) {
    requestOptions.headers['Content-Type'] = 'application/json';
    requestOptions.headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(url, requestOptions, (res) => {
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
          const message = (parsed && (parsed.error || parsed.message || (parsed.detail && JSON.stringify(parsed.detail))))
            || responseText.slice(0, 240);
          reject(new Error(`HTTP ${res.statusCode}: ${message}`));
          return;
        }

        resolve({ body: parsed, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function searchIds(apiKey, domain, jobTitles, rateLimiter) {
  const body = JSON.stringify(buildQuery(domain, jobTitles));
  const { body: parsed, headers } = await httpRequestJson(
    SEARCH_API_URL,
    'POST',
    apiKey,
    body,
    (h, s) => rateLimiter.observe(h, s),
  );
  const ids = Array.isArray(parsed) ? parsed : [];
  return {
    ids,
    totalResults: extractTotalResults(headers, ids.length),
    rateLimitRemaining: headers['ratelimit-remaining'] || '',
  };
}

async function collectPerson(apiKey, id, rateLimiter) {
  const { body: parsed, headers } = await httpRequestJson(
    COLLECT_API_URL(id),
    'GET',
    apiKey,
    undefined,
    (h, s) => rateLimiter.observe(h, s),
  );
  return {
    person: parsed || {},
    creditRemaining: headers['x-credits-remaining'] || '',
    rateLimitRemaining: headers['ratelimit-remaining'] || '',
  };
}

async function searchIdsWithRetries(apiKey, domain, jobTitles, rateLimiter, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rateLimiter.acquire();
      return await searchIds(apiKey, domain, jobTitles, rateLimiter);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(750 * attempt);
    }
  }
  throw lastError;
}

async function collectPersonWithRetries(apiKey, id, rateLimiter, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rateLimiter.acquire();
      return await collectPerson(apiKey, id, rateLimiter);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(750 * attempt);
    }
  }
  throw lastError;
}

// Full /collect profiles carry the person's entire career history in
// `experience[]`; unlike /preview's flattened per-match "title" field, we
// have to find the specific entry that matches this search (current +
// company_website containing the target domain) to get the right title.
function findCurrentExperienceForDomain(person, domain) {
  const experience = Array.isArray(person.experience) ? person.experience : [];
  const domainLower = domain.toLowerCase();
  return experience.find((entry) => {
    if (entry.is_current !== 1) return false;
    if (entry.deleted) return false;
    const website = String(entry.company_website || '').toLowerCase();
    return website.includes(domainLower);
  }) || null;
}

async function fetchCompanyPeople(apiKey, domain, jobTitles, rateLimiter) {
  const { ids, totalResults } = await searchIdsWithRetries(apiKey, domain, jobTitles, rateLimiter);

  const collected = [];
  for (const id of ids) {
    const { person, creditRemaining, rateLimitRemaining } = await collectPersonWithRetries(apiKey, id, rateLimiter);
    const experienceEntry = findCurrentExperienceForDomain(person, domain);
    collected.push({
      title: experienceEntry ? experienceEntry.title : '',
      linkedin: extractLinkedInProfile(person),
      creditRemaining,
      rateLimitRemaining,
    });
  }

  const matched = collected.filter((c) => titleMatchesAny(c.title, jobTitles));
  const linkedinProfiles = uniqueStrings(matched.map((c) => c.linkedin).filter(Boolean));
  const last = collected[collected.length - 1];

  return {
    total_results: totalResults,
    raw_returned_count: ids.length,
    returned_count: matched.length,
    linkedin_profile_count: linkedinProfiles.length,
    linkedin_profiles: linkedinProfiles.join('; '),
    credit_remaining: last ? last.creditRemaining : '',
    rate_limit_remaining: last ? last.rateLimitRemaining : '',
  };
}

function extractTotalResults(headers, fallback) {
  const value = headers['x-total-results'];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function titleMatchesAny(title, jobTitles) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  return jobTitles.some((keyword) => t.includes(keyword.toLowerCase()));
}

function extractLinkedInProfile(person) {
  const value = person.profile_url;
  if (!value) return '';
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
      await sleep(50);
    }
  }

  observe(headers, statusCode) {
    const remaining = Number(headers['ratelimit-remaining']);
    const resetSeconds = Number(headers['ratelimit-reset']);
    const limit = Number(headers['ratelimit-limit']);

    if (Number.isFinite(limit) && limit > 0) {
      this.maxRequests = limit;
    }
    if (statusCode === 429 || (Number.isFinite(remaining) && remaining <= 0)) {
      const waitMs = (Number.isFinite(resetSeconds) ? resetSeconds : 2) * 1000 + 250;
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
    total_results: result.total_results ?? '',
    raw_returned_count: result.raw_returned_count ?? '',
    returned_count: result.returned_count ?? '',
    possibly_truncated: (typeof result.total_results === 'number' && typeof result.raw_returned_count === 'number' && result.total_results > result.raw_returned_count)
      ? 'true'
      : '',
    linkedin_profile_count: result.linkedin_profile_count ?? '',
    linkedin_profiles: result.linkedin_profiles || '',
    credit_remaining: result.credit_remaining || '',
    rate_limit_remaining: result.rate_limit_remaining || '',
    request_status: result.request_status || 'ok',
    error: result.error || '',
  };
}

async function runDryRun(args, records) {
  const selected = [];
  records.forEach((record, rowIndex) => {
    if (rowIndex < args.offset) return;
    if (args.limit && rowIndex >= args.offset + args.limit) return;
    const domain = extractDomain(record.company_website);
    if (domain) selected.push({ rowIndex, domain });
  });

  console.log(`Input rows: ${records.length}`);
  console.log(`Rows to search (dry run, FREE, no collects): ${selected.length}`);
  console.log(`Concurrency: ${args.concurrency}`);
  console.log(`Rate limit: ${args.rateLimit} requests / ${args.rateWindowMs}ms (adaptive from live headers)`);

  const apiKey = await readApiKey(args);
  if (!apiKey) {
    throw new Error('Set CORESIGNAL_API_KEY or pass --api-key-stdin before running this script.');
  }

  const rateLimiter = new RateLimiter({ maxRequests: args.rateLimit, windowMs: args.rateWindowMs });
  let totalMatches = 0;
  let zeroMatchRows = 0;
  let completed = 0;
  let failed = 0;

  await runPool(selected, args.concurrency, async (task) => {
    try {
      const { ids } = await searchIdsWithRetries(apiKey, task.domain, args.jobTitles, rateLimiter);
      totalMatches += ids.length;
      if (ids.length === 0) zeroMatchRows += 1;
      completed += 1;
      console.log(`[${completed + failed}/${selected.length}] ${task.domain} -> ${ids.length} matches (running total: ${totalMatches})`);
    } catch (error) {
      failed += 1;
      console.error(`[${completed + failed}/${selected.length}] ${task.domain} failed: ${error.message}`);
    }
  });

  console.log('');
  console.log('=== DRY RUN SUMMARY ===');
  console.log(`Rows searched: ${completed} ok, ${failed} failed`);
  console.log(`Zero-match rows: ${zeroMatchRows}`);
  console.log(`Total matched people across all rows: ${totalMatches}`);
  console.log(`Avg matches/row: ${(totalMatches / (completed || 1)).toFixed(3)}`);
  console.log(`Estimated credits for a full collect run: ${totalMatches * 10} (${totalMatches} people x 10 credits)`);
}

async function main() {
  const args = parseArgs(process.argv);
  const { headers, records } = readCsv(args.input);
  if (!headers.includes('company_website')) {
    throw new Error('Input CSV must contain company_website');
  }

  if (args.dryRun) {
    await runDryRun(args, records);
    return;
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

    const cacheKey = makeCacheKey(domain, args.jobTitles);
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
  if (tasks.length > 0) {
    console.log(`WARNING: search is free but each /collect call costs ~10 credits per matched person. Cost scales with match count, not with ${tasks.length} rows directly — watch the credits_remaining column as this runs.`);
  }

  let apiKey = '';
  if (tasks.length > 0) {
    apiKey = await readApiKey(args);
    if (!apiKey) {
      throw new Error('Set CORESIGNAL_API_KEY or pass --api-key-stdin before running this script.');
    }
  }

  const rateLimiter = new RateLimiter({ maxRequests: args.rateLimit, windowMs: args.rateWindowMs });
  let completed = 0;
  let failed = 0;

  await runPool(tasks, args.concurrency, async (task) => {
    try {
      const result = await fetchCompanyPeople(apiKey, task.source.domain, args.jobTitles, rateLimiter);
      outputByRow.set(task.rowIndex, buildOutputRecord(task.source, args, result));
      appendCache(args.cache, {
        cacheKey: task.cacheKey,
        domain: task.source.domain,
        jobTitles: args.jobTitles,
        result,
      });
      completed += 1;
      console.log(`[${completed + failed}/${tasks.length}] ${task.source.domain} ok (${result.returned_count} matched / ${result.raw_returned_count} raw, credits left: ${result.credit_remaining})`);
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
    'total_results',
    'raw_returned_count',
    'returned_count',
    'possibly_truncated',
    'linkedin_profile_count',
    'linkedin_profiles',
    'credit_remaining',
    'rate_limit_remaining',
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
