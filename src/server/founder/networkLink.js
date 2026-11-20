/**
 * Founder Check paired with the user's own network (the Network Map tab).
 *
 * Everything here reads the signed-in user's imported contacts and nothing
 * else's. Contact data never leaves the account: it is not logged, not stored
 * in the check, and never sent to an outside service. The one thing that can
 * become a search term is a company name, and only in companySeed(), exactly
 * as if the user had typed it.
 *
 *   companySeed(userId, name, typedCompany)   -> { company } | null
 *     Before a deep check starts with no company: when exactly one contact
 *     carries the person's full name and has a company, that company anchors
 *     the check.
 *
 *   networkForReport(userId, report, opts)    -> network
 *     After the check: is the person a contact, who the user knows around
 *     them (current company, earlier employers, companies they founded,
 *     people named in the check, their investors), and the five best people
 *     to call for a reference.
 *
 *   listFinishedChecks(userId)                -> [{ name, company, date, redFlags }]
 *     The user's own finished deep checks (for the Network Map tab).
 */
import { nameVariants, normalizePersonName } from '../founderCheck';
import { normalizeCompanyKey, companyMatch } from '../../utils/network/parseContacts';
import { ROLE_GROUPS, investorsFromProfile } from '../network/query';
import { query, persistenceMode } from '../db';
import * as networkStore from '../network/store';

export const MAX_PER_GROUP = 25;
export const MAX_COMPANIES = 40;
export const SHORTLIST_SIZE = 5;
const MAX_COMPANY_LENGTH = 120;

const IMPORT_HINT = 'Import your network in the Network Map tab to see who you know around this person.';

// ------------------------------------------------------------ names

const HONORIFIC = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'sir', 'dame']);
const CREDENTIAL = new Set(['phd', 'mba', 'md', 'cfa', 'cpa', 'esq', 'jd', 'msc', 'bsc', 'ma', 'ba', 'pe', 'pmp']);

/** A name tidied for matching, keeping its case: no nickname in brackets, nothing after a comma, no title or degree. */
function tidyName(name) {
  let s = normalizePersonName(String(name || '').replace(/\([^)]*\)/g, ' ').split(',')[0]);
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length > 2 && HONORIFIC.has(tokens[0].toLowerCase().replace(/\./g, ''))) tokens.shift();
  while (tokens.length > 2 && CREDENTIAL.has(tokens[tokens.length - 1].toLowerCase().replace(/\./g, ''))) tokens.pop();
  s = tokens.join(' ');
  return s;
}

/** Lower case, no accents, no punctuation: "José  O'Neil-Ruiz" -> "jose oneil-ruiz". */
export function personKey(name) {
  return String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every full-name form of a name (nameVariants drops middle initials), as keys. */
export function nameKeys(name) {
  const tidy = tidyName(name);
  if (tidy.split(' ').length < 2) return [];
  return [...new Set(nameVariants(tidy).map(personKey).filter((k) => k.split(' ').length >= 2))];
}

/** Do two names give the same full name? A first name or surname alone never does. */
export function sameName(a, b) {
  const ka = nameKeys(a);
  if (!ka.length) return false;
  const kb = nameKeys(b);
  return kb.some((k) => ka.includes(k));
}

// ------------------------------------------------------------ companies

const sameCompany = (a, b) => Boolean(companyMatch(normalizeCompanyKey(a), normalizeCompanyKey(b)));

const FOUNDED = /\b(?:co-?found\w*|found(?:ed|er|ers|ing))\b/i;
const PAST = /\(past\)|\bearlier company\b|\bformer(?:ly)?\b|\bpreviously\b/i;
const GIVEN = /^(?:the company given|the company most sources name)/i;
// Company threads too loose to look for people at: name-only records, parents, holding vehicles, patents.
const LOOSE = /name match only|registered under a name starting with|\bparent of\b|holding vehicle|earlier name|\bpatent\b/i;

/** The role words of a thread's reason, when it reads like a job title ("Chief of Staff (past)" -> "Chief of Staff"). */
function roleFrom(why) {
  const w = String(why || '').replace(/\s*\((?:past|current)\)\s*$/i, '').trim();
  if (!w || w.length > 60 || /\b(?:named|company|record|filed|reports?|form|register|appointment|wikidata|littlesis|sec)\b/i.test(w)) return null;
  return w;
}

const RANK = { current: 0, founded: 1, earlier: 2, other: 3 };

/**
 * The companies to look for people at, from the finished report: the
 * current company, companies they founded, earlier employers (from the
 * profile and from company threads) and other companies the check tied to
 * them. One entry per company, the closest tie winning.
 *   -> [{ name, key, tie: 'current'|'founded'|'earlier'|'other', role, why }]
 */
export function companiesOf(report) {
  const out = [];
  const add = (name, tie, role = null, why = '') => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_LENGTH);
    const key = normalizeCompanyKey(clean);
    if (!key) return;
    const at = out.find((c) => c.key === key || companyMatch(c.key, key));
    if (at) {
      if (RANK[tie] < RANK[at.tie]) { at.tie = tie; at.why = why || at.why; }
      if (!at.role && role) at.role = role;
      return;
    }
    out.push({ name: clean, key, tie, role, why });
  };
  const r = report || {};
  add(r.company, 'current');
  add(r.profile?.company, 'current');
  for (const t of r.threads || []) {
    if (t?.kind !== 'company' || LOOSE.test(t.why || '')) continue;
    const why = String(t.why || '');
    if (GIVEN.test(why)) add(t.value, 'current', null, why);
    else if (FOUNDED.test(why)) add(t.value, 'founded', PAST.test(why) ? 'founder (earlier)' : 'founder', why);
    else if (PAST.test(why)) add(t.value, 'earlier', roleFrom(why), why);
    else add(t.value, 'other', roleFrom(why), why);
  }
  for (const e of r.profile?.earlier || []) add(e?.org, 'earlier', e?.role || null, 'earlier role');
  return out.slice(0, MAX_COMPANIES);
}

