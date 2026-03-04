const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/upload').default;

describe('/api/upload', () => {
  test('returns 405 on non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });
});
