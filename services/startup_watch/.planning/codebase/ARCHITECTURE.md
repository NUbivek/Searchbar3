# ARCHITECTURE

Current architecture is a single-script orchestrator (`startup_watch/startup_watch.py`) with many source-specific scraping functions and shared helper functions in the same module.

Flow:
1. Load YAML config.
2. Collect signals from enabled sources.
3. Apply filters (category/stage/early-stage keyword constraints).
4. Optional enrichment (website metadata + LinkedIn company page enrichment).
5. Dedupe results.
6. Export CSV.

There is no plugin class system yet; source adapters are implemented as functions.
