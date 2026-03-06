# Requirements

## Functional
1. Scrape 200+ public sources across incubators, accelerators, VC portfolios, databases, and social/news signals.
2. Normalize output into a common startup schema.
3. Infer stage (pre-seed, stealth, seed, series-a, series-b, series-c).
4. Filter by investment thesis categories.
5. Deduplicate records and export CSV.
6. Run locally and weekly in GitHub Actions.

## Non-Functional
- Deterministic config-driven behavior.
- CI-safe mode with auth-required sources disabled.
- Structured logging, retries, and rate limiting.
- Unit tests per adapter and integration tests for pipeline.
