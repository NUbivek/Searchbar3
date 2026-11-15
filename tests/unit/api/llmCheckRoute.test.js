jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => null) }));
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(async () => ({ text: '7 years', providerLabel: 'Google Gemini', model: 'gemini-3.8-flash', ms: 900, skipped: [] })),
  chatJson: jest.fn(async () => ({ data: { capital: 'Paris', country: 'France' }, providerLabel: 'OpenRouter', model: 'x:free', skipped: [] })),
  describeChain: jest.fn(async ({ task }) => ({ order: [{ provider: 'Google Gemini', model: `best-for-${task}`, score: 90 }], passedOver: [] })),
  llmStatus: jest.fn(() => [{ id: 'gemini', label: 'Google Gemini', enabled: true, keySet: true, note: 'x' }]),
  PROVIDERS: [{ id: 'gemini' }],
  providerEnabled: jest.fn(() => true),
  llmConfigured: jest.fn(() => true),
}));

jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { getUserId } = require('../../../src/server/auth');
const providers = require('../../../src/server/llm/providers');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/debug/llm-check').default;

describe('/api/debug/llm-check', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.clearAllMocks(); });

  test('GET only', async () => {
    const res = createMockRes();
    await handler(createMockReq({ method: 'POST' }), res);
    expect(res.statusCode).toBe(405);
  });

  test('lists the order per task without calling a model, and never returns key details', async () => {
    const res = createMockRes();
    await handler(createMockReq({ method: 'GET', query: {} }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.analysis.order[0].model).toBe('best-for-analysis');
    expect(res.body.extract.order[0].model).toBe('best-for-extract');
    expect(res.body.providers).toEqual([{ id: 'gemini', label: 'Google Gemini', enabled: true }]);
    expect(providers.chatComplete).not.toHaveBeenCalled();
  });

  test('a run makes one small call for that task', async () => {
    const res = createMockRes();
    await handler(createMockReq({ method: 'GET', query: { run: 'analysis', personal: '1' } }), res);
    expect(res.body).toEqual(expect.objectContaining({ run: 'analysis', ok: true, model: 'gemini-3.8-flash', text: '7 years' }));
    expect(providers.chatComplete.mock.calls[0][1]).toEqual(expect.objectContaining({ task: 'analysis', personal: true }));
    const json = createMockRes();
    await handler(createMockReq({ method: 'GET', query: { run: 'json' } }), json);
    expect(json.body.data).toEqual({ capital: 'Paris', country: 'France' });
    const bad = createMockRes();
    await handler(createMockReq({ method: 'GET', query: { run: 'everything' } }), bad);
    expect(bad.statusCode).toBe(400);
  });

  test('the report writer and the second reader can be tried on a fictional sample', async () => {
    const { sampleState } = require('../../../src/server/founder/sample');
    const { buildReport } = require('../../../src/server/founder/report');
    const report = buildReport(sampleState());
    // the sample exercises every part of a report
    expect(report.totals).toMatchObject({ redFlags: 3, possibleNamesake: 1 }); // a suit, a director bar, a changed degree; and one name-only record
    expect(report.claimChanges).toHaveLength(1);
    expect(JSON.stringify(report)).toMatch(/Quillfeather/);
    providers.chatComplete.mockResolvedValueOnce(null);
    const res = createMockRes();
    await handler(createMockReq({ method: 'GET', query: { run: 'brief' } }), res);
    expect(res.body).toEqual(expect.objectContaining({ run: 'brief', ok: false }));
    expect(res.body.briefInfo.mode).toBe('quoted');
    expect(res.body.brief).toMatch(/## RED FLAGS/);
    providers.chatJson.mockResolvedValueOnce({ model: 'm', data: { companies: [{ name: 'Tidewater Drones', record: 1, role: 'ran it' }], schools: [], people: [], searches: [] } });
    const gaps = createMockRes();
    await handler(createMockReq({ method: 'GET', query: { run: 'gaps' } }), gaps);
    expect(gaps.body.ok).toBe(true);
  });

  test('production needs a signed-in session; a preview deployment does not', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL_ENV;
    const res = createMockRes();
    await handler(createMockReq({ method: 'GET', query: {} }), res);
    expect(res.statusCode).toBe(401);
    getUserId.mockResolvedValueOnce('user-1');
    const signedIn = createMockRes();
    await handler(createMockReq({ method: 'GET', query: {} }), signedIn);
    expect(signedIn.statusCode).toBe(200);
    process.env.VERCEL_ENV = 'preview';
    const preview = createMockRes();
    await handler(createMockReq({ method: 'GET', query: {} }), preview);
    expect(preview.statusCode).toBe(200);
  });
});
