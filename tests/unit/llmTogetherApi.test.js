jest.mock('../../src/utils/errorHandling', () => ({
  withRetry: jest.fn((operation) => operation()),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { withRetry } = require('../../src/utils/errorHandling');
const { logger } = require('../../src/utils/logger');
const { callTogetherAPI } = require('../../src/utils/llm/togetherApi');

describe('callTogetherAPI', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.TOGETHER_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.TOGETHER_API_KEY;
    } else {
      process.env.TOGETHER_API_KEY = originalKey;
    }
    jest.clearAllMocks();
  });

  test('returns empty string and warns when TOGETHER_API_KEY is missing', async () => {
    delete process.env.TOGETHER_API_KEY;

    const result = await callTogetherAPI('hello', { modelId: 'meta-llama' });

    expect(result).toBe('');
    expect(logger.warn).toHaveBeenCalledWith('TOGETHER_API_KEY is not set');
    expect(withRetry).not.toHaveBeenCalled();
  });

  test('returns trimmed text on successful response', async () => {
    process.env.TOGETHER_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: {
          choices: [{ text: '  summary result  ' }],
        },
      }),
    });

    const result = await callTogetherAPI('hello', {
      modelId: 'meta-llama',
      maxTokens: 128,
      temperature: 0.2,
    });

    expect(result).toBe('summary result');
    expect(withRetry).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('returns empty string when Together response shape is invalid', async () => {
    process.env.TOGETHER_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output: {} }),
    });

    const result = await callTogetherAPI('hello', { modelId: 'meta-llama' });

    expect(result).toBe('');
    expect(logger.error).toHaveBeenCalled();
  });

  test('returns empty string when Together request fails', async () => {
    process.env.TOGETHER_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({}),
    });

    const result = await callTogetherAPI('hello', { modelId: 'meta-llama' });

    expect(result).toBe('');
    expect(logger.error).toHaveBeenCalled();
  });
});
