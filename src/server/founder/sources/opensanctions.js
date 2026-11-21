/**
 * Watchlists, regulators' bans and debarments worldwide, read from the
 * per-list files that OpenSanctions publishes (one source, 29 lists):
 *
 *   wanted      Interpol red notices; Hong Kong ICAC, UK NCA and German BKA wanted lists
 *   mdb         the World Bank, ADB, IDB and AfDB debarment lists as each bank publishes
 *               them (short debarments too, which the EBRD list leaves out), EU EDES exclusions
 *   us-markets  FINRA disciplinary actions and barred individuals, SEC actions with
 *               distributions to harmed investors, NFA and OFAC enforcement actions, FDA
 *               clinical investigator disqualifications
 *   intl-markets ESMA national sanctions, France AMF sanctions, Swiss FINMA warnings and
 *               final rulings, Luxembourg CSSF sanctions, Dubai DFSA prohibitions, Turkey CMB
 *               bans, India NSE debarments, Brazil BCB disqualifications, Guernsey and Isle of
 *               Man disqualified directors
 *   sanctions   Australian (DFAT), Swiss (SECO) and Japanese (MOF) sanctions lists
 *
 * Each list is one file (targets.simple.csv) at a stable "latest" address. A
 * list is downloaded only when a lookup needs it, at most once a day, and only
 * a compact index is kept (name, aliases, list, reason, dates, entity link),
 * never the raw file. Before the file, the list's small metadata file is read:
 * a list the publisher reports as empty is a list that did not answer, never a
 * clean screen, and a file with far fewer entries than the metadata promises
 * is treated as broken.
 *
 * Terms: the data is CC BY-NC 4.0 (non-commercial use only) and
 * data.opensanctions.org's robots.txt disallows automated readers, while the
 * publisher's documentation invites scheduled downloads of these files. So the
 * source is OFF unless the owner names it in FOUNDER_SOURCES_ON.
 *
 * Name matching is the strict matching of the sanctions screens: a person
 * only on their first and last name in order (screenRows from debarment.js),
 * a company only on its whole name with the legal form removed. Every hit on
 * a person is 'possible' ("name match only, verify identity") unless the
 * record's own reason text also names something already tied to the person,
 * and then 'likely' at most: this source never sets 'confirmed'.
 *
 * Never read or kept: birth dates, addresses, identifiers (CRD, NPI, prison
 * register numbers), phones, emails, and the nationality of a person (a
 * country is kept for a listed company only). Reason text that touches a
 * child or a protected matter is withheld.
 *
 * Left out on purpose: the politically exposed persons file and the Medicaid
 * exclusion lists (too large), and the whole collections (they repeat lists
 * read elsewhere and are far larger than a day's cache can hold).
 */
import { request, getJson } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { isSensitive, mentionsMinor } from '../guardrails';
import { normalizeName, nameTokens, companyTokens, reasonText, screenNames, gradeListedPerson } from './sanctions';
import { withAliasHold } from './alias';
import { eachCsvRow, screenRows, personNameForms } from './debarment';

const ID = 'opensanctions-lists';
const LABEL = 'Watchlists, regulators\' bans and debarments worldwide (OpenSanctions)';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 6;
const BASE = 'https://data.opensanctions.org/datasets/latest';
const ENTITY_PAGE = 'https://www.opensanctions.org/entities/';
export const CREDIT = 'Lists as collected by OpenSanctions (CC BY-NC 4.0), from each publisher\'s own list.';
export const INTERPOL_NOTE = 'An Interpol red notice is a request by one member country to locate and arrest a person; it is not a conviction, and some notices are politically motivated.';
const REQUIRED_COLUMNS = ['id', 'schema', 'name', 'aliases', 'sanctions', 'dataset', 'first_seen', 'last_change'];

/**
 * Every list read, by group. sev: how grave a listing is; cat: report category;
 * people: true when the list holds people only (skipped for a company).
 */
