/**
 * LinkedIn OAuth callback handler
 * This endpoint receives the authorization code from LinkedIn and exchanges it for access token
 */
import axios from 'axios';
import { getCallbackUrl } from '../../../../utils/oauthUtils';
import { fetchLinkedInProfile } from '../../../../utils/linkedinProfile';

const LINKEDIN_CALLBACK_TIMEOUT_MS = 10000;

function getNetworkRedirectBase(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const requestBase = host ? `${proto}://${host}` : '';
  const isLocalHost = /localhost|127\.0\.0\.1/.test(String(host || ''));
  if (isLocalHost) return requestBase;
  // Always return to the host the user came from: a configured base URL on
  // another (possibly retired) domain would strand them there.
  if (requestBase) return requestBase;
  return process.env.FRONTEND_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || '';
}

export default async function handler(req, res) {
  const networkBase = getNetworkRedirectBase(req);
  const redirectToNetwork = (query = '') => {
    const suffix = query ? `?${query}` : '';
    return res.redirect(`${networkBase}/network${suffix}`);
  };

  if (req.method && req.method !== 'GET') {
    return redirectToNetwork('error=Method%20not%20allowed');
  }

  const { code, state, error } = req.query;

  // Handle error from LinkedIn (the page maps these codes to user copy)
  if (error) {
    console.error(`LinkedIn sign-in failed: ${String(error).slice(0, 80)}`);
    return redirectToNetwork(error === 'user_cancelled_login' || error === 'user_cancelled_authorize' || error === 'access_denied'
      ? 'error=linkedin_denied' : 'error=linkedin_failed');
  }

  if (!code) {
    return redirectToNetwork('error=linkedin_failed');
  }

  // CSRF check: state must match the one set when sign-in started.
  const storedState = req.cookies?.linkedin_auth_state;
  if (!storedState || state !== storedState) {
    return redirectToNetwork('error=linkedin_state');
  }

  try {
    // Determine the redirect URI - must exactly match what's registered in LinkedIn Developer Console
    // Use environment variable with fallback
    const redirectUri = getCallbackUrl('linkedin', req);
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
      console.error('LinkedIn sign-in callback but LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET are not set');
      return redirectToNetwork('error=linkedin_not_configured');
    }

    // Exchange authorization code for access token
    const tokenResponse = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      null,
      {
        params: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: LINKEDIN_CALLBACK_TIMEOUT_MS,
      }
    );

    const { access_token, expires_in } = tokenResponse.data;

    // Fetch basic profile information
    const profile = await fetchLinkedInProfile(access_token, LINKEDIN_CALLBACK_TIMEOUT_MS);

    // Set cookies with token and expiration
    // HttpOnly cookie to prevent client-side access to the token
    const maxAge = expires_in * 1000; // Convert to milliseconds
    res.setHeader('Set-Cookie', [
      `linkedin_access_token=${access_token}; Path=/; Max-Age=${expires_in}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
      `linkedin_user_id=${encodeURIComponent(profile.id)}; Path=/; Max-Age=${expires_in}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
      `linkedin_auth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
    ]);

    // Redirect back to the network page with success flag
    // This will trigger the useEffect in network.js to fetch user data
    return redirectToNetwork('auth=linkedin_success');
  } catch (error) {
    console.error(`LinkedIn token exchange failed: ${error.response?.status || ''} ${String(error.response?.data?.error_description || error.message || '').slice(0, 120)}`);
    return redirectToNetwork('error=linkedin_failed');
  }
}
