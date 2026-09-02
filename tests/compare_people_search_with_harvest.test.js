'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CREDIT_PRICES_USD,
  calculateCostMetrics,
  classifyTitle,
  evaluateProfile,
  main,
  normalizeLinkedInCompanyUrl,
  normalizeLinkedInPersonUrl,
  resolveCreditUsage,
} = require('../scripts/compare_people_search_with_harvest');

function target(overrides = {}) {
  return {
    slug: 'acme',
    companyName: 'Acme',
    companyWebsite: 'https://acme.test',
    companyLinkedInUrl: 'linkedin.com/company/acme',
    companyLinkedInSlug: 'acme',
    normalizedCompanyName: 'acme',
    companyNameIsUnique: true,
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: 'person-1',
    firstName: 'Ada',
    lastName: 'Founder',
    publicIdentifier: 'ada-founder',
    currentPosition: [],
    experience: [],
    ...overrides,
  };
}

function role(overrides = {}) {
  return {
    position: 'Founder & CEO',
    companyName: 'Acme',
    companyLinkedinUrl: 'https://www.linkedin.com/company/acme/',
    ...overrides,
  };
}

function creditInput(overrides = {}) {
  return {
    provider: 'unknown',
    records: [],
    actualCost: null,
    actualCostField: '',
    estimatedCost: null,
    estimatedCostField: '',
    ...overrides,
  };
}

test('normalizes LinkedIn person and company URLs deterministically', () => {
  assert.equal(
    normalizeLinkedInPersonUrl('HTTPS://WWW.LinkedIn.com/in/Ada-Founder/?trk=public_profile'),
    'linkedin.com/in/ada-founder',
  );
  assert.equal(
    normalizeLinkedInCompanyUrl('linkedin.com/company/Acme/?viewAsMember=true'),
    'linkedin.com/company/acme',
  );
  assert.equal(normalizeLinkedInPersonUrl('https://example.com/in/ada-founder'), '');
  assert.equal(normalizeLinkedInPersonUrl('https://linkedin.com/company/acme'), '');
  assert.equal(normalizeLinkedInCompanyUrl('https://linkedin.com/in/ada-founder'), '');
});

test('classifies qualifying titles while rejecting misleading title text', () => {
  assert.deepEqual(classifyTitle('Co-Founder & CEO'), {
    qualifies: true,
    category: 'ceo_founder',
    normalized: 'co founder and ceo',
  });
  assert.equal(classifyTitle('Chief Executive Officer').category, 'ceo');
  assert.equal(classifyTitle('Kurucu').category, 'founder');
  assert.equal(classifyTitle('Executive Assistant to CEO').qualifies, false);
  assert.equal(classifyTitle('Former Co-Founder').qualifies, false);
  assert.equal(classifyTitle('VP, Customer Success').qualifies, false);
});

test('assigns every decisive and unresolved profile verdict', () => {
  const normalizedUrl = 'linkedin.com/in/ada-founder';
  const cases = [
    {
      name: 'correct current founder at target',
      input: profile({ currentPosition: [role()] }),
      verdict: 'correct',
      reason: 'current_qualifying_role_at_target',
    },
    {
      name: 'wrong title at target',
      input: profile({ currentPosition: [role({ position: 'VP, Customer Success' })] }),
      verdict: 'wrong_title',
      reason: 'current_role_at_target_is_not_ceo_or_founder',
    },
    {
      name: 'stale former founder at target',
      input: profile({
        experience: [role({ endDate: { month: 12, year: 2025, text: 'Dec 2025' } })],
      }),
      verdict: 'stale',
      reason: 'former_qualifying_role_at_target',
    },
    {
      name: 'qualifying role at another company',
      input: profile({
        currentPosition: [role({
          companyName: 'Elsewhere',
          companyLinkedinUrl: 'https://www.linkedin.com/company/elsewhere',
        })],
      }),
      verdict: 'wrong_company',
      reason: 'current_qualifying_role_is_at_another_company',
    },
    {
      name: 'wrong company and title',
      input: profile({
        currentPosition: [role({
          position: 'Engineer',
          companyName: 'Elsewhere',
          companyLinkedinUrl: 'https://www.linkedin.com/company/elsewhere',
        })],
      }),
      verdict: 'wrong_both',
      reason: 'no_current_target_role_or_qualifying_title',
    },
    {
      name: 'target role with unknown currentness',
      input: profile({ experience: [role()] }),
      verdict: 'ambiguous',
      reason: 'target_role_has_unknown_currentness',
    },
  ];

  for (const example of cases) {
    const result = evaluateProfile(example.input, normalizedUrl, target());
    assert.equal(result.verdict, example.verdict, example.name);
    assert.equal(result.reason, example.reason, example.name);
  }

  assert.deepEqual(evaluateProfile(null, normalizedUrl, target()), {
    verdict: 'unverified',
    reason: 'harvest_profile_missing',
    harvestStatus: 'missing',
    personKey: `url:${normalizedUrl}`,
  });
  assert.deepEqual(evaluateProfile({}, normalizedUrl, target()), {
    verdict: 'unverified',
    reason: 'harvest_profile_empty',
    harvestStatus: 'empty',
    personKey: `url:${normalizedUrl}`,
  });
});

