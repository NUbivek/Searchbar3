/**
 * More of the person's own public footprint (see presence.js for the rest).
 *
 *   huggingface        Hugging Face accounts: the name the account states, the
 *                      organisations it belongs to and its counts of models,
 *                      datasets, spaces and papers. Found by the person's full
 *                      name, or reached through a handle or profile link a
 *                      record tied to the person gives.
 *   open-library-books books the person wrote, from Open Library, for an author
 *                      id that the person's Wikidata entry gives (Wikidata
 *                      property P648), or an Open Library author page a record
 *                      tied to them links to. Open Library's robots.txt closes
 *                      its search pages and /api to automated readers, so only
 *                      the author pages (/authors/{id}.json and
 *                      /authors/{id}/works.json) are read; the name search is
 *                      never used.
 *   crates-io          the Rust packages a crates.io account publishes, for a
 *                      GitHub login already tied to the person (crates.io
 *                      accounts are GitHub logins). On only with a contact to
 *                      declare: the owner's FOUNDER_HTTP_CONTACT, or else the
 *                      signed-in person's name and email (sent to crates.io
 *                      only). crates.io asks every automated client to name one.
 *
 * Whose account is it? A record is tied to the person only when it states
 * their full name (personNameFits). A name alone is 'possible' and every such
 * title says "name match only, verify identity". 'likely' needs a second fact
 * from the record that matches the person: a company already known to be
 * theirs (in an organisation, bio or Wikidata employer), or the exact handle or
 * link a record tied to them gave. No source here sets 'confirmed'.
 *
 * Privacy: avatars, follower lists, e-mail addresses, author birth and death
 * dates and every other personal field these services return are never read
 * into a record. Bios and book titles pass the privacy filter (safe()).
 *
 * Pace: Open Library asks for one request a second from a client that does
 * not identify itself (three with a contact), crates.io for one a second;
 * both are paced here on top of the shared per-host spacing in ../http.
 * Nothing here is a whole-list download, so nothing goes to the shared list
 * cache (which must never hold anything about the person being checked).
 */
