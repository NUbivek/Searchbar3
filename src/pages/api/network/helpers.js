/**
 * Who in my network can help with this company or founder?
 *
 *   POST { companies?: string[], keywords?: string[], person?: string }
 *   -> { available, reason?, checked,
 *        atCompany:   [{ contact, matchedCompany, role, roleLabel }],   people at the companies (reference calls, customers, former colleagues)
 *        atRelated:   [{ contact, matchedCompany, role, roleLabel }],   people at the related companies given (investors, competitors)
 *        experts:     [{ contact, score, reasons, role, roleLabel }],   diligence-lens contacts matching the industry keywords
 *        investors:   [{ contact, score, reasons, role, roleLabel }] }  raise-lens contacts matching the keywords (who could co-invest or fund)
 *
 * `companies[0]` is the company in question; the rest are related companies
 * (its investors, competitors). Signed-out callers get available: false.
 * Contacts never leave the server; only the caller's own saved network is read.
 */
import { getUserId } from '../../../server/auth';
import { persistenceMode } from '../../../server/db';
import { listContacts, findContactsAtCompanies, countContacts } from '../../../server/network/store';
import { scoreContacts } from '../../../server/network/query';
import { classifyContact } from '../../../utils/network/roles';

const MAX_COMPANIES = 30;
const MAX_KEYWORDS = 6;
const MAX_PER_GROUP = 25;

function clean(list, max, len) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const s = String(v || '').trim().slice(0, len);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function withRole(row) {
  const kind = classifyContact(row.contact || row);
  return { ...row, role: kind.role, roleLabel: kind.label };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const companies = clean(req.body?.companies, MAX_COMPANIES, 120);
  const keywords = clean(req.body?.keywords, MAX_KEYWORDS, 60);
  const person = String(req.body?.person || '').trim().slice(0, 120);
  if (!companies.length && !keywords.length) return res.status(400).json({ error: 'Give at least one company or keyword.' });

  const userId = await getUserId(req, res);
  if (!userId) return res.status(200).json({ available: false, reason: 'Sign in and import your network to see who you know here.' });
  if (persistenceMode() === 'none') return res.status(200).json({ available: false, reason: 'Network data is not available on this deployment.' });

  try {
    const checked = await countContacts(userId);
    if (!checked) return res.status(200).json({ available: false, reason: 'Import your network (LinkedIn Connections.csv or any CSV of contacts) to see who you know here.', checked: 0 });

    const [target, ...related] = companies;
    const [atTarget, atRelatedRows] = await Promise.all([
      target ? findContactsAtCompanies(userId, [target]) : [],
      related.length ? findContactsAtCompanies(userId, related) : [],
    ]);
    const seen = new Set();
    const dedupe = (rows) => rows.filter((r) => {
      const k = `${r.name}|${r.company}`.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const atCompany = dedupe(atTarget).slice(0, MAX_PER_GROUP).map((r) => withRole({ contact: r, matchedCompany: r.matchedCompany }));
    const atRelated = dedupe(atRelatedRows).slice(0, MAX_PER_GROUP).map((r) => withRole({ contact: r, matchedCompany: r.matchedCompany }));

    let experts = [];
    let investors = [];
    if (keywords.length) {
      const all = await listContacts(userId);
      const notAtTarget = (r) => !seen.has(`${r.contact.name}|${r.contact.company}`.toLowerCase());
      experts = scoreContacts(all, { keywords, lens: 'diligence' }, { limit: MAX_PER_GROUP * 2 }).results.filter(notAtTarget).slice(0, MAX_PER_GROUP).map(withRole);
      investors = scoreContacts(all, { keywords, lens: 'raise' }, { limit: MAX_PER_GROUP * 2 }).results.filter(notAtTarget).slice(0, MAX_PER_GROUP).map(withRole);
    }
    return res.status(200).json({ available: true, checked, companies, keywords, person: person || undefined, atCompany, atRelated, experts, investors });
  } catch (error) {
    console.error('Network helpers failed:', error.message);
    return res.status(200).json({ available: false, reason: 'Network data is not available right now.' });
  }
}
