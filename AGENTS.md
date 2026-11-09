# AGENTS.md — handoff for coding agents (Codex, Claude Code, others)

This file gives a coding agent the context it needs to keep working on this
project. Read it before you change anything. Human-facing docs are
`README.md` (product, setup, env vars), `NETWORK-MAP.md` (the Network Map in
depth), `DESIGN.md` (visual rules) and `USER_FLOW.md`.

Last updated: 2026-11-09, by Claude Code (session that did the audit and
overhaul, the redesign and the Network Map rebuild).

---

## 1. What this is

**Research Hub** is a due-diligence tool for a venture investor (the owner,
Bivek Adhikari, managing partner). It has three flows, switched by a
segmented control at the top of every page:

| Flow | Route | What it does |
|---|---|---|
| Open Research | `/` | Searches curated VC/startup sources, Hacker News, the web, SEC and grouped official/institutional sites; writes a cited answer (free LLMs) or quotes sources; checks funding/valuation claims across sources. |
| Network Map | `/network` | The user's own contacts (LinkedIn export, CSV/XLSX, X, Attio placeholder) as an interactive map grouped by role / company / industry / country with three drill-down layers, plus "ask your network" (raise / source / diligence lenses, intro paths). |
| Founder Check | `/founder` | Background brief on a person, plus who in the user's network can help diligence them. |

Secondary pages: `/company/<name>` (company profile), `/workspaces`
(deal workspaces, data-room Q&A, memo export), `/watchlist` (daily alerts),
`/history`, `/signin` (Google only), `/privacy`, `/terms`.

## 2. Where everything lives

| Thing | Value |
|---|---|
| Local checkout | `/Users/bivekadhikari/Documents/Searchbar3` |
| GitHub | https://github.com/NUbivek/Searchbar3 (`origin`) |
| Working branch (preview) | `claude/research-hub-fix` — all work lands here first |
| Production branch | `openclaw-fixes` — Vercel builds production from it |
| `main` | old; not deployed; do not use |
| Rollback tag | `v-before-audit-2026-11-08` (state before the overhaul) |
| Live site | https://diligence.bivek.ai (custom domain) and https://searchbar3.vercel.app |
| Preview URL | `https://searchbar3-git-claude-research-hub-fix-1bivekadhikari-1506s-projects.vercel.app` |
| Vercel | team `1bivekadhikari-1506s-projects`, project `searchbar3`; repo is linked (`.vercel/`), Vercel CLI logged in |
| Database | Neon Postgres via Vercel's Neon integration (`DATABASE_URL` …) in production/preview; embedded PGlite in `.data/` locally |
| Google OAuth | Google Cloud project `vernal-layout-514204-j4` ("My First Project", org bivek.ai, account hi@bivek.ai), consent app "Research Hub" (External, In production), OAuth client "Research Hub web" with redirect URIs for both hosts |
| DNS | `bivek.ai` at Spaceship; `diligence` CNAME → Vercel (`a9ae8ec2b0b7f170.vercel-dns-017.com.`), `_vercel` TXT verification in place |
| Owner's memory notes (Claude) | `~/.claude/projects/-Users-bivekadhikari-Documents/memory/project-searchbar3-overhaul.md` |

## 3. Rules you must follow

These come from the owner. Treat them as hard constraints.

1. **Never push to production without the owner's explicit "push to
   production" in the current conversation.** Work on
   `claude/research-hub-fix`, push it (`git push origin claude/research-hub-fix`),
   let the owner review the preview, and merge into `openclaw-fixes` only when
   told to.
2. **Always push with an explicit branch name** (`git push origin <branch>`);
   never a bare `git push` (also in `CLAUDE.md`). No force-pushes, no history
   rewrites on shared branches.
3. **Never read `.env` / `.env.local` files, `env-config.txt`, or any
   credential file.** Never print secret values. Environment variable *names*
   are fine (see section 7).
4. **Never print the contents of the user's network, contacts or evidence
   files** (names, sizes and dates only). Never move, copy or delete
   `~/ab_copy`, `~/im_copy`, `~/wa_full_copy` or any messaging/contacts
   database.
5. **Free tools only.** The LLM chain is free-first (Groq → OpenRouter `:free`
   → Gemini); paid Together only with `LLM_ALLOW_PAID=true`. Do not add paid
   services without asking.
