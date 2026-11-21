/**
 * Round 3, POST/GET /api/founder/deep: one request at a time per check, a failed first step that still
 * hands back the check, a step that keeps failing, picking a check up again (by person, or from the
 * account's list), the start inputs, the public switch and the client address.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => 'user-1') }));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null), chatJson: jest.fn(async () => null), llmConfigured: () => false, PROVIDERS: [], providerEnabled: () => false }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [] })) }));

// The sources are a list the tests change: a slow source, a source that breaks the step.
const mockControl = { slowMs: 0, poison: false, calls: [] };
jest.mock('../../../src/server/founder/sources', () => {
  const { makeFinding } = jest.requireActual('../../../src/server/founder/finding');
  const fake = {
    id: 'fake', label: 'Fake registry',
    get kinds() { if (mockControl.poison) throw new Error('a bug in a source'); return ['subject', 'company']; },
    run: async (task, { subject }) => {
      mockControl.calls.push(`${task.kind}:${task.value}`);
      if (mockControl.slowMs) await new Promise((r) => setTimeout(r, mockControl.slowMs));
      return { findings: task.kind === 'subject' ? [makeFinding(subject, { source: 'fake', sourceLabel: 'Fake registry', category: 'corporate', title: 'Jane Roe of Acme Corp', quote: 'Jane Roe, CEO of Acme Corp.', url: 'https://reg.test/1' })] : [] };
    },
  };
  return { CONNECTORS: [fake] };
});

const auth = require('../../../src/server/auth');
const { __resetJobsForTests, recentJobCount, getJob } = require('../../../src/server/founder/jobStore');
const { __resetLearningForTests } = require('../../../src/server/learning');
const handler = require('../../../src/pages/api/founder/deep').default;
const { clientIp } = require('../../../src/pages/api/founder/deep');

function call(method, { body, query, headers } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ method, body, query: query || {}, headers: headers || { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } }, res);
  });
}
const start = (extra = {}) => call('POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme Corp', ...extra } });

beforeEach(() => {
  __resetJobsForTests(); __resetLearningForTests();
  Object.assign(mockControl, { slowMs: 0, poison: false, calls: [] });
  auth.getUserId.mockResolvedValue('user-1');
  delete process.env.FOUNDER_DEEP_PUBLIC;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { console.error.mockRestore(); console.warn.mockRestore(); });

test('a second step on a check that is being worked on is told it is busy, and sends nothing out', async () => {
  const { body: { jobId } } = await start();
  mockControl.calls = [];
  mockControl.slowMs = 150;
  // the company lookup is still queued; force one more round so the first step has work
  const [a, b] = await Promise.all([call('POST', { body: { action: 'step', jobId } }), call('POST', { body: { action: 'step', jobId } })]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  expect(new Set(mockControl.calls).size).toBe(mockControl.calls.length); // no lookup ran twice
  // the hold ends with the save: the next step goes through
  expect((await call('POST', { body: { action: 'step', jobId } })).status).toBe(200);
});

test('the same person started again within the hour gets the running check back, without using a slot', async () => {
  const first = await start();
  const again = await start({ name: 'jane roe', company: 'acme corp' });
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ jobId: first.body.jobId, resumed: true });
  expect(await recentJobCount('user-1')).toBe(1);
});

test('a first step that throws still hands back the check, and a step that keeps failing ends collecting', async () => {
  mockControl.poison = true;
  const started = await start();
  expect(started.status).toBe(200);
  const { jobId } = started.body;
  expect(jobId).toBeTruthy();
  expect(await recentJobCount('user-1')).toBe(1);
  expect((await call('POST', { body: { action: 'step', jobId } })).status).toBe(500);
  expect((await call('POST', { body: { action: 'step', jobId } })).status).toBe(500);
  const saved = await getJob(jobId, { owner: 'user-1' });
  expect(saved.state.phase).toBe('report');
  expect(saved.state.log.some((l) => /failed twice/.test(l.text))).toBe(true);
  // the next step builds the report from what was found; it is not stuck
  mockControl.poison = false;
  const done = await call('POST', { body: { action: 'step', jobId } });
  expect(done.status).toBe(200);
  expect(done.body.done).toBe(true);
});

test('GET by person returns the account\'s latest check; GET ?list=1 lists checks without reports; both scoped to the account', async () => {
  const { body: { jobId } } = await start();
  for (let i = 0; i < 10; i += 1) { const r = await call('POST', { body: { action: 'step', jobId } }); if (r.body.done) break; }
  const found = await call('GET', { query: { name: 'Jane Roe', company: 'Acme Corp' } });
  expect(found.status).toBe(200);
  expect(found.body).toMatchObject({ jobId, done: true });
  expect((await call('GET', { query: { name: 'Jane Roe', company: 'Other' } })).status).toBe(404);
  const list = await call('GET', { query: { list: '1' } });
  expect(list.body.jobs).toEqual([expect.objectContaining({ id: jobId, name: 'Jane Roe', company: 'Acme Corp', state: 'done' })]);
  expect(list.body.jobs[0]).not.toHaveProperty('report');
  expect(typeof list.body.jobs[0].when).toBe('string');
  auth.getUserId.mockResolvedValue('someone-else');
  expect((await call('GET', { query: { name: 'Jane Roe', company: 'Acme Corp' } })).status).toBe(404);
  expect((await call('GET', { query: { list: '1' } })).body.jobs).toEqual([]);
});

test('start validates every input with a plain reason, and accepts the optional ones', async () => {
  expect((await start({ name: 'J S' })).body.error).toMatch(/initials/);
  expect((await start({ name: 'Jane Roe site:x.com' })).status).toBe(400);
  expect((await start({ website: 'not a site' })).body).toMatchObject({ field: 'website' });
  expect((await start({ place: '1 Main Street' })).body).toMatchObject({ field: 'place' });
  // a name the matcher cannot read yet is refused plainly, or swapped for a readable other name
  const cjk = await start({ name: '张一鸣', company: 'ByteDance' });
  if (cjk.status === 400) expect(cjk.body.error).toMatch(/script/);
  const ok = await start({ name: 'Jane Roe', company: 'Acme Corp', website: 'acme.com', profileUrl: 'https://www.linkedin.com/in/jane-roe-123', place: 'Paris', otherCompanies: ['Beta Labs'], school: 'MIT', otherNames: ['Jane Doe'] });
  expect(ok.status).toBe(200);
  const job = await getJob(ok.body.jobId, { owner: 'user-1' });
  expect(job.state.given).toMatchObject({ website: 'acme.com', place: 'Paris', otherCompanies: ['Beta Labs'], school: 'MIT', profile: { platform: 'linkedin', handle: 'jane-roe-123' } });
  expect(job.state.otherNames).toEqual(['Jane Doe']);
});

test('the public switch is ignored in production', async () => {
  auth.getUserId.mockResolvedValue(null);
  process.env.FOUNDER_DEEP_PUBLIC = 'true';
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    expect((await start()).status).toBe(401);
  } finally {
    process.env.NODE_ENV = env;
  }
  expect((await start()).status).toBe(200);
});

test('the client address is the one the host set, not the first address the client sent', () => {
  expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }, socket: {} })).toBe('198.51.100.7');
  expect(clientIp({ headers: { 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '1.2.3.4' }, socket: {} })).toBe('198.51.100.8');
  expect(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } })).toBe('10.0.0.1');
});
