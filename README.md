# Research Hub

A due-diligence research tool for venture investors: search a company or
person across curated VC/startup sources, Hacker News and the web, get an
answer written only from those sources with checked citations, keep the work
in deal workspaces, and watch companies for new funding, people and filings.

Next.js 14 (pages router), React 18, Tailwind. Deploys to Vercel. Every AI
feature runs on free providers first; nothing is paid unless you turn it on.

## What it does

The home page has three tabs: **Open Research**, **Network Map** and
**Founder Check**. Signed-in users also get **Workspaces** and **Watchlist**
in the navigation.

### Open Research (`/`)
- Sources you can toggle: curated registry (on by default, no key), Web,
  LinkedIn, X, Reddit, Substack, Medium, Crunchbase, Pitchbook, Carta, and
  Verified (SEC EDGAR, plus FMP market data when `FMP_API_KEY` is set).
  Everything except the curated registry, Hacker News and SEC needs a web
  search key (`SERPER_API_KEY` or `TAVILY_API_KEY`); the LinkedIn/X/Reddit/
  Substack/Medium/Crunchbase/Pitchbook/Carta toggles are site-restricted web
  searches, not platform APIs.
- Custom URLs and uploaded files (PDF, DOCX, CSV, TXT, up to 5 files of
  25 MB) are searched alongside the sources.
- Date filter: any time, past month, past year, past 3 years. Undated items
  are kept and flagged.
- The pipeline (`src/server/search/`): the query is split into the company
  or person, the intent (funding, competitors, team, financials, product,
  legal) and recency; each source gets a rewritten query; results that do not
  name the company are dropped; the rest are ranked by where the company is
  named, intent, recency and source tier (filing > reputable press > blog >
  forum, `src/utils/sourceTiers.js`), and syndicated duplicates are collapsed.
- The answer is written by a free model in five sections (Summary, Key
  Points, Detailed Analysis, Different Perspectives, Follow-up Questions) and
  every sentence is cited with `[Source n]` against the ranked list shown on
  the page. With no model configured, the same sections are quoted from the
  sources instead.
- Claim check (`src/utils/claimCheck.js`, no model needed): funding and
  valuation figures are extracted from every source and marked
  corroborated (2+ sites agree), single-source, or conflicting.
- Model menu: "Auto" picks the best free model available right now
  (`/api/llm/models`); only models each provider serves today are listed.

### Founder Check (`/founder`)
Background brief on a person: career timeline, past companies, education,
litigation mentions (CourtListener, with a free token), press, public profile
snippets as they appear in web search, disambiguation when several people
share a name, and *Who can help diligence this founder*: people in your
imported network at the founder's current and past companies (reference
calls, backchannel) plus sector experts. Every item is a sentence copied
from a fetched source; the brief is AI-written with checked citations or
quoted when no model is configured.

