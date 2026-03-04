const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('../../../src/utils/llmProcessing', () => ({
  processWithLLM: jest.fn(),
}));

const { processWithLLM } = require('../../../src/utils/llmProcessing');
const handler = require('../../../src/pages/api/llm/test').default;

describe('/api/llm/test', () => {
  const originalApiKey = process.env.TOGETHER_API_KEY;

  beforeEach(() => {
    process.env.TOGETHER_API_KEY = 'test-api-key';
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env.TOGETHER_API_KEY = originalApiKey;
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Missing required parameters',
      message: 'The query parameter is required',
    });
  });

  it('returns normalized LLM flags on success', async () => {
    processWithLLM.mockResolvedValue({
      content: 'processed output',
      sources: ['a'],
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find startup signals',
        modelId: 'mixtral-8x7b',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(processWithLLM).toHaveBeenCalledWith(
      [
        {
          title: 'Test Result',
          snippet: 'This is a test result for LLM processing',
          url: 'https://example.com/test',
        },
      ],
      'find startup signals',
      'mixtral-8x7b',
      {
        apiKey: 'test-api-key',
        forceLLM: true,
        debug: true,
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      content: 'processed output',
      sources: ['a'],
      __isImmutableLLMResult: true,
      isLLMResult: true,
      llmProcessed: true,
      query: 'find startup signals',
      modelId: 'mixtral-8x7b',
      testEndpoint: true,
    });
  });

  it('returns fail-soft 200 with error metadata when LLM processing fails', async () => {
    const error = Object.assign(new Error('boom'), { code: 'llm_failure' });
    processWithLLM.mockRejectedValue(error);

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find startup signals',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      degradedSources: ['llm-test'],
      error: 'Failed to test LLM processing',
      message: 'boom',
      isError: true,
      __isImmutableLLMResult: true,
      errorType: 'llm_failure',
    });
  });
});
