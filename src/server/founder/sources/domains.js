/**
 * Domain history: how old a web domain is and whether it is still in use,
 * from records the company does not write itself.
 *
 *   registration record   when the domain was registered, last changed and
 *                         when it expires (RDAP, the registries' own lookup)
 *   web archive           first and last capture of the home page and
 *                         captures per year (Internet Archive)
 *
 * Certificate transparency logs are not searched: the public log search
 * (crt.sh) asks automated readers to stay away in its robots.txt.
 *
 * How to read it: a domain is often older than the company (bought from an
 * earlier owner) and the first archive capture is when the crawler found the
 * site, not the founding date. The dates are shown side by side; they are
 * flagged against a founding year only when one is known for this domain's
 * company (task.params.foundedYear, or a tied record naming the domain). A
 * domain registered years before the founding is labelled as registered by
 * an earlier holder and kept off the timeline.
 *
 * Privacy: registration records can hold the registrant's name, address,
 * phone and email. Only the event dates, status flags and name-server hosts
 * are read; the contact block ("entities") is never touched.
 *
 * FOUNDER_SOURCES_OFF (comma-separated ids) switches off 'domain-history'.
 */
import { getJson } from '../http';
import { makeFinding } from '../finding';

const switchedOff = (id) => String(process.env.FOUNDER_SOURCES_OFF || '').split(',').map((s) => s.trim()).filter(Boolean).includes(id);

const day = (value) => {
  const s = String(value || '');
  if (/^\d{14}$/.test(s) || /^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; // web-archive timestamps
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const count = (n) => Number(n).toLocaleString('en-US');

// Country endings where the registrable name has three labels ("acme.co.uk").
const TWO_LEVEL_ENDINGS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr',
  'co.in', 'net.in', 'org.in', 'com.br', 'com.mx', 'com.ar', 'com.co', 'com.sg', 'com.hk', 'com.tw', 'com.cn', 'net.cn', 'org.cn', 'com.tr', 'co.za',
  'co.il', 'com.ua', 'com.pl', 'com.ng', 'co.ke', 'com.my', 'com.ph', 'co.th', 'com.vn', 'co.id', 'com.sa', 'com.eg', 'com.pk', 'com.bd', 'com.pe', 'com.es',
]);
// Hosts where the page belongs to someone else's platform: a profile, a listing, a hosted site. Not a company's own domain.
const SHARED_HOSTS = new Set([
  'linkedin.com', 'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 't.co', 'threads.net', 'tiktok.com', 'youtube.com', 'youtu.be', 'vimeo.com',
  'github.com', 'github.io', 'gitlab.com', 'gitlab.io', 'bitbucket.org', 'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com', 'tumblr.com', 'wixsite.com',
  'squarespace.com', 'webflow.io', 'notion.site', 'notion.so', 'carrd.co', 'linktr.ee', 'bit.ly', 'about.me', 'vercel.app', 'netlify.app', 'herokuapp.com',
  'pages.dev', 'web.app', 'firebaseapp.com', 'myshopify.com', 'crunchbase.com', 'pitchbook.com', 'angel.co', 'wellfound.com', 'ycombinator.com', 'producthunt.com',
  'wikipedia.org', 'wikidata.org', 'archive.org', 'sec.gov', 'bloomberg.com', 'reddit.com', 'discord.gg', 'discord.com', 'telegram.me', 't.me', 'whatsapp.com',
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com',
  'sites.google.com', 'docs.google.com', 'drive.google.com', 'play.google.com', 'apps.apple.com', 'podcasts.apple.com', 'goo.gl', 'forms.gle',
]);

/**
 * The registrable domain behind a web address, or null when the address is
 * not a company's own site (a social profile, a hosted page, an email
 * address, an IP). "https://www.Theranos.com/about" -> "theranos.com";
 * "blog.acme.co.uk" -> "acme.co.uk"; "https://linkedin.com/company/acme" -> null.
 */
export function companyDomainFromUrl(url) {
  const raw = String(url || '').trim().toLowerCase();
  if (!raw || /\s/.test(raw)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw);
  if (!hasScheme && raw.includes('@')) return null; // an email address is not a web address
  let host;
  try { host = new URL(hasScheme ? raw : `https://${raw}`).hostname; } catch { return null; }
  host = host.replace(/\.$/, '').replace(/^www\d?\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || !/\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(host)) return null;
  const labels = host.split('.');
  const take = TWO_LEVEL_ENDINGS.has(labels.slice(-2).join('.')) ? 3 : 2;
  if (labels.length < take) return null;
  const domain = labels.slice(-take).join('.');
  if (labels.some((label, i) => SHARED_HOSTS.has(labels.slice(i).join('.')))) return null; // the host, or any parent of it, is a shared platform
  return domain;
}

