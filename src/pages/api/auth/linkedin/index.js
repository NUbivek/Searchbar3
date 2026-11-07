/**
 * LinkedIn OAuth2 Authentication - Initiation endpoint
 */
import crypto from 'crypto';
import { getCallbackUrl } from '../../../../utils/oauthUtils';
import { LINKEDIN_SCOPES } from '../../../../utils/linkedinProfile';

export default function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get LinkedIn client ID from environment variables
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  
  // Get the callback URL using our utility function
  const redirectUri = getCallbackUrl('linkedin', req);
  
  // Validate required parameters
  if (!clientId) {
    console.error('LinkedIn client ID is missing. Check your .env.local file.');
    return res.redirect(`/network?error=${encodeURIComponent('LinkedIn is not configured yet: add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to .env.local and restart the dev server.')}`);
  }
  
  // Define scopes for requested data - only using officially supported ones
  const scope = LINKEDIN_SCOPES.join(' ');
  
  // State parameter to prevent CSRF attacks
  const state = crypto.randomBytes(16).toString('hex');
  
  // Store state in session/cookie for validation on callback
  // In a production app, you would use a proper session mechanism
  res.setHeader('Set-Cookie', `linkedin_auth_state=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  
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
