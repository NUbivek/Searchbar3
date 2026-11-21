/**
 * Three national company registers that are worth asking only about a
 * company that plausibly belongs to their country:
 *
 *   no-company-register  Norway's Register of Business Enterprises (Brønnøysund
 *                        Register Centre, open data under NLOD 2.0): a company's
 *                        founding date, earlier names, bankruptcy and winding-up
 *                        flags, and its current officers (chief executive, board
 *                        chair and members, auditor). Current roles only: the
 *                        open register keeps no past officers.
 *   cz-company-register  The Czech public register extract served by ARES (the
 *                        Ministry of Finance's register of economic subjects): a
 *                        company's status, legal form and founding date, and every
 *                        member of its statutory body and supervisory board with
 *                        the dates each membership started and ended.
 *   fi-trade-register    The Finnish Trade Register (PRH open data, CC BY 4.0):
 *                        business ID, registration date, every name the company
 *                        has had, legal form, main line of business, website and
 *                        situations such as bankruptcy or liquidation. It lists no
 *                        people.
 *
 * When each one is asked. All three work on a company thread. A US startup
 * should not cost three foreign lookups, so plan() asks a register only when
 * something places the company in its country: a national legal form in the
 * name ("Nikola AS", "Nikola s.r.o.", "Nikola Oy"), a national word in why the
 * company is being looked at ("Norwegian company where ..."), or a national web
 * address for it (nikola.no). The company the user gave gets one more chance:
 * its lookup runs late, and run() then also reads the records found so far (a
 * tied LEI record with that country's jurisdiction, a tied reference entry
 * placing the person there, the company's own site on that country's domain).
 * When nothing does, run() asks nothing and says so in a note. Other companies
 * with no such sign are not planned at all.
 *
 * Identity. None of these registers can be searched by a person's name, so the
 * person is looked for among the officers of a company found under its exact
 * name (legal form set aside, through the sanctions screens' company matcher).
 * An officer is the person only when the first and last name match in order
 * (the sanctions screens' person matcher; middle names allowed). Such a record
 * is 'likely' when the company is already tied to the person (the company
 * given, or one the check has confirmed), and otherwise 'possible', titled
 * "name match only, verify identity". No record here is ever 'confirmed'. A
 * company record is 'company' only when the person is among its officers, or
 * when one entity alone carries the exact name and that name has two words of
 * its own; otherwise it is 'possible' and its status raises no flag.
 *
 * Privacy. The registers return officers' dates of birth (Norway, Czechia),
 * home addresses (Czechia), company addresses, and for Norwegian sole traders a
 * personal phone and e-mail. Sole traders are never asked for (Norway, Czechia)
 * or skipped (Finland, by legal form), and the parsers read names, roles, dates
 * and company fields by key: birth dates, addresses, nationality and ID numbers
 * of people are never read. The cached copy holds only what the parsers keep.
 *
 * Failures. An answer in an unexpected shape throws (the lookup is reported as
 * failed, never as "no match"). A search the register would not complete (too
 * many companies share the name, or more similar names than one page holds and
 * the exact one is not on it) returns `partial` with a note.
 */
import { request, HttpError } from '../http';
import { makeFinding, makeThread } from '../finding';
import { cachedEntry } from '../cache';
import { companyTokens, matchCompanyName, matchPersonName, personVariants } from './sanctions';
import { companyGrade } from './government';

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 12000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_COMPANIES = 2; // exact-name companies opened per lookup
const MAX_OFFICERS_QUOTED = 10;
const MAX_CO_OFFICERS = 6; // associate threads per tied company

