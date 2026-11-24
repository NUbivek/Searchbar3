# Network Map

Your own contacts, read back to you in plain words: who you know, at which
companies, in which roles and places, and one-click lists of them you can
copy or download. Everything on the page is built from the file you
uploaded: the read-out, the shortcuts, the example questions, the groups on
the globe and their names. Nothing is invented: every person comes from your
file, every role from the title and company in it, every number from a count
of those people. Your contacts never leave your account and are never sent to
a model.

The test the page is held to: within thirty seconds of an upload it says
something true and useful about this file, in this file's own words, and
every control does something you can see.

## Getting your network in

**LinkedIn** does not give apps your connections, so the export is the only
way in: *Settings & Privacy → Data privacy → Get a copy of your data →
Connections*. LinkedIn emails a zip within minutes; drop `Connections.csv`
on the page (or click *Upload LinkedIn Connections.csv*). The export has
first name, last name, URL, company, position and the date you connected.
Email is usually blank (LinkedIn only includes it when the contact allowed it).

**Any CSV or XLSX** of contacts also works: a header row with a name column
(`Name`, `Full Name`, `Candidate Name`, or `First Name` + `Last Name`) and,
ideally, `Company`, `Title`, `Email`, `LinkedIn URL`, `Location` and a column
that sorts people into piles. Columns named tags, labels, list, segment,
category, group, stage, status, pipeline stage, lead status or deal stage
are all read as tags, so a CRM pipeline or an applicant-tracking export
loads as it is. A Notes or Comments column is recognised and left out:
notes are not tags. Dates are read in US or day-first order (decided per
file). A new upload replaces the previous import from that source; LinkedIn
and CSV imports live side by side.

**X** sign-in identifies you and, where X allows it, imports the accounts you
follow; an X following export (JSON) can also be uploaded as a file. There is
no LinkedIn sign-in on the page: LinkedIn only returns your own profile, so
it would add nothing to the map.

