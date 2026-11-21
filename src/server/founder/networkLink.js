/**
 * Founder Check paired with the user's own network (the Network Map tab).
 *
 * Everything here reads the signed-in user's imported contacts and nothing
 * else's. Contact data never leaves the account: it is not logged, not stored
 * in the check, never sent to a model, and never sent to an outside service.
 * The one thing that can become a search term is a company name: the
 * company the user confirms in companySeed(), and the company names the
 * check itself found, in lookupInvestors*().
 *
 *   seedSuggestion(userId, name, typedCompany)          -> { company, question } | null
 *     Before a deep check starts with no company: when exactly one contact
 *     carries the person's full name and has a company, the page asks the
 *     user whether that is the person. Nothing is seeded by this call.
 *
 *   companySeed(userId, name, typedCompany, { confirmedCompany })
 *                                                       -> { company, origin: 'network' } | null
 *     Only after the user said yes to that question: the confirmed company
 *     anchors the check. Without a yes it returns null, so a namesake in the
 *     user's contacts never silently decides who the check is about.
 *
 *   networkForReport(userId, report, opts)              -> network
 *     After the check: is the person a contact, who the user knows around
 *     them (current company, earlier employers with the years they were
 *     there, companies they founded, boards they sit on, people named in the
 *     check, their investors, companies they invested in), and the five
 *     people best placed to give a reference. Each lookup is settled on its
 *     own: one that fails is reported as failed, never as "nobody".
 *
 *   listFinishedChecks(userId) / listRunningChecks(userId)
 *     -> [{ id, name, company, seededCompany, status, date, redFlags }]
 *     The user's own checks, so the page can reopen one by id instead of
 *     starting a new check.
 */
import { nameVariants, normalizePersonName } from '../founderCheck';
import { parsePersonName, isBroadOrganisation } from './names';
import { normalizeCompanyKey, companyMatch, companyFormMatch } from '../../utils/network/parseContacts';
import { ROLE_GROUPS, investorsFromProfile } from '../network/query';
import { query, persistenceMode } from '../db';
import { RETENTION_HOURS } from './jobStore';
import * as networkStore from '../network/store';

export const MAX_PER_GROUP = 25;
export const MAX_COMPANIES = 40;
export const SHORTLIST_SIZE = 5;
const MAX_COMPANY_LENGTH = 120;
const MAX_INVESTORS = 40;
// Rows read per saved company: enough to list, few enough that one big former employer cannot crowd out the rest.
const PER_COMPANY_ROWS = 200;
// Someone who left a company longer ago than this is less likely to be known by the people there now.
const STALE_YEARS = 8;

const IMPORT_HINT = 'Import your network in the Network Map tab to see who you know around this person.';
const READ_FAILED = 'Your network could not be read just now. Open the report again in a moment.';

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

/** The first letter of the first middle name or initial, or ''. */
function middleInitial(name) {
  try {
    const m = parsePersonName(tidyName(name))?.middles || [];
    return m.length ? personKey(m[0]).charAt(0) : '';
  } catch {
    return '';
  }
}

/**
 * Do two names give the same full name? A first name or surname alone never
 * does, and two different middle initials ("John P. Smith" / "John Q. Smith")
 * are two people. A middle initial on one side only still matches.
 */
export function sameName(a, b) {
  const ka = nameKeys(a);
  if (!ka.length) return false;
  const kb = nameKeys(b);
  if (!kb.some((k) => ka.includes(k))) return false;
  const ma = middleInitial(a);
  const mb = middleInitial(b);
  return !(ma && mb && ma !== mb);
}

// ------------------------------------------------------------ companies

/** Is a contact's company this company (by its name or any known legal name)? Exact or whole-word only, never "similar". */
function companyIs(contactCompany, co) {
  const k = normalizeCompanyKey(contactCompany);
  if (!k) return false;
  return [co.name, ...(co.aliases || [])].some((n) => Boolean(companyMatch(k, normalizeCompanyKey(n))));
}
const sameCompany = (a, b) => Boolean(companyMatch(normalizeCompanyKey(a), normalizeCompanyKey(b)));

const FOUNDED = /\b(?:co-?found\w*|found(?:ed|er|ers|ing))\b/i;
const PAST = /\(past\)|\bearlier company\b|\bformer(?:ly)?\b|\bpreviously\b/i;
const BOARD = /\b(?:board|director|trustee|chair\w*|advis\w*)\b/i;
// The company the check was told or found: typed by the user, named by most sources, or confirmed by the user
// from their own network (deepCheck's ASSUMED_COMPANY). Each is their current company in the pairing.
const GIVEN = /^(?:the company given|the company most sources name|the company assumed from your network)/i;
// Company threads too loose to look for people at: name-only records, parents, holding vehicles, patents.
const LOOSE = /name match only|registered under a name starting with|\bparent of\b|holding vehicle|earlier name|\bpatent\b/i;

