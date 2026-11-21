/**
 * Signed-in persistence for imported network contacts (Network Map).
 *
 * The table is created lazily here, so the shared schema in db.js does not
 * need to change. All queries are parameterized. Contacts are only ever read
 * back for their owner; nothing here sends contact data anywhere else.
 */
import crypto from 'crypto';
import { query, persistenceMode } from '../db';
import {
  normalizeContact, dedupeContacts, dedupeKey, normalizeCompanyKey, companyMatch, companyFormMatch, companyFormBase, MAX_CONTACTS, SOURCES,
} from '../../utils/network/parseContacts';
import { isOrdinaryWordCompany, isBroadOrganisation } from '../founder/names';

export const MAX_CONTACTS_PER_USER = MAX_CONTACTS;
const BATCH_SIZE = 500;
// Rows of an import in progress carry this prefix on dedupe_key; see replaceContacts.
const STAGED_PREFIX = 'staged:';
const ACTIVE_WHERE = "dedupe_key NOT LIKE 'staged:%'";

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
  // Added later: direct connection vs firm-wide CRM contact, and whose contact it is.
  'ALTER TABLE network_contacts ADD COLUMN IF NOT EXISTS relationship TEXT',
  'ALTER TABLE network_contacts ADD COLUMN IF NOT EXISTS via TEXT',
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
  'email', 'profile_url', 'location', 'connected_on', 'tags', 'relationship', 'via', 'dedupe_key'];

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
    relationship: r.relationship === 'firm' ? 'firm' : 'direct',
    via: r.via || '',
  };
}

/**
 * Replace all of the user's contacts from one source with a new import,
 * without ever leaving the account with neither the old nor the new rows.
 *
 * The database layer exposes single statements only (no interactive
 * transactions on Neon's HTTP driver), so the import is staged:
 *  1. new rows are inserted in batches of 500 with a `staged:<token>:`
 *     prefix on dedupe_key; every read filters such rows out, so nothing
 *     changes for the user while batches run;
 *  2. one statement then deletes the old rows of that source, drops staged
 *     rows that duplicate a contact already saved from another source, and
 *     activates the rest (prefix removed). A single statement is atomic, so
 *     a failure anywhere leaves the previous import untouched.
 * Leftover staged rows from a crashed import are purged on the next one.
 * Returns { saved, duplicates, truncated, contacts } where contacts are the
 * rows now saved for that source (compact shape, see compactContact).
 */