test('resolves reported, estimated, and provider-specific credit usage', () => {
  assert.deepEqual(resolveCreditUsage(creditInput({
    provider: 'companyenrich',
    actualCost: 12.5,
    actualCostField: 'credit_cost',
    estimatedCost: 99,
    estimatedCostField: 'credit_cost_estimated',
  })), {
    credits: 12.5,
    status: 'reported',
    basis: 'sum of credit_cost',
  });

  assert.deepEqual(resolveCreditUsage(creditInput({
    provider: 'prospeo',
    estimatedCost: 8,
    estimatedCostField: 'credit_cost_estimated',
  })), {
    credits: 8,
    status: 'estimated',
    basis: 'sum of credit_cost_estimated',
  });

  const records = [{ raw_returned_count: '2' }, { raw_returned_count: '3' }];
  assert.equal(resolveCreditUsage(creditInput({ provider: 'apollo', records })).credits, 5);
  assert.equal(resolveCreditUsage(creditInput({ provider: 'pdl', records })).credits, 5);
  assert.equal(resolveCreditUsage(creditInput({ provider: 'coresignal', records })).credits, 50);
  assert.deepEqual(resolveCreditUsage(creditInput({ provider: 'other', records })), {
    credits: null,
    status: 'unknown',
    basis: null,
  });
});

test('calculates USD totals and unit costs from the public pricing snapshot', () => {
  assert.deepEqual(CREDIT_PRICES_USD, {
    apollo: 0.016,
    companyenrich: 0.0011,
    coresignal: 0.014,
    crustdata: 0.30,
    fullenrich: 0.05,
    pdl: 0.28,
    prospeo: 0.015,
  });

  assert.deepEqual(
    calculateCostMetrics(
      'companyenrich',
      { credits: 100, status: 'reported', basis: 'sum of credit_cost' },
      20,
      10,
    ),
    {
      billable_credits: 100,
      billable_credits_status: 'reported',
      billable_credits_basis: 'sum of credit_cost',
      credit_price_usd: 0.0011,
      calculated_cost_usd: 0.11,
      cost_usd_per_correct_contact: 0.0055,
      cost_usd_per_verified_company: 0.011,
    },
  );

  assert.deepEqual(
    calculateCostMetrics(
      'apollo',
      { credits: 10, status: 'reported', basis: 'fixture' },
      0,
      0,
    ),
    {
      billable_credits: 10,
      billable_credits_status: 'reported',
      billable_credits_basis: 'fixture',
      credit_price_usd: 0.016,
      calculated_cost_usd: 0.16,
      cost_usd_per_correct_contact: null,
      cost_usd_per_verified_company: null,
    },
  );

  assert.equal(
    calculateCostMetrics(
      'unpriced-provider',
      { credits: 10, status: 'reported', basis: 'fixture' },
      1,
      1,
    ).calculated_cost_usd,
    null,
  );
});

