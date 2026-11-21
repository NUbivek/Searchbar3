/**
 * US product safety recalls filed by the founder's company. Two sources, one
 * per agency, so each is reported (answered, failed, not run) on its own.
 * Both work on company threads only: a recall is a record about a company,
 * never about a person.
 *
 *   nhtsaRecallsConnector  vehicle and vehicle-equipment recalls filed with
 *                          the National Highway Traffic Safety Administration,
 *                          from the US Department of Transportation's open data
 *                          (the NHTSA recalls dataset on datahub.transportation.gov,
 *                          a documented public data service; public domain).
 *                          NHTSA's own recall service has no search by
 *                          manufacturer.
 *   cpscRecallsConnector   consumer product recalls announced by the Consumer
 *                          Product Safety Commission (its public recalls
 *                          service on saferproducts.gov; public domain).
 *
 * Matching. Both services search broadly (any manufacturer whose name contains
 * the words; any recall title containing them), so a record is kept only when
 * the firm named in it is the company once the legal form is set aside
 * ("Nikola Corporation" is Nikola; "Nikola Motor Works" is not). The firm is the
 * NHTSA manufacturer; for CPSC, the firm the title names ("Peloton Recalls ...",
 * "... Recalled by Werner") or a listed manufacturer, importer or distributor
 * (retailers that only sold the product never count). The company is searched
 * and matched under every known name (the name typed and the legal names the
 * check learned). A record is marked 'company': it is about the company, not
 * the person. A company named with one ordinary word (Apple, Flow, Square, as
 * names.isOrdinaryWordCompany says) is shared by unrelated firms, and nothing
 * in a recall ties one of them to the subject's company: such a record stays
 * 'possible', worded "verify it is the same company". No record here is
 * graded 'confirmed' or 'likely' by hand.
 *
 * Privacy. NHTSA's corrective-action text (it carries customer-service phone
 * numbers) is never requested. CPSC's consumer-contact text, images, injury
 * accounts and retailer lines are never read, and the city after a firm's name
 * ("Peloton Interactive Inc., of New York") is cut.
 *
 * Failures. A service that does not answer, answers with something other than
 * a list of recalls, or whose records have lost the fields this file reads,
 * throws: the lookup is reported as failed, never as "no recall". A lookup
 * that answered for one known name and failed for another returns `partial`.
 * Each search is cached for a day; when a search fails and an older answer
 * stands in for it, the lookup is marked partial with that answer's date.
 *
 * A firm registered as the company's whole name plus general words
 * ("Rivian Automotive, LLC", "Lucid USA, Inc." for Rivian and Lucid) is kept
 * as 'possible' with "verify it is the same company": dropping it would report
 * "no recall" for a company whose legal name the check has not learned.
 */
import { getJson, HttpError } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { companyKeyStrict, isOrdinaryWordCompany } from '../names';
import { isSensitive } from '../guardrails';
import { companyNames } from './sanctions';
import { whichName, extendedName, extendedGrade } from './government';

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ helpers */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const uniq = (list) => [...new Set(list.filter(Boolean))];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${count(n)} ${Number(n) === 1 ? one : many}`;
const yearOf = (d) => (String(d || '').match(/^(\d{4})/) || [])[1] || '';
const dayOf = (d) => (String(d || '').match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
const span = (years) => {
  const ys = uniq(years.map(String)).filter((y) => /^\d{4}$/.test(y)).sort();
  if (!ys.length) return '';
  return ys[0] === ys[ys.length - 1] ? ys[0] : `${ys[0]}–${ys[ys.length - 1]}`;
};
const clip = (s, n) => {
  const str = clean(s);
  if (str.length <= n) return str;
  const cut = str.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '')}…`;
};
/** A sentence ends with one full stop. */
const sentence = (s) => (s ? `${clean(s).replace(/[.\s]+$/, '')}.` : '');
/** A line that would touch on a person's health is left out of the quote. */
const safe = (s) => (isSensitive(s) ? '' : s);
/** The words a search for the company uses: the name without its legal form, punctuation kept ("Fisher-Price"). */
const LEGAL_END = /[,\s]+(?:inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|pbc|lp|llp)\.?\s*$/i;
const searchName = (name) => clean(clean(name).replace(LEGAL_END, '').replace(LEGAL_END, ''));

/**
 * How a record whose firm is one of the company's names is graded. A name of one ordinary word (as the shared
 * matcher decides) is held at 'possible' with a "verify" wording; any other name is the company.
 */
