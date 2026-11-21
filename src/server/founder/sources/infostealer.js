/**
 * Infostealer exposure of a COMPANY's own domain. Never of a person.
 *
 * Hudson Rock publishes a free lookup by domain: how many computers infected
 * by infostealer malware (programs that copy saved logins off a computer)
 * held logins for that domain, split into the company's employees, its users
 * (customers logging in to its site) and third parties, with the dates of the
 * most recent infections. These are the provider's own estimates from its
 * database, not a breach notice and not a finding about the founder.
 *
 * When it runs. Only on a domain thread, and only when the domain is the
 * company's own:
 *   - the website the user typed for the company ("company website given");
 *   - a domain the check learned for one of the person's companies
 *     (identity.addCompanyAlias, from a record tied by more than the word);
 *   - a domain whose name is the company's name ("theranos.com" for Theranos,
 *     "trynikola.com" for Nikola), for the company typed or assumed. A company
 *     named with one ordinary word ("Merge", "Bolt") is a namesake risk
 *     (merge.com is someone else), so its name alone is not enough: the domain
 *     must have come from a record tied to the person as the company website.
 * Never: the person's own site, a mail, social or hosting domain shared by
 * millions, an email address or a person's name.
 *
 * Privacy. Only counts and dates are read. The response also carries captured
 * login addresses (which can hold usernames or emails in their query strings),
 * password-strength figures, antivirus names, third-party domains and a logo:
 * none of it is read, kept or returned. The search-by-email and
 * search-by-username lookups of the same provider are never called.
 *
 * Terms. The provider advertises the lookup as a free tool "for defensive
 * security purposes"; its terms page could not be read in plain text. The
 * source is therefore OFF unless the owner names it in FOUNDER_SOURCES_ON
 * (comma-separated ids); FOUNDER_SOURCES_OFF still wins.
 *
 * One request per domain, cached for a day (counts only, a few hundred bytes).
 */
import { getJson } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { companyKeyStrict, companyKeys, isOrdinaryWordCompany } from '../names';
import { registrableDomain } from './exposure';
import { companyDomainFromUrl } from './domains';

export const INFOSTEALER_ID = 'infostealer-exposure';
const LABEL = 'Infostealer exposure of the company domain (Hudson Rock)';
const SOURCE_LABEL = 'Hudson Rock free infostealer lookup (hudsonrock.com)';
const ENDPOINT = 'https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-domain';
const TOOL_PAGE = 'https://www.hudsonrock.com/free-tools';
const CATEGORY = 'exposure';
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'exposure:infostealer:v1:';
/** The answer for a very large company (hundreds of captured addresses) is well under this. */
const MAX_BYTES = 3 * 1024 * 1024;

const listOf = (name) => String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
const switchedOn = () => listOf('FOUNDER_SOURCES_ON').includes(INFOSTEALER_ID);
const switchedOff = () => listOf('FOUNDER_SOURCES_OFF').includes(INFOSTEALER_ID);

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const count = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;

/**
 * Mail and hosting domains shared by millions of people that domains.js does not already refuse (it refuses
 * social networks, hosted sites and the largest mail services). Kept in step with SHARED_DOMAINS in exposure.js.
 */
const SHARED_MAIL = new Set('gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com gmx.com mail.com zoho.com google.com telegram.org slack.com zoom.us dropbox.com'.split(' '));

/** Where a domain thread came from, when it says the domain is the company's website. */
const GIVEN_WEBSITE = /^company website given$/i;
const COMPANY_WEBSITE = /^company website\b/i;
const PERSONAL = /\bpersonal\b|\bwebsite listed on wikidata\b/i;

/** A domain's first label is the company's name, as companies commonly register it ("ramp", "tryramp", "ramphq"). */
function labelFits(label, name) {
  const base = companyKeyStrict(name).replace(/[^a-z0-9]/g, '');
  if (base.length < 3) return false;
  return label === base || [`try${base}`, `get${base}`, `use${base}`, `join${base}`, `${base}hq`, `${base}app`].includes(label);
}

/** The companies the check treats as the person's own: the one typed, the one assumed from the network, and any typed earlier. */
function ownCompanies(subject) {
  const out = [];
  if (subject?.company) out.push(String(subject.company));
  for (const a of subject?.anchors?.companies?.values?.() || []) {
    if ((a.origin === 'given' || a.origin === 'network') && a.value && !out.includes(a.value)) out.push(String(a.value));
  }
  return out;
}

/** The key identity.js files a company's aliases under. */
const anchorKeyOf = (company) => companyKeys(company)[0] || String(company).toLowerCase();

