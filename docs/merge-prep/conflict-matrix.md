# Merge Conflict Matrix (Searchbar3 -> OpenClaw integration prep)

## Legend
- Risk: `low` | `medium` | `high`
- Strategy types:
  - **Prefer target**: keep destination repo file and port minimal pieces from Searchbar3.
  - **Prefer source**: copy Searchbar3 file as primary implementation.
  - **Layered merge**: preserve both by adding adapter/wrapper/feature flag.

## Conflict-prone paths

| Path / Area | Risk | Why it can conflict | Recommended resolution strategy |
|---|---|---|---|
| `package.json` + `package-lock.json` | high | dependency set and scripts differ across repos; lockfiles conflict frequently | Prefer target for baseline; port only required deps/scripts for new-tab flow (`react-icons`, auth/network deps if missing), then regenerate lockfile once |
| `next.config.js` | high | static export / env injection / webpack rules may differ | Layered merge: keep target defaults, add only required options for imported functionality, avoid overwriting whole config |
| `src/pages/index.js` | high | likely customized in both repos; primary landing route collision | Prefer target page shell; port Searchbar3 mode tabs + open-research integration as composable component |
| `src/pages/network.js` | high | route-level feature likely absent or divergent in target | Prefer source for this route, then adapt imports/services to target conventions |
| `src/components/*` shared UI | medium | component naming/styling overlap possible | Namespace merge: port under explicit names (`ModeTabs`, `NetworkDebug`) and map usage incrementally |
| `src/pages/api/search/*` | high | provider stack and fail-soft behavior likely differs | Layered merge: preserve target search contract, then fold Searchbar3 provider ordering/timeout/fail-soft logic behind existing interface |
| `src/pages/api/network/*` | high | new API namespace likely collides with existing auth/search middlewares | Prefer source for network namespace, then align middleware/auth helpers to target project wrappers |
| `src/pages/api/auth/*` | high | OAuth callback and token handling are environment/domain-sensitive | Layered merge: keep target auth framework, port provider-specific handlers and callback URL logic |
| `src/utils/llmProcessing.js` | high | model routing logic and provider preference may be different | Prefer target contract, port provider-routing strategy (OpenRouter primary, Together secondary) behind same function signature |
| `src/utils/networkLLMUtils.js` | medium | standalone utility but depends on env/provider + response shape | Prefer source with adapter if target uses different LLM client abstraction |
| Tailwind/CSS global styling (`styles/*`, `tailwind.config.js`) | medium | visual regressions if class semantics differ | Prefer target global style system; scope Searchbar3 additions to route-level classes/components |
| Env files / Vercel env | high | key names and callback domains differ | Do not merge env files; use explicit env mapping checklist during integration |

## Naming collisions identified

- Route collisions likely:
  - `/` (`src/pages/index.js`)
  - Potential existing `/network` in target repo
  - `/api/search` namespace
  - `/api/auth/*` namespace
- Utility collisions likely:
  - Generic helper names like `search.js`, `searchUtils.js`, `oauthUtils.js`, `llmProcessing.js`
- Component collisions likely:
  - `OpenSearch`, `NetworkMap`, tab components

## Dependency/version mismatch hotspots

- Next.js pinned to `14.1.0` in Searchbar3; target may differ.
- React major is `18`; ensure target major compatibility.
- Dual LLM client stack (`openai` + `together`) and provider-specific env assumptions.
- Search stack mixes `tavily`/`serper` assumptions inside API handlers.

## Integration order recommendation (conflict-minimizing)

1. Introduce `ModeTabs` + `/network` page shell first (UI only, mocked data path if needed).
2. Port `/api/network/analyze` + `networkLLMUtils` fail-soft local fallback.
3. Port social auth/token/connect endpoints and callbacks.
4. Integrate search provider stack changes (`/api/search` + provider utils).
5. Finalize lockfile/dependency reconciliation and full test/build.

