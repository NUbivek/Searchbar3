/**
 * Twitter OAuth2 Authentication - Initiation endpoint
 */
import { getCallbackUrl } from '../../../../utils/oauthUtils';

export default function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get Twitter API key from environment variables
  const clientId = process.env.TWITTER_API_KEY || process.env.TWITTER_CLIENT_ID;
  
  // Validate required parameters
  if (!clientId) {
    console.error('Twitter API key is missing. Check your .env.local file.');
    return res.status(200).json({
      status: 'fail-soft',
      error: 'Configuration error',
      details: 'Twitter API key is not configured.',
      degradedSources: ['twitter-auth']
    });
  }
  
  // Define the redirect URI using the utility function
  const redirectUri = getCallbackUrl('twitter');
  
  // Define scopes for requested data
  const scope = [
    'tweet.read',
    'users.read', 
    'follows.read',
    'offline.access'
  ].join(' ');
  
  // State parameter to prevent CSRF attacks
  const state = Math.random().toString(36).substring(2, 15);
  
  // Code challenge for PKCE (Proof Key for Code Exchange)
  // Generate a more complex code challenge with additional random characters
  const randomChars = Math.random().toString(36).substring(2, 10);
  const codeChallenge = `challenge${randomChars}`;
  const codeChallengeMethod = 'plain';
  
  // Store state and code verifier in session/cookie for validation on callback
  res.setHeader('Set-Cookie', [
    `twitter_auth_state=${state}; Path=/; HttpOnly; SameSite=Lax`,
    `twitter_code_verifier=${codeChallenge}; Path=/; HttpOnly; SameSite=Lax`
  ]);
  
  // Print debug information to server logs
  console.log('Twitter OAuth Parameters:', {
    clientId,
    redirectUri,
    scope,
    state,
    codeChallenge
  });
  
  // Construct the Twitter authorization URL
  const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', clientId);
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('scope', scope);
  authUrl.searchParams.append('code_challenge', codeChallenge);
  authUrl.searchParams.append('code_challenge_method', codeChallengeMethod);
  
  // Final URL for debugging
  const finalUrl = authUrl.toString();
  console.log('Twitter OAuth URL:', finalUrl);
  
  // Redirect the user to Twitter's authorization page
  res.redirect(finalUrl);
}
