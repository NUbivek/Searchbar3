/**
 * Founder Check and the user's own network, round 3 fixes (audit 2026-11-20,
 * owner "network"). Every contact here is invented; the database is faked,
 * except in the PGlite block, which runs the real SQL in a child process.
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  persistenceMode: jest.fn(() => 'pglite'),
  PersistenceUnavailableError: class PersistenceUnavailableError extends Error {},
}));
jest.mock('../../../src/server/auth', () => {
  const getUserId = jest.fn(async () => 'user-1');
  // requireFounderUser answers 401 itself when signed out (and 403 for an account outside the allow-list)
  const requireFounderUser = jest.fn(async (req, res) => { const id = await getUserId(req, res); if (!id) { res.status(401).json({ error: 'Sign in to use this feature.', signIn: true }); return null; } return id; });
  return { getUserId, requireFounderUser };
});
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [] })) }));

const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../../../src/server/db');
const auth = require('../../../src/server/auth');
const store = require('../../../src/server/network/store');
const link = require('../../../src/server/founder/networkLink');
const { companyMatch, companyFormMatch, normalizeCompanyKey } = require('../../../src/utils/network/parseContacts');

const ROOT = path.resolve(__dirname, '../../..');
const contact = (name, company, position = '', extra = {}) => ({ name, company, position, profileUrl: '', connectedOn: '2020-03-01', source: 'linkedin', relationship: 'direct', via: '', ...extra });

const REPORT = {
  name: 'Trevor Milton',
  company: 'Nikola',
  profile: { company: 'Nikola', earlier: [], education: [], about: [], links: [] },
  threads: [{ kind: 'company', value: 'Nikola', why: 'the company given' }],
  relatedParties: [],
};

const fakeStore = (over = {}) => ({
  countContacts: jest.fn(async () => 10),
  findContactsByNames: jest.fn(async () => []),
  findContactsAtCompanies: jest.fn(async () => []),
  ...over,
});

beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async () => []);
  db.persistenceMode.mockReturnValue('pglite');
  store.__resetForTests();
});

// ------------------------------------------------------------ rule-network-relatives-as-references

describe('relatives are never suggested as references', () => {
  const report = {
    ...REPORT,
    relatedParties: [
      { name: 'Carrie Milton', kind: 'relative', relation: 'wife', records: [] },
      { name: 'Dana Brother', kind: 'associate', relation: 'brother', records: [] },
      { name: 'Sam Partner', kind: 'associate', relation: 'co-founder', records: [] },
    ],
  };
  test('partiesOf leaves out relatives, by kind and by relation', () => {
    expect(link.partiesOf(report).map((p) => p.name)).toEqual(['Sam Partner']);
  });
  test('a contact who shares a relative\'s name is not listed or asked about', () => {
    const net = link.buildNetworkLinks({ report, total: 5, partyMatches: [contact('Carrie Milton', 'Acme'), contact('Sam Partner', 'Zeta')] });
    const text = JSON.stringify(net);
    expect(text).not.toMatch(/Carrie|wife/);
    expect(net.references.map((r) => r.name)).toEqual(['Sam Partner']);
  });
});

// ------------------------------------------------------------ network-company-lookup-failure-shown-as-none / network-all-or-nothing

describe('a failed lookup is shown as failed, never as nobody', () => {
  test('store: strict company lookup throws; the default still never throws', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.query.mockRejectedValue(new Error('db down'));
    await expect(store.findContactsAtCompanies('user-1', ['Nikola'], { strict: true })).rejects.toThrow('db down');
    expect(await store.findContactsAtCompanies('user-1', ['Nikola'])).toEqual([]);
    console.warn.mockRestore();
  });
  test('the company lookup fails: the pairing says so, keeps the parts that worked, and no group reads as empty', async () => {
    const s = fakeStore({
      findContactsByNames: jest.fn(async () => [contact('Trevor Milton', 'Nikola', 'CEO')]),
      findContactsAtCompanies: jest.fn(async () => { throw new Error('timeout'); }),
    });
    const net = await link.networkForReport('user-1', REPORT, { store: s, investors: ['Omega Ventures'] });
    expect(net.available).toBe(true);
    expect(net.self).toMatchObject({ name: 'Trevor Milton' });
    expect(net.failed).toMatchObject({ companies: true, investors: true, self: false });
    expect(net.notes.join(' ')).toMatch(/could not be read/);
    expect(net.groups).toEqual([]);
  });
  test('the party lookup fails: self and company matches survive', async () => {
    const report = { ...REPORT, relatedParties: [{ name: 'Sam Partner', kind: 'associate', relation: 'co-founder', records: [] }] };
    const s = fakeStore({
      findContactsByNames: jest.fn(async (_u, names) => { if (names.includes('Sam Partner')) throw new Error('db down'); return []; }),
      findContactsAtCompanies: jest.fn(async () => [contact('Ann Colleague', 'Nikola', 'VP Sales', { matchedCompany: 'Nikola' })]),
    });
    const net = await link.networkForReport('user-1', report, { store: s });
    expect(net.available).toBe(true);
    expect(net.failed.parties).toBe(true);
    expect(net.groups.find((g) => g.key === 'current').people[0].name).toBe('Ann Colleague');
  });
  test('over-common party names are retried one by one and only those are dropped', async () => {
    const report = { ...REPORT, relatedParties: [{ name: 'John Smith', kind: 'associate', relation: 'board member', records: [] }, { name: 'Sam Partner', kind: 'associate', relation: 'co-founder', records: [] }] };
    const tooMany = () => Object.assign(new Error('more than 1000 contacts share these names'), { code: 'too_many' });
    const s = fakeStore({
      findContactsByNames: jest.fn(async (_u, names) => {
        if (names.includes('John Smith')) throw tooMany();
        return names.includes('Sam Partner') ? [contact('Sam Partner', 'Zeta')] : [];
      }),
    });
    const net = await link.networkForReport('user-1', report, { store: s });
    expect(net.failed.parties).toBe(false);
    expect(net.groups.find((g) => g.key === 'parties').people.map((p) => p.name)).toEqual(['Sam Partner']);
    expect(net.notes.join(' ')).toMatch(/too many of your contacts/);
  });
  test('everything fails: not available, could not be read', async () => {
    const boom = jest.fn(async () => { throw new Error('down'); });
    const net = await link.networkForReport('user-1', REPORT, { store: fakeStore({ findContactsByNames: boom, findContactsAtCompanies: boom }) });
    expect(net).toEqual({ available: false, reason: expect.stringMatching(/could not be read/) });
  });
  test('store: the name lookup marks an over-limit failure so it can be retried name by name', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: store.NAME_MATCH_LIMIT + 1 }, (_, i) => ({ name: `Wei Li ${i}`, company: `Co ${i}` }));
    db.query.mockImplementation(async (sql) => (/SELECT name, company, position, profile_url/.test(sql) ? many : []));
    await expect(store.findContactsByNames('user-1', ['Wei Li'])).rejects.toMatchObject({ code: 'too_many' });
    console.warn.mockRestore();
  });
});

// ------------------------------------------------------------ network-seed-namesake-anchors-check

describe('a namesake contact never anchors a check silently', () => {
  const s = () => fakeStore({ findContactsByNames: jest.fn(async () => [contact('John Smith', 'Acme Robotics')]) });
  test('without the user\'s yes, no company is seeded', async () => {
    expect(await link.companySeed('user-1', 'John Smith', '', { store: s() })).toBeNull();
  });
  test('the suggestion asks the question, with only the company', async () => {
    expect(await link.seedSuggestion('user-1', 'John Smith', '', { store: s() })).toEqual({ company: 'Acme Robotics', question: 'Is this the John Smith at Acme Robotics in your network?' });
    expect(await link.seedSuggestion('user-1', 'John Smith', 'Typed Co', { store: s() })).toBeNull();
  });
  test('after a yes, the seed carries its origin; a yes to another company does not seed', async () => {
    expect(await link.companySeed('user-1', 'John Smith', '', { store: s(), confirmedCompany: 'Acme Robotics' })).toEqual({ company: 'Acme Robotics', origin: 'network' });
    expect(await link.companySeed('user-1', 'John Smith', '', { store: s(), confirmedCompany: 'Other Co' })).toBeNull();
  });
  test('a seeded check does not prove the contact is the person (basis is the seed, not the company)', () => {
    const net = link.buildNetworkLinks({ report: { ...REPORT, name: 'John Smith', company: 'Acme Robotics', profile: { company: 'Acme Robotics' }, threads: [] }, total: 3, seededCompany: 'Acme Robotics', nameMatches: [contact('John Smith', 'Acme Robotics')] });
    expect(net.self).toMatchObject({ basis: 'seed' });
    expect(net.self.note).toMatch(/confirm/i);
  });
});

// ------------------------------------------------------------ network-one-word-company-variants

describe('one-word companies and their longer names', () => {
  test('a company-form tail matches; an ordinary longer name does not', () => {
    expect(companyFormMatch('nikola motor company', 'nikola')).toBe('similar');
    expect(companyFormMatch('meta platforms', 'meta')).toBe('similar');
    expect(companyFormMatch('nikola', 'nikola motor company')).toBe('similar');
    expect(companyFormMatch('meta financial', 'meta')).toBeNull();
    expect(companyFormMatch('sequoia capital', 'sequoia')).toBeNull();
    expect(companyFormMatch('sequoia capital', 'sequoia', { investor: true })).toBe('similar');
    // the Network Map's own matcher is unchanged
    expect(companyMatch('nikola motor company', 'nikola')).toBeNull();
  });
  test('store: the SQL also fetches one-word targets with a longer tail, and marks them similar', async () => {
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM network_contacts/.test(sql) && /company_key/.test(sql) && /ROW_NUMBER/.test(sql)) {
        expect(params[2]).toEqual(expect.arrayContaining(['nikola %']));
        return [
          { name: 'Ann Colleague', company: 'Nikola Motor Company', company_key: 'nikola motor company', position: 'Engineer', key_total: 1 },
          { name: 'Noise Person', company: 'Nikola Tesla Museum', company_key: 'nikola tesla museum', position: '', key_total: 1 },
        ];
      }
      return [];
    });
    const out = await store.findContactsAtCompanies('user-1', ['Nikola'], { similar: true, detail: true });
    expect(out.rows.map((r) => [r.name, r.match])).toEqual([['Ann Colleague', 'similar']]);
  });
  test('a similar-name match is labelled and never makes a namesake "the person" by company', () => {
    const net = link.buildNetworkLinks({
      report: REPORT, total: 5,
      nameMatches: [contact('Trevor Milton', 'Nikola Motor Company'), contact('Trevor Milton', 'Bakery Co')],
      atCompanies: [contact('Ann Colleague', 'Nikola Motor Company', 'VP Sales', { matchedCompany: 'Nikola', match: 'similar' })],
    });
    expect(net.self).toBeNull();
    const ann = net.groups.find((g) => g.key === 'current').people[0];
    expect(ann.why).toMatch(/similar company name/);
  });
  test('the company\'s known legal names are searched as well', async () => {
    const s = fakeStore();
    await link.networkForReport('user-1', { ...REPORT, companyFacts: { legalNames: [{ name: 'Nikola Corporation', cites: [1] }, { name: 'Nikola Motor Company', cites: [2] }] } }, { store: s });
    const names = s.findContactsAtCompanies.mock.calls[0][1];
    expect(names).toEqual(expect.arrayContaining(['Nikola', 'Nikola Motor Company']));
  });
});

// ------------------------------------------------------------ network-cross-source-duplicate-loses-self

test('the same person imported twice (LinkedIn and Attio) is still them', () => {
  const net = link.buildNetworkLinks({ report: REPORT, total: 5, nameMatches: [contact('Trevor Milton', 'Nikola', 'CEO', { source: 'linkedin' }), contact('Trevor Milton', 'Nikola', 'CEO', { source: 'attio', relationship: 'firm', via: 'Pat' })] });
  expect(net.self).toMatchObject({ name: 'Trevor Milton', basis: 'company', relationship: 'direct' });
  expect(net.sameNameContacts).toEqual([]);
});

// ------------------------------------------------------------ network-weak-self-basis

describe('weak evidence never makes a contact "the person"', () => {
  test('conflicting middle initials are different people', () => {
    expect(link.sameName('John P. Smith', 'John Q. Smith')).toBe(false);
    expect(link.sameName('John P. Smith', 'John Smith')).toBe(true);
  });
  test('a namesake with no company is not them when the check has a company', () => {
    const net = link.buildNetworkLinks({ report: REPORT, total: 5, nameMatches: [contact('Trevor Milton', '')] });
    expect(net.self).toBeNull();
    expect(net.sameNameContacts).toHaveLength(1);
  });
  test('a namesake at a company they only left is "confirm", not basis company', () => {
    const report = { ...REPORT, threads: [...REPORT.threads, { kind: 'company', value: 'Upfit Labs', why: 'Chief of Staff (past)' }] };
    const net = link.buildNetworkLinks({ report, total: 5, nameMatches: [contact('Trevor Milton', 'Upfit Labs')] });
    expect(net.self).toMatchObject({ basis: 'tied-company' });
    expect(net.self.note).toMatch(/confirm/i);
  });
});

// ------------------------------------------------------------ network-silent-2000-row-cap

describe('big networks: rows are capped per company and the cut is reported', () => {
  test('store: rows ranked per company, totals returned', async () => {
    let seen = null;
    db.query.mockImplementation(async (sql, params) => {
      if (/ROW_NUMBER\(\) OVER \(PARTITION BY company_key/.test(sql)) {
        seen = params;
        return [{ name: 'Gil One', company: 'Bigco', company_key: 'bigco', position: 'Engineer', key_total: 950 }];
      }
      return [];
    });
    const out = await store.findContactsAtCompanies('user-1', ['Bigco', 'Nikola'], { detail: true, perCompany: 200 });
    expect(seen).toContain(200);
    expect(out.truncated).toEqual([{ company: 'Bigco', shown: 1, total: 950 }]);
  });
  test('the pairing shows how many more were not listed', async () => {
    const s = fakeStore({ findContactsAtCompanies: jest.fn(async () => ({ rows: [contact('Gil One', 'Nikola', 'Engineer', { matchedCompany: 'Nikola' })], truncated: [{ company: 'Nikola', shown: 1, total: 950 }] })) });
    const net = await link.networkForReport('user-1', REPORT, { store: s });
    expect(net.groups.find((g) => g.key === 'current')).toMatchObject({ total: 950, more: 949 });
    expect(net.notes.join(' ')).toMatch(/949 more at Nikola/);
  });
});

// ------------------------------------------------------------ network-profile-roles-ignored

describe('the profile\'s dated roles, boards, founded companies and investments', () => {
  const report = {
    ...REPORT,
    profile: {
      company: 'Nikola',
      roles: [{ org: 'Nikola', title: 'CEO', from: 2014, to: null, current: true, cites: [1] }, { org: 'Upfit Labs', title: 'Founder', from: 2008, to: 2012, current: false, cites: [2] }],
      founded: [{ org: 'Nikola', year: 2014, with: [], cites: [1] }, { org: 'Upfit Labs', year: 2008, with: [], cites: [2] }],
      boards: [{ org: 'Gamma Trust', role: 'board member', from: 2019, to: null, cites: [3] }],
      investments: [{ text: 'angel in Zeta Foods', org: 'Zeta Foods', cites: [4] }],
      earlier: [{ org: 'Upfit Labs', role: 'Founder' }],
    },
  };
  test('read into the companies, with years and new ties', () => {
    const by = Object.fromEntries(link.companiesOf(report).map((c) => [c.name, c]));
    expect(by.Nikola.tie).toBe('current');
    expect(by['Upfit Labs']).toMatchObject({ tie: 'founded', from: 2008, to: 2012 });
    expect(by['Gamma Trust'].tie).toBe('board');
    expect(by['Zeta Foods'].tie).toBe('portfolio');
  });
  test('each person carries the years, and overlap is not claimed', () => {
    const net = link.buildNetworkLinks({ report, total: 5, atCompanies: [contact('Ann Old', 'Upfit Labs', 'Engineer', { matchedCompany: 'Upfit Labs' }), contact('Bo Board', 'Gamma Trust', 'Trustee', { matchedCompany: 'Gamma Trust' })] });
    const ann = net.groups.find((g) => g.key === 'founded').people[0];
    expect(ann.years).toBe('2008–2012');
    expect(ann.why).toMatch(/2008–2012/);
    expect(net.groups.find((g) => g.key === 'board').people[0].name).toBe('Bo Board');
    expect(net.notes.join(' ')).toMatch(/overlapped .* not known/);
  });
  test('investors from the company facts are looked for too', async () => {
    const s = fakeStore();
    await link.networkForReport('user-1', { ...REPORT, companyFacts: { investors: [{ name: 'Omega Ventures', cites: [1] }], funding: [{ round: 'Series A', lead: 'Sigma Capital', investors: ['Tau Partners'], cites: [2] }] } }, { store: s });
    const investorCall = s.findContactsAtCompanies.mock.calls.find((c) => c[1].includes('Omega Ventures'));
    expect(investorCall[1]).toEqual(expect.arrayContaining(['Omega Ventures', 'Sigma Capital', 'Tau Partners']));
  });
});

// ------------------------------------------------------------ network-title-mentions-past-colleagues

describe('contacts whose title mentions the company', () => {
  test('store: a whole-word match on the title, user-scoped, distinctive names only', async () => {
    let call = null;
    db.query.mockImplementation(async (sql, params) => {
      if (/position ~\*/.test(sql)) { call = [sql, params]; return [{ name: 'Pat Former', company: 'Other Fund', company_key: 'other fund', position: 'Partner · ex-Theranos' }, { name: 'Noise', company: 'X', company_key: 'x', position: 'Theranosity lead' }]; }
      return [];
    });
    const rows = await store.findContactsByTitleMention('user-1', ['Theranos', 'Ramp']);
    expect(call[0]).toMatch(/user_id = \$1/);
    expect(call[1][0]).toBe('user-1');
    expect(call[1][1]).toHaveLength(1); // "Ramp" is an ordinary word: never looked for in titles
    expect(rows.map((r) => [r.name, r.matchedCompany])).toEqual([['Pat Former', 'Theranos']]);
  });
  test('the pairing lists them as possible former colleagues, below direct company matches', async () => {
    const report = { ...REPORT, name: 'Elizabeth Holmes', company: 'Ventureco', threads: [{ kind: 'company', value: 'Theranos', why: 'founder (past)' }], profile: {} };
    const s = fakeStore({
      findContactsAtCompanies: jest.fn(async () => [contact('Bob Builder', 'Theranos', 'Engineer', { matchedCompany: 'Theranos' })]),
      findContactsByTitleMention: jest.fn(async () => [contact('Pat Former', 'Other Fund', 'Partner · ex-Theranos', { matchedCompany: 'Theranos' })]),
    });
    const net = await link.networkForReport('user-1', report, { store: s });
    const founded = net.groups.find((g) => g.key === 'founded').people;
    expect(founded.map((p) => p.name)).toEqual(['Bob Builder', 'Pat Former']);
    expect(founded[1].why).toMatch(/title mentions Theranos \(possibly a former colleague\)/);
    expect(net.references.map((r) => r.name)).toEqual(['Bob Builder', 'Pat Former']);
  });
});

