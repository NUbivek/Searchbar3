import handler from '../../../src/pages/api/auth/linkedin/index';

jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(() => 'https://app.example.com/api/auth/linkedin/callback'),
}));

import { getCallbackUrl } from '../../../src/utils/oauthUtils';

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end(payload) {
      this.body = payload;
      return this;
    },
    redirect(url) {
      this.statusCode = 302;
      this.headers.Location = url;
      return this;
    },
  };
}

describe('/api/auth/linkedin init route', () => {
  const originalClientId = process.env.LINKEDIN_CLIENT_ID;

  afterEach(() => {
    if (originalClientId === undefined) {
      delete process.env.LINKEDIN_CLIENT_ID;
    } else {
      process.env.LINKEDIN_CLIENT_ID = originalClientId;
    }
    jest.clearAllMocks();
  });

  it('returns fail-soft payload when LinkedIn client id is missing', async () => {
    delete process.env.LINKEDIN_CLIENT_ID;
    const req = { method: 'GET' };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Configuration error',
      details: 'LinkedIn client ID is not configured.',
      degradedSources: ['linkedin-auth'],
    });
  });

  it('sets state cookie and redirects to LinkedIn auth url', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client';
    const req = { method: 'GET' };
    const res = createRes();

    await handler(req, res);

    expect(getCallbackUrl).toHaveBeenCalledWith('linkedin');
    expect(res.statusCode).toBe(302);
    expect(res.headers['Set-Cookie']).toEqual(
      expect.stringContaining('linkedin_auth_state=')
    );
    expect(res.headers['Set-Cookie']).toEqual(expect.stringContaining('HttpOnly'));
    expect(res.headers['Set-Cookie']).toEqual(expect.stringContaining('SameSite=Lax'));

    const location = res.headers.Location;
    expect(location).toBeTruthy();
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('linkedin-client');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/auth/linkedin/callback'
    );
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBeTruthy();
  });
});
