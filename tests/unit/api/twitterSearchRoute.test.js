jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const axios = require('axios');
const { logger } = require('../../../src/utils/logger');
const handler = require('../../../src/pages/api/search/twitter').default;
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

  it('returns 405 for unsupported methods', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ message: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Query is required' });
  });

  it('returns Twitter API results when a bearer token is configured', async () => {
    process.env.TWITTER_API_KEY = 'twitter-key';

    axios.get.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: '12345',
            text: 'Shipping our new workflow engine',
            created_at: '2026-03-03T12:00:00.000Z',
            author_id: 'founder-1',
            public_metrics: {
              like_count: 9,
              retweet_count: 3,
            },
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'workflow engine' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.twitter.com/2/tweets/search/recent',
      expect.objectContaining({
        params: expect.objectContaining({
          query: 'workflow engine',
          max_results: 10,
        }),
        headers: expect.objectContaining({
          Authorization: 'Bearer twitter-key',
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toEqual([
      expect.objectContaining({
        type: 'TwitterResult',
        content: 'Shipping our new workflow engine',
        url: 'https://twitter.com/i/web/status/12345',
        title: 'Tweet by founder-1',
        sourceId: 'twitter-0',
        metadata: {
          likes: 9,
          retweets: 3,
        },
      }),
    ]);
  });

  it('falls back to Serper when the Twitter API request fails', async () => {
    process.env.TWITTER_API_KEY = 'twitter-key';
    process.env.SERPER_API_KEY = 'serper-key';

    axios.get.mockRejectedValueOnce(new Error('twitter down'));
    axios.post.mockResolvedValueOnce({
      data: {
        organic: [
          {
            title: 'Tweet fallback result',
            link: 'https://twitter.com/user/status/55',
            snippet: 'Fallback tweet snippet',
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'operators' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(logger.error).toHaveBeenCalledWith(
      'Twitter API failed:',
      expect.any(Error)
    );
    expect(axios.post).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      {
        q: 'site:twitter.com operators',
        num: 10,
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-KEY': 'serper-key',
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toEqual([
      expect.objectContaining({
        type: 'TwitterResult',
        title: 'Tweet fallback result',
        content: 'Fallback tweet snippet',
        url: 'https://twitter.com/user/status/55',
      }),
    ]);
  });

  it('returns a fail-soft payload when both providers fail', async () => {
    process.env.TWITTER_API_KEY = 'twitter-key';
    process.env.SERPER_API_KEY = 'serper-key';

    axios.get.mockRejectedValueOnce(new Error('twitter down'));
    axios.post.mockRejectedValueOnce(new Error('serper down'));

    const req = createMockReq({
      method: 'POST',
      body: { query: 'founders' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(logger.error).toHaveBeenCalledWith(
      'Twitter search failed:',
      expect.any(Error)
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['twitter'],
      message: 'Search failed',
      error: 'serper down',
    });
  });
});
