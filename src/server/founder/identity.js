/**
 * Who is this record about? Many people share a name, and a background
 * check that pins someone else's lawsuit on a founder is worse than no
 * check. Every finding is therefore graded against what is already known
 * about the subject (their "anchors": companies, schools, co-founders,
 * handles), never by name alone.
 *
 *   confirmed  the full name and a known company of the subject appear close together
 *              (same sentence, or neighbouring sentences), the company named as a company
 *              and not given to someone else in between
 *   likely     the full name and another anchor (school, co-founder, handle) appear,
 *              or a record dated inside the person's CEO tenure names that company's CEO
 *   possible   only the name appears: may be a namesake
 *
 * The matching itself (name forms, company mentions, closeness, how common a
 * name is) lives in names.js and is shared with the quick brief.
 *
 * Anchors grow as the check learns more (a company found in round 1 confirms
 * records in round 2), which is why matching is recomputed, not stored once.
 */
import { nameMatcher, normalizePersonName, companyKeys } from '../founderCheck';
import {
  companyKeyStrict as strictKey, companyMentionMatcher, companyMatchForms, cooccurrences, isCommonName, isBroadOrganisation,
  describedAsSomeoneElse, parsePersonName, isOrdinaryWordCompany, personNameVariants,
} from './names';

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
  return strictKey(name);
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
 * A matcher for an organisation name, as the subject's anchor: test(text) says
 * whether the text names the organisation as an organisation (names.js
 * companyMention: an ordinary word such as Ramp or Flow counts only where it is
 * used as a company; a leftover key such as "of america" never stands alone).
 * `.positions(text)` gives the spans, so a caller can check they are close to
 * the person's name. Fuller legal names and domains learned for this company
 * (addCompanyAlias) count as the company too.
 */
function orgMatcher(org, subject = null) {
  const raw = String(org || '').trim();
  if (raw.length < 2) return null;
  if (!companyMatchForms(raw).length) return null;
  const key = companyKeys(raw)[0] || raw.toLowerCase();
  const aliases = () => {
    const list = subject?.anchors?.aliases;
    return list ? [...list.values()].filter((a) => a.of === key).map((a) => a.value) : [];
  };
  const person = subject ? subject.hasName : null;
  const personWords = subject ? nameTokens(subject.name) : [];
  const mention = companyMentionMatcher(raw, { aliases, person, personWords });
  const test = (text) => mention(text).named;
  test.positions = (text) => mention(text).spans;
  test.mention = mention;
  return test;
}

/**
 * The subject of a check and everything known about them so far.
 * @param {{ name: string, company?: string }} input
 */
