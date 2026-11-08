/**
 * Search pipeline: query understanding, entity resolution, filtering and
 * ranking, answer validation, the free-first LLM chain, and the
 * /api/search/open response contract.
 */
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../src/server/search/retrieve', () => ({ retrieve: jest.fn() }));
jest.mock('../../../src/components/search/categories/processors/CategoryProcessor', () => ({ processCategories: jest.fn(async () => []) }));
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => null) }));

const axios = require('axios');
const { understandQuery, resolveEntity, webQuery } = require('../../../src/server/search/queryPlan');
const { filterAndRank } = require('../../../src/server/search/rank');
const { validateAnswer, normalizeCitations } = require('../../../src/server/search/answer');
const { createMockReq, createMockRes } = require('../api/testUtils');

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const r = (title, content = '', extra = {}) => ({ title, content, snippet: content, url: `https://example.com/${encodeURIComponent(title).slice(0, 40)}`, source: 'curated', ...extra });

describe('understandQuery', () => {
  test('separates entity, intent and recency', () => {
    const p = understandQuery('open ai latest funding');
    expect(p.entityCandidate).toBe('open ai');
    expect(p.intents).toEqual(['funding']);
    expect(p.recency).toBe(true);
    expect(webQuery(p)).toBe('open ai funding round');
  });
  test('question phrasing', () => {
    const p = understandQuery('who founded Mistral AI');
    expect(p.entityCandidate).toBe('Mistral AI');
    expect(p.intents).toContain('team');
  });
});

describe('resolveEntity', () => {
  test('"open ai" resolves to OpenAI when sources write it joined; "open source AI" is not a match', () => {
    const plan = understandQuery('open ai latest funding');
    const results = [r('OpenAI raises $11 billion at a $1.25 trillion valuation'), r('Open Source AI Is Winning', 'open source models are mainstream')];
    const e = resolveEntity(plan, results);
    expect(e.mode).toBe('entity');
    expect(e.name).toBe('OpenAI');
    expect(e.matcher(results[0])).toBe(true);
    expect(e.matcher(results[1])).toBe(false);
  });
  test('single-word names ignore Title Case phrasal uses ("Ramp Up")', () => {
    const plan = understandQuery('Ramp');
    const results = [
      r('Ramp data shows AI spending stalling'),
      r('Tesla Announces $2B Public Offering to Accelerate Model 3 Ramp Up'),
      r('A Twitter Off Ramp: A Tutorial for Getting on Mastodon'),
      r('Fintech Startup Ramp Hits $22B Valuation'),
    ];
    const e = resolveEntity(plan, results);
    expect(results.map((x) => e.matcher(x))).toEqual([true, false, false, true]);
  });
  test('falls back to the capitalized name inside a longer phrase', () => {
    const plan = understandQuery('Harvey legal AI funding');
    const e = resolveEntity(plan, [r('Legal AI Startup Harvey Raises $300M Series D')]);
    expect(e.name).toBe('Harvey');
  });
  test('generic words are a topic search', () => {
    const plan = understandQuery('seed round AI agents');
    expect(resolveEntity(plan, [r('Kabilio raises €10M to introduce AI agents')]).mode).toBe('topic');
  });
});

describe('filterAndRank', () => {
  const plan = understandQuery('open ai latest funding');
  const results = [
    r('SenseTime releases open-source multimodal model', 'An open-source model from SenseTime.', { publishedAt: daysAgo(2) }),
    r('Franklin Templeton uses OpenAI for research', 'Partnership news.', { publishedAt: daysAgo(1) }),
    r('OpenAI raises $11 billion at $1.25 trillion valuation', 'OpenAI raised $11 billion.', { publishedAt: daysAgo(1) }),
    r('OpenAI raises $11 billion at $1.25 trillion valuation', 'Syndicated copy.', { publishedAt: daysAgo(1), url: 'https://other.example/x' }),
    r('OpenAI raised $6.6 billion in 2024', 'Older round.', { publishedAt: daysAgo(700) }),
  ];
  const entity = resolveEntity(plan, results);
  const { results: ranked, droppedForRelevance } = filterAndRank(results, plan, entity);

  test('drops results not about the entity', () => {
    expect(ranked.some((x) => /SenseTime/.test(x.title))).toBe(false);
    expect(droppedForRelevance).toBe(1);
  });
  test('the latest funding news ranks first and duplicates collapse', () => {
    expect(ranked[0].title).toMatch(/\$11 billion/);
    expect(ranked.filter((x) => /\$11 billion/.test(x.title))).toHaveLength(1);
    expect(ranked.findIndex((x) => /2024/.test(x.title))).toBeGreaterThan(0);
  });
  test('each result carries its tier and rank reasons', () => {
    expect(ranked[0].sourceTierLabel).toBeTruthy();
    expect(ranked[0].rankReasons).toContain('named in title');
  });
});

