const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const path = require('path');

const API_URL = 'https://api.companyenrich.com/people/search/scroll';
const DEFAULT_PROVIDER = 'companyenrich';
const CACHE_KEY_VERSION = 'all-raw-results-v4';
const CACHE_SCHEMA_VERSION = 'companyenrich-people-search-cache-v4';
const CANDIDATE_SCHEMA_VERSION = 'companyenrich-people-search-candidate-v1';

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, '..', 'data', 'YC_Active_Companies_With_LinkedIn.csv'),
    output: path.join(__dirname, '..', 'results', 'companyenrich_people_search_benchmark.csv'),
    candidatesOutput: null,
    cache: null,
    provider: DEFAULT_PROVIDER,
    department: '', // no server-side filter by default; positionQuery supplies the title match
    positionQuery: ['ceo', 'chief executive', 'founder'],
    pageSize: 100,
    concurrency: 5,
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
    } else if (arg === '--candidates-output') {
      args.candidatesOutput = next;
      i += 1;
    } else if (arg === '--provider') {
      args.provider = next;
      i += 1;
    } else if (arg === '--department') {
      args.department = next;
      i += 1;
    } else if (arg === '--position-query') {
      args.positionQuery = next.split(',').map((value) => value.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--page-size') {
      args.pageSize = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--concurrency' || arg === '-c') {
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
    } else if (arg === '--api-key-stdin') {
      args.apiKeyStdin = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 100) {
    throw new Error('--page-size must be an integer from 1 to 100');
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

  args.cache = args.cache || path.join(__dirname, '..', 'cache', `${path.basename(args.output)}.cache.jsonl`);
  if (!args.candidatesOutput) {
    const parsedOutput = path.parse(args.output);
    args.candidatesOutput = path.join(parsedOutput.dir, `${parsedOutput.name}.candidates.jsonl`);
  }
  fs.mkdirSync(path.dirname(args.cache), { recursive: true });
  return args;
}

function printUsage() {
  console.log(`Usage:
  COMPANYENRICH_API_KEY=... node benchmark_companyenrich_people_search.js [options]

Options:
  -i, --input <file>        Input CSV. Default: ../data/YC_Active_Companies_With_LinkedIn.csv (relative to this script's own location)
  -o, --output <file>       Output CSV. Default: ../results/companyenrich_people_search_benchmark.csv (relative to this script's own location)
      --cache <file>        JSONL cache for resumable runs. Default: ../cache/<output-basename>.cache.jsonl
      --candidates-output <file>
                            Candidate-level JSONL sidecar. Default: <output-basename>.candidates.jsonl
      --provider <name>     Provider label for output rows. Default: companyenrich
      --department <value>  Optional server-side department filter. Empty means omit.
                              It is not used for client-side result acceptance.
      --position-query <csv> Comma-separated positionQuery terms. Default: "ceo,chief executive,founder"
      --page-size <n>       API pageSize. Default: 100 (matches the 100-result cap used
                            by the other provider runners)
  -c, --concurrency <n>     Concurrent API calls. Default: 5
      --limit <n>           Process only n rows, useful for smoke tests
      --offset <n>          Start after n data rows
      --force               Refetch rows even if output/cache already has data
      --api-key-stdin       Read CompanyEnrich API key from the first stdin line
`);
}

function readApiKey(args) {
  if (!args.apiKeyStdin) {
    return Promise.resolve(process.env.COMPANYENRICH_API_KEY || '');
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

function makeCacheKey(domain, department, positionQuery, pageSize) {
  return `${CACHE_KEY_VERSION}|${domain}|${department}|${positionQuery.join('+')}|${pageSize}`;
}

function searchPeople(apiKey, domain, department, positionQuery, pageSize) {
  const body = JSON.stringify({
    domains: [domain],
    ...(department ? { department: [department] } : {}),
    positionQuery,
    pageSize,
  });

  const requestOptions = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
          const message = parsed.error || parsed.message || responseText.slice(0, 240);
          reject(new Error(`HTTP ${res.statusCode}: ${message}`));
          return;
        }

        resolve(summarizePeopleResponse(parsed, res.headers));
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractPeople(response) {
  const candidates = [
    response.people,
    response.results,
    response.items,
    response.data,
    response.data && response.data.people,
    response.data && response.data.results,
    response.data && response.data.items,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function hasMatchedExperience(person) {
  const experiences = Array.isArray(person.experiences) ? person.experiences : [];
  return experiences.some((exp) => exp.isMatched === true);
}

function selectPeopleForBenchmark(rawPeople) {
  return Array.isArray(rawPeople) ? rawPeople : [];
}

function summarizePeopleResponse(response, headers = {}) {
  const rawPeople = extractPeople(response);
  // Evaluate every person returned for the requested domain/title query.
  // Provider-derived fields such as isMatched and department must not decide
  // which claims enter the benchmark; Harvest independently verifies the
  // person's current company and title later.
  const people = selectPeopleForBenchmark(rawPeople);
  const linkedinProfiles = uniqueStrings(people.map(extractLinkedInProfile).filter(Boolean));

  return {
    total_results: extractTotalResults(response, rawPeople.length),
    raw_returned_count: rawPeople.length,
    returned_count: people.length,
    provider_matched_count: people.filter((person) => hasMatchedExperience(person)).length,
    linkedin_profile_count: linkedinProfiles.length,
    linkedin_profiles: linkedinProfiles.join('; '),
    credit_cost: headers['x-credit-cost'] || '',
    credit_remaining: headers['x-credit-remaining'] || '',
    rate_limit_remaining: headers['x-ratelimit-remaining'] || '',
  };
}

function extractTotalResults(response, fallback) {
  const candidates = [
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

async function searchWithRetries(apiKey, domain, department, positionQuery, pageSize, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await searchPeople(apiKey, domain, department, positionQuery, pageSize);
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
    department: args.department,
    position_query: args.positionQuery.join('|'),
    page_size: args.pageSize,
    total_results: result.total_results ?? '',
    raw_returned_count: result.raw_returned_count ?? '',
    returned_count: result.returned_count ?? '',
    provider_matched_count: result.provider_matched_count ?? '',
    linkedin_profile_count: result.linkedin_profile_count ?? '',
    linkedin_profiles: result.linkedin_profiles || '',
    credit_cost: result.credit_cost || '',
    credit_remaining: result.credit_remaining || '',
    rate_limit_remaining: result.rate_limit_remaining || '',
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

    const cacheKey = makeCacheKey(domain, args.department, args.positionQuery, args.pageSize);
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

  let apiKey = '';
  if (tasks.length > 0) {
    apiKey = await readApiKey(args);
    if (!apiKey) {
      throw new Error('Set COMPANYENRICH_API_KEY or pass --api-key-stdin before running this script.');
    }
  }

  let completed = 0;
  let failed = 0;

  await runPool(tasks, args.concurrency, async (task) => {
    try {
      const result = await searchWithRetries(apiKey, task.source.domain, args.department, args.positionQuery, args.pageSize);
      outputByRow.set(task.rowIndex, buildOutputRecord(task.source, args, result));
      appendCache(args.cache, {
        cacheKey: task.cacheKey,
        domain: task.source.domain,
        department: args.department,
        positionQuery: args.positionQuery,
        pageSize: args.pageSize,
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
        department: args.department,
        positionQuery: args.positionQuery,
        pageSize: args.pageSize,
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
    'department',
    'position_query',
    'page_size',
    'total_results',
    'raw_returned_count',
    'returned_count',
    'provider_matched_count',
    'linkedin_profile_count',
    'linkedin_profiles',
    'credit_cost',
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

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  hasMatchedExperience,
  makeCacheKey,
  selectPeopleForBenchmark,
  summarizePeopleResponse,
};
