# Deep check maintenance log (a run every two weeks)

## 2026-11-17 (Claude, handover)
- Health: 1,735 tests pass; production build compiles.
- Production: released `eb6ee9d` (merge of preview `5cd490a`) at the owner's request. Smoke check: `/founder` 200, `/api/llm/models` 200, deep check gated behind sign-in (401 when signed out).
- Models on preview: chat and extract answer (Gemini). OpenRouter rejects its key: the owner must rotate `OPENROUTER_API_KEY`.
- Scores (round 4): Milton 80, Neumann 74, Mensch 72; average 75.3; no wrong-person attributions.
- Open: see CODEX-HANDOVER.md section 4 and open-items-round4.json.

## 2026-11-20 (Claude, overhaul after the owner's report that the tab was broken)
- Owner's report: random people in the results even with name and company; less than the person's LinkedIn shows; no visible dark-web, government or court results.
- Causes found on "Shensi Ding / Merge": the quick brief listed colleagues' LinkedIn pages, a contact-broker page and headline words as companies; the first AI model took nearly all the time, so the summary fell back to quotations; the deep check had no profile (search snippets only, no page ever opened), showed clean screens only inside "What was searched", and mixed same-name companies (five "Merge LLC" registrations, a Tennessee trademark, Ethereum's "The Merge") into the sections.
- Changes: quick brief keeps only pages about this person (company required when given; no other people's profiles; no people-search or contact-broker hosts); each model attempt but the last is capped (16s, 26s for analysis); new page reader source; Profile card; Public-record screens checklist; name-only records moved to one collapsed block; a company name shared by three or more register entries ties nothing by itself; a name-only record naming an employer from the person's own bio is raised to likely.
