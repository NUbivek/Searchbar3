/**
 * US federal government records about a company, and about the person where
 * they are a named party. Six sources, one per agency system, so each one is
 * reported (answered, failed, not run) on its own:
 *
 *   usFederalAwardsConnector   federal contracts, grants and loans (PPP loans
 *                              included) to the company, from USAspending.gov
 *   usLobbyingConnector        federal lobbying registrations and quarterly
 *                              reports (LD-1, LD-2) from LDA.gov: the company
 *                              as a client or self-filer, the person as a
 *                              listed lobbyist. Contribution reports (LD-203)
 *                              are never read: political donations are out of
 *                              scope.
 *   cfpbComplaintsConnector    the CFPB consumer complaint database: how many
 *                              complaints name the company, about what, and how
 *                              they were closed. Counts only, never the
 *                              consumers' own stories or locations.
 *   federalRegisterConnector   Federal Register documents (orders, notices,
 *                              settlements, denials) that name the company or
 *                              the person.
 *   fdaRecallsConnector        FDA recall and enforcement reports (drugs,
 *                              devices, food) where the company is the
 *                              recalling firm, from openFDA.
 *   nihGrantsConnector         NIH research grants: the person as principal
 *                              investigator, the company as the grantee.
 *
 * Matching. A company record is kept only when the registered name is the
 * company's own name once the legal form is set aside ("THERANOS, INC." is
 * Theranos; "NEUROTHERANOSTICS INC" and "Nikola Motor Works" are not), and it
 * is marked 'company': it is about the company, not the person. Every company
 * quote carries the agency, the year and, where the record has one, the state,
 * so a reader can rule out a same-name company elsewhere. A company is
 * searched and matched under every known name (the name typed and the legal
 * names the check learned, see knownNames); a record that matches only a
 * one-word name stays 'possible'. A record about the
 * person needs their full name as a structured party (a lobbyist, a principal
 * investigator) or in the document's text, and is graded by makeFinding: a
 * name alone stays 'possible'.
 *
 * Privacy: no street addresses, ZIP codes, phone numbers or contact names are
 * read into a record; complaint narratives and consumers' locations are never
 * requested or kept.
 *
 * Checked and left out (see the report of the change that added this file):
 * EPA ECHO (robots.txt disallows every path of its data host), OSHA and DOL
 * Wage and Hour data (the Labor Department's data service needs a registered
 * account; osha.gov refuses automated readers), NLRB cases (its case search is
 * disallowed in robots.txt), FTC cases (the site refuses automated readers;
 * its data service needs a registered account), FDA warning letters (served
 * only through the site's page widgets under a 30-second crawl delay, and the
 * search could not be confirmed to filter), Canada's federal corporations
 * search (a stateful web form; the open query service needs a registered
 * account), Australia's ABN lookup (needs a registered account), SBIR.gov
 * awards (now refuses requests without an account). SBA PPP loans are covered
 * through USAspending, which carries them as SBA loans.
 */
import { getJson, HttpError } from '../http';
import { makeFinding, makeThread, severityFromText } from '../finding';
import { companyKeyStrict } from '../identity';
import { isSensitive } from '../guardrails';
import { person, sameName, namesPerson, findMentions, sameCompany } from './courts';
// Shared with the agency-orders source, which reads the same Federal Register (courtsMore.js imports neither this
// file nor anything that does, so there is no import cycle).
import { withoutAddress, PRIVATE_MATTER, FR_EXCLUDED_AGENCIES } from './courtsMore';
// Every known name of a company (the name as typed and the legal names learned during the check)
import { companyNames } from './sanctions';