/* ------------------------------------------------------------------ text, names, dates */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isoDay = (s) => (/^(1[6-9]|2\d)\d{2}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : null);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || ''} ${m[1]}`.replace(/\s+/g, ' ') : '';
};
/** "NIKOLA AS" -> "Nikola AS"; names already in mixed case are left alone. */
const tidyCase = (s) => clean(s).split(' ').map((w) => (w.length > 3 && w === w.toUpperCase() && /[A-ZÀ-Þ]/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(' ');

// National legal forms the shared company matcher does not strip ("spol. s r.o.", "v.o.s.", "Ky", "ANS", "NUF").
const NATIONAL_FORM = /[,\s]+(?:spol\.?\s*s\s*r\.?\s*o\.?|s\.\s*r\.\s*o\.?|sro|a\.\s*s\.?|v\.\s*o\.\s*s\.?|k\.\s*s\.?|oyj|oy\s+ab|ab\s+oy|oy|ky|osk|asa|as|ans|nuf)\s*$/i;
/** The name without a national legal form, as written: "Nikola s.r.o." -> "Nikola". */
export function withoutForm(name) {
  let out = clean(name);
  for (let i = 0; i < 2 && NATIONAL_FORM.test(out); i += 1) out = out.replace(NATIONAL_FORM, '').trim();
  return out || clean(name);
}
/** The same company once legal forms (national or general) are set aside. */
export const sameCompany = (a, b) => matchCompanyName(withoutForm(a), withoutForm(b));
const canSearch = (name) => companyTokens(withoutForm(name)).join('').length >= 3;
const cacheKey = (name) => companyTokens(withoutForm(name)).join(' ').toLowerCase();

/** The companies already tied to the person: the one given, and those the check has confirmed. */
const knownCompanies = (subject) => [subject?.company, ...[...(subject?.anchors?.companies?.values?.() || [])].map((a) => a.value)].filter(Boolean);
const isKnown = (subject, names) => knownCompanies(subject).some((k) => names.some((n) => n && sameCompany(k, n)));
const subjectVariants = (subject) => [...new Set([...(subject?.variants || []), ...personVariants(subject?.name || '')])];
/** 1 or 2 when a listed officer is the person by first and last name in order; 0 otherwise. */
const officerTier = (subject, listed) => matchPersonName(subjectVariants(subject), listed);

/* ------------------------------------------------------------------ pacing */

/**
 * PRH asks for about one request a second; ARES restricts users who send hundreds a minute. The shared client
 * spaces unlisted hosts by a fraction of a second, so these two wait their own turn here first.
 */
const HOST_GAP_MS = { 'avoindata.prh.fi': 1100, 'ares.gov.cz': 300 };
const nextSlot = new Map();
let pacing = true;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitTurn(url, deadline) {
  if (!pacing) return;
  const host = new URL(url).hostname;
  const gap = HOST_GAP_MS[host];
  if (!gap) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  if (deadline && at + 2000 > deadline) throw new HttpError('Out of time before the request could start', { url, retryable: true, code: 'deadline' });
  nextSlot.set(host, at + gap);
  if (at > now) await sleep(at - now);
}

/** For tests: turn the per-host spacing off (true) or back on (false), and forget earlier turns. */
export function __resetIntlForTests({ unpaced = true } = {}) {
  pacing = !unpaced;
  nextSlot.clear();
}

async function fetchJson(url, deadline, options = {}) {
  await waitTurn(url, deadline);
  const { text } = await request(url, { deadline, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, accept: 'application/json', ...options });
  try { return JSON.parse(text); } catch { throw new Error(`The register at ${new URL(url).hostname} did not answer in the expected format`); }
}

/* ------------------------------------------------------------------ which country a company belongs to */

const COUNTRIES = {
  NO: {
    name: 'Norway', adjective: 'Norwegian', tld: 'no',
    form: /[,\s](?:AS|ASA|ANS|NUF)\.?\s*$/,
    word: /\b(?:Norwegian|Norway|Norge|Norsk|Oslo|Bergen|Trondheim|Stavanger)\b/i,
    demonym: /\b(?:Norwegian|Norway)\b/i,
  },
  CZ: {
    name: 'the Czech Republic', adjective: 'Czech', tld: 'cz',
    form: /[,\s](?:spol\.?\s*s\s*r\.?\s*o\.?|s\.\s*r\.\s*o\.?|a\.\s*s\.|v\.\s*o\.\s*s\.|k\.\s*s\.)\s*$/i,
    word: /\b(?:Czech|Czechia|Česk\w*|Prague|Praha|Brno|Ostrava)\b/i,
    demonym: /\b(?:Czech|Czechia)\b/i,
  },
  FI: {
    name: 'Finland', adjective: 'Finnish', tld: 'fi',
    form: /[,\s](?:Oyj|Oy|Ky|Osk|Oy\s+Ab|Ab\s+Oy)\.?\s*$/,
    word: /\b(?:Finnish|Finland|Suomi|Suomen|Helsinki|Espoo|Tampere|Oulu|Turku)\b/i,
    demonym: /\b(?:Finnish|Finland)\b/i,
  },
};

const hostOf = (url) => { try { return new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
/** "nikola.no" is the company Nikola's address in Norway: the first label is the company's name run together. */
const isCompanyHost = (host, company, tld) => {
  const parts = String(host || '').split('.');
  if (parts.length < 2 || parts[parts.length - 1] !== tld) return false;
  const label = parts[parts.length - 2].replace(/-/g, '');
  const key = companyTokens(withoutForm(company)).join('').toLowerCase();
  return key.length >= 3 && label === key;
};

/**
 * What places a company in a country, read from the thread itself and what is known about the person (no
 * network, no records). Each sign is a short phrase for the notes; an empty list means nothing does.
 */
export function planSigns(code, thread, subject) {
  const c = COUNTRIES[code];
  const value = clean(thread?.value);
  const signs = [];
  if (c.form.test(value)) signs.push(`its name carries a ${c.adjective} legal form`);
  if (c.word.test(String(thread?.why || ''))) signs.push(`it was found as a ${c.adjective} company`);
  if (hostOf(value).endsWith(`.${c.tld}`) && /\./.test(value) && !/\s/.test(value)) signs.push(`it was given as a .${c.tld} address`);
  const domains = [...(subject?.anchors?.domains?.values?.() || [])].map((a) => hostOf(a.value));
  if (domains.some((h) => isCompanyHost(h, value, c.tld))) signs.push(`its web address is on the .${c.tld} domain`);
  return signs;
}

/** What the records found so far say: a tied record that places the company (or the person) in the country. */
export function recordSigns(code, task, ctx, sourceId) {
  const c = COUNTRIES[code];
  let findings = [];
  try { findings = typeof ctx?.findings === 'function' ? ctx.findings() || [] : []; } catch { findings = []; }
  const signs = new Set();
  for (const f of findings) {
    if (!f || f.match === 'possible') continue;
    const text = `${f.title || ''} ${f.quote || ''}`;
    if (f.source === sourceId) signs.add(`the ${c.adjective} register already holds a record tied to the person`);
    if (f.source === 'lei-register' && String(f.data?.jurisdiction || '').toUpperCase().startsWith(code)) {
      if (companyTokens(withoutForm(task.value)).every((t) => companyTokens(text).includes(t))) signs.add(`the LEI register gives its jurisdiction as ${c.name}`);
    }
    if (f.category === 'identity' && (f.source === 'wikidata' || f.source === 'wikipedia') && c.demonym.test(String(f.title || ''))) {
      signs.add(`a reference entry places the person in ${c.name}`);
    }
    if (isCompanyHost(hostOf(f.url), task.value, c.tld)) signs.add(`a record tied to the person is on its .${c.tld} website`);
  }
  return [...signs];
}

const isPrimary = (thread, subject) => thread?.why === 'the company given' || (subject?.company && sameCompany(subject.company, thread?.value || ''));

/** plan() for one register: a lookup when the company plausibly belongs there; a late check for the company given. */
function planFor(code, prefix, prior) {
  const c = COUNTRIES[code];
  return (thread, subject) => {
    if (thread?.kind !== 'company') return [];
    const signs = planSigns(code, thread, subject);
    if (signs.length) return [{ template: `${prefix}.company`, prior, why: `${c.adjective} company register: ${signs[0]}` }];
    if (isPrimary(thread, subject)) return [{ template: `${prefix}.if-placed`, prior: 0.08, why: `ask the ${c.adjective} register only if the records place the company in ${c.name}` }];
    return [];
  };
}

/** The register is not asked: said in a note, never reported as "no match". */
const notAsked = (label, code, value) => ({
  findings: [], threads: [],
  notes: [`${label} was not asked about ${value}: nothing found so far places it in ${COUNTRIES[code].name} (no ${COUNTRIES[code].adjective} legal form in its name, no .${COUNTRIES[code].tld} web address, no record placing it there).`],
});
const tooShort = (label, value) => ({
  findings: [], threads: [],
  notes: [`${label}: "${clean(value).slice(0, 60)}" is too short a company name to search`],
  partial: [`${clean(value).slice(0, 40)}: name too short to search`],
});

/** Decide whether to ask. Returns null to go ahead, or the result to return instead. */
function gate(code, label, sourceId, task, ctx) {
  if (task.kind !== 'company') return { findings: [], threads: [], notes: [] };
  const value = clean(task.value);
  const signs = [...planSigns(code, task, ctx.subject), ...recordSigns(code, task, ctx, sourceId)];
  if (!signs.length) return notAsked(label, code, value);
  if (!canSearch(value)) return tooShort(label, value);
  return null;
}

/* ------------------------------------------------------------------ shared record builders */

/** Officers, quoted as "Name (role)": people and firms the register lists, never their personal details. */
const officerList = (officers) => officers.slice(0, MAX_OFFICERS_QUOTED).map((o) => `${o.name} (${o.role}${o.current === false ? `, ${o.to ? `until ${o.to}` : 'no longer in office'}` : ''})`).join('; ');

/**
 * The record of the person's role at a company. 'likely' only when the company is already tied to the person;
 * otherwise 'possible', titled as a name match. Never 'confirmed'.
 */
function roleFinding(subject, reg, company, officer, tier, { url, quoteFacts, country }) {
  const known = isKnown(subject, [company.name, ...(company.earlierNames || [])]);
  const span = officer.from || officer.to
    ? `${officer.from ? `from ${longDate(officer.from)}` : ''}${officer.to ? ` until ${longDate(officer.to)}` : officer.current ? ' to the present' : ''}`.trim()
    : (officer.current ? 'current' : 'no longer in office');
  const head = `${subject.name}: ${officer.role} of ${company.name} (${country} company register), ${span}`;
  const finding = makeFinding(subject, {
    source: reg.id,
    sourceLabel: reg.label,
    category: 'corporate',
    title: known ? head : `${head}: name match only, verify identity`,
    quote: [
      ...quoteFacts,
      `${officer.name} — ${officer.role}${officer.body ? ` (${officer.body})` : ''}${officer.from ? ` — since ${officer.from}` : ''}${officer.to ? ` — until ${officer.to}` : ''}`,
    ].filter(Boolean).join(' — '),
    url,
    date: officer.from || null,
    severity: company.distressed ? 'low' : 'info',
    match: known ? 'likely' : 'possible',
    matchReasons: [known
      ? `the register lists ${officer.name} as ${officer.role} of ${company.name}, a company already tied to the person${tier === 2 ? ' (the register gives a middle name)' : ''}`
      : `matched by name only: ${company.name} is not yet tied to the person, so this officer may be a namesake; verify identity`],
    data: {
      country: country === 'Norwegian' ? 'NO' : country === 'Czech' ? 'CZ' : 'FI',
      company: company.name,
      registerNumber: company.number,
      person: officer.name,
      role: officer.role,
      ...(officer.roleCode ? { roleCode: officer.roleCode } : {}),
      ...(officer.body ? { body: officer.body } : {}),
      from: officer.from || null,
      to: officer.to || null,
      current: officer.current !== false,
      appointments: [{ role: officer.role, appointed: officer.from || null, resigned: officer.to || null }],
      ...(officer.groupChanged ? { roleGroupLastChanged: officer.groupChanged } : {}),
    },
  });
  if (finding && !known) finding.excludeFromTimeline = true;
  return finding;
}

/** The company's own record: 'company' when tied, otherwise 'possible' (its status then raises no flag). */
function companyFinding(subject, reg, company, { tie, namesake, sameNamed, wanted, url, quote, title, country }) {
  let grade;
  if (tie) grade = { match: 'company', matchReasons: [`the register lists ${tie} among the officers of ${company.name}`] };
  else if (sameNamed === 1) {
    const why = !reg.lists ? 'the register lists no people, so '
      : namesake ? 'an officer shares the person\'s name, but the company is not yet tied to them, so '
        : 'no listed officer matches the person, so ';
    // graded on the name that matched (a current name or an earlier one)
    grade = companyGrade(wanted, `registered name matches ${wanted}; ${why}the tie rests on the name`);
  } else {
    grade = { match: 'possible', matchReasons: [`same registered name as ${wanted}, but ${sameNamed} ${country} companies carry it; verify it is the same company`] };
  }
  const tied = grade.match === 'company';
  const finding = makeFinding(subject, {
    source: reg.id,
    sourceLabel: reg.label,
    category: 'corporate',
    title: tied ? title : `${title} (same name as ${wanted}; not tied to the person, verify it is the same company)`,
    quote,
    url,
    date: company.founded || null,
    severity: tied ? (company.distressed ? 'medium' : company.ended ? 'low' : 'info') : 'info',
    ...grade,
    data: company.data,
  });
  if (finding && !tied) finding.excludeFromTimeline = true;
  return finding;
}

/** Board and management colleagues of a tied record, as associates (never the person, never an auditor). */
function coOfficerThreads(subject, company, officers, country) {
  return officers
    .filter((o) => o.person && !o.adviser && !officerTier(subject, o.name))
    .slice(0, MAX_CO_OFFICERS)
    .map((o) => makeThread('associate', o.name, `${o.role} of ${company.name} (${country} company register)`, { trusted: true }))
    .filter(Boolean);
}

/** Shared run() body: find the person among a company's officers and build the records. */
function companyRecords(subject, reg, wanted, companies, { country, url, facts, partialNote }) {
  const findings = [];
  const threads = [];
  const notes = [];
  const sameNamed = companies.length;
  for (const company of companies.slice(0, MAX_COMPANIES)) {
    const matches = reg.lists ? company.officers.filter((o) => o.person).map((o) => ({ o, tier: officerTier(subject, o.name) })).filter((m) => m.tier) : [];
    const pageUrl = url(company);
    const quoteFacts = facts(company);
    const roles = matches.map(({ o, tier }) => roleFinding(subject, reg, company, o, tier, { url: pageUrl, quoteFacts: quoteFacts.slice(0, 3), country })).filter(Boolean);
    const tiedRole = roles.find((f) => f.match === 'likely');
    const list = reg.lists ? officerList(company.officers) : '';
    const record = companyFinding(subject, reg, company, {
      tie: tiedRole ? subject.name : null,
      namesake: roles.length > 0 && !tiedRole,
      sameNamed,
      wanted,
      url: pageUrl,
      quote: [...quoteFacts, list ? `Officers: ${list}` : ''].filter(Boolean).join(' — '),
      title: reg.title(company),
      country,
    });
    if (record) findings.push(record);
    findings.push(...roles);
    if (tiedRole) threads.push(...coOfficerThreads(subject, company, company.officers, country));
    if (reg.lists && !matches.length) notes.push(reg.notAmong(subject, company));
  }
  if (companies.length > MAX_COMPANIES) notes.push(`${reg.label}: ${companies.length} companies are registered under the exact name ${wanted}; the first ${MAX_COMPANIES} were read.`);
  if (!reg.lists && companies.length) notes.push(`${reg.label} lists no people, so ${subject.name}'s role at ${wanted} cannot be checked there.`);
  const out = { findings, threads, notes };
  if (partialNote) { notes.push(partialNote); out.partial = [partialNote.slice(0, 80)]; }
  return out;
}

