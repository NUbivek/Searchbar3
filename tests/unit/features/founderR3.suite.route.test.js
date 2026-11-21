/**
 * Final pass (suite): the hourly limit's 429 says when a slot frees (retryAfter in seconds and a Retry-After
 * header), so the page can say "You can start another check at <time>".
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/auth', () => {
  const getUserId = jest.fn(async () => 'user-1');
  // requireFounderUser answers 401 itself when signed out (and 403 for an account outside the allow-list)
  const requireFounderUser = jest.fn(async (req, res) => { const id = await getUserId(req, res); if (!id) { res.status(401).json({ error: 'Sign in to use this feature.', signIn: true }); return null; } return id; });
  return { getUserId, requireFounderUser };
});
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null), chatJson: jest.fn(async () => null), llmConfigured: () => false, PROVIDERS: [], providerEnabled: () => false }));
jest.mock('../../../src/server/founder/sources', () => ({ CONNECTORS: [{ id: 'fake', label: 'Fake registry', kinds: ['subject'], run: async () => ({ findings: [], threads: [] }) }] }));

const jobStore = require('../../../src/server/founder/jobStore');
const handler = require('../../../src/pages/api/founder/deep').default;
const { MAX_JOBS_PER_HOUR } = require('../../../src/pages/api/founder/deep');

function call(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload, headers: this.headers }); },
    };
    handler({ method: 'POST', body, query: {}, headers: { 'x-forwarded-for': '203.0.113.9' }, socket: {} }, res);
  });
}

const start = (i = 0) => call({ action: 'start', name: `Jane Roe${'e'.repeat(i)}`, company: 'Acme' });

beforeEach(() => { jobStore.__resetJobsForTests(); });

test('the hourly limit answers with when the oldest of the hour\'s checks frees a slot', async () => {
  for (let i = 0; i < MAX_JOBS_PER_HOUR; i += 1) expect((await start(i)).status).toBe(200);
  // the first check of the hour started 40 minutes ago: a slot frees in about 20 minutes
  const first = (await jobStore.listJobs('user-1', { limit: 50 })).sort((a, b) => a.createdAt - b.createdAt)[0].id;
  jobStore.__ageJobForTests(first, 40 * 60000);
  const r = await start(40);
  expect(r.status).toBe(429);
  expect(r.body.retryAfter).toBeGreaterThan(19 * 60);
  expect(r.body.retryAfter).toBeLessThanOrEqual(20 * 60 + 1);
  expect(r.headers['Retry-After']).toBe(String(r.body.retryAfter));
});
