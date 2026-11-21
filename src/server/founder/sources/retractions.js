/**
 * Retracted papers and expressions of concern on papers the person wrote.
 *
 *   retractions   Crossref's record of retraction notices and expressions of
 *                 concern. Since 2023 it carries the whole Retraction Watch
 *                 database (Crossref acquired it and made it open) beside the
 *                 notices publishers deposit themselves. One search per
 *                 person: the person's name as an author, filtered to works
 *                 that are the subject of a retraction or an expression of
 *                 concern. When a record already tied to the person lists
 *                 their ORCID iD, the same search is also run on that iD.
 *
 * Crossref's author search is fuzzy ("Elizabeth Holmes" also returns Roisin
 * Holmes and Elizabeth M. Snyder), so a notice is kept only when one of its
 * authors IS the person: first and last name equal, middle names optional
 * (scholar.personNameFits). Initials alone ("E. Holmes") are never enough.
 * A kept notice is:
 *   'likely'   when, besides the full name, the record itself carries a
 *              second fact about the person: the author's ORCID iD is one a
 *              record already tied to them lists, the author's affiliation
 *              is a company or school already known for them (every known
 *              name of the company; a one-word ordinary company only as its
 *              whole name, scholar.knownCompanyOf), or the retracted paper is
 *              one already tied to them (same DOI);
 *   'possible' otherwise, with "verify identity" in its reasons.
 * No grade here is ever 'confirmed'.
 *
 * Privacy: only the person's own name as the record writes it is kept.
 * Co-authors' names, affiliations other than the matching one, and any
 * address inside an affiliation line are never stored or followed. Paper
 * titles pass the privacy rules (a paper about a disease is kept; it is not a
 * statement about its author).
 *
 * Absence proves little: coverage depends on publishers depositing notices
 * and on Retraction Watch, and the notes say so.
 *
 * Crossref asks anonymous readers for one request at a time; requests take
 * turns here. Answers are kept for a day in this server instance's memory
 * only (they are about the person, so never in the shared cache).
 * Terms: Crossref metadata is open to reuse; Crossref asks that Retraction
 * Watch be credited when its data is used, which the label does.
 */
import { getJson, HttpError } from '../http';
import { makeFinding } from '../finding';
import { nameTokens } from '../identity';
import { cleanSentences } from '../guardrails';
import { personNameFits, knownCompanyOf, sameSchool, orcidIdFromUrl } from './scholar';

export const RETRACTIONS_LABEL = 'Retracted papers (Crossref, Retraction Watch)';
export const CROSSREF_WORKS = 'https://api.crossref.org/v1/works';
const FIELDS = 'DOI,title,author,update-to,issued,container-title,type';
const TYPES = { retraction: 'Retraction', expression_of_concern: 'Expression of concern' };
export const ROWS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 8;
const MAX_POSSIBLE = 4;
const ORCID_ID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const VERIFY = 'verify identity';

export const COVERAGE_NOTE = 'Retraction notices reach Crossref from publishers and from the Retraction Watch database; a paper retracted without a deposited notice would not appear.';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const unique = (list) => [...new Set(list.filter(Boolean))];
/** Short labels (a paper title, a journal, a school): only sentences the privacy rules reject are left out. */
const safe = (s) => clean(cleanSentences(clean(s), { kin: false }).text);
const bareOrcid = (v) => clean(v).replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, '').replace(/\/$/, '').toUpperCase();
const bareDoi = (v) => clean(v).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();

const partsToDate = (parts) => {
  const [y, m, d] = Array.isArray(parts?.[0]) ? parts[0] : [];
  if (!y) return '';
  if (!m) return String(y);
  return d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : `${y}-${String(m).padStart(2, '0')}`;
};

/* ------------------------------------------------------------------ */
/* Crossref: one request at a time, answers kept a day in memory        */
/* ------------------------------------------------------------------ */

const GAP_MS = 1100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let queue = Promise.resolve();
let nextAt = 0;
let gapMs = GAP_MS;
const answers = new Map(); // url -> { at, body }

async function turn(deadline, fn) {
  const before = queue;
  let release;
  queue = new Promise((resolve) => { release = resolve; });
  let started = false;
  try {
    await before;
    const wait = Math.max(0, nextAt - Date.now());
    if (deadline && Date.now() + wait + 2500 > deadline) throw new HttpError('Out of time waiting for a turn at Crossref', { url: CROSSREF_WORKS, code: 'deadline' });
    if (wait > 0) await sleep(wait);
    started = true;
    return await fn();
  } finally {
    if (started) nextAt = Date.now() + gapMs;
    release();
  }
}

