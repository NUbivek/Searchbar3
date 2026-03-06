import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '../../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query.id as string;
  const { status, flagged, notes, owner } = req.body || {};
  const r = await query(
    `INSERT INTO startup_signal_meta (signal_id,status,flagged,notes,owner) VALUES ($1,COALESCE($2,'new')::review_status,COALESCE($3,false),$4,$5)
     ON CONFLICT (signal_id) DO UPDATE SET status=COALESCE(EXCLUDED.status,startup_signal_meta.status), flagged=COALESCE(EXCLUDED.flagged,startup_signal_meta.flagged), notes=COALESCE(EXCLUDED.notes,startup_signal_meta.notes), owner=COALESCE(EXCLUDED.owner,startup_signal_meta.owner), updated_at=now(), last_touched=now()
     RETURNING *`, [id, status, flagged, notes, owner]
  );
  return res.status(200).json(r.rows[0]);
}
