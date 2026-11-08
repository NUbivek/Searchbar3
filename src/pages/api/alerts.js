/**
 * GET  /api/alerts            -> { alerts: [...] } (most recent first)
 * GET  /api/alerts?unseen=1   -> only unseen alerts (AccountMenu badge)
 * POST /api/alerts {ids?: []} -> mark those alerts seen (all when omitted)
 */
import { withUser, isUuid } from '../../server/apiHelpers';
import { listAlerts, markAlertsSeen } from '../../server/store';

export default withUser(['GET', 'POST'], async (req, res, userId) => {
  if (req.method === 'GET') {
    const unseenOnly = req.query.unseen === '1' || req.query.unseen === 'true';
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    return res.status(200).json({ alerts: await listAlerts(userId, { unseenOnly, limit }) });
  }
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isUuid) : null;
  if (Array.isArray(req.body?.ids) && req.body.ids.length && !ids.length) {
    return res.status(400).json({ error: 'No valid alert ids.' });
  }
  await markAlertsSeen(userId, ids && ids.length ? ids : null);
  return res.status(200).json({ ok: true });
});
