/**
 * OAuth Utilities
 * 
 * This module provides utilities for working with OAuth providers,
 * particularly for handling callback URLs that can work with both
 * local development and production environments.
 */

/**
 * Get the appropriate callback URL for the given provider
 * 
 * This function determines whether to use the local development URL
 * or the production relay URL based on environment settings.
 * 
 * @param {string} provider - The OAuth provider (e.g., 'twitter', 'linkedin')
 * @returns {string} The callback URL to use
 */
function getRequestBaseUrl(req) {
  if (!req) return null;
  const protoHeader = req.headers?.['x-forwarded-proto'];
  const hostHeader = req.headers?.['x-forwarded-host'] || req.headers?.host;
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : (protoHeader || 'http');
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host) return null;
  return `${proto}://${host}`;
}

export function getCallbackUrl(provider, req = null) {
  // Provider-specific explicit override has highest priority.
  const providerEnvKey = `${String(provider || '').toUpperCase()}_REDIRECT_URI`;
  if (process.env[providerEnvKey]) {
    return process.env[providerEnvKey];
  }

  // Get base URLs from environment with request-host fallback.
  const requestBaseUrl = getRequestBaseUrl(req);
  const baseUrl = requestBaseUrl || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3001';
  const productionUrl = process.env.NEXT_PUBLIC_PRODUCTION_URL || baseUrl;
  
  // Check if we should use production callbacks
  const useProductionCallbacks = process.env.NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS === 'true';
  
  // If we're using production callbacks, handle based on provider
  if (useProductionCallbacks) {
    // Twitter and LinkedIn use direct callbacks instead of the relay system
    if (provider === 'linkedin') {
      return `${productionUrl}/api/auth/linkedin/callback`;
    }
    if (provider === 'twitter') {
      return `${productionUrl}/api/auth/twitter/callback`;
    }
    // Other providers use the relay system
    return `${productionUrl}/api/relay/${provider}`;
  }
  
  // Otherwise return the local callback URL
  return `${baseUrl}/api/auth/${provider}/callback`;
}

/**
 * Get the appropriate redirect URL for the given provider
 * 
 * This is similar to getCallbackUrl but is used for initial OAuth redirects
 * rather than callbacks.
 * 
 * @param {string} provider - The OAuth provider (e.g., 'twitter', 'linkedin')
 * @returns {string} The redirect URL to use
 */
export function getRedirectUrl(provider, req = null) {
  // Get base URLs from environment
  const baseUrl = getRequestBaseUrl(req) || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3001';
  
  // Always use the local redirect URL
  return `${baseUrl}/api/auth/${provider}`;
}

/**
 * Get the base URL for the application
 * 
 * @returns {string} The base URL for the application
 */
export function getBaseUrl() {
  return process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3001';
}

/**
 * Get the production URL for the application
 * 
 * @returns {string} The production URL for the application
 */
export function getProductionUrl() {
  return process.env.NEXT_PUBLIC_PRODUCTION_URL || 'https://research.bivek.ai';
}

/**
 * Check if we should use production callbacks
 * 
 * @returns {boolean} Whether to use production callbacks
 */
export function useProductionCallbacks() {
  return process.env.NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS === 'true';
}
