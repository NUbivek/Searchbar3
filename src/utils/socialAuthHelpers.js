/**
 * Social Media Authentication Helpers
 * Utilities for handling social media authentication flows
 */

import axios from 'axios';

const APP_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';

// LinkedIn Configuration
const LINKEDIN_CONFIG = {
  authEndpoint: '/api/auth/linkedin',
  connectionsEndpoint: '/api/network/linkedin/connections'
};

// Twitter Configuration
const TWITTER_CONFIG = {
  clientId: process.env.NEXT_PUBLIC_TWITTER_CLIENT_ID || '',
  redirectUri: `${APP_BASE_URL}/api/auth/twitter/callback`,
  scope: 'tweet.read users.read follows.read',
};

// Reddit Configuration
const REDDIT_CONFIG = {
  authEndpoint: '/api/auth/reddit'
};

// Facebook Configuration
const FACEBOOK_CONFIG = {
  clientId: process.env.NEXT_PUBLIC_FACEBOOK_APP_ID || '',
  redirectUri: `${APP_BASE_URL}/api/auth/facebook/callback`,
  scope: 'email,public_profile,user_friends',
};

/**
 * Initiates LinkedIn authentication flow
 * Instead of constructing the URL here, we'll use our server-side API
 * @returns {string} The URL to redirect to for authentication
 */
export const initiateLinkedInAuth = () => {
  // We'll redirect to our API endpoint which handles the OAuth flow
  return LINKEDIN_CONFIG.authEndpoint;
};

/**
 * Initiates Twitter authentication flow
 * @returns {string} Authentication URL to redirect the user to
 */
export const initiateTwitterAuth = () => {
  if (!TWITTER_CONFIG.clientId) {
    return '/api/auth/twitter';
  }

  const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', TWITTER_CONFIG.clientId);
  authUrl.searchParams.append('redirect_uri', TWITTER_CONFIG.redirectUri);
  authUrl.searchParams.append('scope', TWITTER_CONFIG.scope);
  authUrl.searchParams.append('state', generateRandomState());
  authUrl.searchParams.append('code_challenge', 'challenge'); // Simplified - in production use PKCE
  authUrl.searchParams.append('code_challenge_method', 'plain');

  return authUrl.toString();
};

/**
 * Initiates Reddit authentication flow
 * @returns {string} Authentication URL to redirect the user to
 */
export const initiateRedditAuth = () => {
  return REDDIT_CONFIG.authEndpoint;
};

/**
 * Initiates Facebook authentication flow
 * @returns {string} Authentication URL to redirect the user to
 */
export const initiateFacebookAuth = () => {
  if (!FACEBOOK_CONFIG.clientId) {
    return '/api/auth/facebook';
  }

  const authUrl = new URL('https://www.facebook.com/v17.0/dialog/oauth');
  authUrl.searchParams.append('client_id', FACEBOOK_CONFIG.clientId);
  authUrl.searchParams.append('redirect_uri', FACEBOOK_CONFIG.redirectUri);
  authUrl.searchParams.append('scope', FACEBOOK_CONFIG.scope);
  authUrl.searchParams.append('state', generateRandomState());

  return authUrl.toString();
};

/**
 * Exchanges authorization code for access token (LinkedIn example)
 * @param {string} code Authorization code from callback
 * @returns {Promise<object>} Access token and other response data
 */
export const exchangeLinkedInCode = async (code) => {
  try {
    const response = await axios.post('/api/auth/linkedin/token', { code });
    return response.data;
  } catch (error) {
    console.error('Error exchanging LinkedIn code:', error);
    throw error;
  }
};

/**
 * Fetches LinkedIn connections data
 * The accessToken is stored in cookies by our backend,
 * so we don't need to pass it explicitly
 * @returns {Promise<object>} LinkedIn connections data
 */
export const fetchLinkedInConnections = async () => {
  try {
    const response = await axios.get(LINKEDIN_CONFIG.connectionsEndpoint);
    return response.data;
  } catch (error) {
    console.error('Error fetching LinkedIn connections:', error);
    throw error;
  }
};

/**
 * Generates random state parameter for OAuth security
 * @returns {string} Random state string
 */
const generateRandomState = () => {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
};

/**
 * Checks if the user is authenticated with a specific social network
 * @param {string} network The social network to check (linkedin, twitter, facebook)
 * @returns {boolean} Whether the user is authenticated
 */
export const checkAuthStatus = async (network) => {
  try {
    const response = await axios.get(`/api/auth/${network}/status`);
    return response.data.authenticated;
  } catch (error) {
    console.error(`Error checking ${network} auth status:`, error);
    return false;
  }
};

/**
 * Logs out from a specific social network
 * @param {string} network The social network to log out from (linkedin, twitter, facebook)
 * @returns {Promise<void>}
 */
export const logoutFromNetwork = async (network) => {
  try {
    await axios.post(`/api/auth/${network}/logout`);
  } catch (error) {
    console.error(`Error logging out from ${network}:`, error);
    throw error;
  }
};
