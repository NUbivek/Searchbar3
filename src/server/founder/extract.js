/**
 * Reading a record for new threads to pull: earlier companies and schools
 * (with the same extractor the quick brief uses), associates named beside
 * the person, relatives the source places in a public role, and the
 * handles and profile pages a record points to.
 *
 * Relatives are the sensitive part. A relative becomes a thread only when
 * the same sentence gives them a public business, political or
 * philanthropic role ("her father, the chairman of ...", "son of the
 * billionaire ..."). A relative mentioned only as family is ignored, and so
 * is anything about children (guardrails.js). The point is related-party
 * and conflict-of-interest diligence, not a family tree.
 */
import { extractFounderEvidence } from '../founderCheck';
import { makeThread } from './finding';
import { mentionsMinor, isSensitive } from './guardrails';

const NAME = "[A-ZÀ-Þ][a-zA-ZÀ-ÿ'’-]+(?:\\s+(?:[A-Z]\\.|de|van|von|bin|al|del|la|le|[A-ZÀ-Þ][a-zA-ZÀ-ÿ'’-]+)){1,3}";
const RELATION_WORDS = 'father|mother|brother|sister|husband|wife|spouse|partner|uncle|aunt|cousin|grandfather|grandmother|stepfather|stepmother|step-father|step-mother|father-in-law|mother-in-law|brother-in-law|sister-in-law|son-in-law|daughter-in-law|fianc[ée]e?';
const DESCENT_WORDS = 'son|daughter|nephew|niece|grandson|granddaughter|stepson|stepdaughter|scion|heir|heiress';

