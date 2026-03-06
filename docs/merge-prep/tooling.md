# Tooling and Runtime

## Runtime Versions
- Node.js: `v22.22.0`
- npm: `10.9.4`
- Next.js CLI: `v14.1.0`

## Package Manager / Lockfile
- Package manager: `npm`
- Lockfile: `package-lock.json`
- Workspace type: single-package Next.js app

## Core Scripts
From `package.json`:
- Dev: `npm run dev` / `npm run dev:3001`
- Build: `npm run build`
- Start: `npm run start`
- Lint: `npm run lint`
- Unit tests: `npm run test:unit`
- API smoke: `npm run smoke:api`
- Local API smoke (starts server if needed): `npm run smoke:api:local`

## Expected Commands for Merge Validation
- `npm ci`
- `npm run build`
- `npm run lint`
- `npm run test:unit`
- `npm run smoke:api:local`

## Environment Variables

### Core for search/LLM behavior
- `TAVILY_API_KEY` (primary web search provider)
- `SERPER_API_KEY` (secondary web search provider)
- `OPENROUTER_API_KEY` (primary LLM provider)

### Secondary/legacy LLM keys (optional but supported)
- `TOGETHER_API_KEY`
- `PERPLEXITY_API_KEY`
- `OPENAI_API_KEY`

### OAuth / network-tab integration
- `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`
- `TWITTER_CLIENT_ID` (or `TWITTER_API_KEY`), `TWITTER_CLIENT_SECRET`, `TWITTER_REDIRECT_URI`
- `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_REDIRECT_URI`

### App URL and callback resolution
- `NEXT_PUBLIC_BASE_URL`
- `NEXT_PUBLIC_PRODUCTION_URL`
- `NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS`

### Optional market-data paths
- `FMP_API_KEY`, `FRED_API_KEY`

## Notes
- OAuth redirect env vars may use template form like `${NEXT_PUBLIC_BASE_URL}/api/auth/twitter/callback`; code now expands these safely.
- `npm run smoke:api` reads `API_SMOKE_BASE` when provided.
