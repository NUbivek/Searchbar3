jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../src/utils/errorHandling', () => ({
  withRetry: jest.fn((fn) => fn()),
}));

jest.mock('../../../src/utils/rateLimiter', () => ({
  rateLimit: jest.fn().mockResolvedValue(undefined),
}));

const { rateLimit } = require('../../../src/utils/rateLimiter');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/search/web').default;

describe('/api/search/web validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SERPER_API_KEY = 'test-key';
  });

  afterAll(() => {
    delete process.env.SERPER_API_KEY;
  });

  test('rejects unsupported methods', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body.message).toBe('Method not allowed');
    expect(rateLimit).not.toHaveBeenCalled();
  });

  test('rejects an invalid model', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme logistics',
        model: 'invalid-model',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe(
      'Invalid model. Must be one of: mixtral-8x7b, deepseek-70b, gemma-7b'
    );
    expect(rateLimit).not.toHaveBeenCalled();
  });

  test('rejects an invalid mode', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme logistics',
        customMode: 'broken',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe(
      'Invalid mode. Must be one of: default, analysis, summary'
    );
    expect(rateLimit).not.toHaveBeenCalled();
  });

  test('rejects invalid custom URLs', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme logistics',
        customUrls: ['notaurl'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Invalid URLs provided');
    expect(rateLimit).not.toHaveBeenCalled();
  });

  test('rejects too many custom URLs', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme logistics',
        customUrls: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`),
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Maximum 10 custom URLs allowed');
    expect(rateLimit).not.toHaveBeenCalled();
  });
});