const dayOf = (ms) => new Date(Number(ms) || Date.now()).toISOString().slice(0, 10);
/** A cached register answer, with asOf (yyyy-mm-dd) when it is an older copy read because the refresh failed. */
const datedEntry = (e) => ({ ...e.value, ...(e.fresh === false ? { asOf: dayOf(e.at) } : {}) });
/**
 * A lookup answered from an older copy is never a clean answer as of today: every note carries the copy's date
 * and the lookup is marked partial.
 */
function dated(label, r, out) {
  if (!r?.asOf || !out) return out;
  const when = ` (register answer as of ${r.asOf})`;
  return {
    ...out,
    notes: (out.notes || []).map((n) => `${String(n).replace(/\.$/, '')}${when}`),
    partial: [...(out.partial || []), `${label.slice(0, 40)}: answer as of ${r.asOf}`],
  };
}

const noExact = (label, wanted, similar) => `${label}: no company is registered under the exact name ${wanted}${similar ? ` (${plural(similar, 'company with a similar name was', 'companies with similar names were')} not reported)` : ''}.`;

/* ------------------------------------------------------------------ Norway (Brønnøysund) */

const NO_ID = 'no-company-register';
const NO_LABEL = 'Norwegian company register (Brønnøysund Register Centre)';
const NO_BASE = 'https://data.brreg.no/enhetsregisteret/api/enheter';
const NO_PAGE = 'https://virksomhet.brreg.no/oppslag/enheter';
// Companies only: sole traders (ENK) carry the owner's own phone and e-mail and are never asked for.
const NO_FORMS = ['AS', 'ASA', 'NUF', 'ANS', 'DA', 'SA', 'KS', 'SE', 'STI'];
const NO_PAGE_SIZE = 20;
const NO_FORM_NAMES = { AS: 'private limited company (AS)', ASA: 'public limited company (ASA)', NUF: 'Norwegian branch of a foreign company (NUF)', ANS: 'general partnership (ANS)', DA: 'partnership with shared liability (DA)', SA: 'cooperative (SA)', KS: 'limited partnership (KS)', SE: 'European company (SE)', STI: 'foundation' };
const NO_ROLES = {
  DAGL: 'chief executive (daglig leder)', LEDE: 'chair of the board', NEST: 'deputy chair of the board', MEDL: 'board member', VARA: 'deputy board member',
  OBS: 'board observer', KONT: 'contact person in Norway', FFØR: 'business manager', REVI: 'auditor', REGN: 'accountant', DTPR: 'partner with full liability',
  DTSO: 'partner with shared liability', KOMP: 'general partner', INNH: 'owner', BEST: 'managing shipowner', SAM: 'joint owner',
};
const NO_ADVISERS = new Set(['REVI', 'REGN', 'KONT']);

