const { withErrorHandler } = require('../../../src/pages/api/middleware');

const { createMockReq, createMockRes } = require('./testUtils');

describe('withErrorHandler', () => {
  it('passes through successful handlers', async () => {
    const req = createMockReq();
    const res = createMockRes();
    const handler = jest.fn(async (_req, response) => {
      response.status(201).json({ ok: true });
    });

    const wrapped = withErrorHandler(handler);

    await wrapped(req, res);

    expect(handler).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns normalized fail-soft payload on handler failure', async () => {
    const req = createMockReq();
    const res = createMockRes();
    const error = new Error('boom');
    const handler = jest.fn(async () => {
      throw error;
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const wrapped = withErrorHandler(handler);

    await wrapped(req, res);

    expect(consoleSpy).toHaveBeenCalledWith('API Error:', error);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Internal server error',
      message: 'boom',
      degradedSources: ['middleware'],
    });

    consoleSpy.mockRestore();
  });
});
