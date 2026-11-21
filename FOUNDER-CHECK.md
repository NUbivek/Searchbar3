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
a grade for whether it is really about this person. The written summary may
only cite records the check found and showed the model; the code checks what
each line cites and removes what it cannot back (see "The brief" below), but
it does not check that a sentence reads its record rightly, so the page marks
an AI brief "AI-written; check it against the cited records".

## What the deep check looks at

| Area | Sources | What they add |
|---|---|---|
| The open web and news | Open-web search (several search engines, tried in turn; the two metered search services only as a capped last resort), news archives by era | Profiles, press, interviews, disputes, and the pages other sources then dig into. About fifteen query patterns per person (lawsuit, fraud, employment disputes, insolvency, prior ventures, education, family and related parties, forums), each scored separately |
| Pages about the person | Page reader (`sources/pages.js`) | Opens up to ten pages the check already tied to the person (team and bio pages, personal sites, profiles and interviews whose headline names them) and keeps the sentences about their career and education. One request per page, identified as an automated reader, only where the site's robots.txt allows. LinkedIn, X, Facebook and Instagram are never opened: their public profile lines come from search results |
| More courts and agency orders | Delaware courts (Chancery, Superior, Supreme: opinions and orders; the last 12 years always, and back to 2000 when dated records show activity then), EU courts and competition decisions, Canadian federal courts, US agency orders in the Federal Register (`sources/courtsMore.js`); US FTC cases (needs a declared contact) and the EU register of national regulators' sanctions (`sources/regulatorsMore.js`) | Company and shareholder disputes, competition and consumer-protection cases, agency orders naming the person or company |
| Bank regulators and FinCEN | Federal Reserve, OCC and NCUA enforcement actions and prohibition orders, FinCEN enforcement actions (`sources/debarment.js`) | Orders against a named person or firm; also screens associates and relatives |
| Development banks | The EBRD list of barred firms and people, which also carries World Bank, ADB, IDB and AfDB debarments (`sources/debarment.js`) | Whether the person, a company, an associate or a relative is barred from development-bank contracts, by which bank, on what grounds and until when |
| FDA debarment | The FDA debarment list for drug product applications, current and ended (`sources/fdaDebarment.js`) | Whether the person or a company is barred from drug applications, since when and for how long. The list gives names only, so a hit on a person is a name match to verify |
| Foreign-agent registrations | The Justice Department's FARA files: short forms, registrants and foreign principals (`sources/fara.js`) | Whether the person registered as a foreign agent, or their company is a registrant or a foreign principal, and for whom. Registration is lawful and is never worded as a red flag |
| Recalls and data-protection fines (company level) | US vehicle safety recalls (NHTSA) and consumer product recalls (CPSC) (`sources/recalls.js`); EU data-protection fines from the CMS Enforcement Tracker (`sources/gdprFines.js`) | Recalls filed by or naming the company; fines EU and EEA authorities published against it. Never a private individual |
| Retracted papers | Crossref's record of retraction notices and expressions of concern, which carries the Retraction Watch database (`sources/retractions.js`) | Papers the person wrote that were retracted or questioned; tied to them only with an ORCID iD, a matching affiliation or a paper already theirs |
| US federal records | Federal contracts, grants and loans (USAspending), lobbying registrations and activity (never contribution reports), CFPB consumer complaints, Federal Register documents, FDA recalls, NIH grants (`sources/government.js`) | What the company sells to or receives from government, who lobbies for it, complaints and recalls |
| Professional footprint | Semantic Scholar, Stack Overflow, npm packages, Bluesky, Mastodon, the person's own writing feeds (`sources/presence.js`); Hugging Face accounts, books on Open Library, Rust packages when a contact is declared (`sources/presenceMore.js`) | Research output, technical work, books and their own words; an account found by name alone stays a name match |
| Degrees and grants | DataCite dissertation records and US National Science Foundation awards (`sources/academicMore.js`) | Independent proof of a degree (school, year), and grants on which the person is principal investigator or that went to their company |
| Earlier versions of pages | Web archive (Internet Archive) | Older captures of LinkedIn, Indeed resume, AngelList, Crunchbase, about.me, GitHub, X and company team pages; what a profile said in each year; **claims that changed** between versions (a degree, an employer, a title that was altered or removed) |
| Identity and public roles | Wikidata, Wikipedia, LittleSis, GitHub, Hacker News, linked accounts (Keybase), academic record (ORCID, Crossref, theses.fr), scholarly publications (OpenAlex), US nonprofit filings (Form 990) | Education and career as the public record has them, public office, board seats and foundations, a claimed doctorate checked against thesis registries, handles and sites the person has linked |
| Family and related parties | Wikidata and LittleSis relatives and their roles, related-party passages in SEC filings, family wording in press, the second reader | Relatives who hold a business, political or philanthropic role, organisations they share with the founder; each is screened against watchlists and searched together with the founder |
| Courts and enforcement | US Department of Justice press releases, federal court case titles (Internet Archive copy of dockets), federal dockets and opinions (CourtListener, when `COURTLISTENER_API_TOKEN` is set), SEC enforcement releases, CFTC and CFPB enforcement actions, FINRA BrokerCheck and SEC adviser records, The Gazette (UK insolvency and disqualification notices), UK court judgments, the French official commercial bulletin (BODACC) | Charges, pleas, convictions, sentences, civil suits, bars, insolvency |
| Sanctions and watchlists | Sanctions lists (US Consolidated Screening List, UN, EU, UK, Canada), US federal exclusion lists (SAM.gov, for exclusions currently in force only: its public search does not show exclusions that have ended, so a past SAM debarment is not covered; and HHS OIG read from its official monthly file), wanted lists (FBI, EU Most Wanted; the founder only), ICIJ Offshore Leaks (the founder and their companies only) | Name screens for the founder, their companies, associates and relatives, under every way the name is written (middle names, suffixes, reordered names) and under any other name given. A clean screen is reported as such with the date of the list copy; a list or register copy older than a day, read because its refresh failed, is named with its date ("list as of ...") and the screen counts as answered in part; a list that failed, a name that could not be screened or a result that was cut is "answered in part", never clean; the report marks any related person who was not fully screened |
| Filings and company records | SEC filings (full-text search, Form D fundraises, insider filings, proxy disclosures of legal proceedings, 8-K events such as bankruptcy, auditor changes and restatements), UK Companies House (officers, disqualified directors, owners with control, charges, insolvency, overdue filings), French company register, US state business registers (the report names the states searched), the registers of Norway, the Czech Republic and Finland for companies placed there (`sources/registriesIntl.js`), Legal Entity Identifier register, Y Combinator directory, domain history. Patents and US trademarks are off (see "Choices the owner should know about") | Roles and dates independent of what the founder says, earlier companies, dissolutions, co-directors and co-founders. Everything is searched under every known name of the company: the name typed, and the legal name and domain learned from a record tied to the person |
| Breach and leak-site exposure (company level) | Ransomware leak-site listings from two live indexes (RansomLook, RansomFeed) and a historical archive (ransomwatch, 2020 to mid-2025) (`sources/exposure.js`, `leakSitesMore.js`); known data breaches (Have I Been Pwned catalogue); breach notices filed with regulators (California, Washington, Oregon, Delaware, Vermont, Maryland, Indiana, the UK ICO) (`breachRegistersMore.js`) | Whether the founder's companies appear as victims or in breach notices. Organisation, date and counts only; a criminal's claim is always "claimed, unverified". A listing that matches only an ordinary word is never the company's, and when the company's own domain was looked up and nothing names it the record says so |

