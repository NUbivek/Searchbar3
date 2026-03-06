import type { NextApiRequest, NextApiResponse } from 'next';
import { query } from '../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { filters = {}, format = 'csv' } = req.body || {};
  const r = await query(
    'INSERT INTO export_jobs (status, filter_params, format) VALUES ($1,$2,$3) RETURNING id,status,format,created_at',
    ['pending', filters, format]
  );
  return res.status(200).json({ job: r.rows[0] });
}