/** One company from the search: entity fields picked by key. Addresses, phone and e-mail are never read. */
function noCompany(e) {
  if (!e || typeof e !== 'object') return null;
  const number = String(e.organisasjonsnummer || '').replace(/\D/g, '');
  const name = clean(e.navn);
  const form = clean(e.organisasjonsform?.kode);
  if (!/^\d{9}$/.test(number) || !name || form === 'ENK') return null;
  const earlierNames = (Array.isArray(e.historiskeNavn) ? e.historiskeNavn : []).map((h) => clean(typeof h === 'string' ? h : h?.navn)).filter(Boolean);
  const bankrupt = e.konkurs === true;
  const windingUp = e.underAvvikling === true;
  const forced = e.underTvangsavviklingEllerTvangsopplosning === true;
  const deleted = isoDay(e.slettedato);
  const status = [bankrupt ? 'BANKRUPT' : '', windingUp ? 'BEING WOUND UP' : '', forced ? 'UNDER COMPULSORY WINDING UP OR DISSOLUTION' : '', deleted ? `DELETED on ${longDate(deleted)}` : ''].filter(Boolean).join(', ');
  return {
    number, name: tidyCase(name), form, formName: NO_FORM_NAMES[form] || clean(e.organisasjonsform?.beskrivelse),
    founded: isoDay(e.stiftelsesdato), registered: isoDay(e.registreringsdatoEnhetsregisteret), earlierNames: earlierNames.map(tidyCase),
    website: clean(e.hjemmeside), status, distressed: bankrupt || windingUp || forced, ended: Boolean(deleted),
  };
}

