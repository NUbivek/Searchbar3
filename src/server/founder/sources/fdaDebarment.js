/**
 * The FDA debarment list for drug product applications: the people and firms
 * the FDA has barred, under section 306 of the Federal Food, Drug, and
 * Cosmetic Act, from working on or submitting drug applications (usually
 * after a criminal conviction). One source, two pages of the FDA site, each
 * read whole at most once a day:
 *
 *   the current list   people and firms debarred now (one HTML page with a
 *                      firms table and a persons table). It must load: if it
 *                      does not, or its tables are gone or nearly empty, the
 *                      lookup fails and is reported as failed.
 *   the expired list   people and firms whose debarment has ended. When only
 *                      this page fails, the lookup is answered from the
 *                      current list and marked partial.
 *
 * What a row holds: last name, first and middle names, effective date, term
 * ("Permanent^", "10 years %"), Federal Register date and citation (linked to
 * the notice). Nothing else: no company, no role, no town. So a row can only
 * ever match a person by name, and every hit on a person is held as
 * 'possible' and says "name match only, verify identity". This source never
 * grades a person 'likely' or 'confirmed': the record has no second fact
 * (company, role) to compare with the person. A firm is matched on its whole
 * name with the legal form removed, and graded as a company record ('company'),
 * or 'possible' when that name is a single word.
 *
 * Never read or kept: the page's footnotes (they give the towns of people
 * with namesakes); the rows carry no address, birth date, nationality or ID
 * number. A footnote marker in front of a name is kept only as a flag that
 * the FDA itself warns against confusing that person with a namesake.
 *
 * Name matching is the strict matching of the other watchlist screens
 * (screenRows in debarment.js, built on sanctions.js): first and last name
 * in order, never part of a name, never fuzzily.
 *
 * Terms: a US government page in the public domain; fda.gov's robots.txt
 * allows these paths for every reader except one named crawler.
 */
import { request, htmlToText } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { nameTokens, companyTokens, normalizeName, screenNames } from './sanctions';
import { withAliasHold } from './alias';
import { screenRows, personNameForms } from './debarment';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 6;

const ID = 'fda-debarment';
const LABEL = 'FDA debarment list (people and firms barred from drug applications)';
const FDA = 'https://www.fda.gov';
export const FDA_DEBARMENT_PAGE = `${FDA}/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/fda-debarment-list-drug-product-applications`;
export const FDA_EXPIRED_PAGE = `${FDA}/inspections-compliance-enforcement-and-criminal-investigations/fda-debarment-list-drug-product-applications/fda-expired-debarment-list-drug-product-applications`;

// Fewer people than this on a page means the page is not the whole list (157 current and about 70 expired in November 2026)
const MIN_CURRENT = 50;
const MIN_EXPIRED = 30;

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const plain = (s) => oneLine(htmlToText(String(s ?? '')).replace(/ /g, ' '));
const isFullName = (tokens) => tokens.filter((t) => t.length > 1).length >= 2;
const AKA = /\s*,?\s*\b(?:a\.?k\.?a\.?|a\/k\/a|also known as)\s*/i;

