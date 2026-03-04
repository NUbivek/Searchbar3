const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../../src/utils/llmProcessing', () => ({
  generatePrompt: jest.fn(),
}));

const axios = require('axios');
const { generatePrompt } = require('../../../src/utils/llmProcessing');
const handler = require('../../../src/pages/api/llm/process').default;

describe('/api/llm/process', () => {
  const originalTogetherApiKey = process.env.TOGETHER_API_KEY;
  const originalPerplexityApiKey = process.env.PERPLEXITY_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    generatePrompt.mockReturnValue('generated prompt');
    process.env.TOGETHER_API_KEY = 'together-key';
    process.env.PERPLEXITY_API_KEY = 'perplexity-key';
  });

  afterAll(() => {
    process.env.TOGETHER_API_KEY = originalTogetherApiKey;
    process.env.PERPLEXITY_API_KEY = originalPerplexityApiKey;
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns a structured 400 payload when query is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        sources: [],
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
  });

  it('returns a graceful fallback when there are no valid sources', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'operator tooling',
        sources: [null, 'bad'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(generatePrompt).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.categories.key_insights).toContain('operator tooling');
    expect(res.body.followUpQuestions).toHaveLength(3);
  });

  it('returns parsed Together JSON when Together succeeds first', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        choices: [
          {
            text: 'prefix {"categories":{"key_insights":"hello"},"metrics":{"relevance":88,"accuracy":77,"credibility":66}} suffix',
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'operator tooling',
        sources: [{ title: 'A', snippet: 'B' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(generatePrompt).toHaveBeenCalledWith('operator tooling', [{ title: 'A', snippet: 'B' }]);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.categories.key_insights).toBe('hello');
    expect(res.body.apiStatus).toEqual({
      together: 'Success',
      perplexity: 'Skipped (Together API succeeded)',
    });
  });

  it('falls back to Perplexity when Together fails', async () => {
    axios.post
      .mockRejectedValueOnce(new Error('together down'))
      .mockResolvedValueOnce({
        data: {
          choices: [
            {
              message: {
                content: '{"categories":{"key_insights":"perplexity fallback"},"metrics":{"relevance":70,"accuracy":71,"credibility":72}}',
              },
            },
          ],
        },
      });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'founder ops',
        sources: [{ title: 'A', snippet: 'B' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.body.categories.key_insights).toBe('perplexity fallback');
    expect(res.body.apiStatus.perplexity).toBe('Success');
    expect(res.body.apiStatus.together).toContain('Error: together down');
  });

  it('returns 500 when both LLM providers fail', async () => {
    axios.post
      .mockRejectedValueOnce(new Error('together down'))
      .mockRejectedValueOnce(new Error('perplexity down'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'rev ops',
        sources: [{ title: 'A', snippet: 'B' }],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('LLM API Error');
    expect(res.body.apiStatus.together).toContain('Error: together down');
    expect(res.body.apiStatus.perplexity).toContain('Error: perplexity down');
  });
});
