# GAPS

## Closed

1. Startup pipeline is modularized (`schema/pipeline/filters/dedup/enrichment/logger` split).
2. Adapter abstraction is standardized around `BaseAdapter` + per-source class contracts.
3. Test coverage now includes broad adapter unit tests plus integration coverage.
4. CI-safe workflow exists and runs weekly/manual with `config.github.yaml`.
5. Pipeline resilience now includes adapter retries, backoff, and optional inter-adapter delay.

## Remaining minor follow-ups (non-blocking)

1. Legacy OCR folder portability cleanup (hardcoded absolute paths in old extraction scripts).
2. Optional future enhancement: richer structured logging fields/JSON logger formatter.
