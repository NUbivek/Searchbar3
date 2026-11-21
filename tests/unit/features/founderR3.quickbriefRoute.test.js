/**
 * Round 3, quick brief route (src/pages/api/founder/index.js): POST with a JSON body (GET still works for the
 * page as it is, never from another site), no-store on every answer, a fair-use limit per address or account,
 * sources first (brief=0) and the brief after (brief=only), and one input check.
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
const { getUserId } = require('../../../src/server/auth');

function call({ method = 'GET', query = {}, body = undefined, headers = {}, ip = '203.0.113.5' } = {}) {
  const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  // the page posts JSON; a POST that is not JSON is refused (founderR4.quickbriefRoute.test.js)
  const type = method === 'POST' ? { 'content-type': 'application/json' } : {};
  return handler({ method, query, body, headers: { 'x-forwarded-for': ip, ...type, ...headers }, socket: {} }, res).then(() => res);
}

const RESULT = { name: 'Jane Doe', company: null, sources: [{ n: 1 }], currentRole: null, profiles: [], pastCompanies: [], timeline: [], litigation: [], press: [], mentions: [], education: [] };

beforeEach(() => {
  runFounderCheck.mockReset().mockResolvedValue(RESULT);
  runFounderBrief.mockReset().mockResolvedValue({ brief: '## SUMMARY\nx', briefInfo: { mode: 'ai' }, fromCache: true });
  getUserId.mockReset().mockResolvedValue(null);
  route.__resetQuickLimitsForTests();
});

describe('security-quick-brief-open', () => {
  test('POST with a JSON body runs the check; the name stays out of the address', async () => {
    const res = await call({ method: 'POST', body: { name: 'Jane Doe', company: 'Acme' } });
    expect(res.statusCode).toBe(200);
    expect(runFounderCheck).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jane Doe', company: 'Acme' }));
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('a GET from another site (an image tag, a cross-site link) is refused', async () => {
    const res = await call({ query: { name: 'Jane Doe' }, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' } });
    expect(res.statusCode).toBe(403);
    expect(runFounderCheck).not.toHaveBeenCalled();
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('every answer, errors included, is no-store', async () => {
    for (const r of [await call({ method: 'DELETE' }), await call({ query: {} }), await call({ query: { name: 'Madonna' } })]) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.headers['Cache-Control']).toBe('no-store');
    }
  });

  test('a script is stopped by the fair-use limit with a plain "wait" message; another address is not', async () => {
    let last;
    for (let i = 0; i < 40; i += 1) {
      last = await call({ method: 'POST', body: { name: 'Jane Doe' } });
      if (last.statusCode === 429) break;
    }
    expect(last.statusCode).toBe(429);
    expect(runFounderCheck.mock.calls.length).toBeGreaterThanOrEqual(10); // generous for a person using the page
    expect(last.body.error).toMatch(/wait/i);
    expect(last.body.error).not.toMatch(/\b(API|key|token|free|paid|tier|quota)\b/i);
    expect(Number(last.headers['Retry-After'])).toBeGreaterThan(0);
    expect((await call({ method: 'POST', body: { name: 'Jane Doe' }, ip: '198.51.100.7' })).statusCode).toBe(200);
  });

  test('a signed-in account has its own, higher allowance', async () => {
    for (let i = 0; i < 40; i += 1) await call({ method: 'POST', body: { name: 'Jane Doe' } });
    getUserId.mockResolvedValue('user-1');
    expect((await call({ method: 'POST', body: { name: 'Jane Doe' } })).statusCode).toBe(200);
  });
});

describe('sources first, brief after', () => {
  test('brief=0 asks for sources and facts only; brief=only asks for the brief of the sources just found', async () => {
    await call({ method: 'POST', body: { name: 'Jane Doe', company: 'Acme', brief: '0' } });
    expect(runFounderCheck).toHaveBeenCalledWith(expect.objectContaining({ brief: 'none', cacheScope: expect.any(String) }));
    const scope = runFounderCheck.mock.calls[0][0].cacheScope;
    const res = await call({ method: 'POST', body: { name: 'Jane Doe', company: 'Acme', brief: 'only' } });
    expect(runFounderBrief).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jane Doe', company: 'Acme', cacheScope: scope }));
    expect(res.body).toEqual(expect.objectContaining({ brief: '## SUMMARY\nx', briefInfo: { mode: 'ai' } }));
  });

  test('the present single call keeps working', async () => {
    const res = await call({ query: { name: 'Jane Doe' } });
    expect(res.statusCode).toBe(200);
    expect(runFounderCheck).toHaveBeenCalledWith(expect.objectContaining({ brief: 'auto' }));
  });
});

describe('security-name-validation', () => {
  test('emails, search operators and initials only are refused with a clear message', async () => {
    for (const name of ['jo@x.com Smith', 'Jane site:x.com', 'J S']) {
      const res = await call({ method: 'POST', body: { name } });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toEqual(expect.any(String));
    }
    expect(runFounderCheck).not.toHaveBeenCalled();
  });

  test('zero-width and bidi characters are removed before the check runs', async () => {
    await call({ method: 'POST', body: { name: 'Jane​ Doe‮', company: '-Acme site:x.com' } });
    expect(runFounderCheck).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jane Doe', company: 'Acme' }));
  });
});
