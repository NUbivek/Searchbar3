import { withErrorHandler } from '../../../src/pages/api/middleware';

describe('/api/middleware withErrorHandler', () => {
  function createRes() {
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

  it('passes through when the handler succeeds', async () => {
    const req = { method: 'GET' };
    const res = createRes();
    const handler = jest.fn(async (_req, response) => {
      response.status(200).json({ ok: true });
    });

    const wrapped = withErrorHandler(handler);
    await wrapped(req, res);

    expect(handler).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns fail-soft payload when the handler throws', async () => {
    const req = { method: 'POST' };
    const res = createRes();
    const error = new Error('boom');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const handler = jest.fn(async () => {
      throw error;
    });

    const wrapped = withErrorHandler(handler);
    await wrapped(req, res);

    expect(consoleSpy).toHaveBeenCalledWith('API Error:', error);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Internal server error',
      message: 'boom',
      degradedSources: ['middleware']
    });

    consoleSpy.mockRestore();
  });
});
