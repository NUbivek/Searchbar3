# Codex handover: Research Hub (diligence.bivek.ai)

Written 2026-11-17 by Claude for Codex, which takes over maintenance and an
improvement run every two weeks. Read this file, then `AGENTS.md` (house rules, design,
architecture), `FOUNDER-CHECK.md` (the deep background check) and `README.md`
(features, AI models, setup). Nothing here replaces them; this file says what
state things are in and how to run the maintenance loop.

## 1. Where things stand

| | |
|---|---|
| Live site | https://diligence.bivek.ai (Vercel project `searchbar3`, team `1bivekadhikari-1506s-projects`) |
| Production branch | `openclaw-fixes` at `eb6ee9d` (merge of preview `5cd490a`), released 2026-11-17 at the owner's request |
| Working branch | `claude/research-hub-fix` (every change lands here first) |
| Tests | 1,735 passing (`npx jest`); production build compiles (`NEXT_DIST_DIR=.next-build npm run build`) |

Released on 2026-11-17 (all live):

1. **Tavus removed** (component, config, docs, package). Restore from commit `ddeb651` if ever wanted.
2. **Model chain: only models that cost nothing, strongest first** (`src/server/llm/providers.js`; README "AI models"). Gemini 4 Hydrogen leads. Guarantees are tested in `tests/unit/features/llmChain.test.js`. `GET /api/debug/llm-check` shows the order; `?run=chat|analysis|extract|json|brief|gaps` makes one small real call.
3. **Deep background check** on the Founder Check page (`FOUNDER-CHECK.md`): about forty free public sources, a step-per-request loop, identity grading, privacy rules, a second reader, learning, and a report with red flags, company matters, possible namesakes, claims that changed, related parties, timeline and coverage. Sign-in required, 12 checks per hour per account.

Quality so far, from graded live checks on public figures (`eval/founder/`):

| Round | Average | Notes |
|---|---|---|
| 2 | 54 | a namesake's guessed archive page confirmed ~35 wrong records |
| 3 | 72.7 | no wrong-person attributions |
| 4 | 75.3 | Milton 80, Neumann 74, Mensch 72; no wrong-person attributions; fixes from this round's plan are released |

## 2. Rules that must never be weakened

These are the owner's decisions. A change that breaks one is a regression, whatever else it improves.

1. **Free only.** Only AI models on the allow-list in `providers.js` (all cost nothing). Never add a paid provider, a trial-credit provider, or a switch that turns one on. Never read the paid keys still in Vercel (`TOGETHER_API_KEY`, `PERPLEXITY_API_KEY`, `CEREBRAS_API_KEY`).
2. **Never pin a namesake's record on the founder.** A record without the person's full name is never tied to them. Name-only matches stay `possible`. A source never sets `confirmed` by hand; the strongest it may set is `likely`. Role and tenure anchors raise a record to `likely` at most.
3. **Privacy:**
   - No home addresses, phone numbers, personal emails, dates of birth (including month and year) or ID numbers.
   - Nothing about children, health (including substance use), religion, sexuality or immigration status.
   - Relatives only when the source states the kinship and gives them a business, political or philanthropic role beside their name. Family ties of relatives to third parties are stripped.
   - Associates and relatives are only screened against watchlists and searched together with the founder; never a stand-alone check.
   - No people-search or data-broker sites. No stolen or breached personal data: breach sources are company-level only. No onion search.
   - Political donation records are excluded.
4. **Polite, permitted access.** Sources are reached the way they allow: paced per host, never disguised as a browser, robots and terms respected. Sources removed for terms reasons stay removed: certificate transparency, a ProPublica people search, the USPTO web app's internal search, ransomware.live, Ahmia.
5. **Honest coverage.** A failed source is reported as failed and a lookup not run is reported as not run. "No record found" is never presented as a clean record.
6. **UI wording.** Never use "API", "key", "token", "free", "paid", "tier" or "quota" in the UI. Say "not enabled on this deployment".
7. **House rules from AGENTS.md:**
   - Never read `.env*` or credential files, or print secrets.
   - Never print the owner's contacts or network files.
   - Always `git push origin <branch>`.
   - **Production only on the owner's explicit "push to production"**, by a merge commit of `claude/research-hub-fix` into `openclaw-fixes` (procedure in AGENTS.md).

## 3. The maintenance run (what Codex does every two weeks)

The owner chose a run every two weeks (not daily). The prompt to schedule is
`CODEX-RUN-PROMPT.md`.

Goal: keep the site healthy and keep improving the deep check's accuracy, without ever breaking the rules above. Work only on `claude/research-hub-fix`. Do not release to production on your own: leave a release note for the owner (step 8).

1. **Sync.** `git checkout claude/research-hub-fix && git pull origin claude/research-hub-fix`. Read the last entry of `eval/founder/LOG.md` (create it if missing).

2. **Health.**
   - Run `npx jest`. All must pass.
   - Run `NEXT_DIST_DIR=.next-build npm run build`. It must compile.
   - Fix anything red before doing anything else.

3. **Production smoke check (read-only).**
   - `/`, `/founder` and `/network` must return 200.
   - `/api/llm/models` must list models.
   - `POST /api/founder/deep` with `{"action":"start","name":"Test Person","company":"Acme"}` while signed out must return 401 with `"signIn":true`.
   - Record the results in the log.

4. **Model chain check.** On the latest preview deployment, via `npx vercel curl "/api/debug/llm-check?run=chat" --deployment <url>` (preview is behind Vercel sign-in; `vercel curl` handles it):
   - `ok` must be true.
   - If a provider shows "sign-in problem", its key was rejected: note it for the owner. Never change keys yourself.
   - If the model line-up changed (new or retired models), update the table at the top of `providers.js`, keeping the free-only allow-list rules and the tests green.

