/**
 * Founder background check: purely extractive. Every item returned is a
 * sentence (or headline) copied verbatim from a fetched source, tagged with
 * the index of that source in `sources`. Nothing is inferred or written here.
 *
 * Name matching is strict: the full name on word boundaries, written in the
 * source as a capitalized proper name. The user's capitalization does not
 * matter ("arthur mensch" finds "Arthur Mensch"), but initials ("A. Mensch")
 * and lowercase common-word uses do not match.
 * LinkedIn's API is not used (it does not share profiles with ordinary
 * apps); public LinkedIn/Crunchbase profile pages are used only as they
 * appear in web search results (title and snippet).
 *
 * runFounderCheck: retrieve (web + news + profile snippets, curated index,
 * Hacker News, CourtListener) -> keep sources naming the person -> rank ->
 * extract sections -> AI-written brief with checked citations (free model
 * chain) or a quoted brief.
 */
import { searchCuratedForEntity } from '../utils/sources/curatedIndex';
import { searchHackerNews } from '../utils/sources/hackernewsAlgolia';
import { searchWeb, webSearchConfigured } from './search/retrieve';
import { chatComplete, PROVIDERS, providerEnabled } from './llm/providers';
import { validateAnswer } from './search/answer';
import { tierInfo } from '../utils/sourceTiers';
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

const EDUCATION_PATTERNS = [
  new RegExp(`\\b(?:graduated|graduate|graduating)\\s+(?:from|of)\\s+(?:the\\s+)?${CO}`),
  new RegExp(`\\b(?:studied|study|studies)\\s+(?:[a-z ]{0,40}\\s)?at\\s+(?:the\\s+)?${CO}`),
  new RegExp(`\\b(?:MBA|PhD|Ph\\.D\\.?|BA|BS|BSc|MSc|MS|MA|JD|MD|degree|doctorate|master'?s|bachelor'?s)\\b[^.]{0,40}?\\b(?:from|at)\\s+(?:the\\s+)?${CO}`),
  new RegExp(`\\b(?:alumnus|alumna|alum|alumni)\\s+of\\s+(?:the\\s+)?${CO}`),
  /\bEducation:\s*([^·|]+)/,
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
export function extractFounderEvidence({ name, company, results, keepAllSources = false }) {
  const hasName = nameMatcher(name);
  const hasCompany = companyMatcher(company);
  const deduped = dedupeResults(results);

  // Raw items reference the deduped result index; renumbered at the end.
  const timeline = [];
  const pastCompanies = [];
  const litigation = [];
  const press = [];
  const education = [];
  const seenSchools = new Set();
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
      for (const re of EDUCATION_PATTERNS) {
        const m = text.match(re);
        const school = m && String(m[1]).trim().replace(/[.,;:]+$/, '');
        if (school && school.length > 2 && !seenSchools.has(school.toLowerCase())) {
          seenSchools.add(school.toLowerCase());
          education.push({ school, quote: text, ri, headline, ...flag(text) });
        }
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

  const ed = education.slice(0, 10);
  // Only cited sources are listed (or all, when the caller numbers them);
  // sourceIndex is 0-based into sources.
  const used = keepAllSources
    ? deduped.map((_, i) => i)
    : [...new Set([...tl, ...pc, ...lit, ...pr, ...ed].map((x) => x.ri))].sort((a, b) => a - b);
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
    education: ed.map(fix),
  };
}

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
    const parts = title.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
    const snippet = cleanText(r.snippet || r.content);
    let role = parts[1] || null;
    let company = parts[2] || null;
    const at = role && role.match(/^(.*?)\s+(?:@|at)\s+(.+)$/);
    if (at) { role = at[1]; company = company || at[2]; }
    const experience = (snippet.match(/Experience:\s*([^·|]+)/) || [])[1];
    const educationText = (snippet.match(/Education:\s*([^·|]+)/) || [])[1];
    const location = (snippet.match(/Location:\s*([^·|]+)/) || [])[1];
    profiles.push({
      platform: isLinkedIn ? 'LinkedIn' : 'Crunchbase',
      role: role || null,
      company: (company || experience || '').trim() || null,
      education: educationText ? educationText.trim() : null,
      location: location ? location.trim() : null,
      url,
      sourceIndex: i,
    });
  });
  return profiles;
}

const BRIEF_SECTIONS = ['## SUMMARY', '## CAREER TIMELINE', '## PAST COMPANIES AND ROLES', '## EDUCATION', '## LITIGATION AND REGULATORY', '## PRESS AND PUBLIC STATEMENTS', '## RED FLAGS AND OPEN QUESTIONS'];

