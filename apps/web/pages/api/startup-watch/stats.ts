import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 's-maxage=60');

  if (process.env.STARTUP_WATCH_MOCK === '1') {
    return res.status(200).json({ total: 120, last_ingest: new Date().toISOString(), mode: 'mock' });
  }

  try {
    const r = await query('SELECT COUNT(*)::int as total, MAX(detected_at) as last_ingest FROM startup_signals');
    return res.status(200).json(r.rows[0] || { total: 0, last_ingest: null, mode: 'db' });
  } catch {
    return res.status(200).json({ total: 0, last_ingest: null, mode: 'degraded' });
  }
}