### Network Map (`/network`)
Your own contacts as a map, sorted by what they can do for a fund. Drop
LinkedIn's `Connections.csv` or any CSV/XLSX of contacts (X following lists
as JSON too), or connect the firm's Attio CRM with an API token: Attio
people are saved as *direct* (their strongest connection in Attio is you)
or *firm-wide* (a colleague's contact, labelled with the colleague) and the
two are never confused on the map or in answers. Every contact is classified from its title and company into a
role (LP, investor, founder, executive, operator, banker, lawyer,
accountant, consultant, academic, press) and into three lenses: **raise**
capital, **source** deals, **diligence** a company or founder. The map shows
you in the centre with three role hubs (Investors & LPs, Founders &
operators, Experts & advisors) and every company you know people at hanging
off the hub its people belong to; switch to by-company, by-industry or
by-country views, filter by lens, highlight a name, go full screen, click
anything for details. Ask it questions in
plain words: "Who can help me raise a fund?", "Who sends me deal flow in
fintech?", "Who can diligence an AI company?", "Who do I know at Google?",
"Intro paths to Stripe". Matching is deterministic over your contacts;
contact data is never sent to an AI provider. LinkedIn's API does not give
apps your connections, so LinkedIn sign-in only identifies you. Signed in,
contacts are saved to your account; signed out, they stay in the browser
tab. Full description in `NETWORK-MAP.md`.

The same network is used across the product: after an Open Research search
about a company, on every company profile, and in Founder Check, a **Your
network** panel lists who you know at the company, at its investors and
competitors, and which experts and investors in your network cover its
sector (`POST /api/network/helpers`).

### Company profile (`/company/<name>`)
Funding rounds, investors, key people, competitors, headcount and
public-company data gathered from the curated registry, Hacker News, web
search and SEC EDGAR/FMP. Purely extractive: every fact is a quoted sentence
with a numbered source.

### Workspaces, history and notes (signed in)
- Every search is saved to **History** (`/history`), can be re-run, and can
  be filed under a deal **Workspace** (`/workspaces`).
- A workspace holds its searches, analyst notes, pinned sources, data-room
  documents and a watchlist toggle.
- **Data-room Q&A**: upload documents to a workspace and ask questions.
  Documents are split into passages, ranked with BM25, and the answer cites
  `[D1]`, `[D2]`... Model answers are verified against the passages (uncited
  sentences and numbers not in the cited passage are dropped); without a
  model, matching sentences are quoted.
- **Memo export** (`/workspaces/<id>/memo`): the workspace's summaries,
  notes, sources and documents assembled into one memo with a single
  renumbered source list, as Markdown or DOCX. Nothing is generated.

### Watchlists and alerts (signed in)
Watch a company and the app checks the curated index and Hacker News for new
funding, people, filing, portfolio and press items that name it (last 90
days, every item linked to its source). Checks run on add, on "Check now",
and daily via the Vercel cron in `vercel.json`. Alerts show in the app
(`/watchlist` and the account menu badge); with `RESEND_API_KEY` set, each
scheduled run also emails a digest.

## AI providers (free first)

`src/server/llm/providers.js` tries, in order:

| Order | Provider | Key | Cost |
|---|---|---|---|
| 1 | Groq | `GROQ_API_KEY` | free tier |
| 2 | OpenRouter, `:free` models only | `OPENROUTER_API_KEY` | free |
| 3 | Google Gemini (Flash first) | `GOOGLE_AI_API_KEY` or `GEMINI_API_KEY` | free only while the key's Google project has no billing account |
| 4 | Together | `TOGETHER_API_KEY` **and** `LLM_ALLOW_PAID=true` | paid, off by default |

Each provider's live model list is fetched and cached, so a retired model id
cannot break answers. A rate limit or error moves to the next provider; with
none configured, answers are quoted from sources and the page says so.
`PROVIDER_CAPABILITY_MATRIX.md` lists what each key unlocks.

## Setup

```bash
npm install
cp .env.local.example .env.local   # fill in the keys you have
npm run dev                        # http://localhost:3000
```

Nothing is required to start: with an empty `.env.local` the curated
registry, Hacker News and SEC EDGAR still work, answers are quoted, and
saved history uses an embedded Postgres (PGlite) in `.data/`. Sign-in is
Google only; set `ALLOW_DEV_LOGIN=true` in development to also get a "Local
test user" sign-in on localhost so signed-in features can be tried without
Google credentials.

Environment variables (all in `.env.local.example`):

| Variable | Used for |
|---|---|
| `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_AI_API_KEY` | free AI answers |
| `TOGETHER_API_KEY` + `LLM_ALLOW_PAID=true` | paid AI answers (opt-in) |
| `SERPER_API_KEY` or `TAVILY_API_KEY` | web and news search, and every site-restricted source |
| `FMP_API_KEY` | market data for public companies (Verified source, company profile) |
| `COURTLISTENER_API_TOKEN` | litigation search in Founder Check (free account) |
| `DATABASE_URL` | Neon Postgres in production (history, workspaces, notes, watchlists, contacts); omit locally to use PGlite |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET` | Google sign-in (NextAuth); leave `NEXTAUTH_URL` unset on Vercel so every domain of the project works |
| `CRON_SECRET` | authorises the daily watchlist cron (`Authorization: Bearer`) |
| `RESEND_API_KEY`, `ALERT_EMAIL_FROM` | optional watchlist email digests |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | LinkedIn sign-in on the Network Map |
| `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | X sign-in and following list |
| `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_PRODUCTION_URL`, `NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS`, `LINKEDIN_REDIRECT_URI`, `TWITTER_REDIRECT_URI` | OAuth callback URLs (see below) |

`GET /api/debug/env-check` reports which variables are set (names only,
never values). It is open in development and requires a signed-in session in
production.

### Google sign-in
Create an OAuth client in Google Cloud with one redirect URI per host,
`https://<your-domain>/api/auth/callback/google` (and the localhost
equivalent), then set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`NEXTAUTH_SECRET` (any long random string). Do not set `NEXTAUTH_URL` on
Vercel: NextAuth then uses the host of each request, so the `.vercel.app`
URL and the custom domain both sign in. The consent screen needs a home
page, privacy policy and terms link before Google lets the app leave
"Testing" mode; the app serves `/privacy` and `/terms` for that.

### LinkedIn sign-in (Network Map)
1. Create an app at https://www.linkedin.com/developers/apps and enable the
   "Sign In with LinkedIn using OpenID Connect" product (scopes `openid`,
   `profile`, `email`; LinkedIn no longer grants connection scopes to
   ordinary apps).
2. Add the redirect URL `http://localhost:3000/api/auth/linkedin/callback`
   (and the production one).
3. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`. The callback URL
   is derived from the host the user is on (`https://<host>/api/auth/linkedin/callback`),
   so register every host you serve. `LINKEDIN_REDIRECT_URI` overrides it
   only when it is a real URL on the same host; a value on another host or
   an unexpanded template such as `${NEXT_PUBLIC_BASE_URL}/...` is ignored.

### X (Twitter) sign-in (Network Map)
1. In the X developer portal create a project and app, enable OAuth 2.0
   ("Web App", code flow with PKCE), and copy the OAuth 2.0 Client ID and
   Secret (not the v1.1 API key).
2. Add the redirect URL `http://localhost:3000/api/auth/twitter/callback`
   (and the production one). Scopes requested: `tweet.read`, `users.read`,
   `follows.read`, `offline.access`.
3. Set `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET`. The callback URL is
   derived from the request host like LinkedIn's; `TWITTER_REDIRECT_URI`
   follows the same same-host rule.
Reading who you follow needs a paid X API tier; on the free tier the page
says so and you can import your following list as a file instead.

To test OAuth locally against callbacks registered for production, set
`NEXT_PUBLIC_PRODUCTION_URL` and `NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS=true`.

### Curated sources
`sources/registry.json` lists VC and accelerator portfolio pages, funding
and startup news feeds and market analysis sites. They are indexed in memory
and refreshed every 3 hours. `npm run sourcing:health` checks every source
and writes `sources/registry-health.json`; dead sources are skipped
automatically. `GET /api/sources/curated` shows index status and
`?q=<query>` searches it directly. The other `npm run sourcing:*` scripts
plan, validate and run the registry pipeline (`src/sourcing/`).

## Deployment (Vercel)

Push the repo and add the environment variables above (Neon via Vercel's
integration provides `DATABASE_URL`). Do not set `NEXTAUTH_URL` (see Google
sign-in). Production builds from the `openclaw-fixes` branch; preview
deployments build from every other pushed branch. `vercel.json` schedules `/api/cron/watchlists` daily at 06:00 UTC; set
`CRON_SECRET` so only Vercel can call it. Long routes (`/api/search/open`,
`/api/founder`, `/api/company`, `/api/workspaces/[id]/ask`,
`/api/llm/models`, `/api/cron/watchlists`) declare `maxDuration: 60`.

## Testing

```bash
npm test                      # jest, tests/unit/**
NEXT_DIST_DIR=.next-build npm run build   # production build without disturbing a running `next dev`
# signed-in pages without Google: a second dev server with a local test user
PGLITE_DIR=.data/pglite-3009 ALLOW_DEV_LOGIN=true NEXT_DIST_DIR=.next-dev npx next dev -p 3009
npm run smoke:api             # status-code checks against a running server (API_SMOKE_BASE=http://127.0.0.1:3000)
```

## Code map

```
src/pages/            index, founder, network, signin, watchlist, company/[name],
                      history/*, workspaces/*  (UI)
src/pages/api/        search/open, founder, company, upload, llm/models,
                      sources/curated, history/*, workspaces/**, watchlist, alerts,
                      cron/watchlists, network/{contacts,query,helpers,attio,twitter},
                      auth/[...nextauth], auth/{linkedin,twitter}/*, debug/env-check
src/server/           search/ (queryPlan, retrieve, rank, answer), llm/providers,
                      founderCheck, companyProfile, dataroom, memo, watchlist,
                      network/, store, db, auth
src/utils/            sourceTiers, claimCheck, evidence, fallbackSynthesizer,
                      network/{parseContacts,graph,roles,sectors,grouping},
                      sources/curatedIndex, sourceIntegration, fileProcessing, ...
src/components/       OpenSearch, SourceSelector, ModelSelector, search/results,
                      network/{NetworkGraph,NetworkHelpers}, workspace/, watchlist/
src/sourcing/         curated registry pipeline (used by scripts/sourcing-*.js)
tests/unit/           jest suites (features/ covers each product feature)
```

Other documents: `USER_FLOW.md` (what happens on each page),
`PROVIDER_CAPABILITY_MATRIX.md`, `NETWORK-MAP.md`, `docs/METRICS_SYSTEM.md`,
`CHANGELOG.md`.

## License

MIT, see `LICENSE`.