// ------------------------------------------------------------ network-shortlist-ranking

test('shortlist: the named co-founder before contacts at a large former employer; parties keyed by their own name', () => {
  const report = {
    ...REPORT,
    threads: [...REPORT.threads, { kind: 'company', value: 'Bigco', why: 'Engineer (past)' }],
    relatedParties: [{ name: 'Sam Partner', kind: 'associate', relation: 'co-founder', records: [] }, { name: 'Tia Adviser', kind: 'associate', relation: 'board member', records: [] }, { name: 'Uma Other', kind: 'associate', relation: 'associate', records: [] }],
  };
  const net = link.buildNetworkLinks({
    report, total: 9,
    partyMatches: [contact('Sam Partner', ''), contact('Tia Adviser', ''), contact('Uma Other', '')],
    atCompanies: [contact('Dan Director', 'Bigco', 'Director', { matchedCompany: 'Bigco' }), contact('Eve Engineer', 'Bigco', 'Engineer', { matchedCompany: 'Bigco' })],
  });
  const names = net.references.map((r) => r.name);
  expect(names.slice(0, 2)).toEqual(['Sam Partner', 'Tia Adviser']);
  expect(names).toContain('Uma Other'); // three parties without a company are not capped as one "company"
  expect(names).toHaveLength(5);
  net.references.forEach((r) => expect(r.reason).toEqual(expect.any(String)));
});