/** The role words of a thread's reason, when it reads like a job title ("Chief of Staff (past)" -> "Chief of Staff"). */
function roleFrom(why) {
  const w = String(why || '').replace(/\s*\((?:past|current)\)\s*$/i, '').trim();
  if (!w || w.length > 60 || /\b(?:named|company|record|filed|reports?|form|register|appointment|wikidata|littlesis|sec)\b/i.test(w)) return null;
  return w;
}

const RANK = { current: 0, founded: 1, earlier: 2, board: 3, other: 4, portfolio: 5 };
const yearOf = (v) => { const n = Number(v); return Number.isFinite(n) && n > 1800 && n < 3000 ? Math.trunc(n) : null; };

/** "2008–2012", "since 2014", "until 2019", or null. */
export function yearsText(from, to, current = false) {
  const f = yearOf(from);
  const t = yearOf(to);
  if (f && t) return f === t ? String(f) : `${f}–${t}`;
  if (f) return current ? `since ${f}` : `from ${f}`;
  if (t) return `until ${t}`;
  return null;
}

/**
 * The companies to look for people at, from the finished report: the
 * current company (with every known legal name), companies they founded,
 * earlier employers, boards they sit on, companies they invested in, and
 * other companies the check tied to them. One entry per company, the
 * closest tie winning; the years they were there are kept when known.
 *   -> [{ name, key, tie, role, why, from, to, current, aliases }]
 *   tie: 'current' | 'founded' | 'earlier' | 'board' | 'other' | 'portfolio'
 */
export function companiesOf(report) {
  const out = [];
  const r = report || {};
  // a person the check names (a co-host, a co-founder) is not a company, whatever a headline made of them
  const people = new Set([...(r.relatedParties || []).map((p) => p?.name), ...(r.threads || []).filter((t) => t?.kind === 'associate' || t?.kind === 'relative').map((t) => t.value)].map((n) => String(n || '').trim().toLowerCase()).filter(Boolean));
  const add = (name, tie, { role = null, why = '', from = null, to = null, current = false } = {}) => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_LENGTH);
    const key = normalizeCompanyKey(clean);
    if (!key || (tie !== 'current' && people.has(clean.toLowerCase()))) return;
    const at = out.find((c) => c.key === key || companyMatch(c.key, key));
    if (at) {
      if (RANK[tie] < RANK[at.tie]) { at.tie = tie; at.why = why || at.why; }
      if (!at.role && role) at.role = role;
      if (at.from == null && yearOf(from)) at.from = yearOf(from);
      if (at.to == null && yearOf(to)) at.to = yearOf(to);
      if (current) at.current = true;
      return;
    }
    out.push({ name: clean, key, tie, role, why, from: yearOf(from), to: yearOf(to), current: Boolean(current), aliases: [] });
  };
  add(r.company, 'current', { current: true });
  add(r.profile?.company, 'current', { current: true });
  // No company typed: the one the check took as theirs (confirmed by the user from their network) stands in
  if (!r.company && !r.profile?.company) add(r.assumedCompany, 'current', { current: true, why: 'the company assumed from your network' });
  // The company's known legal names (design decision 1): searched as the same company, never as another one.
  const current = out.find((c) => c.tie === 'current');
  if (current) {
    for (const l of r.companyFacts?.legalNames || []) {
      const n = String(l?.name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_LENGTH);
      if (n && normalizeCompanyKey(n) && !current.aliases.some((a) => normalizeCompanyKey(a) === normalizeCompanyKey(n)) && normalizeCompanyKey(n) !== current.key) current.aliases.push(n);
    }
  }
  for (const x of r.profile?.roles || []) {
    if (!x?.org) continue;
    add(x.org, x.current ? 'current' : 'earlier', { role: x.title || null, why: x.current ? 'current role' : 'earlier role', from: x.from, to: x.to, current: x.current });
  }
  for (const x of r.profile?.founded || []) if (x?.org) add(x.org, 'founded', { role: 'founder', why: 'founded', from: x.year });
  for (const x of r.profile?.boards || []) if (x?.org) add(x.org, 'board', { role: x.role || 'board member', why: 'board seat', from: x.from, to: x.to });
  for (const t of r.threads || []) {
    if (t?.kind !== 'company' || LOOSE.test(t.why || '') || people.has(String(t.value || '').trim().toLowerCase())) continue;
    const why = String(t.why || '');
    // a network seed the check later set aside (no longer trusted) is not their company
    if (/^the company assumed from your network/i.test(why) && t.trusted === false) continue;
    if (GIVEN.test(why)) add(t.value, 'current', { why, current: true });
    else if (FOUNDED.test(why)) add(t.value, 'founded', { role: PAST.test(why) ? 'founder (earlier)' : 'founder', why });
    else if (PAST.test(why)) add(t.value, 'earlier', { role: roleFrom(why), why });
    else if (BOARD.test(why)) add(t.value, 'board', { role: roleFrom(why), why });
    else add(t.value, 'other', { role: roleFrom(why), why });
  }
  for (const e of r.profile?.earlier || []) add(e?.org, 'earlier', { role: e?.role || null, why: 'earlier role', from: e?.from, to: e?.to });
  for (const x of r.profile?.investments || []) if (x?.org) add(x.org, 'portfolio', { why: 'invested in' });
  return out.slice(0, MAX_COMPANIES);
}

