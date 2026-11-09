/**
 * GET    /api/workspaces/:id  -> workspace with its searches, notes, saved sources, documents
 * PATCH  /api/workspaces/:id {name?, company?}
 * DELETE /api/workspaces/:id
 */
import { withUser, isUuid } from '../../../../server/apiHelpers';
import { getWorkspaceDetail, updateWorkspace, deleteWorkspace } from '../../../../server/store';

export default withUser(['GET', 'PATCH', 'DELETE'], async (req, res, userId) => {
  const { id } = req.query;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid id' });
  if (req.method === 'GET') {
    const detail = await getWorkspaceDetail(userId, id);
    return detail ? res.status(200).json(detail) : res.status(404).json({ error: 'Not found' });
  }
  if (req.method === 'PATCH') {
    const workspace = await updateWorkspace(userId, id, req.body || {});
    return workspace ? res.status(200).json({ workspace }) : res.status(404).json({ error: 'Not found' });
  }
  const ok = await deleteWorkspace(userId, id);
  return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});
