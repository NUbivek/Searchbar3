jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../src/utils/searchUtils', () => ({
  performSimpleSearch: jest.fn(),
  performSimpleVerifiedSearch: jest.fn(),
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
const { performSimpleSearch, performSimpleVerifiedSearch } = require('../../../src/utils/searchUtils');
const { processWithLLM } = require('../../../src/utils/llmProcessing');
const { processCategories } = require('../../../src/components/search/categories/processors/CategoryProcessor');
const { deepWebSearch } = require('../../../src/utils/deepWebSearch');
const handler = require('../../../src/pages/api/search/open').default;

describe('/api/search/open', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    processCategories.mockResolvedValue([]);
    processWithLLM.mockResolvedValue({ content: 'summary' });
    performSimpleSearch.mockResolvedValue([]);
    performSimpleVerifiedSearch.mockResolvedValue([]);
    deepWebSearch.mockResolvedValue([]);
  });

  test('rejects non-POST methods', async () => {
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

  test('returns degraded web response when web search is empty', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme',
        sources: ['web'],
        model: 'test-model',
        useLLM: true,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(deepWebSearch).toHaveBeenCalledWith('acme', { maxResults: 10 });
    expect(processWithLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'acme',
        sources: [],
        model: 'test-model',
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['web']);
    expect(res.body.content).toBe('summary');
  });

  test('merges verified and regular search results', async () => {
    performSimpleVerifiedSearch.mockResolvedValue([{ id: 'verified-result' }]);
    performSimpleSearch.mockResolvedValue([{ id: 'source-result' }]);
    processCategories.mockResolvedValue([{ id: 'cat-1' }]);

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme',
        sources: ['verified', 'linkedin'],
        useLLM: false,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(performSimpleVerifiedSearch).toHaveBeenCalledWith(
      'acme',
      ['fmp', 'sec', 'edgar'],
      expect.objectContaining({
        customUrls: [],
        uploadedFiles: [],
      })
    );
    expect(performSimpleSearch).toHaveBeenCalledWith(
      'acme',
      ['linkedin'],
      expect.objectContaining({
        customUrls: [],
        uploadedFiles: [],
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([{ id: 'verified-result' }, { id: 'source-result' }]);
    expect(res.body.status).toBe('ok');
    expect(res.body.categories).toEqual([{ id: 'cat-1' }]);
    expect(processWithLLM).not.toHaveBeenCalled();
  });

  test('returns fail-soft payload on unexpected errors', async () => {
    performSimpleSearch.mockRejectedValue(new Error('search exploded'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme',
        sources: ['linkedin'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['open-search']);
    expect(res.body.message).toBe('search exploded');
    expect(res.body.results).toEqual([]);
  });
});
