/**
 * POST /api/founder/deep: sign-in, validation, the step loop and the hourly
 * limit. Sources, the model and the database are faked.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => 'user-1') }));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null), chatJson: jest.fn(async () => null), llmConfigured: () => false, PROVIDERS: [], providerEnabled: () => false }));
jest.mock('../../../src/server/founder/sources', () => {
  const { makeFinding, makeThread } = jest.requireActual('../../../src/server/founder/finding');
  return {
    CONNECTORS: [{
      id: 'fake', label: 'Fake registry', kinds: ['subject', 'company'],
      run: async (task, { subject }) => (task.kind === 'subject'
        ? { findings: [makeFinding(subject, { source: 'fake', sourceLabel: 'Fake registry', category: 'regulatory', severity: 'high', title: 'Jane Roe of Acme barred by regulator', quote: 'Jane Roe, CEO of Acme, was barred.', url: 'https://reg.test/1', date: '2024-02-02' })], threads: [makeThread('company', 'Beta Labs', 'founder (past)', { trusted: true })] }
        : { findings: [makeFinding(subject, { source: 'fake', sourceLabel: 'Fake registry', category: 'corporate', title: `${task.value}: Jane Roe listed as director`, quote: `Jane Roe is a director of ${task.value}.`, url: `https://reg.test/co/${encodeURIComponent(task.value)}` })] }),
    }],
  };
});

const auth = require('../../../src/server/auth');
const { __resetJobsForTests } = require('../../../src/server/founder/jobStore');
const { __resetLearningForTests } = require('../../../src/server/learning');
const handler = require('../../../src/pages/api/founder/deep').default;
const { MAX_JOBS_PER_HOUR } = require('../../../src/pages/api/founder/deep');

function call(method, { body, query } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload, headers: this.headers }); },
    };
    handler({ method, body, query: query || {}, headers: { 'x-forwarded-for': '203.0.113.9' }, socket: {} }, res);
  });
}

beforeEach(() => { __resetJobsForTests(); __resetLearningForTests(); auth.getUserId.mockResolvedValue('user-1'); delete process.env.FOUNDER_DEEP_PUBLIC; });

test('a signed-out visitor is asked to sign in, unless public checks are switched on', async () => {
  auth.getUserId.mockResolvedValue(null);
  const r = await call('POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme' } });
  expect(r.status).toBe(401);
  expect(r.body).toMatchObject({ signIn: true });
  process.env.FOUNDER_DEEP_PUBLIC = 'true';
  expect((await call('POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme' } })).status).toBe(200);
});

test('validation: a full name is required and unknown actions are rejected', async () => {
  expect((await call('POST', { body: { action: 'start', name: 'Jane' } })).status).toBe(400);
  expect((await call('POST', { body: { action: 'start', name: '' } })).status).toBe(400);
  expect((await call('POST', { body: { action: 'dance' } })).status).toBe(400);
  expect((await call('PUT')).status).toBe(405);
  expect((await call('POST', { body: { action: 'step', jobId: 'nope' } })).status).toBe(404);
});

test('start, step until done, then read the report; another user cannot read it', async () => {
  const started = await call('POST', { body: { action: 'start', name: 'jane roe', company: 'Acme' } });
  expect(started.status).toBe(200);
  expect(started.headers['Cache-Control']).toBe('no-store');
  const { jobId } = started.body;
  expect(started.body.progress).toMatchObject({ phase: 'collect', step: 1 });
  let last = started;
  for (let i = 0; i < 10 && !last.body.done; i += 1) last = await call('POST', { body: { action: 'step', jobId } });
  expect(last.body.done).toBe(true);
  const { report } = last.body;
  expect(report.name).toBe('jane roe');
  expect(report.redFlags.map((f) => f.title)).toEqual(['Jane Roe of Acme barred by regulator']);
  expect(report.redFlags[0]).not.toHaveProperty('score'); // internal ranking fields are not sent
  expect(report.sections.map((s) => s.key)).toEqual(['regulatory', 'corporate']);
  expect(report.sections[1].items.map((f) => f.title).sort()).toEqual(['Acme: Jane Roe listed as director', 'Beta Labs: Jane Roe listed as director']);
  expect(report.briefInfo).toMatchObject({ mode: 'quoted' });
  expect(report.brief).toMatch(/## RED FLAGS/);
  // stepping a finished job, or reading it, returns the same report
  expect((await call('POST', { body: { action: 'step', jobId } })).body.report.generatedAt).toBe(report.generatedAt);
  expect((await call('GET', { query: { jobId } })).body).toMatchObject({ done: true });
  auth.getUserId.mockResolvedValue('someone-else');
  expect((await call('GET', { query: { jobId } })).status).toBe(404);
});

test('checks per hour are limited per account', async () => {
  for (let i = 0; i < MAX_JOBS_PER_HOUR; i += 1) expect((await call('POST', { body: { action: 'start', name: `Jane Roe${'e'.repeat(i)}`, company: 'Acme' } })).status).toBe(200);
  const blocked = await call('POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme' } });
  expect(blocked.status).toBe(429);
});
