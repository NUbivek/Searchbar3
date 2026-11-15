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
import { matchRank, restoreSubject, personKey } from './identity';
import { companyKeys } from '../founderCheck';
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
const PARTLY_ANSWERED = 0.2; // share of failed lookups from which a source's answer is called partial
const TIMELINE_MAX = 60;

/** Which gaps no free source covered on this run: the fixed list, adjusted to what actually answered. */
function notCoveredFor(state, allSources, answered, silent) {
  const courts = allSources.find((s) => s.id === COURT_DOCKETS);
  // A language the run did search: a source of another country, or a search made in another language.
  const otherLanguage = allSources.some((s) => answered(s) && NON_ENGLISH_SOURCE.test(s.id))
    || (state.done || []).some((key) => {
      const [connector, , , template] = String(key).split('|');
      return NON_ENGLISH_TEMPLATE.test(template || '') && state.sources?.[connector] && answered({ ...state.sources[connector] });
    });
  if (!(courts && silent(courts)) && !otherLanguage) return NOT_COVERED;
  return [
    ...(courts && silent(courts) ? [`Court dockets (CourtListener ${courts.off ? 'is not enabled on this deployment' : 'did not answer'}), including US state courts and the Delaware Court of Chancery`] : []),
    ...NOT_COVERED.map((s) => (otherLanguage && s === NOT_COVERED[NOT_ENGLISH] ? 'Most non-English press, and sources behind a login or paywall' : s)),
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
/** Every date a text gives to the month or day, as 'YYYY-MM' or 'YYYY-MM-DD', none in the future. */
function datesIn(text) {
  const out = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const [re, parts] of DATED_PHRASES) {
    for (const m of String(text || '').matchAll(re)) {
      const [mon, day, year] = parts(m);
      const month = MONTHS.findIndex((x) => x.startsWith(mon.toLowerCase().slice(0, 3))) + 1;
      if (!month) continue;
      const d = day && Number(day) >= 1 && Number(day) <= 31 ? `${year}-${pad(month)}-${pad(day)}` : `${year}-${pad(month)}`;
      if (d.slice(0, 7) <= today.slice(0, 7)) out.push(d);
    }
  }
  return out;
}
/**
 * The date of the event a record reports, read from its own quotation when the record carries only a
 * year ("On September 10, 2020, ..." -> 2020-09-10) or, for an encyclopaedia, only the date the article
 * was last edited. A record dated to the month joins the other reports of its matter and sits in the
 * right place on the timeline. The latest date of the record's own year is used; nothing is guessed.
 */
function eventDated(f) {
  const revised = f.data?.revisedAt && f.date && String(f.data.revisedAt).startsWith(f.date) && f.date.length >= 7;
  if (!(f.date && /^\d{4}$/.test(f.date)) && !revised) return f;
  const dates = datesIn(f.quote).filter((d) => revised || d.startsWith(f.date)).sort();
  if (dates.length) return { ...f, date: dates[dates.length - 1] };
  // An edit date is not the date of the event: without a date in the text the record is undated.
  return revised ? { ...f, date: null } : f;
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

/**
 * The matter a serious record belongs to: a case number when it has one,
 * otherwise the kind of event and the month it was reported, kept apart for
 * the person, their company, and each associate or relative. Twenty news
 * reports of one sentencing are one matter, not twenty red flags.
 */
function matterKey(f) {
  const docket = `${f.title} ${f.quote || ''}`.toLowerCase().match(/\b\d{1,2}:\d{2}-[a-z]{2}-\d{3,6}\b/);
  if (docket) return `case|${docket[0]}`;
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
  const findings = (state.findings || []).map(eventDated);
  const groups = new Map();
  for (const f of findings) {
    const key = corroborationKey(f);
    // A case number identifies the matter whoever the page names; matching headline words only count when tied.
    if (!CORROBORATES.has(f.match) && !key.startsWith('case|')) continue;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add((() => { try { return new URL(f.url).hostname.replace(/^www\./, ''); } catch { return f.source; } })());
  }
  const ranked = findings
    .map((f) => ({ ...f, corroboration: groups.get(corroborationKey(f))?.size || 1 }))
    .map((f) => ({ ...f, score: score(f, f.corroboration, corroborationKey(f)) }))
    .sort((a, b) => b.score - a.score || when(b) - when(a));

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
  const subject = restoreSubject({ name: state.name, company: state.company, anchors: state.anchors });
  const aboutThem = (f) => {
    if (f.category !== 'press' && f.category !== 'identity') return true;
    if (f.match === 'company' || f.data?.person) return true;
    const title = String(f.title || '');
    return subject.hasName(title) || [...subject.anchors.companies.values()].some((a) => a.test(title));
  };
  const serious = cited.filter((f) => (f.severity === 'high' || f.severity === 'medium') && aboutThem(f));
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
  for (const f of serious) {
    const key = matterKey(f);
    if (!matters.has(key)) matters.set(key, []);
    let same = key.startsWith('case|') ? matters.get(key)[0] : null;
    if (!key.startsWith('case|')) {
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
    (person.length ? redFlags : company.length ? companyMatters : possibleNamesake).push(entry);
  }
  redFlags.sort((a, b) => a.n - b.n);
  companyMatters.sort((a, b) => a.n - b.n);
  possibleNamesake.sort((a, b) => a.n - b.n);

  const sections = SECTION_ORDER
    .map((key) => ({ key, title: CATEGORIES[key], items: cited.filter((f) => f.category === key) }))
    .filter((s) => s.items.length > 0);

  // The timeline: each red flag once (its lead record), then the dated records of the person's career,
  // strongest first, up to TIMELINE_MAX. Never a record matched by name only, one its source marked as
  // not for the timeline (a company that only shares the name), or a further report of a red flag's matter.
  const offTimeline = (f) => !f.date || f.match === 'possible' || f.excludeFromTimeline || f.data?.excludeFromTimeline;
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
  for (const f of cited) {
    const person = f.data?.person;
    if (person && related.has(personKey(person))) related.get(personKey(person)).records.push({ n: f.n, title: f.title, severity: f.severity, category: f.category });
  }

  const allSources = Object.entries(state.sources || {}).map(([id, s]) => ({ id, ...s }));
  const answered = (s) => !s.off && s.runs > 0 && (s.errors || 0) < s.runs;
  const silent = (s) => s.off || (s.runs > 0 && s.errors >= s.runs);
  const coverage = {
    // Only sources that answered at least once: a source whose every lookup failed searched nothing.
    searched: allSources.filter(answered).map((s) => ({ id: s.id, label: s.label, lookups: s.runs, records: s.findings, failed: s.errors, lastError: s.errors ? s.lastError : null })),
    // Answered, but a fifth or more of the lookups failed: what it found is a partial picture.
    partlyAnswered: allSources.filter((s) => answered(s) && s.errors > 0 && s.errors / s.runs >= PARTLY_ANSWERED)
      .map((s) => ({ label: s.label, failed: s.errors, lookups: s.runs, reason: `${s.errors} of ${s.runs} lookups failed${s.lastError ? `: ${s.lastError}` : ''}` })),
    notSearched: allSources.filter(silent).map((s) => ({ label: s.label, reason: s.lastError || (s.off ? 'Not enabled on this deployment.' : 'No answer.'), ...(s.off ? { off: true } : {}) })),
    notCovered: notCoveredFor(state, allSources, answered, silent),
    dropped: state.dropped || { tasks: 0, findings: 0, threads: 0 },
    lookups: state.tasksRun || 0,
    rounds: state.step || 0,
  };

  const count = (m) => cited.filter((f) => f.match === m).length;
  return {
    name: state.name,
    company: state.company || null,
    identity: state.identity,
    generatedAt: new Date().toISOString(),
    totals: { records: cited.length, confirmed: count('confirmed'), likely: count('likely'), possible: count('possible'), company: count('company'), redFlags: redFlags.length, companyMatters: companyMatters.length, possibleNamesake: possibleNamesake.length, seriousRecords: serious.length },
    redFlags,
    companyMatters,
    possibleNamesake,
    sections,
    timeline,
    claimChanges,
    relatedParties: [...related.values()].sort((a, b) => b.records.length - a.records.length),
    threads: Object.values(state.threads || {}).filter((t) => t.trusted).map(({ kind, value, why, relation }) => ({ kind, value, why, relation: relation || null })),
    coverage,
    sources,
    log: state.log || [],
    notice: USE_NOTICE,
  };
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
  return records.map((f) => `[Source ${f.n}] (${f.match}; ${CATEGORIES[f.category]}; ${f.sourceLabel}${f.date ? `; ${f.date}` : ''}${f.severity !== 'info' ? `; severity ${f.severity}` : ''}${f.more?.length ? `; ${f.more.length} more record${f.more.length === 1 ? '' : 's'} report the same matter` : ''})\n${f.title}${f.quote ? `\n"${f.quote}"` : ''}`).join('\n\n');
}

/** A brief assembled from the records themselves (no model). */
export function quotedDeepBrief(report, reason) {
  const line = (f) => `• ${f.title}${f.date ? ` (${f.date})` : ''}${f.quote ? `: "${f.quote.slice(0, 240)}"` : ''} [Source ${f.n}]`;
  const of = (key) => (report.sections.find((s) => s.key === key)?.items || []).filter((f) => f.match !== 'possible');
  const t = report.totals;
  const bottom = `${t.records} records were collected about ${report.name}${report.company ? ` (${report.company})` : ''}: ${t.confirmed + t.likely} tied to this person, ${t.company} about their company, ${t.possible} matched by name only. ${t.redFlags ? `${t.redFlags} serious matter(s) are tied to this person.` : 'No serious record is tied to this person in the sources searched.'}${t.companyMatters ? ` ${t.companyMatters} more concern a company they founded or run.` : ''}`;
  const checks = [...of('education'), ...of('career'), ...of('corporate'), ...of('ip')].slice(0, 10);
  const possibleChanges = (report.sections.find((s) => s.key === 'archive')?.items || []).filter((f) => f.match === 'possible' && f.data?.kind === 'change');
  const gaps = [
    ...[...report.possibleNamesake.slice(0, 8), ...possibleChanges.slice(0, 5)].map((f) => `• Rule out a namesake: ${f.title} [Source ${f.n}]`),
    ...report.coverage.notSearched.map((s) => (s.off ? `• ${s.label}: not enabled on this deployment.` : `• ${s.label} did not answer: ${s.reason}`)),
    ...(report.coverage.partlyAnswered || []).map((s) => `• ${s.label} answered only in part: ${s.reason}.`),
    ...report.coverage.notCovered.map((s) => `• Not covered: ${s}.`),
  ];
  return [
    '## BOTTOM LINE', bottom,
    '', '## RED FLAGS', report.redFlags.length ? report.redFlags.slice(0, 14).map(line).join('\n') : 'None found in the records searched.',
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
  const coverage = `Sources that answered: ${report.coverage.searched.map((s) => s.label).join(', ') || 'none'}.\n${partly.length ? `Sources that answered only in part: ${partly.map((s) => `${s.label} (${s.reason})`).join('; ')}.\n` : ''}Sources that did not answer: ${failed.join(', ') || 'none'}.\nSources not enabled on this deployment: ${notEnabled.join(', ') || 'none'}.\nNot covered by any free source: ${report.coverage.notCovered.join('; ')}.`;
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