5. **Live evaluation (three subjects per run, rotating from run to run).**
   1. Start a local server that allows unsigned checks:
      ```
      PGLITE_DIR=.data/pglite-codex ALLOW_DEV_LOGIN=true FOUNDER_DEEP_PUBLIC=true NEXT_DIST_DIR=.next-dev npx next dev -p 3009
      ```
      This runs locally only. Never set `FOUNDER_DEEP_PUBLIC` in Vercel.
   2. Run `node eval/founder/run.mjs "<Name>" "<Company>" eval/founder/runs/<date>`.
   3. Rotate through the subjects in `eval/founder/ground-truth.md`: Elizabeth Holmes / Theranos, Sam Bankman-Fried / FTX, Adam Neumann / WeWork, Trevor Milton / Nikola, Arthur Mensch / Mistral AI, Patrick Collison / Stripe.
   4. Do not run them back to back: search engines need about ten minutes to refill their allowances, and checks run back to back find less press.
   5. Locally there is no AI model, so the brief is assembled from the records. That is expected.

6. **Grade.** Score each report against `eval/founder/ground-truth.md`, section "What graders should score":
   - recall of the MUST and SHOULD facts;
   - wrong attributions (the worst failure);
   - privacy violations;
   - noise and ranking;
   - claims that changed;
   - related parties;
   - coverage honesty.

   For every miss, find its cause in the code (the source was never asked; asked and failed, with what error; answered but the record was dropped; found but ranked low) and write a concrete fix. Append the scores and fixes to `eval/founder/LOG.md`.

7. **Fix.** Apply the highest-value fixes. Pick from today's grading and from `eval/founder/open-items-round4.json`, whose items are still open; check the code first, because some may already be handled.
   - Each fix gets a test.
   - Run the full suite and the build.
   - Commit with a clear message and `git push origin claude/research-hub-fix`.
   - Re-run one subject live to confirm the score did not drop. A fix that lowers the score or adds a wrong attribution is reverted.

8. **Report.** Append to `eval/founder/LOG.md`:
   - the date;
   - the health results;
   - the scores;
   - what changed (commits);
   - what is still open;
   - a one-line release note for the owner, when preview is ahead of production and green.

   Never merge to `openclaw-fixes` without the owner's explicit "push to production".

## 4. Known open items (start here)

1. **OpenRouter key rejected.** On 2026-11-17 every OpenRouter model answered with a sign-in problem, so answers come from Gemini and Groq only. The owner must rotate `OPENROUTER_API_KEY` in Vercel. Codex never handles key values.
2. **Round-4 open items.** The ranked plan in `eval/founder/open-items-round4.json` is not yet fully applied. The main remaining ones:
   - archived federal dockets for the subject's own criminal case still grade `possible`;
   - court case numbers missing without CourtListener;
   - prior-venture lawsuits (state courts) not reachable;
   - Wikipedia passage dating (uses the latest year named);
   - the company's own /about and /team pages over time (archive);
   - French register and BODACC queried for non-French companies;
   - LittleSis blurb clauses about third parties.
3. **CourtListener.** Full federal dockets need a free token (`COURTLISTENER_API_TOKEN`). The owner creates the account and sets the variable. Without it, only case titles are searched.
4. **Owner decisions** (documented in FOUNDER-CHECK.md "Choices the owner should know about"):
   - Google News feed on or off (`FOUNDER_SEARCH_GOOGLE_NEWS=0`);
   - backup search service for the deep check (`FOUNDER_SEARCH_METERED=0`);
   - Gemini for people checks (`LLM_SKIP_GEMINI_FOR_PEOPLE=true`).
5. **Unused paid keys** in Vercel (Together, Perplexity, Cerebras) can be deleted by the owner.
6. **Local database.** The local embedded database folder `.data/pglite-3009` was damaged by a crash. It may hold contacts the owner imported locally, so do not delete it. Saved checks and large list caches no longer use the local database. Use a fresh `PGLITE_DIR` for testing.
7. **Not yet verified in a real browser window:** a complete check run end to end in the visible page. The report page has been verified by rendering a real finished report through the component in a test browser.

## 5. Where things are

| What | Where |
|---|---|
| Deep check loop | `src/server/founder/deepCheck.js` |
| Identity grading | `src/server/founder/identity.js` (`matchSubject`, `orgMatcher`, `addRoleAnchor`, `personKey`, `companyKeyStrict`) |
| Privacy rules | `src/server/founder/guardrails.js` |
| Finding shape and severity | `src/server/founder/finding.js` |
| Report and brief | `src/server/founder/report.js` |
| Second reader | `src/server/founder/gaps.js` |
| Sources | `src/server/founder/sources/*.js`; list in `sources/index.js`; contract at its top; `tests/unit/features/founderSources.registry.test.js` holds every source to it |
| Pacing and HTTP | `src/server/founder/http.js` (per-host gaps; rests with `retryAt`), `sources/searchEngines.js` (engine allowances, `SEARCH_RESTING`) |
| Saved checks and caches | `src/server/founder/jobStore.js`, `src/server/founder/cache.js` (hosted database only; memory locally) |
| Learning | `src/server/learning.js` (kinds query, source, model, model-day) |
| API and page | `src/pages/api/founder/deep.js`, `src/components/founder/DeepCheck.js` |
| Models | `src/server/llm/providers.js`, `src/pages/api/debug/llm-check.js` |
| Evaluation | `eval/founder/run.mjs`, `eval/founder/ground-truth.md`, `eval/founder/open-items-round4.json`, `eval/founder/LOG.md` |
