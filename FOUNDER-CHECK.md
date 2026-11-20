# Founder Check

A background check on one named person, for an investor deciding whether to
back them. The page (`/founder`) gives two things:

- a **quick brief** in under a minute (career, companies, education,
  litigation mentions, press), and
- a **deep background check** that takes a few minutes: it asks every free
  public source it knows about the person, reads each record for new threads
  (an earlier company, a school, a co-founder, a relative in a public role,
  a handle, a domain, an old profile page), pulls those threads, and repeats
  until a round finds nothing new.

Everything shown is a record with a link, a quote taken from the source, and
a grade for whether it is really about this person. Nothing is invented: the
written summary may only cite records the check found, and citations are
checked in code.

## What the deep check looks at

| Area | Sources | What they add |
|---|---|---|
| The open web and news | Open-web search (several search engines, tried in turn; the two metered search services only as a capped last resort), news archives by era | Profiles, press, interviews, disputes, and the pages other sources then dig into. About fifteen query patterns per person (lawsuit, fraud, employment disputes, insolvency, prior ventures, education, family and related parties, forums), each scored separately |
| Pages about the person | Page reader (`sources/pages.js`) | Opens up to ten pages the check already tied to the person (team and bio pages, personal sites, profiles and interviews whose headline names them) and keeps the sentences about their career and education. One request per page, identified as an automated reader, only where the site's robots.txt allows. LinkedIn, X, Facebook and Instagram are never opened: their public profile lines come from search results |
| Earlier versions of pages | Web archive (Internet Archive) | Older captures of LinkedIn, Indeed resume, AngelList, Crunchbase, about.me, GitHub, X and company team pages; what a profile said in each year; **claims that changed** between versions (a degree, an employer, a title that was altered or removed) |
| Identity and public roles | Wikidata, Wikipedia, LittleSis, GitHub, Hacker News, linked accounts (Keybase), academic record (ORCID, Crossref, theses.fr), scholarly publications (OpenAlex), US nonprofit filings (Form 990) | Education and career as the public record has them, public office, board seats and foundations, a claimed doctorate checked against thesis registries, handles and sites the person has linked |
| Family and related parties | Wikidata and LittleSis relatives and their roles, related-party passages in SEC filings, family wording in press, the second reader | Relatives who hold a business, political or philanthropic role, organisations they share with the founder; each is screened against watchlists and searched together with the founder |
| Courts and enforcement | US Department of Justice press releases, federal court case titles (Internet Archive copy of dockets), federal dockets and opinions (CourtListener, when `COURTLISTENER_API_TOKEN` is set), SEC enforcement releases, CFTC and CFPB enforcement actions, FINRA BrokerCheck and SEC adviser records, The Gazette (UK insolvency and disqualification notices), UK court judgments, the French official commercial bulletin (BODACC) | Charges, pleas, convictions, sentences, civil suits, bars, insolvency |
| Sanctions and watchlists | Sanctions lists (US Consolidated Screening List, UN, EU, UK, Canada), US federal exclusion lists (SAM.gov, HHS OIG), wanted lists (FBI, EU Most Wanted), ICIJ Offshore Leaks (the founder and their companies only) | Name screens for the founder, their companies, associates and relatives; a clean screen is reported as such, and the report marks any related person who was not screened in that run |
| Filings and company records | SEC filings (full-text search, Form D fundraises, insider filings), UK Companies House (officers, disqualified directors), French company register, US state business registers, Legal Entity Identifier register, Y Combinator directory, patents, US trademarks, domain history | Roles and dates independent of what the founder says, earlier companies, dissolutions, co-directors and co-founders, inventorship |
| Breach and leak-site exposure (company level) | Ransomware leak-site listings (RansomLook), known data breaches (Have I Been Pwned catalogue), regulators' breach registers | Whether the founder's companies appear as victims or in breach notices. Organisation, date and counts only |

The exact list is `CONNECTORS` in `src/server/founder/sources/index.js`;
`tests/unit/features/founderSources.registry.test.js` holds every source to
the contract.

Sources that need something this deployment does not have are listed in the
report under "Did not answer", with the reason. What no free source covers
(state and county courts, commercial credit and criminal-record files,
private financials) is listed in every report.

## What the report shows

- **The brief**: a written summary by the strongest available AI model, every
  sentence cited to a numbered record, or a summary assembled from the
  records themselves when no model is available.
- **Profile**: current role, education, earlier roles, a few sentences of
  background and public profile links, read from pages tied to the person
  (search results, the company's own pages, bio and interview pages the page
  reader opened, archived copies). Every line links to its record.
- **Public-record screens**: every sanctions, court, regulator, breach and
  register source that was asked, each with its result: no match, records,
  name matches to rule out, answered in part, did not answer, or not enabled.
  A clean screen is shown as having run; a silent one is never shown as clean.
