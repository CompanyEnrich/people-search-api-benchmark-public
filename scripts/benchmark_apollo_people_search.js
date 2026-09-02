const fs = require('fs');
const https = require('https');
const path = require('path');

// Two-step flow, same pattern as Coresignal:
//   1. POST /api/v1/mixed_people/api_search -> 0 credits (confirmed in docs), but
//      returns obfuscated data (last_name_obfuscated, no linkedin_url).
//   2. POST /api/v1/people/bulk_match (up to 10 ids/call) -> 1-9 credits/person,
//      only 1 if reveal_phone_number:false (avoids the +8 phone-reveal charge).
// This script has NOT been extensively live-tested at write time (budget is
// only 75 credits on the test key) — search was validated broadly since it's
// free, but bulk_match was only validated on a couple of people to conserve
// credits for the production key. See printUsage() for what's confirmed vs
// still assumed.
const SEARCH_API_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const BULK_MATCH_API_URL = 'https://api.apollo.io/api/v1/people/bulk_match';
const BULK_MATCH_BATCH_SIZE = 10; // confirmed max per docs
const DEFAULT_PROVIDER = 'apollo';
const DEFAULT_JOB_TITLES = ['ceo', 'chief executive', 'founder'];
// Rate limits vary a lot by plan tier (search: 50-200/min, bulk_match: 20-1000/min
// per docs). Defaulting to the more conservative free-tier numbers; the adaptive
// RateLimiter.observe() self-corrects from live x-rate-limit-minute headers.
const DEFAULT_SEARCH_RATE_LIMIT = 50;
const DEFAULT_ENRICH_RATE_LIMIT = 20;
const DEFAULT_RATE_WINDOW_MS = 60000;

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, '..', 'data', 'YC_Active_Companies_With_LinkedIn.csv'),
    output: path.join(__dirname, '..', 'results', 'apollo_people_search_benchmark.csv'),
    cache: null,
    provider: DEFAULT_PROVIDER,
    jobTitles: DEFAULT_JOB_TITLES,
    includeSimilarTitles: false,
    resultSize: 100,
    concurrency: 3,
    searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
    enrichRateLimit: DEFAULT_ENRICH_RATE_LIMIT,
    rateWindowMs: DEFAULT_RATE_WINDOW_MS,
    limit: null,
    offset: 0,
    force: false,
    apiKeyStdin: false,
    dryRun: false,
    skipEnrich: false,
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
    } else if (arg === '--include-similar-titles') {
      args.includeSimilarTitles = true;
    } else if (arg === '--result-size') {
      args.resultSize = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '-c' || arg === '--concurrency') {
      args.concurrency = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--search-rate-limit') {
      args.searchRateLimit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--enrich-rate-limit') {
      args.enrichRateLimit = Number.parseInt(next, 10);
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
    } else if (arg === '--skip-enrich') {
      args.skipEnrich = true;
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
  if (!Number.isInteger(args.resultSize) || args.resultSize < 1 || args.resultSize > 100) {
    throw new Error('--result-size must be an integer from 1 to 100 (Apollo per_page max)');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  if (!Number.isInteger(args.searchRateLimit) || args.searchRateLimit < 1) {
    throw new Error('--search-rate-limit must be a positive integer');
  }
  if (!Number.isInteger(args.enrichRateLimit) || args.enrichRateLimit < 1) {
    throw new Error('--enrich-rate-limit must be a positive integer');
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
  APOLLO_API_KEY=... node benchmark_apollo_people_search.js [options]

Options:
  -i, --input <file>          Input CSV. Default: ../data/YC_Active_Companies_With_LinkedIn.csv (relative to this script's own location)
  -o, --output <file>         Output CSV. Default: ../results/apollo_people_search_benchmark.csv (relative to this script's own location)
      --cache <file>          JSONL cache for resumable runs. Default: ../cache/<output-basename>.cache.jsonl
      --provider <name>       Provider label for output rows. Default: apollo
      --job-titles <csv>      Comma-separated job title filters (OR'd) AND the client-side
                              safety filter. Default: "ceo,chief executive,founder"
      --include-similar-titles Apollo's default behavior is to ALSO match "job titles with
                              the same terms" (their docs' example: a search for "marketing
                              manager" can return "content marketing manager"). This script
                              disables that (include_similar_titles:false) by default, since
                              every other provider in this project needed the equivalent
                              fix. Pass this flag to re-enable Apollo's fuzzy default.
      --result-size <n>       "per_page" for search. Default: 100 (Apollo's max).
  -c, --concurrency <n>       Concurrent API calls (in-flight workers). Default: 3
      --search-rate-limit <n> Requests/window for the free search step. Default: 50
                              (Apollo's free-tier number; paid plans allow 200/min —
                              raise this once you know your plan tier).
      --enrich-rate-limit <n> Requests/window for the paid bulk_match step. Default: 20
                              (Apollo's free-tier bulk number; paid plans allow up to
                              1000/min).
      --rate-window-ms <n>    Rate window length in ms. Default: 60000
      --limit <n>             Process only n rows, useful for smoke tests
      --offset <n>            Start after n data rows
      --force                 Refetch rows even if output/cache already has data
      --api-key-stdin         Read Apollo API key from the first stdin line
      --dry-run               Run ONLY the free search step for every row (0 credits,
                              confirmed) and report match counts, without calling
                              bulk_match or writing an output CSV. Genuinely free, unlike
                              PDL's attempted dry-run — Apollo's docs explicitly list
                              search as a 0-credit endpoint.
      --skip-enrich            Like --dry-run but DOES write an output CSV, with
                              raw_returned_count/total_results populated from the free
                              search step but linkedin_profiles left empty (no bulk_match
                              calls made). Useful for a free full-dataset coverage pass
                              before spending any enrichment credits.

CONFIRMED FROM DOCS (not yet extensively live-validated — only ~75 test credits
were available at write time, so bulk_match was validated on a very small sample):
  1. Search (mixed_people/api_search) costs 0 credits — documented explicitly.
  2. Search response is OBFUSCATED: last_name_obfuscated (not full last_name), no
     linkedin_url, no email/phone. Full data requires bulk_match per person.
  3. bulk_match costs 1-9 credits/person: "1 credit for demographics/email; +8 credits
     if mobile phone is returned." This script sets reveal_phone_number:false to stay
     at the 1-credit floor — unconfirmed whether omitting this still avoids the phone
     charge if a phone happens to exist, but explicit false should be the safe choice.
  4. q_organization_domains_list does NOT distinguish current vs. past employer —
     confirmed by docs ("This can be the current employer or a previous employer").
     Unlike Crustdata/PDL, there is no dedicated "current only" filter available. This
     is a structural precision ceiling: some matches may be someone's PAST role at the
     target company, not their current one. The client-side title filter cannot detect
     this since it only checks title text, not employment recency.
  5. include_similar_titles:false is used by default (see above) to avoid Apollo's
     fuzzy title-inclusion behavior, matching the fix needed for Coresignal/Crustdata.
  6. Same client-side strict-substring safety filter as every other provider script:
     keep only people whose enriched title literally contains one of --job-titles.

Given point 4 (no current-employer filter) is a real, unavoidable structural gap,
expect this provider's precision ceiling to be lower than Crustdata/PDL's, which do
support current-employment scoping. Run --dry-run or --skip-enrich first (both free)
to sanity-check match volume before spending any bulk_match credits.
`);
}

function readApiKey(args) {
  if (!args.apiKeyStdin) {
    return Promise.resolve(process.env.APOLLO_API_KEY || '');
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

function makeCacheKey(domain, jobTitles, includeSimilarTitles, resultSize) {
  return `${domain}|${jobTitles.join('+')}|${includeSimilarTitles}|${resultSize}`;
}

function httpRequestJson(url, method, apiKey, body, onHeaders) {
  const requestOptions = {
    method,
    headers: {
      'x-api-key': apiKey,
      accept: 'application/json',
      'Cache-Control': 'no-cache',
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
          const message = (parsed && (parsed.error || parsed.message)) || responseText.slice(0, 240);
          reject(new Error(`HTTP ${res.statusCode}: ${message}`));
          return;
        }

        resolve({ body: parsed, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timed out after 30s'));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function searchPeopleIds(apiKey, domain, jobTitles, includeSimilarTitles, resultSize, rateLimiter) {
  const body = JSON.stringify({
    q_organization_domains_list: [domain],
    person_titles: jobTitles,
    include_similar_titles: includeSimilarTitles,
    per_page: resultSize,
  });

  const { body: parsed, headers } = await httpRequestJson(
    SEARCH_API_URL,
    'POST',
    apiKey,
    body,
    (h, s) => rateLimiter.observe(h, s),
  );

  const people = Array.isArray(parsed?.people) ? parsed.people : [];
  // Confirmed live: total_entries is top-level, not nested under "pagination"
  // (response shape is exactly {total_entries, people}).
  const totalResults = typeof parsed?.total_entries === 'number'
    ? parsed.total_entries
    : people.length;

  return {
    people,
    totalResults,
    rateLimitRemaining: headers['x-minute-requests-left'] || '',
  };
}

async function bulkMatch(apiKey, ids, rateLimiter) {
  const body = JSON.stringify({
    details: ids.map((id) => ({ id })),
    reveal_phone_number: false,
  });

  const { body: parsed, headers } = await httpRequestJson(
    BULK_MATCH_API_URL,
    'POST',
    apiKey,
    body,
    (h, s) => rateLimiter.observe(h, s),
  );

  const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
  return { matches, rateLimitRemaining: headers['x-minute-requests-left'] || '' };
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

async function searchWithRetries(apiKey, domain, jobTitles, includeSimilarTitles, resultSize, rateLimiter, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rateLimiter.acquire();
      return await searchPeopleIds(apiKey, domain, jobTitles, includeSimilarTitles, resultSize, rateLimiter);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(750 * attempt);
    }
  }
  throw lastError;
}

async function bulkMatchWithRetries(apiKey, ids, rateLimiter, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rateLimiter.acquire();
      return await bulkMatch(apiKey, ids, rateLimiter);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(750 * attempt);
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
    const remaining = Number(headers['x-minute-requests-left']);
    const limit = Number(headers['x-rate-limit-minute']);
    const retryAfter = Number(headers['retry-after']);

    if (Number.isFinite(limit) && limit > 0) {
      this.maxRequests = limit;
    }
    if (statusCode === 429 || (Number.isFinite(remaining) && remaining <= 0)) {
      const waitMs = (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000 + 250;
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

async function fetchCompanyPeople(apiKey, domain, jobTitles, includeSimilarTitles, resultSize, searchRateLimiter, enrichRateLimiter, skipEnrich) {
  const { people: rawPeople, totalResults } = await searchWithRetries(
    apiKey, domain, jobTitles, includeSimilarTitles, resultSize, searchRateLimiter,
  );

  if (skipEnrich || rawPeople.length === 0) {
    return {
      total_results: totalResults,
      raw_returned_count: rawPeople.length,
      returned_count: 0,
      linkedin_profile_count: 0,
      linkedin_profiles: '',
      enrichment_skipped: skipEnrich ? 'true' : '',
    };
  }

  const ids = rawPeople.map((p) => p.id).filter(Boolean);
  const collected = [];
  for (let i = 0; i < ids.length; i += BULK_MATCH_BATCH_SIZE) {
    const batch = ids.slice(i, i + BULK_MATCH_BATCH_SIZE);
    const { matches } = await bulkMatchWithRetries(apiKey, batch, enrichRateLimiter);
    for (const person of matches) {
      collected.push({
        title: person.title || '',
        linkedin: extractLinkedInProfile(person),
      });
    }
  }

  const matched = collected.filter((c) => titleMatchesAny(c.title, jobTitles));
  const linkedinProfiles = uniqueStrings(matched.map((c) => c.linkedin).filter(Boolean));

  return {
    total_results: totalResults,
    raw_returned_count: rawPeople.length,
    returned_count: matched.length,
    linkedin_profile_count: linkedinProfiles.length,
    linkedin_profiles: linkedinProfiles.join('; '),
    enrichment_skipped: '',
  };
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
    include_similar_titles: String(args.includeSimilarTitles),
    result_size: args.resultSize,
    total_results: result.total_results ?? '',
    raw_returned_count: result.raw_returned_count ?? '',
    returned_count: result.returned_count ?? '',
    enrichment_skipped: result.enrichment_skipped || '',
    linkedin_profile_count: result.linkedin_profile_count ?? '',
    linkedin_profiles: result.linkedin_profiles || '',
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
  console.log(`Rows to search (dry run, search only, confirmed 0 credits): ${selected.length}`);

  const apiKey = await readApiKey(args);
  if (!apiKey) {
    throw new Error('Set APOLLO_API_KEY or pass --api-key-stdin before running this script.');
  }

  const searchRateLimiter = new RateLimiter({ maxRequests: args.searchRateLimit, windowMs: args.rateWindowMs });
  let totalMatches = 0;
  let zeroMatchRows = 0;
  let completed = 0;
  let failed = 0;

  await runPool(selected, args.concurrency, async (task) => {
    try {
      const { totalResults } = await searchWithRetries(apiKey, task.domain, args.jobTitles, args.includeSimilarTitles, args.resultSize, searchRateLimiter);
      totalMatches += totalResults;
      if (totalResults === 0) zeroMatchRows += 1;
      completed += 1;
      console.log(`[${completed + failed}/${selected.length}] ${task.domain} -> ${totalResults} total matches (running total: ${totalMatches})`);
    } catch (error) {
      failed += 1;
      console.error(`[${completed + failed}/${selected.length}] ${task.domain} failed: ${error.message}`);
    }
  });

  console.log('');
  console.log('=== DRY RUN SUMMARY (search step only, 0 credits per docs) ===');
  console.log(`Rows searched: ${completed} ok, ${failed} failed`);
  console.log(`Zero-match rows: ${zeroMatchRows}`);
  console.log(`Total matched people (pre-enrichment, pre-safety-filter): ${totalMatches}`);
  console.log(`Avg matches/row: ${(totalMatches / (completed || 1)).toFixed(3)}`);
  console.log(`If every matched person needs 1 credit to enrich (phone reveal off), a full run would cost roughly ${totalMatches} credits minimum (could be less after the client-side safety filter, but bulk_match must be called before that filter can run).`);
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

    const cacheKey = makeCacheKey(domain, args.jobTitles, args.includeSimilarTitles, args.resultSize);
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
  console.log(`Search rate limit: ${args.searchRateLimit}/${args.rateWindowMs}ms | Enrich rate limit: ${args.enrichRateLimit}/${args.rateWindowMs}ms`);
  if (tasks.length > 0 && !args.skipEnrich) {
    console.log('WARNING: search is free but bulk_match costs 1-9 credits per matched person (1 with phone reveal off). Cost scales with match count.');
  }
  if (args.skipEnrich) {
    console.log('--skip-enrich set: only the free search step will run, linkedin_profiles will be empty.');
  }

  let apiKey = '';
  if (tasks.length > 0) {
    apiKey = await readApiKey(args);
    if (!apiKey) {
      throw new Error('Set APOLLO_API_KEY or pass --api-key-stdin before running this script.');
    }
  }

  const searchRateLimiter = new RateLimiter({ maxRequests: args.searchRateLimit, windowMs: args.rateWindowMs });
  const enrichRateLimiter = new RateLimiter({ maxRequests: args.enrichRateLimit, windowMs: args.rateWindowMs });
  let completed = 0;
  let failed = 0;

  await runPool(tasks, args.concurrency, async (task) => {
    try {
      const result = await fetchCompanyPeople(
        apiKey,
        task.source.domain,
        args.jobTitles,
        args.includeSimilarTitles,
        args.resultSize,
        searchRateLimiter,
        enrichRateLimiter,
        args.skipEnrich,
      );
      outputByRow.set(task.rowIndex, buildOutputRecord(task.source, args, result));
      appendCache(args.cache, {
        cacheKey: task.cacheKey,
        domain: task.source.domain,
        jobTitles: args.jobTitles,
        includeSimilarTitles: args.includeSimilarTitles,
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
        includeSimilarTitles: args.includeSimilarTitles,
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
    'include_similar_titles',
    'result_size',
    'total_results',
    'raw_returned_count',
    'returned_count',
    'enrichment_skipped',
    'linkedin_profile_count',
    'linkedin_profiles',
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
