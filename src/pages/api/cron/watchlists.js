/**
 * GET/POST /api/cron/watchlists — scheduled watchlist checks (Vercel cron).
 *
 * Requires `Authorization: Bearer ${CRON_SECRET}` (Vercel cron sends it when
 * CRON_SECRET is set). Without CRON_SECRET the route only runs in local
 * development.
 */
import crypto from 'crypto';
import { runDueWatchChecks } from '../../../server/watchlist';
import { PersistenceUnavailableError } from '../../../server/db';

export const config = { maxDuration: 60 };

export function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV === 'development';
  const header = String(req.headers?.authorization || '');
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await runDueWatchChecks({ limit: 25, olderThanMinutes: 360 });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof PersistenceUnavailableError) return res.status(503).json({ error: error.message });
    console.error('Watchlist cron failed:', error);
    return res.status(500).json({ error: 'Watchlist check failed.' });
  }
}
