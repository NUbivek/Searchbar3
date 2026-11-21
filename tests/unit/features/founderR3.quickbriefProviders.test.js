/**
 * @jest-environment node
 *
 * Round 3, quick brief: the model chain (src/server/llm/providers.js).
 * - the side-by-side request never sends the same question twice to the service already waiting on it;
 * - a service that timed out is remembered (on every instance) and asked after the others;
 * - chain set-up can start early, and requests made meanwhile share it;
 * - Groq's qwen is not asked to think with a tiny answer allowance.
 */
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const KEYS = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'TOGETHER_API_KEY', 'CEREBRAS_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'LLM_ALLOW_PAID', 'LLM_SKIP_GEMINI_FOR_PEOPLE'];
const env = { ...process.env };
const LISTS = {
  gemini: ['models/gemini-4-hydrogen', 'models/gemini-3.8-flash'],
  openrouter: [
    { id: 'thinkingmachines/inkling-2-small:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['reasoning'] },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, supported_parameters: [] },
  ],
  groq: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'],
};

function load({ keys = { GOOGLE_AI_API_KEY: 'ga', OPENROUTER_API_KEY: 'or', GROQ_API_KEY: 'gq' }, extraEnv = {}, persistence = 'none', rows = [], listDelay = 0 } = {}) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, keys, extraEnv);
  jest.resetModules();
  const axios = require('axios');
  const db = require('../../../src/server/db');
  db.persistenceMode.mockReturnValue(persistence);
  db.query.mockReset().mockImplementation(async (sql) => (/SELECT key, body FROM source_cache/.test(sql) ? rows : []));
  axios.get.mockReset();
  axios.post.mockReset();
  axios.get.mockImplementation(async (url) => {
    if (listDelay) await new Promise((r) => setTimeout(r, listDelay));
    if (url.endsWith('/key')) return { data: { data: {} } };
    const which = url.includes('generativelanguage') ? 'gemini' : url.includes('openrouter') ? 'openrouter' : 'groq';
    return { data: { data: (LISTS[which] || []).map((m) => (typeof m === 'string' ? { id: m } : m)) } };
  });
  const providers = require('../../../src/server/llm/providers');
  return { axios, db, providers };
}

const service = (url) => (url.match(/generativelanguage|openrouter|groq/) || [])[0].replace('generativelanguage', 'gemini');
const reply = (text) => ({ data: { choices: [{ message: { content: text } }] }, headers: {} });
const ask = [{ role: 'user', content: 'hi' }];

afterEach(() => { jest.useRealTimers(); });
afterAll(() => { process.env = env; });

describe('quickbrief-hedge-avoids-wrong-service (fixed by the side-by-side race)', () => {
  test('with Gemini skipped for people, the second request goes to another service, never the one already waiting', async () => {
    jest.useFakeTimers();
    const { axios, providers } = load({ extraEnv: { LLM_SKIP_GEMINI_FOR_PEOPLE: 'true' } });
    const running = {};
    const most = {};
    axios.post.mockImplementation((url, body, options = {}) => new Promise((resolve, reject) => {
      const s = service(url);
      running[s] = (running[s] || 0) + 1;
      most[s] = Math.max(most[s] || 0, running[s]);
      options.signal?.addEventListener('abort', () => { running[s] -= 1; reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })); });
      if (s === 'groq') setTimeout(() => { running[s] -= 1; resolve(reply('from groq')); }, 50);
    }));
    const pending = providers.chatComplete(ask, { personal: true, deadline: Date.now() + 40000, hedgeMs: 100 });
    await jest.advanceTimersByTimeAsync(9000);
    const out = await pending;
    expect(out.text).toBe('from groq');
    const asked = axios.post.mock.calls.map(([url]) => service(url));
    expect(asked[0]).toBe('openrouter');
    expect(asked[1]).toBe('groq');
    expect(asked).not.toContain('gemini');
    expect(Object.values(most).every((n) => n === 1)).toBe(true);
  });
});

describe('quickbrief-timeouts-not-remembered (fixed: a slow service is marked on every instance)', () => {
  test('a timeout marks the service slow in the shared store, and a fresh instance leads with another service', async () => {
    const { axios, db, providers } = load({ persistence: 'neon' });
    axios.post.mockImplementation(async (url) => {
      if (service(url) === 'gemini') throw Object.assign(new Error('timeout of 24000ms exceeded'), { code: 'ECONNABORTED' });
      return reply('ok');
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await providers.chatComplete(ask, {});
    expect(out.provider).not.toBe('gemini');
    const shared = db.query.mock.calls.filter(([sql]) => /INSERT INTO source_cache/.test(sql)).map(([, params]) => params[0]);
    expect(shared).toContain('llm-rest:slow:gemini');

    const until = Date.now() + 10 * 60000;
    const cold = load({ persistence: 'neon', rows: [{ key: 'llm-rest:slow:gemini', body: { until, why: 'slow' } }] });
    const chain = await cold.providers.describeChain({ task: 'chat' });
    expect(chain.order[0].provider).not.toBe('Google Gemini');
    console.warn.mockRestore();
  });
});

describe('quickbrief-cold-start-budget: chain set-up starts early and is shared', () => {
  test('prepareChain starts the model lists; a request made meanwhile waits on the same lookups instead of starting its own', async () => {
    const { axios, providers } = load({ listDelay: 30 });
    axios.post.mockResolvedValue(reply('ok'));
    const early = providers.prepareChain({ personal: true });
    const out = await providers.chatComplete(ask, { personal: true });
    await early;
    expect(out.text).toBe('ok');
    const lists = axios.get.mock.calls.map(([url]) => url).filter((u) => u.endsWith('/models'));
    expect(lists).toHaveLength(3); // one per service, not two
  });
});

describe('quickbrief-groq-reasoning-cutoff', () => {
  test('qwen on Groq: no hidden reasoning for a quick answer; with room, reasoning gets its own allowance', async () => {
    const { axios, providers } = load({ keys: { GROQ_API_KEY: 'gq' } });
    axios.post.mockResolvedValue(reply('ok'));
    await providers.chatComplete(ask, { preferred: 'groq:qwen/qwen3.8-27b', maxTokens: 1300, effort: 'low' });
    let body = axios.post.mock.calls[0][1];
    expect(body.model).toBe('qwen/qwen3.8-27b');
    expect(body.reasoning_effort).toBe('none');
    expect(body.max_completion_tokens).toBe(1300);

    axios.post.mockClear();
    await providers.chatComplete(ask, { preferred: 'groq:qwen/qwen3.8-27b', maxTokens: 1300, task: 'chat' });
    body = axios.post.mock.calls[0][1];
    expect(body.reasoning_effort).not.toBe('high'); // Groq's qwen takes only none or default
    if (body.reasoning_effort === 'default') expect(body.max_completion_tokens).toBeGreaterThanOrEqual(1300 + 2000);
  });

  test('gpt-oss on Groq gets room to reason beside the answer, within the per-minute allowance', async () => {
    const { axios, providers } = load({ keys: { GROQ_API_KEY: 'gq' } });
    axios.post.mockResolvedValue(reply('ok'));
    await providers.chatComplete(ask, { preferred: 'groq:openai/gpt-oss-120b', maxTokens: 1300 });
    const body = axios.post.mock.calls[0][1];
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.max_completion_tokens).toBeGreaterThan(1300);
    expect(body.max_completion_tokens).toBeLessThanOrEqual(8000 - 300);
  });
});
