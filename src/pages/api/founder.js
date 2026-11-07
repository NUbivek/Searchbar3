/**
 * GET /api/founder?name=&company=&model= : founder background check (public).
 * Every item is quoted from a cited source; the brief is AI-written with
 * checked citations when a free model is configured, otherwise quoted.
 * Signed-in users with an imported network also get backchannel references:
 * their own contacts at the founder's current and past companies (never sent
 * to any external service).
 */
import { runFounderCheck } from '../../server/founderCheck';
import { getUserId } from '../../server/auth';

export const config = { api: { responseLimit: '4mb' }, maxDuration: 60 };

async function backchannelReferences(req, res, result) {
  try {
    const userId = await getUserId(req, res);
    if (!userId) return { available: false, reason: 'Sign in and import your network to see people you know at these companies.' };
    const network = await import('../../server/network/store');
    if (typeof network.findContactsAtCompanies !== 'function') return { available: false, reason: 'Network data is not available.' };
    const companies = [...new Set([
      result.company,
      ...(result.profiles || []).map((p) => p.company),
      ...(result.pastCompanies || []).map((p) => p.company),
    ].filter(Boolean).map((c) => String(c).trim()))].slice(0, 15);
    if (companies.length === 0) return { available: true, companies, contacts: [] };
    const contacts = await network.findContactsAtCompanies(userId, companies);
    return { available: true, companies, contacts: (contacts || []).slice(0, 50) };
  } catch (error) {
    return { available: false, reason: 'Network data is not available right now.' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const name = String(req.query.name || '').trim();
  const company = String(req.query.company || '').trim();
  const model = typeof req.query.model === 'string' && req.query.model ? req.query.model : 'auto';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 120) return res.status(400).json({ error: 'name must be 120 characters or fewer' });
  if (company.length > 120) return res.status(400).json({ error: 'company must be 120 characters or fewer' });
  try {
    const result = await runFounderCheck({ name, company, model });
    const references = await backchannelReferences(req, res, result);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ...result, references });
  } catch (error) {
    console.error('Founder check failed:', error);
    return res.status(500).json({ error: 'Founder check failed. Please try again.' });
  }
}