The exact list is `CONNECTORS` in `src/server/founder/sources/index.js`;
`tests/unit/features/founderSources.registry.test.js` holds every source to
the contract.

Six sources are built and switched off until the owner agrees to their
terms (see "Choices the owner should know about"): the OpenSanctions bundle,
Australia's banned and disqualified register, Hong Kong's securities
enforcement news, the US Tax Court search, podcast episodes, and the
estimated infostealer exposure of a company's domain. Each is named in
`FOUNDER_SOURCES_ON` to turn it on.

Sources that need something this deployment does not have are listed in the
report under "Did not answer", with the reason. What the sources this check uses cannot reach
(state and county courts, commercial credit and criminal-record files,
private financials) is listed in every report.

## What the report shows

- **Summary**: the person in one line and honest counts: red flags, matters
  about their companies, records tied to them, screens answered out of
  screens asked. "0 red flags" is shown as reassuring only when every court,
  regulator and watchlist screen answered in full. When a company was typed
  and no record ties the person to it, the report says so first.
- **The brief**: a written summary by the strongest available AI model, or a
  brief assembled from the report's own fields when no model answers. Either
  way it has the same ten sections: bottom line; red flags; career and
  education; company; what checks out; claims that changed over time; related
  parties; public-record screens; gaps and unverified claims; and questions
  for the founder that are specific to this person. What `writeDeepBrief`
  checks in an AI answer:
  - a citation counts only if the model was shown that record (or a summary
    line citing it); others are removed;
  - a factual line with no citation left is removed;
  - in the bottom line, red flags, career, company and what checks out, a
    line citing only name-only records (or records tied only through a
    company the check assumed) is removed;
  - a red flag must share a distinctive word with a record it cites, and may
    not rest only on the person's own posts; what checks out may not rest
    only on a domain an earlier holder registered;
  - links and images are removed, and the privacy rules apply to every line;
  - when more than a fifth of the lines are removed the answer goes to the
    next model, and failing that the assembled brief is used; a section left
    empty is filled from the assembled brief, and the page says which.
  The code does not check that a sentence reads its record rightly: the page
  marks an AI brief "AI-written; check it against the cited records".
  Name-only records are never stated as facts.
