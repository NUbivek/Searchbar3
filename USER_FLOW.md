# User flow

What happens on each page, in the order a user meets it. Routes are the
Next.js pages under `src/pages/`; API routes are under `src/pages/api/`.

## Signed out vs signed in

Open Research, Founder Check, the Network Map and company profiles work
without an account. Signing in (`/signin`: Google; a "Local test user" appears only in
development) adds history, deal workspaces, notes, data-room documents, memo
export, watchlists and saved network contacts. The account menu (top right)
shows the unseen-alert count.

## Open Research (`/`)

1. Type a company or person, pick sources (curated registry is on by
   default), optionally add custom URLs, upload files (PDF, DOCX, CSV, TXT),
   choose a date range and, when signed in, the deal workspace to file the
   search under.
2. `POST /api/search/open` runs `src/server/search/`: understand the query
   (entity, intent, recency), retrieve from every selected source in
   parallel with timeouts, keep results that name the entity, rank by
   name position, intent, recency and source tier, collapse syndicated
   duplicates, then write the answer.
3. The results page shows: the answer in five sections with `[Source n]`
   citations, the claim-check panel (funding and valuation figures marked
   corroborated, single-source or conflicting), the ranked source list with
   tier badges and dates, per-source status (a banner lists sources that
   were unavailable, e.g. no web search key), and the model used or "quoted
   from sources" when no model answered.
4. Signed in: the search is saved to History; any source can be pinned to
   the selected workspace; `?q=` and `?workspace=` links from History,
   workspaces and company pages re-run a search.

## Founder Check (`/founder`)

1. Enter a full name and optionally the company.
2. `GET /api/founder` retrieves web, news and profile snippets, the curated
   index, Hacker News and (with a token) CourtListener; keeps only sources
   that name the person; ranks; extracts timeline, companies, education,
   litigation, press and mentions; then writes a brief with checked
   citations (or quotes one).
3. The page shows the brief, each section with its quoted sentence and
   source number, a disambiguation notice when several people share the
   name, the litigation disclaimer, and backchannel references: contacts
   from your imported network at the founder's companies.

## Company profile (`/company/<name>`)

`GET /api/company?name=` gathers funding rounds, investors, people,
competitors, headcount and public-company data from the curated registry,
Hacker News, web search and SEC EDGAR/FMP. Every line is a quoted sentence
with a numbered source. Buttons run an Open Research search for the company
or add it to the watchlist.

## Network Map (`/network`)

1. Import contacts: LinkedIn's `Connections.csv` export, any CSV/XLSX with
   name/company/title columns, or an X following export. Sign in with
   LinkedIn or X from the page to identify yourself (X also fetches your
   following list where the API tier allows it).
2. Contacts are parsed in the browser (`src/utils/network/parseContacts.js`)
   and, when signed in, saved with `POST /api/network/contacts`.
3. The graph shows you, companies and people, coloured by source.
4. Ask a question ("Who do I know at Stripe?", "Intro paths to OpenAI").
   `POST /api/network/query` parses the question into companies, roles,
   keywords and locations, scores your contacts and returns matches with
   reasons and intro paths (direct contacts, then contacts at the target's
   investors). Contact data never leaves the app.

## History (`/history`, `/history/<id>`)

Lists saved searches with their summary and top sources. A search can be
re-run, filed under a workspace, or deleted (`/api/history`).

## Workspaces (`/workspaces`, `/workspaces/<id>`)

1. Create a workspace for a deal (name and company).
2. The workspace page shows searches filed there, analyst notes, pinned
   sources, the data room and a watchlist toggle for the company.
3. Data room: upload documents (parsed by `/api/upload`, stored with
   `/api/workspaces/<id>/documents`) and ask questions
   (`/api/workspaces/<id>/ask`). Answers cite `[Dn]` passages the page
   also shows; unverifiable model sentences are dropped.
4. Memo (`/workspaces/<id>/memo`): preview the assembled memo and download
   it as Markdown or DOCX (`/api/workspaces/<id>/memo`).

## Watchlist (`/watchlist`)

1. Add a company (also from company pages and workspaces). The first check
   runs immediately and backfills at most 10 recent items.
2. `/api/cron/watchlists` runs daily (Vercel cron, `CRON_SECRET`) and checks
   watches older than 6 hours; "Check now" runs one on demand.
3. New items that name the company (funding, people, filing, portfolio,
   press; last 90 days) become alerts, each linked to its source. Alerts
   are listed on the page and counted in the account menu; `/api/alerts`
   marks them seen. With `RESEND_API_KEY`, scheduled runs also email a
   digest.

## When something is missing

- No web search key: only the curated registry, Hacker News and SEC are
  searched; the banner names the sources that were skipped.
- No AI key: answers, briefs and data-room replies are quoted from sources
  and labelled as such.
- No database in production: history and workspace routes return 503 with a
  message; local development falls back to the embedded database.
- Upload errors: a scanned PDF without a text layer, a damaged file, or a
  file whose extension does not match its declared type is reported per
  file; other files in the batch still succeed.
