jest.mock('../../../src/utils/combinedSearch', () => ({
  performCombinedSearch: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const handler = require('../../../src/pages/api/search/pitchbook').default;
const { performCombinedSearch } = require('../../../src/utils/combinedSearch');
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/search/pitchbook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for non-POST requests', async () => {
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
    const sources = [{ title: 'Pitchbook result', url: 'https://example.com' }];
    performCombinedSearch.mockResolvedValue(sources);

    const req = createMockReq({
      method: 'POST',
      body: { query: 'fintech seed' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(performCombinedSearch).toHaveBeenCalledWith('fintech seed', 'pitchbook');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ sources, results: sources, status: 'ok' }));
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  it('returns a fail-soft response when the search throws', async () => {
    performCombinedSearch.mockRejectedValue(new Error('Pitchbook unavailable'));

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai infrastructure' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['pitchbook'],
      message: 'Search failed',
      error: 'Pitchbook unavailable',
    }));
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
