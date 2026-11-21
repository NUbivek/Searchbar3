/**
 * @jest-environment node
 *
 * R3 (audit 2026-11-20), the keyless search engines (searchEngines.js): a site search no longer retries every
 * half second while the only engine that can take it is paused; a web question only headline feeds answered
 * says so; the seed and adverse questions can wait for a general web search; a Google News headline is matched
 * to the publisher's own address.
 */
jest.mock('../../../src/server/search/retrieve', () => ({
  searchWeb: jest.fn(async () => []),
  webSearchConfigured: jest.fn(() => false),
}));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

import {
  ENGINES, EngineBlocked, keylessSearch, nextFreeAt, resolveHeadline, engineHealth, __resetEnginesForTests,
} from '../../../src/server/founder/sources/searchEngines';

const MINUTE = 60 * 1000;
const hit = (n, extra = {}) => ({ title: `Result ${n} about Jane Roe`, snippet: `Snippet ${n}`, url: `https://example.com/story-${n}`, date: null, ...extra });
let now;
function stub(answers = {}) {
  const spies = {};
  for (const e of ENGINES) {
    const answer = answers[e.id];
    spies[e.id] = jest.spyOn(e, 'search').mockImplementation(async (...args) => {
      if (answer === undefined) return [];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(...args) : answer;
    });
  }
  return spies;
}

beforeEach(() => {
  __resetEnginesForTests();
  now = Date.parse('2026-11-20T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

describe('web-site-query-retry-spin: a site search waits for the engine that can take it', () => {
  test('DuckDuckGo paused: a LinkedIn search is retried when DuckDuckGo is free, not in half a second', async () => {
    stub({ ddg: new EngineBlocked('challenge') });
    await keylessSearch('"Jane Roe" lawsuit').catch(() => null); // DuckDuckGo asks us to stop: paused 10 minutes
    let error = null;
    try { await keylessSearch('"Jane Roe" site:linkedin.com/in'); } catch (e) { error = e; }
    expect(error).toBeTruthy();
    expect(error.code).toBe('SEARCH_RESTING');
    expect(error.retryAt - now).toBeGreaterThanOrEqual(10 * MINUTE);
  });

  test('a site search may use the whole allowance, so its retry time does not subtract the reserve', () => {
    const ddg = ENGINES.find((e) => e.id === 'ddg');
    stub({ ddg: [hit(1)] });
    // four ordinary searches use the ordinary allowance (6 less the 2 kept for site searches)
    return (async () => {
      for (let i = 0; i < 4; i += 1) await keylessSearch(`"Jane Roe" q${i}`);
      // only the spacing between requests (a few seconds) for a site search; the whole period otherwise
      expect(nextFreeAt(['ddg'], { siteSearch: true }) - now).toBeLessThan(MINUTE);
      expect(nextFreeAt(['ddg']) - now).toBeGreaterThanOrEqual(ddg.budget.perMs);
    })();
  });

  test('no switched-on engine can take a site search: not run, said plainly, no waiting', async () => {
    stub({});
    const ddg = ENGINES.find((e) => e.id === 'ddg');
    const enabled = ddg.enabled;
    ddg.enabled = () => false;
    try {
      let error = null;
      try { await keylessSearch('"Jane Roe" site:linkedin.com/in'); } catch (e) { error = e; }
      expect(error.message).toMatch(/^Not run: needs a general web search/);
      expect(error.code).toBeUndefined();
    } finally { if (enabled) ddg.enabled = enabled; else delete ddg.enabled; }
  });
});

describe('web-news-only-counts-as-searched', () => {
  const useUpDdg = async () => { for (let i = 0; i < 4; i += 1) await keylessSearch(`"Someone Else" q${i}`); };

  test('only headline feeds answered a web question: the answer says headlinesOnly', async () => {
    stub({ ddg: [hit(9)], gnews: [hit(1, { url: 'https://news.google.com/rss/articles/1', host: 'reuters.com' })] });
    await useUpDdg();
    const out = await keylessSearch('"Jane Roe" lawsuit');
    expect(out.tried[0]).toMatchObject({ id: 'ddg', outcome: 'resting' });
    expect(out).toMatchObject({ engine: 'gnews', general: false, headlinesOnly: true, generalWaiting: true });
    expect(out.generalRetryAt).toBeGreaterThan(now);
  });

  test('a general web search answered: not headlines only', async () => {
    stub({ ddg: [hit(1)] });
    expect(await keylessSearch('"Jane Roe" lawsuit')).toMatchObject({ general: true, headlinesOnly: false });
  });

  test('needGeneral: waits for DuckDuckGo instead of asking the news feeds, when it is free again soon enough', async () => {
    const spies = stub({ ddg: [hit(9)], gnews: [hit(1)] });
    await useUpDdg();
    now += 5 * MINUTE; // the allowance frees up 10 minutes after the first search: 5 minutes from now
    let error = null;
    try { await keylessSearch('"Jane Roe" lawsuit', { needGeneral: true }); } catch (e) { error = e; }
    expect(error.code).toBe('SEARCH_RESTING');
    expect(error.retryAt - now).toBeLessThanOrEqual(5 * MINUTE + 1000);
    expect(spies.gnews).not.toHaveBeenCalled();
    // past the longest wait it settles for the news feeds, and says so
    const out = await keylessSearch('"Jane Roe" lawsuit', { needGeneral: true, maxWaitMs: MINUTE });
    expect(out).toMatchObject({ headlinesOnly: true });
  });
});

describe('web-coverage-note-misleading', () => {
  test('an engine that never answered is not said to have run; one resting is named', async () => {
    stub({ ddg: [hit(9)] });
    for (let i = 0; i < 6; i += 1) await keylessSearch(`"Jane Roe" site:example.com q${i}`).catch(() => null);
    const { note } = engineHealth();
    expect(note).toMatch(/^Open-web and news searches were answered by DuckDuckGo\./);
    expect(note).not.toMatch(/Google News|Bing News|GDELT/);
    expect(note).toMatch(/DuckDuckGo has used its searches for now and is resting/);
  });
});

describe('web-gnews-articles-never-read: the article behind a Google News headline', () => {
  test('Bing News is asked for the exact headline; only the same headline on the same site is taken', async () => {
    const asked = [];
    stub({
      bingnews: (q) => {
        asked.push(q);
        return [
          { title: 'Merge raises $55M Series B for its unified API', url: 'https://www.techcrunch.com/2022/10/24/merge-raises-55m-series-b-for-its-unified-api/', date: '2022-10-24' },
          { title: 'Merge raises $55M Series B for its unified API', url: 'https://copycat.example.com/merge', date: '2022-10-24' },
        ];
      },
    });
    const url = await resolveHeadline('Merge raises $55M Series B for its unified API - TechCrunch', 'techcrunch.com');
    expect(asked).toEqual(['"Merge raises $55M Series B for its unified API"']);
    expect(url).toBe('https://www.techcrunch.com/2022/10/24/merge-raises-55m-series-b-for-its-unified-api/');
    expect(await resolveHeadline('Merge raises $55M Series B for its unified API', 'forbes.com')).toBeNull();
  });
});
