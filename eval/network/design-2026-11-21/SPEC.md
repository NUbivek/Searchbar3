# Network Map: build spec (2026-11-21)

The owner's brief: presets and labels must come from the file the user uploaded, not from a fixed
list; "Largest company" does nothing; the page must be useful, not fancy; a user must see the value
within thirty seconds of an upload, with no fiddling.

This spec is the winning design of three (`design_insights.json`), with the parts both judges asked
to graft from the other two (`design_simplify.json`, `design_taxonomy.json`, `judge_*.json`), and
the lead's decisions on what the judges found missing. Findings about the present code are in
`understand_*.json`. Where this spec and a design file differ, this spec wins.

Sample networks (invented people): `tests/fixtures/network/*.csv`.

## 1. What the user sees after an upload

Top to bottom:

1. **Source strip**, one line: "544 contacts from LinkedIn · saved to your account · Add or replace
   · Remove all". "Add or replace" opens the connector cards that exist today. With no contacts
   yet, the connector cards are the page (the upload is the hero), with one sentence on what the
   user gets.
2. **"Your network at a glance" card**:
   - a short paragraph in plain words built from the file (section 3). Plain text, numbers bold.
     No buttons inside the paragraph.
   - a row of **shortcuts** (section 4): "Everyone 544" first, then at most six chips built from
     the file, then "More" when there are others (at most twelve in all).
   - the **ask box**, with a fixed placeholder built from the file and three example questions
     built from the file (section 6), shown as small chips under the input. No rotating text.
3. **Map section**: the globe on the left (about 60% of the width) and the **people panel** on the
   right (section 5). On a phone: the panel first, the globe under it.
4. Under the globe, one toolbar: "Arrange by" (only the arrangements that split this file,
   section 7) and the breadcrumb.

After an upload the page scrolls so the at-a-glance card is at the top of the window. The globe
settles quickly (no 2.6 second swing-in after an upload).

Removed from the page: the presets bar (Whole network, Raise capital, Source deals, Diligence,
Largest company), the three lens gauges and their list filter, the "Layers" steps, the "Zoom to"
bar, the back chip, the seniority bar, the toolbar find box (it moves into the people panel), the
rotating placeholder, the dead `companyFilter` state, the `setExpanded` call in "Remove all" (it
throws after the delete has worked). The words Raise / Source / Diligence appear nowhere in the
interface; typed questions that use them still work.

## 2. One selection

Everything that picks people sets one selection `{ label, keys, sort }` (keys = person ids from
`personNodeId`):

- a shortcut (or several, see below);
- the Find input in the people panel (from two characters on);
- an answer to a question;
- a click on a group, a company or a person on the globe or in a list.

The selection drives `highlightIds` on the globe and the people panel's title and list. A selection
never rebuilds the globe's layout (only "Arrange by", the source chips and "direct only" do).
"Everyone" clears it. Setting a selection from another kind replaces the previous one.

**Shortcuts combine.** Pressing a second shortcut narrows the first (AND): "investors" then "at
Stripe" gives the investors at Stripe; the panel title reads "investors · at Stripe · 3". At most
three at once. While one or more are active, every other chip shows the count that would remain if
it were added, and a chip that would leave nobody is disabled. Pressing an active chip removes it.
Chips are toggle buttons (`aria-pressed`), reachable and operable by keyboard; focus stays on the
chip pressed.

## 3. The read-out (plain words)