6. **Keep the UI clean** (see section 6): no pricing/tier/API-key/env-var
   wording in the UI; say "not enabled on this deployment" when a capability is
   missing. The owner repeatedly asked to remove filler copy, taglines and
   footers.
7. **Keep the original feature set** (Key Insights, scores, badges, claim
   check, the five-section answer). Fix data and behaviour; do not drop
   features to simplify.
8. Secrets are pasted by the owner into Vercel himself. Do not type secrets
   into forms on his behalf.

## 4. Run, build, test

```bash
cd /Users/bivekadhikari/Documents/Searchbar3
npm install
npm test                                   # jest; currently 564 tests, all passing
NEXT_DIST_DIR=.next-build npm run build    # production build without clobbering a running dev server
```

Local dev with a signed-in test user (no Google needed):

```bash
PGLITE_DIR=.data/pglite-3009 ALLOW_DEV_LOGIN=true NEXT_DIST_DIR=.next-dev npx next dev -p 3009
# open http://localhost:3009/signin → "Continue as local test user"
```

- `NEXT_DIST_DIR` is honoured by `next.config.js`; `.next-*` folders are gitignored.
  Never run a bare `next build` while a dev server is running (it corrupts `.next`).
- The owner sometimes runs his own server on :3007 (`.claude/launch.json`);
  its PGlite can be in an aborted state — use :3009 for your checks.
- A realistic 1,200-row LinkedIn `Connections.csv` fixture can be generated
  for testing; the local test user on :3009 already has one imported.
- `tests/unit/OpenSearch.test.js` occasionally fails only when the whole suite
  runs under heavy load (dev server + build at the same time); it passes alone
  and on clean runs. Not a code bug.

## 5. Architecture map

```
src/pages/                 UI pages: index (Open Research), network, founder, company/[name],
                           workspaces/*, history/*, watchlist, signin, privacy, terms
src/pages/api/             search/open, founder, company, upload, llm/models, sources/curated,
                           history/*, workspaces/**, watchlist, alerts, cron/watchlists,
                           network/{contacts,query,helpers,attio,twitter},
                           auth/[...nextauth], auth/{linkedin,twitter}/*, debug/env-check
src/server/                search/ (queryPlan, retrieve, rank, answer), llm/providers (free-first chain),
                           founderCheck, companyProfile, dataroom, memo, watchlist,
                           network/{store,query}, store, db, auth
src/utils/                 sourceTiers, claimCheck, evidence, sourceIntegration (search handlers),
                           sources/{curatedIndex,sourceGroups,…},
                           network/{parseContacts,graph,roles,sectors,grouping}, oauthUtils
src/components/            OpenSearch, SourceSelector, ModelSelector (no longer rendered),
                           layout/PageShell (TopBar, SectionSwitch), network/{NetworkGraph,NetworkHelpers},
                           search/results/*, workspace/*, watchlist/*
src/sourcing/              curated registry pipeline (scripts/sourcing-*.js)
sources/registry.json      ~800 curated sources (RSS/HTML/API) incl. government, ip_research,
                           institutions_research categories
tests/unit/                jest suites; tests/unit/features/* cover each product feature
```

Key behaviours worth knowing before editing:

- **Open Research sources.** `SourceSelector` lists: All | Curated, Web,
  LinkedIn, X, Reddit, Substack, Medium, Crunchbase, Pitchbook, Carta,
  Verified, Gov & regulators, Patents & IP, Institutions | Custom. The three
  groups are defined in `src/utils/sources/sourceGroups.js` (chunked
  `site:` queries; hits kept only on group hosts). Tiers in
  `src/utils/sourceTiers.js` (gov/IP = filing, institutions = press).
  `src/pages/api/search/open.js` `VALID_SOURCES` must list every UI source.
- **Network Map.** Roles/lenses in `src/utils/network/roles.js`; industry and
  country in `grouping.js` (known-employer table → decisive titles → sector
  words); graph data in `graph.js` (hubs pinned at compass points, companies
  placed deterministically on outward arcs, one/two-person companies folded
  into "N other companies"); renderer `src/components/network/NetworkGraph.js`
  (force-graph 2D). Drill path, breadcrumb and bottom navigator bar are in
  `src/pages/network.js` (`DRILL_ORDER`, `drill`, `navigator`).
  **Layout gotchas fixed the hard way:** `warmupTicks` must stay 0 and the
  `center` force must stay disabled, or people scatter away from pinned
  companies.
