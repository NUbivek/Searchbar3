# Network Map, round 2: changes after seeing the first build in a browser

Date: 2026-11-21. This file adds to `SPEC.md` in the same folder and wins where the two disagree.
It was written after loading the invented sample networks into the rebuilt page in a real browser.

The owner's test stays the same: within thirty seconds of an upload the page must say something true and
useful about this file, in this file's own words, and every control must do something that can be seen.

## What the first build got right (keep)

- The source strip, the "Your network at a glance" card, the read-out sentences, the example questions.
- One selection drives the globe and the people list; the list has Find, sort, Copy and Download CSV.
- Answers show in the people list; rows open in place; "Remove all" works.
- Arrange by Company is instant; By place and By tag exist and appear only when they split the file.

## R1. Shortcuts switch. Narrowing moves into the people list.

Seen: after pressing "22 at Stripe" the other chips changed to "0 investors" (disabled), "1 engineers",
"0 at Google" (disabled). The card looked as if the network had shrunk, and going from Stripe to Google took
two clicks.

- A shortcut's label and count never change and a shortcut is never disabled.
- Pressing a shortcut makes it the selection, replacing whatever was selected. Pressing the pressed one
  again, or "Everyone", or Clear, goes back to everyone. `aria-pressed` marks the one in use.
- A selection made any other way (a group or company clicked on the globe, an answer) that holds exactly a
  shortcut's people shows that shortcut as pressed.
- Narrowing: when the selection has more than one person, the people list shows a row "Narrow to" with up to
  six of the other shortcuts (from `shortcuts` then `more`) whose overlap with the current list is at least 1
  and smaller than the list, largest first, each with its overlap count ("12 investors", "1 engineer").
  Pressing one narrows the list (AND). At most three parts in all. With two or more parts, each part shows
  as a small removable chip under the title; removing one widens the list again.
- Wording is singular when the count is 1 ("1 engineer", "1 investor", "1 senior leader"), everywhere.

Code: `insights.js` keeps `combine` and `countIfAdded`; add `narrowings(profile, activeIds, limit = 6)`
returning `[{ id, label, count }]` with the label already in the right number, and
`labelFor(shortcut, count)`. `Shortcuts.js` loses the intersection counts and the disabled state.

## R2. By role shows this file's roles, not four fixed groups

Seen: the healthcare file's read-out says "100 clinicians and 64 researchers and academics", and the globe
beside it says "Experts & advisors 135 · Operators & talent 60 · Founders & executives 44". Those four names
are the same for every file. That is the static labelling the owner asked to remove.

- Under By role the first layer is the role families present in the file (`FAMILIES` in `roles.js`), largest
  first: the same people the read-out and the role shortcuts count.
- At most eight family groups. Families beyond the eighth, and any family under 3% of the file, fold into
  one last group, "Other roles", which opens onto those families. The catch-all families ("other senior
  leaders", "other professionals", "people with no title") never take one of the eight places unless fewer
  than three other families exist; otherwise they sit inside "Other roles".
- Second layer under a family: companies (largest first, the same cap and "Other companies" rule as By
  company, scaled down: eight companies, then "Other companies").
- Each family carries a short title for the globe and list ("Investors", "Founders & CEOs", "Engineers",
  "Product & design", "Data & analytics", "Sales & marketing", "Operations", "Finance", "Recruiting & HR",
  "Clinicians", "Researchers & academics", "Bankers", "Lawyers", "Consultants & advisors", "Partners at
  firms", "Accelerators", "Public sector", "Journalists & analysts", "Students", "Other senior leaders",
  "Other roles", "No title") and a short tag for a person's row ("Investor", "Founder or CEO", "Engineer",
  "Product & design", "Data", "Sales & marketing", "Operations", "Finance", "Recruiting & HR", "Clinician",
  "Researcher", "Banker", "Lawyer", "Consultant", "Partner", "Accelerator", "Public sector", "Journalist",
  "Student", "Senior leader"; no tag for the last two catch-alls).
- Every family group has a stable colour from the palette (by family key, not by position), the same in both
  themes and in the list's dots.
- `usefulGroupings` decides whether By role is offered from the families (at least two families of 5% or
  more, the largest no more than 90%).
- The four old names (`ROLE_GROUPS`) stay exported for the question engine and the founder check's network
  link, but nothing on the Network Map page shows them.
- By industry and By place: the second layer is the role family (not the four groups).

## R3. By tag: one number per tag

Seen: sales CRM file, chips "107 tagged prospect, 73 customer, 69 partner"; globe and list "prospect 89,
customer 53, partner 53". A person with several tags sits under one tag only, so the two disagree.

