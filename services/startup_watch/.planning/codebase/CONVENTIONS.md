# CONVENTIONS

- Config-first behavior via YAML files.
- Uses dataclass (`StartupSignal`) for normalized records.
- Source functions return `List[StartupSignal]`.
- Filtering/dedupe are centralized helper functions.
- CI config disables LinkedIn scraping and auth-bound enrichment.
- Output naming uses timestamped CSV filenames.
