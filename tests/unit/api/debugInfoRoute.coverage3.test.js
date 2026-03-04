const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/debug-info').default;

describe('/api/debug-info', () => {
  it('returns status and request context', () => {
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-test-header': 'codex',
      },
    });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      env: process.env.NODE_ENV,
      headers: req.headers,
      method: 'POST',
    });
    expect(typeof res.body.timestamp).toBe('string');
  });
});