// ------------------------------------------------------------ network-second-degree-investors

describe('investors of companies they founded', () => {
  test('investors given with the company they backed say so', () => {
    const report = { ...REPORT, threads: [...REPORT.threads, { kind: 'company', value: 'Upfit Labs', why: 'founder (past)' }] };
    const net = link.buildNetworkLinks({ report, total: 3, atInvestors: [{ investor: 'Kappa Fund', of: 'Upfit Labs', contact: contact('Ivy Investor', 'Kappa Fund', 'Partner') }] });
    expect(net.groups.find((g) => g.key === 'investors').people[0].why).toBe('Works at Kappa Fund, an investor in Upfit Labs, which Trevor Milton founded');
  });
  test('lookupInvestorsForCompanies: bounded, company names only, a missed one is reported', async () => {
    const loader = jest.fn(async (name) => { if (name === 'Upfit Labs') throw new Error('down'); return { investors: [{ name: `${name} Backer` }] }; });
    const out = await link.lookupInvestorsForCompanies(['Nikola', 'Upfit Labs', 'A', 'B', 'C'], { profileLoader: loader, max: 3 });
    expect(loader.mock.calls.map((c) => c[0])).toEqual(['Nikola', 'Upfit Labs', 'A']);
    expect(out.investors).toEqual([{ name: 'Nikola Backer', of: 'Nikola' }, { name: 'A Backer', of: 'A' }]);
    expect(out.complete).toBe(false);
    expect(out.missed).toEqual(['Upfit Labs']);
  });
  test('networkForReport accepts investors with the company they backed', async () => {
    const s = fakeStore({ findContactsAtCompanies: jest.fn(async (_u, names) => (names.includes('Kappa Fund') ? [contact('Ivy Investor', 'Kappa Fund', 'Partner', { matchedCompany: 'Kappa Fund' })] : [])) });
    const report = { ...REPORT, threads: [...REPORT.threads, { kind: 'company', value: 'Upfit Labs', why: 'founder (past)' }] };
    const net = await link.networkForReport('user-1', report, { store: s, investors: [{ name: 'Kappa Fund', of: 'Upfit Labs' }] });
    expect(net.groups.find((g) => g.key === 'investors').people[0].why).toMatch(/investor in Upfit Labs/);
  });
});

