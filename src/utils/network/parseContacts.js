/**
 * Contact import parsing for the Network Map. Pure functions: runs in the
 * browser (file upload) and on the server (re-validating what the client
 * sends). Nothing here makes network calls.
 *
 * Supported inputs:
 *  - LinkedIn's own data export, Connections.csv (Settings > Data privacy >
 *    Get a copy of your data > Connections). It starts with a few "Notes:"
 *    lines, then: First Name,Last Name,URL,Email Address,Company,Position,Connected On
 *  - Any CSV / spreadsheet with recognisable headers (name, company, title...)
 *  - X API "following" JSON ({ data: [ { id, name, username, description } ] })
 *
 * Every contact is normalised to:
 *   { name, firstName, lastName, company, position, email, profileUrl,
 *     location, connectedOn (YYYY-MM-DD | null), source, tags }
 */

export const SOURCES = ['linkedin', 'csv', 'x', 'attio'];
/** How the contact relates to the user: a direct connection, or a firm-wide CRM contact held by a colleague. */
export const RELATIONSHIPS = ['direct', 'firm'];
export const MAX_CONTACTS = 30000;

export const LIMITS = {
  name: 200,
  firstName: 100,
  lastName: 100,
  company: 200,
  position: 300,
  email: 254,
  profileUrl: 500,
  location: 200,
  via: 120,
  tag: 80,
  tags: 20,
};

// ------------------------------------------------------------------ CSV

function detectDelimiter(text) {
  const firstLines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const line of firstLines) {
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch in counts) counts[ch] += 1;
    }
  }
  if (counts['\t'] > counts[','] && counts['\t'] >= counts[';']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

/**
 * RFC 4180 CSV parser: quoted fields may contain the delimiter, doubled
 * quotes ("") and newlines. Strips a UTF-8 BOM. Returns an array of rows
 * (arrays of strings); fully empty rows are dropped.
 */
export function parseCsv(input, { delimiter } = {}) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushRow = () => {
    row.push(field);
    field = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field.trim() === '') { field = ''; inQuotes = true; i += 1; continue; }
    if (ch === delim) { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { pushRow(); i += text[i + 1] === '\n' ? 2 : 1; continue; }
    if (ch === '\n') { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}

// --------------------------------------------------------- normalisers

const clean = (value, max) => {
  if (value == null) return '';
  const s = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return max ? s.slice(0, max) : s;
};

const COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'l l c', 'ltd', 'limited', 'corp', 'corporation', 'co', 'plc',
  'gmbh', 'ag', 'sa', 'sas', 'sarl', 'srl', 'bv', 'nv', 'pty', 'llp', 'lp', 'pbc', 'oy', 'ab', 'as', 'kk',
]);

/**
 * Spellings of one company that people mix in the same export, after the
 * rest of normalizeCompanyKey has run. Only the same company under another
 * spelling or a rename (Facebook is now Meta): a parent and its subsidiary
 * stay apart (Google is not Alphabet, AWS is not Amazon). Kept here, not in
 * the map's code, so the chips, the question engine and the founder check
 * all count the same people.
 */
const COMPANY_ALIASES = new Map([
  ['facebook', 'meta'], ['meta platforms', 'meta'],
  ['jp morgan', 'jpmorgan'], ['j p morgan', 'jpmorgan'], ['jpmorgan chase', 'jpmorgan'], ['jp morgan chase', 'jpmorgan'],
  ['j p morgan chase', 'jpmorgan'], ['jpmorganchase', 'jpmorgan'], ['jpmc', 'jpmorgan'],
  ['mckinsey company', 'mckinsey'],
  ['boston consulting group', 'bcg'], ['bcg boston consulting group', 'bcg'],
  ['pricewaterhousecoopers', 'pwc'], ['ernst and young', 'ey'], ['ernst young', 'ey'],
  ['amazon web services', 'aws'],
  ['google ventures', 'gv'], ['andreessen horowitz', 'a16z'],
  // "Boston Consulting Group" loses its trailing "group" like any other name.
  ['boston consulting', 'bcg'], ['bcg boston consulting', 'bcg'],
  ['twitter', 'x'], ['x corp', 'x'],
]);

