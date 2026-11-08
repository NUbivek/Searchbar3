/**
 * Founder background check: purely extractive. Every item returned is a
 * sentence (or headline) copied verbatim from a fetched source, tagged with
 * the index of that source in `sources`. Nothing is inferred or written here.
 *
 * Name matching is strict: the full name on word boundaries, written in the
 * source as a capitalized proper name. The user's capitalization does not
 * matter ("arthur mensch" finds "Arthur Mensch"); a middle initial is also
 * matched without it ("Paul J. Graham" also finds "Paul Graham", and the
 * result says so). Initials in the source ("A. Mensch") and lowercase
 * common-word uses do not match.
 * LinkedIn's API is not used (it does not share profiles with ordinary
 * apps); public LinkedIn/Crunchbase profile pages are used only as they
 * appear in web search results (title and snippet).
 *
 * runFounderCheck: retrieve (web + news + profile snippets, curated index,
 * Hacker News, CourtListener) -> keep sources naming the person -> rank ->
 * extract sections -> AI-written brief with checked citations (free model
 * chain) or a quoted brief.
 */
import { searchCuratedForEntity, getCuratedIndexStatus } from '../utils/sources/curatedIndex';
import { searchHackerNews } from '../utils/sources/hackernewsAlgolia';
import { searchWeb, webSearchConfigured } from './search/retrieve';
import { chatComplete, PROVIDERS, providerEnabled } from './llm/providers';
import { validateAnswer } from './search/answer';
import { tierInfo } from '../utils/sourceTiers';
import { cleanText, formatDate, sourceLabel, sourceType, sentencesOf } from '../utils/evidence';

const USER_AGENT = 'Searchbar3-Research/1.0';
const QUERY_TIMEOUT_MS = 15000;
const MAX_SOURCES = 20;
const MAX_TIMELINE = 25;
const MAX_COMPANIES = 20;
const MAX_LITIGATION = 20;
const MAX_PRESS = 20;
const MAX_MENTIONS = 8;
const MAX_EDUCATION = 10;
// How close (in characters) the name must be to a role or legal word for a
// sentence to count as being about this person rather than someone else
// mentioned in it.
const NEAR_CHARS = 90;

export const LITIGATION_DISCLAIMER =
  'Absence of litigation or regulatory results here is NOT evidence of a clean record. These sources are news, Hacker News and (when configured) web search and CourtListener; they do not cover all courts, regulators or jurisdictions.';

const ROLE_WORD = "(?:co-?founders?|founders?|CEO|CTO|COO|CFO|CPO|CSO|CRO|CMO|CIO|chief\\s+[a-z]+\\s+officer|president|chair(?:man|woman|person)?|managing\\s+director|executive\\s+director|director|general\\s+partner|partner|VP|vice\\s+president|head\\s+of\\s+[a-z]+|researcher|research\\s+scientist|scientist|engineer|professor|investor|advis[eo]r|board\\s+member|executive|manager|analyst)";

const ROLE_RE = new RegExp(`\\b(?:found(?:ed|er|ers|ing)|co-?found(?:ed|er|ers)|joined|joins|left|leaves|departed|departs|served|serves|appointed|appoints|named|became|becomes|worked|works|hired|launched|launches|started|starts|led(?!\\s+by)|leads|runs|heads|promoted|stepped\\s+down|steps\\s+down|resigned|resigns|fired|ousted|returns?|rejoined|takes\\s+over|took\\s+over|graduated|studied|earned|previously|formerly|former|${ROLE_WORD})\\b`, 'i');

// Words that make a role sentence describe a past position.
const PAST_RE = /\b(former|formerly|ex-|previously|before that|earlier|prior to|stepped down|steps down|left|leaves|resigned|resigns|departed|departs|outgoing|then-|fired|ousted|was|were|had been)\b/i;

// Litigation: a strong legal term, a regulator, or a weaker term in a legal
// context. "settled in San Francisco after a probe into the market" no
// longer counts; "Settles SEC Fraud Charges" does.
const LEGAL_STRONG = /\b(lawsuits?|sued|sues|suing|litigation|indict(?:ed|ment)|plaintiffs?|defendants?|class[- ]action|subpoena(?:ed)?|convicted|injunction|bankruptcy|fraud|misconduct|court|regulators?|arrested|pleaded|guilty|felony|embezzle\w*|antitrust)\b/i;
const LEGAL_AGENCY = /\b(SEC|FTC|DOJ|CFTC|FCA|FBI|AMF|CMA|CNIL|ICO)\b/; // case-sensitive: "sec" is a second
const LEGAL_WEAK = /\b(charged|charges|settles?|settled|settlement|fined|fines|penalt(?:y|ies)|investigat(?:ion|ed|ing)|probe|allegations?|alleged(?:ly)?|regulatory|complaint|ruling|appeal|verdict|trial)\b/i;
const LEGAL_CONTEXT = /\b(legal|judge|law|attorney|lawyer|case|prosecutors?|securities|compliance|violations?|enforcement|regulator|authority|commission|tribunal)\b/i;

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_RE = /\b(19[89]\d|20\d\d)\b/g;

// A company name: one to four capitalized tokens (allowing &, ., -, digits).
const CO = "(?<co>[A-Z\\u00C0-\\u024F][A-Za-z\\u00C0-\\u024F0-9&.'-]*(?:\\s+(?:[A-Z\\u00C0-\\u024F][A-Za-z\\u00C0-\\u024F0-9&.'-]*|&|of|de|du|la)){0,3})";

