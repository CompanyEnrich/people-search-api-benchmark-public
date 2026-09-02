const fs = require('fs');
const https = require('https');
const path = require('path');

// NOTE: this script has NOT been live-tested yet (no API key was available
// at write time). It's a best-effort draft from PDL's docs
// (https://docs.peopledatalabs.com/docs/quickstart-person-search-api and
// /docs/fields). Every other provider script in this project needed live-data
// corrections to its as-documented query (Coresignal's bare "chief",
// Crustdata's fuzzy "(.)" operator, Prospeo's NO_RESULTS-as-error quirk) —
// expect the same here. Specific assumptions that need validating once a key
// is available are flagged inline below and in printUsage().
const API_URL = 'https://api.peopledatalabs.com/v5/person/search';
const DEFAULT_PROVIDER = 'pdl';
const DEFAULT_JOB_TITLES = ['ceo', 'chief executive', 'founder'];
// job_title_levels enum values per docs: Unpaid, Training, Entry, Manager,
// Senior, Partner, Director, VP, Owner, CXO. Lowercased here on the assumption
// the API expects lowercase term values (matches the docs example ["cxo","owner"]) —
// unconfirmed, may need adjusting to exact-case "CXO"/"Owner" once tested live.
const DEFAULT_JOB_TITLE_LEVELS = ['cxo', 'owner'];
const DEFAULT_DOMAIN_FIELD = 'job_company_website';
const DEFAULT_DOMAIN_MATCH_TYPE = 'term'; // confirmed working live
// Confirmed live via x-ratelimit-limit response header: {"minute": N} — a
// per-MINUTE limit, not per-second. Seen as low as 10/min and as high as
// 20/min across the same key at different times (possibly scales with
// credit balance) — the adaptive RateLimiter.observe() self-corrects from
// live headers regardless of this starting default.
const DEFAULT_RATE_LIMIT = 20;
const DEFAULT_RATE_WINDOW_MS = 60000;

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, '..', 'data', 'YC_Active_Companies_With_LinkedIn.csv'),
    output: path.join(__dirname, '..', 'results', 'pdl_people_search_benchmark.csv'),
    cache: null,
    provider: DEFAULT_PROVIDER,
    jobTitles: DEFAULT_JOB_TITLES,
    jobTitleLevels: DEFAULT_JOB_TITLE_LEVELS,
    domainMatchType: DEFAULT_DOMAIN_MATCH_TYPE,
    resultSize: 100,
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
    } else if (arg === '--job-title-levels') {
      args.jobTitleLevels = next.split(',').map((v) => v.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--domain-match-type') {
      args.domainMatchType = next;
      i += 1;
    } else if (arg === '--result-size') {
      args.resultSize = Number.parseInt(next, 10);
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
  if (!Number.isInteger(args.resultSize) || args.resultSize < 1) {
    throw new Error('--result-size must be a positive integer');
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
  PDL_API_KEY=... node benchmark_pdl_people_search.js [options]

Options:
  -i, --input <file>          Input CSV. Default: ../data/YC_Active_Companies_With_LinkedIn.csv (relative to this script's own location)
  -o, --output <file>         Output CSV. Default: ../results/pdl_people_search_benchmark.csv (relative to this script's own location)
      --cache <file>          JSONL cache for resumable runs. Default: ../cache/<output-basename>.cache.jsonl
      --provider <name>       Provider label for output rows. Default: pdl
      --job-titles <csv>      Comma-separated title keywords for the client-side safety
                              filter (checked against each returned person's job_title).
                              Default: "ceo,chief executive,founder"
      --job-title-levels <csv> Comma-separated job_title_levels server-side prefilter
                              (confirmed working via "terms" query). Default: "cxo,owner"
                              NOTE: "cxo" matches ALL C-level titles (CFO/CTO/CMO/CRO/COO
                              etc, confirmed live), not just CEO — the client-side
                              --job-titles filter is what actually narrows this down.
      --domain-match-type <v> "term" (default, confirmed working) or "match" for
                              job_company_website.
      --result-size <n>       "size" field in the request. Confirmed: billing is per
                              actual record returned, capped at this value (e.g. size:5
                              on a company with 7 true matches returned+billed 5, not 7).
                              Default: 100.
  -c, --concurrency <n>       Concurrent API calls (in-flight workers). Default: 3 —
                              consider lowering to 1-2 given how restrictive the
                              confirmed rate limit is (see below).
      --rate-limit <n>        Requests allowed per rate window (preemptive pacing).
                              Confirmed live via x-ratelimit-limit: {"minute":10} —
                              only 10 requests/MINUTE, much more restrictive than the
                              other providers in this project. Default: 10.
      --rate-window-ms <n>    Rate window length in ms. Default: 60000 (matches the
                              confirmed per-minute limit above).
      --limit <n>             Process only n rows, useful for smoke tests
      --offset <n>            Start after n data rows
      --force                 Refetch rows even if output/cache already has data
      --api-key-stdin         Read PDL API key from the first stdin line
      --dry-run               Probe every row with size:1 and report the "total" true
                              match count per row (see note below — NOT free, unlike
                              Coresignal's dry-run).

CONFIRMED FINDINGS FROM LIVE TESTING:
  1. "minimum_should_match" is REJECTED (HTTP 400: "not allowed or invalid field
     name") — do not use it in queries against this API.
  2. "match"/"match_phrase" on job_title do NOT do substring/phrase text search the
     way they do on Crustdata/Coresignal — a match_phrase query for "chief executive"
     failed to match a real person whose job_title was literally "chief executive
     officer & co-founder". job_title is very likely a keyword-type field requiring
     an exact whole-field match. This script does NOT use free-text job_title
     queries server-side because of this — it relies entirely on job_title_levels
     (confirmed working) + the client-side safety filter.
  3. job_title_levels "terms" query is confirmed working and precise for what it's
     designed to do — validated against legora.com and userguiding.com, correctly
     surfacing known-genuine CEO/founder matches.
  4. 0-result queries and failed (4xx) queries cost 0 credits (confirmed via
     x-call-credits-spent: 0 on multiple such calls) — safe to experiment.
  5. size:0 does NOT return a usable "total" (comes back null) — there is no free
     dry-run on PDL. --dry-run here uses size:1 instead, which costs up to 1 credit
     per row with at least one match (0 for zero-match rows).
  6. Credit/quota response headers were inconsistent during testing —
     x-totallimit-remaining did not decrease monotonically across calls (likely a
     rolling per-minute quota tied to the same window as rate limiting) while
     x-totallimit-purchased-remaining barely moved despite x-call-credits-spent
     totaling ~11 across the session. Do not trust these headers alone for budget
     tracking — verify against the actual PDL account dashboard.

As with every other provider in this project, run --limit 1-5 first and inspect
raw responses before trusting this at scale.
`);
}

function readApiKey(args) {
  if (!args.apiKeyStdin) {
    return Promise.resolve(process.env.PDL_API_KEY || '');
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

function makeCacheKey(domain, jobTitles, jobTitleLevels, domainMatchType, resultSize) {
  return `${domain}|${jobTitles.join('+')}|${jobTitleLevels.join('+')}|${domainMatchType}|${resultSize}`;
}

function buildQuery(domain, jobTitles, jobTitleLevels, domainMatchType) {
  // Confirmed live:
  // - "minimum_should_match" is REJECTED by PDL's API (400: "not allowed or
  //   invalid field name") — do not use it.
  // - "match"/"match_phrase" on job_title do NOT behave like substring/phrase
  //   matching against an analyzed text field the way they do on Crustdata or
  //   Coresignal — a match_phrase query for "chief executive" failed to match
  //   a real person whose job_title was literally "chief executive officer &
  //   co-founder". job_title is very likely a keyword-type field requiring an
  //   exact whole-field match, not the free-text search we assumed.
  // - job_title_levels via "terms" DOES work correctly and was validated
  //   against two known-correct companies (legora.com, userguiding.com).
  // So the query relies solely on the confirmed-working term/terms clauses;
  // the client-side titleMatchesAny() safety filter (same pattern as
  // Crustdata) does the real precision work afterward.
  return {
    query: {
      bool: {
        must: [
          { [domainMatchType]: { [DEFAULT_DOMAIN_FIELD]: domain } },
          { terms: { job_title_levels: jobTitleLevels } },
        ],
      },
    },
  };
}

function httpRequestJson(url, method, apiKey, body, onHeaders) {
  const requestOptions = {
    method,
    headers: {
      'X-Api-Key': apiKey,
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
          // Confirmed live: PDL returns HTTP 404 with error.type "not_found" for
          // a legitimate zero-match search, e.g.
          // {"status":404,"error":{"type":"not_found","message":"No records were
          // found matching your search"},"total":0} — same class of quirk as
          // Prospeo's NO_RESULTS. Treat this as a valid empty response, not a
          // failure, so zero-match companies aren't misreported as errors.
          if (res.statusCode === 404 && parsed && parsed.error && parsed.error.type === 'not_found') {
            resolve({ body: parsed, headers: res.headers });
            return;
          }

          const message = (parsed && (parsed.error?.message || parsed.error || parsed.message))
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

async function searchPeople(apiKey, domain, jobTitles, jobTitleLevels, domainMatchType, resultSize, rateLimiter) {
  const body = JSON.stringify({
    query: buildQuery(domain, jobTitles, jobTitleLevels, domainMatchType),
    size: resultSize,
  });

  const { body: parsed, headers } = await httpRequestJson(
    API_URL,
    'GET',
    apiKey,
    body,
    (h, s) => rateLimiter.observe(h, s),
  );

  const rawPeople = Array.isArray(parsed?.data) ? parsed.data : [];
  const people = rawPeople.filter((person) => titleMatchesAny(person.job_title, jobTitles));
  const linkedinProfiles = uniqueStrings(people.map(extractLinkedInProfile).filter(Boolean));
  const totalResults = typeof parsed?.total === 'number' ? parsed.total : rawPeople.length;

  return {
    total_results: totalResults,
    raw_returned_count: rawPeople.length,
    returned_count: people.length,
    possibly_truncated: totalResults > rawPeople.length ? 'true' : '',
    linkedin_profile_count: linkedinProfiles.length,
    linkedin_profiles: linkedinProfiles.join('; '),
    rate_limit_remaining: headers['x-ratelimit-remaining'] || headers['ratelimit-remaining'] || '',
  };
}

function titleMatchesAny(title, jobTitles) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  return jobTitles.some((keyword) => t.includes(keyword.toLowerCase()));
}

function extractLinkedInProfile(person) {
  const value = person.linkedin_url;
  if (!value) return '';
  let text = String(value).trim();
  if (!text) return '';
  if (!text.includes('://')) text = `https://${text}`;
  if (!text.toLowerCase().includes('linkedin.com/in/')) return '';
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

async function searchWithRetries(apiKey, domain, jobTitles, jobTitleLevels, domainMatchType, resultSize, rateLimiter, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rateLimiter.acquire();
      return await searchPeople(apiKey, domain, jobTitles, jobTitleLevels, domainMatchType, resultSize, rateLimiter);
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
      await sleep(50);
    }
  }

  observe(headers, statusCode) {
    const remaining = Number(headers['x-ratelimit-remaining'] || headers['ratelimit-remaining']);
    const resetSeconds = Number(headers['x-ratelimit-reset'] || headers['ratelimit-reset']);
    const limit = Number(headers['x-ratelimit-limit'] || headers['ratelimit-limit']);

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
    job_title_levels: args.jobTitleLevels.join('|'),
    domain_match_type: args.domainMatchType,
    result_size: args.resultSize,
    total_results: result.total_results ?? '',
    raw_returned_count: result.raw_returned_count ?? '',
    returned_count: result.returned_count ?? '',
    possibly_truncated: result.possibly_truncated || '',
    linkedin_profile_count: result.linkedin_profile_count ?? '',
    linkedin_profiles: result.linkedin_profiles || '',
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
  console.log(`Rows to probe (size:1): ${selected.length}`);
  console.log('NOTE: size:0 was tested and does NOT return a usable "total" (confirmed live — PDL returns total:null). There is no free dry-run on PDL, unlike Coresignal\'s separate free search endpoint. This mode uses size:1 instead: costs 0 credits for rows with zero true matches, and up to 1 credit for rows with at least one match (confirmed: 0-result and failed queries cost nothing). The "total" field in the response is the TRUE full match count regardless of the size cap, so this still gives an accurate budget estimate for the real run at low cost — but it is NOT free.');

  const apiKey = await readApiKey(args);
  if (!apiKey) {
    throw new Error('Set PDL_API_KEY or pass --api-key-stdin before running this script.');
  }

  const rateLimiter = new RateLimiter({ maxRequests: args.rateLimit, windowMs: args.rateWindowMs });
  let totalMatches = 0;
  let zeroMatchRows = 0;
  let completed = 0;
  let failed = 0;

  await runPool(selected, args.concurrency, async (task) => {
    try {
      const result = await searchWithRetries(apiKey, task.domain, args.jobTitles, args.jobTitleLevels, args.domainMatchType, 1, rateLimiter);
      totalMatches += result.total_results;
      if (result.total_results === 0) zeroMatchRows += 1;
      completed += 1;
      console.log(`[${completed + failed}/${selected.length}] ${task.domain} -> ${result.total_results} total matches (running total: ${totalMatches})`);
    } catch (error) {
      failed += 1;
      console.error(`[${completed + failed}/${selected.length}] ${task.domain} failed: ${error.message}`);
    }
  });

  console.log('');
  console.log('=== PROBE SUMMARY ===');
  console.log(`Rows searched: ${completed} ok, ${failed} failed`);
  console.log(`Zero-match rows: ${zeroMatchRows}`);
  console.log(`Total matched people (raw, pre-safety-filter) across all rows: ${totalMatches}`);
  console.log(`Avg matches/row: ${(totalMatches / (completed || 1)).toFixed(3)}`);
  console.log(`This probe itself cost roughly ${completed - zeroMatchRows} credits (1 per non-zero row). A full run with --result-size 100 should cost roughly ${totalMatches} credits total (min(true_total, 100) per row) — verify against your actual dashboard balance, not just response headers, which were inconsistent in testing.`);
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

    const cacheKey = makeCacheKey(domain, args.jobTitles, args.jobTitleLevels, args.domainMatchType, args.resultSize);
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
  console.log(`Rate limit: ${args.rateLimit} requests / ${args.rateWindowMs}ms (UNVALIDATED default, adaptive from live headers if present)`);

  let apiKey = '';
  if (tasks.length > 0) {
    apiKey = await readApiKey(args);
    if (!apiKey) {
      throw new Error('Set PDL_API_KEY or pass --api-key-stdin before running this script.');
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
        args.jobTitleLevels,
        args.domainMatchType,
        args.resultSize,
        rateLimiter,
      );
      outputByRow.set(task.rowIndex, buildOutputRecord(task.source, args, result));
      appendCache(args.cache, {
        cacheKey: task.cacheKey,
        domain: task.source.domain,
        jobTitles: args.jobTitles,
        jobTitleLevels: args.jobTitleLevels,
        domainMatchType: args.domainMatchType,
        resultSize: args.resultSize,
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
        jobTitleLevels: args.jobTitleLevels,
        domainMatchType: args.domainMatchType,
        resultSize: args.resultSize,
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
    'job_title_levels',
    'domain_match_type',
    'result_size',
    'total_results',
    'raw_returned_count',
    'returned_count',
    'possibly_truncated',
    'linkedin_profile_count',
    'linkedin_profiles',
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
