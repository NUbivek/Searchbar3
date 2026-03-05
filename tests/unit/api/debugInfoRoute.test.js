const handler = require('../../../src/pages/api/debug-info').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('debug info route', () => {
  it('returns request metadata and environment info', async () => {
    process.env.NODE_ENV = 'test';

    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-test-header': 'debug',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.env).toBe('test');
    expect(res.body.method).toBe('POST');
    expect(res.body.headers).toEqual(
      expect.objectContaining({
        'x-test-header': 'debug',
      })
    );
    expect(typeof res.body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
  });
});
