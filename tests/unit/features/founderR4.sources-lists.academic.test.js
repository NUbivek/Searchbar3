/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const { dataciteThesesConnector, nsfAwardsConnector, __resetAcademicMoreForTests } = require('../../../src/server/founder/sources/academicMore');

const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
let fail = false;
beforeEach(() => {
  __resetCacheForTests();
  __resetAcademicMoreForTests({ unpaced: true });
  fail = false;
  setTransport(async (url) => {
    if (fail) return respond('down', 404);
    if (String(url).includes('datacite')) return respond({ data: [], meta: { total: 0 } });
    return respond({ response: { award: [], metadata: { offset: 0, rpp: 25, totalCount: 0 } } });
  });
});
afterEach(() => { setTransport(); jest.restoreAllMocks(); });

const twoDaysOn = () => {
  const later = Date.now() + 2 * 24 * 3600 * 1000;
  jest.spyOn(Date, 'now').mockReturnValue(later);
  return later;
};

test('NSF: "no award" from an older cached answer is marked partial with its date', async () => {
  const subject = createSubject({ name: 'Dana Vance', company: 'Hydra Freight' });
  const fresh = await nsfAwardsConnector.run({ kind: 'company', value: 'Hydra Freight' }, { subject, deadline: Date.now() + 20000, known: () => ({}) });
  expect(fresh.partial).toBeUndefined();
  const later = twoDaysOn();
  fail = true;
  const r = await nsfAwardsConnector.run({ kind: 'company', value: 'Hydra Freight' }, { subject, deadline: later + 20000, known: () => ({}) });
  expect(r.partial.join(' ')).toMatch(/NSF awards \(answer as of \d{4}-\d{2}-\d{2}\)/);
  expect(r.notes.join(' ')).toMatch(/earlier answer/);
});

test('DataCite: the same', async () => {
  const subject = createSubject({ name: 'Dana Vance' });
  await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, { subject, deadline: Date.now() + 20000, known: () => ({}) });
  const later = twoDaysOn();
  fail = true;
  const r = await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, { subject, deadline: later + 20000, known: () => ({}) });
  expect(r.partial.join(' ')).toMatch(/University theses \(DataCite\) \(answer as of/);
});