/* ------------------------------------------------------------------ helpers */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const uniq = (list) => [...new Set(list.filter(Boolean))];
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripTags = (s) => clean(String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' '));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? `$${Math.round(Number(n)).toLocaleString('en-US')}` : '');
const count = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${count(n)} ${Number(n) === 1 ? one : many}`;
const yearOf = (d) => (String(d || '').match(/^(\d{4})/) || [])[1] || '';
const span = (years) => {
  const ys = uniq(years.map(String)).filter((y) => /^\d{4}$/.test(y)).sort();
  if (!ys.length) return '';
  return ys[0] === ys[ys.length - 1] ? ys[0] : `${ys[0]}–${ys[ys.length - 1]}`;
};
/** "TREVOR R MILTON" -> "Trevor R Milton": the grader reads names written as names. */
const properCase = (s) => clean(s).toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
/**
 * The text a structured name match is graded on. The record's party (a lobbyist, an investigator) was already
 * compared with the person part by part ("LEE R. GODOWN" is Lee Godown), so the grade reads the person's own
 * name in its place followed by the record: the record's other facts (its company) still decide the grade, and a
 * name alone still stays 'possible'.
 */
const gradeOn = (who, listedAs, text) => `${who.name} (listed as ${listedAs}). ${text}`;
/** A topic line that would touch on health (a disease a grant studies, a recall reason): left out of the quote. */
const safe = (s) => (isSensitive(s) ? '' : s);
const isTied = (f) => f && (f.match === 'confirmed' || f.match === 'likely');

/**
 * The grade of a record whose registered name is the company's name. A one-word name ("Flow", once the legal form
 * is set aside) is shared by many unrelated firms across the country, and nothing in these records ties one of
 * them to the subject's company: such a record stays 'possible', as in the debarment lists. A name of two or more
 * distinctive words is the company.
 */
/**
 * The names a company is searched and matched under: as typed, then the fuller legal names the check learned for
 * it (identity.addCompanyAlias, for example "Ramp Business Corporation" for Ramp, from a Form D naming the person
 * as an officer). A one-word name searched alone finds every firm that shares the word; the legal name finds the
 * company. `max` keeps the number of requests per lookup small.
 */
export function knownNames(ctx, company, max = 3) {
  return companyNames(ctx?.subject, company, max);
}

/** The known name a registered name is (longest first, so a legal name wins over the bare word), or ''. */
export function whichName(registered, names) {
  return [...names].sort((a, b) => companyKeyStrict(b).split(' ').length - companyKeyStrict(a).split(' ').length)
    .find((n) => sameCompany(registered, n)) || '';
}

export function companyGrade(company, reason) {
  if (companyKeyStrict(company).split(' ').filter(Boolean).length < 2) {
    return { match: 'possible', matchReasons: [`${reason}; but ${clean(company)} is a one-word name many unrelated companies share, so verify it is the same company`] };
  }
  return { match: 'company', matchReasons: [reason] };
}

/**
 * Some hosts publish a request rate of their own that is slower than the shared
 * client's default spacing: LDA.gov allows 15 requests a minute to readers
 * without an account (robots.txt "Crawl-delay: 4"), and NIH RePORTER asks for
 * no more than one request a second. Each waits its turn here before the
 * shared client's own spacing.
 */
const HOST_GAP_MS = { 'lda.gov': 4100, 'api.reporter.nih.gov': 1100 };
const nextSlot = new Map();
let pacing = true;

async function waitTurn(url, deadline) {
  if (!pacing) return;
  const host = new URL(url).hostname;
  const gap = HOST_GAP_MS[host];
  if (!gap) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  if (deadline && at + 2000 > deadline) throw new HttpError('Out of time before the request could start', { url, retryable: true });
  nextSlot.set(host, at + gap);
  if (at > now) await sleep(at - now);
}

/** For tests: turn the per-host spacing off (true) or back on (false), and forget earlier turns. */
export function __resetGovernmentForTests({ unpaced = true } = {}) {
  pacing = !unpaced;
  nextSlot.clear();
}

async function fetchJson(url, ctx, options = {}) {
  await waitTurn(url, ctx.deadline);
  return getJson(url, { deadline: ctx.deadline, timeoutMs: 15000, ...options });
}

const LEGAL_FORMS = 'Inc|Incorporated|LLC|L\\.L\\.C|Ltd|Limited|Corp|Corporation|Co|Company|PLC|LP|LLP|PBC|S\\.A|SA|GmbH|AG|N\\.V|B\\.V';

/**
 * Where free text names the company as a name. The company's words must be
 * written as a name (capitalised or upper case), must not run on into another
 * capitalised word ("Nikola Motor Works", "Nikola Tesla") or follow one
 * ("Trevor Nikola"), and a one-word name must carry its legal form ("Stripe,
 * Inc."), so "a stripe", "Block Grant" and "Flow" in prose are not the company.
 */
export function namesCompanyInText(text, company) {
  const key = companyKeyStrict(company);
  const words = clean(company).split(' ').filter((w) => key.split(' ').includes(companyKeyStrict(w)) && companyKeyStrict(w));
  if (!words.length) return false;
  const forms = (w) => {
    const base = w.replace(/[^\p{L}\p{N}&'’-]/gu, '');
    if (!base) return '';
    const capital = base[0].toUpperCase() + base.slice(1);
    return uniq([base, capital, base.toUpperCase()]).map(escapeRe).join('|');
  };
  const name = words.map((w) => `(?:${forms(w)})`).join('[\\s-]+');
  const legal = `,?\\s+(?:${LEGAL_FORMS})\\.?(?![A-Za-z])`;
  const needsForm = key.split(' ').length < 2;
  const re = new RegExp(`(?<![A-Za-z0-9])(?<![A-Z][a-z]+\\s)(?:${name})${needsForm ? legal : `(?:${legal})?`}(?![A-Za-z0-9])(?!\\s+[A-Z][a-z])`, 'u');
  return re.test(String(text || ''));
}

/* ------------------------------------------------------------------ 1. USAspending: contracts, grants, loans */

const AW_ID = 'us-federal-awards';
const AW_LABEL = 'US federal contracts, grants and loans (USAspending.gov)';
const AW_BASE = 'https://api.usaspending.gov/api/v2';
const AW_SITE = 'https://www.usaspending.gov';
// One award group per search: the service refuses a mix of groups in one request.
const AW_GROUPS = [
  { group: 'contracts', what: 'federal contracts', one: 'federal contract', codes: ['A', 'B', 'C', 'D'], amount: 'Award Amount', date: 'Start Date', place: 'Place of Performance State Code' },
  { group: 'grants', what: 'federal grants', one: 'federal grant', codes: ['02', '03', '04', '05'], amount: 'Award Amount', date: 'Start Date', place: 'Place of Performance State Code' },
  { group: 'loans', what: 'federal loans (SBA and PPP loans included)', one: 'federal loan', many: 'federal loans', codes: ['07', '08'], amount: 'Loan Value', date: 'Issued Date', place: 'Recipient State Code' },
  { group: 'direct_payments', what: 'federal direct payments', one: 'federal direct payment', codes: ['06', '10'], amount: 'Award Amount', date: 'Start Date', place: 'Place of Performance State Code' },
];

async function awardRecipients(names, ctx) {
  const out = [];
  for (const name of names) {
    const body = await fetchJson(`${AW_BASE}/autocomplete/recipient/`, ctx, { method: 'POST', body: { search_text: name, limit: 50 } });
    if (!body || !Array.isArray(body.results)) throw new HttpError('USAspending returned an unexpected answer to a recipient search', { url: `${AW_BASE}/autocomplete/recipient/` });
    out.push(...body.results.map((r) => clean(r.recipient_name)).filter((n) => whichName(n, names)));
  }
  return uniq(out);
}

/** Rows grouped by the known name their registered name is: one finding each, graded by that name. */
function byKnownName(rows, nameOf, names) {
  const groups = new Map();
  for (const r of rows) {
    const known = whichName(nameOf(r), names);
    if (!known) continue;
    if (!groups.has(known)) groups.set(known, []);
    groups.get(known).push(r);
  }
  return [...groups.entries()].map(([known, list]) => ({ known, rows: list }));
}

export const usFederalAwardsConnector = {
  id: AW_ID,
  label: AW_LABEL,
  kinds: ['company'],
  prior: 0.25,
  timeoutMs: 30000,
  async run(task, ctx) {
    const company = clean(task.value);
    const known = knownNames(ctx, company);
    const notes = ['USAspending searches cover awards from October 2007 on.'];
    const names = await awardRecipients(known, ctx);
    if (!names.length) return { findings: [], threads: [], notes: [...notes, `No federal award recipient is registered under the exact name ${company}.`] };
    const counts = await fetchJson(`${AW_BASE}/search/spending_by_award_count/`, ctx, { method: 'POST', body: { filters: { recipient_search_text: names } } });
    if (!counts || typeof counts.results !== 'object') throw new HttpError('USAspending returned an unexpected answer to an award count', { url: `${AW_BASE}/search/spending_by_award_count/` });
    const findings = [];
    const partial = [];
    for (const g of AW_GROUPS) {
      if (!(Number(counts.results[g.group]) > 0)) continue;
      let rows;
      try {
        const body = await fetchJson(`${AW_BASE}/search/spending_by_award/`, ctx, {
          method: 'POST',
          body: {
            filters: { recipient_search_text: names, award_type_codes: g.codes },
            fields: ['Award ID', 'Recipient Name', g.amount, 'Awarding Agency', g.date, 'Description', g.place, 'recipient_id', 'generated_internal_id'],
            sort: g.amount, order: 'desc', limit: 50, page: 1,
          },
        });
        if (!body || !Array.isArray(body.results)) throw new HttpError('unexpected answer', { url: `${AW_BASE}/search/spending_by_award/` });
        rows = body.results;
      } catch (error) {
        partial.push(g.what);
        continue;
      }
      // The search matches any recipient whose name contains the text: keep the company's own names only, one
      // finding per known name, so a legal-name record is the company's and a bare-word one stays possible.
      for (const { known: as, rows: own } of byKnownName(rows, (r) => clean(r['Recipient Name']), known)) {
        const total = own.reduce((sum, r) => sum + (Number(r[g.amount]) || 0), 0);
        const agencies = uniq(own.map((r) => clean(r['Awarding Agency'])));
        const states = uniq(own.map((r) => clean(r[g.place])));
        const years = own.map((r) => yearOf(r[g.date]));
        const latest = own.map((r) => r[g.date]).filter(Boolean).sort().pop() || null;
        const recipient = clean(own[0]['Recipient Name']);
        const lines = own.slice(0, 3).map((r) => `${yearOf(r[g.date]) || 'undated'}, ${clean(r['Awarding Agency'])}${r[g.place] ? ` (${clean(r[g.place])})` : ''}, ${money(r[g.amount])}: ${clean(r.Description).slice(0, 140)}`);
        const url = own[0].recipient_id ? `${AW_SITE}/recipient/${encodeURIComponent(own[0].recipient_id)}/latest` : `${AW_SITE}/award/${encodeURIComponent(own[0].generated_internal_id)}`;
        const f = makeFinding(ctx.subject, {
          source: AW_ID, sourceLabel: AW_LABEL, category: 'corporate',
          title: `${plural(own.length, g.one, g.many || g.what)} to ${recipient}, ${span(years)}`,
          quote: `${recipient}${states.length ? `, ${states.join(', ')}` : ''}: ${money(total)} in all from ${agencies.slice(0, 3).join(', ')}. ${lines.join('; ')}`,
          url, date: latest, severity: 'info',
          ...companyGrade(as, `registered recipient name ${recipient} is ${as}`),
          data: { group: g.group, awards: own.length, total, agencies, states, recipients: names },
        });
        if (f) findings.push(f);
      }
    }
    if (partial.length && !findings.length && partial.length === AW_GROUPS.filter((g) => Number(counts.results[g.group]) > 0).length) {
      throw new HttpError(`USAspending did not answer for ${partial.join(', ')}`, { url: `${AW_BASE}/search/spending_by_award/`, retryable: true });
    }
    return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 2. LDA.gov: lobbying registrations and reports */

const LD_ID = 'us-lobbying';
const LD_LABEL = 'US federal lobbying registrations and reports (LDA.gov)';
const LD_BASE = 'https://lda.gov/api/v1/filings/';
// LDA.gov's terms ask every reuse to carry this statement and the date the data was retrieved.
const LD_DISCLAIMER = 'Senate Office of Public Records cannot vouch for the data or analyses derived from these data after the data have been retrieved from LDA.gov.';

async function ldaFilings(params, ctx) {
  const url = `${LD_BASE}?${new URLSearchParams({ ...params, page_size: '25', ordering: '-dt_posted' })}`;
  const body = await fetchJson(url, ctx);
  if (!body || !Array.isArray(body.results)) throw new HttpError('LDA.gov returned an unexpected answer', { url });
  return { filings: body.results, total: Number(body.count) || body.results.length, url };
}

const lobbyistName = (l) => clean([l?.first_name, l?.middle_name, l?.last_name].filter(Boolean).join(' '));
const issuesOf = (filings) => uniq(filings.flatMap((f) => (f.lobbying_activities || []).map((a) => clean(a.general_issue_code_display))));

/** Filings grouped by who lobbied for whom, latest first. */
function byEngagement(filings) {
  const groups = new Map();
  for (const f of filings) {
    const key = `${clean(f.registrant?.name)}|${clean(f.client?.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return [...groups.values()];
}

const retrievedNote = () => `Lobbying records retrieved from LDA.gov on ${new Date().toISOString().slice(0, 10)}. ${LD_DISCLAIMER}`;

export const usLobbyingConnector = {
  id: LD_ID,
  label: LD_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.2,
  // LDA.gov allows 15 requests a minute without an account: one lookup at a time.
  maxParallel: 1,
  timeoutMs: 30000,
  async run(task, ctx) {
    const findings = [];
    const base = { source: LD_ID, sourceLabel: LD_LABEL, category: 'corporate', severity: 'info' };
    if (task.kind === 'company') {
      const company = clean(task.value);
      // LDA.gov is slow to ask (one request every four seconds): the name and one learned legal name at most
      const known = knownNames(ctx, company, 2);
      const filings = [];
      const seenFilings = new Set();
      let total = 0;
      for (const name of known) {
        const answer = await ldaFilings({ client_name: name }, ctx);
        total += Math.max(0, answer.total - answer.filings.length);
        for (const f of answer.filings) {
          const id = f.filing_uuid || f.url || JSON.stringify([f.registrant?.name, f.client?.name, f.filing_year, f.filing_period]);
          if (!seenFilings.has(id)) { seenFilings.add(id); filings.push(f); }
        }
      }
      total += filings.length;
      const own = filings.filter((f) => whichName(clean(f.client?.name), known));
      for (const group of byEngagement(own).slice(0, 6)) {
        const latest = group[0];
        const client = clean(latest.client?.name);
        const registrant = clean(latest.registrant?.name);
        const self = sameCompany(registrant, client);
        const years = group.map((f) => f.filing_year);
        const issues = issuesOf(group);
        const spend = group.reduce((sum, f) => sum + (Number(self ? f.expenses : f.income) || 0), 0);
        const lobbyists = uniq(group.flatMap((f) => (f.lobbying_activities || []).flatMap((a) => (a.lobbyists || []).map((l) => properCase(lobbyistName(l.lobbyist))))));
        const terminated = group.find((f) => f.termination_date);
        const quote = `${client}${latest.client?.state ? ` (${clean(latest.client.state)})` : ''}, ${self ? 'lobbying on its own behalf' : `client of ${registrant}`}: ${plural(group.length, 'filing')} ${span(years)}`
          + `${spend ? `, ${money(spend)} reported ${self ? 'spent' : 'paid'}` : ''}`
          + `${issues.length ? `. Issues: ${issues.slice(0, 5).join(', ')}` : ''}`
          + `${lobbyists.length ? `. Lobbyists: ${lobbyists.slice(0, 6).join(', ')}` : ''}`
          + `${terminated ? `. Registration ended ${terminated.termination_date}` : ''}.`;
        const subjectAs = lobbyists.find((n) => sameName(n, person(ctx.subject)));
        const f = makeFinding(ctx.subject, {
          ...base,
          title: self ? `${client} lobbied the federal government, ${span(years)}` : `${registrant} lobbied for ${client}, ${span(years)}`,
          quote, url: latest.filing_document_url || latest.url, date: latest.dt_posted,
          data: { registrant, client, filings: group.length, years: span(years), issues, retrieved: new Date().toISOString().slice(0, 10), disclaimer: LD_DISCLAIMER },
          // The person is one of the lobbyists named: graded on the record's text, so the name alone stays 'possible'.
          ...(subjectAs ? { matchText: gradeOn(person(ctx.subject), subjectAs, quote) } : companyGrade(whichName(client, known) || company, `registered client name ${client} is ${whichName(client, known) || company}`)),
        });
        if (f) findings.push(f);
      }
      const notes = [retrievedNote()];
      if (total > filings.length) {
        notes.push(`LDA.gov lists ${count(total)} filings for clients named like ${company}; the latest ${filings.length} were read.`);
        return { findings, threads: [], notes, partial: [`lobbying filings (latest ${filings.length} of ${count(total)} read)`] };
      }
      return { findings, threads: [], notes };
    }

    // The person as a registered lobbyist.
    const who = person(ctx.subject);
    const threads = [];
    const { filings, total } = await ldaFilings({ lobbyist_name: who.name }, ctx);
    const theirs = filings.map((f) => {
      const entries = (f.lobbying_activities || []).flatMap((a) => (a.lobbyists || []).filter((l) => sameName(lobbyistName(l.lobbyist), who)));
      return entries.length ? { f, entries } : null;
    }).filter(Boolean);
    const groups = new Map();
    for (const t of theirs) {
      const key = `${clean(t.f.registrant?.name)}|${clean(t.f.client?.name)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const group of [...groups.values()].slice(0, 6)) {
      const latest = group[0].f;
      const client = clean(latest.client?.name);
      const registrant = clean(latest.registrant?.name);
      const listedAs = properCase(lobbyistName(group[0].entries[0].lobbyist));
      const positions = uniq(group.flatMap((t) => t.entries.map((e) => clean(e.covered_position)))).filter((p) => p && !/^n\/?a$/i.test(p));
      const years = group.map((t) => t.f.filing_year);
      const issues = issuesOf(group.map((t) => t.f));
      const quote = `${listedAs}, lobbyist for ${client}${latest.client?.state ? ` (${clean(latest.client.state)})` : ''}, registered by ${registrant}, ${span(years)}`
        + `${issues.length ? `. Issues: ${issues.slice(0, 5).join(', ')}` : ''}`
        + `${positions.length ? `. Former government position listed: ${positions.slice(0, 2).join('; ')}` : ''}.`;
      const f = makeFinding(ctx.subject, {
        ...base, category: 'career',
        title: `${listedAs} listed as a federal lobbyist for ${client}, ${span(years)}`,
        quote, url: latest.filing_document_url || latest.url, date: latest.dt_posted, matchText: gradeOn(who, listedAs, quote),
        data: { registrant, client, filings: group.length, years: span(years), issues, positions, retrieved: new Date().toISOString().slice(0, 10), disclaimer: LD_DISCLAIMER },
      });
      if (!f) continue;
      findings.push(f);
      if (isTied(f)) {
        for (const org of uniq([client, registrant])) {
          const t = makeThread('company', org, `${who.name} is listed as a lobbyist on its federal lobbying filings`, { trusted: true });
          if (t) threads.push(t);
        }
      }
    }
    const notes = [retrievedNote()];
    if (total > filings.length) {
      notes.push(`LDA.gov lists ${count(total)} filings for lobbyists named like ${who.name}; the latest ${filings.length} were read.`);
      return { findings, threads, notes, partial: [`lobbying filings (latest ${filings.length} of ${count(total)} read)`] };
    }
    return { findings, threads, notes };
  },
};

/* ------------------------------------------------------------------ 3. CFPB consumer complaint database */

const CC_ID = 'cfpb-complaints';
const CC_LABEL = 'US consumer complaints about financial companies (CFPB)';
const CC_BASE = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/';
const CC_SITE = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/';

const buckets = (aggs, name) => {
  const outer = aggs?.[name];
  const inner = outer?.[name] || outer;
  return Array.isArray(inner?.buckets) ? inner.buckets : [];
};

export const cfpbComplaintsConnector = {
  id: CC_ID,
  label: CC_LABEL,
  kinds: ['company'],
  prior: 0.2,
  timeoutMs: 45000,
  async run(task, ctx) {
    const company = clean(task.value);
    const known = knownNames(ctx, company, 2);
    // First: which companies in the database carry one of the company's names.
    const found = [];
    for (const name of known) {
      const lookUrl = `${CC_BASE}?${new URLSearchParams({ search_term: name, field: 'company', size: '0' })}`;
      // The database is large and a name search can take a while to answer.
      const look = await fetchJson(lookUrl, ctx, { timeoutMs: 25000 });
      if (!look || !look.aggregations) throw new HttpError('The CFPB complaint database returned an unexpected answer', { url: lookUrl });
      found.push(...buckets(look.aggregations, 'company').map((b) => clean(b.key)).filter((n) => whichName(n, known)));
    }
    const names = uniq(found).slice(0, 2);
    const findings = [];
    const partial = [];
    for (const name of names) {
      const url = `${CC_BASE}?${new URLSearchParams({ company: name, size: '1', sort: 'created_date_desc' })}`;
      let body;
      try {
        body = await fetchJson(url, ctx, { timeoutMs: 20000 });
        if (!body || !body.aggregations || !body.hits) throw new HttpError('unexpected answer', { url });
      } catch (error) {
        partial.push(name);
        continue;
      }
      const total = Number(body.hits.total?.value ?? body.hits.total) || 0;
      if (!total) continue;
      const products = buckets(body.aggregations, 'product').slice(0, 3).map((b) => `${b.key} (${count(b.doc_count)})`);
      const issues = buckets(body.aggregations, 'issue').filter((b) => safe(b.key)).slice(0, 4).map((b) => `${b.key} (${count(b.doc_count)})`);
      const responses = buckets(body.aggregations, 'company_response');
      const relief = responses.filter((b) => /relief/i.test(b.key)).map((b) => `${b.key.toLowerCase()} ${count(b.doc_count)}`);
      const late = buckets(body.aggregations, 'timely').find((b) => /^no$/i.test(b.key));
      // Only the date is read from the newest complaint: never its narrative, ZIP code or state.
      const latest = body.hits.hits?.[0]?._source?.date_received || null;
      const quote = `${plural(total, 'complaint')} to the CFPB name ${name}${latest ? `, the latest received ${String(latest).slice(0, 10)}` : ''}.`
        + `${products.length ? ` Products: ${products.join(', ')}.` : ''}`
        + `${issues.length ? ` Top issues: ${issues.join(', ')}.` : ''}`
        + `${relief.length ? ` Closed with ${relief.join(', ')}.` : ''}`
        + `${late && late.doc_count ? ` Not answered in time: ${count(late.doc_count)}.` : ''}`;
      const f = makeFinding(ctx.subject, {
        source: CC_ID, sourceLabel: CC_LABEL, category: 'regulatory',
        title: `${plural(total, 'consumer complaint')} about ${name} in the CFPB database`,
        quote, url: `${CC_SITE}?${new URLSearchParams({ company: name })}`, date: latest,
        // Complaints are consumers' accounts, not findings by the regulator: context, rarely a red flag.
        severity: total >= 10 ? 'low' : 'info',
        ...companyGrade(whichName(name, known) || company, `company name in the database, ${name}, is ${whichName(name, known) || company}`),
        data: { company: name, complaints: total },
      });
      if (f) findings.push(f);
    }
    if (names.length && partial.length === names.length) throw new HttpError(`The CFPB complaint database did not answer for ${partial.join(', ')}`, { url: CC_BASE, retryable: true });
    const notes = ['Complaints are published after the company responds or after 15 days; the CFPB does not verify every claim in them.'];
    return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 4. Federal Register */

const FR_ID = 'federal-register';
const FR_LABEL = 'US Federal Register notices and orders';
const FR_BASE = 'https://www.federalregister.gov/api/v1/documents.json';
const FR_FIELDS = ['title', 'type', 'abstract', 'html_url', 'publication_date', 'agencies', 'document_number', 'excerpts'];

async function frSearch(term, ctx) {
  const params = new URLSearchParams({ 'conditions[term]': `"${term.replace(/"/g, '')}"`, per_page: '40', order: 'relevance' });
  for (const f of FR_FIELDS) params.append('fields[]', f);
  const url = `${FR_BASE}?${params}`;
  const body = await fetchJson(url, ctx);
  if (!body || typeof body.count !== 'number' || (body.count > 0 && !Array.isArray(body.results))) throw new HttpError('The Federal Register returned an unexpected answer', { url });
  const results = body.results || [];
  const docs = results
    // Immigration, health and controlled-substance notices are never read, nor family, estate or health matters.
    .filter((d) => !(d.agencies || []).some((a) => FR_EXCLUDED_AGENCIES.has(clean(a?.slug))))
    .map((d) => ({
      // Export-ban orders print the person's home address in their titles: it is cut, from the text too.
      title: clean(withoutAddress(clean(d.title))),
      type: clean(d.type),
      agencies: uniq((d.agencies || []).map((a) => clean(a.name || a.raw_name))),
      date: d.publication_date || null,
      url: d.html_url,
      number: d.document_number,
      text: clean(withoutAddress(stripTags(d.excerpts || d.abstract || ''))),
    }))
    .filter((d) => d.title && d.url);
  return { docs, total: body.count, read: results.length };
}
const frPartial = (searches) => {
  const cut = searches.filter((s) => s.total > s.read);
  return cut.length ? { partial: cut.map((s) => `Federal Register (${s.read} of ${count(s.total)} documents read)`) } : {};
};

/** Rules and proposed rules discuss cases as background: they are not actions against anyone named in them. */
const frSeverity = (d, text, subject) => {
  const sev = severityFromText(text, subject);
  return /rule/i.test(d.type) && (sev === 'high' || sev === 'medium') ? 'low' : sev;
};
/** How the document writes the person's name (its first mention that is not part of a longer name). */
const mentionOf = (text, who) => (findMentions(text, who).find((m) => !m.extended) || {}).text || who.name;
const frQuote = (d) => `${d.type || 'Document'}, ${d.agencies.slice(0, 2).join(' / ') || 'federal agency'}, published ${d.date || 'undated'}: ${d.text || d.title}`;

export const federalRegisterConnector = {
  id: FR_ID,
  label: FR_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.2,
  timeoutMs: 20000,
  async run(task, ctx) {
    const findings = [];
    const base = { source: FR_ID, sourceLabel: FR_LABEL, category: 'regulatory' };
    if (task.kind === 'company') {
      const company = clean(task.value);
      const who = person(ctx.subject);
      const known = knownNames(ctx, company, 2);
      const searches = [];
      const docs = [];
      const seen = new Set();
      for (const name of known) {
        const search = await frSearch(name, ctx);
        searches.push(search);
        for (const d of search.docs) if (!seen.has(d.url)) { seen.add(d.url); docs.push(d); }
      }
      // A legal name of more words is looked for first: a document naming it is the company's
      const byLength = [...known].sort((a, b) => companyKeyStrict(b).split(' ').length - companyKeyStrict(a).split(' ').length);
      for (const d of docs) {
        const text = `${d.title} ${d.text}`;
        const as = byLength.find((n) => namesCompanyInText(text, n));
        if (!as) continue;
        const named = namesPerson(text, who);
        // A record about a person's family, estate, immigration or health is never read.
        if (named && PRIVATE_MATTER.test(text)) continue;
        const quote = frQuote(d);
        const f = makeFinding(ctx.subject, {
          ...base, title: d.title, quote, url: d.url, date: d.date,
          severity: frSeverity(d, text, ctx.subject),
          data: { type: d.type, agencies: d.agencies, documentNumber: d.number },
          ...(named ? { matchText: gradeOn(who, mentionOf(text, who), `${d.title}\n${quote}`) } : companyGrade(as, `names ${as}`)),
        });
        if (f) findings.push(f);
      }
      return { findings: rank(findings).slice(0, 10), threads: [], notes: [], ...frPartial(searches) };
    }
    const who = person(ctx.subject);
    const docs = [];
    const searches = [];
    for (const name of who.queryNames.slice(0, 2)) {
      const search = await frSearch(name, ctx);
      searches.push(search);
      docs.push(...search.docs);
    }
    const seen = new Set();
    for (const d of docs) {
      if (seen.has(d.url)) continue;
      seen.add(d.url);
      const text = `${d.title} ${d.text}`;
      // The person's own name, not a longer name that contains it
      if (!namesPerson(text, who)) continue;
      // A record about a person's family, estate, immigration or health is never read.
      if (PRIVATE_MATTER.test(text)) continue;
      const quote = frQuote(d);
      const f = makeFinding(ctx.subject, {
        ...base, title: d.title, quote, url: d.url, date: d.date, matchText: gradeOn(who, mentionOf(text, who), `${d.title}\n${quote}`),
        severity: frSeverity(d, text, ctx.subject),
        data: { type: d.type, agencies: d.agencies, documentNumber: d.number },
      });
      if (f) findings.push(f);
    }
    return { findings: rank(findings).slice(0, 10), threads: [], notes: [], ...frPartial(searches) };
  },
};

const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };
const rank = (findings) => findings.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || String(b.date || '').localeCompare(String(a.date || '')));

