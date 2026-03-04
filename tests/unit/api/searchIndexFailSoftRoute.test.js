jest.mock('../../../src/utils/search-legacy', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../../src/utils/llmProcessing', () => ({
  processWithLLM: jest.fn(),
}));

jest.mock('../../../src/utils/fallbackSynthesizer', () => ({
  synthesizeFromResults: jest.fn(),
}));

jest.mock('../../../src/utils/isLLMResult', () => ({
  isLLMResult: jest.fn(() => false),
}));

jest.mock('../../../src/utils/deepWebSearch', () => ({
  deepWebSearch: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../src/components/search/categories/CategoryFinder', () => ({
  CategoryFinder: jest.fn().mockImplementation(() => ({
    find: jest.fn(() => []),
  })),
}));

jest.mock('../../../src/components/search/categories/processors/CategoryFinder', () => ({
  findBestCategories: jest.fn(() => []),
}));

jest.mock('../../../src/components/search/metrics/MetricsCalculator', () => ({
  MetricsCalculator: jest.fn().mockImplementation(() => ({
    calculate: jest.fn(() => ({})),
  })),
}));

jest.mock('../../../src/components/search/categories/processors/CategoryProcessor', () => ({
  processCategories: jest.fn((results) => results),
}));

jest.mock('../../../src/utils/scoring/SearchResultScorer', () => ({
  searchResultScorer: {
    score: jest.fn((results) => results),
  },
}));

jest.mock('../../../src/components/search/utils/contextDetector', () => ({
  detectQueryContext: jest.fn(() => ({ type: 'general' })),
}));

const unifiedSearch = require('../../../src/utils/search-legacy').default;
const handler = require('../../../src/pages/api/search/index').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/search index route', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ results: [] }),
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('returns a fail-soft response when no sources return results', async () => {
    unifiedSearch.mockResolvedValue({
      results: [],
      degradedSources: [{ source: 'web', status: 'degraded', error: 'timeout' }],
      apiStatus: { web: 'degraded' },
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'seed investors' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.results).toEqual([]);
    expect(res.body.degradedSources).toEqual(
      expect.arrayContaining(['web'])
    );
    expect(res.body.synthesis).toEqual(
      expect.objectContaining({ enabled: false })
    );
    expect(res.body.failSoftContent).toBeTruthy();
  });
});
