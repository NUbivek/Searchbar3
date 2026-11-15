/**
 * Fixes from the review of the courts connectors: associates, company
 * headlines, CFTC release types and the replaced fallback docket search.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const {
  courtRecordsOpenConnector, courtDocketsConnector, dojConnector, enforcementActionsConnector, __resetCourtsForTests,
} = require('../../../src/server/founder/sources/courts');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function fakeNet(routes) {
  setTransport(async (url) => {
    const hit = routes.find(([part]) => url.includes(part));
    return hit ? respond(hit[1]) : respond('not found', 404);
  });
}
const doj = (results) => ({ metadata: { resultset: { count: results.length } }, results });
const release = (over) => ({ title: 'x', date: '1703116800', url: 'https://www.justice.gov/x', teaser: '', body: '', number: '1', component: [], ...over });
const cftc = (rows) => `<table><tbody>${rows.map(([d, href, t]) => `<tr><td><time datetime="${d}">x</time></td><td><a href="${href}">${t}</a></td></tr>`).join('')}</tbody></table>`;

beforeEach(() => __resetCourtsForTests());
afterEach(() => {
  setTransport();
  delete process.env.COURTLISTENER_API_TOKEN;
});

test('the open docket search says it is replaced by the fuller one when that one is on', () => {
  expect(courtRecordsOpenConnector.replacedBy).toBe(courtDocketsConnector.id);
  process.env.COURTLISTENER_API_TOKEN = 'x';
  expect(courtRecordsOpenConnector.enabled()).toBe(false);
});

test('DOJ associate: a release naming the associate and only a company of the subject is not reported', async () => {
  fakeNet([['justice.gov', doj([
    release({ title: 'Nikola Supplier Executive Charged', teaser: 'Mark Russell, who sold parts to Nikola Corporation, was charged with tax evasion.', url: 'https://www.justice.gov/a' }),
  ])]]);
  const out = await dojConnector.run({ kind: 'associate', value: 'Mark Russell', template: 'title.associate' }, ctxFor(createSubject({ name: 'Trevor Milton', company: 'Nikola' })));
  expect(out.findings).toHaveLength(0);
});

test('DOJ company: the core word in a headline is not the company; the full name or a case side is', async () => {
  fakeNet([['justice.gov', doj([
    release({ title: 'Man Sentenced for Community Development Block Grant Fraud', teaser: 'A man was sentenced for fraud.', url: 'https://www.justice.gov/grant' }),
  ])]]);
  const block = await dojConnector.run({ kind: 'company', value: 'Block', template: 'title.company' }, ctxFor(createSubject({ name: 'Jack Dorsey', company: 'Block' })));
  expect(block.findings).toHaveLength(0);

  fakeNet([['justice.gov', doj([
    release({ title: 'Nikola Corporation Agrees to Pay $125 Million to Resolve Fraud Charges', teaser: 'The company agreed to pay.', url: 'https://www.justice.gov/nikola' }),
  ])]]);
  const nikola = await dojConnector.run({ kind: 'company', value: 'Nikola Corporation', template: 'title.company' }, ctxFor(createSubject({ name: 'Trevor Milton', company: 'Nikola Corporation' })));
  expect(nikola.findings).toHaveLength(1);
  expect(nikola.findings[0].match).toBe('company');
});

test('CFTC company: the core word inside a phrase is not the company, and the company is not added to the graded text', async () => {
  fakeNet([
    ['cftc.gov', cftc([['2024-01-01T00:00:00Z', '/PressRoom/PressReleases/1-24', 'CFTC Charges John Smith in Cash Flow Scheme']])],
    ['consumerfinance.gov', '<div>enforcement</div>'],
  ]);
  const out = await enforcementActionsConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'John Smith', company: 'Flow' })));
  expect(out.findings).toHaveLength(0);
});

test('CFTC: releases that are not enforcement actions are dropped; charges stay medium', async () => {
  fakeNet([
    ['cftc.gov', cftc([
      ['2022-11-01T00:00:00Z', '/PressRoom/PressReleases/1-22', 'CFTC Seeks Public Comment on FTX Request for Amended DCO Registration Order'],
      ['2022-12-21T00:00:00Z', '/PressRoom/PressReleases/8644-22', 'CFTC Charges FTX Trading Ltd. with Fraud'],
    ])],
    ['consumerfinance.gov', '<div>enforcement</div>'],
  ]);
  const out = await enforcementActionsConnector.run({ kind: 'company', value: 'FTX Trading Ltd.' }, ctxFor(createSubject({ name: 'Sam Bankman-Fried', company: 'FTX Trading Ltd.' })));
  expect(out.findings.map((f) => f.url)).toEqual(['https://www.cftc.gov/PressRoom/PressReleases/8644-22']);
  expect(out.findings[0].severity).toBe('medium');

  fakeNet([['cftc.gov', cftc([
    ['2023-05-01T00:00:00Z', '/PressRoom/PressReleases/2-23', 'Sam Bankman-Fried Speaks at CFTC Technology Advisory Committee'],
  ])]]);
  const person = await enforcementActionsConnector.run({ kind: 'subject', value: 'Sam Bankman-Fried' }, ctxFor(createSubject({ name: 'Sam Bankman-Fried', company: 'FTX' })));
  expect(person.findings).toHaveLength(0);
});
