const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const { logger } = require('../../../src/utils/logger');
const handler = require('../../../src/pages/api/llm/chat').default;

describe('/api/llm/chat', () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.TOGETHER_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete process.env.TOGETHER_API_KEY;
  });

  afterAll(() => {
    global.fetch = originalFetch;

    if (originalApiKey) {
      process.env.TOGETHER_API_KEY = originalApiKey;
    } else {
      delete process.env.TOGETHER_API_KEY;
    }
  });

  test('rejects non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('requires a messages array', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {},
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Messages array is required' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns a configuration error when the Together API key is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Together API key not found' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  test('falls back to mistral-7b when the requested model is unsupported', async () => {
    process.env.TOGETHER_API_KEY = 'together-key';
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: {
          choices: [{ text: 'Assistant reply' }],
        },
      }),
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'unknown-model',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(logger.warn).toHaveBeenCalledWith(
      'Unsupported model, falling back to mistral-7b',
      { requestedModel: 'unknown-model' }
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.together.xyz/inference',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer together-key',
        }),
        body: expect.stringContaining('"model":"mistralai/Mistral-7B-v0.1"'),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      content: 'Assistant reply',
      model: 'mistralai/Mistral-7B-v0.1',
    });
  });

  test('uses the supported gemma model when explicitly requested', async () => {
    process.env.TOGETHER_API_KEY = 'together-key';
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: {
          choices: [{ text: 'Gemma reply' }],
        },
      }),
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gemma-2-9b',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.together.xyz/inference',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer together-key',
        }),
        body: expect.stringContaining('"model":"google/gemma-2-9b-it"'),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      content: 'Gemma reply',
      model: 'google/gemma-2-9b-it',
    });
  });

  test('returns provider errors when Together rejects the request', async () => {
    process.env.TOGETHER_API_KEY = 'together-key';
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'mistral-7b',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Together API error: 502' });
    expect(logger.error).toHaveBeenCalled();
  });

  test('returns a server error when Together returns a malformed payload', async () => {
    process.env.TOGETHER_API_KEY = 'together-key';
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: {},
      }),
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'mistral-7b',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: "Cannot read properties of undefined (reading '0')",
    });
    expect(logger.error).toHaveBeenCalled();
  });
});
