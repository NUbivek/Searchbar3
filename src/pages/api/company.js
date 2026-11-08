/**
 * GET /api/company?name=<company> -> cited company profile (public, no sign-in).
 * Every fact in the response is a quoted sentence with a numbered source.
 */
import { buildCompanyProfile } from '../../server/companyProfile';

// Profiles call several upstream sources; Vercel's default function limit is 10s.
export const config = { api: { responseLimit: '4mb' }, maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const name = typeof req.query.name === 'string' ? req.query.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) return res.status(400).json({ error: 'Missing ?name= (company name)' });
  if (name.length > 120) return res.status(400).json({ error: 'Company name is too long (max 120 characters)' });

  try {
    const profile = await buildCompanyProfile(name);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json(profile);
  } catch (error) {
    console.error('Company profile error:', error);
    return res.status(500).json({
      error: 'Could not build the company profile. Please try again.',
      ...(process.env.NODE_ENV === 'development' ? { detail: String(error?.message || error) } : {}),
    });
  }
}
