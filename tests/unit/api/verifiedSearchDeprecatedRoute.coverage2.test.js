import handler from '../../../src/pages/api/verifiedSearch';
import { createMockReq } from './testUtils';

jest.mock('../../../src/utils/logger', () => ({
  __esModule: true,
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

describe('/api/verifiedSearch (deprecated wrapper)', () => {
  const originalFetch = global.fetch;

  const createRouteRes = () => ({
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    req.headers = {};
    const res = createRouteRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    req.headers = { origin: 'https://example.com' };
    const res = createRouteRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('forwards to /api/search and wraps the response payload', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        results: [{ title: 'Result' }],
        meta: { degraded: false },
      }),
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'founders',
        options: { limit: 5 },
        useLLM: false,
      },
    });
    req.headers = { origin: 'https://example.com' };
    const res = createRouteRes();

    await handler(req, res);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/search',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const forwardedBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(forwardedBody).toMatchObject({
      query: 'founders',
      mode: 'verified',
      useLLM: true,
      options: { limit: 5 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      results: {
        results: [{ title: 'Result' }],
        meta: { degraded: false },
      },
    });
  });

  it('returns 500 when the downstream call fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('downstream failed'));

    const req = createMockReq({
      method: 'POST',
      body: { query: 'founders' },
    });
    req.headers = { origin: 'https://example.com' };
    const res = createRouteRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'An error occurred in the simplified search handler',
      message: 'downstream failed',
    });
  });
});
