/**
 * @jest-environment node
 *
 * Fixes to the keyless search engines (review round 1): the switches for the
 * backup search service and Google News, the backup service's hourly count
 * shared by every server instance, and engine pauses shared through the
 * database so a fresh instance does not ask an engine that just said stop.
 */
const mockRows = new Map(); // key -> { body, fetched_at }
let mockMode = 'neon';
let mockFail = false;
jest.mock('../../../src/server/db', () => ({
  persistenceMode: jest.fn(() => mockMode),
  queryOne: jest.fn(async () => null),
  query: jest.fn(async (text, params = []) => {
    if (mockFail) throw new Error('database down');
    if (/INSERT INTO source_cache/.test(text) && /RETURNING body/.test(text)) {
      const held = mockRows.get(params[0]);
      const body = (held ? Number(held.body) : 0) + 1;
      mockRows.set(params[0], { body, fetched_at: new Date().toISOString() });
      return [{ body }];
    }
    if (/INSERT INTO source_cache/.test(text)) {
      mockRows.set(params[0], { body: params[1], fetched_at: new Date().toISOString() });
      return [];
    }
    if (/^SELECT key, body FROM source_cache WHERE key LIKE/.test(text)) {
      const prefix = String(params[0]).replace(/%$/, '');
      return [...mockRows].filter(([k]) => k.startsWith(prefix)).map(([key, row]) => ({ key, body: row.body }));
    }
    return [];
  }),
}));
jest.mock('../../../src/server/search/retrieve', () => ({
  searchWeb: jest.fn(async () => []),
  webSearchConfigured: jest.fn(() => true),
}));

const { searchWeb, webSearchConfigured } = require('../../../src/server/search/retrieve');
const {
  ENGINES, EngineBlocked, keylessSearch, engineHealth, engineOrder, __resetEnginesForTests, METERED_PER_HOUR,
} = require('../../../src/server/founder/sources/searchEngines');

const MINUTE = 60 * 1000;
const hit = (n) => ({ title: `Result ${n} about Jane Roe`, snippet: `Snippet ${n}`, url: `https://example.com/story-${n}`, date: null });
const metered = [{ title: 'Jane Roe - Acme | LinkedIn', snippet: 'Founder at Acme', url: 'https://www.linkedin.com/in/jane-roe', date: null }];
let now;

