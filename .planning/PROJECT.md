# Searchbar3 — VC Research Search Platform

## What This Is
A VC research search platform that searches curated verified sources, web, social, market data, and user uploads.

## Current Build Goals
- /api/search never returns 500 for provider/key failures
- Promise.allSettled + timeout guards in source orchestration
- HN fallback always available
- Free-LLM fallback chain with caching
- Curated source prioritization + verified badge
- File + URL context included in synthesis
- Admin sources CRUD scaffold
- Connector scaffolds disabled by feature flag