/**
 * The companies whose investors are worth looking up: the current company (typed, found, or confirmed from the
 * user's network) first, then up to two they founded. -> string[]
 */
export function investorLookupCompanies(report, max = 3) {
  const companies = companiesOf(report);
  const names = [...companies.filter((c) => c.tie === 'current'), ...companies.filter((c) => c.tie === 'founded')].map((c) => c.name);
  for (const f of report?.profile?.founded || []) if (f?.org && !names.some((n) => sameCompany(n, f.org))) names.push(String(f.org).trim());
  return names.slice(0, max);
}

/** Every name a company is searched under: its name and its known legal names. */
const searchNames = (companies) => {
  const names = [];
  for (const c of companies) for (const n of [c.name, ...(c.aliases || [])]) if (!names.some((x) => normalizeCompanyKey(x) === normalizeCompanyKey(n))) names.push(n);
  return names.slice(0, 50);
};

// Family is never an independent reference, and a relative is only ever named with a stated public role.
const RELATIVE = /\b(?:wife|husband|spouse|partner'?s|ex-?wife|ex-?husband|fianc[eé]e?|son|daughter|child(?:ren)?|mother|father|parents?|brother|sister|siblings?|cousin|aunt|uncle|niece|nephew|grand\w+|in-law|step\w+|relative|family)\b/i;
// A relation that means the party worked closely with them: the best placed to give a reference.
const CLOSE_RELATION = /\b(?:co-?founders?|founders?|board|directors?|chair\w*|investors?|backers?|business partners?)\b/i;

/** People the check named as tied to the person: related parties and associates, with what they are to them. Never relatives. */
export function partiesOf(report) {
  const out = [];
  const add = (name, relation, role) => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (nameKeys(clean).length === 0 || out.some((p) => sameName(p.name, clean))) return;
    out.push({ name: clean, relation: relation || null, role: role || null });
  };
  for (const p of report?.relatedParties || []) {
    if (p?.kind === 'relative' || RELATIVE.test(String(p?.relation || ''))) continue;
    add(p?.name, p?.relation || (p?.kind === 'associate' ? 'associate' : null), p?.role);
  }
  for (const t of report?.threads || []) {
    if (t?.kind !== 'associate' || RELATIVE.test(String(t.relation || ''))) continue;
    add(t.value, t.relation || 'associate', null);
  }
  return out.slice(0, 60);
}

/**
 * The investors to look for people at: those already looked up (strings, or
 * { name, of } naming the company they backed), and those the check's own
 * company facts name (investors and round leads of the current company).
 *   -> [{ name, of }]
 */
export function investorsOf(report, investors = []) {
  const current = companiesOf(report).find((c) => c.tie === 'current');
  const currentName = current ? current.name : null;
  const out = [];
  const add = (name, of) => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_LENGTH);
    const key = normalizeCompanyKey(clean);
    if (!key || out.some((i) => normalizeCompanyKey(i.name) === key)) return;
    out.push({ name: clean, of: of || currentName });
  };
  for (const i of Array.isArray(investors) ? investors : []) {
    if (typeof i === 'string') add(i, currentName);
    else if (i && typeof i === 'object') add(i.name, i.of);
  }
  const facts = report?.companyFacts || {};
  for (const i of facts.investors || []) add(i?.name, currentName);
  for (const f of facts.funding || []) {
    add(f?.lead, currentName);
    for (const n of Array.isArray(f?.investors) ? f.investors : []) add(typeof n === 'string' ? n : n?.name, currentName);
  }
  return out.slice(0, MAX_INVESTORS);
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

/** Within a group: a contact at the company itself before one whose title only mentions it. */
const compareInGroup = (a, b) => Boolean(a.mention) - Boolean(b.mention) || Boolean(a.similar) - Boolean(b.similar) || comparePeople(a, b);

/**
 * How well a contact is placed to know the person, as a score and a short
 * reason. A named co-founder, board member or investor first; then staff of
 * a company they founded; then colleagues at a company they worked at
 * (lower when they left long ago or the company is very large, since
 * overlap in time cannot be confirmed from the contact data); then the rest.
 */