/** Captures of the home page: first, last, per year. Null when the archive holds none. */
async function archiveCaptures(domain, deadline) {
  let data;
  try {
    data = await getJson(`https://web.archive.org/__wb/sparkline?output=json&url=${encodeURIComponent(domain)}&collection=web`, { deadline, timeoutMs: 9000 });
    if (!data || typeof data !== 'object' || typeof data.years !== 'object') throw new Error('Unexpected answer from the web archive');
  } catch (error) {
    // The capture summary is what the archive's own calendar page uses; if it is unavailable, ask the index for the first capture only.
    let rows;
    try {
      rows = await getJson(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp,original,statuscode&filter=statuscode:200`, { deadline, timeoutMs: 9000, retries: 0 });
    } catch { throw error; }
    const first = Array.isArray(rows) && Array.isArray(rows[1]) ? day(rows[1][0]) : null;
    return first ? { first, last: null, total: null, byYear: {}, lastTwelveMonths: null } : null;
  }
  const first = day(data.first_ts);
  if (!first) return null;
  const byYear = {};
  let total = 0;
  let lastTwelveMonths = 0;
  const now = new Date();
  const monthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  for (const [year, months] of Object.entries(data.years || {})) {
    if (!/^\d{4}$/.test(year) || !Array.isArray(months)) continue;
    const sum = months.reduce((a, b) => a + (Number(b) || 0), 0);
    if (sum > 0) byYear[year] = sum;
    total += sum;
    months.forEach((n, m) => { const age = monthIndex - (Number(year) * 12 + m); if (age >= 0 && age < 12) lastTwelveMonths += Number(n) || 0; });
  }
  return { first, last: day(data.last_ts), total, byYear, lastTwelveMonths };
}

const PARKING_HOSTS = ['sedoparking.com', 'parkingcrew.net', 'bodis.com', 'afternic.com', 'dan.com', 'above.com', 'hugedomains.com', 'parklogic.com', 'domainmarket.com', 'uniregistrymarket.link', 'undeveloped.com'];

/**
 * Dates and status from the registration record. Null when no record is
 * published (the domain is not registered, or its registry has no lookup).
 * The record's `entities` (registrant, admin and technical contacts) are
 * deliberately never read.
 */
async function registrationRecord(domain, deadline) {
  let data;
  try {
    data = await getJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { accept: 'application/rdap+json, application/json', deadline, timeoutMs: 8000 });
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
  if (!data || typeof data !== 'object') throw new Error('Unexpected answer from the domain registry');
  const event = (action) => day((Array.isArray(data.events) ? data.events : []).find((e) => String(e?.eventAction || '').toLowerCase() === action)?.eventDate);
  const nameServers = (Array.isArray(data.nameservers) ? data.nameservers : []).map((n) => String(n?.ldhName || '').toLowerCase()).filter(Boolean);
  return {
    registered: event('registration'),
    changed: event('last changed'),
    transferred: event('transfer'),
    expires: event('expiration'),
    status: (Array.isArray(data.status) ? data.status : []).map((s) => String(s).toLowerCase()).slice(0, 12),
    parkedAt: PARKING_HOSTS.find((p) => nameServers.some((n) => n === p || n.endsWith(`.${p}`))) || null,
  };
}

/**
 * The founding year of the company behind this domain, when known: given with the task or the subject, or read
 * from a tied record that names this very domain (the Y Combinator directory lists each company's website). A
 * founding year of another company of the person (an earlier start-up) must never be compared, so records that do
 * not name the domain are not used. Null when unknown.
 */
export function foundingYearFor(domain, task, ctx) {
  const given = Number(task?.params?.foundedYear ?? ctx?.subject?.foundedYear);
  if (Number.isInteger(given) && given > 1800) return { year: given, from: 'given' };
  let findings = [];
  try { findings = typeof ctx?.findings === 'function' ? ctx.findings() || [] : []; } catch { findings = []; }
  const years = [];
  for (const f of findings) {
    if (!f || f.match === 'possible' || !f.data) continue;
    const site = companyDomainFromUrl(f.data.website || f.data.domain || '');
    const year = Number(f.data.yearFounded ?? f.data.foundedYear);
    if (site === domain && Number.isInteger(year) && year > 1800) years.push({ year, from: f.id || f.source });
  }
  return years.sort((a, b) => a.year - b.year)[0] || null;
}

export const domainHistoryConnector = {
  id: 'domain-history',
  label: 'Domain history (registration record and web archive)',
  kinds: ['domain'],
  prior: 0.5,
  timeoutMs: 15000,
  enabled: () => !switchedOff('domain-history'),
  unavailableReason: 'Domain history is not enabled on this deployment.',

  async run(task, ctx) {
    const domain = companyDomainFromUrl(task?.value);
    if (!domain || (task?.kind && task.kind !== 'domain')) return { findings: [], threads: [], notes: [] };
    const deadline = ctx?.deadline || Date.now() + this.timeoutMs;
    const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
    const [archive, registration] = await Promise.all([
      settle(archiveCaptures(domain, deadline)),
      settle(registrationRecord(domain, deadline)),
    ]);
    if (archive.error && registration.error) throw archive.error;

    const notes = [];
    if (archive.error) notes.push(`The web archive did not answer for ${domain}; only the registration record is shown.`);
    if (registration.error) notes.push(`The registration record for ${domain} could not be read; the dates come from the web archive.`);
    const reg = registration.value || null;
    const web = archive.value || null;
    if (!reg?.registered && !web) {
      if (!archive.error && !registration.error) notes.push(`No registration record or archived copies were found for ${domain}.`);
      return { findings: [], threads: [], notes };
    }

    // What stands out, if anything. A founding year is compared only when one is known for this domain's company:
    // given by the caller, or read from a tied record that names this domain.
    const flags = [];
    const founding = foundingYearFor(domain, task, ctx);
    const foundedYear = founding?.year;
    let earlierHolder = false;
    if (reg?.registered && Number.isInteger(foundedYear) && foundedYear > 1980) {
      const gap = foundedYear - Number(reg.registered.slice(0, 4));
      // A domain much older than the company was registered by someone else and bought later ("ramp.com",
      // registered 1994, for a company founded in 2019): its date says nothing about the company's history.
      if (gap >= 2) {
        earlierHolder = true;
        flags.push({ text: `registered ${gap} years before the stated ${foundedYear} founding: registered by an earlier holder and acquired later`, severity: 'info' });
      }
      if (gap <= -2) flags.push({ text: `registered ${-gap} years after the stated ${foundedYear} founding`, severity: 'low' });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (reg?.expires && reg.expires < today) flags.push({ text: `registration lapsed ${reg.expires}`, severity: 'low' });
    if (reg?.status.some((s) => /hold|redemption|pending delete/.test(s))) flags.push({ text: 'registration on hold or pending deletion', severity: 'low' });
    if (reg?.parkedAt) flags.push({ text: 'pointed at a domain-parking service', severity: 'low' });

    const headline = [
      reg?.registered ? `registered ${reg.registered}` : null,
      web?.first ? `first archived ${web.first}` : archive.error ? null : 'no archived copies found',
      web?.last ? `last archived ${web.last}` : null,
      web && web.total !== null ? `${count(web.total)} ${web.total === 1 ? 'capture' : 'captures'}` : null,
    ].filter(Boolean).join('; ');
    const years = web ? Object.entries(web.byYear).map(([y, n]) => `${y}: ${count(n)}`).join(', ') : '';
    const quote = [
      reg
        ? `Registration record: ${[reg.registered ? `registered ${reg.registered}` : 'no registration date given', reg.transferred ? `transferred ${reg.transferred}` : null, reg.changed ? `last changed ${reg.changed}` : null, reg.expires ? `expires ${reg.expires}` : null].filter(Boolean).join('; ')}.`
        : registration.error ? null : 'Registration record: none published for this domain (it may be unregistered, or its registry may not offer a lookup).',
      web
        ? `Web archive: first capture ${web.first}${web.last ? `; last capture ${web.last}` : ''}${web.total !== null ? `; ${count(web.total)} captures of the home page${web.lastTwelveMonths !== null ? `, ${count(web.lastTwelveMonths)} in the last 12 months` : ''}` : ''}.`
        : archive.error ? null : 'Web archive: no captures of the home page.',
      years ? `Captures per year: ${years}.` : null,
    ].filter(Boolean).join(' ');
    const severity = flags.some((f) => f.severity === 'low') ? 'low' : 'info';

    const finding = makeFinding(ctx?.subject, {
      source: this.id, sourceLabel: this.label, category: 'corporate', severity,
      match: 'company', matchReasons: ['record about a web domain tied to the subject'],
      title: `${domain}: ${headline}${flags.length ? ` (${flags.map((f) => f.text).join('; ')})` : ''}`,
      quote,
      url: web ? `https://web.archive.org/web/*/${domain}` : `https://rdap.org/domain/${domain}`,
      date: reg?.registered || web?.first,
      data: {
        domain,
        registered: reg?.registered || null, lastChanged: reg?.changed || null, transferred: reg?.transferred || null, expires: reg?.expires || null, status: reg?.status || [],
        firstCapture: web?.first || null, lastCapture: web?.last || null, captures: web?.total ?? null, capturesByYear: web?.byYear || {}, capturesLastTwelveMonths: web?.lastTwelveMonths ?? null,
        flags: flags.map((f) => f.text),
        registrationLookup: `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(domain)}`,
        ...(Number.isInteger(foundedYear) ? { foundedYear, foundedFrom: founding.from } : {}),
        // an earlier holder's registration date is not an event in the company's history
        ...(earlierHolder ? { earlierHolder: true, excludeFromTimeline: true } : {}),
      },
    });
    return { findings: [finding].filter(Boolean), threads: [], notes };
  },
};
