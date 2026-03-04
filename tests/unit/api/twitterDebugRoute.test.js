const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/twitter/debug').default;

describe('/api/auth/twitter/debug', () => {
  const originalEnv = {
    TWITTER_CLIENT_ID: process.env.TWITTER_CLIENT_ID,
    TWITTER_API_KEY: process.env.TWITTER_API_KEY,
    TWITTER_CLIENT_SECRET: process.env.TWITTER_CLIENT_SECRET,
    TWITTER_REDIRECT_URI: process.env.TWITTER_REDIRECT_URI,
    NEXT_PUBLIC_TWITTER_CLIENT_ID: process.env.NEXT_PUBLIC_TWITTER_CLIENT_ID,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    delete process.env.TWITTER_CLIENT_ID;
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_CLIENT_SECRET;
    delete process.env.TWITTER_REDIRECT_URI;
    delete process.env.NEXT_PUBLIC_TWITTER_CLIENT_ID;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  test('returns 405 for non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns masked configuration and auth-state diagnostics', async () => {
    process.env.TWITTER_CLIENT_ID = 'abcde12345';
    process.env.TWITTER_CLIENT_SECRET = 'secret-value';
    process.env.TWITTER_REDIRECT_URI = 'https://example.com/api/auth/twitter/callback';
    process.env.NEXT_PUBLIC_TWITTER_CLIENT_ID = 'public-client-id';

    const req = createMockReq({
      method: 'GET',
      headers: {
        cookie: [
          'twitter_access_token=token',
          'twitter_refresh_token=refresh',
          'twitter_code_verifier=verifier',
          'twitter_auth_state=state',
          'twitter_error=bad_token',
        ].join('; '),
      },
      query: {
        error: 'invalid_client_id',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      environment: {
        hasClientId: true,
        hasClientSecret: true,
        hasRedirectUri: true,
        hasPublicClientId: true,
        mode: 'test',
      },
      oauthConfig: {
        configuredRedirectUri: 'https://example.com/api/auth/twitter/callback',
        clientId: 'abcde...',
      },
      authState: {
        hasTwitterAccessToken: true,
        hasTwitterRefreshToken: true,
        hasTwitterCodeVerifier: true,
        hasTwitterAuthState: true,
        recentError: 'bad_token',
      },
      troubleshooting: {
        suggestions: [
          'Recent Twitter error detected: bad_token',
          'Client ID error detected in URL. Make sure your TWITTER_CLIENT_ID is correct and matches the one in your Twitter Developer Portal',
        ],
        tips: expect.any(Array),
      },
    });
    expect(res.body.troubleshooting.tips).toHaveLength(5);
  });

  test('returns safe defaults and guidance when env is missing', async () => {
    const req = createMockReq({ method: 'GET', headers: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.environment).toEqual({
      hasClientId: false,
      hasClientSecret: false,
      hasRedirectUri: false,
      hasPublicClientId: false,
      mode: 'test',
    });
    expect(res.body.oauthConfig).toEqual({
      configuredRedirectUri: 'http://localhost:3000/api/auth/twitter/callback',
      clientId: null,
    });
    expect(res.body.authState).toEqual({
      hasTwitterAccessToken: false,
      hasTwitterRefreshToken: false,
      hasTwitterCodeVerifier: false,
      hasTwitterAuthState: false,
      recentError: null,
    });
    expect(res.body.troubleshooting.suggestions).toEqual([
      'Missing Twitter Client ID: Add TWITTER_CLIENT_ID to your .env.local file',
      'Missing Twitter Client Secret: Add TWITTER_CLIENT_SECRET to your .env.local file',
      'Consider adding TWITTER_REDIRECT_URI to your .env.local file for explicit configuration',
    ]);
  });
});
