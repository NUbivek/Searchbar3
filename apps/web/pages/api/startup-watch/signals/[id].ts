import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '../../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query.id as string;
  const r = await query(`SELECT s.*, m.status, m.flagged, m.notes, m.owner, m.last_touched FROM startup_signals s LEFT JOIN startup_signal_meta m ON m.signal_id=s.id WHERE s.id=$1`, [id]);
  return res.status(200).json(r.rows[0] || null);
}