/** People the check named as tied to the person: related parties and associates, with what they are to them. */
export function partiesOf(report) {
  const out = [];
  const add = (name, relation, role) => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (nameKeys(clean).length === 0 || out.some((p) => sameName(p.name, clean))) return;
    out.push({ name: clean, relation: relation || null, role: role || null });
  };
  for (const p of report?.relatedParties || []) add(p?.name, p?.relation || (p?.kind === 'associate' ? 'associate' : p?.kind === 'relative' ? 'relative' : null), p?.role);
  for (const t of report?.threads || []) if (t?.kind === 'associate') add(t.value, t.relation || 'associate', null);
  return out.slice(0, 60);
}

// ------------------------------------------------------------ ranking

const groupOf = (label) => ROLE_GROUPS.find((g) => g.label === label);
const TOP = ['founders', 'ceos', 'ctos', 'cfos'].map(groupOf).filter(Boolean);
const EXEC = groupOf('executives');
const INVESTOR = groupOf('investors');
const MIDDLE = /\b(?:senior|staff|principal|lead|manager|partner)\b/i;

/** How senior a title reads, using the Network Map's role groups: 3 founder or chief officer, 2 executive or partner, 1 lead or manager, 0 other. */
export function seniority(position) {
  const p = String(position || '');
  if (!p) return 0;
  if (TOP.some((g) => g.match.test(p))) return 3;
  if ((EXEC && EXEC.match.test(p)) || /\b(?:general|managing) partner\b/i.test(p)) return 2;
  if (MIDDLE.test(p) || (INVESTOR && INVESTOR.match.test(p))) return 1;
  return 0;
}

/** Direct contacts before firm contacts, then senior titles, then the longest-standing connection, then name. */
export function comparePeople(a, b) {
  return (a.relationship === 'firm') - (b.relationship === 'firm')
    || seniority(b.position) - seniority(a.position)
    || String(a.connectedOn || '9999').localeCompare(String(b.connectedOn || '9999'))
    || String(a.name).localeCompare(String(b.name));
}

// ------------------------------------------------------------ output shapes

/** The fields of a contact the report shows. Never email or location. */
function shown(c) {
  return {
    name: String(c.name || ''),
    position: c.position || '',
    company: c.company || '',
    relationship: c.relationship === 'firm' ? 'firm' : 'direct',
    ...(c.relationship === 'firm' && c.via ? { via: c.via } : {}),
    connectedOn: c.connectedOn || null,
    profileUrl: /^https?:\/\//i.test(String(c.profileUrl || '')) ? c.profileUrl : '',
  };
}

const contactId = (c) => `${personKey(c.name)}|${normalizeCompanyKey(c.company)}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'They';

function companyWhy(company, person, c) {
  const at = c.company || company.name;
  if (company.tie === 'current') return `Works at ${at}, ${person}'s current company`;
  if (company.tie === 'founded') return `Works at ${at}, which ${person} founded`;
  if (company.tie === 'earlier') return `Works at ${at}, where ${person} ${company.role ? `was ${company.role}` : 'worked earlier'}`;
  return `Works at ${at}, tied to ${person} in this check${company.role ? ` (${company.role})` : ''}`;
}

