/**
 * More regulators and one more court. Four sources, one per publisher, so each is reported on its own:
 *
 *   ftc-cases                US Federal Trade Commission cases and proceedings (consumer protection and
 *                            competition). One search of the FTC's legal library per name
 *                            (www.ftc.gov/legal-library/browse/cases-proceedings?search=...), first page of
 *                            results (20). The site turns away automated readers that declare no contact, so
 *                            the source is on only when FOUNDER_HTTP_CONTACT is set. robots.txt asks for five
 *                            seconds between requests; this file waits 5.1 s and runs one lookup at a time.
 *   esma-sanctions-register  The EU securities regulator's (ESMA) register of administrative sanctions imposed
 *                            by national regulators (BaFin, AMF, CNMV, CONSOB, the Central Bank of Ireland and
 *                            others) under MiFID, UCITS, EMIR and MAR. Firm level. The whole register (about
 *                            1,300 entries, 0.5 MB) is read at most once a day and matched here. Asked only for a
 *                            company with a sign of an EU or EEA tie (see euSigns); otherwise a note says why
 *                            it was not asked. ESMA's legal notice allows reuse with the source acknowledged and
 *                            asks that nothing imply ESMA endorses a firm: every lookup says so in its notes.
 *   sfc-hk-enforcement       Hong Kong Securities and Futures Commission enforcement news since 1997: bans,
 *                            prosecutions, Market Misconduct Tribunal outcomes, freezing orders. The list (about
 *                            2,600 releases, 0.9 MB) is read whole at most once a day from the search the SFC's
 *                            own news page calls, and each release's named targets are matched here. Asked only
 *                            when the person or company has a sign of a Hong Kong tie (see hkSigns). OFF unless
 *                            the owner names 'sfc-hk-enforcement' in FOUNDER_SOURCES_ON: the search is not
 *                            documented as public, and the SFC's terms allow personal or internal use only.
 *   us-tax-court             US Tax Court dockets (cases where the person or company is the petitioner) and
 *                            opinions, from the public search behind the Court's DAWSON web app (the "green"
 *                            host, then the "blue" one: the Court switches between them while deploying). OFF
 *                            unless the owner names 'us-tax-court' in FOUNDER_SOURCES_ON, for the same reason as
 *                            the SFC search. Documents are never opened.
 *
 * Identity. A person is matched only on their full name, by the sanctions screens' strict matcher
 * (sanctions.matchPersonName: first and last name, in order when the record adds names; another spelling or a
 * nickname is a variant). Free text (an FTC case title) must carry the full name (names.personNameMatcher). A
 * record that matches on the name alone is 'possible', titled "name match only, verify identity". It is
 * 'likely' only when the same record also names the company the check was started with (as a co-respondent, a
 * co-target, or in its title or summary). No source here ever sets 'confirmed'; every grade is set here and
 * fixed, so a later re-grade cannot lift it.
 * A company is matched on its whole name with the legal form set aside (sanctions.matchCompanyName), under every
 * known name of the company (the name typed and the legal names the check learned); in free text through the
 * shared company matcher (names.companyMentionMatcher), so a company named with one ordinary word counts only
 * where the text uses it as a company. A structured match on a one-word name stays 'possible' (many unrelated
 * firms share a one-word name), unless the record carries the company's LEI as the LEI register found it.
 *
 * Privacy. Kept: names of the person and of firms, titles, dates, docket and reference numbers, the regulator,
 * the kind of action. Never kept: anyone else's name from a joint Tax Court petition (a spouse), the names of
 * other people an SFC release targets, masked SFC targets, ESMA's decision text (it is never requested), any
 * address, and the body of a release or opinion beyond a short summary that the privacy rules have cleaned.
 * Estate cases ("Estate of ...") are skipped. Related people are never looked up here.
 *
 * Failure. A list that does not load, is too short to be whole, or has changed shape throws, so the lookup is
 * reported as failed, never as "no match". A search page that has changed shape throws too. A first page that
 * holds only part of the results, or a lookup that was not asked, returns `partial` with a note.
 */
import { request, htmlToText, HttpError } from '../http';
import { makeFinding, severityFromText } from '../finding';
import { cachedEntry } from '../cache';
import { normalizeName, nameTokens, companyTokens, matchPersonName, matchCompanyName, screenNames, companyNames } from './sanctions';
import { personNameMatcher, companyMentionMatcher } from '../names';
import { cleanSentences } from '../guardrails';
import { isSelfTask, withAliasHold } from './alias';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 6;