export const DATASETS = [
  // wanted lists
  { id: 'interpol_red_notices', group: 'wanted', name: 'Interpol red notices', sev: 'high', cat: 'sanctions', people: true },
  { id: 'hk_icac_wanted', group: 'wanted', name: 'Hong Kong ICAC wanted persons', sev: 'high', cat: 'sanctions', people: true },
  { id: 'gb_nca_most_wanted', group: 'wanted', name: 'UK National Crime Agency most wanted', sev: 'high', cat: 'sanctions', people: true },
  { id: 'de_bka_wanted', group: 'wanted', name: 'German BKA wanted fugitives', sev: 'high', cat: 'sanctions', people: true },
  // development banks and EU exclusions
  { id: 'worldbank_debarred', group: 'mdb', name: 'World Bank debarred firms and individuals', sev: 'high', cat: 'sanctions' },
  { id: 'adb_sanctions', group: 'mdb', name: 'Asian Development Bank sanctions', sev: 'high', cat: 'sanctions' },
  { id: 'iadb_sanctions', group: 'mdb', name: 'Inter-American Development Bank sanctions', sev: 'high', cat: 'sanctions' },
  { id: 'afdb_sanctions', group: 'mdb', name: 'African Development Bank debarments', sev: 'high', cat: 'sanctions' },
  { id: 'eu_edes', group: 'mdb', name: 'EU Early Detection and Exclusion System', sev: 'high', cat: 'sanctions' },
  // US markets and agencies
  { id: 'us_finra_barred', group: 'us-markets', name: 'FINRA barred individuals', sev: 'high', cat: 'regulatory', people: true },
  { id: 'us_finra_actions', group: 'us-markets', name: 'FINRA disciplinary actions', sev: 'medium', cat: 'regulatory' },
  { id: 'us_sec_harmed_investors', group: 'us-markets', name: 'SEC actions with distributions to harmed investors', sev: 'medium', cat: 'regulatory' },
  { id: 'us_nfa_enforcement_actions', group: 'us-markets', name: 'NFA enforcement and regulatory actions', sev: 'medium', cat: 'regulatory' },
  { id: 'us_ofac_enforcement_actions', group: 'us-markets', name: 'OFAC enforcement actions', sev: 'medium', cat: 'regulatory' },
  { id: 'us_fda_restricted', group: 'us-markets', name: 'FDA clinical investigator disqualifications', sev: 'high', cat: 'regulatory', people: true },
  // markets regulators elsewhere
  { id: 'eu_esma_sanctions', group: 'intl-markets', name: 'ESMA register of national sanctions', sev: 'medium', cat: 'regulatory' },
  { id: 'fr_amf_regulatory_sanctions', group: 'intl-markets', name: 'France AMF sanctions', sev: 'medium', cat: 'regulatory' },
  { id: 'ch_finma_warnings', group: 'intl-markets', name: 'Swiss FINMA warning list', sev: 'medium', cat: 'regulatory' },
  { id: 'ch_finma_rulings', group: 'intl-markets', name: 'Swiss FINMA final rulings', sev: 'high', cat: 'regulatory' },
  { id: 'lu_administrative_sanctions', group: 'intl-markets', name: 'Luxembourg CSSF sanctions', sev: 'medium', cat: 'regulatory' },
  { id: 'ae_dfsa_prohibited', group: 'intl-markets', name: 'Dubai DFSA prohibited individuals', sev: 'high', cat: 'regulatory' },
  { id: 'tr_cmb_banned', group: 'intl-markets', name: 'Turkey Capital Markets Board trading bans', sev: 'high', cat: 'regulatory' },
  { id: 'in_nse_debarred', group: 'intl-markets', name: 'India NSE list of SEBI-debarred entities', sev: 'high', cat: 'regulatory' },
  { id: 'br_bcb_disqualified_persons', group: 'intl-markets', name: 'Brazil Central Bank disqualified persons', sev: 'high', cat: 'regulatory' },
  { id: 'gg_disqualified_directors', group: 'intl-markets', name: 'Guernsey FSC prohibitions and disqualified directors', sev: 'high', cat: 'regulatory' },
  { id: 'im_disqualified_directors', group: 'intl-markets', name: 'Isle of Man disqualified directors', sev: 'high', cat: 'regulatory' },
  // more sanctions lists
  { id: 'au_dfat_sanctions', group: 'sanctions', name: 'Australian sanctions list (DFAT)', sev: 'high', cat: 'sanctions' },
  { id: 'ch_seco_sanctions', group: 'sanctions', name: 'Swiss sanctions list (SECO)', sev: 'high', cat: 'sanctions' },
  { id: 'jp_mof_sanctions', group: 'sanctions', name: 'Japanese sanctions list (Ministry of Finance)', sev: 'high', cat: 'sanctions' },
];

