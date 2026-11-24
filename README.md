# Research Hub

A due-diligence research tool for venture investors: search a company or
person across curated VC/startup sources, Hacker News and the web, get an
answer written only from those sources with checked citations, keep the work
in deal workspaces, and watch companies for new funding, people and filings.

Next.js 14 (pages router), React 18, Tailwind. Deploys to Vercel. Every AI
feature runs on free providers first; nothing is paid unless you turn it on.


Maintainers: start with `CODEX-HANDOVER.md` (current state, hard rules, maintenance run every two weeks) and `AGENTS.md`.

## Design and language

The interface is deliberately quiet (`DESIGN.md`): a light canvas, white
cards, near-black primary actions, one muted steel-blue accent for links,
focus rings and citations, no gradients or colour blocks. Navigation is the
three-flow switch under a minimal top bar (wordmark; Workspaces, Watchlist
and the account menu as small text on the right). Every page is title, the
one input that matters, then content; subtitles, taglines and footers were
removed, and the example questions live inside the search bars (a rotating
placeholder plus a dropdown on focus). Copy is short and specific, never
mentions pricing tiers, keys or environment variables, and says "not enabled
on this deployment" when a capability is missing. Controls that are not the
main action (model, date filter, workspace filing) are small, borderless and
blend into the card; the source toggles are the one row meant to stand out.

## What it does

The three flows are **Open Research**, **Network Map** and **Founder
Check**, switched at the top of every page. **Workspaces** and **Watchlist**
sit quietly at the top right for signed-in users.

### Open Research (`/`)
- Sources you can toggle: curated registry (on by default, no key), Web,
  LinkedIn, X, Reddit, Substack, Medium, Crunchbase, Pitchbook, Carta,
  Verified (SEC EDGAR, FMP market data when `FMP_API_KEY` is set, plus the
  government group below), and three source groups
  (`src/utils/sources/sourceGroups.js`): **Government & regulators** (SEC,
  Federal Reserve and FRED, FDIC, OCC, CFPB, FTC, DOJ, CMS, FDA, Census, BLS,
  Treasury, state business registries, UK and EU regulators), **Patents &
  IP** (USPTO, Google Patents, Copyright Office, WIPO, EPO, UK IPO; DARPA,
  ARPA-E, IARPA, NSF, NIST, NASA, NIH RePORTER, SBIR awards) and
  **Institutions & research** (UN, World Bank, IMF, OECD, WHO, WEF; McKinsey,
  BCG, Bain, the Big Four, Gartner, Forrester; Brookings, RAND, Pew, NBER,
  CFR; SSRN, arXiv, CB Insights, Statista, HBR). Government and IP hits are
  tiered as filings, institutional hits as reputable reports.
  Everything except the curated registry, Hacker News and SEC needs a web
  search key (`SERPER_API_KEY` or `TAVILY_API_KEY`); the platform toggles and
  the groups are site-restricted web searches, not platform APIs. The
  curated registry also carries official and institutional feeds (SEC, Fed,
  FTC, DOJ, CFPB, NSF, DARPA, arXiv, McKinsey, Brookings, Pew, HBR, IMF, CB
  Insights) under the `government`, `ip_research` and `institutions_research`
  categories.
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
- The model is always "Auto": the strongest model available right now
  (`/api/llm/models`); there is no model menu in the UI. Under the search
  box, the "Published" date filter and the workspace filing are one quiet
  line; the source row starts with an **All**
  chip (select or clear every source), then the sources, then **Custom**
  (your own URLs and uploaded files), separated by thin dividers.
- After a search about a company, a **Your network** panel lists who you know
  there, at its investors and competitors, and which experts and investors in
  your network cover its sector (see Network Map).

### Founder Check (`/founder`)
A background check on one named person, in two parts. The **quick brief**
(under a minute): career timeline, past companies, education, litigation
mentions, press, public profile snippets, disambiguation when several people
share a name, and *Who can help diligence this founder* from your imported
network. The **deep background check** (a few minutes, signed in): a loop
over about forty free public sources that pulls every thread it finds:
courts and regulators, sanctions and watchlists, SEC filings and company
registers in several countries, patents, archived versions of profiles and
bios with **claims that changed over time**, relatives and associates in
public roles (related-party diligence), and company-level breach and
leak-site exposure. Every record is graded for whether it is really about
this person (a name-only match is never shown as a fact), cleaned by fixed
privacy rules, and cited. It learns which sources and queries produce
evidence and runs those first next time. Full description, rules and how to
add a source: `FOUNDER-CHECK.md`.

