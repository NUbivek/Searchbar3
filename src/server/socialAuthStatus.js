/**
 * Status handler for /api/auth/{linkedin,twitter,facebook}/status.
 * (Previously the dynamic route /api/auth/[network]/status; it became three
 * static routes so /api/auth/[...nextauth] can serve Google sign-in, since
 * Next.js forbids two differently named dynamic segments at one level.)
 */
const NETWORKS = ['linkedin', 'twitter', 'facebook'];

export function createStatusHandler(fixedNetwork) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const network = fixedNetwork || req.query.network;
    if (!NETWORKS.includes(network)) {
      return res.status(400).json({ error: 'Invalid network specified' });
    }
    // Unchanged behavior: real connection state is read from cookies by the
    // network page; this endpoint reports the default.
    return res.status(200).json({ authenticated: false, network });
  };
}

export default createStatusHandler(null);
