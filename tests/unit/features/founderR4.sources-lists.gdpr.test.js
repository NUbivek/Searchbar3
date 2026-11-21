/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const { gdprFinesConnector, matchCase, screenedNames, withoutLegalForms, MIN_CASES } = require('../../../src/server/founder/sources/gdprFines');

const row = (e, o) => ({ e, c: 'SWEDEN', C: 'Sweden', a: 'Swedish Authority for Privacy Protection (IMY)', d: '2022-03-31', f: 720000, p: 'Filler', s: 'Finance, Insurance and Consulting', r: 'Art. 5 GDPR', t: 'Insufficient fulfilment of information obligations', ...o });
const CASES = [
  row(1, { p: 'Klarna Bank AB' }),
  row(2, { p: 'Avast Software s.r.o.', f: 13900000, C: 'Czech Republic', c: 'CZECH REPUBLIC' }),
  row(3, { p: 'Deliveroo Italy s.r.l.', f: 2500000, C: 'Italy', c: 'ITALY' }),
  row(4, { p: 'Vinted UAB', f: 2385276, C: 'Lithuania', c: 'LITHUANIA' }),
  row(5, { p: 'Uber B.V.', f: 10000000, C: 'The Netherlands', c: 'THE NETHERLANDS' }),
  ...Array.from({ length: MIN_CASES }, (_, i) => row(1000 + i, { p: `Filler Company ${i} S.A.` })),
];
const PAGE = `<html><body><script type="application/json" id="et-cases">${JSON.stringify(CASES)}</script></body></html>`;

beforeEach(() => {
  __resetCacheForTests();
  setTransport(async (url) => ({ status: 200, headers: { get: () => null }, url, text: async () => PAGE }));
});
afterEach(() => setTransport());

const ctxFor = (company) => ({ subject: createSubject({ name: 'Jane Example', company }), deadline: Date.now() + 20000 });
const names = (company) => screenedNames(createSubject({ name: 'Jane Example', company }), company);

describe('fines against a company written with its EU legal form or a subsidiary word', () => {
  test('legal forms of every EU country are removed from the end only', () => {
    expect(withoutLegalForms('Avast Software s.r.o.')).toBe('Avast Software');
    expect(withoutLegalForms('Vinted UAB')).toBe('Vinted');
    expect(withoutLegalForms('Deliveroo Italy s.r.l.')).toBe('Deliveroo Italy');
    expect(withoutLegalForms('Uber B.V.')).toBe('Uber');
  });

  test.each([
    ['Klarna', 'Klarna Bank AB', 'possible'],
    ['Avast', 'Avast Software s.r.o.', 'possible'],
    ['Deliveroo', 'Deliveroo Italy s.r.l.', 'possible'],
    ['Vinted', 'Vinted UAB', 'company'],
  ])('%s: the case against %s is kept', (company, party, grade) => {
    const hit = matchCase({ p: party }, names(company));
    expect(hit).not.toBeNull();
    expect(hit.strong).toBe(grade === 'company');
  });

  test('"Uber B.V." stays an exact name match (held possible only because Uber is an ordinary word)', () => {
    const hit = matchCase({ p: 'Uber B.V.' }, names('Uber'));
    expect(hit.grade).toBe('exact');
  });

  test('a name that only shares a first word is not read as the company', () => {
    expect(matchCase({ p: 'Klarnaville Foods AB' }, names('Klarna'))).toBeNull();
  });

  test('the report keeps the fine as a name match to verify, never "found no fine"', async () => {
    const out = await gdprFinesConnector.run({ kind: 'company', value: 'Klarna' }, ctxFor('Klarna'));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].title).toMatch(/verify it is the same company/);
    expect(out.notes.join(' ')).not.toMatch(/found no fine/);
  });

  test('a company with its own exact entry under a foreign legal form is the company', async () => {
    const out = await gdprFinesConnector.run({ kind: 'company', value: 'Vinted' }, ctxFor('Vinted'));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
  });
});
