jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(),
}));

const { getCallbackUrl } = require('../../../src/utils/oauthUtils');
const handler = require('../../../src/pages/api/auth/linkedin/index').default;

function createRes() {
  return {
    status: jest.fn(function status(code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function json(payload) {
      this.body = payload;
      return this;
    }),
    setHeader: jest.fn(),
    redirect: jest.fn(),
  };
}

describe('/api/auth/linkedin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('redirects to /network with a configuration error when LINKEDIN_CLIENT_ID is missing', () => {
    delete process.env.LINKEDIN_CLIENT_ID;
    getCallbackUrl.mockReturnValue('https://app.example.com/api/auth/linkedin/token');

    const res = createRes();

    handler({ method: 'GET' }, res);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=' +
        encodeURIComponent(
          'LinkedIn is not configured yet: add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to .env.local and restart the dev server.'
        )
    );
    expect(res.json).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('sets auth state cookie and redirects to LinkedIn oauth url', () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    getCallbackUrl.mockReturnValue('https://app.example.com/api/auth/linkedin/token');

    const res = createRes();

    handler({ method: 'GET' }, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('linkedin_auth_state=')
    );
    expect(res.redirect).toHaveBeenCalledTimes(1);

    const redirectUrl = res.redirect.mock.calls[0][0];

    expect(redirectUrl).toContain('https://www.linkedin.com/oauth/v2/authorization?');
    expect(redirectUrl).toContain('response_type=code');
    expect(redirectUrl).toContain('client_id=linkedin-client-id');
    expect(redirectUrl).toContain(
      encodeURIComponent('https://app.example.com/api/auth/linkedin/token')
    );
    expect(redirectUrl).toContain('scope=openid+profile+email');
    expect(redirectUrl).toContain('state=');
  });
});