/* ------------------------------------------------------------------ 5. openFDA recall and enforcement reports */

const FD_ID = 'fda-recalls';
const FD_LABEL = 'US FDA recalls and enforcement reports (openFDA)';
const FD_BASE = 'https://api.fda.gov';
const FD_KINDS = [
  { path: 'drug', what: 'drug' },
  { path: 'device', what: 'medical device' },
  { path: 'food', what: 'food' },
];

async function fdaRecalls(kind, company, ctx) {
  const url = `${FD_BASE}/${kind.path}/enforcement.json?${new URLSearchParams({ search: `recalling_firm:"${company.replace(/"/g, '')}"`, limit: '100' })}`;
  try {
    const body = await fetchJson(url, ctx);
    if (!body || !Array.isArray(body.results)) throw new HttpError('openFDA returned an unexpected answer', { url });
    return { url, rows: body.results, total: Number(body.meta?.results?.total) || body.results.length };
  } catch (error) {
    // openFDA answers a search with no match with HTTP 404 ("No matches found!"): that is an empty answer.
    if (error instanceof HttpError && error.status === 404) return { url, rows: [], total: 0 };
    throw error;
  }
}

export const fdaRecallsConnector = {
  id: FD_ID,
  label: FD_LABEL,
  kinds: ['company'],
  prior: 0.15,
  timeoutMs: 25000,
  async run(task, ctx) {
    const company = clean(task.value);
    const known = knownNames(ctx, company, 2);
    const findings = [];
    const partial = [];
    for (const kind of FD_KINDS) {
      const answers = [];
      let failed = 0;
      for (const name of known) {
        try {
          answers.push(await fdaRecalls(kind, name, ctx));
        } catch (error) {
          failed += 1;
        }
      }
      if (failed) partial.push(`${kind.what} recalls`);
      if (!answers.length) continue;
      const seenRecalls = new Set();
      // Only a second search (a learned legal name) can return the same recall twice
      const rows = answers.length === 1 ? answers[0].rows : answers.flatMap((a) => a.rows).filter((r) => {
        // One event can hold several recalls (products): only the same recall found under two names is folded
        const id = r.recall_number || JSON.stringify(r);
        if (seenRecalls.has(id)) return false;
        seenRecalls.add(id);
        return true;
      });
      const answer = { url: answers[0].url };
      // The search matches any firm whose name contains the words: keep the company's own names only, one
      // finding per known name.
      for (const { known: as, rows: own } of byKnownName(rows, (r) => clean(r.recalling_firm), known)) {
        own.sort((a, b) => String(b.report_date || '').localeCompare(String(a.report_date || '')));
        const firm = clean(own[0].recalling_firm);
        const states = uniq(own.map((r) => clean(r.state)));
        const classes = uniq(own.map((r) => clean(r.classification))).sort();
        const years = own.map((r) => yearOf(r.report_date));
        const seriousCount = own.filter((r) => /class i$/i.test(clean(r.classification))).length;
        const lines = own.slice(0, 3).map((r) => {
          const reason = safe(clean(r.reason_for_recall).slice(0, 160));
          return `${yearOf(r.report_date)}, ${clean(r.classification)}, ${clean(r.status).toLowerCase()}${reason ? `: ${reason}` : ''}`;
        });
        const f = makeFinding(ctx.subject, {
          source: FD_ID, sourceLabel: FD_LABEL, category: 'regulatory',
          title: `${plural(own.length, `${kind.what} recall`)} by ${firm}, ${span(years)}`,
          quote: `${firm}${states.length ? ` (${states.join(', ')})` : ''}, FDA ${kind.what} enforcement reports ${span(years)}, ${classes.join(', ')}${seriousCount ? `, ${count(seriousCount)} Class I (the most serious)` : ''}. ${lines.join('; ')}`,
          url: answer.url, date: own[0].report_date || null,
          severity: seriousCount ? 'medium' : 'low',
          ...companyGrade(as, `recalling firm ${firm} is ${as}`),
          data: { products: kind.what, recalls: own.length, classes, states },
        });
        if (f) findings.push(f);
      }
    }
    if (partial.length === FD_KINDS.length && !findings.length) throw new HttpError('openFDA did not answer', { url: FD_BASE, retryable: true });
    return partial.length ? { findings, threads: [], notes: [], partial } : { findings, threads: [], notes: [] };
  },
};