export const GROUPS = [
  { key: 'wanted', why: 'screen the name against Interpol red notices and national wanted lists' },
  { key: 'mdb', why: 'screen the name against the development banks\' own debarment lists' },
  { key: 'us-markets', why: 'screen the name against FINRA, SEC, NFA, OFAC and FDA actions and bars' },
  { key: 'intl-markets', why: 'screen the name against markets regulators\' sanctions outside the US' },
  { key: 'sanctions', why: 'screen the name against the Australian, Swiss and Japanese sanctions lists' },
];
const ALL = 'os.all';

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
const isLatin = (name) => normalizeName(name).length >= 2;
const isFullName = (tokens) => tokens.filter((t) => t.length > 1).length >= 2;
/** A field the file wrote as a quoted empty string ('""') or wrapped in stray quotes. */
const unquote = (s) => oneLine(String(s ?? '').replace(/^"+|"+$/g, '').replace(/""/g, '"'));
const HONORIFIC = /^(?:mr|mrs|ms|miss|mme|dr|prof|sir|m)\.?\s+/i;
/** "MR. NIKOLAI SMITH #1234" -> "NIKOLAI SMITH". */
const cleanName = (s) => unquote(s).replace(/\s*#\s*\d+\s*$/, '').replace(HONORIFIC, '').trim();
/** True when a name ends or starts with a legal form ("Brightwater Pumps Limited"), which a person's name never does. */
const hasLegalForm = (s) => companyTokens(s).length < normalizeName(s).split(' ').filter(Boolean).length;
const isoDay = (s) => (String(s || '').match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || '';

/** Whether this deployment turned the source on (FOUNDER_SOURCES_ON, comma-separated ids). */
const switchedOn = () => String(process.env.FOUNDER_SOURCES_ON || '').split(',').map((s) => s.trim()).includes(ID);
const switchedOff = () => String(process.env.FOUNDER_SOURCES_OFF || '').split(',').map((s) => s.trim()).includes(ID);

// Words the privacy filter in guardrails does not count as a child, but which are one in a charge
const CHILD_WORDS = /\b(child|children|minors?|juveniles?|underage|under[- ]age|girl|boy|infant|pupil|schoolchild\w*)\b/i;

/** The listing reason, without personal details; withheld when it touches a child or a protected matter. */
export function listingReason(raw) {
  const text = unquote(raw);
  if (!text) return '';
  if (CHILD_WORDS.test(text) || mentionsMinor(text) || isSensitive(text)) return 'withheld (the listing text concerns a protected matter or a minor)';
  return reasonText(text, 220);
}

/** The first two ISO dates in a reason ("Debarred - 2024-07-22 - 2027-07-22"); 2999 means no end date. */
function periodOf(reason) {
  const dates = String(reason || '').match(/\b(?:19|20|29)\d{2}-\d{2}-\d{2}\b/g) || [];
  const start = dates.find((d) => !d.startsWith('29')) || '';
  const after = start ? dates.slice(dates.indexOf(start) + 1) : [];
  const end = after[0] ? (after[0].startsWith('29') ? 'no end date' : after[0]) : '';
  return { start, end };
}

const compact = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== '' && v != null && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out;
};

/* ------------------------------------------------------------------ */
/* Reading one list                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the compact index of one list from its targets.simple.csv.
 * Rows: n name, a aliases, t 'person'|'entity'|'' (LegalEntity: the list does not say),
 * r reason, d start, e end, s first collected, c last changed, k country (companies only), i entity id.
 * Throws when the file is not in the expected format, arrived incomplete, or has
 * far fewer entries than the publisher's metadata (`expected`) says it holds.
 */
export function parseTargets(text, dataset, expected = null) {
  const body = String(text || '');
  if (!/\n\s*$/.test(body.slice(-8))) throw new Error(`The ${dataset.name} file arrived incomplete`);
  let col = null;
  const rows = [];
  eachCsvRow(body, (f) => {
    if (!col) {
      col = Object.fromEntries(f.map((h, i) => [oneLine(h).toLowerCase(), i]));
      for (const need of REQUIRED_COLUMNS) if (col[need] == null) throw new Error(`The ${dataset.name} file is not in the expected format`);
      return;
    }
    if (f.length < REQUIRED_COLUMNS.length) return;
    const get = (k) => f[col[k]] ?? '';
    const schema = oneLine(get('schema'));
    const t = schema === 'Person' ? 'person' : /^(Company|Organization|Vessel|Airplane)$/.test(schema) ? 'entity' : '';
    if (/^(Vessel|Airplane|Address)$/.test(schema)) return;
    let n = cleanName(get('name'));
    let aliases = unquote(get('aliases')).split(';').map(cleanName).filter((x) => x && isLatin(x));
    if (t !== 'entity') {
      // A person's generational suffix and "also known as" are not part of the name compared
      const forms = personNameForms(n);
      if (forms.name) { aliases = [...forms.aliases, ...aliases]; n = forms.name; }
    }
    if (!n || !isLatin(n)) {
      // a name only in another script: an alias in Latin letters stands in for it
      if (!aliases.length) return;
      n = aliases.shift();
    }
    const rawReason = unquote(get('sanctions'));
    const { start, end } = periodOf(rawReason);
    const id = oneLine(get('id'));
    const countries = unquote(get('countries'));
    rows.push(compact({
      n: clipText(n, 200),
      a: [...new Set(aliases.map((x) => clipText(x, 160)))].filter((x) => x !== n).slice(0, 8),
      t,
      r: listingReason(rawReason),
      d: start,
      e: end,
      s: isoDay(get('first_seen')),
      c: isoDay(get('last_change')),
      // a country for a listed company only: the nationality of a person is never kept
      // (a party of unstated type counts as a company only when its name carries a legal form: "... Limited")
      k: t === 'entity' || (t === '' && hasLegalForm(n)) ? clipText(countries.split(';').join(', ').toUpperCase(), 40) : '',
      i: /^[A-Za-z0-9_.-]{1,100}$/.test(id) ? id : '',
    }));
  });
  if (!col) throw new Error(`The ${dataset.name} file was empty`);
  if (!rows.length) throw new Error(`The ${dataset.name} file had no entries that could be read`);
  if (expected && rows.length < Math.floor(expected * 0.8)) throw new Error(`The ${dataset.name} file had ${rows.length} entries where ${expected} were expected`);
  return { v: 1, key: dataset.id, at: new Date().toISOString(), rows };
}

/** The list's metadata: how many entries it holds, where its file is, and the publisher's page. */
export function readMetadata(meta, dataset) {
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.resources)) throw new Error(`The ${dataset.name} metadata is not in the expected format`);
  const count = Number(meta.target_count);
  if (!Number.isFinite(count)) throw new Error(`The ${dataset.name} metadata does not say how many entries the list holds`);
  // An empty list is a list that did not answer (its collector has gone quiet), never a clean screen
  if (count <= 0) throw new Error(`The ${dataset.name} list is empty at the publisher, so it could not be screened`);
  const file = meta.resources.find((r) => r && r.name === 'targets.simple.csv');
  const url = file && /^https:\/\/data\.opensanctions\.org\//.test(String(file.url || '')) ? String(file.url) : `${BASE}/${dataset.id}/targets.simple.csv`;
  const page = /^https:\/\/[^\s"<>]+$/.test(String(meta.url || '')) ? String(meta.url) : '';
  return { count, url, page, size: Number(file?.size) || null, updated: isoDay(meta.updated_at || meta.last_change) };
}

