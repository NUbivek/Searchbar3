const axios = require('axios');

jest.mock('axios');
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const routeModule = require('../../../src/pages/api/search/twitter');
const handler = routeModule.default || routeModule;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/search/twitter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
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

  it('returns Twitter API results when the primary provider succeeds', async () => {
    process.env.TWITTER_API_KEY = 'twitter-key';
    axios.get.mockResolvedValue({
      data: {
        data: [
          {
            id: '1',
            text: 'Tweet body',
            author_id: 'author-1',
            created_at: '2026-03-04T00:00:00.000Z',
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai startups' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({
      type: 'TwitterResult',
      title: 'Tweet by author-1',
      url: 'https://twitter.com/i/web/status/1',
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('falls back to Serper when the Twitter API fails', async () => {
    process.env.TWITTER_API_KEY = 'twitter-key';
    process.env.SERPER_API_KEY = 'serper-key';
    axios.get.mockRejectedValue(new Error('twitter failed'));
    axios.post.mockResolvedValue({
      data: {
        organic: [
          {
            title: 'Fallback result',
            link: 'https://example.com/result',
            snippet: 'Fallback snippet',
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai startups' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({
      type: 'TwitterResult',
      title: 'Fallback result',
      url: 'https://example.com/result',
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('returns a fail-soft payload when no provider can run', async () => {
    delete process.env.TWITTER_API_KEY;
    delete process.env.SERPER_API_KEY;

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai startups' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['twitter'],
      message: 'Search failed',
      error: 'Twitter API key not configured',
    });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
});