const BRIEF_PROMPT = `You are a diligence analyst writing a founder background brief. Use ONLY the numbered sources. Several people can share a name: use only sources that clearly describe the same person (matching company, role or details); if sources may describe different people, say so in RED FLAGS AND OPEN QUESTIONS.

Rules:
- Cite every factual sentence or bullet with [Source n]. Never cite a number that is not listed.
- Never add facts that are not in the sources. If a section has no supporting source, write "Not found in the available sources."
- Absence of litigation results is NOT evidence of a clean record; say so in LITIGATION AND REGULATORY.
- Give dates where sources give them.

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
  return results.map((r, i) => `[Source ${i + 1}] ${cleanText(r.title)}\nPublisher: ${sourceLabel(r)}${formatDate(r.publishedAt || r.date || r.timestamp) ? ` | Date: ${formatDate(r.publishedAt || r.date || r.timestamp)}` : ''}\nURL: ${r.url}\nText: ${cleanText(r.snippet || r.content).slice(0, 600) || '(headline only)'}`).join('\n\n');
}

/** Quoted brief built from the extracted sections (no AI). */
function quotedBrief(person, evidence, reason) {
  const cite = (x) => `[Source ${x.sourceIndex + 1}]`;
  const bullets = (items, fmt, empty = 'Not found in the available sources.') => (items.length ? items.map(fmt).join('\n') : empty);
  return [
    '## SUMMARY',
    evidence.press.length
      ? `${evidence.sources.length} source${evidence.sources.length === 1 ? '' : 's'} name ${person}. ${evidence.press[0].quote} ${cite(evidence.press[0])}`
      : `No source in the available indexes names ${person}.`,
    '', '## CAREER TIMELINE', bullets(evidence.timeline, (x) => `• ${x.year}: ${x.quote} ${cite(x)}`),
    '', '## PAST COMPANIES AND ROLES', bullets(evidence.pastCompanies, (x) => `• **${x.company}**: ${x.quote} ${cite(x)}`),
    '', '## EDUCATION', bullets(evidence.education, (x) => `• **${x.school}**: ${x.quote} ${cite(x)}`),
    '', '## LITIGATION AND REGULATORY', bullets(evidence.litigation, (x) => `• ${x.quote} ${cite(x)}`, 'No litigation or regulatory mentions found in the available sources.'), `\n*${LITIGATION_DISCLAIMER}*`,
    '', '## PRESS AND PUBLIC STATEMENTS', bullets(evidence.press.slice(0, 8), (x) => `• ${x.quote} ${cite(x)}`),
    '', '## RED FLAGS AND OPEN QUESTIONS',
    '• Confirm identity: sources are matched by full name only; check that each describes the same person.',
    '• Ask references about the reasons for each move between companies.',
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

/**
 * Run the check.
 * @param {{ name: string, company?: string, model?: string, useLLM?: boolean }} input
 * @param {{ searchers?: object }} deps override searchers in tests
 */
export async function runFounderCheck({ name, company, model = 'auto', useLLM = true, deadline = null } = {}, deps = {}) {
  const person = String(name || '').trim().replace(/\s+/g, ' ');
  const co = String(company || '').trim().replace(/\s+/g, ' ');
  if (!person) throw new Error('name is required');
  const hasName = nameMatcher(person);

  const searchers = {
    curated: () => searchCuratedForEntity(hasName, { limit: 25, waitMs: 8000 }),
    hackernews: (q) => searchHackerNews(q, { limit: 15 }),
    web: (q, opts) => searchWeb(q, opts),
    courtlistener: (n) => searchCourtListener(n),
    webConfigured: webSearchConfigured,
    ...(deps.searchers || {}),
  };

  const quoted = `"${person}"`;
  const webQueries = [
    [quoted, {}],
    [`${quoted} ${co || 'founder OR CEO OR co-founder'}`, {}],
    [`${quoted} site:linkedin.com/in`, {}],
    [`${quoted} site:crunchbase.com/person`, {}],
    [`${quoted} lawsuit OR sued OR fraud OR charged OR settlement`, {}],
    [`${quoted}${co ? ` ${co}` : ''}`, { news: true, withinDays: 0 }],
  ];

  const warnings = [];
  const unavailableSources = [];
  const webOn = searchers.webConfigured();
  if (!webOn) unavailableSources.push({ source: 'Web search', reason: 'No SERPER_API_KEY or TAVILY_API_KEY configured.' });

  const tasks = [
    { source: 'Curated news index', run: () => searchers.curated(person) },
    { source: 'Hacker News', run: () => searchers.hackernews(person) },
    ...(co ? [{ source: 'Hacker News', run: () => searchers.hackernews(`${person} ${co}`) }] : []),
    ...(webOn ? webQueries.map(([q, opts]) => ({ source: 'Web search', run: () => searchers.web(q, opts) })) : []),
    { source: 'CourtListener', run: () => searchers.courtlistener(person) },
  ];
  const settled = await Promise.allSettled(tasks.map((t) => withTimeout(Promise.resolve().then(t.run), QUERY_TIMEOUT_MS, t.source)));

  const raw = [];
  const failuresBySource = new Map();
  settled.forEach((x, i) => {
    const { source } = tasks[i];
    if (x.status === 'fulfilled') raw.push(...(Array.isArray(x.value) ? x.value : []));
    else if (!failuresBySource.has(source)) failuresBySource.set(source, x.reason);
  });
  for (const [source, err] of failuresBySource) {
    const allFailed = settled.every((x, i) => tasks[i].source !== source || x.status === 'rejected');
    if (allFailed) unavailableSources.push({ source, reason: String(err?.message || err) });
    else warnings.push(`Some ${source} queries failed: ${String(err?.message || err)}`);
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
    sc += { filing: 1.5, press: 1.2, blog: 0.5, other: 0.4, forum: 0.2 }[tierInfo(r).tier] ?? 0.4;
    const t = Date.parse(r.publishedAt || r.date || r.timestamp || '');
    if (!Number.isNaN(t)) sc += Math.max(0, 1 - (Date.now() - t) / (3 * 365 * 86400000));
    return sc;
  };
  const ranked = named.map((r) => ({ r, sc: scoreOf(r) })).sort((a, b) => b.sc - a.sc).map((x) => x.r).slice(0, 20);

  // Display the name as sources write it ("Arthur Mensch", not "arthur mensch")
  const nameRe = new RegExp(`(?<![A-Za-z0-9])${person.split(' ').map(escapeRe).join('\\s+')}(?![A-Za-z0-9])`, 'i');
  const displayName = ranked.map((r) => (text(r).match(nameRe) || [])[0]).find((m) => m && m.split(/\s+/).every((w) => /^[A-Z\u00C0-\u024F]/.test(w))) || person;

  const evidence = extractFounderEvidence({ name: person, company: co, results: ranked, keepAllSources: true });
  const profiles = extractProfiles(ranked, hasName);

  // Disambiguation: profile pages describing different current companies
  const distinctCompanies = [...new Set(profiles.map((p) => String(p.company || '').toLowerCase()).filter(Boolean))];
  if (!co && distinctCompanies.length > 1) {
    warnings.push(`Profiles for several people named ${person} were found (${profiles.map((p) => p.company).filter(Boolean).slice(0, 4).join('; ')}). Add a company to narrow the check.`);
  }
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

  // Brief: AI (free chain) with checked citations, else quoted
  let brief = null;
  let briefInfo = { mode: 'quoted', reason: 'No AI model is configured' };
  if (ranked.length > 0 && useLLM && PROVIDERS.some(providerEnabled)) {
    const user = `Today's date: ${new Date().toISOString().slice(0, 10)}\nPerson: ${displayName}${co ? `\nCompany (to disambiguate): ${co}` : ''}\n\nSources:\n${sourcesBlock(ranked.slice(0, 15))}`;
    const out = await chatComplete([{ role: 'system', content: BRIEF_PROMPT }, { role: 'user', content: user }], { preferred: model, maxTokens: 3000, deadline });
    if (out) {
      const checked = validateAnswer(out.text, Math.min(15, ranked.length), BRIEF_SECTIONS);
      if (checked.ok) {
        brief = checked.content;
        briefInfo = { mode: 'ai', provider: out.providerLabel, model: out.model, confidence: checked.confidence, skipped: out.skipped || [] };
      } else {
        briefInfo = { mode: 'quoted', reason: `The AI brief failed validation (${checked.reason})` };
      }
    } else {
      briefInfo = { mode: 'quoted', reason: 'The AI model was unavailable' };
    }
  }
  if (!brief && ranked.length > 0) brief = quotedBrief(displayName, evidence, briefInfo.reason);

  return {
    name: displayName,
    company: co || null,
    generatedAt: new Date().toISOString(),
    ...evidence,
    profiles,
    brief,
    briefInfo,
    litigationDisclaimer: LITIGATION_DISCLAIMER,
    warnings: ['Name matching is strict (exact full name, any capitalization). Mentions using initials, nicknames or a different spelling are not included; different people can share the same name.', ...warnings],
    unavailableSources: [
      ...unavailableSources,
      { source: 'LinkedIn', reason: 'LinkedIn does not share profiles with third-party apps; public profile snippets from web search are used instead.' },
    ],
  };
}
