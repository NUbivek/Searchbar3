/**
 * POST   /api/workspaces/:id/sources {title, url, sourceName?, publishedAt?, excerpt?} -> pin a source
 * DELETE /api/workspaces/:id/sources?sourceId=
 */
import { withUser, isUuid } from '../../../../server/apiHelpers';
import { saveSource, removeSource } from '../../../../server/store';

export default withUser(['POST', 'DELETE'], async (req, res, userId) => {
  const { id } = req.query;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid id' });
  if (req.method === 'POST') {
    try {
      const source = await saveSource(userId, id, req.body || {});
      return source ? res.status(201).json({ source }) : res.status(404).json({ error: 'Workspace not found' });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      throw error;
    }
  }
  if (!isUuid(req.query.sourceId)) return res.status(400).json({ error: 'Invalid source id' });
  const ok = await removeSource(userId, id, req.query.sourceId);
  return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});
