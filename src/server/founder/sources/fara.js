/**
 * US Foreign Agents Registration Act (FARA) filings, from the Justice
 * Department's FARA eFile bulk data. One source:
 *
 *   fara-registrations   whether the person filed a short-form registration
 *                        (an individual who works for a registrant on behalf
 *                        of a foreign principal) or registered in their own
 *                        name, and whether their company is a registrant or
 *                        is listed as a foreign principal; and for which
 *                        foreign principals, from which country.
 *
 * Registering under FARA is lawful: it is what the law asks of anyone who
 * represents a foreign government, party or company in the US. A record here
 * is context for an investor (foreign ties, related parties), never a red
 * flag: every finding is severity 'info' and the notes say so.
 *
 * Data. Three small zip files the eFile bulk-data page offers for download,
 * each holding one CSV and refreshed daily (about 0.9 MB, 0.25 MB and 0.7 MB
 * zipped): short forms, registrants and foreign principals. Each is fetched
 * as bytes through ../http, unzipped here (one entry, read with zlib), turned
 * into a compact index and cached once a day (one cache entry per file, each
 * well under the 6 MB stored limit). The eFile JSON service has no name
 * search, which is why the files are read whole.
 *
 * Matching. A person is matched only on their full name (personNameMatcher:
 * first and last name, middle names allowed, "Surname, Given" accepted). A
 * name-only hit is 'possible' and its title says "verify identity". It is
 * 'likely' at most, and only when the registrant on the filing is a company
 * already tied to the person (the record's second fact). No record is ever
 * set 'confirmed'. A company is matched on its whole name once the legal form
 * is set aside, under every known name of the company, and only where the
 * shared company matcher (companyMention) reads the listed name as that
 * company; a one-word or ordinary-word name stays 'possible'.
 *
 * Never read or kept: the street address, city, state and ZIP columns of all
 * three files (the short-form file carries individuals' addresses).
 *
 * Every file must arrive whole, in its known format and recent: a file that
 * fails to load, is too short, has changed its columns or has no filing from
 * the last year is an error, so the lookup is reported as failed, never as
 * "no match".
 */
import * as zlib from 'zlib';
import { getBytes, decodeBody } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { matchSubject } from '../identity';
import {
  personNameMatcher, personNameVariants, parsePersonName, foldAccents, companyMention, isOrdinaryWordCompany,
} from '../names';
import { companyNames, companyTokens, matchCompanyName } from './sanctions';
import { eachCsvRow } from './debarment';
import { withAliasHold } from './alias';

const ID = 'fara-registrations';
const LABEL = 'US foreign agent registrations (FARA filings)';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 6;
const MAX_PRINCIPALS = 6;

const BULK = 'https://efile.fara.gov/bulk/zip';
export const FILES = {
  shortForms: `${BULK}/FARA_All_ShortForms.csv.zip`,
  registrants: `${BULK}/FARA_All_Registrants.csv.zip`,
  principals: `${BULK}/FARA_All_ForeignPrincipals.csv.zip`,
};
/** The eFile page to browse and search filings (a registration number finds the registrant's documents). */
export const FARA_PAGE = 'https://efile.fara.gov/ords/fara/f?p=1235:10';
export const FARA_NOTE = 'FARA registration is a legal requirement for anyone who represents a foreign government, party or company in the US; a filing is not evidence of wrongdoing.';

// A zip is at most a few megabytes; the CSV inside at most this many bytes once unzipped
const MAX_ZIP_BYTES = 6 * 1024 * 1024;
const MAX_CSV_BYTES = 32 * 1024 * 1024;
// The whole files held, on 20 Nov 2026, about 44,800 short forms, 7,100 registrants and 17,800 foreign principals
export const MIN_ROWS = { shortForms: 20000, registrants: 3000, principals: 8000 };
// FARA receives new registrations every week: a file with nothing from the last year is out of date
const RECENT_DAYS = 365;

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fold = (s) => foldAccents(oneLine(s)).toLowerCase();
/** mm/dd/yyyy -> yyyy-mm-dd ('' when it is not a date). */
export const isoDate = (s) => {
  const m = oneLine(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};
const regNo = (s) => (/^\d{1,6}$/.test(oneLine(s)) ? Number(oneLine(s)) : 0);
const properCase = (s) => (/[a-z]/.test(s) ? oneLine(s) : oneLine(s).toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase()));

