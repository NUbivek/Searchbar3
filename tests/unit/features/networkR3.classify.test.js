/**
 * Round 3, the classifier's side (eval/network/design-2026-11-21/ROUND2.md R2
 * and R8 decisions 1 to 6, review findings in
 * eval/network/review-2026-11-21/findings.json). Each block names the
 * finding it reproduces. Invented people only.
 */
const fs = require('fs');
const path = require('path');
const {
  parseLinkedInConnectionsCsv, parseGenericCsv, isLinkedInConnectionsCsv, normalizeCompanyKey, isPlaceholderCompany, mapHeaders,
} = require('../../../src/utils/network/parseContacts');
const {
  classifyContact, familyOf, FAMILIES, ROLE_GROUPS, EXPERT_ROLES, isExpert, lensShare,
} = require('../../../src/utils/network/roles');
const {
  industryOf, isSector, cityOf, countryOf, tagsOf, tagProfile, bucketsFor, usefulGroupings, defaultGrouping, groupKeyFor,
  companyKeyFor, companyLabelFor, companyFromEmail, OTHER_INDUSTRY, OTHER_ROLES, UNKNOWN_COUNTRY,
} = require('../../../src/utils/network/grouping');

const DIR = path.join(__dirname, '../../fixtures/network');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.csv')).sort();
const load = (f) => {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  return (isLinkedInConnectionsCsv(text) ? parseLinkedInConnectionsCsv(text) : parseGenericCsv(text)).contacts;
};
const SAMPLES = Object.fromEntries(FILES.map((f) => [f, load(f)]));
const c = (name, position, company, extra = {}) => ({ name, position, company, ...extra });
const tally = (list, fn) => {
  const m = {};
  for (const x of list) { const k = fn(x); m[k] = (m[k] || 0) + 1; }
  return m;
};

// ------------------------------------------------------------ R2: families

