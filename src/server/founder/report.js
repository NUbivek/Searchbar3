/**
 * Turns the records a deep check collected into the report the investor
 * reads: red flags first, each with how sure we are it is the same person;
 * then every record by category; a dated timeline; claims that changed
 * between archived versions; related parties; and a plain statement of
 * what was searched, what failed and what no free source covers.
 *
 * The written brief on top comes from the free model chain and may only
 * cite numbered records; it is checked (every citation must exist) and, when
 * time allows, a second model re-reads each red flag against the quoted
 * text. If no model is available the brief is assembled from the records
 * themselves. Nothing in the report is asserted without a source.
 */
import { CATEGORIES } from './finding';
import { buildProfile, isPersonRun } from './profile';
import { matchRank, restoreSubject, personKey, slugCandidates, nameTokens } from './identity';
import { companyKeys, nameMatcher } from '../founderCheck';
import { companyMentionMatcher, companyKeyStrict, cooccurrences, isBroadOrganisation, isCommonName, isOrdinaryWordCompany } from './names';
import { USE_NOTICE, cleanModelText } from './guardrails';
import { chatComplete, PROVIDERS, providerEnabled } from '../llm/providers';
import { validateAnswer } from '../search/answer';

const SECTION_ORDER = ['sanctions', 'regulatory', 'litigation', 'leaks', 'exposure', 'archive', 'career', 'education', 'corporate', 'related', 'ip', 'identity', 'press'];
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1, info: 0 };
// Records from the authority itself outrank a report about it.
const AUTHORITY = { sanctions: 3, regulatory: 3, litigation: 3, leaks: 2.5, corporate: 2.5, archive: 2, ip: 2, education: 2, exposure: 2, career: 1.5, identity: 1.5, related: 1.5, press: 1 };

// Which kind of source a record comes from, for choosing the record that leads a matter: the authority
// itself (court, prosecutor, regulator, watchlist) first, then the encyclopaedias, then news and the web,
// and a discussion forum last. A forum post is never the headline of a sentencing a court record reports.
const PRIMARY_SOURCES = new Set(['doj-press-releases', 'court-dockets', 'court-records-open', 'us-enforcement-actions', 'finra-brokercheck', 'uk-gazette', 'uk-case-law', 'fr-bodacc', 'sec-filings', 'sec-company', 'sanctions-lists', 'us-exclusions', 'wanted-lists',
  'mdb-debarment', 'us-bank-regulators', 'fincen-actions', 'delaware-courts', 'eu-courts', 'canada-federal-courts', 'us-agency-orders']);
const REFERENCE_SOURCES = new Set(['wikipedia', 'wikidata']);
const FORUM_SOURCES = new Set(['hacker-news']);
const sourceAuthority = (f) => (PRIMARY_SOURCES.has(f.source) ? 3 : REFERENCE_SOURCES.has(f.source) ? 2 : FORUM_SOURCES.has(f.source) ? 0 : 1);

export const NOT_COVERED = [
  'US state and county court records, and full federal dockets (PACER), beyond what CourtListener and news sources carry',
  'Criminal records, credit history, liens and judgments held by commercial background-check providers',
  'Private company financials, cap tables and unpublished regulatory correspondence',
  'Sources that are not in English or are behind a login or paywall',
  'Anything a person has had removed from the web and that was never archived',
  // The state registers searched are Colorado, New York, Connecticut, Oregon and Texas; "no match" there says
  // nothing about a Delaware or California company.
  'Company registers of US states other than Colorado, New York, Connecticut, Oregon and Texas (including Delaware and California), dissolved companies in New York and Oregon (whose registers list active companies only), and registers of countries other than the UK and France',
];
const NOT_ENGLISH = 3; // the entry above about sources not in English
const COURT_DOCKETS = 'court-dockets';
// A registry or court of a non-English-speaking country ('fr-companies'), or a search run in another language ('adverse-fr').
const NON_ENGLISH_SOURCE = /^(?:fr|de|es|it|nl|pt|br|jp|cn|kr)-/;
const NON_ENGLISH_TEMPLATE = /-(?:fr|de|es|it|nl|pt|ja|zh|ko)$/;
// Courts and regulators of a country where the person's company is registered that no source here reads.
const COUNTRY_GAPS = {
  FR: 'French court decisions (Judilibre/Légifrance) and AMF enforcement decisions',
  GB: 'UK county court judgments and FCA enforcement notices beyond what the sources searched carry',
  DE: 'German court decisions and BaFin enforcement measures',
  ES: 'Spanish court decisions (CENDOJ) and CNMV enforcement decisions',
  IT: 'Italian court decisions and CONSOB enforcement decisions',
  NL: 'Dutch court decisions (rechtspraak.nl) and AFM enforcement decisions',
  CH: 'Swiss court decisions and FINMA enforcement proceedings',
  CA: 'Canadian court decisions beyond CanLII and provincial securities-regulator enforcement',
  IN: 'Indian court records and SEBI enforcement orders',
};
// Registers whose tied record places the company in a country.
const COUNTRY_SOURCES = { 'fr-companies': 'FR', 'fr-bodacc': 'FR', 'uk-companies-house': 'GB' };
const countryName = (code) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; } };
/** Countries other than the US where a record tied to the person or their company places the company. */
function companyCountries(findings) {
  const out = new Set();
  for (const f of findings || []) {
    if (!CORROBORATES.has(f.match)) continue;
    const code = COUNTRY_SOURCES[f.source] || (f.source === 'lei-register' ? String(f.data?.jurisdiction || '').split('-')[0].toUpperCase() : '');
    if (/^[A-Z]{2}$/.test(code) && code !== 'US') out.add(code);
  }
  return [...out];
}
const PARTLY_ANSWERED = 0.2; // share of failed lookups from which a source's answer is called partial
const TIMELINE_MAX = 60;

// The checklist of public-record screens the report shows, so a clean screen is seen to have run. A screen
// that answered every lookup in full and found nothing is a clean result worth stating ("Screens with no
// match"); one that failed, waited out a lookup or answered in part is never called clean.
const SCREEN_GROUPS = [
  ['Sanctions and watchlists', ['sanctions-lists', 'us-exclusions', 'mdb-debarment', 'fda-debarment', 'opensanctions-lists', 'asic-banned', 'wanted-lists', 'offshore-leaks']],
  ['Courts and prosecutors', ['court-dockets', 'court-records-open', 'doj-press-releases', 'delaware-courts', 'uk-case-law', 'eu-courts', 'canada-federal-courts', 'us-tax-court']],
  ['Regulators and filings', ['us-enforcement-actions', 'finra-brokercheck', 'us-bank-regulators', 'fincen-actions', 'us-agency-orders', 'sec-filings', 'sec-company', 'cfpb-complaints', 'federal-register', 'fda-recalls', 'ftc-cases', 'esma-sanctions-register', 'sfc-hk-enforcement', 'gdpr-fines', 'nhtsa-recalls', 'cpsc-recalls', 'uk-gazette', 'fr-bodacc']],
  ['US federal awards, lobbying and grants', ['us-federal-awards', 'us-lobbying', 'fara-registrations', 'nih-grants', 'nsf-awards']],
  ['Research integrity', ['retractions']],
  ['Dark-web leak sites and data breaches (company level)', ['leak-sites', 'leak-sites-ransomfeed', 'leak-sites-archive', 'breach-catalogue', 'breach-registers', 'breach-registers-delaware', 'breach-registers-vermont', 'breach-registers-maryland', 'breach-registers-indiana', 'infostealer-exposure']],
  ['Company registers', ['us-state-registries', 'uk-companies-house', 'fr-companies', 'lei-register', 'yc-directory', 'nonprofit-filings', 'no-company-register', 'cz-company-register', 'fi-trade-register']],
  ['Patents and trademarks', ['patents', 'trademarks']],
];
// Records from these are tied to the company by more than its name (the page names the person, or was found through them).
const NAME_PLUS_SOURCES = new Set(['web-search', 'news-archive', 'web-archive', 'page-reader', 'wikipedia', 'wikidata', 'domain-history']);
const REGISTER_SOURCES = new Set(['us-state-registries', 'uk-companies-house', 'fr-companies', 'yc-directory', 'lei-register']);
/** From this many same-name entries in registers on, a company name is shared by several companies. */
const SHARED_NAME_FROM = 3;

// Sources of one family: a record from either counts toward the screen of the other (a Form D notice is an
// SEC company filing, whichever of the two SEC sources found it).
const SOURCE_FAMILY = { 'sec-filings': 'sec', 'sec-company': 'sec' };
const familyOf = (id) => SOURCE_FAMILY[id] || id;
const SCREEN_IDS = new Set(SCREEN_GROUPS.flatMap(([, ids]) => ids));

/**
 * One row per screen: what it was asked, and what came back. A record counts toward the screen of the
 * source family it came from, and so does each copy merged into it (alsoIn). `wordOnly` are the records
 * taken out of the numbered report because they match only an ordinary word: they still show the screen
 * answered with name-only records.
 */
function screensOf(allSources, cited, wordOnly = []) {
  const byId = new Map(allSources.map((s) => [s.id, s]));
  const sourcesOf = (f) => [f.source, ...(f.alsoIn || []).map((c) => c.source)].map(familyOf);
  return SCREEN_GROUPS.map(([group, ids]) => ({
    group,
    items: ids.map((id) => byId.get(id)).filter(Boolean).map((s) => {
      const mine = cited.filter((f) => sourcesOf(f).includes(familyOf(s.id)));
      const tied = mine.filter((f) => f.match !== 'possible');
      const words = wordOnly.filter((f) => familyOf(f.source) === familyOf(s.id)).length;
      const full = !(s.errors > 0) && !(s.waitedOut > 0) && !(s.partial?.length);
      const status = s.off ? 'off'
        : !(s.runs > 0) ? 'not-run'
        : s.errors >= s.runs ? 'failed'
        : tied.length ? 'records'
        : mine.length || words ? 'name-only'
        // it reported a record that is listed under another source's copy of the same page
        : s.findings > 0 ? 'records'
        : !full ? 'partial'
        : 'clear';
      return {
        id: s.id, label: s.label, status, lookups: s.runs || 0, records: tied.length || (mine.length || words ? 0 : s.findings || 0), nameOnly: mine.length - tied.length + words,
        ...(full ? {} : { incomplete: true }), cites: (tied.length ? tied : mine).slice(0, 6).map((f) => f.n),
      };
    }),
  })).filter((g) => g.items.length > 0);
}

/**
 * The screens that answered every lookup in full and returned no record. Read from the screens themselves
 * (coverage.clearScreens, written by buildReport), so the brief and the checklist never disagree; a saved
 * report from before that field falls back to its coverage rows, which must show no failure, no lookup
 * waited out and no part unanswered.
 */
export function cleanScreens(coverage) {
  if (Array.isArray(coverage?.clearScreens)) return [...new Set(coverage.clearScreens)];
  const labels = (coverage?.searched || [])
    .filter((s) => SCREEN_IDS.has(s.id) && !(s.records > 0) && !(s.failed > 0) && !(s.waitedOut > 0) && !(s.partial?.length))
    .map((s) => s.label);
  return [...new Set(labels)];
}

// The role a record states a named person took: "Jane Roe became CEO", "Jane Roe, named chief financial
// officer", "CFO Jane Roe". A former role ("former CEO Jane Roe") is not their role.
const ROLE_TITLE = '(?:(?:interim|acting|new|co-)\\s*)?(?:CEO|CFO|COO|CTO|chief [a-z]+ officer|president|chair(?:man|woman|person)?|general counsel|managing director|director)';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function statedRole(name, text) {
  const who = name.trim().split(/\s+/).map(escapeRe).join('\\s+');
  const after = new RegExp(`(?<![A-Za-z])${who},?\\s+(?:(?:is|was|has been|will be)\\s+)?(?:to assume|named|becomes|became|will become|appointed|promoted to)\\s+(?:as\\s+)?(?:the\\s+|its\\s+)?(${ROLE_TITLE})\\b`, 'i');
  const before = new RegExp(`(?<!\\b(?:former|ex-|then)\\s*(?:[a-z-]+\\s+)?)\\b(${ROLE_TITLE})\\s+${who}(?![A-Za-z])`, 'i');
  const m = after.exec(text) || before.exec(text);
  return m ? m[1].replace(/\s+/g, ' ') : null;
}

