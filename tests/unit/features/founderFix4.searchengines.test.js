/**
 * @jest-environment node
 *
 * Review round 4, item 11 (the part in searchEngines.js): a question about an
 * older event (a lawsuit about an earlier venture) is never answered by the
 * news feeds, which mostly serve recent coverage. When no general web search
 * could be asked, the lookup is reported as not run instead of returning
 * recent headlines that are already known.
 */
jest.mock('../../../src/server/search/retrieve', () => ({
  searchWeb: jest.fn(async () => []),
  webSearchConfigured: jest.fn(() => false),
}));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

import { searchWeb, webSearchConfigured } from '../../../src/server/search/retrieve';
import { ENGINES, EngineBlocked, keylessSearch, engineOrder, __resetEnginesForTests } from '../../../src/server/founder/sources/searchEngines';

const hit = (n) => ({ title: `Result ${n} about Jane Roe and Acme`, snippet: `Snippet ${n}`, url: `https://example.com/story-${n}`, date: null });
const QUERY = '"Acme Labs" "Jane Roe" (sued OR lawsuit OR judgment)';
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
  __resetEnginesForTests();
  now = Date.parse('2026-11-14T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  delete process.env.FOUNDER_SEARCH_BRAVE_HTML;
  delete process.env.FOUNDER_SEARCH_METERED;
  webSearchConfigured.mockReset();
  webSearchConfigured.mockReturnValue(false);
  searchWeb.mockReset();
  searchWeb.mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.FOUNDER_SEARCH_BRAVE_HTML;
});

describe('prefer: archive', () => {
  test('the news feeds are never in the order; reference and plain web searches keep them', () => {
    expect(engineOrder({ query: QUERY, prefer: 'archive' })).toEqual(['ddg', 'wikipedia']);
    process.env.FOUNDER_SEARCH_BRAVE_HTML = '1';
    expect(engineOrder({ query: QUERY, prefer: 'archive' })).toEqual(['ddg', 'brave', 'wikipedia']);
    delete process.env.FOUNDER_SEARCH_BRAVE_HTML;
    expect(engineOrder({ query: QUERY, prefer: 'reference' })).toEqual(['ddg', 'wikipedia', 'gnews', 'bingnews']);
    expect(engineOrder({ query: QUERY })).toEqual(['ddg', 'gnews', 'bingnews', 'wikipedia']);
  });

  test('DuckDuckGo paused: Google News is not asked, and the lookup is not run (waiting for a web search), not empty', async () => {
    const spies = stub({ ddg: new EngineBlocked('challenge page'), gnews: [hit(1)], bingnews: [hit(2)] });
    // first call trips the pause
    await expect(keylessSearch(QUERY, { prefer: 'archive' })).rejects.toThrow(/Not run: needs a general web search; news feed covers recent items only/);
    const err = await keylessSearch(QUERY, { prefer: 'archive' }).catch((e) => e);
    expect(err.message).toMatch(/^Not run: needs a general web search; news feed covers recent items only/);
    expect(err.notRun).toBe('needs a general web search; news feed covers recent items only');
    expect(err.code).toBe('SEARCH_RESTING');
    expect(err.retryAt).toBeGreaterThan(now + 9 * 60 * 1000); // when DuckDuckGo is free again, not when Google News is
    expect(spies.gnews).not.toHaveBeenCalled();
    expect(spies.bingnews).not.toHaveBeenCalled();
  });

  test('a plain failure of the web search is reported as not run, without a retry time', async () => {
    stub({ ddg: new Error('socket hang up'), gnews: [hit(1)] });
    const err = await keylessSearch(QUERY, { prefer: 'archive' }).catch((e) => e);
    expect(err.message).toMatch(/^Not run: needs a general web search/);
    expect(err.code).toBeUndefined();
  });

  test('Wikipedia results are still used when DuckDuckGo cannot be asked', async () => {
    stub({ ddg: new Error('socket hang up'), wikipedia: [hit(3)], gnews: [hit(1)] });
    const out = await keylessSearch(QUERY, { prefer: 'archive' });
    expect(out.engine).toBe('wikipedia');
  });

  test('DuckDuckGo answering "nothing" is a real answer: resolves empty', async () => {
    const spies = stub({ gnews: [hit(1)] });
    const out = await keylessSearch(QUERY, { prefer: 'archive' });
    expect(out.results).toEqual([]);
    expect(out.tried.map((t) => t.id)).toEqual(['ddg', 'wikipedia']);
    expect(spies.gnews).not.toHaveBeenCalled();
  });

  test('the backup search service counts as a general web search', async () => {
    webSearchConfigured.mockReturnValue(true);
    searchWeb.mockResolvedValue([{ title: 'Acme Labs sued over contract (Jane Roe)', snippet: 'court', url: 'https://example.com/old-suit' }]);
    stub({ ddg: new Error('socket hang up'), gnews: [hit(1)] });
    const out = await keylessSearch(QUERY, { prefer: 'archive', allowMetered: true });
    expect(out.engine).toBe('metered');
    expect(out.results[0].url).toBe('https://example.com/old-suit');
  });

  test('prefer: reference keeps falling through to the news feeds as before', async () => {
    stub({ ddg: new Error('socket hang up'), gnews: [hit(1)] });
    const out = await keylessSearch(QUERY, { prefer: 'reference' });
    expect(out.engine).toBe('gnews');
  });
});
