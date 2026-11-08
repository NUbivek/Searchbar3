/**
 * LinkedIn token exchange API endpoint
 * Exchanges authorization code for access token and checks token validity
 */

import axios from 'axios';
import { getCallbackUrl } from '../../../../utils/oauthUtils';
import { fetchLinkedInProfile } from '../../../../utils/linkedinProfile';

const LINKEDIN_AUTH_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  // Handle GET requests to check authentication status
  if (req.method === 'GET') {
    const { cookies } = req;
    const accessToken = cookies.linkedin_access_token;
    // Lets the page hide "Connect profile" when sign-in is not set up here.
    const configured = Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
    
    if (!accessToken) {
      return res.status(200).json({ isAuthenticated: false, configured });
    }
    
    try {
      // Verify the token is still valid by making a simple API call
      const profile = await fetchLinkedInProfile(accessToken, LINKEDIN_AUTH_TIMEOUT_MS);
      return res.status(200).json({ 
        isAuthenticated: true,
        configured,
        provider: 'linkedin',
        user: {
          id: profile.id,
          firstName: profile.firstName,
          lastName: profile.lastName
        }
      });
    } catch (error) {
      console.error(`LinkedIn token validation failed: ${String(error.message || '').slice(0, 120)}`);
      // If token is invalid, clear the cookie
      res.setHeader('Set-Cookie', [
        'linkedin_access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        'linkedin_user_id=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
      ]);
      return res.status(200).json({ isAuthenticated: false, configured, error: 'Token invalid or expired' });
    }
  }
  
  // Handle POST requests for token exchange
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code is required' });
  }

  // Use environment variable with fallback
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = getCallbackUrl('linkedin', req);

  if (!clientId || !clientSecret) {
    console.error('LinkedIn token exchange requested but LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET are not set');
    return res.status(200).json({
      status: 'fail-soft',
      error: 'LinkedIn API credentials not configured',
      degradedSources: ['linkedin-auth-token']
    });
  }

  try {
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
          client_secret: clientSecret,
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: LINKEDIN_AUTH_TIMEOUT_MS,
      }
    );

    const { access_token, expires_in } = tokenResponse.data;
    
    // Get user profile information
    const profile = await fetchLinkedInProfile(access_token, LINKEDIN_AUTH_TIMEOUT_MS);

    // Create user data object for response
    const userData = {
      profile: {
        id: profile.id,
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email
      },
      accessToken: access_token,
      expiresIn: expires_in,
    };

    // Set cookies first to ensure they're set even if client doesn't handle the response properly
    const maxAge = expires_in * 1000; // Convert to milliseconds
    res.setHeader('Set-Cookie', [
      `linkedin_access_token=${access_token}; Path=/; Max-Age=${expires_in}; HttpOnly; SameSite=Lax`,
      `linkedin_user_id=${encodeURIComponent(profile.id)}; Path=/; Max-Age=${expires_in}; SameSite=Lax`
    ]);

    // Return success response with user data
    return res.status(200).json({
      success: true,
      ...userData,
    });
  } catch (error) {
    const errorDetails = error.response?.data?.error_description || error.message || 'Unknown error';
    console.error(`LinkedIn token exchange failed: ${String(errorDetails).slice(0, 120)}`);
    return res.status(200).json({
      status: 'fail-soft',
      error: 'Failed to exchange LinkedIn authorization code',
      details: errorDetails,
      degradedSources: ['linkedin-auth-token']
    });
  }
}
