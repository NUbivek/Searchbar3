/**
 * Round 3, loose ends of the deep check's routes (from the lists phases 1 and 2 left):
 *   /api/founder/deep     accounts outside the allow-list are refused with a plain 403; all accounts together
 *                         start at most so many checks an hour; with no company typed, the one contact with the
 *                         name is offered as a question first and assumed only after a yes; investors are looked
 *                         up for the person's companies with the company they backed
 *   /api/founder/history  the same refusal
 *   /api/founder          the client address the limits count is the one the host set; one name check
 *   /signin               a refused sign-in says so plainly
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/auth', () => {
  const getUserId = jest.fn(async () => 'user-1');
  return {
    getUserId,
    // as auth.js does: 403 for an account the allow-list leaves out, 401 when signed out, else the id
    requireFounderUser: jest.fn(async (req, res) => {
      if (globalThis.__refuseAccount) { res.status(403).json({ error: 'The background check is not enabled for this account.' }); return null; }
      const id = await getUserId(req, res);
      if (!id) { res.status(401).json({ error: 'Sign in to use this feature.', signIn: true }); return null; }
      return id;
    }),
    callerAddress: jest.requireActual('../../../src/server/auth').callerAddress,
  };
});
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null), chatJson: jest.fn(async () => null), llmConfigured: () => false, PROVIDERS: [], providerEnabled: () => false }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [] })) }));
jest.mock('../../../src/server/network/store', () => ({ countContacts: jest.fn(async () => 3), findContactsAtCompanies: jest.fn(async () => []), findContactsByNames: jest.fn(async () => []) }));
jest.mock('../../../src/server/founder/networkLink', () => {
  const actual = jest.requireActual('../../../src/server/founder/networkLink');
  return {
    ...actual,
    seedSuggestion: jest.fn(async () => null),
    companySeed: jest.fn(async () => null),
    lookupInvestorsForCompanies: jest.fn(async () => ({ investors: [{ name: 'Kappa Fund', of: 'Acme Corp' }], complete: true, missed: [] })),
    lookupInvestorsResult: jest.fn(async () => ({ investors: [], complete: true })),
    networkForReport: jest.fn(async () => ({ available: true, groups: [] })),
    listFinishedChecks: jest.fn(async () => []),
    listRunningChecks: jest.fn(async () => []),
  };
});
jest.mock('../../../src/server/founder/sources', () => {
  const { makeFinding } = jest.requireActual('../../../src/server/founder/finding');
  return { CONNECTORS: [{
    id: 'fake', label: 'Fake registry', kinds: ['subject', 'company'],
    run: async (task, { subject }) => ({ findings: task.kind === 'subject' ? [makeFinding(subject, { source: 'fake', sourceLabel: 'Fake registry', category: 'corporate', title: 'Jane Roe of Acme Corp', quote: 'Jane Roe, CEO of Acme Corp.', url: 'https://reg.test/1' })] : [] }),
  }] };
});

const auth = require('../../../src/server/auth');
const link = require('../../../src/server/founder/networkLink');
const { __resetJobsForTests, createJob, getJob } = require('../../../src/server/founder/jobStore');
const { __resetLearningForTests } = require('../../../src/server/learning');
const deep = require('../../../src/pages/api/founder/deep');
const history = require('../../../src/pages/api/founder/history').default;

function call(handler, method, { body, query, headers } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    handler({ method, body, query: query || {}, headers: headers || { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } }, res);
  });
}
const start = (extra = {}) => call(deep.default, 'POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme Corp', ...extra } });

beforeEach(() => {
  __resetJobsForTests(); __resetLearningForTests();
  globalThis.__refuseAccount = false;
  auth.getUserId.mockResolvedValue('user-1');
  link.seedSuggestion.mockReset().mockResolvedValue(null);
  link.companySeed.mockReset().mockResolvedValue(null);
  link.lookupInvestorsForCompanies.mockClear();
  delete process.env.FOUNDER_DEEP_PUBLIC;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { console.error.mockRestore(); console.warn.mockRestore(); });

describe('who may run a check (needs-phase2 fix:security)', () => {
  test('an account the allow-list leaves out is told plainly, on the check and on its history', async () => {
    globalThis.__refuseAccount = true;
    const r = await start();
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/not enabled for this account/);
    const h = await call(history, 'GET');
    expect(h.status).toBe(403);
    expect(h.body.error).toMatch(/not enabled for this account/);
  });

  test('signed out is still asked to sign in', async () => {
    auth.getUserId.mockResolvedValue(null);
    const r = await start();
    expect(r.status).toBe(401);
    expect(r.body.signIn).toBe(true);
    expect((await call(history, 'GET')).status).toBe(401);
  });

  test('all accounts together start at most so many checks an hour', async () => {
    for (let i = 0; i < deep.MAX_JOBS_ALL_PER_HOUR; i += 1) await createJob({ name: `Person ${i}`, owner: `user-${i + 100}`, state: { phase: 'collect' } });
    const r = await start();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('Many checks have been started in the last hour. Try again later.');
  });
});

describe('a company from the user\'s network (needs-phase2 fix:network)', () => {
  test('with no company typed, the one contact with the name is asked about first, and nothing starts', async () => {
    link.seedSuggestion.mockResolvedValue({ company: 'Acme Robotics', question: 'Is this the Jane Roe at Acme Robotics in your network?' });
    const r = await start({ company: '', askNetwork: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ needsConfirm: { company: 'Acme Robotics', question: 'Is this the Jane Roe at Acme Robotics in your network?' } });
    expect(link.companySeed).not.toHaveBeenCalled();
  });

  test('a page that cannot ask yet starts without assuming, and is told what it could ask', async () => {
    link.seedSuggestion.mockResolvedValue({ company: 'Acme Robotics', question: 'Is this the Jane Roe at Acme Robotics in your network?' });
    const r = await start({ company: '' });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBeTruthy();
    expect(r.body.assumed).toBeUndefined();
    expect(r.body.networkSuggestion).toEqual({ company: 'Acme Robotics', question: expect.any(String) });
    const job = await getJob(r.body.jobId, { owner: 'user-1' });
    expect(job.state.assumedCompany).toBeUndefined();
  });

  test('after a yes the company is assumed, with the network as its origin', async () => {
    link.companySeed.mockResolvedValue({ company: 'Acme Robotics', origin: 'network' });
    const r = await start({ company: '', confirmedCompany: 'Acme Robotics' });
    expect(r.status).toBe(200);
    expect(link.companySeed).toHaveBeenCalledWith('user-1', 'Jane Roe', '', { confirmedCompany: 'Acme Robotics' });
    expect(link.seedSuggestion).not.toHaveBeenCalled();
    expect(r.body.assumed).toEqual({ company: 'Acme Robotics' });
    const job = await getJob(r.body.jobId, { owner: 'user-1' });
    expect(job.state.networkSeed).toEqual({ company: 'Acme Robotics', origin: 'network' });
    expect(job.state.anchors.companies).toEqual([{ value: 'Acme Robotics', origin: 'network' }]);
  });

  test('investors are looked up for the person\'s companies together, and kept with the company they backed', async () => {
    const { body: { jobId } } = await start();
    let r;
    for (let i = 0; i < 12; i += 1) { r = await call(deep.default, 'POST', { body: { action: 'step', jobId } }); if (r.body.done) break; }
    expect(r.body.done).toBe(true);
    expect(link.lookupInvestorsForCompanies).toHaveBeenCalledWith(expect.arrayContaining(['Acme Corp']), expect.objectContaining({ max: 3 }));
    const job = await getJob(jobId, { owner: 'user-1' });
    expect(job.state.networkInvestors).toEqual([{ name: 'Kappa Fund', of: 'Acme Corp' }]);
    expect(job.state.networkInvestorsMissed).toBeUndefined();
  });
});

describe('the sign-in page (needs-phase2 fix:security)', () => {
  test('a refused sign-in says sign-in is not enabled for this account', () => {
    const fs = require('fs');
    const text = fs.readFileSync(require.resolve('../../../src/pages/signin.js'), 'utf8');
    expect(text).toMatch(/AccessDenied: 'Sign-in is not enabled for this account\.'/);
  });
});
