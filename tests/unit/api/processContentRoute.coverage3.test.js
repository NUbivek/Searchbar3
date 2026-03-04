const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('../../../src/components/search/categories/types/DefaultCategories', () => ({
  getAllCategories: jest.fn(() => []),
}));

jest.mock('../../../src/components/search/metrics/utils/contextDetector', () => ({
  detectContext: jest.fn(() => ({})),
}));

jest.mock('../../../src/components/search/metrics/MetricsCalculator', () => ({
  MetricsCalculator: jest.fn().mockImplementation(() => ({
    calculate: jest.fn(() => []),
  })),
}));

jest.mock('../../../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const handler = require('../../../src/pages/api/process-content').default;

describe('/api/process-content', () => {
  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query or results are missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: '', results: null },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid request. Query and results array are required.',
    });
  });

  it('returns processed content for a valid request', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'founder-led devtools',
        results: [{ title: 'Example startup', link: 'https://example.com' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.processedContent)).toBe(true);
  });

  it('returns 500 when request parsing throws', async () => {
    const req = createMockReq({ method: 'POST' });
    Object.defineProperty(req, 'body', {
      configurable: true,
      get() {
        throw new Error('boom');
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to process content',
      message: 'boom',
    });
  });
});
