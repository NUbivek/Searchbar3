jest.mock('axios', () => ({}));

jest.mock('../../../src/utils/searchUtils', () => ({
  performSimpleSearch: jest.fn(),
  performSimpleVerifiedSearch: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../src/utils/llmProcessing', () => ({
  processWithLLM: jest.fn(),
}));

jest.mock('../../../src/components/search/categories/processors/CategoryProcessor', () => ({
  processCategories: jest.fn(),
}));

jest.mock('../../../src/utils/deepWebSearch', () => ({
  deepWebSearch: jest.fn(),
}));

const { createMockReq, createMockRes } = require('./testUtils');
const { processWithLLM } = require('../../../src/utils/llmProcessing');
const { processCategories } = require('../../../src/components/search/categories/processors/CategoryProcessor');
const { deepWebSearch } = require('../../../src/utils/deepWebSearch');
const handler = require('../../../src/pages/api/search/open').default;

describe('/api/search/open', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    processWithLLM.mockResolvedValue({ content: 'summary', provider: 'test' });
    processCategories.mockResolvedValue([{ id: 'cat-1', label: 'Signals' }]);
    deepWebSearch.mockResolvedValue([
      {
        title: 'Acme',
        url: 'https://example.com/acme',
        snippet: 'Acme raised a seed round.',
      },
    ]);
  });

  test('rejects non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('requires a query', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        sources: ['web'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  test('returns normalized search results with llm content and categories', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme logistics',
        sources: ['web'],
        model: 'test-model',
        useLLM: true,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(deepWebSearch).toHaveBeenCalledWith('acme logistics', { maxResults: 10 });
    expect(processWithLLM).toHaveBeenCalled();
    expect(processCategories).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.results).toHaveLength(1);
    expect(res.body.content).toBe('summary');
    expect(res.body.categories).toEqual([{ id: 'cat-1', label: 'Signals' }]);
    expect(res.body.degradedSources).toEqual([]);
  });
});
