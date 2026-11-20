/**
 * Debarment, prohibition and enforcement lists that the sanctions screens do
 * not cover. Three sources, six lists:
 *
 *   mdb-debarment       the EBRD list of ineligible entities and individuals.
 *                       It carries the EBRD's own debarments and, through
 *                       the development banks' cross-debarment agreement,
 *                       every World Bank, Asian Development Bank,
 *                       Inter-American Development Bank and African
 *                       Development Bank debarment of more than a year. The
 *                       file is the one the EBRD page's own Download button
 *                       serves (a CSV), read whole at most once a day.
 *   us-bank-regulators  enforcement actions of the three US bank regulators
 *                       that name individuals: the Federal Reserve (its
 *                       published list of actions since 1990, two JSON
 *                       files read whole once a day), the OCC (its public
 *                       enforcement action search, one search per name) and
 *                       the NCUA (its administrative orders, a CSV read whole
 *                       once a day). Prohibition orders, removal orders, cease
 *                       and desist orders, civil money penalties, written
 *                       agreements and Section 19 letters.
 *   fincen-actions      FinCEN's enforcement actions under the Bank Secrecy
 *                       Act (one page that lists every action since 1999,
 *                       read once a day).
 *
 * Name matching is the strict matching of the sanctions screens (sanctions.js):
 * a person is matched only on their first and last name in order, never on a
 * part of a name and never fuzzily; a company only on its whole name with the
 * legal form removed. A hit on a person is graded by makeFinding from the
 * person's name plus the record's own context (the bank or credit union it
 * names, the reason given): it is 'possible' unless that context names
 * something already tied to the person. No source here sets 'confirmed'.
 * Associates and relatives are screened by name only and stay 'possible'
 * unless the record also names the subject.
 *
 * Never read or kept: addresses, nationality of a person, dates of birth,
 * the person's city. The EBRD file's address column is skipped.
 *
 * Looked at and not used (November 2026): the World Bank's own list (its data
 * service needs a subscription key), the ADB register (behind a login
 * gateway), the IDB, AfDB, PCAOB and Canadian Securities Administrators sites
 * (they turn automated readers away), Interpol notices (refuses automated
 * readers), ASIC's banned and disqualified registers (published on
 * data.gov.au, whose robots.txt disallows every automated reader), the FDIC's
 * orders (an interactive app with no data file), NFA BASIC (did not answer an
 * automated reader), the UK FCA register (needs a registered key), and the UK
 * Insolvency Service list (only the last three months; the full register of
 * disqualified directors is already searched through Companies House).
 */
import { request, htmlToText } from '../http';
import { makeFinding, makeThread, severityFromText } from '../finding';
import { cached } from '../cache';
import { normalizeName, nameTokens, companyTokens, matchPersonName, matchCompanyName, personVariants } from './sanctions';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 6;

