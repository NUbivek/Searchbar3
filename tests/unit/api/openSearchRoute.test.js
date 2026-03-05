jest.mock('../../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/openSearch').default;

describe('/api/openSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 200 for OPTIONS requests', async () => {
    const req = createMockReq({ method: 'OPTIONS' });
    const res = createMockRes();
    res.setHeader = jest.fn();
    res.end = jest.fn().mockReturnValue(res);

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.statusCode).toBe(200);
    expect(res.end).toHaveBeenCalled();
  });

  test('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();
    res.setHeader = jest.fn();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({
      error: 'Method not allowed',
      allowedMethods: ['POST'],
    });
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

  test('returns the simplified placeholder response', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'ai startups',
      },
    });
    const res = createMockRes();
    res.setHeader = jest.fn();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      query: 'ai startups',
      model: 'mistral-7b',
      sources: ['Web'],
      message: 'Search processing has been simplified. No results will be returned.',
      results: [],
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  test('uses explicit model and sources when provided', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'developer tools',
        model: 'mixtral-8x7b',
        sources: ['Web', 'Reddit'],
      },
    });
    const res = createMockRes();
    res.setHeader = jest.fn();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      query: 'developer tools',
      model: 'mixtral-8x7b',
      sources: ['Web', 'Reddit'],
      results: [],
    });
  });
});