/**
 * Make lowercase keywords in a pattern match with either capitalization
 * ("previously" also matches "Previously") without the `i` flag, which would
 * also make the company class [A-Z] match lowercase words.
 */
function ciFirst(src) {
  return src.replace(/(?<![\\\[<A-Za-z])([a-z])([a-z]+)/g, (m, a, rest) => `[${a.toUpperCase()}${a}]${rest}`);
}
const rx = (src) => new RegExp(ciFirst(src));

const COMPANY_PATTERNS = [
  { kind: 'past', re: rx(`\\b(?:previously|formerly|before that|earlier|prior to (?:that|this))\\s*,?\\s+(?:(?:she|he|they)\\s+)?(?:(?:was|worked|served|spent\\s+[^.]{1,25}?)\\s+)?(?:as\\s+)?(?:(?:an?|the)\\s+)?(?:[a-z][\\w-]*\\s+){0,3}?(?:at|with|for)\\s+${CO}`) },
  { kind: 'founded', re: rx(`\\b(?<role>co-?founded)\\s+${CO}`) },
  { kind: 'founded', re: rx(`\\b(?<role>founded)\\s+${CO}`) },
  { kind: 'founded', re: rx(`\\b(?<role>(?:co-?)?founder)\\s+(?:and\\s+[\\w-]+\\s+)?(?:of|at)\\s+${CO}`) },
  { kind: 'past', re: rx(`\\b(?:former|ex-|then-)\\s*(?:[A-Za-z-]+\\s+){0,3}?(?<role>${ROLE_WORD})\\s+(?:of|at)\\s+${CO}`) },
  { kind: 'role', re: rx(`\\b(?<role>${ROLE_WORD})\\s+(?:of|at)\\s+${CO}`) },
  { kind: 'past', re: rx(`\\b[Ee]x-${CO}`) },
  { kind: 'past', re: rx(`\\b(?:worked|spent\\s+[\\w\\s]{1,20}?)\\s+at\\s+${CO}`) },
  { kind: 'role', re: rx(`\\bjoined\\s+${CO}`) },
  { kind: 'role', re: rx(`\\b(?:runs|heads|leads|leading|running|heading)\\s+${CO}`) },
  { kind: 'past', re: rx(`\\b(?:left|fired\\s+from|ousted\\s+from|ousted\\s+by|dismissed\\s+from|departed)\\s+${CO}`) },
];

const SCHOOL_WORD = /\b(University|Universit[éàa]|College|School|Institute|Instituto|Polytechnique|Polytechnic|[ÉE]cole|Academy|Conservatory|MIT|Stanford|Harvard|Oxford|Cambridge|Caltech|Berkeley|Princeton|Yale|Columbia|Cornell|Wharton|INSEAD|IIT|IIM|Tsinghua|Peking|ETH|EPFL|HEC|ENS|ENSAE|CentraleSup[ée]lec|Sciences Po|T[ée]l[ée]com|Normale|LSE|UCL|KTH|Technion|Waterloo|McGill|Toronto)\b/i;
const DEGREE_SURE = "(?:MBA|PhD|Ph\\.D\\.?|D\\.?Phil|doctorate|master'?s|bachelor'?s|B\\.S\\.|B\\.A\\.|M\\.S\\.|M\\.A\\.|BSc|MSc|BEng|MEng|LLB|LLM|B\\.?Tech|M\\.?Tech)";
const DEGREE_AMBIG = "(?:(?:an?|his|her|their)\\s+(?:BA|BS|MS|MA|JD|MD|degree))";
const EDUCATION_PATTERNS = [
  { strong: true, re: rx(`\\b(?:graduated|graduate|graduating)\\s+(?:from|of)\\s+(?:the\\s+)?${CO}`) },
  { strong: false, re: rx(`\\b(?:studied|read)\\s+(?:[a-z ]{0,40}\\s)?at\\s+(?:the\\s+)?${CO}`) },
  { strong: false, re: rx(`\\b(?:${DEGREE_SURE}|${DEGREE_AMBIG})\\b[^.]{0,40}?\\b(?:from|at)\\s+(?:the\\s+)?${CO}`) },
  { strong: true, re: rx(`\\b(?:alumnus|alumna|alum|alumni)\\s+of\\s+(?:the\\s+)?${CO}`) },
  { strong: true, re: /\bEducation:\s*(?<co>[^·|]+)/ },
];

const COMPANY_STOP = new Set(['The', 'A', 'An', 'He', 'She', 'They', 'His', 'Her', 'In', 'On', 'At', 'And', 'Before', 'After', 'Then', 'Its', 'This', 'That', 'It', 'We', 'You', 'I', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Chief', 'Founder', 'CEO', 'Series', 'Today', 'Yesterday']);
const COMPANY_LEADING = new Set(['The', 'A', 'An', 'Former', 'Then', 'Ex', 'Current', 'Outgoing', 'Incoming', 'Longtime', 'Veteran', 'Fellow', 'Interim']);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInitial(token) {
  return /^[A-Za-z]\.?$/.test(token);
}

/** The name as typed, and without middle initials ("Paul J. Graham" -> "Paul Graham"). */
export function nameVariants(name) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  const variants = [];
  if (tokens.length) variants.push(tokens.join(' '));
  if (tokens.length > 2) {
    const noInitials = tokens.filter((t, i) => !(i > 0 && i < tokens.length - 1 && isInitial(t)));
    if (noInitials.length >= 2 && noInitials.length < tokens.length) variants.push(noInitials.join(' '));
  }
  return variants;
}

function nameRegex(variants, flags = 'gi') {
  const alts = variants.map((v) => v.split(/\s+/).map(escapeRe).join('\\s+'));
  return new RegExp(`(?<![A-Za-z0-9])(?:${alts.join('|')})(?![A-Za-z0-9])`, flags);
}

function isProperCase(match) {
  return match.split(/\s+/).every((w) => /^[A-ZÀ-ɏ]/.test(w));
}

/**
 * Strict full-name matcher: full name (or a listed variant), word
 * boundaries, capitalized in the source. Returns a function with
 * `.positions(text)` (capitalized matches) and `.re`.
 */
export function nameMatcher(name) {
  const variants = Array.isArray(name) ? name.filter(Boolean) : nameVariants(name);
  if (!variants.length) {
    const none = () => false;
    none.positions = () => [];
    none.variants = [];
    return none;
  }
  const re = nameRegex(variants);
  const positions = (text) => {
    const out = [];
    for (const m of String(text || '').matchAll(re)) {
      if (isProperCase(m[0])) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
    return out;
  };
  const test = (text) => positions(text).length > 0;
  test.positions = positions;
  test.re = re;
  test.variants = variants;
  return test;
}

/** Is a match of `re` within NEAR_CHARS of a capitalized mention of the name? */
function nearName(text, hasName, re, window = NEAR_CHARS) {
  const names = hasName.positions(text);
  if (!names.length) return null;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of String(text).matchAll(g)) {
    const a = m.index;
    const b = a + m[0].length;
    const hit = names.some(({ start, end }) => (a >= end && a - end <= window) || (start >= b && start - b <= window) || (a < end && b > start));
    if (hit) return m;
  }
  return null;
}

/** "Mistral AI, Inc." and "Mistral" match each other; punctuation and suffixes are ignored. */
export function companyKeys(company) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|ai|labs|lab|technologies|technology|tech|group|holdings|plc|sa|sas|gmbh|the|io|com|financial|software|systems|solutions|networks|capital|partners|ventures|health|robotics|energy|security|data|cloud|digital|media|bank)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const full = norm(company);
  return full ? [full] : [];
}