const GROUPS = [
  { key: 'current', title: 'At their current company' },
  { key: 'earlier', title: 'At companies they worked at before' },
  { key: 'founded', title: 'At companies they founded' },
  { key: 'parties', title: 'People named in this check' },
  { key: 'investors', title: 'At their investors' },
  { key: 'other', title: 'At other companies tied to them' },
];

// ------------------------------------------------------------ reference calls

function askFor(p, person) {
  const first = firstName(person);
  if (p.group === 'earlier') return `Ask how ${first} worked at ${p.at}${p.role ? ` as ${p.role}` : ''}: what they owned, how they handled setbacks, and why they left.`;
  if (p.group === 'founded') return `Ask what happened at ${p.at}, and how ${first} treated co-founders, staff and investors along the way.`;
  if (p.group === 'parties') return `Ask about working with ${first}${p.relation ? ` as their ${p.relation}` : ''}: how decisions were made, how disagreements ended, and whether they would do it again.`;
  if (p.group === 'investors') return `Ask what ${p.at} has seen as an investor: candour with bad news, use of money, and follow-through on plans.`;
  if (p.group === 'current') return `Ask how ${first} leads ${p.at} today: hiring, candour with the board, and how the team rates them.`;
  return `Ask how they know ${first} through ${p.at} and what ${first} was like to work with.`;
}

const SHORTLIST_ORDER = ['earlier', 'founded', 'parties', 'investors', 'other', 'current'];

/**
 * The five best people to call. Former colleagues first, then companies
 * they founded, people named beside them, investors and other ties. Someone
 * at the current company only when their title is senior (a peer or a
 * leader, not someone who may report to them), and at most one. At most two
 * per company, direct contacts before firm contacts.
 */
export function referenceShortlist(groups, person) {
  const out = [];
  const perCompany = new Map();
  for (const key of SHORTLIST_ORDER) {
    const group = groups.find((g) => g.key === key);
    if (!group) continue;
    let fromCurrent = 0;
    for (const p of group.all) {
      if (out.length >= SHORTLIST_SIZE) break;
      if (key === 'current' && (seniority(p.position) < 2 || fromCurrent >= 1)) continue;
      const ck = normalizeCompanyKey(p.at || p.company) || p.name;
      if ((perCompany.get(ck) || 0) >= 2) continue;
      perCompany.set(ck, (perCompany.get(ck) || 0) + 1);
      if (key === 'current') fromCurrent += 1;
      const { group: g, why, at, role, relation, ...contact } = p;
      out.push({ ...contact, group: g, why, ask: askFor(p, person) });
    }
  }
  return out;
}

// ------------------------------------------------------------ the pairing

/**
 * Pure: turns the matched contacts into what the report shows.
 *   self:     contacts carrying the person's full name
 *   atCompanies: contacts at the report's companies (findContactsAtCompanies rows)
 *   parties:  contacts carrying a related party's name
 *   atInvestors: contacts at investors ({ investor, contact })
 */
