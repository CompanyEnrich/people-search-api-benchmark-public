# People Search API Benchmark

A reproducible, bring-your-own-keys benchmark for comparing B2B people-search
APIs on one task: finding the current CEO or founder of a known company.

The repository includes the benchmark code and a frozen cohort of 502 active Y
Combinator companies from the Winter, Spring, Summer, and Fall 2024 batches. It
does not include provider responses, HarvestAPI profiles, caches, scorecards,
rankings, or benchmark conclusions. Every user generates those locally.

## Providers

The benchmark supports:

- Apollo
- CompanyEnrich
- CoreSignal
- Crustdata
- FullEnrich
- People Data Labs (PDL)
- Prospeo

HarvestAPI full profiles are used to verify each returned LinkedIn profile's
company, qualifying title, and role currentness.

## Requirements

- Node.js 22 or newer
- An API account and key for every provider you want to run
- A HarvestAPI key for verification

The scripts use only Node.js built-in modules. No dependency installation is
required. Provider and Harvest calls can consume paid credits, so begin with a
small smoke run.

## Quick start

Copy the environment template and add your keys:

```bash
cp .env.example .env
```

Preview the full plan without creating files or calling APIs:

```bash
npm run benchmark -- --dry-run
```

Test the complete pipeline on three companies:

```bash
npm run benchmark -- --run-dir runs/smoke --limit 3
```

After reviewing the smoke outputs and provider billing dashboards, run the full
benchmark:

```bash
npm run benchmark
```

The full command runs the seven providers sequentially, consolidates their
candidates, fetches fresh HarvestAPI profiles, and generates a comparison. It
creates a timestamped directory beneath `runs/` and prints the final report
path.

## API keys

Keys may be exported in the shell or saved in the ignored `.env` file. Shell
values take precedence. Key values are never printed or written into run
metadata.

| Service | Environment variable |
| --- | --- |
| CompanyEnrich | `COMPANYENRICH_API_KEY` |
| Crustdata | `CRUSTDATA_API_KEY` |
| FullEnrich | `FULLENRICH_API_KEY` |
| Apollo | `APOLLO_API_KEY` |
| People Data Labs | `PDL_API_KEY` |
| CoreSignal | `CORESIGNAL_API_KEY` |
| Prospeo | `PROSPEO_API_KEY` |
| HarvestAPI | `HARVESTAPI_KEY` |

Never commit `.env`, credentials, private keys, caches, or generated results.

## Company cohort

The bundled cohort is
[`data/YC_Active_Companies_With_LinkedIn.csv`](data/YC_Active_Companies_With_LinkedIn.csv).
It contains 502 companies marked active in the YC directory that have a
LinkedIn company page. It is the default input and should remain unchanged when
comparing separate provider runs.

You can use a custom cohort:

```bash
npm run benchmark -- --cohort path/to/cohort.csv
```

A cohort CSV must have one unique row per company and these columns:

| Column | Purpose |
| --- | --- |
| `slug` | Stable unique company identifier |
| `company_name` | Company-name matching and reporting |
| `company_website` | Domain supplied to provider searches |
| `company_linkedin_url` | Primary company identity for Harvest verification |

Additional columns are preserved when runners write their result rows.

## Selecting providers

Run only selected providers by repeating `--provider`:

```bash
npm run benchmark -- \
  --provider companyenrich \
  --provider apollo
```

A selected-provider run requires only those provider keys plus
`HARVESTAPI_KEY`. Repeat the same `--provider` flags whenever you resume that
run; selection is not inferred from files already present.

## Resume a run

Every stage writes resumable outputs beneath its run directory. If a command
fails, fix the issue and reuse the same directory:

```bash
npm run benchmark -- --run-dir runs/2026-09-02_120000Z
```

To skip completed stages, start from `consolidate`, `harvest`, or `compare`:

```bash
npm run benchmark -- \
  --run-dir runs/2026-09-02_120000Z \
  --from harvest
```

Starting from a later stage assumes all earlier outputs exist. Avoid `--force`
unless a new paid fetch is intentional; it bypasses reusable cache entries.

