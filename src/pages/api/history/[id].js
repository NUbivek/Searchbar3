/** GET /api/history/:id -> one saved search, including its saved summary and sources */
import { withUser, isUuid } from '../../../server/apiHelpers';
import { getSearch } from '../../../server/store';

export default withUser(['GET'], async (req, res, userId) => {
  if (!isUuid(req.query.id)) return res.status(400).json({ error: 'Invalid id' });
  const search = await getSearch(userId, req.query.id);
  return search ? res.status(200).json({ search }) : res.status(404).json({ error: 'Not found' });
});
