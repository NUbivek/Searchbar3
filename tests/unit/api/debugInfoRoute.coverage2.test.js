const handler = require('../../../src/pages/api/debug-info').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/debug-info', () => {
  it('returns debug metadata', () => {
    const req = createMockReq({
      method: 'POST',
      headers: { 'x-test': '1' },
    });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      env: process.env.NODE_ENV,
      method: 'POST',
      headers: { 'x-test': '1' },
    });
    expect(res.body.timestamp).toEqual(expect.any(String));
  });
});
