# Startup Watch

Config-driven startup sourcing pipeline for supply chain, manufacturing, AgTech, and industrial AI.

## Quick start

```bash
python startup_watch/startup_watch.py --config startup_watch/config.yaml
```

CI-safe mode (disables auth-bound flows like LinkedIn):

```bash
python startup_watch/startup_watch.py --config startup_watch/config.github.yaml
```

## Configuration model

Top-level config is YAML-first and deterministic.

Key sections:

- `pipeline`
  - `adapter_retries`: retries per adapter after first failure
  - `adapter_backoff_seconds`: linear backoff between retry attempts
  - `adapter_delay_seconds`: optional delay between adapters (rate limiting)
- `categories`, `stages`
- `filters`
- `*_adapter` blocks for each source

## CI / production automation

GitHub Actions workflow: `.github/workflows/startup_watch.yml`

- Runs weekly (Monday schedule)
- Supports manual dispatch
- Uses `startup_watch/config.github.yaml`
- Saves `startup_watch/output/latest.csv`

## Current modular layout

- `startup_watch/schema.py`
- `startup_watch/pipeline.py`
- `startup_watch/filters.py`
- `startup_watch/dedup.py`
- `startup_watch/enrichment.py`
- `startup_watch/logger.py`
- `startup_watch/adapters/`
  - `base.py`
  - all source adapters
  - `linkedin.py` (local-only placeholder; auth-required)

## Contributor workflow

1. Add/update adapter in `startup_watch/adapters/`
2. Wire adapter in `startup_watch/pipeline.py`
3. Add config blocks in `config.yaml` and `config.github.yaml`
4. Add unit tests in `tests/unit/`
5. Run checks:

```bash
python3 -m pytest -q
```

6. Commit only when tree is clean and tests pass.
