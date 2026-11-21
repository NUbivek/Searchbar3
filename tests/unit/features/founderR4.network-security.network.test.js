/**
 * @jest-environment node
 *
 * Round 4, network-security (src/server/founder/networkLink.js, src/server/network/store.js).
 *  - network-security-seed-company-tie-other: a company the user confirmed from their network is the person's
 *    current company in the pairing (basis 'seed', senior references only, its investors looked up).
 *  - network-security-incomplete-unread: a company lookup cut by its row limit is said in the notes, and the
 *    cut drops the lowest-ranked rows of each company, not the late-alphabet names.
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  persistenceMode: jest.fn(() => 'pglite'),
  PersistenceUnavailableError: class PersistenceUnavailableError extends Error {},
}));

const db = require('../../../src/server/db');
const store = require('../../../src/server/network/store');
const link = require('../../../src/server/founder/networkLink');

const contact = (name, company, position = '') => ({ name, company, position, profileUrl: '', connectedOn: '2020-03-01', source: 'linkedin', relationship: 'direct', via: '' });
const SEEDED = {
  name: 'John Smith',
  company: null,
  profile: null,
  threads: [{ kind: 'company', value: 'Acme Robotics', why: 'the company assumed from your network', trusted: true }],
  relatedParties: [],
};

describe('a company confirmed from the user\'s network', () => {
  test('is the current company: basis seed, juniors are not suggested as references', () => {
    expect(link.companiesOf(SEEDED)).toEqual([expect.objectContaining({ name: 'Acme Robotics', tie: 'current' })]);
    const net = link.buildNetworkLinks({
      report: SEEDED, total: 10, seededCompany: 'Acme Robotics',
      nameMatches: [contact('John Smith', 'Acme Robotics', 'Founder')],
      atCompanies: [contact('Amy Intern', 'Acme Robotics', 'Summer Intern'), contact('Bob Junior', 'Acme Robotics', 'Associate')].map((c) => ({ ...c, matchedCompany: 'Acme Robotics' })),
    });
    expect(net.self).toMatchObject({ basis: 'seed' });
    expect(net.self.note).not.toMatch(/not their current company/);
    expect(net.references.map((r) => r.name)).not.toEqual(expect.arrayContaining(['Amy Intern']));
    expect(net.references.map((r) => r.name)).not.toEqual(expect.arrayContaining(['Bob Junior']));
  });

  test('the report\'s assumed company counts when no thread carries it', () => {
    const report = { name: 'John Smith', company: null, assumedCompany: 'Acme Robotics', threads: [] };
    expect(link.companiesOf(report)).toEqual([expect.objectContaining({ name: 'Acme Robotics', tie: 'current' })]);
    expect(link.investorsOf({ ...report, companyFacts: { investors: [{ name: 'Seed Fund' }] } })).toEqual([{ name: 'Seed Fund', of: 'Acme Robotics' }]);
  });

  test('its investors are looked up: the current company and founded ones, in order', () => {
    expect(link.investorLookupCompanies(SEEDED)).toEqual(['Acme Robotics']);
    expect(link.investorLookupCompanies({ name: 'Jane Doe', company: 'Acme', profile: { founded: [{ org: 'Beta Labs' }, { org: 'Gamma' }, { org: 'Delta' }] } })).toEqual(['Acme', 'Beta Labs', 'Gamma']);
  });
});

describe('a company lookup cut by its limit', () => {
  beforeEach(() => { db.query.mockReset(); db.persistenceMode.mockReturnValue('pglite'); store.__resetForTests(); });

  test('the cut keeps the best-ranked rows of every company, not the first names in the alphabet', async () => {
    db.query.mockImplementation(async () => []);
    await store.findContactsAtCompanies('user-1', ['Google'], { detail: true, similar: true, perCompany: 5 });
    const sql = db.query.mock.calls.map((c) => c[0]).find((q) => /ROW_NUMBER/.test(q));
    expect(sql).toMatch(/ORDER BY rn, company_key/);
  });

  test('networkForReport says so in the notes', async () => {
    const fake = {
      countContacts: async () => 50,
      findContactsByNames: async () => [],
      findContactsByTitleMention: async () => [],
      findContactsAtCompanies: async (userId, names, opts) => (opts.investor
        ? { rows: [], truncated: [], incomplete: false }
        : { rows: [{ ...contact('Zed Zulu', 'Acme Robotics', 'CTO'), matchedCompany: 'Acme Robotics' }], truncated: [], incomplete: true }),
    };
    const net = await link.networkForReport('user-1', { name: 'Jane Doe', company: 'Acme Robotics', threads: [] }, { store: fake });
    expect(net.available).toBe(true);
    expect(net.incomplete).toBe(true);
    expect(net.notes.join(' ')).toMatch(/Not every contact at their companies could be read/);
  });
});
