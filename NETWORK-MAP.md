# Network Map

Your own contacts, drawn as a map and sorted by what they can do for a fund:
who can help you **raise**, who can help you **source** deals, and who can
help you **diligence** a company or founder. Nothing on the page is invented:
every person comes from a file you uploaded, every role comes from the title
and company in that file, and your contacts never leave the app.

## Getting your network in

**LinkedIn** does not give apps your connections, so the export is the only
way in: *Settings & Privacy → Data privacy → Get a copy of your data →
Connections*. LinkedIn emails a zip within minutes; drop `Connections.csv`
on the page (or click *Upload LinkedIn Connections.csv*). The export has
first name, last name, URL, company, position and the date you connected.
Email is usually blank (LinkedIn only includes it when the contact allowed it).

**Any CSV or XLSX** of contacts also works: a header row with a name column
(`Name`, or `First Name` + `Last Name`) and, ideally, `Company`, `Title`,
`Email`, `LinkedIn URL`, `Location` and `Tags`. Dates are parsed in US or
day-first order (detected per file). A new upload replaces the previous
import from that source; LinkedIn and CSV imports live side by side.

**X** sign-in identifies you; the accounts you follow are only available on
paid X API tiers, so the page offers an upload of an X following export
(JSON, X API format) under *Upload CSV/XLSX contacts*.

**Connect X** signs you in with your X profile and, where the API tier
allows, imports the accounts you follow; it is shown as "not available on
this deployment" when the keys are not set. There is no LinkedIn sign-in on
the page: LinkedIn's API only returns your own profile, so it would add
nothing to the map (the OAuth routes remain in the code base, unused).