- **Profile**: a résumé: current role, every earlier role with years,
  education with degree, field and year, companies founded and what became of
  them, boards, investments, recognition, where they are based (city only)
  and public profile links. It is built without a model from structured
  fields (Wikidata, ORCID, filings and registers naming the person as an
  officer, thesis and grant records), from the person's own profile text
  (search-result lines of their profile, archived bios) and from sentences
  about them; a model, when one answers, adds lines that code keeps only if
  the cited record states them word for word about the person. A colleague's
  or interviewer's job is never credited to the person. A role is "current"
  only when the newest record says so. **To confirm with the person** lists
  leads (for example a name-only broker registration whose dates fit their
  bio) apart from facts. Every line links to its record.
- **Company**: legal names and domains, founding year, funding rounds with
  date, lead and investors, and standing, each cited.
- **Public-record screens**: every sanctions, court, regulator, breach and
  register source that was asked, each with its result: no match, records,
  name matches to rule out, answered in part, did not answer, not run, or not
  enabled. These screens always run, early, and are never dropped when the
  check stops; one that could not run is shown as such, never as clean.
- **Your network** (signed in, with contacts imported in the Network Map tab):
  whether the person is already a contact, people you know who overlapped
  with them at a company in the same years, sat on the same boards or work at
  their investors, and a shortlist of who to call for a reference, best
  placed first, with what to ask. Relatives are never suggested. When no
  company is typed and exactly one contact has that name, the contact's
  company is used only as an assumption: records tied through it are "likely"
  at most and marked, and the report says which company was assumed. Contacts
  never leave the account: only a company name is ever used as a search term.
  A failed lookup is shown as failed, never as "nobody".
- **Red flags**: serious matters tied to the person, sanctions, debarments,
  wanted notices, criminal and regulator actions first. Twenty reports of one
  sentencing are one matter, led by the most official record, with its latest
  outcome (dismissed, acquitted, settled, pardoned) beside it. An acquittal,
  a dismissed suit or a suit the person brought is not a high red flag.