test('generates stable scorecard, duplicate, verdict, coverage, and cost metrics end to end', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'people-search-comparison-test-'));
  const resultsDir = path.join(temporaryRoot, 'results');
  const outputDir = path.join(temporaryRoot, 'comparison');
  const cohortPath = path.join(temporaryRoot, 'cohort.csv');
  const harvestPath = path.join(temporaryRoot, 'harvest.json');
  fs.mkdirSync(resultsDir);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  fs.writeFileSync(cohortPath, [
    'slug,company_name,company_linkedin_url,company_status,company_website',
    'acme,Acme,https://www.linkedin.com/company/acme,Active,https://acme.test',
    'beta,Beta,https://www.linkedin.com/company/beta,Active,https://beta.test',
    '',
  ].join('\n'));

  const alice = profile({
    id: 'alice-id',
    firstName: 'Alice',
    lastName: 'Founder',
    publicIdentifier: 'alice-founder',
    linkedinUrl: 'https://www.linkedin.com/in/alice-founder',
    currentPosition: [role()],
  });
  const bob = profile({
    id: 'bob-id',
    firstName: 'Bob',
    lastName: 'CEO',
    publicIdentifier: 'bob-ceo',
    linkedinUrl: 'https://www.linkedin.com/in/bob-ceo',
    currentPosition: [role({
      position: 'Chief Executive Officer',
      companyName: 'Beta',
      companyLinkedinUrl: 'https://www.linkedin.com/company/beta',
    })],
  });
  const carol = profile({
    id: 'carol-id',
    firstName: 'Carol',
    lastName: 'Former Founder',
    publicIdentifier: 'carol-former-founder',
    linkedinUrl: 'https://www.linkedin.com/in/carol-former-founder',
    currentPosition: [role({
      companyName: 'Elsewhere',
      companyLinkedinUrl: 'https://www.linkedin.com/company/elsewhere',
    })],
    experience: [role({ endDate: { month: 12, year: 2025, text: 'Dec 2025' } })],
  });
  fs.writeFileSync(harvestPath, `${JSON.stringify({
    'https://www.linkedin.com/in/alice-founder': alice,
    'https://www.linkedin.com/in/alice-founder-alias': alice,
    'https://www.linkedin.com/in/bob-ceo': bob,
    'https://www.linkedin.com/in/carol-former-founder': carol,
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(resultsDir, 'companyenrich_people_search_benchmark.csv'), [
    'slug,provider,linkedin_profiles,request_status,credit_cost',
    'acme,companyenrich,https://www.linkedin.com/in/alice-founder;https://www.linkedin.com/in/alice-founder-alias,ok,1.25',
    'beta,companyenrich,,ok,0.75',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(resultsDir, 'apollo_people_search_benchmark.csv'), [
    'slug,provider,linkedin_profiles,request_status,raw_returned_count',
    'acme,apollo,https://www.linkedin.com/in/carol-former-founder,ok,1',
    'beta,apollo,https://www.linkedin.com/in/bob-ceo,ok,1',
    '',
  ].join('\n'));

  const originalConsoleLog = console.log;
  let comparison;
  try {
    console.log = () => {};
    comparison = main([
      'node',
      'compare_people_search_with_harvest.js',
      '--cohort', cohortPath,
      '--results-dir', resultsDir,
      '--harvest', harvestPath,
      '--output-dir', outputDir,
    ]);
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(comparison.metadata.provider_count, 2);
  assert.equal(comparison.metadata.cohort_companies, 2);
  assert.equal(comparison.metadata.pooled_correct_person_company_pairs, 2);
  assert.equal(comparison.metadata.total_candidate_rows, 4);
  assert.equal(comparison.metadata.included_candidate_rows, 3);
  assert.equal(comparison.metadata.duplicate_person_rows, 1);

  const companyEnrich = comparison.providers.find((row) => row.provider === 'companyenrich');
  assert.equal(companyEnrich.rank, 1);
  assert.equal(companyEnrich.correct, 1);
  assert.equal(companyEnrich.unique_candidates, 1);
  assert.equal(companyEnrich.verified_companies, 1);
  assert.equal(companyEnrich.verified_company_coverage, 0.5);
  assert.equal(companyEnrich.companies_no_candidates, 1);
  assert.equal(companyEnrich.companies_with_results_no_correct, 0);
  assert.equal(companyEnrich.wrong, 0);
  assert.equal(companyEnrich.unresolved, 0);
  assert.equal(companyEnrich.unique_finds, 1);
  assert.equal(companyEnrich.verified_precision, 1);
  assert.equal(companyEnrich.pooled_recall, 0.5);
  assert.equal(companyEnrich.people_coverage, 0.5);
  assert.equal(companyEnrich.f1, 0.666667);
  assert.equal(companyEnrich.billable_credits, 2);
  assert.equal(companyEnrich.calculated_cost_usd, 0.0022);
  assert.equal(companyEnrich.cost_usd_per_correct_contact, 0.0022);

  const apollo = comparison.providers.find((row) => row.provider === 'apollo');
  assert.equal(apollo.correct, 1);
  assert.equal(apollo.stale, 1);
  assert.equal(apollo.companies_no_candidates, 0);
  assert.equal(apollo.companies_with_results_no_correct, 1);
  assert.equal(apollo.wrong, 0);
  assert.equal(apollo.unresolved, 0);
  assert.equal(apollo.unique_finds, 1);
  assert.equal(apollo.verified_precision, 0.5);
  assert.equal(apollo.pooled_recall, 0.5);
  assert.equal(apollo.people_coverage, 0.5);
  assert.equal(apollo.f1, 0.5);
  assert.equal(apollo.billable_credits, 2);
  assert.equal(apollo.calculated_cost_usd, 0.032);
  assert.equal(apollo.cost_usd_per_correct_contact, 0.032);

  for (const provider of comparison.providers) {
    assert.equal(
      provider.unique_candidates,
      provider.correct + provider.stale + provider.wrong + provider.unresolved,
      `${provider.provider} people outcomes should partition returned candidates`,
    );
    assert.equal(
      provider.cohort_companies,
      provider.verified_companies
        + provider.companies_no_candidates
        + provider.companies_with_results_no_correct,
      `${provider.provider} company outcomes should partition the cohort`,
    );
  }

  const duplicate = comparison.candidateVerdicts.find((row) => row.verdict === 'duplicate_person');
  assert.equal(duplicate.provider, 'companyenrich');
  assert.equal(duplicate.company_slug, 'acme');
  assert.equal(duplicate.included_in_metrics, false);
  assert.equal(duplicate.underlying_verdict, 'correct');

  for (const outputName of [
    'provider_scorecard.json',
    'candidate_verdicts.jsonl',
    'ambiguous_candidates.csv',
    'unverified_candidates.csv',
    'report.md',
  ]) {
    assert.equal(fs.existsSync(path.join(outputDir, outputName)), true, outputName);
  }

  const savedScorecard = JSON.parse(fs.readFileSync(
    path.join(outputDir, 'provider_scorecard.json'),
    'utf8',
  ));
  assert.deepEqual(savedScorecard.providers, comparison.providers);

  const report = fs.readFileSync(path.join(outputDir, 'report.md'), 'utf8');
  assert.match(report, /## Company-focused comparison/);
  assert.match(report, /Companies resolved \| Coverage \| No candidates \| Results but no correct/);
  assert.match(report, /## People-focused comparison/);
  assert.match(report, /Returned \| Correct \| People coverage \| Unique finds \| Stale \| Wrong \| Unresolved/);
  assert.doesNotMatch(report, /\| Unresolved \| Precision \|/);
  assert.match(report, /## Pricing and benchmark cost/);
  assert.match(report, /USD \/ credit \| Cost \/ resolved company \| Cost \/ correct person/);
  assert.doesNotMatch(report, /\| Credits used \| Usage status \| Total cost \|/);
  assert.match(report, /Detailed usage data remains in `provider_scorecard\.json`/);
});
