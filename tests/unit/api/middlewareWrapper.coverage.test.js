import { withErrorHandler } from '../../../src/pages/api/middleware';

function createRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    }
  };
}

describe('withErrorHandler', () => {
  it('passes through successful handlers', async () => {
    const handler = jest.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const wrapped = withErrorHandler(handler);
    const res = createRes();

    await wrapped({}, res);

    expect(handler).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true });
  });

  it('returns structured 500 when handler throws', async () => {
    const handler = jest.fn(async () => {
      throw new Error('boom');
    });

    const wrapped = withErrorHandler(handler);
    const res = createRes();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await wrapped({}, res);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual({
      error: 'Internal server error',
      message: 'boom'
    });
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
