/**
 * GET /api/sources/curated            -> index status (also starts warming)
 * GET /api/sources/curated?q=<query>  -> search the curated registry sources
 */
import { searchCuratedSources, warmCuratedIndex, getCuratedIndexStatus } from '../../../utils/sources/curatedIndex';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    const status = warmCuratedIndex();
    // Failure details are for debugging; keep the public response small.
    const { failures, ...summary } = status;
    return res.status(200).json({ ...summary, failedSources: (failures || []).map((f) => f.name) });
  }

  const results = await searchCuratedSources(query, { limit: 20 });
  return res.status(200).json({ query, results, index: { ...getCuratedIndexStatus(), failures: undefined } });
}
