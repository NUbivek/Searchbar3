# SOURCING101 CUSTOM COMMANDS
Argument-based commands for OpenCode + Codex

## /src
Build/manage one adapter.
- `--new <id> "<name>" <url> [--method <rss|html|playwright|api|hn|reddit>] [--auth] [--tier <1-7>]`
- `--test <id>`
- `--list [--tier <1-7>] [--auth-only] [--broken]`
- `--status <id>`

## /batch
Build multiple adapters in sequence.
- `--tier <1..7> [--limit <N>] [--dry-run] [--from <id>]`
- `--list <id1> <id2> ...`
- `--resume`

## /simplify
Refactor without behavior changes.
- `--file <path> [--target "<goal>"]`
- `--module <name> [--target "<goal>"]`
- `--adapter <id> [--target "<goal>"]`

## /enrich
Add enrichment pipeline functions.
- `--field <name> [--source <source>] [--test]`

## /run
Execute pipeline and report metrics.
- `--config <ci|local> [--source <id>] [--dry-run] [--verbose]`

## /lsp
Pyright/type-check support.
- `--enable [--strict]`
- `--check [--file <path>]`
- `--fix <path>`

## /fix
Fix adapters/tests/CI quickly.
- `--adapter <id> [--reason "..."]`
- `--test <path> [--reason "..."]`
- `--ci [--reason "..."]`

## /check
Read-only quality audit.
- `[--full] [--adapter <id>]`

## /stage
GSD phase lifecycle wrapper.
- `--plan <N> [--discuss]`
- `--execute <N>`
- `--verify <N>`
- `--status`
- `--next`

## Quick Reference (9 commands)
1. /src
2. /batch
3. /simplify
4. /enrich
5. /run
6. /lsp
7. /fix
8. /check
9. /stage

## Guardrails
- Never enable LinkedIn in CI config.
- Use canonical stage values only.
- One adapter per atomic commit (source + test + config entries).
- Keep `SCM Companies PItchbook Extract/` separate from `startup_watch/`.
