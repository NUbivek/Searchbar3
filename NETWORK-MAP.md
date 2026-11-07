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

Files are parsed in your browser. When you are signed in, contacts are saved
to your account (`network_contacts`, up to 30,000) so they persist and power
Founder Check's backchannel references; when signed out they stay in memory
only. "Remove all my network data" deletes them.

## Features

- **Graph**: you at the center, company nodes sized by how many people you
  know there, people colored by source (LinkedIn blue, X black, CSV gray).
  Large networks (over 1,500 people) show companies first; click to expand.
- **Details panel**: name, position, company, connected-on date, profile link,
  and shortcuts to Company profile, Search, and Founder Check.
- **Ask your network**: "Who do I know at Google?", "Find software engineers
  in my network", "people in fintech". Each match lists why it matched, and
  matches are highlighted on the graph.
- **Warm intro paths**: "Intro paths to Stripe" returns contacts at the
  company and contacts at its investors (investors come from the company
  profile: VC portfolio listings and reported round leads).

Only first-degree connections exist in the exports, so there is no 2nd/3rd
degree filter. LinkedIn's export has no location column, so location
questions only match CSV/X contacts.

## Privacy

Contact data is never sent to an AI provider. When an AI model is configured,
only the question text may be sent to interpret it; matching runs on the
server against your own contacts.

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
