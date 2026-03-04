const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('../../../src/components/search/categories/types/DefaultCategories', () => ({
  getDefaultCategories: jest.fn(),
}));

jest.mock('../../../src/components/search/metrics/utils/contextDetector', () => ({
  detectQueryContext: jest.fn(),
}));

jest.mock('../../../src/components/search/metrics/MetricsCalculator', () => ({
  __esModule: true,
  default: {
    calculateMetrics: jest.fn(),
  },
}));

jest.mock('../../../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const { getDefaultCategories } = require('../../../src/components/search/categories/types/DefaultCategories');
const { detectQueryContext } = require('../../../src/components/search/metrics/utils/contextDetector');
const MetricsCalculator = require('../../../src/components/search/metrics/MetricsCalculator').default;
const handler = require('../../../src/pages/api/process-content').default;

describe('/api/process-content', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    detectQueryContext.mockReturnValue(['business']);
    getDefaultCategories.mockReturnValue([
      {
        id: 'all-results',
        name: 'All Results',
        priority: 0,
        keywords: [],
      },
      {
        id: 'business',
        name: 'Business',
        priority: 10,
        keywords: ['startup', 'market'],
      },
    ]);
    MetricsCalculator.calculateMetrics.mockReturnValue({
      relevance: 88,
      accuracy: 76,
      credibility: 80,
      overall: 84,
      recency: 64,
      business: 91,
    });
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query or results are invalid', async () => {
    const req = createMockReq({ method: 'POST', body: { query: '', results: null } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid request. Query and results array are required.',
    });
  });

  it('returns categorized processed content for valid results', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'startup market map',
        results: [
          {
            title: 'Startup market map',
            description: 'A startup market overview.',
            url: 'https://example.com/startup-market',
          },
        ],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(MetricsCalculator.calculateMetrics).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.processedContent)).toBe(true);
    expect(res.body.processedContent).toHaveLength(2);
    expect(res.body.processedContent[0].id).toBe('business');
    expect(res.body.processedContent[0].content).toHaveLength(1);
    expect(res.body.processedContent[0].content[0]._enhancedByLLM).toBe(true);
    expect(res.body.processedContent[0].content[0]._overallScore).toBe(84);
    expect(res.body.processedContent[1].name).toBe('All Results');
  });

  it('returns fail-soft response when an unexpected route error occurs', async () => {
    const req = { method: 'POST' };
    Object.defineProperty(req, 'body', {
      get() {
        throw new Error('body access failed');
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      success: false,
      processedContent: [],
      degradedSources: ['process-content'],
      error: 'Failed to process content',
      message: 'body access failed',
    });
  });
});