/* ------------------------------------------------------------------ */
/* Zip                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The one CSV inside a FARA zip. Read from the zip's central directory (so sizes are known even when the local
 * header defers them), inflated with zlib, checked against the stated size and checksum. A zip that is cut off,
 * holds more or fewer than one file, is encrypted or uses another compression is an error.
 * @param {Uint8Array} bytes
 * @param {string} label for the error message
 * @returns {Buffer}
 */
export function unzipSingle(bytes, label = 'The FARA file') {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (why) => new Error(`${label} ${why}`);
  const u16 = (at) => { if (at < 0 || at + 2 > buf.length) throw bad('arrived incomplete'); return buf.readUInt16LE(at); };
  const u32 = (at) => { if (at < 0 || at + 4 > buf.length) throw bad('arrived incomplete'); return buf.readUInt32LE(at); };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('is not a complete zip file');
  if (u16(eocd + 10) !== 1) throw bad('no longer holds a single file');
  const cd = u32(eocd + 16);
  if (u32(cd) !== 0x02014b50) throw bad('is not a readable zip file');
  const flags = u16(cd + 8);
  const method = u16(cd + 10);
  const crc = u32(cd + 16);
  const packed = u32(cd + 20);
  const size = u32(cd + 24);
  const name = buf.toString('latin1', cd + 46, cd + 46 + u16(cd + 28));
  const local = u32(cd + 42);
  if (flags & 1) throw bad('is encrypted');
  if (!/\.csv$/i.test(name)) throw bad('no longer holds a CSV file');
  if (size > MAX_CSV_BYTES) throw bad(`is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB once unzipped`);
  if (u32(local) !== 0x04034b50) throw bad('is not a readable zip file');
  const start = local + 30 + u16(local + 26) + u16(local + 28);
  if (start + packed > buf.length) throw bad('arrived incomplete');
  const data = buf.subarray(start, start + packed);
  let out;
  if (method === 0) out = data;
  else if (method === 8) {
    try { out = zlib.inflateRawSync(data, { maxOutputLength: MAX_CSV_BYTES }); } catch { throw bad('could not be unzipped'); }
  } else throw bad('uses a compression this reader does not know');
  if (out.length !== size) throw bad('arrived incomplete');
  if (typeof zlib.crc32 === 'function' && (zlib.crc32(out) >>> 0) !== (crc >>> 0)) throw bad('arrived damaged');
  return out;
}

// windows-1252 characters at 0x80-0x9F (the rest of the range is Latin-1)
const CP1252 = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f'
  + '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
/**
 * A FARA CSV's text. The files are written in windows-1252 (O\x92Brien for O’Brien). UTF-8 is used when the bytes
 * are valid UTF-8 (decodeBody); otherwise the bytes are read as windows-1252 here, because the runtime's own
 * windows-1252 decoder (Node 22) drops the 0x80-0x9F characters, so decodeBody would lose the apostrophe.
 */
export function csvText(bytes, label = 'The FARA file') {
  const raw = unzipSingle(bytes, label);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return decodeBody(new Uint8Array(raw), 'text/csv; charset=utf-8');
  } catch {
    return Buffer.from(raw).toString('latin1').replace(/[\u0080-\u009f]/g, (c) => CP1252[c.charCodeAt(0) - 0x80]);
  }
}

/* ------------------------------------------------------------------ */
/* Reading the three files                                             */
/* ------------------------------------------------------------------ */

/**
 * Read a CSV whose first row names the columns. Only the named columns are read (never an address column).
 * @returns {Array<string[]>} the wanted columns of each row, in the order asked
 */
function readColumns(text, wanted, label) {
  let index = null;
  const rows = [];
  eachCsvRow(String(text), (f) => {
    if (!index) {
      const col = Object.fromEntries(f.map((h, i) => [oneLine(h).toLowerCase(), i]));
      index = wanted.map((w) => col[w.toLowerCase()]);
      if (index.some((i) => i == null)) throw new Error(`${label} is not in the expected format`);
      return;
    }
    if (f.length < 2) return;
    rows.push(index.map((i) => oneLine(f[i])));
  });
  if (!index) throw new Error(`${label} was empty`);
  return rows;
}

