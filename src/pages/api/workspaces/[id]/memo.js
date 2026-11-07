/**
 * GET /api/workspaces/:id/memo?format=md|docx|json[&searchIds=a,b]
 * Exports the workspace as an investment memo. md and docx download as
 * attachments named "<company>-memo-<yyyy-mm-dd>.<ext>"; json feeds the
 * print page.
 */
import { withUser, isUuid } from '../../../../server/apiHelpers';
import { getWorkspaceDetail } from '../../../../server/store';
import { buildMemo, memoToMarkdown, memoToDocx, memoFilename } from '../../../../server/memo';

const FORMATS = ['md', 'docx', 'json'];

export default withUser(['GET'], async (req, res, userId) => {
  const { id } = req.query;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid id' });
  const format = String(req.query.format || 'md').toLowerCase();
  if (!FORMATS.includes(format)) return res.status(400).json({ error: `format must be one of ${FORMATS.join(', ')}` });

  const searchIds = String(req.query.searchIds || '').split(',').map((s) => s.trim()).filter(isUuid);

  const detail = await getWorkspaceDetail(userId, id);
  if (!detail) return res.status(404).json({ error: 'Not found' });

  const memo = buildMemo(detail, { searchIds: searchIds.length ? searchIds : undefined });
  res.setHeader('Cache-Control', 'private, no-store');

  if (format === 'json') return res.status(200).json({ memo, workspaceId: id });

  const filename = memoFilename(memo, format);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (format === 'md') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.status(200).send(memoToMarkdown(memo));
  }
  const buffer = await memoToDocx(memo);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Length', buffer.length);
  return res.status(200).send(buffer);
});
