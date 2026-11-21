/**
 * Breach notices companies filed with four more US state Attorneys General.
 * COMPANY level only: a notice says that an organisation reported a breach,
 * when, how many residents it affected and which kinds of data were involved.
 * No person is ever searched here, and no notice letter (PDF) is ever opened.
 *
 * One source per state, so a state that cannot be read is reported as failed
 * on its own and the others still count:
 *   breach-registers-delaware  the Delaware Attorney General's breach list on
 *                              the state open-data portal (data.delaware.gov),
 *                              read whole once a day (about 500 notices).
 *   breach-registers-vermont   the Vermont Attorney General's notices: the
 *                              current table (from April 2026, read once a
 *                              day) and the archived notice pages (2022 to
 *                              April 2026, about fifty listing pages, read
 *                              slowly once a week).
 *   breach-registers-maryland  the Maryland Attorney General's yearly lists
 *                              (2022 to March 2025; the office publishes no
 *                              later list and the 2020 and 2021 lists are no
 *                              longer online), read once a day.
 *   breach-registers-indiana   the Indiana Attorney General's year-to-date
 *                              reports (PDF tables). Only the newest three
 *                              years are read: earlier reports use other
 *                              layouts (rotated pages, names with the spaces
 *                              removed) that cannot be read reliably.
 *
 * Matching follows the regulator registers in exposure.js: every row is
 * re-checked against the normalised company name (matchOrgName), under each
 * name the check knows for the company (the name given and the legal names
 * learned from other records). A record is the company's ("company") when it
 * names a learned legal name, or the company's exact name when that name is
 * not one ordinary word. A match on an ordinary word alone, or one that adds
 * a general word ("Summit Financial Group" for Summit), is a possible
 * namesake: "possible", kept off the timeline, with a "verify" reason. No
 * record here is ever graded about the person, and nothing is "confirmed".
 *
 * Kept: organisation, organisation type, dates, counts, data-class labels
 * (health and other protected kinds shown only as "Sensitive personal
 * details"), the case number and the official link. A list that does not
 * load, comes back empty or has changed shape throws, so the lookup is
 * reported as failed and never as "no match".
 */
import { getJson, getText, getBytes, htmlToText } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry, isCutShort } from '../cache';
import { isSensitive, mentionsMinor } from '../guardrails';
import { isOrdinaryWordCompany, companyKeys } from '../names';
import { companyKey, matchOrgName, orgTokens } from './exposure';
// The library's own file: its package entry point runs a self-test when it is loaded without a parent module
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const switchedOff = (id) => String(process.env.FOUNDER_SOURCES_OFF || '').split(',').map((x) => x.trim()).filter(Boolean).includes(id);
const OFF_REASON = 'This source is not enabled on this deployment.';

const CATEGORY = 'exposure';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_PER_SOURCE = 8;
const TIMEOUT_MS = 12000;
const NO_ENTRY = 'A company with no entry may still have had a breach.';

/* ------------------------------------------------------------------ */
/* Text, dates and numbers                                             */
/* ------------------------------------------------------------------ */

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const plain = (s) => oneLine(htmlToText(String(s ?? '')));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const validIso = (y, m, d) => (y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
/** "2026-11-10T00:00:00.000" -> "2026-11-10"; the 1971 placeholder some rows carry is refused. */
const isoDay = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim()); return m ? validIso(+m[1], +m[2], +m[3]) : null; };
/** US order with any separator and a two- or four-digit year: "3/1/25", "10/28/2026", "8-13--2026". */
const usDay = (s) => {
  const m = /(\d{1,2})\s*[/-]+\s*(\d{1,2})\s*[/-]+\s*(\d{4}|\d{2})(?!\d)/.exec(String(s || ''));
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return validIso(y, +m[1], +m[2]);
};
const longDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : ''; };
/** 2520 or "10,683" -> "10,683"; '' when it is not a positive whole number. */
const count = (n) => {
  const s = String(n ?? '').replace(/&nbsp;|[,\s ]/g, '');
  if (!/^\d{1,12}$/.test(s) || Number(s) <= 0) return '';
  return Number(s).toLocaleString('en-US');
};
const field = (label, value) => { const v = oneLine(value); return v ? `${label}: ${v}${/[.!?]$/.test(v) ? '' : '.'}` : ''; };
const newestFirst = (a, b) => String(b.reported || '').localeCompare(String(a.reported || ''));
const copyDate = (at) => longDate(new Date(at).toISOString().slice(0, 10));

