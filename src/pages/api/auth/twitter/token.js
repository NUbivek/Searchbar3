/**
 * Twitter token API endpoint
 * Handles token operations: validation, exchange, and data retrieval
 */

import axios from 'axios';
import { parse, serialize } from 'cookie';
import { getCallbackUrl } from '../../../../utils/oauthUtils';

const TWITTER_AUTH_TIMEOUT_MS = 10000;

function respondFailSoftWhenServerError(res, status, payload, degradedSource) {
  if (status >= 500) {
    return res.status(200).json({
      status: 'fail-soft',
      ...payload,
      degradedSources: [degradedSource]
    });
  }

  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  // Handle different request methods for different token operations
  if (req.method === 'GET') {
    // Check if user has a valid token and return their data
    return handleTokenValidation(req, res);
  } else if (req.method === 'POST') {
    // Handle token exchange if code is provided
    const { code, refresh } = req.body;
    
    if (refresh) {
      // Handle token refresh
      return handleTokenRefresh(req, res);
    } else if (code) {
      // Handle code exchange for token
      return handleCodeExchange(req, res, code);
    }
    
    return res.status(400).json({ error: 'Invalid request parameters' });
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}

/**
 * Enhanced in-memory rate limiting to prevent too many Twitter API calls
 * Uses a token bucket algorithm with much more forgiving limits and per-IP tracking
 */
const rateLimits = {
  ipLimits: {},          // Track limits per IP address
  global: {              // Global fallback limiter
    lastRequestTime: Date.now(),
    requestCount: 0,
    maxRequests: 10,       // Maximum 10 requests in the window
    windowMs: 30000,       // 30 second window (more forgiving)
    retryAfterMs: 15000    // Suggest retry after 15 seconds
  }
};

// Cache successful responses to reduce API calls
const responseCache = {
  entries: {},
  maxEntries: 100,
  ttlMs: 5 * 60 * 1000  // 5 minute cache TTL
};

/**
 * Validates if the user has a valid Twitter token and returns the user data
 */
async function handleTokenValidation(req, res) {
  try {
    // Get client IP for rate limiting
    const clientIp = req.headers['x-forwarded-for'] || 
                    req.connection.remoteAddress ||
                    'unknown';
    
    // Initialize rate limit for this IP if not exists
    if (!rateLimits.ipLimits[clientIp]) {
      rateLimits.ipLimits[clientIp] = {
        lastRequestTime: Date.now(),
        requestCount: 0,
        maxRequests: rateLimits.global.maxRequests,
        windowMs: rateLimits.global.windowMs,
        retryAfterMs: rateLimits.global.retryAfterMs
      };
    }
    
    // Get the limiter for this client
    const limiter = rateLimits.ipLimits[clientIp];
    const now = Date.now();
    const timeSinceLastRequest = now - limiter.lastRequestTime;
    
    // Check cache first to avoid unnecessary API calls
    const cacheKey = `token-validation-${clientIp}`;
    const cachedResponse = responseCache.entries[cacheKey];
    
    if (cachedResponse && (now - cachedResponse.timestamp) < responseCache.ttlMs) {
      console.log('Serving Twitter token validation from cache');
      return res.status(cachedResponse.status).json(cachedResponse.data);
    }
    
    // Refill the bucket based on elapsed time
    if (timeSinceLastRequest > limiter.windowMs) {
      // Reset counter after window passes
      limiter.requestCount = 0;
    } else if (limiter.requestCount >= limiter.maxRequests) {
      // We've exceeded our rate limit
      const retryAfter = Math.ceil(limiter.retryAfterMs / 1000);
      
      // Clean up old IP entries every now and then
      if (Object.keys(rateLimits.ipLimits).length > 100) {
        cleanupOldRateLimits();
      }
      
      // Set retry headers for better client handling
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', limiter.maxRequests);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil((limiter.lastRequestTime + limiter.windowMs) / 1000));
      
      // Include more helpful information for debugging
      return res.status(429).json({
        error: `Twitter API rate limit exceeded. Please try again in ${retryAfter} seconds.`,
        authenticated: false,
        rateLimited: true,
        retryAfter: retryAfter,
        windowMs: limiter.windowMs,
        nextReset: new Date(limiter.lastRequestTime + limiter.windowMs).toISOString()
      });
    }
    
    // Update rate limiting data
    limiter.requestCount++;
    limiter.lastRequestTime = now;
    
    // Helper function to clean up old rate limiters
    function cleanupOldRateLimits() {
      const cutoff = now - (30 * 60 * 1000); // 30 minutes
      for (const ip in rateLimits.ipLimits) {
        if (rateLimits.ipLimits[ip].lastRequestTime < cutoff) {
          delete rateLimits.ipLimits[ip];
        }
      }
    }
    
    // Parse cookies to get the access token
    const cookies = parse(req.headers.cookie || '');
    const accessToken = cookies.twitter_access_token;
    
    if (!accessToken) {
      // Cache this negative response
      const responseData = { 
        error: 'Not authenticated with Twitter',
        authenticated: false 
      };
      responseCache.entries[cacheKey] = {
        timestamp: now,
        status: 200,
        data: responseData
      };
      return res.status(200).json(responseData);
    }
    
    // Validate the token by calling the Twitter API
    try {
      // Get user profile with the token
      const userResponse = await axios.get('https://api.twitter.com/2/users/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          'user.fields': 'name,username,profile_image_url,description',
        },
        timeout: TWITTER_AUTH_TIMEOUT_MS,
      });
      
      // Also get user's connections if available
      let connections = [];
      try {
        const connectionsResponse = await axios.get('https://api.twitter.com/2/users/me/following', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            'max_results': 50, // Adjust as needed
            'user.fields': 'name,username,profile_image_url',
          },
          timeout: TWITTER_AUTH_TIMEOUT_MS,
        });
        connections = connectionsResponse.data.data || [];
      } catch (connectionsError) {
        console.warn('Failed to fetch Twitter connections:', connectionsError.message);
        // Don't fail the whole request if connections fail
      }
      
      // Success - return the user data and cache the response
      const responseData = {
        authenticated: true,
        profile: userResponse.data.data,
        connections,
      };
      
      // Store in cache
      responseCache.entries[cacheKey] = {
        timestamp: now,
        status: 200,
        data: responseData
      };
      
      // Clean up cache if needed
      if (Object.keys(responseCache.entries).length > responseCache.maxEntries) {
        const oldestCacheKey = Object.keys(responseCache.entries).reduce((oldest, key) => {
          if (!oldest || responseCache.entries[key].timestamp < responseCache.entries[oldest].timestamp) {
            return key;
          }
          return oldest;
        }, null);
        
        if (oldestCacheKey) {
          delete responseCache.entries[oldestCacheKey];
        }
      }
      
      return res.status(200).json(responseData);
    } catch (error) {
      // Token is invalid or expired
      if (error.response?.status === 401) {
        // Try to refresh the token
        const refreshToken = cookies.twitter_refresh_token;
        if (refreshToken) {
          try {
            const newTokens = await refreshTwitterToken(refreshToken);
            if (!newTokens?.access_token) {
              clearAuthCookies(res);
              return res.status(200).json({
                status: 'fail-soft',
                error: 'Twitter API credentials not configured',
                authenticated: false,
                degradedSources: ['twitter-auth-token']
              });
            }
            
            // Set new cookies
            setTokenCookies(res, newTokens);
            
            // Try again with the new token
            const retryResponse = await axios.get('https://api.twitter.com/2/users/me', {
              headers: {
                Authorization: `Bearer ${newTokens.access_token}`,
              },
              params: {
                'user.fields': 'name,username,profile_image_url,description',
              },
              timeout: TWITTER_AUTH_TIMEOUT_MS,
            });
            
            return res.status(200).json({
              authenticated: true,
              profile: retryResponse.data.data,
              refreshed: true,
            });
          } catch (refreshError) {
            // Clear invalid cookies
            clearAuthCookies(res);
            
            return res.status(401).json({
              error: 'Twitter session expired',
              authenticated: false,
            });
          }
        } else {
          // No refresh token available
          clearAuthCookies(res);
          
          return res.status(401).json({
            error: 'Twitter session expired and no refresh token',
            authenticated: false,
          });
        }
      }
      
      // Other errors
      console.error('Twitter API error:', error.response?.data || error.message);
      const upstreamStatus = error.response?.status || 500;
      return respondFailSoftWhenServerError(res, upstreamStatus, {
        error: 'Failed to validate Twitter token',
        details: error.response?.data || error.message,
        authenticated: false,
      }, 'twitter-auth-token');
    }
  } catch (error) {
    console.error('Twitter token validation error:', error);
    return res.status(200).json({
      status: 'fail-soft',
      error: 'Internal server error during Twitter validation',
      authenticated: false,
      degradedSources: ['twitter-auth-token']
    });
  }
}

