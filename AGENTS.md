# AGENTS.md — handoff for coding agents (Codex, Claude Code, others)

This file gives a coding agent the context it needs to keep working on this
project. Read it before you change anything. Human-facing docs are
`README.md` (product, setup, env vars), `NETWORK-MAP.md` (the Network Map in
depth), `DESIGN.md` (visual rules) and `USER_FLOW.md`.

Last updated: 2026-11-10, by Claude Code (the session that did the audit and
overhaul, the redesign, the globe Network Map with its dashboard, the wider
contact classification and the site-wide night mode). Written as a full
handoff: the owner expects to continue with Codex alone.

---

## 1. What this is

**Research Hub** is a due-diligence tool for a venture investor (the owner,
Bivek Adhikari, managing partner). It has three flows, switched by a
segmented control at the top of every page:

| Flow | Route | What it does |
|---|---|---|
| Open Research | `/` | Searches curated VC/startup sources, Hacker News, the web, SEC and grouped official/institutional sites; writes a cited answer (free LLMs) or quotes sources; checks funding/valuation claims across sources. |
| Network Map | `/network` | The user's own contacts (LinkedIn export, CSV/XLSX, X, Attio placeholder) on a see-through 3D globe (you → group → sub-group → company → person), with a dashboard beside it, grouped by role / company / industry / country, plus "ask your network" (raise / source / diligence lenses, intro paths). |
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
npm test                                   # jest; currently 580 tests, all passing
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
- The suite is stable: an old random failure in `tests/unit/OpenSearch.test.js`
  was a teardown-order bug in the test and is fixed. A failing test now means
  a real problem.
- Node 22 locally; Next.js 14.1.0 (pages router), React 18, Tailwind 3.4.
- **Checking the UI.** There is no browser test suite. After any visual
  change, open the page on :3009 and look at it in day and night mode and at
  phone width. The Network Map needs a few seconds after load (it has an
  opening animation). Console errors shown by the dev overlay can be stale;
  reload before trusting them.

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
                           network/{parseContacts,atlas,roles,sectors,grouping}, oauthUtils,
                           theme (day / night)