export function buildNetworkLinks({ report, total = null, nameMatches = [], atCompanies = [], partyMatches = [], atInvestors = [], investorsChecked = [], seededCompany = null, investorsMissed = false }) {
  const person = String(report?.name || '').trim();
  const companies = companiesOf(report);
  const parties = partiesOf(report);
  const notes = [];

  // ---- 1. in your network
  const namesakes = (nameMatches || []).filter((c) => sameName(c.name, person));
  const atTheirCompanies = namesakes.filter((c) => c.company && companies.some((co) => sameCompany(c.company, co.name)));
  let self = null;
  let others = namesakes;
  if (atTheirCompanies.length === 1) {
    self = { ...shown(atTheirCompanies[0]), basis: 'company', note: `Same full name, and works at ${atTheirCompanies[0].company}, a company this check ties to them.` };
    others = namesakes.filter((c) => c !== atTheirCompanies[0]);
  } else if (namesakes.length === 1 && !companies.some((co) => co.tie === 'current' && namesakes[0].company && !sameCompany(namesakes[0].company, co.name))) {
    self = { ...shown(namesakes[0]), basis: 'name', note: seededCompany ? 'Same full name; this contact\'s company was used to anchor the check.' : 'Same full name. Nothing else ties this contact to the person checked, so confirm it is them.' };
    others = [];
  }
  const sameNameContacts = others.map(shown);

  // Nobody with the person's own name is listed as "someone you know around them".
  const used = new Set(namesakes.map(contactId));

  // ---- 3. people around them
  const buckets = Object.fromEntries(GROUPS.map((g) => [g.key, []]));
  for (const c of partyMatches || []) {
    const party = parties.find((p) => sameName(p.name, c.name));
    if (!party || sameName(c.name, person) || used.has(contactId(c))) continue;
    used.add(contactId(c));
    const why = `Named in this check as ${person ? `${firstName(person)}'s` : 'their'} ${party.relation || 'associate'}${party.role ? ` (${party.role})` : ''}`;
    buckets.parties.push({ ...shown(c), group: 'parties', relation: party.relation, at: c.company || 'their work together', why });
  }
  for (const c of atCompanies || []) {
    if (used.has(contactId(c))) continue;
    const company = companies.find((co) => sameCompany(c.matchedCompany || c.company, co.name)) || companies.find((co) => sameCompany(c.company, co.name));
    if (!company) continue;
    used.add(contactId(c));
    buckets[company.tie].push({ ...shown(c), group: company.tie, at: c.company || company.name, role: company.role, why: companyWhy(company, person || 'the person', c) });
  }
  for (const { investor, contact: c } of atInvestors || []) {
    if (!c || used.has(contactId(c))) continue;
    used.add(contactId(c));
    const current = companies.find((co) => co.tie === 'current');
    buckets.investors.push({ ...shown(c), group: 'investors', at: c.company || investor, why: `Works at ${c.company || investor}, an investor in ${current ? current.name : 'their company'}` });
  }

  const groups = GROUPS.map((g) => {
    const all = buckets[g.key].sort(comparePeople);
    const inGroup = g.key === 'parties' || g.key === 'investors' ? [] : companies.filter((co) => co.tie === g.key).map((co) => co.name);
    return { ...g, companies: inGroup, total: all.length, direct: all.filter((p) => p.relationship === 'direct').length, all };
  });
  const references = referenceShortlist(groups, person);
  const currentOnly = groups.every((g) => g.key === 'current' || g.total === 0) && groups.find((g) => g.key === 'current').total > 0;
  if (currentOnly && !references.length) notes.push('Everyone you know around them works at their current company, below them or beside them. Their view is not independent, so no reference call is suggested.');
  else if (currentOnly) notes.push('Everyone you know around them works at their current company; weigh what they say accordingly.');
  if (investorsMissed) notes.push(INVESTORS_MISSED_NOTE);
  if (!companies.length) notes.push('This check found no company for the person, so there was nothing to match your network against.');

  const people = groups.reduce((n, g) => n + g.total, 0);
  return {
    available: true,
    checked: total,
    seededCompany: seededCompany || null,
    self,
    sameNameContacts,
    groups: groups.filter((g) => g.total > 0).map(({ all, ...g }) => ({ ...g, people: all.slice(0, MAX_PER_GROUP).map(({ at, role, relation, ...p }) => p) })),
    references,
    companiesChecked: companies.map((c) => c.name),
    investorsChecked,
    counts: { people, direct: groups.reduce((n, g) => n + g.direct, 0), companies: companies.length },
    notes,
  };
}

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Investors of the person's current company, from public sources (the same
 * company profile the Network Map's intro paths use). Only the company name
 * goes out. -> string[] (never throws; [] on timeout or failure).
 */
export async function lookupInvestors(company, opts = {}) {
  return (await lookupInvestorsResult(company, opts)).investors;
}

/**
 * The same lookup, saying whether it finished: complete is false when it ran
 * out of time, failed, or had too little time to start, so a missed lookup is
 * never shown as "no contacts at their investors".
 *   -> { investors: string[], complete: boolean } (never throws)
 */
export async function lookupInvestorsResult(company, { profileLoader = null, timeoutMs = 8000 } = {}) {
  const name = String(company || '').trim().slice(0, MAX_COMPANY_LENGTH);
  if (!name) return { investors: [], complete: true };
  if (!(timeoutMs >= 500)) return { investors: [], complete: false };
  const MISSED = Symbol('missed');
  try {
    const load = profileLoader || (await import('../companyProfile')).buildCompanyProfile;
    const profile = await withTimeout(load(name), timeoutMs, MISSED);
    if (profile === MISSED) return { investors: [], complete: false };
    return { investors: investorsFromProfile(profile).map((i) => i.name).slice(0, 25), complete: true };
  } catch {
    return { investors: [], complete: false };
  }
}

