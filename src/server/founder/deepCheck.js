/**
 * The deep background check: a loop that keeps pulling threads.
 *
 *   step 0   every source is asked about the person (and their company)
 *   then     each record is graded for identity, cleaned by the privacy
 *            rules and read for new threads: a former company, a school, a
 *            co-founder, a relative in a public role, a handle, a domain, an
 *            old profile page
 *   next     every new thread is pulled in turn, by the sources that can
 *            handle that kind of thread, and what they return is read for
 *            more threads
 *   stop     when a round finds nothing new, or the budget is spent
 *
 * It learns as it goes. Within a check, a company confirmed in one round
 * upgrades the records that mention it in the next (identity.js), and when
 * the loop runs dry a second reader (gaps.js) goes over the records for
 * threads the first pass missed. Across checks, each query pattern and
 * source is scored by whether it produced evidence, and the best-scoring
 * ones run first (learning.js).
 *
 * The whole state is plain JSON, so a check can run one request at a time
 * (jobStore.js): start() -> step() ... step() until phase is 'report'.
 * No network here: sources are passed in, which is also how tests run it.
 */
import { createSubject, restoreSubject, exportAnchors, addAnchor, addCompanyAlias, companyKeyStrict, matchSubject, matchRank, personKey } from './identity';
import * as identityApi from './identity';
import { connectorResult, THREAD_KINDS } from './finding';
import { companyKeys, normalizePersonName } from '../founderCheck';
import { loadStats, recordStats, rankByLearning } from '../learning';
import * as companyFactsApi from './companyFacts';
// Only its helper that lifts held register records once a legal name is known (no lookups run from here).
import * as registriesApi from './sources/registries';

export const LIMITS = {
  maxTasks: 420, // lookups per check, across all sources (a few minutes of work)
  maxDepth: 2, // the person is depth 0; what is found about them is 1; what those lead to is 2
  maxFindings: 700,
  maxPerSource: 90,
  maxSteps: 18,
  dryStepsToStop: 2,
  maxReviews: 2, // how many times the second reader may restart a loop that ran dry
  stepMs: 40000,
  concurrency: 8,
  taskTimeoutMs: 20000,
  restMs: 20000, // how long a lookup waits when its host is resting and does not say until when
  maxRests: 4, // how many times one lookup may be put back for a resting host
  // A host or the search engines may say when they are free again (an allowance per ten minutes, a pause
  // after "slow down"). Lookups then wait for that time, but a check does not wait forever: past this age
  // the lookups still waiting are reported as not run, never as sources that failed.
  maxWaitAgeMs: 12 * 60 * 1000,
  // When only waiting lookups are left, the longest the check sits idle for the next one
  tailWaitMs: 90 * 1000,
  // how many threads of each kind are pulled; the rest are listed, not followed
  // url: pages the page reader opens (one request each, at most MAX_PAGES in pages.js) and profiles the web archive reads
  pull: { company: 10, affiliate: 16, school: 6, associate: 10, relative: 8, handle: 6, domain: 6, url: 18, alias: 4 },
};

export const GAP_TEMPLATE = 'q.gap';
const GIVEN_COMPANY = 'the company given';
const ASSUMED_COMPANY = 'the company assumed from your network';
const EARLIER_COMPANY_GIVEN = 'an earlier company given';

/**
 * Watchlist, court and regulator screens. They run early whatever learning says (a clean screen is the
 * normal answer, so learning would otherwise push them to the back), they are never dropped when the
 * check stops for being dry or at its round limit, and one that could not run is recorded as not run.
 */
export const SCREEN_SOURCES = new Set([
  'sanctions-lists', 'us-exclusions', 'offshore-leaks', 'wanted-lists', 'mdb-debarment', 'us-bank-regulators', 'fincen-actions',
  'court-dockets', 'court-records-open', 'doj-press-releases', 'us-enforcement-actions', 'uk-case-law', 'uk-gazette',
  'canada-federal-courts', 'delaware-courts', 'eu-courts', 'us-agency-orders', 'finra-brokercheck', 'fr-bodacc',
]);
/** The screens that say whether a person is on a list: the ones a related party is screened against. */
export const WATCHLIST_SOURCES = new Set(['sanctions-lists', 'us-exclusions', 'offshore-leaks', 'wanted-lists', 'mdb-debarment', 'us-bank-regulators', 'fincen-actions']);
/** Sources asked again under a company's legal name once one is learned (design decision 1). */
export const LEGAL_NAME_SOURCES = new Set(['us-state-registries', 'uk-companies-house', 'fr-companies', 'lei-register', 'sec-company', 'trademarks', 'us-lobbying', 'cfpb-complaints', 'us-federal-awards', 'nih-grants', 'leak-sites', 'breach-catalogue', 'breach-registers']);
/**
 * Court and enforcement sources asked about a company again once another of its names is known. They search
 * every known name of the company when they run (design decision 1), so the company's own lookup is run once
 * more, marked with the name that prompted it, rather than a lookup under the new name alone.
 */
export const ALIAS_COURT_SOURCES = new Set(['court-dockets', 'court-records-open', 'doj-press-releases', 'uk-gazette', 'uk-case-law', 'fr-bodacc', 'us-enforcement-actions', 'delaware-courts', 'us-agency-orders', 'eu-courts', 'canada-federal-courts']);
// Screens may run past the lookup budget by this share of it, so the last companies found still get them.
const SCREEN_RESERVE = 0.15;
// Rounds past the round limit in which only screens still queued may run.
const SCREEN_EXTRA_STEPS = 6;

/** A screen lookup: the person, a company they founded or run (or an earlier venture), or a related party on a watchlist. */
export const isScreenTask = (t) => Boolean(t) && SCREEN_SOURCES.has(t.connector) && t.template !== GAP_TEMPLATE && (
  t.kind === 'subject' || t.kind === 'alias'
  || (t.kind === 'company' && (t.tie !== 'affiliate' || Boolean(t.venture)))
  || ((t.kind === 'associate' || t.kind === 'relative') && WATCHLIST_SOURCES.has(t.connector)));

// ---------------------------------------------------------------- anchor strength
// Where an anchor came from decides what it may do:
//   'given' (typed by the user), 'found' and 'found:<finding id>' (a record graded confirmed)  may confirm
//   'weak:<finding id>' (a record graded likely), 'inferred' (no company given; the one most sources name),
//   'network' (the one contact with this name)                       may make a record likely, never confirmed
//   'reader' (proposed by the second reader)                         never raises a record on its own
// A record is never re-graded on an anchor it produced itself.
const STRONG_ORIGIN = /^(?:given|found)(?::|$)/;
const ASSUMED_ORIGIN = /^(?:inferred|network)$/;
const READER_ORIGIN = /^reader(?::|$)/;
export const isStrongOrigin = (origin) => STRONG_ORIGIN.test(String(origin || ''));
const originId = (origin) => (/^(?:found|weak|reader):(.+)$/.exec(String(origin || '')) || [])[1] || null;
// A likely grade carried only by these never makes a record's threads trusted (identity.js basis).
const WEAK_BASIS = new Set(['related', 'event', 'reversed-name']);

/** The subject seen through only the anchors `keep(kind, anchor)` accepts (a cheap copy of the maps). */
function viewOf(subject, keep) {
  const anchors = {};
  for (const [kind, map] of Object.entries(subject.anchors)) {
    anchors[kind] = kind === 'roles' || kind === 'events' || !map ? map : new Map([...map].filter(([, a]) => keep(kind, a)));
  }
  return { ...subject, anchors };
}
/** What the subject's anchors hold that may need a second look, or null when every anchor may do anything. */
function anchorNeeds(subject, selfId) {
  let weakCompany = false;
  let reader = false;
  let self = false;
  for (const [kind, map] of Object.entries(subject.anchors)) {
    if (kind === 'roles' || kind === 'events' || !map) continue;
    for (const a of map.values()) {
      if (kind === 'aliases') { if (selfId && originId(a.origin) === selfId) self = true; continue; }
      if (kind === 'companies' && !isStrongOrigin(a.origin)) weakCompany = true;
      if (READER_ORIGIN.test(String(a.origin || ''))) reader = true;
      if (selfId && originId(a.origin) === selfId) self = true;
    }
  }
  return weakCompany || reader || self ? { weakCompany, reader, self } : null;
}
const KIND_WEIGHT = { subject: 1, alias: 0.9, url: 0.85, company: 0.8, relative: 0.72, associate: 0.62, school: 0.58, handle: 0.5, domain: 0.45 };
const DEPTH_WEIGHT = [1, 0.8, 0.55];
const ANCHOR_KIND = { company: 'companies', school: 'schools', associate: 'people', handle: 'handles', domain: 'domains' };

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// "Theranos" and "Theranos, Inc." are one company
const threadKey = (t) => `${t.kind}|${t.kind === 'company' ? (companyKeys(t.value)[0] || norm(t.value)) : t.kind === 'associate' || t.kind === 'relative' || t.kind === 'alias' ? personKey(t.value) : norm(t.value)}`;

// Headlines are a poor place to read company names from: "Ousted Theranos", "Why Theranos", "SEC Charges
// Theranos" and "U.S" are not companies, and each one followed costs dozens of lookups.
const HEADLINE_LEAD = /^(why|how|what|when|where|who|inside|ousted|disgraced|former|ex|demise|rise|fall|collapse|conversation|interview|meet|watch|read|sec|doj|fbi|feds|exclusive|opinion|is|was|did|does|will|can|boyfriend|girlfriend|husband|wife|fianc[ée]e?|father|mother|brother|sister|son|daughter|ceo|judge|attorney|lawyer|prosecutors?|defendant|billionaire|convicted|jailed|fraudster)\b/i;
const NOT_AN_ORGANISATION = /^(us|usa|uk|eu|un|united states|united kingdom|america|europe|government|congress|senate|police|court|state|city|county|inc|llc|ltd|company|the company|startup)$/i;
const containsWords = (longer, shorter) => longer !== shorter && ` ${longer} `.includes(` ${shorter} `);
// A job title read as an organisation ("Co-Founder", "Solutions Architect Lead"): every word is a title word or a
// word that only qualifies one, and at least one is a title word.
const TITLE_WORD = new Set(['ceo', 'cto', 'coo', 'cfo', 'cmo', 'cpo', 'cso', 'cio', 'chief', 'founder', 'cofounder', 'co-founder', 'founding', 'president', 'chair', 'chairman', 'chairwoman', 'chairperson', 'officer', 'director', 'vp', 'svp', 'evp', 'head', 'partner', 'principal', 'engineer', 'scientist', 'professor', 'manager', 'lead', 'leader', 'adviser', 'advisor', 'investor', 'analyst', 'associate', 'counsel', 'attorney', 'architect', 'designer', 'developer', 'researcher', 'fellow', 'owner', 'executive', 'secretary', 'treasurer', 'editor', 'consultant', 'entrepreneur', 'intern', 'student', 'lecturer', 'boss', 'member', 'board']);
const TITLE_QUALIFIER = new Set(['co', 'vice', 'senior', 'sr', 'junior', 'jr', 'staff', 'assistant', 'deputy', 'interim', 'acting', 'managing', 'general', 'executive', 'technical', 'solutions', 'product', 'software', 'of', 'and', 'the', '&']);
const looksLikeTitleOnly = (value) => {
  const words = String(value || '').toLowerCase().replace(/[,;:/|()]+/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.some((w) => TITLE_WORD.has(w)) && words.every((w) => TITLE_WORD.has(w) || TITLE_QUALIFIER.has(w));
};
// An address is not an organisation name ("https://x.com/acme", "www.acme.io", "acme.com")
const LOOKS_LIKE_HOST = /^(https?:|www\.)|\b[a-z0-9-]+\.(com|net|org|io|co|ai|app|dev|me|fr|uk|de)\b/i;
const KEY_STOPWORDS = new Set(['we', 'the', 'co', 'us', 'a', 'an', 'it', 'our', 'my', 'and', 'of', 'in', 'on', 'at', 'to', 'for']);

/**
 * Is this organisation thread worth recording? Returns:
 *   'junk'      not an organisation name at all
 *   an existing thread   it is a longer or shorter way of naming one already recorded
 *   null        a new organisation
 */
function sameOrganisation(state, thread) {
  const raw = String(thread.value || '').replace(/\./g, '').trim();
  if (raw.length < 3 || NOT_AN_ORGANISATION.test(raw)) return 'junk';
  // "Ousted Theranos", and equally a lone "Disgraced" or "Convicted" lifted from a headline
  if (thread.kind === 'company' && HEADLINE_LEAD.test(raw) && (/\s/.test(raw) || HEADLINE_LEAD.exec(raw)[0].length === raw.length)) return 'junk';
  const key = threadKey(thread).slice(thread.kind.length + 1);
  if (!key) return 'junk';
  // The company the user gave is followed whatever it is called; anything read from a record must look like a name.
  if (thread.why !== GIVEN_COMPANY && thread.why !== ASSUMED_COMPANY && thread.why !== EARLIER_COMPANY_GIVEN) {
    if (looksLikeTitleOnly(thread.value)) return 'junk';
    if (LOOKS_LIKE_HOST.test(String(thread.value || '').trim())) return 'junk';
    // "We Co." keys to "we": too short or too common a word to tell one organisation from another
    if (key.length <= 2 || key.split(' ').every((w) => KEY_STOPWORDS.has(w))) return 'junk';
  }
  for (const [otherKey, other] of Object.entries(state.threads)) {
    if (other.kind !== thread.kind) continue;
    const k = otherKey.slice(other.kind.length + 1);
    // "Conversation With Theranos" is Theranos; "The School of Engineering at Stanford University" is Stanford University
    // A longer trusted name is never folded into a shorter untrusted one: a trusted "Meta Materials" must not
    // turn a namesake's "Meta" into an anchor. It is recorded as its own organisation instead.
    if (k.length >= 4 && containsWords(key, k) && (other.trusted || !thread.trusted)) return other;
    if (k.length >= 4 && other.trusted && containsWords(k, key) && key.length >= 4) return other;
  }
  return null;
}
// A free-form search (proposed by the second reader) is told apart by its wording
// The same page reported twice is one record; a register page that lists several records is several.
// A forum's copy of a story ("Hacker News (120 points, 40 comments): <headline>") is the story.
const headline = (title) => norm(title).replace(/^hacker news \(\d+ points?[^)]*\):\s*/, '').replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, '').slice(0, 70);
// The address of a Wikipedia article, whatever the language edition's mobile host or the section anchor
const wikiArticle = (u) => {
  const m = /^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i.exec(String(u || ''));
  if (!m) return null;
  let title = m[2];
  try { title = decodeURIComponent(title); } catch { /* keep as given */ }
  return `${m[1].toLowerCase()}.wikipedia.org/wiki/${title.replace(/ /g, '_').toLowerCase()}`;
};
const WP_SOURCE = 'wikipedia';
// A Wayback summary of one page ("archived 40 times between ...") is one record whatever its counts say
const isArchiveSummary = (f) => f.category === 'archive' && /web\.archive\.org\/web\/\*\//i.test(String(f.url || ''));
/**
 * The page a record is: address and headline, whichever section a source filed it under. Archive snapshots
 * are kept apart by category and title (several records per replay).
 */