Built by `profileNetwork` (section 8) from the contacts in view (after the source chips and "direct
only"). A sentence whose rule fails is left out, never padded. Templates:

- People files: "You know {N} people at {C} companies: {n1} {family1} and {n2} {family2}." then
  "The most at {co1} ({n}) and {co2} ({n})." then "Strongest in {sector} ({n})." then "{n}
  connected in the last 12 months."
- Files with tags that carry signal (pipeline or fundraising lists): "{N} contacts at {C}
  companies. By tag: {n} {tag1}, {n} {tag2}, {n} {tag3}. The most at {co1} ({n}), then {co2}
  ({n}). Most are in {city} ({n})."
- A file where 60% or more are investors or allocators says so: "{N} contacts at {C}
  organisations, {n} of them investors or allocators."
- Fewer than 30 people: the sector and recency sentences are dropped.
- A file with little to go on (company filled for under half the people, as in an X following
  export): say what there is and what is missing: "{N} people. Most have no company or title in
  this file, so they cannot be grouped by employer or role." plus whatever facet does carry signal.

Wording rules: no fund jargon, no "lens"; never the words API, key, token, free, paid, tier, quota.

## 4. Shortcuts (the presets, built from the file)

Each candidate is `{ id, type, label, count, keys, sort }`. Rules (N = contacts in view):

| Type | Label | Appears when | List order |
|---|---|---|---|
| everyone | "Everyone {N}" | always, first; clears the selection | most senior first |
| tag | "{n} tagged “{tag}”" | tags are filled for 30% or more; the tag covers 5% to 80% of N and at least 3 people; top 3 | most senior first |
| role | "{n} {family}" ("109 investors", "192 engineers", "79 clinicians") | the family covers 5% to 90% of N and at least 3 people; top 2 (top 1 when tags lead); the catch-all families never appear | most senior first |
| company | "{n} at {company}" | counted over the whole file with companies merged across groups (`groupByCompany`), at least 3 people and 2% of N; top 2 | most senior first |
| industry | "{n} in {sector}" | the label is a sector (not a job-function fallback and not Other), covering 10% to 60% of N; "Venture capital" is skipped when an investors chip shows | most senior first |
| place | "{n} in {city}" | location filled for 30% or more; the top city has 8% or more of N | most senior first |
| recent | "{n} connected in the last 12 months" | connected-on filled for 50% or more and at least 5 people in the window. The window ends at the earlier of today and the newest date in the file; when the file's newest date is more than 60 days old the label reads "in the 12 months before this export" | newest first, each row showing "Connected Mon YYYY" |
| senior | "{n} senior leaders" | `seniority() === 0` covers 10% to 60% of N, and no tag is literally "decision maker"; fills a free slot only | by company size, then name |
| relationship | "{n} through colleagues" / "{n} direct" | firm-wide CRM contacts exist | most senior first |

Order: when tags carry signal: tag (3), company (2), place (1), role (1), then the rest. Otherwise:
role (2), company (2), industry (1), place (1), recent (1), senior (1). Six show; the rest go under
"More" (twelve in all). Ties break by count, then label, so the order is stable.

Tags are compared lower-cased and trimmed; the label shows the commonest original spelling. Cities:
the first comma part of the location, with "Greater X Area" read as X.

"Largest company" is gone: the company shortcuts replace it, counted over the whole file. Pressing
"22 at Stripe" lights all 22 across every group they sit in.

## 5. The people panel (right of the globe)

One list, always the people behind the current selection (or, with none, the people in the part of
the globe in view).

- Title: "{label} · {n}" with a Clear control when a selection is active; "Everyone · {N}"
  otherwise.
- **Find** input at the top (name, company or title; from two characters; it is a selection like
  any other). It replaces both the old toolbar find box and "Filter these people".
- Sort: most senior, most recent, A to Z (the shortcut's own order is the default).
- With no selection, the top of the panel shows the groups inside the part of the globe in view as
  rows with counts (what the "Next layer" bars and the "Zoom to" bar did); clicking one flies
  there. With a selection active these rows are hidden.
- Each row: name, title · company, a small role chip, a hollow mark for a firm-wide contact, the
  "Checked" chip when a founder check exists, and a link to the person's profile when the file has
  one. Clicking a row opens it in place (it does not replace the panel): why the person is in this
  list (the classifier's reason, the tag, the date), Company profile, Founder check, intro paths.
- **What to do with the list**: "Copy" (names with title and company, one per line) and "Download
  CSV" (the listed people, the columns the file has) for whatever is listed. These work on the
  user's own data in the browser; nothing is sent anywhere.
- An answer to a question is shown here: "Answer · {total}", the reasons under each person, and
  the intro-path section when there is one. It replaces any active shortcut.
- Long lists render in pages as today.

## 6. Questions built from the file

Three examples, only in forms the question engine answers by rules, only from values in the file,
and only if at least one person would be returned (checked with the same rule tables the engine
uses). In order: "Who do I know at {co1}?"; a role question when a role chip exists ("Which
investors do I know?", "Which clinicians do I know?"); "Who do I know in {city}?" when there is a
place chip, otherwise "Who do I know at {co2}?". Each shows its count. "Intro paths to {company}"
is offered in the panel after a company is selected, not as an example.

The question engine learns the page's vocabulary so typed questions and chips agree: tags
("prospects in New York", "everyone tagged committed"), the map's own industry labels (through
`industryOf`), cities found in the file, and dates ("people I connected with this year", "in
2024", "in the last 12 months"). Role questions count the same people as the role chips (one
classifier, not two).

## 7. Labels and arrangements that follow the file

- **Classifier fixes** (they change every count, so they ship first):
  - tags are never read as job titles (a CRM tag "partner" made 69 retail contacts "investors");
  - a role given by the employer's name alone (investor, LP, clinician) yields to a title that says
    otherwise (an engineer at "Cobalt Capital" is an engineer; a product manager at a hospital is
    not a clinician);
  - pension, endowment and family-office staff are allocators (LP), not investors;
  - the wrong labels the audit lists (`understand_classify.json`): cardiologist and other
    specialists, "Program Manager", "Program Director" at an accelerator, wealth management,
    "Managing Director, Private Markets", retail words (Stores, Grocers, Markets, Outfitters,
    Pharmacy) as Commerce.
- **Families** for the read-out and chips: investors (investors and allocators together),
  founders and CEOs, engineers, product and design people, sales and marketing people, clinicians,
  researchers and academics, bankers, lawyers, consultants, and so on; the catch-all groups are
  split by title and never shown whole.
- **Arrange by**: By role, By company, By industry, By place, By tag. Only arrangements that split
  this file are offered (at least two groups of 5% or more each, the largest 90% or less); the
  others are hidden, not greyed out. The default is the role arrangement, or By tag when tags
  carry signal and most people have exactly one tag; when people carry several tags, By tag is
  offered but is not the default, and its bubbles say "first tag".
- A first layer with a single bucket is skipped (a fundraising list no longer opens as one
  "Investors & LPs 114" bubble).
- Group hints are generated: "{n} people · most at {company} ({k})". The fund-manager sentences go.
- **By company must not freeze**: today globe placement takes 31 seconds on a 544-person file. Cap
  the first layer (the sixteen largest companies, the rest folded into "Other companies") and fix
  the placement cost. Budget: any arrangement of 5,000 contacts ready in under one second.
- A company clicked on the globe selects the whole company (all its people across groups), not
  the slice.

## 8. Code contracts between the owners

Data (`src/utils/network/`):

- `roles.js`: `classifyContact(contact)` (fixed, same return shape plus `family`), `familyOf(contact)
  -> { key, one, many }` ("investor" / "investors"), `FAMILIES`.
- `grouping.js`: `GROUPINGS` gains `{ key: 'tag', label: 'By tag' }` and country becomes "By place";
  `tagsOf(contact) -> string[]` (normalised); `cityOf(contact) -> string`; `isSector(label) ->
  boolean`; `usefulGroupings(contacts) -> [{ key, label }]`; `defaultGrouping(contacts) -> key`.
- `atlas.js`: `buildAtlas(contacts, { groupBy })` accepts `'tag'`; skips a one-bucket first layer;
  caps the first layer of `'company'`; gives every group node a generated `hint`; returns
  `atlas.companyIndex` (company key -> node ids).
- `insights.js` (new, pure, no React): `profileNetwork(contacts, { today } = {}) -> { n,
  companies, fields, sentences: string[], shortcuts: Shortcut[], more: Shortcut[], questions: [{
  text, count }], groupings, defaultGrouping }`; `combine(profile, ids: string[]) -> { label, keys:
  Set<string>, sort }`; `countIfAdded(profile, activeIds, id) -> number`; `listText(contacts) ->
  string`; `listCsv(contacts) -> string`. `Shortcut = { id, type, label, count, keys: string[],
  sort: 'senior' | 'recent' | 'company' }`. Cost budget: 30,000 contacts in under 200 ms.

Globe (`src/components/network/NetworkGraph.js`): props as today. With `highlightIds` set: people
outside it are dimmed clearly (more strongly the larger the selection), the camera turns to the lit
people, and when they are spread over more than about a third of the globe it pulls back to the
whole globe and pulses the lit dots once, so a press is always visible; a small count ("22 lit")
sits in a corner. Hex colours only inside `THEMES`.

Question engine (`src/server/network/query.js`): same return shape; new filters as in section 6.

## 9. Acceptance tests (each owner writes the ones in its area)

- On the six sample files the read-out and shortcuts are exactly the kind shown in
  `design_insights.json` "examples" (numbers may differ where a classifier fix changes them; the
  test states the numbers it gets and why): the venture file leads with investors and Stripe (22)
  and Google (19); the sales CRM leads with its three tags, has no investors at all, and names
  Marlowe Department Stores (18); the founder file has no "investors" chip; the healthcare file
  leads with clinicians; the fundraising list opens on its tags and is not one bubble; the small
  file drops the sector and recency sentences.
- No shortcut ever shows a count of zero or of everyone. Pressing any shortcut on any sample file
  lists exactly `count` people.
- A company shortcut lights every person at the company whatever the arrangement (22 at Stripe
  under By role).
- Two shortcuts combined list the intersection; the chip counts shown while one is active are the
  intersection sizes.
- A selection never changes the atlas object (same reference before and after).
- By company on the 544-person file is ready in under one second (it was 31 seconds).
- Every example question returns at least one person on the file it was built from.
- "Remove all" deletes and shows no error.
- The interface never shows Raise / Source / Diligence, nor API, key, token, free, paid, tier,
  quota. No hex colours and no `dark:` variants outside `THEMES`.
- `profileNetwork` on 30,000 generated contacts runs in under 200 ms.

## 10. Rules that hold

Contacts never leave the account and are never sent to a model (only a question's text may be).
Nothing is invented: every person, label and number comes from the uploaded file. Never read or
print real contact files; use the sample files. The globe stays, serving the selection. Token
classes only (DESIGN.md).