function checkWhole(rows, min, newest, label) {
  if (rows.length < min) throw new Error(`${label} had too few entries to be the whole list`);
  const since = new Date(Date.now() - RECENT_DAYS * DAY_MS).toISOString().slice(0, 10);
  if (!newest || newest < since) throw new Error(`${label} has no filing from the last year, so it looks out of date`);
}
const latest = (dates) => dates.reduce((a, d) => (d > a ? d : a), '');

/**
 * Short forms: [first name, last name, registration number, short form date, short form end date].
 * The individual's address, city, state and ZIP are never read.
 */
export function parseShortForms(text, { minRows = MIN_ROWS.shortForms } = {}) {
  const label = 'The FARA short-form file';
  const raw = readColumns(text, ['Short Form First Name', 'Short Form Last Name', 'Registration Number', 'Short Form Date', 'Short Form Termination Date'], label);
  const rows = [];
  for (const [first, last, no, date, end] of raw) {
    const n = regNo(no);
    if (!last || !first || !n) continue;
    rows.push([first, last, n, isoDate(date), isoDate(end)]);
  }
  checkWhole(rows, minRows, latest(rows.map((r) => r[3])), label);
  return { v: 1, at: new Date().toISOString(), rows };
}

/** Registrants: [registration number, name, business name, registration date, end date]. No address column is read. */
export function parseRegistrants(text, { minRows = MIN_ROWS.registrants } = {}) {
  const label = 'The FARA registrants file';
  const raw = readColumns(text, ['Registration Number', 'Name', 'Business Name', 'Registration Date', 'Termination Date'], label);
  const rows = [];
  for (const [no, name, business, date, end] of raw) {
    const n = regNo(no);
    if (!n || !name) continue;
    rows.push([n, name, business, isoDate(date), isoDate(end)]);
  }
  checkWhole(rows, minRows, latest(rows.map((r) => r[3])), label);
  return { v: 1, at: new Date().toISOString(), rows };
}

/**
 * Foreign principals: [registration number, principal, country or place represented, date registered, end date].
 * The principal's address is never read.
 */
export function parsePrincipals(text, { minRows = MIN_ROWS.principals } = {}) {
  const label = 'The FARA foreign principals file';
  const raw = readColumns(text, ['Registration Number', 'Foreign Principal', 'Country/Location Represented', 'Foreign Principal Registration Date', 'Foreign Principal Termination Date'], label);
  const rows = [];
  for (const [no, name, country, date, end] of raw) {
    const n = regNo(no);
    if (!n || !name) continue;
    rows.push([n, name, country, isoDate(date), isoDate(end)]);
  }
  checkWhole(rows, minRows, latest(rows.map((r) => r[3])), label);
  return { v: 1, at: new Date().toISOString(), rows };
}

const LISTS = {
  shortForms: { key: 'fara:shortforms:v1', parse: parseShortForms, label: 'The FARA short-form file' },
  registrants: { key: 'fara:registrants:v1', parse: parseRegistrants, label: 'The FARA registrants file' },
  principals: { key: 'fara:principals:v1', parse: parsePrincipals, label: 'The FARA foreign principals file' },
};

/** One file, from the cache (once a day), with the date of the copy. */
async function load(which, deadline) {
  const list = LISTS[which];
  const entry = await cachedEntry(list.key, DAY_MS, async ({ deadline: d }) => {
    const bytes = await getBytes(FILES[which], { deadline: d, timeoutMs: 20000, maxBytes: MAX_ZIP_BYTES, accept: 'application/zip,*/*' });
    return list.parse(csvText(bytes, list.label));
  }, { deadline });
  const at = Number(entry.at) || Date.parse(entry.value?.at || '') || Date.now();
  return { index: entry.value, fresh: entry.fresh !== false, asOf: new Date(at).toISOString().slice(0, 10) };
}

/* ------------------------------------------------------------------ */
/* Lookups in the indexes                                              */
/* ------------------------------------------------------------------ */