// ------------------------------------------------------------ network-checked-chip-starts-new-check

describe('history: reopen a check instead of starting a new one', () => {
  test('finished checks carry their id and seeded company, within the retention window', async () => {
    db.persistenceMode.mockReturnValue('neon');
    db.query.mockImplementation(async () => [{ id: 'job-1', name: 'Trevor Milton', company: 'Nikola', status: 'done', updated_at: '2026-11-19T10:00:00Z', red_flags: '2', seeded: 'Nikola' }]);
    const checks = await link.listFinishedChecks('user-1');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/updated_at > now\(\) - interval '72 hours'/);
    expect(params[0]).toBe('user-1');
    expect(checks).toEqual([{ id: 'job-1', name: 'Trevor Milton', company: 'Nikola', seededCompany: 'Nikola', status: 'done', date: '2026-11-19T10:00:00.000Z', redFlags: 2, ifRightPerson: null }]);
  });
  test('running checks are listed apart, never another user\'s', async () => {
    const memory = new Map([
      ['a', { id: 'a', owner: 'user-1', name: 'Trevor Milton', company: '', status: 'running', updatedAt: Date.now(), state: { networkSeed: { company: 'Nikola' } } }],
      ['b', { id: 'b', owner: 'user-2', name: 'Other Person', company: '', status: 'running', updatedAt: Date.now(), state: {} }],
      ['c', { id: 'c', owner: 'user-1', name: 'Old Done', company: '', status: 'done', updatedAt: Date.now(), state: { report: { totals: { redFlags: 0 } } } }],
    ]);
    const running = await link.listRunningChecks('user-1', { memory });
    expect(running).toEqual([expect.objectContaining({ id: 'a', status: 'running', seededCompany: 'Nikola', redFlags: null })]);
  });
  test('GET /api/founder/history returns finished and running checks with ids', async () => {
    db.persistenceMode.mockReturnValue('neon');
    db.query.mockImplementation(async (sql) => (/status = 'done'/.test(sql)
      ? [{ id: 'job-1', name: 'Trevor Milton', company: 'Nikola', status: 'done', updated_at: '2026-11-19T10:00:00Z', red_flags: '0' }]
      : [{ id: 'job-2', name: 'Elizabeth Holmes', company: 'Theranos', status: 'running', updated_at: '2026-11-20T10:00:00Z', red_flags: null }]));
    const handler = require('../../../src/pages/api/founder/history').default;
    const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    auth.getUserId.mockResolvedValueOnce('user-1');
    await handler({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checks.map((c) => c.id)).toEqual(['job-1']);
    expect(res.body.running.map((c) => c.id)).toEqual(['job-2']);
    db.query.mock.calls.forEach(([, params]) => expect(params[0]).toBe('user-1'));
  });
});