import { getJson, HttpError } from '../http';
import { makeFinding } from '../finding';
import { nameTokens } from '../identity';
import { isSensitive, mentionsMinor, redactPII } from '../guardrails';
import { personNameFits } from './scholar';
import { statedName } from './presence';
import { contactFor, requestOptionsFor, CONTACT_HOSTS } from '../contact';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const count = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, word) => `${count(n)} ${word}${Number(n) === 1 ? '' : 's'}`;
/** Text the privacy rules would reject is left out; contact details in what is kept are removed. */
const safe = (s) => {
  const t = clean(s);
  return isSensitive(t) || mentionsMinor(t) ? '' : clean(redactPII(t));
};
const EMPTY = () => ({ findings: [], threads: [], notes: [] });
const day = (value) => {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const errorText = (error) => clean(error?.message) || 'no answer';
const NAME_ONLY = 'name match only, verify identity';

/** Companies already known to be the subject's that a text names (the identity anchors do the matching). */
function knownCompanies(subject, text) {
  const out = [];
  for (const a of (subject.anchors?.companies || new Map()).values()) if (a.test(text)) out.push(a.value);
  return out;
}

/** The service a handle task's handle comes from ('' when not known). */
function platformOf(task) {
  const hint = clean(task?.platform || task?.why).toLowerCase();
  const m = hint.match(/^(github|hugging ?face|crates(?:\.io)?|x|twitter|npm|bluesky|mastodon)\b/);
  if (!m) return '';
  if (/^hugging/.test(m[1])) return 'huggingface';
  if (/^crates/.test(m[1])) return 'crates';
  return m[1] === 'twitter' ? 'x' : m[1];
}

/* ------------------------------------------------------------------ pacing */

/** Minimum gap between this file's requests to one host, in ms (on top of ../http's own spacing). */
const GAPS = { 'openlibrary.org': 1000, 'crates.io': 1000 };
let gapScale = 1;
const nextAt = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pace(host, deadline) {
  let gap = (GAPS[host] || 0) * gapScale;
  // Open Library allows three a second to a client that names a contact.
  if (host === 'openlibrary.org' && clean(process.env.FOUNDER_HTTP_CONTACT)) gap = Math.round(gap / 3);
  if (!gap) return;
  const now = Date.now();
  const at = Math.max(now, nextAt.get(host) || 0);
  if (deadline && at + 1500 > deadline) throw new HttpError('Out of time before the request could start', { retryable: true });
  nextAt.set(host, at + gap);
  if (at > now) await sleep(at - now);
}

async function paced(url, ctx, options = {}) {
  await pace(new URL(url).hostname, ctx.deadline);
  return getJson(url, { deadline: ctx.deadline, retries: 0, maxBytes: 2 * 1024 * 1024, ...options });
}

/** For tests: forget the pacing, and optionally switch it off. */
export function __resetPresenceMoreForTests({ paced: keep = false } = {}) {
  nextAt.clear();
  gapScale = keep ? 1 : 0;
}

/* ------------------------------------------------------------ Hugging Face */

const HF = 'https://huggingface.co';
const HF_LABEL = 'Hugging Face public profiles';
const HF_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
// First path segments of huggingface.co that are site pages, not accounts.
const HF_RESERVED = new Set(['models', 'datasets', 'spaces', 'docs', 'blog', 'papers', 'organizations', 'settings', 'login', 'join', 'pricing',
  'enterprise', 'learn', 'tasks', 'collections', 'posts', 'api', 'chat', 'search', 'new', 'notifications', 'terms-of-service', 'privacy',
  'huggingface', 'welcome', 'inference-endpoints', 'buckets', 'kernels']);
const HF_URL = /^https?:\/\/(?:www\.)?huggingface\.co\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})\/?(?:[?#].*)?$/i;

/** An account's overview, or null when there is no such account. */
async function hfOverview(user, ctx) {
  try {
    const o = await paced(`${HF}/api/users/${encodeURIComponent(user)}/overview`, ctx);
    if (!o || typeof o !== 'object' || typeof o.user !== 'string' || !('fullname' in o)) throw new Error('Hugging Face answered without an account overview');
    return o;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

/** Organisations an account belongs to, as "Full name (handle)". */
const hfOrgs = (o) => (Array.isArray(o.orgs) ? o.orgs : [])
  .map((g) => ({ name: clean(g?.name), fullname: safe(g?.fullname) }))
  .filter((g) => g.name || g.fullname)
  .slice(0, 12);

function hfFinding(subject, o, grade) {
  const user = clean(o.user);
  const name = clean(o.fullname);
  const orgs = hfOrgs(o);
  const bio = safe(o.details).slice(0, 400);
  const joined = day(o.createdAt);
  const counts = [plural(o.numModels, 'model'), plural(o.numDatasets, 'dataset'), plural(o.numSpaces, 'space'), plural(o.numPapers, 'paper')].join(', ');
  const possible = grade.match === 'possible';
  return makeFinding(subject, {
    source: 'huggingface', sourceLabel: HF_LABEL, category: 'identity',
    title: `Hugging Face account ${user} (self-described: name "${name}"): ${counts}${joined ? `, joined ${joined}` : ''}${possible ? `: ${NAME_ONLY}` : ''}`,
    quote: [
      orgs.length ? `Organisations: ${orgs.map((g) => (g.fullname && g.name && g.fullname !== g.name ? `${g.fullname} (${g.name})` : g.fullname || g.name)).join('; ')}` : '',
      bio && `Bio: ${bio}`,
    ].filter(Boolean).join(' | '),
    url: `${HF}/${encodeURIComponent(user)}`,
    date: joined,
    severity: 'info',
    ...grade,
    data: {
      user, name, joined,
      models: Number(o.numModels) || 0, datasets: Number(o.numDatasets) || 0, spaces: Number(o.numSpaces) || 0, papers: Number(o.numPapers) || 0,
      orgs: orgs.map((g) => g.fullname || g.name),
    },
  });
}

/**
 * The grade of an account that states the person's full name. `reached`: why the account was reached
 * through something already tied to the person (the exact handle or link), or '' when found by name.
 */
function hfGrade(subject, o, reached, exact = false, handle = '') {
  const text = [...hfOrgs(o).flatMap((g) => [g.fullname, g.name]), safe(o.details)].filter(Boolean).join('. ');
  const companies = knownCompanies(subject, text);
  // A website or another handle of the person that the bio links to (not the handle the account was reached by).
  const linked = ['domains', 'handles'].flatMap((kind) => [...(subject.anchors[kind] || new Map()).values()])
    .filter((a) => a.value.toLowerCase().replace(/^@/, '') !== String(handle).toLowerCase() && a.test(text)).map((a) => a.value);
  const reasons = ["states the person's full name"];
  // The same handle on another service is no tie by itself: a handle such as "janedoe" is just the name, and a
  // namesake may hold it here (the same rule as presence.js gradeReached). Only the exact Hugging Face link or
  // handle counts on its own.
  const tied = Boolean(reached) && exact;
  if (reached && (tied || companies.length || linked.length)) reasons.push(reached);
  if (companies.length) reasons.push(...companies.slice(0, 2).map((c) => `its organisations or bio name ${c}`));
  if (linked.length) reasons.push(...linked.slice(0, 2).map((v) => `links to ${v}`));
  if (tied || companies.length || linked.length) return { match: 'likely', matchReasons: reasons };
  return { match: 'possible', matchReasons: ['matched by name only: a Hugging Face profile name is its owner\'s own claim; verify identity'] };
}

async function hfByName(subject, ctx) {
  if (nameTokens(subject.name).length < 2) return EMPTY();
  const body = await paced(`${HF}/api/quicksearch?q=${encodeURIComponent(subject.name)}&type=user&limit=10`, ctx);
  if (!body || !Array.isArray(body.users)) throw new Error('Hugging Face answered without a list of accounts');
  const named = body.users.filter((u) => HF_USER.test(clean(u?.user)) && statedName(subject, u.fullname) === 'same');
  if (!named.length) return { findings: [], threads: [], notes: [`Hugging Face: no account states the name ${subject.name}.`] };
  const findings = [];
  const failed = [];
  let firstError = null;
  for (const u of named.slice(0, 3)) {
    let o;
    try {
      o = await hfOverview(clean(u.user), ctx);
    } catch (error) {
      firstError = firstError || error;
      failed.push(clean(u.user));
      continue;
    }
    if (!o || statedName(subject, o.fullname) !== 'same') continue;
    const finding = hfFinding(subject, o, hfGrade(subject, o, ''));
    if (finding) findings.push(finding);
  }
  if (failed.length && !findings.length) throw firstError;
  findings.sort((a, b) => (a.match === 'likely' ? 0 : 1) - (b.match === 'likely' ? 0 : 1));
  const notes = [];
  if (named.length > 3) notes.push(`${named.length} Hugging Face accounts state the name ${subject.name}; the first 3 were read.`);
  if (failed.length) notes.push(`Hugging Face did not answer for the account${failed.length === 1 ? '' : 's'} ${failed.join(', ')}; ${failed.length === 1 ? 'it was' : 'they were'} not read.`);
  return { findings, threads: [], notes, ...(failed.length ? { partial: [`Hugging Face accounts not read: ${failed.join(', ')}`.slice(0, 80)] } : {}) };
}

async function hfAccount(subject, user, why, exact, ctx) {
  const o = await hfOverview(user, ctx);
  if (!o) return { findings: [], threads: [], notes: [`Hugging Face: no account ${user}.`] };
  const stated = statedName(subject, o.fullname);
  if (stated !== 'same') {
    // Without the person's full name the account is not tied to them, however it was reached.
    return { findings: [], threads: [], notes: [stated === 'other' || exact ? `The Hugging Face account ${user} does not state the person's full name and was left out.` : `Hugging Face: the account ${user} does not state the person's name; it was left out.`] };
  }
  const finding = hfFinding(subject, o, hfGrade(subject, o, why, exact, user));
  return { findings: [finding].filter(Boolean), threads: [], notes: [] };
}

export const huggingFaceConnector = {
  id: 'huggingface',
  label: HF_LABEL,
  kinds: ['subject', 'handle', 'url'],
  prior: 0.15,
  maxParallel: 2,
  timeoutMs: 15000,
  async run(task, ctx) {
    const { subject } = ctx;
    if (task.kind === 'subject') return hfByName(subject, ctx);
    if (task.kind === 'url') {
      const m = clean(task.value).match(HF_URL);
      if (!m || HF_RESERVED.has(m[1].toLowerCase())) return EMPTY();
      return hfAccount(subject, m[1], 'reached through the exact Hugging Face profile link a record tied to the person gives', true, ctx);
    }
    if (task.kind === 'handle') {
      const handle = clean(task.value).replace(/^@/, '');
      if (!HF_USER.test(handle) || HF_RESERVED.has(handle.toLowerCase())) return EMPTY();
      const platform = platformOf(task);
      const exact = platform === 'huggingface';
      const why = exact
        ? 'reached through the exact Hugging Face handle a record tied to the person gives'
        : `the same handle, ${handle}, as ${platform ? `a ${platform === 'x' ? 'X' : platform === 'github' ? 'GitHub' : platform} account` : 'an account'} already tied to the person`;
      return hfAccount(subject, handle, why, exact, ctx);
    }
    return EMPTY();
  },
};

/* ------------------------------------------------------------ Open Library */

const OL = 'https://openlibrary.org';
const OL_LABEL = 'Open Library books by the person';
const OLID = /^OL\d{1,10}A$/;
const OL_URL = /^https?:\/\/(?:www\.)?openlibrary\.org\/authors\/(OL\d{1,10}A)(?:[/?#.]|$)/i;
const OL_WORKS = 50;
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';

/** Wikidata people with exactly this name (label or alias) who carry an Open Library author id. */
const wikidataQuery = (name) => {
  const n = clean(name).replace(/["\\]/g, '');
  return `SELECT ?p ?ol ?desc (GROUP_CONCAT(DISTINCT ?orgLabel; separator=" | ") AS ?orgs) WHERE { VALUES ?n { "${n}"@en } { ?p rdfs:label ?n } UNION { ?p skos:altLabel ?n } ?p wdt:P31 wd:Q5 ; wdt:P648 ?ol . OPTIONAL { ?p schema:description ?desc . FILTER(LANG(?desc)="en") } OPTIONAL { { ?p wdt:P108 ?org } UNION { ?p wdt:P1830 ?org } UNION { ?org wdt:P112 ?p } UNION { ?org wdt:P169 ?p } ?org rdfs:label ?orgLabel . FILTER(LANG(?orgLabel)="en") } } GROUP BY ?p ?ol ?desc LIMIT 20`;
};

/** Wikidata's answer as [{ qid, olid, description, orgs }]. Throws when the answer is not a result table. */
export function parseWikidataAuthors(body) {
  if (!body || !Array.isArray(body?.results?.bindings)) throw new Error('Wikidata answered without a result table');
  const out = new Map();
  for (const b of body.results.bindings) {
    const qid = (clean(b?.p?.value).match(/\/(Q\d+)$/) || [])[1];
    const olid = clean(b?.ol?.value);
    if (!qid || !OLID.test(olid)) continue;
    const prev = out.get(`${qid}|${olid}`);
    const orgs = clean(b?.orgs?.value).split(' | ').map(clean).filter(Boolean);
    out.set(`${qid}|${olid}`, { qid, olid, description: clean(b?.desc?.value) || prev?.description || '', orgs: [...new Set([...(prev?.orgs || []), ...orgs])] });
  }
  return [...out.values()];
}

/** The works list of an author id, as [{ title, year, subjects }], newest first, with the total Open Library holds. */
export function parseWorks(body) {
  if (!body || !Array.isArray(body.entries)) throw new Error('Open Library answered without a list of works');
  const works = body.entries.map((w) => {
    const year = Number((clean(w?.first_publish_date).match(/\b(1[5-9]\d\d|20\d\d)\b/) || [])[1]) || null;
    return {
      title: safe(w?.title),
      key: (clean(w?.key).match(/^\/works\/(OL\d{1,10}W)$/) || [])[1] || '',
      year,
      subjects: (Array.isArray(w?.subjects) ? w.subjects : []).map(safe).filter(Boolean).slice(0, 3),
    };
  }).filter((w) => w.title);
  works.sort((a, b) => (b.year || 0) - (a.year || 0));
  return { works, total: Number(body.size) || works.length };
}

async function olWorks(olid, ctx) {
  try {
    return parseWorks(await paced(`${OL}/authors/${olid}/works.json?limit=${OL_WORKS}`, ctx));
  } catch (error) {
    // 404 or 422: the id is not (or no longer) an author on Open Library
    if (error?.status === 404 || error?.status === 422) return null;
    throw error;
  }
}

function olFinding(subject, { olid, name, works, total }, grade) {
  const possible = grade.match === 'possible';
  const latest = works.find((w) => w.year);
  const top = works.slice(0, 8);
  return makeFinding(subject, {
    source: 'open-library-books', sourceLabel: OL_LABEL, category: 'career',
    title: `Open Library lists ${plural(total, 'work')} by ${name || subject.name}: ${top.slice(0, 3).map((w) => `${w.title}${w.year ? ` (${w.year})` : ''}`).join('; ')}${possible ? `: ${NAME_ONLY}` : ''}`,
    quote: top.map((w) => `${w.title}${w.year ? ` (first published ${w.year})` : ''}${w.subjects.length ? `, subjects: ${w.subjects.join(', ')}` : ''}`).join(' | '),
    url: `${OL}/authors/${olid}`,
    date: latest ? String(latest.year) : null,
    severity: 'info',
    ...grade,
    data: { olid, works: total, titles: top.map((w) => ({ title: w.title, year: w.year, url: w.key ? `${OL}/works/${w.key}` : null })) },
  });
}

/** Books through the person's Wikidata entry: the Open Library author id that entry gives. */
async function olBySubject(subject, ctx) {
  if (nameTokens(subject.name).length < 2) return EMPTY();
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(wikidataQuery(subject.name))}&format=json`;
  const people = parseWikidataAuthors(await getJson(url, { deadline: ctx.deadline, retries: 0, accept: 'application/sparql-results+json', maxBytes: 1024 * 1024 }));
  if (!people.length) {
    return { findings: [], threads: [], notes: [`Open Library: no Wikidata entry named ${subject.name} gives an Open Library author id, so no books were looked up (Open Library's own name search is closed to automated readers and was not used).`] };
  }
  const findings = [];
  const notes = [];
  const failed = [];
  let firstError = null;
  for (const p of people.slice(0, 3)) {
    let read;
    try {
      read = await olWorks(p.olid, ctx);
    } catch (error) {
      firstError = firstError || error;
      failed.push(p.olid);
      continue;
    }
    if (!read) { notes.push(`Open Library has no author ${p.olid} (given on Wikidata ${p.qid}).`); continue; }
    if (!read.works.length) { notes.push(`Open Library lists no works for the author ${p.olid} (Wikidata ${p.qid}).`); continue; }
    // The Wikidata entry states the name; it is the person only when it also names a company of theirs.
    const companies = knownCompanies(subject, [p.description, ...p.orgs].join('. '));
    const grade = companies.length
      ? { match: 'likely', matchReasons: [`the Wikidata entry ${p.qid} that gives this author id states the person's full name`, ...companies.slice(0, 2).map((c) => `and names ${c}`)] }
      : { match: 'possible', matchReasons: [`matched by name only: the Wikidata entry ${p.qid}${p.description ? ` ("${safe(p.description).slice(0, 80)}")` : ''} has the person's name and nothing else of theirs; verify identity`] };
    const finding = olFinding(subject, { olid: p.olid, name: subject.name, ...read }, grade);
    if (finding) findings.push(finding);
    if (read.total > read.works.length) notes.push(`Open Library lists ${count(read.total)} works for ${p.olid}; the first ${read.works.length} were read.`);
  }
  if (failed.length && !findings.length) throw firstError;
  if (people.length > 3) notes.push(`${people.length} Wikidata entries named ${subject.name} give an Open Library author id; the first 3 were read.`);
  if (failed.length) notes.push(`Open Library did not answer for ${failed.join(', ')}; those books were not read.`);
  return { findings, threads: [], notes, ...(failed.length ? { partial: [`Open Library authors not read: ${failed.join(', ')}`.slice(0, 80)] } : {}) };
}

/** Books through an Open Library author page a record tied to the person links to; the author record must state their full name. */
async function olByLink(subject, olid, ctx) {
  let author;
  try {
    author = await paced(`${OL}/authors/${olid}.json`, ctx);
  } catch (error) {
    if (error?.status === 404) return { findings: [], threads: [], notes: [`Open Library has no author ${olid}.`] };
    throw error;
  }
  if (!author || typeof author !== 'object' || typeof author.key !== 'string') throw new Error('Open Library answered without an author record');
  if (clean(author.type?.key) === '/type/redirect') {
    const to = (clean(author.location).match(/\/authors\/(OL\d{1,10}A)$/) || [])[1];
    return to && to !== olid ? olByLink(subject, to, ctx) : EMPTY();
  }
  // Only the name fields are read: birth and death dates, photos and bios stay out.
  const names = [author.name, author.personal_name, ...(Array.isArray(author.alternate_names) ? author.alternate_names : [])].map(clean).filter(Boolean);
  const name = names.find((n) => personNameFits(subject, n));
  if (!name) return { findings: [], threads: [], notes: [`The Open Library author ${olid} (${clean(author.name) || 'no name'}) does not state the person's full name and was left out.`] };
  const read = await olWorks(olid, ctx);
  if (!read || !read.works.length) return { findings: [], threads: [], notes: [`Open Library lists no works for the author ${olid}.`] };
  const finding = olFinding(subject, { olid, name, ...read }, {
    match: 'likely',
    matchReasons: ["the author record states the person's full name", 'reached through the exact Open Library author link a record tied to the person gives'],
  });
  return { findings: [finding].filter(Boolean), threads: [], notes: read.total > read.works.length ? [`Open Library lists ${count(read.total)} works for ${olid}; the first ${read.works.length} were read.`] : [] };
}

export const openLibraryBooksConnector = {
  id: 'open-library-books',
  label: OL_LABEL,
  kinds: ['subject', 'url'],
  prior: 0.15,
  maxParallel: 1,
  timeoutMs: 15000,
  async run(task, ctx) {
    if (task.kind === 'subject') return olBySubject(ctx.subject, ctx);
    const m = task.kind === 'url' ? clean(task.value).match(OL_URL) : null;
    return m ? olByLink(ctx.subject, m[1].toUpperCase(), ctx) : EMPTY();
  },
};

/* --------------------------------------------------------------- crates.io */

const CRATES = 'https://crates.io/api/v1';
const CRATES_LABEL = 'crates.io Rust packages';
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const CRATES_PAGE = 20;
/**
 * A signed-in person's contact is named to crates.io only, in the User-Agent of these requests. With the
 * operator's FOUNDER_HTTP_CONTACT set this adds nothing: http.js already sends that one to every host.
 */
const cratesOptions = (url) => requestOptionsFor('site', CONTACT_HOSTS.crates, url);

async function cratesOf(subject, task, ctx) {
  const login = clean(task.value).replace(/^@/, '');
  if (!GITHUB_LOGIN.test(login)) return EMPTY();
  // crates.io accounts are GitHub logins: a handle from another service may be someone else there.
  const platform = platformOf(task);
  if (platform !== 'github' && platform !== 'crates') return EMPTY();
  let body;
  try {
    const userUrl = `${CRATES}/users/${encodeURIComponent(login)}`;
    body = await paced(userUrl, ctx, cratesOptions(userUrl));
  } catch (error) {
    if (error?.status === 404) return { findings: [], threads: [], notes: [`crates.io: no account for the GitHub login ${login}.`] };
    throw error;
  }
  const user = body?.user;
  if (!user || typeof user !== 'object' || !Number.isFinite(Number(user.id)) || typeof user.login !== 'string') throw new Error('crates.io answered without an account record');
  const name = clean(user.name);
  if (!personNameFits(subject, name)) {
    return { findings: [], threads: [], notes: [`The crates.io account ${clean(user.login)} ${name ? `states the name "${name}", not the person's full name,` : "states no name"} and was left out.`] };
  }
  const listUrl = `${CRATES}/crates?user_id=${Number(user.id)}&sort=downloads&per_page=${CRATES_PAGE}`;
  const list = await paced(listUrl, ctx, cratesOptions(listUrl));
  if (!list || !Array.isArray(list.crates)) throw new Error('crates.io answered without a list of crates');
  const crates = list.crates.filter((c) => clean(c?.name)).map((c) => ({
    name: clean(c.name), description: safe(c.description).slice(0, 140), downloads: Number(c.downloads) || 0, updated: day(c.updated_at), created: day(c.created_at),
  }));
  if (!crates.length) return { findings: [], threads: [], notes: [`crates.io: the account ${clean(user.login)} publishes no crates.`] };
  const total = Number(list.meta?.total) || crates.length;
  const downloads = crates.reduce((sum, c) => sum + c.downloads, 0);
  const latest = crates.map((c) => c.updated).filter(Boolean).sort().pop() || null;
  const top = crates.slice(0, 8);
  const finding = makeFinding(subject, {
    source: 'crates-io', sourceLabel: CRATES_LABEL, category: 'career',
    title: `crates.io account ${clean(user.login)} ("${name}") publishes ${plural(total, 'Rust crate')}${total > crates.length ? ` (the ${crates.length} most downloaded read)` : ''}, about ${count(downloads)} downloads in all; most used: ${top.slice(0, 3).map((c) => c.name).join(', ')}`,
    quote: top.map((c) => `${c.name}${c.description ? `: ${c.description}` : ''} (${count(c.downloads)} downloads)`).join(' | '),
    url: `https://crates.io/users/${encodeURIComponent(clean(user.login))}`,
    date: latest,
    severity: 'info',
    match: 'likely',
    matchReasons: ["states the person's full name", `its login is the GitHub account ${login}, already tied to the person`],
    data: { login: clean(user.login), crates: total, downloads, top: top.map((c) => ({ name: c.name, downloads: c.downloads, updated: c.updated })) },
  });
  return { findings: [finding].filter(Boolean), threads: [], notes: total > crates.length ? [`crates.io: ${clean(user.login)} publishes ${count(total)} crates; the ${crates.length} most downloaded were read.`] : [] };
}

export const cratesIoConnector = {
  id: 'crates-io',
  label: CRATES_LABEL,
  kinds: ['handle'],
  prior: 0.1,
  maxParallel: 1,
  timeoutMs: 12000,
  // crates.io asks every automated client to name a contact; without one (the operator's, or else the signed-in
  // person's for the check they run) it is not asked.
  enabled: () => Boolean(contactFor('site')),
  unavailableReason: 'crates.io asks automated readers to name a contact, and this deployment does not declare one',
  async run(task, ctx) {
    return task.kind === 'handle' ? cratesOf(ctx.subject, task, ctx) : EMPTY();
  },
};
