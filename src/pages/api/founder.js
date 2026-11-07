/**
 * GET /api/founder?name=&company= : founder background check (public).
 * Every item in the response is a verbatim quote with a source index.
 */
import { runFounderCheck } from '../../server/founderCheck';

export const config = { api: { responseLimit: '4mb' } };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const name = String(req.query.name || '').trim();
  const company = String(req.query.company || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 120) return res.status(400).json({ error: 'name must be 120 characters or fewer' });
  if (company.length > 120) return res.status(400).json({ error: 'company must be 120 characters or fewer' });
  try {
    const result = await runFounderCheck({ name, company });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (error) {
    console.error('Founder check failed:', error);
    return res.status(500).json({ error: 'Founder check failed. Please try again.' });
  }
}
