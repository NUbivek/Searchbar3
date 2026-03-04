import handler from '../../../src/pages/api/auth/linkedin/logout';
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

describe('api/auth/linkedin/logout', () => {
  it('returns 405 for non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createRouteRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('clears linkedin auth cookies and returns success', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createRouteRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Logged out from LinkedIn'
    });

    const cookies = res.headers['Set-Cookie'] || res.headers['set-cookie'];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe(
      'linkedin_access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
    );
    expect(cookies[1]).toBe(
      'linkedin_user_id=; Path=/; Max-Age=0; SameSite=Lax'
    );
  });
});
