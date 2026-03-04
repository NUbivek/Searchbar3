import axios from 'axios';
import { parse, serialize } from 'cookie';

const REDDIT_AUTH_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.redirect('/network?error=Method%20not%20allowed');
  }

  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/network?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect('/network?error=No authorization code received from Reddit');
  }

  const cookies = parse(req.headers.cookie || '');
  const storedState = cookies.reddit_auth_state;
  if (storedState && state !== storedState) {
    return res.redirect('/network?error=Invalid Reddit OAuth state');
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const redirectUri = process.env.REDDIT_REDIRECT_URI || process.env.NEXT_PUBLIC_BASE_URL + '/api/auth/reddit/callback';

  if (!clientId || !clientSecret) {
    return res.redirect('/network?error=Missing Reddit client credentials');
  }

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await axios.post(
      'https://www.reddit.com/api/v1/access_token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'searchbar/1.0'
        },
        timeout: REDDIT_AUTH_TIMEOUT_MS,
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const baseCookie = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/'
    };

    res.setHeader('Set-Cookie', [
      serialize('reddit_access_token', access_token || '', { ...baseCookie, maxAge: expires_in || 3600 }),
      serialize('reddit_refresh_token', refresh_token || '', { ...baseCookie, maxAge: 30 * 24 * 60 * 60 })
    ]);

    return res.redirect('/network?auth=reddit_success');
  } catch (e) {
    const msg = e.response?.data?.error || e.message;
    return res.redirect(`/network?error=${encodeURIComponent(`Reddit token exchange failed: ${msg}`)}`);
  }
}