describe('R2: role families carry a globe title and a row tag', () => {
  test('every family has the title and tag ROUND2 lists, and familyOf returns the entry', () => {
    const titles = FAMILIES.map((f) => f.title);
    expect(titles).toEqual(['Investors', 'Founders & CEOs', 'Engineers', 'Product & design', 'Data & analytics', 'Sales & marketing', 'Operations', 'Finance',
      'Recruiting & HR', 'Clinicians', 'Researchers & academics', 'Bankers', 'Lawyers', 'Consultants & advisors', 'Partners at firms', 'Accelerators',
      'Public sector', 'Journalists & analysts', 'Students', 'Other senior leaders', 'Other roles', 'No title']);
    expect(FAMILIES.map((f) => f.tag)).toEqual(['Investor', 'Founder or CEO', 'Engineer', 'Product & design', 'Data', 'Sales & marketing', 'Operations', 'Finance',
      'Recruiting & HR', 'Clinician', 'Researcher', 'Banker', 'Lawyer', 'Consultant', 'Partner', 'Accelerator', 'Public sector', 'Journalist', 'Student',
      'Senior leader', '', '']);
    expect(FAMILIES.filter((f) => f.catchAll).map((f) => f.key)).toEqual(['leaders', 'others', 'unknown']);
    expect(familyOf(c('A', 'Cardiologist', 'Mayo Clinic'))).toEqual({ key: 'clinicians', one: 'clinician', many: 'clinicians', title: 'Clinicians', tag: 'Clinician', catchAll: false });
    // The old four groups stay exported for the question engine and the founder check.
    expect(ROLE_GROUPS.map((g) => g.label)).toContain('Experts & advisors');
  });

  test('By role on the healthcare sample shows its own families, largest first, small ones folded into "Other roles"', () => {
    const b = bucketsFor(SAMPLES['healthcare-academic.csv'], 'role');
    expect(b.map((x) => [x.label, x.contacts.length])).toEqual([
      ['Clinicians', 100], ['Researchers & academics', 64], ['Operations', 35], ['Sales & marketing', 12], ['Founders & CEOs', 9], ['Product & design', 9], ['Other roles', 10],
    ]);
    const other = b[b.length - 1];
    expect(other).toMatchObject({ key: OTHER_ROLES, last: true });
    // Under 3% of 239 (7.17): students 6, other senior leaders 3, public sector 1.
    expect(other.buckets.map((x) => [x.label, x.contacts.length])).toEqual([['Students', 6], ['Other senior leaders', 3], ['Public sector', 1]]);
    // None of the four old names.
    const labels = b.map((x) => x.label);
    for (const g of ROLE_GROUPS) expect(labels).not.toContain(g.label);
  });

  test('at most eight families; the rest share "Other roles", which opens onto them', () => {
    const b = bucketsFor(SAMPLES['vc-investor-linkedin.csv'], 'role');
    expect(b).toHaveLength(9);
    expect(b.slice(0, 8).map((x) => x.label)).toEqual(['Investors', 'Engineers', 'Founders & CEOs', 'Product & design', 'Sales & marketing', 'Operations', 'Researchers & academics', 'Bankers']);
    expect(b[8]).toMatchObject({ key: OTHER_ROLES, label: 'Other roles', last: true });
    expect(b[8].contacts.length).toBe(b[8].buckets.reduce((s, x) => s + x.contacts.length, 0));
    expect(b.reduce((s, x) => s + x.contacts.length, 0)).toBe(544);
    expect(b[8].hint).toBe('Data & analytics 18 · Finance 15 · Consultants & advisors 10 · Clinicians 8 · …');
  });

  test('catch-all families only get a place when fewer than three other families do', () => {
    const list = [
      ...Array.from({ length: 10 }, (_, i) => c(`E${i}`, 'Software Engineer', 'Acme')),
      ...Array.from({ length: 6 }, (_, i) => c(`L${i}`, 'Deputy Director', 'Acme')),
      ...Array.from({ length: 4 }, (_, i) => c(`U${i}`, '', '')),
    ];
    const b = bucketsFor(list, 'role');
    expect(b.map((x) => [x.key, x.contacts.length, !!x.last])).toEqual([['engineers', 10, false], ['leaders', 6, true], ['unknown', 4, true]]);
    // With three real families, the catch-alls fold into "Other roles".
    const more = [...list, ...Array.from({ length: 5 }, (_, i) => c(`S${i}`, 'Account Executive', 'Acme')), ...Array.from({ length: 5 }, (_, i) => c(`P${i}`, 'Product Manager', 'Acme'))];
    expect(bucketsFor(more, 'role').map((x) => x.key)).toEqual(['engineers', 'product', 'sales', OTHER_ROLES]);
  });

  test('"family" is the same layer, for By industry and By place; groupKeyFor reads the family', () => {
    const list = SAMPLES['sales-crm.csv'];
    expect(bucketsFor(list, 'family').map((x) => x.key)).toEqual(bucketsFor(list, 'role').map((x) => x.key));
    expect(groupKeyFor(c('A', 'Cardiologist', 'Bayview Health System'), 'role')).toBe('clinicians');
    expect(groupKeyFor(c('A', 'Cardiologist', 'Bayview Health System'), 'family')).toBe('clinicians');
  });

  test('usefulGroupings decides By role on families; the LP list (all investors) is not offered By role', () => {
    expect(usefulGroupings(SAMPLES['lp-fundraising-list.csv']).map((g) => g.key)).not.toContain('role');
    expect(usefulGroupings(SAMPLES['healthcare-academic.csv']).map((g) => g.key)).toContain('role');
  });
});

// ------------------------------------------------------------ R8.1: industry from the employer

