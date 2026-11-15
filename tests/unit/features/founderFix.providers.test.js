/**
 * @jest-environment node
 *
 * Fixes in the model chain (src/server/llm/providers.js): the tripwires,
 * the catch-all model and people checks, the wording of skip reasons, and
 * the retry after a rejected request keeping to the deadline.
 */
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const KEYS = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'LLM_SKIP_GEMINI_FOR_PEOPLE'];
const env = { ...process.env };
const free = (id) => ({ id, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } });
const LISTS = {
  gemini: ['models/gemini-3.8-flash'],
  openrouter: [free('thinkingmachines/inkling-2-small:free'), free('deepseek/deepseek-x:free'), free('newlab/unscored-1:free')],
  groq: ['qwen/qwen3.8-27b'],
};

function load({ keys, persistence = 'none', rows = [] }) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, keys);
  jest.resetModules();
  const axios = require('axios');
  const db = require('../../../src/server/db');
  db.persistenceMode.mockReturnValue(persistence);
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => (/SELECT key, body FROM source_cache/.test(sql) ? rows : []));
  axios.get.mockReset();
  axios.post.mockReset();
  axios.get.mockImplementation(async (url) => {
    if (url.endsWith('/key')) return { data: { data: {} } };
    const which = url.includes('generativelanguage') ? 'gemini' : url.includes('openrouter') ? 'openrouter' : 'groq';
    return { data: { data: LISTS[which].map((m) => (typeof m === 'string' ? { id: m } : m)) } };
  });
  return { axios, db, providers: require('../../../src/server/llm/providers') };
}

const reply = (text, { headers = {}, data = {} } = {}) => ({ data: { choices: [{ message: { content: text } }], ...data }, headers });
const ask = [{ role: 'user', content: 'hi' }];
const BANNED = /\b(key|quota|paid|tokens?|tier|free|api|endpoint)\b/i;
const shareCalls = (db) => db.query.mock.calls.filter(([sql]) => /INSERT INTO source_cache/.test(sql));