// A Wikipedia article about something else that only mentions the person (web search marks it 'other'):
// background, not press, and at most WIKI_OTHER_MAX of them in a check.
const WIKI_OTHER_MAX = 3;
const isWikiOther = (f) => f.data?.wikiKind === 'other'
  || (f.match !== 'confirmed' && (f.matchReasons || []).some((r) => /^Wikipedia article about .+, not about the person$/.test(String(r))));
/** Keeps the strongest few articles about something else, in the order given (strongest first). */
function capWikiOther(findings) {
  let kept = 0;
  return findings.filter((f) => !isWikiOther(f) || (kept += 1) <= WIKI_OTHER_MAX);
}

/**
 * A role statement that starts before the company was founded (a graph says CEO from 2008 of a company
 * founded in 2010) is an inconsistency between sources, not an event: listed as such, off the timeline.
 * Reads data.roleStart and data.orgFounded ('YYYY', 'YYYY-MM' or 'YYYY-MM-DD').
 */
function roleBeforeFounding(f) {
  const start = String(f.data?.roleStart || '');
  const founded = String(f.data?.orgFounded || '');
  if (!/^\d{4}/.test(start) || !/^\d{4}/.test(founded)) return false;
  const n = Math.min(start.length, founded.length);
  return start.slice(0, n) < founded.slice(0, n);
}

// How serious the kind of event a red flag reports is, for ordering red flags: a criminal matter first, then
// a regulator's action, a lawsuit or settlement, related-party dealings, a forced departure, everything else.
const FLAG_WEIGHTS = [
  // a sanctions, debarment or wanted-list entry, or a bar from an industry, leads everything
  [6, /\bsanction(?:s|ed)\b|\bdebarr?\w*|\bwanted (?:by|list)\b|\bmost wanted\b|\bexclusion list\b|\bexcluded from federal\b|\bbarred from\b|\bprohibition order\b/i],
  [5,/\bindict\w*|\bconvict\w*|\bsentenc\w+|\bfound guilty\b|\bplead(?:s|ed)? guilty\b|\bpled guilty\b|\bguilty verdict\b|\bprison\b|\bpardon\w*/i],
  [4, /\bSEC\b|\bSecurities and Exchange Commission\b|\bDOJ\b|\bDepartment of Justice\b|\bcharged\b|\bcharges\b|\bFINRA\b|\bFTC\b|\bregulators?\b|\benforcement action\b/i],
  [3, /\blawsuits?\b|\bsue[ds]?\b|\bsuing\b|\bclass[- ]action\b|\bsettle\w*|\bagreed to pay\b/i],
  [2, /\brelated[- ]part(?:y|ies)\b|\bself[- ]dealing\b|\bconflicts? of interest\b|\blandlord to\b/i],
  [1, /\bousted\b|\bfired\b|\bresign\w*|\bstep(?:s|ped)? down\b|\bforced out\b|\bunder pressure\b/i],
];
const weightOf = (text) => (FLAG_WEIGHTS.find(([, re]) => re.test(String(text || ''))) || [0])[0];
/** A red flag's event weight: from its headlines (the lead's and its tied reports'), else the lead's quotation. */
// Sources whose every record is a watchlist, debarment or bar entry: weight 6 whatever the headline says.
const LIST_SOURCES = new Set(['sanctions-lists', 'us-exclusions', 'mdb-debarment', 'wanted-lists', 'us-bank-regulators', 'fincen-actions']);
function flagWeight(flag) {
  // The kind of source sets a floor: a watchlist entry is never outranked by a press headline about a resignation.
  const floor = flag.category === 'sanctions' || LIST_SOURCES.has(flag.source) ? 6 : flag.category === 'regulatory' ? 4 : 0;
  const titles = [flag.title, ...(flag.more || []).filter((m) => m.match !== 'possible').map((m) => m.title)];
  const fromTitles = Math.max(0, ...titles.map(weightOf));
  return Math.max(floor, fromTitles || weightOf(flag.quote));
}

/** Which gaps no free source covered on this run: the fixed list, adjusted to what actually answered. */
function notCoveredFor(state, allSources, answered, silent) {
  const courts = allSources.find((s) => s.id === COURT_DOCKETS);
  // A language the run did search: a source of another country, or a search made in another language.
  const otherLanguage = allSources.some((s) => answered(s) && NON_ENGLISH_SOURCE.test(s.id))
    || (state.done || []).some((key) => {
      const [connector, , , template] = String(key).split('|');
      return NON_ENGLISH_TEMPLATE.test(template || '') && state.sources?.[connector] && answered({ ...state.sources[connector] });
    });
  const abroad = companyCountries(state.findings).map((c) => COUNTRY_GAPS[c] || `Court decisions and financial-regulator enforcement in ${countryName(c)}`);
  if (!(courts && silent(courts)) && !otherLanguage && !abroad.length) return NOT_COVERED;
  // The Delaware courts have a source of their own: when it answered, they are not a gap.
  const delaware = allSources.find((s) => s.id === 'delaware-courts');
  const delawareAsked = Boolean(delaware && answered(delaware));
  return [
    ...(courts && silent(courts) ? [`Court dockets (CourtListener ${courts.off ? 'is not enabled on this deployment' : 'did not answer'}), including US state courts${delawareAsked ? '' : ' and the Delaware Court of Chancery'}`] : []),
    ...NOT_COVERED.map((s) => (otherLanguage && s === NOT_COVERED[NOT_ENGLISH] ? 'Most non-English press, and sources behind a login or paywall' : s)),
    ...abroad,
  ];
}

const matchWeight = (m) => (m === 'company' ? 2 : matchRank(m));
// Sources that screen a person against official watchlists.
const WATCHLISTS = new Set(['sanctions-lists', 'us-exclusions', 'offshore-leaks', 'wanted-lists', 'mdb-debarment', 'us-bank-regulators', 'fincen-actions']);

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// Who a record is about: a named associate or relative, a particular company, or the person.
function whoOf(f) {
  if (f.data?.person) return personKey(f.data.person);
  if (f.match === 'company') {
    const named = f.data?.company || (/^(?:company|affiliate):\s*(.+)$/i.exec(f.via || '') || [])[1];
    return `company:${(named && (companyKeys(named)[0] || norm(named))) || ''}`;
  }
  return 'person';
}
const when = (f) => (f.date ? Date.parse(f.date.length === 4 ? `${f.date}-01-01` : f.date) || 0 : 0);
// For ranking by recency: a date its source marked approximate does not count.
const recency = (f) => (f.data?.dateApprox ? 0 : when(f));

/**
 * Agreement adds a little weight: up to 2 for other sites carrying the same case number, but only up to 1
 * for the same headline words (which reposts and forum threads share), and none for a forum post, so a
 * widely reposted discussion never outranks the court or regulator record of the same matter.
 */
function score(f, corroboration, key = '') {
  const cap = FORUM_SOURCES.has(f.source) ? 0 : key.startsWith('case|') ? 2 : 1;
  return (SEVERITY_WEIGHT[f.severity] || 0) * 3 + matchWeight(f.match) * 2 + (AUTHORITY[f.category] || 1) + Math.min(cap, (corroboration - 1) * 0.75);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATED_PHRASES = [
  // "September 10, 2020", "Sept. 10 2020"
  [new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2}),?\\s+((?:19|20)\\d{2})\\b`, 'gi'), (m) => [m[1], m[2], m[3]]],
  // "10 September 2020"
  [new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE}\\s+((?:19|20)\\d{2})\\b`, 'gi'), (m) => [m[2], m[1], m[3]]],
  // "In July 2021", "July of 2021"
  [new RegExp(`\\b${MONTH_RE}\\s+(?:of\\s+)?((?:19|20)\\d{2})\\b`, 'gi'), (m) => [m[1], null, m[2]]],
];
const pad = (n) => String(n).padStart(2, '0');
/** Every date a text gives to the month or day, as 'YYYY-MM' or 'YYYY-MM-DD', none in the future; `at` is where it starts. */
function datesIn(text, withPlace = false) {
  const out = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const [re, parts] of DATED_PHRASES) {
    for (const m of String(text || '').matchAll(re)) {
      const [mon, day, year] = parts(m);
      const month = MONTHS.findIndex((x) => x.startsWith(mon.toLowerCase().slice(0, 3))) + 1;
      if (!month) continue;
      const d = day && Number(day) >= 1 && Number(day) <= 31 ? `${year}-${pad(month)}-${pad(day)}` : `${year}-${pad(month)}`;
      if (d.slice(0, 7) <= today.slice(0, 7)) out.push(withPlace ? { d, at: m.index } : d);
    }
  }
  return out;
}
// Sentences of a quotation; an abbreviation ("U.S.", "Sept. 10") does not end one.
const sentencesOf = (text) => String(text || '').split(/(?<=[a-z0-9)"'\u201d]{2}[.!?])\s+(?=[A-Z"\u201c])/);
/**
 * The date of the event a record reports, read from its own quotation when the record carries only a
 * year ("On September 10, 2020, ..." -> 2020-09-10) or, for an encyclopaedia, only the date the article
 * was last edited. A record dated to the month joins the other reports of its matter and sits in the
 * right place on the timeline. The latest date of the record's own year is used; nothing is guessed.
 */
function eventDated(f) {
  const revised = f.data?.revisedAt && f.date && String(f.data.revisedAt).startsWith(f.date) && f.date.length >= 7;
  if (!(f.date && /^\d{4}$/.test(f.date)) && !revised) return f;
  const fits = (d) => revised || d.startsWith(f.date);
  const dates = datesIn(f.quote).filter(fits).sort();
  // Several dates: the event's own sentence says which one ("He resigned in September 2020. ... In
  // September 2024 an arbitrator ruled ..."): its first date, the most precise one given there.
  const tag = dates.length > 1 && new Set(dates).size > 1 && eventOf(f);
  if (tag) {
    const re = EVENTS.find(([t]) => t === tag)[1];
    for (const sentence of sentencesOf(f.quote)) {
      if (!re.test(sentence)) continue;
      const found = datesIn(sentence, true).filter((x) => fits(x.d)).sort((a, b) => a.at - b.at || b.d.length - a.d.length);
      if (!found.length) continue;
      const first = found[0].d;
      return { ...f, date: found.map((x) => x.d).filter((d) => d.startsWith(first)).sort().pop() };
    }
    // No sentence gives both the event and a date: an edit date is not the event's date.
    if (revised) return { ...f, date: null };
  }
  if (dates.length) return { ...f, date: dates[dates.length - 1] };
  // An edit date is not the date of the event: without a date in the text the record is undated.
  return revised ? { ...f, date: null } : f;
}

const COURT_TERMS = /\bcourts?\b|\bdocket\w*|\blawsuits?\b|\bsue[ds]?\b|\bsuing\b|\bjudges?\b|\bplaintiffs?\b|\bdefendants?\b|\bv\.\s|\bvs\.?\s|\bcomplaint\b|\btrial\b|\bjury\b|\bverdict\b|\bindict\w*|\bcharged\b|\bconvict\w*|\bsettle\w*|\barbitrat\w*|\bbankrupt\w*|\bchapter (?:7|11)\b|\b\d{1,2}:\d{2}-[a-z]{2}-\d{3,6}\b/i;
const BUY_BACK = /\bbuy[- ]?back\b|\bbuy(?:s|ing)? back\b|\bbids?\b|\bbidding\b|\boffer to (?:buy|acquire)\b|\btakeover\b/i;
/**
 * A departure or a bid to buy a company back, filed under litigation by a news search but carrying no
 * court or docket term, is business history: a role it ended (career) or a deal (company records).
 */
function businessHistory(f) {
  if (f.category !== 'litigation' || PRIMARY_SOURCES.has(f.source)) return f;
  const text = `${f.title || ''} ${f.quote || ''}`;
  if (COURT_TERMS.test(text)) return f;
  if (EVENTS.find(([t]) => t === 'departure')[1].test(f.title || '')) return { ...f, category: 'career' };
  if (BUY_BACK.test(f.title || '')) return { ...f, category: 'corporate' };
  return f;
}

/**
 * Records that say the same thing, whatever kind of source they come from:
 * a shared case number, or the same distinctive headline words. A court
 * record and a news report of the same case corroborate each other.
 */