export function createSubject({ name, company = '' }) {
  const person = normalizePersonName(name);
  // Search forms: as typed, and given name plus surname without any middle name.
  const variants = personNameVariants(person);
  const subject = {
    name: person,
    variants,
    hasName: nameMatcher(variants),
    slugs: slugCandidates(person),
    company: String(company || '').trim(),
    // A very common full name ("John Smith") needs the company or another anchor beside it in the same record.
    common: isCommonName(person),
    anchors: { companies: new Map(), schools: new Map(), people: new Map(), handles: new Map(), domains: new Map(), roles: new Map(), related: new Map(), events: new Map(), aliases: new Map() },
  };
  // A generational suffix typed with the name ("John Smith Jr.") is kept so "John Smith Sr." is not taken for them.
  const typedSuffix = parsePersonName(String(name || '').replace(/["“”„]/g, '')).suffix;
  if (typedSuffix) subject.hasName = nameMatcher([`${person} ${typedSuffix}`]);
  if (subject.company) addAnchor(subject, 'companies', subject.company, 'given');
  return subject;
}

// An origin of 'encyclopedia' (or 'encyclopedia:<finding id>') marks an organisation or person linked to the
// subject in their own encyclopedia entry (investors, acquirers, co-founders, counterparties).
const isEncyclopedia = (origin) => /^encyclopedia(?::|$)/.test(String(origin || ''));

/**
 * Record something learned about the subject. `origin` says how we know:
 * 'given' (the user typed it) or the finding id that established it.
 * An organisation or person from the subject's encyclopedia entry (origin 'encyclopedia') is kept apart as a
 * 'related' anchor: it counts like a school (full name plus one gives 'likely', never 'confirmed') and is never
 * treated as the subject's own company.
 * Returns true when the anchor is new.
 */
export function addAnchor(subject, kind, value, origin = 'found') {
  const v = String(value || '').trim();
  if (v.length < 2 || !subject.anchors[kind] || kind === 'roles' || kind === 'events' || kind === 'related' || kind === 'aliases') return false;
  const key = kind === 'companies' ? (companyKeys(v)[0] || v.toLowerCase()) : v.toLowerCase();
  if (!key || subject.anchors[kind].has(key)) return false;
  if (isEncyclopedia(origin)) {
    if (kind !== 'companies' && kind !== 'people') return false;
    // A university, a party or a very large employer has thousands of members: being linked to one in an
    // encyclopedia entry says nothing about which namesake a record is about.
    if (kind === 'companies' && isBroadOrganisation(v)) return false;
    if (!subject.anchors.related) subject.anchors.related = new Map();
    const rkey = `${kind}|${key}`;
    if (subject.anchors.related.has(rkey) || subject.hasName(v)) return false;
    const test = kind === 'people' ? nameMatcher([v]) : orgMatcher(v, subject);
    if (!test) return false;
    subject.anchors.related.set(rkey, { value: v, origin, as: kind, test });
    return true;
  }
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

/**
 * Learn a fuller legal name or a domain of one of the subject's companies,
 * from a record tied to them by more than the bare word (for example an SEC
 * Form D naming the person as an officer of "Ramp Business Corp"). From then
 * on the legal name counts as the company: "Ramp Business UK Ltd" and "Ramp
 * Business Corporation" tie, while a bare prefix ("Ramp Network", "Merge
 * Labs") never does.
 *
 * `company` is the company as already known (an existing company anchor, or
 * the company typed); `alias` is the legal name ("Ramp Business Corp") or a
 * domain ("ramp.com"). Refused: an alias that adds nothing (same key), a
 * one-word alias that is an ordinary word, a company not yet an anchor, and a
 * name of the person. Aliases travel with exportAnchors / restoreSubject
 * (kind 'aliases': { value, of, origin }). Returns true when the alias is new.
 */
export function addCompanyAlias(subject, { company, alias, origin = 'found' } = {}) {
  const c = String(company || '').trim();
  const v = String(alias || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
  if (!c || v.length < 3 || isEncyclopedia(origin)) return false;
  const of = companyKeys(c)[0] || c.toLowerCase();
  if (!subject.anchors.companies.has(of)) return false;
  if (!subject.anchors.aliases) subject.anchors.aliases = new Map();
  const isDomain = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(v) && /\.[a-z]{2,}$/i.test(v);
  const value = isDomain ? v.toLowerCase() : String(alias).trim();
  if (!isDomain) {
    const strict = companyKeyStrict(value);
    if (!strict || strict === companyKeyStrict(c)) return false;
    if (!/\s/.test(strict) && isOrdinaryWordCompany(strict)) return false;
    if (subject.hasName(value)) return false;
  }
  const key = isDomain ? value : companyKeyStrict(value);
  if (subject.anchors.aliases.has(key)) return false;
  subject.anchors.aliases.set(key, { value, of, origin });
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
 * CEO" is about them.
 * role 'founder' is accepted only from a caller that has checked the company has exactly one founder and that
 * it is the subject (Wikidata "founded by" listing only them); co-founders share their title. A founder anchor
 * only ever adds to a record that also names the person in full: "Acme founder" alone may mean anyone who
 * claims the title. Returns true when the anchor is new.
 */
export function addRoleAnchor(subject, { org, role = 'ceo', from, to = '', origin = 'found' } = {}) {
  const value = String(org || '').trim();
  const start = isoDay(from);
  const end = isoDay(to);
  if ((role !== 'ceo' && role !== 'founder') || value.length < 2 || !start || (to && !end) || (end && end < start)) return false;
  if (!subject.anchors.roles) subject.anchors.roles = new Map();
  const key = `${companyKeys(value)[0] || value.toLowerCase()}|${start}${role === 'ceo' ? '' : `|${role}`}`;
  if (subject.anchors.roles.has(key)) return false;
  // The registered name and its safe shorter form only: a leftover such as "silicon valley" or "one" never stands
  // for the company.
  const names = [...new Set([value, ...companyMatchForms(value).map((f) => f.form).filter((k) => k.length >= 3)])].map(escapeRe).join('|');
  // "Acme CEO", "Acme's chief executive", but not a predecessor, successor or a shared role ("former Acme CEO",
  // "new Acme CEO", "Acme co-CEO"). A founder: "Acme founder", "Acme's founder", but not "Acme co-founder".
  const title = role === 'ceo' ? 'CEO|chief executive|C\\.E\\.O\\.' : 'founder';
  const re = new RegExp(`(?<![A-Za-z0-9])(${names})(?:['’]s)?\\s+(?:${title})(?![A-Za-z0-9])`, 'gi');
  const otherHolder = /\b(?:former|ex|previous|past|then|interim|acting|incoming|outgoing|new|next|future|founding|co)[\s-]+(?:\S+\s+)?$/i;
  // `isOther(after)` says whether the words after the title name someone else ("Acme CEO John Smith").
  const test = (text, isOther = () => false) => [...String(text || '').matchAll(re)].some((m) => {
    // A one-word name in lowercase is an ordinary word ("the flow CEO"), not the company.
    if (!/\s/.test(m[1]) && m[1] === m[1].toLowerCase()) return false;
    if (otherHolder.test(text.slice(Math.max(0, m.index - 30), m.index))) return false;
    return !isOther(text.slice(m.index + m[0].length));
  });
  subject.anchors.roles.set(key, { value, org: value, role, from: start, to: end, origin, test });
  return true;
}

// The words a later report uses for each kind of event, keyed by the event a record states.
const EVENT_FAMILIES = {
  conviction: /\b(?:convicted|conviction|found guilty|guilty verdict)\b/i,
  sentence: /\b(?:sentenced|sentencing)\b/i,
  pardon: /\bpardon(?:s|ed|ing)?\b/i,
  indictment: /\b(?:indicted|indictment)\b/i,
  charge: /\b(?:charged|charges?\s+(?:against|filed)|(?:criminal|fraud|federal|securities)\s+charges?|(?:SEC|DOJ|prosecutors?)\s+charges?)\b/i,
};
const EVENT_KIND = {
  convicted: 'conviction', conviction: 'conviction', 'found guilty': 'conviction',
  sentenced: 'sentence', sentence: 'sentence',
  pardoned: 'pardon', pardon: 'pardon',
  indicted: 'indictment', indictment: 'indictment',
  charged: 'charge', charge: 'charge', complaint: 'charge', 'sec complaint': 'charge',
};

/**
 * Record an event that a confirmed regulator, court or Wikidata record about the subject states (a conviction,
 * sentence, pardon, indictment or charge, or an SEC complaint) with its date. A later record that names the
 * person in full and reports that kind of event is then 'likely' about them, never 'confirmed'.
 * Returns true when the anchor is new.
 */
export function addEventAnchor(subject, { event, date, origin = 'found', docket = '' } = {}) {
  const kind = EVENT_KIND[String(event || '').trim().toLowerCase()];
  const day = isoDay(date);
  if (!kind || !day) return false;
  if (!subject.anchors.events) subject.anchors.events = new Map();
  const key = `${kind}|${day}`;
  if (subject.anchors.events.has(key)) return false;
  // A docket or case number ties a later record to the same matter whatever its date.
  const dk = String(docket || '').trim();
  const docketRe = dk.length >= 5 ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(dk).replace(/[-:\s]+/g, '[-:\\s]*')}(?![A-Za-z0-9])`, 'i') : null;
  subject.anchors.events.set(key, {
    value: kind, event: kind, date: day, origin, docket: dk,
    test: (text) => EVENT_FAMILIES[kind].test(String(text || '')),
    sameMatter: (text) => Boolean(docketRe && docketRe.test(String(text || ''))),
  });
  return true;
}

// How long after an event a record reporting the same kind of event is taken to report that event (and a little
// before, for records dated by their publisher a day or two early). A namesake's conviction years later is not it.
const EVENT_WINDOW_BEFORE_DAYS = 14;
const EVENT_WINDOW_AFTER_DAYS = 120;
const dayMs = 86400000;
/** Whether a full date (YYYY-MM-DD) falls inside the window around an event day; a year or month alone cannot tell. */
function withinEventWindow(date, eventDay) {
  const d = isoDay(date);
  if (d.length !== 10 || eventDay.length !== 10) return false;
  const diff = (Date.parse(d) - Date.parse(eventDay)) / dayMs;
  return diff >= -EVENT_WINDOW_BEFORE_DAYS && diff <= EVENT_WINDOW_AFTER_DAYS;
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
    out[kind] = [...map.values()].map(({ value, origin, role, from, to, as, date, docket, of }) => (kind === 'roles' ? { value, org: value, role, from, to, origin }
      : kind === 'events' ? { value, event: value, date, origin, ...(docket ? { docket } : {}) }
        : kind === 'related' ? { value, as, origin }
          : kind === 'aliases' ? { value, of, origin } : { value, origin }));
  }
  return out;
}

/** Rebuild a subject from { name, company, anchors } saved by exportAnchors. */
export function restoreSubject({ name, company, anchors = {} }) {
  const subject = createSubject({ name, company });
  // Aliases attach to company anchors, so they are restored after every company.
  const kinds = Object.entries(anchors).sort(([a], [b]) => Number(a === 'aliases') - Number(b === 'aliases'));
  for (const [kind, list] of kinds) {
    for (const a of list || []) {
      if (kind === 'roles') addRoleAnchor(subject, { org: a.org || a.value, role: a.role, from: a.from, to: a.to, origin: a.origin });
      else if (kind === 'events') addEventAnchor(subject, { event: a.event || a.value, date: a.date, origin: a.origin, docket: a.docket });
      else if (kind === 'aliases') {
        const owner = subject.anchors.companies.get(a.of);
        if (owner) addCompanyAlias(subject, { company: owner.value, alias: a.value, origin: a.origin });
      }
      else if (kind === 'related') addAnchor(subject, a.as === 'people' ? 'people' : 'companies', a.value, a.origin);
      else addAnchor(subject, kind, a.value, a.origin);
    }
  }
  return subject;
}

/**
 * Grade a piece of text against the subject.
 *
 * The full name is required. A company anchor confirms only when it is named
 * as a company close to a mention of the name (same sentence, or neighbouring
 * sentences) and is not given to someone else in between. A very common name
 * ("John Smith") needs the company or a school, associate, handle or domain
 * beside it to rise above possible; encyclopedia links and events never raise
 * it. An event anchor counts only for the same matter: a shared docket number,
 * or a record dated within weeks of the event that does not describe someone
 * else ("John Smith, a Utah man").
 *
 * The name written surname first without a comma ("Xiaoming Wang" for Wang
 * Xiaoming) is the name in another order: possible alone, likely with the
 * company beside it, never confirmed. Initials, a nickname, a longer surname or
 * another middle name are not the person's name: 'none', with `weak` saying
 * what was seen.
 *
 * @returns {{ level: 'confirmed'|'likely'|'possible'|'none', reasons: string[], basis?: string[], weak?: string }}
 *   basis: which kinds of anchor carried the grade ('company', 'schools', 'people', 'handles', 'domains',
 *   'related', 'event', 'role', 'reversed-name'), so a caller can decide what to trust; a grade carried only by
 *   'related' or 'event' should not make the record's threads trusted.
 */
export function matchSubject(subject, text, { date } = {}) {
  const str = String(text || '');
  const isSelf = (s) => subject.hasName(s);
  const companyAnchors = [...subject.anchors.companies.values()];
  const pairedCompanies = (names) => {
    const hits = [];
    const far = [];
    for (const a of companyAnchors) {
      const spans = typeof a.test.positions === 'function' ? a.test.positions(str) : (a.test(str) ? [{ start: 0, end: 0 }] : []);
      if (!spans.length) continue;
      if (typeof a.test.positions !== 'function' || cooccurrences(str, names, spans, { isSelf }).length) hits.push(a);
      else far.push(a);
    }
    return { hits, far };
  };
  const names = subject.hasName.positions(str);
  if (!names.length) {
    // The full name is required: a role alone never ties a record to them (lead rule)
    const weak = typeof subject.hasName.weakPositions === 'function' ? subject.hasName.weakPositions(str) : [];
    const reversed = weak.filter((w) => w.kind === 'reversed');
    if (reversed.length) {
      const { hits } = pairedCompanies(reversed);
      if (hits.length) return { level: 'likely', reasons: [`names ${hits[0].value}`, 'the name is written surname first'].slice(0, 4), basis: ['company', 'reversed-name'] };
      return { level: 'possible', reasons: ['matched by name only (written surname first)'], basis: ['reversed-name'] };
    }
    return weak.length ? { level: 'none', reasons: [], weak: weak[0].kind } : { level: 'none', reasons: [] };
  }
  const reasons = [];
  const basis = new Set();
  const { hits, far } = pairedCompanies(names);
  for (const a of hits) reasons.push(`names ${a.value}`);
  const company = hits.length > 0;
  if (company) basis.add('company');
  // Handles and domains are looked for outside the person's own name, so the
  // name itself can never supply the second clue.
  let masked = '';
  let from = 0;
  for (const p of names) { masked += `${str.slice(from, p.start)} \u2022 `; from = p.end; }
  masked += str.slice(from);
  const common = Boolean(subject.common);
  let other = 0;
  for (const kind of ['schools', 'people', 'handles', 'domains', 'related']) {
    // An encyclopedia link never raises a very common name: too many namesakes share such a link.
    if (kind === 'related' && common) continue;
    const where = kind === 'handles' || kind === 'domains' ? masked : str;
    for (const a of (subject.anchors[kind] || new Map()).values()) {
      if (!a.test(where)) continue;
      // For a very common name a school counts only beside the name ("John Smith, a Stanford graduate").
      if (common && kind === 'schools' && typeof a.test.positions === 'function' && !cooccurrences(str, names, a.test.positions(str), { isSelf }).length) continue;
      other += 1;
      basis.add(kind);
      reasons.push(`names ${a.value}`);
    }
  }
  // An event a confirmed record states: the same matter (a shared docket number), or a record dated within weeks
  // of the event that does not describe someone else. Never for a very common name.
  if (!common) {
    for (const a of (subject.anchors.events || new Map()).values()) {
      if (!a.test(str)) continue;
      const same = typeof a.sameMatter === 'function' && a.sameMatter(str);
      const near = withinEventWindow(date, a.date) && !names.some((nm) => describedAsSomeoneElse(str, nm));
      if (same || near) { other += 1; basis.add('event'); reasons.push(`names ${a.event} reported in ${a.origin}`); }
    }
  }
  if (!company && far.length) reasons.push(`names ${far[0].value}, but not beside the person's name`);
  if (company) return { level: 'confirmed', reasons: reasons.slice(0, 4), basis: [...basis] };
  if (other > 0) return { level: 'likely', reasons: reasons.slice(0, 4), basis: [...basis] };
  const role = roleMatch(subject, str, date, true);
  if (role) return { ...role, basis: ['role'] };
  return { level: 'possible', reasons: ['matched by name only', ...reasons].slice(0, 4) };
}

/**
 * A record dated inside one of the subject's CEO tenures that names the company's CEO ("Acme CEO gives back
 * $5.9M") is about them, with or without their name. A record dated on or after the founding of a company
 * whose only founder is the subject, that names its founder, is about them only when it also names them in
 * full (`named`). It is only ever 'likely': the role comes from another source, and the text may still mean
 * someone else.
 */
function roleMatch(subject, str, date, named = false) {
  if (!date || !subject.anchors.roles) return null;
  // Two capitalised words after the title that are not the subject's name are someone else's name.
  const isOther = (after) => {
    const m = after.match(/^[,\s]+((?:[A-ZÀ-Þ][\p{L}'’-]*\.?\s+){1,2}[A-ZÀ-Þ][\p{L}'’-]+)/u);
    return Boolean(m && !subject.hasName(m[1]));
  };
  for (const a of subject.anchors.roles.values()) {
    if (a.role === 'founder' && !named) continue;
    if (withinTenure(date, a.from, a.to) && a.test(str, isOther)) {
      return { level: 'likely', reasons: [a.role === 'founder' ? `names ${a.value}'s founder, a role only the person held` : `names ${a.value}'s CEO while the person held the role`] };
    }
  }
  return null;
}

const LEVEL_RANK = { confirmed: 3, likely: 2, possible: 1, none: 0 };
/** The stronger of two match levels. */
export const strongerMatch = (a, b) => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);
export const matchRank = (level) => LEVEL_RANK[level] || 0;
