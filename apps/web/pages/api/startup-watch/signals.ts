import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '../../../lib/db';
import { buildQuery } from '../../../lib/startup-watch/buildQuery';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const q = req.query;
    const filters = {
      q: q.q as string | undefined,
      stage: q.stage ? [q.stage].flat() : undefined,
      tags: q.tags ? [q.tags].flat() : undefined,
      tags_all: q.tags_all === 'true',
      tier: q.tier ? [q.tier].flat().map(Number) : undefined,
      source_key: q.source_key ? [q.source_key].flat() : undefined,
      signal_type: q.signal_type ? [q.signal_type].flat() : undefined,
      date_from: q.date_from as string | undefined,
      date_to: q.date_to as string | undefined,
      min_funding: q.min_funding ? Number(q.min_funding) : undefined,
      max_funding: q.max_funding ? Number(q.max_funding) : undefined,
      min_headcount: q.min_headcount ? Number(q.min_headcount) : undefined,
      max_headcount: q.max_headcount ? Number(q.max_headcount) : undefined,
      hq_country: q.hq_country ? [q.hq_country].flat() : undefined,
      investor_tier: q.investor_tier ? [q.investor_tier].flat() : undefined,
      min_confidence: q.min_confidence ? Number(q.min_confidence) : undefined,
      status: q.status ? [q.status].flat() : undefined,
      flagged: q.flagged === 'true' ? true : q.flagged === 'false' ? false : undefined,
      sort: q.sort as string | undefined,
      dir: q.dir === 'asc' ? 'asc' as const : 'desc' as const,
      page: q.page ? Number(q.page) : 1,
      page_size: q.page_size ? Number(q.page_size) : 50,
    };

    const { sql, params, countSql, countParams } = buildQuery(filters);
    const start = Date.now();

    const [dataResult, countResult, statsResult] = await Promise.all([
      query(sql, params),
      query(countSql, countParams),
      query('SELECT MAX(detected_at) as last_ingest FROM startup_signals'),
    ]);

    return res.status(200).json({
      rows: dataResult.rows,
      page: filters.page,
      page_size: filters.page_size,
      total: parseInt((countResult.rows[0] as any)?.total ?? '0'),
      meta: {
        query_time_ms: Date.now() - start,
        last_ingest: (statsResult.rows[0] as any)?.last_ingest ?? null,
      }
    });
  } catch (err) {
    console.error('[signals API] error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
