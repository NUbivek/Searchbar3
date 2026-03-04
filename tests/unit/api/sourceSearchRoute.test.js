jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/sourceSearch').default;

describe('/api/sourceSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 405 for non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns contract-compliant success for supported LinkedIn source', async () => {
    axios.get.mockResolvedValueOnce({ data: { items: [{ id: '1' }] } });

    const req = createMockReq({
      method: 'GET',
      query: {
        source: 'LinkedIn',
        query: 'founder',
        apiKey: 'token-123',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith('https://api.linkedin.com/v2/search', {
      headers: { Authorization: 'Bearer token-123' },
      params: { q: 'founder', count: 10 },
      timeout: 10000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.results).toEqual([{ id: '1' }]);
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  test('returns fail-soft response for unsupported source', async () => {
    const req = createMockReq({
      method: 'GET',
      query: {
        source: 'Unknown',
        query: 'founder',
        apiKey: 'token-123',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['unknown']);
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns fail-soft response when upstream request fails', async () => {
    axios.get.mockRejectedValueOnce(new Error('upstream failed'));

    const req = createMockReq({
      method: 'GET',
      query: {
        source: 'X',
        query: 'founder',
        apiKey: 'token-123',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith('https://api.twitter.com/2/tweets/search/recent', {
      headers: { Authorization: 'Bearer token-123' },
      params: { query: 'founder', max_results: 10 },
      timeout: 10000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['x']);
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
