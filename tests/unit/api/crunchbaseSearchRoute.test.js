import handler from '../../../src/pages/api/search/crunchbase';
import { createMockReq, createMockRes } from './testUtils';
import { validateSearchResponseV1 } from '../../../src/utils/contracts/searchResponse';

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn()
  }
}));

jest.mock('../../../src/utils/combinedSearch', () => ({
  performCombinedSearch: jest.fn()
}));

const { performCombinedSearch } = require('../../../src/utils/combinedSearch');

describe('/api/search/crunchbase', () => {
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
    const sources = [{ title: 'Crunchbase result' }];
    performCombinedSearch.mockResolvedValue(sources);

    const req = createMockReq({ method: 'POST', body: { query: 'fintech startups' } });
    const res = createMockRes();

    await handler(req, res);

    expect(performCombinedSearch).toHaveBeenCalledWith('fintech startups', 'crunchbase');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ sources, results: sources, status: 'ok' }));
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  it('returns a fail-soft payload when search throws', async () => {
    performCombinedSearch.mockRejectedValue(new Error('upstream failed'));

    const req = createMockReq({ method: 'POST', body: { query: 'ai startups' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['crunchbase'],
      message: 'Search failed',
      error: 'upstream failed'
    }));
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
