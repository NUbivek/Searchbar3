/**
 * Regression tests: curated registry search, multi-source open search, and
 * the extractive (no-LLM) digest.
 */

// ---- curated index: fake adapters so no network is used ----------------
const fakeFeeds = {};
jest.mock('../../../src/sourcing/adapters/rssAdapter', () => ({
  RssAdapter: class {
    constructor(source) { this.source = source; }
    async run() {
      const items = fakeFeeds[this.source.method.url];
      if (!items) throw new Error('HTTP 404');
      return items;
    }
  },
}));
jest.mock('../../../src/sourcing/adapters/htmlListAdapter', () => ({
  HtmlListAdapter: class {
    constructor(source) { this.source = source; }
    async run() {
      return fakeFeeds[this.source.method.url] || [];
    }
  },
}));
jest.mock('../../../sources/registry.json', () => ([
  { id: 'NEWS', name: 'Funding Wire Feed', adapter: 'rss', category: 'funding_news', region: 'US', cadence: { tier: 'A' }, method: { type: 'rss', url: 'https://news.test/feed' } },
  { id: 'BLOG', name: 'Ops Blog Feed', adapter: 'rss', category: 'market_analysis', region: 'US', cadence: { tier: 'C' }, method: { type: 'rss', url: 'https://blog.test/feed' } },
  { id: 'VC', name: 'Example Ventures Portfolio', adapter: 'html_list', category: 'venture_portfolio', region: 'US', cadence: { tier: 'B' }, method: { type: 'html', url: 'https://vc.test/portfolio' } },
  { id: 'DEAD', name: 'Dead Feed', adapter: 'rss', category: 'startup_news', region: 'US', cadence: { tier: 'B' }, method: { type: 'rss', url: 'https://dead.test/feed' } },
  { id: 'MOVED', name: 'Moved Feed', adapter: 'rss', category: 'startup_news', region: 'US', cadence: { tier: 'B' }, method: { type: 'rss', url: 'https://moved.test/old-feed' } },
]), { virtual: false });
jest.mock('../../../sources/registry-health.json', () => ({
  checkedAt: '2026-11-07T00:00:00.000Z',
  counts: { ok: 3, dead: 1, repaired: 1 },
  sources: {
    NEWS: { status: 'ok' },
    BLOG: { status: 'ok' },
    VC: { status: 'ok' },
    DEAD: { status: 'dead', error: 'ENOTFOUND' },
    MOVED: { status: 'repaired', url: 'https://moved.test/feed' },
  },
}));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(() => { throw new Error('no snapshot in tests'); }),
  writeFileSync: jest.fn(),
}));

const recent = new Date(Date.now() - 2 * 86400000).toISOString();
Object.assign(fakeFeeds, {
  'https://news.test/feed': [
    { title: 'Ramp raises $500M Series E at $13B valuation', url: 'https://news.test/ramp', content: 'Ramp raised $500M led by Founders Fund.', publishedAt: recent },
    { title: 'Ramp raises $500M Series E at $13B valuation', url: 'https://news.test/ramp?utm=dup', content: 'Duplicate story.', publishedAt: recent },
  ],
  'https://blog.test/feed': [
    { title: 'How we ramp up new engineers', url: 'https://blog.test/onboarding', content: 'Teams ramp up faster with docs.', publishedAt: recent },
  ],
  'https://vc.test/portfolio': [
    { title: 'Ramp', url: 'https://vc.test/portfolio/ramp', content: 'Ramp', company_website: 'https://ramp.com' },
  ],
  'https://moved.test/feed': [
    { title: 'Ramp opens London office', url: 'https://moved.test/ramp-london', content: 'Ramp expands to Europe.', publishedAt: recent },
  ],
});

describe('curated registry search', () => {
  const { searchCuratedSources, getCuratedIndexStatus } = require('../../../src/utils/sources/curatedIndex');

  test('finds the company across news and portfolio sources, ranks funding news first', async () => {
    const results = await searchCuratedSources('Ramp funding', { waitMs: 5000 });
    expect(results[0].title).toMatch(/Ramp raises \$500M/);
    expect(results.every(r => r.source === 'curated' && r.verified)).toBe(true);
    expect(results.some(r => r.type === 'portfolio_listing' && /Example Ventures/.test(r.title))).toBe(true);
  });

  test('a capitalized name does not match the ordinary word ("ramp up")', async () => {
    const results = await searchCuratedSources('Ramp', { waitMs: 5000 });
    expect(results.map(r => r.url)).not.toContain('https://blog.test/onboarding');
  });

  test('collapses the same story syndicated twice', async () => {
    const results = await searchCuratedSources('Ramp', { waitMs: 5000 });
    expect(results.filter(r => /Series E/.test(r.title))).toHaveLength(1);
  });

  test('skips dead sources and uses repaired URLs from the health file', async () => {
    const results = await searchCuratedSources('Ramp London', { waitMs: 5000 });
    expect(results.map(r => r.url)).toContain('https://moved.test/ramp-london');
    const status = getCuratedIndexStatus();
    expect(status.indexableSources).toBe(4); // DEAD excluded
    expect(status.failed).toBe(0);
  });

  test('returns nothing (rather than loose matches) for an unknown company', async () => {
    expect(await searchCuratedSources('Zyxwv Robotics', { waitMs: 5000 })).toEqual([]);
  });
});