const pageKey = (f) => {
  if (isArchiveSummary(f)) return `archive|${urlKey(f.url)}`;
  if (f.category === 'archive') return `${f.category}|${urlKey(f.url)}|${headline(f.title)}`;
  return `${urlKey(f.url)}|${headline(f.title)}`;
};
// Another source's copy of a Wikipedia article the Wikipedia source holds is the article (the copy quotes
// whatever the search engine cut, reference lists included): it is dropped, or replaced when the article
// comes second. The Wikipedia source's own records (one per section) are kept as they are.
const wikiAlias = (f) => {
  const article = f.source === WP_SOURCE && wikiArticle(f.url);
  return article ? `wiki|${article}` : null;
};
const wikiCopyOf = (f) => {
  const article = f.source !== WP_SOURCE && wikiArticle(f.url);
  return article ? `wiki|${article}` : null;
};
// A lookup made while a company was only an affiliate is made again in full once it is promoted to primary.
const taskKey = (t) => `${t.connector}|${t.kind}|${t.kind === 'company' ? (companyKeys(t.value)[0] || norm(t.value)) : norm(t.value)}|${t.template || ''}${t.template === GAP_TEMPLATE ? `|${norm(t.params?.query)}` : ''}${t.tie === 'affiliate' ? '|affiliate' : ''}${t.asAlias ? `|aka:${norm(t.asAlias)}` : ''}`;
// Two quotes are the same passage when their words agree; short quotes ("Director") say too little to merge on.
// Archive snapshots of one page are kept apart on purpose (they show how the page changed).
function quoteKey(f) {
  if (!f?.quote || f.category === 'archive') return null;
  const words = String(f.quote).toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, ' ').trim();
  if (words.length < 60) return null;
  // one source family: sec-filings and sec-company are both "sec"
  return `${String(f.source || '').split('-')[0]}|${f.category}|${words}`;
}
// The same record read again with a stronger tie (a page reached from a linked profile rather than a guessed
// address) lifts the copy already kept: whichever source finished first must not decide the grade. A grade
// a source set by hand, or a record about the company rather than the person, is left as it is.
function upgradeKept(kept, f) {
  if (!kept || kept === f || kept.matchFixed || kept.match === 'company') return false;
  if (matchRank(f.match) <= matchRank(kept.match)) return false;
  kept.match = f.match;
  kept.matchReasons = f.matchReasons;
  if (f.matchFixed) kept.matchFixed = true;
  if (f.gradeText) kept.gradeText = f.gradeText;
  if (f.data?.linkedFrom) kept.data = { ...(kept.data || {}), linkedFrom: f.data.linkedFrom };
  return true;
}
// A record found again by a lookup about an associate or relative names that person too (a joint query): the
// kept copy lists them, so the report can file it under them as well.
function tagPerson(kept, task) {
  if (!kept || (task.kind !== 'associate' && task.kind !== 'relative')) return;
  const persons = Array.isArray(kept.data?.persons) ? kept.data.persons : [];
  if (persons.some((p) => personKey(p) === personKey(task.value)) || persons.length >= 12) return;
  kept.data = { ...(kept.data || {}), persons: [...persons, task.value] };
}
const learnKey = (t) => `${t.connector}${t.template ? `:${t.template}` : ''}`;
// Two records are the same page when host, path, query and fragment agree. The query and fragment matter:
// a forum thread is "item?id=N", a register row is a query, and one long page can hold several records at
// different anchors. Only tracking parameters are ignored.
const TRACKING = /^(utm_\w+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid|igshid|share|source|cmpid|ocid|taid)$/i;
// A profile host's country or mobile edition is the same profile (fr.linkedin.com/in/x is linkedin.com/in/x)
const PROFILE_EDITION = /^(?:[a-z]{2}|www|m)\.(linkedin\.com|facebook\.com)$/;
function urlKey(u) {
  try {
    const url = new URL(String(u || ''));
    const query = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(PROFILE_EDITION, '$1');
    return `${host}${url.pathname.replace(/\/$/, '')}${query ? `?${query}` : ''}${url.hash || ''}`.toLowerCase();
  } catch {
    return String(u || '').toLowerCase();
  }
}

/**
 * What the person reading the report is told when a source failed: a plain reason, never the technical
 * message (status codes, library errors, or text echoed from the remote page). The raw message goes to
 * the server log only.
 */
export function plainFailure(message, error = null) {
  const m = String(message || '');
  // A host that answers only automated readers that declare a contact (the SEC's website), with none declared here
  if (error?.code === 'not-declared') return 'asks for a declared contact before it answers';
  if (/timed out|out of time/i.test(m)) return 'did not respond in time';
  if (/rate limited|\b429\b|slower requests/i.test(m)) return 'was busy and turned the request away';
  if (/not json|larger than/i.test(m)) return 'returned something that could not be read';
  return 'could not be reached';
}
// The host is resting, or this lookup's turn at a paced host could not come before the deadline: not a failure.
/**
 * The kind of failure, for diagnosis: an HTTP status, a timeout, a DNS or TLS failure, a connection failure,
 * or a host that turned automated requests away. Never the message itself (it can echo the remote page).
 */
export function failureClass(error) {
  const m = String(error?.message || error || '');
  const status = Number(error?.status || error?.statusCode) || Number((/\b(?:HTTP|status)[\s:]*([1-5]\d\d)\b/i.exec(m) || [])[1]) || 0;
  if (/captcha|abusive|bot traffic|automated (?:requests|queries)|access denied|blocked|forbidden/i.test(m) || status === 403) return status ? `blocked by host (HTTP ${status})` : 'blocked by host';
  if (/timed out|timeout|ETIMEDOUT|out of time|aborted/i.test(m)) return 'timeout';
  if (status) return `HTTP ${status}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|\bDNS\b/i.test(m)) return 'DNS';
  if (/certificate|\bTLS\b|\bSSL\b|CERT_|self[- ]signed/i.test(m)) return 'TLS';
  if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed|network/i.test(m)) return 'connection';
  if (/not json|larger than|unexpected token/i.test(m)) return 'unreadable answer';
  return 'other';
}
const HOST_RESTING = /Out of time before the request could start|is being left alone/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), Math.max(500, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- what the user typed
// Control, zero-width and bidi characters (Unicode Cc and Cf) are never part of a name: they hide or reorder
// what the History list shows, and break the search queries built from it.
const CONTROL = /\p{Cc}/gu;
const INVISIBLE = /\p{Cf}/gu;
/** Text as typed, made safe to search with: compatibility forms folded, invisible characters removed, spaces collapsed. */
export function cleanInputText(raw) {
  return String(raw ?? '').normalize('NFKC').replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}
// Letters and marks of any script, spaces, hyphens, apostrophes, full stops and commas ("Glyman, Eric").
const NAME_CHARS = /^[\p{L}\p{M} '’.,-]+$/u;
// Scripts in which a full name is written without spaces (张一鸣, 山田太郎, 김민준).
const UNSPACED_NAME = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{M}·・]+$/u;
const lettersIn = (token) => String(token || '').replace(/[^\p{L}]/gu, '').length;
export const MAX_NAME_LENGTH = 120;

/**
 * Check a person's name as typed. Returns { ok: true, name, mononym } or { ok: false, error } with a plain
 * reason. Any script is accepted. A name needs two words, except a name written in a script without spaces,
 * or a one-word name when a company is given (graded more strictly, since only the company can tell it
 * apart). Names made only of initials, and anything that is not a name (an address, an email, digits,
 * search operators), are refused.
 */
export function validatePersonName(raw, { company = '' } = {}) {
  const typed = cleanInputText(raw).replace(/^["“”„'‘]+|["“”„'’]+$/g, '').trim();
  if (!typed) return { ok: false, error: 'Enter the name of the person to check.' };
  if (typed.length > MAX_NAME_LENGTH) return { ok: false, error: `The name is too long: use at most ${MAX_NAME_LENGTH} characters.` };
  if (typed.includes('@')) return { ok: false, error: 'Enter a name, not an email address.' };
  if (/https?:|www\.|\/|\.[a-z]{2,}\b\/?$/i.test(typed)) return { ok: false, error: 'Enter a name, not a web address. A profile address has a field of its own.' };
  if (/\p{N}/u.test(typed)) return { ok: false, error: 'A name cannot contain digits.' };
  if (/[:"*+]|\b(?:site|inurl|intitle)\b|(?:^|\s)[-+'](?=\S)|\s(?:OR|AND|NOT)\s/.test(typed)) return { ok: false, error: 'Enter the name only, without search operators.' };
  if (!NAME_CHARS.test(typed)) return { ok: false, error: 'The name contains characters names do not use. Use letters, spaces, hyphens, apostrophes and full stops.' };
  const name = normalizePersonName(typed);
  const tokens = name.split(/\s+/).filter(Boolean);
  if (!tokens.length || !lettersIn(name)) return { ok: false, error: 'Enter the name of the person to check.' };
  if (tokens.length === 1) {
    if (UNSPACED_NAME.test(name) && lettersIn(name) >= 2) return { ok: true, name, mononym: false };
    if (String(company || '').trim()) return { ok: true, name, mononym: true };
    return { ok: false, error: 'Enter the full name (first and last name). For someone known by one name only, add their company too.' };
  }
  // "Malcolm X" is a name; "J S" or "J. R." is not: initials alone match too many people.
  if (!tokens.some((t) => lettersIn(t) >= 2)) return { ok: false, error: 'Enter the name in full: initials alone match too many people.' };
  return { ok: true, name, mononym: false };
}

/** A company, school or other organisation name as typed: search operators removed, length checked. */
export function validateOrgName(raw, { what = 'company' } = {}) {
  let s = cleanInputText(raw);
  if (!s) return { ok: true, value: '' };
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(s)) return { ok: false, error: `Enter the ${what} name, not an email address.` };
  // site:x.com, inurl:..., a leading minus or plus, OR / AND / NOT, quotes and wildcards change every query built from it
  s = s.replace(/\b(?:site|inurl|intitle|intext|filetype|related|cache):\S*/gi, ' ')
    .replace(/(^|\s)[-+](?=\S)/g, '$1')
    .replace(/\s(?:OR|AND|NOT)(?=\s)/g, ' ')
    .replace(/["“”*~|]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, error: `Enter the ${what} name.` };
  if (s.length > MAX_NAME_LENGTH) return { ok: false, error: `The ${what} name is too long: use at most ${MAX_NAME_LENGTH} characters.` };
  return { ok: true, value: s };
}

// Hosts of profiles and networks: a "website" there is a profile, not the company's own site.
const PROFILE_HOSTS = /(?:^|\.)(linkedin\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|github\.com|gitlab\.com|crunchbase\.com|angel\.co|wellfound\.com|medium\.com|substack\.com|bsky\.app|youtube\.com|tiktok\.com|threads\.net|about\.me|mastodon\.social)$/i;
function parseAddress(raw) {
  const s = cleanInputText(raw);
  if (!s) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    // a real public name: letters, a dot and a top-level domain; never a bare address or a local name
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host) || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) return false;
    return { url, host };
  } catch {
    return false;
  }
}

/** The company's website as a domain ("ramp.com"), or an error. */
export function validateWebsite(raw) {
  const parsed = parseAddress(raw);
  if (parsed === null) return { ok: true, value: '' };
  if (!parsed) return { ok: false, error: 'The company website could not be read. Enter an address such as example.com.' };
  if (PROFILE_HOSTS.test(parsed.host)) return { ok: false, error: 'Enter the company’s own website. A profile address has a field of its own.' };
  return { ok: true, value: parsed.host };
}

// The handle in a profile address, per site. LinkedIn is never opened: its handle only ties records to the person.
const PROFILE_PATTERNS = [
  [/(?:^|\.)linkedin\.com$/i, /^\/(?:in|pub)\/([^/?#]+)/i, 'linkedin'],
  [/(?:^|\.)github\.com$/i, /^\/([A-Za-z0-9-]{1,39})\/?$/, 'github'],
  [/(?:^|\.)(?:x|twitter)\.com$/i, /^\/@?([A-Za-z0-9_]{1,15})\/?$/, 'x'],
  [/(?:^|\.)crunchbase\.com$/i, /^\/person\/([^/?#]+)/i, 'crunchbase'],
  [/(?:^|\.)(?:angel\.co|wellfound\.com)$/i, /^\/(?:u\/)?([^/?#]+)/i, 'wellfound'],
  [/(?:^|\.)medium\.com$/i, /^\/@([^/?#]+)/i, 'medium'],
  [/(?:^|\.)bsky\.app$/i, /^\/profile\/([^/?#]+)/i, 'bluesky'],
];
/** A profile address as { platform, handle, url }; a personal site gives { platform: 'site', domain }. */
export function validateProfileUrl(raw) {
  const parsed = parseAddress(raw);
  if (parsed === null) return { ok: true, value: null };
  if (!parsed) return { ok: false, error: 'The profile address could not be read. Paste the whole address, for example https://www.linkedin.com/in/their-name.' };
  const { url, host } = parsed;
  const sub = /^([a-z0-9-]+)\.substack\.com$/i.exec(host);
  if (sub) return { ok: true, value: { platform: 'substack', handle: sub[1].toLowerCase(), url: url.href } };
  for (const [hostRe, pathRe, platform] of PROFILE_PATTERNS) {
    if (!hostRe.test(host)) continue;
    const m = pathRe.exec(url.pathname);
    let handle = m ? m[1] : '';
    try { handle = decodeURIComponent(handle); } catch { /* keep as written */ }
    handle = handle.replace(/^@/, '').trim();
    if (!handle || handle.length < 2 || /^(?:in|pub|company|school|home|search|share|intent|explore|settings)$/i.test(handle)) {
      return { ok: false, error: 'That address is not a person’s profile. Paste the address of their own profile page.' };
    }
    return { ok: true, value: { platform, handle, url: `https://${host}${url.pathname}`.replace(/\/$/, '') } };
  }
  if (PROFILE_HOSTS.test(host)) return { ok: false, error: 'That address is not a person’s profile. Paste the address of their own profile page.' };
  return { ok: true, value: { platform: 'site', domain: host, url: url.href } };
}

