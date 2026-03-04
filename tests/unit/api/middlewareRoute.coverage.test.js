import { withErrorHandler } from '../../../src/pages/api/middleware';

describe('withErrorHandler', () => {
  it('passes through successful handlers', async () => {
    const req = { method: 'GET' };
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status };

    const handler = jest.fn(async (_req, response) => {
      response.status(200).json({ ok: true });
    });

    await withErrorHandler(handler)(req, res);

    expect(handler).toHaveBeenCalledWith(req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true });
  });

  it('returns a normalized 500 response when the handler throws', async () => {
    const req = { method: 'POST' };
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status };
    const error = new Error('boom');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const handler = jest.fn(async () => {
      throw error;
    });

    await withErrorHandler(handler)(req, res);

    expect(handler).toHaveBeenCalledWith(req, res);
    expect(errorSpy).toHaveBeenCalledWith('API Error:', error);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: 'Internal server error',
      message: 'boom'
    });

    errorSpy.mockRestore();
  });
});
