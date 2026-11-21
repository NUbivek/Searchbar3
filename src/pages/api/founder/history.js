/**
 * GET /api/founder/history
 *   -> { checks:  [{ id, name, company, seededCompany, status: 'done', date, redFlags }],
 *        running: [{ id, name, company, seededCompany, status: 'running', date, redFlags: null }] }
 *
 * The signed-in user's own deep checks, newest first (checks are kept for
 * three days; see jobStore.js). Each carries its id, so the page can reopen
 * it (GET /api/founder/deep?jobId=) instead of starting a new check, and the
 * company the check was anchored on, so a re-run keeps it. `checks` holds
 * only finished ones, as before. Never another user's: every read is scoped
 * by the signed-in user's id. 401 when signed out, 403 for an account the
 * allow-list leaves out (the same refusal as the check itself).
 */
import { requireFounderUser } from '../../../server/auth';
import { listFinishedChecks, listRunningChecks } from '../../../server/founder/networkLink';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Sends the 401 or 403 itself
  const userId = await requireFounderUser(req, res);
  if (!userId) return undefined;
  const [done, running] = await Promise.allSettled([listFinishedChecks(userId), listRunningChecks(userId)]);
  if (done.status === 'rejected') return res.status(503).json({ error: 'Your past checks could not be loaded just now.' });
  // A failed read of the running checks is said, never shown as "none running".
  return res.status(200).json({
    checks: done.value,
    running: running.status === 'fulfilled' ? running.value : [],
    ...(running.status === 'rejected' ? { runningUnread: true } : {}),
  });
}