/* ------------------------------------------------------------------ 6. NIH RePORTER research grants */

const NI_ID = 'nih-grants';
const NI_LABEL = 'US NIH research grants (NIH RePORTER)';
const NI_SEARCH = 'https://api.reporter.nih.gov/v2/projects/search';
const NI_FIELDS = ['ApplId', 'ProjectNum', 'CoreProjectNum', 'ProjectTitle', 'Organization', 'FiscalYear', 'AwardAmount', 'PrincipalInvestigators', 'AgencyIcAdmin', 'ProjectStartDate', 'ProjectEndDate', 'ProjectDetailUrl'];

async function nihProjects(criteria, ctx) {
  const body = await fetchJson(NI_SEARCH, ctx, { method: 'POST', body: { criteria, limit: 100, offset: 0, include_fields: NI_FIELDS, sort_field: 'fiscal_year', sort_order: 'desc' } });
  if (!body || !Array.isArray(body.results)) throw new HttpError('NIH RePORTER returned an unexpected answer', { url: NI_SEARCH });
  return { rows: body.results, total: Number(body.meta?.total) || body.results.length };
}

/** One row per grant (its yearly renewals folded in), newest first. */
function byGrant(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.core_project_num || r.project_num || r.appl_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => (b.fiscal_year || 0) - (a.fiscal_year || 0)));
}

