# New-Tab UI Integration Map (Searchbar3)

## Scope
This map covers the "new tab" experience in Searchbar3:
- `Open Research` tab (`/`)
- `Network Map` tab (`/network`)

It isolates code that OpenClaw can port from Searchbar3 into Sourcing101 during final integration.

## Entry Points

### Routes
- `src/pages/index.js`
  - Open Research page entry.
  - Owns default model selection and renders open-search UI.
- `src/pages/network.js`
  - Network Map page entry.
  - Owns account connection state, network fetch flow, and network query flow.

### Shared tab navigation
- `src/components/ModeTabs.js`
  - Reusable mode switcher for `Open Research` vs `Network Map`.
  - Refactor added in prep branch to remove duplicated tab markup from both pages.

### Primary UI components
- `src/components/OpenSearch.js`
  - Open Research search form, source selection, model selection, and results rendering.
- `src/components/NetworkDebug.js`
  - Optional diagnostics rendering for network flow.

## API Dependencies

### Open Research
- `POST /api/search`
  - Primary open-search endpoint.
- `GET /api/search/hackernews`
  - Optional fallback provider path.

### Network Map
- `POST /api/network/analyze`
  - Natural-language network query analysis.
- `GET /api/network/linkedin/index`
  - Fetch LinkedIn-derived network payload.
- `GET /api/network/twitter`
  - Fetch Twitter/X-derived network payload.
- `GET /api/auth/linkedin/token`
  - LinkedIn auth status.
- `GET /api/auth/twitter/token`
  - Twitter auth status.
- `GET /api/auth/linkedin`, `GET /api/auth/twitter`
  - OAuth start routes.
- `POST /api/auth/linkedin/logout`, `POST /api/auth/twitter/logout`
  - Disconnect routes.

## Data / state contracts

### Mode tabs
- `ModeTabs` contract:
  - prop: `activeMode` (`"open"` | `"network"`)
  - route target only; no global store dependency.

### Network page state (`src/pages/network.js`)
- `connectionStatus`: `{ LinkedIn: boolean, Twitter: boolean }`
- `networkData`: normalized object with `connections`, optional `user`/`twitterUser`, source flags
- `searchResults`: result from `/api/network/analyze` with fail-soft support

### Network analysis response contract (observed)
- `{ status, matches, filteredConnections, summary, responseText, degradedSources, error }`
- API should return 200 fail-soft payloads for provider/runtime failures.

## Shared UI primitives and styling dependencies
- Tailwind utility classes are used directly in page markup.
- React icon dependencies:
  - `react-icons/fa`
  - `react-icons/fa6`
- No external design system dependency for tab header after refactor; now local component.

## Feature flags / config toggles involved
- Runtime env gates for provider behavior are handled server-side (search + LLM + social auth).
- Frontend tab UI itself has no feature-flag gating.

## Exact file map (new-tab relevant)

### UI routes and shared component
- `src/pages/index.js`
  - Open Research route and model default wiring.
- `src/pages/network.js`
  - Network tab route, account connect flow, network query UX.
- `src/components/ModeTabs.js`
  - Shared tab-mode switcher (added in prep branch).

### Network processing utilities and APIs
- `src/pages/api/network/analyze.js`
  - Main network analysis API endpoint.
- `src/utils/networkLLMUtils.js`
  - LLM + heuristic fallback path for network analysis.
- `src/pages/api/network/linkedin/index.js`
  - LinkedIn network fetch endpoint.
- `src/pages/api/network/linkedin/connections.js`
  - LinkedIn connection graph extraction.
- `src/pages/api/network/twitter/index.js`
  - Twitter/X network fetch endpoint.
- `src/pages/api/network/query.js`
  - Alternate network query API path.
- `src/pages/api/network/llm-search.js`
  - Alternate LLM network search API path.

### Auth routes tied to network tab
- `src/pages/api/auth/linkedin/index.js`
- `src/pages/api/auth/linkedin/callback.js`
- `src/pages/api/auth/linkedin/token.js`
- `src/pages/api/auth/linkedin/logout.js`
- `src/pages/api/auth/twitter/index.js`
- `src/pages/api/auth/twitter/callback.js`
- `src/pages/api/auth/twitter/token.js`
- `src/pages/api/auth/twitter/logout.js`

## Coupling found and prep refactor

### Coupling found
- Tab header markup was duplicated across:
  - `src/pages/index.js`
  - `src/pages/network.js`
- This duplication increases merge conflict risk when integrating tab UX into Sourcing101.

### Refactor applied (no behavior change)
- Added `src/components/ModeTabs.js`.
- Replaced duplicated mode tab markup in both pages with:
  - `<ModeTabs activeMode="open" />`
  - `<ModeTabs activeMode="network" />`
- No API contract or route behavior changes in this refactor.
