import { getCallbackUrl } from '../../../../utils/oauthUtils';

export default function handler(req, res) {
  const clientId = process.env.REDDIT_CLIENT_ID;

  if (!clientId) {
    return res.status(200).json({
      status: 'fail-soft',
      error: 'Configuration error',
      details: 'REDDIT_CLIENT_ID is not configured.',
      degradedSources: ['reddit-auth']
    });
  }

  const redirectUri = process.env.REDDIT_REDIRECT_URI || getCallbackUrl('reddit');
  const state = Math.random().toString(36).slice(2);

  res.setHeader('Set-Cookie', `reddit_auth_state=${state}; Path=/; HttpOnly; SameSite=Lax`);

  const authUrl = new URL('https://www.reddit.com/api/v1/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('duration', 'permanent');
  authUrl.searchParams.set('scope', 'identity read');

  res.redirect(authUrl.toString());
}
