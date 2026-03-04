import handler from '../../../src/pages/api/llm/status';

jest.mock('../../../src/utils/llmProcessing', () => ({
  MODEL_ENDPOINTS: {
    together: {
      endpoint: 'https://api.together.xyz/v1/chat/completions',
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    },
    perplexity: {
      endpoint: 'https://api.perplexity.ai/chat/completions',
      model: 'sonar',
    },
  },
}));

function createReq(method = 'GET') {
  return { method };
}

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
}

describe('/api/llm/status coverage', () => {
  afterEach(() => {
    restoreEnv();
    jest.clearAllMocks();
  });

  it('returns false status for missing keys', async () => {
    delete process.env.TOGETHER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.NODE_ENV;
    delete process.env.NEXT_PUBLIC_SEARCH_API_URL;

    const req = createReq('GET');
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.apiKeys).toEqual(
      expect.objectContaining({
        together: false,
        togetherKeyLength: 0,
        perplexity: false,
        perplexityKeyLength: 0,
      })
    );
    expect(res.body.env).toEqual(
      expect.objectContaining({
        nodeEnv: undefined,
        hasEnvFile: false,
      })
    );
  });

  it('treats placeholder keys as not configured', async () => {
    process.env.TOGETHER_API_KEY = 'your_together_api_key_here';
    process.env.PERPLEXITY_API_KEY = 'your_perplexity_api_key_here';

    const req = createReq('GET');
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.apiKeys).toEqual(
      expect.objectContaining({
        together: false,
        togetherKeyLength: 0,
        perplexity: false,
        perplexityKeyLength: 0,
      })
    );
  });

  it('reports configured keys and environment metadata', async () => {
    process.env.TOGETHER_API_KEY = 'together_real_key_12345';
    process.env.PERPLEXITY_API_KEY = 'perplexity_real_key_67890';
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_SEARCH_API_URL = 'https://airesearch.bivek.ai';

    const req = createReq('GET');
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.apiKeys).toEqual(
      expect.objectContaining({
        together: true,
        togetherKeyLength: process.env.TOGETHER_API_KEY.length,
        perplexity: true,
        perplexityKeyLength: process.env.PERPLEXITY_API_KEY.length,
      })
    );
    expect(res.body.env).toEqual(
      expect.objectContaining({
        nodeEnv: 'production',
        hasEnvFile: true,
      })
    );
    expect(res.body.modelConfig).toEqual(
      expect.objectContaining({
        together: expect.objectContaining({
          endpoint: 'Not configured',
          model: 'Not configured',
        }),
        perplexity: expect.objectContaining({
          endpoint: 'Not configured',
          model: 'Not configured',
        }),
      })
    );
  });
});
