/**
 * Fixes in POST /api/founder/deep: the hourly limit cannot be passed by a
 * burst of parallel starts, a job store that refuses the insert (limited)
 * gives a 429, and a job that could not be recorded gives a 500 instead of a
 * check run from memory.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => 'user-1') }));
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
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ method: 'POST', body, query: {}, headers: { 'x-forwarded-for': '203.0.113.9' }, socket: {} }, res);
  });
}

const start = (i = 0) => call({ action: 'start', name: `Jane Roe${'e'.repeat(i)}`, company: 'Acme' });

let spies = [];
beforeEach(() => { jobStore.__resetJobsForTests(); });
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; });

test('parallel starts from one account cannot pass the hourly limit together', async () => {
  for (let i = 0; i < MAX_JOBS_PER_HOUR - 1; i += 1) expect((await start(i)).status).toBe(200);
  // a slow count, as with a remote database: every parallel start would read the same number
  const real = jobStore.recentJobCount;
  spies.push(jest.spyOn(jobStore, 'recentJobCount').mockImplementation(async (...a) => {
    const n = await real(...a);
    await new Promise((r) => setTimeout(r, 20));
    return n;
  }));
  const results = await Promise.all([1, 2, 3, 4, 5].map((k) => start(20 + k)));
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(results.filter((r) => r.status === 429)).toHaveLength(4);
});

test('a job store that refuses the insert because the hour is full gives a 429 and runs nothing', async () => {
  spies.push(jest.spyOn(jobStore, 'createJob').mockResolvedValue({ id: null, limited: true }));
  const saved = jest.spyOn(jobStore, 'saveJob');
  spies.push(saved);
  const r = await start();
  expect(r.status).toBe(429);
  expect(saved).not.toHaveBeenCalled();
});

test('the limit is passed to the job store so it can enforce it in the insert', async () => {
  const spy = jest.spyOn(jobStore, 'createJob');
  spies.push(spy);
  expect((await start()).status).toBe(200);
  expect(spy.mock.calls[0][0]).toMatchObject({ owner: 'user-1', limit: { minutes: 60, max: MAX_JOBS_PER_HOUR } });
});

test('a job that could not be recorded ends in a 500, not a check run from memory', async () => {
  spies.push(jest.spyOn(jobStore, 'createJob').mockRejectedValue(new Error('insert failed')));
  const saved = jest.spyOn(jobStore, 'saveJob');
  spies.push(saved);
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  spies.push(err);
  const r = await start();
  expect(r.status).toBe(500);
  expect(saved).not.toHaveBeenCalled();
  // the lock is released after a failure: the next start goes through
  spies.forEach((s) => s.mockRestore()); spies = [];
  expect((await start(1)).status).toBe(200);
});
