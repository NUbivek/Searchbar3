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

const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/search/open').default;
const { performSimpleSearch, performSimpleVerifiedSearch } = require('../../../src/utils/searchUtils');
const { deepWebSearch } = require('../../../src/utils/deepWebSearch');
const { processWithLLM } = require('../../../src/utils/llmProcessing');
const { processCategories } = require('../../../src/components/search/categories/processors/CategoryProcessor');

describe('/api/search/open', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    processWithLLM.mockResolvedValue({ content: 'summary' });
    processCategories.mockResolvedValue([{ id: 'cat-1' }]);
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

  it('returns fail-soft when web search yields no results', async () => {
    deepWebSearch.mockResolvedValue([]);
    processCategories.mockResolvedValue([]);

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai startups', sources: ['web'], useLLM: false },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(deepWebSearch).toHaveBeenCalledWith('ai startups', { maxResults: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['web']);
    expect(res.body.results).toEqual([]);
    expect(res.body.content).toBeNull();
    expect(res.body.categories).toEqual([]);
  });

  it('merges verified and secondary source results', async () => {
    performSimpleVerifiedSearch.mockResolvedValue([{ id: 'verified-1', score: 2 }]);
    performSimpleSearch.mockResolvedValue([{ id: 'twitter-1', score: 1 }]);
    processCategories.mockResolvedValue([{ id: 'cat-verified' }]);

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'seed fintech',
        sources: ['verified', 'twitter'],
        useLLM: false,
        model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(performSimpleVerifiedSearch).toHaveBeenCalled();
    expect(performSimpleSearch).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.results).toEqual([
      { id: 'verified-1', score: 2 },
      { id: 'twitter-1', score: 1 },
    ]);
    expect(res.body.categories).toEqual([{ id: 'cat-verified' }]);
  });

  it('returns outer fail-soft payload on unexpected errors', async () => {
    performSimpleSearch.mockRejectedValue(new Error('boom'));

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ops tools', sources: ['twitter'], useLLM: false },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['open-search']);
    expect(res.body.results).toEqual([]);
    expect(res.body.content).toBeNull();
    expect(res.body.categories).toEqual([]);
    expect(res.body.error).toBe('An error occurred during search');
  });
});
