const fs = require('fs');
const https = require('https');
const path = require('path');

// Single-step flow — linkedin_url comes back directly in search results.
// Confirmed live:
//   - POST /api/v2/people/search, 0.25 credits per person actually returned
//     (confirmed via response metadata.credits and account balance delta:
//     3 people -> 0.75 credits, 2 people -> 0.5 credits). Zero-result queries
//     cost 0 credits (confirmed: metadata.credits: 0).
//   - Direct domain filter (current_company_domains, exact_match:true) is
//     supported natively — unlike Wiza, no company-name-collision problem.
//   - current_position_titles with exact_match:false did NOT show over-matching
//     in testing (checked against a company with a known CFO/COO — they did not
//     appear in results), so no scattered-token false-positive issue was found
//     the way it was for Coresignal/Crustdata's default fuzzy operators. The
//     client-side strict-substring safety filter is still applied as a
//     consistent backstop across all providers in this project regardless.
//   - Rate limit: 60 API calls/minute, confirmed in docs, applies across all
//     FullEnrich endpoints.
const API_URL = 'https://app.fullenrich.com/api/v2/people/search';
const DEFAULT_PROVIDER = 'fullenrich';
const DEFAULT_JOB_TITLES = ['ceo', 'chief executive', 'founder'];
const DEFAULT_RATE_LIMIT = 60; // confirmed: 60/min across all endpoints
const DEFAULT_RATE_WINDOW_MS = 60000;

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, '..', 'data', 'YC_Active_Companies_With_LinkedIn.csv'),
    output: path.join(__dirname, '..', 'results', 'fullenrich_people_search_benchmark.csv'),
    cache: null,
    provider: DEFAULT_PROVIDER,
    jobTitles: DEFAULT_JOB_TITLES,
    exactMatchDomain: true,
    exactMatchTitle: false,
    resultSize: 100, // confirmed max per docs
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
    } else if (arg === '--exact-match-title') {
      args.exactMatchTitle = true;
    } else if (arg === '--no-exact-match-domain') {
      args.exactMatchDomain = false;
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
  if (!Number.isInteger(args.resultSize) || args.resultSize < 1 || args.resultSize > 100) {
    throw new Error('--result-size must be an integer from 1 to 100 (FullEnrich max)');
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
  FULLENRICH_API_KEY=... node benchmark_fullenrich_people_search.js [options]

Options:
  -i, --input <file>          Input CSV. Default: ../data/YC_Active_Companies_With_LinkedIn.csv (relative to this script's own location)
  -o, --output <file>         Output CSV. Default: ../results/fullenrich_people_search_benchmark.csv (relative to this script's own location)
      --cache <file>          JSONL cache for resumable runs. Default: ../cache/<output-basename>.cache.jsonl
      --provider <name>       Provider label for output rows. Default: fullenrich
      --job-titles <csv>      Comma-separated job title filters (OR'd) AND the client-side
                              safety filter. Default: "ceo,chief executive,founder"
      --exact-match-title     Set exact_match:true on current_position_titles (default
                              false — loose matching was tested and did NOT show
                              over-matching, unlike other providers' fuzzy defaults).
      --no-exact-match-domain Disable exact_match on current_company_domains (default
                              true — exact domain matching, confirmed working).
      --result-size <n>       "limit" field in the request. Default: 100 (FullEnrich max).
  -c, --concurrency <n>       Concurrent API calls (in-flight workers). Default: 3
      --rate-limit <n>        Requests allowed per rate window. Default: 60 (confirmed:
                              60 API calls/minute across ALL FullEnrich endpoints).
      --rate-window-ms <n>    Rate window length in ms. Default: 60000
      --limit <n>             Process only n rows, useful for smoke tests
      --offset <n>            Start after n data rows
      --force                 Refetch rows even if output/cache already has data
      --api-key-stdin         Read FullEnrich API key from the first stdin line
      --dry-run               Run the search step for every row and report match counts
                              without writing an output CSV. NOT free (0.25 credits per
                              raw result, confirmed) — a lower-cost preview, not a
                              genuinely free one.

CONFIRMED FROM LIVE TESTING:
  1. Billing: 0.25 credits per person actually returned (confirmed via response
     metadata.credits and account balance deltas). Zero-result queries cost 0.
  2. current_company_domains with exact_match:true works correctly and precisely —
     unlike Wiza, this API has a REAL domain filter, no company-name-collision
     problem observed.
  3. current_position_titles with exact_match:false did not show over-matching in
     testing (a company with a known CFO/COO did not have them appear in CEO/
     founder search results) — cleaner default behavior than most other providers
     in this project. The client-side strict-substring safety filter is still
     applied as a consistent backstop.
  4. Rate limit: 60 calls/minute, confirmed in docs, across all endpoints (not just
     Search) — keep this in mind if running other FullEnrich tools concurrently.
  5. GET https://app.fullenrich.com/api/v2/account/credits returns {"balance": N}
     for checking remaining credits — not used by this script automatically, but
     useful to check manually before/after large runs.
`);
}

function readApiKey(args) {
  if (!args.apiKeyStdin) {
    return Promise.resolve(process.env.FULLENRICH_API_KEY || '');
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

function makeCacheKey(domain, jobTitles, exactMatchDomain, exactMatchTitle, resultSize) {
  return `${domain}|${jobTitles.join('+')}|${exactMatchDomain}|${exactMatchTitle}|${resultSize}`;
}

function httpRequestJson(url, method, apiKey, body, onHeaders) {
  const requestOptions = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

async function searchPeople(apiKey, domain, jobTitles, exactMatchDomain, exactMatchTitle, resultSize, rateLimiter) {
  const body = JSON.stringify({
    limit: resultSize,
    current_company_domains: [{ value: domain, exact_match: exactMatchDomain, exclude: false }],
    current_position_titles: jobTitles.map((title) => ({ value: title, exact_match: exactMatchTitle, exclude: false })),
  });

  const { body: parsed } = await httpRequestJson(
    API_URL,
    'POST',
    apiKey,
    body,
    (h, s) => rateLimiter.observe(h, s),
  );

  const rawPeople = Array.isArray(parsed?.people) ? parsed.people : [];
  const people = rawPeople.filter((p) => titleMatchesAny(getCurrentTitle(p), jobTitles));
  const linkedinProfiles = uniqueStrings(people.map(extractLinkedInProfile).filter(Boolean));
  const totalResults = typeof parsed?.metadata?.total === 'number' ? parsed.metadata.total : rawPeople.length;

  return {
    total_results: totalResults,
    raw_returned_count: rawPeople.length,
    returned_count: people.length,
    linkedin_profile_count: linkedinProfiles.length,
    linkedin_profiles: linkedinProfiles.join('; '),
    credits_used: parsed?.metadata?.credits ?? '',
  };
}

function getCurrentTitle(person) {
  return person?.employment?.current?.title || '';
}

function titleMatchesAny(title, jobTitles) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  return jobTitles.some((keyword) => t.includes(keyword.toLowerCase()));
}

function extractLinkedInProfile(person) {
  const value = person?.social_profiles?.professional_network?.url;
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

async function searchWithRetries(apiKey, domain, jobTitles, exactMatchDomain, exactMatchTitle, resultSize, rateLimiter, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rateLimiter.acquire();
      return await searchPeople(apiKey, domain, jobTitles, exactMatchDomain, exactMatchTitle, resultSize, rateLimiter);
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
    const retryAfter = Number(headers['retry-after']);
    if (statusCode === 429) {
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

function buildOutputRecord(source, args, result) {
  return {
    provider: args.provider,
    slug: source.slug || '',
    company_name: source.company_name || '',
    domain: source.domain || '',
    company_website: source.company_website || '',
    company_linkedin_url: source.company_linkedin_url || '',
    job_titles: args.jobTitles.join('|'),
    exact_match_domain: String(args.exactMatchDomain),
    exact_match_title: String(args.exactMatchTitle),
    result_size: args.resultSize,
    total_results: result.total_results ?? '',
    raw_returned_count: result.raw_returned_count ?? '',
    returned_count: result.returned_count ?? '',
    linkedin_profile_count: result.linkedin_profile_count ?? '',
    linkedin_profiles: result.linkedin_profiles || '',
    credits_used: result.credits_used ?? '',
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
  console.log(`Rows to search (dry run — NOT free, 0.25 credits/raw result): ${selected.length}`);

  const apiKey = await readApiKey(args);
  if (!apiKey) {
    throw new Error('Set FULLENRICH_API_KEY or pass --api-key-stdin before running this script.');
  }

  const rateLimiter = new RateLimiter({ maxRequests: args.rateLimit, windowMs: args.rateWindowMs });
  let totalRaw = 0;
  let totalMatched = 0;
  let zeroMatchRows = 0;
  let completed = 0;
  let failed = 0;

  await runPool(selected, args.concurrency, async (task) => {
    try {
      const result = await searchWithRetries(apiKey, task.domain, args.jobTitles, args.exactMatchDomain, args.exactMatchTitle, args.resultSize, rateLimiter);
      totalRaw += result.raw_returned_count;
      totalMatched += result.returned_count;
      if (result.returned_count === 0) zeroMatchRows += 1;
      completed += 1;
      console.log(`[${completed + failed}/${selected.length}] ${task.domain} -> ${result.returned_count} matched / ${result.raw_returned_count} raw (running matched total: ${totalMatched})`);
    } catch (error) {
      failed += 1;
      console.error(`[${completed + failed}/${selected.length}] ${task.domain} failed: ${error.message}`);
    }
  });

  console.log('');
  console.log('=== DRY RUN SUMMARY ===');
  console.log(`Rows searched: ${completed} ok, ${failed} failed`);
  console.log(`Zero-match rows: ${zeroMatchRows}`);
  console.log(`Total raw profiles returned (billed): ${totalRaw}`);
  console.log(`Total matched (post title-safety-filter): ${totalMatched}`);
  console.log(`Estimated credits for this run: ${(totalRaw * 0.25).toFixed(2)}`);
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

    const cacheKey = makeCacheKey(domain, args.jobTitles, args.exactMatchDomain, args.exactMatchTitle, args.resultSize);
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
  console.log(`Rate limit: ${args.rateLimit} requests / ${args.rateWindowMs}ms`);
  if (tasks.length > 0) {
    console.log('WARNING: 0.25 credits per raw profile returned (confirmed live).');
  }

  let apiKey = '';
  if (tasks.length > 0) {
    apiKey = await readApiKey(args);
    if (!apiKey) {
      throw new Error('Set FULLENRICH_API_KEY or pass --api-key-stdin before running this script.');
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
        args.exactMatchDomain,
        args.exactMatchTitle,
        args.resultSize,
        rateLimiter,
      );
      outputByRow.set(task.rowIndex, buildOutputRecord(task.source, args, result));
      appendCache(args.cache, {
        cacheKey: task.cacheKey,
        domain: task.source.domain,
        jobTitles: args.jobTitles,
        exactMatchDomain: args.exactMatchDomain,
        exactMatchTitle: args.exactMatchTitle,
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
        exactMatchDomain: args.exactMatchDomain,
        exactMatchTitle: args.exactMatchTitle,
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
    'exact_match_domain',
    'exact_match_title',
    'result_size',
    'total_results',
    'raw_returned_count',
    'returned_count',
    'linkedin_profile_count',
    'linkedin_profiles',
    'credits_used',
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