function corroborationKey(f) {
  const text = `${f.title} ${f.quote || ''}`.toLowerCase();
  const docket = text.match(/\b\d{1,2}:\d{2}-[a-z]{2}-\d{3,6}\b/);
  if (docket) return `case|${docket[0]}`;
  const words = (f.title || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 4).slice(0, 6).sort().join(' ');
  // The same headline about another year, or about someone else, is not the same report.
  return words ? `words|${whoOf(f)}|${f.date ? f.date.slice(0, 4) : 'undated'}|${words}` : `words|${f.id}`;
}
// Only records tied to the person or their company can agree with each other; a namesake's report cannot.
const CORROBORATES = new Set(['confirmed', 'likely', 'company']);

// Words that say nothing about which matter a headline reports.
const COMMON = new Set(['about', 'after', 'again', 'against', 'chief', 'court', 'executive', 'federal', 'former', 'founder', 'judge', 'over', 'report', 'reports', 'says', 'their', 'there', 'which', 'while', 'would']);
/**
 * Distinctive headline words (stemmed to five letters), without the names of the people and companies
 * involved and without the event words themselves ("lawsuit", "sued"), which every record of a matter shares.
 */
function headlineWords(f, skip) {
  const text = `${f.title || ''}${f.title ? '' : ` ${f.quote || ''}`}`.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  return new Set(text.split(/\s+/)
    .filter((w) => w.length > 4 && !COMMON.has(w) && !skip.has(w) && !EVENTS.some(([, re]) => re.test(w)))
    .map((w) => w.slice(0, 5)));
}

// What kind of event a serious record reports, read from its headline first.
const EVENTS = [
  ['pardon', /\bpardon\w*|\bcommut\w+|\bclemency\b/i],
  ['appeal', /\bappeal\w*|\bupheld\b|\baffirm\w*|\boverturn\w*|\brehear\w*/i],
  ['sentence', /\bsentenc\w+|\byears? in (?:federal )?prison\b|\bimprison\w*|\breports? to prison\b/i],
  ['conviction', /\bconvict\w+|\bfound guilty\b|\bguilty verdict\b|\bplead(?:s|ed)? guilty\b|\bpled guilty\b|\bverdict\b/i],
  ['charges', /\bindict\w+|\bcharged\b|\bcharges\b|\barrest\w*|\bextradit\w*/i],
  ['settlement', /\bsettle\w*|\bagreed to pay\b|\bconsent (?:order|decree)\b/i],
  ['bar', /\bbarred\b|\bbanned\b|\bdisqualif\w+|\bdebarr\w+|\bexclu(?:sion|ded)\b|\bprohibition\b/i],
  ['insolvency', /\bbankrupt\w*|\binsolven\w*|\bliquidat\w*|\bchapter (?:7|11)\b|\breceivership\b|\bwound up\b|\bwinding[- ]up\b/i],
  ['lawsuit', /\blawsuits?\b|\bsued\b|\bsues\b|\bsuing\b|\bclass[- ]action\b|\bcomplaint\b/i],
  ['investigation', /\binvestigat\w+|\bprobe\b|\bsubpoena\w*/i],
  ['penalty', /\bfined\b|\bpenalt\w+/i],
  ['departure', /\bousted\b|\bfired\b|\bresign\w*|\bstep(?:s|ped) down\b|\bforced out\b/i],
  ['sanction', /\bsanction\w*/i],
  ['breach', /\bdata breach\b|\bransomware\b|\bleak site\b/i],
  ['fraud', /\bfraud\w*|\bscam\b|\bponzi\b|\bmisconduct\b/i],
];
function eventOf(f) {
  for (const text of [f.title, f.quote]) {
    if (!text) continue;
    for (const [tag, re] of EVENTS) if (re.test(text)) return tag;
  }
  return null;
}

const docketOf = (f) => (`${f.title} ${f.quote || ''}`.toLowerCase().match(/\b\d{1,2}:\d{2}-[a-z]{2}-\d{3,6}\b/) || [])[0];
// Events a person goes through once in a while: two reports of one within a month of each other, about the
// same person, are one matter whatever words their headlines use. (Two lawsuits or investigations in a
// month are common, so those still need matching headline words.)
const RARE_EVENTS = new Set(['conviction', 'sentence', 'charges', 'pardon', 'departure', 'settlement', 'insolvency']);
const WINDOW_MS = 31 * 24 * 3600 * 1000;
/**
 * Rare events tied to the person, clustered by date: sorted by date, a record more than 31 days after the
 * previous one starts a new matter. Returns record id -> matter key.
 */
function dateWindows(serious) {
  const kinds = new Map();
  for (const f of serious) {
    const tag = eventOf(f);
    if ((f.match !== 'confirmed' && f.match !== 'likely') || !RARE_EVENTS.has(tag) || !f.date || f.date.length < 7 || docketOf(f)) continue;
    const kind = `${tag}|${whoOf(f)}`;
    if (!kinds.has(kind)) kinds.set(kind, []);
    kinds.get(kind).push(f);
  }
  const out = new Map();
  for (const [kind, list] of kinds) {
    let i = 0;
    list.sort((a, b) => when(a) - when(b)).forEach((f, j) => {
      if (j > 0 && when(f) - when(list[j - 1]) > WINDOW_MS) i += 1;
      out.set(f.id, `${kind}|window${i}`);
    });
  }
  return out;
}

