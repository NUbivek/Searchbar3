/**
 * LinkedIn OAuth2 Authentication - Initiation endpoint
 */
import { getCallbackUrl } from '../../../../utils/oauthUtils';

export default function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get LinkedIn client ID from environment variables
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  
  // Get the callback URL using our utility function
  const redirectUri = getCallbackUrl('linkedin');
  
  // Validate required parameters
  if (!clientId) {
    console.error('LinkedIn client ID is missing. Check your .env.local file.');
    return res.status(200).json({
      status: 'fail-soft',
      error: 'Configuration error',
      details: 'LinkedIn client ID is not configured.',
      degradedSources: ['linkedin-auth']
    });
  }
  
  // Define scopes for requested data - only using officially supported ones
  const scope = [
    'r_emailaddress',
    'r_liteprofile'
  ].join(' ');
  
  // State parameter to prevent CSRF attacks
  const state = Math.random().toString(36).substring(2, 15);
  
  // Store state in session/cookie for validation on callback
  // In a production app, you would use a proper session mechanism
  res.setHeader('Set-Cookie', `linkedin_auth_state=${state}; Path=/; HttpOnly; SameSite=Lax`);
  
  // Print debug information to server logs
  console.log('LinkedIn OAuth Parameters:', {
    clientId,
    redirectUri,
    scope,
    state
  });
  
  // Construct the LinkedIn authorization URL
  const authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', clientId);
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('scope', scope);
  
  // Final URL for debugging
  const finalUrl = authUrl.toString();
  console.log('LinkedIn OAuth URL:', finalUrl);
  
  // Redirect the user to LinkedIn's authorization page
  res.redirect(finalUrl);
}