function stub(answers = {}) {
  const spies = {};
  for (const e of ENGINES) {
    const answer = answers[e.id];
    spies[e.id] = jest.spyOn(e, 'search').mockImplementation(async () => {
      if (answer === undefined) return [];
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }
  return spies;
}

beforeEach(() => {
  mockRows.clear();
  mockMode = 'neon';
  mockFail = false;
  __resetEnginesForTests();
  now = Date.parse('2026-11-14T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  searchWeb.mockReset();
  searchWeb.mockResolvedValue(metered);
  webSearchConfigured.mockReturnValue(true);
  delete process.env.FOUNDER_SEARCH_METERED;
  delete process.env.FOUNDER_SEARCH_GOOGLE_NEWS;
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.FOUNDER_SEARCH_METERED;
  delete process.env.FOUNDER_SEARCH_GOOGLE_NEWS;
});

describe('backup search service', () => {
  test('FOUNDER_SEARCH_METERED=0 switches it off for the deep check', async () => {
    process.env.FOUNDER_SEARCH_METERED = '0';
    stub({});
    const out = await keylessSearch('"Jane Roe" Acme', { allowMetered: true });
    expect(out.results).toEqual([]);
    expect(searchWeb).not.toHaveBeenCalled();
    expect(engineHealth().metered.configured).toBe(false);
  });

  test('the hourly count is shared by all server instances through the database', async () => {
    stub({});
    // other instances already used 19 this hour
    mockRows.set('search-metered:2026-11-14T12', { body: 19, fetched_at: new Date().toISOString() });
    expect((await keylessSearch('"Jane Roe" a', { allowMetered: true })).engine).toBe('metered');
    expect(searchWeb).toHaveBeenCalledTimes(1);

    const second = await keylessSearch('"Jane Roe" b', { allowMetered: true });
    expect(second.engine).toBe(null);
    expect(second.tried[second.tried.length - 1]).toEqual({ id: 'metered', outcome: 'resting' });
    expect(searchWeb).toHaveBeenCalledTimes(1); // not asked once the shared hour is spent
    expect(engineHealth().metered.usedThisHour).toBe(1); // only the use that really ran is counted here

    // a new clock hour starts a new count
    now = Date.parse('2026-11-14T13:00:05Z');
    expect((await keylessSearch('"Jane Roe" c', { allowMetered: true })).engine).toBe('metered');
    expect(mockRows.get('search-metered:2026-11-14T13').body).toBe(1);
    expect(METERED_PER_HOUR).toBe(20);
  });

  test('when the database does not answer, the per-instance count still applies', async () => {
    mockFail = true;
    stub({});
    for (let i = 0; i < METERED_PER_HOUR + 2; i += 1) await keylessSearch(`"Jane Roe" q${i}`, { allowMetered: true });
    expect(searchWeb).toHaveBeenCalledTimes(METERED_PER_HOUR);
  });

  test('not asked when the time ran out', async () => {
    stub({});
    await expect(keylessSearch('"Jane Roe" Acme', { allowMetered: true, deadline: now + 2000 })).rejects.toThrow(/No search engine answered/);
    expect(searchWeb).not.toHaveBeenCalled();
    expect(mockRows.size).toBe(0);
  });
});

describe('Google News', () => {
  test('on by default with at most 60 requests per ten minutes; FOUNDER_SEARCH_GOOGLE_NEWS=0 switches it off', () => {
    const gnews = ENGINES.find((e) => e.id === 'gnews');
    expect(gnews.budget).toEqual({ max: 60, perMs: 10 * MINUTE });
    expect(engineOrder({ news: true, query: '"Jane Roe"' })).toEqual(['gnews', 'bingnews', 'gdelt']);
    process.env.FOUNDER_SEARCH_GOOGLE_NEWS = '0';
    expect(engineOrder({ news: true, query: '"Jane Roe"' })).toEqual(['bingnews', 'gdelt']);
    expect(engineOrder({ query: '"Jane Roe" lawsuit' })).toEqual(['ddg', 'bingnews', 'wikipedia']);
    expect(engineHealth().engines.find((e) => e.id === 'gnews').state).toBe('off');
  });

  test('allowance: the 61st news search in ten minutes goes to Bing News', async () => {
    stub({ gnews: [hit(1)], bingnews: [hit(2)] });
    for (let i = 0; i < 60; i += 1) expect((await keylessSearch(`"Jane Roe" n${i}`, { news: true })).engine).toBe('gnews');
    const next = await keylessSearch('"Jane Roe" n60', { news: true });
    expect(next.tried[0]).toEqual({ id: 'gnews', outcome: 'resting' });
    expect(next.engine).toBe('bingnews');
  });
});

describe('engine pauses shared across server instances', () => {
  test('a block is written to the database and a fresh instance takes it on', async () => {
    const spies = stub({ ddg: new EngineBlocked('DuckDuckGo asked for a human check'), gnews: [hit(1)] });
    await keylessSearch('"Jane Roe" lawsuit');
    await Promise.resolve(); await Promise.resolve();
    const row = mockRows.get('engine-rest:ddg');
    expect(JSON.parse(row.body)).toEqual({ until: now + 10 * MINUTE, ms: 10 * MINUTE });

    __resetEnginesForTests(); // a fresh server instance
    now += MINUTE;
    const out = await keylessSearch('"Jane Roe" fraud');
    expect(out.tried[0]).toEqual({ id: 'ddg', outcome: 'paused' });
    expect(spies.ddg).toHaveBeenCalledTimes(1);

    // the next block on that instance keeps doubling
    now += 10 * MINUTE;
    __resetEnginesForTests();
    mockRows.set('engine-rest:ddg', { body: JSON.stringify({ until: now + MINUTE, ms: 10 * MINUTE }) });
    expect((await keylessSearch('"Jane Roe" meanwhile')).tried[0]).toEqual({ id: 'ddg', outcome: 'paused' });
    now += 2 * MINUTE;
    await keylessSearch('"Jane Roe" again');
    expect(spies.ddg).toHaveBeenCalledTimes(2);
    expect((Date.parse(engineHealth().engines.find((e) => e.id === 'ddg').pausedUntil) - now) / MINUTE).toBe(20);
  });

  test('a short rest after plain failures is not shared, and an expired pause is ignored', async () => {
    stub({ gdelt: new Error('Timed out'), gnews: new Error('x'), bingnews: new Error('x') });
    for (let i = 0; i < 3; i += 1) await expect(keylessSearch(`"Jane Roe" ${i}`, { news: true })).rejects.toThrow();
    expect(engineHealth().engines.find((e) => e.id === 'gdelt').state).toBe('paused');
    expect([...mockRows.keys()].filter((k) => k.startsWith('engine-rest:'))).toEqual([]);

    __resetEnginesForTests();
    mockRows.set('engine-rest:gnews', { body: { until: now - 1000, ms: 10 * MINUTE } });
    stub({ gnews: [hit(1)] });
    expect((await keylessSearch('"Jane Roe"', { news: true })).engine).toBe('gnews');
  });

  test('without a database nothing is written', async () => {
    mockMode = 'none';
    stub({ ddg: new EngineBlocked('challenge'), gnews: [hit(1)] });
    await keylessSearch('"Jane Roe"');
    await Promise.resolve();
    expect(mockRows.size).toBe(0);
  });
});
