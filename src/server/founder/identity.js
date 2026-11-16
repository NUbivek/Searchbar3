/**
 * Who is this record about? Many people share a name, and a background
 * check that pins someone else's lawsuit on a founder is worse than no
 * check. Every finding is therefore graded against what is already known
 * about the subject (their "anchors": companies, schools, co-founders,
 * handles), never by name alone.
 *
 *   confirmed  the name and a known company of the subject appear together
 *   likely     the name and another anchor (school, co-founder, handle) appear,
 *              or a record dated inside the person's CEO tenure names that company's CEO
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
 * A company name without its legal form, and nothing else removed: "Mistral
 * AI, Inc." -> "mistral ai". Unlike companyKeys (which also drops describing
 * words such as "AI" or "Labs" so that mentions in prose still match), this
 * keeps them, for places where two registered names are compared and
 * "Mistral AI" must not be taken for "Mistral, Inc.".
 */
export function companyKeyStrict(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9À-ɏ ]+/g, ' ')
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|sa|sas|sarl|gmbh|ag|bv|nv|pty|lp|llp|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One key per person, however a source writes them: "Christian Holmes" and
 * "Christian Holmes IV", "Donald L. Lucas" and "Donald Lucas", "Silvana
 * Maria Konermann" and "Silvana Konermann" (first and last name, without
 * generational suffixes or titles).
 */
export function personKey(name) {
  const norm = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = norm.replace(/[.,]/g, ' ').split(/\s+/).filter((w) => w && !/^(jr|sr|ii|iii|iv|v|phd|md|esq)$/.test(w));
  return tokens.length >= 2 ? `${tokens[0]} ${tokens[tokens.length - 1]}` : norm;
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
 *
 * A capitalised word can still be one part of a longer, different name
 * ("Cash Flow Capital", "Red Stripe Brewing", "Domaine du Mistral"), so a
 * one-word name also must not come after another capitalised word of the
 * same name. Words after it are allowed, since a company's full legal name
 * and its subsidiaries start with it ("Nikola Motor Company LLC", "Theranos
 * IP Company"). Legal forms ("Inc Stripe"), the company's own other words
 * ("The Flow"), job titles ("CEO Stripe"), possessives ("Neumann's Flow")
 * and the first word of a sentence do not count. Headlines written in Title
 * Case or capitals say nothing by their capitals, so there only a joining
 * word ("Domaine du Mistral") marks a longer name.
 */
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'sas', 'sarl', 'nv', 'bv', 'se', 'pty', 'ab', 'oy', 'spa', 'srl']);
const ROLE_WORDS = new Set(['ceo', 'cto', 'cfo', 'coo', 'cpo', 'founder', 'cofounder', 'co-founder', 'chief', 'president', 'chairman', 'chairwoman', 'chair', 'head', 'director', 'vp', 'boss', 'owner', 'executive']);
// Lowercase words that join the parts of one proper name ("Domaine du Mistral", "Bank of Flow").
const NAME_JOINERS = new Set(['du', 'de', 'des', 'la', 'le', 'les', 'di', 'da', 'del', 'della', 'von', 'van', 'der', 'den', 'of', '&']);
// Common words that a headline capitalises before a company ("With Acme CEO", "Former Acme CEO"): never part of its name.
const FUNCTION_WORDS = new Set(['with', 'from', 'by', 'for', 'at', 'to', 'and', 'says', 'meet', 'inside', 'how', 'why', 'interview', 'former', 'ex', 'avec', 'pour', 'chez']);
const wordKey = (w) => String(w || '').toLowerCase().replace(/^[^a-z0-9À-ɏ&]+|[^a-z0-9À-ɏ&]+$/g, '');
const startsCapital = (w) => /^[^A-Za-zÀ-ɏ0-9]*[A-ZÀ-Þ]/.test(w);

