/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { fdaRecallsConnector, __resetGovernmentForTests } = require('../../../src/server/founder/sources/government');

const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const notFound = { __status: 404, body: '{"error":{"code":"NOT_FOUND","message":"No matches found!"}}' };
const recall = (firm) => ({ status: 'Terminated', state: 'CA', classification: 'Class II', recalling_firm: firm, recall_number: `Z-${firm.length}-2025`, reason_for_recall: 'Label error.', report_date: '20240101' });

beforeEach(() => __resetGovernmentForTests({ unpaced: true }));
afterEach(() => setTransport());

test('an FDA recall by the company name plus general words is a name match to verify, not dropped', async () => {
  setTransport(async (url) => {
    if (String(url).includes('/device/enforcement.json')) {
      return respond({ meta: { results: { total: 2 } }, results: [recall('Kestrelline Medical Devices, Inc.'), recall('Kestrelline Cafe Ltd')] });
    }
    return respond(notFound.body, 404);
  });
  const r = await fdaRecallsConnector.run({ kind: 'company', value: 'Kestrelline' }, { subject: createSubject({ name: 'Dana Quillfeather', company: 'Kestrelline' }), deadline: Date.now() + 20000, known: () => ({}) });
  expect(r.findings).toHaveLength(1);
  expect(r.findings[0].match).toBe('possible');
  expect(r.findings[0].title).toMatch(/Kestrelline Medical Devices/);
  expect(r.findings[0].matchReasons.join(' ')).toMatch(/verify it is the same company/);
});