export async function replaceContacts(userId, source, contacts) {
  if (!SOURCES.includes(source)) throw new Error(`Unknown source: ${source}`);
  await ensureTable();
  const clean = dedupeContacts((contacts || []).map((c) => normalizeContact(c, source)).filter(Boolean));
  const token = `${STAGED_PREFIX}${crypto.randomBytes(8).toString('hex')}:`;

  await query(`DELETE FROM network_contacts WHERE user_id = $1 AND dedupe_key LIKE '${STAGED_PREFIX}%'`, [userId]);
  const [{ n: others } = { n: 0 }] = await query(
    `SELECT COUNT(*)::int AS n FROM network_contacts WHERE user_id = $1 AND source <> $2 AND ${ACTIVE_WHERE}`,
    [userId, source]
  );
  const room = Math.max(0, MAX_CONTACTS_PER_USER - Number(others || 0));
  const toInsert = clean.slice(0, room);

  try {
    for (let start = 0; start < toInsert.length; start += BATCH_SIZE) {
      const batch = toInsert.slice(start, start + BATCH_SIZE);
      const params = [];
      const tuples = batch.map((c) => {
        const base = params.length;
        params.push(
          userId, source, c.name, c.firstName || null, c.lastName || null, c.company || null,
          normalizeCompanyKey(c.company) || null, c.position || null, c.email || null, c.profileUrl || null,
          c.location || null, c.connectedOn || null, JSON.stringify(c.tags || []),
          c.relationship === 'firm' ? 'firm' : 'direct', c.via || null, `${token}${dedupeKey(c)}`
        );
        const ph = COLUMNS.map((col, i) => {
          const p = `$${base + i + 1}`;
          if (col === 'connected_on') return `${p}::date`;
          if (col === 'tags') return `${p}::jsonb`;
          return p;
        });
        return `(${ph.join(', ')})`;
      });
      await query(
        `INSERT INTO network_contacts (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}
         ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
        params
      );
    }
  } catch (error) {
    // Best effort: the staged rows are invisible anyway and purged next time.
    await query('DELETE FROM network_contacts WHERE user_id = $1 AND dedupe_key LIKE $2', [userId, `${token}%`]).catch(() => {});
    throw error;
  }

  // Swap in one statement. `activated` references `removed` so the old rows
  // are gone before any staged row takes a plain dedupe_key (the unique
  // index is checked row by row, but rows deleted in this statement no
  // longer count). Staged rows whose contact is already saved from another
  // source are dropped and reported as duplicates.
  const prefixLen = token.length;
  const [row] = await query(
    `WITH removed AS (
       DELETE FROM network_contacts WHERE user_id = $1 AND source = $2 AND ${ACTIVE_WHERE} RETURNING id
     ), dupes AS (
       DELETE FROM network_contacts s
        WHERE s.user_id = $1 AND s.dedupe_key LIKE $3
          AND EXISTS (SELECT 1 FROM network_contacts a
                       WHERE a.user_id = $1 AND a.source <> $2 AND a.${ACTIVE_WHERE}
                         AND a.dedupe_key = substr(s.dedupe_key, $4 + 1))
        RETURNING id
     ), activated AS (
       UPDATE network_contacts s SET dedupe_key = substr(s.dedupe_key, $4 + 1)
        WHERE s.user_id = $1 AND s.dedupe_key LIKE $3
          AND (SELECT COUNT(*) FROM removed) >= 0
          AND NOT EXISTS (SELECT 1 FROM network_contacts a
                           WHERE a.user_id = $1 AND a.source <> $2 AND a.${ACTIVE_WHERE}
                             AND a.dedupe_key = substr(s.dedupe_key, $4 + 1))
        RETURNING s.id, s.source, s.name, s.company, s.position, s.email, s.profile_url, s.location, s.connected_on, s.tags, s.relationship, s.via
     )
     SELECT (SELECT COUNT(*)::int FROM activated) AS saved,
            (SELECT COUNT(*)::int FROM dupes) AS duplicates,
            (SELECT COALESCE(json_agg(activated ORDER BY lower(name)), '[]'::json) FROM activated) AS contacts`,
    [userId, source, `${token}%`, prefixLen]
  );
  let savedRows = row?.contacts ?? [];
  if (typeof savedRows === 'string') { try { savedRows = JSON.parse(savedRows); } catch { savedRows = []; } }
  const saved = Number(row?.saved) || 0;
  return {
    saved,
    duplicates: Number(row?.duplicates) || 0,
    truncated: clean.length - toInsert.length,
    contacts: (Array.isArray(savedRows) ? savedRows : []).map((r) => compactContact(rowFromDb(r))),
  };
}

/**
 * The shape sent to the browser for the graph: empty fields dropped, no id
 * or split names (the page only uses name, company, position, profileUrl,
 * location, connectedOn, source, and email/tags when present). Roughly
 * halves the payload of a 30,000-contact network.
 */
export function compactContact(c) {
  const out = { name: c.name, source: c.source };
  for (const field of ['company', 'position', 'location', 'profileUrl', 'connectedOn', 'email']) {
    if (c[field]) out[field] = c[field];
  }
  if (Array.isArray(c.tags) && c.tags.length) out.tags = c.tags;
  if (c.relationship === 'firm') { out.relationship = 'firm'; if (c.via) out.via = c.via; }
  return out;
}

/** All of the user's contacts, sorted by name. */
export async function listContacts(userId) {
  await ensureTable();
  const rows = await query(
    `SELECT id, source, name, first_name, last_name, company, position, email, profile_url, location,
            connected_on, tags, relationship, via
       FROM network_contacts WHERE user_id = $1 AND ${ACTIVE_WHERE} ORDER BY lower(name) LIMIT ${MAX_CONTACTS_PER_USER}`,
    [userId]
  );
  return rows.map(rowFromDb);
}

/** Counts and last import time per source. */
export async function contactStats(userId) {
  await ensureTable();
  const rows = await query(
    `SELECT source, COUNT(*)::int AS n, MAX(created_at) AS last_import
       FROM network_contacts WHERE user_id = $1 AND ${ACTIVE_WHERE} GROUP BY source`,
    [userId]
  );
  const bySource = { linkedin: 0, csv: 0, x: 0, attio: 0 };
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
  const [row] = await query(`SELECT COUNT(*)::int AS n FROM network_contacts WHERE user_id = $1 AND ${ACTIVE_WHERE}`, [userId]);
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
 *
 * Founder Check passes options and gets the careful form instead:
 *   { strict }      throw on failure, so a failed lookup is never read as "nobody works there";
 *   { similar }     also match a one-word name written longer with only company-form words
 *                   ("Nikola" / "Nikola Motor Company"; each row says match: 'similar');
 *   { investor }    with similar, a fund's form words count too ("Sequoia" / "Sequoia Capital");
 *   { perCompany }  at most this many rows per saved company (senior titles and direct contacts
 *                   first), so one big former employer cannot crowd out the current company;
 *   { detail }      (implies strict) -> { rows, truncated: [{ company, shown, total }], incomplete }.
 * Without options the Network Map's behaviour is unchanged.
 */
export async function findContactsAtCompanies(userId, companyNames, opts = null) {
  if (opts && typeof opts === 'object') return findContactsAtCompaniesCareful(userId, companyNames, opts);
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
      `SELECT name, company, company_key, position, profile_url, connected_on, source, relationship, via
         FROM network_contacts
        WHERE user_id = $1 AND company_key IS NOT NULL AND company_key <> '' AND ${ACTIVE_WHERE}
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
        relationship: c.relationship,
        via: c.via,
        matchedCompany: hit.name,
      });
    }
    return out;
  } catch (error) {
    console.warn('findContactsAtCompanies failed:', error.message);
    return [];
  }
}

