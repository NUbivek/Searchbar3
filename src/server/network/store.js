/**
 * Signed-in persistence for imported network contacts (Network Map).
 *
 * The table is created lazily here, so the shared schema in db.js does not
 * need to change. All queries are parameterized. Contacts are only ever read
 * back for their owner; nothing here sends contact data anywhere else.
 */
import { query, persistenceMode } from '../db';
import {
  normalizeContact, dedupeContacts, dedupeKey, normalizeCompanyKey, companyMatch, MAX_CONTACTS, SOURCES,
} from '../../utils/network/parseContacts';

export const MAX_CONTACTS_PER_USER = MAX_CONTACTS;
const BATCH_SIZE = 500;

const TABLE_SQL = [
  `CREATE TABLE IF NOT EXISTS network_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    company TEXT,
    company_key TEXT,
    position TEXT,
    email TEXT,
    profile_url TEXT,
    location TEXT,
    connected_on DATE,
    tags JSONB,
    dedupe_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, dedupe_key)
  )`,
  'CREATE INDEX IF NOT EXISTS network_contacts_user_company_idx ON network_contacts(user_id, company_key)',
];

let tablePromise = null;

async function ensureTable() {
  if (!tablePromise) {
    tablePromise = (async () => {
      for (const statement of TABLE_SQL) await query(statement);
    })().catch((error) => {
      tablePromise = null;
      throw error;
    });
  }
  return tablePromise;
}

/** For tests. */
export function __resetForTests() {
  tablePromise = null;
}

const COLUMNS = ['user_id', 'source', 'name', 'first_name', 'last_name', 'company', 'company_key', 'position',
  'email', 'profile_url', 'location', 'connected_on', 'tags', 'dedupe_key'];

function rowFromDb(r) {
  let tags = r.tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch { tags = []; }
  }
  const connected = r.connected_on instanceof Date
    ? r.connected_on.toISOString().slice(0, 10)
    : (r.connected_on ? String(r.connected_on).slice(0, 10) : null);
  return {
    id: r.id,
    name: r.name,
    firstName: r.first_name || '',
    lastName: r.last_name || '',
    company: r.company || '',
    position: r.position || '',
    email: r.email || '',
    profileUrl: r.profile_url || '',
    location: r.location || '',
    connectedOn: connected,
    source: r.source,
    tags: Array.isArray(tags) ? tags : [],
  };
}

/**
 * Replace all of the user's contacts from one source with a new import.
 * Deletes that source, then inserts in multi-row batches of 500. Contacts
 * already saved from another source (same profile URL / email / name +
 * company) are kept under that source and counted as duplicates.
 * Returns { saved, duplicates, truncated }.
 */
