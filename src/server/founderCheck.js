/**
 * Founder background check: purely extractive. Every item returned is a
 * sentence (or headline) copied verbatim from a fetched source, tagged with
 * the index of that source in `sources`. Nothing is inferred or written here.
 *
 * Name matching is strict: the full name on word boundaries, written in the
 * source as a capitalized proper name. The user's capitalization does not
 * matter ("arthur mensch" finds "Arthur Mensch"), but initials ("A. Mensch")
 * and lowercase common-word uses do not match.
 * LinkedIn is not used (it does not share profiles with ordinary apps).
 */
import { searchCuratedSources } from '../utils/sources/curatedIndex';
import { searchHackerNews } from '../utils/sources/hackernewsAlgolia';
import { performSimpleSearch } from '../utils/searchUtils';
import { cleanText, formatDate, sourceLabel, sentencesOf } from '../utils/evidence';

const USER_AGENT = 'Searchbar3-Research/1.0';
const QUERY_TIMEOUT_MS = 15000;
const MAX_TIMELINE = 25;
const MAX_COMPANIES = 20;
const MAX_LITIGATION = 20;
const MAX_PRESS = 20;

export const LITIGATION_DISCLAIMER =
  'Absence of litigation or regulatory results here is NOT evidence of a clean record. These sources are news, Hacker News and (when configured) web search and CourtListener; they do not cover all courts, regulators or jurisdictions.';

const ROLE_RE = /\b(found(ed|er|ing)|co-?found(ed|er)|joined|left|leaves|departed|served|serves|appointed|named|became|becomes|worked|hired|launched|started|led|leads|promoted|stepped down|resigned|graduated|studied|earned|CEO|CTO|COO|CFO|chief|president|chair(man|woman)?|director|head of|vice president|VP|partner|researcher|engineer|professor|previously|formerly|former)\b/i;

// Case-sensitive on purpose for "SEC" (avoid "sec" = second).
const LITIGATION_RE = /\b(lawsuits?|su(ed|es|ing)|litigation|charged|charges|fraud|indict(ed|ment)|settle(d|ment)|plaintiffs?|defendants?|court|class action|fined|penalt(y|ies)|investigation|probe|subpoena(ed)?|convicted|allegations?|alleged(ly)?|misconduct|regulator(s|y)?|injunction|bankruptcy)\b|\bSEC\b|\bFTC\b|\bDOJ\b|\bCFTC\b|\bFCA\b/i;

const YEAR_RE = /\b(19[89]\d|20[0-2]\d|2030)\b/g;

// A company name: one to four capitalized tokens (allowing &, ., -, digits).
const CO = "([A-Z][A-Za-z0-9&.'-]*(?:\\s+(?:[A-Z][A-Za-z0-9&.'-]*|&|of|de|du|la)){0,3})";
const COMPANY_PATTERNS = [
  new RegExp(`\\b(?:previously|formerly|before that|earlier)\\s*,?\\s+(?:worked\\s+)?(?:at|with|for)\\s+${CO}`),
  new RegExp(`\\bco-?founded\\s+${CO}`),
  new RegExp(`\\bfounded\\s+${CO}`),
  new RegExp(`\\b(?:co-?)?founder\\s+(?:and\\s+\\w+\\s+)?of\\s+${CO}`),
  new RegExp(`\\b(?:former|ex-)\\s*(?:[A-Za-z-]+\\s+){0,3}?(?:CEO|CTO|COO|CFO|CPO|chief\\s+\\w+\\s+officer|president|head(?:\\s+of\\s+\\w+)?|director|VP|vice president|engineer|researcher|scientist|partner|executive|employee|manager)\\s+(?:of|at)\\s+${CO}`),
  new RegExp(`\\bex-${CO}`),
  new RegExp(`\\b(?:worked|spent\\s+[\\w\\s]{1,20}?)\\s+at\\s+${CO}`),
  new RegExp(`\\b(?:joined|left)\\s+${CO}`),
];