const MAX_FILE_BYTES = 12 * 1024 * 1024;

/**
 * One list, loaded on first need and kept for a day as a compact index. -> { value, at, fresh }: `fresh` is false
 * when an older copy stands in for a failed refresh, and the screen then says how old the list it read is. The
 * loader uses the deadline the cache gives it (the shared download is not cut short by one caller's deadline).
 */
const loadDataset = (dataset, deadline) => cachedEntry(`opensanctions:${dataset.id}:v1`, DAY_MS, async ({ deadline: d }) => {
  const meta = readMetadata(await getJson(`${BASE}/${dataset.id}/index.json`, { deadline: d, timeoutMs: 10000, maxBytes: 512 * 1024 }), dataset);
  if (meta.size && meta.size > MAX_FILE_BYTES) throw new Error(`The ${dataset.name} file is larger than this source reads`);
  const { text } = await request(meta.url, { deadline: d, timeoutMs: 25000, maxBytes: MAX_FILE_BYTES, accept: 'text/csv' });
  const index = parseTargets(text, dataset, meta.count);
  return { ...index, page: meta.page, ...(meta.updated ? { asOf: meta.updated } : {}) };
}, { deadline });
const dayOf = (ms) => new Date(Number(ms) || Date.now()).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Tasks and findings                                                  */
/* ------------------------------------------------------------------ */

const isPersonTask = (task) => task.kind !== 'company';
// The names screened, shared with the other sanctions screens: a company under every known name (the typed name and
// the legal names learned from records tied to the person), a person under their name and its variants.
const searchedNames = (task, ctx) => screenNames(task, ctx);
const canScreen = (task, ctx) => (isPersonTask(task)
  ? searchedNames(task, ctx).some((v) => isFullName(nameTokens(v)))
  : companyTokens(task.value).join('').length >= 3);