/** Data-class labels that name a protected matter (as exposure.js): shown only as one general label. */
const PROTECTED_CLASS = /sexual|hiv|health|medical|med(?:treatment|history|diagnosis)|diagnos|treatment|mental|physical condition|religio|disabilit|ethnic|\braces?\b|politic|drug|citizenship|nationalit|immigra|family|parenting|spouse|deceased|biometric|insur/i;
/** The kinds of data a notice lists, as general labels; never the data. Order is the order shown. */
const DATA_CLASSES = [
  [/\bssn\b|social security/i, 'Social Security numbers'],
  [/driver'?s?\s*licen[cs]e|driverlicense/i, "Driver's license numbers"],
  [/passport|fed\s*id\b|federal identification|government id|state id|identification card|national identification|\bid card/i, 'Government ID numbers'],
  [/taxpayer|tax\s*id|\bitin\b/i, 'Taxpayer ID numbers'],
  [/credit|debit|card number|security code|access code/i, 'Payment card details'],
  [/account number|financial account|fininfo|financial information|bank|routing/i, 'Financial account details'],
  [/user\s*name|password|security question|online\s*acct|online account|login|credential/i, 'Online account sign-in details'],
  [/birth|\bdob\b/i, 'Dates of birth'],
  [/(?<!user)\bnames?\b/i, 'Names'],
  [/(?<!e-?mail\s)\baddress/i, 'Addresses'],
  [/phone/i, 'Phone numbers'],
];
/** "SSN, MedTreatment, HealthID" -> ["Social Security numbers", "Sensitive personal details"]. */
export function dataClassLabels(text) {
  const t = oneLine(plain(text));
  if (!t) return [];
  const out = DATA_CLASSES.filter(([re]) => re.test(t)).map(([, label]) => label);
  if (PROTECTED_CLASS.test(t) || isSensitive(t)) out.push('Sensitive personal details');
  if (!out.length) out.push('Other personal information');
  return [...new Set(out)];
}
/** A short sentence the register wrote ("how the breach occurred"), or '' when it touches a protected matter or a child. */
const publishable = (text, max = 200) => {
  const t = plain(text);
  return t && t.length <= max && !isSensitive(t) && !mentionsMinor(t) && !PROTECTED_CLASS.test(t) ? t : '';
};

/* ------------------------------------------------------------------ */
/* The company and how a row matches it (the rules of exposure.js)     */
/* ------------------------------------------------------------------ */

const isDomain = (v) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(v || ''));
const dropThe = (tokens) => (tokens.length > 1 && tokens[0] === 'the' ? tokens.slice(1) : tokens);
const containsRun = (tokens, want) => {
  if (!want.length) return false;
  for (let i = 0; i + want.length <= tokens.length; i += 1) if (want.every((t, j) => tokens[i + j] === t)) return true;
  return false;
};
const RANK = { legal: 0, exact: 1, padded: 2, leading: 3, contains: 4 };
const tooGeneralNote = (name) => `Breach notices were not searched for "${oneLine(name)}": the name is too short or too general to match reliably.`;

/** Every name the check knows for this company other than the one given: learned legal names, never a domain. */
function knownNamesOf(key, ctx) {
  const of = companyKeys(key.name)[0] || key.name.toLowerCase();
  const subject = ctx?.subject;
  const out = [];
  for (const a of subject?.anchors?.aliases?.values?.() || []) {
    if (a?.of !== of || isDomain(a.value)) continue;
    if (typeof subject?.hasName === 'function' && subject.hasName(a.value)) continue;
    const k = companyKey(a.value);
    if (k.full.length && !out.some((x) => x.name === k.name)) out.push(k);
  }
  return out;
}

/**
 * What a task asks for, or why it is not run.
 * @returns {{ key: object, names: object[] } | { skip: true, note?: string }}
 */
export function targetOf(task, ctx) {
  const value = oneLine(task?.value);
  if (!value || task?.kind !== 'company') return { skip: true };
  // Breach registers are never searched for a person, even when a person's name arrives as a "company"
  if (typeof ctx?.subject?.hasName === 'function' && ctx.subject.hasName(value)) return { skip: true };
  const key = companyKey(value);
  if (!key.full.length || !key.specific || key.core.join('').length < 3) return { skip: true, note: tooGeneralNote(value) };
  return { key, names: knownNamesOf(key, ctx) };
}

/** Is the company named distinctively enough for its exact name alone to stand for it? */
const distinctive = (key) => key.specific && (key.full.length >= 2 || !isOrdinaryWordCompany(key.full.join(' ')));

/**
 * How a register's organisation name matches the company, under each of its known names.
 * @returns {null | { grade: string, match: 'company'|'possible', severity: string, matchReasons: string[], extra: object }}
 */
