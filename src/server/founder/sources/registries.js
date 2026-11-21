/**
 * Company registers: what the official record says about a company and who
 * runs it, to set against what a founder says.
 *
 *   uk-companies-house   UK Companies House public pages: a person's officer
 *                        appointments, a company's record and officers, and
 *                        the register of disqualified directors.
 *   fr-companies         The French state's open company search: companies a
 *                        person runs, and a company's creation date, status
 *                        and current officers.
 *   us-state-registries  The business registers five US states publish as
 *                        open data (Colorado, New York, Connecticut, Oregon,
 *                        Texas), asked in parallel.
 *   lei-register         The global Legal Entity Identifier register (GLEIF):
 *                        legal name, status, creation date and parent.
 *   yc-directory         Y Combinator's public company directory: batch,
 *                        status, year founded and the official founder list.
 *
 * Identity. Officer search is by name, and registers are full of namesakes
 * and of companies with look-alike names. So:
 *   - an officer is kept only when the first name and surname are the
 *     subject's (middle names allowed);
 *   - an appointment is graded by finding.js from the company it is at: only
 *     a known company of the subject lifts it above "possible". The check
 *     here is stricter than the general one: the registered name must BE the
 *     known company's name, or that name plus only words for a country arm,
 *     a holding or a legal form ("Mistral AI UK Ltd" for "Mistral AI", when
 *     the known name has two words of its own). One that only starts with it
 *     otherwise ("Flow Hair Salon Limited", or "Flow UK Ltd", for "Flow") is
 *     held at "possible", and "Mistral Aircraft Limited" never ties at all;
 *   - a company found by name is reported as the subject's company only when
 *     the register itself ties it to them (the subject, or a known associate,
 *     is among its officers or founders). A company whose name only starts
 *     with the wanted one needs a known associate on its board: an officer
 *     who merely shares the subject's name is not enough. Where a register
 *     lists no people (US states, GLEIF) only an exact legal name is
 *     accepted, only when a single entity carries it (otherwise every one is
 *     "possible" and its status raises no flag), and the record says the tie
 *     rests on the name;
 *   - officer names are compared without a leading title ("Dr", "Sir");
 *   - French companies that share officers with a confirmed company of the
 *     subject are tied through those officers.
 *
 * Privacy. Companies House shows a month and year of birth, nationality,
 * occupation and a correspondence address for every officer; the French
 * register returns a birth month and nationality; the state registers carry
 * registered-agent names and addresses. None of these is read: the parsers
 * pick out names, roles, dates and company fields by id, the state queries
 * select entity columns only, and sole traders are skipped altogether.
 *
 * The lookups can be switched off without a deploy: FOUNDER_SOURCES_OFF is a
 * comma-separated list of connector ids.
 */
import { load } from 'cheerio';
import { getJson, getText, request, mapLimit } from '../http';
import { makeFinding, makeThread } from '../finding';
import { nameTokens, addCompanyAlias } from '../identity';
import { isOrdinaryWordCompany, companyKeys } from '../names';
import { cachedEntry } from '../cache';
import { profileFromUrl } from '../extract';
import { languageHints } from './web';

const switchedOff = (id) => String(process.env.FOUNDER_SOURCES_OFF || '').split(',').map((s) => s.trim()).filter(Boolean).includes(id);
const OFF_REASON = 'This register is not enabled on this deployment.';

/* ------------------------------------------------------------------ shared helpers */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const uniqueBy = (items, keyOf) => { const seen = new Set(); return items.filter((x) => { const k = keyOf(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

const LEGAL_FORMS = 'incorporated|inc|llc|ltd|limited|corp|corporation|co|company|plc|lp|llp|lllp|pbc|pllc|sa|sas|sasu|sarl|eurl|gmbh|ag|bv|nv|oy|ab|aps|pte|pty|srl|spa|kk';
const LEGAL_TAIL = new RegExp(`(?:^|\\s)(?:${LEGAL_FORMS})$`);

/**
 * A company name reduced to what identifies it: lower case, no accents or
 * punctuation, no leading "the", no trailing legal form.
 * "Theranos, Inc." -> "theranos"; "STRIPE PAYMENTS UK LTD" -> "stripe payments uk".
 */
export function legalNorm(name) {
  let out = fold(name).replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, '')).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
  for (let i = 0; i < 3 && LEGAL_TAIL.test(out); i += 1) out = out.replace(LEGAL_TAIL, '').trim();
  return out;
}

/** The name as written, without a trailing legal form: "Nikola Corporation" -> "Nikola". */
export function withoutLegalForm(name) {
  let out = clean(name);
  const tail = new RegExp(`[,\\s]+(?:${LEGAL_FORMS}|l\\.l\\.c|s\\.a\\.s|s\\.a)\\.?$`, 'i');
  for (let i = 0; i < 3; i += 1) out = out.replace(tail, '').trim();
  return out || clean(name);
}

/** How a registered company name relates to a wanted one: 'exact', 'prefix' (starts with all of it) or null. */
export function nameTie(wanted, registered) {
  const w = legalNorm(wanted);
  const r = legalNorm(registered);
  if (w.length < 2 || !r) return null;
  if (r === w) return 'exact';
  return r.startsWith(`${w} `) ? 'prefix' : null;
}

// Words that describe a business rather than name it: "Flow Labs" or "NTT Technologies" is still one word of name
const DESCRIBING_WORDS = new Set(['and', 'of', 'labs', 'lab', 'tech', 'technology', 'technologies', 'group', 'holding', 'holdings', 'international', 'global', 'systems', 'solutions', 'services', 'software', 'ventures', 'capital', 'partners', 'digital', 'data', 'uk', 'us', 'usa', 'france', 'europe', 'sci', 'conseil', 'industries', 'enterprises', 'consulting', 'media', 'studio', 'studios', 'network', 'networks', 'management']);
const LEGAL_SAME = { corporation: 'corp', incorporated: 'inc', limited: 'ltd', company: 'co' };
const fullLegalKey = (name) => fold(name).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '').split(' ').map((w) => LEGAL_SAME[w] || w).join(' ');
/**
 * Is a same-named company worth showing when no listed officer ties it to the
 * person? Only when the name says more than one word of its own, or the given
 * name carried a legal form and the register's name is exactly it ("Nikola
 * Corporation" = "NIKOLA CORP", but not a French "NIKOLA" SAS).
 */
function distinctiveMatch(given, registeredNames) {
  if (legalNorm(given).split(' ').filter((w) => w && !DESCRIBING_WORDS.has(w)).length > 1) return true;
  if (withoutLegalForm(given) === clean(given)) return false;
  return registeredNames.some((n) => fullLegalKey(n) === fullLegalKey(given));
}
/** Untied records are a namesake's company at best: graded 'possible' for good and kept off the timeline. */
const untiedRecord = (finding) => { if (finding) { finding.matchFixed = true; finding.excludeFromTimeline = true; } return finding; };
const isAffiliate = (task) => task.tie === 'affiliate';
const untiedNote = (country, wanted, task) => (isAffiliate(task)
  ? `No ${country} company named ${wanted} lists the person as an officer.`
  : `${country} companies named ${wanted} were found, but no listed officer matches the person and the name alone is too common to tie them to the person; they are not reported.`);

// Words a group adds to its own name for a country arm, a holding or an employee vehicle ("Mistral AI UK Ltd")
const BRANCH_WORDS = new Set(['uk', 'gb', 'france', 'us', 'usa', 'europe', 'eu', 'emea', 'germany', 'holding', 'holdings', 'employees', 'spv', 'ltd', 'limited', 'sas', 'inc']);
/**
 * Does a registered name add to a known company's name only words for a
 * country, a holding or a legal form? Only for a known name of two words of
 * its own or more: "Mistral AI UK Ltd" is Mistral AI's UK arm, but "Flow UK
 * Ltd" could be anyone's.
 */
function isBranchOf(company, registered) {
  if (nameTie(company, registered) !== 'prefix') return false;
  const known = legalNorm(company);
  if (known.split(' ').filter((w) => w && !DESCRIBING_WORDS.has(w)).length < 2) return false;
  const extra = legalNorm(registered).slice(known.length).trim().split(' ').filter(Boolean);
  return extra.length > 0 && extra.every((w) => BRANCH_WORDS.has(w));
}

const knownCompanies = (subject) => uniqueBy([subject.company, ...[...(subject.anchors?.companies?.values?.() || [])].map((a) => a.value)].filter(Boolean), (v) => legalNorm(v));
const isDomainName = (v) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(String(v || '')) && /\.[a-z]{2,}$/i.test(String(v || ''));
/**
 * Every name the check knows a company of the subject by: the company as typed or found, and each fuller
 * legal name learned for it later (identity.addCompanyAlias, from a Form D, a register entry naming the
 * person, the company's own legal footer). `of` is the company the name stands for. Domains are left out:
 * they are not names a register prints.
 */
export function knownCompanyNames(subject) {
  const companies = knownCompanies(subject || {});
  const out = companies.map((company) => ({ name: company, of: company, alias: false }));
  for (const a of subject?.anchors?.aliases?.values?.() || []) {
    if (!a?.value || isDomainName(a.value)) continue;
    const owner = companies.find((c) => (companyKeys(c)[0] || c.toLowerCase()) === a.of) || subject?.anchors?.companies?.get?.(a.of)?.value;
    if (owner) out.push({ name: a.value, of: owner, alias: true });
  }
  return uniqueBy(out, (x) => legalNorm(x.name));
}
// Words a group adds to a coined one-word name for an arm of itself ("Airwallex Global Limited", "Theranos UK
// Ltd"). Words that make a new brand ("Labs", "Tech", "Hair Salon") are not among them.
const GROUP_WORDS = new Set([...BRANCH_WORDS, 'global', 'international', 'group', 'worldwide', 'operations', 'europe', 'emea', 'apac', 'asia', 'pacific', 'australia', 'canada', 'singapore', 'hong', 'kong', 'ireland', 'netherlands', 'india', 'japan']);
/**
 * Does a registered name add to a coined one-word company name ("Airwallex", not "Ramp") only words for an
 * arm of the group? An ordinary word ("Flow UK Ltd", "Merge Ltd") never ties this way: thousands of
 * unrelated businesses carry it.
 */
function isGroupArmOf(company, registered) {
  if (nameTie(company, registered) !== 'prefix') return false;
  const known = legalNorm(company);
  if (known.split(' ').length !== 1 || isOrdinaryWordCompany(company) || known.length < 4) return false;
  const extra = legalNorm(registered).slice(known.length).trim().split(' ').filter(Boolean);
  return extra.length > 0 && extra.every((w) => GROUP_WORDS.has(w));
}
/**
 * The known company of the subject that a registered name IS, or null. A name
 * that only starts with a known one ("Flow Hair Salon Limited" for "Flow") is
 * not enough: with a namesake officer it would pin a stranger's company on the
 * subject. Such a company is tied only through a known associate (ukCompany).
 * The exceptions are the company's own country arm or holding (isBranchOf), an
 * arm of a coined one-word name ("Airwallex Global Limited"), and the same
 * forms of a legal name learned for the company ("RAMP BUSINESS UK LTD" once
 * "Ramp Business Corp" is known as Ramp's legal name).
 * @returns {{ company: string, tie: 'exact'|'branch'|'group', via: string, alias: boolean } | null}
 */
export function knownCompanyFor(subject, registered) {
  const names = knownCompanyNames(subject);
  for (const n of names) if (nameTie(n.name, registered) === 'exact') return { company: n.of, tie: 'exact', via: n.name, alias: n.alias };
  for (const n of names) if (isBranchOf(n.name, registered)) return { company: n.of, tie: 'branch', via: n.name, alias: n.alias };
  for (const n of names) if (isGroupArmOf(n.name, registered)) return { company: n.of, tie: 'group', via: n.name, alias: n.alias };
  return null;
}
/** Does a registered name start with a known company's name? Used to order records only, never to grade them. */
const resemblesKnown = (subject, registered) => knownCompanyNames(subject).some((n) => nameTie(n.name, registered));
/** Is this company name one ordinary word that no learned legal name backs up ("Ramp", "Merge")? */
function bareOrdinaryWord(company) {
  // A fuller legal name ("Ramp Business Corporation") is not bare, even when it starts with an ordinary word
  return isOrdinaryWordCompany(company) && legalNorm(company).split(' ').length === 1;
}

// Titles some registers print before the given names ("Dr Patrick Malcolm COLLISON", "COLLISON, Dr Patrick")
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'professor', 'sir', 'dame', 'lord', 'lady', 'rev', 'revd', 'hon', 'baroness', 'baron']);
/** Drop leading titles, always keeping at least `keep` words. Works on tokens or on words as written. */
const dropTitles = (words, keep) => {
  let at = 0;
  while (words.length - at > keep && HONORIFICS.has(String(words[at]).toLowerCase().replace(/\.$/, ''))) at += 1;
  return words.slice(at);
};