- **About their companies**: serious records about a company the person
  founded or runs that do not name them. Context, not a finding about them.
- **Possible namesakes to rule out**: serious records that match the name only.
- **Name matches only**: every other record that shares the name and nothing
  else, collapsed. For a company named with an ordinary word, records that
  match only the word ("boat ramp", Ethereum's "The Merge") leave the
  numbered report: they are counted and listed here with a one-line reason.
- **Claims that changed over time**: only changes to a claim (title,
  employer, school, degree, dates) in text about the person, between archived
  versions of the same profile or bio. Wording edits and other people's bios
  are not claims that changed.
- **Related parties** with their roles, a **timeline** of career, company and
  legal events with their real dates, every record by kind with filters, and
  **what was searched**, what did not answer, and what the sources this check
  uses cannot reach.
  One page is one record: an archived copy, the page reader's text and a
  search result for the same address are grouped.
- **On the page**: a check survives a reload, a closed tab and a sign-in;
  "Recent checks" reopens a finished check without running it again; the
  report can be printed or copied as text.

## The quick brief

The quick brief reads the pages a search finds about the person (name and
company beside each other; other people's profiles and name-only pages are
left out or marked) and asks a model for a short brief, several model
services side by side so one slow service does not cost the answer. Before
it is shown, every line is checked against the sources it cites
(`src/server/search/answer.js`, `checkClaims`):

- a sentence rests on the citation of its own line (models cite once per
  paragraph); a year, a number or a name that no source tied to the person
  gives is removed; a fact another such source gives is a loose citation
  and stays;
- a sentence that states a legal or regulatory matter (charged, convicted,
  sued, fined, investigated and the like) stays only when its cited source,
  or two other sources tied to the person, state that matter; an invented
  one is removed, and an answer with two of them is refused;
- "no litigation was found", the caveat that absence is not proof, and
  reference questions are not claims;
- an answer is refused, and the next model asked, only when more than half
  of it is unsupported. If no model's answer passes, the brief is assembled
  from the sources and says so.

With no company typed and several people of that name found, the page asks
which person is meant instead of writing one merged brief. Signed-out
visitors get 15 quick briefs per ten minutes and 40 per hour.

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
| `src/server/founder/identity.js`, `names.js` | who a record is about: `confirmed` (names the person beside a company known to be theirs), `likely` (with a known school, associate, handle or domain, or through a weaker anchor), `possible` (the name only: may be a namesake). `names.js` is the one matcher for names and companies that the quick brief and the deep check share |
| `src/server/founder/guardrails.js` | the privacy rules, applied to every record |
| `src/server/founder/finding.js` | the one shape every source returns (`makeFinding`, `makeThread`) |
| `src/server/founder/extract.js` | reads text for companies, schools, associates, relatives in public roles, handles and profile pages |
| `src/server/founder/profileModel.js` | the model-read profile and its word-for-word check against the cited record |
| `src/server/founder/networkLink.js`, `src/components/founder/NetworkLinks.js`, `src/pages/api/founder/history.js` | the pairing with the Network Map: the person as a contact, people around them, reference shortlist, checks already run |
| `src/server/founder/profile.js`, `companyFacts.js` | the résumé (roles, education, founded, boards, investments, recognition, leads to confirm) and the company's facts (legal names, funding, investors), read from tied records with no model |
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
   rule out", never under red flags, and never followed for more threads.
   - The name must be the full name: middle names, initials, suffixes,
     accents, "Surname, Given" and register capitals are the same person;
     initials alone, a nickname, another given name or a longer hyphenated
     surname are not.
   - The company must sit beside the name (same sentence or the next) and
     must not be given to someone else in between.
   - A company named with an ordinary word (Ramp, Merge, Stripe, Flow) counts
     only when the text uses it as a company (a business word, a legal form,
     its domain or a learned legal name beside it), never on a capital letter
     or a headline alone.
   - A very common name (John Smith, Wei Zhang) needs the company or another
     fact in the same record; a very large employer with a common name gives
     `likely` at most.
   - A record graded `likely` never becomes the evidence that confirms other
     records or itself, and nothing an AI model proposes confirms anything.
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
| `FOUNDER_SOURCES_ON` | comma-separated ids of sources that are off until the owner agrees to their terms: `opensanctions-lists`, `asic-banned`, `sfc-hk-enforcement`, `us-tax-court`, `podcast-episodes`, `infostealer-exposure` |
| `SEC_USER_AGENT` | **needed for SEC filing texts, enforcement releases and SEC press releases**: a name and contact email, for example "Example Research ops@example.com". The SEC's website refuses automated readers that declare no contact. An email in `FOUNDER_HTTP_CONTACT` also works. Without either, those lookups are reported as not answered |
| `FOUNDER_HTTP_CONTACT` | a URL or address the owner chooses to declare to the sites it asks (nothing is declared by default). The FTC case search and crates.io are asked only when it is set |
| `FOUNDER_ALLOWED_EMAILS` | comma-separated addresses or `@domains` allowed to sign in; empty means any Google account, as before. Quotes and `mailto:` around an entry are tolerated. A value that is set but holds no valid address or domain refuses every account (it fails closed, and the server log says why) |
| `FOUNDER_GOOGLE_PATENTS=on` | turns the patent search back on (see "Choices the owner should know about") |
| `GITHUB_TOKEN` | optional, a token with no scopes: a larger hourly allowance for GitHub lookups |
| `FOUNDER_SEARCH_GOOGLE_NEWS=0` | turns off the Google News feed (see "Choices the owner should know about") |
| `FOUNDER_SEARCH_METERED=0` | stops the deep check from ever using the site's backup search service |
| `FOUNDER_SEARCH_BRAVE_HTML=1` | turns on Brave Search (off by default) |
| `LLM_SKIP_GEMINI_FOR_PEOPLE=true` | keeps text about the person away from Gemini (see README, "AI models") |

## Choices the owner should know about

- **Development banks' debarment list (on since 2026-11-20).**
  `mdbDebarmentConnector` in `sources/debarment.js` screens the EBRD's list of
  barred firms and people, which carries World Bank, ADB, IDB and AfDB
  debarments too. The publisher's terms allow "personal, non-commercial use"
  only. The owner confirmed that this site is non-commercial and asked for the
  list to be on. If the site is ever used commercially, switch it off with
  `FOUNDER_SOURCES_OFF=mdb-debarment`.

- **A declared contact for the SEC (owner step).** The SEC's website refuses
  automated readers that do not declare a contact, so until `SEC_USER_AGENT`
  (or an email in `FOUNDER_HTTP_CONTACT`) is set, filing texts, enforcement
  lists and SEC press releases are reported as not answered. Search of
  filings by name still works. The contact is sent to the SEC with each
  request; use an address you are comfortable sharing with them.
- **Sources built and switched off (`FOUNDER_SOURCES_ON`).** Each needs the
  owner's yes because of its terms:
  - `opensanctions-lists`: about 30 lists (Interpol red notices, the World
    Bank, ADB, IDB and AfDB debarment lists, FINRA bars, regulators in
    France, Switzerland, India and elsewhere). The licence is non-commercial
    and the data host's robots file says no, while the publisher's own
    documentation invites scheduled downloads.
  - `asic-banned`: Australia's banned and disqualified register. Open licence
    and a documented interface, but the host's robots file says no.
  - `sfc-hk-enforcement`: Hong Kong securities enforcement news. Robots allow
    it; the terms allow personal or internal use, and the search behind the
    page is not documented as public.
  - `us-tax-court`: the search behind the court's own web application, not a
    documented public service.
  - `podcast-episodes`: Apple's podcast directory. A documented, keyless
    search whose path the host's robots file closes to crawlers.
  - `infostealer-exposure`: a provider's estimate of how many infected
    computers held logins for the company's own domain. Counts and dates
    only; the provider offers the lookup for defensive use.
- **Sources on because the owner said the site is non-commercial.** The
  development banks' list (above) and EU data-protection fines (CMS
  Enforcement Tracker, CC BY-NC-SA, credited in each record). Switch either
  off with `FOUNDER_SOURCES_OFF` if the site is ever used commercially.
