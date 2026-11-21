/**
 * Round 3, the quick brief's route (src/pages/api/founder/index.js): the address its fair-use limit counts is
 * the one the host set, never the first address a client writes itself (needs-phase2 fix:security), and the
 * name and company are checked by the same validators as the deep check (needs-phase2 fix:loop).
 */
jest.mock('../../../src/server/founderCheck', () => {
  const actual = jest.requireActual('../../../src/server/founderCheck');
  return { ...actual, runFounderCheck: jest.fn(), runFounderBrief: jest.fn() };
});
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => null), callerAddress: jest.requireActual('../../../src/server/auth').callerAddress }));
jest.mock('../../../src/server/network/store', () => ({ countContacts: jest.fn(async () => 0), findContactsAtCompanies: jest.fn(async () => []) }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const route = require('../../../src/pages/api/founder');
const { runFounderCheck } = require('../../../src/server/founderCheck');

function call({ body, headers = {} }) {
  const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  return route.default({ method: 'POST', query: {}, body, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '10.0.0.1' } }, res).then(() => res);
}

beforeEach(() => {
  runFounderCheck.mockReset().mockResolvedValue({ name: 'Jane Doe', company: null, sources: [], profiles: [], pastCompanies: [] });
  route.__resetQuickLimitsForTests();
});

test('a client that writes a new first forwarded address on every call is still counted at the host\'s address', async () => {
  const max = route.QUICK_LIMITS.signedOut[0].max;
  let last;
  for (let i = 0; i <= max; i += 1) last = await call({ body: { name: 'Jane Doe', brief: '0' }, headers: { 'x-forwarded-for': `198.18.0.${i}, 203.0.113.7` } });
  expect(last.statusCode).toBe(429);
});

test('one validator for both routes: operators are stripped from the company, and a one-word name is refused here', async () => {
  await call({ body: { name: 'Jane Doe', company: '-Acme site:x.com' } });
  expect(runFounderCheck).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jane Doe', company: 'Acme' }));
  const one = await call({ body: { name: 'Madonna', company: 'Acme' } });
  expect(one.statusCode).toBe(400);
  expect(one.body.error).toMatch(/full name/i);
  const web = await call({ body: { name: 'www.jane.com' } });
  expect(web.statusCode).toBe(400);
  expect(web.body.error).toMatch(/web address/);
});
