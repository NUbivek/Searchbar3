const handler = require('../../../src/pages/api/auth/[network]/status').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('auth network status route', () => {
  it('returns the mock status for a supported network', async () => {
    const req = createMockReq({
      method: 'GET',
      query: { network: 'linkedin' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      authenticated: false,
      network: 'linkedin',
    });
  });

  it('rejects unsupported networks', async () => {
    const req = createMockReq({
      method: 'GET',
      query: { network: 'mastodon' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid network specified' });
  });

  it('rejects non-get requests', async () => {
    const req = createMockReq({
      method: 'POST',
      query: { network: 'twitter' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });
});