function orgMatcher(org, subject = null) {
  const raw = String(org || '').trim();
  if (raw.length < 2) return null;
  // The person's own name beside the company ("Jane Roe of Acme", "Jane Roe Acme trial") is not a longer
  // organisation name: it is exactly the pairing that confirms a record.
  const personWords = new Set(subject ? nameTokens(subject.name) : []);
  const exact = new RegExp(`(?<![A-Za-z0-9])${escapeRe(raw)}(?![A-Za-z0-9])`, 'i');
  const keyList = companyKeys(raw).filter((k) => k.length >= 3);
  const keys = keyList.map((k) => new RegExp(`(?<![a-z0-9])${escapeRe(k)}(?![a-z0-9])`));
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, ' ').replace(/\s+/g, ' ');
  const single = keyList.length === 1 && !/\s/.test(keyList[0]) ? keyList[0] : (!/\s/.test(raw) ? raw.toLowerCase() : null);
  const occurrences = single ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(single)}(?![A-Za-z0-9])`, 'gi') : null;
  // A multi-word name that reduces to one key ("Mistral AI" -> "mistral") is tried whole first.
  const whole = single && /\s/.test(raw) ? new RegExp(exact.source, 'gi') : null;
  const ownWords = new Set(raw.split(/\s+/).map(wordKey).filter(Boolean));
  const neutral = (w) => { const k = wordKey(w); return LEGAL_FORMS.has(k) || ROLE_WORDS.has(k) || FUNCTION_WORDS.has(k) || ownWords.has(k) || personWords.has(nameTokens(w)[0]); };
  // The word right before a span, only when nothing but spaces separates them.
  const wordBefore = (str, at) => {
    const m = str.slice(0, at).match(/(\S+)[ \t]+$/);
    if (!m || /[,;:)\]}.!?"”—–|]$/.test(m[1])) return null;
    return { word: m[1], at: m.index };
  };
  const sentenceStart = (str, at) => /(^|[.!?]\s+|\n\s*)$/.test(str.slice(0, at));
  // Title Case or capitals around the span: almost no long word is lowercase.
  const headline = (str, start, end) => {
    // Bracketed tags ("[video]", "[pdf]") are written lowercase in any headline.
    const near = `${str.slice(Math.max(0, start - 80), start)} ${str.slice(end, end + 80)}`.replace(/\[[^\]]{1,12}\]/g, ' ');
    const long = near.match(/[A-Za-zÀ-ɏ]{5,}/g) || [];
    return long.length >= 3 && long.filter((w) => w === w.toLowerCase()).length / long.length < 0.2;
  };
  const insideLongerName = (str, start, end) => {
    const prev = wordBefore(str, start);
    if (!prev) return false;
    if (/['’]s$/i.test(prev.word)) return false; // "Neumann's Flow"
    // Followed by a possessive or a title ("Acme's", "Acme CEO", "Acme founder"), the word is named as the company.
    const after = str.slice(end);
    const next = after.match(/^[ \t]+(\S+)/);
    const titled = /^['’]s\b/i.test(after) || Boolean(next && ROLE_WORDS.has(wordKey(next[1])));
    if (NAME_JOINERS.has(wordKey(prev.word)) || prev.word === '&') {
      const head = wordBefore(str, prev.at);
      if (!head || !startsCapital(head.word) || neutral(head.word)) return false;
      // In a headline, a capitalised joiner ("Worth Of Acme Stock") is only Title Case, and a possessive or
      // title marks the company ("A Timeline of Acme's Founder"). In prose a joined name stays one name
      // ("Domaine du Mistral CEO"), and so does a lowercase joiner in a headline otherwise ("Buys Domaine du
      // Mistral Vineyard").
      if (!headline(str, start, end)) return true;
      return !(startsCapital(prev.word) || titled);
    }
    if (!startsCapital(prev.word) || neutral(prev.word) || titled) return false;
    return !sentenceStart(str, prev.at) && !headline(str, start, end);
  };
  const writtenAsName = (str) => {
    if (!occurrences) return true;
    for (const re of [whole, occurrences]) {
      if (!re) continue;
      for (const m of str.matchAll(re)) {
        const start = m.index;
        const end = m.index + m[0].length;
        const before = start > 0 ? str[start - 1] : '';
        if (before && '/@.'.includes(before)) return true;
        if (/^\.[a-z]{2,6}(?![a-z])/.test(str.slice(end, end + 8))) return true;
        if (m[0] === m[0].toLowerCase()) continue;
        if (!insideLongerName(str, start, end)) return true;
      }
    }
    return false;
  };
  // Handles and domains often glue a word to the name ("@acmemotor", "acmemotor.com"). The company key
  // (spaces removed) counts as the start of an @handle or a domain label when it has 5 or more characters,
  // so short keys ("@flowstate") and the person's own name ("@janeroe" for a company called Jane) do not.
  const prefixes = [...new Set(keyList.map((k) => k.replace(/\s+/g, '')))]
    .filter((k) => k.length >= 5 && /^[a-z0-9]+$/.test(k) && !personWords.has(k))
    .flatMap((k) => [
      new RegExp(`(?<![A-Za-z0-9_])@${escapeRe(k)}[a-z0-9_]*(?![A-Za-z0-9_])`, 'gi'),
      new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(k)}[a-z0-9-]*\\.[a-z]{2,6}(?![A-Za-z0-9])`, 'gi'),
    ]);
  // The top-level domain is written lowercase: "Acmecorp.Then" is two sentences, not an address.
  const handleOrDomain = (str) => prefixes.some((re) => [...str.matchAll(re)]
    .some((m) => m[0].startsWith('@') || /\.[a-z]{2,6}$/.test(m[0])));
  return (text) => {
    const str = String(text || '');
    if (handleOrDomain(str)) return true;
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
    anchors: { companies: new Map(), schools: new Map(), people: new Map(), handles: new Map(), domains: new Map(), roles: new Map() },
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
  if (v.length < 2 || !subject.anchors[kind] || kind === 'roles') return false;
  const key = kind === 'companies' ? (companyKeys(v)[0] || v.toLowerCase()) : v.toLowerCase();
  if (!key || subject.anchors[kind].has(key)) return false;
  // The person's own name is never an anchor for themselves.
  if (kind !== 'handles' && subject.hasName(v)) return false;
  // A handle or domain that is just one of the person's own names ("jack" for
  // Jack Dorsey) would be found inside every namesake's record.
  if ((kind === 'handles' || kind === 'domains') && !/[0-9_.]/.test(v) && nameTokens(subject.name).includes(v.toLowerCase().replace(/^@/, ''))) return false;
  const test = kind === 'people' ? nameMatcher([v])
    : kind === 'handles' || kind === 'domains' ? ((text) => new RegExp(`(?<![A-Za-z0-9_])@?${escapeRe(v)}(?![A-Za-z0-9_])`, 'i').test(text))
    : orgMatcher(v, subject);
  if (!test) return false;
  subject.anchors[kind].set(key, { value: v, origin, test });
  return true;
}

