jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const { createMockReq, createMockRes } = require('./testUtils');
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const handler = require('../../../src/pages/api/verifiedSearch').default;

describe('/api/verifiedSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();
    res.setHeader = jest.fn();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns 400 when query is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {},
    });
    const res = createMockRes();
    res.setHeader = jest.fn();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  test('forwards to the main search API and normalizes response contract', async () => {
    const searchResults = { items: [{ title: 'Example' }], mode: 'verified' };
    global.fetch.mockResolvedValue({
      json: jest.fn().mockResolvedValue(searchResults),
    });

    const req = createMockReq({
      method: 'POST',
      headers: { origin: 'https://example.test' },
      body: {
        query: 'fintech startups',
        options: { limit: 5 },
      },
    });
    const res = createMockRes();
    res.setHeader = jest.fn();

    await handler(req, res);

    expect(global.fetch).toHaveBeenCalledWith('https://example.test/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'fintech startups',
        options: { limit: 5 },
        mode: 'verified',
        useLLM: true,
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.legacyResults).toEqual(searchResults);
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  test('returns fail-soft 200 when forwarding fails', async () => {
    global.fetch.mockRejectedValue(new Error('upstream failed'));

    const req = createMockReq({
      method: 'POST',
      headers: { origin: 'https://example.test' },
      body: {
        query: 'ai tools',
      },
    });
    const res = createMockRes();
    res.setHeader = jest.fn();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      results: [],
      status: 'fail-soft',
      degradedSources: ['verified-search-forwarder'],
      error: 'An error occurred in the simplified search handler',
      message: 'upstream failed',
    }));
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