describe('validateAnswer', () => {
  const ok = '## SUMMARY\nOpenAI raised $11B [Source 1]. Also [Source 9].\n## KEY POINTS\n• x [Source 2]\n## DETAILED ANALYSIS\n### A\ny [Source 1]\n## DIFFERENT PERSPECTIVES\n• z [Source 2]\n## FOLLOW-UP QUESTIONS\n• q?\nCONFIDENCE: Medium - two sources agree';
  test('removes citations to sources that do not exist and extracts confidence', () => {
    const v = validateAnswer(ok, 2);
    expect(v.ok).toBe(true);
    expect(v.content).not.toMatch(/Source 9/);
    expect(v.removedCitations).toBe(1);
    expect(v.confidence).toEqual({ level: 'Medium', reason: 'two sources agree' });
    expect(v.content).not.toMatch(/CONFIDENCE/);
  });
  test('reads a bold confidence line and collapses doubled bullets', () => {
    const text = '## SUMMARY\nRaised $11B [Source 1].\n## KEY POINTS  \n- • $11B round [Source 1]  \n## DETAILED ANALYSIS\nx [Source 1]\n## DIFFERENT PERSPECTIVES\n* • y [Source 1]\n## FOLLOW-UP QUESTIONS\n- • Who led it?\n\n**CONFIDENCE:** High – four outlets agree';
    const v = validateAnswer(text, 1);
    expect(v.confidence).toEqual({ level: 'High', reason: 'four outlets agree' });
    expect(v.content).not.toMatch(/CONFIDENCE/);
    expect(v.content).not.toMatch(/[-*] •/);
    expect(v.content).toMatch(/^• \$11B round/m);
    expect(validateAnswer(text.replace('**CONFIDENCE:** High –', 'CONFIDENCE: **Low** -'), 1).confidence.level).toBe('Low');
  });
  test('removes bold markers around section headings', () => {
    const v = validateAnswer('## SUMMARY**  \nRaised [Source 1].\n\n**## KEY POINTS**\n• a [Source 1]\n## **DETAILED ANALYSIS**\n### **Round**\nx [Source 1]\n## DIFFERENT PERSPECTIVES\n## FOLLOW-UP QUESTIONS\n• q', 1);
    expect(v.ok).toBe(true);
    expect(v.content).toMatch(/^## SUMMARY$/m);
    expect(v.content).toMatch(/^## KEY POINTS$/m);
    expect(v.content).toMatch(/^## DETAILED ANALYSIS$/m);
    expect(v.content).toMatch(/^### Round$/m);
    expect(v.content).not.toMatch(/\*\*/);
  });
  test('rejects output without sections or citations', () => {
    expect(validateAnswer('Here is an answer without structure.', 3).ok).toBe(false);
    expect(validateAnswer('## SUMMARY\nNo citations.\n## KEY POINTS\n## DETAILED ANALYSIS\n## DIFFERENT PERSPECTIVES\n## FOLLOW-UP QUESTIONS', 3).ok).toBe(false);
  });
});

describe('LLM provider chain', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.resetModules(); axios.get.mockReset(); axios.post.mockReset(); });

  test('paid Together is skipped unless LLM_ALLOW_PAID=true', () => {
    process.env.TOGETHER_API_KEY = 'x';
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const { PROVIDERS, providerEnabled } = require('../../../src/server/llm/providers');
    expect(PROVIDERS.filter(providerEnabled).map((p) => p.id)).toEqual([]);
    process.env.LLM_ALLOW_PAID = 'true';
    expect(PROVIDERS.filter(providerEnabled).map((p) => p.id)).toEqual(['together']);
  });

  test('uses the best model the provider serves today and falls back on failure', async () => {
    process.env.GROQ_API_KEY = 'g';
    process.env.OPENROUTER_API_KEY = 'o';
    jest.resetModules();
    const axios = require('axios'); // the instance the freshly loaded module uses
    axios.get.mockImplementation(async (url) => (url.includes('groq')
      ? { data: { data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-120b' }, { id: 'qwen/qwen3.8-27b' }] } }
      : { data: { data: [{ id: 'nvidia/nemotron-3-ultra-550b-a55b:free' }, { id: 'paid/model', pricing: { prompt: '1', completion: '1' } }] } }));
    axios.post.mockImplementation(async (url, body) => {
      if (url.includes('groq')) throw Object.assign(new Error('rate limited'), { response: { status: 429 } });
      return { data: { choices: [{ message: { content: `answer from ${body.model}` } }] } };
    });
    const { chatComplete } = require('../../../src/server/llm/providers');
    const out = await chatComplete([{ role: 'user', content: 'hi' }]);
    const tried = axios.post.mock.calls.map(([url, body]) => `${url.includes('groq') ? 'groq' : 'openrouter'}:${body.model}`);
    expect(tried.slice(0, 2)).toEqual(['groq:openai/gpt-oss-120b', 'groq:qwen/qwen3.8-27b']);
    expect(out).toEqual(expect.objectContaining({ provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' }));
  });

  test('Gemini: free-tier chat models only, newest version first, key aliases', async () => {
    delete process.env.GROQ_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.GOOGLE_AI_API_KEY;
    process.env.GEMINI_API_KEY = 'gm';
    jest.resetModules();
    const axios = require('axios');
    axios.get.mockResolvedValue({ data: { data: [
      { id: 'models/text-embedding-004' }, { id: 'models/imagen-4.0-generate-001' }, { id: 'models/gemini-2.5-flash-preview-tts' },
      { id: 'models/gemini-2.0-flash' }, { id: 'models/gemini-2.5-flash' }, { id: 'models/gemini-3-flash-preview' }, { id: 'models/gemini-2.5-pro' },
    ] } });
    const { PROVIDERS, providerEnabled, pickModels, llmStatus } = require('../../../src/server/llm/providers');
    const gemini = PROVIDERS.find((p) => p.id === 'gemini');
    expect(PROVIDERS.filter(providerEnabled).map((p) => p.id)).toEqual(['gemini']);
    expect(await pickModels(gemini, 3)).toEqual(['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-pro']);
    expect(axios.get.mock.calls[0][1].headers.Authorization).toBe('Bearer gm');
    expect(llmStatus().find((p) => p.id === 'gemini').note).toMatch(/no billing account/);
  });

  test('falls through Groq and OpenRouter to Gemini with a short reasoning budget', async () => {
    process.env.GROQ_API_KEY = 'g'; process.env.OPENROUTER_API_KEY = 'o'; process.env.GOOGLE_AI_API_KEY = 'ga';
    jest.resetModules();
    const axios = require('axios');
    axios.get.mockImplementation(async (url) => ({ data: { data: url.includes('groq') ? [{ id: 'openai/gpt-oss-120b' }]
      : url.includes('openrouter') ? [{ id: 'google/gemma-4-31b-it:free' }] : [{ id: 'models/gemini-2.5-flash' }] } }));
    axios.post.mockImplementation(async (url, body) => {
      if (!url.includes('generativelanguage')) throw Object.assign(new Error('rate limited'), { response: { status: 429 } });
      return { data: { choices: [{ message: { content: `answer from ${body.model} (${body.reasoning_effort})` } }] } };
    });
    const { chatComplete } = require('../../../src/server/llm/providers');
    const out = await chatComplete([{ role: 'user', content: 'hi' }]);
    expect(out).toEqual(expect.objectContaining({ provider: 'gemini', providerLabel: 'Google Gemini', model: 'gemini-2.5-flash', text: 'answer from gemini-2.5-flash (low)' }));
    const geminiCall = axios.post.mock.calls.find(([url]) => url.includes('generativelanguage'));
    expect(geminiCall[0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(geminiCall[2].headers.Authorization).toBe('Bearer ga');
    expect(out.skipped).toEqual([
      { provider: 'Groq', model: 'openai/gpt-oss-120b', why: 'rate limited or out of free quota' },
      { provider: 'OpenRouter (free)', model: 'google/gemma-4-31b-it:free', why: 'rate limited or out of free quota' },
    ]);
    const { skippedNote } = require('../../../src/utils/skippedNote');
    expect(skippedNote(out.skipped)).toBe(' · Skipped: gpt-oss-120b (rate limited or out of free quota), gemma-4-31b-it (rate limited or out of free quota)');
    expect(skippedNote([])).toBe('');
  });

  test('time budget: the chosen model leaves time for a fast fallback; nothing starts after the deadline', async () => {
    process.env.GROQ_API_KEY = 'g'; process.env.GOOGLE_AI_API_KEY = 'ga'; delete process.env.OPENROUTER_API_KEY;
    jest.resetModules();
    const axios = require('axios');
    axios.get.mockImplementation(async (url) => ({ data: { data: url.includes('groq') ? [{ id: 'openai/gpt-oss-120b' }] : [{ id: 'models/gemini-3.8-flash' }] } }));
    axios.post.mockImplementation(async (url, body) => {
      if (url.includes('generativelanguage')) throw Object.assign(new Error('timeout of 28000ms exceeded'), { code: 'ECONNABORTED' });
      return { data: { choices: [{ message: { content: 'fast answer' } }] } };
    });
    const { chatComplete } = require('../../../src/server/llm/providers');
    const out = await chatComplete([{ role: 'user', content: 'hi' }], { preferred: 'gemini:gemini-3.8-flash', deadline: Date.now() + 40000 });
    const [first, second] = axios.post.mock.calls;
    expect(first[0]).toMatch(/generativelanguage/);
    expect(first[2].timeout).toBeLessThanOrEqual(28000);
    expect(first[2].timeout).toBeGreaterThan(26000);
    expect(second[0]).toMatch(/groq/);
    expect(out).toEqual(expect.objectContaining({ provider: 'groq', text: 'fast answer' }));
    expect(out.skipped).toEqual([{ provider: 'Google Gemini', model: 'gemini-3.8-flash', why: 'timed out' }]);

    axios.post.mockClear();
    expect(await chatComplete([{ role: 'user', content: 'hi' }], { deadline: Date.now() + 2000 })).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('returns null when no provider is configured', async () => {
    delete process.env.GROQ_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.TOGETHER_API_KEY; delete process.env.GOOGLE_AI_API_KEY; delete process.env.GEMINI_API_KEY;
    const { chatComplete } = require('../../../src/server/llm/providers');
    expect(await chatComplete([{ role: 'user', content: 'hi' }])).toBeNull();
  });
});

describe('/api/search/open contract', () => {
  const env = { ...process.env };
  beforeEach(() => { delete process.env.GROQ_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.TOGETHER_API_KEY; delete process.env.GOOGLE_AI_API_KEY; delete process.env.GEMINI_API_KEY; });
  afterAll(() => { process.env = env; });
  const handler = require('../../../src/pages/api/search/open').default;
  const { retrieve } = require('../../../src/server/search/retrieve');

  test('400 without a query; 405 for GET', async () => {
    const res = createMockRes();
    await handler(createMockReq({ method: 'POST', body: {} }), res);
    expect(res.statusCode).toBe(400);
    const res2 = createMockRes();
    await handler(createMockReq({ method: 'GET' }), res2);
    expect(res2.statusCode).toBe(405);
  });

  test('entity query: unrelated results removed, quoted answer about the entity, degraded sources listed', async () => {
    retrieve.mockResolvedValue({
      results: [
        { ...r('OpenAI raises $11 billion at a $1.25 trillion valuation', 'OpenAI raised $11 billion in new funding.', { publishedAt: daysAgo(1) }), retrievedBy: 'curated' },
        { ...r('SenseTime releases open-source model', 'open source', { publishedAt: daysAgo(1) }), retrievedBy: 'curated' },
      ],
      statuses: [{ source: 'curated', status: 'ok', count: 2 }, { source: 'web', status: 'error', count: 0, error: 'No SERPER_API_KEY' }],
    });
    const res = createMockRes();
    await handler(createMockReq({ method: 'POST', body: { query: 'open ai latest funding', sources: ['Curated', 'Web'] } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.queryPlan).toEqual(expect.objectContaining({ entity: 'OpenAI', mode: 'entity', intents: ['funding'], recency: true, droppedForRelevance: 1 }));
    expect(res.body.results.map((x) => x.title)).toEqual(['OpenAI raises $11 billion at a $1.25 trillion valuation']);
    expect(res.body.degradedSources).toEqual(['web']);
    expect(res.body.status).toBe('degraded');
    expect(res.body.answerInfo).toEqual({ mode: 'quoted', reason: 'No AI model is configured' });
    expect(res.body.content).toMatch(/## SUMMARY[\s\S]*about OpenAI[\s\S]*\$11 billion/);
    expect(res.body.content).not.toMatch(/SenseTime/);
  });

  test('fail-soft when retrieval throws', async () => {
    retrieve.mockRejectedValue(new Error('boom'));
    const res = createMockRes();
    await handler(createMockReq({ method: 'POST', body: { query: 'Ramp' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['open-search']);
  });
});


describe('citation styles from real models', () => {
  const sections = '## KEY POINTS\n• a\n## DETAILED ANALYSIS\nb\n## DIFFERENT PERSPECTIVES\n• c\n## FOLLOW-UP QUESTIONS\n• d';
  test.each([
    ['gpt-oss full-width brackets', 'OpenAI raised $11B【1】 and【2†source】.', '[Source 1]', '[Source 2]'],
    ['bare numbers', 'OpenAI raised $11B [1][2].', '[Source 1]', '[Source 2]'],
    ['lists and ranges', 'Raised $11B [1, 2] and [3-4].', '[Source 2]', '[Source 4]'],
    ['S-prefixed', 'Raised $11B [S1] [S2].', '[Source 1]', '[Source 2]'],
    ['parenthesized', 'Raised $11B (Source 1) (Sources 2 and 3).', '[Source 1]', '[Source 3]'],
    ['colon style', 'Raised $11B [Source: 2].', '[Source 2]', '[Source 2]'],
  ])('%s', (_label, text, a, b) => {
    const out = normalizeCitations(text);
    expect(out).toContain(a);
    expect(out).toContain(b);
    const v = validateAnswer(`## SUMMARY\n${text}\n${sections}`, 4);
    expect(v.ok).toBe(true);
  });
  test('markdown links are left alone, thinking text is removed', () => {
    expect(normalizeCitations('See [1](https://x.test) and [Report](https://y.test)')).toBe('See [1](https://x.test) and [Report](https://y.test)');
    const v = validateAnswer(`<think>plan the answer</think>## SUMMARY\nRaised [1].\n${sections}`, 2);
    expect(v.content).not.toMatch(/plan the answer/);
  });
});

describe('reasoning models', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.resetModules(); });
  test('gpt-oss on Groq gets low reasoning effort; retried without it if rejected', async () => {
    process.env.GROQ_API_KEY = 'g';
    delete process.env.OPENROUTER_API_KEY;
    jest.resetModules();
    const ax = require('axios');
    ax.get.mockResolvedValue({ data: { data: [{ id: 'openai/gpt-oss-120b' }] } });
    ax.post
      .mockRejectedValueOnce(Object.assign(new Error('bad param'), { response: { status: 400 } }))
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '<think>x</think>## SUMMARY ok' } }] } });
    const { chatComplete } = require('../../../src/server/llm/providers');
    const out = await chatComplete([{ role: 'user', content: 'q' }]);
    expect(ax.post.mock.calls[0][1].reasoning_effort).toBe('low');
    expect(ax.post.mock.calls[1][1].reasoning_effort).toBeUndefined();
    expect(out.text).toBe('## SUMMARY ok');
  });
});

// ---------------------------------------------------------------------------
// Audit fixes (Open Research tab)
// ---------------------------------------------------------------------------
jest.mock('../../../src/utils/sources/curatedIndex', () => ({ searchCuratedForEntity: jest.fn(async () => []), searchCuratedSources: jest.fn(async () => []) }));
jest.mock('../../../src/utils/sources/hackernewsAlgolia', () => ({ searchHackerNews: jest.fn(async () => []) }));
jest.mock('../../../src/utils/urlExtraction', () => ({
  fetchUrlContent: jest.fn(),
  buildUrlSearchResult: jest.fn((p) => (!p || p.status === 'error' || !p.content ? null : { title: p.title || p.url, content: p.content, url: p.url, source: 'custom', type: 'custom_url' })),
}));

describe('query understanding: topic, portfolio and round words (defects 4, 6)', () => {
  test('"best fintech startups 2026" is a topic, not a company called "Best FinTech"', () => {
    const p = understandQuery('best fintech startups 2026');
    expect(p.entityTokens).toEqual(['fintech']);
    expect(p.isGenericCandidate).toBe(true);
    const e = resolveEntity(p, [r('Best FinTech Startup 2015', '', { url: 'http://sdk.finance/x', source: 'hackernews' })]);
    expect(e.mode).toBe('topic');
  });
  test('"Y Combinator portfolio" keeps the investor as the entity and reads a portfolio intent', () => {
    const p = understandQuery('Y Combinator portfolio');
    expect(p.entityCandidate).toBe('Y Combinator');
    expect(p.intents).toContain('portfolio');
    expect(webQuery(p)).toBe('Y Combinator portfolio companies');
  });
  test('"a16z portfolio": a name with digits is accepted in lowercase', () => {
    const p = understandQuery('a16z portfolio');
    expect(p.entityCandidate).toBe('a16z');
    const e = resolveEntity(p, [r('Phaze raises $8.75M seed led by a16z', 'The round was led by a16z.')]);
    expect(e.mode).toBe('entity');
    expect(e.name).toBe('a16z');
  });
  test('"anthropic series f" strips the round from the name and keeps the funding intent', () => {
    const p = understandQuery('anthropic series f');
    expect(p.entityCandidate).toBe('anthropic');
    expect(p.intents).toEqual(['funding']);
    expect(resolveEntity(p, [r('Anthropic raises Series F', 'Anthropic closed its Series F.')]).name).toBe('Anthropic');
  });
  test('a multi-word phrase seen only in one Title Case headline is not a name; two sources make it one', () => {
    const p = understandQuery('Acme Robotics');
    const one = [r('Acme Robotics Startup 2015 Awards', '', { url: 'https://a.test/1' })];
    expect(resolveEntity(p, one).mode).toBe('topic');
    const two = [...one, r('Why Acme Robotics Matters Now', '', { url: 'https://b.test/2' })];
    expect(resolveEntity(p, two).mode).toBe('entity');
    expect(resolveEntity(p, [r('Funding news', 'Acme Robotics raised a seed round.', { url: 'https://c.test/3' })]).mode).toBe('entity');
  });
});

describe('single-word names reject other people and products (defect 5)', () => {
  const plan = understandQuery('who are the founders of Harvey');
  const wrong = [
    r('Larry Harvey, co-founder of Burning Man, has died', '', { source: 'hackernews', url: 'https://nyt.test/1' }),
    r('Harvey OS – A Fresh Take on Plan 9', '', { source: 'hackernews', url: 'https://harvey-os.test/' }),
    r('Harvey Weinstein Is My Monster Too', '', { source: 'hackernews', url: 'https://nyt.test/2' }),
    r('Brian Harvey: Why SICP matters', '', { source: 'hackernews', url: 'https://berkeley.test/' }),
    r('Harvey’s Casino Bomb', '', { source: 'hackernews', url: 'https://fbi.test/' }),
    r('Harvey Friedman bringing incompleteness out of quarantine', '', { source: 'hackernews', url: 'https://nautil.test/' }),
  ];
  test('with no clean mention the query falls back to topic mode', () => {
    expect(resolveEntity(plan, wrong).mode).toBe('topic');
  });
  test('a clean mention wins and the wrong ones are filtered out', () => {
    const right = r('Legal AI Startup Harvey Raises $300M Series D', 'Harvey, the legal AI startup, was founded by Winston Weinberg.', { url: 'https://techcrunch.test/harvey' });
    const e = resolveEntity(plan, [...wrong, right]);
    expect(e.mode).toBe('entity');
    expect(e.name).toBe('Harvey');
    expect(e.confidence).toBe('high');
    expect(wrong.map((x) => e.matcher(x))).toEqual([false, false, false, false, false, false]);
    expect(e.matcher(right)).toBe(true);
    const { results } = filterAndRank([...wrong, right], plan, e);
    expect(results.map((x) => x.title)).toEqual([right.title]);
  });
  test('a clean mention without the asked intent or a descriptor is flagged low confidence', () => {
    const e = resolveEntity(plan, [r('Harvey – An effort to provide a modern 64-bit operating system', '', { source: 'hackernews', url: 'https://harvey-os.test/' })]);
    expect(e.mode).toBe('entity');
    expect(e.confidence).toBe('low');
  });
});

describe('ranking: duplicates, user documents and the date filter (defects 7, 10, 12)', () => {
  const plan = understandQuery('a16z portfolio');
  test('the same page under http/https, query string or trailing slash is one result', () => {
    const results = [
      r('Defending A16z: Noam Scheiber mistakes a VC portfolio for his 401K', 'a16z portfolio', { url: 'http://blog.garrytan.com/defending-a16z-noam-sheiber' }),
      r('Defending A16Z', 'Noam Scheiber on the a16z portfolio.', { url: 'https://www.blog.garrytan.com/defending-a16z-noam-sheiber/?utm_source=hn#top' }),
    ];
    const e = resolveEntity(plan, results);
    const { results: ranked } = filterAndRank(results, plan, e);
    expect(ranked).toHaveLength(1);
  });
  test('uploaded files and custom URLs are never capped out and rank first', () => {
    const plan2 = understandQuery('OpenAI latest funding');
    const many = Array.from({ length: 20 }, (_, i) => r(`OpenAI story ${i}`, `OpenAI raised money ${i}.`, { url: `https://news.test/${i}`, publishedAt: daysAgo(i + 1) }));
    const file = { title: 'File Source: memo.txt', content: 'Our internal notes on the deal.', url: '#', source: 'file', type: 'uploaded_file' };
    const custom = { title: 'Investor update', content: 'Board update text.', url: 'https://mysite.test/update', source: 'custom', type: 'custom_url' };
    const e = resolveEntity(plan2, many);
    const { results } = filterAndRank([...many, file, custom], plan2, e, { limit: 15 });
    expect(results).toHaveLength(17);
    expect(results.slice(0, 2).map((x) => x.source).sort()).toEqual(['custom', 'file']);
    expect(results.filter((x) => x.source === 'curated')).toHaveLength(15);
  });
  test('the date filter runs before the cap and reports how many were older; undated items are flagged', () => {
    const plan2 = understandQuery('OpenAI latest funding');
    const fresh = Array.from({ length: 18 }, (_, i) => r(`OpenAI update ${i}`, `OpenAI news ${i}.`, { url: `https://fresh.test/${i}`, publishedAt: daysAgo(i + 1) }));
    const old = Array.from({ length: 5 }, (_, i) => r(`OpenAI archive ${i}`, `OpenAI old news ${i}.`, { url: `https://old.test/${i}`, publishedAt: daysAgo(800 + i) }));
    const undated = r('OpenAI timeline', 'OpenAI milestones.', { url: 'https://undated.test/x' });
    const e = resolveEntity(plan2, [...fresh, ...old, undated]);
    const { results, olderThanFilter } = filterAndRank([...old, ...fresh, undated], plan2, e, { limit: 15, maxAgeDays: 365 });
    expect(olderThanFilter).toBe(5);
    expect(results).toHaveLength(15);
    expect(results.some((x) => /archive/.test(x.title))).toBe(false);
    const all = filterAndRank([...old, ...fresh, undated], plan2, e, { limit: 30, maxAgeDays: 365 }).results;
    expect(all.find((x) => x.title === 'OpenAI timeline').undated).toBe(true);
  });
});

describe('claim check (defect 3)', () => {
  test('a figure in the headline of a top-ranked result leads over an older, more-cited one', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const out = checkClaims([
      { title: 'Ramp hits $60bn valuation in $1.85bn funding round', content: 'Expense management company Ramp said on Thursday that it had raised $1.85 billion.', url: 'https://techcrunch.com/1' },
      { title: 'Ramp Series F', content: 'Ramp raised $750 million at a $44 billion valuation.', url: 'https://cnbc.com/2', publishedAt: '2026-06-15' },
      { title: 'Ramp Series F', content: 'Ramp announced a $750M Series F.', url: 'https://prnewswire.com/3', publishedAt: '2026-06-15' },
      { title: 'Ramp Series F', content: 'Ramp closes $750 million round.', url: 'https://yahoo.com/4', publishedAt: '2026-06-16' },
    ], { entity: 'Ramp' });
    const funding = out.claims.find((c) => /Funding/.test(c.label));
    expect(funding.value).toBe('$1.85B');
    expect(funding.status).toBe('single-source');
    // the June $750M figures are their own named round, not a disagreement
    const seriesF = out.claims.find((c) => /Series F/.test(c.label));
    expect(seriesF.value).toBe('$750M');
    expect(funding.alternatives.map((a) => a.value)).not.toContain('$750M');
  });

  test('JSON snippets, another company\'s round and "a total of" are not the company\'s claims', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const out = checkClaims([
      { title: 'Stripe data', content: '{ "status": "completed", "output": { "company": "Stripe", "seed": "...", "totalRaised": "Stripe has raised a total of approximately $9.81 billion over 24 funding rounds" } }', url: 'https://api.example.com/1' },
      { title: 'Stripe news', content: 'In September, it launched a joint crypto venture called Tempo, which reportedly raised $500m at a $5bn valuation a little more than a month after coming out from stealth.', url: 'https://news.example.com/2', publishedAt: '2026-10-01' },
      { title: 'Stripe tender', content: 'Stripe has raised a total of $9.81 billion to date; its latest tender offer valued the company at $159 billion.', url: 'https://techcrunch.com/3', publishedAt: '2026-02-20' },
      { title: 'Stripe tender', content: 'Stripe was valued at $159 billion in a February tender offer.', url: 'https://reuters.com/4', publishedAt: '2026-02-21' },
    ], { entity: 'Stripe' });
    expect(out.claims.map((c) => c.value)).not.toContain('$9.81B');
    expect(out.claims.map((c) => c.value)).not.toContain('$500M');
    expect(out.claims.map((c) => c.value)).not.toContain('$5B');
    const v = out.claims.find((c) => c.label === 'Valuation');
    expect(v.value).toBe('$159B');
    expect(v.status).toBe('corroborated');
  });

  test('"said it had raised" is current news, "at today\'s exchange rate" is not', () => {
    const { extractClaims } = require('../../../src/utils/claimCheck');
    const now = extractClaims({ title: 'Ramp', content: 'Ramp said on Thursday that it had raised $1.85 billion in a new funding round.', url: 'https://techcrunch.com/1' }, 1);
    expect(now[0]).toEqual(expect.objectContaining({ amount: 1.85e9, prior: false, current: true }));
    const old = extractClaims({ title: 'Mistral', content: 'The company has raised €385 million, or $415 million at today\'s exchange rate, and it values the company at roughly $2 billion.', url: 'https://yahoo.com/2' }, 2);
    expect(old.every((c) => !c.current && !c.prior)).toBe(true);
  });

  test('undated web results about a new round still lead over an older dated round', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const out = checkClaims([
      { title: 'Ramp raises', content: 'Expense management company Ramp said on Thursday that it had raised $1.85 billion in a new funding round that values it at $60 billion, just four months after raising $750 million at a $44 billion valuation.', url: 'https://techcrunch.com/1' },
      { title: 'Ramp', content: 'The company has raised $1.85 billion in a new round, the investor said.', url: 'https://investing.com/2' },
      { title: 'Ramp Series F', content: 'Ramp raised $750 million at a $44 billion valuation.', url: 'https://cnbc.com/3', publishedAt: '2026-06-15' },
      { title: 'Ramp Series F', content: 'Ramp announced a $750M Series F at a $44B valuation.', url: 'https://prnewswire.com/4', publishedAt: '2026-06-15' },
    ], { entity: 'Ramp' });
    const funding = out.claims.find((c) => /Funding/.test(c.label));
    expect(funding.value).toBe('$1.85B');
    expect(funding.status).toBe('corroborated');
    // the June figures are their own named round (Series F), not a disagreement
    expect(funding.alternatives.map((a) => a.value)).not.toContain('$750M');
    expect(out.claims.find((c) => /Series F/.test(c.label)).value).toBe('$750M');
  });

  test('"prior commitments" and "a year to the day after X\'s $2 billion Series C, which valued the company at $13.7 billion" are earlier figures', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const anthropic = checkClaims([
      { title: 'Anthropic closes $30B', content: 'Anthropic has raised $30 billion in a Series H round.', url: 'https://bloomberg.com/1', publishedAt: '2026-11-07' },
      { title: 'Anthropic round', content: 'Anthropic raised $30 billion; Altimeter, Dragoneer and Sequoia led the round, which also included $15 billion in prior commitments from hyperscalers.', url: 'https://yahoo.com/2', publishedAt: '2026-11-07' },
    ], { entity: 'Anthropic' });
    const a = anthropic.claims.find((c) => /Series H|Funding/.test(c.label));
    expect(a.value).toBe('$30B');
    expect(a.status).toBe('corroborated');
    // "$15 billion in prior commitments" is context, not a round of its own
    expect(anthropic.claims.map((c) => c.value)).not.toContain('$15B');
    expect(anthropic.claims.every((c) => c.status !== 'conflict')).toBe(true);
    const mistral = checkClaims([
      { title: 'Mistral raises', content: 'Mistral AI raised $3.5 billion at a $24 billion valuation on Tuesday.', url: 'https://crunchbase.com/1', publishedAt: '2026-03-10' },
      { title: 'Mistral context', content: 'The financing comes nearly one year to the day after Mistral’s $2 billion Series C, which valued the company at $13.7 billion.', url: 'https://crunchbase.com/2', publishedAt: '2026-03-10' },
      { title: 'Mistral valuation', content: 'Mistral AI is now valued at $24 billion, the company said.', url: 'https://ft.com/3', publishedAt: '2026-03-11' },
    ], { entity: 'Mistral AI' });
    const v = mistral.claims.find((c) => c.label === 'Valuation');
    expect(v.value).toBe('$24B');
    expect(v.status).toBe('corroborated');
    expect(v.alternatives.find((x) => x.value === '$13.7B')).toEqual(expect.objectContaining({ prior: true }));
  });

  test('with the company known: market statistics, other subjects and table cells are not its claims; "last round a year ago" is earlier', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const mk = (title, content, url, date) => ({ title, content, url, publishedAt: date });
    const out = checkClaims([
      mk('Mistral AI Boosts Valuation to €21 Billion', 'Mistral AI has raised €3 billion at a valuation of more than €21 billion. The Paris-based startup has nearly doubled its €11.7 billion valuation from its last fundraising round a year ago.', 'https://bloomberg.com/1', '2026-09-09'),
      mk('Mistral round', 'Mistral AI raised €3 billion in its Series D at a €21 billion valuation, the company said.', 'https://euronews.com/2', '2026-09-09'),
      mk('Europe funding', 'All told, Europe-based startups raised $24 billion in the quarter, two-thirds higher than the $14.4 billion raised in Q2 2025.', 'https://crunchbase.com/3', '2026-10-01'),
      mk('Mistral table', 'In December 2023, Mistral AI completed a Series A funding round raising €385 million led by Andreessen [...] | Sep 2025 | Series C | €1.7 billion | ASML, NVIDIA', 'https://multiples.vc/4', '2026-10-01'),
      mk('Mistral Series B', "The Paris-based outfit raised $640 million in its 'series B' funding round, which was led by General Catalyst, taking its total investment to $1 billion in its first year.", 'https://investing.com/5', '2024-06-11'),
      mk('Mistral Series B', 'Mistral AI has raised 600 million euros ($643.7 million) in a funding round led by General Catalyst, it said on Tuesday.', 'https://reuters.com/6', '2024-06-11'),
    ], { entity: 'Mistral AI' });
    const seriesB = out.claims.find((c) => /Series B/.test(c.label));
    expect(seriesB.status).toBe('corroborated');
    expect(seriesB.alternatives.find((a) => a.value === '$1B')).toEqual(expect.objectContaining({ total: true }));
    const valuation = out.claims.find((c) => c.label === 'Valuation');
    expect(valuation.value).toBe('€21B');
    expect(valuation.status).toBe('corroborated');
    expect(valuation.alternatives.find((a) => a.value === '€11.7B')).toEqual(expect.objectContaining({ prior: true }));
    expect(out.claims.map((c) => c.value)).not.toContain('$24B');
    expect(out.claims.map((c) => c.value)).not.toContain('$14.4B');
    const seriesA = out.claims.find((c) => /Series A/.test(c.label));
    expect(seriesA.value).toBe('€385M');
    expect(seriesA.alternatives).toEqual([]);
  });

  test('each figure is judged by its own clause: recaps and running totals in the same sentence', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const mk = (title, content, url, date) => ({ title, content, url, publishedAt: date });
    const openai = checkClaims([
      mk('OpenAI', 'OpenAI raises $11 billion at a $1.25 trillion valuation, up from $852 billion in March.', 'https://a.com/1', '2026-11-07'),
      mk('OpenAI', 'OpenAI has raised $11 billion, valuing it at $1.25 trillion.', 'https://b.com/2', '2026-11-07'),
      mk('OpenAI March', 'OpenAI was valued at $852 billion in its March round.', 'https://c.com/3', '2026-03-31'),
    ]);
    const openaiVal = openai.claims.find((c) => c.label === 'Valuation');
    expect(openaiVal.value).toBe('$1.25T');
    expect(openaiVal.status).toBe('corroborated');
    expect(openaiVal.alternatives.find((a) => a.value === '$852B')).toEqual(expect.objectContaining({ sameRound: false }));
    const out = checkClaims([
      mk('Ramp', 'Ramp raised $1.85 billion at a $60 billion valuation in October 2026, bringing the company\'s total capital raised to about $5 billion.', 'https://d.com/4', '2026-10-20'),
      mk('Ramp', 'Ramp raised $1.85 billion in a round valuing it at $60 billion.', 'https://e.com/5', '2026-10-21'),
      mk('Ramp recap', 'Ramp, which raised $750 million in June, is growing.', 'https://f.com/6', '2026-11-05'),
      mk('Ramp recap', 'The company raised $750 million at a $44 billion valuation, its sixth round.', 'https://g.com/7', '2026-11-06'),
      mk('Ramp news', 'Expense management company Ramp said it had raised $1.85 billion in a new funding round that values it at $60 billion, just four months after raising $750 million.', 'https://h.com/8', '2026-10-20'),
      mk('Ramp total', 'The company has now raised about $5 billion in funding.', 'https://i.com/9', '2026-10-20'),
    ]);
    expect(out.claims.find((c) => /Funding/.test(c.label)).alternatives.find((a) => a.value === '$5B')).toEqual(expect.objectContaining({ total: true }));
    const ramp = out.claims.find((c) => /Funding/.test(c.label));
    expect(ramp.value).toBe('$1.85B');
    expect(ramp.status).toBe('corroborated');
    expect(ramp.alternatives.find((a) => a.value === '$5B')).toEqual(expect.objectContaining({ total: true }));
    expect(ramp.alternatives.find((a) => a.value === '$750M')).toEqual(expect.objectContaining({ sameRound: false }));
  });

  test('a 10x gap within one named round is not a disagreement', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const out = checkClaims([
      { title: 'Mistral Series A', content: 'Mistral raised $415 million in its Series A at a $2 billion valuation; it is now worth $14.4 billion.', url: 'https://a.com/1', publishedAt: '2023-12-11' },
      { title: 'Mistral Series A', content: 'Mistral closed a $415M Series A led by a16z.', url: 'https://b.com/2', publishedAt: '2023-12-11' },
    ]);
    const a = out.claims.find((c) => /Series A/.test(c.label));
    expect(a.value).toBe('$415M');
    expect(a.status).toBe('corroborated');
    expect(a.alternatives.filter((x) => x.sameRound && !x.speculative)).toEqual([]);
  });

  test('a company with several rounds in a year: the newest corroborated figure leads, earlier ones are "earlier", no false disagreement', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const mk = (title, content, url, date) => ({ title, content, url, publishedAt: date });
    const out = checkClaims([
      mk('Ramp Valued at $60 Billion Following New Funding Round', 'Ramp raised $1.85 billion at a $60 billion valuation in October 2026.', 'https://pymnts.com/1', '2026-10-20'),
      mk('Ramp hits $60B', 'Ramp has raised $1.85 billion, valuing the company at $60 billion.', 'https://techcrunch.com/2', '2026-10-20'),
      mk('Ramp recap', 'This is the fourth round in 2026 (after a $750m Series F in June at $44bn).', 'https://yahoo.com/3', '2026-11-01'),
      mk('Ramp Series F', 'Ramp raised $750 million at a $44 billion valuation.', 'https://cnbc.com/4', '2026-06-15'),
      mk('Ramp Series F', 'Ramp announced a $750M Series F at a $44B valuation.', 'https://prnewswire.com/5', '2026-06-15'),
      mk('Ramp Series F', 'Ramp valued at $44 billion after $750M round.', 'https://finovate.com/6', '2026-06-16'),
      mk('Ramp March', 'Ramp raised $500 million at a $32 billion valuation in March 2026.', 'https://crunchbase.com/7', '2026-03-10'),
      // November recaps of the June round carry no date of their own
      mk('Ramp explained', 'Ramp raised $750 million in its Series F at a $44 billion valuation.', 'https://axios.com/8', '2026-11-05'),
      mk('Ramp profile', 'The company raised $750 million at a $44 billion valuation, its sixth round.', 'https://forbes.com/9', '2026-11-06'),
    ]);
    const valuation = out.claims.find((c) => c.label === 'Valuation');
    expect(valuation.value).toBe('$60B');
    expect(valuation.status).toBe('corroborated');
    expect(valuation.alternatives.map((a) => [a.value, a.prior || a.sameRound])).toEqual([['$44B', false], ['$32B', false]]);
    const funding = out.claims.find((c) => /Funding|Series F/.test(c.label));
    expect(funding.value).toBe('$1.85B');
    expect(funding.status).toBe('corroborated');
  });

  test('"value"/"worth" mark valuations; running totals and earlier rounds never conflict with the latest round', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const out = checkClaims([
      { title: 'OpenAI round', content: 'OpenAI raised $11 billion at a $1.25 trillion valuation.', url: 'https://a.com/1', publishedAt: '2026-11-07' },
      { title: 'OpenAI round', content: 'OpenAI has raised $11 billion in a round valuing it at $1.25 trillion.', url: 'https://d.com/4', publishedAt: '2026-11-07' },
      { title: 'Talks', content: 'OpenAI is in early talks for funding at up to a $1.5 trillion value.', url: 'https://b.com/2', publishedAt: '2026-11-03' },
      { title: 'Total', content: 'OpenAI has raised $122 billion in total funding since 2015.', url: 'https://c.com/3', publishedAt: '2026-11-04' },
      { title: 'Recap', content: 'The company previously raised $122 billion in March at an $852 billion valuation.', url: 'https://e.com/5', publishedAt: '2026-11-06' },
    ]);
    const funding = out.claims.find((c) => /Funding/.test(c.label));
    expect(funding.value).toBe('$11B');
    expect(funding.status).toBe('corroborated');
    expect(funding.alternatives.map((a) => [a.value, a.total || a.prior, a.sameRound])).toEqual([['$122B', true, false]]);
    const valuation = out.claims.find((c) => c.label === 'Valuation');
    expect(valuation.value).toBe('$1.25T');
    expect(valuation.status).toBe('corroborated');
    expect(valuation.alternatives.map((a) => [a.value, a.speculative, a.prior])).toEqual(expect.arrayContaining([['$1.5T', true, false], ['$852B', false, true]]));
  });

  test('the largest figure in a valuation sentence is the valuation, never a funding alternative', () => {
    const { checkClaims } = require('../../../src/utils/claimCheck');
    const out = checkClaims([
      { title: 'OpenAI round', content: 'OpenAI raised $11 billion at a $1.25 trillion valuation.', url: 'https://a.com/1', publishedAt: '2026-11-07' },
      { title: 'Talks', content: 'OpenAI is in talks to raise as much as $30 billion at a valuation of $1.4 trillion, up from $500 billion.', url: 'https://b.com/2', publishedAt: '2026-11-03' },
    ]);
    const funding = out.claims.find((c) => /Funding/.test(c.label));
    const valuation = out.claims.find((c) => c.label === 'Valuation');
    expect(funding.value).toBe('$11B');
    expect(funding.alternatives.map((a) => a.value)).toEqual(['$30B']);
    expect(valuation.value).toBe('$1.25T');
    expect(valuation.alternatives.map((a) => a.value)).toEqual(expect.arrayContaining(['$1.4T']));
    // the whole sentence is "in talks", so $500B is part of a target, never a disagreement
    expect(valuation.alternatives.find((a) => a.value === '$500B')).toEqual(expect.objectContaining({ speculative: true }));
    expect(valuation.status).toBe('single-source');
  });

  test('a reported target ("in talks to raise $30B") never beats or conflicts with a confirmed raise', () => {
    const { checkClaims, isSpeculativeClaim } = require('../../../src/utils/claimCheck');
    const mk = (title, content, url, date) => ({ title, content, url, publishedAt: date });
    const out = checkClaims([
      mk('OpenAI in talks to raise $30 billion', 'OpenAI is in talks to raise $30 billion in new funding, people familiar said.', 'https://a.com/1', '2026-11-01'),
      mk('OpenAI could raise up to $30B', 'OpenAI could raise up to $30 billion this month.', 'https://b.com/2', '2026-11-02'),
      mk('OpenAI seeks $30B round', 'OpenAI seeks $30 billion at a $1.25 trillion valuation.', 'https://c.com/3', '2026-11-03'),
      mk('OpenAI raises $11 billion', 'OpenAI raised $11 billion at a $1.25 trillion valuation, the company said.', 'https://d.com/4', '2026-11-07'),
      mk('OpenAI closes $11B', 'OpenAI has raised $11 billion in a new funding round that values it at $1.25 trillion.', 'https://e.com/5', '2026-11-07'),
    ]);
    const funding = out.claims.find((c) => /Funding/.test(c.label));
    expect(funding.value).toBe('$11B');
    expect(funding.status).toBe('corroborated');
    expect(funding.alternatives).toEqual([expect.objectContaining({ value: '$30B', speculative: true })]);
    expect(isSpeculativeClaim('OpenAI raised $11 billion')).toBe(false);
    expect(isSpeculativeClaim('OpenAI is in talks to raise $30 billion')).toBe(true);
  });

  const { checkClaims, formatAmount } = require('../../../src/utils/claimCheck');
  test('"$11 billion at a $1.25 trillion valuation" is a raise and a valuation, not a conflict', () => {
    const results = [
      r('OpenAI reportedly raises an additional $11 billion at a $1.25 trillion valuation', 'OpenAI has raised $11 billion so far in a new funding round that values the company at $1.25 trillion.', { url: 'https://startupwiredaily.test/a', publishedAt: '2026-11-07T00:00:00Z' }),
      r('OpenAI Raises $11 Billion At a $1.25 Trillion Valuation', 'In a new funding round, OpenAI raises $11 billion to hit a valuation of $1.25 trillion.', { url: 'https://ventureburn.test/b', publishedAt: '2026-11-07T00:00:00Z' }),
    ];
    const { claims, summary } = checkClaims(results);
    const raise = claims.find((c) => c.label === 'Funding amount');
    const valuation = claims.find((c) => c.label === 'Valuation');
    expect(raise.value).toBe('$11B');
    expect(raise.status).toBe('corroborated');
    expect(valuation.value).toBe('$1.25T');
    expect(valuation.status).toBe('corroborated');
    expect(summary.conflicts).toBe(0);
    expect(formatAmount({ amount: 1.25e12, currency: 'USD' })).toBe('$1.25T');
  });
  test('two different rounds are "different figures reported", not a conflict; same month is a conflict', () => {
    const rounds = [
      r('OpenAI raises $11 billion', 'OpenAI raises $11 billion in November 2026.', { url: 'https://a.test/1', publishedAt: '2026-11-07T00:00:00Z' }),
      r('OpenAI raised $6.6 billion in 2024', 'OpenAI raised $6.6 billion in October 2024.', { url: 'https://b.test/2', publishedAt: '2024-10-02T00:00:00Z' }),
    ];
    const { claims } = checkClaims(rounds);
    expect(claims[0].status).toBe('single-source');
    expect(claims[0].note).toBe('different figures reported');
    expect(claims[0].alternatives[0]).toEqual(expect.objectContaining({ value: '$6.6B', sameRound: false }));

    const same = [
      r('OpenAI raises $11 billion', 'OpenAI raises $11 billion in November 2026.', { url: 'https://a.test/1', publishedAt: '2026-11-07T00:00:00Z' }),
      r('OpenAI raises $8 billion', 'OpenAI raises $8 billion in November 2026, sources say.', { url: 'https://b.test/2', publishedAt: '2026-11-06T00:00:00Z' }),
    ];
    expect(checkClaims(same).claims[0].status).toBe('conflict');
  });
});

