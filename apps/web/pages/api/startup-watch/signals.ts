import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '../../../lib/db';
import { buildQuery } from '../../../lib/startup-watch/buildQuery';

const mockRows = Array.from({ length: 120 }, (_, i) => ({
  id: `mock-${i + 1}`,
  company_name: `Startup ${i + 1}`,
  company_domain: `startup${i + 1}.com`,
  stage_guess: ['stealth','pre-seed','seed','series-a','series-b','series-c'][i % 6],
  source_key: ['techcrunch','hn_showhn','yc','a16z'][i % 4],
  source_tier: (i % 7) + 1,
  funding_total: [0, 500000, 2000000, 8000000, 30000000][i % 5],
  confidence: Number((0.35 + (i % 60) / 100).toFixed(3)),
  detected_at: new Date(Date.now() - i * 86400000).toISOString(),
  status: ['new','reviewed','shortlisted'][i % 3],
  flagged: i % 9 === 0,
  summary: `Startup ${i + 1} builds supply chain tooling.`
}));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

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

  if (process.env.STARTUP_WATCH_MOCK === '1') {
    let rows = [...mockRows];
    if (filters.q) rows = rows.filter(r => `${r.company_name} ${r.summary}`.toLowerCase().includes(String(filters.q).toLowerCase()));
    if (filters.stage?.length) rows = rows.filter(r => filters.stage!.includes(r.stage_guess));
    if (filters.source_key?.length) rows = rows.filter(r => filters.source_key!.includes(r.source_key));
    if (filters.min_confidence != null) rows = rows.filter(r => r.confidence >= Number(filters.min_confidence));
    if (filters.status?.length) rows = rows.filter(r => filters.status!.includes(r.status));
    const total = rows.length;
    const page = filters.page || 1;
    const pageSize = Math.min(filters.page_size || 50, 200);
    rows = rows.slice((page - 1) * pageSize, page * pageSize);
    return res.status(200).json({ rows, page, page_size: pageSize, total, meta: { query_time_ms: 5, last_ingest: new Date().toISOString(), mode: 'mock' } });
  }

  try {
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
      meta: { query_time_ms: Date.now() - start, last_ingest: (statsResult.rows[0] as any)?.last_ingest ?? null, mode: 'db' }
    });
  } catch (err) {
    console.error('[signals API] error', err);
    return res.status(200).json({ rows: [], page: filters.page, page_size: filters.page_size, total: 0, meta: { query_time_ms: 0, last_ingest: null, mode: 'degraded' } });
  }
}
