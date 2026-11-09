/**
 * Twitter OAuth2 Authentication - Initiation endpoint
 */
import crypto from 'crypto';
import { getCallbackUrl } from '../../../../utils/oauthUtils';

export default function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // OAuth 2.0 Client ID from the X developer portal (not the v1.1 API key)
  const clientId = process.env.TWITTER_CLIENT_ID;
  
  // Not configured on this deployment: the page maps the code to user copy.
  if (!clientId) {
    console.error('X sign-in requested but TWITTER_CLIENT_ID is not set');
    return res.redirect('/network?error=twitter_not_configured');
  }
  
  // Define the redirect URI using the utility function
  const redirectUri = getCallbackUrl('twitter', req);
  
  // Define scopes for requested data
  const scope = [
    'tweet.read',
    'users.read', 
    'follows.read',
    'offline.access'
  ].join(' ');
  
  // State parameter to prevent CSRF attacks
  const state = crypto.randomBytes(16).toString('hex');
  
  // PKCE (RFC 7636): random 43+ char verifier, S256 challenge
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const codeChallengeMethod = 'S256';
  
  // Store state and code verifier in session/cookie for validation on callback
  res.setHeader('Set-Cookie', [
    // Short-lived: only needed until the callback (10 minutes).
    `twitter_auth_state=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    `twitter_code_verifier=${codeVerifier}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
  ]);
  
  // Construct the Twitter authorization URL
  const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', clientId);
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('scope', scope);
  authUrl.searchParams.append('code_challenge', codeChallenge);
  authUrl.searchParams.append('code_challenge_method', codeChallengeMethod);
  
  // Redirect the user to Twitter's authorization page
  res.redirect(authUrl.toString());
}