const DAY = /^\d{4}(?:-\d{2}){0,2}$/;
const isoDay = (d) => { const s = String(d || '').slice(0, 10); return DAY.test(s) ? s : ''; };

/**
 * Record that the subject was chief executive of `org` from `from` to `to`
 * (ISO dates; `to` empty while they still hold it), as a source that names
 * the person in the role states it (Wikidata "position held" with start and
 * end, a Form D, a confirmed register record). Only one person is a
 * company's CEO on a given day, so a record from that time that names "Acme's
 * CEO" is about them. Only the CEO role counts: founders and co-founders
 * share their title. Returns true when the anchor is new.
 */
export function addRoleAnchor(subject, { org, role = 'ceo', from, to = '', origin = 'found' } = {}) {
  const value = String(org || '').trim();
  const start = isoDay(from);
  const end = isoDay(to);
  if (role !== 'ceo' || value.length < 2 || !start || (to && !end) || (end && end < start)) return false;
  if (!subject.anchors.roles) subject.anchors.roles = new Map();
  const key = `${companyKeys(value)[0] || value.toLowerCase()}|${start}`;
  if (subject.anchors.roles.has(key)) return false;
  const names = [...new Set([value, ...companyKeys(value).filter((k) => k.length >= 3)])].map(escapeRe).join('|');
  // "Acme CEO", "Acme's chief executive", but not a predecessor, successor or a shared role ("former Acme CEO",
  // "new Acme CEO", "Acme co-CEO").
  const re = new RegExp(`(?<![A-Za-z0-9])(${names})(?:['’]s)?\\s+(?:CEO|chief executive|C\\.E\\.O\\.)(?![A-Za-z0-9])`, 'gi');
  const otherHolder = /\b(?:former|ex|previous|past|then|interim|acting|incoming|outgoing|new|next|future|founding|co)[\s-]+(?:\S+\s+)?$/i;
  // `isOther(after)` says whether the words after the title name someone else ("Acme CEO John Smith").
  const test = (text, isOther = () => false) => [...String(text || '').matchAll(re)].some((m) => {
    // A one-word name in lowercase is an ordinary word ("the flow CEO"), not the company.
    if (!/\s/.test(m[1]) && m[1] === m[1].toLowerCase()) return false;
    if (otherHolder.test(text.slice(Math.max(0, m.index - 30), m.index))) return false;
    return !isOther(text.slice(m.index + m[0].length));
  });
  subject.anchors.roles.set(key, { value, org: value, role: 'ceo', from: start, to: end, origin, test });
  return true;
}