// Official notices of one company's insolvency (appointment of liquidators, notice to creditors, resolution
// to wind up) share no headline words, but are one matter: the same company within NOTICE_DAYS.
const NOTICE_SOURCES = new Set(['uk-gazette', 'fr-bodacc']);
const NOTICE_DAYS = 14;
function noticeCompany(f) {
  const named = f.data?.company || f.data?.companyName
    || (/Name of Company:\s*([^\n…]+?)(?:\s*…|\.?\s*$|\n)/i.exec(f.quote || '') || [])[1]
    || (/:\s*([^:(]+?)\s*(?:\(|$)/.exec(f.title || '') || [])[1];
  return named ? companyKeyStrict(named) || norm(named) : '';
}
/** Notices of one company clustered by date (NOTICE_DAYS apart at most). Returns record id -> matter key. */
function noticeWindows(serious) {
  const byCompany = new Map();
  for (const f of serious) {
    if (!NOTICE_SOURCES.has(f.source) || !f.date || docketOf(f)) continue;
    const co = noticeCompany(f);
    if (!co) continue;
    const key = `notice|${co}|${f.match === 'possible' ? 'possible' : 'tied'}`;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(f);
  }
  const out = new Map();
  for (const [key, list] of byCompany) {
    let i = 0;
    list.sort((a, b) => when(a) - when(b)).forEach((f, j) => {
      if (j > 0 && when(f) - when(list[j - 1]) > NOTICE_DAYS * 24 * 3600 * 1000) i += 1;
      out.set(f.id, `${key}|window${i}`);
    });
  }
  return out;
}

/**
 * The matter a serious record belongs to: a case number when it has one, a date window for a rare
 * event tied to the person (see dateWindows), otherwise the kind of event and the month it was
 * reported, kept apart for the person, their company, and each associate or relative. Twenty news
 * reports of one sentencing are one matter, not twenty red flags.
 */
function matterKey(f, windows = new Map()) {
  const docket = docketOf(f);
  if (docket) return `case|${docket}`;
  if (windows.has(f.id)) return windows.get(f.id);
  const tag = eventOf(f);
  // Undated records cannot be placed in a month, so nothing ties two of them to one matter.
  if (!tag || !f.date) return `single|${f.id}`;
  // A record matched by name only is never listed as coverage of a matter tied to the person.
  return `${tag}|${f.date.slice(0, 7)}|${whoOf(f)}${f.match === 'possible' ? '|possible' : ''}`;
}

const PLACEHOLDER = /\bThis is some text inside of a div block\b|\blorem ipsum\b|\bHeading goes here\b/i;

// How a record is tied, for ranking: to the person, to their company, by name only.
const tierOf = (m) => (m === 'confirmed' || m === 'likely' ? 2 : m === 'company' ? 1 : 0);
const TIE_ORDER = { confirmed: 4, likely: 3, company: 2, possible: 1 };
const SEVERITY_ORDER = ['info', 'low', 'medium', 'high'];

// Sources that find records by searching the company's name as text: on those, an ordinary word ("Ramp")
// may be found in any sentence that uses the word, so the word alone ties nothing.
const WORD_SEARCH_SOURCES = new Set(['web-search', 'news-archive', 'web-archive', 'page-reader', 'wikipedia', 'hacker-news', 'reddit', 'stack-exchange']);

// Platforms where one person's posts live under their own path (x.com/<handle>/status/...).
const PROFILE_HOSTS = /^(?:x\.com|twitter\.com|github\.com|medium\.com|instagram\.com|threads\.net|bsky\.app|youtube\.com|substack\.com)$/;
/** 'x.com/handle' for a page under a person's profile on a platform, else ''. twitter.com is x.com. */
function profileRoot(url) {
  try {
    const u = new URL(/^https?:/i.test(String(url)) ? url : `https://${url}`);
    let host = u.hostname.toLowerCase().replace(/^(?:www|mobile)\./, '');
    if (host === 'twitter.com') host = 'x.com';
    if (/\.substack\.com$/.test(host)) return host;
    if (!PROFILE_HOSTS.test(host)) return '';
    const first = u.pathname.split('/').filter(Boolean)[0] || '';
    if (!first || /^(?:search|hashtag|i|home|explore|intent|share|status)$/i.test(first)) return '';
    return `${host}/${first.toLowerCase().replace(/^@/, '')}`;
  } catch { return ''; }
}

/**
 * The year the person's company was founded: from the profile's company facts or the companies they
 * founded (profile.js), else read from records tied to the person or the company ("Ramp was founded in
 * March 2019", "co-founded Ramp in 2019"); the year most of them give. Null when nothing says.
 */
function companyFoundedYear(profile, state, subject, coKey) {
  const fact = Number(profile?.companyFacts?.founded?.year);
  if (Number.isFinite(fact) && fact > 1800) return fact;
  const own = (profile?.resume?.founded || []).find((x) => x && x.org && (companyKeys(x.org)[0] || norm(x.org)) === coKey && Number(x.year) > 1800);
  if (own) return Number(own.year);
  const company = String(state.company || '').trim();
  if (!company) return null;
  const co = escapeRe(company);
  const res = [
    new RegExp(`(?<![\\p{L}\\p{N}])${co}(?![\\p{L}\\p{N}])[^.]{0,60}?\\b(?:was\\s+)?(?:founded|started|launched|incorporated|established)\\b[^.]{0,40}?\\bin\\s+(?:[A-Z][a-z]+\\.?\\s+)?((?:19|20)\\d{2})\\b`, 'iu'),
    new RegExp(`\\b(?:co-?founded|founded|started|launched)\\s+${co}(?![\\p{L}\\p{N}])[^.]{0,30}?\\bin\\s+(?:[A-Z][a-z]+\\.?\\s+)?((?:19|20)\\d{2})\\b`, 'iu'),
  ];
  const votes = new Map();
  for (const f of state.findings || []) {
    if (!CORROBORATES.has(f.match)) continue;
    const text = `${f.title || ''}. ${f.quote || ''}`;
    for (const re of res) {
      const m = re.exec(text);
      if (m) { votes.set(Number(m[1]), (votes.get(Number(m[1])) || 0) + 1); break; }
    }
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return best ? best[0] : null;
}

// Sources whose records are pages of the open web: two of them at one address are one page.
const PAGE_SOURCES = new Set(['web-search', 'news-archive', 'web-archive', 'page-reader', 'wikipedia', 'hacker-news']);
/** The address of the page a record shows, without the archive's replay prefix, scheme, www or trailing slash. */
function pageKey(f) {
  if (!PAGE_SOURCES.has(f.source) || f.data?.kind === 'change') return null;
  let u = String((f.source === 'web-archive' && f.data?.page) || f.url || '');
  u = u.replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//i, '');
  try {
    const url = new URL(/^https?:/i.test(u) ? u : `https://${u}`);
    for (const k of [...url.searchParams.keys()]) if (/^(?:utm_|fbclid|gclid|ref$|ref_)/i.test(k)) url.searchParams.delete(k);
    const query = url.searchParams.toString();
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
  } catch { return null; }
}
/**
 * One page is one record. Records of the same page are grouped: the record that leads is the one most
 * strongly tied to the person (then the one that is not an archive capture, then the longest quotation), it
 * takes the strongest tie and the highest severity of the group, and the others are listed under alsoIn.
 * Returns the grouped records and a map of each merged record's id to the id of the record it joined.
 */
function groupPages(list) {
  const byPage = new Map();
  const out = [];
  for (const f of list) {
    const key = pageKey(f);
    if (!key) { out.push([f]); continue; }
    if (!byPage.has(key)) { byPage.set(key, [f]); out.push(byPage.get(key)); } else byPage.get(key).push(f);
  }
  const memberOf = new Map();
  const records = out.map((group) => {
    if (group.length === 1) return group[0];
    const lead = [...group].sort((a, b) => (TIE_ORDER[b.match] || 0) - (TIE_ORDER[a.match] || 0)
      || Number(a.category === 'archive') - Number(b.category === 'archive')
      || String(b.quote || '').length - String(a.quote || '').length)[0];
    const severity = group.map((f) => f.severity).sort((a, b) => SEVERITY_ORDER.indexOf(b) - SEVERITY_ORDER.indexOf(a))[0] || lead.severity;
    const others = group.filter((f) => f !== lead);
    for (const o of others) memberOf.set(o.id, lead.id);
    return {
      ...lead,
      severity,
      date: lead.date || others.find((o) => o.date && o.category !== 'archive')?.date || null,
      alsoIn: others.map((o) => ({ id: o.id, source: o.source, sourceLabel: o.sourceLabel, title: o.title, url: o.url, match: o.match })),
    };
  });
  return { records, memberOf };
}

// A record whose only tie is an event another record reports ("names the conviction reported in ...") is
// not about the person by itself: it never makes a red flag (identity.js matchSubject basis 'event').
const EVENT_REASON = /^names .+ reported in /;
function eventOnly(f) {
  const basis = f.matchBasis || f.data?.matchBasis;
  if (Array.isArray(basis) && basis.length) return basis.every((b) => b === 'event');
  const reasons = (f.matchReasons || []).filter((r) => r !== 'matched by name only');
  return reasons.length > 0 && reasons.every((r) => EVENT_REASON.test(String(r)));
}

// Fields of a profile that are claims in themselves: any change to them is a claim that changed.
const CLAIM_FIELDS = new Set(['headline', 'role', 'education', 'title', 'dates']);
const CLAIM_WORDS = /\b(?:co-?ceo|ceo|cto|cfo|coo|cpo|co-?founder|cofounder|founder|president|chair(?:man|woman|person)?|director|vp|vice president|chief [a-z]+ officer|general partner|partner|engineer|analyst|associate|b\.?a\.?|b\.?s\.?|m\.?s\.?|mba|ph\.?d\.?|j\.?d\.?|bachelor\w*|master\w*|doctorate)(?![\w.])/gi;
// An organisation a career verb or a title places them at ("worked at Paribus", "CEO of Ramp", "graduated from
// Harvard"); a bare "at" or "of" is too common to read as a claim ("at B2B companies").
const CLAIM_ORG = /\b(?:worked at|works at|working at|previously at|formerly at|joined|joins|co-?founded|cofounded|founded|acquired by|graduated from|studied at|(?:co-?ceo|ceo|cto|cfo|coo|founder|co-?founder|president|director|engineer|analyst|partner)\s+(?:of|at))\s+((?:[A-Z][\w&.'’-]*)(?:\s+[A-Z][\w&.'’-]*){0,3})/gi;
/** The claims a text makes: titles, degrees, years, and the organisations it says they were at or founded. */
// Two or three capitalised words in a row: a person's name, when a sentence names someone.
const NAME_PAIR = /(?<![\p{L}])\p{Lu}[\p{Ll}'’-]+(?:\s+\p{Lu}[\p{Ll}'’-]+){1,2}(?![\p{L}])/gu;
function claimTokens(text) {
  const t = String(text || '');
  const out = new Set();
  for (const m of t.matchAll(CLAIM_WORDS)) out.add(m[0].toLowerCase().replace(/[.\s]+/g, '').replace(/^cofounder$/, 'co-founder'));
  for (const m of t.matchAll(/\b(?:19|20)\d{2}\b/g)) out.add(m[0]);
  for (const m of t.matchAll(CLAIM_ORG)) if (/^\p{Lu}/u.test(m[1])) out.add(`org:${m[1].toLowerCase().replace(/[.,'’]+$/, '')}`);
  return out;
}

/**
 * Dated events of the person's career and company that the profile read from tied records (profile.resume
 * and profile.companyFacts): roles started, companies founded, degrees completed, funding rounds. Each cites
 * the records it was read from; one with no citable record is left out.
 */
function profileEvents(profile, company, cite) {
  const out = [];
  const year = (v) => (v == null || v === '' ? null : String(v).slice(0, 10));
  const add = (date, title, category, ids) => {
    const cites = cite(ids);
    if (!date || !/^\d{4}/.test(date) || !cites.length || out.some((e) => e.title === title)) return;
    out.push({ date, title, category, n: cites[0], cites, severity: 'info', fromProfile: true });
  };
  const r = profile?.resume || {};
  for (const x of r.roles || []) add(year(x.from), `${x.title ? `${x.title}, ` : 'Joined '}${x.org}${x.to ? ` (until ${x.to})` : ''}`, 'career', x.ids);
  for (const x of r.founded || []) add(year(x.year), `Founded ${x.org}${x.outcome ? ` (${x.outcome})` : ''}`, 'career', x.ids);
  for (const x of r.education || []) add(year(x.to), `${[x.degree, x.field].filter(Boolean).join(' in ') || 'Studied'}${x.degree || x.field ? ',' : ' at'} ${x.school}`, 'education', x.ids);
  for (const x of r.boards || []) add(year(x.from), `${x.role || 'Board member'}, ${x.org}`, 'career', x.ids);
  const c = profile?.companyFacts || {};
  if (c.founded?.year) add(year(c.founded.year), `${company || 'The company'} founded`, 'corporate', c.founded.ids);
  for (const x of c.funding || []) add(year(x.date), `${company || 'The company'} raised ${[x.amount, x.round].filter(Boolean).join(' ') || 'a round'}${x.lead ? `, led by ${x.lead}` : ''}`, 'corporate', x.ids);
  return out;
}

/**
 * Build the report from a finished (or still running) check state.
 * Pure: no network, no model.
 */
export function buildReport(state) {
  const subject = restoreSubject({ name: state.name, company: state.company, anchors: state.anchors });
  const trustedThreads = Object.values(state.threads || {}).filter((t) => t.trusted);
  // What the tied records say of their career: read first, because it also settles two kinds of doubtful record.
  const profile = buildProfile(subject, state.findings || [], trustedThreads);

  const text0 = (f) => `${f.title || ''}\n${f.quote || ''}\n${f.url || ''}`;
  const textOf = (f) => `${f.title || ''}\n${f.quote || ''}`;
  const personWords = nameTokens(subject.name);
  const isSelf = (s) => subject.hasName(s);
  const coKey = state.company ? (companyKeys(state.company)[0] || norm(state.company)) : '';
  const coAnchor = coKey ? subject.anchors.companies.get(coKey) : null;
  // The company named as a company (names.js companyMention): an ordinary word ("Ramp") counts only where it
  // is used as a company, and a fuller legal name learned for it (identity.addCompanyAlias) counts too.
  // (a company name with no form to match as a company has no anchor: then the name itself, as a whole word)
  const coWordRe = state.company ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(String(state.company).trim())}(?![\\p{L}\\p{N}])`, 'iu') : null;
  const mentionsCompany = (text) => (coAnchor
    ? Boolean(typeof coAnchor.test.mention === 'function' ? coAnchor.test.mention(text).named : coAnchor.test(text))
    : Boolean(coWordRe && coWordRe.test(text)));
  const aliases = [...(subject.anchors.aliases || new Map()).values()].filter((a) => !coKey || a.of === coKey).map((a) => a.value);
  const aliasRes = aliases.map((a) => (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(a)
    ? new RegExp(`(?<![A-Za-z0-9-])${escapeRe(a)}(?![A-Za-z0-9-])`, 'i')
    : new RegExp(`(?<![\\p{L}\\p{N}])${(companyKeyStrict(a) || norm(a)).split(/\s+/).map(escapeRe).join('[\\s,.&-]+')}(?![\\p{L}\\p{N}])`, 'iu')));
  const namesAlias = (text) => aliasRes.some((re) => re.test(text));
  // "Ramp", "Merge", "Merge Labs": the company is named with an ordinary word, so the word alone ties nothing.
  const ordinaryCompany = Boolean(state.company) && isOrdinaryWordCompany(state.company);

  // 1. A record matched by name only that names, beside the person's full name, an employer their own bio
  //    gives (a broker registration at the bank they worked at) is likely theirs. The employer is matched as
  //    an organisation (never "Times Square" for Square), must come from two of their records or a dated span
  //    the record falls in, and must not be a very large employer (thousands of namesakes work at Google).
  //    A serious record is never raised on an employer alone: it stays possible, with the employer as a hint.
  //    Only the source's own words count: a structured source's title is written by the check.
  const SERIOUS = new Set(['high', 'medium']);
  const resumeRoles = Array.isArray(profile.resume?.roles) && profile.resume.roles.length ? profile.resume.roles.filter((r) => !r.current) : null;
  const employers = (resumeRoles || profile.earlier || [])
    .map((e) => ({ org: String(e.org || '').trim(), ids: e.ids || [], from: e.from ?? null, to: e.to ?? null }))
    .filter((e) => e.org.length >= 3 && !isBroadOrganisation(e.org) && (companyKeys(e.org)[0] || norm(e.org)) !== coKey)
    .map((e) => ({ ...e, n: new Set(e.ids).size, mention: companyMentionMatcher(e.org, { person: subject.hasName, personWords }) }));
  // "Y Combinator lists Acme; Jane Roe is not on its founder list": a record that denies the tie.
  const DENIES = /\bnot (?:on|in|listed|among|named|found)\b|\bno match\b|\bis not\b|\bwas not\b|\bnone of\b/i;
  const yearOf = (d) => { const m = /^(\d{4})/.exec(String(d ?? '')); return m ? Number(m[1]) : null; };
  const inSpan = (e, f) => { const y = yearOf(f.date); const a = yearOf(e.from); return y != null && a != null && y >= a && y <= (yearOf(e.to) ?? 9999); };
  const byEmployer = (f) => {
    if (f.match !== 'possible' || !employers.length || f.data?.person) return f;
    if (DENIES.test(textOf(f))) return f;
    const listed = ['firms', 'employers', 'employment'].flatMap((k) => (Array.isArray(f.data?.[k]) ? f.data[k] : []))
      .map((x) => (typeof x === 'string' ? x : x?.name || x?.firm || '')).filter(Boolean);
    const own = [NAME_PLUS_SOURCES.has(f.source) ? f.title : '', f.quote, ...listed].filter(Boolean).join('\n');
    const names = subject.hasName.positions(own);
    if (!names.length) return f;
    const hit = employers.find((e) => {
      const spans = e.mention(own).spans;
      return spans.length > 0 && cooccurrences(own, names, spans, { isSelf }).length > 0;
    });
    if (!hit) return f;
    // One sentence of one record is too thin to tie a record, and a serious record is never tied by an employer
    // alone: it stays possible, and the employer is shown as a lead to confirm with the person.
    if (SERIOUS.has(f.severity) || !(hit.n >= 2 || inSpan(hit, f))) {
      return { ...f, matchReasons: [...(f.matchReasons || []), `names ${hit.org}, a former employer their own bio gives (not enough by itself to tie the record)`], data: { ...(f.data || {}), employerHint: hit.org } };
    }
    return { ...f, match: 'likely', matchReasons: [...(f.matchReasons || []), `names ${hit.org} beside their name, where their own bio says they worked`], data: { ...(f.data || {}), employerTie: hit.org } };
  };
  // 2. A company name several registered companies share ("Merge") ties nothing by itself: a record about "a
  //    company called Merge" that names neither the person, their site nor a known colleague may be another Merge.
  //    Counted as different companies, not entries: one company registered in three states is one company.
  const registered = (state.findings || []).filter((f) => REGISTER_SOURCES.has(f.source) && !subject.hasName(text0(f)));
  const legalName = (f) => String(f.quote || f.title || '').split(/\s+[—–-]\s+|:/)[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const formed = (f) => (String(f.quote || '').match(/\b(?:formed|registered|founded|incorporated)[^—–]{0,24}?((?:19|20)\d\d)/i) || [])[1] || '';
  const sameNameEntries = new Set(registered.map((f) => `${legalName(f)}|${formed(f)}`));
  const sharedName = Boolean(state.company) && sameNameEntries.size >= SHARED_NAME_FROM && new Set(registered.map(legalName)).size >= 2;
  const ownHosts = trustedThreads.filter((t) => t.kind === 'domain' || (t.kind === 'url' && /team or bio page|personal site/.test(t.why || '')))
    .map((t) => { try { return new URL(/^https?:/.test(t.value) ? t.value : `https://${t.value}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } })
    .filter((h) => h && !/(?:forbes|linkedin|crunchbase|substack|medium|techcrunch|bloomberg)\.com$/.test(h));
  const colleagues = trustedThreads.filter((t) => t.kind === 'associate' && String(t.value).trim().split(/\s+/).length >= 2).map((t) => String(t.value).toLowerCase());
  const tiedOtherwise = (f) => {
    const text = textOf(f);
    return subject.hasName(text) || ownHosts.some((h) => text0(f).toLowerCase().includes(h)) || colleagues.some((c) => text.toLowerCase().includes(c)) || namesAlias(text0(f));
  };
  // 3. A company named with an ordinary word ("Ramp", "Merge", "Flow"): a page found on that word alone ("body
  //    found near the boat ramp", "The Ramp church", "Production Ramp-Up") is about the company only when the
  //    word is used as a company's name ("Ramp raises", "Ramp's backers"), whatever case the user typed it in.
  //    The same test the identity matcher uses (names.js companyMention), so the two never disagree.
  const ordinaryWordOnly = (f) => {
    if (!ordinaryCompany || f.match !== 'company' || !WORD_SEARCH_SOURCES.has(f.source) || f.data?.person) return f;
    if (tiedOtherwise(f) || mentionsCompany(textOf(f))) return f;
    return { ...f, match: 'possible', matchReasons: [`the word "${state.company}" appears, but not as the name of this company`], data: { ...(f.data || {}), companyNamesake: true } };
  };
  const byCompanyNameOnly = (f) => {
    if (!sharedName || f.match !== 'company' || NAME_PLUS_SOURCES.has(f.source)) return f;
    if (tiedOtherwise(f)) return f;
    return { ...f, match: 'possible', matchReasons: [`shares the company name only; several companies are called ${state.company}`], data: { ...(f.data || {}), companyNamesake: true } };
  };
  // 4. A post under the person's own profile (x.com/<their handle>/status/...) that names them is theirs: likely.
  const profileRoots = new Set(trustedThreads.filter((t) => t.kind === 'url').map((t) => profileRoot(t.value)).filter(Boolean));
  const underOwnProfile = (f) => {
    if (f.match !== 'possible' || !profileRoots.size || !profileRoots.has(profileRoot(f.url)) || !subject.hasName(textOf(f))) return f;
    return { ...f, match: 'likely', matchReasons: [...(f.matchReasons || []).filter((r) => r !== 'matched by name only'), 'posted under their own profile'] };
  };
  // 5. A domain registered before the company existed was registered by an earlier holder: not the company's history.
  const foundedYear = companyFoundedYear(profile, state, subject, coKey);
  const earlierHolder = (f) => {
    if (f.source !== 'domain-history' || !foundedYear) return f;
    const reg = String(f.data?.registered || f.date || '');
    const y = yearOf(reg);
    if (!y || y >= foundedYear) return f;
    return {
      ...f,
      title: `${f.data?.domain || 'Domain'}: first registered ${reg}, by an earlier holder (${state.company || 'the company'} was founded in ${foundedYear})`,
      excludeFromTimeline: true,
      data: { ...(f.data || {}), earlierHolder: true },
    };
  };
  const mapped = (state.findings || []).map(byEmployer).map(byCompanyNameOnly).map(ordinaryWordOnly).map(underOwnProfile).map(earlierHolder).map(eventDated).map(businessHistory);
  // 6. For a company named with an ordinary word, a record that matches only the word (not the person, not
  //    the company as a company, not a known legal name) leaves the numbered report: it is counted and listed
  //    with the reason, so the reader sees what was set aside.
  const isWordOnly = (f) => ordinaryCompany && f.match === 'possible' && f.data?.companyNamesake && !f.data?.person
    && !subject.hasName(textOf(f)) && !namesAlias(text0(f));
  const wordOnlyRecords = mapped.filter(isWordOnly);
  // A page whose only text is a site builder's placeholder ("This is some text inside of a div block.") says nothing.
  const placeholders = mapped.filter((f) => PLACEHOLDER.test(`${f.title || ''} ${f.quote || ''}`) && !subject.hasName(textOf(f)));
  // 7. One page is one record: a search result, the page reader's text and an archive capture of the same
  //    address are grouped, with the strongest tie among them (see groupPages).
  const { records: findings, memberOf } = groupPages(mapped.filter((f) => !isWordOnly(f) && !placeholders.includes(f)));
  const groups = new Map();
  for (const f of findings) {
    const key = corroborationKey(f);
    // A case number identifies the matter whoever the page names; matching headline words only count when tied.
    if (!CORROBORATES.has(f.match) && !key.startsWith('case|')) continue;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add((() => { try { return new URL(f.url).hostname.replace(/^www\./, ''); } catch { return f.source; } })());
  }
  // Records tied to the person first, then records about their company, then name-only ones, whatever their
  // severity: a namesake's alarming headline is never numbered ahead of what is known about the person.
  const scored = findings
    .map((f) => ({ ...f, corroboration: groups.get(corroborationKey(f))?.size || 1 }))
    .map((f) => ({ ...f, score: score(f, f.corroboration, corroborationKey(f)) }))
    .sort((a, b) => tierOf(b.match) - tierOf(a.match) || b.score - a.score || recency(b) - recency(a));
  const ranked = capWikiOther(scored);
  const wikiOtherDropped = scored.length - ranked.length;

  // Number the records once; the brief, the sections and the UI all cite the same numbers. A copy merged into
  // a page's record cites that record's number.
  const sources = ranked.map((f, i) => ({ n: i + 1, id: f.id, title: f.title, url: f.url, sourceLabel: f.sourceLabel, category: f.category, date: f.date, match: f.match }));
  const numberOf = new Map(sources.map((s) => [s.id, s.n]));
  for (const [member, lead] of memberOf) if (numberOf.has(lead) && !numberOf.has(member)) numberOf.set(member, numberOf.get(lead));
  // Record ids (of the profile, a merged copy, ...) to the record numbers the report cites.
  const cite = (ids) => [...new Set((ids || []).map((id) => numberOf.get(id)).filter(Boolean))];
  const cited = ranked.map((f) => ({ ...f, n: numberOf.get(f.id) }));

  // Serious records, grouped into matters. A matter with at least one record tied to the person (or their
  // company) is a red flag, led by its strongest tied record. A name-only report joins it only through a
  // shared case number; otherwise it stays with the possible namesakes, which are never stated as fact.
  // A page from the open web that only mentions the person in passing (its own headline is about something
  // else: "2021 in the United States", another person's biography) is not a red flag about them, however
  // alarming the sentence that mentions them. It stays in the press section.
  const aboutThem = (f) => {
    if (f.category !== 'press' && f.category !== 'identity') return true;
    if (f.match === 'company' || f.data?.person) return true;
    const title = String(f.title || '');
    return subject.hasName(title) || [...subject.anchors.companies.values()].some((a) => a.test(title));
  };
  const serious = cited.filter((f) => (f.severity === 'high' || f.severity === 'medium') && aboutThem(f));
  // Roles the person held with an end date ({ org, role, from, to }), from the identity anchors.
  const tenures = [...(state.anchors?.roles || []), ...(subject.anchors.roles ? [...subject.anchors.roles.values()] : [])]
    .map((r) => ({ org: String(r.org || r.value || '').trim(), to: String(r.to || '').slice(0, 10) }))
    .filter((r) => r.org && /^\d{4}(?:-\d{2}){0,2}$/.test(r.to));
  // The role whose end a record of the company's insolvency comes after, when insolvency is all the record reports.
  const afterTenure = (f) => {
    if (!tenures.length || !f.date) return null;
    const text = `${f.title || ''} ${f.quote || ''}`;
    if (!EVENTS.find(([t]) => t === 'insolvency')[1].test(text)) return null;
    if (EVENTS.some(([t, re]) => t !== 'insolvency' && t !== 'departure' && re.test(text))) return null;
    return tenures.find((r) => {
      const key = companyKeys(r.org)[0] || norm(r.org);
      const named = whoOf(f) === `company:${key}` || new RegExp(`(?<![A-Za-z0-9])${r.org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(text);
      const n = Math.min(f.date.length, r.to.length);
      return named && f.date.slice(0, n) > r.to.slice(0, n);
    }) || null;
  };
  // Two lawsuits reported in the same month are two matters: a record joins a matter only when it reports
  // the same thing as the matter's lead (same case number, same headline, or shared distinctive words).
  // Name-only records only group with each other (see matterKey), and need a closer match to do so.
  const skip = new Set(`${state.name || ''} ${state.company || ''} ${companyKeys(state.company || '').join(' ')}`.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean));
  // How closely a record agrees with a matter's lead: 0 when it is not the same matter.
  const agreement = (f, lead) => {
    if (corroborationKey(f) === corroborationKey(lead)) return Infinity;
    const extra = new Set([...skip, ...`${f.data?.person || ''} ${lead.data?.person || ''}`.toLowerCase().split(/[^a-z0-9]+/)]);
    const a = headlineWords(f, extra);
    const b = headlineWords(lead, extra);
    const shared = [...a].filter((w) => b.has(w)).length;
    const jaccard = shared / Math.max(1, new Set([...a, ...b]).size);
    const enough = f.match === 'possible' ? shared >= 2 && jaccard >= 0.4 : shared >= 1;
    return enough ? shared : 0;
  };
  const matters = new Map();
  // Rare events of the person clustered by date, and official notices of one company clustered by date.
  const windows = new Map([...dateWindows(serious), ...noticeWindows(serious)]);
  for (const f of serious) {
    const key = matterKey(f, windows);
    if (!matters.has(key)) matters.set(key, []);
    const whole = key.startsWith('case|') || windows.has(f.id);
    let same = whole ? matters.get(key)[0] : null;
    if (!whole) {
      let best = 0;
      for (const list of matters.get(key)) {
        const a = agreement(f, list[0]);
        if (a > best) { best = a; same = list; }
      }
    }
    if (same) same.push(f);
    else matters.get(key).push([f]);
  }
  const short = (f) => ({ n: f.n, title: f.title, url: f.url, sourceLabel: f.sourceLabel, date: f.date, match: f.match });
  const redFlags = []; // about the person
  const companyMatters = []; // about a company they founded or run: context, not a mark against them by itself
  const possibleNamesake = [];
  for (const list of [...matters.values()].flat()) {
    // A record tied only through an event another record reports is not, by itself, about the person.
    const person = list.filter((f) => (f.match === 'confirmed' || f.match === 'likely') && !eventOnly(f));
    const company = list.filter((f) => f.match === 'company');
    // The authority's own record leads (court, prosecutor or regulator, then an encyclopaedia, then news, a
    // forum last); among records of one kind, `cited` is in rank order, so the first is the strongest.
    const tied = person.length ? person : company.length ? company : list;
    const lead = tied.reduce((best, f) => (sourceAuthority(f) > sourceAuthority(best) ? f : best), tied[0]);
    // The matter's latest outcome a record gives (dismissed, acquitted, settled, pardoned: finding.js data.outcome).
    const outcomes = list.filter((f) => f.data?.outcome && (f.match !== 'possible' || !person.length))
      .sort((a, b) => when(b) - when(a) || b.n - a.n);
    const entry = { ...lead, more: list.filter((f) => f !== lead).map(short), ...(outcomes.length ? { outcome: { text: String(outcomes[0].data.outcome), date: outcomes[0].date || null, n: outcomes[0].n } } : {}) };
    // A company's insolvency reported after the person left it is context about the company, not a mark against them.
    // Even when the record names the person: the insolvency of a company they had already left is all it reports.
    // A matter matched by name only stays with the possible namesakes.
    const left = (person.length > 0 || company.length > 0) && tied.every((f) => afterTenure(f)) && afterTenure(lead);
    if (left) {
      companyMatters.push({ ...entry, severity: 'low', title: `${lead.title} (after the person left ${left.org}${left.to ? ` in ${left.to}` : ''})`, afterTenure: left });
      continue;
    }
    (person.length ? redFlags : company.length ? companyMatters : possibleNamesake).push(entry);
  }
  // A minor report of the person stepping down within 30 days of the end of a role the anchors give joins
  // the serious report of that departure (it never makes a red flag by itself).
  const MONTH_MS = 30 * 24 * 3600 * 1000;
  const at = (d) => (d && d.length >= 7 ? Date.parse(d.length === 7 ? `${d}-01` : d.slice(0, 10)) : NaN);
  const nearEnd = (d) => tenures.some((r) => Number.isFinite(at(r.to)) && Math.abs(at(d) - at(r.to)) <= MONTH_MS);
  const departure = EVENTS.find(([t]) => t === 'departure')[1];
  const inFlags = new Set(redFlags.flatMap((r) => [r.n, ...r.more.map((m) => m.n)]));
  for (const f of cited) {
    if (inFlags.has(f.n) || (f.severity !== 'low' && f.severity !== 'info') || (f.match !== 'confirmed' && f.match !== 'likely')) continue;
    if (!departure.test(f.title || '') || !Number.isFinite(at(f.date)) || !nearEnd(f.date)) continue;
    const flag = redFlags.find((r) => eventOf(r) === 'departure' && whoOf(r) === whoOf(f) && Number.isFinite(at(r.date))
      && nearEnd(r.date) && Math.abs(at(r.date) - at(f.date)) <= 2 * MONTH_MS);
    if (flag) { flag.more.push(short(f)); inFlags.add(f.n); }
  }
  // Most serious kind of event first, then the authority of the source that reports it, then rank.
  redFlags.sort((a, b) => flagWeight(b) - flagWeight(a) || (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0)
    || sourceAuthority(b) - sourceAuthority(a) || a.n - b.n);
  companyMatters.sort((a, b) => a.n - b.n);
  possibleNamesake.sort((a, b) => a.n - b.n);
  // A name-only news report whose headline reports a red flag's event within three days of it may be the same
  // story. It stays with the possible namesakes (the name is all that ties it), marked with that red flag's number.
  const DAY_MS = 24 * 3600 * 1000;
  const day = (d) => (d && d.length === 10 ? Date.parse(d) : NaN);
  for (const p of possibleNamesake) {
    if (p.data?.person || p.category !== 'press' || !Number.isFinite(day(p.date))) continue;
    const flag = redFlags.find((r) => {
      const tag = eventOf(r);
      const re = tag && EVENTS.find(([t]) => t === tag)[1];
      return re && re.test(p.title || '') && [r, ...r.more].some((m) => m.match !== 'possible' && Math.abs(day(m.date) - day(p.date)) <= 3 * DAY_MS);
    });
    if (flag) p.sameStoryAs = flag.n;
  }

  const sections = [
    ...SECTION_ORDER.map((key) => ({ key, title: CATEGORIES[key], items: cited.filter((f) => f.category === key && !(key === 'press' && isWikiOther(f))) })),
    // Encyclopaedia articles about something else that mention the person: background, not press.
    { key: 'background', title: 'Background', items: cited.filter((f) => f.category === 'press' && isWikiOther(f)) },
  ].filter((s) => s.items.length > 0);

  // The timeline: each red flag once (its lead record), then the dated records of the person's career,
  // strongest first, up to TIMELINE_MAX. Never a record matched by name only, one its source marked as
  // not for the timeline (a company that only shares the name), or a further report of a red flag's matter.
  // Nor a record whose date its source marked approximate, or a role said to start before its company was founded.
  const offTimeline = (f) => !f.date || f.match === 'possible' || f.excludeFromTimeline || f.data?.excludeFromTimeline
    || f.data?.dateApprox || roleBeforeFounding(f);
  const inconsistencies = cited.filter(roleBeforeFounding).map((f) => ({
    n: f.n, title: f.title,
    note: `The role is given as starting ${f.data.roleStart}, before the company was founded (${f.data.orgFounded}).`,
  }));
  const coverageOfFlag = new Set(redFlags.flatMap((r) => r.more.map((m) => m.n)));
  const leads = redFlags.filter((f) => !offTimeline(f));
  // Career, company and legal events with their own dates. An archive record is dated by its capture, which
  // is not an event: archive records never sit on the timeline (what they show reaches it through the profile).
  const rest = cited.filter((f) => !offTimeline(f) && !coverageOfFlag.has(f.n) && !leads.some((l) => l.n === f.n)
    && ['career', 'corporate', 'litigation', 'regulatory', 'sanctions', 'education'].includes(f.category));
  const events = profileEvents(profile, state.company, cite);
  const row = (f) => ({ date: f.date, title: f.title, category: f.category, n: f.n, severity: f.severity });
  const leadRows = leads.map(row);
  const restRows = rest.map(row);
  // Red flags first, then the career and company events the profile read, then other dated records: the cap
  // cuts the least telling rows. An event already on the timeline as its own record is not repeated.
  const sameRow = (e) => [...leadRows, ...restRows].some((r) => r.n === e.n && String(r.date).slice(0, 4) === String(e.date).slice(0, 4));
  const allRows = [...leadRows, ...events.filter((e) => !sameRow(e)), ...restRows];
  const timeline = allRows.slice(0, TIMELINE_MAX).sort((a, b) => when(a) - when(b) || a.n - b.n);
  const timelineOmitted = Math.max(0, allRows.length - TIMELINE_MAX);

  // Claims that changed: a change to a claim (a title, an employer, a school, a degree, dates) in text about
  // the person. A wording edit, a page's marketing copy or another person's bio on the same page is not a
  // claim of theirs that changed: those stay in the archive list. A change seen on a page matched by name only
  // may be a namesake's profile.
  // The person's own profile page: a path segment that is their name as a slug (ramp.com/authors/eric-glyman,
  // twitter.com/eglyman), not an article whose address starts with their name (/blog/eric-glyman-lessons-learned).
  const slugs = new Set(slugCandidates(subject.name));
  const ownPage = (url) => {
    const u = String(url || '').replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//i, '');
    try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).pathname.toLowerCase().split('/').some((seg) => slugs.has(seg.replace(/^@/, ''))); } catch { return false; }
  };
  const firstName = String(subject.name || '').trim().split(/\s+/)[0] || '';
  const firstRe = firstName.length >= 3 ? new RegExp(`(?<![\\p{L}])${escapeRe(firstName)}(?![\\p{L}])`, 'u') : null;
  // On their own profile page every sentence is theirs unless it names someone else; elsewhere only a sentence
  // that names them in full.
  const namesOther = (x) => [...x.matchAll(NAME_PAIR)].some((m) => isPersonRun(m[0]) && !subject.hasName(m[0]) && !(firstRe && firstRe.test(m[0])));
  const aboutThemIn = (text, own) => sentencesOf(text).filter((x) => subject.hasName(x) || (own && ((firstRe && firstRe.test(x)) || /^(?:He|She|They|I)\b/.test(x.trim()) || !namesOther(x))));
  const isClaimChange = (f) => {
    if (f.category !== 'archive' || f.data?.kind !== 'change' || f.match === 'possible') return false;
    const d = f.data;
    const own = ownPage(d.page || f.url);
    // a saved change without its before and after text: the record's own title and quotation say whose it is
    if (!d.before && !d.after) return (CLAIM_FIELDS.has(d.field) || !d.field) && (own || subject.hasName(textOf(f)));
    if (CLAIM_FIELDS.has(d.field)) return own || subject.hasName(`${d.before || ''}\n${d.after || ''}`);
    if (d.field !== 'bio') return false;
    // Both versions must say something about them: text about them that appears or vanishes whole is a page
    // rewritten around them (a company page's new copy), not a claim of theirs that changed.
    const beforeText = aboutThemIn(d.before, own);
    const afterText = aboutThemIn(d.after, own);
    if (!beforeText.length || !afterText.length) return false;
    const before = claimTokens(beforeText.join(' '));
    const after = claimTokens(afterText.join(' '));
    if (!before.size && !after.size) return false;
    return before.size !== after.size || [...before].some((t) => !after.has(t));
  };
  const claimChanges = cited.filter(isClaimChange);

  // People screened against a watchlist: done task keys read `connector|kind|value|template`. A person counts
  // as screened only when every watchlist lookup planned for them answered: the check lists the lookups that
  // answered in state.screenedOk (and those that did not in state.screenFailed). A saved check from before
  // that list counts a lookup only when its source answered every lookup of the run in full.
  const okKeys = Array.isArray(state.screenedOk) ? new Set(state.screenedOk) : null;
  const failedKeys = new Set(state.screenFailed || []);
  const sourceClean = (id) => { const s = state.sources?.[id]; return Boolean(s && !s.off && s.runs > 0 && !(s.errors > 0) && !(s.waitedOut > 0) && !(s.partial?.length)); };
  const planned = new Map();
  for (const key of [...(state.done || []), ...failedKeys]) {
    const [connector, kind, value] = String(key).split('|');
    if (!WATCHLISTS.has(connector) || kind === 'company' || !value) continue;
    const who = personKey(value);
    if (!planned.has(who)) planned.set(who, new Map());
    planned.get(who).set(String(key), connector);
  }
  const screenOf = (who) => {
    const plan = planned.get(who);
    if (!plan || !plan.size) return {};
    const missed = [...plan].filter(([key, connector]) => failedKeys.has(key) || !(okKeys ? okKeys.has(key) : sourceClean(connector))).map(([, connector]) => connector);
    if (!missed.length) return { screened: true };
    const labels = [...new Set(missed.map((c) => state.sources?.[c]?.label || c))];
    return missed.length < plan.size ? { screened: false, screenedInPart: true, missedScreens: labels } : { screened: false, missedScreens: labels };
  };
  const related = new Map();
  for (const t of Object.values(state.threads || {})) {
    const key = personKey(t.value);
    if ((t.kind === 'relative' || t.kind === 'associate') && t.trusted && !related.has(key)) related.set(key, { name: t.value, kind: t.kind, relation: t.relation || null, role: t.role || null, why: t.why || '', records: [], ...screenOf(key) });
  }
  // A record belongs to a related party when it is about them (data.person), lists them among the people it
  // names (relatives, related persons of a filing, persons a lookup tagged), or is tied to the subject and
  // names the party in full in its headline or quotation. A surname alone never attaches a record.
  const nameOf = (p) => String((p && typeof p === 'object' ? p.name : p) || '').trim();
  const fullName = (name) => name.split(/\s+/).filter(Boolean).length >= 2;
  const matchers = new Map([...related].filter(([, p]) => fullName(p.name)).map(([key, p]) => [key, nameMatcher([p.name])]));
  for (const f of cited) {
    const listed = [f.data?.person, ...['relatives', 'relatedPersons', 'persons'].flatMap((k) => (Array.isArray(f.data?.[k]) ? f.data[k] : []))]
      .map(nameOf).filter(Boolean).map(personKey);
    const text = `${f.title || ''}\n${f.quote || ''}`;
    for (const [key, party] of related) {
      const tied = listed.includes(key)
        || ((f.match === 'confirmed' || f.match === 'likely') && matchers.has(key) && matchers.get(key)(text));
      if (tied && !party.records.some((r) => r.n === f.n)) party.records.push({ n: f.n, title: f.title, severity: f.severity, category: f.category });
    }
  }
  // A party with no role: the roles a filing lists for them, else the role a record tied to them states.
  for (const [key, party] of related) {
    if (party.role) continue;
    const mine = cited.filter((f) => party.records.some((r) => r.n === f.n));
    const listedRoles = mine.flatMap((f) => (Array.isArray(f.data?.relatedPersons) ? f.data.relatedPersons : []))
      .find((p) => p && typeof p === 'object' && personKey(nameOf(p)) === key && Array.isArray(p.roles) && p.roles.length)?.roles;
    const role = listedRoles ? listedRoles.join(', ') : fullName(party.name) ? mine.map((f) => statedRole(party.name, `${f.title || ''}. ${f.quote || ''}`)).find(Boolean) : null;
    if (role) party.role = role;
  }

  const allSources = Object.entries(state.sources || {}).map(([id, s]) => ({ id, ...s }));
  const answered = (s) => !s.off && s.runs > 0 && (s.errors || 0) < s.runs;
  const silent = (s) => s.off || (s.runs > 0 && s.errors >= s.runs);
  const screens = screensOf(allSources, cited, wordOnlyRecords);
  const coverage = {
    // Only sources that answered at least once: a source whose every lookup failed searched nothing.
    searched: allSources.filter(answered).map((s) => ({
      id: s.id, label: s.label, lookups: s.runs, records: s.findings, failed: s.errors, lastError: s.errors ? s.lastError : null,
      ...(s.waitedOut ? { waitedOut: s.waitedOut } : {}), ...(s.partial?.length ? { partial: s.partial } : {}),
    })),
    // Answered, but not in full: some lookups failed (a fifth or more makes what it found a partial picture;
    // fewer is still stated, as `minor`), lookups waited for a source's allowance and could not run within the
    // check (not failures), or parts of the source did not answer.
    partlyAnswered: allSources.filter((s) => answered(s) && (s.errors > 0 || s.waitedOut > 0 || s.partial?.length > 0))
      .map((s) => ({
        label: s.label, failed: s.errors || 0, lookups: s.runs, ...(s.waitedOut ? { notRun: s.waitedOut } : {}),
        ...(s.partial?.length ? { parts: s.partial } : {}),
        ...(s.errors > 0 && s.errors / s.runs < PARTLY_ANSWERED && !s.waitedOut && !s.partial?.length ? { minor: true } : {}),
        reason: [
          s.errors > 0 ? `${s.errors} of ${s.runs} lookups failed${s.lastError ? `: ${s.lastError}` : ''}` : '',
          s.waitedOut ? `${s.waitedOut} more lookup${s.waitedOut === 1 ? '' : 's'} not run because its allowance for the next few minutes was used up` : '',
          s.partial?.length ? `parts did not answer: ${s.partial.join(', ')}` : '',
        ].filter(Boolean).join('; '),
      })),
    notSearched: allSources.filter(silent).map((s) => ({ label: s.label, reason: s.lastError || (s.off ? 'Not enabled on this deployment.' : 'No answer.'), ...(s.off ? { off: true } : {}) })),
    notCovered: notCoveredFor(state, allSources, answered, silent),
    // The screens that answered every lookup in full and found nothing (the brief's "Screens with no match").
    clearScreens: screens.flatMap((g) => g.items).filter((i) => i.status === 'clear').map((i) => i.label),
    dropped: state.dropped || { tasks: 0, findings: 0, threads: 0 },
    lookups: state.tasksRun || 0,
    rounds: state.step || 0,
  };

  const count = (m) => cited.filter((f) => f.match === m).length;

  // When a company was typed and no record tied to the person names them with it, nothing independent
  // confirms the claimed role: a thin footprint is not a clean one, and the report says so.
  const withCompany = !state.company || cited.some((f) => (f.match === 'confirmed' || f.match === 'likely')
    && subject.hasName(textOf(f)) && (mentionsCompany(textOf(f)) || namesAlias(text0(f))));
  const identityNote = withCompany ? null
    : `No record found ties ${state.name} to ${state.company}. Confirm their identity and their role at ${state.company} directly; the counts below are not evidence of a clean record.`;
  const identity = identityNote ? { ...(state.identity || {}), note: [state.identity?.note, identityNote].filter(Boolean).join(' ') } : state.identity;
  // A very common name: counts only, never a namesake's details. Several organisations among the name-only
  // records also say the name is shared.
  const possibleOrgs = new Set(cited.filter((f) => f.match === 'possible')
    .map((f) => f.data?.company || f.data?.firm || f.data?.employer || (Array.isArray(f.data?.assignees) ? f.data.assignees[0] : ''))
    .filter(Boolean).map((o) => companyKeys(String(o))[0] || norm(o)));
  const common = isCommonName(state.name || '');
  const commonName = common || possibleOrgs.size >= 3
    ? { common: true, reason: common ? 'very common name' : 'name-only records name several organisations', nameOnlyRecords: count('possible'), organisations: possibleOrgs.size }
    : null;

  // The published profile, with leads to confirm with the person: name-only records that name an employer their
  // own bio gives. A lead is a question, never a fact.
  const published = reportProfile(profile, cite);
  const recordLeads = cited.filter((f) => f.match === 'possible' && f.data?.employerHint)
    .map((f) => ({ text: f.title, why: `Matched by name only; it names ${f.data.employerHint}, an employer their own bio gives. Ask whether this is them.`, cites: [f.n] }));
  let leadsOmitted = 0;
  if (published) {
    const all = [...published.leads, ...recordLeads];
    leadsOmitted = Math.max(0, all.length - LEADS_MAX);
    published.leads = all.slice(0, LEADS_MAX);
  }

  return {
    name: state.name,
    company: state.company || null,
    identity,
    identityNote,
    commonName,
    generatedAt: new Date().toISOString(),
    profile: published,
    companyFacts: reportCompanyFacts(profile.companyFacts, cite),
    screens,
    sharedCompanyName: sharedName,
    // Records are pages: copies of one page merged into one record are counted once (copiesMerged says how many).
    totals: {
      records: cited.length, confirmed: count('confirmed'), likely: count('likely'), possible: count('possible'), company: count('company'),
      redFlags: redFlags.length, companyMatters: companyMatters.length, possibleNamesake: possibleNamesake.length, seriousRecords: serious.length,
      copiesMerged: memberOf.size, wordOnly: wordOnlyRecords.length, ...(identityNote ? { companyUnconfirmed: true } : {}),
    },
    redFlags,
    companyMatters,
    possibleNamesake,
    // Records that match only the ordinary word the company is named with: out of the numbered report, listed with the reason.
    wordOnly: {
      count: wordOnlyRecords.length,
      items: wordOnlyRecords.slice(0, WORD_ONLY_LISTED).map((f) => ({ title: f.title, url: f.url, source: f.source, sourceLabel: f.sourceLabel, date: f.date || null, reason: (f.matchReasons || [])[0] || `matches only the word "${state.company}"` })),
      omitted: Math.max(0, wordOnlyRecords.length - WORD_ONLY_LISTED),
    },
    sections,
    timeline,
    claimChanges,
    inconsistencies,
    relatedParties: [...related.values()].sort((a, b) => b.records.length - a.records.length),
    threads: Object.values(state.threads || {}).filter((t) => t.trusted).map(({ kind, value, why, relation }) => ({ kind, value, why, relation: relation || null })),
    coverage,
    // What each cap cut, so nothing is left out silently.
    omitted: { timeline: timelineOmitted, wikiOther: wikiOtherDropped, wordOnly: wordOnlyRecords.length, leads: leadsOmitted, placeholder: placeholders.length },
    sources,
    log: state.log || [],
    notice: USE_NOTICE,
  };
}

const LEADS_MAX = 12;
const WORD_ONLY_LISTED = 40;
const withCites = (list, cite, pick) => (Array.isArray(list) ? list : []).filter(Boolean).map((x) => ({ ...pick(x), cites: cite(x.ids) }));

/**
 * The profile in the report's form: every line cites record numbers in place of record ids. From
 * profile.resume when profile.js gives it (roles, education with degree and field, companies founded, boards,
 * investments, recognition, and leads to confirm with the person); otherwise from the older fields (the
 * current role from the headline, the earlier employers, the schools). `earlier` is kept for older pages.
 * Null when empty.
 * @param {object} profile from profile.buildProfile
 * @param {(ids: string[]) => number[]} cite record ids to record numbers
 */
export function reportProfile(profile, cite) {
  if (!profile) return null;
  const r = profile.resume && typeof profile.resume === 'object' ? profile.resume : null;
  const headlineRole = profile.headline && profile.company && profile.titles?.length
    ? { org: profile.company, title: profile.titles.join(profile.titles.length === 2 ? ' and ' : ', '), from: null, to: null, current: true, cites: cite(profile.headlineIds) }
    : null;
  const start = (x) => (x.current ? 10000 : 0) + (Number(x.from) || Number(x.to) || 0);
  let roles;
  if (r && Array.isArray(r.roles) && r.roles.length) {
    roles = withCites(r.roles, cite, (x) => ({ org: x.org, title: x.title || null, from: x.from ?? null, to: x.to ?? null, current: Boolean(x.current), basis: x.basis || null }));
    // the headline's current role when the resume has none at the company
    const at = (x) => companyKeys(x.org || '')[0] || norm(x.org);
    if (headlineRole && !roles.some((x) => x.current && at(x) === at(headlineRole))) roles.push(headlineRole);
  } else {
    roles = [
      ...(headlineRole ? [headlineRole] : []),
      ...(profile.earlier || []).map((e) => ({ org: e.org, title: e.role || null, from: e.from ?? null, to: e.to ?? null, current: Boolean(e.current), cites: cite(e.ids) })),
    ];
  }
  roles.sort((a, b) => start(b) - start(a));
  const education = r && Array.isArray(r.education) && r.education.length
    ? withCites(r.education, cite, (e) => ({ school: e.school, degree: e.degree || null, field: e.field || null, from: e.from ?? null, to: e.to ?? null, basis: e.basis || null }))
    : (profile.education || []).map((e) => ({ school: e.school, degree: e.degree || null, field: e.field || null, from: e.from ?? null, to: e.to ?? null, cites: cite(e.ids) }));
  const out = {
    headline: profile.headline, headlineCites: cite(profile.headlineIds), company: profile.company,
    roles,
    education,
    earlier: r && Array.isArray(r.roles) && r.roles.length
      ? roles.filter((x) => !x.current).map((x) => ({ org: x.org, role: x.title || null, cites: x.cites }))
      : (profile.earlier || []).map((e) => ({ org: e.org, role: e.role || null, cites: cite(e.ids) })),
    founded: withCites(r?.founded, cite, (x) => ({ org: x.org, year: x.year ?? null, with: Array.isArray(x.with) ? x.with : [], outcome: x.outcome || null })),
    boards: withCites(r?.boards, cite, (x) => ({ org: x.org, role: x.role || null, from: x.from ?? null, to: x.to ?? null })),
    investments: withCites(r?.investments, cite, (x) => ({ text: x.text || x.org || '', org: x.org || null })),
    // `title` repeats the text for profileModel.mergeProfile, which keys recognition on it
    recognition: withCites(r?.recognition, cite, (x) => ({ text: x.text || x.title || '', title: x.text || x.title || '', year: x.year ?? null })),
    leads: withCites(r?.leads, cite, (x) => ({ text: x.text, why: x.why || null })),
    basedIn: profile.basedIn ? { text: profile.basedIn.text, cites: cite(profile.basedIn.ids) } : null,
    about: (profile.about || []).map((a) => ({ text: a.text, cites: cite([a.id]) })),
    links: profile.links || [],
    readBy: profile.readBy || 'records',
  };
  const has = out.headline || out.roles.length || out.education.length || out.basedIn || out.about.length || out.links.length
    || out.founded.length || out.boards.length || out.investments.length || out.recognition.length || out.leads.length;
  return has ? out : null;
}

/**
 * What the records say of the person's company (profile.companyFacts), with citation numbers in place of
 * record ids: legal names, domains, founding year, funding rounds, investors, standing. Null when absent.
 */
export function reportCompanyFacts(facts, cite) {
  if (!facts || typeof facts !== 'object') return null;
  const out = {
    legalNames: withCites(facts.legalNames, cite, (x) => ({ name: x.name })),
    domains: withCites(facts.domains, cite, (x) => ({ domain: x.domain })),
    founded: facts.founded && facts.founded.year != null ? { year: facts.founded.year, cites: cite(facts.founded.ids) } : null,
    funding: withCites(facts.funding, cite, (x) => ({ round: x.round || null, amount: x.amount || null, date: x.date || null, lead: x.lead || null, investors: Array.isArray(x.investors) ? x.investors : [] })),
    investors: withCites(facts.investors, cite, (x) => ({ name: x.name })),
    standing: withCites(facts.standing, cite, (x) => ({ text: x.text })),
  };
  const has = out.legalNames.length || out.domains.length || out.founded || out.funding.length || out.investors.length || out.standing.length;
  return has ? out : null;
}

export const DEEP_SECTIONS = ['## BOTTOM LINE', '## RED FLAGS', '## WHAT CHECKS OUT', '## CLAIMS THAT CHANGED OVER TIME', '## RELATED PARTIES', '## GAPS AND UNVERIFIED CLAIMS', '## QUESTIONS FOR THE FOUNDER'];

const DEEP_PROMPT = `You are a senior due-diligence analyst writing for a venture investor who is deciding whether to back this person. Use ONLY the numbered records. Each record says how sure we are it is about this person:
- "confirmed" or "likely": about this person.
- "company": about a company the person founded or runs, not the person. Report it as context about the company; it is a red flag for the person only if a record ties them to it personally.
- "possible": matched by name only. It may be a different person with the same name. Never state it as a fact about this person; mention it only under GAPS AND UNVERIFIED CLAIMS as something to rule out.

Rules:
- Cite every factual sentence or bullet with [Source n]. Never cite a number that is not listed. Never add a fact that is not in a record.
- Weigh the evidence: say which records are official (court, regulator, sanctions list, filing) and which are press or web. Point out conflicts between records.
- No finding in a category is not proof of a clean record; say what was not covered.
- Leave out anything about health, religion, private family life or children. Family members are relevant only for their own business, political or financial roles.
- Be specific and brief. No filler, no praise, no speculation about motives.

Format (Markdown, exactly these sections, in order):
## BOTTOM LINE
(three to five sentences: who this is, the most serious verified issues or the absence of any, and how much weight the evidence can bear)
## RED FLAGS
(bullets, most serious first: "• <what happened, when> [Source n]"; write "None found in the records searched." if there are none)
## WHAT CHECKS OUT
(claims about career, education, companies, patents confirmed by an independent record)
## CLAIMS THAT CHANGED OVER TIME
(differences between archived versions of profiles or bios; "None found." if none)
## RELATED PARTIES
(relatives or close associates in business, political or financial roles tied to this person, and anything found on them; "None found." if none)
## GAPS AND UNVERIFIED CLAIMS
(claims no independent record supports, possible namesake records to rule out, sources that failed or do not exist for free)
## QUESTIONS FOR THE FOUNDER
(five to eight pointed questions and the document that would settle each)
Then one final line: CONFIDENCE: High|Medium|Low - <reason>`;

function recordsBlock(records) {
  return records.map((f) => `[Source ${f.n}] (${f.match}; ${CATEGORIES[f.category]}; ${f.sourceLabel}${f.data?.kind === 'bio' ? '; a bio or interview page, not an independent record' : ''}${f.date ? `; ${f.date}` : ''}${f.severity !== 'info' ? `; severity ${f.severity}` : ''}${f.more?.length ? `; ${f.more.length} more record${f.more.length === 1 ? '' : 's'} report the same matter` : ''})\n${f.title}${f.quote ? `\n"${f.quote}"` : ''}`).join('\n\n');
}

/** Text cut to about n characters at a space, never inside a word or a number ("$1,850,00"). */
function clipWords(text, n) {
  const t = String(text || '');
  if (t.length <= n) return t;
  const cut = t.slice(0, n + 1).replace(/\s+\S*$/, '');
  return `${cut || t.slice(0, n)}…`;
}

/** A brief assembled from the records themselves (no model). */
export function quotedDeepBrief(report, reason) {
  // Every cut list says how many it left out (the report itself lists them all).
  const capped = (list, n, fmt) => [...list.slice(0, n).map(fmt), ...(list.length > n ? [`• … and ${list.length - n} more in the report.`] : [])];
  const line = (f) => `• ${f.title}${f.date ? ` (${f.date})` : ''}${f.quote ? `: "${clipWords(f.quote, 240)}"` : ''} [Source ${f.n}]`;
  const of = (key) => (report.sections.find((s) => s.key === key)?.items || []).filter((f) => f.match !== 'possible');
  const t = report.totals;
  const bottom = `${report.identityNote ? `${report.identityNote} ` : ''}${t.records} records were collected about ${report.name}${report.company ? ` (${report.company})` : ''}: ${t.confirmed + t.likely} tied to this person, ${t.company} about their company, ${t.possible} matched by name only. ${t.redFlags ? `${t.redFlags} serious matter(s) are tied to this person.` : 'No serious record is tied to this person in the sources searched.'}${t.companyMatters ? ` ${t.companyMatters} more concern a company they founded or run.` : ''}`;
  // what a bio or interview page says is the person's own account, not a record that confirms it
  const allChecks = [...of('education'), ...of('career'), ...of('corporate'), ...of('ip')].filter((f) => f.data?.kind !== 'bio' && !f.data?.earlierHolder);
  const possibleChanges = (report.sections.find((s) => s.key === 'archive')?.items || []).filter((f) => f.match === 'possible' && f.data?.kind === 'change');
  const gaps = [
    ...capped([...report.possibleNamesake, ...possibleChanges], 13, (f) => `• Rule out a namesake: ${f.title} [Source ${f.n}]${f.sameStoryAs ? ` (reports the same kind of event within days of [Source ${f.sameStoryAs}]; it may be the same story)` : ''}`),
    ...(report.wordOnly?.count ? [`• ${report.wordOnly.count} record${report.wordOnly.count === 1 ? '' : 's'} matching only the word "${report.company}" (not this company) were set aside.`] : []),
    ...report.coverage.notSearched.map((s) => (s.off ? `• ${s.label}: not enabled on this deployment.` : `• ${s.label} did not answer: ${s.reason}`)),
    ...(report.coverage.partlyAnswered || []).map((s) => `• ${s.label} answered only in part: ${s.reason}.`),
    ...report.coverage.notCovered.map((s) => `• Not covered: ${s}.`),
    ...(report.inconsistencies || []).map((x) => `• Inconsistent record: ${x.title}. ${x.note} [Source ${x.n}]`),
  ];
  const clean = cleanScreens(report.coverage);
  // The records were cleaned when they were made; the assembled text goes through the same rules a model's does.
  return cleanModelText([
    '## BOTTOM LINE', bottom,
    '', '## RED FLAGS', report.redFlags.length ? capped(report.redFlags, 14, line).join('\n') : 'None found in the records searched.',
    ...(clean.length ? [`Screens with no match: ${clean.join(', ')}.`] : []),
    ...(report.companyMatters?.length ? ['', 'About their companies:', capped(report.companyMatters, 8, line).join('\n')] : []),
    '', '## WHAT CHECKS OUT', allChecks.length ? capped(allChecks, 10, line).join('\n') : 'No independent record confirming a claim was found.',
    '', '## CLAIMS THAT CHANGED OVER TIME', report.claimChanges.length ? capped(report.claimChanges, 10, line).join('\n') : 'None found.',
    '', '## RELATED PARTIES', report.relatedParties.length ? capped(report.relatedParties, 10, (p) => `• ${p.name}${p.relation ? ` (${p.relation})` : p.kind === 'associate' ? ' (associate)' : ''}${p.role ? `, ${p.role}` : ''}${p.records.length ? ` ${p.records.map((r) => `[Source ${r.n}]`).join(' ')}` : ''}`).join('\n') : 'None found.',
    '', '## GAPS AND UNVERIFIED CLAIMS', gaps.join('\n'),
    '', '## QUESTIONS FOR THE FOUNDER', '• Ask for a full CV with dates and a reference at each employer, and compare it with the records above.\n• Ask the founder to explain each red flag and each change between archived versions, with documents.\n• Ask for degree certificates or permission to verify with each institution.',
    '', `*Note: ${reason}, so this brief is assembled from the records themselves.*`,
  ].join('\n')).text;
}

/**
 * Write the brief with the free model chain. Returns { brief, briefInfo }.
 * @param {object} report from buildReport
 * @param {{ deadline?: number, maxRecords?: number, complete?: Function, avoid?: string[] }} options
 *   avoid: model families already tried (see briefInfo.tried), for a second attempt
 */
export async function writeDeepBrief(report, { deadline = null, maxRecords = 70, complete = chatComplete, avoid = [] } = {}) {
  const all = [...report.redFlags, ...(report.companyMatters || []).slice(0, 12), ...report.sections.flatMap((s) => s.items)];
  const seen = new Set();
  const records = [];
  for (const f of all) {
    if (seen.has(f.n)) continue;
    seen.add(f.n);
    records.push(f);
  }
  // Give the model the strongest records from every category rather than only the top of one.
  const perCategory = Math.max(4, Math.floor(maxRecords / Math.max(1, report.sections.length)));
  const picked = [];
  const taken = {};
  // A saved report may have lost its scores; then rank by severity and keep the report's own order.
  const byStrength = (a, b) => (Number.isFinite(a.score) && Number.isFinite(b.score) ? b.score - a.score : 0)
    || (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0) || a.n - b.n;
  for (const f of records.sort(byStrength)) {
    if (picked.length >= maxRecords) break;
    taken[f.category] = (taken[f.category] || 0) + 1;
    if (taken[f.category] <= perCategory || f.severity === 'high') picked.push(f);
  }
  picked.sort((a, b) => a.n - b.n);
  if (!picked.length) return { brief: null, briefInfo: null };
  if (!PROVIDERS.some(providerEnabled)) return { brief: quotedDeepBrief(report, 'AI answers are not enabled on this deployment'), briefInfo: { mode: 'quoted', reason: 'AI answers are not enabled on this deployment' } };

  const identity = report.identity?.note ? `\nIdentity note: ${report.identity.note}` : '';
  const partly = report.coverage.partlyAnswered || [];
  const notEnabled = report.coverage.notSearched.filter((s) => s.off).map((s) => s.label);
  const failed = report.coverage.notSearched.filter((s) => !s.off).map((s) => s.label);
  const coverage = `Sources that answered: ${report.coverage.searched.map((s) => s.label).join(', ') || 'none'}.\n${partly.length ? `Sources that answered only in part: ${partly.map((s) => `${s.label} (${s.reason})`).join('; ')}.\n` : ''}Sources that did not answer: ${failed.join(', ') || 'none'}.\nSources not enabled on this deployment: ${notEnabled.join(', ') || 'none'}.\nNot covered by any free source: ${report.coverage.notCovered.join('; ')}.${cleanScreens(report.coverage).length ? `\nScreens with no match:${cleanScreens(report.coverage).join(', ')}.` : ''}`;
  const user = `Today's date: ${new Date().toISOString().slice(0, 10)}\nPerson: ${report.name}${report.company ? `\nCompany: ${report.company}` : ''}${identity}\n\n${coverage}\n\nRecords (${picked.length} of ${report.totals.records}, strongest first within each kind${(report.companyMatters || []).length > 12 ? `; ${report.companyMatters.length - 12} more company matters not shown` : ''}):\n${recordsBlock(picked)}`;
  const maxN = report.sources.length;
  // A citation is only valid if that record was actually shown to the model. Unshown ones are removed
  // before the checks, so an answer resting only on records it was not shown fails like an uncited one.
  const shown = new Set(picked.map((f) => f.n));
  const check = (text) => {
    // The model's text goes through the privacy rules first (it may add what no record says: children, a birth
    // date); a removed line takes its citations with it, so the citation checks below run on what is left.
    const first = validateAnswer(cleanModelText(String(text || '')).text, maxN, DEEP_SECTIONS);
    if (!first.ok) return first;
    const lines = first.content.split('\n').map((line) => {
      const kept = line.replace(/\[Source (\d+)\]/g, (m, n) => (shown.has(Number(n)) ? m : ''));
      // a bullet whose only citations pointed to unshown records is an uncited claim: drop it
      if (kept !== line && !/\[Source \d+\]/.test(kept) && /^\s*[•*-]/.test(kept)) return null;
      return kept;
    });
    const content = lines.filter((l) => l !== null).join('\n');
    const citations = (content.match(/\[Source \d+\]/g) || []).length;
    if (citations === 0) return { ok: false, reason: 'no valid citations' };
    return { ...first, content, citations };
  };
  // 'analysis': the strongest models, more thinking, and no model with a poor record on made-up facts.
  // An answer that fails the citation checks sends the request to the next model.
  const trace = [];
  const out = await complete([{ role: 'system', content: DEEP_PROMPT }, { role: 'user', content: user }], {
    maxTokens: 3500, deadline, task: 'analysis', personal: true, avoid, trace,
    hedgeMs: 6000, // a slow first service is joined by the others rather than waited out (llm/providers.js)
    accept: (text) => check(text).ok,
  });
  if (!out) {
    // Which models were tried, so one more attempt can start with the next ones (a long report can outlast the first model's time)
    const tried = [...new Set([...avoid, ...trace.map((t) => t.family).filter(Boolean)])];
    return { brief: quotedDeepBrief(report, 'The AI model was unavailable'), briefInfo: { mode: 'quoted', reason: 'The AI model was unavailable', tried, retry: trace.length > 0 && avoid.length === 0 } };
  }
  const checked = check(out.text);
  if (!checked.ok) return { brief: quotedDeepBrief(report, `The AI brief failed validation (${checked.reason})`), briefInfo: { mode: 'quoted', reason: `The AI brief failed validation (${checked.reason})` } };
  return { brief: checked.content, briefInfo: { mode: 'ai', provider: out.providerLabel, model: out.model, confidence: checked.confidence, skipped: out.skipped || [], recordsRead: picked.length } };
}