/** A city or country: words only (never a street address). */
export function validatePlace(raw) {
  const s = cleanInputText(raw);
  if (!s) return { ok: true, value: '' };
  if (s.length > 80) return { ok: false, error: 'Enter a city or country only (at most 80 characters).' };
  if (/\p{N}/u.test(s)) return { ok: false, error: 'Enter a city or country, not a street address.' };
  if (!/^[\p{L}\p{M} '’.,()-]+$/u.test(s)) return { ok: false, error: 'Enter a city or country only.' };
  return { ok: true, value: s };
}

const listOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[;\n]|,(?=\s*\S)/) : []);

/**
 * Everything the start form may send, checked: { name, company, website, profileUrl, place,
 * otherCompanies: [], school, otherNames: [] }. Only the name is required.
 * Returns { ok: true, value } or { ok: false, error, field }.
 */
export function validateCheckInput(body = {}) {
  const company = validateOrgName(body.company);
  if (!company.ok) return { ...company, field: 'company' };
  const person = validatePersonName(body.name, { company: company.value });
  if (!person.ok) return { ...person, field: 'name' };
  const website = validateWebsite(body.website);
  if (!website.ok) return { ...website, field: 'website' };
  const profile = validateProfileUrl(body.profileUrl);
  if (!profile.ok) return { ...profile, field: 'profileUrl' };
  const place = validatePlace(body.place);
  if (!place.ok) return { ...place, field: 'place' };
  const school = validateOrgName(body.school, { what: 'school' });
  if (!school.ok) return { ...school, field: 'school' };
  const otherCompanies = [];
  for (const raw of listOf(body.otherCompanies).slice(0, 8)) {
    const c = validateOrgName(raw);
    if (!c.ok) return { ...c, field: 'otherCompanies' };
    if (c.value && !otherCompanies.some((x) => x.toLowerCase() === c.value.toLowerCase()) && c.value.toLowerCase() !== company.value.toLowerCase()) otherCompanies.push(c.value);
  }
  if (otherCompanies.length > 5) return { ok: false, error: 'Enter at most five earlier companies.', field: 'otherCompanies' };
  const otherNames = [];
  const given = person.name.split(/\s+/)[0];
  for (const raw of listOf(body.otherNames).slice(0, 4)) {
    const typed = cleanInputText(raw);
    if (!typed) continue;
    // A former surname alone ("Jones") is read with the person's given name ("Jane Jones").
    const full = !/\s/.test(typed) && !UNSPACED_NAME.test(typed) && !person.mononym ? `${given} ${typed}` : typed;
    const n = validatePersonName(full, { company: company.value });
    if (!n.ok) return { ok: false, error: `Other name: ${n.error}`, field: 'otherNames' };
    if (n.name.toLowerCase() !== person.name.toLowerCase() && !otherNames.some((x) => x.toLowerCase() === n.name.toLowerCase())) otherNames.push(n.name);
  }
  if (otherNames.length > 3) return { ok: false, error: 'Enter at most three other names.', field: 'otherNames' };
  return {
    ok: true,
    value: {
      name: person.name, company: company.value, mononym: person.mononym,
      website: website.value, profile: profile.value, place: place.value, school: school.value, otherCompanies, otherNames,
    },
  };
}

/** The subject, with other names passed on when identity.js reads them (older versions ignore the field). */
function subjectFor({ name, company = '', otherNames = [], anchors = null }) {
  const input = { name, company, ...(otherNames && otherNames.length ? { otherNames } : {}) };
  try {
    return anchors ? restoreSubject({ ...input, anchors }) : createSubject(input);
  } catch {
    return anchors ? restoreSubject({ name, company, anchors }) : createSubject({ name, company });
  }
}
/**
 * The subject for one step, with what the sources may read beside the anchors: the place the user typed and the
 * countries of the person's tied register records (the open-web source picks its local-language pass from these),
 * and the company's founding year once the records give one (the domain source flags a domain older than it).
 */
function restoreFrom(state) {
  const subject = subjectFor({ name: state.name, company: state.company, otherNames: state.otherNames, anchors: state.anchors || {} });
  if (state.given?.place) subject.place = state.given.place;
  if (Array.isArray(state.countries) && state.countries.length) subject.countries = state.countries.slice();
  if (Number.isInteger(state.companyFounded)) subject.foundedYear = state.companyFounded;
  return subject;
}

const isHandleOnlyName = (subject, handle) => {
  const flat = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (subject.slugs || []).some((slug) => flat(slug) === flat(handle));
};

/**
 * A new check. Beside the name and company, the start form may give a company website, a profile address,
 * a city or country, earlier companies, a school and other names (see validateCheckInput); each is seeded
 * as something the user gave. `assumedCompany` is a company taken from the user's network when none was
 * typed: it may make records likely, never confirmed, and the report says it was assumed.
 */
export function startState({ name, company = '', website = '', profile = null, place = '', otherCompanies = [], school = '', otherNames = [], mononym = false, assumedCompany = '' }) {
  const subject = subjectFor({ name, company, otherNames });
  const given = {};
  if (website) {
    if (addAnchor(subject, 'domains', website, 'given') || subject.anchors.domains.has(String(website).toLowerCase())) given.website = website;
    if (subject.company) addCompanyAlias(subject, { company: subject.company, alias: website, origin: 'given' });
  }
  if (profile && typeof profile === 'object') {
    if (profile.handle) {
      // A handle that is only the person's own name run together ties nothing: a namesake may use it too.
      if (!isHandleOnlyName(subject, profile.handle)) addAnchor(subject, 'handles', profile.handle, 'given');
      given.profile = { platform: profile.platform || null, handle: profile.handle };
    } else if (profile.domain) {
      addAnchor(subject, 'domains', profile.domain, 'given');
      given.profile = { platform: 'site', domain: profile.domain };
    }
  }
  if (place) given.place = place;
  const earlier = (otherCompanies || []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 5);
  for (const c of earlier) addAnchor(subject, 'companies', c, 'given');
  if (earlier.length) given.otherCompanies = earlier;
  if (school) { addAnchor(subject, 'schools', school, 'given'); given.school = school; }
  const assumed = !subject.company && String(assumedCompany || '').trim();
  if (assumed) addAnchor(subject, 'companies', assumed, 'network');
  return {
    version: 1,
    name: subject.name,
    company: subject.company,
    ...(otherNames && otherNames.length ? { otherNames: otherNames.slice(0, 3) } : {}),
    ...(mononym ? { mononym: true } : {}),
    ...(Object.keys(given).length ? { given } : {}),
    ...(assumed ? { assumedCompany: assumed } : {}),
    anchors: exportAnchors(subject),
    identity: subject.company ? { status: 'given', note: null }
      : assumed ? { status: 'assumed', company: assumed, note: `No company was typed. One of your contacts named ${subject.name} works at ${assumed}, so the check assumes this is that person. Records tied only through ${assumed} are shown as "if this is the right person", never as red flags. Add the company to be certain.` }
        : { status: 'open', note: null },
    phase: 'collect',
    step: 0,
    startedAt: Date.now(),
    tasksRun: 0,
    drySteps: 0,
    reviews: 0,
    needsReview: false,
    queue: [],
    done: [],
    missed: [],
    screened: {},
    threads: {},
    findings: [],
    sources: {},
    log: [],
    dropped: { tasks: 0, findings: 0, threads: 0 },
  };
}

/**
 * How the person is tied to a company decides how hard the company is looked at.
 *   primary    they founded, own or run it (or it is the company the user gave): the company itself is
 *              checked in full, since its lawsuits, insolvency and breaches reflect on them
 *   affiliate  they sit on its board, invested in it, advised it or once worked there: only what ties the
 *              two together is looked up. A board seat at a large company must not fill the report with
 *              that company's litigation.
 */