describe('R8.1 industry comes from the employer, never the title (value-5, data-6, data-7, data-1, data-14)', () => {
  test('value-5: 3,000 software engineers at plain-named companies are not "in Software"; students are not "in Education"', () => {
    const cos = ['Acme Corp', 'Contoso', 'Initech', 'Globex', 'Umbrella', 'Hooli', 'Vandelay', 'Wonka', 'Stark', 'Wayne', 'Tyrell'];
    const big = Array.from({ length: 3000 }, (_, i) => c(`P${i}`, 'Software Engineer', cos[i % cos.length]));
    expect(big.every((p) => industryOf(p) === OTHER_INDUSTRY)).toBe(true);
    expect(usefulGroupings(big).map((g) => g.key)).not.toContain('industry');
    const conf = Array.from({ length: 50 }, (_, i) => c(`S${i}`, 'Student', `Company ${i}`));
    expect(conf.every((p) => industryOf(p) === OTHER_INDUSTRY)).toBe(true);
  });

  test('data-6: a CFO or a VP Finance at an unknown company is not Fintech; one company is one industry', () => {
    expect(industryOf(c('A', 'Chief Financial Officer', 'Acme Corp'))).toBe(OTHER_INDUSTRY);
    expect(industryOf(c('B', 'VP Finance', 'Northwind'))).toBe(OTHER_INDUSTRY);
    expect(industryOf(c('C', 'Head of Security', 'Northwind'))).toBe(OTHER_INDUSTRY);
    expect(industryOf(c('D', 'Software Engineer', 'Pioneer Robotics'))).toBe(industryOf(c('E', 'VP of Engineering', 'Zephyr Robotics')));
    for (const f of FILES) {
      const byCompany = new Map();
      for (const p of SAMPLES[f]) {
        const k = companyKeyFor(p);
        if (!k) continue;
        if (!byCompany.has(k)) byCompany.set(k, new Set());
        byCompany.get(k).add(industryOf(p));
      }
      const split = [...byCompany].filter(([, s]) => s.size > 1).map(([k]) => k);
      expect([f, split]).toEqual([f, []]);
    }
  });

  test('data-7: investors at "X Partners" are Venture capital; a partner at a known law firm is Legal', () => {
    expect(industryOf(c('A', 'Associate', 'Acme Partners'))).toBe('Venture capital');
    expect(industryOf(c('B', 'Partner', 'Juniper Partners'))).toBe('Venture capital');
    expect(industryOf(c('C', 'Partner', 'Kirkland & Ellis'))).toBe('Legal');
    expect(industryOf(c('D', 'Investor', 'Orchard Group'))).toBe('Venture capital');
    // VC sample: every investor sits in an investment industry (was VC 86, Investing 13, AM 9, F&O 4).
    expect(tally(SAMPLES['vc-investor-linkedin.csv'].filter((p) => familyOf(p).key === 'investors'), industryOf)).toEqual({ 'Venture capital': 103, 'Asset management': 9 });
  });

  test('data-1: a university hospital is Healthcare; the healthcare sample\'s Education is only its universities', () => {
    expect(industryOf(c('A', 'Resident Physician', 'Acme University Hospital'))).toBe('Healthcare');
    expect(industryOf(c('B', 'Registered Nurse', 'Cinder University Hospital'))).toBe('Healthcare');
    expect(industryOf(c('C', 'Professor', 'Stanford University'))).toBe('Education');
    const list = SAMPLES['healthcare-academic.csv'];
    const edu = list.filter((p) => industryOf(p) === 'Education');
    expect(edu.length).toBe(29);
    expect(edu.every((p) => /University$/.test(p.company))).toBe(true);
    expect(tally(list, industryOf)).toEqual({ Healthcare: 147, Biotech: 63, Education: 29 });
  });

  test('data-14: foundation allocators are Asset management; the LP list has no nonprofit bubble', () => {
    expect(industryOf(c('A', 'Investment Officer', 'Driftwood Foundation'))).toBe('Asset management');
    expect(industryOf(c('B', 'Director of Private Equity', 'Granite Foundation'))).toBe('Asset management');
    expect(industryOf(c('C', 'Program Officer', 'Granite Foundation'))).toBe('Government & nonprofit');
    expect(tally(SAMPLES['lp-fundraising-list.csv'], industryOf)).toEqual({ 'Asset management': 89, 'Venture capital': 25 });
  });

  test('unknown industry is one last group "Industry not known", never a sector', () => {
    const b = bucketsFor(SAMPLES['vc-investor-linkedin.csv'], 'industry');
    const last = b[b.length - 1];
    expect(last).toMatchObject({ key: OTHER_INDUSTRY, label: 'Industry not known', last: true });
    expect(last.contacts.every((p) => !String(p.company || '').trim())).toBe(true);
    // 17 known industries and the unknown: past sixteen groups the smallest
    // known ones share "Other industries", kept apart from "not known".
    expect(b).toHaveLength(16);
    expect(b[14]).toMatchObject({ label: 'Other industries', last: true });
    expect(b[14].buckets.map((x) => x.key)).toEqual(['Asset management', 'Legal']);
    expect(b.slice(0, 14).every((x) => !x.last && isSector(x.key))).toBe(true);
    expect(isSector(OTHER_INDUSTRY)).toBe(false);
  });
});

// ------------------------------------------------------------ R8.2 / R8.3: companies

