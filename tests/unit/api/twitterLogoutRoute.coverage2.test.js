import handler from '../../../src/pages/api/auth/twitter/logout';
import { createMockReq } from './testUtils';

function createRouteRes() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
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

describe('api/auth/twitter/logout', () => {
  it('returns 405 for non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createRouteRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('clears twitter auth cookies and returns success', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createRouteRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Logged out of Twitter'
    });

    const cookies = res.headers['Set-Cookie'] || res.headers['set-cookie'];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toContain('twitter_auth_state=');
    expect(cookies[1]).toContain('twitter_code_verifier=');
    expect(cookies[2]).toContain('twitter_access_token=');
  });
});
