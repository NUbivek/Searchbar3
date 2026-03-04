jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const handler = require('../../../src/pages/api/sourceSearch').default;
const {
  createMockReq,
  createMockRes,
} = require('./testUtils');

describe('/api/sourceSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 500 for unsupported sources', async () => {
    const req = createMockReq({
      query: {
        source: 'UnknownSource',
        query: 'founders',
        apiKey: 'token',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'UnknownSource search failed' });
  });

  it('returns linkedin results on success', async () => {
    const payload = { elements: [{ id: 'li-1' }] };
    axios.get.mockResolvedValueOnce({ data: payload });

    const req = createMockReq({
      query: {
        source: 'LinkedIn',
        query: 'seed startups',
        apiKey: 'linkedin-token',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.linkedin.com/v2/search',
      expect.objectContaining({
        headers: { Authorization: 'Bearer linkedin-token' },
      params: expect.objectContaining({ q: 'seed startups', count: 10 }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it('returns x results on success', async () => {
    const payload = { data: [{ id: 'tweet-1' }] };
    axios.get.mockResolvedValueOnce({ data: payload });

    const req = createMockReq({
      query: {
        source: 'X',
        query: 'ai founders',
        apiKey: 'twitter-token',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.twitter.com/2/tweets/search/recent',
      expect.objectContaining({
        headers: { Authorization: 'Bearer twitter-token' },
      params: expect.objectContaining({ query: 'ai founders', max_results: 10 }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it('returns fail-soft reddit error when reddit search fails', async () => {
    axios.get.mockRejectedValueOnce(new Error('reddit down'));

    const req = createMockReq({
      query: {
        source: 'Reddit',
        query: 'seed',
        apiKey: 'reddit-token',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Reddit search failed' });
  });
});