/**
 * Grouping key for a company name: lower case, accents (on Latin letters)
 * and punctuation removed, "&" -> "and", leading "the", trailing legal
 * suffixes (Inc, LLC, Ltd, Corp, GmbH...) and a trailing "& Co." or "&
 * Company" stripped, a bracketed short form dropped, and the spellings in
 * COMPANY_ALIASES merged. "Stripe, Inc." -> "stripe", "McKinsey & Company"
 * -> "mckinsey". Letters and digits of every script are kept, so "Яндекс"
 * and "株式会社トヨタ" get keys too (marks that are part of the script, such
 * as Japanese dakuten, are left alone).
 */
// Many people share an employer, and every count on the map reads the key:
// each spelling is worked out once. The key depends only on the text.
const companyKeyMemo = new Map();
export function normalizeCompanyKey(name) {
  const raw = typeof name === 'string' ? name : String(name ?? '');
  const hit = companyKeyMemo.get(raw);
  if (hit !== undefined) return hit;
  const key = readCompanyKey(raw);
  if (companyKeyMemo.size > 50000) companyKeyMemo.clear();
  companyKeyMemo.set(raw, key);
  return key;
}

function readCompanyKey(name) {
  let s = clean(name);
  if (!s) return '';
  // "Amazon Web Services (AWS)": the bracket repeats the name in short.
  if (/\S\s*\([^()]{1,12}\)\s*$/.test(s)) s = s.replace(/\s*\([^()]{1,12}\)\s*$/, '');
  // A fixed locale keeps keys identical in the browser and on the server.
  // "Amazon.com", "Notion.so": a web address suffix written into the name.
  s = s.replace(/(\S)\.(com|io|ai|co|net|org|so|app|dev)\s*$/i, '$1');
  s = s.normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC').toLocaleLowerCase('en');
  s = s.replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let words = s.split(' ').filter(Boolean);
  if (words[0] === 'the' && words.length > 1) words = words.slice(1);
  // "l l c" / "l l p" spelled out by punctuation removal ("L.L.C.")
  const tail = () => words.slice(-3).join(' ');
  for (;;) {
    const n = words.length;
    if (n > 3 && (tail() === 'l l c' || tail() === 'l l p')) words = words.slice(0, -3);
    else if (n > 1 && COMPANY_SUFFIXES.has(words[n - 1])) words.pop();
    // "& Co." and "& Company" say only that it is a company; the "and" left
    // behind would split "McKinsey & Co." from "McKinsey".
    else if (n > 2 && words[n - 2] === 'and' && (words[n - 1] === 'company' || words[n - 1] === 'companies')) words = words.slice(0, -2);
    else if (n > 1 && words[n - 1] === 'and') words.pop();
    // "The Goldman Sachs Group, Inc." and "Goldman Sachs" are one employer.
    else if (n > 1 && (words[n - 1] === 'group' || words[n - 1] === 'groups')) words.pop();
    else break;
  }
  const joined = words.join(' ').trim();
  return COMPANY_ALIASES.get(joined) || joined;
}

/**
 * Words people put in the company column that name no company: they work
 * for themselves, in a company they will not name, or nowhere. Read on the
 * normalised key. These people have no company everywhere (chips, read-out,
 * questions, By company).
 */