/* ------------------------------------------------------------------ */
/* Text and names                                                      */
/* ------------------------------------------------------------------ */

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clipText = (s, n) => {
  const str = oneLine(s);
  if (str.length <= n) return str;
  const cut = str.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '')}…`;
};
const capitalise = (s) => String(s || '').replace(/^\s*([a-z])/, (m, c) => c.toUpperCase());
/** "elizabeth HOLMES" -> "Elizabeth Holmes", so the grader (which wants a capitalised name) can read it. */
const properCase = (s) => oneLine(s).split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
/** Entities decoded, tags removed, one line. */
const plain = (s) => oneLine(htmlToText(String(s ?? '')));
const isLatin = (name) => normalizeName(name).length >= 2;
/** A person's name is only searched when it has a first and a last name. */
const isFullName = (tokens) => tokens.filter((t) => t.length > 1).length >= 2;

// "Albert C. Kelly, Jr." -> "Albert C. Kelly": a generational suffix is not part of the name to compare.
const SUFFIX = /(?:,\s*|\s+)(?:jr|sr|ii|iii|iv)\.?\s*,?\s*$/i;
const AKA = /\s*(?:,\s*)?\b(?:also known as|formerly known as|a\.?k\.?a\.?|f\/k\/a|n\/k\/a|also d\/?b\/?a|doing business as|d\/b\/a)\b\s*:?\s*/i;

/**
 * A listed person's name and aliases: generational suffixes removed, quotes
 * removed, "also known as 'Roger Ng'" read as an alias.
 */
export function personNameForms(raw) {
  const text = plain(raw).replace(/["“”‘’']/g, (c) => (c === "'" || c === '’' ? c : ''));
  const parts = text.split(AKA).map((p) => oneLine(p.replace(/^['’]+|['’]+$/g, '')).replace(SUFFIX, '').replace(/[,;\s]+$/, '')).filter(Boolean);
  const [name = '', ...aliases] = parts;
  return { name, aliases: aliases.filter((a) => isLatin(a) && a !== name) };
}

/**
 * A listed firm's name and aliases. Text in brackets is either another name
 * ("also known as M/s Sunaula Khimti") or a qualifier ("but only for its
 * business operations in the Water and Sanitation Sector"); the qualifier is
 * kept apart, for the quote, and is never part of the name compared.
 */
export function firmNameForms(raw, extra = '') {
  let text = oneLine(raw);
  const brackets = [];
  // innermost brackets first, so nested ones come out whole
  for (let guard = 0; guard < 6 && /\([^()]*\)/.test(text); guard += 1) {
    text = text.replace(/\(([^()]*)\)/g, (m, inner) => { brackets.push(oneLine(inner)); return ' '; });
  }
  // an unclosed bracket: the rest is a note
  const open = text.indexOf('(');
  if (open > 0) { brackets.push(oneLine(text.slice(open + 1))); text = text.slice(0, open); }
  const name = oneLine(text).replace(/[,;\s]+$/, '');
  const aliases = [];
  const qualifiers = [];
  const pushAliases = (b) => {
    for (const a of b.split(new RegExp(`${AKA.source}|\\bformerly\\b|;`, 'i'))) {
      const alias = oneLine(a).replace(/^[,;()\s]+|[,;()\s]+$/g, '');
      if (alias && isLatin(alias) && alias.length <= 160) aliases.push(alias);
    }
  };
  const isAka = (b) => AKA.test(b) || /^formerly\b/i.test(b);
  for (const b of brackets) {
    if (!b || !isLatin(b)) continue;
    if (isAka(b)) pushAliases(b);
    else if (/\b(only|operations?|sector|except|limited to|division|branch)\b/i.test(b)) qualifiers.push(b);
  }
  // The file's second name column: the name in its own script, or (when a name spilled over) more aliases
  const second = oneLine(extra);
  if (second && isLatin(second)) pushAliases(second);
  return { name, aliases: [...new Set(aliases)].filter((a) => a !== name).slice(0, 8), qualifier: qualifiers.join('; ') };
}

// US bank legal forms that the shared company matcher does not know: "Blue Ridge Bank, N.A." is "Blue Ridge Bank, National Association".
const BANK_FORM = /,?\s*(?:national association|n\.\s?a\.?|federal savings bank|f\.s\.b\.?)\s*$/i;
const firmCore = (s) => oneLine(String(s || '').replace(BANK_FORM, ''));
/** The same company once legal forms (bank forms included) are removed. */
const sameFirm = (searched, listed) => matchCompanyName(firmCore(searched), firmCore(listed));

/** dd-mm-yyyy or mm/dd/yyyy -> yyyy-mm-dd ('' when it is not a date). */
const dmy = (s) => {
  const m = String(s || '').trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

const compact = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== '' && v != null && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out;
};

/* ------------------------------------------------------------------ */
/* Delimited text                                                      */
/* ------------------------------------------------------------------ */

/**
 * One pass over comma-separated text. Quoted fields may hold commas and line
 * breaks; spaces before an opening quote are allowed (the EBRD file writes
 * `, "name"`); unquoted fields are trimmed.
 */
export function eachCsvRow(text, onRow) {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row = [];
  while (i < n) {
    let j = i;
    while (j < n && (text[j] === ' ' || text[j] === '\t')) j += 1;
    let field;
    if (text[j] === '"') {
      j += 1;
      field = '';
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { field += text.slice(j); j = n; break; }
        if (text[q + 1] === '"') { field += text.slice(j, q + 1); j = q + 2; continue; }
        field += text.slice(j, q);
        j = q + 1;
        break;
      }
      // anything between the closing quote and the separator is dropped
      while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j += 1;
    } else {
      j = i;
      while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j += 1;
      field = text.slice(i, j).trim();
    }
    row.push(field);
    i = j;
    if (i < n && text[i] === ',') {
      i += 1;
      if (i === n) row.push('');
      continue;
    }
    if (text[i] === '\r') i += 1;
    if (text[i] === '\n') i += 1;
    onRow(row);
    row = [];
  }
  if (row.length) onRow(row);
}

/* ------------------------------------------------------------------ */
/* Screening a compact index                                           */
/* ------------------------------------------------------------------ */

/**
 * A compact index is { v, key, at, rows } where each row is
 *   n  name as listed          a  aliases           c  more company names (a joint listing split up)
 *   t  'person' | 'entity' | '' (when the list does not say)
 *   plus fields of its own list (institution, action, dates, link)
 */
const prepared = new WeakMap();
function tokenLine(index) {
  let p = prepared.get(index);
  if (!p) {
    p = index.rows.map((row) => ` ${[row.n, ...(row.a || []), ...(row.c || [])].map((x) => normalizeName(x)).join(' ')} `);
    prepared.set(index, p);
  }
  return p;
}

/**
 * Screen names against an index.
 * @param {object} index
 * @param {string[]} names the searched name and its variants (one entry for a company)
 * @param {'person'|'company'} mode
 * @returns {Array<{ row: object, tier: 1|2, matched: string }>} tier 1 first
 */
export function screenRows(index, names, mode) {
  const hits = [];
  const lines = tokenLine(index);
  if (mode === 'company') {
    const want = companyTokens(firmCore(names[0]));
    if (want.join('').length < 3) return hits;
    index.rows.forEach((row, i) => {
      if (row.t === 'person' || !want.every((t) => lines[i].includes(` ${t} `))) return;
      const matched = [row.n, ...(row.a || []), ...(row.c || [])].find((x) => sameFirm(names[0], x));
      if (matched) hits.push({ row, tier: 1, matched });
    });
    return hits;
  }
  const variants = names.filter((v) => isFullName(nameTokens(v)));
  if (!variants.length) return hits;
  const needs = variants.map((v) => nameTokens(v));
  index.rows.forEach((row, i) => {
    if (row.t === 'entity') return;
    if (!needs.some((need) => need.every((t) => lines[i].includes(` ${t} `)))) return;
    let best = null;
    for (const listed of [row.n, ...(row.a || [])]) {
      const tier = matchPersonName(variants, listed);
      if (tier && (!best || tier < best.tier)) best = { row, tier, matched: listed };
    }
    if (best) hits.push(best);
  });
  return hits.sort((a, b) => a.tier - b.tier);
}

/* ------------------------------------------------------------------ */
/* Tasks and findings                                                  */
/* ------------------------------------------------------------------ */

const isPersonTask = (task) => task.kind !== 'company';
const searchedNames = (task, ctx) => {
  if (task.kind === 'company') return [oneLine(task.value)];
  if (task.kind === 'subject' && ctx?.subject?.variants?.length) return [...new Set([...ctx.subject.variants, ...personVariants(ctx.subject.name)])];
  return personVariants(task.value);
};
/** False when a name cannot be screened at all (a single word for a person, a two-letter company). */
const canScreen = (task, ctx) => (isPersonTask(task)
  ? searchedNames(task, ctx).some((v) => isFullName(nameTokens(v)))
  : companyTokens(firmCore(task.value)).join('').length >= 3);
/** The shortest searched form of a person's name: first and last name, no middle initials. */
const coreName = (variants) => variants.filter((v) => isFullName(nameTokens(v))).sort((a, b) => a.split(' ').length - b.split(' ').length)[0] || variants[0];

/**
 * A name that cannot be screened was not looked up at all: never a clean result. `partial` makes the report list
 * the screen as partly done, not "no match".
 */
const tooShort = (label, task) => ({
  findings: [], threads: [],
  notes: [`${label}: "${oneLine(task.value)}" is too short a name to screen`],
  partial: [`${oneLine(task.value).slice(0, 40)}: name too short to screen`],
});

/** "Father John Roe" / "Associate Jane Roe": who a record found for a related person is about. */
const aboutPrefix = (task) => (task.kind === 'associate' || task.kind === 'relative'
  ? `${capitalise(task.relation || (task.kind === 'relative' ? 'relative' : 'associate'))} ${oneLine(task.value)}: `
  : '');

/**
 * Grade and build one finding.
 *   subject    graded by makeFinding from the person's name plus the record's own context
 *   company    'company' (the caller has already required the whole name); 'possible' when the name is
 *              one word once the legal form is removed
 *   associate, relative   'possible' unless the record also names the subject
 */
function graded(task, ctx, f, context) {
  const subject = ctx.subject;
  if (task.kind === 'company') {
    if (companyTokens(firmCore(task.value)).length < 2) {
      return makeFinding(subject, { ...f, match: 'possible', matchReasons: ['only the company name\'s one distinctive word matches; many unrelated companies share a one-word name'] });
    }
    return makeFinding(subject, { ...f, match: 'company', matchReasons: ['the listed name is the same as the company name'] });
  }
  if (task.kind === 'associate' || task.kind === 'relative') {
    const reason = `name match on ${task.kind === 'relative' ? 'a relative' : 'an associate'} of the subject`;
    return makeFinding(subject, f) || makeFinding(subject, { ...f, match: 'possible', matchReasons: [reason] });
  }
  // The name was matched part by part above; the grade then rests on what else the record names.
  const matchText = `${properCase(subject.name)}. ${context}`;
  const build = (title, byName) => (byName
    ? makeFinding(subject, { ...f, title, match: 'possible', matchReasons: ['matched by name only'] })
    : makeFinding(subject, { ...f, title, matchText }));
  let byName = false;
  let found = build(f.title, false);
  if (!found) { byName = true; found = build(f.title, true); }
  // A name-only match says so in its title, so a namesake's record is never read as theirs
  if (found && found.match === 'possible') return build(`${f.title}: name match only, verify identity`, byName) || found;
  return found;
}

/** A bank a confirmed or likely record ties the person to: worth following. The town and state are left off. */
function institutionThread(task, finding, institution, why) {
  if (task.kind !== 'subject' || !finding || !['confirmed', 'likely'].includes(finding.match)) return null;
  return makeThread('company', oneLine(String(institution || '').split(',')[0]), why, { trusted: true });
}

const atLeastMedium = (sev) => (sev === 'high' ? 'high' : 'medium');
/** Prohibitions, removals, debarments and cease-and-desist orders are the gravest a regulator issues. */
const actionSeverity = (text) => (/prohibit|removal|debar|ineligib|section 19|cease[- ]and[- ]desist|barred/i.test(text) ? 'high' : atLeastMedium(severityFromText(text)));

/* ------------------------------------------------------------------ */
/* 1. Development bank debarments (EBRD list)                          */
/* ------------------------------------------------------------------ */

const MDB_ID = 'mdb-debarment';
const MDB_LABEL = 'Development bank debarment list (EBRD, with World Bank, ADB, IDB and AfDB cross-debarments)';
export const EBRD_PAGE = 'https://www.ebrd.com/home/who-we-are/strategies-governance-compliance/ebrd-sanctions-system/ineligible-entities.html';
const EBRD_CSV = 'https://www.ebrd.com/bin/ebrd_dxp/csvdownloader';
// The form the page's own Download button sends
const EBRD_FORM = new URLSearchParams({
  parentPath: '/content/dam/ebrd_dxp/content-fragments/occo/ineligible-entities', cardType: 'iecard', eventSort: '', searchKey: '', sortBy: '', filters: '', startDate: '', endDate: '', responseType: 'csv',
}).toString();
export const MDB_NOTE = 'The World Bank, Asian Development Bank, Inter-American Development Bank and African Development Bank lists were not read directly; their debarments of more than a year appear on the EBRD list as cross-debarments.';
const EBRD_TAIL = 9; // the file's columns from "Notice type" to "Address"

/** Build the compact index from the EBRD ineligible entities CSV. */
export function parseEbrd(text) {
  if (!/\n\s*$/.test(String(text).slice(-8))) throw new Error('The EBRD list file arrived incomplete');
  let header = null;
  const rows = [];
  eachCsvRow(String(text), (f) => {
    if (!header) {
      header = f;
      if (!/name of entity/i.test(f[0] || '') || !f.some((h) => /notice type/i.test(h)) || f.length !== EBRD_TAIL + 2) throw new Error('The EBRD list file is not in the expected format');
      return;
    }
    if (f.length < EBRD_TAIL + 2) return;
    // A name with an unquoted comma spills into the next column: the last nine columns are read from the right
    const k = f.length - EBRD_TAIL;
    const [type, country, reason, grounds, jurisdiction, start, end, effective] = f.slice(k, k + 8).map(oneLine);
    if (type && !/^(firm|individual)$/i.test(type)) return;
    const person = /^individual$/i.test(type);
    const forms = person ? (() => { const p = personNameForms(f[0]); return { ...p, qualifier: '' }; })() : firmNameForms(f[0], f.slice(1, k).join(', '));
    if (!forms.name || !isLatin(forms.name)) return;
    if (person) {
      const special = oneLine(f.slice(1, k).join(' '));
      if (special && isLatin(special) && normalizeName(special) !== normalizeName(forms.name)) forms.aliases.push(special);
    }
    rows.push(compact({
      n: forms.name,
      a: forms.aliases.slice(0, 8),
      t: person ? 'person' : type ? 'entity' : '',
      q: clipText(forms.qualifier, 160),
      r: clipText(reason.replace(/\s{2,}/g, '; '), 160),
      g: clipText(grounds, 120),
      j: clipText(jurisdiction, 80),
      d: dmy(start),
      e: dmy(end) || clipText(end, 80),
      f: dmy(effective),
      // a firm's country only: a person's nationality is never kept
      ...(person ? {} : { k: clipText(country, 60) }),
    }));
  });
  if (rows.length < 50) throw new Error('The EBRD list file had too few entries to be the whole list');
  return { v: 1, key: 'ebrd', at: new Date().toISOString(), rows };
}

const loadEbrd = (deadline) => cached('debarment:ebrd:v1', DAY_MS, async () => parseEbrd((await request(EBRD_CSV, {
  method: 'POST', body: EBRD_FORM, deadline, timeoutMs: 18000, maxBytes: 8 * 1024 * 1024, accept: 'text/csv',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
})).text));

function ebrdFinding(task, ctx, hit, index) {
  const { row } = hit;
  const fromBank = (row.g || '').match(/cross-debarment from (.+)/i)?.[1] || (/primary/i.test(row.g || '') ? 'EBRD' : '');
  const quote = [
    `Listed name: ${row.n}`,
    hit.matched !== row.n ? `Also listed as: ${hit.matched}` : '',
    row.t ? `Type: ${row.t === 'person' ? 'individual' : 'firm'}` : '',
    row.k ? `Country: ${row.k}` : '',
    row.g ? `Grounds: ${row.g}` : '',
    row.r ? `Reason for debarment: ${row.r}` : '',
    row.j ? `Jurisdiction of judgement: ${row.j}` : '',
    row.d ? `Start: ${row.d}` : '',
    row.e ? `End: ${row.e}` : '',
    row.f ? `Effective at the EBRD: ${row.f}` : '',
    row.q ? `Scope: ${row.q}` : '',
  ].filter(Boolean).join(' | ');
  const finding = graded(task, ctx, {
    source: MDB_ID, sourceLabel: MDB_LABEL, category: 'sanctions', severity: 'high',
    title: `${aboutPrefix(task)}Debarred by ${fromBank ? `the ${fromBank.replace(/^the /i, '')}` : 'a development bank'}: ${row.n}`,
    quote,
    url: EBRD_PAGE,
    date: row.d || row.f || null,
    data: { list: 'EBRD ineligible entities', grounds: row.g || null, debarredBy: fromBank || null, searched: oneLine(task.value), tier: hit.tier, listReadAt: index.at },
  }, [row.r, row.q, row.k].filter(Boolean).join('. '));
  return finding;
}

export const mdbDebarmentConnector = {
  id: MDB_ID,
  label: MDB_LABEL,
  kinds: ['subject', 'company', 'associate', 'relative'],
  prior: 0.3,
  timeoutMs: 22000,
  plan() {
    return [{ template: 'debar.mdb', prior: 0.3, why: 'screen the name against the development banks\' debarment list' }];
  },
  async run(task, ctx) {
    if (!canScreen(task, ctx)) return tooShort(MDB_LABEL, task);
    const name = oneLine(task.value);
    const index = await loadEbrd(ctx.deadline);
    const hits = screenRows(index, searchedNames(task, ctx), isPersonTask(task) ? 'person' : 'company');
    const findings = hits.slice(0, MAX_FINDINGS).map((h) => ebrdFinding(task, ctx, h, index)).filter(Boolean);
    const notes = [MDB_NOTE];
    if (!hits.length) notes.push(`Development bank debarment list: no match for ${name}`);
    if (hits.length > MAX_FINDINGS) notes.push(`Development bank debarment list: ${hits.length} entries match the name ${name}; the first ${MAX_FINDINGS} are shown`);
    return { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ */
/* 2. US bank regulators: Federal Reserve, OCC, NCUA                   */
/* ------------------------------------------------------------------ */

const BANK_ID = 'us-bank-regulators';
const BANK_LABEL = 'US bank regulator enforcement actions (Federal Reserve, OCC, NCUA)';

/* ---- Federal Reserve ---- */

const FRB = 'https://www.federalreserve.gov';
export const FRB_PAGE = `${FRB}/supervisionreg/enforcementactions.htm`;
const FRB_FILES = [`${FRB}/supervisionreg/files/ea-cms-recent.json`, `${FRB}/supervisionreg/files/ea-old.json`];

/** The JSON of one of the Federal Reserve's files (they start with a byte order mark). */
function frbItems(text, which) {
  let json;
  try { json = JSON.parse(String(text).replace(/^﻿/, '')); } catch { throw new Error(`The Federal Reserve ${which} file was not readable`); }
  if (!json || !Array.isArray(json.eaitems)) throw new Error(`The Federal Reserve ${which} file is not in the expected format`);
  return json.eaitems;
}

/** "Silvergate Capital Corporation, La Jolla, California; and Silvergate Bank, La Jolla, California" -> each firm's name. */
export function splitInstitutions(text) {
  const pieces = plain(text).split(/\s*;\s*(?:and\s+)?|,?\s+and\s+(?=[A-Z])/).map(oneLine).filter(Boolean);
  const out = new Set();
  const add = (p) => {
    const parts = p.split(/\s*,\s*/);
    // the name, then the name with its legal form ("Evolve Bancorp, Inc."), never the town or state alone
    if (parts[0]) out.add(parts[0]);
    if (parts.length > 1 && companyTokens(`${parts[0]} ${parts[1]}`).length === companyTokens(parts[0]).length) out.add(`${parts[0]}, ${parts[1]}`);
  };
  pieces.forEach((p, i) => {
    add(p);
    // "Bank and Trust": a name that itself holds "and"
    if (i + 1 < pieces.length) add(`${p.split(/\s*,\s*/)[0]} and ${pieces[i + 1]}`);
  });
  return [...out].filter((x) => isLatin(x));
}

/** Build the compact index from the Federal Reserve's two files. */
export function parseFrb(recentText, oldText) {
  const recent = frbItems(recentText, 'recent actions');
  const old = frbItems(oldText, 'earlier actions');
  if (old.length < 500) throw new Error('The Federal Reserve file of earlier actions had too few entries to be whole');
  const rows = [];
  for (const it of [...recent, ...old]) {
    if (!it || typeof it !== 'object' || !it.type) continue;
    const link = oneLine(it.url);
    const u = /^https?:\/\//i.test(link) ? link : link.startsWith('/') ? `${FRB}${link}` : FRB_PAGE;
    const ended = oneLine(it.tdt);
    const base = { k: clipText(plain(it.type), 120), d: oneLine(it.edt).slice(0, 10), e: ended && !ended.startsWith('1950') ? ended.slice(0, 10) : '', u };
    if (it.person) {
      const { name, aliases } = personNameForms(it.person);
      if (!name || !isLatin(name)) continue;
      rows.push(compact({ n: name, a: aliases, t: 'person', o: clipText(plain(it.porg), 160), ...base }));
    } else if (it.bkorg) {
      const firms = splitInstitutions(it.bkorg);
      if (!firms.length) continue;
      rows.push(compact({ n: clipText(plain(it.bkorg), 200), c: firms, t: 'entity', ...base }));
    }
  }
  if (!rows.length) throw new Error('The Federal Reserve files had no entries that could be read');
  const updated = (recent.find((x) => x && x.updateDate) || {}).updateDate || null;
  return { v: 1, key: 'frb', at: new Date().toISOString(), ...(updated ? { asOf: updated } : {}), rows };
}

const loadFrb = (deadline) => cached('enforcement:frb:v1', DAY_MS, async () => {
  const [recent, old] = await Promise.all(FRB_FILES.map((url) => request(url, { deadline, timeoutMs: 15000, accept: 'application/json' })));
  return parseFrb(recent.text, old.text);
});

async function screenFrb(task, ctx) {
  const name = oneLine(task.value);
  const index = await loadFrb(ctx.deadline);
  const hits = screenRows(index, searchedNames(task, ctx), isPersonTask(task) ? 'person' : 'company');
  const findings = [];
  const threads = [];
  for (const { row, matched } of hits.slice(0, MAX_FINDINGS)) {
    const who = row.t === 'person' ? row.n : matched;
    const f = graded(task, ctx, {
      source: BANK_ID, sourceLabel: BANK_LABEL, category: 'regulatory', severity: actionSeverity(row.k),
      title: `${aboutPrefix(task)}Federal Reserve ${row.k}: ${who}${row.o ? ` (${clipText(row.o, 80)})` : ''}`,
      quote: [
        `${row.t === 'person' ? 'Individual' : 'Banking organization'}: ${row.n}`,
        row.a?.length ? `Also known as: ${row.a.join('; ')}` : '',
        row.o ? `Banking organization: ${row.o}` : '',
        `Action: ${row.k}`,
        row.d ? `Effective: ${row.d}` : '',
        row.e ? `Terminated: ${row.e}` : '',
      ].filter(Boolean).join(' | '),
      url: row.u,
      date: row.d || null,
      data: { agency: 'Federal Reserve', action: row.k, institution: row.o || null, searched: name, listReadAt: index.at, ...(index.asOf ? { listDated: index.asOf } : {}) },
    }, [row.o, row.k].filter(Boolean).join('. '));
    if (!f) continue;
    findings.push(f);
    const t = institutionThread(task, f, row.o, 'named with the person in a Federal Reserve enforcement action');
    if (t) threads.push(t);
  }
  const notes = hits.length ? [] : [`Federal Reserve enforcement actions: no match for ${name}`];
  if (hits.length > MAX_FINDINGS) notes.push(`Federal Reserve enforcement actions: ${hits.length} actions match the name ${name}; the first ${MAX_FINDINGS} are shown`);
  return { findings, threads, notes };
}

/* ---- OCC ---- */

const OCC_SEARCH = 'https://apps.occ.gov/EASearch/api/WebSearch/Actions';
const OCC_PAGE = 'https://apps.occ.gov/EASearch/Search';
const OCC_PDF = 'https://www.occ.gov/static/enforcement-actions/ea';
const OCC_PAGE_SIZE = 100;
export const OCC_NOTE = 'OCC: prohibition notifications issued before 23 December 2022 under 12 USC 1829 are not published, by law.';

const usd = (n) => (Number(n) > 0 ? `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '');

