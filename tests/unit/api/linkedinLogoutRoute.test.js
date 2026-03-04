const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/linkedin/logout').default;

function createHeaderRes() {
  const res = createMockRes();
  res.headers = {};
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  return res;
}

describe('/api/auth/linkedin/logout', () => {
  test('rejects non-GET requests', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createHeaderRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('clears linkedin cookies and returns success', () => {
    const req = createMockReq({ method: 'GET' });
    const res = createHeaderRes();

    handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', [
      'linkedin_access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'linkedin_user_id=; Path=/; Max-Age=0; SameSite=Lax',
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Logged out from LinkedIn',
    });
  });
});
