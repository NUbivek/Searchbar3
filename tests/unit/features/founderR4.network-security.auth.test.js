/**
 * @jest-environment node
 *
 * Round 4, network-security (src/server/auth.js, src/pages/api/debug/*).
 *  - network-security-allowlist-fail-open: a set but malformed FOUNDER_ALLOWED_EMAILS never opens the site to
 *    every account. Quotes and "mailto:" are read through; a value with nothing valid in it refuses everyone.
 *  - network-security-debug-prod-open: model runs share one hourly cap across accounts. (Round 6, the owner's
 *    decision: in production any signed-in account may use the debug routes, as on the rest of the site.)
 */
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn(async () => null) }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(async () => ({ text: 'ok', providerLabel: 'Model', model: 'm', ms: 5, skipped: [] })),
  chatJson: jest.fn(async () => null),
  describeChain: jest.fn(async () => ({ order: [], passedOver: [] })),
  llmStatus: jest.fn(() => []),
  PROVIDERS: [],
  providerEnabled: jest.fn(() => false),
  llmConfigured: jest.fn(() => false),
  prepareChain: jest.fn(() => Promise.resolve()),
  reportAnswerQuality: jest.fn(async () => {}),
}));

const { getServerSession } = require('next-auth/next');
const auth = require('../../../src/server/auth');
const { createMockReq, createMockRes } = require('../api/testUtils');
const llmCheck = require('../../../src/pages/api/debug/llm-check').default;
const envCheck = require('../../../src/pages/api/debug/env-check').default;

const google = (email) => ({ user: { id: 'g1', email, name: 'Someone' }, account: { provider: 'google', providerAccountId: '123' }, profile: { email, email_verified: true } });
const call = async (handler, query = {}) => {
  const res = createMockRes();
  await handler(createMockReq({ method: 'GET', query, headers: { 'x-forwarded-for': '203.0.113.9' } }), res);
  return res;
};

describe('a malformed allow-list fails closed', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.clearAllMocks(); getServerSession.mockResolvedValue(null); });

  test('quotes, angle brackets and mailto: are read through', () => {
    for (const raw of ['"owner@gmail.com"', "'owner@gmail.com'", 'mailto:owner@gmail.com', 'Owner <owner@gmail.com>', '"owner@gmail.com, @partner.org"']) {
      const list = auth.parseAllowList(raw);
      expect(list.emails).toEqual(['owner@gmail.com']);
      expect(auth.emailAllowed('owner@gmail.com', list)).toBe(true);
      expect(auth.emailAllowed('stranger@gmail.com', list)).toBe(false);
    }
  });

  test.each(['owner@gmail', 'owner', '""', 'name@'])('%s parses to nothing, so nobody is let in', async (raw) => {
    const list = auth.parseAllowList(raw);
    expect(auth.allowListActive(list)).toBe(true);
    expect(auth.emailAllowed('stranger@gmail.com', list)).toBe(false);
    expect(list.warnings.length).toBeGreaterThan(0);
    process.env.FOUNDER_ALLOWED_EMAILS = raw;
    expect(await auth.authOptions.callbacks.signIn(google('stranger@gmail.com'))).toBe(false);
    getServerSession.mockResolvedValue({ user: { id: 'google:1', email: 'stranger@gmail.com' } });
    expect(await auth.getUserId(createMockReq(), createMockRes())).toBeNull();
  });

  test('blank stays open, as documented', () => {
    for (const raw of ['', '   ', undefined]) expect(auth.allowListActive(auth.parseAllowList(raw))).toBe(false);
  });

  test('env-check in development lists what was ignored in the list, never the addresses', async () => {
    process.env.NODE_ENV = 'development';
    process.env.FOUNDER_ALLOWED_EMAILS = 'owner@gmail.com, owner@gmail';
    const res = await call(envCheck);
    expect(res.statusCode).toBe(200);
    expect(res.body.allowList).toEqual({ active: true, emails: 1, domains: 0, ignored: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/owner@/);
  });
});

describe('debug routes in production', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.clearAllMocks(); getServerSession.mockResolvedValue(null); });

  // Changed in round 6 (owner's decision): the debug routes follow the site's model, whoever is signed in.
  test('with no allow-list, a signed-in account gets the answer', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL_ENV;
    delete process.env.FOUNDER_ALLOWED_EMAILS;
    getServerSession.mockResolvedValue({ user: { id: 'google:someone', email: 'jane.roe@example.org' } });
    expect((await call(llmCheck)).statusCode).toBe(200);
    expect((await call(envCheck)).statusCode).toBe(200);
  });

  test('model runs share one hourly cap across accounts', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL_ENV;
    process.env.FOUNDER_ALLOWED_EMAILS = '@example.com';
    const codes = [];
    // five accounts on the list, ten runs each: past the shared cap of 40, runs are refused
    for (let a = 0; a < 5; a += 1) {
      getServerSession.mockResolvedValue({ user: { id: `google:shared-${a}`, email: `p${a}@example.com` } });
      for (let i = 0; i < 10; i += 1) codes.push((await call(llmCheck, { run: 'chat' })).statusCode);
    }
    expect(codes.slice(0, 40).every((c) => c === 200)).toBe(true);
    expect(codes.slice(40).every((c) => c === 429)).toBe(true);
  });
});
