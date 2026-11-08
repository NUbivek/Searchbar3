# Network Map

See who you know, ask questions about your network, and find warm intro
paths to companies you are evaluating.

## Getting your network in

LinkedIn's API does not give third-party apps a member's connections, so the
Network Map uses LinkedIn's own data export, which every member can download:

1. LinkedIn → **Settings & Privacy** → **Data privacy** → **Get a copy of your data**
2. Choose **Connections** (or the full archive) and request it
3. When LinkedIn emails you, download it and upload `Connections.csv` here

Also supported:
- **Any CSV or XLSX of contacts** (headers such as name, company, title,
  email, LinkedIn URL, location are mapped automatically)
- **X following**: connect X; the following list requires a paid X API tier,
  and the page says so when it is not available
- **LinkedIn sign-in**: shows who you are connected as (profile only)

Files are parsed in your browser. The "Upload LinkedIn Connections.csv"
button only accepts LinkedIn's export (First Name, Last Name, Connected On
columns); any other contacts file is refused with a pointer to the CSV/XLSX
button, so a stray upload can never overwrite the LinkedIn import. Dates in
spreadsheets keep their cell values; slash dates are read day-first when a
file contains a day over 12. The import notice reports rows skipped, duplicate
rows merged, and anything dropped at the 30,000 limit.

When you are signed in, contacts are saved to your account
(`network_contacts`, up to 30,000) so they persist and power Founder Check's
backchannel references; when signed out they stay in memory only. "Remove all
my network data" deletes them. A re-import of a source is staged under a
temporary key and swapped in with a single statement, so a failed upload
leaves the previous import untouched. The contacts API returns a compact shape
(empty fields omitted) and an import returns what was saved, so the page does
not download the whole network again.

## Features

- **Graph**: you at the center, company nodes sized by how many people you
  know there, people colored by source (LinkedIn blue, X black, CSV gray).
  Large networks (over 1,500 people) show companies first; click to expand.
  An expanded company draws at most 150 people (everyone is in its details
  list); person labels appear on zoom only in graphs under 300 nodes,
  otherwise for highlighted or selected people. Answers auto-expand the
  companies of the top matches except ones with more than 60 people.
- **Details panel**: name, position, company, connected-on date, profile link,
  and shortcuts to Company profile, Search, and Founder Check.
- **Ask your network**: "Who do I know at Google?", "Find software engineers
  in my network", "people in fintech", "anyone at Stripe or Brex", "who works
  in paris". Several companies in one question are all searched; lower-case
  places count as locations when one of your contacts is there. Company
  answers list people who work there; similar company names and title
  mentions ("ex-Stripe") go under "Possibly related". Each match lists why
  it matched, and matches are highlighted on the graph.
- **Warm intro paths**: "Intro paths to Stripe" returns contacts at the
  company and contacts at its investors (investors come from the company
  profile: VC portfolio listings and reported round leads).

Only first-degree connections exist in the exports, so there is no 2nd/3rd
degree filter. LinkedIn's export has no location column, so location
questions only match CSV/X contacts.

## Privacy

Contact data is never sent to an AI provider. When an AI model is configured,
only the question text may be sent to interpret it (the page says so next to
the Ask box); matching runs on the server against your own contacts. Signed
out, the browser sends only the fields scoring uses (name, company, title,
location, tags, profile URL, date, source) plus an identity key, never email.
LinkedIn/X sign-in buttons are hidden when the server has no credentials
(`configured` in `/api/auth/*/token`), and OAuth redirects carry short error
codes that the page maps to user copy; the OAuth routes log only one line on
failure.

## Implementation

| Part | File |
|---|---|
| Parsing (LinkedIn CSV, generic CSV/XLSX, X) | `src/utils/network/parseContacts.js` |
| Graph data | `src/utils/network/graph.js`, `src/components/network/NetworkGraph.js` |
| Storage | `src/server/network/store.js` (`findContactsAtCompanies` used by Founder Check) |
| Questions and intro paths | `src/server/network/query.js`, `/api/network/query` |
| Contacts API | `/api/network/contacts` (GET, POST, DELETE; signed in) |
| Page | `src/pages/network.js` |

Tests: `tests/unit/features/network.test.js`.