describe('R8.2 placeholder employers are not companies (data-2)', () => {
  test('self-employed, stealth, retired, n/a and friends have no company key', () => {
    for (const name of ['Self-employed', 'Self Employed', 'Freelance', 'Freelancer', 'Independent', 'Independent Consultant', 'Stealth', 'Stealth Startup',
      'Stealth Mode', 'Stealth Mode Startup', 'Retired', 'Unemployed', 'Student', 'N/A', 'NA', 'None', 'Confidential', 'Various', '-', '—']) {
      expect([name, isPlaceholderCompany(name)]).toEqual([name, true]);
      expect([name, companyKeyFor(c('A', 'Founder', name))]).toEqual([name, '']);
      expect([name, industryOf(c('A', 'Founder', name))]).toEqual([name, OTHER_INDUSTRY]);
    }
    for (const name of ['Independent Bank', 'Stripe', 'Stealthwatch', 'Student Loan Hero']) expect([name, isPlaceholderCompany(name)]).toEqual([name, false]);
  });

  test('a file where most people are self-employed is not offered By company', () => {
    const list = [...Array.from({ length: 12 }, (_, i) => c(`A${i}`, 'Designer', 'Self-employed')), ...Array.from({ length: 8 }, (_, i) => c(`B${i}`, 'Founder', 'Stealth Startup')),
      ...Array.from({ length: 6 }, (_, i) => c(`C${i}`, 'Engineer', `Co ${i}`))];
    expect(usefulGroupings(list).map((g) => g.key)).not.toContain('company');
  });
});

describe('R8.3 company spellings merge; different companies do not (data-3, data-m2)', () => {
  test('legal tails, "& Co." and "& Company" and known renames give one key', () => {
    const same = [
      ['McKinsey', 'McKinsey & Co.', 'McKinsey & Company', 'McKinsey and Company'],
      ['JPMorgan', 'JP Morgan', 'J.P. Morgan', 'JPMorgan Chase & Co.', 'J.P. Morgan Chase & Co.'],
      ['Meta', 'Meta Platforms, Inc.', 'Facebook'],
      ['Goldman Sachs', 'Goldman Sachs & Co. LLC'],
      ['AWS', 'Amazon Web Services', 'Amazon Web Services (AWS)'],
      ['Bain & Company', 'Bain'],
    ];
    for (const group of same) expect(new Set(group.map(normalizeCompanyKey)).size).toBe(1);
    expect(normalizeCompanyKey('JPMorgan Chase & Co.')).toBe('jpmorgan');
    expect(normalizeCompanyKey('McKinsey & Co.')).toBe('mckinsey');
    // A parent and its subsidiary stay apart.
    expect(normalizeCompanyKey('Alphabet Inc.')).not.toBe(normalizeCompanyKey('Google'));
    expect(normalizeCompanyKey('Amazon')).not.toBe(normalizeCompanyKey('AWS'));
    expect(normalizeCompanyKey('Bain Capital')).not.toBe(normalizeCompanyKey('Bain & Company'));
    expect(normalizeCompanyKey('Johnson & Johnson')).toBe('johnson and johnson');
  });

  test('the label is the spelling most people in the file use', () => {
    const list = [c('A', '', 'McKinsey & Company'), c('B', '', 'McKinsey & Company'), c('C', '', 'McKinsey'), c('D', '', 'McKinsey & Co.')];
    expect(new Set(list.map(companyKeyFor)).size).toBe(1);
    expect(companyLabelFor(list)).toBe('McKinsey & Company');
    expect(companyLabelFor([c('A', '', 'Self-employed')])).toBe('');
  });
});

// ------------------------------------------------------------ R8.4: notes are not tags