/** The search answer. Throws when it is not the register's answer. */
export function parseBrregSearch(json) {
  if (!json || typeof json !== 'object' || !json.page || typeof json.page.totalElements !== 'number') throw new Error('The Norwegian register answered in an unexpected format');
  const raw = json._embedded?.enheter;
  if (json.page.totalElements > 0 && !Array.isArray(raw)) throw new Error('The Norwegian register answered in an unexpected format');
  return { total: json.page.totalElements, companies: (raw || []).map(noCompany).filter(Boolean) };
}

/** The roles answer: names, roles and flags only. Dates of birth are never read. */
export function parseBrregRoles(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.rollegrupper)) throw new Error('The Norwegian register\'s officer list arrived in an unexpected format');
  const officers = [];
  for (const group of json.rollegrupper) {
    const changed = isoDay(group?.sistEndret);
    for (const r of Array.isArray(group?.roller) ? group.roller : []) {
      const code = clean(r?.type?.kode);
      const role = NO_ROLES[code] || clean(r?.type?.beskrivelse).toLowerCase() || 'officer';
      const current = !(r?.avregistrert === true || r?.fratraadt === true);
      const n = r?.person?.navn;
      if (n && typeof n === 'object') {
        const name = [n.fornavn, n.mellomnavn, n.etternavn].map(clean).filter(Boolean).join(' ');
        if (name) officers.push({ name: tidyCase(name), person: true, role, roleCode: code, current, groupChanged: changed, adviser: NO_ADVISERS.has(code) });
      } else if (r?.enhet) {
        const name = clean(Array.isArray(r.enhet.navn) ? r.enhet.navn.join(' ') : r.enhet.navn);
        if (name) officers.push({ name: tidyCase(name), person: false, role, roleCode: code, current, groupChanged: changed, adviser: NO_ADVISERS.has(code) });
      }
    }
  }
  return officers;
}

async function brregLookup(wanted, deadline) {
  // The loader's own deadline (shadowing the caller's) from the cache; an older copy served after a failed
  // refresh is dated (asOf) by `dated`.
  return cachedEntry(`intl:no:v1:${cacheKey(wanted)}`, DAY_MS, async ({ deadline }) => {
    const qs = new URLSearchParams({ navn: withoutForm(wanted), size: String(NO_PAGE_SIZE), organisasjonsform: NO_FORMS.join(',') });
    const { total, companies } = parseBrregSearch(await fetchJson(`${NO_BASE}?${qs}`, deadline));
    const exact = companies.filter((c) => [c.name, ...c.earlierNames].some((n) => sameCompany(wanted, n)));
    for (const c of exact.slice(0, MAX_COMPANIES)) {
      // eslint-disable-next-line no-await-in-loop
      c.officers = parseBrregRoles(await fetchJson(`${NO_BASE}/${c.number}/roller`, deadline));
    }
    return { total, read: companies.length, exact, similar: companies.length - exact.length };
  }, { deadline }).then(datedEntry);
}

const noFacts = (c) => [
  `${c.name} — organisation number ${c.number}`,
  c.formName ? `Legal form: ${c.formName}` : '',
  c.founded ? `Founded ${c.founded}` : '',
  c.status ? `Status: ${c.status}` : 'Status: registered',
  c.earlierNames.length ? `Earlier names: ${c.earlierNames.slice(0, 4).join('; ')}` : '',
  c.website ? `Website: ${c.website}` : '',
].filter(Boolean);

const NO_REG = {
  id: NO_ID, label: NO_LABEL, lists: true,
  title: (c) => `Norwegian company record: ${c.name}${c.status ? `, ${c.status}` : ''}${c.founded ? `, founded ${longDate(c.founded)}` : ''}`,
  notAmong: (subject, c) => `${NO_LABEL}: ${subject.name} is not among the current officers of ${c.name} (the register lists current roles only, so a past role would not show).`,
};

export const noCompanyRegisterConnector = {
  id: NO_ID,
  label: NO_LABEL,
  kinds: ['company'],
  prior: 0.4,
  timeoutMs: 15000,
  plan: planFor('NO', 'intl.no', 0.4),
  async run(task, ctx) {
    const stop = gate('NO', NO_LABEL, NO_ID, task, ctx);
    if (stop) return stop;
    const wanted = clean(task.value);
    const r = await brregLookup(wanted, ctx.deadline);
    return dated(NO_LABEL, r, await (async () => {
      for (const c of r.exact) {
        c.officers = c.officers || [];
        c.data = { country: 'NO', registerNumber: c.number, legalForm: c.form || null, founded: c.founded, status: c.status || 'registered', earlierNames: c.earlierNames, website: c.website || null, officers: c.officers.map((o) => ({ name: o.name, role: o.role, current: o.current, ...(o.person ? {} : { company: true }) })) };
      }
      if (!r.exact.length) {
        const incomplete = r.total > r.read;
        const note = noExact(NO_LABEL, withoutForm(wanted), r.similar);
        if (!incomplete) return { findings: [], threads: [], notes: [note] };
        const partialNote = `${NO_LABEL}: ${r.total} companies have names like ${withoutForm(wanted)}; the first ${r.read} were read and none carries the exact name`;
        return { findings: [], threads: [], notes: [note, partialNote], partial: [partialNote.slice(0, 80)] };
      }
      return companyRecords(ctx.subject, NO_REG, withoutForm(wanted), r.exact, {
        country: 'Norwegian',
        url: (c) => `${NO_PAGE}/${c.number}`,
        facts: noFacts,
      });
    })());
  },
};

/* ------------------------------------------------------------------ Czech Republic (ARES) */