- A tag group's count, on the globe and in the list, is the number of people who carry the tag (107).
- Clicking the tag group selects everyone who carries the tag, wherever they sit.
- The group's hint says how many sit under another tag when that is not zero ("18 of them sit under another
  tag on the map").

## R4. By company: the named companies lead

Seen: "Other companies 116" is the largest bubble, faces the viewer and is first in the list; the largest
named companies have no label at the whole-globe view.

- The largest named company faces the viewer. "Other companies" is placed on the far side and listed last.
- At the whole-globe view the top-layer companies carry labels like groups do (name and count), the largest
  eight at least; the rest appear on hover and when near.
- "No company" people, if any, form their own last group ("No company listed"), never mixed into a company.

## R5. Clicking the globe always does what it looks like

Seen: with the LP file under By tag, a click just above the "COMMITTED 20" label selected "cold · 23"; then,
with cold selected, a click exactly on the dimmed "COMMITTED 20" label did nothing.

- A click on a group or company label, or on its hub, selects that group or company: also while another
  selection is active and the label is dimmed. Dimmed labels stay readable enough to aim at.
- A click that is not on a label, hub or person never selects a group the pointer is merely inside; it is a
  background click. A background click clears the selection, whatever made it (as before the change); so
  does the Escape key while the map or the list has focus. A drag is never a click.
- Clicking a group or a company also opens it, as it did before the change: the camera goes into it far
  enough to show the layer inside, and the breadcrumb names it. Its people are listed in the people list.
  When a click both opens a node and changes the lit people, the camera goes to the node (one flight).
- The pointer shows a hand over anything clickable; hover shows the name and count.

## R6. The breadcrumb follows the user

Seen: after pressing a shortcut, the breadcrumb changed to "All > Experts & advisors 135" because the camera
had turned. The breadcrumb names only what the user opened (a group, a company). A selection that turns the
camera does not change it.

## R7. Small fixes

- The answer's list title says what the list is: the "read as" phrases joined ("In Austin · 27"), or the
  question in quotes when there are none. Not "Answer".
- The read-out quotes tag names (By tag: 23 "cold", 23 "met 2026", 20 "committed") and sets only the counts
  in bold. A number inside a name is never bold.
- An opened row never shows the classifier's internal words ("Title and company: lp / allocator"). It says,
  in plain words, only what helps: "Tagged “passed”", "Connected Mar 2025", where the person is.
- Phone width: the people list shows at least six people before the globe (the group rows collapse to one
  line that opens), and the list is at least 60% of the screen's height.
- When the lit people are a tight bunch, the camera zooms in to them and the "You" marker does not sit on
  top of them. On a file of under forty people the whole network fills the globe.
- The page's wheel scroll is not captured by the globe unless the pointer has been still over it for a
  moment or the globe has focus (a page scroll that starts above the globe keeps scrolling the page).

## Acceptance (added to SPEC.md section 9)

- On all six samples: pressing each shortcut in turn lists exactly its count and leaves every other
  shortcut's label, count and enabled state unchanged.
- "Narrow to" never offers a count of zero or the whole list; pressing one gives exactly its count; three
  parts at most; "1 engineer" not "1 engineers".
- By role on the healthcare sample: first-layer labels include "Clinicians 100" and "Researchers & academics
  64"; none of the four old names appears anywhere on the page for any sample.
- By tag on the sales CRM sample: the "prospect" group shows 107, and selecting it lists 107.
- By company on every sample: the first row of the list's groups is the largest named company, and "Other
  companies" is last.
- A click on any top-layer label selects that node, with and without another selection active (tested on
  the hit-test function with the real projected positions).
- The breadcrumb does not change when a shortcut is pressed.

## R8. Decisions on the independent review (eval/network/review-2026-11-21/findings.json)

Every confirmed finding and every "missed" finding in that file is to be fixed unless listed here as decided
otherwise. Where a finding's `betterFix` exists, use it. These decisions settle the ones with a choice in them.

**One number per thing.** A count shown in the read-out, on a shortcut, on the globe, in the list and in a
typed answer for the same set of people is the same number everywhere. Whenever two disagree, that is a defect.