// ------------------------------------------------------------ the real SQL (PGlite)

describe('the new store queries against a real Postgres (PGlite)', () => {
  const runInNode = (body) => {
    const script = `
      const Module = require('module');
      const fs = require('fs');
      const babel = require('@babel/core');
      const ROOT = ${JSON.stringify(ROOT)};
      const origJs = Module._extensions['.js'];
      Module._extensions['.js'] = function (mod, filename) {
        if (!filename.startsWith(ROOT + '/src/')) return origJs(mod, filename);
        const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), { filename, babelrc: false, configFile: false, presets: [['@babel/preset-env', { targets: { node: 'current' } }]] });
        mod._compile(code, filename);
      };
      (async () => {
        const { PGlite } = require('@electric-sql/pglite');
        const pg = new PGlite(); await pg.waitReady;
        const db = require(ROOT + '/src/server/db');
        const base = { query: async (t, p = []) => (await pg.query(t, p)).rows, exec: async (t) => { await pg.exec(t); } };
        db.__setClientForTests(base);
        await db.query("INSERT INTO users (id) VALUES ('u1'), ('u2')");
        const store = require(ROOT + '/src/server/network/store');
        const out = {};
        ${body}
        process.stdout.write('@@' + JSON.stringify(out));
        await pg.close();
      })().catch((e) => { console.error(e); process.exit(1); });
    `;
    const stdout = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    return JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2));
  };

  test('per-company cap, similar names, title mentions, user scoping', () => {
    const out = runInNode(`
      const big = Array.from({ length: 30 }, (_, i) => ({ name: 'Big ' + String(i).padStart(2, '0'), company: 'Bigco', position: i === 29 ? 'Chief Executive Officer' : 'Engineer' }));
      await store.replaceContacts('u1', 'csv', [
        ...big,
        { name: 'Zed Late', company: 'Nikola Motor Company', position: 'Engineer' },
        { name: 'Pat Former', company: 'Other Fund', position: 'Partner, ex-Theranos' },
        { name: 'Noise', company: 'Nikola Tesla Museum', position: 'Guide' },
      ]);
      await store.replaceContacts('u2', 'csv', [{ name: 'Other User', company: 'Nikola', position: 'ex-Theranos' }]);
      const res = await store.findContactsAtCompanies('u1', ['Bigco', 'Nikola'], { detail: true, similar: true, perCompany: 5 });
      out.names = res.rows.map((r) => r.name + ':' + r.match);
      out.truncated = res.truncated;
      out.titles = (await store.findContactsByTitleMention('u1', ['Theranos'])).map((r) => r.name);
    `);
    expect(out.names).toContain('Zed Late:similar');
    expect(out.names).toContain('Big 29:exact'); // the senior one is kept within the cap
    expect(out.names).not.toContain('Noise:similar');
    expect(out.names.filter((n) => n.startsWith('Big'))).toHaveLength(5);
    expect(out.truncated).toEqual([{ company: 'Bigco', shown: 5, total: 30 }]);
    expect(out.titles).toEqual(['Pat Former']);
  });
});
