/**
 * @jest-environment node
 *
 * Asking several model services side by side (chatComplete's hedgeMs): one slow or failing service
 * must not cost the answer, a clearly stronger model gets a short grace, the caller always has its
 * answer (or null) by the deadline, and a service that was too slow is asked after the others next time.
 */
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const KEYS = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'TOGETHER_API_KEY', 'CEREBRAS_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'LLM_ALLOW_PAID', 'LLM_SKIP_GEMINI_FOR_PEOPLE'];
const env = { ...process.env };

const LISTS = {
  gemini: ['models/gemini-4-hydrogen', 'models/gemini-3.8-flash', 'models/gemini-3.5-flash-lite'],
  openrouter: [
    { id: 'thinkingmachines/inkling-2-small:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['reasoning'] },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, supported_parameters: [] },
  ],
  groq: ['qwen/qwen3.8-27b'],
};

function load() {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { GOOGLE_AI_API_KEY: 'ga', OPENROUTER_API_KEY: 'or', GROQ_API_KEY: 'gq' });
  jest.resetModules();
  const axios = require('axios');
  axios.get.mockReset();
  axios.post.mockReset();
  axios.get.mockImplementation(async (url) => {
    if (url.endsWith('/key')) return { data: { data: {} } };
    const which = url.includes('generativelanguage') ? 'gemini' : url.includes('openrouter') ? 'openrouter' : 'groq';
    return { data: { data: (LISTS[which] || []).map((m) => (typeof m === 'string' ? { id: m } : m)) } };
  });
  const providers = require('../../../src/server/llm/providers');
  return { axios, providers };
}

const service = (url) => (url.match(/generativelanguage|openrouter|groq/) || [])[0].replace('generativelanguage', 'gemini');
const reply = (text) => ({ data: { choices: [{ message: { content: text } }] }, headers: {} });
const called = (axios) => axios.post.mock.calls.map(([url, body]) => `${service(url)}:${body.model}`);
const ask = [{ role: 'user', content: 'hi' }];

/**
 * A stand-in for the three services. `plan[service]` is a list of steps, one per request to that service:
 * { after: ms, text } answers, { after: ms, status } fails, 'hang' never answers (until dropped).
 */
function serve(axios, plan) {
  const state = { running: {}, most: {}, dropped: [] };
  const taken = {};
  axios.post.mockImplementation((url, body, options = {}) => new Promise((resolve, reject) => {
    const s = service(url);
    const step = (plan[s] || [])[taken[s] || 0] || 'hang';
    taken[s] = (taken[s] || 0) + 1;
    state.running[s] = (state.running[s] || 0) + 1;
    state.most[s] = Math.max(state.most[s] || 0, state.running[s]);
    const done = (fn) => { state.running[s] -= 1; fn(); };
    let timer = null;
    options.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      state.dropped.push(`${s}:${body.model}`);
      done(() => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })));
    });
    if (step === 'hang') return;
    timer = setTimeout(() => done(() => (step.status
      ? reject(Object.assign(new Error(`Request failed with status code ${step.status}`), { response: { status: step.status, data: {}, headers: {} } }))
      : resolve(reply(step.text)))), step.after);
  }));
  return state;
}

afterEach(() => { jest.useRealTimers(); });
afterAll(() => { process.env = env; });

