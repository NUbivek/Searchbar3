jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../../src/utils/llmProcessing', () => ({
  generatePrompt: jest.fn(() => 'Generated prompt'),
}));

const axios = require('axios');
const { generatePrompt } = require('../../../src/utils/llmProcessing');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/llm/process').default;

describe('/api/llm/process', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.TOGETHER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('returns structured 400 response when query is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        sources: [{ title: 'Example' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      categories: {
        key_insights: 'No query was provided. Please enter a search query.',
      },
      metrics: {
        relevance: 0,
        accuracy: 0,
        credibility: 0,
      },
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('returns graceful 200 response when there are no valid sources', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'founders',
        sources: [null, 'bad', 12],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.categories.key_insights).toContain('founders');
    expect(res.body.metrics).toEqual({
      relevance: 60,
      accuracy: 60,
      credibility: 60,
    });
    expect(Array.isArray(res.body.followUpQuestions)).toBe(true);
    expect(generatePrompt).not.toHaveBeenCalled();
  });

  test('uses Together API when available and returns parsed JSON', async () => {
    process.env.TOGETHER_API_KEY = 'together-key';
    axios.post.mockResolvedValueOnce({
      data: {
        choices: [
          {
            text: 'prefix {"categories":{"key_insights":"ok"},"metrics":{"relevance":88,"accuracy":77,"credibility":66}} suffix',
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'ai startups',
        sources: [{ title: 'Source A' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(generatePrompt).toHaveBeenCalledWith('ai startups', [{ title: 'Source A' }]);
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.together.xyz/v1/completions',
      expect.objectContaining({
        model: 'mistralai/Mistral-7B-v0.1',
        prompt: 'Generated prompt',
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer together-key',
        },
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.categories).toEqual({ key_insights: 'ok' });
    expect(res.body.metrics).toEqual({
      relevance: 88,
      accuracy: 77,
      credibility: 66,
    });
    expect(res.body.apiStatus).toEqual({
      together: 'Success',
      perplexity: 'Skipped (Together API succeeded)',
    });
  });

  test('falls back to Perplexity when Together fails', async () => {
    process.env.TOGETHER_API_KEY = 'together-key';
    process.env.PERPLEXITY_API_KEY = 'perplexity-key';

    axios.post
      .mockRejectedValueOnce(new Error('together down'))
      .mockResolvedValueOnce({
        data: {
          choices: [
            {
              message: {
                content:
                  '{"categories":{"key_insights":"fallback"},"metrics":{"relevance":70,"accuracy":71,"credibility":72}}',
              },
            },
          ],
        },
      });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'network effects',
        sources: [{ title: 'Source B' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      'https://api.perplexity.ai/chat/completions',
      expect.objectContaining({
        model: 'sonar-small-chat',
        messages: expect.any(Array),
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer perplexity-key',
        },
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.categories).toEqual({ key_insights: 'fallback' });
    expect(res.body.apiStatus.together).toBe('Error: together down');
    expect(res.body.apiStatus.perplexity).toBe('Success');
  });

  test('returns fail-soft 200 with API status when both providers fail', async () => {
    process.env.TOGETHER_API_KEY = 'together-key';
    process.env.PERPLEXITY_API_KEY = 'perplexity-key';

    axios.post
      .mockRejectedValueOnce(new Error('together failed'))
      .mockRejectedValueOnce(new Error('perplexity failed'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'defensibility',
        sources: [{ title: 'Source C' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.error).toBe('Failed to process query with LLM APIs');
    expect(res.body.apiStatus).toEqual({
      together: 'Error: together failed',
      perplexity: 'Error: perplexity failed',
    });
    expect(res.body.categories.key_insights).toContain('defensibility');
  });

  test('returns fail-soft 200 when both API keys are missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'pricing power',
        sources: [{ title: 'Source D' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.apiStatus).toEqual({
      together: 'Missing API key',
      perplexity: 'Missing API key',
    });
  });
});
