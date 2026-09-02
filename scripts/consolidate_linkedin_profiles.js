const fs = require('fs');
const path = require('path');

const INPUT_FILES = [
  'companyenrich_people_search_benchmark.csv',
  'prospeo_people_search_benchmark.csv',
  'crustdata_people_search_benchmark.csv',
  'coresignal_people_search_benchmark.csv',
  'pdl_people_search_benchmark.csv',
  'apollo_people_search_benchmark.csv',
  'fullenrich_people_search_benchmark.csv',
];

function parseArgs(argv) {
  const args = {
    output: path.join(__dirname, '..', 'results', 'all_linkedin_profiles.csv'),
    inputDir: path.join(__dirname, '..', 'results'),
    providers: [],
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--output' || arg === '-o') {
      args.output = next;
      i += 1;
    } else if (arg === '--input-dir') {
      args.inputDir = next;
      i += 1;
    } else if (arg === '--provider') {
      args.providers.push(String(next || '').trim().toLowerCase());
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node consolidate_linkedin_profiles.js [--output <file>] [--input-dir <dir>] [--provider <name>]
Merges linkedin_profiles from every provider's *_people_search_benchmark.csv
(default: ../results relative to this script) into one deduplicated CSV: one
row per unique (domain, linkedin_url) pair, with a providers column listing
which provider(s) independently found that person. Repeat --provider to select
specific providers.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
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

// Providers disagree on URL formatting (protocol, www., trailing slash) —
// normalize before dedup so the same person from different providers merges
// into one row instead of showing up twice.
function normalizeLinkedInUrl(raw) {
  let u = String(raw || '').trim().toLowerCase();
  if (!u) return '';
  u = u.replace(/^https?:\/\//, '');
  u = u.replace(/^www\./, '');
  u = u.replace(/\/$/, '');
  return u;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const selectedProviders = new Set(args.providers);
  const knownProviders = new Set(INPUT_FILES.map((fileName) => fileName.split('_')[0]));
  const unknownProviders = [...selectedProviders].filter((provider) => !knownProviders.has(provider));
  if (unknownProviders.length > 0) {
    throw new Error(`Unknown provider(s): ${unknownProviders.join(', ')}.`);
  }

  // Map: domain -> Map: normalizedUrl -> { originalUrl, providers: Set, companyName, companyWebsite, companyLinkedinUrl }
  const byDomain = new Map();

  for (const fileName of INPUT_FILES) {
    const fileProvider = fileName.split('_')[0];
    if (selectedProviders.size > 0 && !selectedProviders.has(fileProvider)) continue;
    const filePath = path.join(args.inputDir, fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`Skipping missing file: ${filePath}`);
      continue;
    }

    const records = readCsv(filePath);
    let rowCount = 0;
    let profileCount = 0;

    for (const record of records) {
      const domain = record.domain;
      if (!domain) continue;
      const provider = record.provider || path.basename(fileName, '.csv');
      const rawProfiles = (record.linkedin_profiles || '').split(';').map((p) => p.trim()).filter(Boolean);
      if (rawProfiles.length === 0) continue;

      rowCount += 1;
      if (!byDomain.has(domain)) byDomain.set(domain, new Map());
      const domainMap = byDomain.get(domain);

      for (const rawUrl of rawProfiles) {
        const normalized = normalizeLinkedInUrl(rawUrl);
        if (!normalized) continue;
        profileCount += 1;

        if (!domainMap.has(normalized)) {
          domainMap.set(normalized, {
            originalUrl: rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`,
            providers: new Set(),
            companyName: record.company_name || '',
            companyWebsite: record.company_website || '',
            companyLinkedinUrl: record.company_linkedin_url || '',
          });
        }
        domainMap.get(normalized).providers.add(provider);
      }
    }

    console.log(`${fileName}: ${rowCount} companies with profiles, ${profileCount} profile mentions`);
  }

  const outputRows = [];
  for (const [domain, domainMap] of byDomain.entries()) {
    for (const [, info] of domainMap.entries()) {
      const providers = Array.from(info.providers).sort();
      outputRows.push({
        domain,
        company_name: info.companyName,
        company_website: info.companyWebsite,
        company_linkedin_url: info.companyLinkedinUrl,
        linkedin_url: info.originalUrl,
        providers: providers.join('|'),
        provider_count: providers.length,
      });
    }
  }

  // Stable, readable ordering: by domain, then by descending provider_count
  // (most cross-validated people first), then alphabetically by URL.
  outputRows.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    if (a.provider_count !== b.provider_count) return b.provider_count - a.provider_count;
    return a.linkedin_url < b.linkedin_url ? -1 : 1;
  });

  // A person can legitimately appear against more than one target domain (for
  // example, after a company rebrand). The Harvest input contains only a URL
  // column, so deduplicate globally as well to avoid fetching the same profile
  // more than once under different domain keys.
  const uniqueByProfile = new Map();
  for (const row of outputRows) {
    const normalized = normalizeLinkedInUrl(row.linkedin_url);
    if (!uniqueByProfile.has(normalized)) {
      uniqueByProfile.set(normalized, {
        ...row,
        providers: new Set(row.providers.split('|').filter(Boolean)),
      });
      continue;
    }
    const existing = uniqueByProfile.get(normalized);
    for (const provider of row.providers.split('|').filter(Boolean)) {
      existing.providers.add(provider);
    }
  }

  const uniqueOutputRows = Array.from(uniqueByProfile.values()).map((row) => ({
    ...row,
    providers: Array.from(row.providers).sort().join('|'),
    provider_count: row.providers.size,
  }));

  const outputHeaders = ['linkedin_url'];

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, stringifyCsv(outputHeaders, uniqueOutputRows));

  const uniqueCompanies = byDomain.size;
  const uniquePeople = uniqueOutputRows.length;
  const multiProviderPeople = uniqueOutputRows.filter((r) => r.provider_count > 1).length;

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Companies with at least one found profile: ${uniqueCompanies}`);
  console.log(`Unique LinkedIn profiles across all providers: ${uniquePeople}`);
  console.log(`Profiles confirmed by 2+ providers: ${multiProviderPeople} (${(multiProviderPeople / uniquePeople * 100).toFixed(1)}%)`);
  console.log(`Wrote: ${args.output}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = { main, normalizeLinkedInUrl, parseArgs };
