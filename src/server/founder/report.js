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
import { buildProfile } from './profile';
import { matchRank, restoreSubject, personKey } from './identity';
import { companyKeys, nameMatcher } from '../founderCheck';
import { USE_NOTICE } from './guardrails';
import { chatComplete, PROVIDERS, providerEnabled } from '../llm/providers';
import { validateAnswer } from '../search/answer';

const SECTION_ORDER = ['sanctions', 'regulatory', 'litigation', 'leaks', 'exposure', 'archive', 'career', 'education', 'corporate', 'related', 'ip', 'identity', 'press'];
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1, info: 0 };
// Records from the authority itself outrank a report about it.
const AUTHORITY = { sanctions: 3, regulatory: 3, litigation: 3, leaks: 2.5, corporate: 2.5, archive: 2, ip: 2, education: 2, exposure: 2, career: 1.5, identity: 1.5, related: 1.5, press: 1 };

// Which kind of source a record comes from, for choosing the record that leads a matter: the authority
// itself (court, prosecutor, regulator, watchlist) first, then the encyclopaedias, then news and the web,
// and a discussion forum last. A forum post is never the headline of a sentencing a court record reports.
const PRIMARY_SOURCES = new Set(['doj-press-releases', 'court-dockets', 'court-records-open', 'us-enforcement-actions', 'finra-brokercheck', 'uk-gazette', 'uk-case-law', 'fr-bodacc', 'sec-filings', 'sec-company', 'sanctions-lists', 'us-exclusions', 'wanted-lists']);
const REFERENCE_SOURCES = new Set(['wikipedia', 'wikidata']);
const FORUM_SOURCES = new Set(['hacker-news']);
const sourceAuthority = (f) => (PRIMARY_SOURCES.has(f.source) ? 3 : REFERENCE_SOURCES.has(f.source) ? 2 : FORUM_SOURCES.has(f.source) ? 0 : 1);