const CZ_ID = 'cz-company-register';
const CZ_LABEL = 'Czech company register (ARES public register extract)';
const CZ_BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest';
const CZ_PAGE = 'https://ares.gov.cz/ekonomicke-subjekty';
const CZ_PAGE_SIZE = 30;
// Companies only: sole traders (codes 100-108) are people and are never asked for.
const CZ_FORMS = { 111: 'general partnership (v.o.s.)', 112: 'limited liability company (s.r.o.)', 113: 'limited partnership (k.s.)', 121: 'joint-stock company (a.s.)', 205: 'cooperative (družstvo)', 421: 'branch of a foreign company', 931: 'European economic interest grouping', 932: 'European company (SE)' };
const CZ_ROLES = [
  [/^jednatel/i, 'managing director (jednatel)'],
  [/^p[řr]edseda p[řr]edstavenstva/i, 'chair of the board of directors'],
  [/^m[íi]stop[řr]edseda p[řr]edstavenstva/i, 'vice chair of the board of directors'],
  [/^[čc]len p[řr]edstavenstva/i, 'member of the board of directors'],
  [/^p[řr]edseda dozor[čc][íi] rady/i, 'chair of the supervisory board'],
  [/^m[íi]stop[řr]edseda dozor[čc][íi] rady/i, 'vice chair of the supervisory board'],
  [/^[čc]len dozor[čc][íi] rady/i, 'member of the supervisory board'],
  [/^p[řr]edseda spr[áa]vn[íi] rady/i, 'chair of the administrative board'],
  [/^[čc]len spr[áa]vn[íi] rady/i, 'member of the administrative board'],
  [/^statut[áa]rn[íi] [řr]editel/i, 'statutory director'],
  [/^prokurist/i, 'authorised signatory (prokurista)'],
  [/^likvid[áa]tor/i, 'liquidator'],
  [/^p[řr]edseda/i, 'chair'],
  [/^m[íi]stop[řr]edseda/i, 'vice chair'],
];
const czRole = (funkce, organ) => {
  const f = clean(funkce);
  const hit = CZ_ROLES.find(([re]) => re.test(f));
  if (hit) return hit[1];
  if (/dozor[čc]/i.test(organ)) return 'member of the supervisory board';
  if (/p[řr]edstavenstv/i.test(organ)) return 'member of the board of directors';
  return f ? `${f} (${clean(organ) || 'statutory body'})` : `member of the ${/statut/i.test(organ) ? 'statutory body' : clean(organ) || 'statutory body'}`;
};

/** The search answer: entity fields only (seat addresses are never read). */
export function parseAresSearch(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.ekonomickeSubjekty) || typeof json.pocetCelkem !== 'number') throw new Error('The Czech register answered in an unexpected format');
  const companies = [];
  for (const e of json.ekonomickeSubjekty) {
    const number = String(e?.ico || '').replace(/\D/g, '');
    const name = clean(e?.obchodniJmeno);
    const form = String(e?.pravniForma || '');
    if (!/^\d{8}$/.test(number) || !name || /^10\d$/.test(form)) continue;
    const reg = e?.seznamRegistraci || {};
    companies.push({
      number, name, form, formName: CZ_FORMS[form] || '', founded: isoDay(e?.datumVzniku), closed: isoDay(e?.datumZaniku),
      inRegister: /^(AKTIVNI|ZANIKLY)$/.test(String(reg.stavZdrojeVr || '')),
      insolvency: /^(AKTIVNI|ZANIKLY)$/.test(String(reg.stavZdrojeIr || '')) ? String(reg.stavZdrojeIr) : '',
    });
  }
  return { total: json.pocetCelkem, companies };
}

const firstDay = (...xs) => xs.map(isoDay).filter(Boolean).sort()[0] || null;
const lastDay = (...xs) => xs.map(isoDay).filter(Boolean).sort().pop() || null;

/**
 * Merge a member's register entries into spells. The register rewrites an entry when any detail changes (an
 * address, a title): the old entry is struck off the day the new one is written, so touching entries are one
 * spell; a gap between them is a second spell.
 */
function spells(entries) {
  const sorted = entries.filter((e) => e.from).sort((a, b) => a.from.localeCompare(b.from));
  const out = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && (last.end === null || (e.from <= last.end))) {
      if (last.end !== null) last.end = e.end === null ? null : lastDay(last.end, e.end);
      last.roles.add(e.role);
      continue;
    }
    out.push({ from: e.from, end: e.end, roles: new Set([e.role]) });
  }
  return out;
}

/**
 * The register extract: name history, status and the members of every statutory and supervisory body with
 * their dates. Only names, functions and dates are read: dates of birth and home addresses never are.
 */
export function parseAresExtract(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.zaznamy) || !json.zaznamy.length) throw new Error('The Czech register extract arrived in an unexpected format');
  const rec = json.zaznamy.find((z) => z?.primarniZaznam) || json.zaznamy[0];
  if (!rec || typeof rec !== 'object' || !Array.isArray(rec.obchodniJmeno)) throw new Error('The Czech register extract arrived in an unexpected format');
  const names = rec.obchodniJmeno.map((n) => ({ name: clean(n?.hodnota), from: isoDay(n?.datumZapisu), to: isoDay(n?.datumVymazu) })).filter((n) => n.name);
  const people = new Map();
  const bodies = [...(Array.isArray(rec.statutarniOrgany) ? rec.statutarniOrgany : []), ...(Array.isArray(rec.ostatniOrgany) ? rec.ostatniOrgany : [])];
  for (const organ of bodies) {
    const body = clean(organ?.nazevOrganu);
    for (const m of Array.isArray(organ?.clenoveOrganu) ? organ.clenoveOrganu : []) {
      const fo = m?.fyzickaOsoba;
      const po = m?.pravnickaOsoba;
      const name = fo ? [fo.jmeno, fo.prijmeni].map(clean).filter(Boolean).join(' ') : clean(po?.obchodniJmeno);
      if (!name) continue;
      const f = m?.clenstvi?.funkce || {};
      const c = m?.clenstvi?.clenstvi || {};
      const role = czRole(f.nazev || m?.nazevAngazma, body);
      const from = firstDay(f.vznikFunkce, c.vznikClenstvi) || isoDay(m?.datumZapisu);
      const ended = firstDay(f.zanikFunkce, c.zanikClenstvi);
      const struck = isoDay(m?.datumVymazu);
      const key = `${name.toLowerCase()}|${body.toLowerCase()}`;
      const p = people.get(key) || { name, person: Boolean(fo), body, entries: [] };
      p.entries.push({ role, from, end: ended || struck || null });
      people.set(key, p);
    }
  }
  const officers = [];
  for (const p of people.values()) {
    for (const s of spells(p.entries)) {
      officers.push({ name: p.name, person: p.person, body: p.body, role: [...s.roles].join(', '), from: s.from, to: s.end, current: s.end === null });
    }
  }
  officers.sort((a, b) => Number(b.current) - Number(a.current) || String(b.from).localeCompare(String(a.from)));
  const status = clean(rec.stavSubjektu);
  return { names, status, officers };
}

