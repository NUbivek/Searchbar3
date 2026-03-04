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

describe('/api/fetch-url', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 400 when url is missing', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'URL is required' });
  });

  test('returns payload from fetchUrlContent', async () => {
    fetchUrlContent.mockResolvedValue({
      status: 'ok',
      url: 'https://example.com',
      title: 'Example',
      content: 'Hello world',
    });

    const req = createMockReq({
      method: 'GET',
      query: { url: 'https://example.com' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(fetchUrlContent).toHaveBeenCalledWith('https://example.com', {
      timeoutMs: 10000,
      maxBytes: 1024 * 1024,
      textLimit: 8000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('returns fail-soft error payload and logs warning when extractor errors', async () => {
    fetchUrlContent.mockResolvedValue({
      status: 'error',
      url: 'https://example.com/file.pdf',
      title: null,
      content: '',
      error: 'Unsupported content type: application/pdf',
    });

    const req = createMockReq({
      method: 'POST',
      body: { url: 'https://example.com/file.pdf' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'error',
      url: 'https://example.com/file.pdf',
      title: null,
      content: '',
      error: 'Unsupported content type: application/pdf',
    });
    expect(logger.warn).toHaveBeenCalledWith('URL fetch failed', {
      url: 'https://example.com/file.pdf',
      error: 'Unsupported content type: application/pdf',
    });
  });
});