const nihUrl = (r) => r.project_detail_url || `https://reporter.nih.gov/project-details/${encodeURIComponent(r.appl_id)}`;
const SCHOOL = /\b(universit|college|school of|institute of technology|polytechnic)/i;

export const nihGrantsConnector = {
  id: NI_ID,
  label: NI_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.2,
  timeoutMs: 25000,
  async run(task, ctx) {
    const who = person(ctx.subject);
    const findings = [];
    const threads = [];
    if (task.kind === 'company') {
      const company = clean(task.value);
      // One request asks for every known name of the company
      const known = knownNames(ctx, company);
      const { rows, total: listed } = await nihProjects({ org_names: known }, ctx);
      const cut = listed > rows.length ? { partial: [`NIH grants (latest ${rows.length} of ${count(listed)} read)`] } : {};
      for (const { known: as, rows: own } of byKnownName(rows, (r) => clean(r.organization?.org_name), known)) {
        const grants = byGrant(own);
        const org = clean(own[0].organization?.org_name);
        const states = uniq(own.map((r) => clean(r.organization?.org_state)));
        const total = own.reduce((sum, r) => sum + (Number(r.award_amount) || 0), 0);
        const pis = uniq(own.flatMap((r) => (r.principal_investigators || []).map((p) => properCase(p.full_name))));
        const lines = grants.slice(0, 3).map((g) => {
          const topic = safe(clean(g[0].project_title));
          return `${g[0].fiscal_year}, NIH ${clean(g[0].agency_ic_admin?.abbreviation)} ${clean(g[0].core_project_num || g[0].project_num)}${topic ? `: ${topic}` : ''}`;
        });
        const quote = `${org}${states.length ? ` (${states.join(', ')})` : ''}: ${plural(grants.length, 'NIH grant')}, ${money(total)} awarded ${span(own.map((r) => r.fiscal_year))}`
          + `${pis.length ? `. Principal investigators: ${pis.slice(0, 5).join(', ')}` : ''}. ${lines.join('; ')}`;
        const subjectAs = pis.find((n) => sameName(n, who));
        const f = makeFinding(ctx.subject, {
          source: NI_ID, sourceLabel: NI_LABEL, category: 'corporate',
          title: `${plural(grants.length, 'NIH research grant')} to ${org}, ${span(own.map((r) => r.fiscal_year))}`,
          quote, url: nihUrl(grants[0][0]), date: grants[0][0].project_start_date || String(grants[0][0].fiscal_year || ''), severity: 'info',
          data: { grants: grants.length, total, states },
          ...(subjectAs ? { matchText: gradeOn(who, subjectAs, quote) } : companyGrade(as, `grantee organisation ${org} is ${as}`)),
        });
        if (f) findings.push(f);
      }
      return { findings, threads, notes: [], ...cut };
    }

    const { rows, total } = await nihProjects({ pi_names: who.queryNames.slice(0, 2).map((n) => ({ any_name: n })) }, ctx);
    const theirs = rows.filter((r) => (r.principal_investigators || []).some((p) => sameName(clean(p.full_name), who)));
    for (const g of byGrant(theirs).slice(0, 8)) {
      const r = g[0];
      const pi = (r.principal_investigators || []).find((p) => sameName(clean(p.full_name), who));
      const org = clean(r.organization?.org_name);
      const years = span(g.map((x) => x.fiscal_year));
      const topic = safe(clean(r.project_title));
      const listedAs = properCase(pi.full_name);
      const quote = `${listedAs}, principal investigator at ${org}${r.organization?.org_state ? ` (${clean(r.organization.org_state)})` : ''}, NIH ${clean(r.agency_ic_admin?.abbreviation)}, fiscal years ${years}${topic ? `: ${topic}` : ''}`
        + `${r.award_amount ? `. Latest award ${money(r.award_amount)}` : ''}.`;
      const f = makeFinding(ctx.subject, {
        source: NI_ID, sourceLabel: NI_LABEL, category: 'career',
        title: `NIH grant ${clean(r.core_project_num || r.project_num)}${topic ? `: ${topic}` : ` to ${org}`}`,
        quote, url: nihUrl(r), date: r.project_start_date || String(r.fiscal_year || ''), severity: 'info', matchText: gradeOn(who, listedAs, quote),
        data: { project: clean(r.project_num), organisation: org, fiscalYears: years },
      });
      if (!f) continue;
      findings.push(f);
      if (isTied(f) && org) {
        const t = makeThread(SCHOOL.test(org) ? 'school' : 'company', org, `${who.name} is a principal investigator on an NIH grant there`, { trusted: true });
        if (t) threads.push(t);
      }
    }
    if (total > rows.length) {
      const notes = [`NIH RePORTER lists ${count(total)} grants for investigators named like ${who.name}; the latest ${rows.length} were read.`];
      return { findings, threads: uniqThreads(threads), notes, partial: [`NIH grants (latest ${rows.length} of ${count(total)} read)`] };
    }
    return { findings, threads: uniqThreads(threads), notes: [] };
  },
};

const uniqThreads = (threads) => {
  const seen = new Set();
  return threads.filter((t) => {
    const k = `${t.kind}|${t.value.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export const GOVERNMENT_CONNECTORS = [
  usFederalAwardsConnector, usLobbyingConnector, cfpbComplaintsConnector,
  federalRegisterConnector, fdaRecallsConnector, nihGrantsConnector,
];