describe('R8.4 notes are not tags; stage and status columns are (value-6, data-8, value-10)', () => {
  test('data-8: a Notes column never reaches tags, so a lightly tagged file is not tag-led', () => {
    let csv = 'Name,Company,Title,Tags,Notes\n';
    for (let i = 0; i < 100; i += 1) csv += `P${i},Co ${i % 40},Engineer,${i < 8 ? 'hot' : i < 15 ? 'cold' : ''},Note number ${i} about the call\n`;
    const { contacts } = parseGenericCsv(csv);
    expect(contacts.filter((p) => p.tags.length).length).toBe(15);
    expect(contacts.some((p) => p.tags.some((t) => /note/i.test(t)))).toBe(false);
    expect(tagProfile(contacts)).toMatchObject({ signal: false, filled: 15 });
    expect(defaultGrouping(contacts)).not.toBe('tag');
  });

  test('value-6: values longer than four words or forty characters are not counted as tags', () => {
    const notes = ['coffee next month', 'intro via Jo', 'met at SaaStr, follow up re: pilot', 'met at SaaStr'];
    const list = Array.from({ length: 100 }, (_, i) => c(`P${i}`, 'Engineer', `Co ${i}`, { tags: i % 6 < 4 ? [notes[i % 4]] : [] }));
    for (const p of list) for (const t of tagsOf(p)) expect(t.split(' ').length).toBeLessThanOrEqual(4);
    expect(tagsOf(c('A', '', '', { tags: ['met at SaaStr, follow up re: pilot', 'warm'] }))).toEqual(['warm']);
    expect(tagsOf(c('A', '', '', { tags: ['a'.repeat(41), 'decision maker'] }))).toEqual(['decision maker']);
  });

  test('value-10: an applicant-tracking export loads, and its Stage is read as tags', () => {
    let csv = 'Candidate Name,Current Company,Current Title,Stage\n';
    const stages = ['Applied', 'Phone screen', 'Onsite', 'Offer'];
    for (let i = 0; i < 40; i += 1) csv += `Candidate ${i},Co ${i % 9},Software Engineer,${stages[i % 4]}\n`;
    const out = parseGenericCsv(csv);
    expect(out.headerFound).toBe(true);
    expect(out.contacts).toHaveLength(40);
    expect(out.contacts[0]).toMatchObject({ name: 'Candidate 0', company: 'Co 0', position: 'Software Engineer', tags: ['Applied'] });
    expect(tagProfile(out.contacts).signal).toBe(true);
    expect(defaultGrouping(out.contacts)).toBe('tag');
  });

  test('value-10: Status, Lead status, Segment and several tag columns are all read', () => {
    expect(mapHeaders(['Name', 'Company', 'Title', 'Location', 'Status', 'Date Added'])).toMatchObject({ tags: 4, tagColumns: [4] });
    const csv = 'Name,Company,Tags,Lead Status,Segment\nAna,Acme,vip,Contacted,Enterprise\n';
    expect(parseGenericCsv(csv).contacts[0].tags).toEqual(['vip', 'Contacted', 'Enterprise']);
  });
});

// ------------------------------------------------------------ R8.5: thin files

describe('R8.5 a company read from a work email (value-9, the key side)', () => {
  test('work domains are kept as the domain; mail services and reserved domains are not', () => {
    expect(companyFromEmail({ email: 'ana@stripe.com' })).toBe('stripe.com');
    expect(companyFromEmail({ email: 'bo@eng.acme.com' })).toBe('acme.com');
    expect(companyFromEmail({ email: 'cy@acme.co.uk' })).toBe('acme.co.uk');
    for (const e of ['x@gmail.com', 'x@outlook.com', 'x@hotmail.co.uk', 'x@yahoo.com', 'x@icloud.com', 'x@proton.me', 'x@example.org', 'x@mail.ru', '', 'not-an-email']) {
      expect([e, companyFromEmail({ email: e })]).toEqual([e, '']);
    }
  });
});

describe('value-m4: no arrangement splits a names-and-emails file', () => {
  test('defaultGrouping is null, not "role"', () => {
    const book = Array.from({ length: 250 }, (_, i) => ({ name: `Person ${i}`, email: i < 100 ? `p${i}@${i % 2 ? 'stripe' : 'acme'}.com` : `p${i}@gmail.com` }));
    expect(usefulGroupings(book)).toEqual([]);
    expect(defaultGrouping(book)).toBeNull();
  });
});

// ------------------------------------------------------------ R8.6: places