const SENIOR_TITLE_SQL = "(CASE WHEN position ~* '(founder|chief|\\mceo\\M|\\mcto\\M|\\mcfo\\M|\\mcoo\\M|president|\\mvp\\M|vice president|director|partner|head of)' THEN 0 ELSE 1 END)";
const DEFAULT_PER_COMPANY = 200;

/** The careful company lookup behind findContactsAtCompanies(userId, names, opts). */
async function findContactsAtCompaniesCareful(userId, companyNames, { strict = false, similar = false, investor = false, perCompany = null, detail = false } = {}) {
  const empty = detail ? { rows: [], truncated: [], incomplete: false } : [];
  try {
    if (!userId || persistenceMode() === 'none') return empty;
    const targets = [];
    for (const name of Array.isArray(companyNames) ? companyNames : [companyNames]) {
      const key = normalizeCompanyKey(name);
      if (key && !targets.some((t) => t.key === key)) targets.push({ name: String(name).trim(), key });
      if (targets.length >= 50) break;
    }
    if (!targets.length) return empty;
    await ensureTable();
    const keys = targets.map((t) => t.key);
    const exact = new Set(keys);
    const likes = keys.filter((k) => k.includes(' ')).map((k) => `%${k}%`);
    if (similar) {
      for (const k of keys) {
        if (!k.includes(' ')) likes.push(`${k} %`); // "nikola" -> "nikola motor company"
        const base = companyFormBase(k, { investor });
        if (base) exact.add(base); // "nikola motor company" -> "nikola"
      }
    }
    const cap = Math.max(1, Math.min(2000, Number(perCompany) || DEFAULT_PER_COMPANY));
    const limit = Math.min(20000, cap * Math.max(targets.length, 1) * 2);
    // Ranked within each saved company: senior titles, then direct contacts, then the
    // longest-standing connection. key_total says how many there were before the cut.
    // The outer order is by that rank, so when the overall LIMIT cuts, it drops each company's
    // lowest-ranked rows first, never the true matches whose names come late in the alphabet.
    const rows = await query(
      `SELECT name, company, company_key, position, profile_url, connected_on, source, relationship, via, key_total
         FROM (
           SELECT name, company, company_key, position, profile_url, connected_on, source, relationship, via,
                  ROW_NUMBER() OVER (PARTITION BY company_key ORDER BY ${SENIOR_TITLE_SQL}, (relationship = 'firm'), connected_on NULLS LAST, lower(name)) AS rn,
                  COUNT(*) OVER (PARTITION BY company_key) AS key_total
             FROM network_contacts
            WHERE user_id = $1 AND company_key IS NOT NULL AND company_key <> '' AND ${ACTIVE_WHERE}
              AND (company_key = ANY($2::text[])
                   OR company_key LIKE ANY($3::text[])
                   OR (strpos(company_key, ' ') > 0
                       AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS t(k) WHERE t.k LIKE '%' || company_key || '%')))
         ) c
        WHERE rn <= $4
        ORDER BY rn, company_key
        LIMIT ${limit}`,
      [userId, [...exact], likes, cap]
    );
    const out = [];
    const perKey = new Map(); // contact company_key -> { target, total, shown }
    for (const r of rows || []) {
      let match = null;
      let hit = null;
      for (const t of targets) {
        match = companyMatch(r.company_key, t.key);
        if (match) { hit = t; break; }
      }
      if (!hit && similar) {
        for (const t of targets) {
          match = companyFormMatch(r.company_key, t.key, { investor });
          if (match) { hit = t; break; }
        }
      }
      if (!hit) continue;
      const c = rowFromDb(r);
      out.push({
        name: c.name, company: c.company, position: c.position, profileUrl: c.profileUrl, connectedOn: c.connectedOn,
        source: c.source, relationship: c.relationship, via: c.via, matchedCompany: hit.name, match,
      });
      const k = perKey.get(r.company_key) || { target: hit.name, total: Number(r.key_total) || 0, shown: 0 };
      k.shown += 1;
      perKey.set(r.company_key, k);
    }
    if (!detail) return out;
    const byTarget = new Map();
    for (const k of perKey.values()) {
      const t = byTarget.get(k.target) || { company: k.target, shown: 0, total: 0 };
      t.shown += k.shown;
      t.total += Math.max(k.total, k.shown);
      byTarget.set(k.target, t);
    }
    return { rows: out, truncated: [...byTarget.values()].filter((t) => t.total > t.shown), incomplete: (rows || []).length >= limit };
  } catch (error) {
    console.warn('findContactsAtCompanies failed:', error.message);
    if (strict || detail) throw error;
    return empty;
  }
}