/**
 * Exchanges an authorization code for Twitter access and refresh tokens
 */
async function handleCodeExchange(req, res, code) {
  try {
    // Get configuration
    const clientId = process.env.TWITTER_CLIENT_ID || process.env.TWITTER_API_KEY;
    const clientSecret = process.env.TWITTER_CLIENT_SECRET;
    const redirectUri = getCallbackUrl('twitter', req);
    
    if (!clientId) {
      return res.status(200).json({
        status: 'fail-soft',
        error: 'Twitter API credentials not configured',
        degradedSources: ['twitter-auth-token']
      });
    }
    
    // Parse cookies to get the code verifier
    const cookies = parse(req.headers.cookie || '');
    const codeVerifier = cookies.twitter_code_verifier || 'challenge';
    
    // Exchange code for token
    const tokenResponse = await axios.post(
      'https://api.twitter.com/2/oauth2/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        client_id: clientId
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Include Basic Auth if client secret is available
          ...(clientSecret && {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
          })
        },
        timeout: TWITTER_AUTH_TIMEOUT_MS,
      }
    );
    
    // Set token cookies
    setTokenCookies(res, tokenResponse.data);
    
    // Get user profile
    const userResponse = await axios.get('https://api.twitter.com/2/users/me', {
      headers: {
        Authorization: `Bearer ${tokenResponse.data.access_token}`,
      },
      params: {
        'user.fields': 'name,username,profile_image_url,description',
      },
      timeout: TWITTER_AUTH_TIMEOUT_MS,
    });
    
    return res.status(200).json({
      success: true,
      profile: userResponse.data.data,
      accessToken: tokenResponse.data.access_token.substring(0, 10) + '...', // Only send a preview for security
    });
  } catch (error) {
    console.error('Twitter token exchange error:', error.response?.data || error.message);
    const upstreamStatus = error.response?.status || 500;
    return respondFailSoftWhenServerError(res, upstreamStatus, {
      error: 'Failed to exchange Twitter authorization code',
      details: error.response?.data || error.message,
    }, 'twitter-auth-token');
  }
}

