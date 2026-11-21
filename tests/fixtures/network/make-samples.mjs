// Writes invented sample networks for tests and for looking at the Network Map by hand.
// Every person and most companies are made up; well-known employers are used only as employer names.
//   node tests/fixtures/network/make-samples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const FIRST = ['Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Quinn', 'Rowan', 'Emerson', 'Finley', 'Harper', 'Kendall', 'Logan', 'Marlow', 'Nico', 'Oakley', 'Parker', 'Reese', 'Sage', 'Tatum', 'Wren', 'Arden', 'Blair', 'Corin', 'Dale', 'Ellis', 'Flynn', 'Gray', 'Hollis', 'Indra', 'Jules', 'Kai', 'Lane', 'Milan', 'Noor', 'Orion', 'Perry', 'Remy', 'Sloan', 'Teagan', 'Uma', 'Vesper', 'Wyatt', 'Xan', 'Yael', 'Zuri', 'Amara', 'Bodhi', 'Celine', 'Dario', 'Elio', 'Farah', 'Gideon', 'Hana', 'Ivo', 'Junia', 'Kofi', 'Leila', 'Mateo', 'Nadia', 'Omar'];
const LAST = ['Ashdown', 'Bellweather', 'Calloway', 'Dunmore', 'Everhart', 'Fairbanks', 'Greystone', 'Halloran', 'Ironwood', 'Jesperson', 'Kingsolver', 'Larkspur', 'Merriweather', 'Northcott', 'Oakhurst', 'Pemberton', 'Quillfeather', 'Ravenscroft', 'Silverton', 'Thistlewood', 'Underhill', 'Vanterpool', 'Whitlock', 'Yarborough', 'Zeller', 'Abernathy', 'Blackwood', 'Castellan', 'Draycott', 'Eastgate', 'Foxworth', 'Glenmore', 'Hawksley', 'Inglewood', 'Joslin', 'Kettering', 'Lockridge', 'Marchetti', 'Nettleton', 'Orsini', 'Pallister', 'Quennell', 'Rosewarne', 'Stannard', 'Trevelyan'];
const TAIL_A = ['Northwind', 'Acme', 'Bluebird', 'Cobalt', 'Driftwood', 'Ember', 'Fathom', 'Granite', 'Harbor', 'Juniper', 'Kestrel', 'Lumen', 'Meridian', 'Nimbus', 'Orchard', 'Pioneer', 'Quarry', 'Ridgeline', 'Sundial', 'Tidewater', 'Umbra', 'Vantage', 'Willow', 'Zephyr', 'Alder', 'Briar', 'Cinder', 'Dovetail'];
const T = {
  tech: ['Software Engineer', 'Senior Software Engineer', 'Staff Engineer', 'Product Manager', 'Senior Product Manager', 'Engineering Manager', 'VP of Engineering', 'Head of Product', 'Director of Engineering', 'Data Scientist', 'Chief Technology Officer', 'Co-Founder & CEO', 'Founder', 'Account Executive', 'Head of Sales', 'Product Designer'],
  fin: ['Product Manager', 'Head of Risk', 'Software Engineer', 'VP Finance', 'Chief of Staff', 'Co-Founder', 'Head of Partnerships', 'Account Executive'],
  bank: ['Analyst, Investment Banking', 'Associate, Investment Banking', 'Vice President, M&A', 'Managing Director'],
  cons: ['Consultant', 'Engagement Manager', 'Associate Partner', 'Partner'],
  vc: ['Partner', 'Principal', 'Associate', 'General Partner', 'Venture Partner', 'Investor', 'Managing Partner'],
  acad: ['Professor of Computer Science', 'PhD Candidate', 'MBA Candidate', 'Research Scientist', 'Lecturer', 'Postdoctoral Fellow'],
  accel: ['Group Partner', 'Program Director', 'Visiting Partner'],
  law: ['Partner', 'Associate Attorney', 'Counsel'],
  acct: ['Senior Manager, Audit', 'Partner, Tax', 'CPA'],
  lp: ['Chief Investment Officer', 'Director of Private Equity', 'Investment Officer', 'Managing Director, Private Markets', 'Head of Venture Investments'],
  fo: ['Principal, Family Office', 'Chief Investment Officer', 'Investment Director'],
  health: ['Co-Founder & CEO', 'Chief Medical Officer', 'VP Clinical Operations', 'Product Manager', 'Head of Growth', 'Registered Nurse', 'Physician', 'Surgeon'],
  hosp: ['Physician', 'Cardiologist', 'Chief of Surgery', 'Nurse Practitioner', 'Hospital Administrator', 'Resident Physician'],
  bio: ['Research Scientist', 'Principal Scientist', 'VP Research', 'Chief Scientific Officer', 'Founder & CEO', 'Clinical Trial Manager'],
  energy: ['Founder', 'VP Operations', 'Project Engineer'],
  ops: ['COO', 'Operations Manager', 'Founder & CEO'],
  media: ['Creative Director', 'Founder', 'Producer'],
  retail: ['Head of Procurement', 'VP Merchandising', 'Store Operations Director', 'Chief Marketing Officer', 'Buyer', 'E-commerce Manager', 'Chief Executive Officer', 'IT Director'],
  sales: ['Account Executive', 'Enterprise Account Executive', 'Sales Development Representative', 'VP Sales', 'Head of Revenue Operations', 'Customer Success Manager', 'Regional Sales Director'],
  gov: ['Policy Advisor', 'Program Manager', 'Deputy Director'],
};
const TAIL_B = [['Labs', 'tech'], ['Robotics', 'tech'], ['Health', 'health'], ['Capital', 'vc'], ['Ventures', 'vc'], ['Analytics', 'tech'], ['Bio', 'bio'], ['Energy', 'energy'], ['Payments', 'fin'], ['Security', 'tech'], ['Partners', 'vc'], ['AI', 'tech'], ['Logistics', 'ops'], ['Studios', 'media']];
const CITIES = ['San Francisco, CA', 'New York, NY', 'London, United Kingdom', 'Boston, MA', 'Austin, TX', 'Toronto, Canada', 'Berlin, Germany', 'Singapore', 'Chicago, IL', 'Seattle, WA', 'Paris, France', 'Sydney, Australia'];

