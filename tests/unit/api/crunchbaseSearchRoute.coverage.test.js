jest.mock('../../../src/utils/combinedSearch', () => ({
  performCombinedSearch: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const { performCombinedSearch } = require('../../../src/utils/combinedSearch');
const { logger } = require('../../../src/utils/logger');
const handler = require('../../../src/pages/api/search/crunchbase').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/search/crunchbase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for unsupported methods', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ message: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Query is required' });
  });

  it('returns sources when the combined search succeeds', async () => {
    const sources = [{ title: 'Crunchbase result' }];
    performCombinedSearch.mockResolvedValueOnce(sources);

    const req = createMockReq({
      method: 'POST',
      body: { query: 'fintech startups' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(performCombinedSearch).toHaveBeenCalledWith(
      'fintech startups',
      'crunchbase'
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sources });
  });

  it('returns a fail-soft response when the search throws', async () => {
    performCombinedSearch.mockRejectedValueOnce(new Error('upstream failed'));

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai startups' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(logger.error).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['crunchbase'],
      message: 'Search failed',
      error: 'upstream failed',
    });
  });
});