describe('several services asked side by side', () => {
  test('a first service that does not answer no longer costs the answer, and is not blamed for losing', async () => {
    jest.useFakeTimers();
    const { axios, providers } = load();
    const state = serve(axios, { gemini: ['hang', 'hang'], openrouter: [{ after: 40, text: 'from the second service' }, { after: 40, text: 'again from the second service' }] });
    let pending = providers.chatComplete(ask, { deadline: Date.now() + 40000, hedgeMs: 60 });
    await jest.advanceTimersByTimeAsync(9000); // the answer in hand waits a few seconds for the stronger model, then is used
    let out = await pending;
    expect(out.text).toBe('from the second service');
    expect(out.provider).toBe('openrouter');
    expect(called(axios)).toEqual(['gemini:gemini-4-hydrogen', 'openrouter:thinkingmachines/inkling-2-small:free']);
    expect(state.dropped).toEqual(['gemini:gemini-4-hydrogen']); // the slower request is dropped
    expect(out.skipped).toEqual([]); // losing a race is not a failure
    expect(out).not.toHaveProperty('base');

    // The service that was waited for in vain is asked after the others next time, and is not waited for again
    axios.post.mockClear();
    const before = Date.now();
    pending = providers.chatComplete(ask, { deadline: Date.now() + 40000, hedgeMs: 60 });
    await jest.advanceTimersByTimeAsync(500);
    out = await pending;
    expect(out.text).toBe('again from the second service');
    expect(Date.now() - before).toBeLessThan(1000);
    expect(called(axios)[0]).toBe('openrouter:thinkingmachines/inkling-2-small:free');
  });

  test('a quick first answer needs no second request', async () => {
    const { axios, providers } = load();
    serve(axios, { gemini: [{ after: 10, text: 'quick' }] });
    const out = await providers.chatComplete(ask, { deadline: Date.now() + 30000, hedgeMs: 200 });
    expect(out.text).toBe('quick');
    expect(called(axios)).toEqual(['gemini:gemini-4-hydrogen']);
  });

  test('a failure is replaced at once, by another service first', async () => {
    const { axios, providers } = load();
    serve(axios, { gemini: [{ after: 5, status: 503 }], openrouter: [{ after: 20, text: 'replacement' }] });
    const started = Date.now();
    const out = await providers.chatComplete(ask, { deadline: Date.now() + 30000, hedgeMs: 20000 });
    expect(out.text).toBe('replacement');
    expect(Date.now() - started).toBeLessThan(2000); // did not wait for the hedge delay
    expect(called(axios)).toEqual(['gemini:gemini-4-hydrogen', 'openrouter:thinkingmachines/inkling-2-small:free']);
    expect(out.skipped).toEqual([expect.objectContaining({ model: 'gemini-4-hydrogen', why: providers.WHY.providerError })]);
  });

  test('an answer that fails the caller\'s checks sends the question on', async () => {
    const { axios, providers } = load();
    serve(axios, { gemini: [{ after: 5, text: 'no citations' }, { after: 5, text: 'cited [Source 1]' }] });
    const out = await providers.chatComplete(ask, { deadline: Date.now() + 30000, hedgeMs: 20000, accept: (t) => /\[Source \d+\]/.test(t) });
    expect(out.text).toBe('cited [Source 1]');
    expect(out.model).toBe('gemini-3.8-flash');
    expect(out.skipped).toEqual([expect.objectContaining({ model: 'gemini-4-hydrogen', why: 'answer did not pass checks' })]);
  });

  test('an answer in hand waits a few seconds for a clearly stronger model that is still writing', async () => {
    const { axios, providers } = load();
    serve(axios, { gemini: [{ after: 300, text: 'the stronger answer' }], openrouter: [{ after: 30, text: 'the faster answer' }] });
    const out = await providers.chatComplete(ask, { deadline: Date.now() + 30000, hedgeMs: 50 });
    expect(out.text).toBe('the stronger answer');
    expect(out.model).toBe('gemini-4-hydrogen');
  });

  test('while an answer is in hand no further service is started', async () => {
    jest.useFakeTimers();
    const { axios, providers } = load();
    const state = serve(axios, { gemini: ['hang'], openrouter: [{ after: 30, text: 'the faster answer' }] });
    const pending = providers.chatComplete(ask, { deadline: Date.now() + 40000, hedgeMs: 50 });
    await jest.advanceTimersByTimeAsync(9000);
    const out = await pending;
    expect(out.text).toBe('the faster answer');
    expect(state.dropped).toContain('gemini:gemini-4-hydrogen');
    expect(called(axios).filter((c) => c.startsWith('groq'))).toEqual([]);
  });

  test('nothing answers: null by the deadline, every request dropped, and one service never ran two requests at once', async () => {
    jest.useFakeTimers();
    const { axios, providers } = load();
    const state = serve(axios, {});
    let settled = false;
    const pending = providers.chatComplete(ask, { deadline: Date.now() + 30000, hedgeMs: 4000 }).then((v) => { settled = true; return v; });
    await jest.advanceTimersByTimeAsync(29000);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(3500);
    expect(await pending).toBeNull();
    expect(Object.values(state.most).every((n) => n === 1)).toBe(true);
    expect(Object.values(state.running).every((n) => n === 0)).toBe(true);
    expect(new Set(called(axios).map((c) => c.split(':')[0]))).toEqual(new Set(['gemini', 'openrouter', 'groq']));
  });

  test('a service that was too slow is asked after the others next time, until it answers in time again', async () => {
    jest.useFakeTimers();
    const { axios, providers } = load();
    serve(axios, {});
    const pending = providers.chatComplete(ask, { deadline: Date.now() + 30000, hedgeMs: 25000 });
    await jest.advanceTimersByTimeAsync(32000);
    expect(await pending).toBeNull();
    // Gemini had its fair share of the time and did not answer; the service that joined late is not blamed
    let chain = await providers.describeChain({ task: 'chat' });
    expect(chain.order[0].provider).not.toBe('Google Gemini');
    expect(chain.order[chain.order.length - 1].provider).toBe('Google Gemini');
    expect(chain.order.findIndex((c) => c.provider === 'OpenRouter')).toBeLessThan(chain.order.findIndex((c) => c.provider === 'Google Gemini'));

    // The others fail, so Gemini is asked after all, answers, and leads again
    jest.useRealTimers();
    serve(axios, { openrouter: [{ after: 1, status: 429 }, { after: 1, status: 429 }], groq: [{ after: 1, status: 429 }], gemini: [{ after: 5, text: 'back' }] });
    const out = await providers.chatComplete(ask, {});
    expect(out.text).toBe('back');
    chain = await providers.describeChain({ task: 'chat' });
    expect(chain.order[0].provider).toBe('Google Gemini');
  });

  test('a service that keeps the connection busy without answering is dropped at its time limit (one model at a time)', async () => {
    jest.useFakeTimers();
    const { axios, providers } = load();
    // a client whose own timeout never fires and which ignores being dropped: the chain must still move on
    axios.post.mockImplementation((url) => (service(url) === 'gemini' ? new Promise(() => {}) : Promise.resolve(reply('from the next service'))));
    let out;
    const pending = providers.chatComplete(ask, { deadline: Date.now() + 50000 }).then((v) => { out = v; });
    await jest.advanceTimersByTimeAsync(24000 + 500); // the first model's limit
    await jest.advanceTimersByTimeAsync(100);
    await pending;
    expect(out.text).toBe('from the next service');
    expect(out.skipped[0]).toEqual(expect.objectContaining({ model: 'gemini-4-hydrogen', why: 'timed out' }));
    expect(called(axios)).toEqual(['gemini:gemini-4-hydrogen', 'openrouter:thinkingmachines/inkling-2-small:free']);
  });

  test('and nothing can hold a request past its deadline, even a client that never returns', async () => {
    jest.useFakeTimers();
    const { axios, providers } = load();
    axios.post.mockImplementation(() => new Promise(() => {}));
    for (const hedgeMs of [0, 4000]) {
      let done = false;
      const pending = providers.chatComplete(ask, { deadline: Date.now() + 30000, hedgeMs }).then((v) => { done = true; return v; });
      await jest.advanceTimersByTimeAsync(31000);
      await jest.advanceTimersByTimeAsync(1600); // the bounded bookkeeping after the last attempt
      expect(done).toBe(true);
      expect(await pending).toBeNull();
      providers.__resetLlmForTests();
    }
  });

  test('without hedgeMs the chain asks one model at a time, as before', async () => {
    const { axios, providers } = load();
    const state = serve(axios, { gemini: [{ after: 80, text: 'one at a time' }] });
    const out = await providers.chatComplete(ask, { deadline: Date.now() + 30000 });
    expect(out.text).toBe('one at a time');
    expect(called(axios)).toEqual(['gemini:gemini-4-hydrogen']);
    expect(state.dropped).toEqual([]);
  });
});