/**
 * For Founder Check: contacts whose title names one of these companies as a
 * whole word ("Partner · ex-Theranos"), though their company field is
 * elsewhere: possibly a former colleague. Only distinctive names are looked
 * for: an ordinary word ("Ramp"), a very large organisation, or a short name
 * would match too many titles that have nothing to do with the company.
 * Email and location are never selected. Throws on failure.
 *   -> [{ name, company, position, profileUrl, connectedOn, source, relationship, via, matchedCompany }]
 */
export async function findContactsByTitleMention(userId, companyNames, { limit = 300 } = {}) {
  if (!userId || persistenceMode() === 'none') return [];
  const targets = [];
  for (const name of Array.isArray(companyNames) ? companyNames : [companyNames]) {
    const key = normalizeCompanyKey(name);
    if (!key || targets.some((t) => t.key === key)) continue;
    const words = key.split(' ');
    if (!words.every((w) => /^[a-z0-9]+$/.test(w))) continue; // plain letters only, so the pattern needs no escaping
    if (words.length === 1 && (key.length < 5 || isOrdinaryWordCompany(name))) continue;
    if (isBroadOrganisation(name)) continue;
    targets.push({ name: String(name).trim(), key, words });
    if (targets.length >= 40) break;
  }
  if (!targets.length) return [];
  try {
    await ensureTable();
    const patterns = targets.map((t) => `(^|[^[:alnum:]])${t.words.join('[^[:alnum:]]+')}($|[^[:alnum:]])`);
    const rows = await query(
      `SELECT name, company, company_key, position, profile_url, connected_on, source, relationship, via
         FROM network_contacts
        WHERE user_id = $1 AND ${ACTIVE_WHERE} AND position IS NOT NULL AND position ~* ANY($2::text[])
        ORDER BY lower(name)
        LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 300))}`,
      [userId, patterns]
    );
    const out = [];
    for (const r of rows || []) {
      const pos = String(r.position || '');
      const hit = targets.find((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${t.words.join('[^\\p{L}\\p{N}]+')}($|[^\\p{L}\\p{N}])`, 'iu').test(pos));
      if (!hit) continue;
      const c = rowFromDb(r);
      out.push({
        name: c.name, company: c.company, position: c.position, profileUrl: c.profileUrl, connectedOn: c.connectedOn,
        source: c.source, relationship: c.relationship, via: c.via, matchedCompany: hit.name,
      });
    }
    return out;
  } catch (error) {
    console.warn('findContactsByTitleMention failed:', error.message);
    throw error;
  }
}

// ------------------------------------------------------------ names (Founder Check)
//
// Founder Check decides "same full name" with founder/networkLink.js nameKeys():
// no bracketed nickname, nothing after a comma, no leading title or trailing
// degree, accents removed, apostrophes and dots dropped, any other character
// outside a-z 0-9 - read as a space. The SQL below must find every row that
// rule could accept, so the stored name is folded the same way in SQL
// (translate) and both the first and the last word of the name must appear
// in it as whole words. The caller still checks the full name.

const HONORIFIC = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'sir', 'dame']);
const CREDENTIAL = new Set(['phd', 'mba', 'md', 'cfa', 'cpa', 'esq', 'jd', 'msc', 'bsc', 'ma', 'ba', 'pe', 'pmp']);
const COMBINING = /[\u0300-\u036f]/g;
const DROPPED = "'’`.";

// Every Latin letter whose accents fold away to one plain letter, for translate() in SQL.
const [FOLD_FROM, FOLD_TO] = (() => {
  let from = '';
  let to = '';
  const ranges = [[0xc0, 0x24f], [0x1e00, 0x1eff]];
  for (const [a, b] of ranges) {
    for (let cp = a; cp <= b; cp += 1) {
      const ch = String.fromCodePoint(cp);
      const plain = ch.normalize('NFKD').replace(COMBINING, '').toLowerCase();
      if (/^[a-z]$/.test(plain) && plain !== ch) { from += ch; to += plain; }
    }
  }
  // Characters past the end of FOLD_TO are deleted by translate().
  return [from + DROPPED, to];
})();

/** The stored name folded in SQL like foldName() folds it in JS, with a space at each end. */
const FOLDED_NAME_SQL = "' ' || regexp_replace(translate(lower(name), $3, $4), '[^a-z0-9-]+', ' ', 'g') || ' '";

/** Lower case, accents removed, apostrophes and dots dropped, other symbols as spaces (as nameKeys reads names). */
export function foldName(name) {
  return String(name || '')
    .normalize('NFKD').replace(COMBINING, '')
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first and last word of a person's full name, folded; null for a one-word name. */
function firstAndLast(name) {
  const cleaned = String(name || '').replace(/\([^)]*\)/g, ' ').split(',')[0]
    .replace(/["“”„]/g, '').replace(/[’']s\b/g, '');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  while (tokens.length > 2 && HONORIFIC.has(tokens[0].toLowerCase().replace(/\./g, ''))) tokens.shift();
  while (tokens.length > 2 && CREDENTIAL.has(tokens[tokens.length - 1].toLowerCase().replace(/\./g, ''))) tokens.pop();
  if (tokens.length < 2) return null;
  const words = foldName(tokens.join(' ')).split(' ').filter(Boolean);
  if (words.length < 2) return null;
  return [words[0], words[words.length - 1]];
}

/** A LIKE pattern for one whole folded word in the spaced, folded name (words hold only a-z 0-9 -). */
const wholeWord = (w) => `% ${w} %`;

/** Most rows one lookup returns. More than this and the lookup fails rather than return a partial list. */
export const NAME_MATCH_LIMIT = 1000;

/**
 * For Founder Check: which of the user's saved contacts carry one of these
 * names? The SQL only narrows the rows down (the folded stored name holds
 * both the first and the last word of a name); the caller decides what
 * counts as the same full name (see founder/networkLink.js). Email and
 * location are never selected.
 *
 * findContactsByNames(userId, names: string[])
 *   -> Promise<Array<{ name, company, position, profileUrl, connectedOn, source, relationship, via }>>
 *
 * Returns [] when signed out or without persistence. Throws when the
 * lookup fails or would return more than NAME_MATCH_LIMIT rows, so a partial
 * list is never taken for the whole one (both callers in networkLink.js
 * catch: no seed, and "could not be read" on the report).
 */
export async function findContactsByNames(userId, names) {
  if (!userId || persistenceMode() === 'none') return [];
  const pairs = [];
  const seen = new Set();
  for (const name of Array.isArray(names) ? names : [names]) {
    const pair = firstAndLast(name);
    if (!pair) continue;
    const key = pair.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(pair);
    if (pairs.length >= 120) break;
  }
  if (!pairs.length) return [];
  try {
    await ensureTable();
    const firsts = pairs.map(([f]) => wholeWord(f));
    const lasts = pairs.map(([, l]) => wholeWord(l));
    // Pair i matches when the folded name holds first word i and last word i as whole words.
    const rows = await query(
      `SELECT name, company, position, profile_url, connected_on, source, relationship, via
         FROM (
           SELECT name, company, position, profile_url, connected_on, source, relationship, via,
                  ${FOLDED_NAME_SQL} AS folded
             FROM network_contacts
            WHERE user_id = $1 AND ${ACTIVE_WHERE}
         ) c
        WHERE EXISTS (
          SELECT 1 FROM unnest($2::text[], $5::text[]) AS p(f, l)
           WHERE c.folded LIKE p.f AND c.folded LIKE p.l
        )
        ORDER BY lower(name)
        LIMIT ${NAME_MATCH_LIMIT + 1}`,
      [userId, firsts, FOLD_FROM, FOLD_TO, lasts]
    );
    if ((rows || []).length > NAME_MATCH_LIMIT) {
      // Marked, so a caller can retry the names one by one and drop only the over-common ones.
      throw Object.assign(new Error(`more than ${NAME_MATCH_LIMIT} contacts share these names`), { code: 'too_many' });
    }
    return (rows || []).map((r) => {
      const c = rowFromDb(r);
      return {
        name: c.name, company: c.company, position: c.position, profileUrl: c.profileUrl,
        connectedOn: c.connectedOn, source: c.source, relationship: c.relationship, via: c.via,
      };
    });
  } catch (error) {
    console.warn('findContactsByNames failed:', error.message);
    throw error;
  }
}
