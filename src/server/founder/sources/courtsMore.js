/**
 * More courts, trade cases and agency orders, beyond courts.js.
 *
 *   delawareCourtsConnector         Delaware Court of Chancery, Superior Court and Supreme Court opinions and orders
 *   federalRegisterActionsConnector US agency orders (debarments, export bans, consent orders) and US International
 *                                   Trade Commission import cases (Section 337), from the Federal Register
 *   euCourtsConnector               judgments of the EU Court of Justice and General Court, and EU competition
 *                                   decisions, from the EU Publications Office (EUR-Lex)
 *   canadaFederalCourtsConnector    decisions of the Federal Court of Canada and the Federal Court of Appeal
 *
 * Every one is reached the way it publishes itself: the Federal Register's
 * documented search, the EU Publications Office's public query service, and
 * the two courts' own public search pages (both allowed by robots.txt; no
 * terms forbid it). Each is paced and identified as an automated reader.
 *
 * The rules from courts.js hold here too. A record is tied to the person only
 * when it carries their full name, part for part (a party, or the record's
 * own words); the grade then comes from makeFinding, so a record that names
 * them and nothing else stays a possible namesake. A record about the company
 * alone is graded 'company'. No addresses are kept (the export-ban orders
 * print the person's home address in their titles: it is cut), and records
 * about family matters, guardianships, estates, immigration, asylum or
 * health are never read.
 */
import * as cheerio from 'cheerio';
import { getJson, getText, htmlToText, HttpError } from '../http';
import { makeFinding, severityFromText } from '../finding';
import { mentionsMinor } from '../guardrails';
import {
  person, sameName, caseParties, sameCompany, namesPerson, findMentions, personTokens,
  PRIVATE_MATTER, textNamesCompany, formCore, companyNames, matchNames, partyIsKnownCompany,
} from './courts';

// One list of private matters and one company-in-text rule for every court source: both live in courts.js.
export { PRIVATE_MATTER, textNamesCompany };