// A public role: what makes a relative relevant to an investment decision.
// Ordinary jobs and verbs ("a software developer", "a history professor",
// "runs a small bakery", "director of photography") are not public roles:
// those words count only in the qualified forms of QUALIFIED_ROLE, which is
// case-sensitive so that what follows must be a proper name.
const PUBLIC_ROLE = /\b(CEO|CFO|COO|CTO|chief executive|chief \w+ officer|chair(?:man|woman|person)?|president|founder|co-?founder|billionaire|millionaire|magnate|mogul|tycoon|financier|banker|investor|venture capitalist|hedge fund|private equity|fund manager|managing director|general partner|partner at|board member|trustee|philanthropist|industrialist|oligarch|senator|congress(?:man|woman)|representative|governor|mayor|minister|ambassador|diplomat|judge|admiral|politician|member of parliament|\bMP\b|lawmaker|commissioner|secretary of|prime minister|royal|sheikh|family (?:business|office|firm|fortune|company|foundation|trust)|conglomerate|dynasty|empire|seed(?:ed)? (?:investor|money|capital))\b/i;
const QUALIFIED_ROLE = /\b(?:[Rr]eal[ -]estate developer|[Pp]roperty developer|(?:[Mm]anaging |[Nn]on-executive )?[Dd]irector (?:of|at) [A-Z][\w&.-]*|(?:[Dd]irector|[Hh]ead) of [a-z][a-z -]{2,40} (?:at|for) [A-Z][\w&.-]*|(?:[Oo]wner|[Ff]ounder|[Hh]ead) of [A-Z][\w&.-]*|(?:runs|heads|controls|owns|founded) [A-Z][\w&.-]+(?: (?:Inc|LLC|Ltd|Group|Holdings|Capital|Partners|Corp)\.?)?|[Ee]xecutive (?:at|of) [A-Z][\w&.-]*)/;
/** The first public role named in `text` (a match array), or null. */
const matchRole = (text) => {
  const a = text.match(PUBLIC_ROLE);
  const b = text.match(QUALIFIED_ROLE);
  if (a && b) return a.index <= b.index ? a : b;
  return a || b;
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Abbreviations whose full stop does not end a sentence ("SEC v. Acme", "Acme Inc. said").
const ABBREVIATION = /\b(v|vs|Inc|Corp|Ltd|Co|Mr|Mrs|Ms|Dr|Jr|Sr|St|No|Prof|Gen|Sen|Rep|Gov)\.(?=\s)/g;
const sentencesOf = (text) => String(text || '').replace(/\s+/g, ' ').replace(ABBREVIATION, '$1\u0001')
  .split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((s) => s.replace(/\u0001/g, '.').trim()).filter((s) => s.length > 12 && s.length < 600);

/**
 * The sentences that are about the subject: the ones that name them, and
 * the ones that follow and carry on with a pronoun ("She founded ...").
 */
function sentencesAbout(subject, text) {
  const out = [];
  let named = false;
  for (const sentence of sentencesOf(text)) {
    if (subject.hasName(sentence)) { named = true; out.push(sentence); } else if (named && /^(She|He|They|Her|His|Their)\b/.test(sentence)) out.push(sentence);
    else if (!/^(She|He|They|Her|His|Their)\b/.test(sentence)) named = false;
  }
  return out;
}
const cleanName = (raw) => String(raw || '').replace(/[’']s$/, '').replace(/[,.;:]+$/, '').trim();
const NOT_NAMES = /^(The|A|An|He|She|They|His|Her|Their|This|That|It|In|On|At|And|But|Mr|Mrs|Ms|Dr|Sir|Lady|Lord|New York|San Francisco|Los Angeles|United States|Silicon Valley|Wall Street|Y Combinator)\b/;

function plausiblePerson(name, subject) {
  const n = cleanName(name);
  const parts = n.split(/\s+/);
  if (parts.length < 2 || parts.length > 5 || n.length > 60) return null;
  if (NOT_NAMES.test(n) || subject.hasName(n)) return null;
  if (/\b(Inc|LLC|Ltd|Corp|Capital|Ventures|Partners|University|College|School|Bank|Group|Holdings|Foundation|Institute|Company|Fund|Labs?|Technologies)\b/.test(n)) return null;
  return n;
}

/**
 * The public role a sentence gives to `name`: a role word right after the
 * name ("John Roe, chairman of ...") or just before it ("billionaire John
 * Roe"). A role that belongs to the subject ("Acme founder Jane Doe's
 * brother John Roe") does not count, so the words before the name are only
 * read from where the subject's own name ends.
 */
function roleNear(subject, sentence, name) {
  const at = sentence.indexOf(name);
  if (at < 0) return null;
  const after = matchRole(sentence.slice(at + name.length, at + name.length + 90));
  if (after) return after;
  let before = sentence.slice(Math.max(0, at - 48), at);
  for (const variant of subject.variants || [subject.name]) {
    const cut = before.toLowerCase().lastIndexOf(String(variant).toLowerCase());
    if (cut >= 0) before = before.slice(cut + String(variant).length);
  }
  return matchRole(before);
}

/**
 * Relatives named with a public role in the same sentence.
 * @returns {Array<{ name: string, relation: string, role: string, sentence: string }>}
 */
export function relativesFromText(subject, text) {
  const out = [];
  const seen = new Set();
  const add = (rawName, relation, sentence) => {
    const name = plausiblePerson(rawName, subject);
    if (!name || seen.has(name.toLowerCase())) return;
    if (mentionsMinor(sentence) || isSensitive(sentence)) return;
    const role = roleNear(subject, sentence, cleanName(rawName));
    if (!role) return; // family only: not our business
    seen.add(name.toLowerCase());
    out.push({ name, relation: relation.toLowerCase().replace(/^step-/, 'step'), role: role[0], sentence });
  };
  for (const sentence of sentencesAbout(subject, text)) {
    // "her father, John Roe, chairman of ..." / "his brother John Roe"
    for (const m of sentence.matchAll(new RegExp(`\\b(?:[Hh]is|[Hh]er|[Tt]heir|whose)\\s+(?:late\\s+|older\\s+|younger\\s+|elder\\s+|twin\\s+|former\\s+|then-)?(${RELATION_WORDS})\\s*,?\\s+(${NAME})`, 'g'))) add(m[2], m[1], sentence);
    // "John Roe, her father and chairman of ..."
    for (const m of sentence.matchAll(new RegExp(`(${NAME}),\\s+(?:his|her|their)\\s+(${RELATION_WORDS})\\b`, 'g'))) add(m[1], m[2], sentence);
    // "the son of billionaire John Roe" / "daughter of John Roe, founder of ..."
    for (const m of sentence.matchAll(new RegExp(`\\b(${DESCENT_WORDS})\\s+of\\s+(?:the\\s+)?(?:late\\s+)?(?:[a-z-]+\\s+){0,4}?(${NAME})`, 'g'))) {
      const relation = { son: 'parent', daughter: 'parent', stepson: 'stepparent', stepdaughter: 'stepparent', nephew: 'uncle or aunt', niece: 'uncle or aunt', grandson: 'grandparent', granddaughter: 'grandparent', scion: 'family', heir: 'family', heiress: 'family' }[m[1].toLowerCase()];
      add(m[2], relation, sentence);
    }
    // "married to John Roe, a partner at ..."
    for (const m of sentence.matchAll(new RegExp(`\\bmarried\\s+(?:to\\s+)?(${NAME})`, 'g'))) add(m[1], 'spouse', sentence);
  }
  return out;
}

/**
 * Does `text` itself state that `name` is a relative, in a sentence that
 * also gives a public role? Used to check a relative proposed by something
 * other than the patterns above (a model's reading of the record) against
 * the same rule. Returns { relation, role, sentence } or null.
 */
export function publicRelativeIn(subject, text, name) {
  const person = plausiblePerson(name, subject);
  if (!person) return null;
  const nameRe = new RegExp(`(?<![A-Za-z])${escapeRe(person)}(?![A-Za-z])`);
  const kin = new RegExp(`\\b(${RELATION_WORDS}|${DESCENT_WORDS}|married|parents?|sibling|relative|family)\\b`, 'i');
  for (const sentence of sentencesOf(text)) {
    if (!nameRe.test(sentence)) continue;
    const relation = sentence.match(kin);
    const role = roleNear(subject, sentence, person);
    if (!relation || !role) continue;
    if (mentionsMinor(sentence) || isSensitive(sentence)) continue;
    return { name: person, relation: relation[1].toLowerCase(), role: role[0], sentence };
  }
  return null;
}

/** A name that reads like a person's (two to five capitalised words, not an organisation, not the subject). */
export const plausiblePersonName = (name, subject) => plausiblePerson(name, subject);

/** People named beside the subject as co-founders, partners or co-defendants. */
export function associatesFromText(subject, text) {
  const out = new Map();
  const add = (rawName, why) => {
    const name = plausiblePerson(rawName, subject);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, why });
  };
  for (const sentence of sentencesAbout(subject, text)) {
    for (const m of sentence.matchAll(new RegExp(`\\bco-?founders?\\s+(?:and\\s+[A-Za-z ]{1,30}?\\s+)?(${NAME})(?:\\s+and\\s+(${NAME}))?`, 'g'))) {
      // "PayPal co-founders Elon Musk and Peter Thiel": co-founders of another company, not of the person's
      const lead = sentence.slice(Math.max(0, m.index - 40), m.index).match(/([A-Z][\w&.'-]+(?:\s+[A-Z][\w&.'-]+)?)\s*$/);
      const ofAnother = lead && !subject.hasName(lead[1]) && ![...subject.anchors.companies.values()].some((a) => a.test(lead[1]));
      if (ofAnother) continue;
      add(m[1], 'named as a co-founder');
      if (m[2]) add(m[2], 'named as a co-founder');
    }
    for (const m of sentence.matchAll(new RegExp(`(${NAME})\\s+and\\s+(${NAME})\\s*,?\\s+(?:the\\s+)?(?:co-?founders|founders|who\\s+(?:co-?)?founded)`, 'g'))) { add(m[1], 'named as a co-founder'); add(m[2], 'named as a co-founder'); }
    for (const m of sentence.matchAll(new RegExp(`\\b(?:co-?founded|founded|started|launched)\\s+[^.]{0,60}?\\s+(?:with|alongside|together with)\\s+(${NAME})(?:\\s+and\\s+(${NAME}))?`, 'g'))) { add(m[1], 'founded a company together'); if (m[2]) add(m[2], 'founded a company together'); }
    for (const m of sentence.matchAll(new RegExp(`\\b(?:co-?defendants?|co-?conspirators?|business partners?|longtime partner|former partner)\\s*,?\\s+(${NAME})`, 'g'))) add(m[1], 'named as a co-defendant or business partner');
    for (const m of sentence.matchAll(new RegExp(`\\b(?:v\\.|vs\\.?|versus)\\s+(?:[A-Z][A-Za-z.&' -]{0,40}?,\\s+)?(${NAME})\\s+and\\s+(${NAME})`, 'g'))) { add(m[1], 'co-party in a case'); add(m[2], 'co-party in a case'); }
  }
  return [...out.values()];
}

