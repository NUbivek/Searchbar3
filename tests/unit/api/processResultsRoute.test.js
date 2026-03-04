jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/processResults').default;

describe('/api/processResults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 500 for an invalid model', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        results: [{ title: 'Example' }],
        model: 'Unknown Model',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Invalid model selected' });
  });

  test('processes results with the Perplexity provider', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        id: 'perplexity-response',
        choices: [{ message: { content: 'organized' } }],
      },
    });

    const results = [{ title: 'Company A', url: 'https://example.com/a' }];
    const req = createMockReq({
      method: 'POST',
      body: {
        results,
        model: 'Perplexity',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'pplx-7b-online',
        messages: [
          {
            role: 'system',
            content:
              'Analyze and organize the search results into categories. Include source links and extract key information.',
          },
          {
            role: 'user',
            content: JSON.stringify(results),
          },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: 'Bearer undefined',
          'Content-Type': 'application/json',
        },
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      categories: {},
      sources: {},
      followUpQuestions: [],
      raw: {
        id: 'perplexity-response',
        choices: [{ message: { content: 'organized' } }],
      },
    });
  });

  test('processes results with the Together provider', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        id: 'together-response',
        output: 'organized',
      },
    });

    const results = [{ title: 'Company B', url: 'https://example.com/b' }];
    const req = createMockReq({
      method: 'POST',
      body: {
        results,
        model: 'Mistral',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://api.together.xyz/v1/completions',
      {
        model: 'mistralai/Mistral-7B-v0.1',
        prompt:
          'Analyze and organize these search results into categories. Include source links and extract key information: ' +
          JSON.stringify(results),
        temperature: 0.7,
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: 'Bearer undefined',
          'Content-Type': 'application/json',
        },
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      categories: {},
      sources: {},
      followUpQuestions: [],
      raw: {
        id: 'together-response',
        output: 'organized',
      },
    });
  });
});
