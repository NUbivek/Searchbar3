/**
 * LinkedIn profile via "Sign In with LinkedIn using OpenID Connect".
 *
 * LinkedIn retired the r_liteprofile / r_emailaddress scopes and the
 * /v2/me + /v2/emailAddress endpoints for new apps. Apps now request the
 * `openid profile email` scopes and read the member from /v2/userinfo.
 */
import axios from 'axios';

export const LINKEDIN_SCOPES = ['openid', 'profile', 'email'];

export async function fetchLinkedInProfile(accessToken, timeout = 10000) {
  const { data } = await axios.get('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout,
  });
  return {
    id: data.sub,
    firstName: data.given_name || '',
    lastName: data.family_name || '',
    name: data.name || [data.given_name, data.family_name].filter(Boolean).join(' '),
    email: data.email || null,
    picture: data.picture || null,
  };
}

const LINKEDIN_BLUE = '#0077B5';

/**
 * Graph of the signed-in member plus first-degree connections.
 * LinkedIn only exposes /v2/connections to approved partner apps, so for a
 * normal app this is just the member node with connectionsAvailable: false.
 * Never invents contacts.
 */
export async function fetchLinkedInGraph(accessToken, profile, timeout = 10000) {
  const graph = {
    nodes: [{ id: 'user', name: profile.name, val: 20, color: LINKEDIN_BLUE, image: profile.picture, degree: 0, type: 'user' }],
    links: [],
    connectionsAvailable: false,
  };
  try {
    const { data } = await axios.get('https://api.linkedin.com/v2/connections?q=viewer&start=0&count=50', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout,
    });
    for (const connection of data.elements || []) {
      const mini = connection.miniProfile || {};
      const id = `linkedin-${mini.id}`;
      graph.nodes.push({
        id,
        name: `${mini.firstName || ''} ${mini.lastName || ''}`.trim(),
        company: mini.occupation || '',
        position: mini.title || '',
        location: mini.locationName || '',
        val: 10,
        color: LINKEDIN_BLUE,
        image: mini.picture?.displayImage || null,
        degree: 1,
        source: 'linkedin',
        type: 'linkedin',
      });
      graph.links.push({ source: 'user', target: id, value: 1 });
    }
    graph.connectionsAvailable = graph.nodes.length > 1;
  } catch (error) {
    // Expected for apps without LinkedIn partner access (403).
    console.warn('LinkedIn connections not available to this app:', error.response?.status || error.message);
  }
  if (!graph.connectionsAvailable) {
    graph.note = 'LinkedIn shares connection lists only with approved partner apps. Your profile is connected; connections cannot be imported through the API.';
  }
  return graph;
}
