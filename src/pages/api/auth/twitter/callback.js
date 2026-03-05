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

  console.log('Twitter callback handler called', req.query);
  const { code, state, error, error_description } = req.query;

  // Handle error from Twitter
  if (error) {
    console.error('Twitter auth error:', error, error_description);
    return redirectToNetwork(`error=${encodeURIComponent(error_description || 'Authentication failed')}`);
  }

  // Validate the code parameter
  if (!code) {
    console.error('No authorization code received from Twitter');
    return redirectToNetwork('error=No authorization code received');
  }
  
  // Verify state parameter to prevent CSRF attacks
  const cookies = parse(req.headers.cookie || '');
  const storedState = cookies.twitter_auth_state;
  
  if (storedState && state !== storedState) {
    console.error('Invalid state parameter', { received: state, stored: storedState });
    return redirectToNetwork('error=Invalid state parameter');
  }
  
  try {
    // Get the code verifier (used for PKCE)
    // Already parsed cookies above
    const codeVerifier = cookies.twitter_code_verifier || `challenge${state.substring(0, 8)}`; // Use part of state as fallback
    
    // Get configuration from environment variables
    const clientId = process.env.TWITTER_CLIENT_ID || process.env.TWITTER_API_KEY;
    const clientSecret = process.env.TWITTER_CLIENT_SECRET;
    const redirectUri = getCallbackUrl('twitter', req);
    
    if (!clientId) {
      console.error('Missing Twitter client ID');
      return redirectToNetwork('error=Missing Twitter client configuration');
    }
    
    console.log('Exchanging code for token with Twitter', {
      clientId: clientId.substring(0, 5) + '...',
      redirectUri,
      codeLength: code.length
    });
    
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
    
    console.log('Twitter token exchange successful');
    
    // Set access token and refresh token in cookies
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    
    // Cookie options - secure in production
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: expires_in * 1000, // Convert seconds to milliseconds
      path: '/'
    };
    
    // Set cookies with the tokens
    res.setHeader('Set-Cookie', [
      serialize('twitter_access_token', access_token, cookieOptions),
      serialize('twitter_refresh_token', refresh_token, {
        ...cookieOptions,
        // Refresh token typically lives longer
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      })
    ]);
    
    // Redirect back to the network page with success flag
    return redirectToNetwork('auth=twitter_success');
  } catch (error) {
    console.error('Error in Twitter token exchange:', error.response?.data || error.message);
    
    // Provide a more specific error message
    let errorMessage = 'Failed to complete Twitter authentication';
    
    if (error.response) {
      // Handle specific API error responses
      const statusCode = error.response.status;
      const errorData = error.response.data;
      
      if (statusCode === 400) {
        errorMessage = 'Invalid request to Twitter: ' + (errorData.error_description || 'Bad Request');
      } else if (statusCode === 401) {
        errorMessage = 'Twitter authentication failed: ' + (errorData.error_description || 'Unauthorized');
      } else if (statusCode === 403) {
        errorMessage = 'Twitter access forbidden: ' + (errorData.error_description || 'Access Denied');
      }
    }
    
    return redirectToNetwork(`error=${encodeURIComponent(errorMessage)}`);
  }
}