function companyMatcher(company) {
  const c = String(company || '').trim();
  if (!c) return null;
  const exact = new RegExp(`(?<![A-Za-z0-9])${escapeRe(c)}(?![A-Za-z0-9])`, 'i');
  const keys = companyKeys(c).map((k) => new RegExp(`(?<![a-z0-9])${escapeRe(k)}(?![a-z0-9])`));
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, ' ').replace(/\s+/g, ' ');
  return (text) => {
    const str = String(text || '');
    if (exact.test(str)) return true;
    const n = norm(str);
    return keys.some((k) => k.test(n));
  };
}

function cleanCompany(raw, name) {
  // "Y Combinator. AMA" -> "Y Combinator" (a period followed by a space ends the name)
  let c = String(raw || '').trim().split(/\.\s+/)[0].replace(/['’]s$/, '').replace(/[.,;:'-]+$/, '').replace(/\s+(of|de|du|la|&)$/i, '').trim();
  let words = c.split(/\s+/);
  while (words.length > 1 && COMPANY_LEADING.has(words[0])) words = words.slice(1);
  c = words.join(' ');
  if (!c || COMPANY_STOP.has(words[0]) || c.length < 2) return null;
  if (new RegExp(`^${ROLE_WORD}$`, 'i').test(c)) return null;
  // Never treat the person themselves (or part of their name) as a company.
  const nameParts = String(name).split(/\s+/);
  if (nameParts.includes(c) || String(name).includes(c)) return null;
  return c;
}

function yearsIn(sentence) {
  return [...String(sentence).matchAll(YEAR_RE)].map((m) => Number(m[1]));
}

function sourceTime(result) {
  const t = Date.parse(result?.publishedAt || result?.date || result?.timestamp || '');
  return Number.isNaN(t) ? 0 : t;
}

function sourceYear(result) {
  const t = Date.parse(result?.publishedAt || result?.date || result?.timestamp || '');
  return Number.isNaN(t) ? null : new Date(t).getUTCFullYear();
}

function isLegal(text, result) {
  if (result?.source === 'courtlistener') return true;
  if (LEGAL_STRONG.test(text) || LEGAL_AGENCY.test(text)) return true;
  return LEGAL_WEAK.test(text) && LEGAL_CONTEXT.test(text);
}