const PLACEHOLDER_COMPANY = /^(self|self employed|selfemployed|freelance\w*|freelancing|independent|(self employed|selfemployed|self|freelance|freelancer|freelancing|independent)( \w+)? (consultants?|consulting|contractors?|advisors?|advisers?|investors?|directors?|board member|researchers?|professionals?|writers?|designers?|developers?|engineers?|photographers?|coach|coaching|artists?|editors?|journalists?|producers?|marketers?|strategists?|analysts?|creatives?|trainers?|translators?|filmmakers?|architects?|copywriters?|programmers?|recruiters?|operators?|founders?|entrepreneurs?|owners?|work)|stealth|stealth( \w+)+|in stealth|building in stealth|retired|unemployed|student|n a|na|none|nil|null|no company|not applicable|confidential|undisclosed|private|various|multiple|several|unknown|tbd|tba|between (jobs|roles)|open to work|career break|looking for \w+( \w+)?|seeking \w+( \w+)?|currently (seeking|looking)( \w+)*|job seeker)$/;

/** True when a company cell holds a placeholder rather than an employer ("Self-employed", "Stealth", "N/A", "-"). */
export function isPlaceholderCompany(name) {
  const k = normalizeCompanyKey(name);
  return !k ? String(name ?? '').trim() !== '' : PLACEHOLDER_COMPANY.test(k);
}

/** The same test on a key normalizeCompanyKey already gave (saves normalising twice). */
export const isPlaceholderKey = (key) => !!key && PLACEHOLDER_COMPANY.test(key);

/**
 * How a contact's company relates to a target company (both normalised
 * keys). "exact" when equal; "contains"/"within" when the shorter name has at
 * least two words and appears as a whole-word run inside the longer one
 * ("goldman sachs" within "goldman sachs asset management"). Single-word
 * names only match exactly, so "Meta" never matches "Meta Financial".
 */
export function companyMatch(contactKey, targetKey) {
  const a = String(contactKey || '');
  const b = String(targetKey || '');
  if (!a || !b) return null;
  if (a === b) return 'exact';
  const shorter = a.length < b.length ? a : b;
  const longer = shorter === a ? b : a;
  if (shorter.split(' ').length < 2) return null;
  if (` ${longer} `.includes(` ${shorter} `)) return shorter === b ? 'contains' : 'within';
  return null;
}

// Words that only say what form a company takes, never which company it is. A
// one-word name followed by nothing but these is the same company written
// longer ("Nikola" / "Nikola Motor Company", "Meta" / "Meta Platforms"). Kept
// short on purpose: a tail such as "Financial", "Labs" or "Health" names a
// different business as often as not ("Meta Financial"), so it never matches.
const FORM_TAILS = new Set([
  'company', 'companies', 'technologies', 'technology', 'platforms', 'platform',
  'motors', 'motor company', 'motor', 'industries',
]);
// For an investor, a fund's form words too ("Sequoia" / "Sequoia Capital").
const INVESTOR_TAILS = new Set([
  ...FORM_TAILS, 'capital', 'ventures', 'venture partners', 'partners', 'capital partners', 'capital management',
  'management', 'vc', 'ventures management', 'investments',
]);

/**
 * For Founder Check only (the Network Map keeps companyMatch): a one-word
 * company key and a longer key that adds nothing but company-form words.
 * Returns 'similar' or null. Both arguments are normalised keys, either way
 * round. With { investor: true } a fund's form words also count.
 */
export function companyFormMatch(contactKey, targetKey, { investor = false } = {}) {
  const a = String(contactKey || '');
  const b = String(targetKey || '');
  if (!a || !b || a === b) return null;
  const shorter = a.length < b.length ? a : b;
  const longer = shorter === a ? b : a;
  if (shorter.includes(' ') || shorter.length < 2) return null;
  if (!longer.startsWith(`${shorter} `)) return null;
  const tail = longer.slice(shorter.length + 1);
  return (investor ? INVESTOR_TAILS : FORM_TAILS).has(tail) ? 'similar' : null;
}

/**
 * The one-word key a longer key reduces to when its tail is only form words
 * ("nikola motor company" -> "nikola"), or ''. Lets a search for the longer
 * name also fetch contacts saved under the short one.
 */