**Connect Attio (the firm's CRM)** is shown as a placeholder ("Connect Attio · soon") until `NEXT_PUBLIC_ATTIO_ENABLED=true` is set; the import is built and tested. When enabled it imports the People object of an Attio
workspace with an API access token you paste in (Attio → Workspace settings
→ Developers). The token is used for that one request and never stored.
Every person is saved with a *relationship*:

- **direct**: Attio's *strongest connection user* for that person is you
  (matched by the email you sign in with);
- **firm**: anyone else's contact, saved with `via` = the colleague's name.

The map draws firm contacts as hollow dots, every list labels them *Firm ·
via <colleague>*, and the *my direct connections only* chip hides them, so a
colleague's relationship is never mistaken for your own. A token without the
"user management: read" scope cannot see workspace members; everything is
then saved as firm-wide and the page says so. The same person imported from
LinkedIn and Attio is merged once, and a direct connection anywhere wins.

Signed in, contacts are saved to your account (Postgres) and are there on
every device. Signed out, they stay in the browser tab and are gone when you
close it. Limits: 25 MB per file, 30,000 contacts per account, 14 MB per
import request.

## The map

The map is a globe you can spin, with your network inside it in layers:

- **You** are the core of the globe.
- **Groups** sit on the inner shell, **sub-groups** on the middle shell,
  **companies** on the outer shell and **people** on the surface. A branch
  runs outward from each node to the ones in the next layer, so the whole
  network reads as a burst from the centre.
- **A company is a burst**: one ray per person, in a spiral around the
  company's core. The most senior people (founders, CEOs, partners, chiefs)
  sit closest to the core and are drawn a little brighter, then heads of
  function, then everyone else (`seniority` in `src/utils/network/atlas.js`,
  read from the title). A company's size on the map is its headcount.
  Firm-wide CRM contacts are hollow.
- **Nothing moves by itself.** Positions are computed once from your
  contacts (`buildAtlas`), with no physics: the same contacts always give
  the same globe, clusters never overlap, and a branch is always where you
  left it. The camera only turns the globe and moves closer.

Getting around:

- **Drag** to spin the globe; let go while moving and it keeps turning and
  slows down. **Scroll or pinch** to dive in towards the cursor. The grid on
  the surface gets finer as you get closer. At rest and zoomed out, the globe
  drifts slightly (off when the system asks for reduced motion).
- **Click anything** and the globe turns it to face you and flies down to
  it. Click a company for the people you know there; click a person for
  their details. The branch from you to the selected node pulses.
- **What you see depends on how close you are**: from far away, groups,
  sub-groups and companies as sparks; closer, company names; closer still,
  each person as a dot with initials; closest, names and titles. Hover
  anything for its name at any distance.
- **Breadcrumb** (above the map): where you are, for example *All ›
  Founders & operators › Big Tech › Google*. It follows you as you spin and
  zoom by hand; click a step to fly back out to it.
- **Zoom to** (first bar under the map): what is inside the cluster you
  are looking at, largest first: the groups, then their sub-groups, then
  companies, then the people of one company. Click one to fly to it; the
  arrow at the start flies back out one level.
- **Presets** (second bar): *Whole network*, the three lenses (*Raise
  capital*, *Source deals*, *Diligence*, each filtering the globe to the
  people who fit), *Largest company*, and, when firm contacts exist, *My
  direct connections only*.
- **Buttons** (top left of the map): zoom in, zoom out, fit to view, full
  screen.
- **Find a person or company** lights up the matches, turns the globe to
  them and fades everything else.
- The first time the map appears, the globe swings in from the side and
  settles.

Groupings (the switch above the map):

- **By role** (default): *Investors & LPs* (top), *Founders & operators*
  (right), *Everyone else* (bottom) and *Experts & advisors* (left). Inside
  each: industries, then companies, then people.
- **By industry**: industries, then roles, then companies. **By country**:
  countries, then industries, then companies. **By company**: every company
  as its own burst around you. A layer that would not split a group is
  skipped.
- Industry is decided in three steps (`src/utils/network/grouping.js`): a
  known-employer table (Google, Meta, Amazon, Microsoft → Big Tech; OpenAI,
  Anthropic, Databricks → AI; Stripe, Ramp, Brex → Fintech; Goldman Sachs,
  Blackstone → Finance & banking; Sequoia, a16z, YC → Venture capital;
  McKinsey, BCG, Bain, the Big Four → Consulting; Figma, Notion, Snowflake →
  Software; universities → Education; and more), then decisive titles (MBA
  candidate, angel investor, consultant), then sector words in the title,
  company or tags. Up to twelve groups; the long tail folds into *Other* /
  *Unknown* (LinkedIn's export has no location, so those contacts sit under
  *Unknown* until a CSV adds one).

Code: `src/utils/network/atlas.js` (the fixed layout, tested in
`tests/unit/features/network.test.js`) and
`src/components/network/NetworkGraph.js` (the globe: projection, camera,
drawing and input, on one canvas with no graph library).

## Roles and lenses

`src/utils/network/roles.js` classifies each contact from title, company and
tags with ordered regex rules, no model involved. The role decides which
lenses the contact belongs to:

| Role | Examples | Group | Lenses |
|---|---|---|---|
| LP / allocator | family office, endowment, pension, fund of funds, CIO, wealth manager | Investors & LPs | raise |
| Investor | GP, partner/principal/associate *at a fund-like employer*, angel, scout | Investors & LPs | raise, source |
| Accelerator / platform | YC, Techstars, program directors | Founders & operators | source |
| Founder | founder, co-founder, CEO, owner, EIR, stealth | Founders & operators | source, diligence |
| Executive | CTO, COO, VP, head of, director, GM | Founders & operators | source, diligence |
| Operator | engineers, product, sales, marketing, ops, analysts | Founders & operators | diligence, source |
| Banker / M&A | investment banking, corp dev, equity research, bulge-bracket and boutique banks | Experts & advisors | source, diligence, raise |
| Lawyer | counsel, attorney, startup law firms | Experts & advisors | diligence, source |
| Accountant / finance | CPA, audit, controller, CFO, Big Four | Experts & advisors | diligence |
| Consultant / advisor | consultant, advisor, board member, strategy firms | Experts & advisors | diligence |
| Researcher / academic | professor, research scientist, PhD, universities and labs | Experts & advisors | diligence |
| Press / analyst | journalist, editor, industry analyst, Gartner/CB Insights | Experts & advisors | diligence, source |

Generic titles ("Partner", "Associate", "Analyst") only count as *Investor*
when the employer looks like a fund; otherwise later rules apply (a partner
at a law firm is a lawyer, at McKinsey a consultant). "Vice President" is an
executive, not a founder's "President". Contacts with neither a placing title
nor company are *Everyone else* and belong to no lens.

## Ask your network

Deterministic matching over your contacts (`src/server/network/query.js`);
only the question text may go to a model, never a contact:

- **Who do I know at Stripe?** People whose company matches (exact, "Stripe,
  Inc.", or a close variant); similar names and title mentions are listed
  separately as *possibly related*.
- **Find software engineers in my network / fintech people in London**:
  role, industry and location filters (`ROLE_GROUPS`, `KEYWORD_GROUPS` in
  `src/utils/network/sectors.js`, location aliases).
- **Who can help me raise a fund? / Which LPs do I know?**: the *raise*
  lens, LPs ranked before VCs and bankers.
- **Who sends me deal flow in fintech?**: the *source* lens, founders first,
  narrowed by the industry word.
- **Who can diligence an AI company? / Who can do reference checks?**: the
  *diligence* lens, operators and experts in that sector.
- **Intro paths to Stripe**: direct contacts, then your contacts at the
  company's investors (from the company profile, public sources), then a
  note that past-employee paths are not available (exports only carry the
  current company).

Rules parse the question first; a free model is asked to interpret it only
when the rules find nothing specific. Results show the role chip, the match
reasons, and highlight the people on the map.

## In Open Research, company profiles and Founder Check

The same network answers "who can help with *this* company or founder":

- **Open Research**: after a search about a company, a *Your network and
  <company>* panel lists people you know there, plus experts and investors in
  your network whose title or company mentions the sector of the question.
- **Company profile** (`/company/<name>`): people at the company, people at
  its investors and competitors found in the profile (intro paths and a view
  from the cap table), sector experts and sector investors.
- **Founder Check**: *Who can help diligence <name>*: people at the founder's
  current company (reference calls, backchannel), at their past companies and
  profile companies, and sector experts.

All of it comes from `POST /api/network/helpers` (`src/pages/api/network/helpers.js`),
which reads only the signed-in user's saved contacts. Signed out, or with no
import, the panel says so and links to the Network Map.

## Privacy

- Contacts are stored per account and only ever returned to that account.
- Ask your network, intro paths and the helper panels run on the server over
  your saved contacts; signed out, the browser sends only the fields scoring
  needs (never email) for that one request and nothing is stored.
- The AI model, when used, sees the question text only.
- *Remove all my network data* deletes every imported contact.

## Implementation

| Piece | Where |
|---|---|
| Page | `src/pages/network.js` |
| Globe renderer (one canvas: projection, camera, drawing, input) | `src/components/network/NetworkGraph.js` |
| Layout (fixed tree of clusters, bursts, seniority) | `src/utils/network/atlas.js` |
| File parsing (LinkedIn export, CSV/XLSX, X JSON), dedupe, limits | `src/utils/network/parseContacts.js` |
| Role and lens classification | `src/utils/network/roles.js` |
| Industry / country grouping | `src/utils/network/grouping.js` |
| Industry vocabulary | `src/utils/network/sectors.js` |
| Question parsing, scoring, intro paths | `src/server/network/query.js` |
| Storage (Postgres / PGlite), company lookup | `src/server/network/store.js` |
| APIs | `src/pages/api/network/{contacts,query,helpers,attio,twitter}.js` |
| Cross-tab panel | `src/components/network/NetworkHelpers.js` |
| Tests | `tests/unit/features/network*.test.js`, `tests/unit/NetworkPage.test.js` |
