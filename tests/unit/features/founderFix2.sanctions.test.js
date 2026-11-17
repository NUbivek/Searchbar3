/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const { offshoreLeaksConnector } = require('../../../src/server/founder/sources/sanctions');

const headers = () => new Map();
function serveIcij(results) {
  setTransport(async (url) => {
    if (!url.includes('offshoreleaks.icij.org')) return { status: 404, headers: headers(), url, text: async () => 'not found' };
    const body = {};
    results.forEach((r, i) => { body[`q${i}`] = { result: r }; });
    return { status: 200, headers: headers(), url, text: async () => JSON.stringify(body) };
  });
}
const ctxFor = (name, company = '') => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}) });
const entity = (id, name) => ({ id, name, description: 'Entity node extracted from the Panama Papers data.', types: [{ name: 'Entity' }] });

beforeEach(() => { __resetCacheForTests(); });
afterEach(() => setTransport());

describe('ICIJ Offshore Leaks: a one-word company name is held as possible', () => {
  test('a match on the core word alone ("Flow Inc." vs FLOW LTD) is possible, not the company', async () => {
    serveIcij([[entity('11', 'FLOW LTD')], [], []]);
    const out = await offshoreLeaksConnector.run({ kind: 'company', value: 'Flow Inc.' }, ctxFor('Jane Roe', 'Flow'));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].match).not.toBe('company');
  });

  test('a one-word name is possible even when the legal form is the same', async () => {
    serveIcij([[entity('12', 'ACME INC')], [], []]);
    const out = await offshoreLeaksConnector.run({ kind: 'company', value: 'Acme, Inc.' }, ctxFor('Jane Roe', 'Acme'));
    expect(out.findings.map((f) => f.match)).toEqual(['possible']);
  });

  test('a company name with two or more distinctive words still matches as the company', async () => {
    serveIcij([[entity('13', 'NORTHWIND TRADERS LIMITED')], [], []]);
    const out = await offshoreLeaksConnector.run({ kind: 'company', value: 'Northwind Traders Inc.' }, ctxFor('Jane Roe', 'Northwind Traders'));
    expect(out.findings.map((f) => f.match)).toEqual(['company']);
  });

  test('a person search is unchanged by the company rule', async () => {
    serveIcij([[{ id: '14', name: 'Jane Roe', description: 'Officer node extracted from the Panama Papers data.', types: [{ name: 'Officer' }] }], []]);
    const out = await offshoreLeaksConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor('Jane Roe'));
    expect(out.findings.map((f) => f.match)).toEqual(['possible']);
  });
});