export function companyFormBase(key, { investor = false } = {}) {
  const k = String(key || '');
  const at = k.indexOf(' ');
  if (at < 2) return '';
  const base = k.slice(0, at);
  return companyFormMatch(base, k, { investor }) ? base : '';
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const isoDate = (y, m, d) => {
  const yy = Number(y); const mm = Number(m); const dd = Number(d);
  if (!yy || !mm || !dd || mm > 12 || dd > 31 || yy < 1900 || yy > 2200) return null;
  const date = new Date(Date.UTC(yy, mm - 1, dd));
  if (date.getUTCMonth() !== mm - 1) return null;
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};

/**
 * "05 Nov 2026" (LinkedIn), "2026-11-05", "11/05/2026" (US), "5 November
 * 2026", "Nov 5, 2026", or an Excel serial day number -> "YYYY-MM-DD".
 * Slash dates are month/day unless the first number is over 12 (day/month)
 * or `dayFirst` is set (detected per file by rowsToContacts).
 */
export function parseDate(value, { dayFirst = false } = {}) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 20000 && value < 80000) {
      const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
      return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Spreadsheet libraries hand back date-only cells as local midnight;
    // anything else (e.g. an ISO instant) is read in UTC.
    const local = value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0;
    return local
      ? isoDate(value.getFullYear(), value.getMonth() + 1, value.getDate())
      : isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  const s = clean(value, 60);
  const month = (word) => MONTHS[word.slice(0, 3).toLowerCase()];
  let m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})$/);
  if (m && month(m[2])) return isoDate(m[3], month(m[2]), m[1]);
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && month(m[1])) return isoDate(m[3], month(m[1]), m[2]);
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    const dayIsFirst = first > 12 || (dayFirst && second <= 12);
    return dayIsFirst ? isoDate(m[3], m[2], m[1]) : isoDate(m[3], m[1], m[2]);
  }
  return null;
}

/**
 * Look at a column of raw date strings and decide whether slash dates in
 * this file are day-first: true when some row can only be day/month
 * (first number over 12) and no row can only be month/day.
 */
export function detectDayFirst(values) {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const v of values || []) {
    const m = String(v ?? '').trim().match(/^(\d{1,2})[/.](\d{1,2})[/.]\d{4}$/);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst += 1;
    else if (Number(m[2]) > 12) monthFirst += 1;
  }
  return dayFirst > 0 && monthFirst === 0;
}

/** Only http(s) links are kept; bare "linkedin.com/in/x" gets https://. */
export function cleanProfileUrl(value) {
  let s = clean(value, LIMITS.profileUrl);
  if (!s) return '';
  if (/^(www\.)?(linkedin\.com|x\.com|twitter\.com)\//i.test(s)) s = `https://${s}`;
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.toString().slice(0, LIMITS.profileUrl);
  } catch {
    return '';
  }
}

