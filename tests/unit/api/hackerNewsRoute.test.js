const handler = require('../../../src/pages/api/search/hackernews').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/search/hackernews', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns 405 for unsupported methods', async () => {
    const req = createMockReq({ method: 'PUT' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ method: 'GET', query: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('returns normalized results for successful fetches', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        hits: [
          {
            title: 'Test HN Story',
            url: 'https://example.com/story',
            story_text: 'Story body',
            created_at: '2026-03-03T00:00:00.000Z',
            points: 42,
            objectID: '123',
          },
        ],
      }),
    });

    const req = createMockReq({ method: 'GET', query: { q: 'ai tools' } });
    const res = createMockRes();

    await handler(req, res);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('query=ai%20tools'),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.query).toBe('ai tools');
    expect(res.body.source).toBe('hackernews');
    expect(res.body.results).toEqual([
      expect.objectContaining({
        title: 'Test HN Story',
        url: 'https://example.com/story',
        content: 'Story body',
        snippet: 'Story body',
        source: 'hackernews',
        timestamp: '2026-03-03T00:00:00.000Z',
        score: 42,
      }),
    ]);
  });

  it('returns degraded success payload when fetch fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    const req = createMockReq({ method: 'POST', body: { query: 'agents' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      query: 'agents',
      source: 'hackernews',
      results: [],
      degraded: true,
      error: 'network down',
    });
  });
});
