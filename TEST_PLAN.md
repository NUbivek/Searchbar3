# Searchbar Test Plan (User Journey + Functional)

## Desired User Journey (from USER_FLOW.md + README)

1. User enters query in Open Research.
2. App detects context and selected sources.
3. API search executes with best-effort fallback.
4. Results are normalized, scored, categorized.
5. Optional LLM synthesis is shown with source attribution.
6. User can switch between single/multi source scenarios.

## Critical Acceptance Criteria

- Search API never crashes on normal input.
- Missing provider keys should return useful degraded output or explicit actionable error.
- Single source `Web` should be functional when Serper key is valid.
- Multi-source search should return partial results if some providers fail.
- OAuth initiation routes should be reachable for LinkedIn/Twitter/Reddit.
- Build must pass on every change.

## Test Cases

### A. Build and static checks
- A1: `npm run build` succeeds.
- A2: No syntax/parser failures in API routes.

### B. API contract smoke tests
- B1: `GET /api/debug/env-check` returns diagnostics payload.
- B2: `POST /api/search` with empty body returns `400 Query is required`.
- B3: `POST /api/search` with query but missing/invalid Serper key returns controlled config error (not crash).

### C. OAuth route availability
- C1: `GET /api/auth/twitter` responds (redirect or config error JSON).
- C2: `GET /api/auth/linkedin` responds (redirect or config error JSON).
- C3: `GET /api/auth/reddit` responds (redirect or config error JSON).

### D. Source behavior
- D1: Single source `Web` path uses `/api/search/web` and returns normalized shape.
- D2: Multi-source request returns JSON with `results`, and does not throw unhandled exceptions.

### E. Regression checks
- E1: Relay pages compile.
- E2: Reddit auth helper import path works from `EnhancedNetworkMap`.

## Manual UAT checklist (production)

1. Open `https://airesearch.bivek.ai`.
2. Run single-source `Web` query and verify results panel + no hard crash.
3. Run multi-source query and verify partial behavior.
4. Open `/api/debug/env-check` and verify expected provider statuses.
5. Click each OAuth connect button and confirm redirect starts.
