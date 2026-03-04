const errorHandler = require('../../../src/pages/api/middleware/errorHandler').default;

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

describe('errorHandler middleware', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.error = jest.fn();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    console.error = originalConsoleError;
  });

  test('returns 429 for RateLimitError', () => {
    const res = createMockRes();
    const error = {
      name: 'RateLimitError',
      source: 'serper',
      retryAfter: 30
    };

    errorHandler(error, {}, res);

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: 'Rate limit exceeded',
      source: 'serper',
      retryAfter: 30
    });
  });

  test('returns fail-soft for APIError with 5xx status', () => {
    const res = createMockRes();
    const error = {
      name: 'APIError',
      message: 'Provider failed',
      source: 'reddit',
      status: 503
    };

    errorHandler(error, {}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Provider failed',
      source: 'reddit',
      degradedSources: ['reddit']
    });
  });

  test('includes the error message in development for generic errors', () => {
    process.env.NODE_ENV = 'development';
    const res = createMockRes();
    const error = new Error('Unexpected failure');

    errorHandler(error, {}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'An unexpected error occurred',
      message: 'Unexpected failure',
      degradedSources: ['api']
    });
  });

  test('omits the error message outside development for generic errors', () => {
    process.env.NODE_ENV = 'production';
    const res = createMockRes();
    const error = new Error('Unexpected failure');

    errorHandler(error, {}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'An unexpected error occurred',
      message: undefined,
      degradedSources: ['api']
    });
  });
});
