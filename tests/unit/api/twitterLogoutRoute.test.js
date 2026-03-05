const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/twitter/logout').default;

function createHeaderRes() {
  const res = createMockRes();
  res.headers = {};
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  return res;
}

describe('/api/auth/twitter/logout', () => {
  test('rejects non-GET requests', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createHeaderRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  test('clears twitter cookies and returns success', () => {
    const req = createMockReq({ method: 'GET' });
    const res = createHeaderRes();

    handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', [
      'twitter_auth_state=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
      'twitter_code_verifier=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
      'twitter_access_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Logged out of Twitter',
    });
  });
});
