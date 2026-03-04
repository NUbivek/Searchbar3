/**
 * Twitter OAuth Debug Endpoint
 * Use this endpoint to troubleshoot Twitter OAuth integration issues
 */

import { parse } from 'cookie';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Gather environment variable information (safely)
  const hasTwitterClientId = !!process.env.TWITTER_CLIENT_ID;
  const hasTwitterApiKey = !!process.env.TWITTER_API_KEY; 
  const hasTwitterClientSecret = !!process.env.TWITTER_CLIENT_SECRET;
  const hasRedirectUri = !!process.env.TWITTER_REDIRECT_URI;
  
  // Get the configured redirect URI
  const configuredRedirectUri = process.env.TWITTER_REDIRECT_URI || 
    'http://localhost:3000/api/auth/twitter/callback';
  
  // Get public environment variables
  const publicTwitterClientId = process.env.NEXT_PUBLIC_TWITTER_CLIENT_ID;
  
  // Check for auth cookies (don't expose the actual tokens)
  const cookies = parse(req.headers.cookie || '');
  const hasTwitterAccessToken = !!cookies.twitter_access_token;
  const hasTwitterRefreshToken = !!cookies.twitter_refresh_token;
  const hasTwitterCodeVerifier = !!cookies.twitter_code_verifier;
  const hasTwitterAuthState = !!cookies.twitter_auth_state;
  
  // Generate suggestions based on configuration
  const suggestions = [];
  
  if (!hasTwitterClientId && !hasTwitterApiKey) {
    suggestions.push('Missing Twitter Client ID: Add TWITTER_CLIENT_ID to your .env.local file');
  }
  
  if (!hasTwitterClientSecret) {
    suggestions.push('Missing Twitter Client Secret: Add TWITTER_CLIENT_SECRET to your .env.local file');
  }
  
  if (!hasRedirectUri) {
    suggestions.push('Consider adding TWITTER_REDIRECT_URI to your .env.local file for explicit configuration');
  }
  
  // Check for common configuration issues
  if ((hasTwitterClientId || hasTwitterApiKey) && cookies.twitter_error) {
    suggestions.push(`Recent Twitter error detected: ${cookies.twitter_error}`);
  }
  
  // Special case for client ID issues in redirect URL
  if (req.query.error && req.query.error.includes('client_id')) {
    suggestions.push('Client ID error detected in URL. Make sure your TWITTER_CLIENT_ID is correct and matches the one in your Twitter Developer Portal');
  }
  
  // Return debug information
  res.status(200).json({
    environment: {
      hasClientId: hasTwitterClientId || hasTwitterApiKey,
      hasClientSecret: hasTwitterClientSecret,
      hasRedirectUri,
      hasPublicClientId: !!publicTwitterClientId,
      mode: process.env.NODE_ENV || 'development',
    },
    oauthConfig: {
      configuredRedirectUri,
      // Only return a masked version of the client ID for security
      clientId: hasTwitterClientId 
        ? `${process.env.TWITTER_CLIENT_ID?.substring(0, 5)}...` 
        : hasTwitterApiKey 
          ? `${process.env.TWITTER_API_KEY?.substring(0, 5)}...`
          : null,
    },
    authState: {
      hasTwitterAccessToken,
      hasTwitterRefreshToken,
      hasTwitterCodeVerifier,
      hasTwitterAuthState,
      recentError: cookies.twitter_error || null,
    },
    troubleshooting: {
      suggestions,
      tips: [
        'The Twitter Client ID should look like QzU0a01zRS1CbW9oSXNSOTNZbGc6MTpjaQ',
        'Make sure your Twitter Developer Portal has the correct redirect URI: ' + configuredRedirectUri,
        'Verify that your Twitter app has the required scopes: tweet.read,users.read,follows.read',
        'Check browser cookies to make sure they are being properly set and read',
        'Test your implementation with the Twitter API Console to validate credentials',
      ]
    }
  });
}