// A bare "owner" or "owns" is not enough: an investor "owns" a stake. Owning it outright, or owning and running it, is.
const PRIMARY_TIE = /\b(found(?:ed|er|ing)|co-?found\w*|started|launched|ran|runs|led|heads|headed|chief executive|CEO|CTO|COO|CFO|owner(?:[- ]operator| and (?:CEO|chief executive|founder|operator|president|managing director))|owns and (?:runs|operates|manages)|wholly owns|president|managing (?:director|partner|member)|general partner|principal|executive officer|sole (?:director|member|shareholder|owner|proprietor)|proprietor|10% owner|holding vehicle|promoter|earlier name|formerly named|the company given|the company most sources name)\b/i;
// A role read out of free text ("CEO", "founder (past)": the words next to a company name in a snippet) can
// belong to someone else in the same sentence ("... and Airbus CEO Guillaume Faury"). Such a thread is
// looked at as an affiliate until a record that states the tie (a register, a filing, a knowledge graph,
// the person's own profile: their "why" names the source) says the person ran the company.
const LOOSE_ROLE = /^\s*[\w&.' -]{1,40}?(?:\s*\((?:past|current)\))?\s*$/;
const STATED = /\(|given|most sources name|earlier name|formerly|filing|register|form d|wikidata|littlesis|profile|insider|appointment|official/i;
export const tieOf = (thread) => {
  // The second reader's proposal is looked at only together with the person until a record states the tie.
  if (thread.suggested) return 'affiliate';
  const why = String(thread.why || '');
  if (why === 'the company given' || why === ASSUMED_COMPANY || why.startsWith('the company most sources name') || why.startsWith('legal name of ')) return 'primary';
  if (!PRIMARY_TIE.test(`${why} ${thread.role || ''}`)) return 'affiliate';
  return LOOSE_ROLE.test(why) && !STATED.test(why.replace(/\((?:past|current)\)/g, '')) ? 'affiliate' : 'primary';
};
/** Sources that establish what the person did at a company; the only ones asked about an affiliate. */
const AFFILIATE_SOURCES = new Set(['sec-company', 'uk-companies-house', 'fr-companies', 'yc-directory']);
export const JOINT_TEMPLATES = ['q.joint-role', 'q.joint-adverse'];

/**
 * A page that is read, not tracked over time: an article, show notes or an interview. Its earlier versions say
 * nothing a profile's would, so the web archive is not asked about it (each archive lookup is several slow,
 * paced requests).
 */
const READ_ONLY_PAGE = /^(?:article naming them|podcast or interview page|interview or article page about them)$/;
const ARCHIVE_SOURCE = 'web-archive';
/** The seed of a check: the lookups about the person that build their profile, run ahead of everything else. */
export const isSeedTask = (t) => t.depth === 0 && t.kind === 'subject' && Boolean(t.params?.seed);

/** The tasks a thread turns into: one per source (and per query pattern) that can handle its kind. */
/**
 * Whether a source is on. A source whose own check throws is treated as off for this check and recorded as
 * a source that could not be asked, rather than making every step of the check fail on the same throw.
 */
function sourceOn(c, state = null) {
  if (typeof c.enabled !== 'function') return true;
  try {
    return Boolean(c.enabled());
  } catch (error) {
    if (state) planFailed(state, c, error);
    return false;
  }
}
function ensureStat(state, id, label) {
  if (!state.sources) state.sources = {};
  return state.sources[id] || (state.sources[id] = { label: label || id, runs: 0, findings: 0, errors: 0, ms: 0 });
}
function planFailed(state, c, error) {
  const stat = ensureStat(state, c.id, c.label);
  stat.notRun = (stat.notRun || 0) + 1;
  stat.lastError = 'could not be planned';
  stat.lastErrorClass = 'plan';
  if (process.env.NODE_ENV !== 'test') console.warn(`[deep-check] ${c.id} could not be planned: ${String(error?.message || error).slice(0, 300)}`);
}

/**
 * Sources asked about an earlier venture (a company the person founded or ran, read from a tied record) on
 * top of the affiliate ones: what happened to the company itself (courts, enforcement, insolvency, watchlists).
 */
const isVentureSource = (id) => SCREEN_SOURCES.has(id);

/**
 * The founding year of the company a domain thread belongs to (the given company's website or a domain learned as
 * one of its names), so the domain source can say a domain was registered by an earlier holder. Null otherwise:
 * another company's domain is never compared with this company's founding.
 */
function companyDomainYear(state, subject, thread) {
  if (thread.kind !== 'domain' || !state || !Number.isInteger(state.companyFounded) || !subject?.company) return null;
  const domain = String(thread.value || '').toLowerCase().replace(/^www\./, '');
  const of = companyKeys(subject.company)[0] || subject.company.toLowerCase();
  const alias = subject.anchors.aliases?.get(domain);
  return (alias && alias.of === of) || String(state.given?.website || '').toLowerCase() === domain ? state.companyFounded : null;
}

function planTasks(thread, depth, connectors, subject, state = null) {
  const out = [];
  const affiliate = thread.kind === 'company' && thread.tie === 'affiliate';
  const venture = affiliate && Boolean(thread.venture);
  if (affiliate) {
    // The person and the company together: what they did there, and anything adverse that names both.
    const searcher = connectors.find((c) => c.id === 'web-search' && (typeof c.enabled !== 'function' || c.enabled()));
    if (searcher) {
      const both = `"${subject.name}" "${thread.value}"`;
      out.push({ connector: searcher.id, kind: 'company', value: thread.value, depth, template: JOINT_TEMPLATES[0], params: { query: both }, prior: 0.5, why: thread.why || '', relation: null, tie: thread.tie || null });
      out.push({ connector: searcher.id, kind: 'company', value: thread.value, depth, template: JOINT_TEMPLATES[1], params: { query: `${both} lawsuit OR sued OR fraud OR investigation OR dispute OR fired OR bankruptcy` }, prior: 0.55, why: thread.why || '', relation: null, tie: thread.tie || null });
    }
  }
  for (const c of connectors) {
    if (!Array.isArray(c.kinds) || !c.kinds.includes(thread.kind)) continue;
    if (affiliate && !AFFILIATE_SOURCES.has(c.id) && !(venture && isVentureSource(c.id))) continue;
    if (thread.kind === 'url' && c.id === ARCHIVE_SOURCE && READ_ONLY_PAGE.test(String(thread.why || ''))) continue;
    if (!sourceOn(c, state)) continue;
    let variants;
    try {
      variants = typeof c.plan === 'function' ? c.plan(thread, subject) : [{}];
    } catch (error) {
      // One source's planning bug must not make the check unrunnable: it is reported as not asked.
      if (state) planFailed(state, c, error);
      continue;
    }
    const founded = companyDomainYear(state, subject, thread);
    for (const v of Array.isArray(variants) ? variants : []) {
      if (!v || typeof v !== 'object') continue;
      out.push({
        connector: c.id, kind: thread.kind, value: thread.value, depth,
        template: v.template || null, params: founded && !(v.params && 'foundedYear' in v.params) ? { ...(v.params || {}), foundedYear: founded } : v.params || null,
        prior: v.prior ?? c.prior ?? 0.5, why: v.why || thread.why || '', relation: thread.relation || null, platform: thread.platform || null, tie: thread.tie || null,
        ...(venture ? { venture: true } : {}),
      });
    }
  }
  return out;
}

function enqueue(state, tasks) {
  const seen = new Set([...state.done, ...(state.missed || []), ...state.queue.map(taskKey)]);
  let added = 0;
  for (const t of tasks) {
    const key = taskKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    state.queue.push(t);
    added += 1;
  }
  return added;
}

/**
 * Does this thread tell us anything about who the person is? A handle that is only the person's own name
 * run together ("johnsmith") carries no identity beyond the name: it is followed, never used to tie
 * records to them.
 */
function anchors(subject, thread) {
  if (!ANCHOR_KIND[thread.kind]) return false;
  if (thread.kind !== 'handle') return true;
  const flat = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const handle = flat(thread.value);
  return Boolean(handle) && !(subject.slugs || []).some((slug) => flat(slug) === handle);
}

/**
 * Record a thread. Returns it when it is new and should be pulled, else null.
 * A thread is only pulled, and only becomes an identity anchor, when it is
 * trusted: it came from a record already tied to the subject. A namesake's
 * employer must never become "known" about the subject.
 */
/** The anchor key identity.js files a value under. */
const anchorKey = (kind, value) => {
  const v = String(value || '').trim();
  return kind === 'company' ? (companyKeys(v)[0] || v.toLowerCase()) : v.toLowerCase();
};
/** Add an anchor for a trusted thread, or lift an existing weaker one when a stronger record now supports it. */
function anchorFor(subject, thread, value, origin) {
  if (!anchors(subject, thread)) return;
  const kind = ANCHOR_KIND[thread.kind];
  if (addAnchor(subject, kind, value, origin)) return;
  const existing = subject.anchors[kind]?.get(anchorKey(thread.kind, value));
  if (!existing) return;
  // A record that bears out the second reader's clue makes it an ordinary anchor (weak or strong, as that record is)
  if ((!isStrongOrigin(existing.origin) && isStrongOrigin(origin)) || (READER_ORIGIN.test(String(existing.origin || '')) && !READER_ORIGIN.test(String(origin || '')))) existing.origin = origin;
}

/**
 * Record a thread. Returns it when it is new and should be pulled, else null.
 * A thread is only pulled, and only becomes an identity anchor, when it is
 * trusted: it came from a record already tied to the subject. A namesake's
 * employer must never become "known" about the subject.
 * `origin` says what the thread rests on: { anchor } is the origin its anchor gets ('found:<id>' from a
 * confirmed record, 'weak:<id>' from a likely one, 'reader' from the second reader, 'given'), and
 * { venture: true } that a tied record says the person founded or ran this company.
 */
function noteThread(state, subject, thread, depth, evidence = null, origin = null) {
  if (!thread || !THREAD_KINDS.includes(thread.kind)) return null;
  // A thread the second reader proposed keeps the origin it names (the record it read, 'reader:<id>'): it may be
  // followed, never confirm records on its own.
  const readerOrigin = thread.suggested ? (READER_ORIGIN.test(String(thread.origin || '')) ? String(thread.origin) : 'reader') : null;
  const anchorOrigin = readerOrigin || origin?.anchor || 'found';
  const key = threadKey(thread);
  let existing = state.threads[key];
  if (!existing && (thread.kind === 'company' || thread.kind === 'school')) {
    const same = sameOrganisation(state, thread);
    if (same === 'junk') return null;
    if (same) existing = same;
  }
  if (!existing && (thread.kind === 'associate' || thread.kind === 'relative')) {
    // someone already recorded as a relative is not recorded again as an associate (or the reverse)
    const other = state.threads[`${thread.kind === 'associate' ? 'relative' : 'associate'}|${personKey(thread.value)}`];
    if (other) existing = other;
  }
  if (existing) {
    existing.support = (existing.support || 1) + 1;
    addEvidence(existing, evidence);
    // first seen deep (from an untrusted record), now seen closer to the person: it is pulled at the shallower depth
    existing.depth = Math.min(existing.depth ?? depth, depth);
    // A later record may show the person founded or ran a company first seen as a mere affiliation
    const promoted = existing.kind === 'company' && existing.tie === 'affiliate' && thread.trusted && !thread.suggested && tieOf(thread) === 'primary';
    if (promoted) { existing.tie = 'primary'; existing.why = thread.why || existing.why; delete existing.venture; }
    // A tied record says the person founded or ran this earlier company: its own courts, enforcement,
    // insolvency and watchlist screens are asked too (it stays an affiliate otherwise).
    const venture = !promoted && existing.kind === 'company' && existing.tie === 'affiliate' && thread.trusted && origin?.venture && !existing.venture;
    if (venture) existing.venture = true;
    // seen again on a record (not only proposed by the second reader)
    if (thread.trusted && existing.suggested && !READER_ORIGIN.test(anchorOrigin)) { delete existing.suggested; delete existing.origin; }
    if (thread.trusted && !existing.trusted) {
      existing.trusted = true;
      anchorFor(subject, thread, existing.value, anchorOrigin);
      if (!existing.pulled) return existing;
    } else if (thread.trusted && existing.trusted) {
      anchorFor(subject, thread, existing.value, anchorOrigin);
    }
    if ((promoted || venture) && existing.trusted) { existing.pulled = false; return existing; } // pull again, in full this time
    return null;
  }
  const tie = thread.kind === 'company' ? tieOf(thread) : null;
  const record = {
    kind: thread.kind, value: thread.value, why: thread.why || '', depth, trusted: Boolean(thread.trusted), support: 1, pulled: false,
    ...(thread.kind === 'company' ? { tie } : {}),
    ...(tie === 'affiliate' && thread.trusted && origin?.venture ? { venture: true } : {}),
    ...(thread.relation ? { relation: thread.relation } : {}), ...(thread.role ? { role: thread.role } : {}), ...(thread.platform ? { platform: thread.platform } : {}),
    // proposed by the second reader, not yet seen on a record: the report labels it so
    ...(READER_ORIGIN.test(anchorOrigin) ? { suggested: true, origin: anchorOrigin, ...(thread.statedRole ? { statedRole: String(thread.statedRole).slice(0, 80) } : {}) } : {}),
  };
  addEvidence(record, evidence);
  state.threads[key] = record;
  if (record.trusted) anchorFor(subject, thread, record.value, anchorOrigin);
  // Another name of the person (former, maiden, other script): graded likely at most when found in a record.
  if (record.trusted && thread.kind === 'alias' && anchorOrigin !== 'given' && typeof identityApi.addNameAlias === 'function') identityApi.addNameAlias(subject, { alias: record.value, origin: anchorOrigin });
  return record.trusted ? record : null;
}

/**
 * Other names a newly kept, tied record gives for the person ("née Smith", "formerly known as"), as threads
 * (when this deployment knows the 'alias' kind) and as other names of the subject. Never from a record
 * that is tied only through an assumed company.
 */
function readNameAliases(state, subject, kept) {
  if (typeof identityApi.findNameAliases !== 'function') return [];
  const out = [];
  for (const f of kept) {
    if ((f.match !== 'confirmed' && f.match !== 'likely') || f.assumedTie) continue;
    for (const { name, how } of identityApi.findNameAliases(subject, `${f.title || ''}\n${f.quote || ''}`)) {
      const origin = f.match === 'confirmed' ? `found:${f.id}` : `weak:${f.id}`;
      if (THREAD_KINDS.includes('alias')) {
        const record = noteThread(state, subject, { kind: 'alias', value: name, why: `${how} (in a record about them)`, trusted: true }, 1, null, { anchor: origin });
        if (record) out.push(record);
      } else if (typeof identityApi.addNameAlias === 'function') identityApi.addNameAlias(subject, { alias: name, origin });
    }
  }
  return out;
}

// "<Person> founded/co-founded/started/ran <Company>", "<Person>, co-founder and CEO of <Company>".
const VENTURE_ROLE = /\b(?:co-?found(?:ed|er|ing)|founded|founder|started|launched|was (?:the )?(?:ceo|chief executive)|(?:ceo|chief executive(?: officer)?|managing director|president)(?= (?:of|at)\b))\b/i;
// What may stand between the person's name and the role: nothing naming another person, except co-founders
// listed with them ("Shensi Ding and Gil Feig founded Merge").
const ANOTHER_PERSON = /\b[\p{Lu}][\p{Ll}'’-]+\s+[\p{Lu}][\p{Ll}'’-]+\b/u;
const VENTURE_ROLE_ALL = new RegExp(VENTURE_ROLE.source, 'gi');
const ROLE_TO_COMPANY = /^(?:\s*(?:,|and|&)\s*(?:co-?)?(?:ceo|cto|coo|cfo|chief [a-z]+(?: officer)?|president|chair(?:man|woman)?|managing director|founder))*\s*(?:of|at)?\s*(?:(?:the|a|an|their|his|her)\s+)?(?:(?:startup|start-up|company|firm|fintech|business|venture|platform)\s+(?:called\s+|named\s+)?)?\s*$/i;
const CO_FOUNDERS = /(?:,?\s*(?:and|&)\s+[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){0,2}\s*,?)+/gu;
/**
 * Does this text say, in a sentence about the person, that they founded or ran `company`? The sentence must
 * name them in full before the role, and the role must not belong to someone named in between
 * ("Eric Glyman joined Erik Torenberg (co-founder of Village Global)").
 */
export function statesVenture(subject, text, company) {
  const value = String(company || '').trim();
  if (!value) return false;
  const forms = [...new Set([value, ...(companyKeys(value)[0] ? [companyKeys(value)[0]] : [])])].filter((f) => f.length >= 3).map((f) => f.toLowerCase());
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const lower = sentence.toLowerCase();
    if (!forms.some((f) => lower.includes(f))) continue;
    const names = typeof subject.hasName.positions === 'function' ? subject.hasName.positions(sentence) : [];
    for (const n of names) {
      const after = sentence.slice(n.end, n.end + 160);
      for (const m of after.matchAll(VENTURE_ROLE_ALL)) {
        // the companies already known about the person ("Ada Quill, CEO of Acme Corp, previously co-founded
        // Zeta") and co-founders listed with them may stand in between; another person named there may not
        let between = after.slice(0, m.index).replace(CO_FOUNDERS, ' ');
        for (const a of subject.anchors.companies.values()) between = between.split(a.value).join(' ');
        if (ANOTHER_PERSON.test(between) || /[()]/.test(between)) continue;
        // the company is what the role is about: right after it ("co-founded Paribus", "founder and CEO of
        // Merge", "started a startup called Expanse"), not a later clause ("... and sits on the board of Meta")
        const rest = after.slice(m.index + m[0].length).toLowerCase();
        for (const f of forms) {
          const at = rest.indexOf(f);
          if (at >= 0 && at <= 60 && ROLE_TO_COMPANY.test(rest.slice(0, at))) return true;
        }
      }
    }
  }
  return false;
}

/**
 * What a thread a source returned rests on: the strongest record of the same lookup that names it (else
 * the strongest record of the lookup). -> { level, id, basis, assumed, venture }
 */
function threadOrigin(subject, task, findings, th) {
  const value = norm(th?.value);
  const textOf = (f) => `${f.title || ''}\n${f.quote || ''}\n${f.gradeText || ''}`;
  const naming = value ? findings.filter((f) => norm(textOf(f)).includes(value)) : [];
  const pool = naming.length ? naming : findings;
  // A record about the company (not the person) counts as likely: it may lead somewhere, it confirms nothing.
  const rank = (f) => (f.match === 'company' ? 2 : matchRank(f.match));
  let best = null;
  for (const f of pool) if (!best || rank(f) > rank(best)) best = f;
  const level = best ? (best.match === 'company' ? 'likely' : best.match) : (th?.trusted ? 'likely' : 'possible');
  const id = best ? best.id : `${task.connector}|${norm(task.value)}`;
  const venture = th?.kind === 'company' && naming.some((f) => rank(f) >= 2 && !f.assumedTie && statesVenture(subject, textOf(f), th.value));
  return { level, id, basis: best?.matchBasis || null, assumed: Boolean(best?.assumedTie), venture };
}

/**
 * What a thread was seen in: one entry per distinct page (or, for a thread a source returned without a
 * record naming it, one per source and lookup subject). The same article returned by two query patterns
 * is one piece of evidence, however many times it is seen.
 */
function addEvidence(record, evidence) {
  if (!evidence?.length) return;
  const list = record.evidence || (record.evidence = []);
  for (const e of evidence) {
    if (list.length >= 12) break;
    if (!list.some((x) => x.key === e.key)) list.push(e);
  }
}

function evidenceFor(task, findings, thread) {
  const value = norm(thread?.value);
  const naming = value ? findings.filter((f) => norm(`${f.title} ${f.quote || ''} ${f.gradeText || ''}`).includes(value)) : [];
  if (!naming.length) return [{ key: `${task.connector}|${task.kind}|${norm(task.value)}`, by: task.connector, host: null }];
  return naming.map((f) => ({ key: pageKey(f), by: task.connector, host: urlKey(f.url).split(/[/?#]/)[0] || null }));
}

/** Pull a thread: mark it and queue its tasks, within the per-kind allowance. */
function pullThread(state, subject, record, connectors) {
  if (record.pulled) return 0;
  if (record.depth > LIMITS.maxDepth) { if (record.trusted) state.dropped.threads += 1; return 0; }
  // companies the person ran and companies they are merely tied to have separate allowances
  const pulledOfKind = Object.values(state.threads).filter((t) => t.kind === record.kind && t.pulled && (t.tie || '') === (record.tie || '')).length;
  const allowance = record.tie === 'affiliate' ? LIMITS.pull.affiliate : LIMITS.pull[record.kind];
  if (pulledOfKind >= (allowance ?? 6)) { state.dropped.threads += 1; return 0; }
  record.pulled = true;
  return enqueue(state, planTasks(record, record.depth, connectors, subject, state));
}

/**
 * When no company was given, records can only be matched by name. If one
 * company clearly dominates what the sources say about this name, adopt it
 * (and say so); otherwise leave the identity open and say that too.
 */
function resolveIdentity(state, subject, connectors) {
  if (state.identity.status !== 'open') return 0;
  // A very common name is never pinned to whichever namesake the sources cover best.
  if (subject.common) {
    if (state.step >= 1 && state.identity.status === 'open') {
      state.identity = { status: 'ambiguous', note: `${subject.name} is a common name, and no company was given, so no company is assumed. Records match by name only. Add the company so records can be matched to the right person.` };
    }
    return 0;
  }
  // Only distinct evidence counts: one page seen twice (two query patterns returning the same article) is one.
  const weight = (t) => (t.evidence || []).length;
  const candidates = Object.values(state.threads).filter((t) => t.kind === 'company' && !t.trusted).sort((a, b) => weight(b) - weight(a) || (b.support || 0) - (a.support || 0));
  if (!candidates.length) return 0;
  const [top, second] = candidates;
  // and it must come from more than one place: two sources, or pages on two different sites
  const diverse = (t) => new Set((t.evidence || []).map((e) => e.by)).size >= 2 || new Set((t.evidence || []).map((e) => e.host).filter(Boolean)).size >= 2;
  if (weight(top) >= 2 && diverse(top) && (!second || weight(top) >= 2 * weight(second))) {
    top.trusted = true;
    top.tie = 'primary';
    addAnchor(subject, 'companies', top.value, 'inferred');
    state.identity = { status: 'inferred', company: top.value, note: `No company was given. Most sources about this name describe someone at ${top.value}, so the check assumes this is that person. Records tied only through ${top.value} are shown as "if this is the right person", never as red flags. Add the company to be certain.` };
    state.log.push({ step: state.step, text: `Identity: following ${subject.name} at ${top.value} (the company most sources name).` });
    return pullThread(state, subject, top, connectors);
  }
  if (state.step >= 1) {
    state.identity = { status: 'ambiguous', note: `Sources describe more than one person named ${subject.name} (${candidates.slice(0, 4).map((c) => c.value).join('; ')}). Add the company so records can be matched to the right person.` };
  }
  return 0;
}

/**
 * Grade text against the subject, keeping to what each anchor may do (see "anchor strength" above):
 *   confirmed  only through a company anchor the user gave or a confirmed record produced, and never one
 *              this record produced itself (`selfId`)
 *   likely     the cap when the company that tied it came from a likely record, or was only inferred or
 *              assumed from the user's network (then `assumed` is set: the record holds only if the
 *              assumed company is the right one)
 *   possible   when the only other clue was proposed by the second reader or came from this record
 * Returns matchSubject's { level, reasons, basis } plus `assumed`.
 */
function gradeOf(subject, text, date = null, selfId = null) {
  let graded = matchSubject(subject, text, { date });
  if (graded.level !== 'confirmed' && graded.level !== 'likely') return graded;
  const needs = anchorNeeds(subject, selfId);
  if (!needs) return graded;
  const notSelf = (a) => !(selfId && originId(a.origin) === selfId);
  if (graded.level === 'confirmed' && (needs.weakCompany || needs.self)) {
    const strong = matchSubject(viewOf(subject, (kind, a) => notSelf(a) && (kind !== 'companies' || isStrongOrigin(a.origin))), text, { date });
    if (strong.level === 'confirmed') return graded;
    // Rests on the assumed company alone when nothing else known about the person ties it.
    const assumedHit = [...subject.anchors.companies.values()].some((a) => ASSUMED_ORIGIN.test(String(a.origin || '')) && a.test(text));
    graded = { ...graded, level: 'likely', ...(assumedHit && matchRank(strong.level) < matchRank('likely') ? { assumed: true } : {}) };
  }
  if (!needs.reader && !needs.self) return graded;
  // A clue the second reader proposed, or one this record produced, does not count on its own. One exception:
  // a legal name learned from a filing or register entry that lists the person (design decision 1) lifts that
  // same entry to likely, never to confirmed.
  const without = matchSubject(viewOf(subject, (kind, a) => (kind === 'aliases' || notSelf(a)) && !READER_ORIGIN.test(String(a.origin || ''))), text, { date });
  if (matchRank(without.level) >= matchRank('likely')) return graded;
  return { level: 'possible', reasons: ['matched by name only', ...(needs.reader ? ['a clue the second reader suggested is not yet borne out by a record'] : [])].slice(0, 4), basis: without.basis || [] };
}

/** Apply a grade to a kept record: level, reasons, basis, and whether it rests on an assumed company. */
function applyGrade(f, graded) {
  f.match = graded.level;
  f.matchReasons = graded.reasons;
  if (graded.basis) f.matchBasis = graded.basis; else delete f.matchBasis;
  if (graded.assumed) f.assumedTie = true; else delete f.assumedTie;
}

/** The date a record is graded at (a role held at the time): the one it was first graded at, else its own. */
const gradeDateOf = (f) => f.gradeDate || f.date || null;

/** Records graded "possible" or "likely" are re-read whenever more is known about the subject. */
function regrade(state, subject) {
  let upgraded = 0;
  // Register entries held at "possible" because their company was not yet known to be the person's are looked at
  // again with the names known now ("RAMP BUSINESS UK LTD" once "Ramp Business Corp" is learned); likely at most.
  if (subject.anchors.aliases?.size && typeof registriesApi.retieHeldRecords === 'function') {
    try { upgraded += registriesApi.retieHeldRecords(subject, state.findings) || 0; } catch { /* the held records stay as they were */ }
  }
  for (const f of state.findings) {
    if (f.match === 'company' || f.matchFixed) continue;
    if (f.match === 'confirmed' && !f.assumedTie) continue;
    // the text the record was first graded on (which may hold structured context the title lacks)
    const graded = gradeOf(subject, f.gradeText || `${f.title}\n${f.quote || ''}`, gradeDateOf(f), f.id);
    if (matchRank(graded.level) > matchRank(f.match)) { applyGrade(f, graded); upgraded += 1; }
    // the same grade, now resting on something more than the assumed company
    else if (graded.level === f.match && f.assumedTie && !graded.assumed) applyGrade(f, graded);
  }
  return upgraded;
}

function summarize(state) {
  const byCategory = {};
  const byMatch = {};
  for (const f of state.findings) {
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    byMatch[f.match] = (byMatch[f.match] || 0) + 1;
  }
  const threads = {};
  for (const t of Object.values(state.threads)) if (t.trusted) threads[t.kind] = (threads[t.kind] || 0) + 1;
  return {
    phase: state.phase, step: state.step, tasksRun: state.tasksRun, queued: state.queue.length,
    findings: state.findings.length, byCategory, byMatch, threads,
    sources: Object.entries(state.sources).map(([id, s]) => ({ id, label: s.label, runs: s.runs, findings: s.findings, errors: s.errors, lastError: s.lastError || null, ...(s.lastErrorClass ? { lastErrorClass: s.lastErrorClass } : {}), ...(s.partial?.length ? { partial: s.partial.slice() } : {}), ...(s.notRun ? { notRun: s.notRun } : {}), ...(s.waitedOut ? { waitedOut: s.waitedOut } : {}) })),
    identity: state.identity, log: state.log.slice(-14), dropped: state.dropped,
  };
}

// ---------------------------------------------------------------- screens and lookups not run
const PERSON_KINDS = new Set(['subject', 'alias', 'associate', 'relative']);
/** A watchlist screen of a person (the subject or a related party): the report says whether each was screened. */
const isPersonScreen = (t) => WATCHLIST_SOURCES.has(t.connector) && PERSON_KINDS.has(t.kind);
/**
 * Record how a watchlist screen of a person went. state.screened[personKey] = { name, ok: [source ids],
 * missed: [source ids] }: a person counts as screened only when every list asked about them answered in full.
 */
function noteScreen(state, task, ok) {
  if (!isPersonScreen(task)) return;
  const name = task.kind === 'subject' ? state.name : task.value;
  const screened = state.screened || (state.screened = {});
  const entry = screened[personKey(name)] || (screened[personKey(name)] = { name, ok: [], missed: [] });
  const list = ok ? entry.ok : entry.missed;
  if (!list.includes(task.connector)) list.push(task.connector);
}
/**
 * Each watchlist lookup, by its task key: state.screenedOk lists those that answered in full, state.screenFailed
 * those that failed, answered in part, waited out or did not run. The report screens a related party only on
 * these, never on whether the source as a whole answered.
 */
function noteWatchlistLookup(state, task, ok) {
  if (!WATCHLIST_SOURCES.has(task.connector)) return;
  const key = taskKey(task);
  const okList = state.screenedOk || (state.screenedOk = []);
  const failed = state.screenFailed || (state.screenFailed = []);
  if (ok) { if (!okList.includes(key) && !failed.includes(key)) okList.push(key); return; }
  if (!failed.includes(key)) failed.push(key);
  const at = okList.indexOf(key);
  if (at >= 0) okList.splice(at, 1);
}
function addPartial(stat, text) {
  const v = String(text || '').trim().slice(0, 80);
  if (!v) return;
  const partial = stat.partial || (stat.partial = []);
  if (!partial.includes(v) && partial.length < 60) partial.push(v);
}
/**
 * Lookups that will not run in this check (dropped at a stop, past the wait limit, refused before any request
 * went out). Each is counted per source, so a screen whose lookups were dropped is shown as answered in part
 * or not run, never as a clean result, and a person whose watchlist screen did not run is not shown as screened.
 */
function markNotRun(state, tasks, byId, { waited = false } = {}) {
  const missed = state.missed || (state.missed = []);
  for (const t of tasks) {
    const stat = ensureStat(state, t.connector, byId?.get(t.connector)?.label);
    if (waited) stat.waitedOut = (stat.waitedOut || 0) + 1;
    else stat.notRun = (stat.notRun || 0) + 1;
    // a screen that could not ask about everyone is answered in part (the reason names who was not asked)
    if (SCREEN_SOURCES.has(t.connector) && !waited) addPartial(stat, `not run: ${t.value}`);
    const key = taskKey(t);
    if (!missed.includes(key)) missed.push(key);
    noteScreen(state, t, false);
    noteWatchlistLookup(state, t, false);
  }
  state.dropped.tasks += tasks.length;
}
// A note in which a source says part of its lists or registers did not answer
const FAILED_NOTE = /\b(?:could not|did not|failed|unavailable|not (?:loaded|reached|answer))\b/i;

// ---------------------------------------------------------------- legal names (design decision 1)
// A legal form at the end of a name: "Ramp Business Corp", "Merge API, Inc."
const LEGAL_FORM_END = /\b(?:inc|incorporated|corp|corporation|co|company|llc|l\.l\.c|ltd|limited|plc|lp|llp|gmbh|ag|sa|sas|sarl|bv|nv|pty|pte|ab|oy|kk|spa|srl)\.?\s*$/i;
// Sources whose record of a company is official: a filing or register entry naming the person.
const OFFICIAL_SOURCES = new Set(['sec-filings', 'sec-company', 'uk-companies-house', 'fr-companies', 'lei-register', 'us-state-registries']);
/** Is `name` a fuller legal name of `company` ("Ramp Business Corp" of "Ramp"), never another company that shares a word? */
function extendsName(name, company) {
  const n = String(name || '').trim();
  if (!LEGAL_FORM_END.test(n)) return false;
  const full = companyKeyStrict(n);
  const base = companyKeyStrict(company);
  return Boolean(base) && full !== base && full.startsWith(`${base} `);
}
/** Does a domain belong to the company ("ramp.com", "tryramp.com", "merge.dev" for Merge)? */
function domainFits(domain, company) {
  const label = String(domain || '').toLowerCase().replace(/^www\./, '').split('.')[0];
  const base = companyKeyStrict(company).replace(/\s+/g, '');
  return base.length >= 3 && (label === base || label === `try${base}` || label === `get${base}` || label === `use${base}` || label === `join${base}` || label === `${base}hq` || label === `${base}app`);
}
/** The companies whose legal names are learned: the one given, and those the person founded or runs (strong anchors only). */
function primaryCompanies(state, subject) {
  return Object.values(state.threads).filter((t) => {
    if (t.kind !== 'company' || !t.trusted || t.tie === 'affiliate') return false;
    const a = subject.anchors.companies.get(anchorKey('company', t.value));
    return Boolean(a) && isStrongOrigin(a.origin);
  });
}
/**
 * Learn fuller legal names and domains of the person's companies from records tied by more than the bare
 * word (a filing or register entry naming the person, a thread from a confirmed record that states the
 * tie), register them through identity.js, and ask the registers, SEC, trademarks, lobbying, complaints and
 * awards again under each legal name, once. Returns how many lookups were queued.
 */
function learnLegalNames(state, subject, connectors, kept, threads) {
  const primaries = primaryCompanies(state, subject);
  if (!primaries.length) return 0;
  const candidates = [];
  for (const f of kept) {
    // A filing or register entry that names the person in full is tied by more than the bare word, even
    // while the bare word alone cannot confirm it ("Ramp" inside "Ramp Business Corp" is an ordinary word).
    if (!OFFICIAL_SOURCES.has(f.source) || f.assumedTie) continue;
    const d = f.data || {};
    const text = `${f.title || ''}\n${f.quote || ''}\n${f.gradeText || ''}`;
    if (!subject.hasName(text)) continue;
    // tied already, or the entry lists the person in a role (an officer of a Form D, a register's director)
    const listsRole = (Array.isArray(d.roles) && d.roles.length > 0) || (Array.isArray(d.appointments) && d.appointments.length > 0) || /\b(?:officer|director|promoter|executive)\b/i.test(f.title || '');
    if (matchRank(f.match) < matchRank('likely') && !listsRole) continue;
    const names = [d.issuer, d.company, d.legalName, d.entityName, ...(Array.isArray(d.filers) ? d.filers : [])].filter((x) => typeof x === 'string');
    for (const name of names) candidates.push({ name, origin: `found:${f.id}` });
  }
  for (const { th, origin } of threads) {
    if (!th?.trusted || origin.level !== 'confirmed' || origin.assumed) continue;
    if (th.kind === 'company' && tieOf(th) === 'primary') candidates.push({ name: th.value, origin: `found:${origin.id}` });
    if (th.kind === 'domain') {
      for (const p of primaries) if (domainFits(th.value, p.value)) addCompanyAlias(subject, { company: p.value, alias: th.value, origin: `found:${origin.id}` });
    }
  }
  let queued = 0;
  const learned = state.legalNames || (state.legalNames = {});
  const legalSources = connectors.filter((c) => LEGAL_NAME_SOURCES.has(c.id));
  for (const { name, origin } of candidates) {
    const owner = primaries.find((p) => extendsName(name, p.value));
    if (!owner) continue;
    const key = companyKeyStrict(name);
    if (learned[key]) continue;
    const added = addCompanyAlias(subject, { company: owner.value, alias: name, origin });
    if (!added && !subject.anchors.aliases?.has(key)) continue;
    learned[key] = { name: String(name).trim(), of: owner.value, origin };
    const thread = { kind: 'company', value: String(name).trim(), why: `legal name of ${owner.value}`, tie: 'primary' };
    const n = enqueue(state, planTasks(thread, owner.depth ?? 1, legalSources, subject, state));
    queued += n;
    state.log.push({ step: state.step, text: `Learned the legal name ${String(name).trim()} for ${owner.value}${n ? `: registers, filings, trademarks, lobbying, complaints and awards are asked again under it (${n} lookups)` : ''}.` });
  }
  return queued;
}

const ORIGIN_PREFIX = /^(?:given|found|weak|reader|inferred|network)(?::|$)/;
const IS_DOMAIN = (v) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(String(v || '')) && /\.[a-z]{2,}$/i.test(String(v || ''));

/**
 * Follow every name and domain a company of the person has gained since the last step, however it was learned:
 * a filing (learnLegalNames), the company's own site footer read by a source (the page reader registers it
 * itself), or the company facts read from the records (companyFacts.learnCompanyNames). Once each:
 *   a legal name   the registers, SEC, trademarks, lobbying, complaints, awards, the entity register and the
 *                  breach and leak sources are asked under it, and the court and enforcement sources are asked
 *                  about the company once more (they search every known name when they run)
 *   a domain       followed like a website the user gave: the domain sources look at it
 * Never a clue the second reader proposed. Returns how many lookups were queued.
 */
function followCompanyNames(state, subject, connectors) {
  if (typeof companyFactsApi.learnCompanyNames === 'function' && subject.company) {
    try {
      const before = new Set(subject.anchors.aliases ? subject.anchors.aliases.keys() : []);
      companyFactsApi.learnCompanyNames(subject, state.findings, Object.values(state.threads));
      // It names the record a name came from by its id alone: the origin says how strongly that record is tied,
      // so the record is never later re-graded on the name it produced itself.
      for (const [key, a] of subject.anchors.aliases || []) {
        if (before.has(key) || ORIGIN_PREFIX.test(String(a.origin || ''))) continue;
        const f = state.findings.find((x) => x.id === a.origin);
        a.origin = f && f.match === 'confirmed' && !f.assumedTie ? `found:${a.origin}` : `weak:${a.origin}`;
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') console.warn(`[deep-check] company names not read: ${String(error?.message || error).slice(0, 200)}`);
    }
  }
  const aliases = subject.anchors.aliases;
  if (!aliases || !aliases.size) return 0;
  const followed = state.aliasesFollowed || (state.aliasesFollowed = []);
  const primaries = primaryCompanies(state, subject);
  const legalSources = connectors.filter((c) => LEGAL_NAME_SOURCES.has(c.id));
  const courtSources = connectors.filter((c) => ALIAS_COURT_SOURCES.has(c.id));
  let queued = 0;
  for (const [key, a] of aliases) {
    if (followed.includes(key) || READER_ORIGIN.test(String(a.origin || ''))) continue;
    const owner = primaries.find((p) => anchorKey('company', p.value) === a.of);
    if (!owner) continue; // not (yet) a company the person founded or runs: looked at again next step
    followed.push(key);
    const depth = Math.min(owner.depth ?? 1, LIMITS.maxDepth);
    if (IS_DOMAIN(a.value)) {
      const origin = ORIGIN_PREFIX.test(String(a.origin || '')) ? a.origin : 'weak';
      const record = noteThread(state, subject, { kind: 'domain', value: a.value, why: `website of ${owner.value}`, trusted: true }, depth, null, { anchor: origin });
      const n = record ? pullThread(state, subject, record, connectors) : 0;
      queued += n;
      if (n) state.log.push({ step: state.step, text: `Learned the website ${a.value} for ${owner.value}: it is looked at too (${n} lookups).` });
      continue;
    }
    let n = 0;
    const legal = state.legalNames || (state.legalNames = {});
    if (!legal[key]) {
      legal[key] = { name: String(a.value).trim(), of: owner.value, origin: a.origin };
      n += enqueue(state, planTasks({ kind: 'company', value: String(a.value).trim(), why: `legal name of ${owner.value}`, tie: 'primary' }, depth, legalSources, subject, state));
    }
    if (owner.pulled && courtSources.length) {
      n += enqueue(state, planTasks(owner, depth, courtSources, subject, state).map((t) => ({ ...t, asAlias: String(a.value).trim() })));
    }
    queued += n;
    if (n) state.log.push({ step: state.step, text: `${owner.value} is also known as ${String(a.value).trim()}: registers, filings, courts and enforcement sources are asked again with it (${n} lookups).` });
  }
  return queued;
}

/**
 * Countries of the register entries tied to the person (a Norwegian or Finnish register, the entity register's
 * jurisdiction). The open-web source chooses its local-language pass from these. Never a home or residence field.
 */
function noteCountries(state, kept) {
  for (const f of kept) {
    if ((f.match !== 'confirmed' && f.match !== 'likely') || f.assumedTie) continue;
    if (!OFFICIAL_SOURCES.has(f.source) && !f.data?.registerNumber) continue;
    const raw = typeof f.data?.country === 'string' ? f.data.country : typeof f.data?.jurisdiction === 'string' ? f.data.jurisdiction.split('-')[0] : '';
    const country = raw.replace(/\s+/g, ' ').trim();
    if (!country || country.length > 40 || /\d/.test(country)) continue;
    const countries = state.countries || (state.countries = []);
    if (!countries.some((c) => c.toLowerCase() === country.toLowerCase()) && countries.length < 5) countries.push(country);
  }
}

/** The founding year of the company given, once the records state one (companyFacts). */
function noteCompanyFounded(state, subject) {
  if (!subject.company || typeof companyFactsApi.buildCompanyFacts !== 'function') return;
  try {
    const year = Number(companyFactsApi.buildCompanyFacts(subject, state.findings, Object.values(state.threads))?.founded?.year);
    if (Number.isInteger(year) && year > 1800) { state.companyFounded = year; subject.foundedYear = year; }
  } catch {
    // the founding year only sharpens the domain check; without it the dates are shown side by side
  }
}

/**
 * Run one step: as many queued lookups as fit before `deadline`.
 * Mutates and returns `state`.
 * @param {object} state from startState or a previous step
 * @param {{ connectors: Array, deadline?: number, limits?: object, review?: Function }} options
 *   review(state, { deadline }) -> { threads, searches }: the second reader
 *   (gaps.findGaps). Optional; without it the loop simply stops when dry. A reader that throws, times out
 *   or says it did not answer (`failed: true`) is reported as such, never as "found nothing more".
 */
export async function stepDeepCheck(state, { connectors, deadline = Date.now() + LIMITS.stepMs, limits = LIMITS, review = null } = {}) {
  if (state.phase !== 'collect') return { state, progress: summarize(state) };
  if (!state.missed) state.missed = [];
  if (!state.screened) state.screened = {};
  const subject = restoreFrom(state);
  const byId = new Map(connectors.map((c) => [c.id, c]));
  const screenCap = limits.maxTasks + Math.ceil(limits.maxTasks * SCREEN_RESERVE);

  // The loop ran dry last round: let the second reader look for what was missed before giving up.
  if (state.needsReview) {
    state.needsReview = false;
    state.reviews = (state.reviews || 0) + 1;
    let added = 0;
    let found = null;
    let failed = typeof review !== 'function';
    if (!failed) {
      try {
        found = await withTimeout(Promise.resolve().then(() => review(state, { deadline: Math.min(deadline - 3000, Date.now() + 22000) })), Math.max(1000, Math.min(deadline - 2500, Date.now() + 23000) - Date.now()));
        if (!found || typeof found !== 'object' || found.failed) failed = true;
      } catch {
        failed = true;
      }
    }
    const fresh = [];
    // What the reader proposes may order and pull lookups, but is never proof: its anchors cannot raise a
    // record on their own until a record bears them out.
    for (const th of (!failed && Array.isArray(found.threads) ? found.threads : [])) {
      const record = noteThread(state, subject, th, 1, null, { anchor: 'reader' });
      if (record) fresh.push(record);
    }
    for (const record of fresh) added += pullThread(state, subject, record, connectors);
    const searcher = byId.get('web-search');
    const searches = !failed && Array.isArray(found.searches) ? found.searches : [];
    if (searcher && sourceOn(searcher, state)) {
      added += enqueue(state, searches.map((query) => ({
        connector: searcher.id, kind: 'subject', value: subject.name, depth: 1,
        template: GAP_TEMPLATE, params: { query }, prior: 0.5, why: 'a gap the review of the records pointed to', relation: null,
      })));
    }
    state.anchors = exportAnchors(subject);
    if (failed) {
      // Not an empty answer: nothing was learned, and nothing queued is thrown away for it.
      state.log.push({ step: state.step, text: 'The second reading of the records did not answer in time; the check carries on without it.' });
      if (!state.queue.length) {
        if ((state.reviews || 0) < (limits.maxReviews ?? 0) && typeof review === 'function') {
          state.needsReview = true; // one more try at the next step
          return { state, progress: summarize(state) };
        }
        state.phase = 'report';
        return { state, progress: summarize(state) };
      }
    } else if (added > 0) {
      state.drySteps = 0;
      state.log.push({ step: state.step, text: `A second reading of the records found ${fresh.length} more thread${fresh.length === 1 ? '' : 's'} and ${searches.length} more search${searches.length === 1 ? '' : 'es'} to run.` });
    } else {
      state.log.push({ step: state.step, text: 'A second reading of the records found nothing more to follow.' });
      // The loop was dry: what is still queued is dropped (and reported as not run), except the screens.
      const others = state.queue.filter((t) => !isScreenTask(t));
      if (others.length) markNotRun(state, others, byId);
      state.queue = state.queue.filter(isScreenTask);
      if (!state.queue.length) {
        state.phase = 'report';
        return { state, progress: summarize(state) };
      }
    }
  }

  if (state.step === 0 && state.queue.length === 0 && state.tasksRun === 0) {
    enqueue(state, planTasks({ kind: 'subject', value: subject.name, why: 'the person being checked' }, 0, connectors, subject, state));
    const seeds = [];
    if (subject.company) seeds.push({ kind: 'company', value: subject.company, why: GIVEN_COMPANY, trusted: true });
    if (state.assumedCompany) seeds.push({ kind: 'company', value: state.assumedCompany, why: ASSUMED_COMPANY, trusted: true });
    const given = state.given || {};
    for (const c of given.otherCompanies || []) seeds.push({ kind: 'company', value: c, why: EARLIER_COMPANY_GIVEN, trusted: true });
    if (given.school) seeds.push({ kind: 'school', value: given.school, why: 'school given', trusted: true });
    // Other names the user typed are searched and screened like the name, where sources take them
    if (THREAD_KINDS.includes('alias')) for (const n of state.otherNames || []) seeds.push({ kind: 'alias', value: n, why: 'other name given', trusted: true });
    if (given.website) seeds.push({ kind: 'domain', value: given.website, why: 'company website given', trusted: true });
    if (given.profile?.domain) seeds.push({ kind: 'domain', value: given.profile.domain, why: 'personal website given', trusted: true });
    // A LinkedIn handle only ties records to the person: LinkedIn is never opened or searched as a handle.
    if (given.profile?.handle && given.profile.platform !== 'linkedin') seeds.push({ kind: 'handle', value: given.profile.handle, why: `${given.profile.platform || 'profile'} handle given`, platform: given.profile.platform || null, trusted: true });
    for (const th of seeds) {
      const origin = { anchor: th.why === ASSUMED_COMPANY ? 'network' : 'given' };
      const record = noteThread(state, subject, th, 1, null, origin);
      if (record) pullThread(state, subject, record, connectors);
    }
    // A source that is off because a fuller one replaced it is not something that failed to answer
    const isOn = (c) => sourceOn(c, state);
    const off = connectors.filter((c) => !isOn(c) && !(c.replacedBy && connectors.some((o) => o.id === c.replacedBy && isOn(o))));
    for (const c of off) if (!state.sources[c.id]) state.sources[c.id] = { label: c.label, runs: 0, findings: 0, errors: 0, ms: 0, off: true, lastError: c.unavailableReason || 'Not enabled on this deployment.' };
  }

  // Best-first: what kind of thread it is, how deep, and what this source and query pattern have yielded before.
  const stats = await loadStats('query');
  const priors = new Map();
  for (const t of state.queue) if (!priors.has(learnKey(t))) priors.set(learnKey(t), t.prior);
  const learned = new Map(rankByLearning([...priors].map(([key, prior]) => ({ key, prior })), stats).map((x) => [x.key, x.score]));
  // A thread several records point to (a company named again and again) goes before one seen once.
  const attested = (t) => 1 + Math.min(5, (state.threads[threadKey(t)]?.support || 1) - 1) * 0.08;
  // The seed goes first whatever learning says: when the search engines are short of allowance, the lookups
  // that tell who the person is must be the ones that get it. The screens come next, also outside learning:
  // a clean screen is their normal answer, and learning would push them to the end, where they go unrun.
  const tierOf = (t) => (isSeedTask(t) ? 2 : isScreenTask(t) ? 1 : 0);
  const order = state.queue
    .map((t, i) => ({ t, i, tier: tierOf(t), score: (KIND_WEIGHT[t.kind] ?? 0.5) * (DEPTH_WEIGHT[t.depth] ?? 0.4) * (tierOf(t) === 1 ? 1 : (0.4 + (learned.get(learnKey(t)) ?? 0.5))) * attested(t) }))
    .sort((x, y) => y.tier - x.tier || y.score - x.score || x.i - y.i)
    .map((x) => x.t);

  // The budget: everything but the screens stops at maxTasks; the screens may use a reserve beyond it.
  const batch = [];
  let planned = state.tasksRun;
  for (const t of order) {
    if (isScreenTask(t) ? planned < screenCap : planned < limits.maxTasks) { batch.push(t); planned += 1; }
  }
  const seenIds = new Set(state.findings.map((f) => f.id));
  const seenUrls = new Set(state.findings.map(pageKey));
  const byQuote = new Map();
  for (const f of state.findings) { const k = quoteKey(f); if (k && !byQuote.has(k)) byQuote.set(k, f); }
  // the kept copy of each record, by id and by page, so a stronger read of it can lift its grade
  const keptBy = new Map();
  for (const f of state.findings) { if (!keptBy.has(`id:${f.id}`)) keptBy.set(`id:${f.id}`, f); if (!keptBy.has(`page:${pageKey(f)}`)) keptBy.set(`page:${pageKey(f)}`, f); }
  for (const f of state.findings) { const alias = wikiAlias(f); if (alias && !keptBy.has(`wiki:${alias}`)) keptBy.set(`wiki:${alias}`, f); }
  const perSource = {};
  for (const f of state.findings) perSource[f.source] = (perSource[f.source] || 0) + 1;

  const taken = new Set(); // lookups of the batch already claimed
  const inFlight = new Map(); // connector id -> lookups running now
  const release = (id) => inFlight.set(id, Math.max(0, (inFlight.get(id) || 1) - 1));
  const claim = () => {
    const now = Date.now();
    for (let i = 0; i < batch.length; i += 1) {
      if (taken.has(batch[i])) continue;
      if (batch[i].notBefore && batch[i].notBefore > now) continue; // its host is resting
      const source = byId.get(batch[i].connector);
      const limit = source?.maxParallel || Infinity;
      if ((inFlight.get(batch[i].connector) || 0) >= limit) continue; // that source is busy: leave it queued
      taken.add(batch[i]);
      inFlight.set(batch[i].connector, (inFlight.get(batch[i].connector) || 0) + 1);
      return batch[i];
    }
    return null;
  };
  let newFindings = 0;
  const newThreads = [];
  const newlyKept = [];
  const outcomes = [];
  const reliability = [];
  // Lookups that ran this step: key -> 'ok' (answered) or 'missed' (failed, or a watchlist that answered only in part)
  const ran = new Map();
  // Lookups that will not run (refused before any request, no such source): recorded once the workers stop
  const notRun = [];
  // What a source may read about the check so far: who the person is tied to, the records already
  // collected (so it does not say "nothing ties them to X" when an earlier record does), and the pages
  // already tied to them (so a guessed address is not preferred over a known one). Read-only copies.
  const ctxBase = {
    subject,
    known: () => exportAnchors(subject),
    findings: () => state.findings.slice(),
    // the lookups already asked, as `source|kind|value|pattern` (so a source can keep to a per-check limit)
    done: () => [...(state.done || []), ...(state.missed || [])],
    knownUrls: () => Object.values(state.threads).filter((t) => t.kind === 'url' && t.trusted).map((t) => t.value),
    // A per-check counter kept on the state (live within a step, saved across steps): takes n under `key`
    // when the total stays within max, so a source can bound its requests even while its lookups run in parallel.
    spend: (key, n = 1, max = Infinity) => {
      const spent = state.spent || (state.spent = {});
      if ((spent[key] || 0) + n > max) return false;
      spent[key] = (spent[key] || 0) + n;
      return true;
    },
  };

  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline - 2500) return;
      const task = claim();
      if (!task) {
        // Nothing to run now. If a lookup waits for a resting host that is back well before the deadline,
        // wait for it rather than ending the step (and spinning through empty steps).
        const next = Math.min(...batch.filter((t) => !taken.has(t) && t.notBefore && t.notBefore > Date.now()).map((t) => t.notBefore));
        if (Number.isFinite(next) && next < deadline - 6000) { await sleep(next - Date.now() + 5); continue; }
        // The next one is free only after this step ends: wait out most of the step rather than return at once
        if (Number.isFinite(next) && ran.size === 0 && Date.now() < deadline - 8000) { await sleep(Math.min(next, deadline - 6000) - Date.now()); continue; }
        return;
      }
      const c = byId.get(task.connector);
      const key = taskKey(task);
      if (!c) { release(task.connector); notRun.push(task); continue; }
      ran.set(key, 'running');
      const started = Date.now();
      const taskDeadline = Math.min(deadline, started + (c.timeoutMs || limits.taskTimeoutMs));
      const stat = ensureStat(state, c.id, c.label);
      let result = null;
      let raw = null;
      try {
        raw = await withTimeout(Promise.resolve().then(() => c.run(task, { ...ctxBase, deadline: taskDeadline })), taskDeadline - started + 400);
        result = connectorResult(raw);
      } catch (error) {
        const message = String(error?.message || error);
        const code = error?.code;
        // A source that could not answer may say why in plain words (the SEC's website asks for a declared
        // contact): the reader sees that once, rather than only "could not be reached".
        const note = typeof error?.note === 'string' ? error.note.trim().slice(0, 400) : '';
        if (note && !state.log.some((l) => l.text === note)) state.log.push({ step: state.step, text: note });
        // The step ran out of time before this lookup got its turn (it was queued behind others for the
        // same host, or the step's deadline cut it short). That is not the source failing: run it next step.
        const cutShort = taskDeadline >= deadline - 50 && (code === 'deadline' || /out of time|timed out/i.test(message));
        if (cutShort && (task.retries || 0) < 2) {
          task.retries = (task.retries || 0) + 1;
          ran.delete(key);
          release(task.connector);
          continue;
        }
        // The host or the search engines said when they are free again: wait for that, within the check's limit.
        const retryAt = Number(error?.retryAt) || 0;
        const maxAge = limits.maxWaitAgeMs ?? LIMITS.maxWaitAgeMs;
        if (retryAt > Date.now() && (code === 'SEARCH_RESTING' || HOST_RESTING.test(message))) {
          ran.delete(key);
          release(task.connector);
          if (retryAt - (state.startedAt || Date.now()) <= maxAge) {
            task.notBefore = retryAt;
            taken.delete(task);
            continue;
          }
          // Too long to wait in this check: not run, and said so; not a failure of the source, and never a clean screen
          notRun.push({ task, waited: true });
          continue;
        }
        // Its host is resting, or its turn could not come in time: put it back to run after the rest.
        if (HOST_RESTING.test(message) && (task.rests || 0) < (limits.maxRests ?? LIMITS.maxRests)) {
          task.rests = (task.rests || 0) + 1;
          task.notBefore = Date.now() + (limits.restMs ?? LIMITS.restMs);
          ran.delete(key);
          taken.delete(task);
          release(task.connector);
          continue;
        }
        // Refused before any request went out (an address the client never opens, a site the source does not
        // read), or a source that says it could not run this lookup: not opened, so neither a failure of the
        // source nor a clean result.
        if (code === 'blocked' || code === 'refused' || error?.notRun) {
          ran.delete(key);
          release(task.connector);
          notRun.push({ task });
          continue;
        }
        stat.errors += 1;
        stat.lastError = plainFailure(message, error);
        stat.lastErrorClass = failureClass(error);
        const classes = stat.errorClasses || (stat.errorClasses = {});
        classes[stat.lastErrorClass] = (classes[stat.lastErrorClass] || 0) + 1;
        if (process.env.NODE_ENV !== 'test') console.warn(`[deep-check] ${c.id} failed (${stat.lastErrorClass}): ${message.slice(0, 300)}`);
      }
      release(task.connector);
      const ms = Date.now() - started;
      stat.runs += 1;
      stat.ms += ms;
      reliability.push({ key: c.id, win: Boolean(result), ms });
      // A failed lookup says something about the source (reliability), not about the query pattern.
      if (!result) {
        ran.set(key, 'missed');
        noteScreen(state, task, false);
        noteWatchlistLookup(state, task, false);
        continue;
      }
      // Parts of a source that did not answer (state registers that timed out): listed, so the report does
      // not call them searched.
      const partial = Array.isArray(raw?.partial) && raw.partial.some((p) => String(p || '').trim());
      if (partial) for (const p of raw.partial) addPartial(stat, p);
      // A watchlist that answered only in part has not screened the person.
      const complete = !partial && !result.notes.some((n) => FAILED_NOTE.test(n));
      ran.set(key, isPersonScreen(task) && !complete ? 'missed' : 'ok');
      noteScreen(state, task, complete);
      noteWatchlistLookup(state, task, complete);
      // Another name read from a record (not typed by the user) ties a record to the person less surely than
      // their own name: what a lookup under it finds is likely at most, and held there (sources/alias.js does
      // the same; this holds for any source).
      const foundAlias = task.kind === 'alias' && !(state.otherNames || []).some((n) => personKey(n) === personKey(task.value));
      // Each record is graded again on what each anchor may do: a record confirmed only through a company
      // that came from a likely record, or that was only inferred or assumed, is at most "likely"; a clue the
      // second reader proposed does not count on its own.
      for (const f of result.findings) {
        if (foundAlias && f.match === 'confirmed') {
          f.match = 'likely';
          f.matchFixed = true;
          f.matchReasons = [...new Set([...(f.matchReasons || []), `found under ${String(task.value).slice(0, 80)}, another name read from a linked record`])].slice(0, 4);
          continue;
        }
        // A source never confirms a record by hand: a grade it fixed at "confirmed" stands only when the record
        // confirms on its own against what is known; otherwise it is held at likely.
        if (f.matchFixed && f.match === 'confirmed') {
          const graded = gradeOf(subject, f.gradeText || `${f.title}\n${f.quote || ''}`, gradeDateOf(f), f.id);
          if (graded.level !== 'confirmed') {
            f.match = 'likely';
            f.matchReasons = [...new Set([...(f.matchReasons || []), 'held at likely: a source\'s own grade never confirms a record'])].slice(0, 4);
          }
          continue;
        }
        if (f.matchFixed || (f.match !== 'confirmed' && f.match !== 'likely')) continue;
        const graded = gradeOf(subject, f.gradeText || `${f.title}\n${f.quote || ''}`, gradeDateOf(f), f.id);
        if (matchRank(graded.level) <= matchRank(f.match)) applyGrade(f, graded);
      }
      let strong = 0;
      let weak = 0;
      for (const f of result.findings) {
        const dupKey = pageKey(f);
        const copyOf = wikiCopyOf(f);
        if (seenIds.has(f.id) || (seenUrls.has(dupKey) && (f.category !== 'archive' || isArchiveSummary(f))) || (copyOf && keptBy.has(`wiki:${copyOf}`))) {
          // another source (or pattern) found the same record: partial credit, not none
          const kept = (seenIds.has(f.id) && keptBy.get(`id:${f.id}`)) || keptBy.get(`page:${dupKey}`);
          // A copy of an article the Wikipedia source holds is dropped; it never re-grades the article's records.
          if (kept) upgradeKept(kept, f);
          tagPerson(kept || (copyOf && keptBy.get(`wiki:${copyOf}`)), task);
          if (f.match === 'possible') weak += 0.5; else strong += 0.5;
          continue;
        }
        // The same passage on another page of the same source (one testimonial in three filings) is one record
        const qk = quoteKey(f);
        const twin = qk ? byQuote.get(qk) : null;
        if (twin && urlKey(twin.url) !== urlKey(f.url) && (matchRank(f.match) <= matchRank(twin.match) || upgradeKept(twin, f))) {
          tagPerson(twin, task);
          const alsoIn = twin.data?.alsoIn || [];
          if (f.url && !alsoIn.includes(f.url) && alsoIn.length < 8) twin.data = { ...(twin.data || {}), alsoIn: [...alsoIn, f.url] };
          seenIds.add(f.id);
          seenUrls.add(dupKey);
          if (f.match === 'possible') weak += 0.5; else strong += 0.5;
          continue;
        }
        if (state.findings.length >= limits.maxFindings || (perSource[f.source] || 0) >= limits.maxPerSource) { state.dropped.findings += 1; continue; }
        seenIds.add(f.id);
        seenUrls.add(dupKey);
        perSource[f.source] = (perSource[f.source] || 0) + 1;
        // A record found while looking at an associate or relative is filed under that person in the report
        const about = task.kind === 'associate' || task.kind === 'relative' ? { data: { ...(f.data || {}), person: f.data?.person || task.value } } : {};
        const kept = { ...f, ...about, step: state.step, via: task.kind === 'subject' ? null : `${task.kind}: ${task.value}` };
        // The Wikipedia source's article replaces a copy of it another source kept earlier
        const alias = wikiAlias(kept);
        if (alias && !keptBy.has(`wiki:${alias}`)) {
          for (const copy of state.findings.filter((x) => wikiCopyOf(x) === alias)) {
            state.findings.splice(state.findings.indexOf(copy), 1);
            perSource[copy.source] = Math.max(0, (perSource[copy.source] || 1) - 1);
            if (state.sources[copy.source]?.findings) state.sources[copy.source].findings -= 1;
          }
          keptBy.set(`wiki:${alias}`, kept);
        }
        state.findings.push(kept);
        newlyKept.push(kept);
        if (qk && !byQuote.has(qk)) byQuote.set(qk, kept);
        if (!keptBy.has(`id:${f.id}`)) keptBy.set(`id:${f.id}`, kept);
        if (!keptBy.has(`page:${dupKey}`)) keptBy.set(`page:${dupKey}`, kept);
        stat.findings += 1;
        newFindings += 1;
        if (f.match === 'possible') weak += 1; else strong += 1;
      }
      for (const th of result.threads) newThreads.push({ th, depth: task.depth + 1, evidence: evidenceFor(task, result.findings, th), origin: threadOrigin(subject, task, result.findings, th) });
      for (const note of result.notes) if (!state.log.some((l) => l.text === note)) state.log.push({ step: state.step, text: note });
      // Screens are left out of query learning: "no match" is their normal answer, not a lookup that failed.
      // A lookup answered only from headline feeds or the encyclopedia (raw.noLearn) says nothing about how well
      // its query pattern works: it neither teaches nor penalises it.
      if (!isScreenTask(task) && !raw?.noLearn) outcomes.push({ key: learnKey(task), win: strong >= 1 ? 1 : strong > 0 ? 0.5 : weak > 0 ? 0.4 : result.threads.length ? 0.25 : 0, ms });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limits.concurrency) }, worker));

  state.tasksRun += ran.size;
  for (const [key, status] of ran) {
    if (status === 'ok') state.done.push(key);
    else if (!state.missed.includes(key)) state.missed.push(key);
  }
  const notRunTasks = notRun.map((x) => (x.task ? x : { task: x }));
  const waitedOut = notRunTasks.filter((x) => x.waited).map((x) => x.task);
  const refused = notRunTasks.filter((x) => !x.waited).map((x) => x.task);
  if (waitedOut.length) markNotRun(state, waitedOut, byId, { waited: true });
  if (refused.length) markNotRun(state, refused, byId);
  const gone = new Set([...ran.keys(), ...notRunTasks.map((x) => taskKey(x.task))]);
  state.queue = state.queue.filter((t) => !gone.has(taskKey(t)));

  // Read what came back for new threads, then pull them.
  let pulled = 0;
  const fresh = [];
  for (const { th, depth, evidence, origin } of newThreads) {
    let thread = th;
    if (thread?.trusted) {
      // A likely grade that rests only on an encyclopedia link, an event or a name written surname first does
      // not make what the record leads to trusted (identity.js basis).
      const basis = Array.isArray(origin.basis) ? origin.basis : [];
      if (origin.level === 'likely' && basis.length && basis.every((b) => WEAK_BASIS.has(b))) thread = { ...thread, trusted: false };
    }
    // A thread from a confirmed record may confirm others; one from a likely (or assumed) record only makes them likely.
    const anchor = origin.level === 'confirmed' && !origin.assumed ? `found:${origin.id}` : `weak:${origin.id}`;
    const record = noteThread(state, subject, thread, depth, evidence, { anchor, venture: origin.venture });
    if (record) fresh.push(record);
  }
  // Only so many threads of each kind are pulled: take the best attested first
  fresh.sort((a, b) => (b.support || 1) - (a.support || 1));
  for (const record of fresh) pulled += pullThread(state, subject, record, connectors);
  for (const record of readNameAliases(state, subject, newlyKept)) pulled += pullThread(state, subject, record, connectors);
  pulled += resolveIdentity(state, subject, connectors);
  pulled += learnLegalNames(state, subject, connectors, newlyKept, newThreads);
  noteCountries(state, newlyKept);
  if (newlyKept.length) noteCompanyFounded(state, subject);
  pulled += followCompanyNames(state, subject, connectors);
  const upgraded = regrade(state, subject);
  state.anchors = exportAnchors(subject);

  await Promise.all([recordStats('query', outcomes), recordStats('source', reliability)]);

  const PLURAL = { alias: 'other names', company: 'companies', school: 'schools', associate: 'associates', relative: 'relatives', handle: 'handles', domain: 'domains', url: 'pages' };
  const kinds = fresh.reduce((m, t) => { m[t.kind] = (m[t.kind] || 0) + 1; return m; }, {});
  const kindsText = Object.entries(kinds).map(([kind, n]) => `${n} ${n === 1 ? (kind === 'url' ? 'page' : kind) : PLURAL[kind] || `${kind}s`}`).join(', ');
  state.log.push({ step: state.step, text: `Round ${state.step + 1}: ${ran.size} lookups, ${newFindings} new records${fresh.length ? `, ${fresh.length} new threads to pull (${kindsText})` : ''}${upgraded ? `, ${upgraded} earlier records now tied to the person` : ''}.` });

  // Nothing ran because every remaining lookup waits for a resting host: not a round, and not a dry one.
  // But a check does not sit idle for minutes for its last few lookups: when only waiting lookups are left
  // and the next is more than tailWaitMs away, they are reported as not run and the check moves on.
  if (ran.size === 0 && state.queue.some((t) => t.notBefore && t.notBefore > Date.now())) {
    const waiting = state.queue.filter((t) => t.notBefore && t.notBefore > Date.now());
    const next = Math.min(...waiting.map((t) => t.notBefore));
    const onlyWaiting = waiting.length === state.queue.length;
    if (onlyWaiting && next - Date.now() > (limits.tailWaitMs ?? LIMITS.tailWaitMs)) {
      markNotRun(state, waiting, byId, { waited: true });
      state.queue = state.queue.filter((t) => !waiting.includes(t));
      state.log.pop();
      state.log.push({ step: state.step, text: `${waiting.length} last lookup${waiting.length === 1 ? '' : 's'} not run: ${waiting.length === 1 ? 'its source' : 'their sources'} asked to wait more than a minute and a half.` });
    } else {
      state.log.pop();
      return { state, progress: summarize(state) };
    }
  }

  state.step += 1;
  // A round only counts as dry when lookups actually ran and found nothing, and no screen is still waiting to run
  const screensLeft = state.queue.some(isScreenTask);
  state.drySteps = ran.size > 0 && newFindings === 0 && fresh.length === 0 && pulled === 0 && !screensLeft ? state.drySteps + 1 : ran.size > 0 ? 0 : state.drySteps;
  const spent = state.tasksRun >= limits.maxTasks;
  const dry = state.queue.length === 0 || state.drySteps >= limits.dryStepsToStop;
  if (dry && !spent && state.step < limits.maxSteps && typeof review === 'function' && (state.reviews || 0) < (limits.maxReviews ?? 0) && state.findings.length > 0) {
    // Not finished yet: the next step starts with a second reading of the records.
    state.needsReview = true;
  } else if (state.queue.length === 0 || spent || state.step >= limits.maxSteps || state.drySteps >= limits.dryStepsToStop) {
    const others = state.queue.filter((t) => !isScreenTask(t));
    if (others.length) {
      markNotRun(state, others, byId);
      state.log.push({ step: state.step, text: `Stopped with ${others.length} lookups not run (${spent ? 'the lookup budget for one check was reached' : state.drySteps >= limits.dryStepsToStop ? 'the last rounds found nothing new' : 'the round limit was reached'}).` });
    }
    state.queue = state.queue.filter(isScreenTask);
    // The screens still queued run before the report, within their reserve and a few more rounds.
    if (state.queue.length && state.tasksRun < screenCap && state.step < limits.maxSteps + SCREEN_EXTRA_STEPS) {
      if (!state.log.some((l) => l.text.startsWith('Finishing the watchlist'))) state.log.push({ step: state.step, text: `Finishing the watchlist, court and regulator screens (${state.queue.length} left) before the report.` });
    } else {
      if (state.queue.length) {
        markNotRun(state, state.queue, byId);
        state.log.push({ step: state.step, text: `${state.queue.length} screen lookup${state.queue.length === 1 ? '' : 's'} not run: the check reached its limits first. They are reported as not run.` });
      }
      state.queue = [];
      state.phase = 'report';
    }
  }
  return { state, progress: summarize(state) };
}

/** Progress for a state without running anything. */
export function progressOf(state) {
  return summarize(state);
}

/**
 * End the collecting phase now (a step that keeps failing, an operator stop): every lookup still queued is
 * recorded as not run, so the report states what was not asked rather than showing it as clean.
 */
export function stopCollecting(state, reason) {
  if (!state || state.phase !== 'collect') return state;
  if (!state.missed) state.missed = [];
  if (!state.dropped) state.dropped = { tasks: 0, findings: 0, threads: 0 };
  if (state.queue?.length) { markNotRun(state, state.queue, null); state.queue = []; }
  state.needsReview = false;
  if (!Array.isArray(state.log)) state.log = [];
  if (reason) state.log.push({ step: state.step, text: reason });
  state.phase = 'report';
  return state;
}
