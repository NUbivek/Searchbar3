# Assumptions and Open Questions for OpenClaw Integration

## Assumptions used in this prep

1. OpenClaw will execute final cross-repo merge/cherry-pick and resolve destination-specific conflicts.
2. Searchbar3 `openclaw-fixes` is the source-of-truth for current fail-soft search and network behavior.
3. Target repo (Sourcing101 side) may already have overlapping route ownership for `/`, `/api/search`, and auth routes.
4. Environment secrets are managed in deployment platform (Vercel), not committed repo files.
5. Desired UI keeps two top-level modes:
   - `Open Research`
   - `Network Map`

## Open questions requiring explicit resolution during final merge

1. Which repo owns the canonical `/` page shell after merge?
2. Should `/network` be a separate route, or rendered as a tab panel under `/` in target?
3. Which auth implementation is canonical for OAuth state/token storage (Searchbar3 vs target)?
4. Which API contract is canonical for network analyze responses if target already has one?
5. Should Together remain enabled as secondary for network analysis, or be replaced with OpenRouter parity there too?
6. Are there target-side middleware wrappers (auth, logging, CORS) that all `/api/network/*` routes must adopt?
7. Should `.fixed` / `.bak` artifacts be retained for historical reference or excluded from final integration scope?

## Non-goals of this prep branch

- No final cross-repo merge.
- No history rewrite.
- No destructive cleanup of potentially-referenced modules.