/** Fuller names learned for a company ("Nikola Corporation"), keyed by the company's anchor key. */
function legalNamesOf(subject) {
  const out = [];
  for (const a of subject?.anchors?.aliases?.values?.() || []) {
    if (a && a.value && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(a.value))) out.push({ name: String(a.value), of: a.of });
  }
  return out;
}

/**
 * Whether the task's domain is the company's own, and which company. Returns { domain, company, how } or
 * { skip: true, note? }.
 */
export function companyDomainOf(task, subject) {
  const value = oneLine(task?.value);
  if (task?.kind !== 'domain' || !value) return { skip: true };
  // never an email address or a person
  if (value.includes('@') || (typeof subject?.hasName === 'function' && subject.hasName(value))) return { skip: true };
  const domain = registrableDomain(value);
  if (!domain) return { skip: true };
  const why = oneLine(task.why);
  const label = domain.split('.')[0].replace(/[^a-z0-9]/g, '');
  // The person's own site (firstlast.com) is about a person, not a company.
  if (PERSONAL.test(why) || (subject?.slugs || []).some((slug) => String(slug).replace(/[^a-z0-9]/g, '') === label)) return { skip: true };

  const companies = ownCompanies(subject);
  const legal = legalNamesOf(subject);
  // 1. a domain learned for one of the person's companies from a record tied by more than the word
  for (const a of subject?.anchors?.aliases?.values?.() || []) {
    if (a && registrableDomain(a.value) === domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(a.value))) {
      const company = companies.find((c) => anchorKeyOf(c) === String(a.of || '')) || companies[0] || String(a.of || '');
      if (company) return { domain, company, how: `the check learned ${domain} as the website of ${company} from a record tied to the person` };
    }
  }
  const shared = SHARED_MAIL.has(domain) || !companyDomainFromUrl(domain);
  // 2. the domain's name is the company's name (or a learned legal name of it)
  for (const company of companies) {
    const key = companyKeyStrict(company);
    const names = [company, ...legal.filter((l) => l.of === anchorKeyOf(company)).map((l) => l.name)];
    if (!names.some((n) => labelFits(label, n))) continue;
    const ordinary = !/\s/.test(key) && isOrdinaryWordCompany(company);
    // A domain everybody uses is the company's only when the company is that service itself, named distinctively.
    if (ordinary && !COMPANY_WEBSITE.test(why)) {
      return { skip: true, note: `Infostealer exposure was not looked up for ${domain}: "${company}" is an ordinary word, and nothing yet shows that ${domain} is this company's website.` };
    }
    if (shared && ordinary) return { skip: true };
    return { domain, company, how: COMPANY_WEBSITE.test(why) ? `${domain} is the website of ${company}` : `the domain ${domain} carries the name of ${company}` };
  }
  if (shared) return { skip: true };
  // 3. the website the user typed for the company
  if (GIVEN_WEBSITE.test(why)) return { domain, company: companies[0] || '', how: `${domain} was given as the company's website` };
  return { skip: true, note: `Infostealer exposure was not looked up for ${domain}: the check has not tied this domain to a company the person founded or runs.` };
}

/** An ISO day from the provider's timestamp, or '' (an unreadable value is reported by the caller). */
function dayOf(value) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(String(value || ''));
  if (!m) return '';
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? m[1] : '';
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * The counts and dates of one answer, and nothing else. Throws when the answer is not the shape the provider
 * has served (a missing or non-numeric count, an empty database), so a changed format is reported as a failed
 * lookup, never as "no exposure".
 * @returns {{ total, employees, users, thirdParties, databaseSize, lastEmployee, lastUser, datesUnreadable }}
 */
export function parseInfostealer(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('The infostealer lookup returned an unexpected response');
  const { total, employees, users, totalStealers } = body;
  const thirdParties = body.third_parties ?? 0;
  if (![total, employees, users, thirdParties, totalStealers].every(isCount)) throw new Error('The infostealer lookup changed its format: counts are missing');
  // The provider's database is tens of millions of computers: an empty one means the lookup did not really answer.
  if (totalStealers === 0) throw new Error('The infostealer lookup answered with an empty database');
  if (employees + users + thirdParties > 0 && total === 0) throw new Error('The infostealer lookup changed its format: counts do not add up');
  const raw = { lastEmployee: body.last_employee_compromised, lastUser: body.last_user_compromised };
  const lastEmployee = dayOf(raw.lastEmployee);
  const lastUser = dayOf(raw.lastUser);
  const datesUnreadable = (raw.lastEmployee != null && raw.lastEmployee !== '' && !lastEmployee) || (raw.lastUser != null && raw.lastUser !== '' && !lastUser);
  return { total: Math.max(total, employees + users + thirdParties), employees, users, thirdParties, databaseSize: totalStealers, lastEmployee, lastUser, datesUnreadable };
}

