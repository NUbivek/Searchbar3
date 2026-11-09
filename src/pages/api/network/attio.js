/**
 * Import people from an Attio CRM workspace into the signed-in user's network.
 *
 *   POST { token: string }
 *   -> { saved, direct, firm, companies, members, truncated, note?, stats, contacts }
 *
 * The token is an Attio API access token the user pastes in; it is used for
 * this request only and never stored or logged. People are read with
 * POST /v2/objects/people/records/query (500 per page), companies with the
 * same endpoint on `companies` (to turn the company reference into a name),
 * and workspace members with GET /v2/workspace_members.
 *
 * Direct vs firm-wide: Attio tracks who in the workspace has the strongest
 * connection to each person (`strongest_connection_user`). When that member's
 * email is the signed-in user's email the contact is a *direct* connection;
 * otherwise it is a *firm* contact held by a colleague, saved with
 * relationship 'firm' and `via` set to the colleague's name so the map and
 * every answer can tell the two apart. Without member access (token scope)
 * every contact is saved as firm-wide.
 */
import { withUser } from '../../../server/apiHelpers';
import { getUserEmail } from '../../../server/auth';
import { replaceContacts, contactStats, MAX_CONTACTS_PER_USER } from '../../../server/network/store';

const API = 'https://api.attio.com/v2';
const PAGE = 500;
const MAX_PAGES = 60; // 30,000 people
const TIMEOUT_MS = 20000;

export const config = { api: { bodyParser: { sizeLimit: '64kb' } }, maxDuration: 60 };

async function attio(path, token, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      const err = new Error(json?.message || json?.error || `Attio returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

const first = (values, key) => (Array.isArray(values?.[key]) && values[key].length ? values[key][0] : null);
const text = (values, key) => {
  const v = first(values, key);
  if (!v) return '';
  return String(v.value ?? v.full_name ?? v.email_address ?? v.locality ?? '').trim();
};

async function queryAll(object, token) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await attio(`/objects/${object}/records/query`, token, { method: 'POST', body: { limit: PAGE, offset: page * PAGE } });
    const rows = Array.isArray(res?.data) ? res.data : [];
    out.push(...rows);
    if (rows.length < PAGE) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}

export function mapPerson(record, { companies, members, myMemberId }) {
  const v = record?.values || {};
  const name = text(v, 'name');
  if (!name) return null;
  const nameParts = first(v, 'name') || {};
  const companyRef = first(v, 'company');
  const company = companyRef?.target_record_id ? (companies.get(companyRef.target_record_id) || '') : '';
  const loc = first(v, 'primary_location');
  const location = loc ? [loc.locality, loc.region, loc.country_code].filter(Boolean).join(', ') : '';
  const linkedin = text(v, 'linkedin');
  const twitter = text(v, 'twitter');
  const strongest = first(v, 'strongest_connection_user');
  const memberId = strongest?.referenced_actor_id || '';
  const member = memberId ? members.get(memberId) : null;
  const direct = Boolean(myMemberId && memberId && memberId === myMemberId);
  const strength = first(v, 'strongest_connection_strength');
  const strengthLabel = strength?.option?.title || strength?.value || '';
  const tags = [];
  if (strengthLabel) tags.push(`Attio: ${strengthLabel}`);
  return {
    name,
    firstName: nameParts.first_name || '',
    lastName: nameParts.last_name || '',
    company,
    position: text(v, 'job_title'),
    email: text(v, 'email_addresses'),
    profileUrl: linkedin ? (/^https?:\/\//i.test(linkedin) ? linkedin : `https://www.linkedin.com/in/${linkedin.replace(/^\/+/, '')}`) : (twitter ? (/^https?:\/\//i.test(twitter) ? twitter : `https://x.com/${twitter.replace(/^@/, '')}`) : ''),
    location,
    connectedOn: record?.created_at ? String(record.created_at).slice(0, 10) : '',
    tags,
    relationship: direct ? 'direct' : 'firm',
    via: direct ? '' : (member ? [member.first_name, member.last_name].filter(Boolean).join(' ') : ''),
  };
}

export default withUser(['POST'], async (req, res, userId) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token || token.length > 400) return res.status(400).json({ error: 'Paste an Attio API access token.' });
  res.setHeader('Cache-Control', 'no-store');

  let myEmail = '';
  try { myEmail = String((await getUserEmail(req, res)) || '').toLowerCase(); } catch { myEmail = ''; }

  // Workspace members: optional (needs the user_management:read scope).
  const members = new Map();
  let myMemberId = '';
  let note = '';
  try {
    const m = await attio('/workspace_members', token);
    for (const row of Array.isArray(m?.data) ? m.data : []) {
      const id = row?.id?.workspace_member_id;
      if (!id) continue;
      members.set(id, { first_name: row.first_name || '', last_name: row.last_name || '', email: String(row.email_address || '').toLowerCase() });
      if (myEmail && String(row.email_address || '').toLowerCase() === myEmail) myMemberId = id;
    }
    if (!myMemberId) note = myEmail
      ? `No Attio workspace member uses ${myEmail}, so every contact was saved as firm-wide. Sign in with the email you use in Attio to mark your own connections as direct.`
      : 'Your account has no email, so every contact was saved as firm-wide.';
  } catch (error) {
    if (error.status === 401) return res.status(400).json({ error: 'Attio rejected this token.' });
    note = 'The token cannot read workspace members, so every contact was saved as firm-wide. Create a token with the "user management: read" scope to mark your own connections as direct.';
  }

  try {
    const [people, companies] = await Promise.all([queryAll('people', token), queryAll('companies', token)]);
    const companyNames = new Map();
    for (const c of companies.rows) {
      const id = c?.id?.record_id;
      const name = text(c?.values || {}, 'name');
      if (id && name) companyNames.set(id, name);
    }
    const contacts = people.rows.map((r) => mapPerson(r, { companies: companyNames, members, myMemberId })).filter(Boolean);
    if (!contacts.length) return res.status(200).json({ saved: 0, direct: 0, firm: 0, companies: companyNames.size, members: members.size, truncated: false, note: 'Attio returned no people.', stats: await contactStats(userId), contacts: [] });
    const result = await replaceContacts(userId, 'attio', contacts.slice(0, MAX_CONTACTS_PER_USER));
    const direct = contacts.filter((c) => c.relationship === 'direct').length;
    return res.status(200).json({
      ...result,
      direct,
      firm: contacts.length - direct,
      companies: companyNames.size,
      members: members.size,
      truncated: Boolean(result.truncated) || people.truncated,
      ...(note ? { note } : {}),
      stats: await contactStats(userId),
    });
  } catch (error) {
    if (error.status === 401) return res.status(400).json({ error: 'Attio rejected this token.' });
    if (error.status === 403) return res.status(400).json({ error: 'This token cannot read people records. Create a token with the "record permission: read-write" or "read" scope for People and Companies.' });
    console.error('Attio import failed:', error.message);
    return res.status(502).json({ error: 'Attio could not be read right now. Please try again.' });
  }
});