describe('source tiers and verified badge (defect 9)', () => {
  const { sourceTier, isVerifiedSource } = require('../../../src/utils/sourceTiers');
  test('the host decides before the retrieving source', () => {
    expect(sourceTier({ source: 'hackernews', url: 'https://www.sec.gov/Archives/edgar/data/1/s1.htm' })).toBe('filing');
    expect(sourceTier({ source: 'hackernews', url: 'https://techcrunch.com/2026/11/06/x' })).toBe('press');
    expect(sourceTier({ source: 'hackernews', url: 'https://news.ycombinator.com/item?id=1' })).toBe('forum');
    expect(sourceTier({ source: 'curated', url: 'https://openai.com/index/x', sourceCategory: 'company_blog' })).toBe('blog');
  });
  test('only filings, official records and market data are verified', () => {
    expect(isVerifiedSource({ source: 'sec', url: 'https://www.sec.gov/x' })).toBe(true);
    expect(isVerifiedSource({ source: 'fmp', url: 'https://apple.com' })).toBe(true);
    expect(isVerifiedSource({ source: 'curated', url: 'https://www.saastr.com/x', sourceCategory: 'market_analysis' })).toBe(false);
  });
});

describe('quoted digest (defects 8, 18)', () => {
  const { synthesizeFromResults } = require('../../../src/utils/fallbackSynthesizer');
  const { cleanText } = require('../../../src/utils/evidence');
  const results = [
    r('OpenAI reportedly raises an additional $11 billion at a $1.25 trillion valuation', 'OpenAI has raised $11 billion so far in a new funding round that values the company at $1.25 trillion.', { url: 'https://startupwiredaily.test/a', sourceName: 'StartupWire Daily', publishedAt: '2026-11-07T00:00:00Z' }),
    r('OpenAI looks to make data centers more palatable', 'OpenAI said it would avoid nondisclosure agreements in data center deals.', { url: 'https://semafor.test/b', sourceName: 'Semafor', publishedAt: '2026-11-05T00:00:00Z' }),
  ];
  test('summary sentences are joined with punctuation, one citation per sentence, coverage on its own line', () => {
    const { content } = synthesizeFromResults('open ai latest funding', results, { entityName: 'OpenAI', intents: ['funding'], recency: true });
    const summary = content.split('## SUMMARY')[1].split('## KEY POINTS')[0];
    expect(summary).toMatch(/^\nBased on 2 sources about OpenAI \(2 from your curated sources\), dated 2026-11-05 to 2026-11-07\.\n\n/);
    expect(summary).toMatch(/\$1\.25 trillion \(StartupWire Daily, 2026-11-07\) \[Source 1\]\. OpenAI /);
    expect(summary).not.toMatch(/\[Source \d\] [A-Z]/);
  });
  test('follow-up questions depend on the intent and do not repeat the question', () => {
    const funding = synthesizeFromResults('open ai latest funding', results, { entityName: 'OpenAI', intents: ['funding'] }).followUpQuestions;
    expect(funding[0]).toMatch(/led OpenAI's most recent round, and at what valuation/);
    expect(funding.join(' ')).toMatch(/use the new capital/);
    expect(funding.join(' ')).not.toMatch(/latest funding/i);
    const team = synthesizeFromResults('who are the founders of OpenAI', results, { entityName: 'OpenAI', intents: ['team'] }).followUpQuestions;
    expect(team[0]).toMatch(/key recent hires/);
    expect(team.join(' ')).not.toMatch(/known about OpenAI's founders and leadership team/);
    const comp = synthesizeFromResults('OpenAI competitors', results, { entityName: 'OpenAI', intents: ['competitors'] }).followUpQuestions;
    expect(comp[0]).toMatch(/position itself against those competitors on product and pricing/);
    expect(comp.join(' ')).not.toMatch(/closest competitors, and how do they compare/);
  });
  test('source numbering follows the full ranked list (no 12-source cap)', () => {
    const many = Array.from({ length: 16 }, (_, i) => r(`OpenAI story ${i + 1}`, `OpenAI announced item number ${i + 1} today.`, { url: `https://n.test/${i}` }));
    const { sourceMap } = synthesizeFromResults('OpenAI', many, { entityName: 'OpenAI' });
    expect(Object.keys(sourceMap)).toHaveLength(16);
    expect(sourceMap['16'].url).toBe('https://n.test/15');
  });
  test('feed footers in French are removed, including a truncated one', () => {
    expect(cleanText("Mistral a été mis L’article Mistral s'offre une cinquième acquisition est apparu en premier sur Maddyness - Le média pour comprendre l'économie de demain .")).toBe('Mistral a été mis');
    expect(cleanText('Kabilio lève 10M€ pour ses agents. L’article Kabilio lève 10M€ est apparu en premier su')).toBe('Kabilio lève 10M€ pour ses agents.');
    expect(cleanText('The post-money valuation was $2B. Great news.')).toBe('The post-money valuation was $2B. Great news.');
  });
});

describe('retrieval statuses (defects 11, 20)', () => {
  const env = { ...process.env };
  const handler = require('../../../src/pages/api/search/open').default;
  const { retrieve } = require('../../../src/server/search/retrieve');
  afterEach(() => { process.env = { ...env }; jest.resetModules(); });
  test('web without a key is "not_configured", not an error, and is not searched', async () => {
    delete process.env.SERPER_API_KEY; delete process.env.TAVILY_API_KEY;
    const { retrieve: realRetrieve } = jest.requireActual('../../../src/server/search/retrieve');
    const { statuses } = await realRetrieve(understandQuery('OpenAI'), ['curated', 'web']);
    expect(statuses.find((s) => s.source === 'web')).toEqual(expect.objectContaining({ status: 'not_configured' }));
    expect(statuses.find((s) => s.source === 'web').error).toMatch(/SERPER_API_KEY/);
    expect(axios.post).not.toHaveBeenCalled();
  });
  test('curated retrieval always searches the full name, even when its words are generic ("open ai" -> "OpenAI")', async () => {
    const curated = require('../../../src/utils/sources/curatedIndex');
    curated.searchCuratedForEntity.mockClear();
    const { retrieve: realRetrieve } = jest.requireActual('../../../src/server/search/retrieve');
    await realRetrieve(understandQuery('open ai latest funding'), ['curated']);
    const matchers = curated.searchCuratedForEntity.mock.calls.map(([isMention]) => isMention);
    expect(matchers.length).toBeGreaterThan(0);
    expect(matchers.some((isMention) => isMention('OpenAI raises $11 billion'))).toBe(true);
    expect(matchers.some((isMention) => isMention('open source AI is winning'))).toBe(false);
  });
  test('the API keeps not-configured sources out of degradedSources and reports olderThanFilter', async () => {
    retrieve.mockResolvedValue({
      results: [{ ...r('OpenAI raises $11 billion', 'OpenAI raised $11 billion.', { publishedAt: daysAgo(1) }), retrievedBy: 'curated' }, { ...r('OpenAI raised $6.6 billion in 2024', 'Older round.', { publishedAt: daysAgo(700) }), retrievedBy: 'curated' }],
      statuses: [{ source: 'curated', status: 'ok', count: 2 }, { source: 'web', status: 'not_configured', count: 0, error: 'Web search is off' }],
    });
    const res = createMockRes();
    await handler(createMockReq({ method: 'POST', body: { query: 'open ai latest funding', maxAgeDays: 365, model: 'bogus:model' } }), res);
    expect(res.body.status).toBe('ok');
    expect(res.body.degradedSources).toEqual([]);
    expect(res.body.olderThanFilter).toBe(1);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.answerInfo.modelNote).toMatch(/Requested model "bogus:model" is not available/);
  });
  test('no results: content null, answerInfo null, fail-soft message and suggestions', async () => {
    retrieve.mockResolvedValue({ results: [{ ...r('Unrelated', 'nothing here'), retrievedBy: 'hackernews' }], statuses: [{ source: 'curated', status: 'empty', count: 0 }] });
    const res = createMockRes();
    await handler(createMockReq({ method: 'POST', body: { query: 'asdkjhasd' } }), res);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.content).toBeNull();
    expect(res.body.answerInfo).toBeNull();
    expect(res.body.failSoftContent.message).toMatch(/asdkjhasd/);
    expect(res.body.failSoftContent.suggestions.length).toBeGreaterThan(1);
  });
  test('custom URL failures are surfaced with the reason', async () => {
    const { fetchUrlContent } = require('../../../src/utils/urlExtraction');
    const { sourceHandlers } = require('../../../src/utils/sourceIntegration');
    fetchUrlContent.mockResolvedValueOnce({ status: 'error', url: 'https://x.test/a', content: '', error: 'Unsupported content type: application/pdf' });
    await expect(sourceHandlers.custom('q', ['https://x.test/a'])).rejects.toThrow(/x\.test\/a: Unsupported content type/);
    fetchUrlContent
      .mockResolvedValueOnce({ status: 'ok', url: 'https://x.test/b', title: 'B', content: 'Body text' })
      .mockResolvedValueOnce({ status: 'empty', url: 'https://x.test/c', title: 'C', content: '' });
    const partial = await sourceHandlers.custom('q', ['https://x.test/b', 'https://x.test/c']);
    expect(partial).toHaveLength(1);
    expect(partial.errors).toEqual(['https://x.test/c: no readable text on the page']);
  });
});
