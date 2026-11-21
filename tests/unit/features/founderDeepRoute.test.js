/**
 * POST /api/founder/deep: sign-in, validation, the step loop and the hourly
 * limit. Sources, the model and the database are faked.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/auth', () => {
  const getUserId = jest.fn(async () => 'user-1');
  // requireFounderUser answers 401 itself when signed out (and 403 for an account outside the allow-list)
  const requireFounderUser = jest.fn(async (req, res) => { const id = await getUserId(req, res); if (!id) { res.status(401).json({ error: 'Sign in to use this feature.', signIn: true }); return null; } return id; });
  return { getUserId, requireFounderUser };
});
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null), chatJson: jest.fn(async () => null), llmConfigured: () => false, PROVIDERS: [], providerEnabled: () => false }));
jest.mock('../../../src/server/founder/sources', () => {
  const { makeFinding, makeThread } = jest.requireActual('../../../src/server/founder/finding');
  return {
    CONNECTORS: [{
      id: 'fake', label: 'Fake registry', kinds: ['subject', 'company'],
      run: async (task, { subject }) => (task.kind === 'subject'
        ? { findings: [makeFinding(subject, { source: 'fake', sourceLabel: 'Fake registry', category: 'regulatory', severity: 'high', title: 'Jane Roe of Acme barred by regulator', quote: 'Jane Roe, CEO of Acme, was barred.', url: 'https://reg.test/1', date: '2024-02-02' })], threads: [makeThread('company', 'Beta Labs', 'founder (past; Wikidata)', { trusted: true })] }
        : { findings: [makeFinding(subject, { source: 'fake', sourceLabel: 'Fake registry', category: 'corporate', title: `${task.value}: Jane Roe listed as director`, quote: `Jane Roe is a director of ${task.value}.`, url: `https://reg.test/co/${encodeURIComponent(task.value)}` })] }),
    }],
  };
});

// The brief, the profile read, the investor lookup and the network read are real unless a test slows one down.
jest.mock('../../../src/server/founder/report', () => {
  const actual = jest.requireActual('../../../src/server/founder/report');
  return { ...actual, writeDeepBrief: jest.fn(actual.writeDeepBrief) };
});
jest.mock('../../../src/server/founder/profileModel', () => {
  const actual = jest.requireActual('../../../src/server/founder/profileModel');
  return { ...actual, readProfile: jest.fn(actual.readProfile) };
});
jest.mock('../../../src/server/network/store', () => {
  const actual = jest.requireActual('../../../src/server/network/store');
  return { ...actual, countContacts: jest.fn(actual.countContacts) };
});
jest.mock('../../../src/server/founder/networkLink', () => {
  const actual = jest.requireActual('../../../src/server/founder/networkLink');
  return { ...actual, networkForReport: jest.fn(actual.networkForReport) };
});
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [] })) }));

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
  // (a new person: the same person still running is handed back, and uses no slot)
  const blocked = await call('POST', { body: { action: 'start', name: 'Jane Doe', company: 'Acme' } });
  expect(blocked.status).toBe(429);
});

describe('the report step always answers inside the 60s limit', () => {
  const reportMod = require('../../../src/server/founder/report');
  const profileMod = require('../../../src/server/founder/profileModel');
  const store = require('../../../src/server/network/store');
  const linkMod = require('../../../src/server/founder/networkLink');
  const companyProfile = require('../../../src/server/companyProfile');
  const { REPORT_BUDGET } = require('../../../src/pages/api/founder/deep');
  const never = () => new Promise(() => {});
  const after = (ms, value) => new Promise((resolve) => { setTimeout(() => resolve(value), ms); });
  const realImmediate = setImmediate;

  /** Runs a call on the fake clock and returns its answer and how long it took on that clock. */
  async function timed(method, opts) {
    const t0 = Date.now();
    let out = null;
    call(method, opts).then((r) => { out = r; });
    while (!out) {
      await jest.advanceTimersByTimeAsync(100);
      await new Promise((r) => realImmediate(r));
      if (Date.now() - t0 > 120000) throw new Error('no answer within 120s');
    }
    return { ...out, elapsed: Date.now() - t0 };
  }
  /** Start a check and step it until the next step builds the report. */
  async function toReportStep() {
    const started = await timed('POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme' } });
    let r = started;
    for (let i = 0; i < 10 && r.body.progress?.phase === 'collect'; i += 1) r = await timed('POST', { body: { action: 'step', jobId: started.body.jobId } });
    expect(r.body.done).toBeFalsy();
    return started.body.jobId;
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    store.countContacts.mockResolvedValue(3); // signed in, with contacts
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const m of [reportMod.writeDeepBrief, profileMod.readProfile, store.countContacts, linkMod.networkForReport, companyProfile.buildCompanyProfile]) m.mockReset();
    const actualReport = jest.requireActual('../../../src/server/founder/report');
    const actualProfile = jest.requireActual('../../../src/server/founder/profileModel');
    const actualLink = jest.requireActual('../../../src/server/founder/networkLink');
    const actualStore = jest.requireActual('../../../src/server/network/store');
    reportMod.writeDeepBrief.mockImplementation(actualReport.writeDeepBrief);
    profileMod.readProfile.mockImplementation(actualProfile.readProfile);
    linkMod.networkForReport.mockImplementation(actualLink.networkForReport);
    store.countContacts.mockImplementation(actualStore.countContacts);
    companyProfile.buildCompanyProfile.mockImplementation(async () => ({ investors: [] }));
  });

  test('every part hangs: the report still comes back well before 60s, saying what was cut short', async () => {
    const jobId = await toReportStep();
    reportMod.writeDeepBrief.mockImplementation(never);
    profileMod.readProfile.mockImplementation(never);
    companyProfile.buildCompanyProfile.mockImplementation(never);
    linkMod.networkForReport.mockImplementation(never);
    const r = await timed('POST', { body: { action: 'step', jobId } });
    expect(r.status).toBe(200);
    expect(r.body.done).toBe(true);
    expect(r.elapsed).toBeLessThanOrEqual(REPORT_BUDGET.NETWORK_UNTIL_MS + 500);
    expect(r.elapsed).toBeLessThan(58000);
    // the brief that did not come back is replaced by the records-only brief, and one more try is offered
    expect(r.body.report.briefInfo).toMatchObject({ mode: 'quoted', retry: true });
    expect(r.body.report.brief).toMatch(/## RED FLAGS/);
    // the network read that did not finish is not shown as an empty result
    expect(r.body.report.network).toMatchObject({ available: false, reason: expect.stringMatching(/too long/) });
    // the investor lookup that did not finish is carried to the next read, which says so
    linkMod.networkForReport.mockImplementation(async () => ({ available: true, notes: [] }));
    const again = await timed('GET', { query: { jobId } });
    expect(linkMod.networkForReport).toHaveBeenLastCalledWith('user-1', expect.anything(), expect.objectContaining({ investorsMissed: true }));
    expect(again.body.report.network).toMatchObject({ available: true });
  });

  test('a brief that overshoots its deadline (back at 49.5s) is cut off; the investor lookup and network read keep to their shares', async () => {
    const jobId = await toReportStep();
    reportMod.writeDeepBrief.mockImplementation((report) => after(49500, { brief: '## BOTTOM LINE late', briefInfo: { mode: 'ai' } }));
    profileMod.readProfile.mockImplementation((report) => after(30000, report.profile || null));
    companyProfile.buildCompanyProfile.mockImplementation(() => after(20000, { investors: [{ name: 'Omega Ventures' }] }));
    linkMod.networkForReport.mockImplementation(() => after(4000, { available: true, notes: [] }));
    const r = await timed('POST', { body: { action: 'step', jobId } });
    expect(r.status).toBe(200);
    expect(r.elapsed).toBeLessThan(58000);
    expect(r.body.report.brief).not.toMatch(/late/);
    expect(r.body.report.briefInfo).toMatchObject({ mode: 'quoted' });
    expect(reportMod.writeDeepBrief.mock.calls[0][1].deadline).toBeLessThanOrEqual(Date.now()); // asked to finish inside its share
    expect(profileMod.readProfile.mock.calls[0][2].deadline - reportMod.writeDeepBrief.mock.calls[0][1].deadline).toBeLessThan(0); // the profile read ends first
  });

  test('a brief back in time is used, and a network read that fits its share is shown', async () => {
    const jobId = await toReportStep();
    reportMod.writeDeepBrief.mockImplementation(() => after(40000, { brief: '## BOTTOM LINE on time [Source 1]', briefInfo: { mode: 'ai' } }));
    companyProfile.buildCompanyProfile.mockImplementation(() => after(1000, { investors: [{ name: 'Omega Ventures' }] }));
    linkMod.networkForReport.mockImplementation(() => after(500, { available: true, notes: [] }));
    const r = await timed('POST', { body: { action: 'step', jobId } });
    expect(r.body.report.brief).toMatch(/on time/);
    expect(r.body.report.network).toEqual({ available: true, notes: [] });
    expect(linkMod.networkForReport).toHaveBeenLastCalledWith('user-1', expect.anything(), expect.objectContaining({ investors: [{ name: 'Omega Ventures', of: 'Acme' }], investorsMissed: false }));
  });

  test('the second try at the brief is cut off at the same share and stops offering more tries', async () => {
    const jobId = await toReportStep();
    reportMod.writeDeepBrief.mockImplementation(never);
    await timed('POST', { body: { action: 'step', jobId } });
    const r = await timed('POST', { body: { action: 'brief', jobId } });
    expect(r.status).toBe(200);
    expect(r.elapsed).toBeLessThan(58000);
    expect(r.body.report.briefInfo).toMatchObject({ mode: 'quoted', retry: false });
  });
});