const prepared = new WeakMap();
/** Per index and purpose ('person', 'company'), each row's searchable words, built once. */
function haystacks(index, purpose, pick) {
  let byPurpose = prepared.get(index);
  if (!byPurpose) { byPurpose = new Map(); prepared.set(index, byPurpose); }
  let p = byPurpose.get(purpose);
  if (!p) { p = index.rows.map((r) => ` ${pick(r).map(fold).join(' ')} `); byPurpose.set(purpose, p); }
  return p;
}

const byRegNo = (index) => {
  const map = new Map();
  for (const r of index.rows) if (!map.has(r[0])) map.set(r[0], r);
  return map;
};

/** "Olympic Media LLC - DBA Starboard LLC" -> both names; the business name column too. */
export function registrantNames(name, business = '') {
  const out = [];
  for (const raw of [name, business]) {
    for (const part of oneLine(raw).split(/\s+-?\s*\b(?:d\/b\/a|dba|a\/k\/a|aka|f\/k\/a|formerly)\b\.?\s*/i)) {
      const n = oneLine(part).replace(/^[-,;\s]+|[-,;\s]+$/g, '');
      if (n.length >= 2 && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

const ORG_WORD = /\b(llc|l\.l\.c|inc|ltd|corp|corporation|co|company|group|associates|partners|lp|llp|pllc|pc|p\.c|consulting|consultants|strategies|strategic|international|global|law|firm|services|government|affairs|media|communications|bank|foundation|council|association|center|centre|institute|office|ministry|embassy|commission|agency|bureau|trust|fund|holdings|ventures|advisors|advisory|solutions|public|relations|network|society|chamber|committee|republic|kingdom|state|tourism|board|news|press|times|radio|television|tv)\b|&/i;
/** A registrant written "Surname, Given" with no organisation word: an individual registered in their own name. */
export const isIndividualRegistrant = (name) => /^[^,]+,[^,]+$/.test(oneLine(name)) && !ORG_WORD.test(name) && oneLine(name).split(/\s+/).length <= 5;

/** The searched forms of the person's name: as typed and given name plus surname, with the subject's variants. */
function personForms(task, ctx) {
  const base = task.kind === 'subject' && ctx?.subject?.variants?.length ? [...ctx.subject.variants, task.value] : [task.value];
  const out = [];
  for (const n of base.flatMap((x) => personNameVariants(x))) {
    const p = parsePersonName(n);
    if (p.given && p.surname && p.given.replace(/\./g, '').length > 1 && p.surname.length > 1 && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 4);
}

/**
 * People on the short forms and individual registrants whose full name is the searched name.
 * @returns {Array<{ kind: 'short-form'|'registrant', listed: string, reg: number, date: string, end: string }>}
 */
export function screenPerson(forms, shortForms, registrants) {
  if (!forms.length) return [];
  const matchers = forms.map((f) => personNameMatcher(f));
  const surnames = [...new Set(forms.map((f) => fold(parsePersonName(f).surname).split(/[\s-]+/).pop()).filter(Boolean))];
  const named = (listed) => matchers.some((m) => m(listed));
  const hits = [];
  const sfHay = haystacks(shortForms, 'person', (r) => [r[0], r[1]]);
  shortForms.rows.forEach((r, i) => {
    if (!surnames.some((s) => sfHay[i].includes(s))) return;
    // "Last, First Middle": the form the matcher reads as the full name
    if (!named(`${r[1]}, ${r[0]}`)) return;
    hits.push({ kind: 'short-form', listed: properCase(`${r[0]} ${r[1]}`), reg: r[2], date: r[3], end: r[4] });
  });
  const rgHay = haystacks(registrants, 'person', (r) => [r[1]]);
  registrants.rows.forEach((r, i) => {
    if (!surnames.some((s) => rgHay[i].includes(s)) || !isIndividualRegistrant(r[1]) || !named(r[1])) return;
    const [last, first] = r[1].split(',').map(oneLine);
    hits.push({ kind: 'registrant', listed: properCase(`${first} ${last}`), reg: r[0], date: r[3], end: r[4] });
  });
  return hits;
}

/**
 * Whether a listed organisation is the company, under one of its known names: the whole name once the legal form
 * is set aside, and read as that company by the shared company matcher.
 * @returns {string} the known name that matched, or ''
 */
export function sameCompanyAs(knownNames, listed) {
  for (const known of knownNames) {
    if (matchCompanyName(known, listed) && companyMention(known, listed).named) return known;
  }
  return '';
}

/** Registrants and foreign principals that are the company. */
export function screenCompany(knownNames, registrants, principals) {
  const wants = knownNames.map((n) => ({ n, t: companyTokens(n).map(fold) })).filter((w) => w.t.join('').length >= 3);
  const hits = [];
  if (!wants.length) return hits;
  const carries = (hay) => wants.some((w) => w.t.every((t) => hay.includes(` ${t} `)));
  const rgHay = haystacks(registrants, 'company', (r) => [companyTokens(r[1]).join(' '), companyTokens(r[2]).join(' ')]);
  registrants.rows.forEach((r, i) => {
    if (!carries(rgHay[i]) || isIndividualRegistrant(r[1])) return;
    for (const listed of registrantNames(r[1], r[2])) {
      const via = sameCompanyAs(knownNames, listed);
      if (via) { hits.push({ kind: 'registrant', listed: r[1], reg: r[0], date: r[3], end: r[4], via }); return; }
    }
  });
  if (principals) {
    const fpHay = haystacks(principals, 'company', (r) => [companyTokens(r[1]).join(' ')]);
    principals.rows.forEach((r, i) => {
      if (!carries(fpHay[i])) return;
      const via = sameCompanyAs(knownNames, r[1]);
      if (via) hits.push({ kind: 'principal', listed: r[1], country: r[2], reg: r[0], date: r[3], end: r[4], via });
    });
  }
  return hits;
}

/** A registrant's foreign principals, current ones first. */
function principalsOf(principals, reg) {
  if (!principals) return [];
  const rows = principals.rows.filter((r) => r[0] === reg);
  rows.sort((a, b) => (a[4] ? 1 : 0) - (b[4] ? 1 : 0) || String(b[3]).localeCompare(String(a[3])));
  return rows;
}
const principalLine = (rows) => {
  const shown = rows.slice(0, MAX_PRINCIPALS).map((r) => `${r[1]}${r[2] ? ` (${properCase(r[2])})` : ''}${r[4] ? `, ended ${r[4]}` : ''}`);
  return shown.length ? `${shown.join('; ')}${rows.length > MAX_PRINCIPALS ? `; and ${rows.length - MAX_PRINCIPALS} more` : ''}` : '';
};

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The grade of a person found by full name. 'likely' only when the registrant on the filing is a company already
 * tied to the person (the identity matcher reads the person's name beside the registrant as a known company);
 * otherwise 'possible', with "verify identity" in the title. Never 'confirmed'.
 */
function personGrade(subject, registrant) {
  const graded = registrant ? matchSubject(subject, `${subject.name} | ${registrant}`) : null;
  if (graded && (graded.level === 'confirmed' || graded.level === 'likely') && (graded.basis || []).includes('company')) {
    return { match: 'likely', matchReasons: [...graded.reasons.filter((r) => /^names /.test(r)).slice(0, 2), 'the registrant on the filing is a company already tied to the person; the filing gives no other detail to confirm it is them'] };
  }
  return null;
}

function personFinding(task, ctx, hit, lists) {
  const reg = lists.registrantsByNo.get(hit.reg);
  const registrant = hit.kind === 'short-form' ? (reg ? reg[1] : '') : '';
  const fps = principalsOf(lists.principals, hit.reg);
  const ended = hit.end ? ` (ended ${hit.end})` : '';
  const base = hit.kind === 'short-form'
    ? `Filed a FARA short-form registration${registrant ? ` as an individual working for ${registrant}` : ''}${ended}: ${hit.listed}`
    : `Registered under FARA in their own name (registration ${hit.reg})${ended}: ${hit.listed}`;
  const grade = personGrade(ctx.subject, registrant);
  const title = grade ? base : `${base}: name match only, verify identity`;
  const quote = [
    `Name on the filing: ${hit.listed}`,
    registrant ? `Registrant: ${registrant}` : '',
    `Registration number: ${hit.reg}`,
    hit.date ? `${hit.kind === 'short-form' ? 'Short form filed' : 'Registered'}: ${hit.date}` : '',
    hit.end ? `Ended: ${hit.end}` : (hit.date ? 'Status: active' : ''),
    fps.length ? `${hit.kind === 'short-form' ? "Registrant's foreign principals" : 'Foreign principals'}: ${principalLine(fps)}` : '',
  ].filter(Boolean).join(' | ');
  return makeFinding(ctx.subject, {
    source: ID, sourceLabel: LABEL, category: 'career', severity: 'info',
    title, quote, url: FARA_PAGE, date: hit.date || null,
    match: grade ? grade.match : 'possible',
    matchReasons: grade ? grade.matchReasons : ['matched by full name only; verify identity (FARA filings give no detail beyond the name and the registrant)'],
    data: {
      filing: hit.kind, registrationNumber: hit.reg, registrant: registrant || null, ended: hit.end || null,
      foreignPrincipals: fps.slice(0, MAX_PRINCIPALS).map((r) => ({ name: r[1], country: r[2] || null, ended: r[4] || null })),
      searched: oneLine(task.value),
    },
  });
}

function companyGrade(via) {
  if (companyTokens(via).length < 2 || isOrdinaryWordCompany(via)) {
    return { match: 'possible', matchReasons: [`${oneLine(via)} is a one-word or ordinary-word name many unrelated companies share; verify it is the same company`] };
  }
  return { match: 'company', matchReasons: ['the listed name is the same as the company name'] };
}

function companyFinding(task, ctx, hit, lists) {
  const grade = companyGrade(hit.via);
  const held = grade.match === 'possible' ? ': name match only, verify it is the same company' : '';
  const ended = hit.end ? ` (ended ${hit.end})` : '';
  if (hit.kind === 'registrant') {
    const fps = principalsOf(lists.principals, hit.reg);
    return makeFinding(ctx.subject, {
      source: ID, sourceLabel: LABEL, category: 'corporate', severity: 'info',
      title: `Registered under FARA as an agent of foreign principals${ended}: ${hit.listed}${held}`,
      quote: [
        `Registrant: ${hit.listed}`,
        `Registration number: ${hit.reg}`,
        hit.date ? `Registered: ${hit.date}` : '',
        hit.end ? `Ended: ${hit.end}` : (hit.date ? 'Status: active' : ''),
        fps.length ? `Foreign principals: ${principalLine(fps)}` : '',
      ].filter(Boolean).join(' | '),
      url: FARA_PAGE, date: hit.date || null, ...grade,
      data: {
        filing: 'registrant', registrationNumber: hit.reg, ended: hit.end || null,
        foreignPrincipals: fps.slice(0, MAX_PRINCIPALS).map((r) => ({ name: r[1], country: r[2] || null, ended: r[4] || null })),
        searched: oneLine(task.value),
      },
    });
  }
  const reg = lists.registrantsByNo.get(hit.reg);
  const agent = reg ? reg[1] : '';
  return makeFinding(ctx.subject, {
    source: ID, sourceLabel: LABEL, category: 'corporate', severity: 'info',
    title: `Listed as a foreign principal in a FARA registration${agent ? ` (represented by ${agent})` : ''}${ended}: ${hit.listed}${held}`,
    quote: [
      `Foreign principal: ${hit.listed}`,
      hit.country ? `Country or place represented: ${properCase(hit.country)}` : '',
      agent ? `Registrant representing it: ${agent}` : '',
      `Registration number: ${hit.reg}`,
      hit.date ? `Listed: ${hit.date}` : '',
      hit.end ? `Ended: ${hit.end}` : '',
    ].filter(Boolean).join(' | '),
    url: FARA_PAGE, date: hit.date || null, ...grade,
    data: { filing: 'foreign-principal', registrationNumber: hit.reg, registrant: agent || null, country: hit.country || null, ended: hit.end || null, searched: oneLine(task.value) },
  });
}

/* ------------------------------------------------------------------ */
/* The source                                                          */
/* ------------------------------------------------------------------ */

const tooShort = (task) => ({
  findings: [], threads: [],
  notes: [`FARA filings: "${oneLine(task.value)}" is too short a name to search`],
  partial: [`${oneLine(task.value).slice(0, 40)}: name too short to search`],
});

const asOf = (...copies) => {
  const dates = [...new Set(copies.filter(Boolean).map((c) => c.asOf))].sort();
  return dates.length ? ` (files as of ${dates[0]})` : '';
};

export const faraConnector = {
  id: ID,
  label: LABEL,
  // 'alias': another name of the person, looked for like their own name
  kinds: ['subject', 'alias', 'company'],
  prior: 0.2,
  timeoutMs: 25000,
  plan(thread) {
    if (thread?.kind === 'company') return [{ template: 'fara.company', prior: 0.2, why: 'look for the company among FARA registrants and foreign principals' }];
    return [{ template: 'fara.person', prior: 0.15, why: 'look for the person among FARA short-form filers and individual registrants' }];
  },
  async run(task, ctx) {
    const name = oneLine(task.value);
    const notes = [FARA_NOTE];
    const partial = [];
    const stale = (label, copy) => {
      if (copy && !copy.fresh) {
        notes.push(`${label}: the latest copy could not be downloaded, so the copy of ${copy.asOf} was searched`);
        partial.push(`${label}: as of ${copy.asOf}`);
      }
    };

    if (task.kind === 'company') {
      const known = companyNames(ctx.subject, name, 3);
      if (!known.some((n) => companyTokens(n).join('').length >= 3)) return tooShort(task);
      const registrants = await load('registrants', ctx.deadline);
      let principals = null;
      try { principals = await load('principals', ctx.deadline); } catch {
        notes.push(`FARA foreign principals file: could not be read, so ${name} was not looked for among foreign principals, and registrants' principals are not listed`);
        partial.push('FARA foreign principals file');
      }
      stale('FARA registrants file', registrants);
      stale('FARA foreign principals file', principals);
      const lists = { registrantsByNo: byRegNo(registrants.index), principals: principals?.index || null };
      const hits = screenCompany(known, registrants.index, lists.principals);
      hits.sort((a, b) => (a.kind === 'registrant' ? 0 : 1) - (b.kind === 'registrant' ? 0 : 1) || String(b.date).localeCompare(String(a.date)));
      const findings = hits.slice(0, MAX_FINDINGS).map((h) => companyFinding(task, ctx, h, lists)).filter(Boolean);
      const searched = principals ? 'FARA registrants and foreign principals' : 'FARA registrants';
      if (!hits.length) notes.push(`${searched}: no registrant${principals ? ' or foreign principal' : ''} is named ${known.join(' or ')}${asOf(registrants, principals)}`);
      if (hits.length > MAX_FINDINGS) notes.push(`FARA filings: ${hits.length} entries carry the name ${name}; the first ${MAX_FINDINGS} are shown`);
      return { findings, threads: [], notes, ...(partial.length ? { partial } : {}) };
    }

    const forms = personForms(task, ctx);
    if (!forms.length) return tooShort(task);
    const [shortForms, registrants] = await Promise.all([load('shortForms', ctx.deadline), load('registrants', ctx.deadline)]);
    stale('FARA short-form file', shortForms);
    stale('FARA registrants file', registrants);
    const hits = screenPerson(forms, shortForms.index, registrants.index);
    let principals = null;
    if (hits.length) {
      try { principals = await load('principals', ctx.deadline); } catch {
        notes.push('FARA foreign principals file: could not be read, so the foreign principals of the filings found are not listed');
        partial.push('FARA foreign principals file');
      }
      stale('FARA foreign principals file', principals);
    }
    const lists = { registrantsByNo: byRegNo(registrants.index), principals: principals?.index || null };
    // One finding per registration; the latest filing first
    const seen = new Set();
    const unique = hits.sort((a, b) => String(b.date).localeCompare(String(a.date))).filter((h) => {
      const k = `${h.kind}|${h.reg}|${fold(h.listed)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const findings = unique.slice(0, MAX_FINDINGS).map((h) => personFinding(task, ctx, h, lists)).filter(Boolean);
    if (!unique.length) notes.push(`FARA short-form filings and individual registrants: no filing names ${name}${asOf(shortForms, registrants)}`);
    if (unique.length > MAX_FINDINGS) notes.push(`FARA filings: ${unique.length} filings carry the name ${name}; the first ${MAX_FINDINGS} are shown`);
    return { findings, threads: [], notes, ...(partial.length ? { partial } : {}) };
  },
};

// A record found only under another name of the person the user did not type is 'likely' at most (alias.js).
faraConnector.run = withAliasHold(faraConnector.run);
