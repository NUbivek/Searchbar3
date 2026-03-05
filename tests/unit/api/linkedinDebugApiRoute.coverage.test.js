const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/linkedin/debug').default;

describe('/api/auth/linkedin/debug', () => {
  const ORIGINAL_ENV = {
    LINKEDIN_CLIENT_ID: process.env.LINKEDIN_CLIENT_ID,
    LINKEDIN_CLIENT_SECRET: process.env.LINKEDIN_CLIENT_SECRET,
    LINKEDIN_REDIRECT_URI: process.env.LINKEDIN_REDIRECT_URI,
    NEXT_PUBLIC_LINKEDIN_REDIRECT_URI: process.env.NEXT_PUBLIC_LINKEDIN_REDIRECT_URI,
    NEXT_PUBLIC_LINKEDIN_CLIENT_ID: process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id-12345';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret';
    process.env.LINKEDIN_REDIRECT_URI = 'https://app.example.com/api/auth/linkedin/callback';
    process.env.NEXT_PUBLIC_LINKEDIN_REDIRECT_URI = 'https://app.example.com/api/auth/linkedin/callback';
    process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID = 'public-linkedin-client';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
  });

  afterAll(() => {
    Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  it('returns config payload with expected top-level sections', async () => {
    const req = createMockReq({
      headers: {
        host: 'localhost:3000',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('environment');
    expect(res.body).toHaveProperty('request');
    expect(res.body).toHaveProperty('oauthConfig');
    expect(res.body).toHaveProperty('troubleshooting');
    expect(res.body.environment.nodeEnv).toBe('test');
    expect(res.body.environment.hasClientId).toBe(true);
    expect(res.body.environment.hasClientSecret).toBe(true);
    expect(res.body.oauthConfig.configuredRedirectUri).toBe(
      'https://app.example.com/api/auth/linkedin/callback'
    );
    expect(Array.isArray(res.body.troubleshooting.suggestions)).toBe(true);
  });

  it('derives baseUrl from forwarded headers and exposes candidate redirect URIs', async () => {
    const req = createMockReq({
      headers: {
        host: 'internal-host',
        'x-forwarded-host': 'airesearch.bivek.ai',
        'x-forwarded-proto': 'https',
        origin: 'https://airesearch.bivek.ai',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.request.host).toBe('internal-host');
    expect(res.body.request.protocol).toBe('https');
    expect(res.body.request.baseUrl).toBe('https://internal-host');
    expect(Array.isArray(res.body.oauthConfig.possibleRedirectUris)).toBe(true);
    expect(
      res.body.oauthConfig.possibleRedirectUris.some((uri) =>
        uri.includes('/api/auth/linkedin/callback')
      )
    ).toBe(true);
  });

  it('includes authState details when linkedin cookies are present', async () => {
    const req = createMockReq({
      headers: {
        host: 'localhost:3000',
      },
      cookies: {
        linkedin_access_token: 'token-123456789',
        linkedin_user_id: 'user-42',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('authState');
    expect(res.body.authState.hasLinkedInToken).toBe(true);
    expect(res.body.authState.hasLinkedInUserId).toBe(true);
    expect(res.body.authState.tokenLength).toBe('token-123456789'.length);
  });
});
