/**
 * Round 4, POST /api/founder/deep: the first step of a start runs under the check's lease (a start sent again
 * cannot run the seed lookups twice), a start with other details replaces the running check instead of being
 * dropped, a start whose save lost tells what was saved, and the report the page gets carries no internal
 * field on any record, wherever it sits.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/auth', () => {
  const getUserId = jest.fn(async () => 'user-1');
  const requireFounderUser = jest.fn(async (req, res) => { const id = await getUserId(req, res); if (!id) { res.status(401).json({ error: 'Sign in to use this feature.', signIn: true }); return null; } return id; });
  return { getUserId, requireFounderUser };
});
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null), chatJson: jest.fn(async () => null), llmConfigured: () => false, PROVIDERS: [], providerEnabled: () => false }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [] })) }));

const mockControl = { slowMs: 0, calls: [] };
jest.mock('../../../src/server/founder/sources', () => {
  const { makeFinding } = jest.requireActual('../../../src/server/founder/finding');
  const fake = {
    id: 'fake', label: 'Fake registry', kinds: ['subject', 'company'],
    run: async (task, { subject }) => {
      mockControl.calls.push(`${task.kind}:${task.value}`);
      if (mockControl.slowMs) await new Promise((r) => setTimeout(r, mockControl.slowMs));
      return { findings: task.kind === 'subject' ? [makeFinding(subject, { source: 'fake', sourceLabel: 'Fake registry', category: 'corporate', title: 'Jane Roe of Acme Corp', quote: 'Jane Roe, CEO of Acme Corp.', url: 'https://reg.test/1' })] : [] };
    },
  };
  return { CONNECTORS: [fake] };
});

const jobStore = require('../../../src/server/founder/jobStore');
const { __resetLearningForTests } = require('../../../src/server/learning');
const route = require('../../../src/pages/api/founder/deep');

const handler = route.default;
function call(method, { body, query } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ method, body, query: query || {}, headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } }, res);
  });
}
const start = (extra = {}) => call('POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme Corp', ...extra } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  jobStore.__resetJobsForTests(); __resetLearningForTests();
  Object.assign(mockControl, { slowMs: 0, calls: [] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

test('a start sent again while the first is still stepping is handed the check, and a step on it is told it is busy', async () => {
  mockControl.slowMs = 200;
  const first = start();
  await wait(50);
  const again = await start();
  expect(again.body.resumed).toBe(true);
  // the page steps the check it was handed: the first start still holds it, so nothing is sent out twice
  const step = await call('POST', { body: { action: 'step', jobId: again.body.jobId } });
  expect(step.status).toBe(409);
  const done = await first;
  expect(done.body.jobId).toBe(again.body.jobId);
  expect(new Set(mockControl.calls).size).toBe(mockControl.calls.length);
  // the lease ends with the first start's save
  expect((await call('POST', { body: { action: 'step', jobId: done.body.jobId } })).status).toBe(200);
});

test('a start whose save lost to another request answers what was saved, and gives the check back', async () => {
  const save = jest.spyOn(jobStore, 'saveJob').mockImplementationOnce(async () => false);
  const res = await start();
  expect(save).toHaveBeenCalled();
  expect(res.status).toBe(200);
  // the saved check is the one before the first step: nothing ran in it
  expect(res.body.progress.tasksRun).toBe(0);
  // the lease was released, so the page's next step goes through
  expect((await call('POST', { body: { action: 'step', jobId: res.body.jobId } })).status).toBe(200);
});

test('started again with other details, a new check runs with them and the earlier one stops', async () => {
  const first = await start();
  // still collecting, with a lookup left to run (the fake source finishes in one round)
  const saved = await jobStore.getJob(first.body.jobId, { owner: 'user-1' });
  Object.assign(saved.state, { phase: 'collect', queue: [{ connector: 'fake', kind: 'company', value: 'Beta Labs', depth: 1, template: null, params: null, prior: 0.5, why: '', relation: null, tie: 'affiliate' }] });
  await jobStore.saveJob(first.body.jobId, { state: saved.state, status: 'running' });
  const second = await start({ otherNames: ['Jane Smith'], website: 'acmecorp.io' });
  expect(second.status).toBe(200);
  expect(second.body.resumed).toBeUndefined();
  expect(second.body.jobId).not.toBe(first.body.jobId);
  expect(second.body.replaced).toBe(first.body.jobId);
  const fresh = await jobStore.getJob(second.body.jobId, { owner: 'user-1' });
  expect(fresh.state.otherNames).toEqual(['Jane Smith']);
  expect(fresh.state.given.website).toBe('acmecorp.io');
  const old = await jobStore.getJob(first.body.jobId, { owner: 'user-1' });
  expect(old.state.phase).toBe('report');
  expect(old.state.log.some((l) => /started with other details/.test(l.text))).toBe(true);
  expect(old.state.queue).toEqual([]);
  expect(old.state.sources.fake.notRun).toBe(1); // what it had not asked is listed as not run, never as clean
  // the same details again (other case and order) are the running check
  const third = await start({ name: 'jane roe', company: 'acme corp', otherNames: ['jane smith'], website: 'ACMECORP.IO' });
  expect(third.body).toMatchObject({ jobId: second.body.jobId, resumed: true });
});

test('the input fingerprint ignores case, order and spacing, and sees every detail', () => {
  const { inputKey } = route;
  const base = { name: 'Jane Roe', company: 'Acme Corp', otherNames: ['A B', 'C D'] };
  expect(inputKey(base, {})).toBe(inputKey({ name: 'jane  roe', company: 'ACME CORP', otherNames: ['c d', 'a b'] }, {}));
  expect(inputKey(base, {})).not.toBe(inputKey({ ...base, school: 'MIT' }, {}));
  expect(inputKey(base, {})).not.toBe(inputKey({ ...base, profile: { platform: 'github', handle: 'jroe' } }, {}));
  expect(inputKey(base, {})).not.toBe(inputKey(base, { confirmedCompany: 'Acme Corp' }));
  expect(inputKey(base, {})).not.toBe(inputKey(base, { useNetworkCompany: false }));
});

test('no record in the report the page gets carries an internal field, at any depth', () => {
  const { publicReport } = route;
  const rec = (id, extra = {}) => ({ id, source: 'fake', match: 'likely', title: id, score: 3, step: 2, via: 'company: Acme', matchFixed: true, gradeText: 'long text', ...extra });
  const report = {
    totals: { redFlags: 1, step: 4 },
    redFlags: [rec('a')], companyMatters: [rec('b')], possibleNamesake: [rec('c')], claimChanges: [rec('d')],
    sections: [{ id: 'press', title: 'Press', items: [rec('e', { more: [rec('f')] })] }],
    ifRightPerson: [rec('g')],
    people: [{ name: 'Lena Ortiz', findings: [rec('h')] }],
  };
  const out = publicReport(report);
  const bad = [];
  const walk = (v, path) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (typeof v.id === 'string' && ('match' in v || 'source' in v)) for (const k of ['score', 'step', 'via', 'matchFixed', 'gradeText']) if (k in v) bad.push(`${path}.${k}`);
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(out, 'report');
  expect(bad).toEqual([]);
  // what is not a record is kept as it is, and the record keeps everything else
  expect(out.totals).toEqual({ redFlags: 1, step: 4 });
  expect(out.ifRightPerson[0]).toMatchObject({ id: 'g', match: 'likely', title: 'g' });
  expect(out.sections[0].items[0].more[0].id).toBe('f');
});
