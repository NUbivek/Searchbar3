/**
 * LinkedIn token exchange API endpoint
 * Exchanges authorization code for access token and checks token validity
 */

import axios from 'axios';
import { getCallbackUrl } from '../../../../utils/oauthUtils';

const LINKEDIN_AUTH_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  // Handle GET requests to check authentication status
  if (req.method === 'GET') {
    const { cookies } = req;
    const accessToken = cookies.linkedin_access_token;
    
    if (!accessToken) {
      return res.status(200).json({ isAuthenticated: false });
    }
    
    try {
      console.log('Validating LinkedIn token from cookies');
      // Verify the token is still valid by making a simple API call
      const profileResponse = await axios.get('https://api.linkedin.com/v2/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        timeout: LINKEDIN_AUTH_TIMEOUT_MS,
      });
      
      console.log('LinkedIn token is valid, user:', profileResponse.data.localizedFirstName);
      return res.status(200).json({ 
        isAuthenticated: true,
        provider: 'linkedin',
        user: {
          id: profileResponse.data.id,
          firstName: profileResponse.data.localizedFirstName,
          lastName: profileResponse.data.localizedLastName
        }
      });
    } catch (error) {
      console.error('LinkedIn token validation error:', error.message);
      // If token is invalid, clear the cookie
      res.setHeader('Set-Cookie', [
        'linkedin_access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        'linkedin_user_id=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
      ]);
      return res.status(200).json({ isAuthenticated: false, error: 'Token invalid or expired' });
    }
  }
  
  // Handle POST requests for token exchange
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code } = req.body;

  if (!code) {
    console.error('No authorization code provided in request body');
    return res.status(400).json({ error: 'Authorization code is required' });
  }

  // Use environment variable with fallback
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = getCallbackUrl('linkedin', req);

  if (!clientId || !clientSecret) {
    console.error('LinkedIn credentials missing from environment variables');
    return res.status(200).json({
      status: 'fail-soft',
      error: 'LinkedIn API credentials not configured',
      degradedSources: ['linkedin-auth-token']
    });
  }

  try {
    console.log('Exchanging authorization code for LinkedIn token');
    
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

    console.log('Successfully obtained LinkedIn access token');
    const { access_token, expires_in } = tokenResponse.data;
    
    // Get user profile information
    const profileResponse = await axios.get('https://api.linkedin.com/v2/me', {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
      timeout: LINKEDIN_AUTH_TIMEOUT_MS,
    });

    // Get user email address (if we have the correct scope permissions)
    let email = null;
    try {
      const emailResponse = await axios.get('https://api.linkedin.com/v2/emailAddress?q=members&projection=(elements*(handle~))', {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
        timeout: LINKEDIN_AUTH_TIMEOUT_MS,
      });
      email = emailResponse.data?.elements?.[0]?.['handle~']?.emailAddress || null;
    } catch (emailError) {
      console.warn('Unable to fetch LinkedIn email (may require additional scope permissions):', emailError.message);
    }

    // Create user data object for response
    const userData = {
      profile: {
        id: profileResponse.data.id,
        firstName: profileResponse.data.localizedFirstName,
        lastName: profileResponse.data.localizedLastName,
        email
      },
      accessToken: access_token,
      expiresIn: expires_in,
    };

    // Set cookies first to ensure they're set even if client doesn't handle the response properly
    const maxAge = expires_in * 1000; // Convert to milliseconds
    res.setHeader('Set-Cookie', [
      `linkedin_access_token=${access_token}; Path=/; Max-Age=${expires_in}; HttpOnly; SameSite=Lax`,
      `linkedin_user_id=${profileResponse.data.id}; Path=/; Max-Age=${expires_in}; SameSite=Lax`
    ]);

    // Return success response with user data
    return res.status(200).json({
      success: true,
      ...userData,
    });
  } catch (error) {
    console.error('LinkedIn token exchange error:', error.response?.data || error.message);
    const errorDetails = error.response?.data?.error_description || error.message || 'Unknown error';
    return res.status(200).json({
      status: 'fail-soft',
      error: 'Failed to exchange LinkedIn authorization code',
      details: errorDetails,
      degradedSources: ['linkedin-auth-token']
    });
  }
}