/** "05/15/2024", "2/2/2010", "0  4  /  14  /2021" -> "2024-05-15" ('' when it is not a date). */
export function usDate(s) {
  const m = plain(s).replace(/\s+/g, '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const [, mo, d, y] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return '';
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** "Permanent^*" -> { term: 'Permanent', kind: [...] }, from the page's notations. */
export function readTerm(raw) {
  const text = plain(raw);
  const kind = [];
  if (text.includes('^')) kind.push('mandatory debarment, section 306(a)');
  if (text.includes('%')) kind.push('permissive debarment, section 306(b)');
  if (/\*/.test(text)) kind.push('hearing requested and denied');
  if (text.includes('#')) kind.push('acquiesced to debarment');
  if (text.includes('++')) kind.push('order of debarment withdrawn');
  else if (text.includes('+')) kind.push('special termination of debarment');
  return { term: oneLine(text.replace(/[\^%*#~+]/g, ' ')), kind };
}

// Only links to the Federal Register and the government printing office are kept
const FR_LINK = /^https?:\/\/(?:www\.)?(?:federalregister\.gov|govinfo\.gov|gpo\.gov)\//i;

/** The Federal Register citation of a cell, and its link when it has one. */
function citation(cellHtml) {
  const href = (String(cellHtml).match(/href=["']([^"']+)["']/i) || [])[1] || '';
  return { cite: oneLine(plain(cellHtml).replace(/~/g, ' ')), link: FR_LINK.test(href) ? href.replace(/^http:/i, 'https:') : '' };
}

/**
 * A listed person's name and aliases from the two name cells.
 *   "Garmendia a/k/a Germendia" + "Bernardo"      -> Bernardo Garmendia, alias Bernardo Germendia
 *   "Manookian, a.k.a. Ed Manning" + "Edward"     -> Edward Manookian, alias Ed Manning
 *   "Pai, a.k.a. Lau, Daphne" + "Daphne"          -> Daphne Pai, alias Daphne Lau
 *   "Gonsalves, Jr." + "Wallace"                  -> Wallace Gonsalves
 *   "**Donnelly" + "Mary"                         -> Mary Donnelly, with the FDA's namesake warning flagged
 */
export function listedPerson(lastCell, firstCell) {
  let last = plain(lastCell);
  const warned = /^\*+/.test(last);
  last = last.replace(/^\*+\s*/, '');
  const first = oneLine(plain(firstCell).replace(/\bNMI\b/g, ' ').replace(/\*+/g, ' '));
  const [lastMain, ...akaParts] = last.split(AKA).map(oneLine).filter(Boolean);
  const { name } = personNameForms(`${first} ${lastMain || ''}`);
  const aliases = [];
  for (const part of akaParts) {
    let alias = part;
    // "Lau, Daphne": surname first
    if (/,/.test(alias)) { const [l, f] = alias.split(',').map(oneLine); alias = `${f} ${l}`; }
    // "Germendia": another spelling of the surname
    else if (nameTokens(alias).length === 1) alias = `${first} ${alias}`;
    const form = personNameForms(alias).name;
    if (form && normalizeName(form) !== normalizeName(name)) aliases.push(form);
  }
  return { name, aliases, warned };
}

/* ------------------------------------------------------------------ */
/* Reading a page                                                      */
/* ------------------------------------------------------------------ */

const cellsOf = (rowHtml, tag) => [...String(rowHtml).matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1]);

/** Where each column is, from the table's header row. */
function columns(headers) {
  const h = headers.map((x) => plain(x).toLowerCase());
  const at = (re) => h.findIndex((x) => re.test(x));
  return { last: at(/last name/), first: at(/first/), firm: at(/name of firm/), effective: at(/effective/), term: at(/term/), frDate: at(/fr date/), volume: at(/volume|page/) };
}

const compact = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== '' && v != null && v !== false && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out;
};

/**
 * Build the compact index of one page (the current list or the expired one).
 * Rows: n name, a aliases, t 'person' | 'entity', d effective date, e term,
 * k kind of debarment, f Federal Register date, c citation, u citation link,
 * m later entries (corrections, terminations), w FDA namesake warning, x ended.
 * @param {string} html
 * @param {{ expired?: boolean }} options
 */
export function parseFdaDebarment(html, { expired = false } = {}) {
  const which = expired ? 'expired debarment list' : 'debarment list';
  const tables = [...String(html).matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  let persons = null;
  let firms = null;
  for (const table of tables) {
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
    // The header is the table's <th> row, or (on the expired page) its first row of <td> cells that names the columns
    const headerIndex = rows.findIndex((r) => {
      const cells = cellsOf(r, 'th').length ? cellsOf(r, 'th') : cellsOf(r, 'td');
      return cells.some((c) => /last name|name of firm/i.test(plain(c)));
    });
    if (headerIndex < 0) continue;
    const headerCells = cellsOf(rows[headerIndex], 'th').length ? cellsOf(rows[headerIndex], 'th') : cellsOf(rows[headerIndex], 'td');
    const col = columns(headerCells);
    const body = rows.slice(headerIndex + 1).map((r) => cellsOf(r, 'td')).filter((c) => c.length);
    if (col.last >= 0 && col.first >= 0 && !persons) persons = { col, body };
    else if (col.firm >= 0 && !firms) firms = { col, body };
  }
  if (!persons || !firms) throw new Error(`The FDA ${which} page is not in the expected format`);
  for (const need of ['effective', 'term', 'volume']) {
    if (persons.col[need] < 0 || firms.col[need] < 0) throw new Error(`The FDA ${which} page is not in the expected format`);
  }

  const rows = [];
  const read = (cells, col, person) => {
    const get = (k) => (col[k] >= 0 ? cells[col[k]] || '' : '');
    const { term, kind } = readTerm(get('term'));
    const { cite, link } = citation(get('volume'));
    const nameCell = person ? `${plain(get('last'))}${plain(get('first'))}` : plain(get('firm'));
    // A row with no name continues the row above it: an FR correction or an early termination
    if (!oneLine(nameCell)) {
      const prev = rows[rows.length - 1];
      if (!prev || (person ? prev.t !== 'person' : prev.t !== 'entity')) return;
      const more = [usDate(get('effective')), [term, ...kind].filter(Boolean).join(': '), usDate(get('frDate')), cite].filter(Boolean).join(', ');
      if (more) prev.m = [...(prev.m || []), more].slice(0, 4);
      return;
    }
    if (!person && /^none\b/i.test(nameCell)) return;
    let entry;
    if (person) {
      const p = listedPerson(get('last'), get('first'));
      if (!p.name || nameTokens(p.name).length < 2) return;
      entry = { n: p.name, a: p.aliases, t: 'person', w: p.warned ? 1 : '' };
    } else {
      const n = oneLine(nameCell.replace(/^\*+\s*/, ''));
      if (normalizeName(n).length < 2) return;
      entry = { n, t: 'entity' };
    }
    rows.push(compact({ ...entry, d: usDate(get('effective')), e: term, k: kind, f: usDate(get('frDate')), c: cite, u: link, x: expired ? 1 : '' }));
  };
  for (const cells of firms.body) if (cells.length >= 4) read(cells, firms.col, false);
  for (const cells of persons.body) if (cells.length >= 5) read(cells, persons.col, true);

  const people = rows.filter((r) => r.t === 'person').length;
  if (people < (expired ? MIN_EXPIRED : MIN_CURRENT)) throw new Error(`The FDA ${which} page had too few entries to be the whole list`);
  return { v: 1, key: expired ? 'fda-expired' : 'fda-current', at: new Date().toISOString(), rows };
}

// -> { value, at, fresh }: fresh is false when an older copy stands in for a failed refresh. The loader uses the
// deadline the cache gives it, so one caller's deadline does not cut the shared download short.
const loadPage = (key, url, expired, deadline) => cachedEntry(key, DAY_MS, async ({ deadline: d }) => parseFdaDebarment((await request(url, {
  deadline: d, timeoutMs: 15000, accept: 'text/html', maxBytes: 2 * 1024 * 1024,
})).text, { expired }), { deadline });
const dayOf = (ms) => new Date(Number(ms) || Date.now()).toISOString().slice(0, 10);
const loadCurrent = (deadline) => loadPage('debarment:fda-current:v1', FDA_DEBARMENT_PAGE, false, deadline);
const loadExpired = (deadline) => loadPage('debarment:fda-expired:v1', FDA_EXPIRED_PAGE, true, deadline);

/* ------------------------------------------------------------------ */
/* The source                                                          */
/* ------------------------------------------------------------------ */

const isPersonTask = (task) => task.kind !== 'company';
// The names screened, shared with the other sanctions screens: a company under every known name (the typed name and
// the legal names learned from records tied to the person), a person under their name and its variants.
const searchedNames = (task, ctx) => screenNames(task, ctx);
const canScreen = (task, ctx) => (isPersonTask(task)
  ? searchedNames(task, ctx).some((v) => isFullName(nameTokens(v)))
  : companyTokens(task.value).join('').length >= 3);

const NAME_ONLY = 'matched by name only: the FDA list gives a name, dates and a Federal Register citation, and nothing (no company, no role) to tell namesakes apart';

function finding(task, ctx, { row, matched, via }) {
  const ended = Boolean(row.x);
  const person = row.t === 'person';
  const what = ended ? 'FDA debarment (ended)' : 'FDA debarment';
  const quote = [
    `${person ? 'Person' : 'Firm'}: ${row.n}`,
    matched && matched !== row.n ? `Also listed as: ${matched}` : '',
    row.a?.length && (!matched || matched === row.n) ? `Also known as: ${row.a.join('; ')}` : '',
    row.d ? `Effective: ${row.d}` : '',
    row.e ? `Term: ${row.e}${row.k?.length ? ` (${row.k.join('; ')})` : ''}` : '',
    ended ? 'Listed by the FDA among debarments that have ended' : 'On the FDA\'s list of current debarments',
    row.c ? `Federal Register: ${row.c}${row.f ? `, ${row.f}` : ''}` : '',
    row.m?.length ? `Later entries: ${row.m.join('; ')}` : '',
    row.w ? 'The FDA notes that this person is not to be confused with another person of the same name' : '',
  ].filter(Boolean).join(' | ');
  const base = {
    source: ID, sourceLabel: LABEL, category: 'sanctions', severity: 'high',
    quote,
    url: row.u || (ended ? FDA_EXPIRED_PAGE : FDA_DEBARMENT_PAGE),
    date: row.d || row.f || null,
    data: { list: ended ? 'FDA expired debarment list (drug product applications)' : 'FDA debarment list (drug product applications)', citation: row.c || null, term: row.e || null, ended, listPage: ended ? FDA_EXPIRED_PAGE : FDA_DEBARMENT_PAGE, searched: oneLine(task.value) },
  };
  if (task.kind === 'company') {
    // One word only when the hit came through the bare typed word, not a learned legal name matched whole.
    const oneWord = companyTokens(via || task.value).length < 2;
    return makeFinding(ctx.subject, {
      ...base,
      title: `${what}: ${row.n}${oneWord ? ': name match only, verify identity' : ''}`,
      match: oneWord ? 'possible' : 'company',
      matchReasons: [oneWord ? 'only the company name\'s one distinctive word matches; many unrelated companies share a one-word name' : 'the listed firm name is the same as the company name'],
    });
  }
  // A person: the record has nothing but the name, so it is never more than a name match.
  return makeFinding(ctx.subject, {
    ...base,
    title: `${what}: ${row.n}: name match only, verify identity`,
    match: 'possible',
    matchReasons: [NAME_ONLY],
  });
}

export const fdaDebarmentConnector = {
  id: ID,
  label: LABEL,
  // 'alias': another name of the person, screened like their own name
  kinds: ['subject', 'alias', 'company'],
  prior: 0.2,
  timeoutMs: 20000,
  plan() {
    return [{ template: 'fda.debarment', prior: 0.2, why: 'screen the name against the FDA\'s list of people and firms barred from drug applications' }];
  },
  async run(task, ctx) {
    const name = oneLine(task.value);
    if (!canScreen(task, ctx)) {
      return {
        findings: [], threads: [],
        notes: [`${LABEL}: "${name}" is too short a name to screen`],
        partial: [`${name.slice(0, 40)}: name too short to screen`],
      };
    }
    // The current list must load; the list of ended debarments is a bonus
    const [currentEntry, expiredEntry] = await Promise.allSettled([loadCurrent(ctx.deadline), loadExpired(ctx.deadline)]);
    if (currentEntry.status === 'rejected') throw currentEntry.reason;
    const current = { status: 'fulfilled', value: currentEntry.value.value };
    const expired = expiredEntry.status === 'fulfilled' ? { status: 'fulfilled', value: expiredEntry.value.value } : expiredEntry;
    // A copy older than a day, read because the refresh failed: the note gives its date and the screen is partial
    const staleDates = [currentEntry.value, expiredEntry.status === 'fulfilled' ? expiredEntry.value : null]
      .filter((e) => e && e.fresh === false).map((e) => dayOf(e.at));
    const asOf = staleDates.length ? ` (list as of ${staleDates.sort()[0]})` : '';
    const mode = isPersonTask(task) ? 'person' : 'company';
    const names = searchedNames(task, ctx);
    const hits = [
      ...screenRows(current.value, names, mode),
      ...(expired.status === 'fulfilled' ? screenRows(expired.value, names, mode) : []),
    ];
    const findings = hits.slice(0, MAX_FINDINGS).map((h) => finding(task, ctx, h)).filter(Boolean);
    const notes = [];
    const partial = [];
    if (expired.status === 'rejected') {
      notes.push(`FDA expired debarment list: could not be read, so ${name} was screened only against current FDA debarments, not against debarments that have ended`);
      partial.push('FDA expired debarment list');
    }
    if (asOf) partial.push(`FDA debarment list: list as of ${staleDates.sort()[0]}`);
    if (!hits.length) {
      const firmsListed = current.value.rows.some((r) => r.t === 'entity');
      const scope = expired.status === 'fulfilled' ? 'current or ended FDA debarments' : 'current FDA debarments';
      notes.push(mode === 'company' && !firmsListed
        ? `FDA debarment list: no firm is currently debarred, so there is no match for ${name}${expired.status === 'fulfilled' ? ' (the list of ended debarments was also searched)' : ''}${asOf}`
        : `FDA debarment list: no match for ${name} among ${scope}${asOf}`);
    }
    if (hits.length > MAX_FINDINGS) notes.push(`FDA debarment list: ${hits.length} entries match the name ${name}; the first ${MAX_FINDINGS} are shown`);
    if (findings.length && mode === 'person') notes.push(`FDA debarment list: the list gives only names, dates and Federal Register citations, so a match on ${name} is a name match until the Federal Register notice shows it is the same person`);
    return { findings, threads: [], notes, ...(partial.length ? { partial } : {}) };
  },
};

// A record found only under another name of the person the user did not type is 'likely' at most (alias.js).
fdaDebarmentConnector.run = withAliasHold(fdaDebarmentConnector.run);
