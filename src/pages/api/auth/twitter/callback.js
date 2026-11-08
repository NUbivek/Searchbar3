/**
 * Twitter OAuth callback handler
 * This endpoint receives the authorization code from Twitter (X) and exchanges it for an access token
 */

import axios from 'axios';
import { parse } from 'cookie';
import { serialize } from 'cookie';
import { getCallbackUrl } from '../../../../utils/oauthUtils';

const TWITTER_CALLBACK_TIMEOUT_MS = 10000;

function getNetworkRedirectBase(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const requestBase = host ? `${proto}://${host}` : '';
  const isLocalHost = /localhost|127\.0\.0\.1/.test(String(host || ''));
  if (isLocalHost) return requestBase;
  return process.env.FRONTEND_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || requestBase;
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

  // Handle error from Twitter (the page maps these codes to user copy)
  if (error) {
    console.error(`X sign-in failed: ${String(error).slice(0, 80)}`);
    return redirectToNetwork(error === 'access_denied' ? 'error=twitter_denied' : 'error=twitter_failed');
  }

  // Validate the code parameter
  if (!code) {
    return redirectToNetwork('error=twitter_failed');
  }
  
  // Verify state parameter to prevent CSRF attacks
  const cookies = parse(req.headers.cookie || '');
  const storedState = cookies.twitter_auth_state;
  
  if (!storedState || state !== storedState) {
    return redirectToNetwork('error=twitter_state');
  }
  
  try {
    // Get the code verifier (used for PKCE)
    // Already parsed cookies above
    const codeVerifier = cookies.twitter_code_verifier;
    if (!codeVerifier) {
      return redirectToNetwork('error=twitter_expired');
    }
    
    // Get configuration from environment variables
    const clientId = process.env.TWITTER_CLIENT_ID;
    const clientSecret = process.env.TWITTER_CLIENT_SECRET;
    const redirectUri = getCallbackUrl('twitter', req);
    
    if (!clientId) {
      console.error('X sign-in callback but TWITTER_CLIENT_ID is not set');
      return redirectToNetwork('error=twitter_not_configured');
    }
    
    // Exchange the authorization code for an access token
    const tokenResponse = await axios.post(
      'https://api.twitter.com/2/oauth2/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        client_id: clientId
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Include Basic Auth if client secret is available
          ...(clientSecret && {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
          })
        },
        timeout: TWITTER_CALLBACK_TIMEOUT_MS,
      }
    );
    
    // Set access token and refresh token in cookies
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    
    // Cookie options - secure in production
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: expires_in, // cookie.serialize takes seconds
      path: '/'
    };
    
    // Set cookies with the tokens
    res.setHeader('Set-Cookie', [
      serialize('twitter_access_token', access_token, cookieOptions),
      serialize('twitter_refresh_token', refresh_token, {
        ...cookieOptions,
        // Refresh token typically lives longer
        maxAge: 30 * 24 * 60 * 60 // 30 days, in seconds
      }),
      // One-time PKCE/state values are spent; clear them.
      serialize('twitter_auth_state', '', { ...cookieOptions, maxAge: 0 }),
      serialize('twitter_code_verifier', '', { ...cookieOptions, maxAge: 0 })
    ]);
    
    // Redirect back to the network page with success flag
    return redirectToNetwork('auth=twitter_success');
  } catch (error) {
    console.error(`X token exchange failed: ${error.response?.status || ''} ${String(error.response?.data?.error_description || error.message || '').slice(0, 120)}`);
    return redirectToNetwork('error=twitter_failed');
  }
}