export function gradeOrganisation(target, recordName) {
  const tokens = dropThe(orgTokens(recordName));
  if (!tokens.length) return null;
  // A learned legal name of two words or more written whole in the entry is the company ("Uber Technologies, Inc.")
  const legal = target.names.find((k) => k.full.length >= 2 && containsRun(tokens, k.full));
  if (legal) {
    return { grade: 'legal', match: 'company', severity: 'medium', extra: {}, matchReasons: [`the organisation's name contains ${legal.name}, a name of ${target.key.name} found in other records`] };
  }
  let best = null;
  for (const key of [target.key, ...target.names]) {
    const grade = matchOrgName(key, recordName);
    if (grade && (!best || RANK[grade] < RANK[best.grade])) best = { grade, key };
  }
  if (!best) return null;
  const reason = {
    exact: `the organisation's name matches ${best.key.name}`,
    padded: `the organisation's name is ${best.key.name} followed by general words`,
    leading: `the entry begins with the name ${best.key.name}`,
    contains: `the entry names ${best.key.name}`,
  }[best.grade];
  if (best.grade !== 'padded' && distinctive(best.key)) return { grade: best.grade, match: 'company', severity: 'medium', extra: {}, matchReasons: [reason] };
  const why = best.grade === 'padded'
    ? `the name adds a general word to ${best.key.name}, so it may be another company: verify it is the same company before relying on it`
    : `"${best.key.name}" is an ordinary word other organisations also use, so it may be another company: verify it is the same company before relying on it`;
  return { grade: best.grade, match: 'possible', severity: 'low', extra: { excludeFromTimeline: true, companyNamesake: true }, matchReasons: [reason, why] };
}

/* ------------------------------------------------------------------ */
/* Notices -> findings                                                 */
/* ------------------------------------------------------------------ */

/**
 * The notices of one register that match the company, as findings. Notices that share one link (a register
 * with no page per notice) are reported together as one record: two records with one link would be taken
 * for duplicates.
 * @param {object} reg { id, label, office, residents }
 * @param {Array<{ organisation, reported, breachDates?, affected?, total?, classes?, orgType?, cause?, caseNumber?, url }>} rows
 */
export function noticeFindings(reg, target, ctx, rows) {
  const matched = [];
  for (const row of rows) {
    const organisation = oneLine(row.organisation);
    const g = organisation ? gradeOrganisation(target, organisation) : null;
    if (g) matched.push({ ...row, organisation, g });
  }
  const groups = new Map();
  for (const n of matched) {
    if (!groups.has(n.url)) groups.set(n.url, []);
    groups.get(n.url).push(n);
  }
  const quoteOf = (n) => [
    field('Organization', n.organisation), field('Type', n.orgType), field('Reported', longDate(n.reported)),
    field('Date of breach', n.breachDates), field(`${reg.residents} affected`, n.affected), field('Total affected', n.total),
    field('Kinds of data', (n.classes || []).join(', ')), field('How it happened', n.cause),
  ].filter(Boolean).join(' ');
  const out = [];
  for (const [url, list] of groups) {
    list.sort(newestFirst);
    const best = list.slice().sort((a, b) => RANK[a.g.grade] - RANK[b.g.grade] || newestFirst(a, b))[0];
    const latest = list[0].reported || null;
    const data = {
      register: reg.office, organisation: best.organisation, reported: latest, nameMatch: best.g.grade, ...best.g.extra,
      ...(list.length === 1
        ? { breachDates: best.breachDates || null, affected: best.affected || null, totalAffected: best.total || null, dataClasses: best.classes || [], organisationType: best.orgType || null, ...(best.caseNumber ? { caseNumber: best.caseNumber } : {}) }
        : { notices: list.slice(0, MAX_PER_SOURCE).map((n) => ({ organisation: n.organisation, reported: n.reported || null, breachDates: n.breachDates || null, affected: n.affected || null, totalAffected: n.total || null, dataClasses: n.classes || [], ...(n.caseNumber ? { caseNumber: n.caseNumber } : {}) })) }),
    };
    const title = list.length === 1
      ? `${best.organisation}: data breach notice filed with the ${reg.office}${latest ? `, reported ${longDate(latest)}` : ''}${best.affected ? ` (${best.affected} ${best.affected === '1' ? reg.residents.replace(/s$/, '') : reg.residents} affected)` : ''}`
      : `${best.organisation}: ${list.length} data breach notices filed with the ${reg.office}${latest ? `, most recently reported ${longDate(latest)}` : ''}`;
    const finding = makeFinding(ctx.subject, {
      source: reg.id, sourceLabel: reg.label, category: CATEGORY, title,
      quote: list.slice(0, 4).map(quoteOf).join(' '),
      url, date: latest, severity: best.g.severity, match: best.g.match, matchReasons: best.g.matchReasons, data,
    });
    if (finding) out.push({ finding, rank: RANK[best.g.grade], reported: latest });
  }
  return out
    .sort((a, b) => a.rank - b.rank || newestFirst(a, b))
    .slice(0, MAX_PER_SOURCE)
    .sort(newestFirst)
    .map((x) => x.finding);
}

