import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '../../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  const { signal_ids = [], updates = {} } = req.body || {};
  for (const id of signal_ids) {
    await query(`INSERT INTO startup_signal_meta (signal_id,status,owner) VALUES ($1,COALESCE($2,'new')::review_status,$3)
      ON CONFLICT (signal_id) DO UPDATE SET status=COALESCE(EXCLUDED.status,startup_signal_meta.status), owner=COALESCE(EXCLUDED.owner,startup_signal_meta.owner), updated_at=now(), last_touched=now()`, [id, updates.status, updates.owner]);
  }
  return res.status(200).json({ ok: true, count: signal_ids.length });
}
