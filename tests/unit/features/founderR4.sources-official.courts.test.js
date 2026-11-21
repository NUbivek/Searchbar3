/**
 * Round 4 fixes for src/server/founder/sources/courts.js and courtsMore.js (review 2026-11-21, sources-official.json):
 *   sources-official-private-matter-overbroad   the private-matter list no longer drops a company's class action,
 *                                               a case against Visa, a custody bank, or a debarment order
 *   sources-official-sec-nickname-prefix (same class in the court sources)   a party found only under a diminutive
 *                                               of the first name ("Samuel" for "Sam") is held at likely
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const courts = require('../../../src/server/founder/sources/courts');
const more = require('../../../src/server/founder/sources/courtsMore');

const { PRIVATE_MATTER, courtDocketsConnector, __resetCourtsForTests, holdDiminutive, person } = courts;
const { federalRegisterActionsConnector, __resetCourtsMoreForTests } = more;

const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ctxFor = (subject) => ({ subject, deadline: Date.now() + 30000, known: () => ({}), findings: () => [] });
function fakeNet(route) {
  setTransport(async (url) => {
    const out = route(url, decodeURIComponent(url));
    return out === undefined ? respond('not found', 404) : respond(out);
  });
}

beforeEach(() => { __resetCourtsForTests(); __resetCourtsMoreForTests(); });
afterEach(() => { setTransport(); delete process.env.COURTLISTENER_API_TOKEN; });

describe('sources-official-private-matter-overbroad', () => {
  test('business names that only contain a private word are not private', () => {
    for (const text of ['Nikola Corp. v. Visa U.S.A. Inc.', 'Acme v. Coinbase Custody Trust Company', 'Acme v. Anchorage Digital Custody LLC', 'Real Estate of Texas LLC v. Acme']) {
      expect([text, PRIVATE_MATTER.test(text)]).toEqual([text, false]);
    }
  });

  test('family, estate and immigration matters still are', () => {
    for (const text of ['In re Child Custody of J.D.', 'In re Estate of John Smith', 'Estate of John Smith v. Jones', 'Smith v. Estate of Mary Jones', 'Smith v. Dept. of State (immigrant visa denial)', 'In re custody of the minor', 'Jones, visa petition', 'In the Matter of the Guardianship of Smith']) {
      expect([text, PRIVATE_MATTER.test(text)]).toEqual([text, true]);
    }
  });

  test('company path: the class action with an estate among the parties, and the Visa and custody-bank cases, are kept', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    const base = { court: 'District Court, D. Arizona', court_id: 'azd', dateFiled: '2020-09-15' };
    fakeNet(() => ({ count: 4, results: [
      { ...base, caseName: 'In re Nikola Corporation Securities Litigation', docketNumber: '2:20-cv-1797', docket_absolute_url: '/docket/1/a/', party: ['Nikola Corporation', 'Estate of John Q Investor', 'Trevor Milton'], suitNature: '850 Securities/Commodities' },
      { ...base, caseName: 'Nikola Corp. v. Visa U.S.A. Inc.', docketNumber: '2:21-cv-2', docket_absolute_url: '/docket/2/b/', party: ['Nikola Corp.', 'Visa U.S.A. Inc.'], suitNature: '190 Contract: Other' },
      { ...base, caseName: 'Nikola Corporation v. Anchorage Digital Custody LLC', docketNumber: '2:21-cv-3', docket_absolute_url: '/docket/3/c/', party: ['Nikola Corporation', 'Anchorage Digital Custody LLC'], suitNature: '190 Contract: Other' },
      { ...base, caseName: 'Nikola Corporation v. Lion Electric', docketNumber: '2:21-cv-4', docket_absolute_url: '/docket/4/d/', party: ['Nikola Corporation', 'Lion Electric'], suitNature: '830 Patent' },
    ] }));
    const out = await courtDocketsConnector.run({ kind: 'company', value: 'Nikola', template: 'dockets.company' }, ctxFor(createSubject({ name: 'Trevor Milton', company: 'Nikola' })));
    expect(out.findings).toHaveLength(4);
  });

  test('Federal Register: a debarment order whose abstract mentions psychiatric billing is a public sanction and is kept', async () => {
    fakeNet(() => ({ count: 1, results: [{
      title: 'Jane Roe: Final Debarment Order', abstract: 'The FDA is issuing an order debarring Jane Roe for a conviction related to fraudulent psychiatric billing and visa fraud in a drug product application.',
      html_url: 'https://www.federalregister.gov/d/2', publication_date: '2022-03-01', agencies: [{ slug: 'food-and-drug-administration', name: 'Food and Drug Administration' }],
    }] }));
    const out = await federalRegisterActionsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'orders.name' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Acme Rockets' })));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].severity).toBe('high');
  });
});

describe('court records found under a diminutive of the first name', () => {
  test('holdDiminutive holds a confirmed grade at likely unless the evidence gives the full name', () => {
    const s = createSubject({ name: 'Sam Lowell', company: 'Lowell Robotics' });
    const who = person(s);
    const f = { match: 'confirmed', matchReasons: ['names Lowell Robotics'] };
    expect(holdDiminutive(f, s, who, 'Samuel Lowell')).toMatchObject({ match: 'likely', matchFixed: true });
    expect(holdDiminutive(f, s, who, 'Sam Lowell')).toBe(f);
    expect(holdDiminutive(f, s, who, 'LOWELL, SAM J.')).toBe(f);
  });

  test('CourtListener: a party listed as Samuel Lowell is not confirmed for Sam Lowell', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    fakeNet(() => ({ count: 1, results: [
      { court: 'District Court, D. Delaware', court_id: 'ded', dateFiled: '2021-01-01', caseName: 'Lowell Robotics Inc. v. Samuel Lowell', docketNumber: '1:21-cv-5', docket_absolute_url: '/docket/5/e/', party: ['Lowell Robotics Inc.', 'Samuel Lowell'], suitNature: '190 Contract: Other' },
    ] }));
    const out = await courtDocketsConnector.run({ kind: 'subject', value: 'Sam Lowell', template: 'dockets.party' }, ctxFor(createSubject({ name: 'Sam Lowell', company: 'Lowell Robotics' })));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('likely');
  });
});