1. **Industry comes from the employer, never from the job title** (value-5, data-6, data-7). `industryOf`
   reads the company (its name, the known-company table, its own descriptors such as "Capital", "Health
   System", "University"). Job-function words in a title ("Software Engineer", "Student", "Finance") never
   set a sector. A teaching hospital is Healthcare (data-1). When the employer says nothing, the industry is
   not known: those people sit in one last group "Industry not known" under By industry, are never a
   shortcut, and never appear in "Strongest in". By industry is offered only when it still splits the file.
2. **Placeholder employers are not companies** (data-2): self-employed, freelance, independent, stealth
   (any form), retired, unemployed, student, n/a, none, confidential, various, "-", "—". They count as no
   company everywhere (chips, sentences, questions, By company).
3. **Company spellings merge; different companies do not** (data-3, data-m2). Merge legal suffixes and
   spelling variants ("McKinsey", "McKinsey & Co.", "McKinsey & Company"; "JPMorgan", "JP Morgan", "J.P.
   Morgan Chase & Co."; "Facebook" with "Meta" as a rename). Do not merge a parent with a subsidiary
   (Google stays apart from Alphabet). The label shown is the spelling most people in the file use.
4. **Notes are not tags** (value-6, data-8). A Notes or Comments column is not stored in `tags`. Tags come
   from columns named tag(s), label(s), list, segment, category, group, stage, status, pipeline stage, lead
   status (value-10). `tagProfile` counts as a tag only a value of at most four words and forty characters.
   An applicant-tracking export (Candidate Name, Current Company, Current Title, Stage) must load (value-10).
5. **Thin files still get something** (value-9). When fewer than half the people have a company, a company
   is read from a work email's domain (never from a webmail domain), shown as the domain ("stripe.com") and
   the sentence says "from email addresses". A file with names only says so in one sentence and offers Find.
6. **Places** (data-9): LinkedIn's metro strings resolve to the real city and country ("Greater Houston",
   "Miami-Fort Lauderdale Area", "Dallas-Fort Worth Metroplex", "Bay Area", "Brooklyn, NY" as New York).
   "Remote" and anything unrecognised is "Place not known", never a country.
7. **Ties are said as ties** (value-2, value-16), and a sentence is never written about a group that is
   everyone or nearly everyone (value-12, value-m1, value-m2, value-m3) unless it says exactly that
   ("all of them investors or allocators").
8. **Shortcuts never repeat each other** (value-4): a candidate that shares 80% or more of its people with a
   shortcut already shown gives its place to the next candidate. "More" holds one of each remaining kind
   before a second of any kind (value-3, data-10). A shortcut has at least three people (value-11).
9. **A typed answer returns everyone it found** (ask-1, page-2, page-m1). The response carries `keys`: the
   contact key of every match, uncapped, in rank order; rows with reasons stay capped. The page lights,
   counts, lists, copies and downloads from `keys`. The question is answered over the people in view (the
   active source filters and "direct only" are applied before ranking: signed out by sending only those
   people, signed in by sending the filters).
10. **Nothing from the file reaches a model** (ask-2, ask-3, ask-m2, ask-m5). The model is asked only when
    the rules read nothing at all from a question the user typed. Questions the page builds itself (the
    examples, "Intro paths to …", "Company profile") go with the target as data (`target`) or with the model
    switched off, so a company name or tag from the file can never be in a prompt. With no contacts the
    route answers 400. Signed out, the model is not used at all. The lens words stay understood in typed
    questions, and a lens found by the rules counts as found.
11. **A question that cannot be honoured says so** (ask-4, ask-19). "not at Google", "excluding", "except",
    "outside" exclude that company, place or tag. Words the engine could not use are named in a note ("Not
    used: …") instead of being dropped silently. "diligence" alone asks for a company or field when it
    would match most of the file (ask-m3).
12. **Tags in one question** (ask-11): "prospects in New York" is AND across kinds; two tags of the same
    kind joined by "and" are AND ("prospects who are decision makers"), joined by "or" are OR.
13. **Speed** (data-11, globe-8, globe-5): the test times the page's real order on fresh objects, cold, at
    30,000 contacts: profile and first atlas together under 600 ms, a selection change under 50 ms. The
    draw loop batches lit dots (one path per style), and stops when nothing is animating or the canvas is
    off screen or the tab is hidden.
14. **Privacy wording** (page-23): the empty state says only what is true in both modes: "Your contacts are
    never shared and never sent to a model." Nothing else about where things are kept unless it is exact.
15. **Wording rule**: Attio and X error text shown to a user never carries "token", "API" or "key"
    (page-8); the page rewrites such errors in plain words.
16. **Download** (data-12, page-16, data-16, data-m1): the CSV starts with a byte-order mark so Excel reads
    accents; the file is named after the list ("network-investors.csv"); a failed copy or download says so.