let quiet;
beforeEach(() => { quiet = ['warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation(() => {})); });
afterEach(() => { quiet.forEach((s) => s.mockRestore()); jest.restoreAllMocks(); });
afterAll(() => { process.env = env; });

describe('tripwires', () => {
  test('Groq reporting paid-plan limits: the answer is discarded, the next model answers, the switch-off is shared for a long time', async () => {
    const { axios, db, providers } = load({ keys: { GROQ_API_KEY: 'gq', GOOGLE_AI_API_KEY: 'ga' }, persistence: 'postgres' });
    axios.post.mockImplementation(async (url) => (url.includes('groq')
      ? reply('from groq', { headers: { 'x-ratelimit-limit-tokens': '250000' } })
      : reply('from gemini')));
    // Groq first: make it the preferred model
    const out = await providers.chatComplete(ask, { preferred: 'groq:qwen/qwen3.8-27b' });
    expect(out.provider).toBe('gemini');
    expect(out.text).toBe('from gemini');
    expect(out.skipped).toEqual([{ provider: 'Groq', model: 'qwen/qwen3.8-27b', why: 'not available' }]);
    const shares = shareCalls(db);
    expect(shares).toHaveLength(1);
    expect(shares[0][1][0]).toBe('llm-rest:groq:*');
    const body = JSON.parse(shares[0][1][1]);
    expect(Number.isFinite(body.until)).toBe(true);
    expect(body.until).toBeGreaterThan(Date.now() + 7 * 24 * 3600 * 1000);
    expect(body.why).not.toMatch(BANNED);
    // and this instance does not ask Groq again
    axios.post.mockClear();
    await providers.chatComplete(ask, { preferred: 'groq:qwen/qwen3.8-27b' });
    expect(axios.post.mock.calls.map(([url]) => url).join(' ')).not.toMatch(/groq/);
  });

  test('another instance that reads the shared switch-off never calls Groq', async () => {
    const until = Date.now() + 30 * 24 * 3600 * 1000;
    const { axios, providers } = load({ keys: { GROQ_API_KEY: 'gq' }, persistence: 'postgres', rows: [{ key: 'llm-rest:groq:*', body: { until, why: 'not available' } }] });
    expect(await providers.chatComplete(ask)).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('OpenRouter answering with a model that is not free: the answer is discarded and the switch-off is shared', async () => {
    const { axios, db, providers } = load({ keys: { OPENROUTER_API_KEY: 'or' }, persistence: 'postgres' });
    axios.post.mockResolvedValue(reply('paid answer', { data: { model: 'openai/gpt-5' } }));
    expect(await providers.chatComplete(ask)).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(shareCalls(db).map(([, args]) => args[0])).toEqual(['llm-rest:openrouter:*']);
  });
});

describe('people checks', () => {
  test('an unscored model (operator unknown) never receives text about a person under review', async () => {
    const { providers } = load({ keys: { OPENROUTER_API_KEY: 'or' } });
    const personal = (await providers.describeChain({ task: 'chat', personal: true })).order.map((m) => m.model);
    const plain = (await providers.describeChain({ task: 'chat' })).order.map((m) => m.model);
    expect(personal).not.toContain('deepseek/deepseek-x:free');
    expect(personal).not.toContain('newlab/unscored-1:free');
    expect(personal).toContain('thinkingmachines/inkling-2-small:free');
    expect(plain).toContain('deepseek/deepseek-x:free'); // still a fallback for ordinary answers
  });
});

describe('skip reasons shown to people are plain English', () => {
  test.each([429, 402, 401, 403, 404, 413, 400, 500, 503])('status %i', (status) => {
    const { providers } = load({ keys: { GOOGLE_AI_API_KEY: 'ga' } });
    expect(providers.describeFailure({ response: { status } }).why).not.toMatch(BANNED);
  });

  test('every reason in the list, and an answer cut short', async () => {
    const { axios, providers } = load({ keys: { GOOGLE_AI_API_KEY: 'ga' } });
    for (const why of Object.values(providers.WHY)) expect(why).not.toMatch(BANNED);
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: '' }, finish_reason: 'length' }] }, headers: {} });
    const trace = [];
    await providers.chatComplete(ask, { trace });
    expect(trace[0].why).toBe('answer was cut short');
  });

  test('a rate-limited model is described as resting', async () => {
    const { axios, providers } = load({ keys: { GOOGLE_AI_API_KEY: 'ga', OPENROUTER_API_KEY: 'or' } });
    axios.post.mockImplementation(async (url) => {
      if (url.includes('generativelanguage')) throw Object.assign(new Error('429'), { response: { status: 429 } });
      return reply('ok');
    });
    const out = await providers.chatComplete(ask, { preferred: 'gemini:gemini-3.8-flash' });
    expect(out.skipped[0]).toEqual({ provider: 'Google Gemini', model: 'gemini-3.8-flash', why: 'resting until its allowance resets' });
  });
});

describe('the retry after a rejected request keeps to the deadline', () => {
  test('with less than the minimum attempt time left, the rejection stands and no retry is sent', async () => {
    const { axios, providers } = load({ keys: { GOOGLE_AI_API_KEY: 'ga' } });
    const base = Date.now();
    let offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => base + offset);
    axios.post.mockImplementation(async () => {
      offset = 7000; // the first request took 7 s, leaving 1 s before the deadline
      throw Object.assign(new Error('400'), { response: { status: 400 } });
    });
    const trace = [];
    expect(await providers.chatComplete(ask, { deadline: base + 8000, trace })).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(trace[0].why).toBe('request rejected');
  });

  test('with room left, the retry runs without the extra settings and its timeout fits before the deadline', async () => {
    const { axios, providers } = load({ keys: { GOOGLE_AI_API_KEY: 'ga' } });
    const base = Date.now();
    let offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => base + offset);
    axios.post
      .mockImplementationOnce(async () => { offset = 2000; throw Object.assign(new Error('400'), { response: { status: 400 } }); })
      .mockImplementationOnce(async () => reply('ok'));
    const out = await providers.chatComplete(ask, { deadline: base + 30000 });
    expect(out.text).toBe('ok');
    expect(axios.post).toHaveBeenCalledTimes(2);
    const [, retryBody, retryOptions] = axios.post.mock.calls[1];
    expect(retryBody.reasoning_effort).toBeUndefined();
    expect(retryOptions.timeout).toBeLessThanOrEqual(28000);
  });
});