const aboutPrefix = (task) => (task.kind === 'associate' || task.kind === 'relative'
  ? `${capitalise(task.relation || (task.kind === 'relative' ? 'relative' : 'associate'))} ${oneLine(task.value)}: `
  : '');

/** Never 'confirmed': a record that would grade so is held at 'likely', the strongest this source may set. */
function capped(subject, f, found) {
  if (!found || found.match !== 'confirmed') return found;
  return makeFinding(subject, { ...f, match: 'likely', matchReasons: [...(found.matchReasons || []), 'held at likely: a watchlist entry is matched by name'] });
}

/**
 * Grade one hit.
 *   subject    'possible' (name match only, verify identity) unless the listing's own reason names
 *              something already tied to the person; then 'likely' at most
 *   company    'company' when the whole name matches; 'possible' for a one-word name
 *   associate, relative   'possible' unless the record also names the subject (then 'likely' at most)
 */
function graded(task, ctx, f, { context = '', tier = 1, via = '' } = {}) {
  const subject = ctx.subject;
  if (task.kind === 'company') {
    // One word only when the hit came through the bare typed word: a learned legal name ("Ramp Business
    // Corporation") matched whole is the company's own record.
    if (companyTokens(via || task.value).length < 2) {
      return makeFinding(subject, { ...f, title: `${f.title}: name match only, verify identity`, match: 'possible', matchReasons: ['only the company name\'s one distinctive word matches; many unrelated companies share a one-word name'] });
    }
    return makeFinding(subject, { ...f, match: 'company', matchReasons: ['the listed name is the same as the company name'] });
  }
  if (task.kind === 'associate' || task.kind === 'relative') {
    const reason = `name match on ${task.kind === 'relative' ? 'a relative' : 'an associate'} of the subject; verify identity`;
    return capped(subject, f, makeFinding(subject, f)) || makeFinding(subject, { ...f, match: 'possible', matchReasons: [reason] });
  }
  // The person: the shared grader of a listed person, as ASIC and the debarment lists use it. A variant of the
  // name (tier 3) stays possible, and only a company the check was started with raises a hit; then the hold at
  // likely, the strongest this source may set.
  const possibleTitle = `${f.title}: name match only, verify identity`;
  const found = gradeListedPerson(subject, f, { tier, context, possibleTitle });
  if (!found || found.match !== 'confirmed') return found;
  return makeFinding(subject, { ...f, match: 'likely', matchReasons: [...(found.matchReasons || []).slice(0, 3), 'held at likely: a watchlist entry is matched by name'] });
}

function findingFor(task, ctx, dataset, index, hit) {
  const { row, matched, tier, via } = hit;
  const interpol = dataset.id === 'interpol_red_notices';
  const kind = row.t === 'person' ? 'Individual' : row.t === 'entity' ? 'Entity' : 'Listed party';
  const quote = [
    `List: ${dataset.name}`,
    `${kind}: ${row.n}`,
    matched !== row.n ? `Also listed as: ${matched}` : '',
    row.r ? `${interpol ? 'Charge as stated by the requesting country' : 'Listing reason'}: ${row.r}` : 'Listing reason: not given by the list',
    row.d ? `From: ${row.d}` : '',
    row.e ? `Until: ${row.e}` : '',
    row.k ? `Country: ${row.k}` : '',
    row.s ? `On the list since at least: ${row.s}` : '',
    row.c ? `Entry last changed: ${row.c}` : '',
    interpol ? INTERPOL_NOTE : '',
  ].filter(Boolean).join(' | ');
  const title = interpol
    ? `${aboutPrefix(task)}Interpol red notice (a request by one country, not a conviction; some are politically motivated): ${row.n}`
    : `${aboutPrefix(task)}${dataset.name}: ${row.n}`;
  return graded(task, ctx, {
    source: ID, sourceLabel: LABEL, category: dataset.cat, severity: dataset.sev,
    title,
    quote,
    url: row.i ? `${ENTITY_PAGE}${row.i}/` : (index.page || `${BASE}/${dataset.id}/`),
    date: row.d || row.s || null,
    data: {
      list: dataset.name, dataset: dataset.id, reason: row.r || null, from: row.d || null, until: row.e || null,
      listedSince: row.s || null, lastChanged: row.c || null, publisherPage: index.page || null,
      searched: oneLine(task.value), tier: hit.tier, listReadAt: index.at, ...(index.asOf ? { listDated: index.asOf } : {}),
      credit: 'OpenSanctions, CC BY-NC 4.0',
    },
  }, { context: row.r || '', tier, via });
}

