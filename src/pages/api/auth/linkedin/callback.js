/**
 * LinkedIn OAuth callback handler
 * This endpoint receives the authorization code from LinkedIn and exchanges it for access token
 */
import axios from 'axios';

const LINKEDIN_CALLBACK_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  const { code, state, error, error_description } = req.query;
  console.log('LinkedIn callback received:', { code: !!code, state, error, error_description });

  // Handle error from LinkedIn
  if (error) {
    console.error('LinkedIn auth error:', error, error_description);
    return res.redirect(`/network?error=${encodeURIComponent(error_description || 'Authentication failed')}`);
  }

  if (!code) {
    return res.redirect('/network?error=No authorization code received');
  }

  try {
    // Determine the redirect URI - must exactly match what's registered in LinkedIn Developer Console
    // Use environment variable with fallback
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3001';
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI || `${baseUrl}/api/auth/linkedin/callback`;
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
      console.error('LinkedIn credentials missing from environment variables');
      return res.redirect('/network?error=LinkedIn API credentials not configured');
    }

    console.log('Exchanging code for token with redirectUri:', redirectUri);
    
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
    console.log('LinkedIn token obtained successfully');

    // Fetch basic profile information
    const profileResponse = await axios.get('https://api.linkedin.com/v2/me', {
      headers: {
        Authorization: `Bearer ${access_token}`
      },
      timeout: LINKEDIN_CALLBACK_TIMEOUT_MS,
    });
    
    console.log('LinkedIn profile fetched successfully');

    // Set cookies with token and expiration
    // HttpOnly cookie to prevent client-side access to the token
    const maxAge = expires_in * 1000; // Convert to milliseconds
    res.setHeader('Set-Cookie', [
      `linkedin_access_token=${access_token}; Path=/; Max-Age=${expires_in}; HttpOnly; SameSite=Lax`,
      `linkedin_user_id=${profileResponse.data.id}; Path=/; Max-Age=${expires_in}; SameSite=Lax`
    ]);

    // Redirect back to the network page with success flag
    // This will trigger the useEffect in network.js to fetch user data
    return res.redirect('/network?auth=linkedin_success');
  } catch (error) {
    console.error('LinkedIn token exchange error:', error.response?.data || error.message);
    const errorDetails = error.response?.data?.error_description || error.message || 'Unknown error';
    return res.redirect(`/network?error=${encodeURIComponent('Failed to authenticate with LinkedIn: ' + errorDetails)}`);
  }
}