/**
 * The works under one search, as { items, total }. Throws when Crossref does
 * not answer or answers in a shape this reader does not know, so a changed
 * format is reported as a failed lookup, never as "no retraction".
 */
async function search(params, ctx) {
  const query = new URLSearchParams(params);
  query.set('filter', [params.filter, 'update-type:retraction', 'update-type:expression_of_concern'].filter(Boolean).join(','));
  query.set('rows', String(ROWS));
  query.set('select', FIELDS);
  const url = `${CROSSREF_WORKS}?${query}`;
  const hit = answers.get(url);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.result;
  const body = await turn(ctx.deadline, () => getJson(url, { deadline: ctx.deadline, maxBytes: 4 * 1024 * 1024 }));
  const message = body?.message;
  if (body?.status !== 'ok' || !message || !Array.isArray(message.items) || typeof message['total-results'] !== 'number') {
    throw new HttpError('Crossref answered in a shape this reader does not know (no list of works)', { url });
  }
  // Every work this filter returns is the subject of a retraction or a concern; none carrying one means the format changed.
  if (message.items.length && !message.items.some((it) => noticesOf(it).length)) {
    throw new HttpError('Crossref answered without retraction details on any work (the format may have changed)', { url });
  }
  const result = { items: message.items, total: message['total-results'] };
  if (answers.size >= 200) answers.delete(answers.keys().next().value);
  answers.set(url, { at: Date.now(), result });
  return result;
}

/** For tests: forget remembered answers and the queue. */
export function __resetRetractionsForTests({ gap = GAP_MS } = {}) {
  answers.clear();
  queue = Promise.resolve();
  nextAt = 0;
  gapMs = gap;
}

/* ------------------------------------------------------------------ */
/* Reading one work                                                    */
/* ------------------------------------------------------------------ */

/** The retraction and concern entries of one work: [{ doi, type, label, source, date }]. */
export function noticesOf(item) {
  return (Array.isArray(item?.['update-to']) ? item['update-to'] : [])
    .filter((u) => u && TYPES[u.type] && clean(u.DOI))
    .map((u) => ({
      doi: bareDoi(u.DOI),
      type: u.type,
      source: clean(u.source),
      date: clean(u.updated?.['date-time']).slice(0, 10) || partsToDate(u.updated?.['date-parts']),
    }));
}

