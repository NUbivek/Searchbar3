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

describe('/api/search/web', () => {
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

  test('returns fail-soft response when Serper is not configured', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme logistics',
        customUrls: [],
        uploadedFiles: [],
        selectedSources: ['web'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(rateLimit).toHaveBeenCalledWith('Web');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['web']);
    expect(res.body.message).toBe('Serper API key not configured');
  });

  test('rejects invalid custom URLs', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme logistics',
        customUrls: ['notaurl'],
        uploadedFiles: [],
        selectedSources: ['web'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Invalid URLs provided');
    expect(rateLimit).not.toHaveBeenCalled();
  });
});
