jest.mock('../../../src/utils/searchUtils', () => ({
  performSimpleSearch: jest.fn(),
  performSimpleVerifiedSearch: jest.fn(),
}));

jest.mock('../../../src/utils/deepWebSearch', () => ({
  deepWebSearch: jest.fn(),
}));

jest.mock('../../../src/utils/llmProcessing', () => ({
  processWithLLM: jest.fn(),
}));

jest.mock('../../../src/components/search/categories/processors/CategoryProcessor', () => ({
  processCategories: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { createMockReq, createMockRes } = require('./testUtils');
const { performSimpleSearch, performSimpleVerifiedSearch } = require('../../../src/utils/searchUtils');
const { deepWebSearch } = require('../../../src/utils/deepWebSearch');
const { processWithLLM } = require('../../../src/utils/llmProcessing');
const { processCategories } = require('../../../src/components/search/categories/processors/CategoryProcessor');
const handler = require('../../../src/pages/api/search/open').default;

describe('/api/search/open route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    processCategories.mockResolvedValue([]);
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

  it('returns fail-soft when web search produces no results', async () => {
    deepWebSearch.mockResolvedValue([]);

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'ai startups',
        sources: ['web'],
        useLLM: false,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['web']);
    expect(res.body.results).toEqual([]);
    expect(res.body.content).toBeNull();
    expect(res.body.categories).toEqual([]);
  });

  it('returns ok with llm content and categories when search succeeds', async () => {
    const results = [{ title: 'Result 1', url: 'https://example.com/1' }];
    const llmResponse = { content: 'LLM summary' };
    const categories = [{ name: 'Startups', items: results }];

    deepWebSearch.mockResolvedValue(results);
    processWithLLM.mockResolvedValue(llmResponse);
    processCategories.mockResolvedValue(categories);

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'ai startups',
        sources: ['web'],
        model: 'meta-llama',
        useLLM: true,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.degradedSources).toEqual([]);
    expect(res.body.results).toEqual(results);
    expect(res.body.content).toBe('LLM summary');
    expect(res.body.categories).toEqual(categories);
    expect(processWithLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'ai startups',
        sources: results,
        model: 'meta-llama',
      })
    );
  });

  it('returns fail-soft when the outer handler throws', async () => {
    deepWebSearch.mockRejectedValue(new Error('upstream failed'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'ai startups',
        sources: ['web'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.results).toEqual([]);
    expect(res.body.degradedSources).toEqual(['open-search']);
    expect(res.body.content).toBeNull();
    expect(res.body.categories).toEqual([]);
    expect(res.body.error).toBe('An error occurred during search');
  });

  it('uses the verified search helper when verified is requested', async () => {
    const verifiedResults = [{ title: 'Verified result', url: 'https://example.com/v' }];
    performSimpleVerifiedSearch.mockResolvedValue(verifiedResults);

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'founders',
        sources: ['verified'],
        useLLM: false,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(performSimpleVerifiedSearch).toHaveBeenCalled();
    expect(performSimpleSearch).not.toHaveBeenCalled();
    expect(deepWebSearch).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.results).toEqual(verifiedResults);
  });
});
