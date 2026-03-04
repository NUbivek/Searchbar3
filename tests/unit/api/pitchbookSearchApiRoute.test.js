const { createMockReq, createMockRes } = require('./testUtils');

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
const handler = require('../../../src/pages/api/search/pitchbook').default;

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

  it('returns sources on success', async () => {
    const sources = [{ title: 'PitchBook result' }];
    performCombinedSearch.mockResolvedValueOnce(sources);

    const req = createMockReq({ method: 'POST', body: { query: 'fintech' } });
    const res = createMockRes();

    await handler(req, res);

    expect(performCombinedSearch).toHaveBeenCalledWith('fintech', 'pitchbook');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sources });
  });

  it('returns a fail-soft response when the search throws', async () => {
    performCombinedSearch.mockRejectedValueOnce(new Error('PitchBook upstream failed'));

    const req = createMockReq({ method: 'POST', body: { query: 'ai startups' } });
    const res = createMockRes();

    await handler(req, res);

    expect(logger.error).toHaveBeenCalledWith(
      'Pitchbook search failed:',
      expect.any(Error)
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['pitchbook'],
      message: 'Search failed',
      error: 'PitchBook upstream failed',
    });
  });
});