const cleanEmail = (value) => {
  const s = clean(value, LIMITS.email).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
};

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[;,|\n]/);
  const out = [];
  for (const t of list) {
    const tag = clean(t, LIMITS.tag);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

/** Validate and normalise one contact (from any source, client or server). */
export function normalizeContact(raw, source, { dayFirst = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const src = SOURCES.includes(source) ? source : (SOURCES.includes(raw.source) ? raw.source : 'csv');
  const firstName = clean(raw.firstName, LIMITS.firstName);
  const lastName = clean(raw.lastName, LIMITS.lastName);
  let name = clean(raw.name, LIMITS.name);
  if (!name) name = clean(`${firstName} ${lastName}`, LIMITS.name);
  if (!name) return null;
  return {
    name,
    firstName,
    lastName,
    company: clean(raw.company, LIMITS.company),
    position: clean(raw.position, LIMITS.position),
    email: cleanEmail(raw.email),
    profileUrl: cleanProfileUrl(raw.profileUrl),
    location: clean(raw.location, LIMITS.location),
    connectedOn: parseDate(raw.connectedOn, { dayFirst }),
    source: src,
    tags: cleanTags(raw.tags),
    relationship: RELATIONSHIPS.includes(raw.relationship) ? raw.relationship : 'direct',
    via: clean(raw.via, LIMITS.via),
  };
}

const normalizeUrlKey = (url) => String(url || '').toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

/** Identity used for de-duplication: profile URL, else email, else name + company. */
export function dedupeKey(contact) {
  if (contact.profileUrl) return `u:${normalizeUrlKey(contact.profileUrl)}`;
  if (contact.email) return `e:${contact.email.toLowerCase()}`;
  return `n:${clean(contact.name).toLowerCase()}|${normalizeCompanyKey(contact.company)}`;
}

/** Drop duplicates; later copies only fill fields the first copy lacked. */
export function dedupeContacts(contacts) {
  const byKey = new Map();
  for (const c of contacts || []) {
    if (!c) continue;
    const key = dedupeKey(c);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...c }); continue; }
    for (const field of ['firstName', 'lastName', 'company', 'position', 'email', 'profileUrl', 'location', 'connectedOn', 'via']) {
      if (!prev[field] && c[field]) prev[field] = c[field];
    }
    // A direct connection anywhere beats a firm-wide one.
    if (prev.relationship === 'firm' && c.relationship === 'direct') { prev.relationship = 'direct'; prev.via = ''; }
    if (c.tags?.length) prev.tags = cleanTags([...(prev.tags || []), ...c.tags]);
  }
  return [...byKey.values()];
}

// -------------------------------------------------------------- headers

