/**
 * Founder Check paired with the user's own network: name matching and
 * collisions, the companies and people read from a report, ranking, the
 * reference shortlist, the store's user scoping, the no-company seeding rule
 * (and that only a contact's company can reach a search), and the history
 * of finished checks. All data here is synthetic; the database is faked.
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
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null), chatJson: jest.fn(async () => null), llmConfigured: () => false, PROVIDERS: [], providerEnabled: () => false }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [] })) }));
// Every lookup the deep check runs is recorded, so the test can see which words went out.
const mockTasks = [];
jest.mock('../../../src/server/founder/sources', () => ({
  CONNECTORS: [{
    id: 'fake', label: 'Fake registry', kinds: ['subject', 'company'],
    run: async (task) => { mockTasks.push(JSON.parse(JSON.stringify(task))); return { findings: [], threads: [] }; },
  }],
}));

const db = require('../../../src/server/db');
const auth = require('../../../src/server/auth');
const store = require('../../../src/server/network/store');
const link = require('../../../src/server/founder/networkLink');
const { __resetJobsForTests } = require('../../../src/server/founder/jobStore');
const { __resetLearningForTests } = require('../../../src/server/learning');

const contact = (name, company, position = '', extra = {}) => ({ name, company, position, profileUrl: '', connectedOn: '2020-03-01', source: 'linkedin', relationship: 'direct', via: '', ...extra });

const REPORT = {
  name: 'Jane Doe',
  company: 'Acme Robotics',
  profile: { company: 'Acme Robotics', earlier: [{ org: 'Expanse', role: 'Chief of Staff' }], education: [], about: [], links: [] },
  threads: [
    { kind: 'company', value: 'Acme Robotics', why: 'the company given' },
    { kind: 'company', value: 'Beta Labs', why: 'founder (past; Wikidata)' },
    { kind: 'company', value: 'Gamma Bank', why: 'board member' },
    { kind: 'company', value: 'Delta Holdings', why: 'holding vehicle that files insider reports together with the person (Acme)' },
    { kind: 'associate', value: 'Sam Lee', why: 'co-founder', relation: 'co-founder' },
  ],
  relatedParties: [{ name: 'Sam Lee', kind: 'associate', relation: 'co-founder', role: 'CTO', records: [] }],
};

beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async () => []);
  db.persistenceMode.mockReturnValue('pglite');
  store.__resetForTests();
});

// ------------------------------------------------------------ names

describe('names', () => {
  test('a full name matches with or without a middle initial, accents, a degree or a nickname', () => {
    expect(link.sameName('Jane Q. Doe', 'Jane Doe')).toBe(true);
    expect(link.sameName('Jane Doe, MBA', 'jane doe')).toBe(true);
    expect(link.sameName('Jane (JD) Doe', 'Jane Doe')).toBe(true);
    expect(link.sameName('José García', 'Jose Garcia')).toBe(true);
    expect(link.sameName('Dr. Jane Doe', 'Jane Doe')).toBe(true);
  });
  test('a first name, a surname or a longer name never matches', () => {
    expect(link.sameName('Jane', 'Jane Doe')).toBe(false);
    expect(link.sameName('Jane Doer', 'Jane Doe')).toBe(false);
    expect(link.sameName('Jane Mary Doe', 'Jane Doe')).toBe(false);
    expect(link.sameName('John Doe', 'Jane Doe')).toBe(false);
  });
});

// ------------------------------------------------------------ the report

describe('reading the report', () => {
  test('companies: current, founded, earlier and other ties; loose ties are left out', () => {
    const cos = link.companiesOf(REPORT);
    const by = Object.fromEntries(cos.map((c) => [c.name, c]));
    expect(by['Acme Robotics'].tie).toBe('current');
    expect(by['Beta Labs'].tie).toBe('founded');
    expect(by.Expanse).toMatchObject({ tie: 'earlier', role: 'Chief of Staff' });
    // a board seat is its own tie now (audit 2026-11-20, network-profile-roles-ignored)
    expect(by['Gamma Bank'].tie).toBe('board');
    expect(by['Delta Holdings']).toBeUndefined();
    expect(cos.filter((c) => c.name === 'Acme Robotics')).toHaveLength(1);
  });
  test('parties: related parties and associates, once each', () => {
    expect(link.partiesOf(REPORT)).toEqual([{ name: 'Sam Lee', relation: 'co-founder', role: 'CTO' }]);
  });
});

// ------------------------------------------------------------ in your network

describe('in your network', () => {
  test('several contacts share the name: the one at their company is them, the other is listed apart', () => {
    const net = link.buildNetworkLinks({ report: REPORT, total: 10, nameMatches: [contact('Jane Doe', 'Acme Robotics', 'CEO'), contact('Jane Doe', 'Bakery Co', 'Baker')] });
    expect(net.self).toMatchObject({ name: 'Jane Doe', company: 'Acme Robotics', basis: 'company' });
    expect(net.sameNameContacts).toEqual([expect.objectContaining({ company: 'Bakery Co' })]);
  });
  test('several namesakes and none at their companies: nobody is merged', () => {
    const net = link.buildNetworkLinks({ report: REPORT, total: 10, nameMatches: [contact('Jane Doe', 'Bakery Co'), contact('Jane Doe', 'Florist Ltd')] });
    expect(net.self).toBeNull();
    expect(net.sameNameContacts).toHaveLength(2);
  });
  test('one namesake at a different current company is not taken for them', () => {
    const net = link.buildNetworkLinks({ report: REPORT, total: 10, nameMatches: [contact('Jane Doe', 'Bakery Co')] });
    expect(net.self).toBeNull();
    expect(net.sameNameContacts).toHaveLength(1);
  });
  test('one namesake and no company known: shown, with a note to confirm', () => {
    const net = link.buildNetworkLinks({ report: { name: 'Jane Doe' }, total: 10, nameMatches: [contact('Jane Doe', 'Bakery Co')] });
    expect(net.self).toMatchObject({ basis: 'name' });
    expect(net.self.note).toMatch(/confirm/);
  });
  test('contacts who only share a surname are ignored', () => {
    const net = link.buildNetworkLinks({ report: REPORT, total: 10, nameMatches: [contact('John Doe', 'Acme Robotics')] });
    expect(net.self).toBeNull();
    expect(net.sameNameContacts).toEqual([]);
  });
});

// ------------------------------------------------------------ people around them

describe('people around them', () => {
  const atCompanies = [
    contact('Ann Junior', 'Acme Robotics', 'Software Engineer', { matchedCompany: 'Acme Robotics' }),
    contact('Cara Chief', 'Acme Robotics', 'Chief Operating Officer', { matchedCompany: 'Acme Robotics' }),
    contact('Jane Doe', 'Acme Robotics', 'CEO', { matchedCompany: 'Acme Robotics' }),
    contact('Fred Firm', 'Expanse', 'CEO', { relationship: 'firm', via: 'Pat Partner', matchedCompany: 'Expanse' }),
    contact('Eve Engineer', 'Expanse', 'Engineer', { matchedCompany: 'Expanse' }),
    contact('Dan Director', 'Expanse', 'Director of Sales', { matchedCompany: 'Expanse' }),
    contact('Bob Builder', 'Beta Labs', 'Engineer', { matchedCompany: 'Beta Labs' }),
    contact('Gus Board', 'Gamma Bank', 'Analyst', { matchedCompany: 'Gamma Bank' }),
    contact('Sam Lee', 'Zeta AI', 'CTO', { matchedCompany: 'Beta Labs' }),
  ];
  const net = link.buildNetworkLinks({
    report: REPORT,
    total: 500,
    nameMatches: [contact('Jane Doe', 'Acme Robotics', 'CEO')],
    atCompanies,
    partyMatches: [contact('Sam Lee', 'Zeta AI', 'CTO')],
    atInvestors: [{ investor: 'Omega Ventures', contact: contact('Ivy Investor', 'Omega Ventures', 'General Partner') }],
    investorsChecked: ['Omega Ventures'],
  });
  const group = (key) => net.groups.find((g) => g.key === key);

  test('grouped by how they relate, with counts; the person themself is not listed', () => {
    expect(net.groups.map((g) => g.key)).toEqual(['current', 'earlier', 'founded', 'board', 'parties', 'investors']);
    expect(group('current').people.map((p) => p.name)).toEqual(['Cara Chief', 'Ann Junior']);
    expect(group('founded').people.map((p) => p.name)).toEqual(['Bob Builder']);
    expect(group('parties').people.map((p) => p.name)).toEqual(['Sam Lee']);
    expect(group('investors').people.map((p) => p.name)).toEqual(['Ivy Investor']);
    expect(net.counts).toMatchObject({ people: 9, direct: 8 });
  });
  test('direct contacts before firm contacts, then senior titles first', () => {
    expect(group('earlier').people.map((p) => p.name)).toEqual(['Dan Director', 'Eve Engineer', 'Fred Firm']);
    expect(group('earlier').people[2]).toMatchObject({ relationship: 'firm', via: 'Pat Partner' });
  });
  test('each person says why they matter', () => {
    expect(group('earlier').people[0].why).toBe('Works at Expanse, where Jane Doe was Chief of Staff');
    expect(group('founded').people[0].why).toBe('Works at Beta Labs, which Jane Doe founded');
    expect(group('parties').people[0].why).toBe("Named in this check as Jane's co-founder (CTO)");
    expect(group('investors').people[0].why).toBe('Works at Omega Ventures, an investor in Acme Robotics');
  });
  test('seniority reuses the Network Map role groups', () => {
    expect(link.seniority('Co-Founder & CEO')).toBe(3);
    expect(link.seniority('VP Engineering')).toBe(2);
    expect(link.seniority('Senior Engineer')).toBe(1);
    expect(link.seniority('Engineer')).toBe(0);
  });
  // Ranked by how well each is placed to know them (audit 2026-11-20, network-shortlist-ranking):
  // the named co-founder first, then a company they founded, then former colleagues.
  test('reference shortlist: five, best placed first, at most two per company, no junior current colleague', () => {
    const names = net.references.map((r) => r.name);
    expect(names).toEqual(['Sam Lee', 'Bob Builder', 'Dan Director', 'Eve Engineer', 'Gus Board']);
    expect(names).not.toContain('Fred Firm'); // third at Expanse
    expect(names).not.toContain('Ann Junior');
    expect(net.references.find((r) => r.name === 'Dan Director').ask).toMatch(/Chief of Staff/);
    net.references.forEach((r) => expect(r.ask).toEqual(expect.any(String)));
  });
  test('only current colleagues: no junior one is suggested, and the page says why', () => {
    const only = link.buildNetworkLinks({ report: REPORT, total: 5, atCompanies: [contact('Ann Junior', 'Acme Robotics', 'Engineer', { matchedCompany: 'Acme Robotics' })] });
    expect(only.references).toEqual([]);
    expect(only.notes.join(' ')).toMatch(/not independent/);
    const senior = link.buildNetworkLinks({ report: REPORT, total: 5, atCompanies: [contact('Cara Chief', 'Acme Robotics', 'Chief Operating Officer', { matchedCompany: 'Acme Robotics' }), contact('Carl Chair', 'Acme Robotics', 'VP Sales', { matchedCompany: 'Acme Robotics' })] });
    expect(senior.references.map((r) => r.name)).toEqual(['Cara Chief']);
  });
  test('the per-group list is capped, the count is not', () => {
    const many = Array.from({ length: 40 }, (_, i) => contact(`Person ${String.fromCharCode(65 + (i % 26))}${i} Smith`, 'Expanse', 'Engineer', { matchedCompany: 'Expanse' }));
    const big = link.buildNetworkLinks({ report: REPORT, total: 40, atCompanies: many });
    expect(big.groups[0]).toMatchObject({ key: 'earlier', total: 40 });
    expect(big.groups[0].people).toHaveLength(link.MAX_PER_GROUP);
  });
});

// ------------------------------------------------------------ the store

describe('store.findContactsByNames', () => {
  test('scoped to the user, narrowed by surname, never selects email or location', async () => {
    db.query.mockImplementation(async (sql) => (/SELECT name, company/.test(sql) ? [{ name: 'Jane Doe', company: 'Acme', position: 'CEO', profile_url: 'https://x.test/jd', connected_on: '2021-01-02', source: 'linkedin', relationship: null, via: null }] : []));
    const rows = await store.findContactsByNames('user-1', ['Jane Doe', 'José García']);
    const call = db.query.mock.calls.find(([sql]) => /SELECT name, company/.test(sql));
    expect(call[0]).toMatch(/WHERE user_id = \$1/);
    expect(call[0]).not.toMatch(/email|location/);
    expect(call[1][0]).toBe('user-1');
    // first and last word of each name, folded (no accents), as whole words
    expect(call[1][1]).toEqual(['% jane %', '% jose %']);
    expect(call[1][4]).toEqual(['% doe %', '% garcia %']);
    expect(rows[0]).toEqual({ name: 'Jane Doe', company: 'Acme', position: 'CEO', profileUrl: 'https://x.test/jd', connectedOn: '2021-01-02', source: 'linkedin', relationship: 'direct', via: '' });
  });
  test('nothing without a user, without persistence, or for a one-word name', async () => {
    expect(await store.findContactsByNames(null, ['Jane Doe'])).toEqual([]);
    expect(await store.findContactsByNames('user-1', ['Jane'])).toEqual([]);
    db.persistenceMode.mockReturnValue('none');
    expect(await store.findContactsByNames('user-1', ['Jane Doe'])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
  test('titles and degrees are not taken for the first or last word', async () => {
    db.query.mockImplementation(async () => []);
    await store.findContactsByNames('user-1', ['Dr. Wei Li PhD', "Seán O'Neil-Ruiz (Sean)", 'Doe, Jane']);
    const call = db.query.mock.calls.find(([sql]) => /SELECT name, company/.test(sql));
    expect(call[1][1]).toEqual(['% wei %', '% sean %']);
    expect(call[1][4]).toEqual(['% li %', '% oneil-ruiz %']);
  });
  test('a failed lookup, or one cut off at the row limit, throws instead of passing a partial list as complete', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.query.mockImplementation(async (sql) => { if (/SELECT name, company/.test(sql)) throw new Error('db down'); return []; });
    await expect(store.findContactsByNames('user-1', ['Wei Li'])).rejects.toThrow('db down');
    const many = Array.from({ length: store.NAME_MATCH_LIMIT + 1 }, (_, i) => ({ name: `Wei Li ${i}`, company: `Co ${i}` }));
    db.query.mockImplementation(async (sql) => {
      if (/SELECT name, company, position, profile_url/.test(sql)) return many;
      if (/COUNT\(\*\)/.test(sql)) return [{ n: 5000 }];
      return [];
    });
    await expect(store.findContactsByNames('user-1', ['Wei Li'])).rejects.toThrow(/more than/);
    // the callers treat that as "could not be read": no seed, and no "not one of your contacts"
    expect(await link.companySeed('user-1', 'Wei Li', '')).toBeNull();
    // the parts that did read are still shown, and the failed one is named (audit 2026-11-20, network-all-or-nothing)
    const net = await link.networkForReport('user-1', { ...REPORT, name: 'Wei Li' });
    expect(net.self).toBeNull();
    expect(net.failed.self).toBe(true);
    expect(net.notes.join(' ')).toMatch(/could not be read/);
    console.warn.mockRestore();
  });
});

// ------------------------------------------------------------ seeding and the full pairing

const fakeStore = (byName = [], { count = 10 } = {}) => ({
  countContacts: jest.fn(async () => count),
  findContactsByNames: jest.fn(async () => byName),
  findContactsAtCompanies: jest.fn(async () => []),
});

describe('companySeed', () => {
  test('a typed company is never replaced, and the network is not read', async () => {
    const s = fakeStore([contact('Jane Doe', 'Acme')]);
    expect(await link.companySeed('user-1', 'Jane Doe', 'Typed Co', { store: s })).toBeNull();
    expect(s.findContactsByNames).not.toHaveBeenCalled();
  });
  test('exactly one contact with the full name: only their company comes back', async () => {
    const s = fakeStore([contact('Jane Doe', 'Acme Robotics', 'CEO', { email: 'jane@acme.test', location: 'Oakland', profileUrl: 'https://x.test/jd' }), contact('John Doe', 'Other')]);
    // only after the user said yes to the question (audit 2026-11-20, network-seed-namesake-anchors-check)
    expect(await link.companySeed('user-1', 'Jane Doe', '', { store: s })).toBeNull();
    const seed = await link.companySeed('user-1', 'Jane Doe', '', { store: s, confirmedCompany: 'Acme Robotics' });
    expect(seed).toEqual({ company: 'Acme Robotics', origin: 'network' });
    expect(s.findContactsByNames).toHaveBeenCalledWith('user-1', ['Jane Doe']);
  });
  test('two contacts with the name, or one without a company: no seed', async () => {
    expect(await link.companySeed('user-1', 'Jane Doe', '', { store: fakeStore([contact('Jane Doe', 'A'), contact('Jane Doe', 'B')]) })).toBeNull();
    expect(await link.companySeed('user-1', 'Jane Doe', '', { store: fakeStore([contact('Jane Doe', '')]) })).toBeNull();
  });
  test('never for a signed-out visitor', async () => {
    const s = fakeStore([contact('Jane Doe', 'Acme')]);
    expect(await link.companySeed('anon:abc', 'Jane Doe', '', { store: s })).toBeNull();
    expect(await link.companySeed(null, 'Jane Doe', '', { store: s })).toBeNull();
    expect(s.findContactsByNames).not.toHaveBeenCalled();
  });
});

describe('networkForReport', () => {
  test('signed out, no persistence, or no contacts: an empty state pointing to the Network Map tab', async () => {
    expect((await link.networkForReport(null, REPORT)).available).toBe(false);
    expect((await link.networkForReport('anon:x', REPORT, { store: fakeStore() })).available).toBe(false);
    const none = await link.networkForReport('user-1', REPORT, { store: fakeStore([], { count: 0 }) });
    expect(none).toEqual({ available: false, reason: expect.stringMatching(/Network Map/) });
  });
  test('every read is the signed-in user\'s, and no email or location reaches the result', async () => {
    const s = fakeStore([contact('Jane Doe', 'Acme Robotics', 'CEO', { email: 'jane@acme.test', location: 'Oakland' })]);
    s.findContactsAtCompanies.mockImplementation(async (_u, names) => (names.includes('Expanse') ? [contact('Dan Director', 'Expanse', 'Director', { matchedCompany: 'Expanse', email: 'dan@x.test', location: 'Austin' })] : []));
    const net = await link.networkForReport('user-1', REPORT, { store: s, investors: ['Omega Ventures'] });
    for (const mock of [s.countContacts, s.findContactsByNames, s.findContactsAtCompanies]) mock.mock.calls.forEach((c) => expect(c[0]).toBe('user-1'));
    expect(s.findContactsAtCompanies).toHaveBeenCalledWith('user-1', ['Omega Ventures'], expect.objectContaining({ investor: true }));
    expect(net.self).toMatchObject({ name: 'Jane Doe' });
    expect(net.references[0].name).toBe('Dan Director');
    const text = JSON.stringify(net);
    expect(text).not.toMatch(/acme\.test|x\.test|Oakland|Austin/);
  });
  test('the seeded company is reported', async () => {
    const net = await link.networkForReport('user-1', REPORT, { store: fakeStore(), seededCompany: 'Acme Robotics' });
    expect(net.seededCompany).toBe('Acme Robotics');
  });
});

describe('lookupInvestors', () => {
  test('only the company name goes out; investors and round leads come back', async () => {
    const loader = jest.fn(async () => ({ investors: [{ name: 'Omega Ventures' }], fundingRounds: [{ round: 'Seed', leadInvestors: ['Sigma Capital'] }] }));
    expect(await link.lookupInvestors('Acme Robotics', { profileLoader: loader })).toEqual(['Omega Ventures', 'Sigma Capital']);
    expect(loader).toHaveBeenCalledWith('Acme Robotics');
    expect(await link.lookupInvestors('', { profileLoader: loader })).toEqual([]);
  });
  test('a lookup that runs out of its share of time, fails, or has no time to start is reported as missed, not as "no investors"', async () => {
    jest.useFakeTimers();
    try {
      const slow = link.lookupInvestorsResult('Acme Robotics', { profileLoader: () => new Promise(() => {}), timeoutMs: 5000 });
      await jest.advanceTimersByTimeAsync(5000);
      expect(await slow).toEqual({ investors: [], complete: false });
    } finally {
      jest.useRealTimers();
    }
    expect(await link.lookupInvestorsResult('Acme Robotics', { profileLoader: async () => { throw new Error('down'); } })).toEqual({ investors: [], complete: false });
    expect(await link.lookupInvestorsResult('Acme Robotics', { profileLoader: async () => ({ investors: [] }), timeoutMs: 200 })).toEqual({ investors: [], complete: false });
    expect(await link.lookupInvestorsResult('Acme Robotics', { profileLoader: async () => ({ investors: [] }), timeoutMs: NaN })).toEqual({ investors: [], complete: false });
    // a finished lookup that found none is complete
    expect(await link.lookupInvestorsResult('Acme Robotics', { profileLoader: async () => ({ investors: [] }) })).toEqual({ investors: [], complete: true });
  });
  test('when the investor lookup was missed, the pairing says so instead of reading as nobody at their investors', async () => {
    const missed = await link.networkForReport('user-1', REPORT, { store: fakeStore(), investorsMissed: true });
    expect(missed.notes).toContain(link.INVESTORS_MISSED_NOTE);
    expect(link.INVESTORS_MISSED_NOTE).not.toMatch(/\b(?:api|key|token|free|paid|tier|quota)\b/i);
    const fine = await link.networkForReport('user-1', REPORT, { store: fakeStore() });
    expect(fine.notes).not.toContain(link.INVESTORS_MISSED_NOTE);
  });
});

// ------------------------------------------------------------ history

describe('listFinishedChecks', () => {
  test('hosted database: one query scoped to the user', async () => {
    db.persistenceMode.mockReturnValue('neon');
    db.query.mockImplementation(async () => [
      { name: 'Jane Doe', company: 'Acme', updated_at: '2026-11-19T10:00:00Z', red_flags: '2' },
      { name: 'jane doe', company: 'ACME', updated_at: '2026-11-18T10:00:00Z', red_flags: '1' },
    ]);
    const checks = await link.listFinishedChecks('user-1');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE user_id = \$1 AND status = 'done'/);
    expect(params[0]).toBe('user-1');
    expect(checks).toEqual([{ id: null, name: 'Jane Doe', company: 'Acme', seededCompany: null, status: 'done', date: '2026-11-19T10:00:00.000Z', redFlags: 2, ifRightPerson: null }]);
  });
  test('kept in memory: another user\'s checks are never listed', async () => {
    // Recent times: a check older than the job store's retention (72 hours) is not listed (needs-phase2 entry 47).
    const now = Date.now();
    const memory = new Map([
      ['a', { owner: 'user-1', name: 'Jane Doe', company: '', status: 'done', updatedAt: now - 2000, state: { report: { totals: { redFlags: 0 } } } }],
      ['b', { owner: 'user-2', name: 'Other Person', company: '', status: 'done', updatedAt: now - 1000, state: { report: { totals: { redFlags: 4 } } } }],
      ['c', { owner: 'user-1', name: 'Run Ning', company: '', status: 'running', updatedAt: now, state: {} }],
    ]);
    expect((await link.listFinishedChecks('user-1', { memory })).map((c) => c.name)).toEqual(['Jane Doe']);
    expect(await link.listFinishedChecks(null, { memory })).toEqual([]);
    expect(await link.listFinishedChecks('anon:x', { memory })).toEqual([]);
  });
  test('GET /api/founder/history needs sign-in', async () => {
    const handler = require('../../../src/pages/api/founder/history').default;
    const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    auth.getUserId.mockResolvedValueOnce(null);
    await handler({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(401);
  });
});

// ------------------------------------------------------------ the deep check route

describe('POST /api/founder/deep with a network', () => {
  const handler = require('../../../src/pages/api/founder/deep').default;
  function call(body) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200, headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, body: payload }); },
      };
      handler({ method: 'POST', body, query: {}, headers: {}, socket: {} }, res);
    });
  }
  // The user's saved contacts, as the database would return them (with every field).
  const ROWS = [{ name: 'Jane Doe', company: 'Acme Robotics', position: 'Secret Title', email: 'jane@private.test', location: 'Hidden City', profile_url: 'https://profiles.test/jane-doe-private', connected_on: '2019-05-05', source: 'linkedin', relationship: null, via: null }];
  beforeEach(() => {
    __resetJobsForTests(); __resetLearningForTests(); mockTasks.length = 0;
    auth.getUserId.mockResolvedValue('user-1');
    db.query.mockImplementation(async (sql) => {
      if (/COUNT\(\*\)::int AS n FROM network_contacts/.test(sql)) return [{ n: 1 }];
      if (/FROM network_contacts/.test(sql) && /SELECT name, company/.test(sql)) return ROWS; // the name lookup (and the company lookup, which only finds her again)
      return [];
    });
  });
  const leaked = (text) => /private\.test|Hidden City|Secret Title|profiles\.test/.test(text);

  // A namesake contact never anchors a check without the user's yes (audit 2026-11-20,
  // network-seed-namesake-anchors-check): the check starts without the contact's company.
  test('no company typed and one contact with the name: the contact\'s company is not used silently, and nothing of theirs goes out', async () => {
    const started = await call({ action: 'start', name: 'Jane Doe', company: '' });
    expect(started.status).toBe(200);
    expect(mockTasks.length).toBeGreaterThan(0);
    const sent = JSON.stringify(mockTasks);
    expect(sent).not.toMatch(/Acme Robotics/);
    expect(leaked(sent)).toBe(false);
    // finish the check: the report carries the pairing, and still no private field
    let r = started;
    for (let i = 0; i < 30 && !r.body.done; i += 1) r = await call({ action: 'step', jobId: started.body.jobId });
    expect(r.body.done).toBe(true);
    expect(r.body.report.network).toMatchObject({ available: true, seededCompany: null });
    expect(leaked(JSON.stringify(mockTasks))).toBe(false);
  });

  test('a typed company is kept as typed', async () => {
    await call({ action: 'start', name: 'Jane Doe', company: 'Typed Co' });
    const sent = JSON.stringify(mockTasks);
    expect(sent).toMatch(/Typed Co/);
    expect(sent).not.toMatch(/Acme Robotics/);
  });

  test('a signed-out (public) check never reads the network', async () => {
    process.env.FOUNDER_DEEP_PUBLIC = 'true';
    auth.getUserId.mockResolvedValue(null);
    try {
      await call({ action: 'start', name: 'Jane Doe', company: '' });
      expect(db.query.mock.calls.some(([sql]) => /network_contacts/.test(sql))).toBe(false);
      expect(JSON.stringify(mockTasks)).not.toMatch(/Acme Robotics/);
    } finally {
      delete process.env.FOUNDER_DEEP_PUBLIC;
    }
  });
});

// ------------------------------------------------------------ the report section

describe('NetworkLinks on the report', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const NetworkLinks = require('../../../src/components/founder/NetworkLinks').default;
  const FORBIDDEN = /\b(?:api|key|token|free|paid|tier|quota)\b/i;

  test('empty state points to the Network Map tab', () => {
    const html = renderToStaticMarkup(React.createElement(NetworkLinks, { network: { available: false, reason: 'Import your network in the Network Map tab to see who you know around this person.' }, name: 'Jane Doe' }));
    expect(html).toMatch(/Network Map/);
    expect(html).toMatch(/href="\/network"/);
  });

  test('shows the match, the groups and the reference calls in plain words', () => {
    const net = link.buildNetworkLinks({
      report: REPORT, total: 12, seededCompany: 'Acme Robotics',
      nameMatches: [contact('Jane Doe', 'Acme Robotics', 'CEO', { profileUrl: 'https://profiles.test/jd' }), contact('Jane Doe', 'Bakery Co')],
      atCompanies: [contact('Dan Director', 'Expanse', 'Director of Sales', { matchedCompany: 'Expanse' }), contact('Fred Firm', 'Expanse', 'CEO', { relationship: 'firm', via: 'Pat Partner', matchedCompany: 'Expanse' })],
    });
    const html = renderToStaticMarkup(React.createElement(NetworkLinks, { network: net, name: 'Jane Doe' }));
    expect(html).toMatch(/In your network/);
    expect(html).toMatch(/A contact with this name/);
    expect(html).toMatch(/used Acme Robotics, the company of the one contact in your network/);
    expect(html).toMatch(/People you know around them/);
    expect(html).toMatch(/Who to call for a reference/);
    expect(html).toMatch(/via Pat Partner/);
    expect(html).toMatch(/connected Mar 2020/);
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(FORBIDDEN);
  });
});
