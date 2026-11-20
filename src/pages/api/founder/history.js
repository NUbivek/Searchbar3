/**
 * GET /api/founder/history -> { checks: [{ name, company, date, redFlags }] }
 *
 * The signed-in user's own finished deep checks, newest first (checks are
 * kept for three days; see jobStore.js). Never another user's: every read
 * is scoped by the signed-in user's id. 401 when signed out.
 */
import { getUserId } from '../../../server/auth';
import { listFinishedChecks } from '../../../server/founder/networkLink';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getUserId(req, res);
  if (!userId) return res.status(401).json({ error: 'Sign in to see the checks you have run.', signIn: true });
  try {
    return res.status(200).json({ checks: await listFinishedChecks(userId) });
  } catch {
    return res.status(503).json({ error: 'Your past checks could not be loaded just now.' });
  }
}
