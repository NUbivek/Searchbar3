/**
 * Facebook token exchange API endpoint
 * Exchanges authorization code for access token
 */

import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code is required' });
  }

  const clientId = process.env.FACEBOOK_APP_ID;
  const clientSecret = process.env.FACEBOOK_APP_SECRET;
  const redirectUri = process.env.NEXT_PUBLIC_APP_URL 
    ? `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/facebook/callback` 
    : 'http://localhost:3000/api/auth/facebook/callback';

  if (!clientId || !clientSecret) {
    return res.status(200).json({
      status: 'fail-soft',
      error: 'Facebook API credentials not configured',
      degradedSources: ['facebook-auth-token']
    });
  }

  try {
    // Exchange authorization code for access token
    const tokenResponse = await axios.get(
      'https://graph.facebook.com/v17.0/oauth/access_token',
      {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        },
      }
    );

    // Get user profile information
    const profileResponse = await axios.get('https://graph.facebook.com/me', {
      params: {
        fields: 'id,name,email,picture',
        access_token: tokenResponse.data.access_token,
      },
    });

    // Get user friends (will only return friends who have also authorized your app)
    const friendsResponse = await axios.get('https://graph.facebook.com/me/friends', {
      params: {
        access_token: tokenResponse.data.access_token,
      },
    });

    const userData = {
      profile: profileResponse.data,
      friends: friendsResponse.data,
      accessToken: tokenResponse.data.access_token,
      expiresIn: tokenResponse.data.expires_in,
    };

    // In a real implementation, you would save this in a session:
    // req.session.facebookAuth = userData;
    // await req.session.save();

    return res.status(200).json({
      success: true,
      ...userData,
    });
  } catch (error) {
    console.error('Facebook token exchange error:', error.response?.data || error.message);
    return res.status(200).json({
      status: 'fail-soft',
      error: 'Failed to exchange Facebook authorization code',
      details: error.response?.data || error.message,
      degradedSources: ['facebook-auth-token']
    });
  }
}