## Run outputs

Each run is isolated and ignored by Git:

```text
runs/<timestamp>/
├── cohort.csv
├── git_commit.txt
├── run_manifest.json
├── cache/
├── results/
└── comparison/
    ├── report.md
    ├── provider_scorecard.json
    ├── candidate_verdicts.jsonl
    ├── ambiguous_candidates.csv
    └── unverified_candidates.csv
```

`--limit` runs are smoke tests rather than comparable benchmark snapshots: the
cohort denominator remains fixed while provider and Harvest data are incomplete.

The generated report separates the headline comparison into three tables:

- **Company-focused:** resolved companies, coverage, no-candidate companies,
  and companies with results but no correct person.
- **People-focused:** returned and correct people, pooled people coverage,
  unique finds, stale results, wrong results, and unresolved results.
- **Pricing:** USD per credit, cost per resolved company, and cost per correct
  person. Detailed credit usage remains in `provider_scorecard.json`.

## Methodology

The pipeline is:

```text
Frozen company cohort
        ↓
Independent provider searches
        ↓
Strict CEO/founder title filtering
        ↓
LinkedIn URL consolidation and deduplication
        ↓
Fresh HarvestAPI full-profile lookup
        ↓
Company, title, and currentness verification
        ↓
Local scorecard and review queues
```

Candidates are deduplicated within each provider and company. Company matching
uses LinkedIn company URL or ID first; an exact unique cohort-company name can
resolve a stale or rebranded company URL.

### Verdicts

- `correct`: current qualifying CEO/founder role at the target company.
- `stale`: former qualifying role at the target company.
- `wrong_title`: current role at the target company, but not CEO/founder.
- `wrong_company`: current CEO/founder role at another company.
- `wrong_both`: neither the current company nor title matches.
- `ambiguous`: company identity or role currentness cannot be resolved safely.
- `unverified`: the Harvest profile is missing or empty.

### Metrics

- **Companies resolved:** companies with at least one correct person.
- **Company coverage:** resolved companies divided by all cohort companies.
- **No candidates:** companies where a provider returned no valid candidate.
- **Results but no correct:** companies with candidates but no verified current
  CEO or founder.
- **Returned:** unique candidates after normalization and person deduplication.
- **Correct:** verified current CEO/founder person-company pairs.
- **People coverage:** correct pairs found by a provider divided by the pooled
  correct pairs found by at least one selected provider.
- **Unique finds:** correct pairs found by exactly one selected provider.
- **Stale:** former qualifying CEO/founder roles at the target company.
- **Wrong:** wrong-title, wrong-company, and wrong-both verdicts combined.
- **Unresolved:** ambiguous and unverified candidates combined.
- **Pricing efficiency:** calculated cost per resolved company and per correct
  person when usage is available.

People coverage is the reader-facing name for pooled recall. It is relative: a
person missed by every selected provider is absent from the reference pool.

The machine-readable scorecard retains verified precision, lower-bound
precision, F1, Hit@1, Hit@3, Hit@5, mean reciprocal rank, request reliability,
detailed verdict counts, and credit-usage calculations for deeper analysis.

Per-credit prices are assumptions stored near the top of
`scripts/compare_people_search_with_harvest.js`. Review them before each run or
remove them if cost comparison is not part of your methodology.

## Tests and CI

Run the dependency-free checks locally:

```bash
npm run check
npm test
```

The tests use synthetic temporary fixtures and make no API calls. GitHub Actions
runs the checks on Node.js 22 and 24 for every push and pull request.

## Limitations

- HarvestAPI is treated as the verification source, but its profiles can be
  missing, incomplete, stale, or ambiguous.
- Provider and LinkedIn data change over time, so later runs will not be
  byte-for-byte identical.
- Provider search controls, result limits, rate limits, and billing models are
  not identical.
- Pooled recall cannot measure candidates missed by every selected provider.
- A benchmark result applies only to its frozen cohort, run date, runner commit,
  API behavior, and pricing assumptions.

## License

Available under the [MIT License](LICENSE).