src/components/            OpenSearch, SourceSelector, ModelSelector (no longer rendered),
                           layout/PageShell (TopBar, ThemeToggle, SectionSwitch),
                           network/{NetworkGraph,NetworkHelpers}, tavus/{TavusGuide,guideTools},
                           search/results/*, workspace/*, watchlist/*
src/styles/globals.css     colour tokens for day and night, component classes
docs/tavus/                text the owner uploads to the video guide's knowledge base
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
- **Day / night theme.** One attribute (`<html data-theme="dark">`), set by `src/utils/theme.js`; every colour is a CSS variable in `src/styles/globals.css` and Tailwind's colours point at them (`tailwind.config.js`). Use token classes, never hex for surfaces or text, never `dark:` variants. See DESIGN.md "Day and night".
- **Network Map.** Full description in `NETWORK-MAP.md`. The pieces:
  - `src/utils/network/roles.js`: `classifyContact` puts each contact in a
    role, one of five first-layer groups (`ROLE_GROUPS`: investors, founders
    = "Founders & executives", operators = "Operators & talent", experts,
    other) and the lenses raise / source / diligence. Rules are an ordered
    list (`ROLES`), first match wins; anyone with a title or employer who
    matches nothing becomes `professional` under operators, so "Everyone
    else" holds only contacts with neither.
  - `src/utils/network/grouping.js`: `industryOf` decides in five steps:
    known-employer table, decisive titles, sector words, sector words in the
    company's own name (`COMPANY_WORD_INDUSTRY`), then what the person does
    (`FUNCTION_GROUP`: Founders & CEOs, Engineering & data, ...). `countryOf`
    reads the location field. `bucketsFor` makes up to 16 groups per layer.
    Tests in `tests/unit/features/networkGrouping.test.js` hold both leftover
    buckets under 5% on a realistic mix; keep them passing.
  - `src/utils/network/atlas.js`: `buildAtlas(contacts, { groupBy })` returns
    a fixed tree (root → group → sub-group → company → person) with x/y/r for
    every node, packed with d3-hierarchy, no physics. `LAYERS` gives the
    layer order per grouping. People spiral out from their company ordered by
    `seniority` (0 leaders, 1 heads, 2 team). Sub-groups get a `shade` of
    their group's colour. Same contacts, same layout, always.
  - `src/components/network/NetworkGraph.js`: one canvas, no graph library.
    `wrapOntoGlobe` places each top-level cluster on its own patch of a unit
    sphere; depth is by level (`SHELL`: you at the core, people on the
    surface). Camera is yaw / pitch / radius; drag spins with momentum,
    scroll zooms towards the cursor, a click flies to the node. Deeper
    layers are ghosted until you zoom in (`reveal`); everything outside the
    cluster in view fades (`inFocus`). Labels differ per layer (banner, tag,
    plate). Colours come from `THEMES` (light and dark) via the `theme` prop.
  - `src/pages/network.js`: `focus` (where the camera was sent; bump `nonce`
    to fly again), `viewId` (the cluster in view, reported back by the map),
    the breadcrumb, the two bars under the globe ("Zoom to" and "Presets")
    and the dashboard on the right (layer stepper, seniority bar, raise /
    source / diligence gauges, next-layer bars, people list with filter and
    sort; details of a selection open in the same panel).
  - "By country" is disabled until some contact has a location: LinkedIn's
    export has none.
  - Gone: `graph.js`, force-graph, react-kapsule. Jest maps `d3-hierarchy`
    to its UMD build (`jest.config.js`).
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

Quiet and modern, in two themes (day is the default, night via the moon
button in the top bar): a quiet canvas, cards one step lighter, ink
(`bg-ink`) primary actions, one muted steel-blue accent (`brand-*`, #3D6A96) for links/focus/
citations, **no gradients or purple/pink**. Minimal top bar (wordmark left;
Workspaces, Watchlist, account menu as small text right); the three-flow
switch is the main navigation. Primary search inputs use `.input-hero`;
secondary controls under it use `.select-quiet`. Example questions live inside
search bars (rotating placeholder + focus dropdown), not as chip rows. No page
subtitles/taglines/footer sentences unless the owner asks.

Colour rule that keeps night mode working: use the token classes
(`text-ink`, `text-muted`, `bg-white`, `border-line`, `brand-*`, `slate-*`,
`rose-*`, `amber-*`, `emerald-*`). Never write a hex colour for a surface,
text or border, and never use Tailwind `dark:` variants. In inline styles
use `rgb(var(--c-ink))` and the like. `bg-white` means "surface": white by
day, a dark panel at night. `tests/unit/theme.test.js` fails if a token is
added for day without a night value.

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

## 8. Current state (2026-11-10)

Production `openclaw-fixes` is at `bcacb2b`. The preview branch
`claude/research-hub-fix` has the same application code, plus one newer
commit that only updates this file
(`git diff --stat origin/openclaw-fixes origin/claude/research-hub-fix`
should list `AGENTS.md` and nothing else). Nothing is waiting to be deployed. 580 tests pass; the production build
compiles.

Shipped on 2026-11-09 and 2026-11-10 (all live):

- **Network Map rebuilt as a globe** (`ef26cf0` … `9a37132`): fixed layout,
  layered see-through sphere, bursts per company ordered by seniority,
  spin / zoom / fly-to, one layer revealed at a time, a label style per
  layer, shades per sub-group, opening swing-in.
- **Readability** (`9d0a626`): focus fade, key, at most 14 company names.
- **Dashboard beside the globe** (`f3b03b7`).
- **"By country" disabled without locations** (`3dadff6`).
- **Wider classification** (`51930ed`) and **five first-layer groups**
  (`5b4c66f`): see section 5.
- **Night mode** (`cfb6861`): site-wide day / night theme, toggle in the top
  bar, remembered per browser, no flash on load, printing always in day.

Still true from before: full audit and overhaul; free-first LLM chain;
Google sign-in on both hosts; custom domain; privacy / terms; Open Research
source groups (Gov, Patents & IP, Institutions) with All / Custom chips;
Tavus video guide with three page tools; avatar knowledge docs in
`docs/tavus/` (keep them in step with UI changes; the owner uploads them to
the guide's knowledge base himself).

On purpose, do not undo:

- `docs/tavus/media/` is untracked (banner and background JPGs for the
  owner's video). Leave it uncommitted unless he asks.
- A Tavus findings report and `?tavusDebug=1` timing marks were added and
  reverted (`eb29785`). The owner keeps that report outside the repo.

### How production is released

Production is updated by a **merge commit** of the preview branch into
`openclaw-fixes` (it cannot fast-forward). Only after the owner says "push
to production":

```bash
npm test && NEXT_DIST_DIR=.next-build npm run build
git checkout openclaw-fixes && git merge --ff-only origin/openclaw-fixes
git merge --no-ff claude/research-hub-fix -m "Merge branch 'claude/research-hub-fix' into openclaw-fixes"
git diff --stat HEAD claude/research-hub-fix   # must print nothing
git push origin openclaw-fixes
git checkout claude/research-hub-fix
```

Vercel deploys in about a minute. Confirm with
`curl -s -o /dev/null -w '%{http_code}' https://diligence.bivek.ai/network`
and by loading the page. To roll back, revert the merge commit on
`openclaw-fixes` and push (the tag `v-before-audit-2026-11-08` is the state
before all of this work).

## 9. Open items — pick up here

Not yet verified (worth doing first):

1. **Night mode on pages nobody opened at night:** a live Open Research
   search and Founder Check run (only a saved result was viewed), workspace
   detail, memo and company profile pages. They use the same tokens; look
   for leftover light panels or unreadable text and fix with token classes.
2. **Classification on the owner's real contacts.** The under-5% result for
   "Everyone else" and industry "Other" was measured on synthetic test
   contacts. If the owner reports a large leftover bucket, extend `ROLES`,
   `COMPANY_WORD_INDUSTRY` or `FUNCTION_GROUP` and add the case to
   `tests/unit/features/networkGrouping.test.js`. Do not print his contacts.
3. **Network Map checks not done:** touch pinch on a phone, full-screen mode
   with the dashboard hidden, and "By company" / "By industry" after the
   last layout changes.

Waiting on the owner:

4. **X (Twitter) connect.** Sign-in completes, but X answers
   `403 client-not-enrolled` because X retired its free API plan. The owner
   said he will enable X's Pay Per Use plan. No code change needed. After
   he does: if the OAuth client id / secret changed he updates
   `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` in Vercel and production
   needs a redeploy; then test Connect X and `GET /api/auth/twitter/token`
   (expect `authenticated: true`), then "Import follows".
5. **Tavus page tools.** The three tools must be added to the guide in the
   Tavus PAL Maker exactly as in `docs/tavus/03-pal-tools.md`. Until then
   the guide talks but cannot navigate.
6. **Stale env overrides in Vercel** (the code already ignores them):
   `TWITTER_REDIRECT_URI`, `LINKEDIN_REDIRECT_URI`,
   `NEXT_PUBLIC_LINKEDIN_REDIRECT_URI`, and `NEXT_PUBLIC_BASE_URL` /
   `NEXT_PUBLIC_PRODUCTION_URL` if they point at the old domain. Removing
   env vars needs his OK.
7. **Key rotation.** Keys once in `env-config.txt` are in git history; he
   should rotate them, plus the Vercel variables marked "Needs Attention".
8. **Attio** stays a disabled placeholder until he has a workspace token;
   enable with `NEXT_PUBLIC_ATTIO_ENABLED=true`. Import logic and tests
   exist (`src/pages/api/network/attio.js`,
   `tests/unit/features/networkAttio.test.js`).

Ideas discussed, not started (build only if he asks):

9. **A geographic globe:** continents drawn on the sphere and people placed
   on their countries. Blocked on data: LinkedIn's export has no location.
   He chose to wait. It becomes possible when contacts carry a location (a
   CSV with a Location column, or Attio). Guessing from the employer's
   headquarters was offered and not chosen.
10. **Colour the people by an attribute** (seniority, lens, how recently
    connected) with a switch on the map.
11. **Rename to "DiligenceHub".** He uses that name on the banner, the
    guide and the X app; the site still says "Research Hub". Rename only if
    he asks.
12. A firm-level LinkedIn import (colleagues' exports → "via <colleague>"
    paths, reusing the direct / firm model); optional `RESEND_API_KEY` for
    watchlist email digests.

## 10. How the owner likes to work

- Reviews on the preview or the local server, then says "push to
  production". Ask before production pushes, destructive actions, or
  anything that spends money.
- Wants the site "very clean": fewer words, no repeated navigation, subtle
  secondary controls, prominent primary search.
- Gives feedback fast and in fragments while watching the page, and changes
  direction when he sees the result. Build the smallest version that shows
  the idea, show it, then refine. Keep what already worked.
- Wants docs (README, NETWORK-MAP.md, DESIGN.md, `docs/tavus/*.txt`) updated
  with every feature change.
- Prefers a short plain summary at the end: what changed, what is verified,
  what is not, what is left on his side.

What he decided about the Network Map (do not reopen without him):

- Rejected: a flat packed-bubble map ("too simple"), and a force-directed
  layout that scatters. Wanted: the "neurons" look (bursts and branches) on
  a wireframe, see-through globe with layers at different depths, "hyper
  interactive, modern, sophisticated".
- The globe must be used all the way round; the far side must not look
  empty.
- One layer first, deeper layers on zoom; each layer's labels must differ by
  more than font and colour; labels need solid backgrounds to be readable.
- The bars under the globe stay: quick zoom and presets. Choosing a preset
  must bring that group to the front. Chip dots use a shade per sub-group.
- He first refused a table beside the globe, then asked for it back as a
  visual, filterable, layer-focused dashboard. Keep both the globe and the
  dashboard.
- Leftover buckets ("Other", "Everyone else") must stay under 5%.
- Day is the default theme; night mode must look as considered as day.
