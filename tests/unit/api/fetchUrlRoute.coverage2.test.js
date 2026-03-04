jest.mock('../../../src/utils/urlExtraction', () => ({
  fetchUrlContent: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

const { fetchUrlContent } = require('../../../src/utils/urlExtraction');
const { logger } = require('../../../src/utils/logger');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/fetch-url').default;

describe('/api/fetch-url coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 405 for unsupported method', async () => {
    const req = createMockReq({ method: 'PUT' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('accepts POST body url and logs degraded payload', async () => {
    fetchUrlContent.mockResolvedValue({
      status: 'error',
      url: 'https://bad.example',
      error: 'Timeout',
    });

    const req = createMockReq({
      method: 'POST',
      body: { url: 'https://bad.example' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(fetchUrlContent).toHaveBeenCalledWith('https://bad.example', {
      timeoutMs: 10000,
      maxBytes: 1024 * 1024,
      textLimit: 8000,
    });
    expect(logger.warn).toHaveBeenCalledWith('URL fetch failed', {
      url: 'https://bad.example',
      error: 'Timeout',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('error');
  });
});
