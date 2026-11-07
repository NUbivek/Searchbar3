/**
 * X (Twitter) network: the signed-in X user and, when the app's X API tier
 * allows it, the accounts they follow.
 *
 * Reading following lists (GET /2/users/:id/following) needs a paid X API
 * tier. On the free tier X answers 403; this route then reports
 * followingAvailable: false with an explanation and never invents accounts.
 *
 *   GET -> { user, following: XUser[], followingAvailable, truncated, note,
 *            networksData: { nodes: [user], links: [] } }
 */
import axios from 'axios';
import { parse } from 'cookie';

const TWITTER_NETWORK_TIMEOUT_MS = 10000;
const MAX_PAGES = 5; // 5 x 1000 accounts

const PAID_TIER_NOTE = 'X only shares who you follow with apps on a paid X API tier, and this app does not have that access. '
  + 'You can still upload your X following list as a JSON file in the X API format, or add the people to a CSV.';

async function fetchFollowing(userId, accessToken) {
  const following = [];
  let token;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await axios.get(`https://api.twitter.com/2/users/${encodeURIComponent(userId)}/following`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        max_results: 1000,
        'user.fields': 'name,username,description,location',
        ...(token ? { pagination_token: token } : {}),
      },
      timeout: TWITTER_NETWORK_TIMEOUT_MS,
    });
    for (const u of response.data?.data || []) {
      following.push({ id: u.id, name: u.name, username: u.username, description: u.description || '', location: u.location || '' });
    }
    token = response.data?.meta?.next_token;
    if (!token) return { following, truncated: false };
  }
  return { following, truncated: true };
}

export default async function handler(req, res) {
  const cookies = parse(req.headers.cookie || '');
  const accessToken = cookies.twitter_access_token;

  if (!accessToken) {
    return res.status(401).json({
      error: 'Authentication required',
      details: 'No Twitter access token found'
    });
  }

  let userData;
  try {
    const userResponse = await axios.get('https://api.twitter.com/2/users/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        'user.fields': 'username,profile_image_url,description'
      },
      timeout: TWITTER_NETWORK_TIMEOUT_MS,
    });
    userData = userResponse.data?.data;
  } catch (error) {
    if (error.response?.status === 401) {
      return res.status(401).json({
        error: 'Authentication error',
        details: 'Twitter token expired or invalid',
        tokenExpired: true
      });
    }
    if (error.response?.status === 429) {
      return res.status(429).json({
        error: 'Twitter API rate limit exceeded',
        details: 'Too many requests. Please try again later.',
        retryAfter: error.response.headers?.['retry-after'] || 60
      });
    }
    console.error('X user lookup failed:', error.response?.status || error.message);
    return res.status(200).json({
      status: 'fail-soft',
      user: null,
      following: [],
      followingAvailable: false,
      networksData: { nodes: [], links: [] },
      degradedSources: ['twitter-network'],
      error: 'Failed to fetch Twitter network data',
      details: error.response?.data?.error || error.message,
    });
  }

  if (!userData) {
    return res.status(200).json({
      status: 'fail-soft',
      user: null,
      following: [],
      followingAvailable: false,
      networksData: { nodes: [], links: [] },
      degradedSources: ['twitter-network'],
      error: 'Missing user data in Twitter API response'
    });
  }

  const userNode = { id: 'user', name: userData.username || 'You', type: 'user', image: userData.profile_image_url };
  let following = [];
  let followingAvailable = false;
  let truncated = false;
  let note = null;
  try {
    ({ following, truncated } = await fetchFollowing(userData.id, accessToken));
    followingAvailable = true;
    if (truncated) note = `Only the first ${following.length.toLocaleString('en-US')} accounts you follow were loaded.`;
  } catch (error) {
    const status = error.response?.status;
    if (status === 403 || status === 401) note = PAID_TIER_NOTE;
    else if (status === 429) note = 'X rate-limited the request for your following list. Try again in 15 minutes.';
    else note = `Could not load your X following list (${status || error.message}).`;
  }

  return res.status(200).json({
    user: userData,
    following,
    followingAvailable,
    truncated,
    note,
    networksData: { nodes: [userNode], links: [] },
  });
}