/** Whether an ISO date (any precision) falls inside a tenure, comparing at the shorter precision. */
// A date that only matches a boundary at a coarser precision ("2019" against a tenure ending "2019-09-24") may
// fall on either side of it, and so is not inside.
function withinTenure(date, from, to) {
  const d = isoDay(date);
  if (!d) return false;
  const cmp = (a, b) => {
    const n = Math.min(a.length, b.length);
    const c = a.slice(0, n).localeCompare(b.slice(0, n));
    return c !== 0 || a.length === b.length ? c : NaN;
  };
  return cmp(d, from) >= 0 && (!to || cmp(d, to) <= 0);
}

/** Plain-data copy of the anchors (for persisting a job between requests). */
export function exportAnchors(subject) {
  const out = {};
  for (const [kind, map] of Object.entries(subject.anchors)) {
    out[kind] = [...map.values()].map(({ value, origin, role, from, to }) => (kind === 'roles' ? { value, org: value, role, from, to, origin } : { value, origin }));
  }
  return out;
}

/** Rebuild a subject from { name, company, anchors } saved by exportAnchors. */
export function restoreSubject({ name, company, anchors = {} }) {
  const subject = createSubject({ name, company });
  for (const [kind, list] of Object.entries(anchors)) {
    for (const a of list || []) {
      if (kind === 'roles') addRoleAnchor(subject, { org: a.org || a.value, role: a.role, from: a.from, to: a.to, origin: a.origin });
      else addAnchor(subject, kind, a.value, a.origin);
    }
  }
  return subject;
}

/**
 * Grade a piece of text against the subject.
 * @returns {{ level: 'confirmed'|'likely'|'possible'|'none', reasons: string[] }}
 */
export function matchSubject(subject, text, { date } = {}) {
  const str = String(text || '');
  if (!subject.hasName(str)) return roleMatch(subject, str, date) || { level: 'none', reasons: [] };
  const reasons = [];
  let company = false;
  for (const a of subject.anchors.companies.values()) if (a.test(str)) { company = true; reasons.push(`names ${a.value}`); }
  // Handles and domains are looked for outside the person's own name, so the
  // name itself can never supply the second clue.
  let masked = '';
  let from = 0;
  for (const p of subject.hasName.positions(str)) { masked += `${str.slice(from, p.start)} \u2022 `; from = p.end; }
  masked += str.slice(from);
  let other = 0;
  for (const kind of ['schools', 'people', 'handles', 'domains']) {
    const where = kind === 'handles' || kind === 'domains' ? masked : str;
    for (const a of subject.anchors[kind].values()) if (a.test(where)) { other += 1; reasons.push(`names ${a.value}`); }
  }
  if (company) return { level: 'confirmed', reasons: reasons.slice(0, 4) };
  if (other > 0) return { level: 'likely', reasons: reasons.slice(0, 4) };
  return roleMatch(subject, str, date) || { level: 'possible', reasons: ['matched by name only'] };
}

/**
 * A record dated inside one of the subject's CEO tenures that names the company's CEO ("Acme CEO gives back
 * $5.9M") is about them, with or without their name. It is only ever 'likely': the tenure comes from another
 * source, and the text may still mean someone else.
 */
function roleMatch(subject, str, date) {
  if (!date || !subject.anchors.roles) return null;
  // Two capitalised words after the title that are not the subject's name are someone else's name.
  const isOther = (after) => {
    const m = after.match(/^[,\s]+((?:[A-ZÀ-Þ][\p{L}'’-]*\.?\s+){1,2}[A-ZÀ-Þ][\p{L}'’-]+)/u);
    return Boolean(m && !subject.hasName(m[1]));
  };
  for (const a of subject.anchors.roles.values()) {
    if (withinTenure(date, a.from, a.to) && a.test(str, isOther)) {
      return { level: 'likely', reasons: [`names ${a.value}'s CEO while the person held the role`] };
    }
  }
  return null;
}

const LEVEL_RANK = { confirmed: 3, likely: 2, possible: 1, none: 0 };
/** The stronger of two match levels. */
export const strongerMatch = (a, b) => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);
export const matchRank = (level) => LEVEL_RANK[level] || 0;
