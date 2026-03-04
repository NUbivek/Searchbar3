const { createMockReq, createMockRes } = require('./testUtils');
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
    process.env.TOGETHER_API_KEY = originalApiKey;
  });

  test('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns 400 when messages is not an array', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {},
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Messages array is required' });
  });

  test('returns fail-soft 200 when the Together API key is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      content: null,
      model: 'mistralai/Mistral-7B-v0.1',
      degradedSources: ['together'],
      error: 'Together API key not found',
    });
  });

  test('falls back to mistral when an unsupported model is requested', async () => {
    process.env.TOGETHER_API_KEY = 'test-key';
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: {
          choices: [{ text: '  hello world  ' }],
        },
      }),
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'unknown-model',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.together.xyz/inference',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        },
        signal: expect.any(Object),
      })
    );

    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(requestBody.model).toBe('mistralai/Mistral-7B-v0.1');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      content: 'hello world',
      model: 'mistralai/Mistral-7B-v0.1',
    });
  });

  test('returns fail-soft 200 when Together returns a non-ok response', async () => {
    process.env.TOGETHER_API_KEY = 'test-key';
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'mistral-7b',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      content: null,
      model: 'mistralai/Mistral-7B-v0.1',
      degradedSources: ['together'],
      error: 'Together API error: 500',
    });
  });
});
