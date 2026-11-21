/**
 * Round 3, security-debug-routes and quickbrief-debug-profile-run (src/pages/api/debug/*, src/server/auth.js,
 * src/server/founder/sample.js).
 *
 * Production: only a signed-in account on the allow-list may use the debug routes; everyone else gets a 404,
 * as if they did not exist. Preview deployments stay usable without the site's own sign-in (the host's
 * sign-in sits in front), but every caller is limited per hour and so is the deployment as a whole.
 * env-check on a deployment says only which groups are set up, never the names of the settings.
 * Two fictional runs check the quick brief and the profile reader without a word about a real person.
 */
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn(async () => null) }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(async () => ({ text: '7 years', providerLabel: 'Google Gemini', model: 'gemini-x', ms: 900, skipped: [] })),
  chatJson: jest.fn(async () => null),
  describeChain: jest.fn(async ({ task }) => ({ order: [{ provider: 'Google Gemini', model: `best-for-${task}`, score: 90 }], passedOver: [] })),
  llmStatus: jest.fn(() => [{ id: 'gemini', label: 'Google Gemini', enabled: true, keySet: true, note: 'x' }]),
  PROVIDERS: [{ id: 'gemini' }],
  providerEnabled: jest.fn(() => false),
  llmConfigured: jest.fn(() => false),
  prepareChain: jest.fn(() => Promise.resolve()),
  reportAnswerQuality: jest.fn(async () => {}),
}));
jest.mock('../../../src/utils/sources/curatedIndex', () => ({
  searchCuratedSources: jest.fn(async () => []),
  searchCuratedForEntity: jest.fn(async () => { throw new Error('the fictional run must not search the real index'); }),
  getCuratedIndexStatus: jest.fn(() => null),
}));
jest.mock('../../../src/utils/sources/hackernewsAlgolia', () => ({ searchHackerNews: jest.fn(async () => { throw new Error('the fictional run must not search'); }) }));

const { getServerSession } = require('next-auth/next');
const providers = require('../../../src/server/llm/providers');
const { createMockReq, createMockRes } = require('../api/testUtils');
const llmCheck = require('../../../src/pages/api/debug/llm-check').default;
const envCheck = require('../../../src/pages/api/debug/env-check').default;
const { sampleState, sampleSearchers } = require('../../../src/server/founder/sample');
const { buildReport } = require('../../../src/server/founder/report');

let ip = 0;
const call = async (handler, query = {}, headers = {}) => {
  const res = createMockRes();
  await handler(createMockReq({ method: 'GET', query, headers: { 'x-forwarded-for': `198.51.100.${(ip % 250) + 1}`, ...headers } }), res);
  return res;
};

describe('security-debug-routes', () => {
  const env = { ...process.env };
  beforeEach(() => { ip += 1; });
  afterEach(() => { process.env = { ...env }; jest.clearAllMocks(); getServerSession.mockResolvedValue(null); });

  test('production: signed out gets a 404, not a sign-in prompt', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL_ENV;
    for (const h of [llmCheck, envCheck]) {
      const res = await call(h);
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/sign in|diagnostic/i);
    }
  });

  test('production with an allow-list: a signed-in account outside it gets a 404; one on it gets the answer', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL_ENV;
    process.env.FOUNDER_ALLOWED_EMAILS = 'owner@example.com';
    getServerSession.mockResolvedValue({ user: { id: 'google:9', email: 'stranger@gmail.com' } });
    expect((await call(llmCheck)).statusCode).toBe(404);
    expect((await call(envCheck)).statusCode).toBe(404);
    getServerSession.mockResolvedValue({ user: { id: 'google:1', email: 'owner@example.com' } });
    expect((await call(llmCheck)).statusCode).toBe(200);
    expect((await call(envCheck)).statusCode).toBe(200);
  });

  test('production: even an allowed account is limited in how many model runs it starts an hour', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL_ENV;
    process.env.FOUNDER_ALLOWED_EMAILS = 'owner@example.com';
    getServerSession.mockResolvedValue({ user: { id: `google:limit-${Math.random()}`, email: 'owner@example.com' } });
    const codes = [];
    for (let i = 0; i < 11; i += 1) codes.push((await call(llmCheck, { run: 'chat' })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  test('a preview deployment stays usable without the site sign-in, but each caller is limited per hour', async () => {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL_ENV = 'preview';
    // the first forwarded address is the client's own word; the host's hop is the one counted
    const headers = { 'x-forwarded-for': '1.2.3.4, 203.0.113.77' };
    const codes = [];
    for (let i = 0; i < 11; i += 1) codes.push((await call(llmCheck, { run: 'analysis' }, headers)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    const last = await call(llmCheck, { run: 'analysis' }, { 'x-forwarded-for': '9.9.9.9, 203.0.113.77' });
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers['Retry-After'])).toBeGreaterThan(0);
    // another caller is not blocked by the first one's runs
    expect((await call(llmCheck, { run: 'analysis' }, { 'x-forwarded-for': '203.0.113.78' })).statusCode).toBe(200);
  });

  test('env-check on a deployment says which groups are set up, never the names of settings or addresses', async () => {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL_ENV = 'preview';
    process.env.GROQ_API_KEY = 'secret-value';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://internal.example';
    const res = await call(envCheck);
    expect(res.statusCode).toBe(200);
    expect(res.body.diagnostics.providers.llm).toEqual({ configured: true });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/GROQ|_API_KEY|secret-value|internal\.example/);
  });

  test('a run that throws answers with a plain error and no inner details', async () => {
    process.env.NODE_ENV = 'test';
    providers.chatComplete.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.1.2.3:443 with secret header'));
    const res = await call(llmCheck, { run: 'chat' });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|secret/);
  });
});

describe('quickbrief-debug-profile-run: fictional runs of the quick brief and the profile reader', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.clearAllMocks(); });

  test('the sample again exercises every part of a report: three red flags and one name-only record', () => {
    const report = buildReport(sampleState());
    expect(report.totals).toMatchObject({ redFlags: 3, possibleNamesake: 1 });
  });

  test('run=quick runs the quick brief on fictional search results only and says whether a model wrote it', async () => {
    process.env.NODE_ENV = 'test';
    const res = await call(llmCheck, { run: 'quick' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ run: 'quick', ok: false }));
    expect(typeof res.body.ms).toBe('number');
    expect(res.body.mode).toBeTruthy();
    expect(res.body.sources).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).toMatch(/Quillfeather/);
  });

  test('the fictional searchers answer only with invented records', async () => {
    const s = sampleSearchers();
    const web = await s.web('Jordan Quillfeather');
    expect(web.length).toBeGreaterThan(0);
    for (const r of web) expect(r.url).toMatch(/\.example\//);
    expect(await s.curated()).toEqual([]);
  });

  test('run=profile reports what the profile reader should find, so a silent fall back to rules is visible', async () => {
    process.env.NODE_ENV = 'test';
    const res = await call(llmCheck, { run: 'profile' });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.readBy).not.toBe('model');
    expect(res.body.checks).toEqual(expect.objectContaining({ harrowgateEducation: expect.any(Boolean), noRoleForCasey: expect.any(Boolean) }));
  });
});