/** Name tokens in "given names, surname" order, whether the register wrote "SURNAME, Forenames" or "Forenames SURNAME". */
function registryTokens(name) {
  const parts = String(name || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return [...dropTitles(nameTokens(parts[1]), 1), ...nameTokens(parts[0])]; // a third part is a title ("Dr")
  return dropTitles(nameTokens(name), 2);
}

/**
 * Are these the subject's first name and surname? Middle names on either
 * side are allowed, but where both sides give one they must agree.
 * @param {string[]} theirs tokens of the registered name, given names first
 * @param {string[]} mine   tokens of the subject's name
 */
export function sameName(theirs, mine) {
  if (theirs.length < 2 || mine.length < 2 || theirs[0] !== mine[0]) return false;
  for (let k = 1; k < mine.length; k += 1) {
    const surname = mine.slice(k);
    if (theirs.length <= surname.length) continue;
    if (surname.some((t, i) => theirs[theirs.length - surname.length + i] !== t)) continue;
    const myMiddle = mine.slice(1, k);
    const theirMiddle = theirs.slice(1, theirs.length - surname.length);
    const agrees = (m) => theirMiddle.some((t) => t === m || (m.length === 1 && t.startsWith(m)) || (t.length === 1 && m.startsWith(t)));
    if (myMiddle.length && theirMiddle.length && !myMiddle.every(agrees)) continue;
    return true;
  }
  return false;
}

const tidyWord = (w) => (w.length > 1 && w === w.toUpperCase() && /[A-ZÀ-Þ]/.test(w)
  ? w.toLowerCase().replace(/(^|[-'’\s])([a-zà-ÿ])/g, (m, lead, ch) => lead + ch.toUpperCase())
  : w);
/** "VAN GAEL, Jurgen Anne" -> "Jurgen Anne Van Gael"; "Arthur Hubert Jean MENSCH" -> "Arthur Hubert Jean Mensch". */
function displayPerson(name) {
  const parts = String(name || '').split(',').map((p) => clean(p)).filter(Boolean);
  const ordered = parts.length >= 2 ? `${parts[1]} ${parts[0]}` : clean(name);
  return ordered.split(' ').map(tidyWord).join(' ');
}
/** First given name and surname only: how other sources usually write a person. */
function shortPerson(name) {
  const parts = String(name || '').split(',').map((p) => clean(p)).filter(Boolean);
  if (parts.length >= 2) return `${tidyWord(dropTitles(parts[1].split(' '), 1)[0])} ${parts[0].split(' ').map(tidyWord).join(' ')}`;
  const words = dropTitles(clean(name).split(' '), 2);
  if (words.length <= 2) return words.map(tidyWord).join(' ');
  // "Forenames SURNAME": the surname is the run of capitals at the end
  let at = words.length - 1;
  while (at > 1 && words[at - 1] === words[at - 1].toUpperCase() && /[A-Z]/.test(words[at - 1]) && words[at - 1].length > 1) at -= 1;
  return [words[0], ...words.slice(at)].map(tidyWord).join(' ');
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** "25 May 2023" -> "2023-05-25" (no time zone involved). */
function ukDate(text) {
  const m = clean(text).match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS.findIndex((name) => name.startsWith(m[2].toLowerCase().slice(0, 3)));
  return month < 0 ? null : `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
// Registers fill unknown dates with placeholders such as 0001-01-01: those are no date
const isoDay = (s) => (/^(1[89]|2\d)\d{2}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : null);
/** "2023-05-25" -> "25 May 2023". */
function longDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month[0].toUpperCase()}${month.slice(1)} ${m[1]}` : m[1];
}

const GONE = /dissolved|struck off|removed|closed|ceased|withdrawn|revoked|forfeited|cancel|terminated|merged|expired|inactive/i;
const DISTRESSED = /liquidation|administration|receivership|insolven|voluntary arrangement|bankrupt/i;
const LAPSED = /delinquent|noncompliant|not in good standing|suspended/i;
/** How much a company's registered status matters: gone or lapsed is worth a look, insolvency more so. */
const companySeverity = (status) => (DISTRESSED.test(status) ? 'medium' : GONE.test(status) || LAPSED.test(status) ? 'low' : 'info');
/** The same, for a person's role at that company. */
const roleSeverity = (status) => (DISTRESSED.test(status) || GONE.test(status) ? 'low' : 'info');

/**
 * Grade and build a record that ties the subject to a company through a
 * register. finding.js grades it from the names; this adds the stricter
 * company rule: when the general grader would accept a company that only
 * resembles a known one, the record is held at "possible" for good.
 */
function personAtCompany(subject, registeredCompany, fields, context = '', sameRecord = null) {
  const tie = knownCompanyFor(subject, registeredCompany);
  // Separated so the grader never reads "Arthur Mensch MISTRAL AI" as one longer name. A tie through a learned
  // legal name puts that name beside the register's, so the grader sees the company it stands for.
  const matchText = [subject.name, registeredCompany, tie?.alias ? `${tie.via} (${tie.company})` : '', context].filter(Boolean).join('; ');
  // With no tie and no structured context the record is held at "possible" for good: a regrade must never lift
  // it on the strength of a look-alike name. retieHeldRecords lifts it to "likely" if a legal name learned later
  // ties it. An appointment on the same register record (the same Companies House officer) as one that does tie
  // is the same person's, and is graded "likely".
  const hold = !tie && !context;
  const finding = makeFinding(subject, {
    ...fields,
    matchText,
    ...(hold && sameRecord ? { match: 'likely', matchReasons: [sameRecord] }
      : hold ? { match: 'possible', matchReasons: ['matched by name; the company name only resembles a known company of this person, or is not one'] } : {}),
    data: { ...(fields.data || {}), registeredCompany, ...(hold ? { heldOnName: true } : {}) },
  });
  if (finding && hold) finding.matchFixed = true;
  return finding;
}

/**
 * Register records held at "possible" because their company was not then a known one of the subject, looked at
 * again with what is known now: a legal name learned later ("Ramp Business Corp") ties "RAMP BUSINESS UK LTD".
 * Such a record, and the other appointments on the same Companies House officer record, rise to "likely" (a
 * source never sets "confirmed" by hand). Changes the findings in place; returns how many were lifted. The loop
 * calls it after it learns a company name or alias.
 */
export function retieHeldRecords(subject, findings) {
  let lifted = 0;
  const list = Array.isArray(findings) ? findings : [];
  const heldRegister = (f) => f && f.data?.heldOnName && f.match === 'possible' && (f.source === 'uk-companies-house' || f.source === 'fr-companies');
  const tiedOfficers = new Map();
  for (const f of list) {
    if (!heldRegister(f)) continue;
    const tie = knownCompanyFor(subject, f.data.registeredCompany);
    if (!tie) continue;
    f.match = 'likely';
    f.matchReasons = [`the register's company ${f.data.registeredCompany} is ${tie.alias ? `${tie.via}, a legal name of ${tie.company}` : tie.company}${tie.tie === 'exact' ? '' : ` (${tie.tie === 'branch' ? 'its country arm or holding' : 'an arm of the group'})`}`];
    f.matchFixed = true;
    lifted += 1;
    if (f.data.officerId) tiedOfficers.set(f.data.officerId, f.data.registeredCompany);
  }
  for (const f of list) {
    if (!heldRegister(f) || !f.data.officerId || !tiedOfficers.has(f.data.officerId)) continue;
    f.match = 'likely';
    f.matchReasons = [`same Companies House officer record as the appointment at ${tiedOfficers.get(f.data.officerId)}`];
    lifted += 1;
  }
  return lifted;
}

/* ------------------------------------------------------------------ UK Companies House */

const CH = 'https://find-and-update.company-information.service.gov.uk';
const CH_LABEL = 'UK Companies House';
const CH_TIMEOUT = 9000;
const MAX_OFFICER_PAGES = 5; // namesake officer records opened per person search
const MAX_APPOINTMENTS = 16; // appointment records reported per person search
const MAX_UNTIED_PER_OFFICER = 4;
const MAX_CO_DIRECTORS = 6;

const chPage = (path, deadline) => getText(`${CH}${path}`, { deadline, timeoutMs: CH_TIMEOUT, accept: 'text/html' });

/** Officer search results: name and link only. The "Born ..." line and the address are never read. */
export function parseOfficerSearch(html) {
  const $ = load(html);
  if (!$('#search-container, #services-information-results, .results-list, #no-results, #no-results-js').length) throw new Error('Companies House returned a page that could not be read');
  const out = [];
  $('li.type-officer').each((i, li) => {
    const a = $(li).find('h3 a').first();
    const href = a.attr('href') || '';
    if (!/^\/officers\/[A-Za-z0-9_-]+\/appointments$/.test(href)) return; // also skips the page's template rows
    out.push({ name: clean(a.text()), href });
  });
  return out;
}

/** An officer's appointments page: company, role, dates and company status for each appointment. */
export function parseAppointments(html) {
  const $ = load(html);
  if (!$('#officer-name').length) return null;
  const appointments = [];
  $('.appointments-list > div').each((i, div) => {
    const el = $(div);
    const heading = clean(el.find('[id^="company-name-"]').first().text());
    const href = el.find('[id^="company-name-"] a').attr('href') || '';
    const number = (href.match(/^\/company\/([A-Za-z0-9]+)/) || [])[1] || (heading.match(/\(([A-Z0-9]{6,10})\)\s*$/) || [])[1] || '';
    const company = heading.replace(/\s*\([A-Z0-9]{6,10}\)\s*$/, '');
    if (!company || !number) return;
    appointments.push({
      company,
      number,
      companyStatus: clean(el.find('[id^="company-status-value-"]').first().text()),
      role: clean(el.find('[id^="appointment-type-value"]').first().text()),
      appointed: clean(el.find('[id^="appointed-value"]').first().text()),
      resigned: clean(el.find('[id^="resigned-value"]').first().text()),
    });
  });
  const total = Number((clean($('#personal-appointments').text()).match(/(\d+)/) || [])[1]) || appointments.length;
  return { officerName: clean($('#officer-name').text()), total, appointments };
}

/** Company search results: name, number, the dates on the result line and any matching previous names. No address. */
export function parseCompanySearch(html) {
  const $ = load(html);
  if (!$('#search-container, #services-information-results, .results-list, #no-results, #no-results-js').length) throw new Error('Companies House returned a page that could not be read');
  const out = [];
  $('li.type-company').each((i, li) => {
    const el = $(li);
    const a = el.find('h3 a').first();
    const number = ((a.attr('href') || '').match(/^\/company\/([A-Za-z0-9]+)$/) || [])[1];
    if (!number) return;
    const inset = clean(el.find('p.inset').first().text());
    const meta = clean(el.find('p.meta').not('.inset').first().text());
    const parts = meta.split(' - ').map((p) => p.trim());
    const dated = (re) => { const hit = parts.find((p) => re.test(p)); return hit ? ukDate(hit.replace(re, '')) : null; };
    const hint = parts.slice(1).find((p) => !/\bon\s+\d/.test(p)) || '';
    out.push({
      name: clean(a.text()),
      number,
      incorporated: dated(/^(?:Incorporated|Registered|Formed|Converted\/Closed|Opened) on\s+/i),
      dissolved: dated(/^(?:Dissolved|Closed|Removed) on\s+/i),
      statusHint: hint,
      previousNames: /^Matching previous names:/i.test(inset) ? inset.replace(/^Matching previous names:\s*/i, '').split('·').map(clean).filter(Boolean) : [],
    });
  });
  return out;
}

/** A company's overview page: status, type, dates and previous names. The registered office is not read. */
export function parseCompanyPage(html) {
  const $ = load(html);
  if (!$('#company-number').length) return null;
  const previousNames = [];
  for (let n = 1; n <= 12; n += 1) {
    const name = clean($(`#previous-name-${n}`).text());
    if (!name) break;
    previousNames.push({ name, period: clean($(`#previous-date-${n}`).text()) });
  }
  // The filing blocks ("Accounts", "Confirmation statement") say OVERDUE when a filing is late
  const block = (heading) => clean($('h2').filter((i, h) => new RegExp(`^${heading}$`, 'i').test(clean($(h).text()))).first().parent().text());
  const accounts = block('Accounts');
  const confirmation = block('Confirmation statement');
  const lastAccounts = (accounts.match(/Last accounts made up to\s+(\d{1,2} [A-Za-z]+ \d{4})/i) || [])[1] || null;
  return {
    name: clean($('.company-header h1, p.heading-xlarge, #company-name').first().text()),
    number: (clean($('#company-number').text()).match(/([A-Z0-9]{6,10})\s*$/) || [])[1] || '',
    status: clean($('#company-status').text()),
    type: clean($('#company-type-value').text()) || clean($('#company-type').text()),
    incorporated: ukDate($('#company-creation-date').text()),
    dissolved: ukDate($('#cessation-date').text()),
    previousNames,
    // block text runs words of separate elements together ("OVERDUELast"), so no word boundary is asked for
    accountsOverdue: /overdue/i.test(accounts),
    confirmationOverdue: /overdue/i.test(confirmation),
    lastAccounts,
    // which further pages the register has for this company (it shows a tab only when there is something)
    tabs: { charges: $('#charges-tab').length > 0, insolvency: $('#insolvency-tab').length > 0 },
  };
}

/**
 * The register of persons with significant control: each owner's name, whether a person or a company, the
 * nature of control and the dates. Birth month and year, nationality, country of residence and addresses are
 * on the page and are never read (fields are picked by id).
 */
export function parsePscPage(html) {
  const $ = load(html);
  if (!$('#company-pscs, .appointments-list, #company-number').length) throw new Error('Companies House returned a page that could not be read');
  const owners = [];
  const statements = [];
  for (let n = 1; n <= 40; n += 1) {
    const statement = clean($(`#psc-statement-${n}`).text());
    if (statement && !/ceased/i.test(clean($(`#statement-status-tag-${n}`).text()))) statements.push(statement);
    const nameEl = $(`#psc-name-${n}`);
    if (!nameEl.length) continue;
    const raw = clean(nameEl.text());
    if (!raw) continue;
    const box = nameEl.closest(`.appointment-${n}`).length ? nameEl.closest(`.appointment-${n}`) : $(`.appointment-${n}`);
    const control = box.find('[id*="nature-of-control"], [id*="natures-of-control"]').toArray().map((el) => clean($(el).text())).filter((t) => t && t.length < 160);
    const name = dropTitles(raw.split(' '), 2).join(' ');
    owners.push({
      name,
      // a company or other legal entity is registered with a legal form; a person is listed with a title or plainly
      kind: new RegExp(`\\b(?:${LEGAL_FORMS}|corporation|incorporated|limited|trust|partnership|holdings?|group|fund|foundation|bank)\\b\\.?`, 'i').test(name) ? 'company' : 'person',
      control: [...new Set(control)],
      notified: clean($(`#psc-notified-on-${n}`).text()) || null,
      ceased: clean($(`#psc-ceased-on-${n}`).text()) || null,
    });
  }
  return { owners, statements };
}

/** Charges (secured lending): how many, how many still outstanding, and who holds them. */
export function parseChargesPage(html) {
  const $ = load(html);
  const head = clean($('#company-mortgages').text());
  if (!head && !$('#company-number').length) throw new Error('Companies House returned a page that could not be read');
  const total = Number((head.match(/(\d+)\s+charges?/i) || [])[1]) || 0;
  const breakdown = clean($('#company-mortgages-breakdown').text());
  const num = (re) => Number((breakdown.match(re) || [])[1]) || 0;
  const holders = $('[id*="persons-entitled"]').toArray().flatMap((el) => {
    const items = $(el).find('li').toArray().map((li) => clean($(li).text()));
    return items.length ? items : [clean($(el).text())];
  }).filter((t) => t && t.length < 120 && !/^persons entitled/i.test(t));
  return {
    total, outstanding: num(/(\d+)\s+outstanding/i), satisfied: num(/(\d+)\s+satisfied/i), partSatisfied: num(/(\d+)\s+part satisfied/i),
    holders: uniqueBy(holders, (h) => legalNorm(h)),
    summary: [head || `${total} charges registered`, breakdown].filter(Boolean).join(': '),
  };
}

const INSOLVENCY_TYPES = /(creditors[’']? voluntary liquidation|members[’']? voluntary liquidation|compulsory liquidation|administration order|in administration|administrative receiver(?:ship)?|receivership|receiver manager|company voluntary arrangement|moratorium|winding[- ]up order|scheme of arrangement|restructuring plan)/gi;
/** Insolvency cases: how many and of what kind. Practitioners' names and addresses are not read. */
export function parseInsolvencyPage(html) {
  const $ = load(html);
  const text = clean($('.govuk-tabs__panel, #content-container, main').first().text());
  if (!text) throw new Error('Companies House returned a page that could not be read');
  const cases = new Set((text.match(/Case number\s+(\d+)/gi) || []).map((m) => m.replace(/\D/g, ''))).size;
  const types = [...new Set((text.match(INSOLVENCY_TYPES) || []).map((t) => t.toLowerCase()))];
  return { cases: cases || (types.length ? 1 : 0), types };
}

const CORPORATE_OFFICER = new RegExp(`\\b(?:${LEGAL_FORMS}|secretaries|nominees|services|trustees?|partnership|group|holdings|gmbh|s\\.a|verein)\\b\\.?$`, 'i');

/** A company's officers page: name, role, status and dates. Birth, nationality, occupation and address are not read. */
export function parseCompanyOfficers(html) {
  const $ = load(html);
  if (!$('#company-appointments, .appointments-list, #company-number').length) return null;
  const officers = [];
  for (let n = 1; n <= 60; n += 1) {
    const el = $(`#officer-name-${n}`);
    if (!el.length) break;
    const name = clean(el.text());
    if (!name) continue;
    // Companies House prints a date-of-birth line for people only; its presence (never its content) marks a person.
    const person = $(`#officer-date-of-birth-${n}, #officer-date-of-birth-field-${n}`).length > 0 || (name.includes(',') && !CORPORATE_OFFICER.test(name));
    officers.push({
      name,
      person,
      role: clean($(`#officer-role-${n}`).text()),
      status: clean($(`#officer-status-tag-${n}`).text()) || 'Active',
      appointed: clean($(`#officer-appointed-on-${n}`).text()),
      resigned: clean($(`#officer-resigned-on-${n}`).text()),
    });
  }
  return {
    name: clean($('.company-header h1, p.heading-xlarge, #company-name').first().text()),
    summary: clean($('#company-appointments').text()),
    officers,
  };
}

/** Disqualified-director search results: name and link only. */
export function parseDisqualifiedSearch(html) {
  const $ = load(html);
  if (!$('#search-container, #services-information-results, .results-list, #no-results, #no-results-js').length) throw new Error('Companies House returned a page that could not be read');
  const out = [];
  $('li.type-disqualification, li.type-disqualified-officer').each((i, li) => {
    const a = $(li).find('h3 a').first();
    const href = a.attr('href') || '';
    if (!/^\/disqualified-officers\/(?:natural|corporate)\/[A-Za-z0-9_-]+$/.test(href)) return;
    out.push({ name: clean(a.text()), href });
  });
  return out;
}

const DISQUALIFICATION_FIELDS = { 'start date': 'start', 'end date': 'end', 'case reference': 'caseReference', court: 'court', reason: 'reason' };

/** A disqualified director's page: each order or undertaking. Date of birth, nationality and address are not read. */
export function parseDisqualification(html) {
  const $ = load(html);
  const name = clean($('#content-container h1, main h1').first().text());
  if (!name) return null;
  const items = [];
  $('.disqualification').each((i, div) => {
    const el = $(div);
    const heading = clean(el.find('h3').first().text());
    const item = { kind: heading.replace(/\s*\(.*$/, '') || 'Disqualification', decided: ukDate((heading.match(/\(([^)]+)\)/) || [])[1] || ''), companies: [] };
    el.find('dt').each((k, dt) => {
      const label = clean($(dt).text()).toLowerCase();
      const dd = $(dt).next('dd');
      if (/^disqualified for conduct/.test(label)) {
        dd.find('li').each((x, li) => { const company = clean($(li).text()); if (company) item.companies.push(company); });
        if (!item.companies.length && clean(dd.text())) item.companies.push(clean(dd.text()));
        return;
      }
      const key = DISQUALIFICATION_FIELDS[label];
      if (key) item[key] = clean(dd.text()); // any other label (birth, nationality, address) is skipped
    });
    if (item.start || item.end || item.reason) items.push(item);
  });
  return { name, items };
}

const lower = (s) => clean(s).toLowerCase();
const statusPhrase = (status) => (status ? `, ${GONE.test(status) || DISTRESSED.test(status) ? status.toUpperCase() : lower(status)}` : '');

/** One record for a person's appointments at one UK company (several roles there are listed together). */
function ukAppointmentFinding(subject, registeredName, group, context = '', { officerId = '', sameRecord = null } = {}) {
  const [first] = group;
  const status = first.companyStatus || '';
  const term = (a) => `appointed ${a.appointed || 'on an unstated date'}${a.resigned ? `, resigned ${a.resigned}` : ''}`;
  const title = `${subject.name}: ${lower(first.role) || 'officer'} of ${first.company} (UK company${statusPhrase(status)}), ${term(first)}${group.length > 1 ? ` (and ${plural(group.length - 1, 'more appointment', 'more appointments')} there)` : ''}`;
  const quote = group.map((a) => `${registeredName} — ${a.role || 'Officer'} — ${a.company} (${a.number})${a.companyStatus ? ` — Company status: ${a.companyStatus}` : ''} — Appointed on ${a.appointed || 'not stated'}${a.resigned ? ` — Resigned on ${a.resigned}` : ''}`).join(' | ');
  return personAtCompany(subject, first.company, {
    source: 'uk-companies-house',
    sourceLabel: CH_LABEL,
    category: 'corporate',
    title,
    quote,
    url: `${CH}/company/${first.number}/officers`,
    date: ukDate(first.appointed),
    severity: /director|member|partner/i.test(first.role) ? roleSeverity(status) : 'info',
    data: {
      company: first.company, companyNumber: first.number, companyStatus: status || null,
      appointments: group.map((a) => ({ role: a.role, appointed: ukDate(a.appointed), resigned: ukDate(a.resigned) })),
      ...(officerId ? { officerId } : {}),
    },
  }, context, sameRecord);
}

/** Whether a Companies House search page links to a further page of results. */
export function searchHasMorePages(html) {
  const $ = load(html);
  return $('a[href*="page="]').toArray().some((a) => {
    const href = $(a).attr('href') || '';
    const rel = String($(a).attr('rel') || '').toLowerCase();
    const label = clean($(a).text()).toLowerCase();
    // Only the "Next" link counts: the numbered links are there on the last page too
    return /[?&]page=\d+/.test(href) && (rel === 'next' || $(a).attr('id') === 'next-page' || /^next\b/.test(label));
  });
}

const MAX_SEARCH_PAGES = 3; // pages of officer search results read for one name

async function ukOfficersByName(ctx) {
  const { subject, deadline } = ctx;
  const mine = nameTokens(subject.name);
  const notes = [];
  const partial = [];
  // The search is fuzzy and returns 20 rows a page: for a common name the person's own record can be on page 2.
  const firstHtml = await chPage(`/search/officers?q=${encodeURIComponent(subject.name)}`, deadline);
  const rows = parseOfficerSearch(firstHtml);
  let more = searchHasMorePages(firstHtml);
  let read = 1;
  while (more && read < MAX_SEARCH_PAGES) {
    let html;
    try { html = await chPage(`/search/officers?q=${encodeURIComponent(subject.name)}&page=${read + 1}`, deadline); } catch { break; }
    rows.push(...parseOfficerSearch(html));
    more = searchHasMorePages(html);
    read += 1;
  }
  if (more) {
    notes.push(`Companies House has more than ${read} pages of officer results for ${subject.name}; only the first ${read} were read, so an appointment under this name may be missing.`);
    partial.push('Companies House officer search (first pages only)');
  }
  const namesakes = uniqueBy(rows.filter((r) => sameName(registryTokens(r.name), mine)), (r) => r.href);
  if (!namesakes.length) return partial.length ? { findings: [], threads: [], notes, partial } : { findings: [], threads: [], notes };
  const opened = namesakes.slice(0, MAX_OFFICER_PAGES);
  const pages = await mapLimit(opened, 3, async (o) => parseAppointments(await chPage(o.href, deadline)));
  if (pages.every((p) => !p)) throw new Error('Companies House officer records could not be opened');
  // A page that failed must not read as "no appointments": say how many were not read
  const failed = pages.filter((p) => !p).length;
  if (failed) {
    notes.push(`${plural(failed, 'Companies House officer record', 'Companies House officer records')} under the name ${subject.name} could not be opened, so ${failed === 1 ? 'its' : 'their'} appointments are not listed.`);
    partial.push('Companies House officer records');
  }

  const candidates = [];
  pages.forEach((page, i) => {
    if (!page) return;
    const officerId = (opened[i].href.match(/^\/officers\/([A-Za-z0-9_-]+)\//) || [])[1] || '';
    const byCompany = new Map();
    for (const a of page.appointments) byCompany.set(a.number, [...(byCompany.get(a.number) || []), a]);
    // Companies House files one person's appointments under one officer record: when one of them is at a known
    // company of the subject, the others on the same record are that person's too ("likely", never more).
    const anchorAppointment = [...byCompany.values()].find((g) => knownCompanyFor(subject, g[0].company));
    let untied = 0;
    for (const group of byCompany.values()) {
      const tied = resemblesKnown(subject, group[0].company) || Boolean(anchorAppointment); // ordering only
      if (!tied) { untied += 1; if (untied > MAX_UNTIED_PER_OFFICER) continue; }
      const sameRecord = anchorAppointment && anchorAppointment !== group ? `same Companies House officer record as the appointment at ${anchorAppointment[0].company}` : null;
      candidates.push({ group, tied, registeredName: page.officerName || opened[i].name, officerId, sameRecord });
    }
  });
  // Records at a known company first, then companies that are gone, then the rest
  const weight = (c) => (c.tied ? 0 : GONE.test(c.group[0].companyStatus) || DISTRESSED.test(c.group[0].companyStatus) ? 1 : 2);
  candidates.sort((a, b) => weight(a) - weight(b));

  const findings = [];
  const threads = [];
  const seen = new Set();
  for (const c of candidates) {
    if (findings.length >= MAX_APPOINTMENTS) break;
    const number = c.group[0].number;
    if (seen.has(number)) continue;
    const finding = ukAppointmentFinding(subject, c.registeredName, c.group, '', { officerId: c.officerId, sameRecord: c.sameRecord });
    if (!finding) continue;
    seen.add(number);
    findings.push(finding);
    threads.push(makeThread('company', withoutLegalForm(c.group[0].company), `UK ${lower(c.group[0].role) || 'officer'} appointment (Companies House)`, { trusted: finding.match !== 'possible' }));
  }
  if (namesakes.length > opened.length) notes.push(`Companies House lists ${namesakes.length} officer records under the name ${subject.name} in the results read; the first ${opened.length} were opened.`);
  return partial.length ? { findings, threads, notes, partial } : { findings, threads, notes };
}

async function ukDisqualifications(ctx) {
  const { subject, deadline } = ctx;
  const mine = nameTokens(subject.name);
  const rows = parseDisqualifiedSearch(await chPage(`/search/disqualified-officers?q=${encodeURIComponent(subject.name)}`, deadline));
  const namesakes = rows.filter((r) => sameName(registryTokens(r.name), mine)).slice(0, 2);
  if (!namesakes.length) return { findings: [], threads: [], notes: [] };
  const pages = await mapLimit(namesakes, 2, async (o) => parseDisqualification(await chPage(o.href, deadline)));
  if (pages.every((p) => !p)) throw new Error('Companies House disqualification records could not be opened');
  const findings = [];
  const threads = [];
  pages.forEach((page, i) => {
    if (!page || !page.items.length) return;
    const [first] = page.items;
    const companies = uniqueBy(page.items.flatMap((x) => x.companies), (c) => legalNorm(c));
    const tied = companies.find((c) => knownCompanyFor(subject, c));
    const period = first.start && first.end ? `from ${first.start} to ${first.end}` : first.start ? `from ${first.start}` : first.end ? `until ${first.end}` : '';
    const finding = personAtCompany(subject, tied || companies.join('; '), {
      source: 'uk-companies-house',
      sourceLabel: CH_LABEL,
      category: 'regulatory',
      title: `${subject.name}: disqualified from acting as a UK company director ${period} (${lower(first.kind)})${page.items.length > 1 ? ` and ${plural(page.items.length - 1, 'more disqualification', 'more disqualifications')}` : ''}`.replace(/\s+/g, ' '),
      quote: page.items.map((x) => [
        `${page.name} — ${x.kind}${x.decided ? ` (${longDate(x.decided)})` : ''}`,
        x.start ? `Start date: ${x.start}` : '', x.end ? `End date: ${x.end}` : '',
        x.caseReference ? `Case reference: ${x.caseReference}` : '', x.court ? `Court: ${x.court}` : '',
        x.companies.length ? `Disqualified for conduct while acting for: ${x.companies.join('; ')}` : '',
        x.reason ? `Reason: ${x.reason}` : '',
      ].filter(Boolean).join(' — ')).join(' | '),
      url: `${CH}${namesakes[i].href}`,
      date: ukDate(first.start) || first.decided,
      severity: 'high',
      data: { disqualifications: page.items.map((x) => ({ kind: x.kind, start: ukDate(x.start), end: ukDate(x.end), caseReference: x.caseReference || null, court: x.court || null, companies: x.companies, reason: x.reason || null })) },
    });
    if (!finding) return;
    findings.push(finding);
    for (const company of companies.slice(0, 6)) threads.push(makeThread('company', withoutLegalForm(company), 'named in a UK director disqualification', { trusted: finding.match !== 'possible' }));
  });
  return { findings, threads, notes: [] };
}

/** Who among a company's officers ties it to the subject: the subject, or a person already known to be their associate. */
function officerTie(subject, people) {
  const mine = nameTokens(subject.name);
  const self = people.filter((p) => sameName(p.tokens, mine));
  let associate = null;
  for (const anchor of subject.anchors?.people?.values?.() || []) {
    associate = people.find((p) => !sameName(p.tokens, mine) && (anchor.test(p.display) || anchor.test(p.short))) || null;
    if (associate) break;
  }
  // `associate` is kept even when the subject is listed: a company whose name only starts with a known one needs it
  if (self.length) return { via: 'officer', self, associate, reason: `${subject.name} is listed among its officers${associate ? `, as is ${associate.short}, a known associate` : ''}` };
  if (associate) return { via: 'associate', self: [], associate, reason: `${associate.short}, a known associate, is listed among its officers` };
  return null;
}

/** Read one extra page of a tied company; a page that fails is noted, never taken for "nothing there". */
async function companyExtra(path, parse, deadline, missing, what) {
  try {
    return parse(await chPage(path, deadline));
  } catch (error) {
    if (error?.status === 404) return null; // the register has no such page for this company
    missing.push(what);
    return null;
  }
}

/** The register's own facts about a tied company beyond its officers: owners, charges, insolvency. */
async function ukCompanyExtras(c, info, deadline) {
  const missing = [];
  const owners = await companyExtra(`/company/${c.number}/persons-with-significant-control`, parsePscPage, deadline, missing, 'persons with significant control');
  const charges = info?.tabs?.charges ? await companyExtra(`/company/${c.number}/charges`, parseChargesPage, deadline, missing, 'charges') : null;
  const insolvency = info?.tabs?.insolvency ? await companyExtra(`/company/${c.number}/insolvency`, parseInsolvencyPage, deadline, missing, 'insolvency') : null;
  return { owners, charges, insolvency, missing };
}

const pscLine = (p) => `${p.name}${p.control.length ? ` (${p.control.slice(0, 3).join('; ')})` : ''}${p.ceased ? `, ceased ${p.ceased}` : p.notified ? `, notified ${p.notified}` : ''}`;

async function ukCompany(task, ctx) {
  const { subject, deadline } = ctx;
  const wanted = withoutLegalForm(task.value);
  if (legalNorm(task.value).length < 2) return { findings: [], threads: [], notes: [] };
  const rows = parseCompanySearch(await chPage(`/search/companies?q=${encodeURIComponent(wanted)}`, deadline));
  // A known company's own arm, or a legal name learned for it, comes right after the exact name
  const rank = { exact: 0, known: 1, former: 2, prefix: 3 };
  const candidates = rows.map((row) => {
    const tie = nameTie(task.value, row.name);
    const former = row.previousNames.find((p) => nameTie(task.value, p) === 'exact');
    const kind = tie === 'exact' ? 'exact' : former ? 'former' : tie === 'prefix' && knownCompanyFor(subject, row.name) ? 'known' : tie;
    return { ...row, kind, former: former || null };
  }).filter((c) => c.kind).sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 3);
  if (!candidates.length) return { findings: [], threads: [], notes: [] };

  const pages = await mapLimit(candidates, 3, async (c) => parseCompanyOfficers(await chPage(`/company/${c.number}/officers`, deadline)));
  if (pages.every((p) => !p)) throw new Error('Companies House officer lists could not be opened');
  const notes = [];
  const partial = [];
  // An officer list that could not be opened is not "no officer matches": say which company was not read
  const unread = candidates.filter((c, i) => !pages[i]);
  if (unread.length) {
    notes.push(`The Companies House officer list of ${unread.map((c) => `${c.name} (${c.number})`).join(' and ')} could not be opened, so ${unread.length === 1 ? 'that company was' : 'those companies were'} not checked for the person.`);
    partial.push(...unread.map((c) => `Companies House: ${c.name}`));
  }

  const judged = candidates.map((c, i) => {
    const page = pages[i];
    const people = (page?.officers || []).filter((o) => o.person).map((o) => ({ ...o, tokens: registryTokens(o.name), display: displayPerson(o.name), short: shortPerson(o.name) }));
    const found = page ? officerTie(subject, people) : null;
    // A name that only starts with the wanted one is tied through a known associate on its board, never
    // through an officer who merely shares the subject's name: that is how a namesake's company slips in
    // (a known company's own country arm, "Mistral AI UK Ltd", is tied by the subject's seat like the company itself)
    const prefixed = c.kind === 'prefix' || c.kind === 'known';
    const tie = found && (!prefixed || found.associate || (found.self.length && knownCompanyFor(subject, c.name))) ? found : null;
    const namesake = found && !tie ? found : null;
    return { ...c, page, people, tie, namesake, nameOnly: !found && !prefixed };
  }).filter((c) => c.page && (c.tie || c.namesake || c.nameOnly));
  // The register's own tie first; a bare name match last
  judged.sort((a, b) => Number(Boolean(b.tie)) - Number(Boolean(a.tie)));
  // With no officer tie, a company the person is only affiliated with adds nothing, and a one-word name is
  // too common to show: say so in a note instead of a record. An officer sharing the person's name is kept
  // (held at possible) for a company the person runs: it is something for the reader to check
  const shown = judged.filter((c) => c.tie || (!isAffiliate(task) && (c.namesake || distinctiveMatch(task.value, [c.name, c.former].filter(Boolean)))));
  if (shown.length < judged.length && !judged.some((c) => c.tie)) notes.push(untiedNote('UK', wanted, task));
  const kept = shown.slice(0, 2);
  const done = () => (partial.length ? { findings, threads, notes, partial } : { findings, threads, notes });
  const findings = [];
  const threads = [];
  if (!kept.length) return done();

  // The overview of every company shown (its status and filing flags), and for a company the register ties to
  // the person, its owners, charges and insolvency cases.
  const details = await mapLimit(kept, 2, async (c) => parseCompanyPage(await chPage(`/company/${c.number}`, deadline)));
  const extras = await mapLimit(kept, 2, async (c, i) => (c.tie ? ukCompanyExtras(c, details[i], deadline) : null));
  // The company the task is about, as the check knows it ("Ramp" for a task on "Ramp Business Corp")
  const knownForTask = knownCompanyFor(subject, task.value)?.company || null;

  kept.forEach((c, i) => {
    const info = details[i] || null;
    const extra = extras[i] || null;
    const status = info?.status || (c.dissolved ? 'Dissolved' : c.statusHint || '');
    const incorporated = info?.incorporated || c.incorporated;
    const dissolved = info?.dissolved || c.dissolved;
    const previous = info?.previousNames?.length ? info.previousNames.map((p) => `${p.name}${p.period ? ` (${p.period})` : ''}`) : c.previousNames;
    const officers = (c.page.officers || []).map((o) => ({ name: displayPerson(o.name), role: o.role, status: o.status, appointed: ukDate(o.appointed), resigned: ukDate(o.resigned) }));
    const officerLine = (o) => `${o.name} (${o.role || 'Officer'}, ${o.resigned ? `${o.appointed} to ${o.resigned}` : `appointed ${o.appointed || 'date not stated'}`})`;
    const gone = GONE.test(status) || DISTRESSED.test(status);
    const overdue = [info?.accountsOverdue ? 'accounts overdue' : '', info?.confirmationOverdue ? 'confirmation statement overdue' : ''].filter(Boolean);
    const cases = extra?.insolvency?.cases || 0;
    const facts = [
      status ? (gone ? `${status.toUpperCase()}${dissolved ? ` on ${longDate(dissolved)}` : ''}` : lower(status)) : '',
      incorporated ? `incorporated ${longDate(incorporated)}` : '',
      ...(c.tie ? overdue.map((o) => o.toUpperCase()) : []),
      c.tie && cases ? `${plural(cases, 'INSOLVENCY CASE', 'INSOLVENCY CASES')}` : '',
    ].filter(Boolean).join(', ');
    const title = c.tie
      ? `UK company record: ${c.name}${facts ? `, ${facts}` : ''}`
      : c.namesake
        ? `UK company whose name begins with ${wanted}: ${c.name}${facts ? `, ${facts}` : ''} (an officer shares the name ${subject.name}; nothing else ties it to them)`
        : `UK company with the same name as ${wanted}: ${c.name}${facts ? `, ${facts}` : ''} (no listed officer matches the person)`;
    const untiedReason = c.namesake
      ? `name begins with ${wanted} and an officer shares the name ${subject.name}; no known associate is on its board, so it may be another person's company`
      : `same name as ${wanted}; no listed officer matches the person`;
    const owners = extra?.owners?.owners || [];
    const charges = extra?.charges || null;
    const severityOf = () => {
      if (!c.tie) return companySeverity(status);
      if (cases || DISTRESSED.test(status)) return 'medium';
      if (overdue.length) return companySeverity(status) === 'info' ? 'low' : companySeverity(status);
      return companySeverity(status);
    };
    const finding = makeFinding(subject, {
      source: 'uk-companies-house',
      sourceLabel: CH_LABEL,
      category: 'corporate',
      title,
      quote: [
        `${c.name} — Company number ${c.number}`,
        status ? `Company status: ${status}` : '',
        info?.type || '',
        incorporated ? `Incorporated on ${longDate(incorporated)}` : '',
        dissolved ? `Dissolved on ${longDate(dissolved)}` : '',
        previous.length ? `Previous company names: ${previous.join('; ')}` : '',
        info?.lastAccounts ? `Last accounts made up to ${info.lastAccounts}` : '',
        c.tie && overdue.length ? `The register shows: ${overdue.join(', ')}` : '',
        c.page.summary || '',
        (c.page.officers || []).slice(0, 12).map(officerLine).join('; '),
        owners.length ? `Persons with significant control: ${owners.slice(0, 5).map(pscLine).join('; ')}` : '',
        extra?.owners?.statements?.length ? `Statement on control: ${extra.owners.statements[0]}` : '',
        charges ? `Charges: ${charges.summary}${charges.holders.length ? `; held by ${charges.holders.slice(0, 4).join(', ')}` : ''}` : '',
        cases ? `Insolvency: ${plural(cases, 'case', 'cases')}${extra.insolvency.types.length ? ` (${extra.insolvency.types.join('; ')})` : ''}` : '',
        extra?.missing?.length ? `Not read: ${extra.missing.join(', ')}` : '',
      ].filter(Boolean).join(' — '),
      url: `${CH}/company/${c.number}`,
      date: incorporated,
      severity: severityOf(),
      match: c.tie ? 'company' : 'possible',
      matchReasons: [c.tie ? c.tie.reason : untiedReason],
      data: {
        companyNumber: c.number, status: status || null, type: info?.type || null, incorporated: incorporated || null, dissolved: dissolved || null,
        previousNames: previous, officers: officers.slice(0, 40), ...(c.kind === 'former' ? { formerName: c.former } : {}),
        ...(c.tie ? {
          accountsOverdue: Boolean(info?.accountsOverdue), confirmationStatementOverdue: Boolean(info?.confirmationOverdue), lastAccounts: info?.lastAccounts || null,
          owners: owners.slice(0, 10).map((p) => ({ name: p.name, kind: p.kind, control: p.control, notified: ukDate(p.notified), ceased: ukDate(p.ceased) })),
          charges: charges ? { total: charges.total, outstanding: charges.outstanding, satisfied: charges.satisfied, partSatisfied: charges.partSatisfied, holders: charges.holders.slice(0, 8) } : null,
          insolvencyCases: cases, insolvencyTypes: extra?.insolvency?.types || [],
          notRead: extra?.missing || [],
        } : {}),
      },
    });
    if (finding) findings.push(c.tie ? finding : untiedRecord(finding));
    if (extra?.missing?.length) partial.push(...extra.missing.map((m) => `Companies House ${m}: ${c.name}`));
    if (!c.tie) return;

    // A register entry tied to the person (their own seat, or a known associate's) gives a fuller legal name of
    // the company: the check then searches and matches by it too. So does a corporate owner whose name starts
    // with the company's ("Ramp Business Corporation" owning RAMP BUSINESS UK LTD).
    if (finding && knownForTask) {
      addCompanyAlias(subject, { company: knownForTask, alias: c.name, origin: finding.id });
      for (const o of owners.filter((p) => p.kind === 'company')) {
        if (nameTie(knownForTask, o.name) || knownCompanyFor(subject, o.name)) addCompanyAlias(subject, { company: knownForTask, alias: o.name, origin: finding.id });
      }
    }

    // The subject's own seat on this board: the company is one the check already ties to them
    if (c.tie.self.length) {
      const group = c.tie.self.map((o) => ({ company: c.name, number: c.number, companyStatus: status, role: o.role, appointed: o.appointed, resigned: o.resigned }));
      group.sort((a, b) => Number(Boolean(a.resigned)) - Number(Boolean(b.resigned)));
      const seat = ukAppointmentFinding(subject, c.tie.self[0].display, group, task.value);
      if (seat) findings.push(seat);
    }
    if (nameTie(task.value, c.name) !== 'exact') threads.push(makeThread('company', withoutLegalForm(c.name), `UK company registered under a name starting with ${wanted}`, { trusted: true }));
    const mine = nameTokens(subject.name);
    const coDirectors = uniqueBy(
      c.people.filter((p) => /director|member|partner/i.test(p.role) && !sameName(p.tokens, mine)).sort((a, b) => Number(Boolean(a.resigned)) - Number(Boolean(b.resigned))),
      (p) => fold(p.short),
    ).slice(0, MAX_CO_DIRECTORS);
    for (const p of coDirectors) threads.push(makeThread('associate', p.short, `${p.resigned ? 'former ' : ''}${lower(p.role)} of ${c.name} (UK Companies House)`, { trusted: true }));
    // Owners: a person who controls the company is an associate; a company that owns it is a company to look into
    for (const p of owners.filter((x) => !x.ceased).slice(0, 4)) {
      if (p.kind === 'person' && !subject.hasName(p.name)) threads.push(makeThread('associate', p.name, `person with significant control of ${c.name} (UK Companies House)`, { trusted: true }));
      if (p.kind === 'company' && !knownCompanyFor(subject, p.name)) threads.push(makeThread('company', withoutLegalForm(p.name), `owner of ${c.name} (UK register of persons with significant control)`, { trusted: true }));
    }
  });
  return done();
}

export const ukCompaniesConnector = {
  id: 'uk-companies-house',
  label: 'UK Companies House (company records, officers, disqualified directors)',
  kinds: ['subject', 'company'],
  prior: 0.5,
  timeoutMs: 20000,
  enabled: () => !switchedOff('uk-companies-house'),
  unavailableReason: OFF_REASON,
  plan(thread) {
    if (thread.kind === 'subject') {
      return [
        { template: 'uk.officers', prior: 0.5, why: 'UK company appointments under this name' },
        { template: 'uk.disqualified', prior: 0.35, why: 'UK register of disqualified directors' },
      ];
    }
    return [{ template: 'uk.company', prior: 0.5 }];
  },
  async run(task, ctx) {
    if (task.kind === 'company') return ukCompany(task, ctx);
    if (task.kind !== 'subject') return { findings: [], threads: [], notes: [] };
    if (nameTokens(ctx.subject.name).length < 2) return { findings: [], threads: [], notes: [] };
    if (task.template === 'uk.officers') return ukOfficersByName(ctx);
    if (task.template === 'uk.disqualified') return ukDisqualifications(ctx);
    // No query pattern named: do both
    const [officers, disqualified] = await Promise.allSettled([ukOfficersByName(ctx), ukDisqualifications(ctx)]);
    if (officers.status === 'rejected' && disqualified.status === 'rejected') throw officers.reason;
    const parts = [officers, disqualified].filter((r) => r.status === 'fulfilled').map((r) => r.value);
    return { findings: parts.flatMap((p) => p.findings), threads: parts.flatMap((p) => p.threads), notes: parts.flatMap((p) => p.notes) };
  },
};

/* ------------------------------------------------------------------ France */

const FR_SEARCH = 'https://recherche-entreprises.api.gouv.fr/search';
const FR_PAGE = 'https://annuaire-entreprises.data.gouv.fr';
const FR_LABEL = 'French company register (Annuaire des Entreprises)';
const MAX_FR_COMPANIES = 12;

const FR_ROLES = [
  [/^pr[ée]sident de sas/i, 'president'],
  [/^pr[ée]sident du conseil d'administration/i, 'chair of the board'],
  [/^pr[ée]sident/i, 'president'],
  [/^directeur g[ée]n[ée]ral d[ée]l[ée]gu[ée]/i, 'deputy chief executive'],
  [/^directeur g[ée]n[ée]ral/i, 'chief executive (directeur général)'],
  [/^g[ée]rant/i, 'manager (gérant)'],
  [/^administrateur/i, 'board member'],
  [/^membre du (?:conseil de surveillance|directoire)/i, 'board member'],
  [/^associ[ée]/i, 'partner'],
  [/^liquidateur/i, 'liquidator'],
];
const frRole = (qualite) => { const hit = FR_ROLES.find(([re]) => re.test(clean(qualite))); return hit ? hit[1] : lower(qualite) || 'officer'; };
const FR_FORMS = { 5710: 'SAS', 5720: 'SASU', 5499: 'SARL', 5498: 'SARL with one member', 5599: 'SA', 5699: 'SA', 6540: 'SCI', 5202: 'SNC', 9220: 'association' };
const AUDITOR = /commissaire aux comptes/i;
const SURNAME_PARTICLES = new Set(['de', 'du', 'des', 'le', 'la', 'van', 'von', 'der', 'den', 'di', 'da', 'del', 'della', 'bin', 'ben', 'al', 'el', 'st', 'saint']);

/** First given name and surname for the officer search ("Xavier de Villepin" -> "Xavier", "de Villepin"). */
function splitPersonName(name) {
  const words = clean(name).split(' ').filter((w) => !/^[A-Za-z]\.?$/.test(w));
  if (words.length < 2) return null;
  let at = words.length - 1;
  while (at > 1 && SURNAME_PARTICLES.has(words[at - 1].toLowerCase())) at -= 1;
  return { first: words[0], last: words.slice(at).join(' ') };
}

/** The officers of one French company. Birth month, birth year and nationality are never read. */
function frOfficers(result) {
  const people = [];
  const firms = [];
  for (const d of Array.isArray(result?.dirigeants) ? result.dirigeants : []) {
    const role = clean(d?.qualite);
    if (d?.type_dirigeant === 'personne morale' || d?.denomination) { if (d?.denomination) firms.push({ name: clean(d.denomination), role }); continue; }
    const nom = clean(d?.nom);
    const prenoms = clean(d?.prenoms);
    if (!nom || !prenoms) continue;
    const registered = `${nom}, ${prenoms}`;
    people.push({ key: fold(registered), tokens: registryTokens(registered), display: displayPerson(registered), short: shortPerson(registered), role, auditor: AUDITOR.test(role) });
  }
  return { people, firms };
}

/** One French company, entity fields only (the head-office address is not read). */
function frCompany(result) {
  const siren = String(result?.siren || '').replace(/\D/g, '');
  const name = clean(result?.nom_raison_sociale) || clean(result?.nom_complet);
  if (!/^\d{9}$/.test(siren) || !name) return null;
  const soleTrader = /^1/.test(String(result?.nature_juridique || '')) || !result?.nom_raison_sociale;
  const restricted = result?.statut_diffusion && result.statut_diffusion !== 'O';
  if (soleTrader || restricted) return null; // a person's own business, or one whose details the register does not publish
  const ceased = result?.etat_administratif === 'C';
  return {
    siren, name,
    names: [name, clean(result?.nom_complet), clean(result?.sigle)].filter(Boolean),
    created: isoDay(result?.date_creation), closed: isoDay(result?.date_fermeture),
    status: ceased ? 'ceased' : result?.etat_administratif === 'A' ? 'active' : '',
    form: FR_FORMS[String(result?.nature_juridique || '')] || '',
    size: clean(result?.categorie_entreprise),
    ...frOfficers(result),
  };
}

const frStatus = (c) => (c.status === 'ceased' ? `CEASED${c.closed ? ` on ${longDate(c.closed)}` : ''}` : c.status);
const frFacts = (c) => [`${c.name} — SIREN ${c.siren}`, c.form ? `Legal form: ${c.form}` : '', c.status ? `Status: ${c.status}` : '', c.created ? `Created on ${longDate(c.created)}` : '', c.closed ? `Closed on ${longDate(c.closed)}` : ''].filter(Boolean);
const frOfficerList = (c) => [...c.people.filter((p) => !p.auditor).map((p) => `${p.display} (${p.role})`), ...c.firms.filter((f) => !AUDITOR.test(f.role)).map((f) => `${f.name} (${f.role})`)].slice(0, 10).join('; ');

function frRoleFinding(subject, c, self, context = '', sharedWith = null) {
  const role = frRole(self.role);
  return personAtCompany(subject, c.name, {
    source: 'fr-companies',
    sourceLabel: FR_LABEL,
    category: 'corporate',
    title: `${subject.name}: ${role} of ${c.name} (French company${c.status ? `, ${frStatus(c)}` : ''})${c.created ? `, company created ${longDate(c.created)}` : ''}`,
    quote: [
      ...frFacts(c),
      `${self.display} — ${self.role}`,
      frOfficerList(c) ? `Officers: ${frOfficerList(c)}` : '',
      sharedWith ? `Shares officers with ${sharedWith.company}: ${sharedWith.people.join(', ')}` : '',
    ].filter(Boolean).join(' — '),
    url: `${FR_PAGE}/dirigeants/${c.siren}`,
    date: c.created,
    severity: c.status === 'ceased' ? 'low' : 'info',
    data: { company: c.name, siren: c.siren, role: self.role, status: c.status || null, created: c.created, closed: c.closed },
  }, context);
}

async function frByPerson(ctx) {
  const { subject, deadline } = ctx;
  const who = splitPersonName(subject.name);
  if (!who) return { findings: [], threads: [], notes: [] };
  const qs = new URLSearchParams({ nom_personne: who.last, prenoms_personne: who.first, type_personne: 'dirigeant', per_page: '25' });
  const data = await getJson(`${FR_SEARCH}?${qs}`, { deadline, timeoutMs: 9000 });
  if (!Array.isArray(data?.results)) throw new Error('Unexpected answer from the French company register');
  const mine = nameTokens(subject.name);
  const rows = [];
  for (const result of data.results) {
    const c = frCompany(result);
    if (!c) continue;
    const self = c.people.find((p) => !p.auditor && sameName(p.tokens, mine));
    if (self) rows.push({ c, self, known: knownCompanyFor(subject, c.name) });
  }
  // Companies run with the same people as a known company of the subject are the same person's
  const anchors = rows.filter((r) => r.known);
  for (const row of rows) {
    if (row.known) continue;
    for (const anchor of anchors) {
      const shared = row.c.people.filter((p) => !p.auditor && p.key !== row.self.key && anchor.c.people.some((q) => !q.auditor && q.key === p.key));
      if (shared.length) { row.sharedWith = { company: anchor.c.name, known: anchor.known.company, people: shared.map((p) => p.display).slice(0, 4) }; break; }
    }
  }
  const weight = (r) => (r.known ? 0 : r.sharedWith ? 1 : r.c.status === 'ceased' ? 2 : 3);
  rows.sort((a, b) => weight(a) - weight(b));
  const findings = [];
  const threads = [];
  for (const row of rows.slice(0, MAX_FR_COMPANIES)) {
    const context = row.sharedWith ? `${row.sharedWith.known} ${row.sharedWith.company}` : '';
    const finding = frRoleFinding(subject, row.c, row.self, context, row.sharedWith || null);
    if (!finding) continue;
    findings.push(finding);
    threads.push(makeThread('company', row.c.name, `French company where a ${subject.name} is ${frRole(row.self.role)}`, { trusted: finding.match !== 'possible' }));
  }
  const notes = [];
  const total = Number(data.total_results) || 0;
  if (total > data.results.length) notes.push(`The French register lists ${total} companies with an officer named ${subject.name}; the first ${data.results.length} were read.`);
  return { findings, threads, notes };
}

async function frByCompany(task, ctx) {
  const { subject, deadline } = ctx;
  const wanted = withoutLegalForm(task.value);
  if (legalNorm(task.value).length < 2) return { findings: [], threads: [], notes: [] };
  const data = await getJson(`${FR_SEARCH}?${new URLSearchParams({ q: wanted, per_page: '10' })}`, { deadline, timeoutMs: 9000 });
  if (!Array.isArray(data?.results)) throw new Error('Unexpected answer from the French company register');
  const matches = data.results.map(frCompany).filter((c) => c && c.names.some((n) => nameTie(task.value, n) === 'exact'))
    .map((c) => ({ c, tie: officerTie(subject, c.people.filter((p) => !p.auditor)) }));
  matches.sort((a, b) => Number(Boolean(b.tie)) - Number(Boolean(a.tie)));
  // The same rule as for UK companies: no officer tie and an affiliate, or a one-word name, is a note, not a record
  const shown = matches.filter(({ c, tie }) => tie || (!isAffiliate(task) && distinctiveMatch(task.value, c.names)));
  const notes = shown.length < matches.length && !matches.some((m) => m.tie) ? [untiedNote('French', wanted, task)] : [];
  const findings = [];
  const threads = [];
  for (const { c, tie } of shown.slice(0, 2)) {
    const officers = frOfficerList(c);
    const facts = [c.status ? frStatus(c) : '', c.created ? `created ${longDate(c.created)}` : ''].filter(Boolean).join(', ');
    const finding = makeFinding(subject, {
      source: 'fr-companies',
      sourceLabel: FR_LABEL,
      category: 'corporate',
      title: tie
        ? `French company record: ${c.name}${facts ? `, ${facts}` : ''}`
        : `French company with the same name as ${wanted}: ${c.name}${facts ? `, ${facts}` : ''} (no listed officer matches the person)`,
      quote: [...frFacts(c), c.size ? `Size class: ${c.size}` : '', officers ? `Officers: ${officers}` : ''].filter(Boolean).join(' — '),
      url: `${FR_PAGE}/entreprise/${c.siren}`,
      date: c.created,
      severity: c.status === 'ceased' ? 'low' : 'info',
      match: tie ? 'company' : 'possible',
      matchReasons: [tie ? tie.reason : `same name as ${wanted}; no listed officer matches the person`],
      data: {
        siren: c.siren, status: c.status || null, created: c.created, closed: c.closed, legalForm: c.form || null,
        officers: [...c.people.map((p) => ({ name: p.display, role: p.role })), ...c.firms.map((f) => ({ name: f.name, role: f.role, company: true }))].slice(0, 30),
      },
    });
    if (finding) findings.push(tie ? finding : untiedRecord(finding));
    if (!tie) continue;
    // The register ties it to the person: its registered name is a known name of the company from now on
    const knownForTask = knownCompanyFor(subject, task.value)?.company;
    if (finding && knownForTask) addCompanyAlias(subject, { company: knownForTask, alias: c.name, origin: finding.id });
    if (tie.self.length) {
      const seat = frRoleFinding(subject, c, tie.self[0], task.value);
      if (seat) findings.push(seat);
    }
    const mine = nameTokens(subject.name);
    for (const p of c.people.filter((x) => !x.auditor && !sameName(x.tokens, mine)).slice(0, MAX_CO_DIRECTORS)) {
      threads.push(makeThread('associate', p.short, `${frRole(p.role)} of ${c.name} (French company register)`, { trusted: true }));
    }
  }
  return { findings, threads, notes };
}

/**
 * Which countries the check already ties the person or company to, read only from tied records: a
 * reference entry's one-line description ("French entrepreneur", "American businessman"), a tied
 * LEI record's jurisdiction, a tied record from this country's own register, and the language hints.
 * Used only to skip a national register, never to grade a record.
 */
const DEMONYMS = {
  FR: /\b(?:French|France)\b/i,
  US: /\b(?:American|United States)\b/i,
  GB: /\b(?:British|English|Scottish|Welsh|United Kingdom)\b/i,
  DE: /\b(?:German|Germany)\b/i,
  IL: /\b(?:Israeli|Israel)\b/i,
  CA: /\b(?:Canadian|Canada)\b/i,
  IN: /\b(?:Indian|India)\b/i,
  CN: /\b(?:Chinese|China)\b/i,
  ES: /\b(?:Spanish|Spain)\b/i,
  IT: /\b(?:Italian|Italy)\b/i,
  NL: /\b(?:Dutch|Netherlands)\b/i,
  CH: /\b(?:Swiss|Switzerland)\b/i,
  AU: /\b(?:Australian|Australia)\b/i,
  IE: /\b(?:Irish|Ireland)\b/i,
  SE: /\b(?:Swedish|Sweden)\b/i,
  JP: /\b(?:Japanese|Japan)\b/i,
  BR: /\b(?:Brazilian|Brazil)\b/i,
};
const COUNTRY_REGISTERS = { FR: { source: 'fr-companies', lang: 'fr', legalForm: /\b(?:SAS|SASU|SARL|EURL|SCI|S\.A\.S\.?|S\.A\.R\.L\.?)$/i, word: /\b(?:French|France)\b/i } };

export function linkedCountries(task, ctx) {
  const out = new Set();
  const reg = Object.entries(COUNTRY_REGISTERS);
  for (const [code, r] of reg) {
    if (languageHints(ctx.subject).includes(r.lang)) out.add(code);
    if (task.kind === 'company' && (r.legalForm.test(clean(task.value)) || r.word.test(String(task.why || '')))) out.add(code);
  }
  let findings = [];
  try { findings = typeof ctx.findings === 'function' ? ctx.findings() || [] : []; } catch { findings = []; }
  for (const f of findings) {
    if (!f || f.match === 'possible') continue;
    for (const [code, r] of reg) if (f.source === r.source) out.add(code);
    if (f.source === 'lei-register' && f.data?.jurisdiction) out.add(String(f.data.jurisdiction).split('-')[0].toUpperCase());
    if (f.category === 'identity' && (f.source === 'wikidata' || f.source === 'wikipedia')) {
      const described = String(f.title || '').replace(/\s*\((?:Wikipedia article|Wikidata entry)\)\s*$/, '').split(':').slice(1).join(':');
      for (const [code, re] of Object.entries(DEMONYMS)) if (re.test(described)) out.add(code);
    }
  }
  return out;
}

/**
 * A national register is skipped only when tied records place the person and company in other
 * countries and nothing ties them to this one. With no country known yet, it still runs, so a
 * person whose tie to the country is not yet on record is not missed.
 */
export function registerOutOfScope(code, task, ctx) {
  const countries = linkedCountries(task, ctx);
  return countries.size > 0 && !countries.has(code);
}

export const frCompaniesConnector = {
  id: 'fr-companies',
  label: FR_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.4,
  timeoutMs: 12000,
  enabled: () => !switchedOff('fr-companies'),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    if ((task.kind === 'company' || task.kind === 'subject') && registerOutOfScope('FR', task, ctx)) {
      return { findings: [], threads: [], notes: [`The French company register was not searched${task.kind === 'company' ? ` for ${task.value}` : ''}: the records found so far place the person and company outside France.`] };
    }
    if (task.kind === 'company') return frByCompany(task, ctx);
    if (task.kind === 'subject') return frByPerson(ctx);
    return { findings: [], threads: [], notes: [] };
  },
};

/* ------------------------------------------------------------------ US state registers */

const STATE_TIMEOUT_MS = 7000; // two tries fit inside the connector's 15 s
const MAX_PER_STATE = 3;
const US_LABEL = 'US state business registers (Colorado, New York, Connecticut, Oregon, Texas)';
const CO_TYPES = { DPC: 'domestic corporation', FPC: 'foreign corporation', DLLC: 'domestic LLC', FLLC: 'foreign LLC', DNC: 'domestic nonprofit corporation', FNC: 'foreign nonprofit corporation', DLP: 'domestic limited partnership', FLP: 'foreign limited partnership', DLLP: 'domestic LLP', FLLP: 'foreign LLP', DPBC: 'domestic public benefit corporation' };
const CO_STATUS_TAIL = /,\s*(Delinquent|Dissolved|Withdrawn|Noncompliant|Colorado Authority Relinquished|Colorado Authority Terminated)\s+([A-Z][a-z]+ \d{1,2}, \d{4})$/;
const usDate = (text) => { const m = clean(text).match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/); return m ? ukDate(`${m[2]} ${m[1]} ${m[3]}`) : null; };

/**
 * The five registers. Each query selects entity columns only: the datasets
 * also hold registered-agent names and addresses, which are never asked for.
 */
export const STATE_REGISTERS = [
  {
    code: 'CO', name: 'Colorado', host: 'data.colorado.gov', dataset: '4ykn-tg5h', nameCol: 'entityname',
    select: ':id,entityid,entityname,entitystatus,entitytype,entityformdate,jurisdictonofformation',
    read(row) {
      const raw = clean(row.entityname);
      const tail = raw.match(CO_STATUS_TAIL); // Colorado appends the status to the name
      return { name: raw.replace(CO_STATUS_TAIL, ''), number: row.entityid, status: clean(row.entitystatus), statusDate: tail ? usDate(tail[2]) : null, type: CO_TYPES[row.entitytype] || clean(row.entitytype), formed: isoDay(row.entityformdate), formedWord: 'formed', jurisdiction: clean(row.jurisdictonofformation) };
    },
  },
  {
    code: 'NY', name: 'New York', host: 'data.ny.gov', dataset: 'n9v6-gdp6', nameCol: 'current_entity_name', activeOnly: true,
    select: ':id,dos_id,current_entity_name,initial_dos_filing_date,jurisdiction,entity_type',
    read: (row) => ({ name: clean(row.current_entity_name), number: row.dos_id, status: 'Active', type: lower(row.entity_type), formed: isoDay(row.initial_dos_filing_date), formedWord: 'first filed', jurisdiction: clean(row.jurisdiction) }),
  },
  {
    code: 'CT', name: 'Connecticut', host: 'data.ct.gov', dataset: 'n7gp-d28j', nameCol: 'name',
    select: ':id,accountnumber,name,status,sub_status,business_type,date_registration,dissolution_date,formation_place,citizenship,reason_for_administrative',
    read: (row) => ({
      name: clean(row.name), number: row.accountnumber, status: clean(row.status), statusDate: isoDay(row.dissolution_date), type: [lower(row.citizenship), clean(row.business_type)].filter(Boolean).join(' '),
      formed: isoDay(row.date_registration), formedWord: /foreign/i.test(row.citizenship || '') ? 'registered' : 'formed', jurisdiction: clean(row.formation_place),
      extra: row.reason_for_administrative ? `Reason: ${clean(row.reason_for_administrative)}` : '',
    }),
  },
  {
    code: 'OR', name: 'Oregon', host: 'data.oregon.gov', dataset: 'tckn-sxa6', nameCol: 'business_name', activeOnly: true,
    // one row per associated name: only the business's own row is asked for
    extraWhere: "associated_name_type = 'PRINCIPAL PLACE OF BUSINESS'",
    select: ':id,registry_number,business_name,entity_type,registry_date,jurisdiction',
    read: (row) => ({ name: clean(row.business_name), number: row.registry_number, status: 'Active', type: lower(row.entity_type), formed: isoDay(row.registry_date), formedWord: 'registered', jurisdiction: clean(row.jurisdiction) }),
  },
  {
    code: 'TX', name: 'Texas', host: 'data.texas.gov', dataset: '9cir-efmm', nameCol: 'taxpayer_name',
    select: ':id,taxpayer_number,taxpayer_name,sos_charter_date,sos_status_code,right_to_transact_business_code,responsibility_beginning_date',
    read(row) {
      const code = clean(row.sos_status_code);
      const right = clean(row.right_to_transact_business_code);
      // Only the code that is certain is put into words; the others are shown as the register gives them
      const status = code === 'A' && (!right || right === 'A') ? 'Active' : [code ? (code === 'A' ? 'Active' : `Secretary of State status code ${code}`) : '', right && right !== 'A' ? `right-to-transact-business code ${right}` : ''].filter(Boolean).join(', ');
      return { name: clean(row.taxpayer_name), number: row.taxpayer_number, status, type: 'franchise taxpayer', formed: isoDay(row.sos_charter_date) || isoDay(row.responsibility_beginning_date), formedWord: isoDay(row.sos_charter_date) ? 'chartered' : 'liable for franchise tax from', jurisdiction: '' };
    },
  },
];

const soqlText = (s) => fold(s).toUpperCase().replace(/[%_]/g, ' ').replace(/'/g, "''").replace(/\s+/g, ' ').trim();

async function queryStateRegister(state, wanted, deadline) {
  const col = `upper(${state.nameCol})`;
  const n = soqlText(wanted);
  const names = `${col} = '${n}' OR ${col} like '${n} %' OR ${col} like '${n},%'`;
  // Exact legal names first, so a long list of look-alikes cannot push the real entity off the page
  const first = [`${col} = '${n}'`, `${col} like '${n},%'`, ...[' INC', ' CORP', ' LLC', ' L.L.C', ' CO', ' LTD', ' LIMITED', ' LP', ' PBC'].map((s) => `${col} like '${n}${s}%'`)];
  const qs = new URLSearchParams({
    $select: state.select,
    $where: state.extraWhere ? `(${names}) AND ${state.extraWhere}` : names,
    $order: `case(${first.map((c) => `${c}, 0`).join(', ')}, true, 1), ${state.nameCol}`,
    $limit: '40',
  });
  const url = `https://${state.host}/resource/${state.dataset}.json?${qs}`;
  let rows;
  try {
    rows = await getJson(url, { deadline, timeoutMs: STATE_TIMEOUT_MS, retries: 0 });
  } catch (error) {
    // A slow first answer gets one more try when the time allows; any other failure is reported as it is
    if (!/^Timed out/.test(String(error?.message || '')) || (deadline && Date.now() + STATE_TIMEOUT_MS / 2 > deadline)) throw error;
    rows = await getJson(url, { deadline, timeoutMs: STATE_TIMEOUT_MS, retries: 0 });
  }
  if (!Array.isArray(rows)) throw new Error(`Unexpected answer from the ${state.name} register`);
  return rows;
}

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const STATE_BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [fold(name), code]));
/** "DE", "Delaware", "DELAWARE", "US-DE" -> "DE"; anything else (a country, blank) -> null. */
export function usStateCode(text) {
  const t = clean(text).replace(/^US-/i, '').replace(/\.$/, '');
  if (/^[A-Za-z]{2}$/.test(t) && US_STATES[t.toUpperCase()]) return t.toUpperCase();
  return STATE_BY_NAME.get(fold(t)) || null;
}

/**
 * The US state the company was formed in, when a record tied to it says so: a tied LEI record ("US-DE"), or a
 * Form D or company filing of a known name of the company naming its jurisdiction of incorporation. Null when
 * nothing tied says. Used only to tell the company's own state registrations from namesakes'.
 */
export function homeJurisdiction(ctx) {
  let findings = [];
  try { findings = typeof ctx?.findings === 'function' ? ctx.findings() || [] : []; } catch { findings = []; }
  const subject = ctx?.subject;
  for (const f of findings) {
    if (!f || f.match === 'possible') continue;
    if (f.source === 'lei-register' && f.match === 'company') {
      const code = /^US-/i.test(String(f.data?.jurisdiction || '')) ? usStateCode(f.data.jurisdiction) : null;
      if (code) return { code, from: 'the LEI register' };
    }
    if (/^sec-/.test(String(f.source || ''))) {
      const stated = f.data?.jurisdiction || f.data?.stateOfIncorporation;
      const issuer = f.data?.issuer || '';
      if (stated && usStateCode(stated) && (!issuer || knownCompanyFor(subject, issuer))) return { code: usStateCode(stated), from: 'an SEC filing' };
      // "Issuer: Ramp Business Corp (Corporation, DELAWARE)" in a Form D record
      const m = String(f.quote || '').match(/Issuer:\s*([^(;]+?)\s*\(([^)]*)\)/);
      if (m && subject && knownCompanyFor(subject, m[1])) {
        const code = m[2].split(',').map((p) => usStateCode(p)).find(Boolean);
        if (code) return { code, from: 'an SEC filing' };
      }
    }
  }
  return null;
}

const OTHER_STATES = Object.keys(US_STATES).length - 5;
const statesCoverage = (wanted) => `US state registers searched for ${wanted}: Colorado, New York, Connecticut, Oregon and Texas. Not searched: Delaware, where most US start-ups are formed, California and the other ${OTHER_STATES - 2} states, whose registers cannot be searched by this check; a company missing here may be registered there.`;

export const usStateRegistriesConnector = {
  id: 'us-state-registries',
  label: US_LABEL,
  kinds: ['company'],
  prior: 0.4,
  timeoutMs: 15000,
  enabled: () => !switchedOff('us-state-registries'),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const { subject, deadline } = ctx;
    if (task.kind !== 'company') return { findings: [], threads: [], notes: [] };
    const wanted = withoutLegalForm(task.value);
    if (legalNorm(task.value).length < 3) return { findings: [], threads: [], notes: [] };
    const answers = await Promise.all(STATE_REGISTERS.map(async (state) => {
      try { return { state, rows: await queryStateRegister(state, wanted, deadline) }; } catch (error) { return { state, error }; }
    }));
    if (answers.every((a) => a.error)) throw new Error(`None of the state registers answered (${String(answers[0].error?.message || answers[0].error)})`);

    const findings = [];
    const notes = [statesCoverage(wanted)];
    const lookalikes = [];
    const perState = [];
    const partial = []; // states that did not answer: the search is partial, not "nothing found"
    for (const { state, rows, error } of answers) {
      if (error) {
        const late = /^Timed out/.test(String(error?.message || '')) || /^Out of time/.test(String(error?.message || ''));
        partial.push(state.name);
        notes.push(late
          ? `The ${state.name} business register did not answer in time.`
          : `The ${state.name} business register could not be read (${String(error?.message || error)}).`);
        continue;
      }
      // A name reservation is not a company: Connecticut lists them beside real entities
      const entities = uniqueBy(rows.map((row) => ({ ...state.read(row), rowId: String(row[':id'] || '') })).filter((e) => e.name && e.rowId && !/reservation/i.test(e.status)), (e) => String(e.number || e.name));
      const exact = entities.filter((e) => nameTie(task.value, e.name) === 'exact').map((e) => ({ ...e, formedIn: usStateCode(e.jurisdiction) || (e.jurisdiction ? clean(e.jurisdiction) : null) }));
      const similar = entities.filter((e) => nameTie(task.value, e.name) === 'prefix');
      if (similar.length) lookalikes.push(`${state.name}: ${similar.slice(0, 2).map((e) => e.name).join(', ')}${similar.length > 2 ? ` and ${similar.length - 2} more` : ''}`);
      perState.push({ state, exact });
    }
    const all = perState.flatMap((s) => s.exact.map((e) => ({ ...e, state: s.state })));

    // One ordinary word ("Merge", "Ramp") with no fuller legal name: every same-named entity is someone else's
    // business as far as the register can tell. Counted in one line, never shown as the company's.
    if (bareOrdinaryWord(task.value) && all.length) {
      const byState = perState.filter((s) => s.exact.length).map((s) => `${s.state.name} ${s.exact.length}`).join(', ');
      notes.push(`State registers list ${plural(all.length, 'business', 'businesses')} named ${wanted} (${byState}). "${wanted}" is an ordinary word many businesses use, and these registers list no officers, so none is shown as the company; a search under the company's full legal name can tell.`);
      if (lookalikes.length) notes.push(`State registers also list companies whose names begin with "${wanted}" (${lookalikes.join('; ')}); they are not reported.`);
      return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
    }

    // These registers list no officers, so a legal name and the state the entity was formed in are all that tie
    // it to the company. With the company's home state known (a tied LEI record or Form D), only a registration of
    // an entity formed there ties. Without it, a domestic entity of these states never ties on its name (the
    // company may be formed elsewhere and the local one a namesake); foreign registrations tie only when every
    // same-named entity with a known place of formation was formed in one and the same place.
    const home = homeJurisdiction(ctx);
    const places = new Set(all.map((e) => e.formedIn).filter(Boolean));
    const domesticHere = (e) => e.formedIn === e.state.code;
    const tiedRow = (e) => {
      if (!e.formedIn) return false; // Texas gives no place of formation
      if (home) return e.formedIn === home.code;
      return !domesticHere(e) && places.size === 1 && !all.some((x) => domesticHere(x));
    };
    const shownRows = perState.flatMap((s) => s.exact.slice(0, MAX_PER_STATE).map((e) => ({ ...e, state: s.state })));
    for (const e of shownRows) {
      const tied = tiedRow(e);
      const state = e.state;
      const notGood = GONE.test(e.status) || DISTRESSED.test(e.status) || LAPSED.test(e.status);
      const when = e.formed ? `${e.formedWord} ${longDate(e.formed)}` : '';
      const where = e.jurisdiction && fold(e.jurisdiction) !== fold(state.code) && fold(e.jurisdiction) !== fold(state.name) ? `home jurisdiction ${e.jurisdiction}` : '';
      const title = notGood
        ? `${state.name} business register shows ${e.name} as ${e.status.toUpperCase()}${e.statusDate ? ` since ${longDate(e.statusDate)}` : ''}${when ? `; ${when}` : ''}${where ? `, ${where}` : ''}`
        : `${state.name} business register: ${e.name}, ${(/\bcode\b/.test(e.status) ? e.status : lower(e.status)) || 'listed'}${when ? `, ${when}` : ''}${where ? `, ${where}` : ''}`;
      const formedText = e.formedIn ? (usStateCode(e.formedIn) ? US_STATES[e.formedIn] : e.formedIn) : '';
      const reason = tied
        ? (home
          ? `legal name matches ${wanted} and the entity was formed in ${US_STATES[home.code]}, the company's home state according to ${home.from}; the register lists no officers`
          : `legal name matches ${wanted} and every same-named entity in these registers was formed in ${formedText}; the register lists no officers, so the tie rests on the name`)
        : home && e.formedIn
          ? `same legal name as ${wanted}, but formed in ${formedText}, while the company is formed in ${US_STATES[home.code]} (${home.from}): another business`
          : !e.formedIn
            ? `same legal name as ${wanted}; the register gives no place of formation and lists no officers, so it may be another business`
            : `same legal name as ${wanted}; ${domesticHere(e) ? `a ${state.name} entity, and the company is not known to be formed there` : `${plural(places.size, 'place of formation', 'places of formation')} among the same-named entities`}; the register lists no officers, so it may be another business`;
      const finding = makeFinding(subject, {
        source: 'us-state-registries',
        sourceLabel: US_LABEL,
        category: 'corporate',
        title,
        quote: [
          `${e.name} — ${state.name} register number ${e.number || 'not stated'}`,
          e.status ? `Status: ${e.status}${e.statusDate ? ` (${longDate(e.statusDate)})` : ''}` : '',
          e.type ? `Type: ${e.type}` : '',
          e.formed ? `${e.formedWord[0].toUpperCase()}${e.formedWord.slice(1)}: ${longDate(e.formed)}` : '',
          e.jurisdiction ? `Jurisdiction of formation: ${e.jurisdiction}` : '',
          e.extra || '',
          state.activeOnly ? 'This register lists active entities only' : '',
        ].filter(Boolean).join(' — '),
        url: `https://${state.host}/resource/${state.dataset}/${encodeURIComponent(e.rowId)}.json`,
        date: e.formed,
        severity: tied ? companySeverity(e.status) : 'info',
        match: tied ? 'company' : 'possible',
        matchReasons: [reason],
        data: { state: state.code, registerNumber: e.number || null, status: e.status || null, type: e.type || null, formed: e.formed, jurisdiction: e.jurisdiction || null, ...(home ? { homeState: home.code } : {}) },
      });
      if (finding) findings.push(tied ? finding : untiedRecord(finding));
    }
    if (lookalikes.length) notes.push(`State registers also list companies whose names begin with "${wanted}" (${lookalikes.join('; ')}). Only exact legal names are reported, because a similar name may be an affiliate or an unrelated business.`);
    return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ GLEIF */

const LEI_SEARCH = 'https://api.gleif.org/api/v1/lei-records';
const LEI_LABEL = 'Legal Entity Identifier register (GLEIF)';
const LEI_PAGE = 100; // results read per search (the register allows up to 200)
const regionName = (() => { try { const names = new Intl.DisplayNames(['en'], { type: 'region' }); return (code) => { try { return names.of(code) || code; } catch { return code; } }; } catch { return (code) => code; } })();
const jurisdictionName = (code) => { const [country, region] = String(code || '').split('-'); return country ? `${regionName(country)}${region ? ` (${code})` : ''}` : ''; };
/** GLEIF dates are UTC instants of a local midnight, so they can read a day early: round to the nearest day. */
function leiDay(value) {
  const t = Date.parse(String(value || ''));
  return Number.isNaN(t) ? null : new Date(t + 12 * 3600 * 1000).toISOString().slice(0, 10);
}

export const leiConnector = {
  id: 'lei-register',
  label: LEI_LABEL,
  kinds: ['company'],
  prior: 0.25,
  timeoutMs: 12000,
  enabled: () => !switchedOff('lei-register'),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const { subject, deadline } = ctx;
    if (task.kind !== 'company') return { findings: [], threads: [], notes: [] };
    const wanted = withoutLegalForm(task.value);
    if (legalNorm(task.value).length < 3) return { findings: [], threads: [], notes: [] };
    const qs = `filter%5Bentity.legalName%5D=${encodeURIComponent(wanted)}&page%5Bsize%5D=${LEI_PAGE}`;
    const data = await getJson(`${LEI_SEARCH}?${qs}`, { deadline, timeoutMs: 8000, accept: 'application/vnd.api+json' });
    if (!Array.isArray(data?.data)) throw new Error('Unexpected answer from the LEI register');
    const matching = data.data.filter((d) => {
      const e = d?.attributes?.entity;
      return /^[A-Z0-9]{20}$/.test(String(d?.id || '')) && e && [e.legalName?.name, ...(e.otherNames || []).map((n) => n?.name)].filter(Boolean).some((n) => nameTie(task.value, n) === 'exact');
    });
    // The search is by words, not exact names: when it holds more entities than one page, an entity with the same
    // exact name may be among those not read, so "only one carries the name" cannot be said.
    const total = Number(data?.meta?.pagination?.total) || data.data.length;
    const readInPart = total > data.data.length;
    const notes = readInPart ? [`The LEI register holds ${total} entities whose names contain "${wanted}"; the first ${data.data.length} were read, so none is tied to the company on its name alone.`] : [];
    const partial = readInPart ? ['LEI register (first page of results only)'] : [];
    const records = matching.slice(0, 3);
    if (!records.length) return partial.length ? { findings: [], threads: [], notes, partial } : { findings: [], threads: [], notes };
    // The register lists no officers: a legal name ties a record to the company only when no other entity,
    // in any country, carries it, every result was read, and the name is not one ordinary word ("Merge", "Ramp")
    // that a business anywhere may use. With several, none is graded the company and no parents are read.
    const tied = matching.length === 1 && !readInPart && !bareOrdinaryWord(task.value);

    // Parents of the tied record only (one or two more lookups)
    const parentLinks = tied ? ['direct-parent', 'ultimate-parent'].map((rel) => ({ rel, url: records[0].relationships?.[rel]?.links?.['lei-record'] || null })) : [];
    const parents = await mapLimit(parentLinks, 2, async ({ rel, url }) => {
      if (!url || !/^https:\/\/api\.gleif\.org\//.test(url)) return { rel, reported: false };
      const parent = (await getJson(url, { deadline, timeoutMs: 6000, accept: 'application/vnd.api+json' }))?.data;
      const name = clean(parent?.attributes?.entity?.legalName?.name);
      return name ? { rel, reported: true, name, lei: parent.id, jurisdiction: parent.attributes.entity.jurisdiction || '' } : { rel, reported: false };
    });

    const findings = [];
    const threads = [];
    records.forEach((d, i) => {
      const e = d.attributes.entity;
      const reg = d.attributes.registration || {};
      const name = clean(e.legalName?.name);
      const created = leiDay(e.creationDate);
      const inactive = e.status && e.status !== 'ACTIVE';
      const ended = e.expiration?.reason ? `${lower(e.expiration.reason).replace(/_/g, ' ')}${e.expiration.date ? `, ${longDate(leiDay(e.expiration.date))}` : ''}` : '';
      const place = jurisdictionName(e.jurisdiction);
      const parentText = tied && i === 0 ? (parents || []).filter(Boolean).map((p) => `${p.rel === 'direct-parent' ? 'Direct parent' : 'Ultimate parent'}: ${p.reported ? `${p.name}${p.jurisdiction ? ` (${p.jurisdiction})` : ''}` : 'not reported'}`) : [];
      const finding = makeFinding(subject, {
        source: 'lei-register',
        sourceLabel: LEI_LABEL,
        category: 'corporate',
        title: inactive
          ? `Legal entity register shows ${name}${place ? ` (${place})` : ''} as ${String(e.status).toUpperCase()}${ended ? ` (${ended})` : ''}${created ? `; created ${longDate(created)}` : ''}`
          : `Legal entity register: ${name}${place ? ` (${place})` : ''}, active${created ? `, created ${longDate(created)}` : ''}`,
        quote: [
          `${name} — LEI ${d.id}`,
          e.jurisdiction ? `Jurisdiction: ${e.jurisdiction}` : '',
          e.status ? `Entity status: ${e.status}` : '',
          created ? `Created: ${longDate(created)}` : '',
          ended ? `Ended: ${ended}` : '',
          e.registeredAs ? `Local registration number: ${e.registeredAs}` : '',
          reg.status ? `LEI registration: ${reg.status}${reg.initialRegistrationDate ? `, first registered ${longDate(isoDay(reg.initialRegistrationDate))}` : ''}` : '',
          ...parentText,
        ].filter(Boolean).join(' — '),
        url: `https://www.gleif.org/lei/${d.id}`,
        date: created,
        severity: tied && inactive ? 'low' : 'info',
        match: tied ? 'company' : 'possible',
        matchReasons: [tied
          ? `legal name matches ${wanted}; the register lists no officers, so the tie rests on the name`
          : matching.length > 1 ? `same legal name as ${wanted}${place ? ` in ${place}` : ''}; ${matching.length} registered entities share it`
            : readInPart ? `same legal name as ${wanted}${place ? ` in ${place}` : ''}; the register holds more same-word entities than were read`
              : `same legal name as ${wanted}${place ? ` in ${place}` : ''}; "${wanted}" is an ordinary word other businesses also use, and the register lists no officers`],
        data: {
          lei: d.id, jurisdiction: e.jurisdiction || null, status: e.status || null, created, registeredAs: e.registeredAs || null, registrationStatus: reg.status || null,
          ...(tied && i === 0 ? { parents: (parents || []).filter((p) => p?.reported).map((p) => ({ relation: p.rel, name: p.name, lei: p.lei })) } : {}),
        },
      });
      if (finding) findings.push(tied ? finding : untiedRecord(finding));
    });
    // A parent is recorded but not followed: the tie to the subject's company rests on a name match
    for (const p of uniqueBy((parents || []).filter((x) => x?.reported), (x) => x.lei)) threads.push(makeThread('company', withoutLegalForm(p.name), `${p.rel === 'direct-parent' ? 'direct' : 'ultimate'} parent of ${clean(records[0].attributes.entity.legalName?.name)} in the LEI register`, { trusted: false }));
    return partial.length ? { findings, threads, notes, partial } : { findings, threads, notes };
  },
};

/* ------------------------------------------------------------------ Y Combinator directory */

const YC_LIST = 'https://yc-oss.github.io/api/companies/all.json';
const YC_PAGE = 'https://www.ycombinator.com/companies';
const YC_LABEL = 'Y Combinator company directory';
const YC_CACHE_KEY = 'registry:yc-directory:v1';
const YC_TTL_MS = 24 * 60 * 60 * 1000;
const YC_CHUNK = 5_000_000; // the list is about 11 MB; it is fetched in byte ranges below the client's body limit
const slugify = (name) => fold(name).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hostOf = (url) => { try { return new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

/** The whole directory, fetched in byte ranges and joined. */
async function downloadYcList(deadline) {
  const first = await request(YC_LIST, { deadline, timeoutMs: 10000, headers: { Range: `bytes=0-${YC_CHUNK - 1}` }, accept: 'application/json' });
  const total = Number((String(first.headers?.get?.('content-range') || '').match(/\/(\d+)\s*$/) || [])[1]) || 0;
  let text = first.text;
  if (first.status === 206 && total > YC_CHUNK) {
    const ranges = [];
    for (let from = YC_CHUNK; from < total; from += YC_CHUNK) ranges.push(`bytes=${from}-${Math.min(total, from + YC_CHUNK) - 1}`);
    if (ranges.length > 6) throw new Error('The Y Combinator directory list is larger than expected');
    const rest = await mapLimit(ranges, 3, async (range) => (await request(YC_LIST, { deadline, timeoutMs: 10000, headers: { Range: range }, accept: 'application/json' })).text);
    if (rest.some((part) => part === null)) throw new Error('The Y Combinator directory list could not be downloaded in full');
    text += rest.join('');
  }
  let list;
  try { list = JSON.parse(text); } catch { throw new Error('The Y Combinator directory list could not be read'); }
  if (!Array.isArray(list) || !list.length) throw new Error('The Y Combinator directory list was empty');
  return list;
}

/**
 * The compact index kept in the cache: [name, slug, former names, website host, batch, status] per company.
 * The download gets its own time (the cache's loader deadline), not the first caller's, so a caller short of
 * time does not leave the list failed for everyone. Returns { index, asOf } where asOf is set when an older
 * copy stood in for a failed refresh.
 */
async function ycIndex(deadline) {
  const entry = await cachedEntry(YC_CACHE_KEY, YC_TTL_MS, async ({ deadline: loadDeadline } = {}) => (await downloadYcList(loadDeadline))
    .filter((c) => c && c.name && c.slug)
    .map((c) => [clean(c.name), String(c.slug), (Array.isArray(c.former_names) ? c.former_names : []).map(clean).filter(Boolean), hostOf(c.website || ''), clean(c.batch), clean(c.status)]), { deadline });
  return { index: entry.value, asOf: entry.fresh ? '' : new Date(entry.at).toISOString().slice(0, 10) };
}

/** Directory entries whose name, former name or slug is the wanted company. */
function ycLookup(index, wanted) {
  const w = legalNorm(wanted);
  if (w.length < 2) return [];
  // "Luciq (formerly Instabug)", "Flirtey (SkyDrop)": the directory sometimes carries an alias in brackets
  const names = (name) => [name, name.replace(/\s*\([^)]*\)\s*$/, ''), ...(name.match(/\((?:formerly\s+)?([^)]+)\)\s*$/i) || []).slice(1)];
  const out = [];
  for (const [name, slug, former, website, batch, status] of index) {
    const current = names(name).some((n) => legalNorm(n) === w);
    const wasCalled = !current && former.find((f) => legalNorm(f) === w);
    if (current || wasCalled) out.push({ name, slug, website, batch, status, formerName: wasCalled || null });
  }
  return out.sort((a, b) => Number(Boolean(a.formerName)) - Number(Boolean(b.formerName))).slice(0, 2);
}

const decodeAttr = (s) => String(s).replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/gi, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The public company page: the directory's own data for one company. Returns null when there is no such page. */
async function ycCompanyPage(slug, deadline) {
  let html;
  try {
    html = await getText(`${YC_PAGE}/${encodeURIComponent(slug)}`, { deadline, timeoutMs: 8000, accept: 'text/html' });
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
  const raw = (html.match(/data-page="([^"]+)"/) || [])[1];
  if (!raw) throw new Error('The Y Combinator company page could not be read');
  let company;
  try { company = JSON.parse(decodeAttr(raw))?.props?.company; } catch { throw new Error('The Y Combinator company page could not be read'); }
  if (!company?.name) throw new Error('The Y Combinator company page could not be read');
  return {
    name: clean(company.name),
    slug: String(company.slug || slug),
    batch: clean(company.batch_name || company.batch),
    status: clean(company.ycdc_status),
    yearFounded: Number(company.year_founded) || null,
    teamSize: Number(company.team_size) || null,
    website: hostOf(company.website || ''),
    oneLiner: clean(company.one_liner),
    // name, title and the public profile links the directory publishes; nothing else about a founder is read
    founders: (Array.isArray(company.founders) ? company.founders : []).map((f) => ({ name: clean(f?.full_name), title: clean(f?.title), active: f?.is_active !== false, linkedin: clean(f?.linkedin_url), twitter: clean(f?.twitter_url) })).filter((f) => f.name),
  };
}

async function ycForCompany(company, ctx, { personOnly = false } = {}) {
  const { subject, deadline } = ctx;
  if (legalNorm(company).length < 2) return { findings: [], threads: [], notes: [] };
  let entries = null;
  const notes = [];
  try {
    const { index, asOf } = await ycIndex(deadline);
    entries = ycLookup(index, company);
    if (asOf && entries.length) notes.push(`The Y Combinator directory list could not be refreshed; the copy of ${asOf} was used.`);
  } catch {
    entries = null; // the list is a mirror and may be down: fall back to the page the name would have
  }
  if (entries && !entries.length) return { findings: [], threads: [], notes };
  const slugs = entries ? entries.map((e) => e.slug) : [slugify(withoutLegalForm(company))].filter(Boolean);
  const pages = (await Promise.all(slugs.map((slug) => ycCompanyPage(slug, deadline)))).filter(Boolean)
    .filter((p) => (entries ? true : nameTie(company, p.name) === 'exact'));
  if (!pages.length) return { findings: [], threads: [], notes };

  const mine = nameTokens(subject.name);
  const judged = pages.map((p) => {
    const self = p.founders.find((f) => sameName(nameTokens(f.name), mine)) || null;
    let reason = self ? `${subject.name} is on its founder list` : '';
    if (!reason) {
      const friend = p.founders.find((f) => [...(subject.anchors?.people?.values?.() || [])].some((a) => a.test(f.name)));
      if (friend) reason = `${friend.name}, a known associate, is on its founder list`;
    }
    const knownDomains = [...(subject.anchors?.domains?.values?.() || []), ...[...(subject.anchors?.aliases?.values?.() || [])].filter((a) => isDomainName(a.value))].map((a) => hostOf(a.value));
    if (!reason && p.website && knownDomains.includes(p.website)) reason = `its website (${p.website}) is a known domain of the company`;
    const entry = (entries || []).find((e) => e.slug === p.slug);
    return { p, self, reason, viaFormerName: Boolean(entry?.formerName) };
  });
  // If one of two same-named companies is tied to the subject, the other is not theirs. An untied company is
  // shown only for the company the user gave, under its current name: a company that merely used the name once
  // ("Versine, formerly Merge"), or a namesake of an earlier employer ("Expanse"), is not this person's and adds
  // nothing but noise. It is counted in a note instead.
  const anyTied = judged.some((j) => j.reason);
  const given = subject.company && legalNorm(subject.company) === legalNorm(company);
  const kept = judged.filter((j) => j.reason || (!anyTied && given && !j.viaFormerName));
  const left = judged.filter((j) => !kept.includes(j) && !j.reason);
  if (left.length && !personOnly) notes.push(`The Y Combinator directory lists ${left.map((j) => `${j.p.name}${j.viaFormerName ? ` (once called ${company})` : ''}`).join(' and ')}; nothing ties ${left.length === 1 ? 'it' : 'them'} to ${subject.name}, so ${left.length === 1 ? 'it is' : 'they are'} not reported.`);

  const findings = [];
  const threads = [];
  for (const { p, self, reason } of kept) {
    const url = `${YC_PAGE}/${p.slug}`;
    const entry = (entries || []).find((e) => e.slug === p.slug);
    const gone = /inactive/i.test(p.status);
    const founderList = p.founders.map((f) => `${f.name}${f.title ? ` (${f.title})` : ''}`).join('; ');
    const facts = [p.batch ? `${p.batch} batch` : '', p.yearFounded ? `founded ${p.yearFounded}` : ''].filter(Boolean).join(', ');
    if (!personOnly) {
      const finding = makeFinding(subject, {
        source: 'yc-directory',
        sourceLabel: YC_LABEL,
        category: 'corporate',
        title: reason
          ? (gone ? `Y Combinator directory shows ${p.name} as INACTIVE${facts ? ` (${facts})` : ''}` : `Y Combinator directory: ${p.name}${facts ? `, ${facts}` : ''}${p.status ? `, status ${lower(p.status)}` : ''}`)
          : `Y Combinator lists a company named ${p.name}${facts ? ` (${facts}${p.status ? `, ${lower(p.status)}` : ''})` : ''}; its founder list does not include ${subject.name} (the directory may list only some founders)`,
        quote: [
          `${p.name}${entry?.formerName ? ` (formerly ${entry.formerName})` : ''}${p.oneLiner ? ` — ${p.oneLiner}` : ''}`,
          p.batch ? `Batch: ${p.batch}` : '', p.status ? `Status: ${p.status}` : '', p.yearFounded ? `Year founded: ${p.yearFounded}` : '',
          p.teamSize ? `Team size: ${p.teamSize}` : '', founderList ? `Founders: ${founderList}` : '',
        ].filter(Boolean).join(' — '),
        url,
        date: p.yearFounded ? String(p.yearFounded) : null,
        severity: gone ? 'low' : 'info',
        match: reason ? 'company' : 'possible',
        matchReasons: [reason || `same company name; the directory's founder list does not include ${subject.name}`],
        data: { slug: p.slug, batch: p.batch || null, status: p.status || null, yearFounded: p.yearFounded, teamSize: p.teamSize, website: p.website || null, founders: p.founders.map((f) => ({ name: f.name, title: f.title, active: f.active })) },
      });
      if (finding) findings.push(finding);
    }
    if (!reason) continue;
    if (self) {
      // The company name is in the title and the text that is graded, so the identity check sees name and company together
      const seat = makeFinding(subject, {
        source: 'yc-directory',
        sourceLabel: YC_LABEL,
        category: 'career',
        title: `${subject.name}: on Y Combinator's founder list for ${p.name}${self.title ? ` (${self.title})` : ''}${p.batch ? `, ${p.batch} batch` : ''}`,
        quote: [`${p.name} — Founders: ${founderList}`, p.batch ? `Batch: ${p.batch}` : '', p.status ? `Status: ${p.status}` : ''].filter(Boolean).join(' — '),
        url,
        date: p.yearFounded ? String(p.yearFounded) : null,
        severity: 'info',
        matchText: `${subject.name}; ${p.name}; ${company}`,
        data: { company: p.name, role: self.title || null, batch: p.batch || null },
      });
      if (seat) {
        findings.push(seat);
        const trusted = seat.match !== 'possible';
        // The directory's own website for a company the person is a listed founder of is a domain of that company
        const knownAs = knownCompanyFor(subject, p.name)?.company || knownCompanyFor(subject, company)?.company;
        if (trusted && knownAs && p.website) addCompanyAlias(subject, { company: knownAs, alias: p.website, origin: seat.id });
        for (const link of [self.linkedin, self.twitter]) {
          const profile = profileFromUrl(link);
          if (!profile) continue;
          threads.push(makeThread('url', profile.url, `${profile.platform} profile on the Y Combinator founder list`, { trusted, platform: profile.platform }));
          if (profile.platform === 'x') threads.push(makeThread('handle', profile.handle, 'X handle on the Y Combinator founder list', { trusted, platform: 'x' }));
        }
        for (const f of p.founders.filter((x) => x !== self).slice(0, MAX_CO_DIRECTORS)) threads.push(makeThread('associate', f.name, `co-founder of ${p.name} (Y Combinator founder list)`, { trusted }));
      }
    }
  }
  return { findings, threads, notes };
}

export const ycDirectoryConnector = {
  id: 'yc-directory',
  label: YC_LABEL,
  kinds: ['company', 'subject'],
  prior: 0.35,
  timeoutMs: 18000,
  enabled: () => !switchedOff('yc-directory'),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    if (task.kind === 'company') return ycForCompany(task.value, ctx);
    if (task.kind !== 'subject') return { findings: [], threads: [], notes: [] };
    // The directory cannot be searched by founder: for the person, it is read for the company they gave
    const company = ctx.subject.company;
    return company ? ycForCompany(company, ctx, { personOnly: true }) : { findings: [], threads: [], notes: [] };
  },
};

export const registryConnectors = [ukCompaniesConnector, frCompaniesConnector, usStateRegistriesConnector, leiConnector, ycDirectoryConnector];
