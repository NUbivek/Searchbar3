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
import { matchRank } from './identity';
import { USE_NOTICE } from './guardrails';
import { chatComplete, PROVIDERS, providerEnabled } from '../llm/providers';
import { validateAnswer } from '../search/answer';

const SECTION_ORDER = ['sanctions', 'regulatory', 'litigation', 'leaks', 'exposure', 'archive', 'career', 'education', 'corporate', 'related', 'ip', 'identity', 'press'];
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1, info: 0 };
// Records from the authority itself outrank a report about it.
const AUTHORITY = { sanctions: 3, regulatory: 3, litigation: 3, leaks: 2.5, corporate: 2.5, archive: 2, ip: 2, education: 2, exposure: 2, career: 1.5, identity: 1.5, related: 1.5, press: 1 };

export const NOT_COVERED = [
  'US state and county court records, and full federal dockets (PACER), beyond what CourtListener and news sources carry',
  'Criminal records, credit history, liens and judgments held by commercial background-check providers',
  'Private company financials, cap tables and unpublished regulatory correspondence',
  'Sources that are not in English or are behind a login or paywall',
  'Anything a person has had removed from the web and that was never archived',
];

const matchWeight = (m) => (m === 'company' ? 2 : matchRank(m));
const when = (f) => (f.date ? Date.parse(f.date.length === 4 ? `${f.date}-01-01` : f.date) || 0 : 0);

function score(f, corroboration) {
  return (SEVERITY_WEIGHT[f.severity] || 0) * 3 + matchWeight(f.match) * 2 + (AUTHORITY[f.category] || 1) + Math.min(2, (corroboration - 1) * 0.75);
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
  return `words|${words || f.id}`;
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
  if (!tag) return `single|${f.id}`;
  const who = f.data?.person ? String(f.data.person).toLowerCase() : f.match === 'company' ? 'company' : 'person';
  return `${tag}|${f.date ? f.date.slice(0, 7) : 'undated'}|${who}`;
}

/**
 * Build the report from a finished (or still running) check state.
 * Pure: no network, no model.
 */
