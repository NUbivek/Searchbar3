/**
 * @jest-environment node
 *
 * The model chain's two promises: it can only call models that cost nothing,
 * and it asks the strongest one that can answer.
 */
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const KEYS = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'TOGETHER_API_KEY', 'CEREBRAS_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'LLM_ALLOW_PAID', 'LLM_SKIP_GEMINI_FOR_PEOPLE'];
const env = { ...process.env };

const LISTS = {
  gemini: ['models/gemini-4-hydrogen', 'models/gemini-4-carbon', 'models/gemini-3.8-flash', 'models/gemini-flash-latest', 'models/gemini-3.5-flash-lite', 'models/gemini-3.1-flash-lite', 'models/gemini-3.1-pro-preview', 'models/gemma-4-31b-it', 'models/text-embedding-004', 'models/gemini-2.5-flash-preview-tts'],
  openrouter: [
    { id: 'thinkingmachines/inkling-2-small:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['reasoning'] },
    { id: 'inclusionai/ling-3.2-flash:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['reasoning', 'response_format', 'structured_outputs'] },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, supported_parameters: [] },
    { id: 'google/lyria-3:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['audio'] } },
    { id: 'openai/gpt-5', pricing: { prompt: '0.00001', completion: '0.00003' }, architecture: { output_modalities: ['text'] } },
    { id: 'sneaky/model:free', pricing: { prompt: '0.000001', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'old/model:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, expiration_date: '2020-01-01' },
    { id: 'newlab/unscored-1:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'openrouter/free' },
    { id: 'openrouter/auto' },
  ],
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'meta-llama/llama-3.3-70b-versatile', 'whisper-large-v3'],
};

function load({ keys = { GOOGLE_AI_API_KEY: 'ga', OPENROUTER_API_KEY: 'or', GROQ_API_KEY: 'gq' }, lists = LISTS, quota = null } = {}) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, keys);
  jest.resetModules();
  const axios = require('axios');
  axios.get.mockReset();
  axios.post.mockReset();
  axios.get.mockImplementation(async (url) => {
    if (url.endsWith('/key')) return { data: { data: quota === null ? {} : { free_model_daily_requests: { used: 50 - quota, limit: 50, remaining: quota } } } };
    const which = url.includes('generativelanguage') ? 'gemini' : url.includes('openrouter') ? 'openrouter' : url.includes('groq') ? 'groq' : 'nvidia';
    return { data: { data: (lists[which] || []).map((m) => (typeof m === 'string' ? { id: m } : m)) } };
  });
  const providers = require('../../../src/server/llm/providers');
  const learning = require('../../../src/server/learning');
  return { axios, providers, learning };
}

const reply = (text, extra = {}) => ({ data: { choices: [{ message: { content: text } }], ...extra.data }, headers: extra.headers || {} });
const called = (axios) => axios.post.mock.calls.map(([url, body]) => `${(url.match(/generativelanguage|openrouter|groq|nvidia/) || [])[0]}:${body.model}`);
const ask = [{ role: 'user', content: 'hi' }];

afterAll(() => { process.env = env; });

describe('only models that cost nothing can be called', () => {
  test('the allow-list refuses paid, non-text, expired, router and off-plan models', () => {
    const { providers } = load();
    const by = (id) => providers.PROVIDERS.find((p) => p.id === id);
    const or = (id) => providers.allowedEntry(by('openrouter'), LISTS.openrouter.find((m) => m.id === id) || { id });
    expect(or('thinkingmachines/inkling-2-small:free')).toEqual(expect.objectContaining({ family: 'inkling-2-small' }));
    expect(or('newlab/unscored-1:free')).toEqual(expect.objectContaining({ family: 'other-free', weak: true }));
    expect(or('openai/gpt-5')).toBeNull(); // no ":free"
    expect(or('sneaky/model:free')).toBeNull(); // ":free" but priced
    expect(or('google/lyria-3:free')).toBeNull(); // not a text model
    expect(or('old/model:free')).toBeNull(); // expired
    expect(or('openrouter/free')).toBeNull();
    expect(or('openrouter/auto')).toBeNull();
    expect(providers.allowedEntry(by('groq'), 'meta-llama/llama-3.3-70b-versatile')).toBeNull();
    expect(providers.allowedEntry(by('groq'), 'qwen/qwen3.8-27b')).toEqual(expect.objectContaining({ family: 'qwen-3.8' }));
    expect(providers.allowedEntry(by('gemini'), 'models/gemini-4-carbon')).toBeNull();
    expect(providers.allowedEntry(by('gemini'), 'models/gemini-3.1-pro-preview')).toBeNull();
    expect(providers.allowedEntry(by('gemini'), 'models/gemini-4-hydrogen')).toEqual(expect.objectContaining({ family: 'gemini-4-hydrogen' }));
  });

  test('keys for paid services are never read, with or without the old LLM_ALLOW_PAID switch', async () => {
    const { axios, providers } = load({ keys: { TOGETHER_API_KEY: 't', CEREBRAS_API_KEY: 'c', PERPLEXITY_API_KEY: 'p', OPENAI_API_KEY: 'o', LLM_ALLOW_PAID: 'true' } });
    expect(providers.PROVIDERS.map((p) => p.id)).toEqual(['gemini', 'openrouter', 'groq', 'nvidia']);
    expect(providers.llmConfigured()).toBe(false);
    expect(await providers.chatComplete(ask)).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(JSON.stringify(providers.llmStatus())).not.toMatch(/together|cerebras|perplexity|openai/i);
  });

  test('a model id from the menu that is not on the list is ignored, never sent', async () => {
    const { axios, providers } = load();
    axios.post.mockResolvedValue(reply('ok'));
    for (const preferred of ['openrouter:openai/gpt-5', 'openrouter:openrouter/auto', 'groq:meta-llama/llama-3.3-70b-versatile', 'gemini:gemini-4-carbon', 'together:anything', 'openrouter:sneaky/model:free']) {
      axios.post.mockClear();
      const out = await providers.chatComplete(ask, { preferred });
      expect(called(axios)).toEqual(['generativelanguage:gemini-4-hydrogen']);
      expect(out.model).toBe('gemini-4-hydrogen');
    }
    // a listed model is honoured
    axios.post.mockClear();
    await providers.chatComplete(ask, { preferred: 'openrouter:thinkingmachines/inkling-2-small:free' });
    expect(called(axios)).toEqual(['openrouter:thinkingmachines/inkling-2-small:free']);
  });

  test('Groq reporting paid-plan limits switches Groq off, and its answer is not used', async () => {
    const { axios, providers } = load({ keys: { GROQ_API_KEY: 'gq' } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    axios.post.mockResolvedValue(reply('ok', { headers: { 'x-ratelimit-limit-tokens': '250000' } }));
    expect(await providers.chatComplete(ask)).toBeNull();
    console.warn.mockRestore();
    axios.post.mockClear();
    expect(await providers.chatComplete(ask)).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
    console.error.mockRestore();
  });

  test('OpenRouter answering with a model that is not free switches OpenRouter off', async () => {
    const { axios, providers } = load({ keys: { OPENROUTER_API_KEY: 'or' } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.post.mockResolvedValue(reply('ok', { data: { model: 'openai/gpt-5' } }));
    await providers.chatComplete(ask);
    axios.post.mockClear();
    expect(await providers.chatComplete(ask)).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
    console.error.mockRestore();
  });

  test('the model list for the menu holds only allowed models, strongest first', async () => {
    const { providers } = load();
    const ids = (await providers.availableModels()).map((m) => m.id);
    expect(ids.slice(0, 4)).toEqual(['gemini:gemini-4-hydrogen', 'gemini:gemini-3.8-flash', 'openrouter:thinkingmachines/inkling-2-small:free', 'openrouter:inclusionai/ling-3.2-flash:free']);
    expect(ids.join(' ')).not.toMatch(/gpt-5|lyria|carbon|pro-preview|llama|unscored|sneaky|openrouter\/(free|auto)/);
  });
});

describe('the strongest model that can answer goes first', () => {
  test('order for an ordinary answer, across providers; weak models last', async () => {
    const { axios, providers } = load();
    axios.post.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await providers.chatComplete(ask)).toBeNull();
    expect(called(axios)).toEqual([
      'generativelanguage:gemini-4-hydrogen',
      'generativelanguage:gemini-3.8-flash',
      'openrouter:thinkingmachines/inkling-2-small:free',
      'openrouter:inclusionai/ling-3.2-flash:free',
      'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free',
      'groq:qwen/qwen3.8-27b',
    ]); // six attempts at most
    console.warn.mockRestore();
  });

  test('a report gets more thinking and room for it, and is never written by a weak model', async () => {
    const { axios, providers } = load();
    axios.post.mockResolvedValue(reply('ok'));
    await providers.chatComplete(ask, { task: 'analysis', maxTokens: 3500 });
    const [, body] = axios.post.mock.calls[0];
    expect(body).toEqual(expect.objectContaining({ model: 'gemini-4-hydrogen', reasoning_effort: 'high', max_tokens: 15500 }));

    const weakOnly = load({ keys: { GROQ_API_KEY: 'gq' }, lists: { groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] } });
    weakOnly.axios.post.mockResolvedValue(reply('ok'));
    expect(await weakOnly.providers.chatComplete(ask, { task: 'analysis' })).toBeNull();
    expect(weakOnly.axios.post).not.toHaveBeenCalled();
    // ...but an ordinary answer may still use it as the last resort
    expect((await weakOnly.providers.chatComplete(ask)).model).toBe('openai/gpt-oss-120b');
  });

  test('extraction prefers the high-allowance models and asks for little thinking', async () => {
    const { axios, providers } = load();
    axios.post.mockResolvedValue(reply('ok'));
    await providers.chatComplete(ask, { task: 'extract' });
    const [, body] = axios.post.mock.calls[0];
    expect(body.model).toBe('gemini-3.5-flash-lite'); // the newer of the two lite versions
    expect(body.reasoning_effort).toBe('low');
  });

  test('text about a named person is not sent to models served from another jurisdiction', async () => {
    const { axios, providers } = load({ keys: { OPENROUTER_API_KEY: 'or' } });
    axios.post.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await providers.chatComplete(ask, { personal: true });
    expect(called(axios).join(' ')).not.toMatch(/ling-3/);
    expect(called(axios)).toContain('openrouter:thinkingmachines/inkling-2-small:free');
    console.warn.mockRestore();
  });

  test('the owner can keep Gemini out of people checks', async () => {
    const { axios, providers } = load({ keys: { GOOGLE_AI_API_KEY: 'ga', OPENROUTER_API_KEY: 'or', LLM_SKIP_GEMINI_FOR_PEOPLE: 'true' } });
    axios.post.mockResolvedValue(reply('ok'));
    expect((await providers.chatComplete(ask, { personal: true })).provider).toBe('openrouter');
    expect((await providers.chatComplete(ask)).provider).toBe('gemini');
  });

  test('a model out of allowance rests instead of being asked again, and that is not held against it', async () => {
    const { axios, providers, learning } = load();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    axios.post.mockImplementation(async (url, body) => {
      if (body.model === 'gemini-4-hydrogen') throw Object.assign(new Error('429'), { response: { status: 429, data: [{ error: { message: 'Quota exceeded for metric: generate_requests_per_day' } }] } });
      return reply(`from ${body.model}`);
    });
    const first = await providers.chatComplete(ask);
    expect(first.model).toBe('gemini-3.8-flash');
    expect(first.skipped).toEqual([{ provider: 'Google Gemini', model: 'gemini-4-hydrogen', why: 'resting until its allowance resets' }]);
    axios.post.mockClear();
    const second = await providers.chatComplete(ask);
    expect(called(axios)).toEqual(['generativelanguage:gemini-3.8-flash']); // hydrogen not asked again
    // the answer still says a stronger model was passed over, and why
    expect(second.skipped).toEqual([{ provider: 'Google Gemini', model: 'gemini-4-hydrogen', why: 'resting until its allowance resets' }]);
    const stats = await learning.loadStats('model');
    expect(stats.get('chat|gemini:gemini-4-hydrogen')).toBeUndefined();
    expect(stats.get('chat|gemini:gemini-3.8-flash')).toEqual(expect.objectContaining({ tries: 2, wins: 2 }));
    console.warn.mockRestore();
  });

  test('the last calls of the day on the best models are kept for reports', async () => {
    const { axios, providers, learning } = load();
    axios.post.mockResolvedValue(reply('ok'));
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
    await learning.recordStats('model-day', Array.from({ length: 12 }, () => ({ key: `${day}|gemini:gemini-4-hydrogen`, win: 1 })));
    expect((await providers.chatComplete(ask)).model).toBe('gemini-3.8-flash');
    expect((await providers.chatComplete(ask, { task: 'analysis' })).model).toBe('gemini-4-hydrogen');
  });

  test('OpenRouter: no calls left today means it is skipped; the last few are kept for reports', async () => {
    const none = load({ keys: { OPENROUTER_API_KEY: 'or' }, quota: 0 });
    none.axios.post.mockResolvedValue(reply('ok'));
    expect(await none.providers.chatComplete(ask, { task: 'analysis' })).toBeNull();
    expect(none.axios.post).not.toHaveBeenCalled();

    const few = load({ keys: { OPENROUTER_API_KEY: 'or' }, quota: 6 });
    few.axios.post.mockResolvedValue(reply('ok'));
    expect(await few.providers.chatComplete(ask)).toBeNull();
    expect((await few.providers.chatComplete(ask, { task: 'analysis' })).model).toBe('thinkingmachines/inkling-2-small:free');
  });

  test('Groq is only asked when the question fits its per-minute allowance, and the answer allowance is cut to fit', async () => {
    const { axios, providers } = load({ keys: { GROQ_API_KEY: 'gq' } });
    axios.post.mockResolvedValue(reply('ok'));
    const long = [{ role: 'user', content: 'x'.repeat(30000) }]; // about 8,600 tokens
    expect(await providers.chatComplete(long)).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
    const medium = [{ role: 'user', content: 'x'.repeat(17500) }]; // about 5,000 tokens
    await providers.chatComplete(medium, { maxTokens: 3000 });
    const [, body] = axios.post.mock.calls[0];
    expect(body.model).toBe('qwen/qwen3.8-27b');
    expect(body.max_completion_tokens).toBe(2700);
    expect(body.max_tokens).toBeUndefined();
    expect(body).toEqual(expect.objectContaining({ reasoning_effort: 'high', reasoning_format: 'hidden' }));
  });

  test('an answer that fails the caller\'s checks sends the request to the next model, and the model is marked down', async () => {
    const { axios, providers, learning } = load();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    axios.post.mockImplementation(async (url, body) => reply(body.model === 'gemini-4-hydrogen' ? 'no citations here' : 'fine [Source 1]'));
    const out = await providers.chatComplete(ask, { accept: (text) => /\[Source \d+\]/.test(text) });
    expect(out.model).toBe('gemini-3.8-flash');
    expect(out.skipped).toEqual([{ provider: 'Google Gemini', model: 'gemini-4-hydrogen', why: 'answer did not pass checks' }]);
    const stats = await learning.loadStats('model');
    expect(stats.get('chat|gemini:gemini-4-hydrogen')).toEqual(expect.objectContaining({ tries: 1, wins: 0 }));
    console.warn.mockRestore();
  });

  test('learning: a model that keeps failing drops below the next one; a reliable one keeps its place', async () => {
    const { axios, providers, learning } = load();
    axios.post.mockResolvedValue(reply('ok'));
    await learning.recordStats('model', Array.from({ length: 30 }, () => ({ key: 'chat|gemini:gemini-4-hydrogen', win: 0 })));
    await learning.recordStats('model', Array.from({ length: 30 }, () => ({ key: 'chat|gemini:gemini-3.8-flash', win: 1, ms: 4000 })));
    expect((await providers.chatComplete(ask)).model).toBe('gemini-3.8-flash');
    // after-the-fact feedback counts too
    await providers.reportAnswerQuality({ provider: 'gemini', family: 'gemini-3.8-flash' }, false);
    expect((await learning.loadStats('model')).get('chat|gemini:gemini-3.8-flash').tries).toBe(32);
  });

  test('a model known to be too slow for the time left is not started first', async () => {
    const { axios, providers, learning } = load({ keys: { GOOGLE_AI_API_KEY: 'ga' } });
    axios.post.mockResolvedValue(reply('ok'));
    await learning.recordStats('model', Array.from({ length: 5 }, () => ({ key: 'chat|gemini:gemini-4-hydrogen', win: 1, ms: 45000 })));
    expect((await providers.chatComplete(ask, { deadline: Date.now() + 40000 })).model).toBe('gemini-3.8-flash');
    expect((await providers.chatComplete(ask)).model).toBe('gemini-4-hydrogen'); // no deadline: the best one
  });
});

describe('structured answers', () => {
  const schema = { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'], additionalProperties: false };

  test('uses the model\'s own structured mode where it has one, and reads JSON out of the reply elsewhere', async () => {
    const { axios, providers } = load({ keys: { OPENROUTER_API_KEY: 'or' } });
    axios.post.mockResolvedValue(reply('```json\n{"names":["A"]}\n```'));
    const out = await providers.chatJson([{ role: 'user', content: 'list' }], { schema, name: 'people' });
    expect(out.data).toEqual({ names: ['A'] });
    const [, body] = axios.post.mock.calls[0];
    expect(body.model).toBe('inclusionai/ling-3.2-flash:free'); // best extraction model that supports it
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'people', strict: true, schema } });
    expect(body.messages[0].content).toMatch(/JSON Schema/);
  });

  test('a reply that is not JSON, or fails the caller\'s check, goes to the next model', async () => {
    const { axios, providers } = load({ keys: { OPENROUTER_API_KEY: 'or' } });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    axios.post
      .mockResolvedValueOnce(reply('Sure! Here are the names you asked for.'))
      .mockResolvedValueOnce(reply('{"names":[]}'))
      .mockResolvedValueOnce(reply('prefix {"names":["B \\"quoted\\" }"]} suffix'));
    const out = await providers.chatJson([{ role: 'user', content: 'list' }], { schema, check: (d) => d.names.length > 0 });
    expect(out.data).toEqual({ names: ['B "quoted" }'] });
    expect(axios.post).toHaveBeenCalledTimes(3);
    // a model without a structured mode is not sent the parameter
    const third = axios.post.mock.calls[2][1];
    expect(third.response_format).toBeUndefined();
    console.warn.mockRestore();
  });

  test('parseJsonReply', () => {
    const { providers } = load();
    expect(providers.parseJsonReply('[1, 2]')).toEqual([1, 2]);
    expect(providers.parseJsonReply('nothing')).toBeNull();
    expect(providers.parseJsonReply('{"a": 1')).toBeNull();
  });
});

describe('a second attempt', () => {
  test('models the caller already tried are left out, and every failed attempt is reported back', async () => {
    const { axios, providers } = load({ keys: { GOOGLE_AI_API_KEY: 'ga' } });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    axios.post.mockRejectedValue(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }));
    const trace = [];
    expect(await providers.chatComplete(ask, { task: 'analysis', trace })).toBeNull();
    expect(trace.map((t) => t.family).slice(0, 2)).toEqual(['gemini-4-hydrogen', 'gemini-3.8-flash']);
    axios.post.mockReset();
    axios.post.mockResolvedValue(reply('ok'));
    const out = await providers.chatComplete(ask, { task: 'analysis', avoid: ['gemini-4-hydrogen', 'gemini-3.8-flash'] });
    expect(out.model).not.toMatch(/hydrogen|3\.8-flash/);
    console.warn.mockRestore();
  });

  test('with little time left a fallback is asked for a quick answer rather than a thorough one', async () => {
    const { axios, providers } = load({ keys: { GOOGLE_AI_API_KEY: 'ga' } });
    axios.post.mockResolvedValue(reply('ok'));
    await providers.chatComplete(ask, { task: 'analysis', deadline: Date.now() + 15000 });
    expect(axios.post.mock.calls[0][1].reasoning_effort).toBe('low');
    axios.post.mockClear();
    await providers.chatComplete(ask, { task: 'analysis', deadline: Date.now() + 50000 });
    expect(axios.post.mock.calls[0][1].reasoning_effort).toBe('high');
  });
});