export const NOT_COVERED = [
  'US state and county court records, and full federal dockets (PACER), beyond what CourtListener and news sources carry',
  'Criminal records, credit history, liens and judgments held by commercial background-check providers',
  'Private company financials, cap tables and unpublished regulatory correspondence',
  'Sources that are not in English or are behind a login or paywall',
  'Anything a person has had removed from the web and that was never archived',
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

// Watchlist, court and enforcement screens: one that answered every lookup and found nothing is a clean
// result worth stating ("Screens with no match"), not only a silence. Ids as the sources register them.
const SCREENS = {
  'sanctions-lists': 'sanctions (US, UN, EU, UK, Canada)',
  'us-exclusions': 'US exclusion lists',
  'mdb-debarment': 'development bank debarments',
  'wanted-lists': 'FBI/EU wanted lists',
  'finra-brokercheck': 'FINRA BrokerCheck',
  'court-records-open': 'open court records',
  'uk-case-law': 'UK case law',
  'doj-press-releases': 'DOJ releases',
  'us-enforcement-actions': 'US enforcement actions',
  'uk-gazette': 'UK Gazette notices',
  'fr-bodacc': 'French insolvency notices (BODACC)',
  bodacc: 'French insolvency notices (BODACC)',
  'offshore-leaks': 'ICIJ Offshore Leaks',
  icij: 'ICIJ Offshore Leaks',
};
// The checklist of public-record screens the report shows, so a clean screen is seen to have run.
const SCREEN_GROUPS = [
  ['Sanctions and watchlists', ['sanctions-lists', 'us-exclusions', 'mdb-debarment', 'wanted-lists', 'offshore-leaks']],
  ['Courts and prosecutors', ['court-dockets', 'court-records-open', 'doj-press-releases', 'delaware-courts', 'uk-case-law', 'eu-courts', 'canada-federal-courts']],
  ['Regulators and filings', ['us-enforcement-actions', 'finra-brokercheck', 'us-bank-regulators', 'fincen-actions', 'us-agency-orders', 'sec-filings', 'sec-company', 'cfpb-complaints', 'federal-register', 'fda-recalls', 'uk-gazette', 'fr-bodacc']],
  ['US federal awards, lobbying and grants', ['us-federal-awards', 'us-lobbying', 'nih-grants']],
  ['Dark-web leak sites and data breaches (company level)', ['leak-sites', 'breach-catalogue', 'breach-registers']],
  ['Company registers', ['us-state-registries', 'uk-companies-house', 'fr-companies', 'lei-register', 'yc-directory', 'nonprofit-filings']],
  ['Patents and trademarks', ['patents', 'trademarks']],
];
// Records from these are tied to the company by more than its name (the page names the person, or was found through them).
const NAME_PLUS_SOURCES = new Set(['web-search', 'news-archive', 'web-archive', 'page-reader', 'wikipedia', 'wikidata', 'domain-history']);
const REGISTER_SOURCES = new Set(['us-state-registries', 'uk-companies-house', 'fr-companies', 'yc-directory', 'lei-register']);
/** From this many same-name entries in registers on, a company name is shared by several companies. */
const SHARED_NAME_FROM = 3;

/** One row per screen: what it was asked, and what came back. */
function screensOf(allSources, cited) {
  const byId = new Map(allSources.map((s) => [s.id, s]));
  return SCREEN_GROUPS.map(([group, ids]) => ({
    group,
    items: ids.map((id) => byId.get(id)).filter(Boolean).map((s) => {
      const mine = cited.filter((f) => f.source === s.id);
      const tied = mine.filter((f) => f.match !== 'possible');
      const status = s.off ? 'off'
        : !(s.runs > 0) ? 'not-run'
        : s.errors >= s.runs ? 'failed'
        : tied.length ? 'records'
        : mine.length ? 'name-only'
        // it reported a record that is listed under another source's copy of the same page
        : s.findings > 0 ? 'records'
        : s.errors > 0 || s.waitedOut > 0 || s.partial?.length ? 'partial'
        : 'clear';
      return { id: s.id, label: s.label, status, lookups: s.runs || 0, records: tied.length || (mine.length ? 0 : s.findings || 0), nameOnly: mine.length - tied.length, cites: (tied.length ? tied : mine).slice(0, 6).map((f) => f.n) };
    }),
  })).filter((g) => g.items.length > 0);
}

/** The screens that answered every lookup and returned no record. */
export function cleanScreens(coverage) {
  const labels = (coverage?.searched || [])
    .filter((s) => SCREENS[s.id] && !(s.records > 0) && !(s.failed > 0))
    .map((s) => SCREENS[s.id]);
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
  [5, /\bindict\w*|\bconvict\w*|\bsentenc\w+|\bfound guilty\b|\bplead(?:s|ed)? guilty\b|\bpled guilty\b|\bguilty verdict\b|\bprison\b|\bpardon\w*/i],
  [4, /\bSEC\b|\bSecurities and Exchange Commission\b|\bDOJ\b|\bDepartment of Justice\b|\bcharged\b|\bcharges\b|\bFINRA\b|\bFTC\b|\bregulators?\b|\benforcement action\b/i],
  [3, /\blawsuits?\b|\bsue[ds]?\b|\bsuing\b|\bclass[- ]action\b|\bsettle\w*|\bagreed to pay\b/i],
  [2, /\brelated[- ]part(?:y|ies)\b|\bself[- ]dealing\b|\bconflicts? of interest\b|\blandlord to\b/i],
  [1, /\bousted\b|\bfired\b|\bresign\w*|\bstep(?:s|ped)? down\b|\bforced out\b|\bunder pressure\b/i],
];
const weightOf = (text) => (FLAG_WEIGHTS.find(([, re]) => re.test(String(text || ''))) || [0])[0];
/** A red flag's event weight: from its headlines (the lead's and its tied reports'), else the lead's quotation. */
function flagWeight(flag) {
  const titles = [flag.title, ...(flag.more || []).filter((m) => m.match !== 'possible').map((m) => m.title)];
  const fromTitles = Math.max(0, ...titles.map(weightOf));
  return fromTitles || (flag.category === 'regulatory' ? 4 : weightOf(flag.quote));
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
  return [
    ...(courts && silent(courts) ? [`Court dockets (CourtListener ${courts.off ? 'is not enabled on this deployment' : 'did not answer'}), including US state courts and the Delaware Court of Chancery`] : []),
    ...NOT_COVERED.map((s) => (otherLanguage && s === NOT_COVERED[NOT_ENGLISH] ? 'Most non-English press, and sources behind a login or paywall' : s)),
    ...abroad,
  ];
}

const matchWeight = (m) => (m === 'company' ? 2 : matchRank(m));
// Sources that screen a person against official watchlists.
const WATCHLISTS = new Set(['sanctions-lists', 'us-exclusions', 'offshore-leaks', 'wanted-lists']);

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

/**
 * Build the report from a finished (or still running) check state.
 * Pure: no network, no model.
 */
export function buildReport(state) {
  const subject = restoreSubject({ name: state.name, company: state.company, anchors: state.anchors });
  const trustedThreads = Object.values(state.threads || {}).filter((t) => t.trusted);
  // What the tied records say of their career: read first, because it also settles two kinds of doubtful record.
  const profile = buildProfile(subject, state.findings || [], trustedThreads);

  // 1. A record matched by name only that also names an employer their own bio gives (a broker registration
  //    at the bank they worked at) is likely theirs. Never more than likely, and only with the full name.
  const SERIOUS = new Set(['high', 'medium']);
  const employers = profile.earlier.filter((e) => e.org.length >= 5).map((e) => ({ org: e.org, n: e.ids.length, re: new RegExp(`(?<![A-Za-z0-9])${e.org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i') }));
  const byEmployer = (f) => {
    if (f.match !== 'possible' || !employers.length) return f;
    const text = `${f.title || ''}\n${f.quote || ''}`;
    if (!subject.hasName(text)) return f;
    // a serious record needs the employer in two of their records before it is raised: one sentence is too thin for a red flag
    const hit = employers.find((e) => e.re.test(text) && (!SERIOUS.has(f.severity) || e.n >= 2));
    return hit ? { ...f, match: 'likely', matchReasons: [...(f.matchReasons || []), `names ${hit.org}, where their own bio says they worked`] } : f;
  };
  // 2. A company name several registered companies share ("Merge") ties nothing by itself: a record about "a
  //    company called Merge" that names neither the person, their site nor a known colleague may be another Merge.
  const text0 = (f) => `${f.title || ''}\n${f.quote || ''}\n${f.url || ''}`;
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
  // 3. A one-word company name that is also an ordinary word ("Ramp", "Merge", "Flow"): a news item found on
  //    that word alone ("body found near the boat ramp", "The Ramp church") is about the company only when
  //    the word stands as a name of its own and the text speaks of a business.
  const oneWord = Boolean(state.company) && companyKeys(state.company)[0] && !companyKeys(state.company)[0].includes(' ');
  const coWord = oneWord ? String(state.company).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const PART_OF_LONGER = oneWord ? new RegExp(`(?:[A-Z][\\p{L}'’-]+\\s+|['"‘“]?[Tt]he\\s+)${coWord}(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])${coWord}\\s+(?:Road|Street|Church|Park|Festival|Lake|River|Bridge|County|School|Avenue)\\b`, 'u') : null;
  const STANDS_ALONE = oneWord ? new RegExp(`(?<![\\p{L}\\p{N}])${coWord}(?![\\p{L}\\p{N}])`, 'gu') : null;
  const BUSINESS = /\b(?:compan(?:y|ies)|startup|start-up|fintech|software|platform|ceo|co-?founders?|founders?|raises?|raised|funding|valuation|valued|investors?|customers|acquir\w+|ipo|layoffs?|employees|inc\.?|corp\.?|llc|series [a-h]|unicorn|shareholders?|executives?)\b/i;
  const ordinaryWordOnly = (f) => {
    if (!oneWord || f.match !== 'company' || !NAME_PLUS_SOURCES.has(f.source) || f.data?.person) return f;
    const text = `${f.title || ''}\n${f.quote || ''}`;
    if (subject.hasName(text) || ownHosts.some((h) => text0(f).toLowerCase().includes(h)) || colleagues.some((c) => text.toLowerCase().includes(c))) return f;
    const all = (text.match(STANDS_ALONE) || []).length;
    const inLonger = (text.match(new RegExp(PART_OF_LONGER.source, 'gu')) || []).length;
    if (all > inLonger && BUSINESS.test(text)) return f;
    return { ...f, match: 'possible', matchReasons: [`the word "${state.company}" appears, but not clearly as this company`], data: { ...(f.data || {}), companyNamesake: true } };
  };
  const byCompanyNameOnly = (f) => {
    if (!sharedName || f.match !== 'company' || NAME_PLUS_SOURCES.has(f.source)) return f;
    const text = text0(f).toLowerCase();
    if (subject.hasName(text) || ownHosts.some((h) => text.includes(h)) || colleagues.some((c) => text.includes(c))) return f;
    return { ...f, match: 'possible', matchReasons: [`shares the company name only; several companies are called ${state.company}`], data: { ...(f.data || {}), companyNamesake: true } };
  };
  const findings = (state.findings || []).map(byEmployer).map(byCompanyNameOnly).map(ordinaryWordOnly).map(eventDated).map(businessHistory);
  const groups = new Map();
  for (const f of findings) {
    const key = corroborationKey(f);
    // A case number identifies the matter whoever the page names; matching headline words only count when tied.
    if (!CORROBORATES.has(f.match) && !key.startsWith('case|')) continue;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add((() => { try { return new URL(f.url).hostname.replace(/^www\./, ''); } catch { return f.source; } })());
  }
  const ranked = capWikiOther(findings
    .map((f) => ({ ...f, corroboration: groups.get(corroborationKey(f))?.size || 1 }))
    .map((f) => ({ ...f, score: score(f, f.corroboration, corroborationKey(f)) }))
    .sort((a, b) => b.score - a.score || recency(b) - recency(a)));

  // Number the records once; the brief, the sections and the UI all cite the same numbers.
  const sources = ranked.map((f, i) => ({ n: i + 1, id: f.id, title: f.title, url: f.url, sourceLabel: f.sourceLabel, category: f.category, date: f.date, match: f.match }));
  const numberOf = new Map(sources.map((s) => [s.id, s.n]));
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
  const windows = dateWindows(serious);
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
    const person = list.filter((f) => f.match === 'confirmed' || f.match === 'likely');
    const company = list.filter((f) => f.match === 'company');
    // The authority's own record leads (court, prosecutor or regulator, then an encyclopaedia, then news, a
    // forum last); among records of one kind, `cited` is in rank order, so the first is the strongest.
    const tied = person.length ? person : company.length ? company : list;
    const lead = tied.reduce((best, f) => (sourceAuthority(f) > sourceAuthority(best) ? f : best), tied[0]);
    const entry = { ...lead, more: list.filter((f) => f !== lead).map(short) };
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
  redFlags.sort((a, b) => flagWeight(b) - flagWeight(a) || sourceAuthority(b) - sourceAuthority(a) || a.n - b.n);
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
  const rest = cited.filter((f) => !offTimeline(f) && !coverageOfFlag.has(f.n) && !leads.some((l) => l.n === f.n)
    && ['career', 'corporate', 'litigation', 'regulatory', 'sanctions', 'education', 'archive'].includes(f.category));
  const timeline = [...leads, ...rest].slice(0, TIMELINE_MAX)
    .sort((a, b) => when(a) - when(b) || a.n - b.n)
    .map((f) => ({ date: f.date, title: f.title, category: f.category, n: f.n, severity: f.severity }));

  // A change seen on a page matched by name only may be a namesake's profile: not a claim that changed.
  const claimChanges = cited.filter((f) => f.category === 'archive' && f.data?.kind === 'change' && f.match !== 'possible');

  // People screened against a watchlist: done task keys read `connector|kind|value|template`.
  const screened = new Set();
  for (const key of state.done || []) {
    const [connector, kind, value] = String(key).split('|');
    if (WATCHLISTS.has(connector) && kind !== 'company' && value) screened.add(personKey(value));
  }
  const related = new Map();
  for (const t of Object.values(state.threads || {})) {
    const key = personKey(t.value);
    if ((t.kind === 'relative' || t.kind === 'associate') && t.trusted && !related.has(key)) related.set(key, { name: t.value, kind: t.kind, relation: t.relation || null, role: t.role || null, why: t.why || '', records: [], ...(screened.has(key) ? { screened: true } : {}) });
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
  const coverage = {
    // Only sources that answered at least once: a source whose every lookup failed searched nothing.
    searched: allSources.filter(answered).map((s) => ({ id: s.id, label: s.label, lookups: s.runs, records: s.findings, failed: s.errors, lastError: s.errors ? s.lastError : null })),
    // Answered, but a fifth or more of the lookups failed: what it found is a partial picture.
    // Also: lookups that waited for a source's allowance and could not run within the check (not failures)
    partlyAnswered: allSources.filter((s) => answered(s) && ((s.errors > 0 && s.errors / s.runs >= PARTLY_ANSWERED) || s.waitedOut > 0))
      .map((s) => ({
        label: s.label, failed: s.errors, lookups: s.runs, ...(s.waitedOut ? { notRun: s.waitedOut } : {}),
        reason: [
          s.errors > 0 && s.errors / s.runs >= PARTLY_ANSWERED ? `${s.errors} of ${s.runs} lookups failed${s.lastError ? `: ${s.lastError}` : ''}` : '',
          s.waitedOut ? `${s.waitedOut} more lookup${s.waitedOut === 1 ? '' : 's'} not run because its allowance for the next few minutes was used up` : '',
        ].filter(Boolean).join('; '),
      })),
    notSearched: allSources.filter(silent).map((s) => ({ label: s.label, reason: s.lastError || (s.off ? 'Not enabled on this deployment.' : 'No answer.'), ...(s.off ? { off: true } : {}) })),
    notCovered: notCoveredFor(state, allSources, answered, silent),
    dropped: state.dropped || { tasks: 0, findings: 0, threads: 0 },
    lookups: state.tasksRun || 0,
    rounds: state.step || 0,
  };

  const count = (m) => cited.filter((f) => f.match === m).length;
  const cite = (ids) => [...new Set((ids || []).map((id) => numberOf.get(id)).filter(Boolean))];
  return {
    name: state.name,
    company: state.company || null,
    identity: state.identity,
    generatedAt: new Date().toISOString(),
    profile: reportProfile(profile, cite),
    screens: screensOf(allSources, cited),
    sharedCompanyName: sharedName,
    totals: { records: cited.length, confirmed: count('confirmed'), likely: count('likely'), possible: count('possible'), company: count('company'), redFlags: redFlags.length, companyMatters: companyMatters.length, possibleNamesake: possibleNamesake.length, seriousRecords: serious.length },
    redFlags,
    companyMatters,
    possibleNamesake,
    sections,
    timeline,
    claimChanges,
    inconsistencies,
    relatedParties: [...related.values()].sort((a, b) => b.records.length - a.records.length),
    threads: Object.values(state.threads || {}).filter((t) => t.trusted).map(({ kind, value, why, relation }) => ({ kind, value, why, relation: relation || null })),
    coverage,
    sources,
    log: state.log || [],
    notice: USE_NOTICE,
  };
}

/**
 * The profile in the report's form: every line cites record numbers. Roles (the current one from the
 * headline, then the earlier ones, latest first), education, and the fields a model-read profile adds
 * (profileModel.js mergeProfile) left empty, so the page reads the same shape either way. Null when empty.
 * @param {object} profile from profile.buildProfile
 * @param {(ids: string[]) => number[]} cite record ids to record numbers
 */
export function reportProfile(profile, cite) {
  if (!profile) return null;
  const current = profile.headline && profile.company && profile.titles?.length
    ? [{ org: profile.company, title: profile.titles.join(profile.titles.length === 2 ? ' and ' : ', '), from: null, to: null, current: true, cites: cite(profile.headlineIds) }]
    : [];
  const earlier = (profile.earlier || []).map((e) => ({ org: e.org, title: e.role || null, from: e.from ?? null, to: e.to ?? null, current: Boolean(e.current), cites: cite(e.ids) }));
  const roles = [...current, ...earlier].sort((a, b) => (b.current ? 10000 : 0) + (b.from || b.to || 0) - ((a.current ? 10000 : 0) + (a.from || a.to || 0)));
  const out = {
    headline: profile.headline, headlineCites: cite(profile.headlineIds), company: profile.company,
    roles,
    education: (profile.education || []).map((e) => ({ school: e.school, degree: null, field: null, from: e.from ?? null, to: e.to ?? null, cites: cite(e.ids) })),
    earlier: (profile.earlier || []).map((e) => ({ org: e.org, role: e.role || null, cites: cite(e.ids) })),
    boards: [], founded: [], investments: [], recognition: [],
    basedIn: profile.basedIn ? { text: profile.basedIn.text, cites: cite(profile.basedIn.ids) } : null,
    about: (profile.about || []).map((a) => ({ text: a.text, cites: cite([a.id]) })),
    links: profile.links || [],
  };
  const has = out.headline || out.roles.length || out.education.length || out.basedIn || out.about.length || out.links.length;
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

/** A brief assembled from the records themselves (no model). */
export function quotedDeepBrief(report, reason) {
  const line = (f) => `• ${f.title}${f.date ? ` (${f.date})` : ''}${f.quote ? `: "${f.quote.slice(0, 240)}"` : ''} [Source ${f.n}]`;
  const of = (key) => (report.sections.find((s) => s.key === key)?.items || []).filter((f) => f.match !== 'possible');
  const t = report.totals;
  const bottom = `${t.records} records were collected about ${report.name}${report.company ? ` (${report.company})` : ''}: ${t.confirmed + t.likely} tied to this person, ${t.company} about their company, ${t.possible} matched by name only. ${t.redFlags ? `${t.redFlags} serious matter(s) are tied to this person.` : 'No serious record is tied to this person in the sources searched.'}${t.companyMatters ? ` ${t.companyMatters} more concern a company they founded or run.` : ''}`;
  // what a bio or interview page says is the person's own account, not a record that confirms it
  const checks = [...of('education'), ...of('career'), ...of('corporate'), ...of('ip')].filter((f) => f.data?.kind !== 'bio').slice(0, 10);
  const possibleChanges = (report.sections.find((s) => s.key === 'archive')?.items || []).filter((f) => f.match === 'possible' && f.data?.kind === 'change');
  const gaps = [
    ...[...report.possibleNamesake.slice(0, 8), ...possibleChanges.slice(0, 5)].map((f) => `• Rule out a namesake: ${f.title} [Source ${f.n}]${f.sameStoryAs ? ` (reports the same kind of event within days of [Source ${f.sameStoryAs}]; it may be the same story)` : ''}`),
    ...report.coverage.notSearched.map((s) => (s.off ? `• ${s.label}: not enabled on this deployment.` : `• ${s.label} did not answer: ${s.reason}`)),
    ...(report.coverage.partlyAnswered || []).map((s) => `• ${s.label} answered only in part: ${s.reason}.`),
    ...report.coverage.notCovered.map((s) => `• Not covered: ${s}.`),
    ...(report.inconsistencies || []).map((x) => `• Inconsistent record: ${x.title}. ${x.note} [Source ${x.n}]`),
  ];
  const clean = cleanScreens(report.coverage);
  return [
    '## BOTTOM LINE', bottom,
    '', '## RED FLAGS', report.redFlags.length ? report.redFlags.slice(0, 14).map(line).join('\n') : 'None found in the records searched.',
    ...(clean.length ? [`Screens with no match: ${clean.join(', ')}.`] : []),
    ...(report.companyMatters?.length ? ['', 'About their companies:', report.companyMatters.slice(0, 8).map(line).join('\n')] : []),
    '', '## WHAT CHECKS OUT', checks.length ? checks.map(line).join('\n') : 'No independent record confirming a claim was found.',
    '', '## CLAIMS THAT CHANGED OVER TIME', report.claimChanges.length ? report.claimChanges.slice(0, 10).map(line).join('\n') : 'None found.',
    '', '## RELATED PARTIES', report.relatedParties.length ? report.relatedParties.slice(0, 10).map((p) => `• ${p.name}${p.relation ? ` (${p.relation})` : p.kind === 'associate' ? ' (associate)' : ''}${p.role ? `, ${p.role}` : ''}${p.records.length ? ` ${p.records.map((r) => `[Source ${r.n}]`).join(' ')}` : ''}`).join('\n') : 'None found.',
    '', '## GAPS AND UNVERIFIED CLAIMS', gaps.join('\n'),
    '', '## QUESTIONS FOR THE FOUNDER', '• Ask for a full CV with dates and a reference at each employer, and compare it with the records above.\n• Ask the founder to explain each red flag and each change between archived versions, with documents.\n• Ask for degree certificates or permission to verify with each institution.',
    '', `*Note: ${reason}, so this brief is assembled from the records themselves.*`,
  ].join('\n');
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
  const user = `Today's date: ${new Date().toISOString().slice(0, 10)}\nPerson: ${report.name}${report.company ? `\nCompany: ${report.company}` : ''}${identity}\n\n${coverage}\n\nRecords (${picked.length} of ${report.totals.records}, strongest first within each kind):\n${recordsBlock(picked)}`;
  const maxN = report.sources.length;
  // A citation is only valid if that record was actually shown to the model. Unshown ones are removed
  // before the checks, so an answer resting only on records it was not shown fails like an uncited one.
  const shown = new Set(picked.map((f) => f.n));
  const check = (text) => {
    const first = validateAnswer(text, maxN, DEEP_SECTIONS);
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
