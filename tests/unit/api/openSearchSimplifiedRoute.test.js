const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

const handler = require('../../../src/pages/api/openSearch').default;

describe('/api/openSearch', () => {
  test('responds to OPTIONS with 200', async () => {
    const req = createMockReq({ method: 'OPTIONS' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  test('rejects unsupported methods', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.jsonData).toEqual({
      error: 'Method not allowed',
      allowedMethods: ['POST'],
    });
  });

  test('requires query', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonData).toEqual({ error: 'Query is required' });
  });

  test('returns simplified success payload', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'ai startups',
        sources: ['Web', 'News'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonData).toMatchObject({
      query: 'ai startups',
      model: 'mistral-7b',
      sources: ['Web', 'News'],
      message:
        'Search processing has been simplified. No results will be returned.',
      results: [],
    });
    expect(typeof res.jsonData.timestamp).toBe('string');
  });
});