- **Patents and trademarks are off.** The patent search used Google Patents,
  whose terms bar automated querying and which turns automated readers away;
  `FOUNDER_GOOGLE_PATENTS=on` turns it back on at the owner's risk. The
  trademark search called the USPTO web application's internal search, which
  rule 4 of the handover lists as removed, so it is not enabled. A permitted
  route for both exists (the USPTO Open Data Portal) and needs a registered
  account, which is the owner's to create.
- **Who can sign in.** Any Google account can sign in and run checks unless
  `FOUNDER_ALLOWED_EMAILS` is set.
- **Debug routes.** In production the debug routes (`/api/debug/...`) answer
  only when `FOUNDER_ALLOWED_EMAILS` is set and the signed-in account is on it
  (everyone else gets "not found"). Model runs through them share one hourly
  cap of 40 across all accounts, on top of each account's own limit.
- **Quick brief limits.** Signed-out visitors: 15 quick briefs per ten
  minutes and 40 per hour per address. Signed-in: 30 and 120 per account
  (`QUICK_LIMITS` in `src/pages/api/founder/index.js`).
- **Stricter identity choices.** A person known by one name is tied to a
  record only when their company is named beside them. A very large employer
  beside a common name gives "likely", not "confirmed", until a second fact
  agrees. A pardoned conviction is graded medium and shown with the pardon.
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
- **Not covered by any free, permitted source.** US state trial courts,
  German and Dutch judgments (published without names), commercial credit
  and criminal-record files, private financials. Federal opinions, full
  party lists and case numbers need the CourtListener setting; without it
  only archived case titles are searched.