/** Candidate sentences of a result, headline first. */
function candidates(result) {
  const out = [];
  const title = cleanText(result?.title);
  if (title) out.push({ text: title, headline: true });
  for (const s of sentencesOf(result)) {
    if (s !== title) out.push({ text: s, headline: false });
  }
  return out;
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const r of results || []) {
    const url = r?.url || r?.link;
    if (!url) continue;
    const key = String(url).replace(/[?#].*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function sourceEntry(r, i) {
  const date = formatDate(r.publishedAt || r.date || r.timestamp);
  return {
    n: i + 1,
    title: cleanText(r.title) || sourceLabel(r),
    url: r.url || r.link,
    sourceName: sourceLabel(r),
    via: sourceType(r),
    date,
    dateLabel: r.source === 'hackernews' ? 'posted' : 'published',
  };
}

/**
 * Pure extraction step (no network): builds every section from results.
 * Exported for tests.
 */
export function extractFounderEvidence({ name, company, results, keepAllSources = false }) {
  const hasName = typeof name === 'function' ? name : nameMatcher(name);
  const personName = typeof name === 'function' ? (name.variants?.[0] || '') : String(name || '');
  const hasCompany = companyMatcher(company);
  const deduped = dedupeResults(results);

  // Items reference the deduped result index (ri); renumbered at the end.
  const timeline = [];
  const companies = [];
  const litigation = [];
  const press = [];
  const mentions = [];
  const education = [];
  const roleCandidates = [];
  const seenSchools = new Set();
  const seenQuotes = new Set();
  const seenCompanies = new Map();

  // Name-specific role patterns: "Mistral CEO Arthur Mensch", "Arthur Mensch, CEO of Mistral AI"
  const nameSrc = hasName.re ? hasName.re.source : escapeRe(personName);
  const namedPatterns = [
    { kind: 'role', re: new RegExp(`${CO}(?:['’]s)?\\s+(?<role>${ciFirst(ROLE_WORD)})\\s*,?\\s+(?:${nameSrc})`) },
  ];

  deduped.forEach((result, ri) => {
    const title = cleanText(result.title);
    const body = cleanText(result.snippet || result.content || result.description);
    const full = `${title} ${body}`;
    if (!hasName(full)) return;
    const headlineOnly = !body || body === title;
    const sourceMentionsCompany = hasCompany ? hasCompany(full) : null;
    const flag = (sentence) => {
      if (!hasCompany) return {};
      const inSentence = hasCompany(sentence);
      if (inSentence || sourceMentionsCompany) return { mentionsCompany: inSentence };
      // A headline-only source cannot be expected to name the company.
      return headlineOnly ? { mentionsCompany: false, companyUnknown: true } : { mentionsCompany: false, possibleDifferentPerson: true };
    };
    const published = sourceYear(result);

    let firstQuote = null;
    for (const { text, headline } of candidates(result)) {
      if (!hasName(text)) continue;
      if (!firstQuote) firstQuote = text;
      const key = text.toLowerCase();
      if (seenQuotes.has(key)) continue;
      seenQuotes.add(key);

      if (isLegal(text, result)) {
        litigation.push({ quote: text, ri, headline, ...flag(text) });
      }

      // Career events: a role word next to the name. Year from the sentence
      // (never a future year); otherwise the source's own date.
      const roleHit = nearName(text, hasName, ROLE_RE);
      if (roleHit) {
        const years = yearsIn(text);
        const past = years.filter((y) => y <= CURRENT_YEAR);
        const future = years.some((y) => y > CURRENT_YEAR);
        let year = null;
        let yearFrom = null;
        if (past.length) { year = Math.min(...past); yearFrom = 'sentence'; }
        else if (!future && published) { year = published; yearFrom = 'source'; }
        if (year) timeline.push({ year, yearFrom, quote: text, ri, headline, ...flag(text) });
      }

      for (const { strong, re } of EDUCATION_PATTERNS) {
        const m = text.match(re);
        const school = m && String(m.groups.co).trim().replace(/[.,;:]+$/, '');
        if (!school || school.length <= 2) continue;
        if (!strong && !SCHOOL_WORD.test(school)) continue;
        if (!nearName(text, hasName, re)) continue;
        if (seenSchools.has(school.toLowerCase())) continue;
        seenSchools.add(school.toLowerCase());
        education.push({ school, quote: text, ri, headline, ...flag(text) });
      }

      for (const { kind, re } of [...COMPANY_PATTERNS, ...namedPatterns]) {
        const m = nearName(text, hasName, re);
        if (!m) continue;
        const co = cleanCompany(m.groups?.co, personName);
        if (!co) continue;
        let role = m.groups?.role ? String(m.groups.role).replace(/\s+/g, ' ') : null;
        if (role && /founded$/i.test(role)) role = /^co/i.test(role) ? 'co-founder' : 'founder';
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        let status = kind === 'past' ? 'past' : kind === 'founded' ? 'founded' : 'current';
        if (status === 'current' && (PAST_RE.test(before) || PAST_RE.test(m[0]))) status = 'past';
        const coKey = companyKeys(co)[0] || co.toLowerCase();
        if (status !== 'past' && role) roleCandidates.push({ role, company: co, quote: text, ri, at: sourceTime(result), ...flag(text) });
        const existing = seenCompanies.get(coKey);
        if (existing) {
          // Same company again: keep the first quote, but fill in a role we did not have
          if (!existing.role && role) { existing.role = role; existing.roleQuote = text; existing.roleRi = ri; }
          continue;
        }
        const entry = { company: co, role, status, quote: text, ri, headline, ...flag(text) };
        seenCompanies.set(coKey, entry);
        companies.push(entry);
      }
    }
    if (firstQuote && result.source !== 'courtlistener') {
      const item = { title: title || sourceLabel(result), quote: firstQuote, ri, ...flag(full) };
      if (hasName(title)) press.push(item);
      else mentions.push(item);
    }
  });

  // Company-mentioning items first (stable), then the section's own order.
  const rank = (arr) => (hasCompany ? arr.map((x, i) => [x, i]).sort((a, b) => (Number(!!b[0].mentionsCompany) - Number(!!a[0].mentionsCompany)) || (a[1] - b[1])).map(([x]) => x) : arr);

  const tl = timeline
    .sort((a, b) => a.year - b.year || (Number(a.yearFrom === 'source') - Number(b.yearFrom === 'source')) || (Number(!!b.mentionsCompany) - Number(!!a.mentionsCompany)))
    .slice(0, MAX_TIMELINE);
  const pc = rank(companies).slice(0, MAX_COMPANIES);
  const lit = rank(litigation).slice(0, MAX_LITIGATION);
  const pr = rank(press).slice(0, MAX_PRESS);
  const mn = rank(mentions).slice(0, MAX_MENTIONS);
  const ed = education.slice(0, MAX_EDUCATION);
  // Most recent role: company-matching first, then the newest source
  const currentRole = roleCandidates
    .map((x, i) => [x, i])
    .sort((a, b) => (Number(!!b[0].mentionsCompany) - Number(!!a[0].mentionsCompany)) || (b[0].at - a[0].at) || (a[1] - b[1]))
    .map(([x]) => { const { at, ...rest } = x; return rest; })[0] || null;

  // Only cited sources are listed (or all, when the caller numbers them);
  // sourceIndex is 0-based into sources.
  const used = keepAllSources
    ? deduped.map((_, i) => i)
    : [...new Set([...tl, ...pc, ...lit, ...pr, ...mn, ...ed].map((x) => x.ri))].sort((a, b) => a - b);
  const indexOf = new Map(used.map((ri, i) => [ri, i]));
  const sources = used.map((ri, i) => sourceEntry(deduped[ri], i));
  const fix = ({ ri, roleRi, ...rest }) => ({ ...rest, sourceIndex: indexOf.get(ri), ...(roleRi != null ? { roleSourceIndex: indexOf.get(roleRi) } : {}) });

  return {
    sources,
    currentRole: currentRole ? fix(currentRole) : null,
    timeline: tl.map(fix),
    pastCompanies: pc.map(fix),
    litigation: lit.map(fix),
    press: pr.map(fix),
    mentions: mn.map(fix),
    education: ed.map(fix),
  };
}

const PROFILE_JUNK = /^(Professional Profile|Profile|LinkedIn|Crunchbase|Person Profile|.*\bArea$|Greater .*|United States|France|Germany|United Kingdom|Canada|India|\d+\+? connections?)$/i;

/**
 * Profile facts from public profile pages as they appear in search results:
 * "Name - Role - Company | LinkedIn", "Name - Co-Founder & CEO @ Company -
 * Crunchbase Person Profile", snippets with "Experience: ... Education: ...
 * Location: ...". Each profile keeps its source index.
 */
export function extractProfiles(results, hasName) {
  const profiles = [];
  results.forEach((r, i) => {
    const url = String(r.url || '');
    const isLinkedIn = /linkedin\.com\/in\//i.test(url);
    const isCrunchbase = /crunchbase\.com\/person\//i.test(url);
    if (!isLinkedIn && !isCrunchbase) return;
    const title = cleanText(r.title).replace(/\s*[|·]\s*(LinkedIn|Crunchbase.*)$/i, '').replace(/\s+-\s+Crunchbase Person Profile$/i, '');
    if (!hasName(title)) return;
    const rawParts = title.split(/\s+[-–—|]\s+/).map((x) => x.trim()).filter(Boolean);
    const parts = rawParts.filter((x) => !PROFILE_JUNK.test(x));
    const snippet = cleanText(r.snippet || r.content);
    let role = parts[1] || null;
    let company = parts[2] || null;
    const at = role && role.match(/^(.*?)\s+(?:@|at)\s+(.+)$/);
    if (at) { role = at[1]; company = company || at[2]; }
    // Crunchbase: "Jane Doe is the Co-Founder & CEO at Acme Robotics."
    const isThe = snippet.match(/\bis\s+(?:the\s+|an?\s+)?([A-Z][^.]{2,60}?)\s+(?:at|of)\s+([A-Z][A-Za-z0-9&.'\- ]{1,60}?)(?:[.,;]|\s+(?:and|where|which)\b|$)/);
    if (!role && isThe) role = isThe[1].trim();
    if (!company && isThe) company = isThe[2].trim();
    const experience = (snippet.match(/Experience:\s*([^·|]+)/) || [])[1];
    const educationText = (snippet.match(/Education:\s*([^·|]+)/) || [])[1];
    const location = (snippet.match(/Location:\s*([^·|]+)/) || [])[1];
    if (!company && experience) company = experience.trim();
    const place = location ? location.trim() : (rawParts.find((p) => /\bArea$|Greater /i.test(p)) || null);
    profiles.push({
      platform: isLinkedIn ? 'LinkedIn' : 'Crunchbase',
      role: role || null,
      company: company ? company.trim() : null,
      education: educationText ? educationText.trim() : null,
      location: place,
      url,
      sourceIndex: i,
    });
  });
  return profiles;
}

export const BRIEF_SECTIONS = ['## SUMMARY', '## CAREER TIMELINE', '## PAST COMPANIES AND ROLES', '## EDUCATION', '## LITIGATION AND REGULATORY', '## PRESS AND PUBLIC STATEMENTS', '## RED FLAGS AND OPEN QUESTIONS'];

const BRIEF_PROMPT = `You are a diligence analyst writing a founder background brief. Use ONLY the numbered sources. Several people can share a name: use only sources that clearly describe the same person (matching company, role or details); if sources may describe different people, say so in RED FLAGS AND OPEN QUESTIONS.

Rules:
- Cite every factual sentence or bullet with [Source n]. Never cite a number that is not listed.
- Never add facts that are not in the sources. If a section has no supporting source, write "Not found in the available sources."
- Absence of litigation results is NOT evidence of a clean record; say so in LITIGATION AND REGULATORY.
- Give dates where sources give them. A source's publication date is not the date of the event unless the source says so.

Format (Markdown, exactly these sections, in order):
## SUMMARY
## CAREER TIMELINE
(bullets "• YEAR: event [Source n]", oldest first)
## PAST COMPANIES AND ROLES
## EDUCATION
## LITIGATION AND REGULATORY
## PRESS AND PUBLIC STATEMENTS
## RED FLAGS AND OPEN QUESTIONS
(include specific reference-check questions)
Then one final line: CONFIDENCE: High|Medium|Low - <reason>`;

function sourcesBlock(results) {
  return results.map((r, i) => {
    const date = formatDate(r.publishedAt || r.date || r.timestamp);
    return `[Source ${i + 1}] ${cleanText(r.title)}\nPublisher: ${sourceLabel(r)} (${sourceType(r)})${date ? ` | ${r.source === 'hackernews' ? 'Posted' : 'Date'}: ${date}` : ''}\nURL: ${r.url}\nText: ${cleanText(r.snippet || r.content).slice(0, 600) || '(headline only)'}`;
  }).join('\n\n');
}

/** Add any section the model left out, so the brief always has all seven. */
export function completeBriefSections(content) {
  let out = String(content || '').trim();
  const present = BRIEF_SECTIONS.filter((h) => out.includes(h));
  if (present.length === BRIEF_SECTIONS.length) return out;
  const blocks = BRIEF_SECTIONS.map((h) => {
    if (out.includes(h)) {
      const start = out.indexOf(h);
      const next = BRIEF_SECTIONS.map((x) => (x === h ? -1 : out.indexOf(x, start + h.length))).filter((i) => i >= 0);
      const end = next.length ? Math.min(...next) : out.length;
      return out.slice(start, end).trim();
    }
    const body = h === '## LITIGATION AND REGULATORY'
      ? `Not found in the available sources.\n\n*${LITIGATION_DISCLAIMER}*`
      : 'Not found in the available sources.';
    return `${h}\n${body}`;
  });
  return blocks.join('\n\n');
}

/** Quoted brief built from the extracted sections (no AI). */
function quotedBrief(person, company, evidence, reason) {
  const cite = (x) => `[Source ${x.sourceIndex + 1}]`;
  const bullets = (items, fmt, empty = 'Not found in the available sources.') => (items.length ? items.map(fmt).join('\n') : empty);
  const n = evidence.sources.length;
  const summary = [`${n} source${n === 1 ? '' : 's'} name ${person}${company ? ` (checked against ${company})` : ''}.`];
  if (evidence.currentRole) summary.push(`Most recent role found: ${evidence.currentRole.role} at ${evidence.currentRole.company} ${cite(evidence.currentRole)}.`);
  const latest = [...evidence.press].sort((a, b) => String(evidence.sources[b.sourceIndex]?.date || '').localeCompare(String(evidence.sources[a.sourceIndex]?.date || '')))[0];
  if (latest) {
    const s = evidence.sources[latest.sourceIndex];
    summary.push(`Most recent coverage: "${latest.title}" (${s.sourceName}${s.date ? `, ${s.date}` : ''}) ${cite(latest)}.`);
  }
  const flagged = [...evidence.timeline, ...evidence.pastCompanies, ...evidence.litigation, ...evidence.press].filter((x) => x.possibleDifferentPerson).length;
  const redFlags = ['• Confirm identity: sources are matched by full name only; check that each describes the same person.'];
  if (flagged) redFlags.push(`• ${flagged} item(s) come from sources that do not mention ${company}; confirm they describe the same person.`);
  const companyNames = evidence.pastCompanies.map((c) => c.company).slice(0, 5);
  if (companyNames.length > 1) redFlags.push(`• Ask references about the reasons for each move between ${companyNames.join(', ')}.`);
  else if (companyNames.length === 1) redFlags.push(`• Only one company was found (${companyNames[0]}); ask for a full CV and verify earlier roles directly.`);
  else redFlags.push('• No employer could be extracted from the sources; ask for a CV and verify each role directly.');
  if (evidence.litigation.length) redFlags.push(`• Review the ${evidence.litigation.length} litigation or regulatory mention(s) above with counsel.`);
  if (!evidence.education.length) redFlags.push('• Education not found in the sources; verify degrees with the institution.');
  const yearLine = (x) => `• ${x.year}${x.yearFrom === 'source' ? ' (date of source)' : ''}: ${x.quote} ${cite(x)}`;
  const roleLine = (x) => `• **${x.company}**${x.role ? ` (${x.role}${x.status === 'past' ? ', past' : ''})` : x.status === 'past' ? ' (past)' : ''}: ${x.quote} ${cite(x)}`;
  return [
    '## SUMMARY', summary.join(' '),
    '', '## CAREER TIMELINE', bullets(evidence.timeline, yearLine),
    '', '## PAST COMPANIES AND ROLES', bullets(evidence.pastCompanies, roleLine),
    '', '## EDUCATION', bullets(evidence.education, (x) => `• **${x.school}**: ${x.quote} ${cite(x)}`),
    '', '## LITIGATION AND REGULATORY', bullets(evidence.litigation, (x) => `• ${x.quote} ${cite(x)}`, 'No litigation or regulatory mentions found in the available sources.'), `\n*${LITIGATION_DISCLAIMER}*`,
    '', '## PRESS AND PUBLIC STATEMENTS', bullets(evidence.press.slice(0, 8), (x) => `• ${x.quote} ${cite(x)}`),
    '', '## RED FLAGS AND OPEN QUESTIONS', ...redFlags,
    '', `*Note: ${reason}, so every statement above is quoted from the cited source.*`,
  ].join('\n');
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** CourtListener RECAP search. Needs COURTLISTENER_API_TOKEN (anonymous calls return 401). */
async function searchCourtListener(name, { timeoutMs = 12000 } = {}) {
  const token = process.env.COURTLISTENER_API_TOKEN;
  if (!token) {
    const err = new Error('CourtListener skipped: requires COURTLISTENER_API_TOKEN (free account; anonymous API requests return 401).');
    err.skipped = true;
    throw err;
  }
  const url = `https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(`"${name}"`)}&type=r`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Authorization: `Token ${token}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`CourtListener returned ${r.status}`);
    const data = await r.json();
    return (data.results || []).slice(0, 20).map((d) => {
      const snippets = (d.recap_documents || []).map((doc) => cleanText(doc.snippet)).filter(Boolean);
      const caseLine = `${cleanText(d.caseName || d.case_name)}${d.court ? ` (${cleanText(d.court)}` : ''}${d.docketNumber ? `, docket ${cleanText(d.docketNumber)}` : ''}${d.court ? ')' : ''}.`;
      return {
        title: caseLine,
        snippet: snippets.join(' '),
        url: d.absolute_url ? `https://www.courtlistener.com${d.absolute_url}` : null,
        date: d.dateFiled || d.date_filed || null,
        source: 'courtlistener',
        sourceName: 'CourtListener',
      };
    });
  } finally {
    clearTimeout(t);
  }
}

/** Normalise what the user typed: quotes, possessives, spacing. */
export function normalizePersonName(name) {
  return String(name || '')
    .replace(/["“”„]/g, '')
    .replace(/[’']s\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Run the check.
 * @param {{ name: string, company?: string, model?: string, useLLM?: boolean, deadline?: number }} input
 * @param {{ searchers?: object }} deps override searchers in tests
 */
export async function runFounderCheck({ name, company, model = 'auto', useLLM = true, deadline = null } = {}, deps = {}) {
  const person = normalizePersonName(name);
  const co = String(company || '').trim().replace(/\s+/g, ' ');
  if (!person) throw new Error('name is required');
  const variants = nameVariants(person);
  const hasName = nameMatcher(variants);

  const searchers = {
    curated: () => searchCuratedForEntity(hasName, { limit: 25, waitMs: 8000 }),
    hackernews: (q) => searchHackerNews(q, { limit: 15 }),
    web: (q, opts) => searchWeb(q, opts),
    courtlistener: (n) => searchCourtListener(n),
    webConfigured: webSearchConfigured,
    indexStatus: () => { try { return getCuratedIndexStatus(); } catch { return null; } },
    ...(deps.searchers || {}),
  };

  const warnings = [];
  const unavailableSources = [];
  const webOn = searchers.webConfigured();
  if (!webOn) unavailableSources.push({ source: 'Web search', reason: 'No SERPER_API_KEY or TAVILY_API_KEY configured.' });

  const webQueriesFor = (n) => [
    [`"${n}"`, {}],
    [`"${n}" ${co || 'founder OR CEO OR co-founder'}`, {}],
    [`"${n}" site:linkedin.com/in`, {}],
    [`"${n}" site:crunchbase.com/person`, {}],
    [`"${n}" lawsuit OR sued OR fraud OR charged OR settlement`, {}],
    [`"${n}"${co ? ` ${co}` : ''}`, { news: true, withinDays: 0 }],
  ];
  // Search every variant (with and without a middle initial)
  const tasks = [
    { source: 'Curated news index', run: () => searchers.curated(person) },
    ...variants.map((v) => ({ source: 'Hacker News', run: () => searchers.hackernews(v) })),
    ...(co ? [{ source: 'Hacker News', run: () => searchers.hackernews(`${variants[variants.length - 1]} ${co}`) }] : []),
    ...(webOn ? variants.flatMap((v) => webQueriesFor(v).map(([q, opts]) => ({ source: 'Web search', run: () => searchers.web(q, opts) }))) : []),
    ...variants.map((v) => ({ source: 'CourtListener', run: () => searchers.courtlistener(v) })),
  ];
  const settled = await Promise.allSettled(tasks.map((t) => withTimeout(Promise.resolve().then(t.run), QUERY_TIMEOUT_MS, t.source)));

  const raw = [];
  const failuresBySource = new Map();
  const countBySource = new Map();
  settled.forEach((x, i) => {
    const { source } = tasks[i];
    if (x.status === 'fulfilled') {
      const list = Array.isArray(x.value) ? x.value : [];
      raw.push(...list);
      countBySource.set(source, (countBySource.get(source) || 0) + list.length);
    } else if (!failuresBySource.has(source)) failuresBySource.set(source, x.reason);
  });
  for (const [source, err] of failuresBySource) {
    const allFailed = settled.every((x, i) => tasks[i].source !== source || x.status === 'rejected');
    if (allFailed) unavailableSources.push({ source, reason: String(err?.message || err) });
    else warnings.push(`Some ${source} queries failed: ${String(err?.message || err)}`);
  }
  const searchedSources = [...new Set(tasks.map((t) => t.source))]
    .filter((s) => !unavailableSources.some((u) => u.source === s))
    .map((s) => ({ source: s, results: countBySource.get(s) || 0 }));

  const index = searchers.indexStatus ? searchers.indexStatus() : null;
  if (index && !index.ready) {
    warnings.push(`The curated news index is still loading (${index.itemsAvailable || 0} items so far); this check may be incomplete. Run it again in a minute.`);
  }

  // Keep sources that name the person; rank: mentions the company, profile
  // pages, source tier, recency.
  const hasCo = companyMatcher(co);
  const text = (r) => `${cleanText(r.title)} ${cleanText(r.snippet || r.content)}`;
  const named = dedupeResults(raw).filter((r) => hasName(text(r)));
  const scoreOf = (r) => {
    let sc = 0;
    if (hasCo && hasCo(text(r))) sc += 3;
    if (/linkedin\.com\/in\/|crunchbase\.com\/person\//i.test(r.url || '')) sc += 2;
    if (r.source === 'courtlistener') sc += 2;
    if (hasName(cleanText(r.title))) sc += 1;
    sc += { filing: 1.5, press: 1.2, blog: 0.5, other: 0.4, forum: 0.2 }[tierInfo(r).tier] ?? 0.4;
    const t = Date.parse(r.publishedAt || r.date || r.timestamp || '');
    if (!Number.isNaN(t)) sc += Math.max(0, 1 - (Date.now() - t) / (3 * 365 * 86400000));
    return sc;
  };
  const ranked = named.map((r) => ({ r, sc: scoreOf(r) })).sort((a, b) => b.sc - a.sc).map((x) => x.r).slice(0, MAX_SOURCES);

  // Display the name as sources write it ("Arthur Mensch", not "arthur mensch")
  const firstMention = ranked.map((r) => hasName.positions(text(r))[0]?.text).find(Boolean);
  const displayName = firstMention || person;
  if (variants.length > 1) {
    const exact = nameMatcher([variants[0]]);
    const onlyShort = ranked.length > 0 && !ranked.some((r) => exact(text(r)));
    if (onlyShort) warnings.push(`No source writes "${variants[0]}" with the initial; the sources below match "${variants[1]}". Check that they describe the same person.`);
  }

  const evidence = extractFounderEvidence({ name: hasName, company: co, results: ranked, keepAllSources: true });
  const profiles = extractProfiles(ranked, hasName);
  if (!evidence.currentRole) {
    const p = profiles.find((x) => x.role && x.company);
    if (p) evidence.currentRole = { role: p.role, company: p.company, quote: `${p.platform} profile`, sourceIndex: p.sourceIndex, fromProfile: true };
  }

  // Disambiguation: profile pages describing different current companies
  const distinctCompanies = [...new Set(profiles.map((p) => String(p.company || '').toLowerCase()).filter(Boolean))];
  if (!co && distinctCompanies.length > 1) {
    warnings.push(`Profiles for several people named ${displayName} were found (${profiles.map((p) => p.company).filter(Boolean).slice(0, 4).join('; ')}). Add a company to narrow the check.`);
  }
  if (co) {
    const flagged = [...evidence.timeline, ...evidence.pastCompanies, ...evidence.litigation, ...evidence.press, ...evidence.mentions].filter((x) => x.possibleDifferentPerson).length;
    if (flagged) warnings.push(`${flagged} item(s) come from sources that do not mention "${co}". They may describe the same person at another company, or a different person with the same name.`);
  }
  if (!evidence.sources.length) {
    const webMissing = unavailableSources.some((u) => /web/i.test(u.source));
    warnings.push(webMissing
      ? `No source mentions "${displayName}" by full name. Without web search, only the curated startup-news feeds and Hacker News are searched, and they rarely cover individuals who have not been in funding news. Add a web search key (SERPER_API_KEY or TAVILY_API_KEY) to search the wider web.`
      : `No source mentions "${displayName}" by full name.`);
  }

  // Brief: AI (free chain) with checked citations, else quoted
  let brief = null;
  let briefInfo = { mode: 'quoted', reason: 'No AI model is configured' };
  if (ranked.length > 0 && useLLM && PROVIDERS.some(providerEnabled)) {
    const user = `Today's date: ${new Date().toISOString().slice(0, 10)}\nPerson: ${displayName}${co ? `\nCompany (to disambiguate): ${co}` : ''}\n\nSources:\n${sourcesBlock(ranked)}`;
    const out = await chatComplete([{ role: 'system', content: BRIEF_PROMPT }, { role: 'user', content: user }], { preferred: model, maxTokens: 3000, deadline });
    if (out) {
      const checked = validateAnswer(out.text, ranked.length, BRIEF_SECTIONS);
      if (checked.ok) {
        brief = completeBriefSections(checked.content);
        briefInfo = { mode: 'ai', provider: out.providerLabel, model: out.model, confidence: checked.confidence, skipped: out.skipped || [] };
      } else {
        briefInfo = { mode: 'quoted', reason: `The AI brief failed validation (${checked.reason})` };
      }
    } else {
      briefInfo = { mode: 'quoted', reason: 'The AI model was unavailable' };
    }
  }
  if (!brief && ranked.length > 0) brief = quotedBrief(displayName, co, evidence, briefInfo.reason);
  if (!brief) briefInfo = null;

  return {
    name: displayName,
    nameVariants: variants,
    company: co || null,
    generatedAt: new Date().toISOString(),
    ...evidence,
    profiles,
    brief,
    briefInfo,
    litigationDisclaimer: LITIGATION_DISCLAIMER,
    warnings: ['Name matching is strict (exact full name, any capitalization). Mentions using initials, nicknames or a different spelling are not included; different people can share the same name.', ...warnings],
    searchedSources,
    indexStatus: index ? { ready: Boolean(index.ready), items: index.itemsAvailable || 0, sources: index.indexableSources || index.registrySources || 0 } : null,
    unavailableSources: [
      ...unavailableSources,
      { source: 'LinkedIn', reason: 'LinkedIn does not share profiles with third-party apps; public profile snippets from web search are used instead.' },
    ],
  };
}
