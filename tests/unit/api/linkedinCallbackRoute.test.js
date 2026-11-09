jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/linkedin/callback').default;

function createRedirectRes() {
  const res = createMockRes();
  res.redirectTarget = null;
  res.redirect = jest.fn((target) => {
    res.redirectTarget = target;
    return res;
  });
  return res;
}

// A request as the dev server sees it: localhost host header, so the
// redirect goes back to the same origin.
function createCallbackReq(overrides = {}) {
  return createMockReq({
    headers: { host: 'localhost:3000' },
    cookies: {},
    ...overrides,
  });
}

const NETWORK = 'http://localhost:3000/network';

describe('/api/auth/linkedin/callback', () => {
  const saved = {};
  const KEYS = ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'NEXT_PUBLIC_BASE_URL', 'LINKEDIN_REDIRECT_URI', 'FRONTEND_BASE_URL'];

  beforeAll(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of KEYS) delete process.env[key];
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
  });

  test('redirects non-GET requests back to the network page with an error', async () => {
    const req = createCallbackReq({ method: 'POST' });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirectTarget.startsWith(`${NETWORK}?error=`)).toBe(true);
  });

  test('redirects with an error when LinkedIn reports one', async () => {
    const req = createCallbackReq({ query: { error: 'access_denied', error_description: 'User denied access' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectTarget.startsWith(`${NETWORK}?error=`)).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('redirects with an error when no authorization code is received', async () => {
    const req = createCallbackReq({ query: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectTarget.startsWith(`${NETWORK}?error=`)).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rejects a callback whose state does not match the cookie (CSRF)', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'id';
    process.env.LINKEDIN_CLIENT_SECRET = 'secret';
    const req = createCallbackReq({ query: { code: 'auth-code', state: 'from-attacker' }, cookies: { linkedin_auth_state: 'real' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectTarget.startsWith(`${NETWORK}?error=`)).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('redirects with an error when LinkedIn credentials are missing', async () => {
    const req = createCallbackReq({ query: { code: 'auth-code', state: 's1' }, cookies: { linkedin_auth_state: 's1' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectTarget.startsWith(`${NETWORK}?error=`)).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('exchanges the code, sets cookies and redirects with the success flag', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';

    axios.post.mockResolvedValueOnce({ data: { access_token: 'linkedin-access-token', expires_in: 7200 } });
    axios.get.mockResolvedValueOnce({ data: { sub: 'linkedin-user', name: 'Ada Lovelace' } });

    const req = createCallbackReq({ query: { code: 'auth-code', state: 's1' }, cookies: { linkedin_auth_state: 's1' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [tokenUrl, , tokenOptions] = axios.post.mock.calls[0];
    expect(tokenUrl).toBe('https://www.linkedin.com/oauth/v2/accessToken');
    expect(tokenOptions.params).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code',
      client_id: 'linkedin-client-id',
      client_secret: 'linkedin-client-secret',
    });
    expect(tokenOptions.params.redirect_uri).toMatch(/\/api\/auth\/linkedin\/callback$/);
    expect(tokenOptions.timeout).toBeGreaterThan(0);

    expect(axios.get).toHaveBeenCalledWith('https://api.linkedin.com/v2/userinfo', expect.objectContaining({
      headers: { Authorization: 'Bearer linkedin-access-token' },
    }));

    const cookies = res.headers['Set-Cookie'];
    expect(cookies[0]).toMatch(/^linkedin_access_token=linkedin-access-token; Path=\/; Max-Age=7200; HttpOnly; SameSite=Lax/);
    expect(cookies[1]).toMatch(/^linkedin_user_id=linkedin-user; Path=\/; Max-Age=7200; SameSite=Lax/);
    expect(cookies).toContain('linkedin_auth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    expect(res.redirectTarget).toBe(`${NETWORK}?auth=linkedin_success`);
  });

  test('redirects with an error when the token exchange fails', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret';
    axios.post.mockRejectedValueOnce({ response: { data: { error_description: 'Invalid authorization code' } } });

    const req = createCallbackReq({ query: { code: 'bad-code', state: 's1' }, cookies: { linkedin_auth_state: 's1' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectTarget.startsWith(`${NETWORK}?error=`)).toBe(true);
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });
});
