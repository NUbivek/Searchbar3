/**
 * Round 4, quick brief route (src/pages/api/founder/index.js): brief=only is inside the fair-use limit, and no
 * other site can start a check in a visitor's browser, by GET or by POST.
 */
jest.mock('../../../src/server/founderCheck', () => {
  const actual = jest.requireActual('../../../src/server/founderCheck');
  return { ...actual, runFounderCheck: jest.fn(), runFounderBrief: jest.fn() };
});
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => null), callerAddress: jest.requireActual('../../../src/server/auth').callerAddress }));
jest.mock('../../../src/server/network/store', () => ({ countContacts: jest.fn(async () => 0), findContactsAtCompanies: jest.fn(async () => []) }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const route = require('../../../src/pages/api/founder');
const handler = route.default;
const { runFounderCheck, runFounderBrief } = require('../../../src/server/founderCheck');

function call({ method = 'POST', query = {}, body = undefined, headers = {}, ip = '203.0.113.9' } = {}) {
  const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  const h = method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers;
  return handler({ method, query, body, headers: { 'x-forwarded-for': ip, ...h }, socket: {} }, res).then(() => res);
}

beforeEach(() => {
  runFounderCheck.mockReset().mockResolvedValue({ name: 'Jane Doe', sources: [], profiles: [], pastCompanies: [] });
  // as the real one does: a cache miss asks the route first (onMiss), then runs the whole check
  runFounderBrief.mockReset().mockImplementation(async (opts) => {
    if (opts.onMiss) await opts.onMiss();
    return { name: 'Jane Doe', brief: '## SUMMARY\nx', briefInfo: { mode: 'quoted' }, sources: [], fromCache: false };
  });
  route.__resetQuickLimitsForTests();
});

describe('quickbrief-only-mode-bypasses-limit', () => {
  test('brief=only calls that miss the cache are counted before they run, and refused when over', async () => {
    let refused = 0;
    for (let i = 0; i < 60; i += 1) {
      const res = await call({ body: { name: 'Jane Doe', company: `Acme ${i}`, brief: 'only' } });
      if (res.statusCode === 429) {
        refused += 1;
        expect(res.body.error).toMatch(/wait/i);
        expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(runFounderBrief.mock.calls.length).toBe(60);
    // the refused ones never got past onMiss: only the allowed ones ran
    expect(60 - refused).toBeLessThanOrEqual(15);
  });

  test('a cache hit is not counted again', async () => {
    runFounderBrief.mockReset().mockResolvedValue({ brief: 'x', briefInfo: { mode: 'ai' }, fromCache: true });
    for (let i = 0; i < 20; i += 1) expect((await call({ body: { name: 'Jane Doe', brief: 'only' } })).statusCode).toBe(200);
  });
});

describe('quickbrief-cross-site-post', () => {
  test('a POST from another site is refused', async () => {
    const res = await call({ body: { name: 'Jane Doe' }, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res.statusCode).toBe(403);
    expect(runFounderCheck).not.toHaveBeenCalled();
  });

  test('a POST that is not JSON (a simple request another site can send without asking) is refused', async () => {
    const res = await call({ body: '{"name":"Jane Doe"}', headers: { 'content-type': 'text/plain' } });
    expect(res.statusCode).toBe(415);
    expect(runFounderCheck).not.toHaveBeenCalled();
  });

  test('a same-site JSON POST runs', async () => {
    const res = await call({ body: { name: 'Jane Doe' }, headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.statusCode).toBe(200);
  });
});