export async function replaceContacts(userId, source, contacts) {
  if (!SOURCES.includes(source)) throw new Error(`Unknown source: ${source}`);
  await ensureTable();
  const clean = dedupeContacts((contacts || []).map((c) => normalizeContact(c, source)).filter(Boolean));

  await query('DELETE FROM network_contacts WHERE user_id = $1 AND source = $2', [userId, source]);
  const [{ n: others } = { n: 0 }] = await query(
    'SELECT COUNT(*)::int AS n FROM network_contacts WHERE user_id = $1', [userId]
  );
  const room = Math.max(0, MAX_CONTACTS_PER_USER - Number(others || 0));
  const toInsert = clean.slice(0, room);

  let saved = 0;
  for (let start = 0; start < toInsert.length; start += BATCH_SIZE) {
    const batch = toInsert.slice(start, start + BATCH_SIZE);
    const params = [];
    const tuples = batch.map((c) => {
      const base = params.length;
      params.push(
        userId, source, c.name, c.firstName || null, c.lastName || null, c.company || null,
        normalizeCompanyKey(c.company) || null, c.position || null, c.email || null, c.profileUrl || null,
        c.location || null, c.connectedOn || null, JSON.stringify(c.tags || []), dedupeKey(c)
      );
      const ph = COLUMNS.map((col, i) => {
        const p = `$${base + i + 1}`;
        if (col === 'connected_on') return `${p}::date`;
        if (col === 'tags') return `${p}::jsonb`;
        return p;
      });
      return `(${ph.join(', ')})`;
    });
    const rows = await query(
      `INSERT INTO network_contacts (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
      params
    );
    saved += Array.isArray(rows) ? rows.length : 0;
  }
  return {
    saved,
    duplicates: toInsert.length - saved,
    truncated: clean.length - toInsert.length,
  };
}

/** All of the user's contacts, sorted by name. */
export async function listContacts(userId) {
  await ensureTable();
  const rows = await query(
    `SELECT id, source, name, first_name, last_name, company, position, email, profile_url, location,
            connected_on, tags
       FROM network_contacts WHERE user_id = $1 ORDER BY lower(name) LIMIT ${MAX_CONTACTS_PER_USER}`,
    [userId]
  );
  return rows.map(rowFromDb);
}

/** Counts and last import time per source. */
export async function contactStats(userId) {
  await ensureTable();
  const rows = await query(
    `SELECT source, COUNT(*)::int AS n, MAX(created_at) AS last_import
       FROM network_contacts WHERE user_id = $1 GROUP BY source`,
    [userId]
  );
  const bySource = { linkedin: 0, csv: 0, x: 0 };
  const lastImportBySource = {};
  let lastImportAt = null;
  for (const r of rows) {
    bySource[r.source] = Number(r.n) || 0;
    const at = r.last_import ? new Date(r.last_import).toISOString() : null;
    lastImportBySource[r.source] = at;
    if (at && (!lastImportAt || at > lastImportAt)) lastImportAt = at;
  }
  const total = Object.values(bySource).reduce((a, b) => a + b, 0);
  return { total, bySource, lastImportAt, lastImportBySource, limit: MAX_CONTACTS_PER_USER };
}

export async function countContacts(userId) {
  await ensureTable();
  const [row] = await query('SELECT COUNT(*)::int AS n FROM network_contacts WHERE user_id = $1', [userId]);
  return Number(row?.n) || 0;
}

/** Remove every saved contact for the user. Returns the number deleted. */
export async function deleteAllContacts(userId) {
  await ensureTable();
  const rows = await query('DELETE FROM network_contacts WHERE user_id = $1 RETURNING id', [userId]);
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * For Founder Check and other features: which of the user's saved contacts
 * work at any of these companies?
 *
 * findContactsAtCompanies(userId, companyNames: string[])
 *   -> Promise<Array<{ name, company, position, profileUrl, connectedOn, source, matchedCompany }>>
 *
 * Matching uses normalised company keys ("Stripe, Inc." == "stripe"): exact,
 * or whole-word containment either way when the shorter name has two or more
 * words. matchedCompany is the input name that matched. Never throws: returns
 * [] when signed out, when persistence is unavailable, or with no data.
 */
export async function findContactsAtCompanies(userId, companyNames) {
  try {
    if (!userId || persistenceMode() === 'none') return [];
    const targets = [];
    for (const name of Array.isArray(companyNames) ? companyNames : [companyNames]) {
      const key = normalizeCompanyKey(name);
      if (key && !targets.some((t) => t.key === key)) targets.push({ name: String(name).trim(), key });
      if (targets.length >= 50) break;
    }
    if (!targets.length) return [];
    await ensureTable();
    const keys = targets.map((t) => t.key);
    const multi = keys.filter((k) => k.includes(' '));
    // Pre-filter in SQL (exact keys, or a multi-word key inside the contact's
    // key, or the contact's multi-word key inside a target); verify in JS.
    const rows = await query(
      `SELECT name, company, company_key, position, profile_url, connected_on, source
         FROM network_contacts
        WHERE user_id = $1 AND company_key IS NOT NULL AND company_key <> ''
          AND (company_key = ANY($2::text[])
               OR company_key LIKE ANY($3::text[])
               OR (strpos(company_key, ' ') > 0
                   AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS t(k) WHERE t.k LIKE '%' || company_key || '%')))
        ORDER BY lower(name)
        LIMIT 2000`,
      [userId, keys, multi.map((k) => `%${k}%`)]
    );
    const out = [];
    for (const r of rows || []) {
      const hit = targets.find((t) => companyMatch(r.company_key, t.key));
      if (!hit) continue;
      const c = rowFromDb(r);
      out.push({
        name: c.name,
        company: c.company,
        position: c.position,
        profileUrl: c.profileUrl,
        connectedOn: c.connectedOn,
        source: c.source,
        matchedCompany: hit.name,
      });
    }
    return out;
  } catch (error) {
    console.warn('findContactsAtCompanies failed:', error.message);
    return [];
  }
}