- **Pace.** Sources are asked no faster than they allow (the web archive
  about 15 times a minute; two sites ask for ten seconds between requests),
  so a full check takes three to five minutes, and several checks run back
  to back will find less news until the search allowances refill (about ten
  minutes).

## How the loop runs

- **Anchors from likely records never confirm.** A company, school, handle or
  domain learned from a record graded likely (of any kind) may raise another
  record to likely at most, never to confirmed. A likely grade that rests only
  on a weak basis (a related record, an event, a reversed name, or a list
  sharing one surname such as "Patrick and John Collison") never makes that
  record's threads trusted.
- **Screens are retried once.** A court, regulator or watchlist screen that
  timed out or got a server error (5xx) is run once more before it is
  reported as not answered.
- **Earlier companies typed are screened**, under their own names, unless one
  is a very large employer; then it is only checked for ties to the person.
  The report's coverage lists which were screened and which were only checked
  for ties.
- **Per-check allowances.** Presence sources (Hugging Face, Open Library,
  crates.io, npm, Stack Overflow, Bluesky, Mastodon, writing feeds) at most 5
  lookups each per check; the web archive at most 12. Lookups past an
  allowance are reported as not run.
- **Waiting for a source.** A lookup whose host or search engine says when it
  is free again waits for that time while the check is under 12 minutes old
  (`LIMITS.maxWaitAgeMs`; a search engine's allowance window and its pause
  after a block are both ten minutes). Past that it is reported as not run.
  A check never sits through more than two steps in a row with nothing run
  (`LIMITS.maxIdleSteps`): the lookups still waiting are then reported as not
  run, so the page is not left on a stuck bar for its last few lookups.
- **Starting again.** Starting a check of a person who already has one
  running resumes that check only when the details given match the ones it
  started with. Otherwise the running check is stopped and replaced by a new
  one with the new details, and the page says so.

## Limits per check

`LIMITS` in `deepCheck.js`: lookups, depth (the person is 0, what is found
about them 1, what those lead to 2), records kept, records per source,
rounds, and how many threads of each kind are pulled. When a limit is
reached the report says how much was not run or not kept.