/** "Retraction Note: A study of X" -> "A study of X". */
const PREFIX = /^\s*(?:(?:editorial\s+)?(?:retraction|expression of concern|notice of retraction|withdrawal)(?:\s+(?:note|notice|statement))?(?:\s+(?:to|for|of))?|retracted|withdrawn)\s*[:.\-–—]?\s*/i;
export function paperTitle(raw) {
  const t = clean(raw);
  const stripped = clean(t.replace(PREFIX, '').replace(/^["“'‘]+|["”'’]+$/g, ''));
  return stripped.length >= 8 ? stripped : t;
}

/**
 * Which known organisation of the subject an affiliation line names, or ''.
 * A company is compared as a name (knownCompanyOf: every known name, a
 * one-word ordinary company only as its whole name); a school as a school
 * (sameSchool), on the line and on its first part ("Stanford University,
 * Stanford, CA" is Stanford University).
 */
function knownAffiliation(subject, line) {
  const first = clean(String(line).split(',')[0]);
  for (const label of unique([clean(line), first])) {
    const company = knownCompanyOf(subject, label);
    if (company) return company.value;
  }
  for (const a of (subject?.anchors?.schools || new Map()).values()) {
    if (sameSchool(a.value, line) || sameSchool(a.value, first)) return a.value;
  }
  return '';
}

/**
 * The person's authorship on one work, or null: the author whose name fits
 * the subject's, with the second fact (if any) that ties them.
 */
export function subjectAuthorship(subject, item, { tiedOrcids = new Set(), tiedDois = new Set(), notices = noticesOf(item) } = {}) {
  for (const author of Array.isArray(item?.author) ? item.author : []) {
    if (!author?.family) continue;
    const written = clean(`${author.given || ''} ${author.family}`);
    const orcid = ORCID_ID.test(bareOrcid(author.ORCID)) ? bareOrcid(author.ORCID) : '';
    if (!personNameFits(subject, written)) continue;
    const reasons = [];
    if (orcid && tiedOrcids.has(orcid)) reasons.push(`the author's ORCID iD (${orcid}) is that of a record already tied to the person`);
    let affiliation = '';
    for (const a of Array.isArray(author.affiliation) ? author.affiliation : []) {
      const known = knownAffiliation(subject, clean(a?.name));
      if (known) { affiliation = known; break; }
    }
    if (affiliation) reasons.push(`the author's affiliation on the paper is ${affiliation}, already known for the person`);
    const tiedPaper = notices.find((n) => tiedDois.has(n.doi));
    if (tiedPaper) reasons.push(`the paper (${tiedPaper.doi}) is one already tied to the person`);
    return { written, orcid, affiliation, reasons };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

/** ORCID iDs and paper DOIs on records this check already tied to the person (likely or confirmed). */
function tiedFacts(ctx, extraOrcids = []) {
  let earlier = [];
  try { earlier = typeof ctx?.findings === 'function' ? ctx.findings() : ctx?.findings; } catch { earlier = []; }
  const tied = (Array.isArray(earlier) ? earlier : []).filter((f) => f && (f.match === 'likely' || f.match === 'confirmed'));
  const orcids = new Set([...extraOrcids, ...tied.map((f) => f.data?.orcid)].map(bareOrcid).filter((x) => ORCID_ID.test(x)));
  const dois = new Set(tied.map((f) => f.data?.doi).filter(Boolean).map(bareDoi));
  return { orcids, dois };
}

/**
 * Findings from Crossref works: one per retracted or questioned paper (a
 * paper often has both a publisher's notice and a Retraction Watch entry).
 */
export function retractionFindings(subject, items, { tiedOrcids = new Set(), tiedDois = new Set() } = {}) {
  const byPaper = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const notices = noticesOf(item);
    if (!notices.length) continue;
    const who = subjectAuthorship(subject, item, { tiedOrcids, tiedDois, notices });
    if (!who) continue;
    const paperDoi = notices[0].doi;
    const entry = byPaper.get(paperDoi) || { item, who, notices: [], journal: '', titles: [] };
    entry.notices.push(...notices.filter((n) => n.doi === paperDoi));
    entry.journal = entry.journal || safe((item['container-title'] || [])[0]);
    entry.titles.push(clean((item.title || [])[0]));
    if (who.reasons.length > entry.who.reasons.length) entry.who = who;
    byPaper.set(paperDoi, entry);
  }
  const findings = [];
  for (const [doi, e] of byPaper) {
    const retracted = e.notices.some((n) => n.type === 'retraction');
    const kind = retracted ? 'retraction' : 'expression_of_concern';
    const date = e.notices.filter((n) => n.type === kind).map((n) => n.date).filter(Boolean).sort()[0] || partsToDate(e.item.issued?.['date-parts']) || null;
    const year = date ? date.slice(0, 4) : '';
    const title = safe(paperTitle(e.titles.find(Boolean) || ''));
    const sources = unique(e.notices.map((n) => (n.source === 'retraction-watch' ? 'Retraction Watch' : n.source === 'publisher' ? 'the publisher' : '')));
    const what = retracted ? 'Retracted paper' : 'Expression of concern on a paper';
    const likely = e.who.reasons.length > 0;
    const made = makeFinding(subject, {
      source: 'retractions', sourceLabel: RETRACTIONS_LABEL, category: 'ip',
      title: `${what} listing ${e.who.written} as an author${title ? `: ${title}` : ''}${[e.journal, year].filter(Boolean).length ? ` (${[e.journal, year].filter(Boolean).join(', ')})` : ''}`,
      quote: [
        `Author: ${e.who.written}${e.who.affiliation ? ` (${e.who.affiliation})` : ''}`,
        safe(e.titles.find(Boolean) || ''),
        e.journal,
        `${TYPES[kind]}${date ? ` dated ${date}` : ''}${sources.length ? `, recorded by ${sources.join(' and ')}` : ''}`,
      ].filter(Boolean).join('. '),
      url: `https://doi.org/${doi}`,
      date,
      severity: retracted ? 'medium' : 'low',
      match: likely ? 'likely' : 'possible',
      matchReasons: likely
        ? [`the author's full name matches, and ${e.who.reasons[0]}`]
        : [`an author of this paper has the person's full name, and nothing else on the record ties the paper to them: ${VERIFY}`],
      data: {
        registry: 'Crossref', doi, notice: kind, noticeSources: sources, journal: e.journal || null,
        ...(e.who.orcid ? { orcid: e.who.orcid } : {}),
        ...(e.who.affiliation ? { affiliation: e.who.affiliation } : {}),
      },
    });
    if (made) findings.push(made);
  }
  const rank = (f) => (f.match === 'likely' ? 2 : 1) * 10 + (f.data?.notice === 'retraction' ? 1 : 0);
  let possible = 0;
  return findings.sort((a, b) => rank(b) - rank(a))
    .filter((f) => f.match !== 'possible' || (possible += 1) <= MAX_POSSIBLE)
    .slice(0, MAX_FINDINGS);
}

/* ------------------------------------------------------------------ */
/* The source                                                          */
/* ------------------------------------------------------------------ */

async function runLookup(subject, ctx, { orcid = '' } = {}) {
  const { orcids, dois } = tiedFacts(ctx, orcid ? [orcid] : []);
  const searches = [{ what: `the name ${subject.name}`, params: { 'query.author': subject.name } }];
  for (const id of [...orcids].slice(0, 2)) searches.push({ what: `the ORCID iD ${id}`, params: { filter: `orcid:${id}` } });
  if (orcid) searches.shift(); // a lookup started from an ORCID link searches that iD only
  const settled = await Promise.allSettled(searches.map((s) => search(s.params, ctx)));
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
  const notes = [];
  const partial = [];
  const items = [];
  settled.forEach((r, i) => {
    const s = searches[i];
    if (r.status === 'rejected') {
      partial.push(`retraction notices under ${s.what}`);
      notes.push(`Crossref did not answer the search for retraction notices under ${s.what} (${clean(r.reason?.message) || 'no answer'}).`);
      return;
    }
    items.push(...r.value.items);
    if (r.value.total > ROWS) {
      partial.push(`retraction notices under ${s.what} (most relevant ${ROWS} of ${r.value.total} read)`);
      notes.push(`Crossref lists ${r.value.total} retracted or questioned papers for an author search on ${s.what}; the ${ROWS} it ranks closest were read.`);
    }
  });
  const findings = retractionFindings(subject, items, { tiedOrcids: orcids, tiedDois: dois });
  if (!findings.length) {
    notes.push(`Searched Crossref's record of retractions and expressions of concern (with the Retraction Watch database) for papers by ${subject.name}${orcids.size ? ` and by ORCID iD ${[...orcids].join(', ')}` : ''}: no paper with an author of that full name was found.`);
  } else if (findings.every((f) => f.match === 'possible')) {
    notes.push(`The papers found list an author named ${subject.name}, but nothing on them (an ORCID iD, an affiliation, a paper already tied to the person) shows it is this person: ${VERIFY}.`);
  }
  notes.push(COVERAGE_NOTE);
  return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
}

export const retractionsConnector = {
  id: 'retractions',
  label: RETRACTIONS_LABEL,
  kinds: ['subject', 'url'],
  prior: 0.2,
  maxParallel: 1,
  timeoutMs: 15000,
  plan(thread) {
    // The loop's task does not carry the thread's trust, so the plan passes it on in params.
    if (thread.kind === 'url') return orcidIdFromUrl(thread.value) && thread.trusted ? [{ template: 'orcid-id', prior: 0.3, why: 'retracted papers under the ORCID iD a tied record links to', params: { trusted: true } }] : [];
    if (thread.kind === 'subject') return [{ template: 'author', prior: 0.2, why: 'retracted papers and expressions of concern' }];
    return [];
  },
  async run(task, ctx) {
    const { subject } = ctx;
    if (task.kind === 'url') {
      const id = orcidIdFromUrl(task.value);
      if (!id || !(task.trusted || task.params?.trusted)) return { findings: [], threads: [], notes: [] };
      return runLookup(subject, ctx, { orcid: id });
    }
    if (task.kind !== 'subject') return { findings: [], threads: [], notes: [] };
    if (nameTokens(subject.name).length < 2) return { findings: [], threads: [], notes: ['Retracted papers were not searched: a first and a last name are needed.'], partial: ['retracted papers (not searched without a first and a last name)'] };
    return runLookup(subject, ctx);
  },
};
