jest.mock('../../../src/utils/llmProcessing', () => ({
  processWithLLM: jest.fn(),
}));

const { processWithLLM } = require('../../../src/utils/llmProcessing');
const handler = require('../../../src/pages/api/llm/test').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/llm/test', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {},
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Missing required parameters',
      message: 'The query parameter is required',
    });
  });

  it('returns normalized success output', async () => {
    process.env.TOGETHER_API_KEY = 'test-key';
    processWithLLM.mockResolvedValue({ summary: 'ok' });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find startups',
        modelId: 'mistral-7b',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(processWithLLM).toHaveBeenCalledTimes(1);
    const [results, query, modelId, options] = processWithLLM.mock.calls[0];
    expect(results).toHaveLength(1);
    expect(query).toBe('find startups');
    expect(modelId).toBe('mistral-7b');
    expect(options).toEqual(
      expect.objectContaining({
        apiKey: 'test-key',
        forceLLM: true,
        debug: true,
      })
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      summary: 'ok',
      __isImmutableLLMResult: true,
      isLLMResult: true,
      llmProcessed: true,
      query: 'find startups',
      modelId: 'mistral-7b',
      testEndpoint: true,
    });
  });

  it('returns normalized errors from llm processing failures', async () => {
    process.env.TOGETHER_API_KEY = 'test-key';
    const error = Object.assign(new Error('boom'), { code: 'bad_request' });
    processWithLLM.mockRejectedValue(error);

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find startups',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to test LLM processing',
      message: 'boom',
      isError: true,
      __isImmutableLLMResult: true,
      errorType: 'bad_request',
    });
  });
});
