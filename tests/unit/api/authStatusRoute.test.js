import handler from '../../../src/pages/api/auth/[network]/status';
import { createMockReq, createMockRes } from './testUtils';

describe('api/auth/[network]/status', () => {
  it('returns 405 for non-GET requests', async () => {
    const req = createMockReq({ method: 'POST', query: { network: 'linkedin' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 for unsupported networks', async () => {
    const req = createMockReq({ method: 'GET', query: { network: 'reddit' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid network specified' });
  });

  it('returns unauthenticated mock status for supported networks', async () => {
    const req = createMockReq({ method: 'GET', query: { network: 'twitter' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      authenticated: false,
      network: 'twitter'
    });
  });
});
