const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/[...catchAll]').default;

describe('/api/[...catchAll]', () => {
  test('returns a normalized 404 response for undefined API routes', () => {
    const req = createMockReq({ query: { catchAll: ['missing', 'route'] } });
    const res = createMockRes();
    res.setHeader = jest.fn();

    handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'API route not found' });
  });
});
