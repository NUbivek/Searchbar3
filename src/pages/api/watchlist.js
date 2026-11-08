/**
 * GET    /api/watchlist                         -> { watchlist: [...] }
 * POST   /api/watchlist {company, workspaceId?} -> add (or re-add) and check now
 * POST   /api/watchlist {id} (or ?check=1&id=)  -> "Check now" for an existing watch
 * DELETE /api/watchlist?id=<uuid>               -> remove
 *
 * Adding or checking runs checkWatch for that one company and records any
 * new alerts. A failed source search does not undo the add.
 */
import { withUser, isUuid } from '../../server/apiHelpers';
import { listWatchlist, addWatch, removeWatch, recordWatchCheck } from '../../server/store';
import { checkWatch, emailAlertsConfigured } from '../../server/watchlist';

async function runCheck(watch) {
  try {
    const alerts = await checkWatch(watch);
    const created = await recordWatchCheck(watch, alerts);
    return { found: alerts.length, created };
  } catch (error) {
    console.error(`Watch check failed for ${watch.company}:`, error.message);
    return { found: 0, created: 0, error: 'Could not reach the sources right now. The next scheduled check will retry.' };
  }
}

export default withUser(['GET', 'POST', 'DELETE'], async (req, res, userId) => {
  if (req.method === 'GET') {
    return res.status(200).json({ watchlist: await listWatchlist(userId), emailAlerts: emailAlertsConfigured() });
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!isUuid(id)) return res.status(400).json({ error: 'A valid watch id is required.' });
    const removed = await removeWatch(userId, id);
    if (!removed) return res.status(404).json({ error: 'Watch not found.' });
    return res.status(200).json({ ok: true });
  }

  // POST
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const checkId = body.id || (req.query.check ? req.query.id : null);
  if (checkId) {
    if (!isUuid(checkId)) return res.status(400).json({ error: 'A valid watch id is required.' });
    const existing = (await listWatchlist(userId)).find((w) => w.id === checkId);
    if (!existing) return res.status(404).json({ error: 'Watch not found.' });
    const check = await runCheck({ ...existing, user_id: userId });
    return res.status(200).json({ watch: existing, check });
  }

  let watch;
  try {
    watch = await addWatch(userId, {
      company: typeof body.company === 'string' ? body.company : '',
      workspaceId: isUuid(body.workspaceId) ? body.workspaceId : null,
    });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    throw error;
  }
  const check = await runCheck(watch);
  return res.status(201).json({ watch, check });
});
