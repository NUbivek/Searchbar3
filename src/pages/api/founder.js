/**
 * GET /api/founder?name=&company=&model= : founder background check (public).
 * Every item is quoted from a cited source; the brief is AI-written with
 * checked citations when a free model is configured, otherwise quoted.
 * Signed-in users with an imported network also get backchannel references:
 * their own contacts at the founder's current and past companies (never sent
 * to any external service).
 */
import { runFounderCheck, normalizePersonName } from '../../server/founderCheck';
import { getUserId } from '../../server/auth';

export const config = { api: { responseLimit: '4mb' }, maxDuration: 60 };

const MAX_REFERENCE_COMPANIES = 15;

async function backchannelReferences(req, res, result, typedCompany) {
  try {
    const userId = await getUserId(req, res);
    if (!userId) return { available: false, reason: 'Sign in and import your network to see people you know at these companies.' };
    const network = await import('../../server/network/store');
    if (typeof network.findContactsAtCompanies !== 'function') return { available: false, reason: 'Network data is not available.' };
    const total = typeof network.countContacts === 'function' ? await network.countContacts(userId) : null;
    if (total === 0) {
      return { available: false, reason: 'Import your network (LinkedIn Connections.csv or any CSV of contacts) to see people you know at these companies.' };
    }
    const companies = [...new Set([
      typedCompany,
      result.company,
      result.currentRole?.company,
      ...(result.profiles || []).map((p) => p.company),
      ...(result.pastCompanies || []).map((p) => p.company),
    ].filter(Boolean).map((c) => String(c).trim()))].slice(0, MAX_REFERENCE_COMPANIES);
    if (companies.length === 0) {
      return { available: true, checked: total, companies, contacts: [], reason: 'No company could be found for this person in the sources, so there is nothing to match your network against. Add the company to the check.' };
    }
    const contacts = await network.findContactsAtCompanies(userId, companies);
    return { available: true, checked: total, companies, contacts: (contacts || []).slice(0, 50) };
  } catch (error) {
    return { available: false, reason: 'Network data is not available right now.' };
  }
}

export default async function handler(req, res) {
  const startedAt = Date.now(); // the brief must finish inside maxDuration (60s)
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const name = normalizePersonName(req.query.name);
  const company = String(req.query.company || '').trim();
  const model = typeof req.query.model === 'string' && req.query.model ? req.query.model : 'auto';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.split(' ').length < 2) return res.status(400).json({ error: 'Enter the full name (first and last name).' });
  if (name.length > 120) return res.status(400).json({ error: 'name must be 120 characters or fewer' });
  if (company.length > 120) return res.status(400).json({ error: 'company must be 120 characters or fewer' });
  try {
    const result = await runFounderCheck({ name, company, model, deadline: startedAt + 50000 });
    const references = await backchannelReferences(req, res, result, company);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ...result, references });
  } catch (error) {
    console.error('Founder check failed:', error.message);
    return res.status(500).json({ error: 'Founder check failed. Please try again.' });
  }
}
