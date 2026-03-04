jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const axios = require('axios');
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/search/medium').default;

describe('/api/search/medium', () => {
  const originalSerperKey = process.env.SERPER_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SERPER_API_KEY;
  });

  afterAll(() => {
    if (originalSerperKey) {
      process.env.SERPER_API_KEY = originalSerperKey;
    } else {
      delete process.env.SERPER_API_KEY;
    }
  });

  test('rejects non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ message: 'Method not allowed' });
  });

  test('requires a query', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {},
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Query is required' });
  });

  test('returns fail-soft when Serper is not configured', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'seed investing' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['medium']);
    expect(res.body.message).toBe('Search failed');
    expect(res.body.error).toBe('Serper API key not configured');
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  test('returns normalized medium sources on success', async () => {
    process.env.SERPER_API_KEY = 'test-key';
    axios.post.mockResolvedValue({
      data: {
        organic: [
          {
            title: 'A useful Medium post',
            link: 'https://medium.com/@acme/useful-post',
            snippet: 'A concise summary',
          },
          {
            title: 'Missing link',
            snippet: 'Ignored',
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'seed investing' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      expect.objectContaining({
        q: 'site:medium.com seed investing',
        num: 10,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-KEY': 'test-key',
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.status).toBe('ok');
    expect(res.body.sources[0]).toEqual(
      expect.objectContaining({
        type: 'MediumResult',
        title: 'A useful Medium post',
        url: 'https://medium.com/@acme/useful-post',
        content: 'A concise summary',
        sourceId: 'medium-0',
      })
    );
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