function maker(start) {
  seed = start;
  const used = new Set();
  const rows = [];
  const person = () => { let n; do { n = `${pick(FIRST)} ${pick(LAST)}`; } while (used.has(n)); used.add(n); return n.split(' '); };
  const date = (from = 2012, span = 15) => `${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')} ${pick(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])} ${from + Math.floor(rnd() * span)}`;
  return { rows, person, date, tail: () => { const [s, k] = pick(TAIL_B); return [`${pick(TAIL_A)} ${s}`, k]; } };
}
const csv = (header, rows) => [header, ...rows].map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';
const LI = ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On'];
const linkedIn = (m, company, kind, recent = false) => { const [f, l] = m.person(); m.rows.push([f, l, `https://www.linkedin.com/in/${f}-${l}-${m.rows.length}`.toLowerCase(), '', company, pick(T[kind]), recent ? m.date(2026, 1) : m.date()]); };
const out = {};

// 1. A venture investor's LinkedIn export: funds, founders, LPs, bankers, lawyers, operators at well-known employers.
{ const m = maker(11);
  for (const [c, n, k] of [['Stripe', 22, 'fin'], ['Google', 19, 'tech'], ['Goldman Sachs', 12, 'bank'], ['Meta', 11, 'tech'], ['McKinsey & Company', 10, 'cons'], ['OpenAI', 9, 'tech'], ['Sequoia Capital', 9, 'vc'], ['Ramp', 8, 'fin'], ['Stanford University', 8, 'acad'], ['Andreessen Horowitz', 7, 'vc'], ['Morgan Stanley', 7, 'bank'], ['Anthropic', 6, 'tech'], ['Harvard Business School', 6, 'acad'], ['Deloitte', 6, 'acct'], ['Databricks', 6, 'tech'], ['Y Combinator', 5, 'accel'], ['Kirkland & Ellis', 5, 'law'], ['Plaid', 5, 'fin'], ['Yale Investments Office', 3, 'lp'], ['CalPERS', 3, 'lp'], ['Hawthorne Family Office', 3, 'fo']]) for (let i = 0; i < n; i += 1) linkedIn(m, c, k, i === 0);
  for (let i = 0; i < 360; i += 1) { const [c, k] = m.tail(); linkedIn(m, c, k, i % 12 === 0); }
  for (let i = 0; i < 14; i += 1) linkedIn(m, '', 'tech');
  out['vc-investor-linkedin.csv'] = csv(LI, m.rows); }

// 2. A startup founder's LinkedIn export: mostly engineers and product people, a few investors.
{ const m = maker(22);
  for (const [c, n, k] of [['Google', 41, 'tech'], ['Meta', 28, 'tech'], ['Amazon', 24, 'tech'], ['Microsoft', 19, 'tech'], ['Stripe', 14, 'fin'], ['Airbnb', 12, 'tech'], ['Databricks', 9, 'tech'], ['Carnegie Mellon University', 9, 'acad'], ['Sequoia Capital', 2, 'vc'], ['Y Combinator', 3, 'accel']]) for (let i = 0; i < n; i += 1) linkedIn(m, c, k, i < 2);
  for (let i = 0; i < 290; i += 1) { const [c] = m.tail(); linkedIn(m, c, 'tech', i % 9 === 0); }
  out['founder-operator-linkedin.csv'] = csv(LI, m.rows); }

