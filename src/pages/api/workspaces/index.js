/**
 * GET  /api/workspaces              -> the user's deal workspaces
 * POST /api/workspaces {name, company} -> create one
 */
import { withUser } from '../../../server/apiHelpers';
import { listWorkspaces, createWorkspace } from '../../../server/store';

export default withUser(['GET', 'POST'], async (req, res, userId) => {
  if (req.method === 'GET') {
    return res.status(200).json({ workspaces: await listWorkspaces(userId) });
  }
  try {
    const workspace = await createWorkspace(userId, req.body || {});
    return res.status(201).json({ workspace });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    throw error;
  }
});