/* ------------------------------------------------------------------ text */

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => {
  const str = oneLine(s);
  if (str.length <= n) return str;
  const cut = str.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '')}…`;
};
/** Entities decoded, tags removed, one line. */
const plain = (s) => oneLine(htmlToText(String(s ?? '')));
const isoDay = (s) => (String(s || '').match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || '';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const uniq = (list) => [...new Set(list.filter(Boolean))];
const atLeastMedium = (sev) => (sev === 'high' ? 'high' : 'medium');

/* ------------------------------------------------------------------ switches */

const listed = (name, id) => String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean).includes(id);
const switchedOff = (id) => listed('FOUNDER_SOURCES_OFF', id);
/** On only when the owner names it in FOUNDER_SOURCES_ON (and has not also switched it off). */
const switchedOn = (id) => listed('FOUNDER_SOURCES_ON', id) && !switchedOff(id);
const contactDeclared = () => Boolean(oneLine(process.env.FOUNDER_HTTP_CONTACT));

/* ------------------------------------------------------------------ pacing */

// Spacing per host, on top of the shared client's own. ftc.gov publishes "Crawl-delay: 5"; the other hosts
// publish none (ESMA's and the Tax Court's robots.txt answer with a page, not rules), so one second.
export const GAP_MS = {
  'www.ftc.gov': 5100,
  'registers.esma.europa.eu': 1000,
  'apps.sfc.hk': 1000,
  'public-api-green.dawson.ustaxcourt.gov': 1000,
  'public-api-blue.dawson.ustaxcourt.gov': 1000,
};
const nextSlot = new Map();
let pacing = true;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitTurn(url, deadline) {
  if (!pacing) return;
  const host = new URL(url).hostname;
  const gap = GAP_MS[host];
  if (!gap) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  if (deadline && at + 2000 > deadline) throw new HttpError('Out of time before the request could start', { url, retryable: true, code: 'deadline' });
  nextSlot.set(host, at + gap);
  if (at > now) await sleep(at - now);
}

/** For tests: turn the per-host spacing off (true) or back on (false), and forget earlier turns. */
export function __resetRegulatorsMoreForTests({ unpaced = true } = {}) {
  pacing = !unpaced;
  nextSlot.clear();
}

async function fetchText(url, deadline, options = {}) {
  await waitTurn(url, deadline);
  return (await request(url, { deadline, timeoutMs: 15000, ...options })).text;
}

function parseJson(text, what) {
  try { return JSON.parse(String(text).replace(/^﻿/, '')); } catch { throw new Error(`${what} did not answer in the expected format`); }
}

/** A whole list from the cache, with the date of the copy (the loader gets the cache's own deadline). */
async function loadList(key, loader, deadline) {
  const entry = await cachedEntry(key, DAY_MS, ({ deadline: d }) => loader(d), { deadline });
  const at = Number(entry.at) || Date.parse(entry.value?.at || '') || Date.now();
  return { index: entry.value, at, fresh: entry.fresh !== false, asOf: new Date(at).toISOString().slice(0, 10) };
}
const asOfText = (copy) => (copy?.asOf ? ` (list as of ${copy.asOf})` : '');
/** An older copy stood in for a failed download: the screen ran, but is only partly current. */
function withStale(out, label, copy) {
  if (!copy || copy.fresh) return out;
  out.notes.push(`${label}: the latest copy could not be downloaded, so the copy of ${copy.asOf} was screened`);
  out.partial = [...(out.partial || []), `${label}: list as of ${copy.asOf}`];
  return out;
}

/* ------------------------------------------------------------------ names and grades */

/** The searched forms of the person: the names the sanctions screens use (variants, Latin spellings). */
const personNames = (task, ctx) => screenNames(task, ctx).filter((v) => nameTokens(v).filter((t) => t.length > 1).length >= 2);
/** The shortest full form (first and last name), the one sent to a search box. */
const coreName = (names) => [...names].sort((a, b) => a.split(' ').length - b.split(' ').length)[0] || '';
/** Every known name of a company: as typed, then the legal names the check learned. */
const knownCompanyNames = (ctx, company) => companyNames(ctx?.subject, company, 3);
const canScreenCompany = (names) => names.some((n) => companyTokens(n).join('').length >= 3);

/** The company the check was started with, as the anchor matcher (it also knows the learned legal names). */
function givenCompanyAnchors(subject) {
  return [...(subject?.anchors?.companies?.values?.() || [])].filter((a) => a && a.origin === 'given' && typeof a.test === 'function');
}
/** Free text names the company the check was started with, as a company. */
const textNamesGivenCompany = (subject, text) => givenCompanyAnchors(subject).some((a) => a.test(oneLine(text)));
/** A structured firm name is the company the check was started with (any of its known names). */
function firmIsGivenCompany(subject, firm) {
  if (!subject?.company) return false;
  return companyNames(subject, subject.company, 3).some((n) => matchCompanyName(n, firm));
}

/**
 * A person matched on their name, graded. 'likely' when the record itself also names the company the check was
 * started with (`second`), and the name is the person's (not only a variant of it); otherwise 'possible', titled
 * as a name match. Never 'confirmed'.
 */
function personFinding(subject, f, { tier, second = '' }) {
  if (second && tier && tier < 3) {
    return makeFinding(subject, {
      ...f,
      match: 'likely',
      matchReasons: [`the record names the person${tier === 2 ? ' (with a middle name the search did not have)' : ''}`, second],
    });
  }
  return makeFinding(subject, {
    ...f,
    title: `${f.title}: name match only, verify identity`,
    match: 'possible',
    matchReasons: [tier >= 3 ? 'only a variant of the name matches (another spelling, a nickname or an extra surname)' : 'matched by name only; nothing else in the record ties it to the person'],
  });
}

/**
 * A company matched on a structured name. 'company' when the name matched has two or more words of its own, or
 * the record carries the LEI the check tied to the company; 'possible' for a one-word name.
 */
function companyFinding(subject, f, { via, reason, lei = false }) {
  if (lei) return makeFinding(subject, { ...f, match: 'company', matchReasons: [`${reason}; the record carries the company's Legal Entity Identifier`] });
  if (companyTokens(via).length < 2) {
    return makeFinding(subject, { ...f, match: 'possible', matchReasons: [`${reason}; but ${oneLine(via)} is a one-word name many unrelated companies share, so verify it is the same company`] });
  }
  return makeFinding(subject, { ...f, match: 'company', matchReasons: [reason] });
}

/** Records found so far, tied to the person or their companies. */
function tiedFindings(ctx) {
  let findings = [];
  try { findings = typeof ctx?.findings === 'function' ? ctx.findings() || [] : []; } catch { findings = []; }
  return findings.filter((f) => f && f.match && f.match !== 'possible');
}

const isPrimary = (thread, subject) => thread?.why === 'the company given'
  || Boolean(subject?.company && thread?.value && companyTokens(subject.company).join(' ') === companyTokens(thread.value).join(' '));

