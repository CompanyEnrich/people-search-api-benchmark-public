#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_COHORT = path.join(PROJECT_ROOT, 'data', 'YC_Active_Companies_With_LinkedIn.csv');
const DEFAULT_RESULTS_DIR = path.join(PROJECT_ROOT, 'results');
const DEFAULT_HARVEST = path.join(DEFAULT_RESULTS_DIR, 'harvestapi_full_profiles.json');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'comparison');
const RESULT_FILE_PATTERN = /^(.+)_people_search_benchmark\.csv$/;
const PRESENT_MARKERS = new Set(['present', 'current', 'now']);
const CREDIT_PRICES_USD = Object.freeze({
  apollo: 0.016,
  companyenrich: 0.0011,
  coresignal: 0.014,
  crustdata: 0.30,
  fullenrich: 0.05,
  pdl: 0.28,
  prospeo: 0.015,
});

function parseArgs(argv) {
  const args = {
    cohort: DEFAULT_COHORT,
    resultsDir: DEFAULT_RESULTS_DIR,
    harvest: DEFAULT_HARVEST,
    outputDir: DEFAULT_OUTPUT_DIR,
    providers: [],
  };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--cohort') {
      args.cohort = path.resolve(next);
      index += 1;
    } else if (argument === '--results-dir') {
      args.resultsDir = path.resolve(next);
      index += 1;
    } else if (argument === '--harvest') {
      args.harvest = path.resolve(next);
      index += 1;
    } else if (argument === '--output-dir' || argument === '-o') {
      args.outputDir = path.resolve(next);
      index += 1;
    } else if (argument === '--provider') {
      args.providers.push(String(next || '').trim().toLowerCase());
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/compare_people_search_with_harvest.js [options]

Compares provider people-search benchmark results against Harvest full-profile
data. The script makes no API calls and does not modify source results.

Options:
  --cohort <csv>          Target-company cohort CSV
  --results-dir <dir>     Directory containing *_people_search_benchmark.csv
  --harvest <json>        Harvest full-profile JSON keyed by LinkedIn URL
  -o, --output-dir <dir>  Output directory. Default: ../comparison
  --provider <name>       Include one provider; repeat to select several
  -h, --help              Show this help

Outputs:
  provider_scorecard.json, candidate_verdicts.jsonl, ambiguous_candidates.csv,
  unverified_candidates.csv, and report.md
`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }

  if (inQuotes) throw new Error('Malformed CSV: unclosed quoted field.');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCsvRecords(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((header, index) => (
    index === 0 ? String(header || '').replace(/^\uFEFF/, '').trim() : String(header || '').trim()
  ));
  if (new Set(headers).size !== headers.length) {
    throw new Error(`Duplicate CSV headers: ${filePath}`);
  }
  const records = rows
    .slice(1)
    .filter((candidateRow) => candidateRow.some((value) => String(value || '').trim()))
    .map((candidateRow, rowIndex) => {
      if (candidateRow.length > headers.length) {
        throw new Error(`${filePath}: row ${rowIndex + 2} has too many fields.`);
      }
      return Object.fromEntries(headers.map((header, index) => [header, candidateRow[index] || '']));
    });
  return { headers, records };
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').trim();
}

function normalizeLinkedInPersonUrl(rawValue) {
  const raw = normalizeText(rawValue);
  if (!raw) return '';
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return '';
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments[0].toLowerCase() !== 'in') return '';
    let slug;
    try {
      slug = decodeURIComponent(segments[1]);
    } catch (_error) {
      slug = segments[1];
    }
    return `linkedin.com/in/${slug.normalize('NFC').toLowerCase()}`;
  } catch (_error) {
    return '';
  }
}

function normalizeLinkedInCompanyUrl(rawValue) {
  const raw = normalizeText(rawValue);
  if (!raw) return '';
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return '';
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments[0].toLowerCase() !== 'company') return '';
    let slug;
    try {
      slug = decodeURIComponent(segments[1]);
    } catch (_error) {
      slug = segments[1];
    }
    return `linkedin.com/company/${slug.normalize('NFC').toLowerCase()}`;
  } catch (_error) {
    return '';
  }
}

function companySlugFromUrl(rawValue) {
  return normalizeLinkedInCompanyUrl(rawValue).split('/')[2] || '';
}

function normalizeCompanyName(rawValue) {
  return normalizeText(rawValue)
    .toLowerCase()
    .replace(/\(\s*yc\s+[^)]*\)/gi, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(incorporated|inc|limited|ltd|llc|corp|corporation|company|co)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeTitle(rawValue) {
  return normalizeText(rawValue)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[‐‑‒–—-]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyTitle(rawTitle) {
  const normalized = normalizeTitle(rawTitle);
  if (!normalized) return { qualifies: false, category: '', normalized };

  const excludedContext = [
    /\b(former|previous|past)\b/,
    /\bex\s+(ceo|chief executive|founder|co founder|cofounder)\b/,
    /\b(assistant|advisor|adviser|chief of staff|partner)\s+(to|of)\s+(the\s+)?(ceo|chief executive|founder)\b/,
    /\b(ceo|chief executive|founder)\s+(office|associate|assistant|advisor|adviser)\b/,
  ];
  if (excludedContext.some((pattern) => pattern.test(normalized))) {
    return { qualifies: false, category: '', normalized };
  }

  const ceo = /\bceo\b|\bchief executive(?: officer)?\b/.test(normalized);
  const founder = /\b(founder|co\s*founder|cofounder|fundador|fundadora|fondateur|fondatrice|mitgrunder|grunder|fondatore|fondatrice|kurucu|oprichter)\b/.test(normalized);
  return {
    qualifies: ceo || founder,
    category: ceo && founder ? 'ceo_founder' : ceo ? 'ceo' : founder ? 'founder' : '',
    normalized,
  };
}

function normalizeRole(role) {
  return {
    title: normalizeText(role?.position || role?.title),
    companyName: normalizeText(role?.companyName || role?.company_name),
    companyLinkedInUrl: normalizeText(role?.companyLinkedinUrl || role?.companyLinkedInUrl),
    companyId: normalizeText(role?.companyId || role?.company_id),
    companyUniversalName: normalizeText(role?.companyUniversalName || role?.company_universal_name),
    startDate: role?.startDate || null,
    endDate: role?.endDate || null,
  };
}

function roleKey(role) {
  return [
    normalizeTitle(role.title),
    normalizeCompanyName(role.companyName),
    normalizeLinkedInCompanyUrl(role.companyLinkedInUrl),
    role.companyId,
    normalizeText(role.endDate?.text).toLowerCase(),
  ].join('|');
}

function classifyRoles(profile) {
  const current = [];
  const historical = [];
  const uncertain = [];
  const currentKeys = new Set();

  for (const rawRole of Array.isArray(profile?.currentPosition) ? profile.currentPosition : []) {
    const role = normalizeRole(rawRole);
    const key = roleKey(role);
    if (!currentKeys.has(key)) {
      current.push(role);
      currentKeys.add(key);
    }
  }

  for (const rawRole of Array.isArray(profile?.experience) ? profile.experience : []) {
    const role = normalizeRole(rawRole);
    const key = roleKey(role);
    const endText = normalizeText(role.endDate?.text).toLowerCase();
    if (PRESENT_MARKERS.has(endText)) {
      if (!currentKeys.has(key)) {
        current.push(role);
        currentKeys.add(key);
      }
    } else if (role.endDate && (endText || role.endDate.year)) {
      historical.push(role);
    } else if (!currentKeys.has(key)) {
      uncertain.push(role);
    }
  }

  return { current, historical, uncertain };
}

function matchRoleCompany(role, target) {
  const roleUrl = normalizeLinkedInCompanyUrl(role.companyLinkedInUrl);
  const roleUniversalName = normalizeText(role.companyUniversalName).toLowerCase();
  const roleName = normalizeCompanyName(role.companyName);

  if (roleUrl && target.companyLinkedInUrl && roleUrl === target.companyLinkedInUrl) {
    return { status: 'match', method: 'linkedin_url' };
  }
  if (roleUniversalName && target.companyLinkedInSlug && roleUniversalName === target.companyLinkedInSlug) {
    return { status: 'match', method: 'linkedin_universal_name' };
  }
  if (/^\d+$/.test(target.companyLinkedInSlug) && role.companyId === target.companyLinkedInSlug) {
    return { status: 'match', method: 'linkedin_company_id' };
  }
  if (roleName && target.normalizedCompanyName && roleName === target.normalizedCompanyName) {
    if (roleUrl && target.companyLinkedInUrl && roleUrl !== target.companyLinkedInUrl) {
      if (target.companyNameIsUnique) {
        return { status: 'match', method: 'exact_unique_name_url_conflict' };
      }
      return { status: 'ambiguous', method: 'non_unique_name_url_conflict' };
    }
    if (target.companyNameIsUnique) return { status: 'match', method: 'exact_unique_name' };
    return { status: 'ambiguous', method: 'non_unique_name' };
  }
  return { status: roleUrl || roleName ? 'mismatch' : 'unknown', method: '' };
}

function chooseRoleMatch(role, target) {
  return {
    role,
    title: classifyTitle(role.title),
    company: matchRoleCompany(role, target),
  };
}

function profileDisplayName(profile) {
  return [normalizeText(profile?.firstName), normalizeText(profile?.lastName)].filter(Boolean).join(' ');
}

function profilePersonKey(profile, normalizedUrl) {
  const stableId = normalizeText(profile?.id || profile?.objectUrn);
  if (stableId) return `harvest:${stableId}`;
  const publicIdentifier = normalizeText(profile?.publicIdentifier).toLowerCase();
  if (publicIdentifier) return `linkedin:${publicIdentifier}`;
  return `url:${normalizedUrl}`;
}

function evaluateProfile(profile, normalizedUrl, target) {
  if (!profile) {
    return {
      verdict: 'unverified',
      reason: 'harvest_profile_missing',
      harvestStatus: 'missing',
      personKey: `url:${normalizedUrl}`,
    };
  }
  if (Object.keys(profile).length === 0) {
    return {
      verdict: 'unverified',
      reason: 'harvest_profile_empty',
      harvestStatus: 'empty',
      personKey: `url:${normalizedUrl}`,
    };
  }

  const personKey = profilePersonKey(profile, normalizedUrl);
  const roles = classifyRoles(profile);
  const current = roles.current.map((role) => chooseRoleMatch(role, target));
  const historical = roles.historical.map((role) => chooseRoleMatch(role, target));
  const uncertain = roles.uncertain.map((role) => chooseRoleMatch(role, target));

  const currentCorrect = current.find((item) => item.company.status === 'match' && item.title.qualifies);
  if (currentCorrect) {
    return {
      verdict: 'correct',
      reason: 'current_qualifying_role_at_target',
      harvestStatus: 'matched',
      personKey,
      match: currentCorrect,
      roles,
    };
  }

  const currentTarget = current.find((item) => item.company.status === 'match');
  if (currentTarget) {
    return {
      verdict: 'wrong_title',
      reason: 'current_role_at_target_is_not_ceo_or_founder',
      harvestStatus: 'matched',
      personKey,
      match: currentTarget,
      roles,
    };
  }

  const historicalTarget = historical.find((item) => item.company.status === 'match' && item.title.qualifies);
  if (historicalTarget) {
    return {
      verdict: 'stale',
      reason: 'former_qualifying_role_at_target',
      harvestStatus: 'matched',
      personKey,
      match: historicalTarget,
      roles,
    };
  }

  const ambiguousRelevant = [...current, ...uncertain].find((item) => (
    item.company.status === 'ambiguous' && item.title.qualifies
  ));
  if (ambiguousRelevant) {
    return {
      verdict: 'ambiguous',
      reason: ambiguousRelevant.company.method,
      harvestStatus: 'matched',
      personKey,
      match: ambiguousRelevant,
      roles,
    };
  }

  const currentQualifyingElsewhere = current.find((item) => item.title.qualifies);
  if (currentQualifyingElsewhere) {
    return {
      verdict: 'wrong_company',
      reason: 'current_qualifying_role_is_at_another_company',
      harvestStatus: 'matched',
      personKey,
      match: currentQualifyingElsewhere,
      roles,
    };
  }

  const uncertainTarget = uncertain.find((item) => item.company.status === 'match' && item.title.qualifies);
  if (uncertainTarget) {
    return {
      verdict: 'ambiguous',
      reason: 'target_role_has_unknown_currentness',
      harvestStatus: 'matched',
      personKey,
      match: uncertainTarget,
      roles,
    };
  }

  return {
    verdict: 'wrong_both',
    reason: 'no_current_target_role_or_qualifying_title',
    harvestStatus: 'matched',
    personKey,
    match: current[0] || historical[0] || uncertain[0] || null,
    roles,
  };
}

function buildHarvestIndex(rawProfiles) {
  const byUrl = new Map();
  const put = (rawUrl, profile) => {
    const normalized = normalizeLinkedInPersonUrl(rawUrl);
    if (!normalized) return;
    const existing = byUrl.get(normalized);
    if (!existing || (Object.keys(existing).length === 0 && Object.keys(profile || {}).length > 0)) {
      byUrl.set(normalized, profile);
    }
  };

  for (const [rawUrl, profile] of Object.entries(rawProfiles)) {
    put(rawUrl, profile);
    if (profile?.linkedinUrl) put(profile.linkedinUrl, profile);
    if (profile?.publicIdentifier) put(`https://www.linkedin.com/in/${profile.publicIdentifier}`, profile);
  }
  return byUrl;
}

