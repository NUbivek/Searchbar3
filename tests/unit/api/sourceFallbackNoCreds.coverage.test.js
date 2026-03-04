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
const linkedinHandler = require('../../../src/pages/api/search/linkedin').default;
const twitterHandler = require('../../../src/pages/api/search/twitter').default;
const redditHandler = require('../../../src/pages/api/search/reddit').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('search source fallback without native credentials', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SERPER_API_KEY = 'serper-key';
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
    delete process.env.TWITTER_API_KEY;
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('linkedin route uses serper fallback when linkedin creds are missing', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        organic: [
          { title: 'LinkedIn fallback', link: 'https://linkedin.com/post/1', snippet: 'snippet' },
        ],
      },
    });

    const req = createMockReq({ method: 'POST', body: { query: 'operators' } });
    const res = createMockRes();

    await linkedinHandler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      { q: 'site:linkedin.com operators', num: 10 },
      expect.any(Object)
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
  });

  test('twitter route uses serper fallback when twitter api key is missing', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        organic: [
          { title: 'Tweet fallback', link: 'https://twitter.com/i/web/status/42', snippet: 'tweet snippet' },
        ],
      },
    });

    const req = createMockReq({ method: 'POST', body: { query: 'founder' } });
    const res = createMockRes();

    await twitterHandler(req, res);

    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      { q: 'site:twitter.com founder', num: 10 },
      expect.any(Object)
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
  });

  test('reddit route uses serper fallback when reddit credentials are missing', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        organic: [
          { title: 'Reddit fallback', link: 'https://reddit.com/r/startups/1', snippet: 'reddit snippet' },
        ],
      },
    });

    const req = createMockReq({ method: 'POST', body: { query: 'ai' } });
    const res = createMockRes();

    await redditHandler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      { q: 'site:reddit.com ai', num: 10 },
      expect.any(Object)
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
  });
});