async function aresLookup(wanted, deadline) {
  // The loader's own deadline (shadowing the caller's) from the cache; an older copy served after a failed
  // refresh is dated (asOf) by `dated`.
  return cachedEntry(`intl:cz:v1:${cacheKey(wanted)}`, DAY_MS, async ({ deadline }) => {
    await waitTurn(`${CZ_BASE}/x`, deadline);
    let search;
    try {
      const { text } = await request(`${CZ_BASE}/ekonomicke-subjekty/vyhledat`, {
        method: 'POST', deadline, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, accept: 'application/json',
        headers: { 'Content-Type': 'application/json' },
        body: { obchodniJmeno: withoutForm(wanted), pocet: CZ_PAGE_SIZE, pravniForma: Object.keys(CZ_FORMS) },
      });
      try { search = parseAresSearch(JSON.parse(text)); } catch (error) { throw new Error(error?.message?.startsWith('The Czech') ? error.message : 'The Czech register answered in an unexpected format'); }
    } catch (error) {
      // The register refuses a search that matches more than 1,000 companies (HTTP 400): not a clean result
      if (error instanceof HttpError && error.status === 400) return { refused: true, exact: [], total: 0, read: 0, similar: 0 };
      throw error;
    }
    const exact = search.companies.filter((c) => sameCompany(wanted, c.name));
    for (const c of exact.slice(0, MAX_COMPANIES)) {
      c.officers = [];
      c.earlierNames = [];
      if (!c.inRegister) continue;
      let extract = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        extract = parseAresExtract(await fetchJson(`${CZ_BASE}/ekonomicke-subjekty-vr/${c.number}`, deadline));
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) throw error;
      }
      if (!extract) { c.inRegister = false; continue; }
      c.officers = extract.officers;
      c.earlierNames = extract.names.filter((n) => n.to && n.name !== c.name).map((n) => n.name);
      c.registerStatus = extract.status;
    }
    return { total: search.total, read: search.companies.length, exact, similar: search.companies.length - exact.length };
  }, { deadline }).then(datedEntry);
}

const CZ_STATUS = { AKTIVNI: 'active', ZANIKLY: 'ceased', V_LIKVIDACI: 'in liquidation' };
const czStatus = (c) => (c.closed ? `CEASED on ${longDate(c.closed)}` : CZ_STATUS[c.registerStatus] || (c.registerStatus ? c.registerStatus.toLowerCase().replace(/_/g, ' ') : 'active'));
const czFacts = (c) => [
  `${c.name} — IČO ${c.number}`,
  c.formName ? `Legal form: ${c.formName}` : '',
  c.founded ? `Founded ${c.founded}` : '',
  `Status: ${czStatus(c)}`,
  c.insolvency ? `Listed in the insolvency register (${c.insolvency === 'AKTIVNI' ? 'current entry' : 'ended entry'})` : '',
  c.earlierNames?.length ? `Earlier names: ${c.earlierNames.slice(0, 4).join('; ')}` : '',
  c.inRegister ? '' : 'Not in the public (commercial) register, so no officers are listed',
].filter(Boolean);

const CZ_REG = {
  id: CZ_ID, label: CZ_LABEL, lists: true,
  title: (c) => `Czech company record: ${c.name}, ${czStatus(c)}${c.founded ? `, founded ${longDate(c.founded)}` : ''}${c.insolvency === 'AKTIVNI' ? ', in the insolvency register' : ''}`,
  notAmong: (subject, c) => (c.inRegister
    ? `${CZ_LABEL}: ${subject.name} is not among the past or present members of ${c.name}'s statutory body or supervisory board.`
    : `${CZ_LABEL}: ${c.name} is not in the public register, so its officers could not be checked.`),
};

export const czCompanyRegisterConnector = {
  id: CZ_ID,
  label: CZ_LABEL,
  kinds: ['company'],
  prior: 0.4,
  timeoutMs: 18000,
  plan: planFor('CZ', 'intl.cz', 0.4),
  async run(task, ctx) {
    const stop = gate('CZ', CZ_LABEL, CZ_ID, task, ctx);
    if (stop) return stop;
    const wanted = clean(task.value);
    const r = await aresLookup(wanted, ctx.deadline);
    return dated(CZ_LABEL, r, await (async () => {
      if (r.refused) {
        const note = `${CZ_LABEL}: the register refused the search for ${withoutForm(wanted)} (it does so when more than 1,000 companies share a name), so the search was not completed`;
        return { findings: [], threads: [], notes: [note], partial: [note.slice(0, 80)] };
      }
      for (const c of r.exact) {
        c.officers = c.officers || [];
        c.distressed = c.insolvency === 'AKTIVNI' || /LIKVID/i.test(c.registerStatus || '');
        c.ended = Boolean(c.closed);
        c.data = {
          country: 'CZ', registerNumber: c.number, legalForm: c.formName || c.form || null, founded: c.founded, closed: c.closed, status: czStatus(c),
          insolvencyRegister: c.insolvency || null, earlierNames: c.earlierNames || [],
          officers: c.officers.map((o) => ({ name: o.name, role: o.role, body: o.body, from: o.from, to: o.to, ...(o.person ? {} : { company: true }) })).slice(0, 30),
        };
      }
      if (!r.exact.length) {
        const note = noExact(CZ_LABEL, withoutForm(wanted), r.similar);
        if (r.total <= r.read) return { findings: [], threads: [], notes: [note] };
        const partialNote = `${CZ_LABEL}: ${r.total} companies have names like ${withoutForm(wanted)}; the first ${r.read} were read and none carries the exact name`;
        return { findings: [], threads: [], notes: [note, partialNote], partial: [partialNote.slice(0, 80)] };
      }
      return companyRecords(ctx.subject, CZ_REG, withoutForm(wanted), r.exact, {
        country: 'Czech',
        url: (c) => `${CZ_PAGE}?ico=${c.number}`,
        facts: czFacts,
      });
    })());
  },
};

