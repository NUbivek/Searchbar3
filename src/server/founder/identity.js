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
  const neutral = (w) => { const k = wordKey(w); return LEGAL_FORMS.has(k) || ROLE_WORDS.has(k) || ownWords.has(k) || personWords.has(nameTokens(w)[0]); };
  // The word right before a span, only when nothing but spaces separates them.
  const wordBefore = (str, at) => {
    const m = str.slice(0, at).match(/(\S+)[ \t]+$/);
    if (!m || /[,;:)\]}.!?"”—–|]$/.test(m[1])) return null;
    return { word: m[1], at: m.index };
  };
  const sentenceStart = (str, at) => /(^|[.!?]\s+|\n\s*)$/.test(str.slice(0, at));
  // Title Case or capitals around the span: almost no long word is lowercase.
  const headline = (str, start, end) => {
    const near = `${str.slice(Math.max(0, start - 80), start)} ${str.slice(end, end + 80)}`;
    const long = near.match(/[A-Za-zÀ-ɏ]{5,}/g) || [];
    return long.length >= 3 && long.filter((w) => w === w.toLowerCase()).length / long.length < 0.2;
  };
  const insideLongerName = (str, start, end) => {
    const prev = wordBefore(str, start);
    if (!prev) return false;
    if (/['’]s$/i.test(prev.word)) return false; // "Neumann's Flow"
    if (NAME_JOINERS.has(wordKey(prev.word)) || prev.word === '&') {
      const head = wordBefore(str, prev.at);
      return Boolean(head && startsCapital(head.word) && !neutral(head.word));
    }
    if (!startsCapital(prev.word) || neutral(prev.word)) return false;
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
  return { level: 'possible', reasons: ['matched by name only'] };
}

const LEVEL_RANK = { confirmed: 3, likely: 2, possible: 1, none: 0 };
/** The stronger of two match levels. */
export const strongerMatch = (a, b) => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);
export const matchRank = (level) => LEVEL_RANK[level] || 0;