/** Screen one name against the lists of one group (or all of them). */
async function screenLists(task, ctx, lists) {
  const name = oneLine(task.value);
  const person = isPersonTask(task);
  const wanted = person ? lists : lists.filter((d) => !d.people);
  const loaded = new Array(wanted.length).fill(null);
  const errors = new Array(wanted.length).fill(null);
  // Two lists at a time: a polite pace for one host, and quick enough for a lookup
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= wanted.length) return;
      try { loaded[i] = await loadDataset(wanted[i], ctx.deadline); } catch (error) { errors[i] = error; }
    }
  };
  await Promise.all([worker(), worker()]);
  if (wanted.length && loaded.every((x) => !x)) throw errors.find(Boolean) || new Error('No list could be read');

  const findings = [];
  const notes = [CREDIT];
  const partial = [];
  const clean = [];
  let interpolHit = false;
  wanted.forEach((dataset, i) => {
    const entry = loaded[i];
    const index = entry ? entry.value : null;
    if (!index) {
      notes.push(`${dataset.name}: could not be read (${clipText(errors[i]?.message || 'no answer', 120)}), so ${name} was not screened against it`);
      partial.push(`${dataset.name}: did not answer`);
      return;
    }
    // An older copy read because the refresh failed: dated, and the screen answered only in part (never a clean
    // result as of today).
    const stale = entry.fresh === false;
    if (stale) partial.push(`${dataset.name}: list as of ${dayOf(entry.at)}`);
    const hits = screenRows(index, searchedNames(task, ctx), person ? 'person' : 'company');
    if (!hits.length) { clean.push(stale ? `${dataset.name} (list as of ${dayOf(entry.at)})` : dataset.name); return; }
    if (dataset.id === 'interpol_red_notices') interpolHit = true;
    for (const hit of hits.slice(0, MAX_FINDINGS)) {
      const f = findingFor(task, ctx, dataset, index, hit);
      if (f) findings.push(f);
    }
    if (hits.length > MAX_FINDINGS) notes.push(`${dataset.name}: ${hits.length} entries match the name ${name}; the first ${MAX_FINDINGS} are shown`);
  });
  if (clean.length) notes.push(`Searched for ${name} and found no entry in: ${clean.join('; ')}`);
  if (interpolHit) notes.push(INTERPOL_NOTE);
  return { findings: findings.slice(0, MAX_FINDINGS * 2), threads: [], notes, ...(partial.length ? { partial } : {}) };
}

export const openSanctionsConnector = {
  id: ID,
  label: LABEL,
  // 'alias': another name of the person, screened like their own name (alias.js holds the grade)
  kinds: ['subject', 'alias', 'company', 'associate', 'relative'],
  prior: 0.3,
  timeoutMs: 40000,
  maxParallel: 2,
  enabled: () => switchedOn() && !switchedOff(),
  unavailableReason: 'not enabled on this deployment',
  /** The person and their companies get one lookup per group of lists; associates and relatives one lookup for all. */
  plan(thread) {
    if (thread?.kind === 'subject' || thread?.kind === 'company') {
      return GROUPS
        .filter((g) => thread.kind === 'subject' || DATASETS.some((d) => d.group === g.key && !d.people))
        .map((g) => ({ template: `os.${g.key}`, prior: 0.3, why: g.why }));
    }
    return [{ template: ALL, prior: 0.3, why: 'screen the name against watchlists, regulators\' bans and debarments worldwide' }];
  },
  async run(task, ctx) {
    if (!canScreen(task, ctx)) {
      return {
        findings: [], threads: [],
        notes: [`${LABEL}: "${oneLine(task.value)}" is too short a name to screen`],
        partial: [`${oneLine(task.value).slice(0, 40)}: name too short to screen`],
      };
    }
    const template = String(task.template || ALL);
    if (template === ALL) return screenLists(task, ctx, DATASETS);
    const group = GROUPS.find((g) => `os.${g.key}` === template);
    if (!group) throw new Error(`Unknown group of lists: ${template}`);
    return screenLists(task, ctx, DATASETS.filter((d) => d.group === group.key));
  },
};

// A record found only under another name of the person the user did not type is 'likely' at most (alias.js).
openSanctionsConnector.run = withAliasHold(openSanctionsConnector.run);
