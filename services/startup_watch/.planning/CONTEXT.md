# SOURCING101 — PROJECT CONTEXT
Load this file at the start of every session and every subagent spawn.

## OWNER & PURPOSE
- Owner: Bivek Adhikari, VC analyst
- Goal: Identify pre-seed/stealth/seed/Series A startups in supply chain, manufacturing, and AgTech before they appear in standard VC databases
- Runtime: Python 3.10+, macOS Apple Silicon (local) + Ubuntu 22.04 (CI)
- Repo: https://github.com/NUbivek/sourcing101.git

## INVESTMENT THESIS
Priority verticals:
1. Supply Chain Intelligence
2. Manufacturing Tech
3. AgTech
4. Industrial AI / IoT
5. Procurement & Sourcing
6. Supply Chain Finance
7. Warehousing & Intralogistics
8. Supply Chain Risk

Stage targets: pre-seed, stealth, seed, series-a, series-b, series-c
Geography: US, Canada, EU, Israel, Australia, NZ

## REPO DIRECTION
Target structure for incremental refactor:
- `startup_watch/startup_watch.py` (entrypoint)
- `startup_watch/schema.py`
- `startup_watch/pipeline.py`
- `startup_watch/filters.py`
- `startup_watch/dedup.py`
- `startup_watch/enrichment.py`
- `startup_watch/logger.py`
- `startup_watch/adapters/*.py`
- `tests/unit`, `tests/integration`

Legacy OCR subproject (`SCM Companies PItchbook Extract/`) is separate and low priority.

## SOURCE TIERS (target)
1. University incubators
2. Private accelerators
3. VC portfolios
4. News/RSS
5. Public databases
6. Specialized industry
7. Social signals

## SCRAPING RULES
- Static pages: requests + BS4
- JS pages: Playwright
- RSS/Atom: feedparser
- JSON/XHR: requests + json
- LinkedIn: local-only, never CI

## CODING STANDARDS
- Python 3.10+, PEP8, full type hints, docstrings for public methods
- Absolute imports
- `os.getenv()` for secrets
- Retry network calls with exponential backoff
- Random request delays (2–5s)
- Adapters implement a common contract returning list of normalized startup signals

## CI RULES (CRITICAL)
- `config.github.yaml` disables LinkedIn/auth-required sources
- Never hardcode credentials, machine paths, or usernames
- Auth-required adapters must stay disabled in CI

## STAGE INFERENCE CANONICAL VALUES
- pre-seed
- stealth
- seed
- series-a
- series-b
- series-c

## TASK SIZE CONSTRAINTS
- 2–3 tasks per phase
- One adapter OR one core module per task
- End every task with tests + lint + atomic commit

## VERIFICATION CHECKLIST
```bash
python -m pytest tests/ -x -q
python -m flake8 startup_watch/ --max-line-length=100
git log --oneline -3
```

For adapter work:
```bash
python -c "from startup_watch.adapters.<id> import <ClassName>; print(<ClassName>().fetch()[:2])"
```