/* ------------------------------------------------------------------ helpers */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const plain = (html) => clean(htmlToText(String(html || '')));
const uniq = (list) => [...new Set(list.filter(Boolean))];
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3 };
const atLeast = (floor, severity) => (SEVERITY_RANK[severity] > SEVERITY_RANK[floor] ? severity : floor);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "11/20/2026" -> "2026-11-20". */
const usDay = (value) => {
  const m = String(value || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const isoDay = (value) => {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return usDay(s);
};

/** The words that identify a company: "Nikola Corporation" -> "Nikola", "The Boring Company" -> "Boring". */
export const companyCore = formCore;

/** A company's known names (the name typed, then legal names learned from records tied to the person), at most `n`. */
const searchCompanyNames = (subject, company, n = 2) => {
  const seen = new Set();
  return companyNames(subject, company).names.map(companyCore).filter((c) => c.length >= 2 && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase())).slice(0, n);
};
/** Does text name the company under any name it may be matched by (the bare ordinary word not, once a legal name is known)? */
const textNamesKnownCompany = (text, company, subject) => matchNames(subject, company).some((n) => textNamesCompany(text, n));

/** Remove a street address, city and postcode written after a name ("Jane Doe, 12 Elm Drive, Tempe, AZ 85284;"). */
export function withoutAddress(text) {
  return String(text || '')
    // "In the Matter of: NAME, <address ...>; Order ..." keeps the name only
    .replace(/(In the Matter of:?\s*[^,;]+?),\s*(?:[^;]*?\d[^;]*?);/gi, '$1;')
    // "Richard Roe, with a last known address of 26 Elm Drive, Rolling Hills, CA 90274, and ..." keeps the name only
    .replace(/,?\s*(?:with|at) (?:a |the |his |her |their )?(?:last known |current )?address(?:es)? (?:of|at)\s+[^;]*?\b[A-Z]{2}\s*\d{5}(?:-\d{4})?/g, '')
    .replace(/,\s*\d{1,6}\s+[^,;]{2,60},\s*[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?/g, '')
    .replace(/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g, '')
    .replace(/\s+([,;])/g, '$1')
    .replace(/,\s*;/g, ';');
}

/* Politeness: the deep check may run several lookups at once; each host here gets one request at a time, spaced. */
const GAP_MS = { 'courts.delaware.gov': 1500, 'decisions.fct-cf.gc.ca': 1500, 'publications.europa.eu': 1000, 'www.federalregister.gov': 400 };
const nextAt = new Map();
let pacing = true;
async function pace(host, deadline) {
  if (!pacing) return;
  const now = Date.now();
  const at = Math.max(now, nextAt.get(host) || 0);
  if (deadline && at + 2500 > deadline) throw new HttpError('Out of time before the request could start', { retryable: true });
  nextAt.set(host, at + (GAP_MS[host] || 500));
  if (at > now) await sleep(at - now);
}

/** For tests: turn this module's own spacing off (true) or back on (false), and forget earlier requests. */
export function __resetCourtsMoreForTests({ noPacing = true } = {}) {
  pacing = !noPacing;
  nextAt.clear();
}

/** Is a company thread near the subject (the company given, or found first)? Slow sources only run for those. */
const nearCompany = (thread, subject) => (thread.depth ?? 1) <= 1 || Boolean(subject?.company && sameCompany(thread.value, subject.company));

/**
 * A lookup that could not be run at all (no full name, a company name too short to search). It is not a clean
 * result: `partial` makes the report list the screen as partly done, never "no match".
 */
const notScreened = (note, what) => ({ findings: [], threads: [], notes: [note], partial: [what] });

/* ------------------------------------------------------------------ 1. Delaware courts */

const DE_ID = 'delaware-courts';
const DE_LABEL = 'Delaware court opinions and orders (Court of Chancery, Superior Court, Supreme Court)';
const DE_HOST = 'courts.delaware.gov';
const DE_SEARCH = `https://${DE_HOST}/opinions/index.aspx`;
const DE_DOC = `https://${DE_HOST}/opinions/download.aspx?id=`;
// The court's search covers one calendar year at a time and lists at most 100 records.
const DE_PER_PAGE = 100;
const DE_RECENT_YEARS = 5;
const DE_OLDER_YEARS = 7;
// Business and criminal courts only: Family Court, the Justice of the Peace Court and the Court of Common Pleas
// hear family, landlord and small personal matters.
const DE_COURTS = new Set(['court of chancery', 'superior court', 'supreme court']);

/** The search page for one year. The court's own form builds this address. */
export function delawareUrl(words, year) {
  return `${DE_SEARCH}?ag=all%20courts&period=date&from=01/01/${year}&to=12/31/${year}&results=${DE_PER_PAGE}&ss=${encodeURIComponent(words)}`;
}

/** The rows of one result page: [{ id, caption, date, fileNumber, court, type, officer, description }]. */
export function parseDelaware(html) {
  const page = String(html || '');
  const hasTable = /Parties\/Caption/i.test(page);
  if (!hasTable && !/no results/i.test(page)) throw new HttpError('The Delaware courts search returned something unexpected');
  if (!hasTable) return [];
  const $ = cheerio.load(page);
  const rows = [];
  $('tbody tr').each((i, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 7) return;
    const link = cells.eq(0).find('a[href*="download.aspx"]').attr('href') || '';
    const id = (link.match(/id=(\d+)/i) || [])[1];
    const caption = clean(cells.eq(0).text());
    if (!id || !caption) return;
    rows.push({
      id,
      caption,
      date: usDay(cells.eq(1).text()),
      fileNumber: clean(cells.eq(2).text()),
      court: clean(cells.eq(3).text()),
      type: clean(cells.eq(4).text()),
      officer: clean(cells.eq(5).text()),
      description: clean(cells.eq(6).text()),
    });
  });
  return rows;
}

/** One key per case: "C.A. No. 2018-0408-KSJM" and "2018-0408" are the same case. */
const caseKey = (row) => {
  const m = row.fileNumber.match(/(\d{4})-(\d{3,5})\b/);
  const n = m ? `${m[1]}-${Number(m[2])}` : (row.fileNumber.match(/[A-Z]*\d[\w-]*\d/) || [])[0];
  return `${row.court}|${n || row.caption.toLowerCase()}`;
};

/** One case (all its published opinions and orders) as a finding, or null. */
function delawareFinding(rows, ctx, who, company) {
  const latest = [...rows].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const { court } = latest;
  const caption = latest.caption.replace(/[,;:\s]+$/, '');
  if (!DE_COURTS.has(court.toLowerCase()) || PRIVATE_MATTER.test(`${caption} ${latest.description}`)) return null;
  const parties = caseParties(caption);
  const partyHit = parties.people.find((p) => sameName(p, who)) || '';
  const companyParty = company ? [...parties.sides, ...parties.people, ...parties.asides].find((p) => partyIsKnownCompany(p, company, ctx.subject)) || '' : '';
  if (!partyHit && !companyParty) return null;
  // A minor's initials in the caption: never reported.
  if (mentionsMinor(caption)) return null;
  const criminal = /^state(?: of delaware)?\s+v\.?\s/i.test(caption) || /criminal/i.test(latest.type);
  const descriptions = uniq(rows.map((r) => r.description)).slice(0, 4);
  const first = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  const quote = [
    `${plural(rows.length, 'published decision')} in this case${rows.length > 1 && first.date ? `, from ${first.date}` : ''}.`,
    `Latest: ${latest.description || 'decision'}${latest.date ? ` (${latest.date})` : ''}.`,
    descriptions.length > 1 ? `Others: ${descriptions.slice(1).join('; ')}.` : '',
    latest.officer ? `Judicial officer: ${latest.officer}.` : '',
  ].filter(Boolean).join(' ');
  const finding = makeFinding(ctx.subject, {
    source: DE_ID,
    sourceLabel: DE_LABEL,
    category: 'litigation',
    title: `${caption} (Delaware ${court}${latest.fileNumber ? `, ${latest.fileNumber}` : ''})`,
    quote,
    url: `${DE_DOC}${latest.id}`,
    date: latest.date,
    severity: criminal ? 'high' : atLeast('medium', severityFromText(`${caption}. ${descriptions.join('. ')}`, ctx.subject)),
    data: { caseNumber: latest.fileNumber || null, court: `Delaware ${court}`, decisions: rows.length },
    ...(partyHit
      ? { matchText: [who.name, caption, `Delaware ${court}`, descriptions.join('; ')].filter(Boolean).join(' | ') }
      : { match: 'company', matchReasons: [`${companyParty} is a party to the case`] }),
  });
  return finding;
}

/** A phrase for the court's search: quoted, so "Mistral AI" is not read as "Mistral" OR "ai" (which matches "Claim"). */
const dePhrase = (words) => `"${clean(words).replace(/"/g, '')}"`;

/**
 * Search each year (the court refuses ranges over a year) for each phrase.
 * A year that fills the page is searched again with the narrower `retries`
 * phrases (a common surname capped by namesakes), and stays partial.
 */
async function delawareYears(phrases, years, ctx, notes, { retries = [] } = {}) {
  const rows = [];
  const searched = [];
  const failed = [];
  let firstError = null;
  const capped = [];
  const fetchYear = async (phrase, year) => {
    await pace(DE_HOST, ctx.deadline);
    const html = await getText(delawareUrl(phrase, year), { deadline: ctx.deadline, timeoutMs: 20000, accept: 'text/html' });
    return parseDelaware(html);
  };
  for (const year of years) {
    if (ctx.deadline && Date.now() + 4000 > ctx.deadline) break;
    try {
      let full = false;
      for (const phrase of phrases) {
        const found = await fetchYear(phrase, year);
        if (found.length >= DE_PER_PAGE) full = true;
        rows.push(...found);
      }
      searched.push(year);
      if (full) {
        capped.push(year);
        for (const phrase of retries) {
          if (ctx.deadline && Date.now() + 4000 > ctx.deadline) break;
          rows.push(...await fetchYear(phrase, year).catch(() => []));
        }
      }
    } catch (error) {
      firstError = firstError || error;
      failed.push(year);
    }
  }
  if (!searched.length) throw firstError || new HttpError('Out of time before the Delaware courts could be searched', { retryable: true });
  const skipped = years.filter((y) => !searched.includes(y) && !failed.includes(y));
  const partial = [];
  if (failed.length) {
    notes.push(`The Delaware courts did not answer for ${failed.join(', ')}; those years were not searched.`);
    partial.push(`Delaware decisions ${failed.join(', ')} (no answer)`);
  }
  if (skipped.length) {
    notes.push(`Ran out of time before searching Delaware decisions from ${skipped.join(', ')}.`);
    partial.push(`Delaware decisions ${skipped.join(', ')} (not reached in time)`);
  }
  if (capped.length) {
    notes.push(`In ${plural(capped.length, 'year')} the Delaware search listed its maximum of ${DE_PER_PAGE} decisions for ${phrases.join(' and ')}${retries.length ? ' (searched again under the full name)' : ''}; some decisions in that year may not have been read.`);
    partial.push(`Delaware decisions ${capped.join(', ')} (first ${DE_PER_PAGE} read)`);
  }
  // One decision can come back from two phrases: keep it once.
  const seen = new Set();
  return { rows: rows.filter((r) => !seen.has(r.id) && seen.add(r.id)), searched, partial };
}

// The court's online archive of opinions and orders starts in 2000.
const DE_FIRST_YEAR = 2000;
/**
 * The earliest year the person (or, for a company, their role there) is known
 * to have been active, from dated role and event anchors; null when none.
 */
function earliestActivity(subject, company = '') {
  const years = [];
  for (const r of subject?.anchors?.roles?.values() || []) {
    if (company && !sameCompany(r.org || r.value || '', company)) continue;
    const y = Number(String(r.from || '').slice(0, 4));
    if (y >= 1950) years.push(y);
  }
  if (!company) {
    for (const e of subject?.anchors?.events?.values() || []) {
      const y = Number(String(e.date || '').slice(0, 4));
      if (y >= 1950) years.push(y);
    }
  }
  return years.length ? Math.min(...years) : null;
}
/** The years before the regular span worth searching: from the first known activity (never before 2000) to the span's start. */
function archiveYears(subject, company, lastYear) {
  const first = earliestActivity(subject, company);
  if (!first || first > lastYear) return [];
  const from = Math.max(DE_FIRST_YEAR, first - 1);
  return Array.from({ length: lastYear - from + 1 }, (_, i) => lastYear - i);
}

export const delawareCourtsConnector = {
  id: DE_ID,
  label: DE_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.5,
  maxParallel: 1,
  timeoutMs: 45000,
  plan(thread, subject) {
    const thisYear = new Date().getUTCFullYear();
    if (thread.kind === 'company') {
      if (!nearCompany(thread, subject)) return [];
      const older = archiveYears(subject, thread.value, thisYear - DE_RECENT_YEARS).length > 0;
      return [
        { template: 'captions.company', prior: 0.5, why: 'Delaware cases the company is a party to (most US startups are Delaware companies)' },
        ...(older ? [{ template: 'captions.archive', prior: 0.2, why: 'Delaware cases of the company from the years before (the person was there then)' }] : []),
      ];
    }
    // Years before the regular twelve are asked only when dated records show the person active then.
    const older = archiveYears(subject, '', thisYear - DE_RECENT_YEARS - DE_OLDER_YEARS).length > 0;
    return [
      { template: 'captions.recent', prior: 0.5, why: 'Delaware cases from the last five years that name the person as a party' },
      { template: 'captions.older', prior: 0.3, why: 'older Delaware cases that name the person as a party' },
      ...(older ? [{ template: 'captions.archive', prior: 0.15, why: 'Delaware cases from the years records show the person active, before the last twelve' }] : []),
    ];
  },
  async run(task, ctx) {
    const who = person(ctx.subject);
    const notes = [];
    const template = task.template || (task.kind === 'company' ? 'captions.company' : 'captions.recent');
    const company = task.kind === 'company' ? clean(task.value) : '';
    const thisYear = new Date().getUTCFullYear();
    const regularStart = thisYear - (company ? DE_RECENT_YEARS : DE_RECENT_YEARS + DE_OLDER_YEARS);
    let span;
    if (template === 'captions.archive') span = archiveYears(ctx.subject, company, regularStart);
    else if (template === 'captions.older') span = Array.from({ length: DE_OLDER_YEARS }, (_, i) => thisYear - DE_RECENT_YEARS - i);
    else span = Array.from({ length: DE_RECENT_YEARS }, (_, i) => thisYear - i);
    if (!company && !(who.given && who.surname)) return notScreened('A first name and surname are needed to search Delaware cases.', 'Delaware cases (no full name to search)');
    if (company && companyCore(company).length < 2) return notScreened(`"${company}" is too short a name to search Delaware cases.`, 'Delaware cases (name too short to search)');
    if (!span.length) return { findings: [], threads: [], notes: ['No dated record shows activity before the years already searched, so earlier Delaware decisions were not searched.'] };
    // Quoted phrases: the court's search joins loose words with OR and matches inside words. A person is searched by
    // the quoted surname (captions write "Tornetta", "Richard J. Tornetta" or "Rich Tornetta"); sameName then keeps
    // only their own name. A year capped by namesakes is searched again under the quoted full name forms.
    const phrases = company ? searchCompanyNames(ctx.subject, company).map(dePhrase) : [dePhrase(who.surname)];
    const retries = company ? [] : uniq([`${who.given} ${who.surname}`, ...who.queryNames]).map(dePhrase);
    const { rows, searched, partial } = await delawareYears(phrases, span, ctx, notes, { retries });
    const byCase = new Map();
    for (const row of rows) byCase.set(caseKey(row), [...(byCase.get(caseKey(row)) || []), row]);
    const findings = [...byCase.values()].map((group) => delawareFinding(group, ctx, who, company)).filter(Boolean)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 10);
    const first = Math.min(...searched);
    notes.push(`Delaware decisions searched for ${searched.length > 1 ? `${first}–${Math.max(...searched)}` : searched[0]}; only cases whose title names ${company || who.name} are reported.`);
    notes.push(first > DE_FIRST_YEAR
      ? `Delaware decisions from ${DE_FIRST_YEAR} to ${first - 1} were not searched by this lookup.`
      : `The Delaware courts' online archive starts in ${DE_FIRST_YEAR}; earlier decisions were not searched.`);
    return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 2. Federal Register: agency orders and trade cases */

const FR_ID = 'us-agency-orders';
const FR_LABEL = 'US agency orders and import trade cases (Federal Register)';
const FR_HOST = 'www.federalregister.gov';
const FR_SEARCH = `https://${FR_HOST}/api/v1/documents.json`;
const FR_FIELDS = ['title', 'abstract', 'html_url', 'publication_date', 'excerpts', 'document_number', 'type', 'agencies'];
// Agencies whose notices are about immigration, health or controlled-substance prescribing, or that print
// dates of birth and addresses in full (the sanctions lists are screened by their own source).
export const FR_EXCLUDED_AGENCIES = new Set([
  'u-s-citizenship-and-immigration-services', 'immigration-and-customs-enforcement', 'executive-office-for-immigration-review',
  'drug-enforcement-administration', 'foreign-assets-control-office', 'centers-for-medicare-medicaid-services', 'indian-health-service',
  'substance-abuse-and-mental-health-services-administration', 'veterans-affairs-department',
]);
const ITC = 'international-trade-commission';
// What makes a notice an order or a case, and not a rule, a meeting or a public comment.
const FR_ACTION = /\b(?:debarment|debarring|debarred|denying export privileges|denial order|order denying|temporary denial|in the matter of|consent (?:agreement|order)|civil (?:money )?penalt(?:y|ies)|cease[- ]and[- ]desist|exclusion order|settlement agreement|disqualification|prohibition order|order of prohibition|revocation of|suspension of|decision and order|order instituting|notice of charges|final order)\b/i;
const FR_BAN = /\b(?:debar\w*|denying export privileges|denial order|order denying|temporary denial|exclusion order|prohibition order|order of prohibition)\b/i;

const frUrl = (params) => {
  const parts = [`per_page=${params.perPage || 20}`, `order=${params.order || 'relevance'}`, `conditions%5Bterm%5D=${encodeURIComponent(params.term)}`];
  for (const a of params.agencies || []) parts.push(`conditions%5Bagencies%5D%5B%5D=${encodeURIComponent(a)}`);
  for (const f of FR_FIELDS) parts.push(`fields%5B%5D=${f}`);
  return `${FR_SEARCH}?${parts.join('&')}`;
};

async function frSearch(params, ctx) {
  await pace(FR_HOST, ctx.deadline);
  const url = frUrl(params);
  const json = await getJson(url, { deadline: ctx.deadline, timeoutMs: 15000 });
  if (!json || typeof json !== 'object' || (json.results !== undefined && !Array.isArray(json.results)) || (json.results === undefined && Number(json.count) !== 0)) {
    throw new HttpError('The Federal Register search returned something unexpected', { url });
  }
  return { count: Number(json.count) || 0, docs: arr(json.results).filter((d) => d && d.title && /^https:\/\/www\.federalregister\.gov\//.test(String(d.html_url || ''))) };
}

/** The readable parts of one Federal Register document, with addresses cut out. */
function readDoc(d) {
  const agencies = arr(d.agencies).map((a) => ({ slug: clean(a?.slug), name: clean(a?.name || a?.raw_name) })).filter((a) => a.slug || a.name);
  return {
    title: withoutAddress(plain(d.title)),
    abstract: withoutAddress(plain(d.abstract)),
    excerpt: withoutAddress(plain(d.excerpts)),
    url: String(d.html_url),
    date: isoDay(d.publication_date),
    number: clean(d.document_number),
    agencies,
    agencyName: (agencies.filter((a) => a.slug !== 'health-and-human-services-department' && a.slug !== 'commerce-department').map((a) => a.name)[0]) || agencies.map((a) => a.name)[0] || 'US federal agency',
  };
}
const excluded = (doc) => doc.agencies.some((a) => FR_EXCLUDED_AGENCIES.has(a.slug)) || PRIVATE_MATTER.test(`${doc.title} ${doc.abstract}`);
const isItc = (doc) => doc.agencies.some((a) => a.slug === ITC);

/** An order or case that names the person. */
function frPersonFinding(doc, ctx, who) {
  if (excluded(doc)) return null;
  const head = `${doc.title}\n${doc.abstract}`;
  if (!FR_ACTION.test(head)) return null;
  const body = `${doc.abstract} ${doc.excerpt}`;
  // An order is about the party its title names ("Jane Doe: Final Debarment Order", "In the Matter of: Jane Doe; ...").
  // When that party is a person, it must be the person's own name, part for part.
  const party = clean((doc.title.match(/^In the Matter of:?\s*([^;,]+)/i) || doc.title.match(/^([^:;]+?)[:;]\s/) || [])[1]);
  if (party && /^(?:[A-Z][\p{L}'’.-]*\s+){1,4}[A-Z][\p{L}'’-]+$/u.test(party) && !/\b(?:Inc|LLC|Ltd|Corp|Corporation|Company|Certain|Notice|Order)\b/.test(party)) {
    if (!sameName(party, who)) return null;
  } else if (!namesPerson(doc.title, who) && !namesPerson(body, who)) return null;
  const itc = isItc(doc);
  return makeFinding(ctx.subject, {
    source: FR_ID,
    sourceLabel: FR_LABEL,
    category: itc ? 'litigation' : 'regulatory',
    title: `${doc.title} (${doc.agencyName}, Federal Register ${doc.date || ''})`.replace(/ \)$/, ')'),
    quote: clip(doc.abstract || doc.excerpt || doc.title, 650),
    url: doc.url,
    date: doc.date,
    severity: FR_BAN.test(head) ? 'high' : atLeast('medium', severityFromText(head, ctx.subject)),
    data: { documentNumber: doc.number || null, agency: doc.agencyName },
    matchText: `${doc.title}\n${doc.abstract}\n${doc.excerpt}`,
  });
}

/** "Certain Mobile Electronic Devices and Components Thereof; Institution of Investigation" -> the products. */
const itcProducts = (doc) => {
  if (/^Certain\s/i.test(doc.title)) return clean(doc.title.split(';')[0]);
  const named = `${doc.abstract} ${doc.excerpt}`.match(/\bentitled\s+(Certain\s[^,;]+?)(?:,\s*DN\s*\d+)?[,;.]/);
  return named ? clean(named[1]) : '';
};
const itcNumber = (text) => (String(text).match(/\b337-TA-\d{3,5}\b/) || [])[0] || '';

/** ITC import cases (Section 337) that name the company, one finding per case. */
function itcFindings(docs, ctx, company) {
  const byCase = new Map();
  for (const doc of docs) {
    if (!isItc(doc) || excluded(doc)) continue;
    const text = `${doc.title}\n${doc.abstract}\n${doc.excerpt}`;
    if (!/section 337|337-TA-|^Certain\s/i.test(text) || !textNamesKnownCompany(text, company, ctx.subject)) continue;
    const key = itcNumber(text) || itcProducts(doc).toLowerCase() || doc.number;
    byCase.set(key, [...(byCase.get(key) || []), doc]);
  }
  const findings = [];
  for (const group of byCase.values()) {
    const sorted = [...group].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const latest = sorted[0];
    const all = sorted.map((d) => `${d.title} ${d.abstract} ${d.excerpt}`).join(' ');
    const number = itcNumber(all);
    const core = matchNames(ctx.subject, company).map((n) => escapeRe(companyCore(n))).join('|') || escapeRe(companyCore(company));
    const respondent = new RegExp(`respondents?:?[^.]{0,400}?(?:${core})`, 'i').test(all);
    const complainant = new RegExp(`(?:on behalf of|filed by|complainants?:?)[^.]{0,200}?(?:${core})`, 'i').test(all);
    const role = respondent && !complainant ? 'respondent (the side accused)' : complainant && !respondent ? 'complainant (the side bringing the case)' : '';
    const products = sorted.map(itcProducts).find(Boolean) || '';
    const finding = makeFinding(ctx.subject, {
      source: FR_ID,
      sourceLabel: FR_LABEL,
      category: 'litigation',
      title: `US International Trade Commission import case${products ? `: ${products}` : ''}${number ? ` (${number})` : ''}`,
      quote: clip(`${role ? `${clean(company)} is named as ${role}. ` : ''}${plural(group.length, 'notice')} in the Federal Register; latest: ${latest.title} (${latest.date}). ${latest.excerpt || latest.abstract}`, 700),
      url: latest.url,
      date: latest.date,
      severity: /violation|exclusion order|cease and desist/i.test(all) ? 'medium' : atLeast('low', severityFromText(latest.title)),
      data: { investigation: number || null, role: role ? role.split(' ')[0] : null, notices: group.length },
      match: 'company',
      matchReasons: [`${clean(company)} is named in the case notice`],
    });
    if (finding) findings.push(finding);
  }
  return findings.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

/** Agency orders (not ITC) that name the company in their title or summary. */
function frCompanyOrders(docs, ctx, company) {
  return docs.filter((doc) => !isItc(doc) && !excluded(doc) && FR_ACTION.test(doc.title) && textNamesKnownCompany(`${doc.title}\n${doc.abstract}`, company, ctx.subject))
    .map((doc) => makeFinding(ctx.subject, {
      source: FR_ID,
      sourceLabel: FR_LABEL,
      category: 'regulatory',
      title: `${doc.title} (${doc.agencyName}, Federal Register ${doc.date || ''})`.replace(/ \)$/, ')'),
      quote: clip(doc.abstract || doc.excerpt || doc.title, 650),
      url: doc.url,
      date: doc.date,
      severity: FR_BAN.test(`${doc.title} ${doc.abstract}`) ? 'high' : atLeast('medium', severityFromText(`${doc.title}. ${doc.abstract}`)),
      data: { documentNumber: doc.number || null, agency: doc.agencyName },
      match: 'company',
      matchReasons: [`the order names ${clean(company)}`],
    })).filter(Boolean);
}

export const federalRegisterActionsConnector = {
  id: FR_ID,
  label: FR_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.4,
  timeoutMs: 20000,
  plan(thread) {
    if (thread.kind === 'company') {
      return [
        { template: 'trade-cases.company', prior: 0.4, why: 'US International Trade Commission import cases (patent and trade disputes) naming the company' },
        { template: 'orders.company', prior: 0.3, why: 'US agency orders against the company (debarments, export bans, consent orders)' },
      ];
    }
    return [{ template: 'orders.name', prior: 0.4, why: 'US agency orders naming the person (debarments, export bans, consent orders)' }];
  },
  async run(task, ctx) {
    const who = person(ctx.subject);
    const notes = [];
    const template = task.template || (task.kind === 'company' ? 'trade-cases.company' : 'orders.name');
    if (template === 'orders.name') {
      if (!who.given || !who.surname) return notScreened('A first name and surname are needed to search agency orders.', 'US agency orders (no full name to search)');
      // Each name as a phrase with up to three words between ("Arthur Gau" finds "Arthur Ching-Fu Gau"): orders carry
      // the legal middle name. The order's own party must still be the person's name part for part.
      const forms = uniq([...who.queryNames, `${who.given} ${who.surname}`].map((n) => n.replace(/"/g, '')));
      const term = forms.map((n) => `"${n}"~3`).join(' | ');
      const { count, docs } = await frSearch({ term, perPage: 40 }, ctx);
      const findings = docs.map(readDoc).map((d) => frPersonFinding(d, ctx, who)).filter(Boolean).slice(0, 8);
      if (count > docs.length) {
        notes.push(`The Federal Register holds ${count} documents with ${who.name}; the ${docs.length} most relevant were read.`);
        return { findings, threads: [], notes, partial: [`US agency orders (${docs.length} of ${count} documents read)`] };
      }
      return { findings, threads: [], notes };
    }
    const company = clean(task.value);
    const core = companyCore(company);
    if (core.length < 2) return notScreened(`"${company}" is too short a name to search agency orders.`, 'US agency orders (name too short to search)');
    // Every known name of the company, in one search: "Ramp" | "Ramp Business".
    const coTerm = searchCompanyNames(ctx.subject, company, 3).map((n) => `"${n.replace(/"/g, '')}"`).join(' | ') || `"${core.replace(/"/g, '')}"`;
    if (template === 'trade-cases.company') {
      const { count, docs } = await frSearch({ term: coTerm, agencies: [ITC], order: 'newest', perPage: 60 }, ctx);
      const findings = itcFindings(docs.map(readDoc), ctx, company).slice(0, 8);
      if (count > docs.length) {
        notes.push(`The Trade Commission has ${count} Federal Register notices mentioning ${core}; the ${docs.length} newest were read.`);
        return { findings, threads: [], notes, partial: [`Trade Commission import cases (${docs.length} of ${count} notices read)`] };
      }
      return { findings, threads: [], notes };
    }
    const { count, docs } = await frSearch({ term: coTerm, perPage: 40 }, ctx);
    const findings = frCompanyOrders(docs.map(readDoc), ctx, company).slice(0, 8);
    if (count > docs.length) {
      notes.push(`The Federal Register holds ${count} documents mentioning ${core}; the ${docs.length} most relevant were read.`);
      return { findings, threads: [], notes, partial: [`US agency orders (${docs.length} of ${count} documents read)`] };
    }
    return { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 3. EU courts and competition decisions */

const EU_ID = 'eu-courts';
const EU_LABEL = 'EU court judgments and EU competition decisions (EUR-Lex)';
const EU_HOST = 'publications.europa.eu';
const EU_QUERY = `https://${EU_HOST}/webapi/rdf/sparql`;
const EU_DOC = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:';
const EU_COURTS = { C: 'Court of Justice of the EU', T: 'General Court of the EU', F: 'EU Civil Service Tribunal' };
// Which document of a case to show: the judgment first, then an order, a summary, the Advocate General's opinion, the filing notice.
const EU_DOC_RANK = { J: 0, O: 1, A: 2, B: 3, D: 3, C: 4, N: 5 };
// The most documents one search reads; a search that fills it was cut short.
const EU_LIMIT = 60;

/** A phrase safe to put inside the query's text search: letters, digits, spaces, hyphens and dots only. */
const euPhrase = (s) => clean(String(s || '').normalize('NFC').replace(/[^\p{L}\p{N}\s.-]+/gu, ' '));

/** The query: case-law titles (and competition-decision titles) that contain every phrase. */
export function euQuery(phrases) {
  const contains = phrases.map(euPhrase).filter((p) => p.length >= 2).map((p) => `"${p}"`).join(' AND ');
  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?celex ?date ?title WHERE {
 ?expr cdm:expression_title ?title .
 ?title bif:contains '${contains}' .
 ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
       cdm:expression_belongs_to_work ?work .
 ?work cdm:resource_legal_id_celex ?celex .
 FILTER(STRSTARTS(STR(?celex), "6") || CONTAINS(LCASE(STR(?title)), "proceeding under article") || CONTAINS(LCASE(STR(?title)), "proceedings under article"))
 OPTIONAL { ?work cdm:work_date_document ?date }
} ORDER BY DESC(?date) LIMIT ${EU_LIMIT}`;
}

async function euSearch(phrases, ctx) {
  await pace(EU_HOST, ctx.deadline);
  const url = `${EU_QUERY}?query=${encodeURIComponent(euQuery(phrases))}`;
  const json = await getJson(url, { deadline: ctx.deadline, timeoutMs: 20000, accept: 'application/sparql-results+json' });
  const bindings = json?.results?.bindings;
  if (!Array.isArray(bindings)) throw new HttpError('The EU case-law search returned something unexpected', { url });
  return bindings.map((b) => ({ celex: clean(b?.celex?.value), date: isoDay(b?.date?.value), title: clean(b?.title?.value) })).filter((r) => r.celex && r.title);
}

/** Who the case is between, from one document title. */
export function euParties(title) {
  const t = String(title || '');
  const appealBy = t.match(/\bAppeal brought on [^#]*?\bby\s+(.+?)\s+against\b/);
  if (appealBy) return clean(appealBy[1]);
  const segments = t.split(/#|\s[—–]\s/).map(clean).filter(Boolean);
  const versus = segments.find((s) => /\sv\.?\s/.test(s) && !/^(?:Judgment|Order|Opinion|Case)\b[^v]*$/.test(s));
  if (versus) return clean(versus.replace(/\((?:[^()]|\([^()]*\))*\)/g, ' ').replace(/\([^)]*$/, '').replace(/\.$/, ''));
  const appeal = t.match(/\bby\s+(.+?)\s+against\b/);
  if (appeal) return clean(appeal[1]);
  const decision = t.match(/\(Case\s+(?:AT|COMP)[^)]*?\s[-–—]\s*([^)]+)\)/);
  return decision ? clean(decision[1]) : '';
}

/** Every name a party list gives, split on "v", "and" and commas. */
const euNames = (parties) => uniq([
  ...caseParties(parties).sides,
  ...caseParties(parties).people,
  ...caseParties(parties).people.flatMap((p) => p.split(/,\s+/)),
].map(clean));

/** One document's case: { key, court, caseNumber, kind } from its EUR-Lex number. */
export function euCase(celex, title) {
  const m = String(celex).match(/^6(\d{4})([A-Z])([A-Z])(\d{4})/);
  if (m) return { key: `${m[2]}-${Number(m[4])}/${m[1].slice(2)}`, court: EU_COURTS[m[2]] || 'EU court', caseNumber: `${m[2]}-${Number(m[4])}/${m[1].slice(2)}`, kind: m[3], decision: false };
  const at = String(title).match(/\(Case\s+((?:AT|COMP)\S*)/);
  const number = at ? clean(at[1]) : '';
  return { key: number || celex, court: 'European Commission (competition decision)', caseNumber: number || null, kind: 'D', decision: true };
}

function euFindings(rows, ctx, who, company) {
  const byCase = new Map();
  for (const row of rows) {
    const c = euCase(row.celex, row.title);
    const parties = euParties(row.title);
    if (!parties) continue;
    byCase.set(c.key, [...(byCase.get(c.key) || []), { ...row, ...c, parties }]);
  }
  const findings = [];
  for (const docs of byCase.values()) {
    const sorted = [...docs].sort((a, b) => ((EU_DOC_RANK[a.kind] ?? 6) - (EU_DOC_RANK[b.kind] ?? 6)) || String(b.date).localeCompare(String(a.date)) || (a.celex.includes('_') - b.celex.includes('_')));
    const rep = sorted[0];
    const names = uniq(docs.flatMap((d) => euNames(d.parties)));
    const personHit = who ? names.find((n) => sameName(n, who)) || '' : '';
    // A competition decision names its party without a legal form ("Case COMP/38.784 - Orange"). A one-word
    // name there may be any company of that name, so it is kept as a possible match, never as the company's own.
    const formalHit = company ? names.find((n) => partyIsKnownCompany(n, company, ctx.subject)) || '' : '';
    const decisionHit = company && !formalHit && rep.decision ? names.find((n) => matchNames(ctx.subject, company).some((m) => sameCompany(n, m))) || '' : '';
    const companyHit = formalHit || decisionHit;
    if (!personHit && !companyHit) continue;
    const allText = docs.map((d) => d.title).join(' ');
    if (personHit && PRIVATE_MATTER.test(allText)) continue;
    const dates = docs.map((d) => d.date).filter(Boolean).sort();
    const competition = /competition|cartel|abuse of (?:a )?dominant|article (?:81|82|101|102)|state aid|fine|\bv\.? (?:European )?Commission\b|\b(?:European )?Commission v\b/i.test(allText);
    const appeal = /\bAppeal brought on\b/.test(rep.title);
    const readable = rep.title.replace(/#/g, '. ').replace(/\s*\.\s*\./g, '.');
    const finding = makeFinding(ctx.subject, {
      source: EU_ID,
      sourceLabel: EU_LABEL,
      category: rep.decision ? 'regulatory' : 'litigation',
      title: `${appeal ? 'Appeal by ' : ''}${rep.parties} (${rep.court}${rep.caseNumber ? `, case ${rep.caseNumber}` : ''})`,
      quote: clip(`${readable}${docs.length > 1 ? ` ${plural(docs.length, 'document')} in this case${dates.length > 1 ? `, ${dates[0]} to ${dates[dates.length - 1]}` : ''}.` : ''}`, 700),
      url: `${EU_DOC}${rep.celex}`,
      date: rep.date,
      severity: rep.decision ? atLeast('medium', severityFromText(allText)) : competition ? 'medium' : atLeast('low', severityFromText(rep.title)),
      data: { caseNumber: rep.caseNumber, court: rep.court, documents: docs.length },
      ...(personHit
        ? { matchText: [who.name, rep.parties, rep.court].join(' | ') }
        : formalHit
          ? { match: 'company', matchReasons: [`${companyHit} is a party to the case`] }
          : { match: 'possible', matchReasons: [`the decision names ${companyHit}, a one-word name many unrelated companies share; verify it is the same company`] }),
    });
    if (finding) findings.push(finding);
  }
  return findings.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

export const euCourtsConnector = {
  id: EU_ID,
  label: EU_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.3,
  timeoutMs: 25000,
  plan(thread) {
    if (thread.kind === 'company') return [{ template: 'cases.company', prior: 0.35, why: 'EU court cases and EU competition decisions naming the company' }];
    return [{ template: 'cases.name', prior: 0.2, why: 'EU court cases that name the person as a party' }];
  },
  async run(task, ctx) {
    const who = person(ctx.subject);
    if (task.kind === 'company') {
      const company = clean(task.value);
      const core = companyCore(company);
      if (core.length < 2) return notScreened(`"${company}" is too short a name to search EU cases.`, 'EU cases (name too short to search)');
      // Every known name of the company: the name typed and the legal names learned from records tied to the person.
      let rows = [];
      let full = false;
      for (const name of searchCompanyNames(ctx.subject, company)) {
        const found = await euSearch([name], ctx);
        if (found.length >= EU_LIMIT) full = true;
        rows = [...rows, ...found.filter((r) => !rows.some((x) => x.celex === r.celex))];
      }
      const findings = euFindings(rows, ctx, null, company).slice(0, 8);
      if (full) return { findings, threads: [], notes: [`The EU case-law index holds more than ${EU_LIMIT} documents with ${core} in the title; the newest ${EU_LIMIT} were read.`], partial: [`EU cases (newest ${EU_LIMIT} documents read)`] };
      return { findings, threads: [], notes: [] };
    }
    if (!who.given || !who.surname) return notScreened('A first name and surname are needed to search EU cases.', 'EU cases (no full name to search)');
    const rows = await euSearch([who.given, who.surname], ctx);
    const findings = euFindings(rows, ctx, who, '').slice(0, 6);
    if (rows.length >= EU_LIMIT) return { findings, threads: [], notes: [`The EU case-law index holds more than ${EU_LIMIT} documents with ${who.given} and ${who.surname} in the title; the newest ${EU_LIMIT} were read.`], partial: [`EU cases (newest ${EU_LIMIT} documents read)`] };
    return { findings, threads: [], notes: [] };
  },
};

/* ------------------------------------------------------------------ 4. Federal courts of Canada */

const CA_ID = 'canada-federal-courts';
const CA_LABEL = 'Federal Court of Canada and Federal Court of Appeal decisions';
const CA_HOST = 'decisions.fct-cf.gc.ca';
const CA_SEARCH = `https://${CA_HOST}/fc-cf/en/d/s/index.do`;
// 53: Federal Court of Appeal decisions; 54: Federal Court decisions.
const CA_COLLECTIONS = ['53', '54'];

/** The court's own advanced-search page (the version it shows inside its search frame). */
export function canadaUrl({ text = '', parties = '' }) {
  const q = (s) => (s ? encodeURIComponent(`"${String(s).replace(/"/g, '')}"`) : '');
  return `${CA_SEARCH}?cont=${q(text)}&ref=&d1=&d2=&p=${q(parties)}&${CA_COLLECTIONS.map((c) => `col=${c}`).join('&')}&or=date&iframe=true`;
}

/** The results of one page: { total, items: [{ title, url, citation, date, court, snippet }] }. */
export function parseCanada(html) {
  const page = String(html || '');
  const count = page.match(/(\d[\d,]*)\s+result\(s\)/);
  if (!count) throw new HttpError('The Federal Court decisions search returned something unexpected');
  const $ = cheerio.load(page);
  const items = [];
  $('#decisia-results li').each((i, li) => {
    const a = $(li).find('.title a').first();
    const href = a.attr('href') || '';
    const title = clean(a.text()).replace(/[’‘]/g, "'");
    if (!title || !/^\/(?:fc-cf|fca-caf)\/decisions\/en\/item\/\d+\//.test(href)) return;
    items.push({
      title,
      url: `https://${CA_HOST}${href.replace(/\?.*$/, '')}`,
      citation: clean($(li).find('.citation').first().text()),
      date: isoDay(clean($(li).find('.publicationDate').first().text())),
      court: /^\/fca-caf\//.test(href) ? 'Federal Court of Appeal' : 'Federal Court of Canada',
      snippet: clean($(li).find('.snippet').first().text()).replace(/\s*\[\.\.\.\]\s*/g, ' … ').replace(/[’‘]/g, "'"),
    });
  });
  return { total: Number(count[1].replace(/,/g, '')) || 0, items };
}

const surnameIn = (title, who) => {
  const surname = personTokens(`x ${who.surname}`).slice(1).join(' ');
  const tokens = personTokens(stripAccents(title).replace(/[’']/g, ''));
  return Boolean(surname) && tokens.includes(surname.replace(/[’']/g, ''));
};

function canadaFinding(item, ctx, who, company) {
  if (PRIVATE_MATTER.test(`${item.title} ${item.snippet}`) || /\bCanada \((?:Citizenship|Immigration|Public Safety)/i.test(item.title)) return null;
  const parties = caseParties(item.title);
  let personHit = '';
  if (who) {
    personHit = parties.people.find((p) => sameName(p, who)) || '';
    // Titles name individuals by surname ("O'Leary v. Ragone"); the decision's heading, quoted in the snippet, gives the full name.
    if (!personHit && surnameIn(item.title, who)) {
      const mention = findMentions(item.snippet, who).find((m) => !m.extended);
      if (mention) personHit = mention.text;
    }
  }
  const companyHit = company ? [...parties.sides, ...parties.people, ...parties.asides].find((p) => partyIsKnownCompany(p, company, ctx.subject)) || '' : '';
  if (!personHit && !companyHit) return null;
  if (personHit && mentionsMinor(`${item.title} ${item.snippet}`)) return null;
  return makeFinding(ctx.subject, {
    source: CA_ID,
    sourceLabel: CA_LABEL,
    category: 'litigation',
    title: `${item.title} (${item.court}${item.citation ? `, ${item.citation}` : ''})`,
    quote: clip(item.snippet || `Decision of the ${item.court} in ${item.title}.`, 600),
    url: item.url,
    date: item.date,
    severity: atLeast('medium', severityFromText(`${item.title}. ${item.snippet}`, ctx.subject)),
    data: { citation: item.citation || null, court: item.court },
    ...(personHit
      ? { matchText: [who.name, item.title, item.court, item.snippet].filter(Boolean).join(' | ') }
      : { match: 'company', matchReasons: [`${companyHit} is a party to the case`] }),
  });
}

export const canadaFederalCourtsConnector = {
  id: CA_ID,
  label: CA_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.25,
  maxParallel: 1,
  timeoutMs: 20000,
  plan(thread, subject) {
    if (thread.kind === 'company') return nearCompany(thread, subject) ? [{ template: 'parties.company', prior: 0.3, why: 'Canadian federal cases the company is a party to (patents, trademarks, federal disputes)' }] : [];
    return [{ template: 'parties.name', prior: 0.2, why: 'Canadian federal cases that name the person as a party' }];
  },
  async run(task, ctx) {
    const who = person(ctx.subject);
    const notes = [];
    const company = task.kind === 'company' ? clean(task.value) : '';
    if (!company && (!who.given || !who.surname)) return notScreened('A first name and surname are needed to search Canadian federal cases.', 'Canadian federal cases (no full name to search)');
    if (company && companyCore(company).length < 2) return notScreened(`"${company}" is too short a name to search Canadian federal cases.`, 'Canadian federal cases (name too short to search)');
    // A company under each known name; a person by the surname as party, with the full name in the text.
    const urls = company ? searchCompanyNames(ctx.subject, company).map((n) => canadaUrl({ parties: n })) : [canadaUrl({ text: who.name, parties: who.surname })];
    let total = 0;
    let items = [];
    for (const url of urls) {
      await pace(CA_HOST, ctx.deadline);
      const html = await getText(url, { deadline: ctx.deadline, timeoutMs: 18000, accept: 'text/html' });
      const page = parseCanada(html);
      total += page.total;
      items = [...items, ...page.items.filter((it) => !items.some((x) => x.url === it.url))];
    }
    const findings = items.map((item) => canadaFinding(item, ctx, company ? null : who, company)).filter(Boolean).slice(0, 8);
    if (total > items.length) {
      notes.push(`The Canadian federal courts list ${total} decisions for ${company || who.name}; the ${items.length} newest were read.`);
      return { findings, threads: [], notes, partial: [`Canadian federal cases (newest ${items.length} of ${total} decisions read)`] };
    }
    return { findings, threads: [], notes };
  },
};

export const MORE_COURT_CONNECTORS = [delawareCourtsConnector, federalRegisterActionsConnector, euCourtsConnector, canadaFederalCourtsConnector];
