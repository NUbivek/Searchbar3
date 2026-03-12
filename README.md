# Searchbar3

`Searchbar3` is the active Next.js application for startup sourcing, candidate ranking, research/search workflows, and related network/integration surfaces.

This README is the current handoff document for the codebase as of `2026-03-12`.

## What This App Is

This repo is no longer just a generic “research hub” search UI.

Today it contains four meaningful product layers:

1. `Sourcing / startup candidate workflow`
   - Curated source registry
   - Source adapters and sourcing runner
   - Signal normalization and local artifacts
   - Raise-candidate API and UI

2. `Research / search product shell`
   - Open research and verified-source search surfaces
   - LLM-assisted research workflows
   - Multi-source search and result presentation

3. `Network / auth / integration surfaces`
   - LinkedIn / Twitter / Reddit / network routes
   - Integration routes and local glue code

4. `Local enrichment + ranking layer`
   - Funding enrichment cache
   - Description enrichment cache
   - Candidate scoring and explanation generation

## Current Status

The codebase has gone through a large stabilization pass focused on the startup-sourcing surface.

What is materially improved:

- startup candidate page exists at [`src/pages/sourcing.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/pages/sourcing.js)
- raise-candidates API exists at [`src/pages/api/startups/raise-candidates.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/pages/api/startups/raise-candidates.js)
- funding cache and free description cache are wired into candidate generation
- junk-name filtering is much stronger than before
- `Visit ...` prefix contamination has been removed
- stage and funding-round mismatches in top results are reconciled
- bare `SaaS` tags are removed from the user-facing sector taxonomy
- tier labels are normalized and displayed consistently

What is still not finished:

- live candidate totals are still below the aspirational target
- early-stage / pre-seed coverage is still underrepresented
- some registry sources still produce low or zero yield
- a few mature / non-target companies can still rank too highly
- some descriptions still rely on heuristic fallbacks

This commit should be treated as a strong checkpoint, not a “done” state.

## Source Of Truth

Within the broader `source-and-search` workspace, this repo is the active app codebase.

For practical work, treat this repo as the source of truth for:

- frontend
- startup sourcing UI
- candidate API
- local enrichment scripts
- sourcing pipeline logic
- deployment config

## Product Surfaces

### 1. Startup sourcing

Main page:
- [`src/pages/sourcing.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/pages/sourcing.js)

Primary behavior:
- reads from local candidate API
- supports filters for search, stage, country, sector, tier, and source
- displays funding, descriptions, source, country, score, and rationale
- uses local artifacts instead of the old stale `sourcing101/startup_watch` fallback

### 2. Raise candidates API

API route:
- [`src/pages/api/startups/raise-candidates.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/pages/api/startups/raise-candidates.js)

Responsibilities:
- loads local candidate store
- applies filters
- returns rows, totals, facets, and debug stats
- supports refresh action for local ingestion

### 3. Research/search shell

The legacy research app still exists and is documented in:
- [`ARCHITECTURE.md`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/ARCHITECTURE.md)
- [`USER_FLOW.md`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/USER_FLOW.md)
- [`TEST_PLAN.md`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/TEST_PLAN.md)

Those docs are still useful for the broader app shell, but they do not fully describe the new sourcing stack below.

## Architecture Map

### High-level flow

```text
sources/registry.json
  -> src/sourcing/registry.js
  -> src/sourcing/planner.js
  -> src/sourcing/runner.js
  -> src/sourcing/adapters/*
  -> src/sourcing/normalizer.js
  -> data/signals.jsonl + data/*.csv summaries
  -> scripts/enrich-funding.js
  -> scripts/enrich-descriptions.js
  -> src/lib/raiseCandidatesStore.js
  -> src/lib/raiseScoring.js
  -> src/pages/api/startups/raise-candidates.js
  -> src/pages/sourcing.js
```

### Core modules

#### Source registry

- [`sources/registry.json`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/sources/registry.json)

