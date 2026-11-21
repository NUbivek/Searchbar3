/**
 * Australia's register of banned and disqualified persons and organisations,
 * kept by ASIC (the Australian Securities and Investments Commission). One
 * source, two lists:
 *
 *   persons        people disqualified from managing corporations, banned
 *                  from financial services, credit, securities or futures
 *                  dealing, or disqualified as a self-managed super fund
 *                  trustee (about 7,200 entries, 1.1 MB)
 *   organisations  firms banned from financial services or credit (a short
 *                  list)
 *
 * ASIC publishes both on data.gov.au under Creative Commons Attribution 3.0
 * Australia, refreshed monthly. The current file's address is read from the
 * catalogue's documented data interface (CKAN package_show), then the
 * tab-separated file is downloaded whole, at most once a day per list, and
 * kept as a compact index.
 *
 * OFF BY DEFAULT. data.gov.au's robots.txt disallows every automated reader,
 * although the same data is published under an open licence through that
 * documented interface. The source runs only when FOUNDER_SOURCES_ON (comma-
 * separated ids) contains 'asic-banned', and FOUNDER_SOURCES_OFF still switches
 * it off. The owner decides.
 *
 * Matching. A person is matched on their full name only (first and last name,
 * in order, through the sanctions screens' strict matcher); a variant of the
 * name (a nickname, another spelling) is always 'possible'. The register gives
 * nothing but the name, the kind of ban, dates and sometimes a comment, so a
 * hit is 'possible' with "verify identity" in its title unless the comment
 * names the company the check was started with; even then it is 'likely' at
 * most. No grade here is ever 'confirmed'. Associates and relatives are
 * screened by name and stay 'possible' unless the record also names the
 * subject. A company is matched by its whole name once the legal form is
 * removed, under every known name of the company; a match on a one-word name
 * (an ordinary word such as "Flow" above all) stays 'possible'.
 *
 * Privacy. Never read or kept: the suburb, postcode and street of a person,
 * the ASIC document number, the organisation's company number. A person's
 * state (NSW, VIC, ...) is kept only to help rule a namesake out.
 */
import { request, getJson, htmlToText } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { isOrdinaryWordCompany, companyMention } from '../names';
import { nameTokens, companyTokens, screenNames, gradeListedPerson, normalizeName } from './sanctions';
import { withAliasHold } from './alias';
import { screenRows, personNameForms, firmNameForms } from './debarment';

export const ASIC_ID = 'asic-banned';
export const ASIC_LABEL = 'Australian register of banned and disqualified persons and organisations (ASIC)';
export const ASIC_OFF_REASON = 'not enabled on this deployment';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 6;
const MAX_BYTES = 6 * 1024 * 1024;

const CKAN = 'https://data.gov.au/data/api/3/action/package_show?id=';
export const PERSONS_PAGE = 'https://data.gov.au/data/dataset/asic-banned-disqualified-per';
export const ORGS_PAGE = 'https://data.gov.au/data/dataset/asic-banned-disqualified-org';

const PERSON_COLUMNS = ['REGISTER_NAME', 'BD_PER_NAME', 'BD_PER_TYPE', 'BD_PER_DOC_NUM', 'BD_PER_START_DT', 'BD_PER_END_DT', 'BD_PER_ADD_LOCAL', 'BD_PER_ADD_STATE', 'BD_PER_ADD_PCODE', 'BD_PER_ADD_COUNTRY', 'BD_PER_COMMENTS'];
const ORG_COLUMNS = ['REGISTER_NAME', 'BD_ORG_ACN', 'BD_ORG_NAME', 'BD_ORG_TYPE', 'BD_ORG_URL', 'BD_ORG_START_DT', 'BD_ORG_END_DT', 'BD_ORG_COMMENT'];

const LISTS = {
  persons: { dataset: 'asic-banned-disqualified-per', page: PERSONS_PAGE, columns: PERSON_COLUMNS, min: 3000, key: 'asic:banned:persons:v1', name: 'ASIC banned and disqualified persons' },
  orgs: { dataset: 'asic-banned-disqualified-org', page: ORGS_PAGE, columns: ORG_COLUMNS, min: 5, key: 'asic:banned:orgs:v1', name: 'ASIC banned and disqualified organisations' },
};