/* ------------------------------------------------------------------ Finland (PRH) */

const FI_ID = 'fi-trade-register';
const FI_LABEL = 'Finnish Trade Register (PRH)';
const FI_BASE = 'https://avoindata.prh.fi/opendata-ytj-api/v3/companies';
const FI_PAGE = 'https://tietopalvelu.ytj.fi/yritys';
const FI_SITUATIONS = { KONK: 'BANKRUPT', SELTILA: 'IN LIQUIDATION', SANE: 'IN RESTRUCTURING' };
// Business-name forms that are a person's own business: never reported
const FI_SOLE = /^(?:yksityinen elinkeinonharjoittaja|private trader|sole trader)/i;
const english = (descriptions) => clean((Array.isArray(descriptions) ? descriptions : []).find((d) => String(d?.languageCode) === '3')?.description);

/** The search answer: company fields only (addresses are never read). */
export function parsePrhCompanies(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.companies) || typeof json.totalResults !== 'number') throw new Error('The Finnish register answered in an unexpected format');
  const companies = [];
  for (const c of json.companies) {
    const number = clean(c?.businessId?.value);
    if (!/^\d{7}-\d$/.test(number)) continue;
    const names = (Array.isArray(c?.names) ? c.names : []).map((n) => ({ name: clean(n?.name), from: isoDay(n?.registrationDate), to: isoDay(n?.endDate), main: String(n?.type) === '1' })).filter((n) => n.name);
    const current = names.find((n) => n.main && !n.to) || names.find((n) => !n.to) || names[0];
    if (!current) continue;
    const forms = (Array.isArray(c?.companyForms) ? c.companyForms : []).map((f) => ({ name: english(f?.descriptions), to: isoDay(f?.endDate) }));
    const form = (forms.find((f) => !f.to) || forms[0] || {}).name || '';
    if (FI_SOLE.test(form)) continue;
    const situations = (Array.isArray(c?.companySituations) ? c.companySituations : []).filter((s) => !isoDay(s?.endDate)).map((s) => FI_SITUATIONS[s?.type] || clean(s?.type)).filter(Boolean);
    const ended = isoDay(c?.endDate);
    companies.push({
      number, name: current.name, form,
      earlierNames: names.filter((n) => n !== current).map((n) => n.name),
      allNames: names.map((n) => n.name),
      founded: isoDay(c?.registrationDate) || isoDay(c?.businessId?.registrationDate),
      line: english(c?.mainBusinessLine?.descriptions),
      website: clean(c?.website?.url),
      situations, ended,
      status: [...situations, ended ? `ENDED on ${longDate(ended)}` : ''].filter(Boolean).join(', '),
      distressed: situations.length > 0,
    });
  }
  return { total: json.totalResults, companies };
}

async function prhLookup(wanted, deadline) {
  // The loader's own deadline (shadowing the caller's) from the cache; an older copy served after a failed
  // refresh is dated (asOf) by `dated`.
  return cachedEntry(`intl:fi:v1:${cacheKey(wanted)}`, DAY_MS, async ({ deadline }) => {
    const { total, companies } = parsePrhCompanies(await fetchJson(`${FI_BASE}?${new URLSearchParams({ name: withoutForm(wanted) })}`, deadline));
    const exact = companies.filter((c) => c.allNames.some((n) => sameCompany(wanted, n)));
    return { total, read: companies.length, exact, similar: companies.length - exact.length };
  }, { deadline }).then(datedEntry);
}

const fiFacts = (c) => [
  `${c.name} — business ID ${c.number}`,
  c.form ? `Legal form: ${c.form}` : '',
  c.founded ? `Registered ${c.founded}` : '',
  `Status: ${c.status || 'registered'}`,
  c.earlierNames.length ? `Earlier or parallel names: ${c.earlierNames.slice(0, 4).join('; ')}` : '',
  c.line ? `Main line of business: ${c.line}` : '',
  c.website ? `Website: ${c.website}` : '',
].filter(Boolean);

const FI_REG = {
  id: FI_ID, label: FI_LABEL, lists: false,
  title: (c) => `Finnish trade register: ${c.name}${c.status ? `, ${c.status}` : ''}${c.founded ? `, registered ${longDate(c.founded)}` : ''}`,
};

export const fiTradeRegisterConnector = {
  id: FI_ID,
  label: FI_LABEL,
  kinds: ['company'],
  prior: 0.3,
  timeoutMs: 15000,
  maxParallel: 1,
  plan: planFor('FI', 'intl.fi', 0.3),
  async run(task, ctx) {
    const stop = gate('FI', FI_LABEL, FI_ID, task, ctx);
    if (stop) return stop;
    const wanted = clean(task.value);
    const r = await prhLookup(wanted, ctx.deadline);
    return dated(FI_LABEL, r, await (async () => {
      for (const c of r.exact) {
        c.officers = [];
        c.data = { country: 'FI', registerNumber: c.number, legalForm: c.form || null, founded: c.founded, ended: c.ended, status: c.status || 'registered', earlierNames: c.earlierNames, mainLine: c.line || null, website: c.website || null };
      }
      if (!r.exact.length) {
        const note = noExact(FI_LABEL, withoutForm(wanted), r.similar);
        if (r.total <= r.read) return { findings: [], threads: [], notes: [note] };
        const partialNote = `${FI_LABEL}: ${r.total} companies have names like ${withoutForm(wanted)}; the first ${r.read} were read and none carries the exact name`;
        return { findings: [], threads: [], notes: [note, partialNote], partial: [partialNote.slice(0, 80)] };
      }
      return companyRecords(ctx.subject, FI_REG, withoutForm(wanted), r.exact, {
        country: 'Finnish',
        url: (c) => `${FI_PAGE}/${c.number}`,
        facts: fiFacts,
      });
    })());
  },
};

export const INTL_REGISTRY_CONNECTORS = [noCompanyRegisterConnector, czCompanyRegisterConnector, fiTradeRegisterConnector];