### Network Map (`/network`)
Your own contacts, read back to you in the file's own words. Drop
LinkedIn's `Connections.csv` or any CSV/XLSX of contacts (X following lists
as JSON too), or connect the firm's Attio CRM: Attio people are saved as
*direct* (their strongest connection in Attio is you) or *firm-wide* (a
colleague's contact, labelled with the colleague) and the two are never
confused on the map or in answers.

The first screen after an upload is built from the upload:

- **Your network at a glance**: a few plain sentences ("You know 544 people
  at 254 companies: 112 investors and 97 engineers. The most at Stripe (22)
  and Google (19). ..."), then **shortcuts** made from the file's own roles,
  companies, tags, places, industries and dates, each with its count. A
  pipeline or fundraising list leads with its tags; a healthcare list with
  clinicians and researchers. Nothing here is a fixed label.
- Pressing a shortcut switches to those people: they light up on the globe
  and are listed beside it. "Narrow to" in the list combines up to three.
- **The people list**: Find, sort, rows that open in place (company
  profile, founder check, intro paths), Copy and Download CSV.
- **Ask**: "Who do I know at Google?", "Which investors do I know?",
  "prospects in New York", "people I connected with this year", "Intro
  paths to Stripe", with three example questions built from the file. The
  answer shows in the same list and lights the same globe. A count for the
  same people is the same number in the read-out, on its shortcut, on the
  globe and in an answer.

The map is a globe you can spin: you are its core, groups sit on the inner
shell, companies further out and people on the surface. Each company is a
burst of rays, one per person, most senior closest to its core. "Arrange by"
offers role, company, industry, place and tag, and only the arrangements
that split this file; under By role the groups are the file's own role
families. Drag to spin, scroll to zoom, click a group or company to open it
and list its people; a breadcrumb shows where you are. The globe is
see-through and used all the way round; it is light by default with a dark
palette (`theme` prop). The layout is computed once with no physics, so the
same contacts always give the same globe.

Every contact is read from its title and employer into a role family and,
from the employer only, an industry. Matching is deterministic over your
contacts; nothing from the file is ever sent to an AI provider. LinkedIn
does not give apps your connections, so the page offers no LinkedIn
sign-in, only the export upload. Signed in, contacts are saved to your
account; signed out, they stay in the browser tab. Full description in
`NETWORK-MAP.md`.

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

## AI models (only ones that cost nothing, strongest first)

`src/server/llm/providers.js` keeps two promises.

**It cannot spend money.** A model is only called when it is on that
provider's allow-list:

| Provider | Key | What may be called |
|---|---|---|
| Google Gemini | `GOOGLE_AI_API_KEY` or `GEMINI_API_KEY` | the models on the free tier (Gemini 4 Hydrogen, the Flash and Flash-Lite models, Gemma). Free only while the key's Google project has no billing account: that cannot be checked from code |
| OpenRouter | `OPENROUTER_API_KEY` | ids ending in `:free` that the catalogue prices at zero and that output text only |
| Groq | `GROQ_API_KEY` | the three chat models on the free plan. If Groq ever reports paid-plan limits for the key, Groq is switched off |
| NVIDIA (optional) | `NVIDIA_API_KEY` | a short list of hosted models; off until a key is added |

Keys for paid services (Together, Cerebras, Perplexity, OpenAI) are never
read, and there is no switch that turns a paid model on. A model id sent by
the model menu goes through the same list, so an id that is not on it is
ignored.

**It asks the strongest model that can answer in time.** Every allowed model
has a quality score from public benchmark results (the table at the top of
`providers.js`; refresh it when the line-up changes). The order is that
score adjusted by what has happened on this site (`src/server/learning.js`):
how often the model answered, whether its answer passed the caller's checks,
and how long it takes compared with the time left. On top of that:

- **Tasks.** `analysis` (the deep background check report: strongest models,
  more thinking, and no model with a poor record on made-up facts), `chat`
  (search answers, data room) and `extract` (many small structured calls:
  the high-allowance models first).
- **Allowances.** A model that is out of allowance rests until its limit
  resets, on every server instance, instead of being asked on each request.
  The last daily calls of the best models are kept for reports.
- **Checks.** Callers pass their own check of the answer (sections,
  citations). An answer that fails goes to the next model, and only when
  every model fails does the page fall back to an answer quoted from sources.
- **People.** Text about a named person under review is not sent to models
  served from another jurisdiction. Set `LLM_SKIP_GEMINI_FOR_PEOPLE=true` to
  also keep it away from Gemini, whose free-tier terms ask not to submit
  personal information (people checks then use the next-best models).

`GET /api/debug/llm-check` shows the order in use for each task without
calling a model; `?run=chat|analysis|extract|json` makes one small real call.
With no key set, answers are quoted from sources and the page says so.
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
| `GOOGLE_AI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` (optional `NVIDIA_API_KEY`) | AI answers, from models that cost nothing |
| `LLM_SKIP_GEMINI_FOR_PEOPLE` | `true` keeps text about a person under review away from Gemini |
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
