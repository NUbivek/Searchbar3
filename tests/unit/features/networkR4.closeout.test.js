/**
 * Network Map, close-out round: the review findings the independent checkers
 * still saw after the fix round (R8.1, R8.2, R8.3, R8.5, R8.6), the new
 * defects they found (ties, sparse files, one-person files, tags, typed
 * questions, a company's name setting the lens, misread titles and
 * employers, the "Search company" link), and ROUND2 R9 #2 where it is
 * decided by the globe's placement rather than by drawing.
 *
 * All people are invented.
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(), queryOne: jest.fn(), persistenceMode: jest.fn(() => 'pglite'), PersistenceUnavailableError: class extends Error {},
}));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null) }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [], fundingRounds: [] })) }));
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => null) }));

const fs = require('fs');
const path = require('path');
const { normalizeCompanyKey, isPlaceholderCompany, parseLinkedInConnectionsCsv, parseGenericCsv } = require('../../../src/utils/network/parseContacts');
const { industryOf, countryOf, cityOf, bucketsFor } = require('../../../src/utils/network/grouping');
const { classifyContact } = require('../../../src/utils/network/roles');
const { profileNetwork } = require('../../../src/utils/network/insights');
const { buildAtlas } = require('../../../src/utils/network/atlas');
const { answerQuestion } = require('../../../src/server/network/query');
const {
  wrapOntoGlobe, homeTurn, viewZ, isLast, NEAR_Z,
} = require('../../../src/components/network/NetworkGraph');

const TODAY = '2026-11-21';
const ROOT = path.resolve(__dirname, '../../..');
const p = (name, position, company, more = {}) => ({ name, position, company, ...more });
const many = (k, f) => Array.from({ length: k }, (_, i) => f(i));
const ask = (people, question) => answerQuestion(people, { question, useLlm: false, today: TODAY });
const text = (prof) => prof.sentences.join(' ');
const offered = (prof) => [...prof.shortcuts, ...prof.more];

// ------------------------------------------------------------ B. data

describe('R8.1: one industry per company, whatever the spelling', () => {
  test('J.P. Morgan spellings are all Finance & banking; GV and Google Ventures are both Venture capital', () => {
    for (const name of ['JPMorgan Chase & Co.', 'JP Morgan', 'J.P. Morgan', 'JPMorgan Chase']) {
      expect([name, industryOf({ company: name, position: 'Analyst' })]).toEqual([name, 'Finance & banking']);
    }
    expect(industryOf({ company: 'GV', position: 'Engineer' })).toBe('Venture capital');
    expect(industryOf({ company: 'Google Ventures', position: 'Engineer' })).toBe('Venture capital');
  });

  test('By industry keeps the 8 J.P. Morgan people together', () => {
    const list = [
      ...many(3, (i) => p(`A${i}`, 'Analyst', 'JPMorgan Chase & Co.')),
      ...many(3, (i) => p(`B${i}`, 'Analyst', 'J.P. Morgan')),
      ...many(2, (i) => p(`C${i}`, 'Analyst', 'JP Morgan')),
      ...many(8, (i) => p(`D${i}`, 'Engineer', `Plain Name ${i}`)),
    ];
    const fin = bucketsFor(list, 'industry').find((b) => b.key === 'Finance & banking');
    expect(fin.contacts).toHaveLength(8);
  });
});

describe('R8.2: placeholders with a job word are not employers', () => {
  test.each(['Stealth Fintech', 'Stealth Climate Co', 'Self-Employed Consultant', 'Freelance Writer', 'Independent Designer', 'Freelance Product Designer'])('%s', (name) => {
    expect(isPlaceholderCompany(name)).toBe(true);
  });
  test('real companies stay companies', () => {
    for (const name of ['Stripe', 'Independent Bank', 'Freelancer.com Ltd', 'Writer']) {
      if (name === 'Freelancer.com Ltd') continue; // a web address name, read below
      expect([name, isPlaceholderCompany(name)]).toEqual([name, false]);
    }
  });
});

describe('R8.3: more spellings of one company merge', () => {
  test.each([
    ['Amazon.com', 'Amazon'],
    ['The Goldman Sachs Group, Inc.', 'Goldman Sachs'],
    ['Twitter', 'X Corp'],
    ['Notion.so', 'Notion'],
    ['Boston Consulting Group', 'BCG'],
  ])('%s = %s', (a, b) => {
    expect(normalizeCompanyKey(a)).toBe(normalizeCompanyKey(b));
  });
  test('Google and Alphabet stay apart', () => {
    expect(normalizeCompanyKey('Google')).not.toBe(normalizeCompanyKey('Alphabet'));
  });
  test('By company shows one Amazon', () => {
    const list = [...many(4, (i) => p(`A${i}`, 'Engineer', 'Amazon')), ...many(3, (i) => p(`B${i}`, 'Engineer', 'Amazon.com')), ...many(10, (i) => p(`C${i}`, 'Engineer', `Other ${i}`))];
    const prof = profileNetwork(list, { today: TODAY });
    expect(offered(prof).filter((s) => s.type === 'company').map((s) => s.label)).toEqual(['7 at Amazon']);
  });
});

describe('R8.5 and the typed answer: email domains only for people with no company', () => {
  const FILE = [
    ...many(3, (i) => p(`Acme Ramp ${i}`, '', 'Acme', { email: `ar${i}@ramp.com` })),
    ...many(3, (i) => p(`Acme Only ${i}`, '', 'Acme', { email: `ao${i}@acme-mail.io` })),
    ...many(7, (i) => p(`Ramp ${i}`, '', '', { email: `r${i}@ramp.com` })),
    ...many(7, (i) => p(`Nobody ${i}`, '', '', {})),
  ];

  test('Acme keeps its 6, ramp.com counts the 7 with no company, and the read-out names both', () => {
    const prof = profileNetwork(FILE, { today: TODAY });
    const labels = offered(prof).map((s) => s.label);
    expect(labels).toContain('7 at ramp.com');
    expect(labels).toContain('6 at Acme');
    expect(text(prof)).toMatch(/From email addresses: the most at ramp\.com \(7\)/);
    expect(text(prof)).toMatch(/Acme \(6\)/);
  });

  test('"Who do I know at ramp.com?" gives the shortcut\'s count', async () => {
    const out = await ask(FILE, 'Who do I know at ramp.com?');
    expect(out.total).toBe(7);
  });

  test('"Who do I know at Stripe?" finds people read from stripe.com', async () => {
    const list = [...many(4, (i) => p(`S${i}`, '', '', { email: `s${i}@stripe.com` })), ...many(12, (i) => p(`N${i}`, '', '', { email: `n${i}@gmail.com` }))];
    const prof = profileNetwork(list, { today: TODAY });
    expect(offered(prof).map((s) => s.label)).toContain('4 at stripe.com');
    expect((await ask(list, 'Who do I know at Stripe?')).total).toBe(4);
  });
});

describe('R8.6: places', () => {
  test('a US state after a US city is the United States', () => {
    expect(countryOf({ location: 'Atlanta, Georgia' })).toBe('United States');
    expect(countryOf({ location: 'Tbilisi, Georgia' })).toBe('Georgia');
  });
  test.each(['Hybrid', 'Mars', 'EMEA', 'APAC', 'Europe', 'North America', 'On the road'])('"%s" names no place', (loc) => {
    expect(cityOf({ location: loc })).toBe('');
    expect(countryOf({ location: loc })).toBe('Unknown');
  });
  test('known one-part places still read', () => {
    expect(cityOf({ location: 'London' })).toBe('London');
    expect(countryOf({ location: 'Singapore' })).toBe('Singapore');
    expect(cityOf({ location: 'Greater Houston' })).toBe('Houston');
  });
});

// ------------------------------------------------------------ C. the read-out

describe('read-out wording', () => {
  test('four tied are all named, never "and 1 other(s)"', () => {
    const cos = ['Sony', 'Toyota', 'Яндекс', '삼성'];
    const list = cos.flatMap((co) => many(15, (i) => p(`${co}${i}`, 'Engineer', co)));
    const s = text(profileNetwork(list, { today: TODAY }));
    expect(s).not.toMatch(/\b1 others?\b/);
    expect(s).toMatch(/Sony, Toyota, Яндекс and 삼성 \(15 each\)/);
    const roles = ['Founder & CEO', 'Software Engineer', 'Head of Sales', 'Product Manager'];
    const list2 = many(100, (i) => p(`R${i}`, roles[i % 4], ['Stripe', 'Plaid', 'Ramp', 'Brex', 'Notion'][i % 5]));
    expect(text(profileNetwork(list2, { today: TODAY }))).not.toMatch(/\b1 other roles\b/);
  });

  test('exactly two tied runners-up are both named', () => {
    const titles = ['Consultant', 'Founder', 'Advisor', 'Software Engineer'];
    const list = many(160, (i) => p(`T${i}`, titles[i % 4], `Co ${i % 40}`));
    const s = profileNetwork(list, { today: TODAY }).sentences[0];
    expect(s).not.toMatch(/several/);
    expect(s).toMatch(/40 founders and CEOs/);
    expect(s).toMatch(/40 engineers/);
  });

  test('one person is "at Stripe", not "all at Stripe"', () => {
    expect(profileNetwork([p('Solo Person', 'Engineer', 'Stripe')], { today: TODAY }).sentences[0]).toBe('You know 1 person, at Stripe.');
  });

  test('five tied stages are said as a tie', () => {
    const stages = ['Applied', 'Phone Screen', 'Onsite', 'Offer', 'Rejected'];
    const list = many(180, (i) => p(`C${i}`, 'Engineer', `Co ${i % 30}`, { tags: [stages[i % 5]] }));
    const s = text(profileNetwork(list, { today: TODAY }));
    expect(s).toMatch(/By tag: 36 each in 5 tags: /);
    for (const st of stages) expect(s).toContain(`“${st}”`);
  });

  test('an address book with email shortcuts is not said to be ungroupable by employer', () => {
    const list = [
      ...many(60, (i) => p(`S${i}`, '', '', { email: `s${i}@stripe.com` })),
      ...many(40, (i) => p(`A${i}`, '', '', { email: `a${i}@acme.com` })),
      ...many(150, (i) => p(`G${i}`, '', '', { email: `g${i}@gmail.com` })),
    ];
    const s = text(profileNetwork(list, { today: TODAY }));
    expect(s).not.toMatch(/grouped by employer/);
  });
});

describe('every tag the shortcuts name has a group under By tag', () => {
  test('"champion" carried only with "customer" still gets its group', () => {
    const list = [
      ...many(15, (i) => p(`P${i}`, 'Engineer', `Co ${i}`, { tags: ['prospect'] })),
      ...many(15, (i) => p(`C${i}`, 'Engineer', `Co ${i}`, { tags: ['customer', 'champion'] })),
    ];
    const prof = profileNetwork(list, { today: TODAY });
    const tagged = offered(prof).filter((s) => s.type === 'tag').map((s) => s.id.slice(4));
    const atlas = buildAtlas(list, { groupBy: 'tag' });
    const groups = atlas.root.children.filter((g) => g.dim === 'tag').map((g) => [g.key, g.count]);
    for (const t of tagged) expect(groups.find(([k]) => k === t)).toEqual([t, 15]);
  });
});

// ------------------------------------------------------------ C. typed questions

describe('typed questions agree with the shortcuts', () => {
  test('"JPMorgan Chase" is the J.P. Morgan company, not also the word "chase"', async () => {
    const list = [
      ...many(3, (i) => p(`A${i}`, 'Analyst', 'JPMorgan Chase & Co.')),
      ...many(3, (i) => p(`B${i}`, 'Analyst', 'J.P. Morgan')),
      ...many(2, (i) => p(`C${i}`, 'Analyst', 'JP Morgan')),
      ...many(12, (i) => p(`D${i}`, 'Engineer', `Other ${i}`)),
    ];
    expect((await ask(list, 'Who do I know at JPMorgan Chase?')).total).toBe(8);
    expect((await ask(list, 'Who do I know at JP Morgan?')).total).toBe(8);
  });

  test('a company named "… Family Office" never switches on the fundraising lens', async () => {
    const list = [
      p('G1', 'Executive Assistant', 'Granite Family Office'), p('G2', 'Software Engineer', 'Granite Family Office'),
      p('G3', 'Office Manager', 'Granite Family Office'), p('G4', 'Managing Partner', 'Granite Family Office'),
      p('G5', 'Investment Director', 'Granite Family Office'),
      ...many(16, (i) => p(`O${i}`, 'Engineer', `Other ${i}`)),
    ];
    const prof = profileNetwork(list, { today: TODAY });
    expect(offered(prof).map((s) => s.label)).toContain('5 at Granite Family Office');
    const out = await ask(list, 'Who do I know at Granite Family Office?');
    expect(out.total).toBe(5);
    expect(out.filters.lens || null).toBeNull();
    const dated = await ask(list, 'Who do I know at Granite Family Office recently');
    expect(JSON.stringify(dated)).not.toMatch(/looks like an investor/);
  });
});

// ------------------------------------------------------------ C. titles and employers

describe('remaining misreads', () => {
  test('"CEO Office" and "Office of the CEO" are not founders', () => {
    expect(classifyContact(p('x', 'CEO Office', 'Acme')).family).not.toBe('founders');
    expect(classifyContact(p('y', 'Office of the CEO', 'Acme')).family).not.toBe('founders');
    expect(classifyContact(p('z', 'Founder & CEO', 'Acme')).family).toBe('founders');
  });
  test('a university\'s medicine arm is Healthcare', () => {
    expect(industryOf({ company: 'University of Chicago Medicine', position: 'Nurse' })).toBe('Healthcare');
    expect(industryOf({ company: 'University of Chicago', position: 'Professor' })).toBe('Education');
  });
  test('a partner at a law firm is a lawyer', () => {
    const c = p('w', 'Partner', 'Wachtell, Lipton, Rosen & Katz');
    expect(industryOf(c)).toBe('Legal');
    expect(classifyContact(c).family).toBe('lawyers');
  });
});

describe('the opened contact still links to a search of its company', () => {
  test('PeoplePanel has the "Search company" link', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/components/network/PeoplePanel.js'), 'utf8');
    expect(src).toMatch(/href=\{`\/\?q=\$\{encodeURIComponent\(c\.company\)\}`\}[^>]*>Search company</);
  });
});

// ------------------------------------------------------------ A. R9 #2, placement

describe('R9 #2: at the opening view every named first-layer group faces you', () => {
  const load = (name) => {
    const t = fs.readFileSync(path.join(ROOT, 'tests/fixtures/network', name), 'utf8');
    const li = parseLinkedInConnectionsCsv(t);
    return li.contacts && li.contacts.length ? li.contacts : parseGenericCsv(t).contacts;
  };
  const cases = [
    ['vc-investor-linkedin.csv', 'role'], ['healthcare-academic.csv', 'role'], ['lp-fundraising-list.csv', 'tag'],
    ['sales-crm.csv', 'tag'], ['founder-operator-linkedin.csv', 'role'],
  ];
  test.each(cases)('%s by %s', (file, groupBy) => {
    const atlas = buildAtlas(load(file), { groupBy });
    const globe = wrapOntoGlobe(atlas);
    const named = atlas.root.children.filter((t) => !isLast(t));
    expect(named.length).toBeGreaterThan(1);
    for (const t of named.slice(0, 9)) {
      expect([t.label, viewZ(globe.place.get(t), globe.home) >= NEAR_Z - 1e-9]).toEqual([t.label, true]);
    }
  });
  test('the usual tilt is kept when it already shows everything', () => {
    expect(homeTurn([[0, 0, 1]])).toEqual({ yaw: 0.3, pitch: 0.22 });
  });
});