/**
 * Refreshes an expired Twitter token using the refresh token
 */
async function handleTokenRefresh(req, res) {
  try {
    // Parse cookies to get the refresh token
    const cookies = parse(req.headers.cookie || '');
    const refreshToken = cookies.twitter_refresh_token;
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'No refresh token available' });
    }
    
    // Refresh the token
    const newTokens = await refreshTwitterToken(refreshToken);
    if (!newTokens?.access_token) {
      clearAuthCookies(res);
      return res.status(200).json({
        status: 'fail-soft',
        error: 'Twitter API credentials not configured',
        degradedSources: ['twitter-auth-token']
      });
    }
    
    // Set new cookies
    setTokenCookies(res, newTokens);
    
    return res.status(200).json({
      success: true,
      message: 'Twitter token refreshed successfully',
    });
  } catch (error) {
    console.error('Twitter token refresh error:', error.response?.data || error.message);
    
    // Clear invalid cookies
    clearAuthCookies(res);
    
    const upstreamStatus = error.response?.status || 500;
    return respondFailSoftWhenServerError(res, upstreamStatus, {
      error: 'Failed to refresh Twitter token',
      details: error.response?.data || error.message,
    }, 'twitter-auth-token');
  }
}

/**
 * Helper function to refresh a Twitter token
 */
async function refreshTwitterToken(refreshToken) {
  const clientId = process.env.TWITTER_CLIENT_ID || process.env.TWITTER_API_KEY;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  
  if (!clientId) {
    return null;
  }
  
  const tokenResponse = await axios.post(
    'https://api.twitter.com/2/oauth2/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Include Basic Auth if client secret is available
        ...(clientSecret && {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
        })
      },
      timeout: TWITTER_AUTH_TIMEOUT_MS,
    }
  );
  
  return tokenResponse.data;
}

/**
 * Sets Twitter token cookies
 */
function setTokenCookies(res, tokenData) {
  const { access_token, refresh_token, expires_in } = tokenData;
  
  // Cookie options - secure in production
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  };
  
  // Set cookies with the tokens
  res.setHeader('Set-Cookie', [
    serialize('twitter_access_token', access_token, {
      ...cookieOptions,
      maxAge: expires_in * 1000, // Convert seconds to milliseconds
    }),
    serialize('twitter_refresh_token', refresh_token, {
      ...cookieOptions,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    })
  ]);
}

/**
 * Clears all Twitter auth cookies
 */
function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    serialize('twitter_access_token', '', { maxAge: 0, path: '/' }),
    serialize('twitter_refresh_token', '', { maxAge: 0, path: '/' }),
    serialize('twitter_code_verifier', '', { maxAge: 0, path: '/' }),
    serialize('twitter_auth_state', '', { maxAge: 0, path: '/' })
  ]);
}