async function screenOcc(task, ctx) {
  const name = oneLine(task.value);
  const person = isPersonTask(task);
  const variants = searchedNames(task, ctx);
  const q = person ? coreName(variants) : companyTokens(firmCore(name)).join(' ');
  const url = `${OCC_SEARCH}?q=${encodeURIComponent(q)}&srt=1&pg=1&pgsz=${OCC_PAGE_SIZE}`;
  const { text } = await request(url, { deadline: ctx.deadline, timeoutMs: 12000, accept: 'application/json' });
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error('The OCC enforcement action search did not return a result'); }
  if (!Array.isArray(rows)) throw new Error('The OCC enforcement action search did not return a result');
  // One docket can carry several actions (a removal order and a penalty): one finding per person and docket.
  const groups = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const individual = /individual/i.test(r.EnforcementInstIAPType || '');
    let tier = 0;
    let listed = '';
    if (person) {
      if (!individual) continue;
      listed = personNameForms(`${oneLine(r.FirstName)} ${oneLine(r.LastName)}`).name;
      tier = matchPersonName(variants, listed);
    } else {
      if (individual) continue;
      listed = [oneLine(r.CompanyName), oneLine(r.BankName)].find((x) => x && sameFirm(name, x)) || '';
      tier = listed ? 1 : 0;
    }
    if (!tier) continue;
    const key = `${normalizeName(listed)}|${oneLine(r.DocketNumber) || oneLine(r.DocumentNumber)}`;
    const g = groups.get(key) || { listed, tier, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const findings = [];
  const threads = [];
  const sorted = [...groups.values()].sort((a, b) => a.tier - b.tier || String(b.rows[0].CompleteDate).localeCompare(String(a.rows[0].CompleteDate)));
  for (const g of sorted.slice(0, MAX_FINDINGS)) {
    const first = g.rows[0];
    const bank = oneLine(first.BankName) || oneLine(first.CompanyName);
    const actions = [...new Set(g.rows.map((r) => [oneLine(r.EnforcementTypeDescription), usd(r.Amount)].filter(Boolean).join(' ')))];
    const doc = g.rows.map((r) => oneLine(r.DocumentNumber)).find((d) => /^[A-Za-z0-9-]{3,40}$/.test(d) && g.rows.some((r) => r.HasPdf));
    const date = (oneLine(first.CompleteDate).match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || null;
    const ended = (oneLine(first.TerminationDate).match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || '';
    const subjects = oneLine(first.SubjectMatterAssociations).split('|').map(oneLine).filter(Boolean);
    const f = graded(task, ctx, {
      source: BANK_ID, sourceLabel: BANK_LABEL, category: 'regulatory', severity: actionSeverity(actions.join(' ')),
      title: `${aboutPrefix(task)}OCC ${actions[0]}${actions.length > 1 ? ` and ${actions.length - 1} more` : ''}: ${g.listed}${person && bank ? ` (${bank})` : ''}`,
      quote: [
        `${person ? 'Individual' : 'Institution'}: ${g.listed}`,
        person && bank ? `Bank: ${bank}` : '',
        `Actions: ${actions.join('; ')}`,
        first.DocketNumber ? `Docket: ${oneLine(first.DocketNumber)}` : '',
        date ? `Completed: ${date}` : '',
        ended ? `Terminated: ${ended}` : '',
        subjects.length ? `Subject matters: ${subjects.slice(0, 8).join('; ')}` : '',
      ].filter(Boolean).join(' | '),
      url: doc ? `${OCC_PDF}${doc}.pdf` : `${OCC_PAGE}?q=${encodeURIComponent(q)}`,
      date,
      data: { agency: 'OCC', actions, docket: oneLine(first.DocketNumber) || null, institution: bank || null, searched: name },
    }, [bank, subjects.join('. ')].filter(Boolean).join('. '));
    if (!f) continue;
    findings.push(f);
    const t = institutionThread(task, f, bank, 'named with the person in an OCC enforcement action');
    if (t) threads.push(t);
  }
  const notes = [];
  if (person) notes.push(OCC_NOTE);
  if (!groups.size) notes.push(`OCC enforcement actions: no match for ${name}`);
  if (groups.size > MAX_FINDINGS) notes.push(`OCC enforcement actions: ${groups.size} matching records; the first ${MAX_FINDINGS} are shown`);
  const partial = rows.length >= OCC_PAGE_SIZE ? [`OCC enforcement actions (more than ${OCC_PAGE_SIZE} actions carry the words of the name; the first ${OCC_PAGE_SIZE} were read)`] : null;
  return { findings, threads, notes, ...(partial ? { partial } : {}) };
}

/* ---- NCUA ---- */

const NCUA_CSV = 'https://ncua.gov/sites/default/files/list_csv/administrative-orders.csv';
export const NCUA_PAGE = 'https://ncua.gov/news/enforcement-actions/administrative-orders';

/** Build the compact index from the NCUA administrative orders CSV. */
export function parseNcua(text) {
  let col = null;
  const rows = [];
  eachCsvRow(String(text), (f) => {
    if (!col) {
      col = Object.fromEntries(f.map((h, i) => [oneLine(h).toLowerCase(), i]));
      for (const need of ['docket number', 'first name', 'last name', 'institution', 'url']) if (col[need] == null) throw new Error('The NCUA list file is not in the expected format');
      return;
    }
    const get = (k) => oneLine(f[col[k]]);
    const first = get('first name');
    const last = get('last name');
    const link = get('url');
    const u = /^https:\/\/(?:www\.)?ncua\.gov\//.test(link) ? link : NCUA_PAGE;
    const institution = get('institution');
    const base = { i: get('docket number'), y: /^\d{4}$/.test(get('year')) ? get('year') : '', o: clipText(institution, 140), u };
    if (last && !/^n\/?a$/i.test(last)) {
      const { name } = personNameForms(`${first} ${last}`);
      if (!name || !isLatin(name)) return;
      const role = get('relationship');
      rows.push(compact({ n: name, t: 'person', r: /^n\/?a$/i.test(role) ? '' : clipText(role, 80), ...base }));
    } else if (first || institution) {
      const n = first || institution;
      if (!isLatin(n)) return;
      rows.push(compact({ n, t: 'entity', ...base, s: get('state').slice(0, 2) }));
    }
  });
  if (rows.length < 100) throw new Error('The NCUA list file had too few entries to be the whole list');
  return { v: 1, key: 'ncua', at: new Date().toISOString(), rows };
}

const loadNcua = (deadline) => cached('enforcement:ncua:v1', DAY_MS, async () => parseNcua((await request(NCUA_CSV, { deadline, timeoutMs: 15000, accept: 'text/csv' })).text));

async function screenNcua(task, ctx) {
  const name = oneLine(task.value);
  const index = await loadNcua(ctx.deadline);
  const hits = screenRows(index, searchedNames(task, ctx), isPersonTask(task) ? 'person' : 'company');
  const findings = [];
  const threads = [];
  for (const { row } of hits.slice(0, MAX_FINDINGS)) {
    const f = graded(task, ctx, {
      source: BANK_ID, sourceLabel: BANK_LABEL, category: 'regulatory', severity: row.t === 'person' ? 'high' : 'medium',
      title: `${aboutPrefix(task)}NCUA administrative order: ${row.n}${row.t === 'person' && row.o ? ` (${row.o})` : ''}`,
      quote: [
        `${row.t === 'person' ? 'Individual' : 'Credit union'}: ${row.n}`,
        row.t === 'person' && row.o ? `Credit union: ${row.o}` : '',
        row.r ? `Relationship: ${row.r}` : '',
        row.t !== 'person' && row.s ? `State: ${row.s}` : '',
        row.i ? `Docket: ${row.i}` : '',
        row.y ? `Year: ${row.y}` : '',
      ].filter(Boolean).join(' | '),
      url: row.u,
      date: row.y || null,
      data: { agency: 'NCUA', docket: row.i || null, institution: row.o || null, searched: name, listReadAt: index.at },
    }, [row.o, row.r].filter(Boolean).join('. '));
    if (!f) continue;
    findings.push(f);
    const t = institutionThread(task, f, row.o, 'named with the person in an NCUA administrative order');
    if (t) threads.push(t);
  }
  const notes = hits.length ? [] : [`NCUA administrative orders: no match for ${name}`];
  if (hits.length > MAX_FINDINGS) notes.push(`NCUA administrative orders: ${hits.length} orders match the name ${name}; the first ${MAX_FINDINGS} are shown`);
  return { findings, threads, notes };
}

const BANK_LISTS = [
  { key: 'frb', name: 'Federal Reserve enforcement actions', run: screenFrb },
  { key: 'occ', name: 'OCC enforcement actions', run: screenOcc },
  { key: 'ncua', name: 'NCUA administrative orders', run: screenNcua },
];
const BANK_ALL = 'bank.all';

export const usBankRegulatorsConnector = {
  id: BANK_ID,
  label: BANK_LABEL,
  kinds: ['subject', 'company', 'associate', 'relative'],
  prior: 0.3,
  timeoutMs: 20000,
  /** The person and their companies get one lookup per regulator; associates and relatives one lookup for all three. */
  plan(thread) {
    if (thread?.kind === 'subject' || thread?.kind === 'company') return BANK_LISTS.map((l) => ({ template: `bank.${l.key}`, prior: 0.3, why: `screen the name against the ${l.name}` }));
    return [{ template: BANK_ALL, prior: 0.3, why: 'screen the name against the US bank regulators\' enforcement actions' }];
  },
  async run(task, ctx) {
    if (!canScreen(task, ctx)) return tooShort(BANK_LABEL, task);
    const wanted = String(task.template || BANK_ALL);
    if (wanted !== BANK_ALL) {
      const list = BANK_LISTS.find((l) => `bank.${l.key}` === wanted);
      if (!list) throw new Error(`Unknown bank regulator list: ${wanted}`);
      return list.run(task, ctx);
    }
    const results = await Promise.allSettled(BANK_LISTS.map((l) => l.run(task, ctx)));
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    const out = { findings: [], threads: [], notes: [], partial: [] };
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        out.notes.push(`${BANK_LISTS[i].name}: could not be read, so ${oneLine(task.value)} was not screened against it`);
        out.partial.push(BANK_LISTS[i].name);
        return;
      }
      out.findings.push(...r.value.findings);
      out.threads.push(...r.value.threads);
      out.notes.push(...r.value.notes);
      if (r.value.partial) out.partial.push(...r.value.partial);
    });
    if (!out.partial.length) delete out.partial;
    return out;
  },
};