This is the master list of portfolio pages, accelerators, startup databases, conferences, and other sourcing inputs.

Important notes:
- registry quality is one of the main determinants of output quality
- many historical sources were quarantined or disabled
- tiers are now partially populated for newer VC additions, but much of the older registry still has `unset`

#### Runner and planner

- [`src/sourcing/planner.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/sourcing/planner.js)
- [`src/sourcing/runner.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/sourcing/runner.js)

Responsibilities:
- choose which sources should run
- respect disabled sources and auth constraints
- execute adapters
- normalize and validate signals
- export run artifacts and source-health summaries

#### Adapters

Most sourcing volume comes through:
- [`src/sourcing/adapters/htmlListAdapter.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/sourcing/adapters/htmlListAdapter.js)

This adapter now handles:
- generic HTML list extraction
- `__NEXT_DATA__` parsing for some portfolio pages
- link filtering
- junk label rejection
- `Visit ...` prefix stripping

#### Signal normalization

- [`src/sourcing/normalizer.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/sourcing/normalizer.js)

Responsibilities:
- canonical company names
- region normalization
- thesis tag normalization
- funding/hiring/investor/website enrichment attachment
- junk-name rejection
- final signal shaping for `signals.jsonl`

#### Candidate store

- [`src/lib/raiseCandidatesStore.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/lib/raiseCandidatesStore.js)

This is the effective heart of the startup lead product.

Responsibilities:
- load `signals.jsonl` and CSV fallbacks
- merge funding and description caches
- normalize names, funding, countries, tiers, sectors
- reject placeholders and stealth junk
- build API rows, facets, rationale, and debug stats
- score results and paginate them

#### Scoring

- [`src/lib/raiseScoring.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/lib/raiseScoring.js)

Current scoring signals include:
- months since last round
- funding confidence
- round stage
- momentum
- accelerator recency
- source tier
- signal confidence

This is still heuristic. It is useful, but not yet a rigorously calibrated model.

## Data Artifacts

### Runtime data directory

Current local runtime artifacts live in `data/`:

- `signals.jsonl`
- `funding_cache.json`
- `description_cache.json`
- `latest_run_summary.json`
- `source_health.csv`
- `source_state.json`
- `crm_export.csv`
- `daily_rollup.csv`
- `category_rollup.csv`

Important:
- most `data/*.csv` and `signals.jsonl` are intentionally ignored in git
- the two cache files are useful to keep because the UI/runtime benefits from them immediately

### What the app actually reads

Primary candidate input:
- `data/signals.jsonl`

Primary enrichment caches:
- `data/funding_cache.json`
- `data/description_cache.json`

Fallbacks:
- `data/crm_export.csv`
- historical report snapshots if present

## Free Enrichment Architecture

No paid API dependency is required for the current enrichment path.

### Funding enrichment

- [`scripts/enrich-funding.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/scripts/enrich-funding.js)

Current working approach:
- Google News RSS
- TechCrunch RSS fallback
- company site / news pages in limited cases
- no paid Anthropic or OpenAI API dependency

Current weakness:
- ambiguity and large-company contamination still need additional work

### Description enrichment

- [`scripts/enrich-descriptions.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/scripts/enrich-descriptions.js)

Current approach:
- website `og:description`
- website `meta description`
- website `twitter:description`
- Google News RSS fallback
- heuristic fallback from source/tags

This is intentionally free-only.

## Commands That Matter

### Local app

```bash
npm install
npm run dev:3001
```

Use `3001` for this workspace if `3000` is occupied by older processes.

### Validation

```bash
npm run sourcing:validate
npx jest --runInBand tests/unit/sourcing.test.js
```

### Targeted maintenance scripts

```bash
npm run validate:names:rules
npm run enrich:funding:test
npm run enrich:funding
npm run enrich:descriptions:dry
npm run enrich:descriptions:high
```

### Sourcing pipeline