const hostOf = (v) => { try { return new URL(/^https?:/i.test(v) ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const looksLikeDomain = (v) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(oneLine(v));
function subjectDomains(subject) {
  const out = [...(subject?.anchors?.domains?.values?.() || [])].map((a) => String(a.value || ''));
  for (const a of subject?.anchors?.aliases?.values?.() || []) if (looksLikeDomain(a.value)) out.push(String(a.value));
  if (looksLikeDomain(subject?.company)) out.push(subject.company);
  return uniq(out.map(hostOf));
}
const subjectOrgs = (subject) => uniq([subject?.company, ...[...(subject?.anchors?.companies?.values?.() || [])].map((a) => a.value), ...[...(subject?.anchors?.schools?.values?.() || [])].map((a) => a.value)].map(oneLine));
const subjectPlaces = (subject) => uniq([subject?.country, subject?.place, subject?.jurisdiction, ...(Array.isArray(subject?.countries) ? subject.countries : [])].map(oneLine));

/* ------------------------------------------------------------------ ties to a place */

const HK_WORDS = /\bHong\s*Kong\b|\bHK\b|\bH\.K\.|\bKowloon\b|香港/;
const HK_PLACE = /^(?:hk|hkg|hong\s*kong)$/i;

/**
 * What ties the thread to Hong Kong, read from the thread and what is known about the person (no network): a
 * Hong Kong word in the company's name or in why it is being looked at, a .hk web address, a place given as Hong
 * Kong, and (for the person, or for the company the check was started with) an organisation or school of
 * theirs in Hong Kong. Each sign is a short phrase for the notes; empty when nothing does.
 */
export function hkSigns(thread, subject) {
  const value = oneLine(thread?.value);
  const signs = [];
  if (thread?.kind === 'company') {
    if (HK_WORDS.test(value)) signs.push('its name places it in Hong Kong');
    if (HK_WORDS.test(String(thread?.why || ''))) signs.push('it was found as a Hong Kong company');
    if (looksLikeDomain(value) && hostOf(value).endsWith('.hk')) signs.push('it was given as a .hk address');
  }
  if (thread?.kind !== 'company' || isPrimary(thread, subject)) {
    if (subjectPlaces(subject).some((p) => HK_PLACE.test(p) || HK_WORDS.test(p))) signs.push('the place given is Hong Kong');
    const org = subjectOrgs(subject).find((o) => HK_WORDS.test(o));
    if (org) signs.push(`${org} is in Hong Kong`);
    if (subjectDomains(subject).some((h) => h.endsWith('.hk'))) signs.push('a known web address is on the .hk domain');
  }
  return uniq(signs);
}

/** A tied record found so far that places the person (or this company) in Hong Kong. */
export function hkRecordSigns(task, ctx) {
  const signs = [];
  const company = task.kind === 'company' ? companyMentionMatcher(task.value, { aliases: knownCompanyNames(ctx, task.value).slice(1) }) : null;
  for (const f of tiedFindings(ctx)) {
    const text = `${f.title || ''} ${f.quote || ''}`;
    if (f.source === 'lei-register' && /^HK\b/i.test(String(f.data?.jurisdiction || '')) && (!company || company(text).named)) signs.push('the LEI register gives its jurisdiction as Hong Kong');
    else if (HK_WORDS.test(text) && (!company || company(text).named)) signs.push(`a record tied to the ${company ? 'company' : 'person'} mentions Hong Kong`);
    if (hostOf(String(f.url || '')).endsWith('.hk') && f.match !== 'company') signs.push('a record tied to the person is on a .hk website');
  }
  return uniq(signs);
}

// The EU and EEA: ESMA's register holds sanctions of the national regulators of these countries.
const EEA_CODES = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(' '));
const EU_TLD = /\.(?:eu|at|be|bg|hr|cy|cz|dk|ee|fi|fr|de|gr|hu|ie|it|lv|lt|lu|mt|nl|pl|pt|ro|sk|si|es|se|is|li|no)$/;
// National legal forms, written as the last part of a company name ("Acme GmbH", "Acme S.A.S.", "Acme B.V.")
const EU_FORM = /[,\s](?:GmbH|mbH|AG|KG|KGaA|UG|SE|S\.?A\.?S\.?U?|SARL|S\.?à\.?r\.?l\.?|EURL|SpA|S\.p\.A\.?|S\.?r\.?l\.?|B\.?V\.?|N\.?V\.?|AB|Oy|Oyj|ApS|A\/S|AS|ASA|S\.?L\.?U?|Sp\.?\s*z\s*o\.?\s*o\.?|s\.?\s*r\.?\s*o\.?|a\.?\s*s\.?|Lda|SGPS|S\.?A\.?|SCA|SNC|GIE|e\.?V\.?|KfT|Zrt|Nyrt|d\.?o\.?o\.?|OÜ|UAB|SIA|EOOD|OOD|DAC|CLG)\.?\s*$/;
const EU_WORDS = /\b(?:European Union|Europe|Austria|Austrian|Belgi(?:um|an)|Bulgaria|Bulgarian|Croatia|Croatian|Cyprus|Cypriot|Czech|Denmark|Danish|Estonia|Finland|Finnish|France|French|Germany|German|Greece|Greek|Hungary|Hungarian|Ireland|Irish|Italy|Italian|Latvia|Latvian|Lithuania|Lithuanian|Luxembourg|Luxembourgish|Malta|Maltese|Netherlands|Dutch|Poland|Polish|Portugal|Portuguese|Romania|Romanian|Slovakia|Slovak|Slovenia|Slovenian|Estonian|Spain|Spanish|Sweden|Swedish|Iceland|Icelandic|Liechtenstein|Norway|Norwegian|Paris|Berlin|Munich|München|Frankfurt|Hamburg|Amsterdam|Brussels|Madrid|Barcelona|Milan|Milano|Rome|Dublin|Lisbon|Stockholm|Copenhagen|Helsinki|Vienna|Warsaw|Prague|Athens|Luxembourg|Tallinn|Vilnius|Riga|Oslo)\b/;
const EU_PLACE = new RegExp(`^(?:${[...EEA_CODES].join('|')})$`, 'i');

/** What ties a company to the EU or EEA, from the thread and what is known about the person (no network). */
export function euSigns(thread, subject) {
  if (thread?.kind !== 'company') return [];
  const value = oneLine(thread?.value);
  const signs = [];
  if (EU_FORM.test(value)) signs.push('its name carries a European legal form');
  if (EU_WORDS.test(String(thread?.why || ''))) signs.push('it was found as a European company');
  if (looksLikeDomain(value) && EU_TLD.test(hostOf(value))) signs.push('it was given as a European web address');
  if (isPrimary(thread, subject)) {
    if (subjectPlaces(subject).some((p) => EU_PLACE.test(p) || EU_WORDS.test(p))) signs.push('the place given is in Europe');
    if (subjectDomains(subject).some((h) => EU_TLD.test(h))) signs.push('a known web address is on a European domain');
  }
  // Learned legal names of the company ("Acme GmbH")
  for (const n of knownCompanyNames({ subject }, value).slice(1)) if (EU_FORM.test(n)) { signs.push(`its legal name ${n} carries a European legal form`); break; }
  return uniq(signs);
}

const EU_REGISTERS = new Set(['fr-companies', 'no-company-register', 'cz-company-register', 'fi-trade-register']);
/** A tied record found so far that places this company in the EU or EEA. */
export function euRecordSigns(task, ctx) {
  const signs = [];
  const company = companyMentionMatcher(task.value, { aliases: knownCompanyNames(ctx, task.value).slice(1) });
  for (const f of tiedFindings(ctx)) {
    const text = `${f.title || ''} ${f.quote || ''}`;
    if (f.source === 'lei-register' && EEA_CODES.has(String(f.data?.jurisdiction || '').slice(0, 2).toUpperCase()) && company(text).named) {
      signs.push(`the LEI register gives its jurisdiction as ${String(f.data.jurisdiction).slice(0, 2).toUpperCase()}`);
    }
    if (EU_REGISTERS.has(f.source) && company(text).named) signs.push('a European company register holds a record of it');
  }
  return uniq(signs);
}

/** The source was not asked: said in a note, and marked partial so it is never shown as a clean screen. */
const notAsked = (label, value, place) => ({
  findings: [], threads: [],
  notes: [`${label} was not asked about ${oneLine(value)}: nothing found so far ties ${oneLine(value)} to ${place}.`],
  partial: [`not asked: no tie to ${place} found`],
});

/* ================================================================== 1. FTC cases and proceedings */

const FTC_ID = 'ftc-cases';
const FTC_LABEL = 'US Federal Trade Commission cases and proceedings';
const FTC = 'https://www.ftc.gov';
export const FTC_SEARCH = `${FTC}/legal-library/browse/cases-proceedings`;
const FTC_PAGE_SIZE = 20;

const field = (html, name) => {
  const m = String(html).match(new RegExp(`field--name-${name}\\b[\\s\\S]*?<div class="field__items">([\\s\\S]*?)</div>\\s*</div>`, 'i'));
  return m ? plain(m[1]) : '';
};

/**
 * One page of FTC search results: { total, shown, items: [{ kind, title, url, summary, date, action, matter,
 * docket, status, types }] }. Throws when the page is neither a result list nor the "no results" message.
 */
export function parseFtcResults(html) {
  const text = String(html || '');
  const count = text.match(/Displaying\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  if (!count) {
    if (/class="view-empty"/.test(text) && /No results found/i.test(text)) return { total: 0, shown: 0, items: [] };
    throw new Error('The FTC case search did not answer in the expected format');
  }
  const items = [];
  const starts = [...text.matchAll(/<article about="([^"]+)" class="node node--type-([\w-]+)[^"]*\bnode--view-mode-search-result\b/g)];
  starts.forEach((m, i) => {
    const block = text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : m.index + 40000);
    const title = plain((block.match(/<h3 class="node-title">([\s\S]*?)<\/h3>/i) || [])[1] || '');
    const path = m[1];
    if (!title || !path.startsWith('/legal-library/browse/cases-proceedings/')) return;
    const types = [...(block.match(/field--name-field-legal-library-record-types[\s\S]*?<\/div>\s*<\/div>/i) || [''])[0].matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((x) => plain(x[1]));
    const summary = plain((block.match(/field--name-body[\s\S]*?<div class="field__item">([\s\S]*?)<\/div>\s*<\/div>/i) || [])[1] || '');
    items.push({
      kind: m[2] === 'case' ? 'case' : 'statement',
      title,
      url: `${FTC}${path}`,
      summary,
      date: isoDay((block.match(/<time datetime="([^"]+)"/) || [])[1]),
      action: field(block, 'field-case-action-type'),
      matter: field(block, 'field-matter-number'),
      docket: field(block, 'field-docket-number'),
      status: field(block, 'field-case-status'),
      types: types.filter((t) => t !== 'Cases and Proceedings'),
    });
  });
  const total = Number(count[3]);
  // How many results the page itself says it shows; far fewer readable results means the layout has changed
  const shown = Math.max(0, Number(count[2]) - Number(count[1]) + 1);
  if (total > 0 && starts.length < Math.ceil(shown / 2)) throw new Error('The FTC case search listed results that could not be read');
  return { total, shown, items };
}

/** The part of a statement's title that names the matter ("... Regarding FTC v. Acme"), or '' when it names none. */
const matterPart = (title) => {
  const m = String(title).match(/\b(?:regarding|concerning|in the matter of|matter of|in re|v\.|vs\.?)\s/i);
  return m ? title.slice(m.index) : '';
};

const LEGAL_TAIL_WORD = /^(?:Inc|Incorporated|LLC|L\.L\.C|Ltd|Limited|Corp|Corporation|Co|Company|L\.?P|LLP|PLC|N\.?A|PBC|AG|SA|S\.A|GmbH|BV|NV)\b/;
/**
 * The parties a case title names: "Brightwell Analytics, Inc., and Dana Roe, FTC v." -> ["Brightwell Analytics,
 * Inc.", "Dana Roe"]; "Statement ... In the Matter of Uber, Inc." -> ["Uber, Inc."]. A comma before a legal form
 * stays inside the name.
 */
export function ftcParties(caption) {
  let t = oneLine(caption);
  const marker = t.match(/\b(?:in the matter of|matter of|in re|v\.|vs\.?)\s+/i);
  if (marker && !/,?\s*(?:FTC|Federal Trade Commission|U\.\s?S\.|United States)[^,]*\s+v\.?\s*$|,?\s*In the Matter of\s*$/i.test(t)) t = t.slice(marker.index + marker[0].length);
  t = t.replace(/,?\s*(?:FTC|Federal Trade Commission|U\.\s?S\.|United States)[^,]*\s+v\.?\s*$/i, '').replace(/,?\s*In the Matter of\s*$/i, '').replace(/,?\s*et\.? al\.?\s*$/i, '');
  const parts = [];
  for (const piece of t.split(/\s*;\s*(?:and\s+)?|\s+and\s+/i)) {
    let current = '';
    for (const bit of piece.split(/\s*,\s*/)) {
      if (!bit) continue;
      if (current && LEGAL_TAIL_WORD.test(bit)) current = `${current}, ${bit}`;
      else { if (current) parts.push(current); current = bit.replace(/^and\s+/i, ''); }
    }
    if (current) parts.push(current);
  }
  return uniq(parts.map(oneLine).filter((p) => /[A-Za-z]/.test(p)));
}

/** The first sentences of a case summary, cleaned by the privacy rules (consumers are never named in a quote). */
const summaryQuote = (s) => clip(cleanSentences(oneLine(s).split(/(?<=[.!?])\s+/).slice(0, 2).join(' ')).text, 320);

function ftcQuote(item) {
  return [
    `${item.kind === 'case' ? 'Case' : (item.types[0] || 'Statement')}: ${item.title}`,
    item.action ? `Type of action: ${item.action}` : '',
    item.matter ? `FTC matter number: ${item.matter}` : '',
    item.docket ? `Docket number: ${item.docket}` : '',
    item.status ? `Case status: ${item.status}` : '',
    item.date ? `${item.kind === 'case' ? 'Last updated' : 'Dated'}: ${item.date}` : '',
    item.summary ? summaryQuote(item.summary) : '',
  ].filter(Boolean).join(' | ');
}

const ftcSeverity = (item) => (item.kind === 'case' ? atLeastMedium(severityFromText(`${item.title}. ${item.summary}`)) : 'low');

async function searchFtc(query, deadline) {
  const url = `${FTC_SEARCH}?search=${encodeURIComponent(query)}`;
  const html = await fetchText(url, deadline, { timeoutMs: 18000, maxBytes: 3 * 1024 * 1024, accept: 'text/html' });
  return { url, ...parseFtcResults(html) };
}

export const ftcCasesConnector = {
  id: FTC_ID,
  label: FTC_LABEL,
  kinds: ['subject', 'alias', 'company'],
  prior: 0.25,
  maxParallel: 1,
  timeoutMs: 25000,
  // ftc.gov turns away automated readers that declare no contact
  enabled: () => contactDeclared() && !switchedOff(FTC_ID),
  unavailableReason: 'The FTC site asks automated readers to name a contact, and this deployment does not declare one.',
  plan(thread) {
    if (isSelfTask(thread)) return [{ template: 'ftc.person', prior: 0.25, why: 'FTC cases and proceedings naming the person' }];
    if (thread?.kind === 'company') return [{ template: 'ftc.company', prior: 0.3, why: 'FTC cases and proceedings against the company' }];
    return [];
  },
  async run(task, ctx) {
    const subject = ctx.subject;
    if (task.kind === 'company') {
      const names = knownCompanyNames(ctx, task.value);
      if (!canScreenCompany(names)) return { findings: [], threads: [], notes: [`${FTC_LABEL}: "${oneLine(task.value)}" is too short a company name to search`], partial: ['name too short to search'] };
      const mention = companyMentionMatcher(names[0], { aliases: names.slice(1) });
      const queries = names.slice(0, 2);
      const findings = [];
      const notes = [];
      const partial = [];
      const seen = new Set();
      for (const q of queries) {
        // eslint-disable-next-line no-await-in-loop
        const page = await searchFtc(q, ctx.deadline);
        if (page.total > page.shown) partial.push(`first ${page.shown} of ${page.total} results for ${clip(q, 40)}`);
        for (const item of page.items) {
          if (seen.has(item.url) || findings.length >= MAX_FINDINGS) continue;
          // the case title (or the matter a statement is about) must name the company as a company
          const caption = item.kind === 'case' ? item.title : matterPart(item.title);
          if (!caption) continue;
          // Named as a company in the title (the shared matcher), or a party of the title is one of the
          // company's known names, legal form set aside (a one-word name then stays possible)
          const named = mention(caption).named;
          const party = named ? '' : ftcParties(caption).find((x) => names.some((n) => matchCompanyName(n, x)));
          if (!named && !party) continue;
          seen.add(item.url);
          const base = {
            source: FTC_ID, sourceLabel: FTC_LABEL, category: 'regulatory', severity: ftcSeverity(item),
            title: `FTC ${item.kind === 'case' ? 'case' : (item.types[0] || 'statement').toLowerCase()}: ${item.title}`,
            quote: ftcQuote(item), url: item.url, date: item.date || null,
            data: { agency: 'FTC', kind: item.kind, matter: item.matter || null, docket: item.docket || null, status: item.status || null, action: item.action || null, searched: q },
          };
          const where = item.kind === 'case' ? 'case title' : 'matter named';
          const f = named
            ? makeFinding(subject, { ...base, match: 'company', matchReasons: [`the ${where} names ${oneLine(task.value)} as a company`] })
            : companyFinding(subject, base, { via: names.find((n) => matchCompanyName(n, party)), reason: `the ${where} names ${party} as a party` });
          if (f) findings.push(f);
        }
      }
      notes.push(findings.length
        ? `FTC cases and proceedings: searched for ${queries.map((q) => `"${q}"`).join(' and ')}; ${plural(findings.length, 'case or statement', 'cases or statements')} ${findings.length === 1 ? 'names' : 'name'} the company in the title`
        : `FTC cases and proceedings: searched for ${queries.map((q) => `"${q}"`).join(' and ')}; no case or statement names ${oneLine(task.value)} in its title`);
      if (partial.length) notes.push(`FTC cases and proceedings: only the first page of results was read (${partial.join('; ')})`);
      return { findings, threads: [], notes, ...(partial.length ? { partial } : {}) };
    }
    const names = personNames(task, ctx);
    if (!names.length) return { findings: [], threads: [], notes: [`${FTC_LABEL}: "${oneLine(task.value)}" is too short a name to search`], partial: ['name too short to search'] };
    const q = coreName(names);
    const page = await searchFtc(q, ctx.deadline);
    const matchers = names.map((n) => personNameMatcher(n));
    const findings = [];
    for (const item of page.items) {
      if (findings.length >= MAX_FINDINGS) break;
      // a statement counts only when the person is named in the matter it is about, never as its author
      const caption = item.kind === 'case' ? item.title : matterPart(item.title);
      if (!caption || !matchers.some((m) => m(caption))) continue;
      const second = textNamesGivenCompany(subject, `${item.title}. ${item.summary}`) ? `the record also names ${subject.company}, the company the check was started with` : '';
      const f = personFinding(subject, {
        source: FTC_ID, sourceLabel: FTC_LABEL, category: 'regulatory', severity: ftcSeverity(item),
        title: `FTC ${item.kind === 'case' ? 'case' : (item.types[0] || 'statement').toLowerCase()}: ${item.title}`,
        quote: ftcQuote(item), url: item.url, date: item.date || null,
        data: { agency: 'FTC', kind: item.kind, matter: item.matter || null, docket: item.docket || null, status: item.status || null, action: item.action || null, searched: q },
      }, { tier: 1, second });
      if (f) findings.push(f);
    }
    const notes = [findings.length
      ? `FTC cases and proceedings: searched for "${q}"; ${plural(findings.length, 'case or statement', 'cases or statements')} ${findings.length === 1 ? 'names' : 'name'} the person in the title`
      : `FTC cases and proceedings: searched for "${q}"; no case or statement names ${oneLine(task.value)} in its title`];
    if (page.total > page.shown) {
      notes.push(`FTC cases and proceedings: the search found ${page.total} results for "${q}"; only the first ${page.shown} were read`);
      return { findings, threads: [], notes, partial: [`first ${page.shown} of ${page.total} results`] };
    }
    return { findings, threads: [], notes };
  },
};

/* ================================================================== 2. ESMA register of national sanctions */

const ESMA_ID = 'esma-sanctions-register';
const ESMA_LABEL = 'EU register of national regulators\' sanctions (ESMA)';
const ESMA = 'https://registers.esma.europa.eu';
export const ESMA_PAGE = `${ESMA}/publication/searchRegister?core=esma_registers_sanctions`;
// Never sn_text: it holds national decision text with addresses
const ESMA_FIELDS = 'id,sn_entityName,sn_date,sn_ncaCodeFullName,sn_natureFullName,sn_sanctionLegalFrameworkName,sn_countryName,sn_entityLEI';
export const ESMA_URL = `${ESMA}/solr/esma_registers_sanctions/select?q=*:*&rows=5000&wt=json&fl=${ESMA_FIELDS}`;
export const ESMA_NOTE = 'Source: ESMA register of administrative sanctions imposed by national regulators. Its listing of a firm is not an endorsement or assessment of that firm by ESMA.';

/** "PBN CAPITAL (CAPITAL TECH LTD / PBOX LTD)" -> name PBN CAPITAL, other names CAPITAL TECH LTD and PBOX LTD. */
export function esmaNames(raw) {
  const text = plain(raw);
  const inner = [];
  const name = oneLine(text.replace(/\(([^()]*)\)/g, (m, x) => { inner.push(x); return ' '; }));
  const others = inner.flatMap((x) => x.split(/\s*\/\s*|\s*;\s*/)).map(oneLine).filter((x) => x && !/^(?:www\.|https?:)/i.test(x) && normalizeName(x).length >= 3);
  return { name: name || text, aliases: uniq(others).slice(0, 6) };
}

/** Build the compact index from the register's answer. */
export function parseEsma(text) {
  const json = parseJson(text, 'The ESMA sanctions register');
  const docs = json?.response?.docs;
  const found = Number(json?.response?.numFound);
  if (!Array.isArray(docs) || !Number.isFinite(found)) throw new Error('The ESMA sanctions register is not in the expected format');
  if (docs.length < found) throw new Error('The ESMA sanctions register sent only part of its entries');
  if (docs.length < 500) throw new Error('The ESMA sanctions register had too few entries to be the whole register');
  if (!docs.slice(0, 50).some((d) => d && 'sn_date' in d && 'sn_ncaCodeFullName' in d)) throw new Error('The ESMA sanctions register is not in the expected format');
  const rows = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    const raw = String(d.sn_entityName || '');
    if (!raw.trim()) continue; // a person, or a name the regulator withheld: firm level only
    const { name, aliases } = esmaNames(raw);
    if (normalizeName(name).length < 2) continue;
    const href = (raw.match(/href=['"]([^'"]+)['"]/) || [])[1] || '';
    rows.push({
      n: clip(name, 200),
      ...(aliases.length ? { a: aliases } : {}),
      ...(/^details\?core=esma_registers_upreg&docId=[\w-]+$/.test(href) ? { u: `${ESMA}/publication/${href}` } : {}),
      ...(/^[A-Z0-9]{20}$/.test(String(d.sn_entityLEI || '')) ? { l: d.sn_entityLEI } : {}),
      d: isoDay(d.sn_date),
      r: clip(plain(d.sn_ncaCodeFullName), 120),
      k: clip(plain(d.sn_natureFullName), 120),
      w: clip(plain(d.sn_sanctionLegalFrameworkName), 40),
      c: clip(plain(d.sn_countryName), 40),
    });
  }
  if (rows.length < 200) throw new Error('The ESMA sanctions register had too few named firms to be whole');
  return { v: 1, key: 'esma', at: new Date().toISOString(), rows };
}

const loadEsma = (deadline) => loadList('regulators:esma-sanctions:v1', async (d) => parseEsma(await fetchText(ESMA_URL, d, { timeoutMs: 20000, maxBytes: 4 * 1024 * 1024, accept: 'application/json' })), deadline);

/** The LEIs the LEI register tied to the person's companies. */
const tiedLeis = (ctx) => new Set(tiedFindings(ctx).filter((f) => f.source === 'lei-register' && f.match === 'company' && /^[A-Z0-9]{20}$/.test(String(f.data?.lei || ''))).map((f) => f.data.lei));

export const esmaSanctionsConnector = {
  id: ESMA_ID,
  label: ESMA_LABEL,
  kinds: ['company'],
  prior: 0.15,
  timeoutMs: 25000,
  enabled: () => !switchedOff(ESMA_ID),
  unavailableReason: 'The EU register of national regulators\' sanctions is not enabled on this deployment.',
  plan(thread, subject) {
    if (thread?.kind !== 'company') return [];
    const signs = euSigns(thread, subject);
    if (signs.length) return [{ template: 'esma.company', prior: 0.2, why: `EU regulators' sanctions: ${signs[0]}` }];
    // The company given gets a late check: run() reads the records found by then for a European tie
    if (isPrimary(thread, subject)) return [{ template: 'esma.if-placed', prior: 0.06, why: 'ask the EU sanctions register only if the records place the company in Europe' }];
    return [];
  },
  async run(task, ctx) {
    if (task.kind !== 'company') return { findings: [], threads: [], notes: [] };
    const value = oneLine(task.value);
    const signs = [...euSigns(task, ctx.subject), ...euRecordSigns(task, ctx)];
    const leis = tiedLeis(ctx);
    if (!signs.length && !leis.size) return notAsked('The EU register of national regulators\' sanctions (ESMA)', value, 'the EU or EEA');
    const names = knownCompanyNames(ctx, value);
    if (!canScreenCompany(names) && !leis.size) return { findings: [], threads: [], notes: [`${ESMA_LABEL}: "${value}" is too short a company name to screen`], partial: ['name too short to screen'] };
    const copy = await loadEsma(ctx.deadline);
    const hits = [];
    for (const row of copy.index.rows) {
      const byLei = row.l && leis.has(row.l);
      let via = '';
      let matched = '';
      for (const n of names) {
        matched = [row.n, ...(row.a || [])].find((x) => matchCompanyName(n, x)) || '';
        if (matched) { via = n; break; }
      }
      if (byLei || matched) hits.push({ row, via: via || value, matched: matched || row.n, byLei });
    }
    hits.sort((a, b) => Number(b.byLei) - Number(a.byLei) || String(b.row.d).localeCompare(String(a.row.d)));
    const findings = hits.slice(0, MAX_FINDINGS).map(({ row, via, matched, byLei }) => companyFinding(ctx.subject, {
      source: ESMA_ID, sourceLabel: ESMA_LABEL, category: 'regulatory', severity: 'medium',
      title: `${row.r || 'An EU national regulator'} sanction (${row.w || 'financial services law'}): ${row.n}`,
      quote: [
        `Firm: ${row.n}`,
        matched !== row.n ? `Also named: ${matched}` : '',
        row.c ? `Country: ${row.c}` : '',
        row.r ? `Regulator: ${row.r}` : '',
        row.k ? `Nature: ${row.k}` : '',
        row.w ? `Legal framework: ${row.w}` : '',
        row.d ? `Date: ${row.d}` : '',
        row.l ? `LEI: ${row.l}` : '',
      ].filter(Boolean).join(' | '),
      url: row.u || ESMA_PAGE,
      date: row.d || null,
      data: { register: 'ESMA sanctions', regulator: row.r || null, framework: row.w || null, nature: row.k || null, country: row.c || null, lei: row.l || null, searched: value, listReadAt: new Date(copy.at).toISOString() },
    }, { via, reason: byLei ? `the register lists ${row.n}` : `the register lists ${row.n}, the same name as ${via}`, lei: byLei })).filter(Boolean);
    const notes = [ESMA_NOTE, `EU national regulators' sanctions: asked because ${signs[0] || 'the LEI register tied an identifier to the company'}`];
    if (!hits.length) notes.push(`EU national regulators' sanctions: no firm named ${names.join(' or ')} in the register${asOfText(copy)}. The register covers firms only; sanctions on individuals are not named there.`);
    if (hits.length > MAX_FINDINGS) notes.push(`EU national regulators' sanctions: ${hits.length} entries match; the ${MAX_FINDINGS} most recent are shown`);
    return withStale({ findings, threads: [], notes }, 'EU national regulators\' sanctions', copy);
  },
};

/* ================================================================== 3. Hong Kong SFC enforcement news */

const SFC_ID = 'sfc-hk-enforcement';
const SFC_LABEL = 'Hong Kong Securities and Futures Commission enforcement news';
const SFC_SEARCH = 'https://apps.sfc.hk/edistributionWeb/api/news/search';
const SFC_DOC = 'https://apps.sfc.hk/edistributionWeb/gateway/EN/news-and-announcements/news/doc?refNo=';
const SFC_PAGE_SIZE = 5000;

// A target that is a firm, not a person
const FIRM_WORDS = /\b(?:limited|ltd|llc|l\.l\.c|inc|incorporated|corp|corporation|company|co|plc|lp|llp|gmbh|ag|s\.a|bhd|pte|holdings?|group|securities|capital|management|bank|banking|partners|fund|funds|investments?|asset|assets|international|financial|finance|futures|brokerage|broking|brokers?|trust|trustees?|services|consultants?|consulting|enterprises?|associates|ventures|technology|technologies|industries|development|properties|resources|advisors?|advisers?|wealth|markets?|exchange|insurance|nominees?|agency|investment)\b|[()&]|\.com\b/i;
// A target of one word ("Binance") is a firm: a person is always listed with a surname and a given name
export const isSfcFirm = (name) => FIRM_WORDS.test(String(name || '')) || oneLine(name).split(' ').length < 2;

/**
 * The forms of an SFC target's name. The SFC writes the surname first, then the given names and an optional
 * English name, sometimes after a comma: "HWANG Sung Kook Bill", "CHOW Pak Wah, Oliver", "Evans Daryl Paul".
 * Each form is written given names first, so the shared matcher reads it: "Sung Kook Bill HWANG", "Sung Kook
 * HWANG", "Bill HWANG"; "Pak Wah CHOW", "Oliver CHOW".
 */
export function sfcPersonForms(raw) {
  const [main, english = ''] = oneLine(raw).split(/\s*,\s*/);
  const words = oneLine(main).split(' ').filter(Boolean);
  if (words.length < 2) return [];
  const [surname, ...givens] = words;
  const out = [`${givens.join(' ')} ${surname}`, oneLine(raw)];
  const eng = oneLine(english);
  if (eng) out.push(`${eng} ${surname}`, `${givens.join(' ')} ${eng} ${surname}`);
  else if (givens.length >= 3) out.push(`${givens[givens.length - 1]} ${surname}`, `${givens.slice(0, -1).join(' ')} ${surname}`);
  return uniq(out);
}

/** Build the compact index from the SFC's enforcement news list. */
export function parseSfc(text) {
  const json = parseJson(text, 'The SFC enforcement news list');
  const items = json?.items;
  const total = Number(json?.total);
  if (!Array.isArray(items) || !Number.isFinite(total)) throw new Error('The SFC enforcement news list is not in the expected format');
  if (items.length < total) throw new Error('The SFC enforcement news list sent only part of its releases');
  if (items.length < 1500) throw new Error('The SFC enforcement news list had too few releases to be whole');
  const since = new Date(Date.now() - 548 * DAY_MS).toISOString().slice(0, 10);
  if (!items.some((x) => isoDay(x?.issueDate) >= since)) throw new Error('The SFC enforcement news list holds no recent release');
  const rows = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || !/^[\w-]{3,20}$/.test(String(it.newsRefNo || ''))) continue;
    const targets = (Array.isArray(it.targetCeList) ? it.targetCeList : []).filter((t) => t && !t.masked && oneLine(t.ceName) && !/\{X\}/.test(t.ceName));
    if (!targets.length) continue;
    const p = [];
    const f = [];
    for (const t of targets) (isSfcFirm(t.ceName) ? f : p).push(clip(oneLine(t.ceName), 120));
    rows.push({ r: it.newsRefNo, t: clip(plain(it.title), 220), d: isoDay(it.issueDate), ...(p.length ? { p } : {}), ...(f.length ? { f } : {}) });
  }
  if (rows.length < 1000) throw new Error('The SFC enforcement news list had too few named releases to be whole');
  return { v: 1, key: 'sfc', at: new Date().toISOString(), rows };
}

const loadSfc = (deadline) => loadList('regulators:sfc-enforcement:v1', async (d) => {
  await waitTurn(SFC_SEARCH, d);
  const { text } = await request(SFC_SEARCH, {
    method: 'POST', body: { lang: 'EN', category: 'enforcement', pageNo: 0, pageSize: SFC_PAGE_SIZE }, deadline: d, timeoutMs: 20000, maxBytes: 5 * 1024 * 1024, accept: 'application/json',
  });
  return parseSfc(text);
}, deadline);

const sfcSeverity = (title) => (/\bban|banned|prohibit|convict|jail|imprison|sentenc|disqualif|revok|suspend|market misconduct|insider dealing|manipulat|fraud|cold shoulder\b/i.test(title) ? 'high' : atLeastMedium(severityFromText(title)));

export const sfcEnforcementConnector = {
  id: SFC_ID,
  label: SFC_LABEL,
  kinds: ['subject', 'alias', 'company'],
  prior: 0.15,
  timeoutMs: 25000,
  enabled: () => switchedOn(SFC_ID),
  unavailableReason: 'Hong Kong securities regulator enforcement news is not enabled on this deployment.',
  plan(thread, subject) {
    if (!isSelfTask(thread) && thread?.kind !== 'company') return [];
    const signs = hkSigns(thread, subject);
    const what = isSelfTask(thread) ? 'person' : 'company';
    if (signs.length) return [{ template: `sfc.${what}`, prior: 0.25, why: `Hong Kong securities regulator: ${signs[0]}` }];
    // The person and the company given get a late check: run() reads the records found by then for a Hong Kong tie
    if (isSelfTask(thread) || isPrimary(thread, subject)) return [{ template: `sfc.${what}.if-placed`, prior: 0.06, why: 'ask the Hong Kong securities regulator only if the records place the person or company there' }];
    return [];
  },
  async run(task, ctx) {
    if (task.kind !== 'subject' && task.kind !== 'company') return { findings: [], threads: [], notes: [] };
    const subject = ctx.subject;
    const value = oneLine(task.value);
    const signs = [...hkSigns(task, subject), ...hkRecordSigns(task, ctx)];
    if (!signs.length) return notAsked('Hong Kong securities regulator enforcement news (SFC)', value, 'Hong Kong');
    const person = task.kind === 'subject';
    const names = person ? personNames(task, ctx) : knownCompanyNames(ctx, value);
    if (person ? !names.length : !canScreenCompany(names)) return { findings: [], threads: [], notes: [`${SFC_LABEL}: "${value}" is too short a name to screen`], partial: ['name too short to screen'] };
    const copy = await loadSfc(ctx.deadline);
    const hits = [];
    for (const row of copy.index.rows) {
      if (person) {
        let best = null;
        for (const listedName of row.p || []) {
          for (const form of sfcPersonForms(listedName)) {
            const tier = matchPersonName(names, form);
            if (tier && (!best || tier < best.tier)) best = { tier, listed: listedName };
          }
        }
        if (best) hits.push({ row, ...best });
      } else {
        for (const firm of row.f || []) {
          const via = names.find((n) => matchCompanyName(n, firm));
          if (via) { hits.push({ row, listed: firm, via }); break; }
        }
      }
    }
    hits.sort((a, b) => (a.tier || 1) - (b.tier || 1) || String(b.row.d).localeCompare(String(a.row.d)));
    const findings = [];
    for (const h of hits.slice(0, MAX_FINDINGS)) {
      const { row } = h;
      const others = (row.p || []).filter((x) => x !== h.listed).length;
      const f = {
        source: SFC_ID, sourceLabel: SFC_LABEL, category: 'regulatory', severity: sfcSeverity(row.t),
        title: `Hong Kong SFC: ${row.t}`,
        quote: [
          `Release: ${row.t}`,
          `Named target: ${h.listed}`,
          row.f?.length && person ? `Firms named: ${row.f.slice(0, 4).join('; ')}` : '',
          !person && row.f?.length > 1 ? `Other firms named: ${row.f.filter((x) => x !== h.listed).slice(0, 3).join('; ')}` : '',
          others ? `${plural(others, 'other individual')} named (not listed here)` : '',
          `Issued: ${row.d}`,
          `Reference: ${row.r}`,
        ].filter(Boolean).join(' | '),
        url: `${SFC_DOC}${encodeURIComponent(row.r)}`,
        date: row.d || null,
        data: { regulator: 'SFC (Hong Kong)', reference: row.r, target: h.listed, searched: value, listReadAt: new Date(copy.at).toISOString() },
      };
      let finding;
      if (person) {
        const firm = (row.f || []).find((x) => firmIsGivenCompany(subject, x));
        const second = firm ? `the same release names ${firm}, the company the check was started with`
          : textNamesGivenCompany(subject, row.t) ? `the release title names ${subject.company}, the company the check was started with` : '';
        finding = personFinding(subject, f, { tier: h.tier, second });
      } else {
        finding = companyFinding(subject, f, { via: h.via, reason: `the release names ${h.listed} as a target, the same name as ${h.via}` });
      }
      if (finding) findings.push(finding);
    }
    const notes = [`Hong Kong SFC enforcement news: asked because ${signs[0]}`];
    if (!hits.length) notes.push(`Hong Kong SFC enforcement news: no release since 1997 names ${value} as a target${asOfText(copy)}. Targets the SFC masks in its list are not searchable.`);
    if (hits.length > MAX_FINDINGS) notes.push(`Hong Kong SFC enforcement news: ${hits.length} releases match the name; the first ${MAX_FINDINGS} are shown`);
    return withStale({ findings, threads: [], notes }, 'Hong Kong SFC enforcement news', copy);
  },
};

/* ================================================================== 4. US Tax Court */

const TAX_ID = 'us-tax-court';
const TAX_LABEL = 'US Tax Court dockets and opinions';
const TAX_HOSTS = ['https://public-api-green.dawson.ustaxcourt.gov/public-api', 'https://public-api-blue.dawson.ustaxcourt.gov/public-api'];
export const TAX_CASE_PAGE = 'https://dawson.ustaxcourt.gov/case-detail/';
const OPINION_TYPES = 'MOP,SOP,TCOP,OST,RPT';
const TAX_RESULT_CAP = 500;

/** The Court's search, on the green host and then the blue one (one of them is down during a deployment). */
async function taxCourt(path, deadline) {
  let last = null;
  for (const base of TAX_HOSTS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await fetchText(`${base}${path}`, deadline, { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024, accept: 'application/json' });
      const json = parseJson(text, 'The Tax Court search');
      if (!json || !Array.isArray(json.results)) throw new Error('The Tax Court search did not answer in the expected format');
      return json.results;
    } catch (error) {
      last = error;
      // another host is worth trying only when this one is down, not when the answer itself was wrong
      const down = error?.code === 'network' || error?.code === 'timeout' || (error?.code === 'status' && Number(error.status) >= 500);
      if (!down) throw error;
    }
  }
  throw last;
}

/**
 * A petitioner's own name. "Sunil & Mita Patel" (a joint name the Court kept as one) gives "Sunil Patel" and is
 * never kept whole; "X, Deceased" and estates are not people the check is about.
 */
export function petitionerForms(raw) {
  const name = oneLine(raw);
  if (/\b(?:estate of|deceased|trust\b|trustee)/i.test(name)) return [];
  const parts = name.split(/\s*(?:&|\band\b)\s*/i).map(oneLine).filter(Boolean);
  if (parts.length < 2) return [name];
  const last = parts[parts.length - 1].split(' ');
  const surname = last[last.length - 1];
  return parts.map((p) => (p.split(' ').length === 1 ? `${p} ${surname}` : p));
}

/** A corporate petitioner's name without the Court's additions ("Acme, Inc. & Subsidiaries"). */
const corporateName = (raw) => oneLine(String(raw || '').replace(/\s*(?:&|and)\s+subsidiar(?:y|ies)\b.*$/i, '').replace(/,?\s*(?:petitioners?|transferees?)\s*$/i, ''));

function taxCaseFields(r) {
  const docket = oneLine(r.docketNumberWithSuffix || r.docketNumber);
  return { docket, plainDocket: oneLine(r.docketNumber), small: /S$/.test(docket) };
}

export const usTaxCourtConnector = {
  id: TAX_ID,
  label: TAX_LABEL,
  kinds: ['subject', 'alias', 'company'],
  prior: 0.15,
  maxParallel: 1,
  timeoutMs: 25000,
  enabled: () => switchedOn(TAX_ID),
  unavailableReason: 'US Tax Court dockets and opinions are not enabled on this deployment.',
  plan(thread) {
    if (!isSelfTask(thread) && thread?.kind !== 'company') return [];
    return [
      { template: 'taxcourt.cases', prior: 0.15, why: 'US Tax Court cases where the name is the petitioner' },
      { template: 'taxcourt.opinions', prior: 0.12, why: 'US Tax Court opinions in cases of that petitioner' },
    ];
  },
  async run(task, ctx) {
    if (task.kind !== 'subject' && task.kind !== 'company') return { findings: [], threads: [], notes: [] };
    const subject = ctx.subject;
    const person = task.kind === 'subject';
    const value = oneLine(task.value);
    const opinions = String(task.template || '') === 'taxcourt.opinions';
    const names = person ? personNames(task, ctx) : knownCompanyNames(ctx, value);
    if (person ? !names.length : !canScreenCompany(names)) return { findings: [], threads: [], notes: [`${TAX_LABEL}: "${value}" is too short a name to search`], partial: ['name too short to search'] };
    const queries = person ? [coreName(names)] : names.slice(0, 2);
    const results = [];
    let capped = false;
    for (const q of queries) {
      const path = opinions
        ? `/opinion-search?keyword=${encodeURIComponent(q)}&dateRange=allDates&opinionTypes=${OPINION_TYPES}`
        : `/search?petitionerName=${encodeURIComponent(q)}`;
      // eslint-disable-next-line no-await-in-loop
      const got = await taxCourt(path, ctx.deadline);
      if (got.length >= TAX_RESULT_CAP) capped = true;
      results.push(...got);
    }
    // One finding per docket (and per opinion), the person's own name only
    const seen = new Set();
    const hits = [];
    for (const r of results) {
      if (!r || typeof r !== 'object') continue;
      // a case lists its petitioners; an opinion only its caption ("A & B, Petitioners")
      const listedNames = Array.isArray(r.petitionerNames) && r.petitionerNames.length ? r.petitionerNames : [String(r.caseCaption || '').replace(/,\s*Petitioners?\s*$/i, '')];
      let best = null;
      if (person) {
        for (const listedName of listedNames) {
          for (const form of petitionerForms(listedName)) {
            const tier = matchPersonName(names, form);
            if (tier && (!best || tier < best.tier)) best = { tier, listed: form };
          }
        }
      } else {
        for (const listedName of listedNames.flatMap((x) => x.split(/\s+&\s+(?!subsidiar)/i))) {
          const firm = corporateName(listedName);
          const via = names.find((n) => matchCompanyName(n, firm));
          if (via) { best = { tier: 1, listed: firm, via }; break; }
        }
      }
      if (!best) continue;
      const { docket } = taxCaseFields(r);
      const key = opinions ? `${docket}|${oneLine(r.docketEntryId)}|${oneLine(r.documentTitle)}` : docket;
      if (!docket || seen.has(key)) continue;
      seen.add(key);
      const everyone = person ? listedNames.flatMap((x) => petitionerForms(x)).length : listedNames.length;
      hits.push({ r, ...best, others: Math.max(0, everyone - 1) });
    }
    hits.sort((a, b) => a.tier - b.tier || String(b.r.filingDate || b.r.receivedAt).localeCompare(String(a.r.filingDate || a.r.receivedAt)));
    const findings = [];
    for (const h of hits.slice(0, MAX_FINDINGS)) {
      const { docket, plainDocket, small } = taxCaseFields(h.r);
      const date = isoDay(opinions ? h.r.filingDate : h.r.receivedAt);
      const kind = opinions ? clip(plain(h.r.documentType || 'Opinion'), 60) : 'case';
      const f = {
        source: TAX_ID, sourceLabel: TAX_LABEL, category: 'litigation', severity: opinions ? 'medium' : 'low',
        title: opinions
          ? `US Tax Court ${kind}, docket ${docket}: ${h.listed}, petitioner`
          : `US Tax Court case ${docket}: ${h.listed}, petitioner`,
        quote: [
          `Petitioner: ${h.listed}`,
          h.others ? `${plural(h.others, 'other petitioner')} on the same case (not named here)` : '',
          `Docket: ${docket}${small ? ' (small tax case)' : ''}`,
          opinions && h.r.documentTitle ? `Document: ${clip(plain(h.r.documentTitle), 200)}` : '',
          opinions && h.r.judge ? `Judge: ${clip(plain(h.r.judge), 60)}` : '',
          date ? `${opinions ? 'Filed' : 'Petition received'}: ${date}` : '',
        ].filter(Boolean).join(' | '),
        url: `${TAX_CASE_PAGE}${encodeURIComponent(plainDocket || docket.replace(/[A-Z]+$/, ''))}`,
        date: date || null,
        data: { court: 'US Tax Court', docket, ...(opinions ? { documentType: kind } : {}), searched: value },
      };
      const finding = person
        ? personFinding(subject, f, { tier: h.tier, second: '' })
        : companyFinding(subject, f, { via: h.via, reason: `the Court lists ${h.listed} as the petitioner, the same name as ${h.via}` });
      if (finding) findings.push(finding);
    }
    const what = opinions ? 'opinions' : 'cases';
    const notes = [hits.length
      ? `US Tax Court ${what}: searched for ${queries.map((q) => `"${q}"`).join(' and ')}; ${plural(hits.length, opinions ? 'opinion' : 'case')} with ${value} as petitioner`
      : `US Tax Court ${what}: searched for ${queries.map((q) => `"${q}"`).join(' and ')}; no ${opinions ? 'opinion in a case' : 'case'} with ${value} as petitioner`];
    if (hits.length > MAX_FINDINGS) notes.push(`US Tax Court ${what}: ${hits.length} match; the first ${MAX_FINDINGS} are shown`);
    if (person && hits.length) notes.push('US Tax Court: a petitioner here is matched by name only; the Court\'s list gives no employer, so verify identity.');
    if (capped) {
      notes.push(`US Tax Court ${what}: the search returned ${TAX_RESULT_CAP} or more results, so some may not have been read`);
      return { findings, threads: [], notes, partial: [`${what}: more results than were read`] };
    }
    return { findings, threads: [], notes };
  },
};

/** The four sources of this file, for the registry. */
export const REGULATORS_MORE_CONNECTORS = [ftcCasesConnector, esmaSanctionsConnector, sfcEnforcementConnector, usTaxCourtConnector];

// Another name of the person ('alias') is searched like their own; a record found only under a name read from a
// record is 'likely' at most (alias.js).
for (const c of [ftcCasesConnector, sfcEnforcementConnector, usTaxCourtConnector]) c.run = withAliasHold(c.run);
