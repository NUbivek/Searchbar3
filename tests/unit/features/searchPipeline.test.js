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

  test('returns null when no provider is configured', async () => {
    delete process.env.GROQ_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.TOGETHER_API_KEY;
    const { chatComplete } = require('../../../src/server/llm/providers');
    expect(await chatComplete([{ role: 'user', content: 'hi' }])).toBeNull();
  });
});

describe('/api/search/open contract', () => {
  const env = { ...process.env };
  beforeEach(() => { delete process.env.GROQ_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.TOGETHER_API_KEY; });
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
