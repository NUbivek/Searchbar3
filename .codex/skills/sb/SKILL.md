---
name: "sb"
description: "Searchbar3 argument-based command system. Usage: $sb <command> [target] [--flags]. Run $sb help."
metadata:
  short-description: "Searchbar3 unified command system: $sb <command> [target] [--flags]"
---
# $sb — Searchbar3 Command System

You are operating in repo Searchbar3. All $sb commands must:
1) be pattern-based (NO hardcoded line numbers)
2) be fail-safe (no breaking changes)
3) run verification gates after changes:
- npm run build
- powershell -ExecutionPolicy Bypass -File scripts/api-smoke.ps1

Never delete files unless the command explicitly says SAFE_TO_DELETE and the file is a backup (.bak/.new).

## SAFETY PROTOCOL (ALWAYS)
- Before editing: print the file path(s) you will edit and why.
- Only modify files under src/ and config/ and scripts/ (unless told otherwise).
- For API routes:
- Search/LLM providers MUST fail-soft (no 500 on missing keys/provider errors).
- Admin routes MUST remain secure (401/403 when ADMIN_SECRET missing).
- After edits: run build + smoke tests.
- Make a small commit with a clear message.

## COMMANDS

### $sb help
Print this command list with examples.

### RELIABILITY / SEARCH ORCHESTRATION
- $sb scan env [--scope search|llm|all]
Find unguarded process.env usages by scope, output file list + lines.

- $sb guard env [target|all] [--scope search|llm]
Add null guards ONLY to search/llm execution paths (NOT admin auth).
Provider functions should return ProviderResult objects (never throw).

- $sb settle promises [target|all]
Replace Promise.all with Promise.allSettled in orchestration paths only.

- $sb add timeouts [target|all] --ms 8000
Add AbortController or axios timeout to external calls; no infinite waits.

- $sb harden phase1
Executes: scan env → guard env → settle promises → add timeouts
Targets: src/pages/api/search/**, src/utils/**search**, src/utils/**source**
Runs build+smoke tests and commits.

### SOURCE PROVIDERS
- $sb add source <name> [--type hn|rss|serper|api]
Scaffold provider handler + wire into orchestrator.

- $sb disable source <name>
Mark pill unavailable with lock + tooltip, and ensure orchestrator skips it.

- $sb test source <name> --query "<q>"
Run a single-provider test via node script or curl to local API.

### API CONTRACT
- $sb enforce contract search
Ensure POST /api/search always returns stable SearchResponseV1:
requestId, status(ok|partial|degraded|fail-soft), results[], degradedSources[].
Never return 500 for missing keys/provider failures.

### LLM SYSTEM (COST-OPTIMIZED)
- $sb add llm providers
Add provider registry supporting: groq, google(openai-compatible),
openrouter, cerebras, together, perplexity.

- $sb set llm chain <csv>
Set fallback chain; 1 retry max; skip if key missing.

- $sb add llm router
Default: skip synthesis unless user enabled OR query type indicates analysis.
Cap to top 5–7 sources; cache 24h.

- $sb add model switcher ui
Add ModelSwitcher component and API /api/llm/models returning readiness booleans.
Show toast when fallback happens and show provider/model used.

### CURATED VERIFIED SOURCES
- $sb add curated store
Add JSON datastore for curated sources + admin CRUD at /sources protected by ADMIN_SECRET.

- $sb boost curated --points 500
Add +500 boost to curated/verified results and render ⭐ gold badge.

### UI RELIABILITY
- $sb add degraded banner ui
Add DegradedBanner component that renders when degradedSources non-empty.
Ensure empty states are helpful (never blank).

### TOOLING
- $sb dead
List SAFE_TO_DELETE backups (.bak/.new) and REVIEW items without deleting.

- $sb clean
Delete only SAFE_TO_DELETE items and commit.

## VERIFICATION GATES (MUST RUN)
After any command that edits code:
1) npm run build
2) powershell -ExecutionPolicy Bypass -File scripts/api-smoke.ps1

If either fails: revert or fix before proceeding.
