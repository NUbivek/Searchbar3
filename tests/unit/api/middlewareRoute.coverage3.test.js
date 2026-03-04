const { createMockReq, createMockRes } = require('./testUtils');

const { withErrorHandler } = require('../../../src/pages/api/middleware');

describe('withErrorHandler', () => {
  it('preserves successful handler responses', async () => {
    const handler = jest.fn(async (_req, res) => {
      res.status(201).json({ ok: true });
    });

    const wrapped = withErrorHandler(handler);
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await wrapped(req, res);

    expect(handler).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns a structured 500 when the handler throws', async () => {
    const error = new Error('boom');
    const handler = jest.fn(async () => {
      throw error;
    });
    const wrapped = withErrorHandler(handler);
    const req = createMockReq();
    const res = createMockRes();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await wrapped(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Internal server error',
      message: 'boom',
    });
    expect(consoleSpy).toHaveBeenCalledWith('API Error:', error);

    consoleSpy.mockRestore();
  });
});
