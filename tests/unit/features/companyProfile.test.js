/**
 * Company profile builder: extraction is quote-based and cited, filters out
 * results that do not concern the company, and degrades to an empty profile
 * when every provider fails.
 */
jest.mock('../../../src/utils/sources/curatedIndex', () => ({ searchCuratedSources: jest.fn() }));
jest.mock('../../../src/utils/sources/hackernewsAlgolia', () => ({ searchHackerNews: jest.fn() }));
jest.mock('../../../src/utils/sourceIntegration', () => ({ performSearch: jest.fn(), sourceHandlers: { fmp: jest.fn() } }));
jest.mock('../../../src/utils/edgarUtils', () => ({ getFilings: jest.fn(), searchCompany: jest.fn() }));
jest.mock('../../../src/utils/dataSources', () => ({ DATA_PROVIDERS: { government_data: { edgar: { headers: { 'User-Agent': 'test' } } } } }));
jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const { searchCuratedSources } = require('../../../src/utils/sources/curatedIndex');
const { searchHackerNews } = require('../../../src/utils/sources/hackernewsAlgolia');
const { performSearch, sourceHandlers } = require('../../../src/utils/sourceIntegration');
const { getFilings } = require('../../../src/utils/edgarUtils');
const { buildCompanyProfile, parseFundingSentence, companyAliases, mentionsCompany } = require('../../../src/server/companyProfile');

const article = (title, content, extra = {}) => ({
  title, content, snippet: content, url: `https://news.test/${encodeURIComponent(title)}`,
  source: 'curated', sourceName: 'Funding Wire Feed', publishedAt: '2026-03-01T00:00:00.000Z', type: 'curated_article', ...extra,
});

function allItems(p) {
  return [
    ...p.fundingRounds, ...p.investors, ...p.keyPeople, ...p.competitors, ...p.headcount, ...p.otherFacts,
    ...p.fundingRounds.flatMap((r) => r.otherSources || []),
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  searchCuratedSources.mockResolvedValue([]);
  searchHackerNews.mockResolvedValue([]);
  performSearch.mockResolvedValue([]);
  sourceHandlers.fmp.mockResolvedValue([]);
  axios.get.mockResolvedValue({ data: {} });
  getFilings.mockResolvedValue(null);
});

describe('parseFundingSentence', () => {
  const acme = companyAliases('Acme Robotics');

  test('parses amount, round and lead investors', () => {
    const f = parseFundingSentence('Acme Robotics raised $45 million in a Series B round led by Sequoia Capital and Index Ventures, with participation from Y Combinator.', acme);
    expect(f.amount).toBe('$45 million');
    expect(f.currency).toBe('USD');
    expect(f.round).toBe('Series B');
    expect(f.leadInvestors).toEqual(['Sequoia Capital', 'Index Ventures']);
    expect(f.participants).toEqual(['Y Combinator']);
  });

  test('takes the raised amount, not the valuation', () => {
    const f = parseFundingSentence('Acme today announced that it has raised €3 billion in a Series D funding round at a post-money valuation of more than €21 billion.', acme);
    expect(f.amount).toBe('€3 billion');
    expect(f.currency).toBe('EUR');
    expect(f.round).toBe('Series D');
  });

  test('headline form "X raises $NM" and seed rounds', () => {
    expect(parseFundingSentence('Acme Robotics raises $12M seed round', acme)).toMatchObject({ amount: '$12M', round: 'Seed' });
    expect(parseFundingSentence('Acme Robotics raises 1.7B€', acme)).toMatchObject({ amount: '1.7B€', currency: 'EUR' });
  });

  test('does not attribute a competitor\'s raise to the company', () => {
    expect(parseFundingSentence('Rivals like Acme Robotics watched as Beta Corp raised $80M led by Accel.', acme)).toBeNull();
    expect(parseFundingSentence('Acme Robotics launched a new arm; separately, in an unrelated story covering many other companies across the sector this week, Beta Corp raised $80M.', acme)).toBeNull();
    expect(parseFundingSentence('Acme Robotics hired a new CFO.', acme)).toBeNull();
  });
});

describe('name filtering', () => {
  test('case-sensitive whole-name match; short alias only on the company\'s own site', () => {
    const aliases = companyAliases('Ramp');
    expect(mentionsCompany(article('Ramp raises $500M', 'Ramp raised $500M.'), aliases)).toBe(true);
    expect(mentionsCompany(article('How teams ramp up', 'Engineers ramp up faster.'), aliases)).toBe(false);
    expect(mentionsCompany(article('Rampart Security launches', 'Rampart is new.'), aliases)).toBe(false);
    expect(mentionsCompany(article('Tesla Announces $2B Public Offering to Accelerate Model 3 Ramp Up', 'Tesla news.'), aliases)).toBe(false);
    expect(mentionsCompany(article('Ramp Up Your Sales', 'Tips.'), aliases)).toBe(false);
    expect(mentionsCompany(article('Ramp Financial hits $1B', 'Ramp, the spend platform, said.'), aliases)).toBe(true);

    const mistral = companyAliases('Mistral AI');
    expect(mistral.short).toBe('Mistral');
    expect(mentionsCompany(article('Mistral raises €3B', 'Mistral raised.', { url: 'https://mistral.ai/news/x' }), mistral)).toBe(true);
    expect(mentionsCompany(article('The Mistral wind blows', 'Mistral weather.'), mistral)).toBe(false);
  });

  test('profile excludes unrelated results and their facts', async () => {
    searchCuratedSources.mockResolvedValue([
      article('Ramp raises $500M Series E led by Founders Fund', 'Ramp raised $500M in a Series E led by Founders Fund.'),
      article('How teams ramp up hiring', 'Startups ramp up to 200 employees after raising $50M led by Accel.'),
    ]);
    const p = await buildCompanyProfile('Ramp', { useCache: false });
    expect(p.sources).toHaveLength(1);
    expect(p.fundingRounds).toHaveLength(1);
    expect(p.fundingRounds[0]).toMatchObject({ round: 'Series E', amount: '$500M', leadInvestors: ['Founders Fund'], date: '2026-03-01' });
    expect(p.headcount).toHaveLength(0);
    expect(p.investors.map((i) => i.name)).toEqual(['Founders Fund']);
    expect(JSON.stringify(p)).not.toMatch(/Accel/);
  });
});