// 3. A sales team's CRM export: accounts in retail and healthcare, with locations and tags.
{ const m = maker(33);
  const head = ['Name', 'Company', 'Title', 'Email', 'Location', 'Tags'];
  const tags = ['customer', 'prospect', 'prospect', 'partner', 'churned', 'champion', 'decision maker'];
  const accounts = [['Marlowe Department Stores', 18, 'retail'], ['Greenfield Grocers', 14, 'retail'], ['Northgate Pharmacy Group', 12, 'retail'], ['Summit Outdoor Co', 9, 'retail'], ['Bayview Health System', 16, 'hosp'], ['Lakeside Medical Group', 11, 'hosp'], ['Hartwell Home Goods', 8, 'retail']];
  const row = (c, k) => { const [f, l] = m.person(); const t = [...new Set([pick(tags), rnd() < 0.3 ? pick(tags) : null].filter(Boolean))].join('; '); m.rows.push([`${f} ${l}`, c, pick(T[k]), `${f}.${l}@example.org`.toLowerCase(), pick(CITIES.slice(0, 6)), t]); };
  for (const [c, n, k] of accounts) for (let i = 0; i < n; i += 1) row(c, k);
  for (let i = 0; i < 210; i += 1) row(`${pick(TAIL_A)} ${pick(['Stores', 'Markets', 'Outfitters', 'Pharmacy', 'Clinic', 'Supply Co'])}`, rnd() < 0.7 ? 'retail' : 'hosp');
  for (let i = 0; i < 30; i += 1) row(`${pick(TAIL_A)} Software`, 'sales');
  out['sales-crm.csv'] = csv(head, m.rows); }

// 4. A clinician-researcher's contacts: hospitals, universities, biotech, with locations.
{ const m = maker(44);
  const head = ['First Name', 'Last Name', 'Company', 'Title', 'Location'];
  const row = (c, k) => { const [f, l] = m.person(); m.rows.push([f, l, c, pick(T[k]), pick(CITIES)]); };
  for (const [c, n, k] of [['Massachusetts General Hospital', 22, 'hosp'], ['Johns Hopkins University', 17, 'acad'], ['Mayo Clinic', 14, 'hosp'], ['Stanford University', 12, 'acad'], ['Moderna', 9, 'bio'], ['Genentech', 8, 'bio'], ['National Institutes of Health', 7, 'gov']]) for (let i = 0; i < n; i += 1) row(c, k);
  for (let i = 0; i < 150; i += 1) row(`${pick(TAIL_A)} ${pick(['Bio', 'Therapeutics', 'Medical Center', 'Health', 'University Hospital'])}`, pick(['bio', 'hosp', 'health']));
  out['healthcare-academic.csv'] = csv(head, m.rows); }

// 5. A fundraising list: LPs and family offices with tags and locations.
{ const m = maker(55);
  const head = ['Name', 'Company', 'Title', 'Location', 'Tags'];
  const tags = ['warm', 'cold', 'met 2026', 'committed', 'passed', 'follow up'];
  const row = (c, k) => { const [f, l] = m.person(); m.rows.push([`${f} ${l}`, c, pick(T[k]), pick(CITIES), pick(tags)]); };
  for (const [c, n, k] of [['Yale Investments Office', 4, 'lp'], ['CalPERS', 5, 'lp'], ['Ontario Teachers Pension Plan', 4, 'lp'], ['Hawthorne Family Office', 3, 'fo'], ['Kestrel Family Office', 3, 'fo']]) for (let i = 0; i < n; i += 1) row(c, k);
  for (let i = 0; i < 70; i += 1) row(`${pick(TAIL_A)} ${pick(['Family Office', 'Endowment', 'Pension Fund', 'Foundation', 'Fund of Funds', 'Wealth Management'])}`, rnd() < 0.5 ? 'lp' : 'fo');
  for (let i = 0; i < 25; i += 1) row(`${pick(TAIL_A)} Capital`, 'vc');
  out['lp-fundraising-list.csv'] = csv(head, m.rows); }

// 6. A small network: twenty-two people.
{ const m = maker(66);
  for (const [c, n, k] of [['Bluebird Labs', 6, 'tech'], ['Harbor Capital', 3, 'vc'], ['Google', 2, 'tech']]) for (let i = 0; i < n; i += 1) linkedIn(m, c, k, i === 0);
  for (let i = 0; i < 11; i += 1) { const [c, k] = m.tail(); linkedIn(m, c, k); }
  out['small-network-linkedin.csv'] = csv(LI, m.rows); }

for (const [name, text] of Object.entries(out)) { fs.writeFileSync(path.join(dir, name), text); console.log(name, text.trim().split('\n').length - 1, 'people'); }