- **Contacts store.** `src/server/network/store.js`, table `network_contacts`
  (created lazily; columns include `relationship` 'direct'|'firm' and `via`).
  Imports are staged and swapped atomically.
- **Auth.** NextAuth, Google only (`src/server/auth.js`). Do **not** set
  `NEXTAUTH_URL` on Vercel (both hosts must work). LinkedIn/X OAuth routes
  under `src/pages/api/auth/`; callback URLs derive from the request host
  (`src/utils/oauthUtils.js` ignores `*_REDIRECT_URI` overrides that are not
  real URLs or point at another host).

- **Tavus video guide.** `src/components/tavus/TavusGuide.js` renders the one
  `<tavus-widget>` (deployment id in `src/config/tavus.js`), loaded in
  `_app.js` with `next/dynamic` and `ssr: false`. Tool logic and page
  descriptions are in `guideTools.js` (unit-tested in
  `tests/unit/features/tavusGuide.test.js`); the PAL Maker tool specs are in
  `docs/tavus/03-pal-tools.md`. Keep `@tavus/widget` on the `latest` tag.
  Open Research keeps its current query in the URL (`?q=`) so the agent and
  links stay in sync; do not mount the widget per page (a remount ends calls).

## 6. Design rules (short; full version in DESIGN.md)