const PROFILE_HOSTS = [
  [/^(?:[a-z]{2,3}\.)?linkedin\.com$/, /^\/(?:in|pub)\/([^/?#]+)/, 'linkedin'],
  [/^github\.com$/, /^\/([A-Za-z0-9-]{2,39})\/?$/, 'github'],
  [/^(?:twitter|x)\.com$/, /^\/([A-Za-z0-9_]{2,15})\/?$/, 'x'],
  [/^(?:www\.)?crunchbase\.com$/, /^\/person\/([^/?#]+)/, 'crunchbase'],
  [/^(?:angel\.co|wellfound\.com)$/, /^\/(?:u|p)\/([^/?#]+)/, 'wellfound'],
  [/^about\.me$/, /^\/([^/?#]+)/, 'about.me'],
  [/^medium\.com$/, /^\/@([^/?#]+)/, 'medium'],
  [/^([a-z0-9-]+)\.substack\.com$/, null, 'substack'],
];
const NOT_HANDLES = new Set(['home', 'search', 'explore', 'login', 'signup', 'about', 'pricing', 'features', 'orgs', 'topics', 'i', 'intent', 'share', 'hashtag', 'company', 'jobs', 'pulse', 'feed']);

/**
 * A profile page and handle from a URL, when it is one.
 * @returns {{ platform: string, handle: string, url: string } | null}
 */
export function profileFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const [hostRe, pathRe, platform] of PROFILE_HOSTS) {
    const hm = host.match(hostRe);
    if (!hm) continue;
    const handle = pathRe ? (u.pathname.match(pathRe) || [])[1] : hm[1];
    if (!handle || NOT_HANDLES.has(handle.toLowerCase())) return null;
    return { platform, handle: decodeURIComponent(handle), url: `https://${host}${pathRe ? u.pathname.replace(/\/$/, '') : ''}` };
  }
  return null;
}

/**
 * Does this handle plausibly belong to the subject? It must contain one of
 * their full name slugs (firstlast, flast, lastfirst ...); a bare first name
 * or surname ("jack", "collison") is shared by too many people to fit.
 */
export function handleFitsSubject(subject, handle) {
  const h = String(handle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!h) return false;
  return subject.slugs.some((slug) => {
    const s = slug.replace(/[^a-z0-9]/g, '');
    return s.length > 0 && h.includes(s);
  });
}

/**
 * Every thread a web-style result (title, snippet, url) offers.
 * `trusted` says whether the result itself is tied to the subject; only
 * then are its threads followed.
 * @param {object} subject
 * @param {{ title?: string, snippet?: string, url?: string, date?: string }} result
 * @param {{ trusted: boolean }} options
 */
export function threadsFromResult(subject, result, { trusted }) {
  const threads = [];
  const title = String(result?.title || '');
  const snippet = String(result?.snippet || result?.content || '');
  const text = `${title}. ${snippet}`;
  // Companies and schools: the quick brief's extractor, run on this one result.
  const evidence = extractFounderEvidence({ name: subject.hasName, company: subject.company, results: [{ title, snippet, url: result?.url || 'https://example.invalid/', source: 'web' }], keepAllSources: true });
  for (const c of evidence.pastCompanies) {
    threads.push(makeThread('company', c.company, c.role ? `${c.role}${c.status === 'past' ? ' (past)' : ''}` : c.status === 'past' ? 'earlier company' : 'named with the person', { trusted }));
  }
  for (const e of evidence.education) threads.push(makeThread('school', e.school, 'named as their school', { trusted }));
  for (const a of associatesFromText(subject, text)) threads.push(makeThread('associate', a.name, a.why, { trusted }));
  for (const r of relativesFromText(subject, text)) threads.push(makeThread('relative', r.name, `${r.relation}; ${r.role}`, { trusted, relation: r.relation, role: r.role }));
  const profile = profileFromUrl(result?.url);
  // A profile is only as trusted as the result it came from: a title that
  // merely repeats the name ("John Smith (johnsmith) · GitHub") may be a namesake.
  if (profile && handleFitsSubject(subject, profile.handle)) {
    threads.push(makeThread('url', profile.url, `${profile.platform} profile`, { trusted, platform: profile.platform }));
    if (profile.platform === 'github' || profile.platform === 'x') threads.push(makeThread('handle', profile.handle, `${profile.platform} handle`, { trusted, platform: profile.platform }));
  }
  return threads.filter(Boolean);
}

/** A word-boundary test for an arbitrary phrase (used by connectors to check a page names something). */
export const mentions = (text, phrase) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(phrase)}(?![A-Za-z0-9])`, 'i').test(String(text || ''));