export function recallGrade(name, reason) {
  if (isOrdinaryWordCompany(name)) {
    return { match: 'possible', matchReasons: [`${reason}; but ${clean(name)} is an ordinary word many unrelated companies use as a name, so verify it is the same company`] };
  }
  return { match: 'company', matchReasons: [reason] };
}

/**
 * Records grouped by the known name their firm is (each firm tried in turn): one finding per known name. A firm
 * registered as the company's whole name plus general words ("Rivian Automotive, LLC" for Rivian, the usual case
 * for a young company whose legal name the check has not learned) is kept in its own group marked `extended`,
 * graded as a name match to verify, and never listed among other manufacturers.
 */
export function byKnownName(rows, firmsOf, names) {
  const groups = new Map();
  const others = new Set();
  for (const r of rows) {
    const firms = firmsOf(r);
    let hit = null;
    for (const firm of firms) {
      const known = whichName(firm, names);
      if (known) { hit = { known, firm, extended: false }; break; }
    }
    if (!hit) {
      for (const firm of firms) {
        const known = extendedName(firm, names);
        if (known) { hit = { known, firm, extended: true }; break; }
      }
    }
    if (!hit) { if (firms[0]) others.add(firms[0]); continue; }
    const id = `${hit.extended ? 'extended' : 'same'}\u0000${hit.known}`;
    if (!groups.has(id)) groups.set(id, { known: hit.known, extended: hit.extended, rows: [] });
    groups.get(id).rows.push({ row: r, firm: hit.firm });
  }
  return { groups: [...groups.values()], others: [...others] };
}

/** The grade of one group: the company's own name (recallGrade), or a longer firm name to verify. */
const groupGrade = (group, firm, reason) => (group.extended ? extendedGrade(group.known, firm, reason) : recallGrade(group.known, reason));

/**
 * The date of a cached answer that stands in for a search that failed today, or '' when the answer is fresh. A
 * stale "no recall" must never read as today's answer.
 */
const staleDate = (entry) => (entry && entry.fresh === false ? new Date(entry.at).toISOString().slice(0, 10) : '');

/**
 * The open-data host publishes "Crawl-delay: 1"; the shared client's default spacing is shorter, so each request
 * to it waits its turn here first. The CPSC host gets the same one-second spacing.
 */
const HOST_GAP_MS = { 'datahub.transportation.gov': 1100, 'www.saferproducts.gov': 1100 };
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
export function __resetRecallsForTests({ unpaced = true } = {}) {
  pacing = !unpaced;
  nextSlot.clear();
}

async function fetchJson(url, deadline, timeoutMs = 15000) {
  await waitTurn(url, deadline);
  return getJson(url, { deadline, timeoutMs, maxBytes: 2 * 1024 * 1024 });
}

/** Ask once per known name; a failure for one name is partial, a failure for every name is a failure. */
async function searchAll(names, search) {
  const answers = [];
  const failed = [];
  let lastError = null;
  for (const name of names) {
    try {
      answers.push({ name, rows: await search(name) });
    } catch (error) {
      failed.push(name);
      lastError = error;
    }
  }
  if (!answers.length) throw lastError || new HttpError('No search could be run', { url: '' });
  return { answers, failed };
}

/* ------------------------------------------------------------------ 1. NHTSA vehicle recalls */

const NH_ID = 'nhtsa-recalls';
const NH_LABEL = 'US vehicle safety recalls (NHTSA)';
const NH_BASE = 'https://datahub.transportation.gov/resource/6axg-epim.json';
const NH_SITE = 'https://www.nhtsa.gov/recalls';
const NH_LIMIT = 200;
// The fields read. corrective_action (customer-service phone numbers) is never requested.
const NH_FIELDS = ['report_received_date', 'nhtsa_id', 'recall_link', 'manufacturer', 'subject', 'component', 'recall_type', 'potentially_affected', 'consequence_summary', 'fire_risk_when_parked', 'do_not_drive'];

