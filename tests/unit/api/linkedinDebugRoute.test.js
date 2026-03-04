const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/linkedin/debug').default;

describe('/api/auth/linkedin/debug', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    LINKEDIN_CLIENT_ID: process.env.LINKEDIN_CLIENT_ID,
    NEXT_PUBLIC_LINKEDIN_CLIENT_ID: process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID,
    LINKEDIN_CLIENT_SECRET: process.env.LINKEDIN_CLIENT_SECRET,
    LINKEDIN_REDIRECT_URI: process.env.LINKEDIN_REDIRECT_URI,
    NEXT_PUBLIC_LINKEDIN_REDIRECT_URI: process.env.NEXT_PUBLIC_LINKEDIN_REDIRECT_URI,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
    delete process.env.LINKEDIN_REDIRECT_URI;
    delete process.env.NEXT_PUBLIC_LINKEDIN_REDIRECT_URI;
    delete process.env.NEXT_PUBLIC_APP_URL;
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

  test('returns 405 for non-GET requests', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns diagnostic suggestions when linkedin config is missing', () => {
    const req = createMockReq({
      headers: {
        host: 'localhost:3000',
      },
    });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.environment).toMatchObject({
      nodeEnv: 'test',
      hasClientId: false,
      hasClientSecret: false,
      clientId: 'Not configured',
      clientIdLength: 0,
    });
    expect(res.body.request).toMatchObject({
      host: 'localhost:3000',
      protocol: 'http',
      baseUrl: 'http://localhost:3000',
    });
    expect(res.body.oauthConfig.configuredRedirectUri).toBe(
      'http://localhost:3000/api/auth/linkedin/callback'
    );
    expect(res.body.troubleshooting.suggestions).toEqual(
      expect.arrayContaining([
        'LinkedIn Client ID is missing. Add LINKEDIN_CLIENT_ID to your .env.local file.',
        'LinkedIn Client Secret is missing. Add LINKEDIN_CLIENT_SECRET to your .env.local file.',
        'Frontend is using hardcoded LinkedIn Client ID. Add NEXT_PUBLIC_LINKEDIN_CLIENT_ID to your .env.local file.',
        'Frontend is using hardcoded redirect URI. Add NEXT_PUBLIC_LINKEDIN_REDIRECT_URI to your .env.local file.',
      ])
    );
  });

  test('reports configured state and auth cookie mismatches', () => {
    process.env.LINKEDIN_CLIENT_ID = 'abcd1234wxyz9876';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-secret';
    process.env.LINKEDIN_REDIRECT_URI = 'https://app.example.com/api/auth/linkedin/callback';
    process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID = 'public-client-id';
    process.env.NEXT_PUBLIC_LINKEDIN_REDIRECT_URI = 'https://app.example.com/api/auth/linkedin/callback';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

    const req = createMockReq({
      headers: {
        host: 'app.example.com',
        referer: 'https://app.example.com/network',
        origin: 'https://app.example.com',
        'x-forwarded-proto': 'https',
      },
      cookies: {
        linkedin_access_token: 'token-123456',
      },
    });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.environment).toMatchObject({
      hasClientId: true,
      hasClientSecret: true,
      clientId: 'abcd...9876',
      clientIdLength: 16,
    });
    expect(res.body.oauthConfig).toMatchObject({
      configuredRedirectUri: 'https://app.example.com/api/auth/linkedin/callback',
      frontendConfig: {
        usesHardcodedClientId: false,
        usesHardcodedRedirectUri: false,
      },
    });
    expect(res.body.authState).toEqual({
      hasLinkedInToken: true,
      hasLinkedInUserId: false,
      tokenLength: 12,
    });
    expect(res.body.troubleshooting.suggestions).toEqual(
      expect.arrayContaining([
        'LinkedIn access token exists but user ID cookie is missing. This may indicate an issue with the token exchange process.',
      ])
    );
  });
});