export function placement(p, now = new Date().getUTCFullYear()) {
  let score;
  let reason;
  switch (p.group) {
    case 'parties':
      if (CLOSE_RELATION.test(String(p.relation || ''))) { score = 100; reason = `Named in this check as their ${p.relation}`; }
      else { score = 60; reason = 'Named in this check beside them'; }
      break;
    case 'founded': score = 85; reason = 'At a company they founded'; break;
    case 'board': score = 70; reason = 'At a company whose board they sit on'; break;
    case 'earlier': {
      score = 75;
      reason = 'At a company they worked at';
      const left = yearOf(p.toYear);
      if (left && now - left > STALE_YEARS) { score -= 20; reason += `, which they left in ${left}`; }
      if (p.broad) { score -= 15; reason += ' (a very large organisation)'; }
      break;
    }
    case 'investors': score = 60; reason = 'At one of their investors'; break;
    case 'other': score = 45; reason = 'At a company this check ties to them'; break;
    case 'portfolio': score = 40; reason = 'At a company they invested in'; break;
    case 'current': score = 30; reason = 'A senior colleague at their current company'; break;
    default: score = 20; reason = 'Tied to them in this check';
  }
  if (p.mention) { score -= 20; reason += '; only their title mentions the company'; }
  if (p.similar) { score -= 8; reason += '; a similar company name'; }
  if (p.relationship === 'firm') score -= 10;
  score += 2 * seniority(p.position);
  return { score, reason };
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

/** One row per person: the same contact imported from two sources (LinkedIn and Attio) is one person, the direct copy kept. */
function uniquePeople(rows) {
  const by = new Map();
  for (const c of rows || []) {
    const id = contactId(c);
    const at = by.get(id);
    if (!at || (at.relationship === 'firm' && c.relationship !== 'firm')) by.set(id, c);
  }
  return [...by.values()];
}

function companyWhy(company, person, c, years) {
  const at = c.company || company.name;
  const span = years ? ` (there ${years})` : '';
  let why;
  if (company.tie === 'current') why = `Works at ${at}, ${person}'s current company`;
  else if (company.tie === 'founded') why = `Works at ${at}, which ${person} founded${span}`;
  else if (company.tie === 'earlier') why = `Works at ${at}, where ${person} ${company.role ? `was ${company.role}` : 'worked earlier'}${span}`;
  else if (company.tie === 'board') why = `Works at ${at}, where ${person} is ${company.role ? `a ${company.role.replace(/^an? /i, '')}` : 'on the board'}${span}`;
  else if (company.tie === 'portfolio') why = `Works at ${at}, a company ${person} invested in`;
  else why = `Works at ${at}, tied to ${person} in this check${company.role ? ` (${company.role})` : ''}`;
  if (c.match === 'similar') why += `. A similar company name (${at} for ${company.name}): confirm it is the same company`;
  return why;
}

const GROUPS = [
  { key: 'current', title: 'At their current company' },
  { key: 'earlier', title: 'At companies they worked at before' },
  { key: 'founded', title: 'At companies they founded' },
  { key: 'board', title: 'At boards they sit on' },
  { key: 'parties', title: 'People named in this check' },
  { key: 'investors', title: 'At their investors' },
  { key: 'portfolio', title: 'At companies they invested in' },
  { key: 'other', title: 'At other companies tied to them' },
];

// ------------------------------------------------------------ reference calls

function askFor(p, person) {
  const first = firstName(person);
  if (p.group === 'earlier') return `Ask how ${first} worked at ${p.at}${p.role ? ` as ${p.role}` : ''}: what they owned, how they handled setbacks, and why they left.`;
  if (p.group === 'founded') return `Ask what happened at ${p.at}, and how ${first} treated co-founders, staff and investors along the way.`;
  if (p.group === 'board') return `Ask how ${first} works on the board of ${p.at}: preparation, candour, and how they handle disagreement.`;
  if (p.group === 'parties') return `Ask about working with ${first}${p.relation ? ` as their ${p.relation}` : ''}: how decisions were made, how disagreements ended, and whether they would do it again.`;
  if (p.group === 'investors') return `Ask what ${p.at} has seen as an investor: candour with bad news, use of money, and follow-through on plans.`;
  if (p.group === 'portfolio') return `Ask how ${first} behaved as an investor in ${p.at}: help given, and how they acted when things went badly.`;
  if (p.group === 'current') return `Ask how ${first} leads ${p.at} today: hiring, candour with the board, and how the team rates them.`;
  return `Ask how they know ${first} through ${p.at} and what ${first} was like to work with.`;
}

/**
 * The five people best placed to give a reference, by placement(): a named
 * co-founder or board member first, a colleague at a company they founded
 * or worked at next, someone who merely shares a large former employer
 * later. Someone at the current company only when their title is senior (a
 * peer or a leader, not someone who may report to them), and at most one.
 * At most two per company (people named in the check each count on their
 * own), direct contacts before firm contacts. Each carries its reason.
 */
export function referenceShortlist(groups, person) {
  const pool = [];
  for (const g of groups) for (const p of g.all || []) pool.push({ p, ...placement(p) });
  pool.sort((a, b) => b.score - a.score || compareInGroup(a.p, b.p));
  const out = [];
  const perCompany = new Map();
  let fromCurrent = 0;
  for (const { p, reason } of pool) {
    if (out.length >= SHORTLIST_SIZE) break;
    if (p.group === 'current' && (seniority(p.position) < 2 || fromCurrent >= 1)) continue;
    const ck = p.group === 'parties' ? `party:${personKey(p.name)}` : (normalizeCompanyKey(p.at || p.company) || `person:${personKey(p.name)}`);
    if ((perCompany.get(ck) || 0) >= 2) continue;
    perCompany.set(ck, (perCompany.get(ck) || 0) + 1);
    if (p.group === 'current') fromCurrent += 1;
    const { group: g, why, at, role, relation, toYear, broad, ...contact } = p;
    out.push({ ...contact, group: g, why, reason, ask: askFor(p, person) });
  }
  return out;
}

// ------------------------------------------------------------ the pairing

const asRows = (x) => (Array.isArray(x) ? x : Array.isArray(x?.rows) ? x.rows : []);
const asTruncated = (x) => (Array.isArray(x?.truncated) ? x.truncated : []);

/**
 * Pure: turns the matched contacts into what the report shows.
 *   nameMatches:  contacts carrying the person's full name
 *   atCompanies:  contacts at the report's companies (findContactsAtCompanies rows; match 'similar' marks a longer form of the name)
 *   titleMentions: contacts whose title names one of those companies
 *   partyMatches: contacts carrying a related party's name
 *   atInvestors:  contacts at investors ({ investor, of, contact })
 *   truncated:    [{ company, shown, total }] companies with more contacts than were read
 *   failed:       { self, companies, titles, parties, investors } lookups that did not finish
 */
export function buildNetworkLinks({
  report, total = null, nameMatches = [], atCompanies = [], titleMentions = [], partyMatches = [], atInvestors = [],
  investorsChecked = [], seededCompany = null, investorsMissed = false, truncated = [], failed = {}, extraNotes = [],
}) {
  const person = String(report?.name || '').trim();
  const companies = companiesOf(report);
  const parties = partiesOf(report);
  const notes = [];
  const fail = { self: false, companies: false, titles: false, parties: false, investors: false, ...failed };
  const findCompany = (name) => companies.find((co) => co.name === name || (co.aliases || []).includes(name))
    || companies.find((co) => companyIs(name, co));

  // ---- 1. in your network
  const namesakes = uniquePeople((nameMatches || []).filter((c) => sameName(c.name, person)));
  const strong = companies.filter((co) => co.tie === 'current' || co.tie === 'founded');
  const atStrong = namesakes.filter((c) => c.company && strong.some((co) => companyIs(c.company, co)));
  const hasCurrent = companies.some((co) => co.tie === 'current');
  let self = null;
  let others = namesakes;
  if (atStrong.length === 1 && seededCompany && sameCompany(atStrong[0].company, seededCompany)) {
    // The check's company came from this very contact, so matching it proves nothing.
    self = { ...shown(atStrong[0]), basis: 'seed', note: 'Same full name. The check was anchored on this contact\'s company, which you confirmed, so it does not show on its own that this is them: confirm it.' };
    others = namesakes.filter((c) => c !== atStrong[0]);
  } else if (atStrong.length === 1) {
    self = { ...shown(atStrong[0]), basis: 'company', note: `Same full name, and works at ${atStrong[0].company}, a company this check ties to them.` };
    others = namesakes.filter((c) => c !== atStrong[0]);
  } else if (namesakes.length === 1) {
    const c = namesakes[0];
    const tied = c.company ? companies.find((co) => companyIs(c.company, co)) : null;
    if (tied) {
      self = { ...shown(c), basis: 'tied-company', note: `Same full name, and works at ${c.company}, a company they were tied to earlier. That is not their current company: confirm it is them.` };
      others = [];
    } else if (!hasCurrent) {
      self = { ...shown(c), basis: 'name', note: 'Same full name. Nothing else ties this contact to the person checked, so confirm it is them.' };
      others = [];
    }
  }
  const sameNameContacts = others.map(shown);

  // Nobody with the person's own name is listed as "someone you know around them".
  const used = new Set(namesakes.map(contactId));

  // ---- 3. people around them
  const buckets = Object.fromEntries(GROUPS.map((g) => [g.key, []]));
  const more = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
  for (const c of partyMatches || []) {
    const party = parties.find((p) => sameName(p.name, c.name));
    if (!party || sameName(c.name, person) || used.has(contactId(c))) continue;
    used.add(contactId(c));
    const why = `Named in this check as ${person ? `${firstName(person)}'s` : 'their'} ${party.relation || 'associate'}${party.role ? ` (${party.role})` : ''}`;
    buckets.parties.push({ ...shown(c), group: 'parties', relation: party.relation, at: c.company || party.name, why });
  }
  const placeAt = (c, company, extra = {}) => {
    const years = company.tie === 'current' ? null : yearsText(company.from, company.to, company.current);
    const item = {
      ...shown(c), group: company.tie, at: c.company || company.name, role: company.role,
      why: extra.why || companyWhy(company, person || 'the person', c, years),
      toYear: company.to, broad: isBroadOrganisation(company.name),
      ...(years ? { years } : {}),
      ...(c.match === 'similar' ? { similar: true } : {}),
      ...(extra.mention ? { mention: true } : {}),
    };
    buckets[company.tie].push(item);
  };
  for (const c of uniquePeople(atCompanies)) {
    if (used.has(contactId(c))) continue;
    const company = (c.matchedCompany && findCompany(c.matchedCompany)) || findCompany(c.company);
    if (!company) continue;
    used.add(contactId(c));
    placeAt(c, company);
  }
  for (const c of uniquePeople(titleMentions)) {
    if (used.has(contactId(c))) continue;
    const company = c.matchedCompany && findCompany(c.matchedCompany);
    if (!company || !['earlier', 'founded'].includes(company.tie)) continue;
    used.add(contactId(c));
    placeAt(c, company, { mention: true, why: `Works at ${c.company || 'another company'}; their title mentions ${company.name} (possibly a former colleague)` });
  }
  for (const { investor, of, contact: c } of atInvestors || []) {
    if (!c || used.has(contactId(c))) continue;
    used.add(contactId(c));
    const backed = of ? companies.find((co) => co.name === of || sameCompany(co.name, of)) : companies.find((co) => co.tie === 'current');
    const ofName = of || (backed ? backed.name : null);
    const which = backed && backed.tie === 'founded' ? `, which ${person || 'they'} founded` : '';
    buckets.investors.push({
      ...shown(c), group: 'investors', at: c.company || investor,
      why: `Works at ${c.company || investor}, an investor in ${ofName || 'their company'}${which}${c.match === 'similar' ? `. A similar name (${c.company} for ${investor}): confirm it is the same firm` : ''}`,
      ...(c.match === 'similar' ? { similar: true } : {}),
    });
  }

  // ---- companies with more contacts than were read: say how many, never drop them silently
  for (const t of truncated || []) {
    const n = Math.max(0, Number(t?.total || 0) - Number(t?.shown || 0));
    if (!n) continue;
    const company = findCompany(t.company);
    const key = company ? company.tie : 'investors';
    more[key] += n;
    notes.push(`${n} more at ${t.company} are not listed here; the most senior are shown first.`);
  }

  const groups = GROUPS.map((g) => {
    const all = buckets[g.key].sort(compareInGroup);
    const inGroup = g.key === 'parties' || g.key === 'investors' ? [] : companies.filter((co) => co.tie === g.key).map((co) => co.name);
    return { ...g, companies: inGroup, total: all.length + more[g.key], ...(more[g.key] ? { more: more[g.key] } : {}), direct: all.filter((p) => p.relationship === 'direct').length, all };
  });
  const references = referenceShortlist(groups, person);
  const currentGroup = groups.find((g) => g.key === 'current');
  const currentOnly = groups.every((g) => g.key === 'current' || g.total === 0) && currentGroup.total > 0;
  if (currentOnly && !references.length) notes.push('Everyone you know around them works at their current company, below them or beside them. Their view is not independent, so no reference call is suggested.');
  else if (currentOnly) notes.push('Everyone you know around them works at their current company; weigh what they say accordingly.');
  if (groups.some((g) => g.all.some((p) => p.years))) notes.push('The years are when they were at each company; whether your contacts overlapped with them there is not known.');
  if (fail.self) notes.push('Whether they are one of your contacts could not be read just now.');
  if (fail.companies) notes.push('People you know at their companies could not be read just now. Open the report again in a moment.');
  if (fail.titles) notes.push('Contacts whose titles mention their earlier companies could not be read just now.');
  if (fail.parties) notes.push('People named in this check could not be matched to your contacts just now.');
  if (fail.investors) notes.push('People you know at their investors could not be read just now.');
  if (investorsMissed) notes.push(INVESTORS_MISSED_NOTE);
  notes.push(...extraNotes);
  if (!companies.length) notes.push('This check found no company for the person, so there was nothing to match your network against.');

  const strip = ({ at, role, relation, toYear, broad, ...p }) => p;
  return {
    available: true,
    checked: total,
    seededCompany: seededCompany || null,
    self,
    sameNameContacts,
    groups: groups.filter((g) => g.total > 0).map(({ all, ...g }) => ({ ...g, people: all.slice(0, MAX_PER_GROUP).map(strip) })),
    references,
    companiesChecked: companies.map((c) => c.name),
    investorsChecked,
    failed: fail,
    counts: { people: groups.reduce((n, g) => n + g.total, 0), direct: groups.reduce((n, g) => n + g.direct, 0), companies: companies.length },
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

/**
 * Investors of several companies (the current one and those they founded),
 * at most `max` lookups run side by side under one time limit. Only company
 * names go out.
 *   -> { investors: [{ name, of }], complete, missed: string[] } (never throws)
 */
export async function lookupInvestorsForCompanies(companies, { profileLoader = null, timeoutMs = 8000, max = 3 } = {}) {
  const names = [];
  for (const c of Array.isArray(companies) ? companies : []) {
    const n = String(c || '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMPANY_LENGTH);
    if (n && !names.some((x) => normalizeCompanyKey(x) === normalizeCompanyKey(n))) names.push(n);
  }
  const picked = names.slice(0, Math.max(1, Math.min(5, Number(max) || 3)));
  const results = await Promise.all(picked.map((n) => lookupInvestorsResult(n, { profileLoader, timeoutMs })));
  const investors = [];
  const missed = [];
  results.forEach((r, i) => {
    if (!r.complete) missed.push(picked[i]);
    for (const name of r.investors) if (!investors.some((x) => normalizeCompanyKey(x.name) === normalizeCompanyKey(name))) investors.push({ name, of: picked[i] });
  });
  return { investors: investors.slice(0, MAX_INVESTORS), complete: missed.length === 0, missed };
}

export const INVESTORS_MISSED_NOTE = 'Their investors could not be looked up in time, so people you know at their investors are not shown.';

/** Parties' names, in one lookup; names shared by too many contacts are retried one by one and only those dropped. */
async function partyLookup(store, userId, names) {
  try {
    return { rows: await store.findContactsByNames(userId, names), dropped: 0 };
  } catch (error) {
    if (error?.code !== 'too_many') throw error;
    if (names.length < 2) return { rows: [], dropped: 1 };
  }
  const rows = [];
  let dropped = 0;
  for (let i = 0; i < names.length; i += 10) {
    const settled = await Promise.allSettled(names.slice(i, i + 10).map((n) => store.findContactsByNames(userId, [n])));
    for (const s of settled) {
      if (s.status === 'fulfilled') rows.push(...(s.value || []));
      else if (s.reason?.code === 'too_many') dropped += 1;
      else throw s.reason;
    }
  }
  return { rows, dropped };
}

/**
 * The pairing for a finished report. `investors` are names already looked
 * up (strings, or { name, of }; kept on the check, so a reload does not look
 * them up again). Each lookup is settled on its own: the parts that worked
 * are shown and each part that failed is named in the notes and in
 * `failed`. Never throws: { available: false, reason } when signed out,
 * without persistence, with no contacts, or when nothing could be read.
 */
export async function networkForReport(userId, report, { store = networkStore, investors = [], seededCompany = null, investorsMissed = false } = {}) {
  try {
    if (!userId || String(userId).startsWith('anon:')) return { available: false, reason: 'Sign in and import your network in the Network Map tab to see who you know around this person.' };
    if (persistenceMode() === 'none') return { available: false, reason: 'Your network is not saved on this deployment, so it cannot be matched to this check.' };
    const total = await store.countContacts(userId);
    if (!total) return { available: false, reason: IMPORT_HINT };
    const companies = companiesOf(report);
    const parties = partiesOf(report);
    const investorTargets = investorsOf(report, investors);
    const titleTargets = companies.filter((c) => c.tie === 'earlier' || c.tie === 'founded').map((c) => c.name);
    const skip = Symbol('skip');
    const parts = {
      self: report?.name ? store.findContactsByNames(userId, [report.name]) : skip,
      companies: companies.length ? store.findContactsAtCompanies(userId, searchNames(companies), { detail: true, similar: true, perCompany: PER_COMPANY_ROWS }) : skip,
      titles: titleTargets.length && typeof store.findContactsByTitleMention === 'function' ? store.findContactsByTitleMention(userId, titleTargets) : skip,
      parties: parties.length ? partyLookup(store, userId, parties.map((p) => p.name)) : skip,
      investors: investorTargets.length ? store.findContactsAtCompanies(userId, investorTargets.map((i) => i.name), { detail: true, similar: true, investor: true, perCompany: 50 }) : skip,
    };
    const keys = Object.keys(parts);
    const settled = await Promise.allSettled(keys.map((k) => parts[k]));
    const got = {};
    const failed = {};
    keys.forEach((k, i) => {
      const s = settled[i];
      if (s.status === 'rejected') failed[k] = true;
      else got[k] = s.value === skip ? null : s.value;
    });
    const tried = keys.filter((k) => parts[k] !== skip && k !== 'titles');
    if (tried.length && tried.every((k) => failed[k])) return { available: false, reason: READ_FAILED };
    const extraNotes = [];
    // A lookup that hit its row limit read only part of the contacts: say so, never let it pass as everyone
    const incomplete = Boolean(got.companies?.incomplete || got.investors?.incomplete);
    if (incomplete) extraNotes.push('Not every contact at their companies could be read, so some people you know there may be missing.');
    if (got.parties?.dropped) extraNotes.push(`${got.parties.dropped} ${got.parties.dropped === 1 ? 'name' : 'names'} named in this check ${got.parties.dropped === 1 ? 'is' : 'are'} shared by too many of your contacts to match, so ${got.parties.dropped === 1 ? 'it was' : 'they were'} left out.`);
    const atInvestors = asRows(got.investors).map((c) => {
      const t = investorTargets.find((i) => i.name === c.matchedCompany) || { name: c.matchedCompany, of: null };
      return { investor: t.name, of: t.of, contact: c };
    });
    const net = buildNetworkLinks({
      report, total,
      nameMatches: asRows(got.self),
      atCompanies: asRows(got.companies),
      titleMentions: asRows(got.titles),
      partyMatches: got.parties?.rows || [],
      atInvestors,
      truncated: [...asTruncated(got.companies), ...asTruncated(got.investors)],
      investorsChecked: investorTargets.map((i) => i.name),
      seededCompany, investorsMissed, failed, extraNotes,
    });
    return incomplete ? { ...net, incomplete: true } : net;
  } catch {
    return { available: false, reason: READ_FAILED };
  }
}

/** The one contact carrying this full name with a company, or null. */
async function singleNamesake(userId, name, store) {
  if (!userId || String(userId).startsWith('anon:') || persistenceMode() === 'none') return null;
  if (nameKeys(name).length === 0) return null;
  const matches = uniquePeople((await store.findContactsByNames(userId, [name])).filter((c) => sameName(c.name, name)));
  if (matches.length !== 1) return null;
  const company = String(matches[0].company || '').replace(/\s+/g, ' ').trim();
  if (!company || company.length > MAX_COMPANY_LENGTH) return null;
  return company;
}

/**
 * Before a deep check starts with no company typed: when exactly one contact
 * carries the full name and has a company, the question to put to the user.
 * Only the company name is returned; no other contact field is. Nothing is
 * seeded here. -> { company, question } | null
 */
export async function seedSuggestion(userId, name, typedCompany = '', { store = networkStore } = {}) {
  try {
    if (String(typedCompany || '').trim()) return null;
    const company = await singleNamesake(userId, name, store);
    if (!company) return null;
    return { company, question: `Is this the ${tidyName(name)} at ${company} in your network?` };
  } catch {
    return null;
  }
}

/**
 * The company that anchors a check started without one, only after the user
 * said yes to seedSuggestion()'s question (`confirmedCompany`) and only while
 * that is still the one contact's company. Without a yes: null, so a namesake
 * never silently decides who the check is about. The origin is 'network', so
 * the check can treat it as a lead rather than as a company the user typed.
 *   -> { company, origin: 'network' } | null
 */
export async function companySeed(userId, name, typedCompany = '', { store = networkStore, confirmedCompany = '' } = {}) {
  try {
    if (String(typedCompany || '').trim()) return null;
    const confirmed = String(confirmedCompany || '').trim();
    if (!confirmed) return null;
    const company = await singleNamesake(userId, name, store);
    if (!company || !sameCompany(company, confirmed)) return null;
    return { company, origin: 'network' };
  } catch {
    return null;
  }
}

/**
 * The user's own checks in one status, newest first, one per person and
 * company. Saved checks live in the hosted database; locally they are kept in
 * this server's memory (see jobStore.js), which `memory` reads. Only checks
 * the job store still keeps (RETENTION_HOURS) are listed, so every id opens.
 */
async function listChecks(userId, status, { limit = 50, memory = globalThis.__founderJobs } = {}) {
  if (!userId || String(userId).startsWith('anon:')) return [];
  const cap = Math.max(1, Math.min(100, Number(limit) || 50));
  let rows = [];
  if (persistenceMode() === 'neon') {
    rows = (await query(
      `SELECT id, name, company, status, updated_at, (state->'report'->'totals'->>'redFlags') AS red_flags,
              (state->'report'->'totals'->>'ifRightPerson') AS if_right,
              (state->'networkSeed'->>'company') AS seeded
         FROM founder_jobs
        WHERE user_id = $1 AND status = '${status === 'done' ? 'done' : 'running'}'
          AND updated_at > now() - interval '${Number(RETENTION_HOURS) || 72} hours'
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, cap]
    )) || [];
  } else if (memory && typeof memory.values === 'function') {
    const done = (j) => j.status === 'done' || Boolean(j.state?.report);
    // The same retention as the hosted list: a check older than the job store keeps is not listed.
    const since = Date.now() - (Number(RETENTION_HOURS) || 72) * 3600 * 1000;
    const fresh = (j) => !(Number(j.updatedAt) > 0) || Number(j.updatedAt) > since;
    rows = [...memory.values()]
      .filter((j) => j && j.owner === userId && fresh(j) && (status === 'done' ? done(j) : j.status === 'running' && !done(j)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, cap)
      .map((j) => ({ id: j.id, name: j.name, company: j.company, status: status, updated_at: j.updatedAt, red_flags: j.state?.report?.totals?.redFlags, if_right: j.state?.report?.totals?.ifRightPerson, seeded: j.state?.networkSeed?.company }));
  }
  const out = [];
  for (const r of rows) {
    const key = `${personKey(r.name)}|${normalizeCompanyKey(r.company)}`;
    if (out.some((c) => c.key === key)) continue;
    const date = r.updated_at ? new Date(r.updated_at) : null;
    const flags = r.red_flags === null || r.red_flags === undefined ? NaN : Number(r.red_flags);
    const held = r.if_right === null || r.if_right === undefined ? NaN : Number(r.if_right);
    out.push({
      key,
      id: r.id ? String(r.id) : null,
      name: String(r.name || ''),
      company: String(r.company || ''),
      seededCompany: r.seeded ? String(r.seeded) : null,
      status: status === 'done' ? 'done' : 'running',
      date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      redFlags: Number.isFinite(flags) ? flags : null,
      // serious matters held "if this is the right person": the Checked chip turns amber on them
      ifRightPerson: Number.isFinite(held) ? held : null,
    });
  }
  return out.map(({ key, ...c }) => c);
}

/** The user's own finished deep checks. -> [{ id, name, company, seededCompany, status: 'done', date, redFlags, ifRightPerson }] */
export async function listFinishedChecks(userId, opts = {}) {
  return listChecks(userId, 'done', opts);
}

/** The user's own checks still running, so the page can reopen one instead of starting it again. */
export async function listRunningChecks(userId, opts = {}) {
  return listChecks(userId, 'running', opts);
}