/** SoQL: '%NIKOLA%' for Nikola, '%FISHER%PRICE%' for Fisher-Price; quotes and wildcards removed from the name. */
export function nhtsaLike(name) {
  const words = searchName(name).toUpperCase().replace(/[%_'"\\]/g, ' ').split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
  return words.length ? `%${words.join('%')}%` : '';
}

async function nhtsaSearch(name, deadline) {
  const like = nhtsaLike(name);
  if (!like) return { rows: [], cut: false };
  // Spaces written as %20, the form the data service documents
  const params = Object.entries({
    $select: NH_FIELDS.join(','),
    $where: `upper(manufacturer) like '${like}'`,
    $order: 'report_received_date DESC',
    $limit: String(NH_LIMIT),
  }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `${NH_BASE}?${params}`;
  const entry = await cachedEntry(`recalls:nhtsa:v1:${like}`, DAY_MS, async ({ deadline: d }) => {
    const body = await fetchJson(url, d);
    if (!Array.isArray(body)) throw new HttpError('The NHTSA recalls data returned an unexpected answer', { url });
    if (body.length && !body.some((r) => r && r.nhtsa_id && r.manufacturer)) throw new HttpError('The NHTSA recalls data has changed format (no recall numbers or manufacturers)', { url });
    // Kept compact: only what a finding quotes
    const rows = body.filter((r) => r && r.nhtsa_id && r.manufacturer).map((r) => ({
      id: clean(r.nhtsa_id),
      date: dayOf(r.report_received_date),
      link: clean(r.recall_link?.url),
      manufacturer: clean(r.manufacturer),
      subject: clip(r.subject, 160),
      component: clip(r.component, 80),
      type: clean(r.recall_type),
      units: Number(String(r.potentially_affected || '').replace(/[^\d]/g, '')) || 0,
      consequence: clip(r.consequence_summary, 240),
      fireParked: /^yes$/i.test(clean(r.fire_risk_when_parked)),
      doNotDrive: /^yes$/i.test(clean(r.do_not_drive)),
    }));
    return { rows, cut: body.length >= NH_LIMIT };
  }, { deadline });
  return { ...entry.value, stale: staleDate(entry) };
}

const nhtsaUrl = (r) => (/^https:\/\/www\.nhtsa\.gov\//.test(r.link) ? r.link : `${NH_SITE}?nhtsaId=${encodeURIComponent(r.id)}`);

export const nhtsaRecallsConnector = {
  id: NH_ID,
  label: NH_LABEL,
  kinds: ['company'],
  prior: 0.12,
  timeoutMs: 25000,
  async run(task, ctx) {
    const company = clean(task.value);
    const known = companyNames(ctx?.subject, company, 2);
    const { answers, failed } = await searchAll(known, async (name) => nhtsaSearch(name, ctx.deadline));
    const seen = new Set();
    const rows = [];
    for (const a of answers) for (const r of a.rows.rows) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    const { groups, others } = byKnownName(rows, (r) => [r.manufacturer], known);
    const findings = [];
    for (const group of groups) {
      const { known: as, rows: own } = group;
      const list = own.map((x) => x.row).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const firm = list[0].manufacturer;
      const units = list.reduce((sum, r) => sum + r.units, 0);
      const years = list.map((r) => yearOf(r.date));
      const urgent = list.filter((r) => r.doNotDrive || r.fireParked);
      const fire = list.filter((r) => /\bfire\b/i.test(r.consequence));
      const lines = list.slice(0, 3).map((r) => {
        const consequence = safe(r.consequence);
        return sentence(`${r.date || 'Undated'}, recall ${r.id}${r.component ? ` (${r.component.toLowerCase()})` : ''}: ${r.subject}${r.units ? `, ${count(r.units)} potentially affected` : ''}`)
          + (consequence ? ` ${sentence(consequence)}` : '');
      });
      const quote = sentence(`${firm}: ${plural(list.length, 'recall')} filed with NHTSA ${span(years)}${units ? `, about ${count(units)} vehicles or parts potentially affected` : ''}`)
        + (urgent.length ? ` ${sentence(`${count(urgent.length)} carried a do-not-drive or park-outside warning`)}` : '')
        + ` ${lines.join(' ')}`;
      const f = makeFinding(ctx.subject, {
        source: NH_ID, sourceLabel: NH_LABEL, category: 'regulatory',
        title: `${plural(list.length, 'vehicle safety recall')} by ${firm}, ${span(years)}`,
        quote: clean(quote), url: nhtsaUrl(list[0]), date: list[0].date || null,
        severity: urgent.length ? 'high' : (fire.length ? 'medium' : 'low'),
        ...groupGrade(group, firm, `recall manufacturer ${firm} ${group.extended ? 'begins with' : 'is'} ${as}`),
        data: { manufacturer: firm, recalls: list.length, units, recallNumbers: list.slice(0, 10).map((r) => r.id), urgent: urgent.length },
      });
      if (f) findings.push(f);
    }
    const notes = [];
    const cut = answers.filter((a) => a.rows.cut).map((a) => a.name);
    const stale = answers.filter((a) => a.rows.stale);
    for (const a of stale) notes.push(`NHTSA's vehicle recall records could not be searched again for ${a.name}, so the answer of ${a.rows.stale} was used.`);
    if (!findings.length) notes.push(`NHTSA's vehicle recall records were searched for a manufacturer named ${known.join(' or ')}; no recall filed under that name was found.`);
    if (others.length) notes.push(`Recalls by other manufacturers whose names contain the same words (${others.slice(0, 3).join(', ')}${others.length > 3 ? ', and others' : ''}) were left out.`);
    const partial = [
      ...failed.map((n) => `NHTSA vehicle recalls (the search for ${n} did not answer)`),
      ...cut.map((n) => `NHTSA vehicle recalls (the latest ${NH_LIMIT} recalls by manufacturers named like ${n} were read)`),
      ...stale.map((a) => `NHTSA vehicle recalls (the search for ${a.name} as of ${a.rows.stale})`),
    ];
    return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 2. CPSC consumer product recalls */

const CP_ID = 'cpsc-recalls';
const CP_LABEL = 'US consumer product recalls (CPSC)';
const CP_BASE = 'https://www.saferproducts.gov/RestWebServices/Recall';
const CP_SITE = 'https://www.cpsc.gov/Recalls';

/** "Peloton Interactive Inc., of New York, N.Y." -> "Peloton Interactive Inc.": the firm's city is cut. */
export function firmName(raw) {
  return clean(String(raw || '')
    .replace(/,\s*of\s+[A-Z][\s\S]*$/, '')
    .replace(/(\b(?:inc|llc|ltd|corp|co|company|corporation)\.?)\s+of\s+[A-Z][\s\S]*$/i, '$1')
    .replace(/[,;\s]+$/, ''));
}

/** The firms a recall title names: "Peloton Recalls ...", "Fisher-Price and Mattel Recall ...", "... Recalled by Werner". */
export function titleFirms(title) {
  const t = clean(title);
  const out = [];
  const lead = t.match(/^(.{2,120}?)\s+(?:Announce\s+)?Recalls?\b/);
  if (lead && !/^recall/i.test(lead[1])) {
    out.push(lead[1]);
    out.push(...lead[1].split(/\s*,\s*|\s+and\s+|\s*&\s*/).filter((p) => p && p !== lead[1]));
  }
  const by = t.match(/\bRecalled\s+by\s+(.{2,120}?)(?:\s+Due\s+to\b|\s*[;(]|$)/i);
  if (by) out.push(by[1]);
  return uniq(out.map(firmName));
}

const cpscFirms = (r) => uniq([
  ...titleFirms(r.title),
  ...r.makers,
]);

async function cpscQuery(param, name, deadline) {
  const url = `${CP_BASE}?${new URLSearchParams({ format: 'json', [param]: name })}`;
  // The service can take 15 seconds or more to answer a manufacturer search
  const body = await fetchJson(url, deadline, 30000);
  if (!Array.isArray(body)) throw new HttpError('The CPSC recalls service returned an unexpected answer', { url });
  // A busy service answers with one pseudo-record whose title is its error ("Error retrieving Recalls: ...")
  if (body.some((r) => r && !r.RecallNumber && !r.RecallID && /^error\b/i.test(clean(r.Title)))) throw new HttpError('The CPSC recalls service reported an error', { url, retryable: true });
  if (body.length && !body.some((r) => r && (r.RecallNumber || r.RecallID) && r.Title)) throw new HttpError('The CPSC recalls service has changed format (no recall numbers or titles)', { url });
  const names = (list) => (Array.isArray(list) ? list.map((x) => firmName(x?.Name)).filter(Boolean) : []);
  // Kept compact. Never read: ConsumerContact (phone numbers), Images, Injuries (accounts of what happened to people), Retailers.
  return body.filter((r) => r && (r.RecallNumber || r.RecallID) && r.Title).map((r) => ({
    id: clean(r.RecallNumber || r.RecallID),
    date: dayOf(r.RecallDate),
    title: clip(r.Title, 220),
    url: clean(r.URL),
    makers: uniq([...names(r.Manufacturers), ...names(r.Importers), ...names(r.Distributors)]).slice(0, 6),
    units: uniq((Array.isArray(r.Products) ? r.Products : []).map((p) => clip(p?.NumberOfUnits, 80))).slice(0, 2),
    hazard: clip((Array.isArray(r.Hazards) ? r.Hazards : []).map((h) => clean(h?.Name)).filter(Boolean)[0] || '', 220),
  }));
}

// The title search finds recalls the firm announced; the manufacturer search finds the rest (its field is often empty)
const CP_SEARCHES = [{ param: 'RecallTitle', what: 'recall title search' }, { param: 'Manufacturer', what: 'manufacturer search' }];

/**
 * Both searches for one name, each cached for the day on its own. The manufacturer search can be slow to answer:
 * when one of the two fails the other's recalls are kept and the failure is named; when both fail, the error is thrown.
 */
async function cpscSearch(name, deadline) {
  const term = searchName(name);
  if (term.length < 2) return { rows: [], failed: [], stale: [] };
  const rows = [];
  const failed = [];
  const stale = [];
  let lastError = null;
  for (const s of CP_SEARCHES) {
    try {
      const entry = await cachedEntry(`recalls:cpsc:v1:${s.param}:${term.toLowerCase()}`, DAY_MS, ({ deadline: d }) => cpscQuery(s.param, term, d), { deadline, loadMs: 40000 });
      rows.push(...entry.value);
      const when = staleDate(entry);
      if (when) stale.push({ what: s.what, when });
    } catch (error) {
      failed.push(s.what);
      lastError = error;
    }
  }
  if (failed.length === CP_SEARCHES.length) throw lastError;
  const seen = new Set();
  return { rows: rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))), failed, stale };
}

const cpscUrl = (r) => (/^https:\/\/(?:www\.)?cpsc\.gov\//.test(r.url) ? r.url : CP_SITE);
const SERIOUS = /\b(death|deaths|died|fatal|fire|burn|electrocution|electric shock|strangulation|suffocation|poisoning)\b/i;

export const cpscRecallsConnector = {
  id: CP_ID,
  label: CP_LABEL,
  kinds: ['company'],
  prior: 0.12,
  timeoutMs: 45000,
  async run(task, ctx) {
    const company = clean(task.value);
    const known = companyNames(ctx?.subject, company, 2);
    const { answers, failed } = await searchAll(known, async (name) => cpscSearch(name, ctx.deadline));
    const seen = new Set();
    const rows = [];
    for (const a of answers) for (const r of a.rows.rows) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    const { groups, others } = byKnownName(rows, cpscFirms, known);
    const findings = [];
    for (const group of groups) {
      const { known: as, rows: own } = group;
      own.sort((a, b) => String(b.row.date).localeCompare(String(a.row.date)));
      const list = own.map((x) => x.row);
      const firm = own[0].firm;
      const years = list.map((r) => yearOf(r.date));
      const serious = list.filter((r) => SERIOUS.test(`${r.title} ${r.hazard}`));
      // Each recall its own sentences, so a line the privacy rules remove takes nothing else with it
      const lines = list.slice(0, 3).map((r) => {
        const hazard = safe(r.hazard);
        return sentence(`${r.date || 'Undated'}, recall ${r.id}: ${r.title}${r.units.length ? ` (${r.units.join('; ')})` : ''}`)
          + (hazard ? ` ${sentence(`Hazard: ${hazard}`)}` : '');
      });
      const quote = `${sentence(`${firm}: ${plural(list.length, 'consumer product recall')} announced with the CPSC ${span(years)}`)} ${lines.join(' ')}`;
      const f = makeFinding(ctx.subject, {
        source: CP_ID, sourceLabel: CP_LABEL, category: 'regulatory',
        title: `${plural(list.length, 'consumer product recall')} by ${firm}, ${span(years)}`,
        quote: clean(quote), url: cpscUrl(list[0]), date: list[0].date || null,
        severity: serious.length ? 'medium' : 'low',
        ...groupGrade(group, firm, `recalling firm ${firm} ${group.extended ? 'begins with' : 'is'} ${as}`),
        data: { firm, recalls: list.length, recallNumbers: list.slice(0, 10).map((r) => r.id) },
      });
      if (f) findings.push(f);
    }
    const notes = [];
    if (!findings.length) notes.push(`CPSC recall notices were searched for recalls announced by, or listing as maker, importer or distributor, a firm named ${known.join(' or ')}; none was found.`);
    if (others.length) notes.push(`Recalls whose titles carry the same words but name another firm (${others.slice(0, 3).join(', ')}${others.length > 3 ? ', and others' : ''}) were left out.`);
    const partial = [
      ...failed.map((n) => `CPSC product recalls (the search for ${n} did not answer)`),
      ...answers.flatMap((a) => a.rows.failed.map((what) => `CPSC product recalls (the ${what} for ${a.name} did not answer)`)),
      ...answers.flatMap((a) => (a.rows.stale || []).map((x) => `CPSC product recalls (the ${x.what} for ${a.name} as of ${x.when})`)),
    ];
    for (const a of answers) for (const x of a.rows.stale || []) notes.push(`The CPSC ${x.what} for ${a.name} could not be run again, so its answer of ${x.when} was used.`);
    return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
  },
};

export const RECALL_CONNECTORS = [nhtsaRecallsConnector, cpscRecallsConnector];