/** The plain-words line every lookup ends with: what was searched and what it found. */
function searchedNote(reg, target, { notices, span, findings, asOf }) {
  const names = [target.key.name, ...target.names.map((k) => k.name)].filter((n, i, all) => all.indexOf(n) === i);
  const what = `${reg.office} breach notices (${notices.toLocaleString('en-US')} notices${span ? `, ${span}` : ''}${asOf ? `; copy of ${asOf}` : ''})`;
  if (findings) return `${what} were searched for ${names.join(' or ')}: ${findings === 1 ? 'one record names' : `${findings} records name`} it. ${NO_ENTRY}`;
  return `${what} were searched for ${names.join(' or ')}: none names it. ${NO_ENTRY}`;
}

/** A whole list through the cache, with the date of the copy. The loader gets the cache's own deadline. */
async function loadList(key, ttlMs, loader, deadline, options = {}) {
  const entry = await cachedEntry(key, ttlMs, ({ deadline: d }) => loader(d), { deadline, ...options });
  return { value: entry.value, at: entry.at, fresh: entry.fresh !== false };
}

const spanOf = (rows) => {
  const days = rows.map((r) => r.reported).filter(Boolean).sort();
  return days.length ? `${longDate(days[0])} to ${longDate(days[days.length - 1])}` : '';
};

/* ------------------------------------------------------------------ */
/* Delaware                                                            */
/* ------------------------------------------------------------------ */

const DE = {
  id: 'breach-registers-delaware',
  label: 'Delaware Attorney General data breach notices (data.delaware.gov)',
  office: 'Delaware Attorney General', residents: 'Delaware residents',
};
const DE_RESOURCE = 'https://data.delaware.gov/resource/dir6-wx8v.json';
const DE_PAGE = 'https://data.delaware.gov/d/dir6-wx8v';
const DE_LIMIT = 20000;
const DE_MIN_ROWS = 100; // 478 notices in November 2026; far fewer means the list changed
const DE_CACHE_KEY = 'breach-more:delaware:v1';

/** The Delaware list as a compact index. Throws on a list that is empty, too short or of another shape. */
export function compactDelaware(rows) {
  if (!Array.isArray(rows)) throw new Error('The Delaware breach list returned an unexpected response');
  if (rows.length < DE_MIN_ROWS) throw new Error(`The Delaware breach list returned only ${rows.length} notices`);
  const out = [];
  for (const r of rows) {
    const organisation = oneLine(r?.company_name);
    if (!organisation) continue;
    const link = String(r?.sample_of_notice?.url || '');
    out.push({
      o: organisation.slice(0, 160),
      r: isoDay(r.date_of_notice),
      b: isoDay(r.date_of_breach),
      a: count(r.de_residents_affected),
      t: count(r.total_affected),
      c: dataClassLabels(r.information_breached),
      u: /^https:\/\/attorneygeneral\.delaware\.gov\/[^\s"'<>]+\.pdf$/i.test(link) ? link : '',
    });
  }
  if (out.length < rows.length / 2) throw new Error('The Delaware breach list has changed shape: most rows have no company name');
  return out;
}

async function loadDelaware(deadline) {
  const select = 'company_name,date_of_breach,date_of_notice,de_residents_affected,total_affected,information_breached,sample_of_notice';
  const url = `${DE_RESOURCE}?$select=${select}&$order=${encodeURIComponent('date_of_notice DESC')}&$limit=${DE_LIMIT}`;
  return compactDelaware(await getJson(url, { deadline, timeoutMs: 20000, maxBytes: 6 * 1024 * 1024 }));
}

export const delawareBreachNoticesConnector = {
  id: DE.id,
  label: 'Delaware Attorney General breach notices',
  kinds: ['company'],
  prior: 0.25,
  timeoutMs: TIMEOUT_MS,
  enabled: () => !switchedOff(DE.id),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const target = targetOf(task, ctx);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    const list = await loadList(DE_CACHE_KEY, DAY_MS, loadDelaware, ctx.deadline);
    const rows = list.value.map((x) => ({
      organisation: x.o, reported: x.r, breachDates: longDate(x.b), affected: x.a, total: x.t, classes: x.c, url: x.u || DE_PAGE,
    }));
    const findings = noticeFindings(DE, target, ctx, rows);
    const asOf = list.fresh ? '' : copyDate(list.at);
    const out = { findings, threads: [], notes: [searchedNote(DE, target, { notices: rows.length, span: spanOf(rows), findings: findings.length, asOf })] };
    if (asOf) out.partial = [`Delaware breach notices: list as of ${asOf}`];
    return out;
  },
};

/* ------------------------------------------------------------------ */
/* Vermont                                                             */
/* ------------------------------------------------------------------ */