/** One lookup, cached for a day per domain; `asOf` is set when an older copy stood in for a failed refresh. */
async function lookup(domain, deadline) {
  const entry = await cachedEntry(`${CACHE_PREFIX}${domain}`, DAY_MS, async ({ deadline: loadDeadline } = {}) => {
    const body = await getJson(`${ENDPOINT}?domain=${encodeURIComponent(domain)}`, { deadline: loadDeadline, timeoutMs: 12000, maxBytes: MAX_BYTES });
    return parseInfostealer(body);
  }, { deadline });
  return { counts: entry.value, asOf: entry.fresh ? '' : new Date(entry.at).toISOString().slice(0, 10) };
}

export const infostealerExposureConnector = {
  id: INFOSTEALER_ID,
  label: LABEL,
  kinds: ['domain'],
  prior: 0.25,
  timeoutMs: 15000,
  enabled: () => switchedOn() && !switchedOff(),
  unavailableReason: 'Infostealer exposure of company domains is not enabled on this deployment.',
  async run(task, ctx) {
    const target = companyDomainOf(task, ctx?.subject);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    const { domain, company, how } = target;
    const { counts, asOf } = await lookup(domain, ctx.deadline);
    const notes = asOf ? [`Hudson Rock could not be reached; its answer of ${asOf} for ${domain} was used.`] : [];
    const partial = counts.datesUnreadable ? [`Hudson Rock infostealer lookup for ${domain} (dates of the latest infections unreadable)`] : [];
    if (counts.datesUnreadable) notes.push(`Hudson Rock's dates of the most recent infections for ${domain} could not be read; the counts were kept.`);
    if (counts.total === 0) {
      notes.push(`Hudson Rock's infostealer lookup was searched for ${domain}: no infected computer in its database of about ${count(counts.databaseSize)} held logins for this domain. Its database does not cover every infection, so this is not proof that none happened.`);
      return { findings: [], threads: [], notes, ...(partial.length ? { partial } : {}) };
    }

    const parts = [plural(counts.employees, 'employee computer', 'employee computers'), plural(counts.users, 'user computer', 'user computers')];
    if (counts.thirdParties) parts.push(plural(counts.thirdParties, 'third-party computer', 'third-party computers'));
    const recency = [
      counts.lastEmployee && counts.employees ? `the most recent with an employee login on ${counts.lastEmployee}` : '',
      counts.lastUser && counts.users ? `the most recent with a user login on ${counts.lastUser}` : '',
    ].filter(Boolean);
    const latest = [counts.employees ? counts.lastEmployee : '', counts.users ? counts.lastUser : ''].filter(Boolean).sort().pop() || '';
    const quote = [
      `Hudson Rock estimates that ${parts.join(', ')} infected by infostealer malware held logins for ${domain} (${count(counts.total)} in all, an aggregate count from a database of about ${count(counts.databaseSize)} infected computers).`,
      recency.length ? `It dates ${recency.join(' and ')}.` : 'It gives no date for the most recent infection.',
      'Employees are people logging in to the company\'s own systems; users are customers logging in to its site. No login, address or computer is shown.',
    ].join(' ');
    const finding = makeFinding(ctx.subject, {
      source: INFOSTEALER_ID, sourceLabel: SOURCE_LABEL, category: CATEGORY,
      title: `${domain}: ${count(counts.employees)} employee and ${count(counts.users)} user computers infected by infostealer malware held logins for this domain (provider's estimate, aggregate count)`,
      quote,
      url: TOOL_PAGE,
      date: latest || undefined,
      severity: counts.employees > 0 ? 'medium' : 'low',
      match: 'company',
      matchReasons: [how, 'a count for the company\'s domain, not a record about the person'],
      data: {
        organisation: company || null,
        domain,
        infectedComputers: counts.total,
        employees: counts.employees,
        users: counts.users,
        thirdParties: counts.thirdParties,
        lastEmployeeInfection: counts.employees ? (counts.lastEmployee || null) : null,
        lastUserInfection: counts.users ? (counts.lastUser || null) : null,
        databaseSize: counts.databaseSize,
        status: "provider's estimate",
        ...(latest ? {} : { excludeFromTimeline: true }),
      },
    });
    return { findings: [finding].filter(Boolean), threads: [], notes, ...(partial.length ? { partial } : {}) };
  },
};