Quiet and modern: light canvas, white cards, near-black (`bg-ink`) primary
actions, one muted steel-blue accent (`brand-*`, #3D6A96) for links/focus/
citations, **no gradients or purple/pink**. Minimal top bar (wordmark left;
Workspaces, Watchlist, account menu as small text right); the three-flow
switch is the main navigation. Primary search inputs use `.input-hero`;
secondary controls under it use `.select-quiet`. Example questions live inside
search bars (rotating placeholder + focus dropdown), not as chip rows. No page
subtitles/taglines/footer sentences unless the owner asks.

## 7. Environment variables (names only — values live in Vercel)

Free LLMs: `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_AI_API_KEY`
(also present but paid/unused by default: `TOGETHER_API_KEY`, `PERPLEXITY_API_KEY`, `CEREBRAS_API_KEY`).
Search/data: `SERPER_API_KEY`, `TAVILY_API_KEY`, `FMP_API_KEY`, `FRED_API_KEY`.
DB: `DATABASE_URL` and the `DATABASE_*` family from the Neon integration.
Auth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `CRON_SECRET`.
Social: `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`, `TWITTER_API_KEY`,
`TWITTER_REDIRECT_URI`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
`LINKEDIN_REDIRECT_URI`, `NEXT_PUBLIC_LINKEDIN_*`, `REDDIT_*`.
Misc: `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_PRODUCTION_URL`, `FEATURE_*`,
`ADMIN_SECRET`, `CONNECTORS_ENABLED`. Optional, not set: `RESEND_API_KEY`
(email digests), `NEXT_PUBLIC_ATTIO_ENABLED` (turns on the Attio import),
`COURTLISTENER_API_TOKEN`.

`vercel env ls` shows names; use `vercel env add NAME preview <branch> --value '…' --yes`
for non-interactive adds (the owner normally pastes secret values himself).

## 8. Current state (2026-11-09, evening)

Production `openclaw-fixes` is at `f3b49a5`. The preview branch
`claude/research-hub-fix` is at `eb29785` and has the **same code**: its two
extra commits (`a4dde74` and its revert `eb29785`) cancel out. Nothing is
waiting to be deployed.

Done earlier: full audit and overhaul; free-first LLM chain incl. Gemini;
redesign (ink + steel blue, quiet top bar, hero search bars); Google sign-in
on both hosts; custom domain; privacy/terms; Network Map rebuild (roles and
lenses, role/company/industry/country grouping, three-layer drill-down,
breadcrumb, navigator, full screen, folded singletons, known-employer
industries, cross-tab "Your network" panels, Attio import built behind a
flag); Open Research source groups (Gov, Patents & IP, Institutions),
All/Custom chips.

Added since the first handoff (all live):
- **Tavus video guide** ("Diligence Doctor"), commit `f9d9655`: one
  `<tavus-widget>` on every page with page-aware context and three PAL tools
  (`go_to_section`, `run_research`, `run_founder_check`). See section 5 and
  `docs/tavus/03-pal-tools.md`. Open Research now writes the current query to
  the URL (`?q=`) and reruns on every new `?q=`.
- **Avatar knowledge docs**, commit `45eb8a5`:
  `docs/tavus/01-site-overview-and-navigation.txt` and
  `02-walkthroughs-faq-and-limits.txt`, written for the avatar (user-facing
  language). Keep them in sync with UI changes; the owner uploads them to the
  PAL's knowledge base.
- **X callbacks and diagnostics**, commit `e635c19`: OAuth callbacks return
  to the host the user started on; the X status endpoint reports X's own
  refusal reason (`xReason`, `xDetail`) and makes one API call, not two.
- A Tavus findings report and `?tavusDebug=1` timing marks were added and then
  reverted on purpose (`eb29785`). The owner keeps that report outside the
  repo. Do not re-add it.
- **Untracked, on purpose:** `docs/tavus/media/` holds banner and avatar
  background JPGs made for the owner's video. Leave them uncommitted unless he
  asks.

## 9. Open items — pick up here

1. **X (Twitter) connect — blocked on the owner's X plan.** Sign-in now
   completes and returns to diligence.bivek.ai, and the app "Diligence Hub" is
   inside a Project. X still answers `403 client-not-enrolled` because X
   deprecated its Free API plan (the Project shows a quota of 0). The owner
   said he will enable X's **Pay Per Use** plan. No code change is needed.
   After he does: if the OAuth 2.0 Client ID/Secret changed he updates
   `TWITTER_CLIENT_ID`/`TWITTER_CLIENT_SECRET` in Vercel and production needs a
   redeploy; then re-test Connect X and `GET /api/auth/twitter/token`
   (expect `authenticated: true`), then "Import follows".
2. **Tavus PAL tools — on the owner.** The three tools must be added to the
   PAL in the Tavus PAL Maker exactly as in `docs/tavus/03-pal-tools.md`
   (delivery app message, on-resolve `generate_response`). Until then the
   guide talks but cannot act. The owner reported a freeze in a test call;
   the page replies to tool calls in under 100 ms, so the likelier causes are
   the PAL's knowledge base size or the PAL runtime. Not a code task unless he
   asks.
3. **Stale env overrides in Vercel** (cleanup; code already ignores them):
   `TWITTER_REDIRECT_URI` (unexpanded template), `LINKEDIN_REDIRECT_URI` and
   `NEXT_PUBLIC_LINKEDIN_REDIRECT_URI` (old `airesearch.bivek.ai`), and
   `NEXT_PUBLIC_BASE_URL` / `NEXT_PUBLIC_PRODUCTION_URL` if they still point at
   the old domain. Removing env vars needs the owner's OK.
4. **Key rotation:** keys that were once in `env-config.txt` are in git
   history; the owner should rotate them, plus the Vercel variables marked
   "Needs Attention".
5. **Attio** stays a disabled placeholder until the owner has a workspace
   token; enable with `NEXT_PUBLIC_ATTIO_ENABLED=true`. Import logic and tests
   exist (`src/pages/api/network/attio.js`, `tests/unit/features/networkAttio.test.js`).
6. **Possible rename:** the owner now calls the product "DiligenceHub"
   (banner, PAL, X app). The site still says "Research Hub" in the logo,
   titles and sign-in page. Rename only if he asks.
7. **Ideas the owner liked but not started:** a firm-level LinkedIn import
   (colleagues' exports attributed to them → "via <colleague>" second-degree
   paths, reusing the direct/firm model); optional `RESEND_API_KEY` for
   watchlist email digests.

## 10. How the owner likes to work

- Wants the site "very clean": fewer words, no repeated navigation, subtle
  secondary controls, prominent primary search.
- Reviews on the preview, then says "push to production". Ask before
  production pushes, destructive actions, or anything that spends money.
- Wants docs (README / NETWORK-MAP.md) updated with every feature change.
- Prefers a short plain summary at the end: what changed, what is verified,
  what is left on his side.
