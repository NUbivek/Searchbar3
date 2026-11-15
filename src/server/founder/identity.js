/**
 * Who is this record about? Many people share a name, and a background
 * check that pins someone else's lawsuit on a founder is worse than no
 * check. Every finding is therefore graded against what is already known
 * about the subject (their "anchors": companies, schools, co-founders,
 * handles), never by name alone.
 *
 *   confirmed  the name and a known company of the subject appear together
 *   likely     the name and another anchor (school, co-founder, handle) appear
 *   possible   only the exact name appears: may be a namesake
 *
 * Anchors grow as the check learns more (a company found in round 1 confirms
 * records in round 2), which is why matching is recomputed, not stored once.
 */
import { nameMatcher, nameVariants, normalizePersonName, companyKeys } from '../founderCheck';

const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercase ASCII tokens of a name: "José María O'Neil-Smith" -> ["jose", "maria", "oneil", "smith"]. */
export function nameTokens(name) {
  return stripAccents(name).toLowerCase().replace(/['’.]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * URL slugs and handles a person commonly uses: first-last, firstlast,
 * first.last, flast, first_last, lastfirst. Middle names and initials are
 * dropped for the short forms.
 */
export function slugCandidates(name) {
  const tokens = nameTokens(name);
  if (tokens.length < 2) return [];
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const out = new Set([
    `${first}-${last}`, `${first}${last}`, `${first}.${last}`, `${first}_${last}`,
    `${first[0]}${last}`, `${last}${first}`, `${last}-${first}`,
  ]);
  if (tokens.length > 2) {
    out.add(tokens.join('-'));
    out.add(tokens.join(''));
  }
  return [...out].filter((s) => s.length >= 4);
}

/**
 * A matcher for an organisation name that tolerates suffixes ("Theranos,
 * Inc." matches "Theranos").
 *
 * Many companies are named with an ordinary word (Stripe, Flow, Square,
 * Notion). "A blue stripe" or "cash flow" beside a namesake must not confirm
 * that the record is about the founder, so a one-word name only counts when
 * it is written as a name: with a capital letter somewhere ("Stripe",
 * "dHybrid", "STRIPE"), or as part of an address or handle ("stripe.com",
 * "/company/stripe", "@stripe").
 */
function orgMatcher(org) {
  const raw = String(org || '').trim();
  if (raw.length < 2) return null;
  const exact = new RegExp(`(?<![A-Za-z0-9])${escapeRe(raw)}(?![A-Za-z0-9])`, 'i');
  const keyList = companyKeys(raw).filter((k) => k.length >= 3);
  const keys = keyList.map((k) => new RegExp(`(?<![a-z0-9])${escapeRe(k)}(?![a-z0-9])`));
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, ' ').replace(/\s+/g, ' ');
  const single = keyList.length === 1 && !/\s/.test(keyList[0]) ? keyList[0] : (!/\s/.test(raw) ? raw.toLowerCase() : null);
  const occurrences = single ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(single)}(?![A-Za-z0-9])`, 'gi') : null;
  const writtenAsName = (str) => {
    if (!occurrences) return true;
    for (const m of str.matchAll(occurrences)) {
      if (m[0] !== m[0].toLowerCase()) return true;
      const before = m.index > 0 ? str[m.index - 1] : '';
      if (before && '/@.'.includes(before)) return true;
      if (/^\.[a-z]{2,6}(?![a-z])/.test(str.slice(m.index + m[0].length, m.index + m[0].length + 8))) return true;
    }
    return false;
  };
  return (text) => {
    const str = String(text || '');
    return (exact.test(str) || (keys.length > 0 && keys.some((k) => k.test(norm(str))))) && writtenAsName(str);
  };
}

/**
 * The subject of a check and everything known about them so far.
 * @param {{ name: string, company?: string }} input
 */
export function createSubject({ name, company = '' }) {
  const person = normalizePersonName(name);
  const variants = nameVariants(person);
  const subject = {
    name: person,
    variants,
    hasName: nameMatcher(variants),
    slugs: slugCandidates(person),
    company: String(company || '').trim(),
    anchors: { companies: new Map(), schools: new Map(), people: new Map(), handles: new Map(), domains: new Map() },
  };
  if (subject.company) addAnchor(subject, 'companies', subject.company, 'given');
  return subject;
}

/**
 * Record something learned about the subject. `origin` says how we know:
 * 'given' (the user typed it) or the finding id that established it.
 * Returns true when the anchor is new.
 */
export function addAnchor(subject, kind, value, origin = 'found') {
  const v = String(value || '').trim();
  if (v.length < 2 || !subject.anchors[kind]) return false;
  const key = kind === 'companies' ? (companyKeys(v)[0] || v.toLowerCase()) : v.toLowerCase();
  if (!key || subject.anchors[kind].has(key)) return false;
  // The person's own name is never an anchor for themselves.
  if (kind !== 'handles' && subject.hasName(v)) return false;
  const test = kind === 'people' ? nameMatcher([v])
    : kind === 'handles' || kind === 'domains' ? ((text) => new RegExp(`(?<![A-Za-z0-9_])@?${escapeRe(v)}(?![A-Za-z0-9_])`, 'i').test(text))
    : orgMatcher(v);
  if (!test) return false;
  subject.anchors[kind].set(key, { value: v, origin, test });
  return true;
}

/** Plain-data copy of the anchors (for persisting a job between requests). */
export function exportAnchors(subject) {
  const out = {};
  for (const [kind, map] of Object.entries(subject.anchors)) out[kind] = [...map.values()].map(({ value, origin }) => ({ value, origin }));
  return out;
}

/** Rebuild a subject from { name, company, anchors } saved by exportAnchors. */
export function restoreSubject({ name, company, anchors = {} }) {
  const subject = createSubject({ name, company });
  for (const [kind, list] of Object.entries(anchors)) for (const a of list || []) addAnchor(subject, kind, a.value, a.origin);
  return subject;
}

/**
 * Grade a piece of text against the subject.
 * @returns {{ level: 'confirmed'|'likely'|'possible'|'none', reasons: string[] }}
 */
export function matchSubject(subject, text) {
  const str = String(text || '');
  if (!subject.hasName(str)) return { level: 'none', reasons: [] };
  const reasons = [];
  let company = false;
  for (const a of subject.anchors.companies.values()) if (a.test(str)) { company = true; reasons.push(`names ${a.value}`); }
  let other = 0;
  for (const kind of ['schools', 'people', 'handles', 'domains']) {
    for (const a of subject.anchors[kind].values()) if (a.test(str)) { other += 1; reasons.push(`names ${a.value}`); }
  }
  if (company) return { level: 'confirmed', reasons: reasons.slice(0, 4) };
  if (other > 0) return { level: 'likely', reasons: reasons.slice(0, 4) };
  return { level: 'possible', reasons: ['matched by name only'] };
}

const LEVEL_RANK = { confirmed: 3, likely: 2, possible: 1, none: 0 };
/** The stronger of two match levels. */
export const strongerMatch = (a, b) => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);
export const matchRank = (level) => LEVEL_RANK[level] || 0;
