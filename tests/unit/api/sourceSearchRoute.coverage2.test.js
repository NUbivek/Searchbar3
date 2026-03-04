const axios = require('axios');
const handler = require('../../../../Searchbar3/src/pages/api/sourceSearch').default;
const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('axios');

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
      query: { source: 'Unknown', query: 'seed', apiKey: 'token' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Unknown search failed' });
  });

  it('returns LinkedIn results on success', async () => {
    axios.get.mockResolvedValueOnce({ data: { items: ['linkedin'] } });

    const req = createMockReq({
      query: { source: 'LinkedIn', query: 'ai founders', apiKey: 'li-token' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith('https://api.linkedin.com/v2/search', {
      headers: { Authorization: 'Bearer li-token' },
      params: { q: 'ai founders', count: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ items: ['linkedin'] });
  });

  it('returns X results on success', async () => {
    axios.get.mockResolvedValueOnce({ data: { items: ['x'] } });

    const req = createMockReq({
      query: { source: 'X', query: 'operators', apiKey: 'x-token' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith('https://api.twitter.com/2/tweets/search/recent', {
      headers: { Authorization: 'Bearer x-token' },
      params: { query: 'operators', max_results: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ items: ['x'] });
  });

  it('returns Reddit results on success', async () => {
    axios.get.mockResolvedValueOnce({ data: { items: ['reddit'] } });

    const req = createMockReq({
      query: { source: 'Reddit', query: 'founder', apiKey: 'reddit-token' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith('https://oauth.reddit.com/search', {
      headers: { Authorization: 'Bearer reddit-token' },
      params: { q: 'founder', limit: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ items: ['reddit'] });
  });

  it('returns 500 when an upstream request fails', async () => {
    axios.get.mockRejectedValueOnce(new Error('network down'));

    const req = createMockReq({
      query: { source: 'LinkedIn', query: 'seed', apiKey: 'li-token' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'LinkedIn search failed' });
  });
});