export function buildReport(state) {
  const findings = state.findings || [];
  const groups = new Map();
  for (const f of findings) {
    const key = corroborationKey(f);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add((() => { try { return new URL(f.url).hostname.replace(/^www\./, ''); } catch { return f.source; } })());
  }
  const ranked = findings
    .map((f) => ({ ...f, corroboration: groups.get(corroborationKey(f)).size }))
    .map((f) => ({ ...f, score: score(f, f.corroboration) }))
    .sort((a, b) => b.score - a.score || when(b) - when(a));

  // Number the records once; the brief, the sections and the UI all cite the same numbers.
  const sources = ranked.map((f, i) => ({ n: i + 1, id: f.id, title: f.title, url: f.url, sourceLabel: f.sourceLabel, category: f.category, date: f.date, match: f.match }));
  const numberOf = new Map(sources.map((s) => [s.id, s.n]));
  const cited = ranked.map((f) => ({ ...f, n: numberOf.get(f.id) }));

  // Serious records, grouped into matters. A matter with at least one record tied to the person (or their
  // company) is a red flag, led by its strongest tied record; name-only reports of the same event in the
  // same month are listed under it as further coverage. A matter known only by name is a possible namesake.
  const serious = cited.filter((f) => f.severity === 'high' || f.severity === 'medium');
  const matters = new Map();
  for (const f of serious) {
    const key = matterKey(f);
    if (!matters.has(key)) matters.set(key, []);
    matters.get(key).push(f);
  }
  const short = (f) => ({ n: f.n, title: f.title, url: f.url, sourceLabel: f.sourceLabel, date: f.date, match: f.match });
  const redFlags = []; // about the person
  const companyMatters = []; // about a company they founded or run: context, not a mark against them by itself
  const possibleNamesake = [];
  for (const list of matters.values()) {
    const person = list.filter((f) => f.match === 'confirmed' || f.match === 'likely');
    const company = list.filter((f) => f.match === 'company');
    const lead = (person.length ? person : company.length ? company : list)[0]; // `cited` is in rank order, so the first is the strongest
    const entry = { ...lead, more: list.filter((f) => f !== lead).map(short) };
    (person.length ? redFlags : company.length ? companyMatters : possibleNamesake).push(entry);
  }
  redFlags.sort((a, b) => a.n - b.n);
  companyMatters.sort((a, b) => a.n - b.n);
  possibleNamesake.sort((a, b) => a.n - b.n);

  const sections = SECTION_ORDER
    .map((key) => ({ key, title: CATEGORIES[key], items: cited.filter((f) => f.category === key) }))
    .filter((s) => s.items.length > 0);

  const timeline = cited
    .filter((f) => f.date && f.match !== 'possible' && ['career', 'corporate', 'litigation', 'regulatory', 'sanctions', 'education', 'archive'].includes(f.category))
    .sort((a, b) => when(a) - when(b))
    .map((f) => ({ date: f.date, title: f.title, category: f.category, n: f.n, severity: f.severity }));

  const claimChanges = cited.filter((f) => f.category === 'archive' && f.data?.kind === 'change');

  const related = new Map();
  for (const t of Object.values(state.threads || {})) {
    if ((t.kind === 'relative' || t.kind === 'associate') && t.trusted) related.set(t.value.toLowerCase(), { name: t.value, kind: t.kind, relation: t.relation || null, role: t.role || null, why: t.why || '', records: [] });
  }
  for (const f of cited) {
    const person = f.data?.person;
    if (person && related.has(String(person).toLowerCase())) related.get(String(person).toLowerCase()).records.push({ n: f.n, title: f.title, severity: f.severity, category: f.category });
  }

  const allSources = Object.entries(state.sources || {}).map(([id, s]) => ({ id, ...s }));
  const coverage = {
    searched: allSources.filter((s) => s.runs > 0).map((s) => ({ id: s.id, label: s.label, lookups: s.runs, records: s.findings, failed: s.errors, lastError: s.errors ? s.lastError : null })),
    notSearched: allSources.filter((s) => s.off || (s.runs > 0 && s.errors >= s.runs)).map((s) => ({ label: s.label, reason: s.lastError || 'No answer.' })),
    notCovered: NOT_COVERED,
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
  const gaps = [
    ...report.possibleNamesake.slice(0, 8).map((f) => `• Rule out a namesake: ${f.title} [Source ${f.n}]`),
    ...report.coverage.notSearched.map((s) => `• ${s.label} did not answer: ${s.reason}`),
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
 * @param {{ deadline?: number, maxRecords?: number, complete?: Function }} options
 */
export async function writeDeepBrief(report, { deadline = null, maxRecords = 70, complete = chatComplete } = {}) {
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
  for (const f of records.sort((a, b) => b.score - a.score)) {
    if (picked.length >= maxRecords) break;
    taken[f.category] = (taken[f.category] || 0) + 1;
    if (taken[f.category] <= perCategory || f.severity === 'high') picked.push(f);
  }
  picked.sort((a, b) => a.n - b.n);
  if (!picked.length) return { brief: null, briefInfo: null };
  if (!PROVIDERS.some(providerEnabled)) return { brief: quotedDeepBrief(report, 'AI answers are not enabled on this deployment'), briefInfo: { mode: 'quoted', reason: 'AI answers are not enabled on this deployment' } };

  const identity = report.identity?.note ? `\nIdentity note: ${report.identity.note}` : '';
  const coverage = `Sources that answered: ${report.coverage.searched.map((s) => s.label).join(', ') || 'none'}.\nSources that failed or are not enabled: ${report.coverage.notSearched.map((s) => s.label).join(', ') || 'none'}.\nNot covered by any free source: ${report.coverage.notCovered.join('; ')}.`;
  const user = `Today's date: ${new Date().toISOString().slice(0, 10)}\nPerson: ${report.name}${report.company ? `\nCompany: ${report.company}` : ''}${identity}\n\n${coverage}\n\nRecords (${picked.length} of ${report.totals.records}, strongest first within each kind):\n${recordsBlock(picked)}`;
  const maxN = report.sources.length;
  // 'analysis': the strongest models, more thinking, and no model with a poor record on made-up facts.
  // An answer that fails the citation checks sends the request to the next model.
  const out = await complete([{ role: 'system', content: DEEP_PROMPT }, { role: 'user', content: user }], {
    maxTokens: 3500, deadline, task: 'analysis', personal: true,
    accept: (text) => validateAnswer(text, maxN, DEEP_SECTIONS).ok,
  });
  if (!out) return { brief: quotedDeepBrief(report, 'The AI model was unavailable'), briefInfo: { mode: 'quoted', reason: 'The AI model was unavailable' } };
  const checked = validateAnswer(out.text, maxN, DEEP_SECTIONS);
  if (!checked.ok) return { brief: quotedDeepBrief(report, `The AI brief failed validation (${checked.reason})`), briefInfo: { mode: 'quoted', reason: `The AI brief failed validation (${checked.reason})` } };
  // A citation is only valid if that record was actually shown to the model.
  const shown = new Set(picked.map((f) => f.n));
  const content = checked.content.replace(/\[Source (\d+)\]/g, (m, n) => (shown.has(Number(n)) ? m : ''));
  return { brief: content, briefInfo: { mode: 'ai', provider: out.providerLabel, model: out.model, confidence: checked.confidence, skipped: out.skipped || [], recordsRead: picked.length } };
}