**Attio (the firm's CRM)** shows as "Connect Attio · soon" until
`NEXT_PUBLIC_ATTIO_ENABLED=true` is set; the import is built and tested.
When on, it imports the People of an Attio workspace with an access code you
paste in (Attio → Workspace settings → Developers). The code is used for that
one request and never stored. Every person is saved with a *relationship*:

- **direct**: Attio's *strongest connection user* for that person is you
  (matched by the email you sign in with);
- **firm**: anyone else's contact, saved with `via` = the colleague's name.

Firm contacts are hollow dots on the globe and every list labels them *Firm ·
via <colleague>*, so a colleague's relationship is never mistaken for your
own. An access code that cannot see the workspace's members saves everyone as
firm-wide, and the page says so. The same person imported from LinkedIn and
Attio is merged once, and a direct connection anywhere wins. Messages from X
and Attio are shown in plain words.

Signed in, contacts are saved to your account (Postgres) and are there on
every device. Signed out, they stay in the browser tab and are gone when you
close it. Limits: 25 MB per file, 30,000 contacts per account, 14 MB per
import request.

## What you see after an upload

The page scrolls so the read-out is at the top of the window, and the globe
settles at once. Top to bottom:

1. the source strip;
2. "Your network at a glance": the read-out, the shortcuts and the ask box;
3. the map section: the globe and, beside it (above it on a phone), the
   people list;
4. under the globe, "Arrange by" and the breadcrumb.

With no contacts yet, the connector cards are the page, with one sentence on
what you get: "Your contacts are never shared and never sent to a model."

## The source strip

One line: "544 contacts from LinkedIn · saved to your account · Add or
replace · Remove all" ("kept in this tab only" when signed out). *Add or
replace* opens the connector cards. *Remove all* asks once, deletes every
imported contact and says so.

When contacts come from more than one source, each source has a chip that
shows or hides its people, and with firm contacts present, *My direct
connections only* hides the colleagues' contacts. These are the only
controls that change who is "in view": the read-out, the shortcuts, the
globe and every answer are worked out again over the people in view. A
fresh upload shows every source again.

## Your network at a glance

**The read-out** is a few sentences built by `profileNetwork`
(`src/utils/network/insights.js`) from the people in view. A sentence whose
rule finds nothing worth saying is left out, never padded. Only the counts
are bold; a tag name is quoted and stays plain, even when it holds a number
("23 “met 2026”"). The kind of file decides what it says:

- A people file: "You know 544 people at 254 companies: 112 investors and
  97 engineers. The most at Stripe (22) and Google (19). Strongest in
  Fintech (60). 79 connected in the last 12 months." A file with locations
  also says where most people are ("More are in Austin (27) than anywhere
  else").
- A file whose tags carry signal (a pipeline or a fundraising list): "By
  tag: 107 “prospect”, 73 “customer”, 69 “partner”." then companies and
  places.
- A file where nearly everyone is an investor or allocator says that once
  ("114 contacts at 80 organisations, all of them investors or allocators")
  instead of naming the obvious group.
- Under thirty people, the sector and recency sentences are dropped.
- A file with few companies says what it has and what it lacks. When fewer
  than half the people have a company, the people with no company get one
  from their work email's domain (never from gmail.com and the like), shown
  as the domain ("stripe.com"); the companies the file does give are kept.
  The companies the file names get their own sentence ("The most at Acme
  (6)") and the email ones another ("From email addresses: the most at
  ramp.com (7)"). Once company shortcuts exist the read-out no longer says
  the people cannot be grouped by employer. A file of names only says so in
  one sentence and offers Find.
- Ties are said as ties, never settled by the alphabet: two tied runners-up
  are both named ("80 consultants and advisors, 40 founders and CEOs and 40
  engineers"), three or more are "several groups of 40"; up to four tied
  are all named, more end "and 2 more"; tags tied at the cut are said as
  "36 each in 5 tags: …". A two-person company never leads; a group that
  holds everyone is said as "all of them" or not at all, and a one-person
  file reads "You know 1 person, at Stripe".

## Shortcuts and narrowing

Under the read-out sits a row of **shortcuts**: "Everyone 544" first, then at
most six chips built from the file, then "More" (twelve in all). Each one is
a set of people with its count in its label:

| Kind | Label | Offered when |
|---|---|---|
| tag | "107 tagged “prospect”" | tags are filled for 30% or more of the people and at least two tags are useful; the tag holds 5% to 80% of the people and at least 3 |
| role | "112 investors", "100 clinicians", "1 engineer" | the family holds 5% to 90% of the people; the catch-all families are never offered |
| company | "22 at Stripe" | 3 people and 2% of the file or more, counted across the whole file |
| industry | "57 in Software" | a real sector (never "Industry not known"), 10% to 60% of the people; "Venture capital" is skipped when an investors chip shows |
| place | "27 in Austin" | locations filled for 30% or more; the city holds 8% or more |
| recent | "79 connected in the last 12 months" | dates filled for half the file and 5 people or more; an export whose newest date is over 60 days old says "in the 12 months before this export" |
| senior | "180 senior leaders" | 10% to 60% of the file, and no tag already says "decision maker" |
| relationship | "through colleagues" / "direct" | firm-wide CRM contacts exist |

A shortcut always has at least three people and never everyone. Two
shortcuts that light 80% or more of the same people never both show: the
later one gives its place to the next candidate. The order follows the file:
tag-led files show tags, then companies, a place and a role; other files
show roles, companies, an industry, a place, the recent and the senior chip.
"More" holds one of each remaining kind before a second of any kind. A count
of one is singular everywhere.

**A shortcut switches.** Pressing one makes it the selection, replacing
whatever was selected; pressing it again, or "Everyone", goes back to
everyone. A shortcut's label and count never change and it is never greyed
out, so going from "at Stripe" to "at Google" is one click. A selection made
another way that holds exactly a shortcut's people (a group clicked on the
globe, an answer) shows that shortcut as pressed.

**Narrowing lives in the people list.** When the list holds more than one
person, a row "Narrow to" offers up to six other shortcuts that would make
it smaller, each with the count that would remain ("12 investors", "1
engineer"), largest first. Pressing one narrows the list (AND), up to three
parts; each part then shows as a small removable chip under the title, and
removing one widens the list again. "Narrow to" never offers zero or the
whole list.

**The ask box** sits under the shortcuts with a placeholder and three example
questions built from the file, each with its count ("Who do I know at
Stripe? 22", "Which clinicians do I know? 100", "Who do I know in Austin?
27"). They only use forms the rules answer, only values in the file, and
each returns exactly the people of the shortcut it came from.

## One selection, one number

Everything that picks people sets one selection: a shortcut (or a narrowed
list), Find in the people list (from two characters), an answer to a
question, or a click on a group, a company or a person. The selection lights
its people on the globe and fills the people list; it never rebuilds the
globe's layout (only "Arrange by", the source chips and "direct only" do).

A count shown for the same people is the same number everywhere: in the
read-out, on the shortcut, on the globe's group, in the list title and in a
typed answer. A test holds this on all six sample files.

## The people list

Beside the globe, always the people behind the current selection or, with
none, the people in the part of the globe in view.

- **Title**: what the list is and how many ("at Stripe · 22"; for an answer,
  what the question was read as, "In Austin · 27", or the question itself in
  quotes). A Clear control (and Escape, in the list or on the map) goes back
  to everyone.
- **Find**: a name, company or title, accents folded; it is a selection like
  any other.
- **Sort**: most senior, most recent (only when the listed people have
  connection dates), A to Z. A shortcut's own order is the default.
- **Groups in view**: with no selection, the groups inside the part of the
  globe in view, with their counts and colours, in the globe's own order
  (named groups largest first, "Other …" and "… not known" last). Clicking
  one flies there. On a phone they fold to one line that opens, so the list
  keeps most of the screen.
- **Rows**: name, title · company, a short role tag ("Investor", "Founder or
  CEO", "Clinician"; none for the catch-alls), a hollow mark for a firm-wide
  contact, "Checked" when a founder check exists, and a link to the person's
  profile when the file has one. A row opens in place and says in plain words
  why the person is listed ("Tagged “passed”", "Connected Mar 2025", where
  they are), with Company profile, Search company (a search of the company
  on the home page), Founder check and Intro paths.
- **Copy** (names with title and company, one per line) and **Download CSV**
  (the listed people, only the columns the file has, with a byte-order mark
  so spreadsheets read accents, named after the list:
  `network-investors.csv`). Both run in the browser on your own data; a
  failure says so.
- **A company selected** (by its shortcut or on the globe) adds Company
  profile and Intro paths for it. A company read from an email domain
  ("stripe.com") offers neither.
- Long lists show fifty people at a time.

## The globe

The globe serves the selection: you are the core, groups sit on the inner
shell, companies further out, people on the surface. A company is a burst,
one ray per person, the most senior people (founders, CEOs, partners,
chiefs) closest to its core and drawn darker (brighter in the dark theme);
the corner key says "darker dot = most senior". Firm-wide contacts are
hollow. Positions are computed once from your contacts (`buildAtlas`), with
no physics: the same contacts always give the same globe and nothing moves
by itself.

- **A selection** dims everyone else (more strongly the larger it is), turns
  the camera to the lit people, zooms in when they are a tight bunch and
  pulls back to the whole globe with one pulse when they are spread out; "22
  lit" sits in a corner. A file of under forty people fills the globe.
- **Click** a group's or a company's label or hub and it is selected and
  opened: the camera goes in far enough to show the layer inside and the
  breadcrumb names it. Dimmed labels stay clickable. A company selects
  everyone at it, across every group it sits in; a tag group selects
  everyone who carries the tag. A click on empty space clears the selection;
  a drag is never a click.
- **When a selection ends** (Clear, Everyone, Escape, a click on empty
  space, a shortcut switched off) and the camera is where the turn to that
  selection put it, it goes back: to the whole globe, or into the node you
  had opened. A globe you turned or zoomed yourself stays where you put it.
- **The opening view** names every first-layer group, "Other …" too. The
  named groups (up to nine) are placed well inside the side facing you and
  the camera is turned so each of them is on the near side, labelled at
  full strength; a crowded label moves under its cluster or beside its hub
  rather than being dropped.
- **Lit dots** at the whole-globe view have a core of about 4 px with a
  soft ring (smaller on the far side), so a scattered selection can be
  counted at a glance; zoomed into a cluster they are drawn small.
- **The breadcrumb** names only what you opened (a click, or a zoom or drag
  that brings a group to fill the view). A selection that turns the camera
  does not change it.
- **Drag** to spin, **scroll or pinch** to dive in. The page keeps
  scrolling when a scroll merely passes over the globe; the globe takes the
  wheel once the pointer rests on it or it has focus. Buttons top left: zoom
  in, zoom out, fit, full screen.
- Every colour the canvas paints comes from `THEMES` in
  `src/components/network/NetworkGraph.js` (light by default, dark ready).
  The draw loop stops when nothing moves, the globe is off screen or the tab
  is hidden.

## Arrange by

Under the globe: *By role*, *By company*, *By industry*, *By place*, *By
tag*. Only the arrangements that split this file are offered; the others
are hidden, not greyed out. An arrangement splits the file when it gives at
least two groups of 5% or more and none over 90% (By company: half the
people have a company, there are two companies or more, and none holds over
90%; By tag: the tags carry signal).

The map opens on *By tag* when the tags carry signal and most tagged people
have exactly one tag (a pipeline or a fundraising list), otherwise on *By
role*, otherwise on the first arrangement that splits the file. A file that
nothing splits (names only) shows its people by company, with no group layer.
A layer with a single group is skipped, so a fundraising list never opens as
one bubble. How each first layer is chosen:

- **By role**: the file's own role families, largest first, at most eight,
  with their short titles ("Investors", "Founders & CEOs", "Clinicians",
  "Researchers & academics"). Families past the eighth and any under 3% of
  the file fold into one last group, "Other roles", which opens onto them.
  The catch-alls ("Other senior leaders", "Other roles", "No title") only
  take a place of their own when fewer than three other families exist.
  Each family has one colour, the same on every file, in both themes and in
  the list's dots. Inside a family: its eight largest companies, then "Other
  companies".
- **By company**: the sixteen largest companies, largest first, the largest
  facing you; the rest share "Other companies", placed on the far side and
  listed last, then "No company listed". The ten largest carry their name
  and count at the whole-globe view.
- **By industry**: the industries read from the employers, largest first,
  then "Other industries", then "Industry not known" last. Inside each: the
  role families, then companies.
- **By place**: countries, or cities when one country holds over 60% of the
  located people or fewer than three countries appear (a US-only CRM is
  split by city); then "Other places" and "Place not known" last. Inside
  each: the role families, then companies.
- **By tag**: one group per tag, the person filed under their first tag;
  smaller tags share "Other tags", then "No tag". A tag group's count is
  everyone who carries the tag, the same number as its shortcut, and its
  line says how many of them sit under another tag on the map. A tag that a
  shortcut or the read-out names always has its own group, even when all
  its people sit under another tag ("customer; champion").

Every group has a line built from its people ("{n} people · most at
{company} ({k})"); a tie at the top names no company.

## How a file is read

All of it is rules in `src/utils/network/`, no model involved, and the same
rules serve the read-out, the shortcuts, the globe, the question engine and
the founder check's network link.

- **Roles** (`roles.js`): `classifyContact` reads the title and the company
  with ordered rules and returns the role, the four-way group the
  question engine and founder check still use (`ROLE_GROUPS`), the lenses,
  a reason and the **family**. `familyOf` gives the family entry: `one`,
  `many`, `title` (the globe and list label) and `tag` (the row label).
  Tags are never read as titles. A role given by the employer's name alone
  yields to a title that says otherwise: an engineer at "Cobalt Capital" is
  an engineer, a product manager at a hospital is not a clinician. Pension,
  endowment and family-office staff are allocators, counted with investors
  in the "Investors" family. Generic titles ("Partner", "Associate") only
  make an investor at a fund-like employer; anyone at a known law firm
  (Wachtell, Kirkland, Latham and the others the industry table files under
  Legal) is a lawyer, a partner included. "Vice President" leads a function
  and is not a top leader; "CEO Office" and "Office of the CEO" are staff,
  not the chief executive.
- **Seniority** (`atlas.js`, `seniority`): 0 runs the place (founder, CEO,
  chief, president, managing director or partner, partner of a firm), 1
  leads a function (VP, head, director, lead), 2 everyone else.
- **Industries** (`grouping.js`, `industryOf`): from the employer only,
  never from a job title, read first from the company key so every spelling
  of one employer gets one industry ("J.P. Morgan" and "JPMorgan Chase &
  Co." are Finance & banking, "Google Ventures" is GV, Venture capital). In
  order: a hospital or clinic, or a university's medicine or health arm
  ("University of Chicago Medicine" is Healthcare), a known-employer table (Google, Meta → Big Tech;
  Stripe, Ramp → Fintech; Sequoia, a16z → Venture capital; McKinsey, BCG →
  Consulting; universities → Education), an allocator, then the employer's
  own words ("Capital", "Health System", "University"). When the employer
  says nothing, the industry is not known.
- **Companies** (`parseContacts.js`, `normalizeCompanyKey`; `grouping.js`,
  `companyKeyFor`): legal tails, "& Co." and "& Company" and a bracketed short
  form are dropped, as are a trailing web suffix ("Amazon.com") and a
  trailing "Group" ("The Goldman Sachs Group, Inc." is Goldman Sachs), and
  known spellings merged ("McKinsey & Company" and "McKinsey"; "JP Morgan"
  and "J.P. Morgan Chase & Co."; Facebook as Meta; Twitter as X), but a
  parent and a subsidiary stay apart (Google is not Alphabet). The name
  shown is the spelling most people in the file use. Placeholders
  ("Self-employed", "Freelance", "Stealth" followed by any words,
  "Self-Employed Consultant", "Freelance Writer", "Retired", "N/A", "None",
  "Confidential", "Various", "-") are no company anywhere: not on a
  chip, in a sentence, in a question or on the globe. On the first company lookup for an
  account, the store checks each saved company key against its company and
  corrects any that differ.
- **Places** (`grouping.js`, `cityOf`, `countryOf`): LinkedIn's metro names
  resolve to the real city and country ("Greater Houston", "Dallas-Fort Worth
  Metroplex", "Bay Area" as San Francisco, "Brooklyn, NY" as New York). A
  US state after a US city is the United States ("Atlanta, Georgia"; "Tbilisi,
  Georgia" stays Georgia). "Remote", a one-part place that is neither a known
  city nor a country ("Hybrid", "EMEA", "Europe") and anything not
  recognised is "Place not known", never a country or a city.
- **Tags** (`grouping.js`, `tagsOf`, `tagProfile`): compared lower-cased and
  trimmed, shown in the file's commonest spelling. A value of more than four
  words or forty characters is a note and is not counted as a tag. Tags
  "carry signal" when 30% or more of the people have one and at least two
  tags are of a useful size.

## Ask your network

Deterministic matching over the people in view (`src/server/network/query.js`).
Every answer lights, counts, lists, copies and downloads everyone it found:
the reply carries `keys`, every match, uncapped, in rank order, beside the
first hundred rows with their reasons. Under the answer the page shows what
the question was read as ("At Stripe", "Investors", "Tagged “prospect”",
"In Austin", "Connected in 2024", "Not at Google") and any notes.

What a typed question understands:

- **Companies** of the file, however long, after at, from, to, of, on or
  alone ("Who do I know at Stripe?", "people from Goldman Sachs"). People who
  work there are the answer; similar names and title mentions are listed
  apart as *possibly related*. A company typed in full ("JPMorgan Chase") is
  that company only; its words are not read again as keywords. A person the
  file gives no company is found by their email's company ("at ramp.com" or
  "at Stripe" for stripe.com addresses), with the same count as the
  shortcut. A placeholder ("at Self-employed") lists nobody and says it is
  not a company.
- **Roles** in the page's words ("Which investors do I know?", "clinicians",
  "senior leaders") count exactly the role shortcut's people; narrower words
  (nurses, surgeons, heads of product, VPs, LPs, endowments) stay inside
  their family.
- **Tags** of the file ("prospects", "everyone tagged committed", a tag that
  is an everyday word such as "warm").
- **Industries** by the map's own labels ("people in Software", "Healthcare
  founders").
- **Places** found in the file, typed in any case ("Who do I know in
  Austin?", "in New York and Boston", "in the UK").
- **Dates**: "this year", "in 2024", "last year", "since 2025", "last
  month", quarters, "in the last 12 months", counted on your own calendar
  (the browser sends its date).
- **People** of the file by name.
- **Combinations**: different kinds join with AND ("prospects in New York",
  "senior people at Meta"); two tags joined by "and" are AND, by "or" OR.
- **Exclusions**: "not at Google", "excluding", "except", "outside" leave out
  that company, place or tag.
- **Lens words** still work in typed questions ("who can help me raise",
  "deal flow in fintech", "who can vet an AI company"). A company's own name
  never sets a lens: "Who do I know at Granite Family Office?" lists
  everyone there, not only its allocators. "Diligence" alone,
  when it would list most of the file, asks for a company or a field instead.
- Words the rules could not use are named in a note ("Not used: …") rather
  than dropped silently.

**Intro paths** (from a selected company or an opened row) send the company
as data, not as a question: your contacts at the company, then your contacts
at its investors (named in the company profile, from public sources), each
investor group with everyone there counted and lit, then a note that past
employees cannot be found (exports carry only the current company).

The model is asked only for a question you typed, only when the rules read
nothing at all from it, only when signed in, at most twenty times an hour,
and it receives only the question's text. The examples, Intro paths and links
from other pages never reach it, so no company name or tag from your file is
ever in a prompt. Signed out the model is not used. With no contacts the
answer is a plain "There are no contacts to search yet."

## In Open Research, company profiles and Founder Check

The same network answers "who can help with *this* company or founder":

- **Open Research**: after a search about a company, a *Your network and
  <company>* panel lists people you know there, plus experts and investors in
  your network whose title or company mentions the sector of the question.
- **Company profile** (`/company/<name>`): people at the company, people at
  its investors and competitors found in the profile, sector experts and
  sector investors.
- **Founder Check**: people at the founder's current company (reference
  calls, backchannel), at their past companies and profile companies, and
  sector experts.

These come from `POST /api/network/helpers` (`src/pages/api/network/helpers.js`)
and `src/server/founder/networkLink.js`, which read only the signed-in
user's saved contacts and use the same classification and company keys as
the map. Signed out, or with no import, the panel says so and links to the
Network Map.

## What never leaves the account

- Contacts are stored per account and only ever returned to that account.
- The read-out, the shortcuts, the globe, Find, Copy and Download CSV are
  worked out in your browser from your own data.
- Questions and intro paths run on the server over your saved contacts.
  Signed out, the browser sends only the people in view, with only the
  fields scoring needs (never email), for that one request; nothing is
  stored.
- No contact, and nothing taken from your file, is ever sent to a model.
  Only the text of a question you typed may be, as above.
- Intro paths look up the named company's investors in public sources; your
  contacts are not part of that lookup.
- *Remove all* deletes every imported contact.

## Implementation

| Piece | Where |
|---|---|
| Page (selection, ask, arrange) | `src/pages/network.js` |
| Source strip, read-out, shortcuts, people list, connectors | `src/components/network/{SourceStrip,AtAGlance,Shortcuts,PeoplePanel,Connectors}.js` |
| Globe renderer (one canvas: projection, camera, drawing, input) | `src/components/network/NetworkGraph.js` |
| Read-out, shortcuts, narrowing, examples, Copy and CSV | `src/utils/network/insights.js` |
| Layout (fixed tree of groups, bursts, seniority, group indexes) | `src/utils/network/atlas.js` |
| File parsing, company keys, placeholders, dedupe, limits | `src/utils/network/parseContacts.js` |
| Roles and families | `src/utils/network/roles.js` |
| Arrangements, industries, places, tags | `src/utils/network/grouping.js` |
| Industry vocabulary | `src/utils/network/sectors.js` |
| Question parsing, scoring, intro paths | `src/server/network/query.js` |
| Storage (Postgres / PGlite), company lookup | `src/server/network/store.js` |
| Routes | `src/pages/api/network/{contacts,query,helpers,attio,twitter}.js` |
| Cross-tab panel | `src/components/network/NetworkHelpers.js` |
| Tests | `tests/unit/features/network*.test.js`; sample networks of invented people in `tests/fixtures/network/` |
