const errorHandler = require('../../../src/pages/api/middleware/errorHandler').default;

const { createMockReq, createMockRes } = require('./testUtils');

describe('errorHandler middleware', () => {
  it('returns 429 for rate limit errors', () => {
    const req = createMockReq();
    const res = createMockRes();
    const error = {
      name: 'RateLimitError',
      source: 'serper',
      retryAfter: 30,
    };
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(error, req, res, jest.fn());

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: 'Rate limit exceeded',
      source: 'serper',
      retryAfter: 30,
    });

    consoleSpy.mockRestore();
  });

  it('returns fail-soft payload for upstream 5xx api errors', () => {
    const req = createMockReq();
    const res = createMockRes();
    const error = {
      name: 'APIError',
      message: 'Upstream failed',
      source: 'reddit',
      status: 502,
    };
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(error, req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Upstream failed',
      source: 'reddit',
      degradedSources: ['reddit'],
    });

    consoleSpy.mockRestore();
  });

  it('returns fail-soft default payload outside development', () => {
    const req = createMockReq();
    const res = createMockRes();
    const error = new Error('secret');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.env.NODE_ENV;

    process.env.NODE_ENV = 'production';
    errorHandler(error, req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'An unexpected error occurred',
      message: undefined,
      degradedSources: ['api'],
    });

    process.env.NODE_ENV = previous;
    consoleSpy.mockRestore();
  });

  it('includes default error details in development', () => {
    const req = createMockReq();
    const res = createMockRes();
    const error = new Error('visible');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.env.NODE_ENV;

    process.env.NODE_ENV = 'development';
    errorHandler(error, req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'An unexpected error occurred',
      message: 'visible',
      degradedSources: ['api'],
    });

    process.env.NODE_ENV = previous;
    consoleSpy.mockRestore();
  });
});