const COMPANY_STOP = new Set(['The', 'A', 'An', 'He', 'She', 'They', 'His', 'Her', 'In', 'On', 'At', 'And', 'Before', 'After', 'Then', 'Its', 'This', 'That', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strict full-name matcher: full name, word boundaries, capitalized in the source. */
export function nameMatcher(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean).map(escapeRe);
  if (!parts.length) return () => false;
  // Whatever capitalization the user types ("bivek adhikari"), match the
  // full name case-insensitively, but only where the source writes it as a
  // proper name (each part capitalized, e.g. "Bivek Adhikari"), so common
  // words that happen to equal a name part do not match.
  const re = new RegExp(`(?<![A-Za-z0-9])${parts.join('\\s+')}(?![A-Za-z0-9])`, 'gi');
  return (text) => {
    const str = String(text || '');
    for (const m of str.matchAll(re)) {
      if (m[0].split(/\s+/).every((w) => /^[A-Z\u00C0-\u024F]/.test(w))) return true;
    }
    return false;
  };
}

function companyMatcher(company) {
  const c = String(company || '').trim();
  if (!c) return null;
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(c)}(?![A-Za-z0-9])`, 'i');
  return (text) => re.test(String(text || ''));
}

function cleanCompany(raw, name) {
  let c = String(raw || '').trim().replace(/[.,;:'-]+$/, '').replace(/\s+(of|de|du|la|&)$/i, '').trim();
  const first = c.split(/\s+/)[0];
  if (!c || COMPANY_STOP.has(first) || c.length < 2) return null;
  // Never treat the person themselves (or part of their name) as a company.
  const nameParts = String(name).split(/\s+/);
  if (nameParts.includes(c) || String(name).includes(c)) return null;
  return c;
}

function firstYear(sentence) {
  const years = [...String(sentence).matchAll(YEAR_RE)].map((m) => Number(m[1]));
  return years.length ? Math.min(...years) : null;
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

/**
 * Pure extraction step (no network): builds every section from results.
 * Exported for tests.
 */
export function extractFounderEvidence({ name, company, results }) {
  const hasName = nameMatcher(name);
  const hasCompany = companyMatcher(company);
  const deduped = dedupeResults(results);

  // Raw items reference the deduped result index; renumbered at the end.
  const timeline = [];
  const pastCompanies = [];
  const litigation = [];
  const press = [];
  const seenQuotes = new Set();
  const seenCompanies = new Set();

  deduped.forEach((result, ri) => {
    const full = `${cleanText(result.title)} ${cleanText(result.snippet || result.content || result.description)}`;
    if (!hasName(full)) return;
    const sourceMentionsCompany = hasCompany ? hasCompany(full) : null;
    const flag = (sentence) => {
      if (!hasCompany) return {};
      const inSentence = hasCompany(sentence);
      return {
        mentionsCompany: inSentence,
        possibleDifferentPerson: !inSentence && !sourceMentionsCompany,
      };
    };

    let pressQuote = null;
    for (const { text, headline } of candidates(result)) {
      if (!hasName(text)) continue;
      if (!pressQuote) pressQuote = text;
      const key = text.toLowerCase();
      const fresh = !seenQuotes.has(key);
      seenQuotes.add(key);
      if (!fresh) continue;

      if (result.source === 'courtlistener' || LITIGATION_RE.test(text)) {
        litigation.push({ quote: text, ri, headline, ...flag(text) });
      }
      const year = firstYear(text);
      if (year && ROLE_RE.test(text)) {
        timeline.push({ year, quote: text, ri, headline, ...flag(text) });
      }
      for (const re of COMPANY_PATTERNS) {
        const m = text.match(re);
        const co = m && cleanCompany(m[1], name);
        if (co && !seenCompanies.has(co.toLowerCase())) {
          seenCompanies.add(co.toLowerCase());
          pastCompanies.push({ company: co, quote: text, ri, headline, ...flag(text) });
        }
      }
    }
    if (pressQuote && result.source !== 'courtlistener') {
      press.push({ title: cleanText(result.title) || sourceLabel(result), quote: pressQuote, ri, ...flag(full) });
    }
  });

  // Company-mentioning items first (stable), then the section's own order.
  const rank = (arr) => (hasCompany ? arr.map((x, i) => [x, i]).sort((a, b) => (Number(!!b[0].mentionsCompany) - Number(!!a[0].mentionsCompany)) || (a[1] - b[1])).map(([x]) => x) : arr);

  const tl = timeline.sort((a, b) => a.year - b.year || (Number(!!b.mentionsCompany) - Number(!!a.mentionsCompany))).slice(0, MAX_TIMELINE);
  const pc = rank(pastCompanies).slice(0, MAX_COMPANIES);
  const lit = rank(litigation).slice(0, MAX_LITIGATION);
  const pr = rank(press).slice(0, MAX_PRESS);

  // Only cited sources are listed; renumber so sourceIndex is 0-based into sources.
  const used = [...new Set([...tl, ...pc, ...lit, ...pr].map((x) => x.ri))].sort((a, b) => a - b);
  const indexOf = new Map(used.map((ri, i) => [ri, i]));
  const sources = used.map((ri, i) => {
    const r = deduped[ri];
    return {
      n: i + 1,
      title: cleanText(r.title) || sourceLabel(r),
      url: r.url || r.link,
      sourceName: sourceLabel(r),
      date: formatDate(r.publishedAt || r.date || r.timestamp),
    };
  });
  const fix = ({ ri, ...rest }) => ({ ...rest, sourceIndex: indexOf.get(ri) });

  return {
    sources,
    timeline: tl.map(fix),
    pastCompanies: pc.map(fix),
    litigation: lit.map(fix),
    press: pr.map(fix),
  };
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
    const err = new Error('CourtListener skipped: requires COURTLISTENER_API_TOKEN (anonymous API requests return 401).');
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

function webSearchConfigured() {
  return Boolean(process.env.SERPER_API_KEY || process.env.TAVILY_API_KEY);
}

/**
 * Run the check.
 * @param {{ name: string, company?: string }} input
 * @param {{ searchers?: object }} deps override searchers in tests
 */
export async function runFounderCheck({ name, company } = {}, deps = {}) {
  const person = String(name || '').trim().replace(/\s+/g, ' ');
  const co = String(company || '').trim().replace(/\s+/g, ' ');
  if (!person) throw new Error('name is required');

  const searchers = {
    curated: (q) => searchCuratedSources(q, { limit: 20, waitMs: 8000 }),
    hackernews: (q) => searchHackerNews(q, { limit: 15 }),
    web: (q) => performSimpleSearch(q, ['web']),
    courtlistener: (n) => searchCourtListener(n),
    webConfigured: webSearchConfigured,
    ...(deps.searchers || {}),
  };

  const queries = [
    `"${person}"`,
    `"${person}" founder`,
    ...(co ? [`"${person}" ${co}`] : []),
    `"${person}" lawsuit OR sued OR litigation OR SEC charges OR fraud`,
    `"${person}" previously OR former OR joined OR left`,
  ];
  // Curated index and HN do keyword matching, so OR-operators add noise there.
  const plain = [person, `${person} founder`, ...(co ? [`${person} ${co}`] : []), `${person} lawsuit`, `${person} former`];

  const warnings = [];
  const unavailableSources = [];
  const webOn = searchers.webConfigured();
  if (!webOn) unavailableSources.push({ source: 'Web search', reason: 'No SERPER_API_KEY or TAVILY_API_KEY configured.' });
  unavailableSources.push({ source: 'LinkedIn', reason: 'LinkedIn does not share profiles or connections with third-party apps.' });

  const tasks = [];
  plain.forEach((q) => tasks.push({ source: 'Curated news index', run: () => searchers.curated(q) }));
  plain.forEach((q) => tasks.push({ source: 'Hacker News', run: () => searchers.hackernews(q) }));
  if (webOn) queries.forEach((q) => tasks.push({ source: 'Web search', run: () => searchers.web(q) }));
  tasks.push({ source: 'CourtListener', run: () => searchers.courtlistener(person) });

  const settled = await Promise.allSettled(tasks.map((t) => withTimeout(Promise.resolve().then(t.run), QUERY_TIMEOUT_MS, t.source)));

  const results = [];
  const failuresBySource = new Map();
  settled.forEach((s, i) => {
    const { source } = tasks[i];
    if (s.status === 'fulfilled') results.push(...(Array.isArray(s.value) ? s.value : []));
    else if (!failuresBySource.has(source)) failuresBySource.set(source, s.reason);
  });
  for (const [source, err] of failuresBySource) {
    const allFailed = settled.every((s, i) => tasks[i].source !== source || s.status === 'rejected');
    if (allFailed) unavailableSources.push({ source, reason: String(err?.message || err) });
    else warnings.push(`Some ${source} queries failed: ${String(err?.message || err)}`);
  }

  const evidence = extractFounderEvidence({ name: person, company: co, results });

  warnings.push('Name matching is strict (exact full name, any capitalization). Mentions using initials, nicknames or a different spelling are not included; different people can share the same name.');
  if (co) {
    const flagged = [...evidence.timeline, ...evidence.pastCompanies, ...evidence.litigation, ...evidence.press].filter((x) => x.possibleDifferentPerson).length;
    if (flagged) warnings.push(`${flagged} item(s) come from sources that do not mention "${co}" and may refer to a different person with the same name.`);
  }
  if (!evidence.sources.length) {
    const webMissing = unavailableSources.some((u) => /web/i.test(u.source));
    warnings.push(webMissing
      ? `No source mentions "${person}" by full name. Without web search, only the curated startup-news feeds and Hacker News are searched, and they rarely cover individuals who have not been in funding news. Add a web search key (SERPER_API_KEY or TAVILY_API_KEY) to search the wider web.`
      : `No source mentions "${person}" by full name.`);
  }

  return {
    name: person,
    company: co || null,
    generatedAt: new Date().toISOString(),
    ...evidence,
    litigationDisclaimer: LITIGATION_DISCLAIMER,
    warnings,
    unavailableSources,
  };
}
