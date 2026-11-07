/**
 * API endpoint to fetch LinkedIn connections as graph data.
 *
 * LinkedIn only exposes a member's connections to approved partner apps, so
 * for a normal app /v2/connections returns 403. In that case this returns the
 * signed-in member as the only node with connectionsAvailable: false, never
 * invented contacts.
 */
import { fetchLinkedInProfile, fetchLinkedInGraph } from '../../../../utils/linkedinProfile';

const LINKEDIN_CONNECTIONS_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const accessToken = req.cookies.linkedin_access_token;
  if (!accessToken) {
    return res.status(401).json({ error: 'Not authenticated with LinkedIn' });
  }

  let profile;
  try {
    profile = await fetchLinkedInProfile(accessToken, LINKEDIN_CONNECTIONS_TIMEOUT_MS);
  } catch (error) {
    console.error('Error fetching LinkedIn profile:', error.response?.data || error.message);
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'LinkedIn session expired, please reconnect' });
    }
    return res.status(200).json({
      status: 'fail-soft',
      nodes: [],
      links: [],
      degradedSources: ['linkedin-network'],
      error: 'Failed to fetch LinkedIn profile',
      details: error.message
    });
  }

  const graph = await fetchLinkedInGraph(accessToken, profile, LINKEDIN_CONNECTIONS_TIMEOUT_MS);

  return res.status(200).json(graph);
}