// ---- open search: every selected source is searched --------------------
jest.mock('../../../src/utils/searchUtils', () => ({
  performSimpleSearch: jest.fn(),
  performSimpleVerifiedSearch: jest.fn(),
}));
jest.mock('../../../src/utils/llmProcessing', () => ({ processWithLLM: jest.fn() }));

describe('/api/search/open source handling', () => {
  const handler = require('../../../src/pages/api/search/open').default;
  const { performSimpleSearch, performSimpleVerifiedSearch } = require('../../../src/utils/searchUtils');
  const { createMockReq, createMockRes } = require('../api/testUtils');

  beforeEach(() => jest.clearAllMocks());

  test('Web plus other sources are searched together (Web used to hide the rest)', async () => {
    performSimpleSearch.mockResolvedValue([
      { title: 'w', url: 'https://w.test', source: 'web' },
      { title: 'c', url: 'https://c.test', source: 'curated' },
    ]);
    const req = createMockReq({ method: 'POST', body: { query: 'Ramp', sources: ['Curated', 'Web', 'Carta'], useLLM: false } });
    const res = createMockRes();

    await handler(req, res);

    expect(performSimpleSearch).toHaveBeenCalledTimes(1);
    expect(performSimpleSearch.mock.calls[0][1]).toEqual(['curated', 'web', 'carta']);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.degradedSources).toEqual(['carta']); // only the source that returned nothing
  });

  test('a failing Verified search does not discard other results', async () => {
    performSimpleVerifiedSearch.mockRejectedValue(new Error('FMP down'));
    performSimpleSearch.mockResolvedValue([{ title: 'c', url: 'https://c.test', source: 'curated' }]);
    const req = createMockReq({ method: 'POST', body: { query: 'Ramp', sources: ['Curated', 'Verified'], useLLM: false } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.results).toHaveLength(1);
    expect(res.body.degradedSources).toEqual(['verified']);
    expect(res.body.status).toBe('degraded');
  });
});

// ---- extractive digest ---------------------------------------------------
describe('no-LLM digest is extractive and correctly cited', () => {
  const { synthesizeFromResults } = require('../../../src/utils/fallbackSynthesizer');

  const results = [
    { title: 'Ramp raises $500M', url: 'https://a.test', source: 'curated', sourceName: 'Funding Wire Feed', publishedAt: '2026-10-01T00:00:00Z', content: 'Ramp raised $500M in a Series E led by Founders Fund. The round values Ramp at $13B.' },
    { title: 'Ramp opens London office', url: 'https://b.test', source: 'web', content: 'Ramp is opening an office in London to serve European customers.' },
  ];

  test('keeps the standard five sections in order', () => {
    const { content } = synthesizeFromResults('Ramp funding', results);
    const order = ['## SUMMARY', '## KEY POINTS', '## DETAILED ANALYSIS', '## DIFFERENT PERSPECTIVES', '## FOLLOW-UP QUESTIONS']
      .map((h) => content.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  test('every key point and perspective is a sentence from the cited source', () => {
    const { content } = synthesizeFromResults('Ramp funding', results);
    const section = (h) => content.split(h)[1].split('\n## ')[0];
    const lines = [...section('## KEY POINTS').split('\n'), ...section('## DIFFERENT PERSPECTIVES').split('\n')]
      .filter((l) => l.startsWith('• ') && /\[Source \d+\]/.test(l));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const n = Number(line.match(/\[Source (\d+)\]/)[1]);
      const body = line.replace(/^• (\*\*[^*]+\*\*: )?/, '');
      const sentence = body.slice(0, body.lastIndexOf(' ('));
      expect(results[n - 1].content).toContain(sentence);
    }
  });

  test('contains no template filler', () => {
    const { content } = synthesizeFromResults('Ramp funding', results);
    expect(content).not.toMatch(/these technologies can enhance productivity|conversational assistants|Educational institutions|\\n/);
  });

  test('follow-up questions name the company, not the funding words', () => {
    const { followUpQuestions } = synthesizeFromResults('Acme Robotics Series B', results);
    expect(followUpQuestions[0]).toMatch(/^Who led Acme Robotics's most recent round/);
  });
});