- **Red flags**: serious matters tied to the person. Twenty reports of one
  sentencing are one matter, led by the most official record, with the rest
  listed under it.
- **About their companies**: serious records about a company the person
  founded or runs that do not name them. Context, not a finding about them.
- **Possible namesakes to rule out**: serious records that match the name only.
- **Name matches only**: every other record that shares the name (or, for a
  company name several registered companies share, the company's name) and
  nothing else. Kept apart from the sections about the person, collapsed.
- **Claims that changed over time**: differences between archived versions
  of the same profile or bio.
- **Related parties**, a **timeline** from dated records, every record by
  kind, and **what was searched**, what did not answer, and what no free
  source covers.

## How it works

```
start  ->  step  ->  step  -> ... ->  report
           |  every source that can handle a thread is asked (in parallel,
           |  politely: spaced per site, with timeouts)
           |  each record is graded for identity and cleaned by the privacy rules
           |  each record is read for new threads; trusted threads are queued
           |  when a round finds nothing new, a second reader (an AI model)
           |  goes over the records for threads the rules missed
```

A check runs longer than one serverless request, so the browser asks for it
one step at a time (`POST /api/founder/deep`), and the state is saved between
steps (`founder_jobs` table; kept 72 hours). A reload picks a running check
up again. Sign-in is required (a check uses shared allowances and gathers a
lot about one person); at most 12 checks an hour per account.

| File | What it does |
|---|---|
| `src/server/founder/deepCheck.js` | the loop: plans lookups per thread, runs them best-first within a time budget, notes and pulls threads, re-grades earlier records as more becomes known, stops when dry or at the limits |
| `src/server/founder/identity.js` | who a record is about: `confirmed` (names the person with a company known to be theirs), `likely` (with a known school, associate, handle or domain), `possible` (the name only: may be a namesake) |
| `src/server/founder/guardrails.js` | the privacy rules, applied to every record |
| `src/server/founder/finding.js` | the one shape every source returns (`makeFinding`, `makeThread`) |
| `src/server/founder/extract.js` | reads text for companies, schools, associates, relatives in public roles, handles and profile pages |
| `src/server/founder/profile.js` | reads role, education and earlier employers out of sentences that name the person in tied records |
| `src/server/founder/gaps.js` | the second reader: a model proposes missed threads and searches; code keeps only what the cited record states |
| `src/server/founder/report.js` | ranks and numbers the records, builds red flags, possible namesakes, claims that changed, related parties, timeline, coverage; writes the brief |
| `src/server/founder/sources/` | one file per family of sources; `index.js` lists them all |
| `src/server/founder/http.js`, `cache.js` | polite HTTP (per-site spacing, timeouts, loud failure on oversized downloads) and a cache for whole-list downloads such as sanctions lists |
| `src/server/founder/jobStore.js` | saves a check between requests |
| `src/server/learning.js` | what has worked before (see below) |
| `src/pages/api/founder/deep.js`, `src/components/founder/DeepCheck.js` | the API and the page |

## Rules the check never breaks

1. **Never pin a namesake's record on the founder.** A record that matches
   by name alone is graded `possible`, shown under "Possible namesakes to
   rule out", never under red flags, and never followed for more threads. A
   company named with an ordinary word (Stripe, Flow) only confirms identity
   when it is written as a name.
2. **Privacy.** No home addresses, phone numbers, personal email addresses,
   dates of birth or ID numbers. Nothing about children, health, religion,
   sexuality or immigration status. No people-search or data-broker sites,
   ever (they are neither queried nor cited).
3. **Family only where it matters to an investor.** A relative appears only
   when the source itself states the kinship and gives that relative a
   business, political or philanthropic role, right beside their name.
   Relatives and associates are never checked in their own right: they are
   screened against watchlists and searched together with the founder, for
   related-party and conflict-of-interest diligence.
4. **No stolen data.** "Dark web" coverage means published, company-level
   exposure: ransomware leak-site listings from a public index, the public
   catalogue of known breaches, regulators' breach registers. Stolen
   personal records are never retrieved, stored or shown, and onion search
   engines that forbid automated use are not used.
5. **Free and polite.** Only free public sources, reached the way they
   permit, spaced per site, never disguised as a browser. Only AI models
   that cost nothing (see README, "AI models").
6. **Honest coverage.** A source that failed is reported as failed, a limit
   that was reached is stated, and "no record found" is never presented as
   proof of a clean record.

Political donation records are left out on purpose. This is not a consumer
report and must not be used for employment, credit, housing or insurance
decisions; the report says so.

## How it gets better with use

- **Within a check.** A company confirmed in one round upgrades records
  that mention it in the next; each new thread opens new lookups; the second
  reader restarts a loop that ran dry (at most twice).
- **Across checks** (`learning_stats` table). Every query pattern and every
  source is scored by whether it produced evidence tied to the person, and
  the next check runs the best-scoring lookups first. AI models are scored
  the same way (did they answer, did the answer pass its checks), which
  moves the order of the model chain. Under-tried options get a small bonus
  so new ones still get a turn.

## Adding a source

1. Write a connector in `src/server/founder/sources/` (contract at the top
   of `sources/index.js`): `id`, `label`, `kinds`, `prior`, optional
   `enabled` / `unavailableReason` / `plan`, and `run(task, ctx)` returning
   `{ findings, threads, notes }` built with `makeFinding` and `makeThread`.
2. HTTP only through `../http` with `deadline: ctx.deadline`; whole-list
   downloads through `cached()` in `../cache` as a compact index.
3. Put the text of the record (never the query) in `title`, `quote` or
   `matchText`, and let `makeFinding` grade identity. Mark a thread
   `trusted` only when it comes from a record graded `confirmed` or `likely`.
4. Add it to `CONNECTORS` in `sources/index.js`, with a Jest file
   (`tests/unit/features/founderSource.<file>.test.js`) that fakes the
   network with `setTransport` and covers mapping, identity grading (a
   namesake case), privacy and the failure path.

## How deeply a company is checked

The company the user gave, and any company the records say the person
founded, owns or runs, is checked in full: its lawsuits, insolvency,
breaches and registry entries reflect on them. A company the person only
sits on the board of, invested in, advised or once worked at is not: only
what ties the two together is looked up (filings naming both, registry
roles, and searches for the person and the company together). A board seat
at a large company must not fill the report with that company's litigation.
If a later record shows the person founded such a company, it is then
checked in full.

## Switches

| Variable | Effect |
|---|---|
| `COURTLISTENER_API_TOKEN` | turns on US federal dockets and opinions (a free CourtListener account) |
| `FOUNDER_DEEP_PUBLIC=true` | lets a check run without sign-in (local testing only) |
| `FOUNDER_SOURCES_OFF` | comma-separated source ids to switch off |
| `SEC_USER_AGENT` | a declared contact for SEC requests, if the default is ever refused |
| `FOUNDER_HTTP_CONTACT` | a URL or address the owner chooses to declare to the sites it asks (nothing is declared by default) |
| `FOUNDER_SEARCH_GOOGLE_NEWS=0` | turns off the Google News feed (see "Choices the owner should know about") |
| `FOUNDER_SEARCH_METERED=0` | stops the deep check from ever using the site's backup search service |
| `FOUNDER_SEARCH_BRAVE_HTML=1` | turns on Brave Search (off by default) |
| `LLM_SKIP_GEMINI_FOR_PEOPLE=true` | keeps text about the person away from Gemini (see README, "AI models") |

## Choices the owner should know about

- **Google News feed.** Most open-web lookups are answered by Google's news
  search feed. The feed is published for programs to read, but the site's
  crawler rules do not list that path among the allowed ones. It is used
  because each request is a lookup a person started, at a modest pace (at
  most 60 in ten minutes). `FOUNDER_SEARCH_GOOGLE_NEWS=0` turns it off; the
  check then leans on DuckDuckGo (a handful of lookups per ten minutes),
  Bing News and Wikipedia, and finds much less press.
- **The backup search service.** The site's ordinary search already uses a
  metered search service (Serper, then Tavily). The deep check uses it only
  as a last resort for its most valuable lookups, at most 20 times an hour.
  `FOUNDER_SEARCH_METERED=0` keeps the deep check off it entirely.
- **Gemini and personal information.** The strongest model that costs
  nothing is Google's, and its terms for unpaid use ask not to submit
  personal information. The summary sends it only text already published
  about the person. `LLM_SKIP_GEMINI_FOR_PEOPLE=true` uses the next-best
  models for people checks instead.
- **Sources left out on purpose.** Certificate-transparency lookups, a
  people search on a nonprofit database, a patent office's web-app search,
  onion search engines and a ransomware-victim feed were removed or never
  used because their terms do not allow automated or business use.
  Political donation records are excluded by design.
- **Pace.** Sources are asked no faster than they allow (the web archive
  about 15 times a minute; two sites ask for ten seconds between requests),
  so a full check takes three to five minutes, and several checks run back
  to back will find less news until the search allowances refill (about ten
  minutes).

## Limits per check

`LIMITS` in `deepCheck.js`: lookups, depth (the person is 0, what is found
about them 1, what those lead to 2), records kept, records per source,
rounds, and how many threads of each kind are pulled. When a limit is
reached the report says how much was not run or not kept.