const normHeader = (h) => clean(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const HEADER_MAP = {
  name: ['name', 'full name', 'fullname', 'contact name', 'display name', 'contact', 'person', 'candidate', 'candidate name', 'applicant', 'applicant name', 'lead name', 'prospect name'],
  firstName: ['first name', 'firstname', 'first', 'given name', 'forename'],
  lastName: ['last name', 'lastname', 'last', 'surname', 'family name'],
  company: ['company', 'organization', 'organisation', 'employer', 'company name', 'current company', 'current employer', 'org', 'firm', 'account', 'account name'],
  position: ['title', 'position', 'job title', 'role', 'headline', 'occupation', 'job', 'current title', 'current position', 'current job title'],
  email: ['email', 'email address', 'e mail', 'e mail address', 'work email', 'primary email', 'email 1 value'],
  profileUrl: ['linkedin', 'linkedin url', 'url', 'profile', 'profile url', 'linkedin profile', 'linkedin profile url', 'profile link', 'twitter', 'x', 'x url', 'twitter url'],
  location: ['location', 'city', 'region', 'based in', 'address', 'metro', 'area'],
  country: ['country'],
  connectedOn: ['connected on', 'connected', 'date added', 'added on', 'connection date', 'created', 'date'],
  // Every column that sorts people into a few named piles is read as tags:
  // a pipeline's stage or status is the signal a CRM or applicant list has.
  tags: ['tags', 'tag', 'labels', 'label', 'groups', 'group', 'lists', 'list', 'segment', 'segments', 'category', 'categories',
    'stage', 'status', 'pipeline stage', 'pipeline', 'lead status', 'deal stage', 'lifecycle stage', 'candidate stage', 'application status'],
  // Recognised so the column is not mistaken for another field, but never
  // kept: free-text notes are not tags, and there is nowhere to store them.
  notes: ['notes', 'note', 'comments', 'comment', 'description'],
};

const HEADER_LOOKUP = (() => {
  const map = new Map();
  for (const [field, names] of Object.entries(HEADER_MAP)) names.forEach((n) => map.set(n, field));
  return map;
})();

/**
 * Map a header row to { field: columnIndex }. A file may have several tag
 * columns (Tags and Stage): `tags` is the first and `tagColumns` all of them.
 */
export function mapHeaders(headerRow) {
  const mapping = {};
  (headerRow || []).forEach((h, idx) => {
    const field = HEADER_LOOKUP.get(normHeader(h));
    if (field === 'tags') (mapping.tagColumns = mapping.tagColumns || []).push(idx);
    if (field && mapping[field] === undefined) mapping[field] = idx;
  });
  return mapping;
}

const usableMapping = (m) => m.name !== undefined || m.firstName !== undefined || m.lastName !== undefined;

function rowToContact(row, mapping, source, { dayFirst = false } = {}) {
  const get = (field) => (mapping[field] === undefined ? '' : row[mapping[field]]);
  const location = [clean(get('location')), clean(get('country'))].filter(Boolean).join(', ');
  const tagColumns = mapping.tagColumns || (mapping.tags === undefined ? [] : [mapping.tags]);
  const tags = cleanTags(tagColumns.flatMap((i) => cleanTags(row[i])));
  return normalizeContact({
    name: get('name'),
    firstName: get('firstName'),
    lastName: get('lastName'),
    company: get('company'),
    position: get('position'),
    email: get('email'),
    profileUrl: get('profileUrl'),
    location,
    connectedOn: get('connectedOn'),
    tags,
  }, source, { dayFirst });
}

/**
 * Convert table rows (first rows may be notes) into contacts. The header is
 * the first of the first 15 rows that has a name column.
 * Returns { contacts, headerFound, skippedRows, mapping }.
 */
export function rowsToContacts(rows, { source = 'csv' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let headerIdx = -1;
  let mapping = {};
  for (let i = 0; i < Math.min(list.length, 15); i += 1) {
    const m = mapHeaders(list[i]);
    if (usableMapping(m)) { headerIdx = i; mapping = m; break; }
  }
  if (headerIdx < 0) return { contacts: [], headerFound: false, skippedRows: list.length, duplicates: 0, truncated: 0, mapping: {} };
  const body = list.slice(headerIdx + 1);
  const dayFirst = mapping.connectedOn !== undefined && detectDayFirst(body.map((r) => r[mapping.connectedOn]));
  const contacts = [];
  let skippedRows = 0;
  for (const row of body) {
    const c = rowToContact(row, mapping, source, { dayFirst });
    if (c) contacts.push(c); else skippedRows += 1;
  }
  const deduped = dedupeContacts(contacts);
  return {
    contacts: deduped.slice(0, MAX_CONTACTS),
    headerFound: true,
    skippedRows,
    duplicates: contacts.length - deduped.length,
    truncated: Math.max(0, deduped.length - MAX_CONTACTS),
    mapping,
  };
}

/** A header mapping with LinkedIn's three signature columns. */
export const isLinkedInMapping = (m) => m && m.firstName !== undefined && m.lastName !== undefined && m.connectedOn !== undefined;

/** True when the text looks like LinkedIn's Connections.csv export. */
export function isLinkedInConnectionsCsv(text) {
  const head = String(text || '').slice(0, 4000).toLowerCase();
  return head.includes('first name') && head.includes('last name') && head.includes('connected on');
}

/** LinkedIn Connections.csv -> { contacts, headerFound, skippedRows, duplicates }. */
export function parseLinkedInConnectionsCsv(text) {
  const rows = parseCsv(text, { delimiter: ',' });
  return rowsToContacts(rows, { source: 'linkedin' });
}

/** Any CSV with recognisable headers. */
export function parseGenericCsv(text) {
  return rowsToContacts(parseCsv(text), { source: 'csv' });
}

/**
 * X API following list: { data: [user] } (or several pages, or a bare array).
 * Users carry id, name, username, description, location.
 */
export function parseXFollowing(json) {
  let data = json;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return { contacts: [], headerFound: false, skippedRows: 0 }; }
  }
  let users = [];
  if (Array.isArray(data)) {
    users = data.flatMap((d) => (Array.isArray(d?.data) ? d.data : [d]));
  } else if (Array.isArray(data?.data)) {
    users = data.data;
  } else if (Array.isArray(data?.following)) {
    users = data.following;
  } else if (Array.isArray(data?.users)) {
    users = data.users;
  }
  const contacts = [];
  let skippedRows = 0;
  for (const u of users) {
    const username = clean(u?.username || u?.screen_name, 60).replace(/^@/, '');
    const c = normalizeContact({
      name: u?.name || username,
      position: u?.description,
      location: u?.location,
      profileUrl: username && /^[A-Za-z0-9_]{1,30}$/.test(username) ? `https://x.com/${username}` : '',
      tags: username ? [`@${username}`] : [],
    }, 'x');
    if (c) contacts.push(c); else skippedRows += 1;
  }
  const deduped = dedupeContacts(contacts);
  return {
    contacts: deduped.slice(0, MAX_CONTACTS),
    headerFound: users.length > 0,
    skippedRows,
    duplicates: contacts.length - deduped.length,
    truncated: Math.max(0, deduped.length - MAX_CONTACTS),
  };
}

