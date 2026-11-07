/**
 * POST   /api/workspaces/:id/notes {body} -> add a note
 * DELETE /api/workspaces/:id/notes?noteId=
 */
import { withUser, isUuid } from '../../../../server/apiHelpers';
import { addNote, deleteNote } from '../../../../server/store';

export default withUser(['POST', 'DELETE'], async (req, res, userId) => {
  const { id } = req.query;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid id' });
  if (req.method === 'POST') {
    try {
      const note = await addNote(userId, id, req.body?.body);
      return note ? res.status(201).json({ note }) : res.status(404).json({ error: 'Workspace not found' });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      throw error;
    }
  }
  if (!isUuid(req.query.noteId)) return res.status(400).json({ error: 'Invalid note id' });
  const ok = await deleteNote(userId, id, req.query.noteId);
  return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});
