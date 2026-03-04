# Reconciled Build Plan

This merges the two provided build plans into one execution order for `Searchbar3`.

## Guiding Split

- The detailed build plan is the long-range sourcing engine roadmap: registry, adapters, scheduler, enrichment, scoring, and 200+ sources.
- The master build plan is the immediate Searchbar3 application roadmap: fix the current search stack so the product can reliably power that sourcing engine.

## Execution Order

### Phase A: Stabilize Current Search Stack

1. Enforce fail-soft provider execution.
2. Normalize provider status to `{ source, status, results, error }`.
3. Replace throw-driven provider failures with empty/error envelopes.
4. Use `Promise.allSettled` plus per-provider timeouts in search orchestration.
5. Add real file parsing for PDF, DOCX, CSV, and TXT uploads.
6. Add guarded URL extraction for custom URLs.

### Phase B: Close Current Product Gaps

1. Keep degraded-mode UX and fail-soft API contract consistent across all search entrypoints.
2. Finish remaining source integrations and model surface cleanup.
3. Keep build + smoke validation attached to each patch.

### Phase C: Add Sourcing Pipeline Inside This Repo

1. Create `sources/registry.json` plus schema validation.
2. Add adapter scaffolding for the first Tier-A sources.
3. Write normalized `StartupSignal` JSONL output.
4. Add scheduler/state for incremental runs.

### Phase D: Expand To Full Sourcing System

1. Import the 176-source library.
2. Extend to 200+ sources.
3. Add enrichment: funding, investors, website, headcount.
4. Add thesis filtering, scoring, and daily CRM-ready rollups.

## Immediate Transport From OpenClaw

These were the first portable items and are now the correct starting point in this repo:

1. Fail-soft provider normalization and orchestration hardening.
2. Real upload parsing in `/api/upload`.
3. URL extraction in `/api/fetch-url` and custom URL search handling.

## Current Scope Completion Rule

For the app layer, the next patches should continue in this order:

1. Verify `npm run build` stays green.
2. Re-run API smoke coverage against the updated routes.
3. Continue remaining master-plan gaps only after the app layer is stable.