const EMPTY = { contacts: [], headerFound: false, skippedRows: 0, duplicates: 0, truncated: 0 };

/**
 * Browser: parse an uploaded File. kind: 'linkedin' | 'auto'.
 * .xlsx/.xls are read with the `xlsx` package, loaded on demand.
 *
 * kind 'linkedin' (the "Upload LinkedIn Connections.csv" button) only
 * accepts a file with LinkedIn's columns (First Name, Last Name, Connected
 * On). Any other contacts file is refused with `reason: 'not-linkedin'`
 * instead of being saved over the LinkedIn import.
 */
export async function parseContactsFile(file, { kind = 'auto' } = {}) {
  const name = String(file?.name || '').toLowerCase();
  if (/\.(xlsx|xlsm|xls)$/.test(name)) {
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    // cellDates + raw keep date cells as Date objects (handled by parseDate)
    // instead of locale-formatted strings.
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    let generic = null;
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
      const asLinkedIn = rows.slice(0, 15).some((r) => isLinkedInMapping(mapHeaders(r)));
      const result = rowsToContacts(rows, { source: asLinkedIn ? 'linkedin' : 'csv' });
      if (!result.headerFound) continue;
      if (kind === 'linkedin' && !asLinkedIn) { generic = generic || result; continue; }
      return { ...result, source: asLinkedIn ? 'linkedin' : 'csv' };
    }
    if (generic) return { ...EMPTY, reason: 'not-linkedin', source: 'csv' };
    return { ...EMPTY, source: 'csv' };
  }
  const text = await file.text();
  if (/\.json$/.test(name) || /^\s*[[{]/.test(text)) {
    if (kind === 'linkedin') return { ...EMPTY, reason: 'not-linkedin', source: 'x' };
    return { ...parseXFollowing(text), source: 'x' };
  }
  if (isLinkedInConnectionsCsv(text)) {
    return { ...parseLinkedInConnectionsCsv(text), source: 'linkedin' };
  }
  if (kind === 'linkedin') {
    // The header may be spelled differently; accept it only when the mapped
    // columns are LinkedIn's. Otherwise refuse rather than guess.
    const rows = parseCsv(text, { delimiter: ',' });
    const asLinkedIn = rows.slice(0, 15).some((r) => isLinkedInMapping(mapHeaders(r)));
    if (asLinkedIn) return { ...rowsToContacts(rows, { source: 'linkedin' }), source: 'linkedin' };
    const generic = parseGenericCsv(text);
    return { ...EMPTY, ...(generic.headerFound ? { reason: 'not-linkedin' } : {}), source: 'csv' };
  }
  return { ...parseGenericCsv(text), source: 'csv' };
}

/** Counts per source. */
export function countBySource(contacts) {
  const out = { linkedin: 0, csv: 0, x: 0, attio: 0 };
  for (const c of contacts || []) if (out[c.source] !== undefined) out[c.source] += 1;
  return out;
}
