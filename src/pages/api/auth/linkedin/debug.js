/**
 * Diagnostic endpoint to debug LinkedIn OAuth configuration
 * This endpoint helps troubleshoot OAuth configuration issues by showing
 * all relevant environment variables and configuration details.
 */
import { IncomingMessage } from 'http';
import { URL } from 'url';

/**
 * Safely checks if a string contains a substring without throwing errors
 * if the string is null or undefined
 */
function safeIncludes(str, searchStr) {
  if (!str || typeof str !== 'string') return false;
  return str.includes(searchStr);
}

export default function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get hostname information
  const getHostInfo = (req) => {
    try {
      const host = req.headers.host || 'localhost:3000';
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      return { host, protocol };
    } catch (e) {
      return { host: 'unknown', protocol: 'unknown', error: e.message };
    }
  };
  
  const { host, protocol } = getHostInfo(req);
  const baseUrl = `${protocol}://${host}`;
  
  // Parse client ID to check if it's set
  const clientId = process.env.LINKEDIN_CLIENT_ID || process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID;
  const hasClientId = !!clientId;
  const maskedClientId = hasClientId ? 
    `${clientId.substring(0, 4)}...${clientId.substring(clientId.length - 4)}` : 
    'Not configured';
  
  // Check if client secret is set
  const hasClientSecret = !!process.env.LINKEDIN_CLIENT_SECRET;
  
  // Determine the redirect URI from environment variables with fallbacks
  const configuredRedirectUri = process.env.LINKEDIN_REDIRECT_URI || 
    process.env.NEXT_PUBLIC_LINKEDIN_REDIRECT_URI || 
    `${baseUrl}/api/auth/linkedin/callback`;
  
  // All possible redirect URIs that could be used
  const possibleRedirectUris = [
    configuredRedirectUri,
    // Common patterns
    `${baseUrl}/api/auth/linkedin/callback`,
    `${baseUrl}/network`,
    // Localhost variations
    'http://localhost:3000/api/auth/linkedin/callback',
    'https://localhost:3000/api/auth/linkedin/callback',
    // Production variants
    `${process.env.NEXT_PUBLIC_APP_URL || baseUrl}/api/auth/linkedin/callback`,
  ];
  
  // Determine if we're using hardcoded or environment values in network.js
  // This helps identify if we're using the right values in the frontend
  const frontendConfig = {
    usesHardcodedClientId: !process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID,
    usesHardcodedRedirectUri: !process.env.NEXT_PUBLIC_LINKEDIN_REDIRECT_URI,
  };
  
  // Return comprehensive diagnostic information
  const config = {
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      hasClientId,
      hasClientSecret,
      clientId: maskedClientId,
      clientIdLength: clientId ? clientId.length : 0,
    },
    request: {
      host,
      protocol,
      baseUrl,
      headers: {
        host: req.headers.host,
        referer: req.headers.referer,
        origin: req.headers.origin,
        'x-forwarded-proto': req.headers['x-forwarded-proto'],
      }
    },
    oauthConfig: {
      configuredRedirectUri,
      possibleRedirectUris,
      frontendConfig,
    },
    troubleshooting: {
      suggestions: []
    }
  };
  
  // Add troubleshooting suggestions based on detected issues
  if (!hasClientId) {
    config.troubleshooting.suggestions.push(
      'LinkedIn Client ID is missing. Add LINKEDIN_CLIENT_ID to your .env.local file.'
    );
  }
  
  if (!hasClientSecret) {
    config.troubleshooting.suggestions.push(
      'LinkedIn Client Secret is missing. Add LINKEDIN_CLIENT_SECRET to your .env.local file.'
    );
  }
  
  if (frontendConfig.usesHardcodedClientId) {
    config.troubleshooting.suggestions.push(
      'Frontend is using hardcoded LinkedIn Client ID. Add NEXT_PUBLIC_LINKEDIN_CLIENT_ID to your .env.local file.'
    );
  }
  
  if (frontendConfig.usesHardcodedRedirectUri) {
    config.troubleshooting.suggestions.push(
      'Frontend is using hardcoded redirect URI. Add NEXT_PUBLIC_LINKEDIN_REDIRECT_URI to your .env.local file.'
    );
  }
  
  // Add cookie information if available
  if (req.cookies) {
    const hasLinkedInToken = !!req.cookies.linkedin_access_token;
    const hasLinkedInUserId = !!req.cookies.linkedin_user_id;
    
    config.authState = {
      hasLinkedInToken,
      hasLinkedInUserId,
      tokenLength: hasLinkedInToken ? req.cookies.linkedin_access_token.length : 0,
    };
    
    if (hasLinkedInToken && !hasLinkedInUserId) {
      config.troubleshooting.suggestions.push(
        'LinkedIn access token exists but user ID cookie is missing. This may indicate an issue with the token exchange process.'
      );
    }
  }
  
  res.status(200).json(config);
}
