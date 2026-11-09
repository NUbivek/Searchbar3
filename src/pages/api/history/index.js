/**
 * GET    /api/history                 -> recent searches for the signed-in user
 * PATCH  /api/history {id, workspaceId} -> file a search under a workspace (or null)
 * DELETE /api/history?id=             -> delete one search
 */
import { withUser, isUuid } from '../../../server/apiHelpers';
import { listSearches, deleteSearch, moveSearch } from '../../../server/store';

export default withUser(['GET', 'PATCH', 'DELETE'], async (req, res, userId) => {
  if (req.method === 'GET') {
    const workspaceId = isUuid(req.query.workspaceId) ? req.query.workspaceId : null;
    return res.status(200).json({ searches: await listSearches(userId, { workspaceId, limit: req.query.limit }) });
  }
  if (req.method === 'PATCH') {
    const { id, workspaceId = null } = req.body || {};
    if (!isUuid(id) || (workspaceId && !isUuid(workspaceId))) return res.status(400).json({ error: 'Invalid id' });
    const ok = await moveSearch(userId, id, workspaceId);
    return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  }
  if (!isUuid(req.query.id)) return res.status(400).json({ error: 'Invalid id' });
  const ok = await deleteSearch(userId, req.query.id);
  return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});