```bash
npm run sourcing:plan
npm run sourcing:run
```

Do not assume a full sourcing run is lightweight. It is the heaviest operation in the project.

## Current Product Features

### Candidate table

Each row can expose:
- startup name
- description summary
- stage
- funding amount
- last round type
- last round date
- country / inferred geography
- source tier
- source name
- raise likelihood score
- forecast label
- rationale points

### Filters

Current main filter row is intentionally compact:
- Search
- Stage
- Country
- Sector
- Tier
- Source

There is no longer a separate Round filter in the UI.

### Ranking behavior

The `/sourcing` experience is meant to answer:
- Which startups look likely to raise in the next 6 months?
- Which ones are aligned to the sourcing thesis?
- Which are backed by credible sources or investors?

## Known Gaps

These are the main unresolved issues worth preserving in writing.

### 1. Coverage still under target

The biggest remaining problem is source yield.

Symptoms:
- many enabled sources produce zero signals
- some added early-stage funds are blocked, moved, or low-yield
- live candidate totals are still below the target previously being chased

### 2. Pre-seed coverage is thin in live results

Raw pre-seed signals exist, but live candidate output underweights or filters many of them.

### 3. Funding coverage is good in top-ranked rows, but not broad enough overall

Funding cache helps top candidates a lot, but full coverage remains partial.

### 4. Mature-company leakage still happens

Some large incumbents or late-stage non-target entities can still enter the candidate pool if sourced from portfolio or news pages.

### 5. Registry remains a long-term maintenance problem

The registry is much better than before, but still contains:
- stale URLs
- low-yield pages
- uneven tier metadata
- mixed source quality

## Recommended Resume Plan

If this project is picked up later, the safest restart order is:

1. Start the local app and verify `/sourcing`
2. Run:
   ```bash
   npm run sourcing:validate
   npx jest --runInBand tests/unit/sourcing.test.js
   ```
3. Check live API totals:
   ```bash
   curl -s "http://127.0.0.1:3001/api/startups/raise-candidates?page_size=25"
   ```
4. Audit the current top 25 manually
5. Improve only one of these at a time:
   - source coverage
   - junk filtering
   - description quality
   - funding coverage
   - stage / geography calibration

Do not combine a full sourcing rerun, a large registry rewrite, and candidate-scoring changes in the same pass unless there is time to re-validate everything.

## Files Worth Starting With

If someone needs to understand the current stack quickly, start here:

1. [`src/pages/sourcing.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/pages/sourcing.js)
2. [`src/pages/api/startups/raise-candidates.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/pages/api/startups/raise-candidates.js)
3. [`src/lib/raiseCandidatesStore.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/lib/raiseCandidatesStore.js)
4. [`src/lib/raiseScoring.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/lib/raiseScoring.js)
5. [`src/sourcing/adapters/htmlListAdapter.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/sourcing/adapters/htmlListAdapter.js)
6. [`src/sourcing/normalizer.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/sourcing/normalizer.js)
7. [`src/sourcing/runner.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/src/sourcing/runner.js)
8. [`scripts/enrich-funding.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/scripts/enrich-funding.js)
9. [`scripts/enrich-descriptions.js`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/scripts/enrich-descriptions.js)
10. [`sources/registry.json`](/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My%20Drive/MBA/VC/Resume%20%26%20Applications/Startups%20to%20recommend/Bulk%20Data/Searchbar3/sources/registry.json)

## Hibernation Notes

This repo is now in a reasonable checkpoint state for pausing work.

What is safe to assume on return:
- the startup sourcing surface is real and usable
- the code now has a coherent candidate pipeline
- cleanup and enrichment systems exist and are wired in

What is not safe to assume on return:
- totals are “done”
- registry coverage is complete
- funding enrichment is complete
- ranking is calibrated for production-quality lead quality

If resuming later, treat this as a maintained prototype with real pipeline value, not as a finished sourcing platform.
