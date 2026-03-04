jest.mock('axios', () => ({
  get: jest.fn(),
}));

jest.mock('cheerio', () => ({
  __esModule: true,
  default: jest.requireActual('cheerio'),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/webScrape').default;

describe('/api/webScrape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns 400 when neither url nor sources is provided', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'operators' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Either url or sources must be provided' });
  });

  test('scrapes a single URL and returns normalized content', async () => {
    axios.get.mockResolvedValueOnce({
      data: `
        <html>
          <head>
            <title>Example Page</title>
            <meta name="description" content="Example description" />
          </head>
          <body>
            <main>Hello world from the body content.</main>
          </body>
        </html>
      `,
    });

    const req = createMockReq({
      method: 'POST',
      body: { url: 'https://example.com/path/page' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://example.com/path/page',
      expect.objectContaining({
        timeout: 10000,
        headers: expect.objectContaining({
          'User-Agent': expect.stringContaining('Mozilla/5.0'),
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.type).toBe('Web Content');
    expect(res.body.title).toBe('page');
    expect(res.body.content).toContain('Example Page');
    expect(res.body.content).toContain('Example description');
    expect(res.body.content).toContain('Hello world from the body content.');
  });

  test('returns a graceful message when single-url scraping fails', async () => {
    axios.get.mockRejectedValueOnce(new Error('timeout'));

    const req = createMockReq({
      method: 'POST',
      body: { url: 'https://example.com/fail' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.type).toBe('Web Content');
    expect(res.body.content).toBe('Failed to scrape content from https://example.com/fail');
  });

  test('returns an empty aggregated result for unsupported sources', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'operators', sources: ['UnknownSource'] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      summary: 'Found results across 1 sources',
      degradedSources: [],
      results: [],
    });
  });

  test('scrapes configured sources and flattens the results', async () => {
    axios.get.mockResolvedValueOnce({
      data: `
        <div data-testid="tweet">
          <div data-testid="tweetText">Tweet body text</div>
          <div data-testid="User-Name">Jane Founder</div>
          <a href="/jane/status/123">Status</a>
        </div>
      `,
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'operators', sources: ['Twitter'] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://twitter.com/search?q=operators&f=live',
      expect.objectContaining({ timeout: 10000 })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.summary).toBe('Found results across 1 sources');
    expect(res.body.degradedSources).toEqual([]);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toEqual(
      expect.objectContaining({
        source: 'Twitter',
        title: 'Tweet body text',
        content: 'Tweet body text',
        url: '/jane/status/123',
        author: 'Jane Founder',
      })
    );
    expect(typeof res.body.results[0].timestamp).toBe('string');
  });

  test('returns fail-soft response for unexpected handler exceptions', async () => {
    const req = { method: 'POST' };
    Object.defineProperty(req, 'body', {
      get() {
        throw new Error('body crashed');
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      summary: 'Web scraping encountered an unexpected error',
      degradedSources: ['webScrape'],
      results: [],
      error: 'Scraping failed',
    });
  });
});
