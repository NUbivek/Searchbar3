/**
 * Data-room documents for a workspace.
 *
 * GET    /api/workspaces/:id/documents             -> { documents: [{id, name, size, created_at}] }
 * POST   /api/workspaces/:id/documents {files:[{name, content}]}
 *        The client first parses files with /api/upload, then posts the text here.
 *        -> 201 { documents: [...stored], errors: [{name, error}] }
 * DELETE /api/workspaces/:id/documents?docId=
 */
import { withUser, isUuid } from '../../../../server/apiHelpers';
import { addDocument, deleteDocument, getWorkspaceDetail, getWorkspaceRow } from '../../../../server/store';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export const MAX_FILES_PER_REQUEST = 10;
export const MAX_CONTENT_CHARS = 2_000_000;

export default withUser(['GET', 'POST', 'DELETE'], async (req, res, userId) => {
  const { id } = req.query;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid id' });

  if (req.method === 'GET') {
    const detail = await getWorkspaceDetail(userId, id);
    if (!detail) return res.status(404).json({ error: 'Workspace not found' });
    return res.status(200).json({ documents: detail.documents || [] });
  }

  if (req.method === 'DELETE') {
    if (!isUuid(req.query.docId)) return res.status(400).json({ error: 'Invalid document id' });
    const ok = await deleteDocument(userId, id, req.query.docId);
    return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  }

  // POST
  const files = req.body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Send {files:[{name, content}]} with at least one file.' });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return res.status(400).json({ error: `At most ${MAX_FILES_PER_REQUEST} documents per upload.` });
  }
  for (const file of files) {
    if (!file || typeof file.content !== 'string') {
      return res.status(400).json({ error: 'Each file needs a text "content" field.' });
    }
    if (file.content.length > MAX_CONTENT_CHARS) {
      return res.status(400).json({ error: `"${String(file.name || 'Document').slice(0, 100)}" is longer than ${MAX_CONTENT_CHARS.toLocaleString('en-US')} characters.` });
    }
  }
  if (!(await getWorkspaceRow(userId, id))) return res.status(404).json({ error: 'Workspace not found' });

  const documents = [];
  const errors = [];
  for (const file of files) {
    const name = String(file.name || 'Document').trim() || 'Document';
    try {
      const row = await addDocument(userId, id, { name, content: file.content });
      if (!row) return res.status(404).json({ error: 'Workspace not found' });
      documents.push(row);
    } catch (error) {
      if (error.status === 400) { errors.push({ name, error: error.message }); continue; }
      throw error;
    }
  }
  if (!documents.length) return res.status(400).json({ error: errors[0]?.error || 'No document could be stored.', errors });
  return res.status(201).json({ documents, errors });
});