const VT = {
  id: 'breach-registers-vermont',
  label: 'Vermont Attorney General security breach notices (ago.vermont.gov)',
  office: 'Vermont Attorney General', residents: 'Vermont residents',
};
const VT_BASE = 'https://ago.vermont.gov';
const VT_PAGE = `${VT_BASE}/categories/security-breach-notices`;
const VT_CURRENT_KEY = 'breach-more:vermont-current:v1';
const VT_ARCHIVE_KEY = 'breach-more:vermont-archive:v1';
let VT_MAX_PAGES = 80;
let VT_PAGE_GAP_MS = 1000;
/** For tests: how many archived listing pages to read at most, and the pause between them. */
export function __setVermontArchiveForTests({ maxPages = 80, gapMs = 1000 } = {}) { VT_MAX_PAGES = maxPages; VT_PAGE_GAP_MS = gapMs; }
const VT_ARCHIVE_LOAD_MS = 180000;

/** The current table on the notices page: [{ o, r, k (type), a, c }]. Throws when the table is missing or empty. */
export function parseVermontTable(html) {
  const tables = String(html || '').match(/<table\b[\s\S]*?<\/table>/gi) || [];
  const table = tables.find((t) => /Reporting Organization Name/i.test(t) && /Date Reported/i.test(t));
  if (!table) throw new Error('The Vermont breach notices page has changed: its table was not found');
  const out = [];
  for (const row of table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => plain(m[1]));
    if (cells.length < 5) continue;
    const [date, organisation, type, affected, categories] = cells;
    if (!organisation) continue;
    out.push({ o: organisation.slice(0, 160), r: usDay(date), k: type.slice(0, 40), a: count(affected), c: dataClassLabels(categories) });
  }
  if (!out.length) throw new Error('The Vermont breach notices table is empty');
  if (out.filter((r) => r.r).length < out.length / 2) throw new Error('The Vermont breach notices table has changed: most rows have no date');
  return out;
}

/** "2022-09-30-University-of-Southern-California-Data-Breach-Notice-to-Consumers" -> { r, o }. */
export function vermontArchiveTitle(title) {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[\s-]+(.+)$/.exec(plain(title));
  if (!m) return null;
  let rest = m[4];
  if (!/\s/.test(rest.trim())) rest = rest.replace(/-/g, ' ');
  rest = rest
    .replace(/\s*\.pdf\s*$/i, '')
    .replace(/[\s,-]*(?:supplemental[\s-]+)?(?:dat[ae]|data)[\s-]+br(?:e)?ach[\s-]+notice\b.*$/i, '')
    .replace(/[\s,-]*notice[\s-]+(?:of[\s-]+)?(?:data|security)[\s-]+(?:breach|incident|event)\b.*$/i, '');
  const organisation = oneLine(rest).replace(/[\s,;:-]+$/, '');
  return organisation ? { r: validIso(+m[1], +m[2], +m[3]), o: organisation.slice(0, 160) } : null;
}

/** The archived notice links on one listing page: [{ o, r, s (slug) }] and the last page number. */
export function parseVermontArchivePage(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<h2\b[^>]*>\s*<a\s+href="\/document\/([a-z0-9-]{5,200})"[^>]*>\s*(?:<span>)?([\s\S]*?)(?:<\/span>)?\s*<\/a>/gi)) {
    const t = vermontArchiveTitle(m[2]);
    if (t) out.push({ ...t, s: m[1] });
  }
  const pages = [...String(html || '').matchAll(/href="\?page=(\d{1,3})"/g)].map((m) => Number(m[1]));
  return { notices: out, last: pages.length ? Math.max(...pages) : 0 };
}

async function loadVermontCurrent(deadline) {
  return parseVermontTable(await getText(VT_PAGE, { deadline, timeoutMs: 20000, accept: 'text/html', maxBytes: 4 * 1024 * 1024 }));
}

/** The archived listing pages, read one after another with a pause between them. */
async function loadVermontArchive(deadline) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const first = parseVermontArchivePage(await getText(`${VT_PAGE}?page=0`, { deadline, timeoutMs: 20000, accept: 'text/html', maxBytes: 4 * 1024 * 1024 }));
  if (!first.notices.length) throw new Error('The Vermont archived notices could not be read: the listing has changed');
  const last = Math.min(first.last, VT_MAX_PAGES - 1);
  const all = first.notices.slice();
  for (let page = 1; page <= last; page += 1) {
    await pause(VT_PAGE_GAP_MS);
    const { notices } = parseVermontArchivePage(await getText(`${VT_PAGE}?page=${page}`, { deadline, timeoutMs: 20000, accept: 'text/html', maxBytes: 4 * 1024 * 1024 }));
    if (!notices.length) throw new Error(`The Vermont archived notices could not be read: listing page ${page + 1} has no notices`);
    all.push(...notices);
  }
  return { notices: all, pages: last + 1, more: first.last > last };
}