const AU_STATES = new Set(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']);

/** The register's own codes, in words. */
const BAN_TYPES = [
  [/^disq\.? director/i, 'Disqualified from managing corporations'],
  [/^afs banned/i, 'Banned from providing financial services'],
  [/^credit banned/i, 'Banned from engaging in credit activities'],
  [/^banned securities/i, 'Banned from securities dealing'],
  [/^banned futures/i, 'Banned from futures dealing'],
  [/^disqualified smsf/i, 'Disqualified from acting as a self-managed super fund trustee'],
];
export const banText = (type) => {
  const t = oneLineOf(type);
  const hit = BAN_TYPES.find(([re]) => re.test(t));
  return hit ? hit[1] : t;
};

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

function oneLineOf(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
const oneLine = oneLineOf;
const clipText = (s, n) => {
  const str = oneLine(s);
  if (str.length <= n) return str;
  const cut = str.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '')}…`;
};
const capitalise = (s) => String(s || '').replace(/^\s*([a-z])/, (m, c) => c.toUpperCase());
const properCase = (s) => oneLine(s).toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const isFullName = (tokens) => tokens.filter((t) => t.length > 1).length >= 2;
const listed = (name, id) => String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean).includes(id);
const isOn = () => listed('FOUNDER_SOURCES_ON', ASIC_ID) && !listed('FOUNDER_SOURCES_OFF', ASIC_ID);

/** dd/mm/yyyy -> yyyy-mm-dd ('' when it is not a date). */
export const auDate = (s) => {
  const m = oneLine(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};

/** "ABBOTT, BILL JOHN" -> "BILL JOHN ABBOTT" (the register writes surname first). */
export function givenFirst(raw) {
  const s = oneLine(raw);
  const i = s.indexOf(',');
  if (i < 0) return s;
  return oneLine(`${s.slice(i + 1)} ${s.slice(0, i)}`);
}

/** The register's comment: HTML removed, "No comment made" dropped, clipped. */
const commentOf = (s) => {
  const t = oneLine(htmlToText(String(s ?? '')));
  return /^no comment made\.?$/i.test(t) ? '' : clipText(t, 300);
};

const compact = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== '' && v != null && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out;
};

/* ------------------------------------------------------------------ */
/* Reading the files                                                   */
/* ------------------------------------------------------------------ */

/** Rows of a tab-separated file, checked against the expected header. A reshaped file throws. */
function tsvRows(text, columns, what) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const header = (lines.shift() || '').split('\t').map((h) => h.trim().toUpperCase());
  if (header.length !== columns.length || columns.some((c, i) => header[i] !== c)) throw new Error(`The ${what} file is not in the expected format`);
  const rows = [];
  let bad = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length !== columns.length) { bad += 1; continue; }
    rows.push(Object.fromEntries(columns.map((c, i) => [c, f[i]])));
  }
  if (bad > Math.max(5, rows.length * 0.02)) throw new Error(`The ${what} file is not in the expected format`);
  return rows;
}

/**
 * Build the compact index of the persons file. Kept per row: n the name (given name first), t 'person', k the ban
 * type, d start, e end (a date or the register's words), s the state, c the comment. The suburb, postcode and
 * document number are never read into the index.
 */
export function parsePersons(text, { asOf = '' } = {}) {
  const rows = [];
  for (const r of tsvRows(text, PERSON_COLUMNS, LISTS.persons.name)) {
    const { name, aliases } = personNameForms(givenFirst(r.BD_PER_NAME));
    if (!name || normalizeName(name).length < 2) continue;
    const state = oneLine(r.BD_PER_ADD_STATE).toUpperCase();
    rows.push(compact({
      n: name,
      a: aliases,
      t: 'person',
      k: clipText(r.BD_PER_TYPE, 60),
      d: auDate(r.BD_PER_START_DT),
      e: auDate(r.BD_PER_END_DT) || clipText(r.BD_PER_END_DT, 40),
      s: AU_STATES.has(state) ? state : '',
      c: commentOf(r.BD_PER_COMMENTS),
    }));
  }
  if (rows.length < LISTS.persons.min) throw new Error(`The ${LISTS.persons.name} file had too few entries to be the whole register`);
  return { v: 1, key: 'asic-persons', at: new Date().toISOString(), ...(asOf ? { asOf } : {}), rows };
}

/** Build the compact index of the organisations file (the company number is not kept). */
export function parseOrgs(text, { asOf = '' } = {}) {
  const rows = [];
  for (const r of tsvRows(text, ORG_COLUMNS, LISTS.orgs.name)) {
    const forms = firmNameForms(r.BD_ORG_NAME);
    if (!forms.name || normalizeName(forms.name).length < 2) continue;
    const link = oneLine(r.BD_ORG_URL);
    rows.push(compact({
      n: forms.name,
      a: forms.aliases,
      t: 'entity',
      k: clipText(r.BD_ORG_TYPE, 80),
      d: auDate(r.BD_ORG_START_DT),
      e: auDate(r.BD_ORG_END_DT) || clipText(r.BD_ORG_END_DT, 40),
      c: commentOf(r.BD_ORG_COMMENT),
      u: /^https?:\/\/(?:www\.)?asic\.gov\.au\//i.test(link) ? link.replace(/^http:/i, 'https:') : '',
    }));
  }
  if (rows.length < LISTS.orgs.min) throw new Error(`The ${LISTS.orgs.name} file had too few entries to be the whole register`);
  return { v: 1, key: 'asic-orgs', at: new Date().toISOString(), ...(asOf ? { asOf } : {}), rows };
}

/**
 * The current tab-separated file of a dataset, from the catalogue's package_show answer. A changed catalogue
 * (no current TSV file, a file outside data.gov.au) throws.
 */
export function currentFile(pkg, what) {
  const resources = pkg && pkg.success && pkg.result && Array.isArray(pkg.result.resources) ? pkg.result.resources : null;
  if (!resources) throw new Error(`The ${what} catalogue entry is not in the expected format`);
  const tsv = resources.filter((r) => r && /^tsv$/i.test(oneLine(r.format)) && /^https:\/\/data\.gov\.au\//i.test(oneLine(r.url)));
  const pick = tsv.find((r) => /current/i.test(oneLine(r.name))) || (tsv.length === 1 ? tsv[0] : null);
  if (!pick) throw new Error(`The ${what} catalogue entry lists no current file`);
  const asOf = (oneLine(pick.last_modified || pick.created || '').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];
  return { url: oneLine(pick.url), asOf };
}

async function loadIndex(which, deadline) {
  const list = LISTS[which];
  const entry = await cachedEntry(list.key, DAY_MS, async ({ deadline: d }) => {
    const pkg = await getJson(`${CKAN}${list.dataset}`, { deadline: d, timeoutMs: 15000, maxBytes: 512 * 1024 });
    const file = currentFile(pkg, list.name);
    const { text } = await request(file.url, { deadline: d, timeoutMs: 20000, maxBytes: MAX_BYTES, accept: 'text/tab-separated-values,text/plain,*/*' });
    return which === 'persons' ? parsePersons(text, { asOf: file.asOf }) : parseOrgs(text, { asOf: file.asOf });
  }, { deadline });
  const at = Number(entry.at) || Date.parse(entry.value?.at || '') || Date.now();
  return { index: entry.value, at, fresh: entry.fresh !== false, asOf: new Date(at).toISOString().slice(0, 10) };
}

/* ------------------------------------------------------------------ */
/* Grading                                                             */
/* ------------------------------------------------------------------ */

const isPersonTask = (task) => task.kind !== 'company';

/** 'likely' at most: a grade of 'confirmed' from the shared graders is held one step lower. */
function capLikely(subject, f, finding) {
  if (!finding || finding.match !== 'confirmed') return finding;
  return makeFinding(subject, {
    ...f,
    match: 'likely',
    matchReasons: [...(finding.matchReasons || []).slice(0, 3), 'a register entry gives only a name and a ban, so it is held at likely'],
  });
}

function graded(task, ctx, f, { tier, via, context }) {
  const subject = ctx.subject;
  if (task.kind === 'company') {
    const name = via || task.value;
    if (companyTokens(name).length < 2) {
      const ordinary = isOrdinaryWordCompany(name);
      return makeFinding(subject, {
        ...f,
        title: `${f.title}: name match only, verify identity`,
        match: 'possible',
        matchReasons: [ordinary
          ? 'the company name is one ordinary word; many unrelated companies share it'
          : 'only the company name\'s one distinctive word matches; many unrelated companies share a one-word name'],
      });
    }
    return makeFinding(subject, { ...f, match: 'company', matchReasons: ['the listed name is the same as the company name'] });
  }
  if (task.kind === 'associate' || task.kind === 'relative') {
    const reason = `name match on ${task.kind === 'relative' ? 'a relative' : 'an associate'} of the subject`;
    const named = makeFinding(subject, f);
    if (named) return capLikely(subject, f, named);
    return makeFinding(subject, { ...f, title: `${f.title}: name match only, verify identity`, match: 'possible', matchReasons: [reason] });
  }
  const finding = gradeListedPerson(subject, f, { tier, context, possibleTitle: `${f.title}: name match only, verify identity` });
  return capLikely(subject, f, finding);
}

const aboutPrefix = (task) => (task.kind === 'associate' || task.kind === 'relative'
  ? `${capitalise(task.relation || (task.kind === 'relative' ? 'relative' : 'associate'))} ${oneLine(task.value)}: `
  : '');

/** An end date already past: the ban has ended (still on the register, no longer in force). */
const endedOn = (row) => (/^\d{4}-\d{2}-\d{2}$/.test(row.e || '') && row.e < new Date().toISOString().slice(0, 10) ? row.e : '');

function personFinding(task, ctx, hit, copy) {
  const { row, tier, matched } = hit;
  const ban = banText(row.k);
  const ended = endedOn(row);
  const who = properCase(row.n);
  const f = {
    source: ASIC_ID, sourceLabel: ASIC_LABEL, category: 'regulatory',
    severity: ended ? 'medium' : 'high',
    title: `${aboutPrefix(task)}${ended ? `Formerly ${ban.charAt(0).toLowerCase()}${ban.slice(1)} in Australia (ended ${ended})` : `${ban} in Australia`}: ${who}`,
    quote: [
      `Listed name: ${row.n}`,
      matched && matched !== row.n ? `Also listed as: ${matched}` : '',
      `Register: ASIC banned and disqualified persons`,
      `Type: ${row.k}`,
      row.d ? `Start: ${row.d}` : '',
      row.e ? `End: ${row.e}` : 'End: none given',
      row.s ? `State: ${row.s}` : '',
      row.c ? `Comment: ${row.c}` : '',
    ].filter(Boolean).join(' | '),
    url: PERSONS_PAGE,
    date: row.d || null,
    data: { register: 'ASIC banned and disqualified persons', banType: row.k, searched: oneLine(task.value), tier, listReadAt: new Date(copy.at).toISOString(), ...(copy.index.asOf ? { listDated: copy.index.asOf } : {}), ...(ended ? { ended } : {}) },
  };
  return graded(task, ctx, f, { tier, context: [row.c, ban].filter(Boolean).join('. ') });
}

function orgFinding(task, ctx, hit, copy) {
  const { row, via, matched } = hit;
  const ended = endedOn(row);
  const f = {
    source: ASIC_ID, sourceLabel: ASIC_LABEL, category: 'regulatory',
    severity: ended ? 'medium' : 'high',
    title: `${ended ? `Formerly banned in Australia (ended ${ended})` : 'Banned in Australia'}: ${row.n}`,
    quote: [
      `Listed name: ${row.n}`,
      matched && matched !== row.n ? `Also listed as: ${matched}` : '',
      'Register: ASIC banned and disqualified organisations',
      `Type: ${row.k}`,
      row.d ? `Start: ${row.d}` : '',
      row.e ? `End: ${row.e}` : 'End: none given',
      row.c ? `Comment: ${row.c}` : '',
    ].filter(Boolean).join(' | '),
    url: row.u || ORGS_PAGE,
    date: row.d || null,
    data: { register: 'ASIC banned and disqualified organisations', banType: row.k, searched: oneLine(task.value), listReadAt: new Date(copy.at).toISOString(), ...(copy.index.asOf ? { listDated: copy.index.asOf } : {}), ...(ended ? { ended } : {}) },
  };
  return graded(task, ctx, f, { via });
}

/* ------------------------------------------------------------------ */
/* The source                                                          */
/* ------------------------------------------------------------------ */

const asOfText = (copy) => (copy?.index?.asOf ? ` (register file of ${copy.index.asOf})` : copy?.asOf ? ` (list as of ${copy.asOf})` : '');

export const asicBannedConnector = {
  id: ASIC_ID,
  label: ASIC_LABEL,
  // 'alias': another name of the person, screened like their own name (alias.js holds the grade)
  kinds: ['subject', 'alias', 'company', 'associate', 'relative'],
  prior: 0.15,
  timeoutMs: 25000,
  enabled: () => isOn(),
  unavailableReason: ASIC_OFF_REASON,
  plan() {
    return [{ template: 'asic.banned', prior: 0.15, why: 'screen the name against Australia\'s register of banned and disqualified persons and organisations' }];
  },
  async run(task, ctx) {
    const name = oneLine(task.value);
    if (!isOn()) {
      return { findings: [], threads: [], notes: [`${ASIC_LABEL}: ${ASIC_OFF_REASON}, so ${name} was not screened`], partial: [`${ASIC_LABEL}: ${ASIC_OFF_REASON}`] };
    }
    const person = isPersonTask(task);
    const names = screenNames(task, ctx);
    const screenable = person
      ? names.some((v) => isFullName(nameTokens(v)))
      : names.some((n) => companyTokens(n).join('').length >= 3);
    if (!screenable) {
      return {
        findings: [], threads: [],
        notes: [`${ASIC_LABEL}: "${name}" is too short a name to screen, so it was not looked up`],
        partial: [`${name.slice(0, 40)}: name too short to screen`],
      };
    }
    const which = person ? 'persons' : 'orgs';
    const copy = await loadIndex(which, ctx.deadline);
    // A company hit must also be one the shared company matcher reads as that company's name (a register name
    // carries its legal form, so an ordinary word written as a company name still counts, and is then held below)
    const hits = screenRows(copy.index, names, person ? 'person' : 'company')
      .filter((h) => person || companyMention(h.via || name, h.matched || h.row.n).named);
    const findings = hits.slice(0, MAX_FINDINGS)
      .map((h) => (person ? personFinding(task, ctx, h, copy) : orgFinding(task, ctx, h, copy)))
      .filter(Boolean);
    const notes = [];
    const listName = LISTS[which].name;
    if (!hits.length) {
      notes.push(`${listName}: searched for ${name}${asOfText(copy)} and found no entry. This covers bans and disqualifications by Australia's corporate regulator only.`);
    } else if (hits.length > MAX_FINDINGS) {
      notes.push(`${listName}: ${hits.length} entries match the name ${name}; the first ${MAX_FINDINGS} are shown`);
    }
    if (hits.length && person) notes.push(`${listName}: the register gives only a name, the kind of ban, dates and the state, so a match may be someone else with the same name`);
    const out = { findings, threads: [], notes };
    if (!copy.fresh) {
      out.notes.push(`${listName}: the latest copy could not be downloaded, so the copy of ${copy.asOf} was screened`);
      out.partial = [`${listName}: list as of ${copy.asOf}`];
    }
    return out;
  },
};

// A record found only under another name of the person the user did not type is 'likely' at most (alias.js).
asicBannedConnector.run = withAliasHold(asicBannedConnector.run);