export const INVESTORS_MISSED_NOTE = 'Their investors could not be looked up in time, so people you know at their investors are not shown.';

/**
 * The pairing for a finished report. `investors` are names already looked
 * up (kept on the check, so a reload does not look them up again).
 * Never throws: { available: false, reason } when signed out, without
 * persistence, with no contacts, or on failure.
 */
export async function networkForReport(userId, report, { store = networkStore, investors = [], seededCompany = null, investorsMissed = false } = {}) {
  try {
    if (!userId || String(userId).startsWith('anon:')) return { available: false, reason: 'Sign in and import your network in the Network Map tab to see who you know around this person.' };
    if (persistenceMode() === 'none') return { available: false, reason: 'Your network is not saved on this deployment, so it cannot be matched to this check.' };
    const total = await store.countContacts(userId);
    if (!total) return { available: false, reason: IMPORT_HINT };
    const companies = companiesOf(report);
    const parties = partiesOf(report);
    const investorNames = (Array.isArray(investors) ? investors : []).map(String).filter(Boolean).slice(0, 25);
    const [nameMatches, atCompanies, partyMatches, atInvestorRows] = await Promise.all([
      report?.name ? store.findContactsByNames(userId, [report.name]) : [],
      companies.length ? store.findContactsAtCompanies(userId, companies.map((c) => c.name)) : [],
      parties.length ? store.findContactsByNames(userId, parties.map((p) => p.name)) : [],
      investorNames.length ? store.findContactsAtCompanies(userId, investorNames) : [],
    ]);
    const atInvestors = (atInvestorRows || []).map((c) => ({ investor: c.matchedCompany, contact: c }));
    return buildNetworkLinks({ report, total, nameMatches, atCompanies, partyMatches, atInvestors, investorsChecked: investorNames, seededCompany, investorsMissed });
  } catch {
    return { available: false, reason: 'Your network could not be read just now. Open the report again in a moment.' };
  }
}

/**
 * Before a deep check starts. When the user typed a company, nothing
 * happens. Otherwise, when exactly one of their contacts carries the full
 * name and has a company, that company anchors the check. Only the company
 * name is returned; no other contact field is. -> { company } | null
 */
export async function companySeed(userId, name, typedCompany = '', { store = networkStore } = {}) {
  try {
    if (String(typedCompany || '').trim()) return null;
    if (!userId || String(userId).startsWith('anon:') || persistenceMode() === 'none') return null;
    if (nameKeys(name).length === 0) return null;
    const matches = (await store.findContactsByNames(userId, [name])).filter((c) => sameName(c.name, name));
    if (matches.length !== 1) return null;
    const company = String(matches[0].company || '').replace(/\s+/g, ' ').trim();
    if (!company || company.length > MAX_COMPANY_LENGTH) return null;
    return { company };
  } catch {
    return null;
  }
}

/**
 * The user's own finished deep checks, newest first. Saved checks live in the
 * hosted database; locally they are kept in this server's memory (see
 * jobStore.js), which `memory` reads.
 *   -> [{ name, company, date, redFlags }]
 */
export async function listFinishedChecks(userId, { limit = 50, memory = globalThis.__founderJobs } = {}) {
  if (!userId || String(userId).startsWith('anon:')) return [];
  const cap = Math.max(1, Math.min(100, Number(limit) || 50));
  let rows = [];
  if (persistenceMode() === 'neon') {
    rows = (await query(
      `SELECT name, company, updated_at, (state->'report'->'totals'->>'redFlags') AS red_flags
         FROM founder_jobs
        WHERE user_id = $1 AND status = 'done'
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, cap]
    )) || [];
  } else if (memory && typeof memory.values === 'function') {
    rows = [...memory.values()]
      .filter((j) => j && j.owner === userId && (j.status === 'done' || j.state?.report))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, cap)
      .map((j) => ({ name: j.name, company: j.company, updated_at: j.updatedAt, red_flags: j.state?.report?.totals?.redFlags }));
  }
  const out = [];
  for (const r of rows) {
    const key = `${personKey(r.name)}|${normalizeCompanyKey(r.company)}`;
    if (out.some((c) => c.key === key)) continue;
    const date = r.updated_at ? new Date(r.updated_at) : null;
    const flags = Number(r.red_flags);
    out.push({ key, name: String(r.name || ''), company: String(r.company || ''), date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null, redFlags: Number.isFinite(flags) ? flags : null });
  }
  return out.map(({ key, ...c }) => c);
}
