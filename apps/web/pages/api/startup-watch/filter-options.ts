import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 's-maxage=3600');

  if (process.env.STARTUP_WATCH_MOCK === '1') {
    return res.status(200).json({
      countries: ['US', 'CA', 'DE', 'GB', 'IL', 'AU'],
      sources: ['techcrunch', 'hn_showhn', 'yc', 'a16z'],
      tags: ['supply-chain', 'manufacturing', 'agtech', 'industrial-ai']
    });
  }

  try {
    const [countries, sources, tags] = await Promise.all([
      query('SELECT DISTINCT hq_country FROM startup_signals WHERE hq_country IS NOT NULL ORDER BY hq_country'),
      query('SELECT DISTINCT source_key FROM startup_signals WHERE source_key IS NOT NULL ORDER BY source_key'),
      query('SELECT DISTINCT unnest(thesis_tags) as tag FROM startup_signals ORDER BY tag')
    ]);

    return res.status(200).json({
      countries: countries.rows.map((r: any) => r.hq_country),
      sources: sources.rows.map((r: any) => r.source_key),
      tags: tags.rows.map((r: any) => r.tag)
    });
  } catch {
    return res.status(200).json({ countries: [], sources: [], tags: [] });
  }
}