describe('R8.6 places (data-9)', () => {
  test.each([
    ['Greater Houston', 'Houston', 'United States'],
    ['Greater Philadelphia', 'Philadelphia', 'United States'],
    ['Miami-Fort Lauderdale Area', 'Miami', 'United States'],
    ['Washington DC-Baltimore Area', 'Washington', 'United States'],
    ['Dallas-Fort Worth Metroplex', 'Dallas', 'United States'],
    ['Salt Lake City Metropolitan Area', 'Salt Lake City', 'United States'],
    ['Bay Area', 'San Francisco', 'United States'],
    ['San Francisco Bay Area', 'San Francisco', 'United States'],
    ['Brooklyn, NY', 'New York', 'United States'],
    ['Manhattan, New York', 'New York', 'United States'],
    ['Greater New York City Area', 'New York', 'United States'],
    ['Bangalore Urban', 'Bangalore', 'India'],
    ['London Area, United Kingdom', 'London', 'United Kingdom'],
    ['Remote', '', UNKNOWN_COUNTRY],
    ['Springfield, Narnia', 'Springfield', UNKNOWN_COUNTRY],
    ['United States', '', 'United States'],
    ['Singapore', 'Singapore', 'Singapore'],
  ])('%s -> %s / %s', (location, city, country) => {
    expect(cityOf({ location })).toBe(city);
    expect(countryOf({ location })).toBe(country);
  });

  test('unknown place is one last group "Place not known"', () => {
    const list = [c('A', '', '', { location: 'Remote' }), c('B', '', '', { location: 'Austin, TX' }), c('C', '', '', { location: 'Austin, TX' }), c('D', '', '', { location: 'Boston, MA' })];
    const b = bucketsFor(list, 'country');
    expect(b.map((x) => [x.label, x.contacts.length, !!x.last])).toEqual([['Austin', 2, false], ['Boston', 1, false], ['Place not known', 1, true]]);
  });
});

// ------------------------------------------------------------ data-5: titles

describe('data-5: partner managers, founding engineers and "... to the CEO"', () => {
  test.each([
    ['Partner Manager', 'Google', 'sales'],
    ['Partner Marketing Manager', 'HubSpot', 'sales'],
    ['Channel Partner Manager', 'Acme', 'sales'],
    ['Strategic Partner Development', 'Acme', 'sales'],
    ['HR Business Partner', 'Acme', 'people'],
    ['Founding Engineer', 'Acme', 'engineers'],
    ['Founding Account Executive', 'Acme', 'sales'],
    ['Chief of Staff to the CEO', 'Acme', 'operations'],
    ['Executive Assistant to the CEO', 'Acme', 'operations'],
    ['Head of People', 'Acme', 'people'],
    ['Product Owner', 'Acme', 'product'],
    // Still right:
    ['Partner', 'Kirkland & Ellis', 'lawyers'],
    ['Senior Partner', 'McKinsey & Company', 'consultants'],
    ['Partner', 'Harbor & Finch LLP', 'lawyers'],
    ['Founding Partner', 'Acme Ventures', 'investors'],
    ['Managing Partner', 'Juniper Partners', 'investors'],
    ['Co-Founder & CEO', 'Acme', 'founders'],
    ['Chief Executive Officer', 'Acme', 'founders'],
    ['Owner', 'Joe\'s Bakery', 'founders'],
  ])('%s at %s -> %s', (position, company, family) => {
    expect(classifyContact(c('A', position, company)).family).toBe(family);
  });
});

// ------------------------------------------------------------ data-17: caches

describe('data-17: a contact edited in place is read again', () => {
  test('family, industry, company key, city and tags follow the edit', () => {
    const p = { name: 'Ann', position: 'Software Engineer', company: 'Stripe', location: 'Boston, MA', tags: ['lead'] };
    expect([familyOf(p).key, industryOf(p), companyKeyFor(p), cityOf(p), tagsOf(p)]).toEqual(['engineers', 'Fintech', 'stripe', 'Boston', ['lead']]);
    p.position = 'Partner'; p.company = 'Sequoia Capital'; p.location = 'London, UK'; p.tags.push('warm');
    expect([familyOf(p).key, industryOf(p), companyKeyFor(p), cityOf(p), tagsOf(p)]).toEqual(['investors', 'Venture capital', 'sequoia capital', 'London', ['lead', 'warm']]);
  });

  test('tagProfile reads an array again after it grows', () => {
    const arr = [c('A', '', '', { tags: ['x'] }), c('B', '', '', { tags: ['y'] })];
    expect(tagProfile(arr).filled).toBe(2);
    arr.push(c('C', '', '', { tags: ['x'] }));
    expect(tagProfile(arr).filled).toBe(3);
  });
});

// ------------------------------------------------------------ ask-m3: diligence

describe('ask-m3: "diligence" alone would list the whole CRM file', () => {
  test('the lens holds everyone on the CRM, the expert roles only the clinicians', () => {
    const crm = SAMPLES['sales-crm.csv'];
    expect(lensShare(crm, 'diligence')).toBe(1);
    expect(crm.filter(isExpert).length).toBe(74);
    expect([...EXPERT_ROLES].sort()).toEqual(['academic', 'accountant', 'banker', 'clinician', 'consultant', 'lawyer', 'partner', 'press', 'public']);
  });
});