describe('buildCompanyProfile', () => {
  test('every extracted item points at a real source and quotes it verbatim', async () => {
    searchCuratedSources.mockResolvedValue([
      article('Acme Robotics raises $45M Series B led by Sequoia Capital', 'Acme Robotics raised $45 million in a Series B round led by Sequoia Capital. Acme Robotics now has 120 employees. Acme Robotics competes with Boston Dynamics in warehouses. Acme Robotics grew revenue 3x to $20M ARR.'),
      article('Acme Robotics (portfolio: Example Ventures)', 'Acme Robotics', { type: 'portfolio_listing', sourceName: 'Example Ventures Portfolio', url: 'https://vc.test/acme', content: 'Acme Robotics is listed on Example Ventures Portfolio.' }),
    ]);
    searchHackerNews.mockResolvedValue([
      { title: 'Interview with Jane Smith, CEO of Acme Robotics', url: 'https://news.ycombinator.com/item?id=1', content: '', snippet: '', source: 'hackernews', timestamp: '2026-02-01T00:00:00.000Z' },
      { title: 'Unrelated robotics story', url: 'https://news.ycombinator.com/item?id=2', content: '', source: 'hackernews' },
    ]);

    const p = await buildCompanyProfile('Acme Robotics', { useCache: false });
    const items = allItems(p);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const src = p.sources.find((s) => s.n === item.sourceIndex);
      expect(src).toBeDefined();
      expect(src.url).toMatch(/^https?:\/\//);
    }
    const sourceText = JSON.stringify([...await searchCuratedSources.mock.results[0].value, ...await searchHackerNews.mock.results[0].value]);
    for (const item of items.filter((i) => i.quote)) expect(sourceText).toContain(item.quote);

    expect(p.fundingRounds).toHaveLength(1);
    expect(p.fundingRounds[0]).toMatchObject({ round: 'Series B', leadInvestors: ['Sequoia Capital'] });
    expect(p.investors).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Example Ventures', evidence: 'portfolio listing' }),
      expect.objectContaining({ name: 'Sequoia Capital', evidence: 'led round' }),
    ]));
    expect(p.keyPeople[0]).toMatchObject({ name: 'Jane Smith', role: 'CEO' });
    expect(p.headcount[0].quote).toMatch(/120 employees/);
    expect(p.competitors[0].quote).toMatch(/Boston Dynamics/);
    expect(p.otherFacts[0].quote).toMatch(/\$20M ARR/);
    expect(p.publicData).toBeNull();
    expect(p.coverage).toEqual({ curated: 2, web: 0, hn: 1, total: 3 });
  });

  test('public data only when SEC returns an exact name match', async () => {
    axios.get.mockResolvedValue({ data: { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } } });
    getFilings.mockResolvedValue({
      name: 'Apple Inc.', tickers: ['AAPL'], exchanges: ['Nasdaq'], sicDescription: 'Electronic Computers',
      filings: { recent: { form: ['10-K', '4'], filingDate: ['2025-10-31', '2025-11-01'], reportDate: ['2025-09-27', ''], accessionNumber: ['0000320193-25-000079', 'x'], primaryDocument: ['aapl-20250927.htm', 'y'] } },
    });
    const p = await buildCompanyProfile('Apple', { useCache: false });
    expect(p.publicData.sec).toMatchObject({ name: 'Apple Inc.', cik: '320193', tickers: ['AAPL'] });
    expect(p.publicData.sec.filings).toHaveLength(1);
    expect(p.sources.find((s) => s.n === p.publicData.sec.sourceIndex).sourceName).toBe('SEC EDGAR');

    const q = await buildCompanyProfile('Applecart', { useCache: false });
    expect(q.publicData).toBeNull();
  });

  test('graceful empty output when every provider fails', async () => {
    searchCuratedSources.mockRejectedValue(new Error('index down'));
    searchHackerNews.mockRejectedValue(new Error('HN 500'));
    performSearch.mockRejectedValue(new Error('no keys'));
    sourceHandlers.fmp.mockRejectedValue(new Error('no key'));
    axios.get.mockRejectedValue(new Error('SEC 403'));

    const p = await buildCompanyProfile('Nonexistent Startup', { useCache: false });
    expect(p).toMatchObject({
      name: 'Nonexistent Startup', sources: [], fundingRounds: [], investors: [], keyPeople: [],
      competitors: [], headcount: [], otherFacts: [], publicData: null,
      coverage: { curated: 0, web: 0, hn: 0, total: 0 },
    });
    expect(typeof p.generatedAt).toBe('string');
  });
});
