/**
 * POST /api/workspaces/:id/ask {question, docIds?, includeSources?}
 * Answers a question from the workspace's data-room documents (and optionally
 * curated sources) with passage citations. See src/server/dataroom.js.
 */
import { withUser, isUuid } from '../../../../server/apiHelpers';
import { getDocuments, getWorkspaceRow } from '../../../../server/store';
import { answerQuestion } from '../../../../server/dataroom';

export const MAX_QUESTION_CHARS = 2000;

// The answer waits on an upstream model; Vercel's default function limit is 10s.
export const config = { maxDuration: 60 };

export default withUser(['POST'], async (req, res, userId) => {
  const { id } = req.query;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid id' });
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'Ask a question.' });
  if (question.length > MAX_QUESTION_CHARS) {
    return res.status(400).json({ error: `Questions are limited to ${MAX_QUESTION_CHARS} characters.` });
  }
  const docIds = req.body?.docIds;
  if (docIds != null && (!Array.isArray(docIds) || !docIds.every(isUuid))) {
    return res.status(400).json({ error: 'docIds must be a list of document ids.' });
  }
  if (!(await getWorkspaceRow(userId, id))) return res.status(404).json({ error: 'Workspace not found' });

  // Always load this workspace's documents, then narrow by docIds, so ids from
  // another workspace can never be pulled in.
  let documents = await getDocuments(userId, id);
  if (Array.isArray(docIds) && docIds.length) {
    const wanted = new Set(docIds.map((d) => d.toLowerCase()));
    documents = documents.filter((d) => wanted.has(String(d.id).toLowerCase()));
  }
  if (!documents.length && !req.body?.includeSources) {
    return res.status(400).json({ error: 'Upload at least one document to this workspace first.' });
  }

  const result = await answerQuestion({ question, documents, includeSources: Boolean(req.body?.includeSources) });
  return res.status(200).json({ ...result, documentCount: documents.length });
});