function splitProfileUrls(value) {
  return String(value || '').split(';').map((item) => item.trim()).filter(Boolean);
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumKnown(records, field) {
  if (!field) return null;
  const values = records.map((record) => finiteNumber(record[field])).filter((value) => value !== null);
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : null;
}

function resolveCreditUsage(input) {
  if (input.actualCost !== null) {
    return {
      credits: input.actualCost,
      status: 'reported',
      basis: `sum of ${input.actualCostField}`,
    };
  }

  if (input.estimatedCost !== null) {
    return {
      credits: input.estimatedCost,
      status: 'estimated',
      basis: `sum of ${input.estimatedCostField}`,
    };
  }

  const rawReturned = sumKnown(input.records, 'raw_returned_count');
  if (rawReturned === null) return { credits: null, status: 'unknown', basis: null };

  if (input.provider === 'apollo') {
    return {
      credits: rawReturned,
      status: 'estimated',
      basis: 'raw_returned_count × 1 bulk-match credit (phone reveal disabled)',
    };
  }
  if (input.provider === 'pdl') {
    return {
      credits: rawReturned,
      status: 'estimated',
      basis: 'raw_returned_count × 1 person-search credit',
    };
  }
  if (input.provider === 'coresignal') {
    return {
      credits: rawReturned * 10,
      status: 'estimated',
      basis: 'raw_returned_count × 10 collect credits',
    };
  }

  return { credits: null, status: 'unknown', basis: null };
}

function calculateCostMetrics(provider, creditUsage, correctContactCount, verifiedCompanyCount) {
  const creditPriceUsd = CREDIT_PRICES_USD[provider] ?? null;
  const calculatedCostUsd = creditUsage.credits !== null && creditPriceUsd !== null
    ? creditUsage.credits * creditPriceUsd
    : null;

  return {
    billable_credits: creditUsage.credits === null ? null : round(creditUsage.credits, 4),
    billable_credits_status: creditUsage.status,
    billable_credits_basis: creditUsage.basis,
    credit_price_usd: creditPriceUsd,
    calculated_cost_usd: round(calculatedCostUsd, 6),
    cost_usd_per_correct_contact: round(ratio(calculatedCostUsd, correctContactCount), 6),
    cost_usd_per_verified_company: round(ratio(calculatedCostUsd, verifiedCompanyCount), 6),
  };
}

function ratio(numerator, denominator) {
  return numerator !== null && numerator !== undefined && denominator > 0
    ? numerator / denominator
    : null;
}

function f1Score(precision, recall) {
  if (precision === null || recall === null) return null;
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

function round(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function percent(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function number(value, digits = 0) {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function usd(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return `$${number(value, digits)}`;
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, content);
  fs.renameSync(temporaryPath, filePath);
}

function escapeCsvValue(value) {
  const stringValue = String(value ?? '');
  return /[",\r\n]/.test(stringValue)
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}

function stringifyCsv(headers, records) {
  const lines = [headers.map(escapeCsvValue).join(',')];
  for (const record of records) {
    lines.push(headers.map((header) => escapeCsvValue(record[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function buildReviewRows(candidateVerdicts, verdict) {
  const grouped = new Map();
  for (const row of candidateVerdicts.filter((candidate) => (
    candidate.included_in_metrics && candidate.verdict === verdict
  ))) {
    const key = `${row.company_slug}|${row.harvest_person_key}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        company_slug: row.company_slug,
        company_name: row.company_name,
        target_company_linkedin_url: row.target_company_linkedin_url,
        person_name: row.harvest_name,
        linkedin_url: row.raw_linkedin_url,
        harvest_person_key: row.harvest_person_key,
        harvest_status: row.harvest_status,
        role_title: row.matched_role_title,
        role_company: row.matched_role_company,
        role_company_linkedin_url: row.matched_role_company_linkedin_url,
        reason: row.reason,
        providers: new Set(),
        best_rank: row.rank,
        suggested_action: verdict === 'ambiguous'
          ? 'Confirm whether the Harvest role is current'
          : 'Open LinkedIn manually or refetch the Harvest profile',
        review_decision: '',
        review_notes: '',
      });
    }
    const review = grouped.get(key);
    review.providers.add(row.provider);
    review.best_rank = Math.min(review.best_rank, row.rank);
  }

  return [...grouped.values()]
    .map((row) => ({
      ...row,
      providers: [...row.providers].sort().join('|'),
      provider_count: row.providers.size,
    }))
    .sort((a, b) => (
      a.company_name.localeCompare(b.company_name)
      || a.person_name.localeCompare(b.person_name)
      || a.linkedin_url.localeCompare(b.linkedin_url)
    ));
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const cohort = readCsvRecords(args.cohort).records;
  if (cohort.length === 0) throw new Error('Cohort is empty.');

  const cohortSlugs = new Set();
  const companyNameCounts = new Map();
  for (const company of cohort) {
    const slug = normalizeText(company.slug).toLowerCase();
    if (!slug || cohortSlugs.has(slug)) throw new Error(`Missing or duplicate cohort slug: ${slug || '(blank)'}`);
    cohortSlugs.add(slug);
    const normalizedName = normalizeCompanyName(company.company_name);
    companyNameCounts.set(normalizedName, (companyNameCounts.get(normalizedName) || 0) + 1);
  }

  const targets = new Map(cohort.map((company) => {
    const slug = normalizeText(company.slug).toLowerCase();
    const normalizedCompanyName = normalizeCompanyName(company.company_name);
    return [slug, {
      slug,
      companyName: normalizeText(company.company_name),
      companyWebsite: normalizeText(company.company_website),
      companyLinkedInUrl: normalizeLinkedInCompanyUrl(company.company_linkedin_url),
      companyLinkedInSlug: companySlugFromUrl(company.company_linkedin_url),
      normalizedCompanyName,
      companyNameIsUnique: companyNameCounts.get(normalizedCompanyName) === 1,
    }];
  }));

  const harvestProfiles = JSON.parse(fs.readFileSync(args.harvest, 'utf8'));
  const harvestIndex = buildHarvestIndex(harvestProfiles);
  const selectedProviders = new Set(args.providers);
  const resultFiles = fs.readdirSync(args.resultsDir)
    .filter((fileName) => RESULT_FILE_PATTERN.test(fileName))
    .filter((fileName) => {
      if (selectedProviders.size === 0) return true;
      return selectedProviders.has(fileName.match(RESULT_FILE_PATTERN)[1].toLowerCase());
    })
    .sort();
  if (resultFiles.length === 0) throw new Error('No provider benchmark CSV files found.');

  const providerInputs = [];
  const candidateVerdicts = [];

  for (const fileName of resultFiles) {
    const filePath = path.join(args.resultsDir, fileName);
    const { headers, records } = readCsvRecords(filePath);
    for (const requiredHeader of ['slug', 'provider', 'linkedin_profiles', 'request_status']) {
      if (!headers.includes(requiredHeader)) throw new Error(`${fileName} is missing ${requiredHeader}.`);
    }

    const provider = normalizeText(records[0]?.provider || fileName.match(RESULT_FILE_PATTERN)[1]).toLowerCase();
    const rowsBySlug = new Map();
    for (const record of records) {
      const slug = normalizeText(record.slug).toLowerCase();
      if (!targets.has(slug)) throw new Error(`${fileName}: unknown cohort slug ${slug}.`);
      if (rowsBySlug.has(slug)) throw new Error(`${fileName}: duplicate row for ${slug}.`);
      rowsBySlug.set(slug, record);
    }

    const seenPersonByCompany = new Map();
    for (const [slug, target] of targets) {
      const record = rowsBySlug.get(slug);
      if (!record) continue;
      const rawUrls = splitProfileUrls(record.linkedin_profiles);
      const seenUrls = new Set();
      let rank = 0;
      for (const rawUrl of rawUrls) {
        const normalizedUrl = normalizeLinkedInPersonUrl(rawUrl);
        if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
        seenUrls.add(normalizedUrl);
        rank += 1;
        const profile = harvestIndex.get(normalizedUrl) || null;
        const evaluation = evaluateProfile(profile, normalizedUrl, target);
        const companyPersonKey = `${slug}|${evaluation.personKey}`;
        const previousRank = seenPersonByCompany.get(companyPersonKey);
        const includedInMetrics = previousRank === undefined;
        if (includedInMetrics) seenPersonByCompany.set(companyPersonKey, rank);

        candidateVerdicts.push({
          provider,
          company_slug: slug,
          company_name: target.companyName,
          target_company_linkedin_url: target.companyLinkedInUrl,
          rank,
          raw_linkedin_url: rawUrl,
          normalized_linkedin_url: normalizedUrl,
          harvest_status: evaluation.harvestStatus,
          harvest_person_key: evaluation.personKey,
          harvest_name: profileDisplayName(profile),
          verdict: includedInMetrics ? evaluation.verdict : 'duplicate_person',
          underlying_verdict: evaluation.verdict,
          reason: includedInMetrics ? evaluation.reason : `same_harvest_person_as_rank_${previousRank}`,
          matched_role_title: evaluation.match?.role?.title || '',
          matched_role_company: evaluation.match?.role?.companyName || '',
          matched_role_company_linkedin_url: normalizeLinkedInCompanyUrl(evaluation.match?.role?.companyLinkedInUrl),
          company_match_method: evaluation.match?.company?.method || '',
          title_category: evaluation.match?.title?.category || '',
          current_role_count: evaluation.roles?.current?.length || 0,
          historical_role_count: evaluation.roles?.historical?.length || 0,
          uncertain_role_count: evaluation.roles?.uncertain?.length || 0,
          included_in_metrics: includedInMetrics,
        });
      }
    }

    const actualCostField = headers.includes('credit_cost')
      ? 'credit_cost'
      : headers.includes('credits_used')
        ? 'credits_used'
        : '';
    const estimatedCostField = headers.includes('credit_cost_estimated') ? 'credit_cost_estimated' : '';
    providerInputs.push({
      provider,
      fileName,
      records,
      rowsBySlug,
      actualCost: sumKnown(records, actualCostField),
      estimatedCost: sumKnown(records, estimatedCostField),
      actualCostField,
      estimatedCostField,
    });
  }

  const includedCandidates = candidateVerdicts.filter((row) => row.included_in_metrics);
  const poolProvidersByPair = new Map();
  for (const row of includedCandidates.filter((candidate) => candidate.verdict === 'correct')) {
    const pairKey = `${row.company_slug}|${row.harvest_person_key}`;
    if (!poolProvidersByPair.has(pairKey)) poolProvidersByPair.set(pairKey, new Set());
    poolProvidersByPair.get(pairKey).add(row.provider);
  }
  const pooledCorrectPairs = poolProvidersByPair.size;

  const scorecards = providerInputs.map((input) => {
    const providerCandidates = includedCandidates.filter((row) => row.provider === input.provider);
    const verdictCounts = Object.fromEntries(
      ['correct', 'stale', 'wrong_title', 'wrong_company', 'wrong_both', 'ambiguous', 'unverified']
        .map((verdict) => [verdict, providerCandidates.filter((row) => row.verdict === verdict).length]),
    );
    const verifiable = providerCandidates.length - verdictCounts.ambiguous - verdictCounts.unverified;
    const precision = ratio(verdictCounts.correct, verifiable);
    const lowerBoundPrecision = ratio(verdictCounts.correct, providerCandidates.length);
    const wrong = verdictCounts.wrong_title + verdictCounts.wrong_company + verdictCounts.wrong_both;
    const unresolved = verdictCounts.ambiguous + verdictCounts.unverified;
    const correctPairs = new Set(
      providerCandidates
        .filter((row) => row.verdict === 'correct')
        .map((row) => `${row.company_slug}|${row.harvest_person_key}`),
    );
    const correctCompanies = new Set(
      providerCandidates.filter((row) => row.verdict === 'correct').map((row) => row.company_slug),
    );
    const companiesWithCandidates = new Set(providerCandidates.map((row) => row.company_slug));
    const companiesNoCandidates = targets.size - companiesWithCandidates.size;
    const companiesWithResultsNoCorrect = [...companiesWithCandidates]
      .filter((slug) => !correctCompanies.has(slug))
      .length;
    const bestCorrectRank = new Map();
    for (const row of providerCandidates.filter((candidate) => candidate.verdict === 'correct')) {
      const previous = bestCorrectRank.get(row.company_slug);
      if (previous === undefined || row.rank < previous) bestCorrectRank.set(row.company_slug, row.rank);
    }
    const reciprocalRankSum = [...targets.keys()].reduce((sum, slug) => {
      const bestRank = bestCorrectRank.get(slug);
      return sum + (bestRank ? 1 / bestRank : 0);
    }, 0);
    const pooledRecall = ratio(correctPairs.size, pooledCorrectPairs);
    const f1 = f1Score(precision, pooledRecall);
    const exclusiveCorrectPairs = [...correctPairs].filter((pairKey) => poolProvidersByPair.get(pairKey)?.size === 1).length;
    const requestOk = input.records.filter((record) => normalizeText(record.request_status).toLowerCase() === 'ok').length;
    const cost = input.actualCost;
    const creditUsage = resolveCreditUsage(input);
    const costMetrics = calculateCostMetrics(
      input.provider,
      creditUsage,
      correctPairs.size,
      correctCompanies.size,
    );

    return {
      provider: input.provider,
      source_file: input.fileName,
      cohort_companies: targets.size,
      result_rows: input.records.length,
      request_ok: requestOk,
      request_success_rate: round(ratio(requestOk, targets.size)),
      unique_candidates: providerCandidates.length,
      verifiable_candidates: verifiable,
      ...verdictCounts,
      wrong,
      unresolved,
      verified_precision: round(precision),
      lower_bound_precision: round(lowerBoundPrecision),
      pooled_correct_pairs: pooledCorrectPairs,
      provider_correct_pairs: correctPairs.size,
      pooled_recall: round(pooledRecall),
      people_coverage: round(pooledRecall),
      f1: round(f1),
      verified_companies: correctCompanies.size,
      verified_company_coverage: round(ratio(correctCompanies.size, targets.size)),
      companies_no_candidates: companiesNoCandidates,
      companies_with_results_no_correct: companiesWithResultsNoCorrect,
      hit_at_1: round(ratio([...bestCorrectRank.values()].filter((rank) => rank <= 1).length, targets.size)),
      hit_at_3: round(ratio([...bestCorrectRank.values()].filter((rank) => rank <= 3).length, targets.size)),
      hit_at_5: round(ratio([...bestCorrectRank.values()].filter((rank) => rank <= 5).length, targets.size)),
      mean_reciprocal_rank: round(reciprocalRankSum / targets.size),
      exclusive_correct_pairs: exclusiveCorrectPairs,
      unique_finds: exclusiveCorrectPairs,
      reported_credit_cost: cost === null ? null : round(cost, 4),
      estimated_credit_cost: input.estimatedCost === null ? null : round(input.estimatedCost, 4),
      cost_field: input.actualCostField || null,
      estimated_cost_field: input.estimatedCostField || null,
      credits_per_correct_pair: cost === null ? null : round(ratio(cost, correctPairs.size), 4),
      credits_per_verified_company: cost === null ? null : round(ratio(cost, correctCompanies.size), 4),
      ...costMetrics,
    };
  });

  scorecards.sort((a, b) => (
    (b.f1 ?? -1) - (a.f1 ?? -1)
    || b.verified_company_coverage - a.verified_company_coverage
    || b.verified_precision - a.verified_precision
    || a.provider.localeCompare(b.provider)
  ));
  scorecards.forEach((scorecard, index) => { scorecard.rank = index + 1; });

  candidateVerdicts.sort((a, b) => (
    a.provider.localeCompare(b.provider)
    || a.company_slug.localeCompare(b.company_slug)
    || a.rank - b.rank
  ));

  const generatedAt = new Date().toISOString();
  const coverageLeader = [...scorecards].sort((a, b) => (
    b.verified_company_coverage - a.verified_company_coverage
    || (b.f1 ?? -1) - (a.f1 ?? -1)
  ))[0];
  const peopleCoverageLeader = [...scorecards].sort((a, b) => (
    b.people_coverage - a.people_coverage
    || b.correct - a.correct
  ))[0];
  const costLeader = scorecards
    .filter((row) => row.cost_usd_per_correct_contact !== null)
    .sort((a, b) => a.cost_usd_per_correct_contact - b.cost_usd_per_correct_contact)[0] || null;
  const companyScorecards = [...scorecards].sort((a, b) => (
    b.verified_company_coverage - a.verified_company_coverage
    || a.companies_with_results_no_correct - b.companies_with_results_no_correct
    || a.provider.localeCompare(b.provider)
  ));
  const peopleScorecards = [...scorecards].sort((a, b) => (
    b.correct - a.correct
    || b.people_coverage - a.people_coverage
    || a.provider.localeCompare(b.provider)
  ));
  const pricingScorecards = [...scorecards].sort((a, b) => (
    (a.cost_usd_per_correct_contact ?? Number.POSITIVE_INFINITY)
      - (b.cost_usd_per_correct_contact ?? Number.POSITIVE_INFINITY)
    || a.provider.localeCompare(b.provider)
  ));
  const metadata = {
    generated_at: generatedAt,
    cohort_file: path.relative(PROJECT_ROOT, args.cohort),
    harvest_file: path.relative(PROJECT_ROOT, args.harvest),
    results_directory: path.relative(PROJECT_ROOT, args.resultsDir),
    provider_count: scorecards.length,
    cohort_companies: targets.size,
    harvest_json_entries: Object.keys(harvestProfiles).length,
    harvest_indexed_urls: harvestIndex.size,
    pooled_correct_person_company_pairs: pooledCorrectPairs,
    total_candidate_rows: candidateVerdicts.length,
    included_candidate_rows: includedCandidates.length,
    duplicate_person_rows: candidateVerdicts.filter((row) => !row.included_in_metrics).length,
    credit_prices_usd_per_credit: CREDIT_PRICES_USD,
    methodology: {
      headline_comparison: 'Separate company-focused and people-focused tables; no composite overall rank',
      detailed_rank: 'F1 of verified precision and pooled recall, retained in the machine-readable scorecard',
      recall_scope: 'Harvest-confirmed correct person-company pairs found by at least one compared provider',
      currentness: 'Harvest currentPosition plus experience roles explicitly ending in Present/Current/Now',
      title_scope: 'CEO, Chief Executive, Founder, Co-Founder, and listed language variants',
      company_matching: 'LinkedIn company URL/ID first; exact unique cohort company name is accepted when the cohort LinkedIn URL is stale',
      unverified_handling: 'Missing and empty Harvest records are excluded from verified precision and included in lower-bound precision',
      unique_finds: 'Correct person-company pairs found by exactly one compared provider',
      people_coverage: 'Correct person-company pairs found by a provider divided by the pooled correct pairs found by at least one compared provider',
    },
  };

  const reportLines = [
    '# People Search Provider Comparison',
    '',
    `Generated: ${generatedAt}`,
    '',
    `Compared ${scorecards.length} providers across ${targets.size} companies using ${Object.keys(harvestProfiles).length.toLocaleString('en-US')} Harvest JSON entries. The pooled reference contains ${pooledCorrectPairs.toLocaleString('en-US')} Harvest-confirmed current CEO/founder person-company pairs found by at least one provider.`,
    '',
    '## Key findings',
    '',
    `- **${coverageLeader.provider} has the highest verified-company coverage**, finding at least one correct person for ${number(coverageLeader.verified_companies)} of ${number(targets.size)} companies (${percent(coverageLeader.verified_company_coverage)}).`,
    `- **${peopleCoverageLeader.provider} found the most correct people**, with ${number(peopleCoverageLeader.correct)} of ${number(pooledCorrectPairs)} pooled correct person-company pairs (${percent(peopleCoverageLeader.people_coverage)} people coverage).`,
    ...(costLeader ? [`- **${costLeader.provider} has the lowest calculated USD cost per correct contact** at ${usd(costLeader.cost_usd_per_correct_contact, 4)}.`] : []),
    '',
    '## Company-focused comparison',
    '',
    '| Provider | Companies resolved | Coverage | No candidates | Results but no correct |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...companyScorecards.map((row) => `| ${row.provider} | ${number(row.verified_companies)} | ${percent(row.verified_company_coverage)} | ${number(row.companies_no_candidates)} | ${number(row.companies_with_results_no_correct)} |`),
    '',
    '## People-focused comparison',
    '',
    '| Provider | Returned | Correct | People coverage | Unique finds | Stale | Wrong | Unresolved |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...peopleScorecards.map((row) => `| ${row.provider} | ${number(row.unique_candidates)} | ${number(row.correct)} | ${percent(row.people_coverage)} | ${number(row.unique_finds)} | ${number(row.stale)} | ${number(row.wrong)} | ${number(row.unresolved)} |`),
    '',
    '## Pricing and benchmark cost',
    '',
    '| Provider | USD / credit | Cost / resolved company | Cost / correct person |',
    '| --- | ---: | ---: | ---: |',
    ...pricingScorecards.map((row) => `| ${row.provider} | ${usd(row.credit_price_usd, 4)} | ${usd(row.cost_usd_per_verified_company, 4)} | ${usd(row.cost_usd_per_correct_contact, 4)} |`),
    '',
    '> Cost note: CompanyEnrich, Crustdata, and FullEnrich use reported credit consumption. Apollo, CoreSignal, People Data Labs, and Prospeo use estimated consumption. Detailed usage data remains in `provider_scorecard.json`.',
    '',
    '## Interpretation',
    '',
    '- People coverage divides a provider\'s correct person-company pairs by the pooled correct pairs found by at least one compared provider. It is relative rather than absolute because people missed by every provider are absent from the pool.',
    '- `Wrong` combines wrong-title, wrong-company, and wrong-both verdicts. `Unresolved` combines ambiguous and unverified candidates.',
    '- `Unique finds` are verified correct person-company pairs found by exactly one compared provider; the count can change when providers are added or removed.',
    '- Company outcomes partition the cohort into resolved companies, companies with no candidates, and companies with results but no correct candidate.',
    '- USD costs use roughly comparable $500-plan per-credit prices: Crustdata $0.30, CompanyEnrich $0.0011, FullEnrich $0.05, Apollo $0.016, PDL $0.28, Prospeo $0.015, and CoreSignal $0.014.',
    '- Crustdata, CompanyEnrich, and FullEnrich credit usage is reported by their benchmark files. Prospeo usage is the benchmark estimate. Apollo is estimated at one credit per raw enriched person, PDL at one credit per raw search result, and CoreSignal at ten credits per collected person.',
    '- Company identity uses LinkedIn URL/ID first. An exact unique cohort-company name can resolve a stale or rebranded cohort LinkedIn URL.',
    '',
    '## Verdict rules',
    '',
    '- `correct`: current qualifying CEO/founder role at the target company.',
    '- `stale`: former qualifying role at the target company.',
    '- `wrong_title`: current role at the target company, but not CEO/founder.',
    '- `wrong_company`: current CEO/founder role at another company.',
    '- `wrong_both`: neither current target-company employment nor a qualifying current title.',
    '- `ambiguous`: target-company identity or role currentness cannot be resolved safely.',
    '- `unverified`: Harvest profile is missing or empty.',
    '',
    'Detailed candidate evidence is available in `candidate_verdicts.jsonl`; machine-readable provider metrics are in `provider_scorecard.json`. Unique manual-review queues are available in `ambiguous_candidates.csv` and `unverified_candidates.csv`.',
  ];

  writeAtomic(
    path.join(args.outputDir, 'provider_scorecard.json'),
    `${JSON.stringify({ metadata, providers: scorecards }, null, 2)}\n`,
  );
  writeAtomic(
    path.join(args.outputDir, 'candidate_verdicts.jsonl'),
    `${candidateVerdicts.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  const ambiguousReviewRows = buildReviewRows(candidateVerdicts, 'ambiguous');
  const unverifiedReviewRows = buildReviewRows(candidateVerdicts, 'unverified');
  const reviewHeaders = [
    'company_slug',
    'company_name',
    'target_company_linkedin_url',
    'person_name',
    'linkedin_url',
    'harvest_person_key',
    'harvest_status',
    'role_title',
    'role_company',
    'role_company_linkedin_url',
    'reason',
    'providers',
    'provider_count',
    'best_rank',
    'suggested_action',
    'review_decision',
    'review_notes',
  ];
  writeAtomic(
    path.join(args.outputDir, 'ambiguous_candidates.csv'),
    stringifyCsv(reviewHeaders, ambiguousReviewRows),
  );
  writeAtomic(
    path.join(args.outputDir, 'unverified_candidates.csv'),
    stringifyCsv(reviewHeaders, unverifiedReviewRows),
  );
  writeAtomic(path.join(args.outputDir, 'report.md'), `${reportLines.join('\n')}\n`);

  console.log(`Compared ${scorecards.length} providers across ${targets.size} companies.`);
  console.log(`Pooled correct person-company pairs: ${pooledCorrectPairs}`);
  for (const row of companyScorecards) {
    console.log(`${row.provider}: ${number(row.verified_companies)} companies resolved (${percent(row.verified_company_coverage)} company coverage), ${number(row.correct)} correct people (${percent(row.people_coverage)} people coverage)`);
  }
  console.log(`Ambiguous review rows: ${ambiguousReviewRows.length}`);
  console.log(`Unverified review rows: ${unverifiedReviewRows.length}`);
  console.log(`Wrote: ${args.outputDir}`);

  return { metadata, providers: scorecards, candidateVerdicts };
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
  CREDIT_PRICES_USD,
  calculateCostMetrics,
  classifyTitle,
  evaluateProfile,
  main,
  normalizeLinkedInCompanyUrl,
  normalizeLinkedInPersonUrl,
  resolveCreditUsage,
};