/* ------------------------------------------------------------------ */
/* 3. FinCEN enforcement actions                                       */
/* ------------------------------------------------------------------ */

const FINCEN_ID = 'fincen-actions';
const FINCEN_LABEL = 'FinCEN enforcement actions (US anti-money-laundering regulator)';
const FINCEN = 'https://www.fincen.gov';
export const FINCEN_PAGE = `${FINCEN}/news/enforcement-actions/`;

/** The parties of a FinCEN action title: "In the Matter of Larry Dean Harmon d/b/a Helix" -> [Larry Dean Harmon, Helix]. */
export function fincenParties(title) {
  const t = oneLine(title).replace(/^in the matter of\s+(?:the\s+)?/i, '');
  const pieces = t.split(/\s+(?:d\/b\/a|dba|a\/k\/a|aka)\s+|\s*;\s*|,?\s+et\.?\s*al\.?,?\s*|\s+and\s+/i).map((p) => oneLine(p).replace(/^[,\s]+|[,\s]+$/g, '')).filter(Boolean);
  const out = new Set([t]);
  pieces.forEach((p, i) => {
    out.add(p);
    if (i + 1 < pieces.length) out.add(`${p} and ${pieces[i + 1]}`);
  });
  return [...out].filter(isLatin);
}

/** Build the compact index from FinCEN's enforcement actions page. */
export function parseFincen(html) {
  const rows = [];
  for (const m of String(html).matchAll(/<tr\b[^>]*data-date=["']?(\d{4}-\d{2}-\d{2})[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cell = (cls) => (m[2].match(new RegExp(`<td[^>]*views-field-${cls}[^>]*>([\\s\\S]*?)</td>`, 'i')) || [])[1] || '';
    const titleCell = cell('title');
    const title = plain(titleCell);
    if (!title) continue;
    const href = (titleCell.match(/href=["']?([^"'\s>]+)/i) || [])[1] || '';
    const u = /^https?:\/\//i.test(href) ? href : href.startsWith('/') ? `${FINCEN}${href}` : FINCEN_PAGE;
    const parties = fincenParties(title);
    // the parties serve as aliases for a person and as names for a company (screenRows reads both)
    rows.push(compact({ n: title, a: parties.filter((p) => p !== title).slice(0, 12), t: '', d: m[1], i: plain(cell('field-matter-no')), k: plain(cell('field-tags-financial-institution')), u }));
  }
  if (rows.length < 50) throw new Error('The FinCEN enforcement actions page did not list the actions');
  return { v: 1, key: 'fincen', at: new Date().toISOString(), rows };
}

const loadFincen = (deadline) => cached('enforcement:fincen:v1', DAY_MS, async () => parseFincen((await request(FINCEN_PAGE, { deadline, timeoutMs: 15000, accept: 'text/html' })).text));

export const fincenActionsConnector = {
  id: FINCEN_ID,
  label: FINCEN_LABEL,
  kinds: ['subject', 'company', 'associate', 'relative'],
  prior: 0.25,
  timeoutMs: 18000,
  plan() {
    return [{ template: 'fincen.actions', prior: 0.25, why: 'screen the name against FinCEN\'s enforcement actions' }];
  },
  async run(task, ctx) {
    if (!canScreen(task, ctx)) return tooShort(FINCEN_LABEL, task);
    const name = oneLine(task.value);
    const index = await loadFincen(ctx.deadline);
    const hits = screenRows(index, searchedNames(task, ctx), isPersonTask(task) ? 'person' : 'company');
    const findings = hits.slice(0, MAX_FINDINGS).map(({ row }) => graded(task, ctx, {
      source: FINCEN_ID, sourceLabel: FINCEN_LABEL, category: 'regulatory', severity: actionSeverity(row.n),
      title: `${aboutPrefix(task)}FinCEN enforcement action: ${row.n}`,
      quote: [
        `Action: ${row.n}`,
        row.i ? `Matter number: ${row.i}` : '',
        row.k ? `Financial institution type: ${row.k}` : '',
        `Released: ${row.d}`,
      ].filter(Boolean).join(' | '),
      url: row.u,
      date: row.d,
      data: { agency: 'FinCEN', matter: row.i || null, institutionType: row.k || null, searched: name, listReadAt: index.at },
    }, [row.n, row.k].filter(Boolean).join('. '))).filter(Boolean);
    const notes = hits.length ? [] : [`FinCEN enforcement actions: no match for ${name}`];
    if (hits.length > MAX_FINDINGS) notes.push(`FinCEN enforcement actions: ${hits.length} actions match the name ${name}; the first ${MAX_FINDINGS} are shown`);
    return { findings, threads: [], notes };
  },
};