export const vermontBreachNoticesConnector = {
  id: VT.id,
  label: 'Vermont Attorney General breach notices',
  kinds: ['company'],
  prior: 0.25,
  timeoutMs: TIMEOUT_MS,
  enabled: () => !switchedOff(VT.id),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const target = targetOf(task, ctx);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    const notes = [];
    const partial = [];
    // The current table must be read; without it the lookup has failed
    const current = await loadList(VT_CURRENT_KEY, DAY_MS, loadVermontCurrent, ctx.deadline);
    if (!current.fresh) partial.push(`Vermont current notices: list as of ${copyDate(current.at)}`);
    const rows = current.value.map((x) => ({ organisation: x.o, reported: x.r, orgType: x.k, affected: x.a, classes: x.c, url: VT_PAGE }));
    // The archived pages are read slowly once a week; a check that cannot wait for them says so
    try {
      const archive = await loadList(VT_ARCHIVE_KEY, WEEK_MS, loadVermontArchive, ctx.deadline, { loadMs: VT_ARCHIVE_LOAD_MS, maxStaleMs: 5 * WEEK_MS });
      for (const x of archive.value.notices) rows.push({ organisation: x.o, reported: x.r, url: `${VT_BASE}/document/${x.s}` });
      if (!archive.fresh) partial.push(`Vermont archived notices: list as of ${copyDate(archive.at)}`);
      if (archive.value.more) notes.push(`Only the first ${archive.value.pages} listing page${archive.value.pages === 1 ? '' : 's'} of Vermont's archived notices ${archive.value.pages === 1 ? 'was' : 'were'} read; older notices were not searched.`);
    } catch (error) {
      const why = isCutShort(error) ? 'were still being read' : 'could not be read';
      notes.push(`Vermont's archived breach notices (2022 to April 2026) ${why}, so only the notices from April 2026 on were searched.`);
      partial.push('Vermont archived notices (2022 to April 2026) not searched');
    }
    const findings = noticeFindings(VT, target, ctx, rows);
    notes.unshift(searchedNote(VT, target, { notices: rows.length, span: spanOf(rows), findings: findings.length }));
    return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ */
/* Maryland                                                            */
/* ------------------------------------------------------------------ */

const MD = {
  id: 'breach-registers-maryland',
  label: 'Maryland Attorney General security breach notices (oag.maryland.gov)',
  office: 'Maryland Attorney General', residents: 'Maryland residents',
};
const MD_PAGE = 'https://oag.maryland.gov/resources-info/Pages/security-breach-notices.aspx';
/** The yearly lists still online (checked 2026-11-20): the office publishes none after March 2025. */
const MD_YEARS = [2025, 2024, 2023, 2022];
const MD_FIELDS = 'Title,Date_x0020_Received,Case_x0020_No_x002e_,No_x0020_of_x0020_Maryland_x0020,Information_x0020_Breached,How_x0020_Breach_x0020_Occurred';
const mdListUrl = (year) => `https://oag.maryland.gov/resources-info/_api/web/lists/getbytitle('Security-Breach-Notices-${year}')/items?$top=5000&$select=${MD_FIELDS}`;

/** One year's list as a compact index. Throws when it is empty or of another shape. */
export function compactMaryland(body, year) {
  const rows = body && Array.isArray(body.value) ? body.value : null;
  if (!rows) throw new Error(`The Maryland breach list for ${year} returned an unexpected response`);
  if (!rows.length) throw new Error(`The Maryland breach list for ${year} is empty`);
  const out = [];
  for (const r of rows) {
    const organisation = oneLine(r?.Title);
    if (!organisation) continue;
    const caseNo = oneLine(r.Case_x0020_No_x002e_).replace(/\.pdf$/i, '');
    out.push({
      o: organisation.slice(0, 160),
      r: usDay(r.Date_x0020_Received),
      a: count(r.No_x0020_of_x0020_Maryland_x0020),
      c: dataClassLabels(r.Information_x0020_Breached),
      h: publishable(r.How_x0020_Breach_x0020_Occurred),
      n: /^[A-Z]{2,5}-\d{3,9}$/i.test(caseNo) ? caseNo : '',
    });
  }
  if (out.length < rows.length / 2) throw new Error(`The Maryland breach list for ${year} has changed shape`);
  return out;
}

export const marylandBreachNoticesConnector = {
  id: MD.id,
  label: 'Maryland Attorney General breach notices',
  kinds: ['company'],
  prior: 0.2,
  timeoutMs: TIMEOUT_MS,
  enabled: () => !switchedOff(MD.id),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const target = targetOf(task, ctx);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    const settled = await Promise.allSettled(MD_YEARS.map((year) => loadList(`breach-more:maryland-${year}:v1`, DAY_MS, async (d) => compactMaryland(await getJson(mdListUrl(year), {
      deadline: d, timeoutMs: 20000, accept: 'application/json;odata=nometadata', maxBytes: 4 * 1024 * 1024,
    }), year), ctx.deadline)));
    const failed = MD_YEARS.filter((y, i) => settled[i].status === 'rejected');
    if (failed.length === MD_YEARS.length) {
      throw new Error(`The Maryland breach lists could not be read (${String(settled[0].reason?.message || settled[0].reason).slice(0, 100)})`);
    }
    const rows = [];
    const partial = [];
    settled.forEach((s, i) => {
      if (s.status !== 'fulfilled') return;
      if (!s.value.fresh) partial.push(`Maryland ${MD_YEARS[i]} notices: list as of ${copyDate(s.value.at)}`);
      for (const x of s.value.value) rows.push({ organisation: x.o, reported: x.r, affected: x.a, classes: x.c, cause: x.h, caseNumber: x.n, url: MD_PAGE });
    });
    const findings = noticeFindings(MD, target, ctx, rows);
    const notes = [
      searchedNote(MD, target, { notices: rows.length, span: spanOf(rows), findings: findings.length }),
      'Maryland publishes no breach notices after March 2025, so later breaches are not covered by this list.',
    ];
    if (failed.length) {
      notes.push(`The Maryland lists for ${failed.join(', ')} could not be read, so ${failed.length === 1 ? 'that year was' : 'those years were'} not searched.`);
      partial.push(`Maryland notices for ${failed.join(', ')} not searched`);
    }
    return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ */
/* Indiana                                                             */
/* ------------------------------------------------------------------ */

const IN = {
  id: 'breach-registers-indiana',
  label: 'Indiana Attorney General data breach reports (in.gov)',
  office: 'Indiana Attorney General', residents: 'Indiana residents',
};
const IN_HOST = 'https://www.in.gov';
const IN_PAGE = `${IN_HOST}/attorneygeneral/consumer-protection-division/id-theft-prevention/security-breaches/`;
const IN_YEARS_READ = 3;
const IN_LIST_KEY = 'breach-more:indiana-reports:v1';

/** The yearly report links on the Indiana page: [{ year, url }], newest first. Throws when none is found. */
export function parseIndianaReports(html) {
  const out = new Map();
  for (const m of String(html || '').matchAll(/<a\b[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const year = Number((/^\s*((?:19|20)\d{2})\s*$/.exec(plain(m[2])) || [])[1]);
    if (!year) continue;
    const href = m[1].replace(/&amp;/g, '&');
    const url = href.startsWith('/attorneygeneral/') ? `${IN_HOST}${href}` : /^https:\/\/www\.in\.gov\/attorneygeneral\//i.test(href) ? href : '';
    if (url && !out.has(year)) out.set(year, url);
  }
  const reports = [...out].map(([year, url]) => ({ year, url })).sort((a, b) => b.year - a.year);
  if (!reports.length) throw new Error('The Indiana breach reports page has changed: no yearly report was found');
  return reports;
}

/** The text items of a PDF, page by page: [[{ s, x, y }]]. */
export async function pdfItems(bytes) {
  const pages = [];
  // a copy with a buffer of its own: a small Buffer is a view into a shared pool, which the PDF reader would misread
  await pdfParse(new Uint8Array(bytes), {
    pagerender: async (page) => {
      const content = await page.getTextContent();
      pages.push(content.items.map((i) => ({ s: String(i.str || ''), x: Number(i.transform?.[4]) || 0, y: Number(i.transform?.[5]) || 0 })).filter((i) => i.s.trim()));
      return '';
    },
  });
  return pages;
}

const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const DIGITS_RE = /^\d[\d,]*$/;

/**
 * The rows of one Indiana year-to-date report, from the PDF's text items. Columns are found from the
 * header ("Matter: Name | Notific Sent | Breach Occ | IN Affected | Total Affected") by position, so the
 * two counts are never confused. Throws when the header is not found (a report in another layout).
 * @returns {Array<{ o, r, b, a, t }>}
 */
export function parseIndianaReport(pages) {
  const out = [];
  let withHeader = 0;
  for (const items of pages || []) {
    // lines: items within 3 points of height of one another (a cell is sometimes set a point higher)
    const sorted = items.slice().sort((p, q) => q.y - p.y || p.x - q.x);
    const lines = [];
    for (const it of sorted) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line.y - it.y) <= 3) line.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    const headerAt = lines.findIndex((l) => {
      const t = l.items.map((i) => i.s).join(' | ');
      return /Notific|Date of Notification/i.test(t) && /Breach Occ|Date of the Breach/i.test(t) && /IN Affected/i.test(t) && /Total Affected/i.test(t);
    });
    if (headerAt < 0) continue;
    withHeader += 1;
    const header = lines[headerAt].items;
    const colX = (re) => (header.find((i) => re.test(i.s)) || {}).x;
    const notice = colX(/Notific|Date of Notification/i);
    const breach = colX(/Breach Occ|Date of the Breach/i);
    const inX = colX(/IN Affected/i);
    const total = colX(/Total Affected/i);
    if (![notice, breach, inX, total].every(Number.isFinite) || !(notice < breach && breach < inX && inX < total)) continue;
    let numbered = false;
    for (const line of lines.slice(headerAt + 1)) {
      const cells = line.items.slice().sort((p, q) => p.x - q.x);
      const row = { name: [], r: null, b: null, a: '', t: '', no: false };
      cells.forEach((c, i) => {
        const s = oneLine(c.s);
        if (DATE_RE.test(s) && c.x >= notice - 40) {
          if (c.x < breach - 10) row.r = usDay(s); else if (c.x < inX) row.b = usDay(s);
        } else if (DIGITS_RE.test(s) && c.x >= inX - 30) {
          if (c.x < total) row.a = count(s); else row.t = count(s);
        } else if (c.x < notice - 30) {
          // a row number: digits first on the line, with the name after it
          if (i === 0 && /^\d{1,5}$/.test(s) && cells.length > 1 && cells[1].x < notice - 30) { row.no = true; numbered = true; } else row.name.push(s);
        }
      });
      const name = oneLine(row.name.join(' '));
      if (!name || /^\d+ of \d+$/.test(name)) continue;
      const bare = !row.no && !row.r && !row.b && !row.a && !row.t;
      // a long name set on two lines: the second line carries no row number and nothing else
      if (bare && numbered && out.length) { out[out.length - 1].o = oneLine(`${out[out.length - 1].o} ${name}`).slice(0, 160); continue; }
      out.push({ o: name.slice(0, 160), r: row.r, b: row.b, a: row.a, t: row.t });
    }
  }
  if (!withHeader) throw new Error('An Indiana breach report is in a layout that cannot be read (no table header was found)');
  if (!out.length) throw new Error('An Indiana breach report has no rows');
  if (out.filter((r) => r.r || r.b).length < out.length / 2) throw new Error('An Indiana breach report has changed: most rows have no dates');
  return out;
}

async function loadIndianaReport(url, deadline) {
  const bytes = await getBytes(url, { deadline, timeoutMs: 25000, maxBytes: 6 * 1024 * 1024, accept: 'application/pdf' });
  return parseIndianaReport(await pdfItems(bytes));
}

export const indianaBreachNoticesConnector = {
  id: IN.id,
  label: 'Indiana Attorney General breach reports',
  kinds: ['company'],
  prior: 0.2,
  timeoutMs: TIMEOUT_MS,
  enabled: () => !switchedOff(IN.id),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const target = targetOf(task, ctx);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    const listing = await loadList(IN_LIST_KEY, DAY_MS, async (d) => parseIndianaReports(await getText(IN_PAGE, { deadline: d, timeoutMs: 15000, accept: 'text/html' })), ctx.deadline);
    const reports = listing.value.slice(0, IN_YEARS_READ);
    const newest = reports[0].year;
    // the current year's report grows through the year; past years' reports are final
    const settled = await Promise.allSettled(reports.map((rep) => loadList(
      `breach-more:indiana-${rep.year}:${rep.url.split('/').pop().slice(0, 60)}:v1`,
      rep.year === newest ? DAY_MS : 30 * DAY_MS,
      (d) => loadIndianaReport(rep.url, d), ctx.deadline,
      rep.year === newest ? { loadMs: 60000 } : { loadMs: 60000, maxStaleMs: 90 * DAY_MS },
    )));
    const failed = reports.filter((r, i) => settled[i].status === 'rejected');
    if (failed.length === reports.length) {
      throw new Error(`The Indiana breach reports could not be read (${String(settled[0].reason?.message || settled[0].reason).slice(0, 100)})`);
    }
    const rows = [];
    const partial = [];
    settled.forEach((s, i) => {
      if (s.status !== 'fulfilled') return;
      const rep = reports[i];
      if (!s.value.fresh) partial.push(`Indiana ${rep.year} report: copy of ${copyDate(s.value.at)}`);
      for (const x of s.value.value) rows.push({ organisation: x.o, reported: x.r, breachDates: longDate(x.b), affected: x.a, total: x.t, url: rep.url });
    });
    const findings = noticeFindings(IN, target, ctx, rows);
    const readYears = reports.filter((r, i) => settled[i].status === 'fulfilled').map((r) => r.year).sort();
    const notes = [
      searchedNote(IN, target, { notices: rows.length, span: `the yearly reports for ${readYears.join(', ')}`, findings: findings.length }),
      `Indiana's reports before ${reports[reports.length - 1].year} use other layouts and were not searched.`,
    ];
    if (failed.length) {
      notes.push(`The Indiana reports for ${failed.map((r) => r.year).join(', ')} could not be read, so ${failed.length === 1 ? 'that year was' : 'those years were'} not searched.`);
      partial.push(`Indiana reports for ${failed.map((r) => r.year).join(', ')} not searched`);
    }
    if (!listing.fresh) partial.push(`Indiana report list as of ${copyDate(listing.at)}`);
    return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
  },
};

export const breachRegistersMoreConnectors = [delawareBreachNoticesConnector, vermontBreachNoticesConnector, marylandBreachNoticesConnector, indianaBreachNoticesConnector];
