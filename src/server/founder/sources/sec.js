/**
 * SEC records about a person and their companies.
 *
 *   secPersonConnector   what US securities filings say about the person:
 *     formd        Form D notices (private fundraises) that name them as an
 *                  executive officer, director or promoter
 *     all          every filing since 2001 whose text contains their name
 *     insider      Forms 3/4/5 they filed as an officer, director or large
 *                  shareholder, and the holding vehicles that filed with them
 *     related      filings where the name sits next to a related-party or
 *                  family term, or a dealing with the company (a lease, a
 *                  loan, a trademark sold to it)
 *     family       relatives the person's company names in its own filings
 *                  with a part in the business
 *     enforcement  SEC litigation releases and administrative proceedings,
 *                  and the complaints they cite, dated when filed
 *     press        SEC press releases that name the person
 *   secCompanyConnector  for a company tied to the person: its Form D
 *     notices (and who else is named on them), filings that name the person
 *     together with the company, and 8-K cyber-incident reports. For a
 *     company the person was only an affiliate of, only records that name
 *     them are kept and its cyber incidents are not looked up.
 *
 * Three SEC hosts are used. The full-text search (efts.sec.gov) returns the
 * filing index only, never a text snippet, so quotes are either a passage
 * read from the filing itself (www.sec.gov/Archives) or a line built from
 * the index fields. www.sec.gov turns away automated clients it cannot
 * identify: set SEC_USER_AGENT ("Company name contact@company.com") to
 * declare one; otherwise the shared default is sent. When the document host
 * refuses, the search results are still reported, without roles or passages.
 *
 * Identity. The search matches a phrase, so "Adam Neumann" also finds
 * "Spencer Adam Neumann" and a trust "FBO Erin Elizabeth Holmes". Where a
 * document is read, a mention inside a longer name is not taken as the
 * person. A filer becomes a company thread to follow only when it is already
 * a known company of the person, or its own notice gives them a role there:
 * a fund whose prospectus mentions a founder in passing is not their company.
 *
 * Privacy: Form D and Forms 3/4/5 carry street addresses and phone numbers.
 * Only names, roles, dates and amounts are ever read out of them. Sentences
 * that give an address are cut from quoted passages, and trusts or accounts
 * held for children are never reported.
 */
import { getJson, getText, mapLimit, htmlToText } from '../http';
import { makeFinding, makeThread, severityFromText } from '../finding';
import { relativesFromText, associatesFromText, threadsFromResult } from '../extract';
import { mentionsMinor, isSensitive } from '../guardrails';
import { addRoleAnchor } from '../identity';

const SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const ARCHIVES_URL = 'https://www.sec.gov/Archives/edgar/data';
const SEC_SITE = 'https://www.sec.gov';
const SUBMISSIONS_URL = 'https://data.sec.gov/submissions';
const REGISTRANT_TTL_MS = 6 * 60 * 60 * 1000;
const INDEX_START = '2001-01-01'; // the text index begins in 2001
const BLOCK_PAUSE_MS = 10 * 60 * 1000;
const DOCUMENT_MAX_BYTES = 32 * 1024 * 1024; // a prospectus or merger proxy runs to many megabytes
const SURNAME_MAX_HITS = 40; // a surname with more Form D notices than this is too common to check one by one

const PERSON_ID = 'sec-filings';
const PERSON_LABEL = 'SEC filings and enforcement releases (EDGAR)';
const COMPANY_ID = 'sec-company';
const COMPANY_LABEL = 'SEC company filings (Form D fundraises, cyber-incident reports)';

/* ------------------------------------------------------------------ text helpers */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const uniq = (list) => [...new Set(list.filter(Boolean))];
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const joinAnd = (list) => (list.length <= 1 ? list[0] || '' : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const listText = (items, max = 3) => {
  const list = uniq(items);
  return list.length <= max ? joinAnd(list) : `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3 };
const atLeast = (floor, severity) => (SEVERITY_RANK[severity] > SEVERITY_RANK[floor] ? severity : floor);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', sect: '§', reg: '®', trade: '™', bull: '•', hellip: '…' };
const decodeEntities = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
  if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? m;
  const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
  try { return String.fromCodePoint(n); } catch { return ' '; }
});
// Older filings write quotes and dashes as Windows-1252 numbers (&#146;), which decode to control characters.
const WINDOWS_1252 = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x8b: '‹', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™', 0x9b: '›' };
const fixControlChars = (s) => String(s || '')
  .replace(/[\u0080-\u009f]/g, (c) => WINDOWS_1252[c.charCodeAt(0)] || ' ')
  .replace(/([A-Za-z])�(s|t|d|re|ve|ll)\b/g, '$1’$2').replace(/�/g, ' ');

/* ------------------------------------------------------------------ names */

const NAME_SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'md', 'phd', 'esq', 'cpa']);

/** Lowercase tokens of a person's name. A hyphenated surname stays one token; quoted nicknames are dropped. */
function personTokens(name) {
  return stripAccents(name).toLowerCase()
    .replace(/["“”][^"“”]{0,24}["“”]/g, ' ').replace(/\([^)]{0,24}\)/g, ' ').replace(/['’.]/g, '')
    .split(/[^a-z0-9-]+/).map((t) => t.replace(/^-+|-+$/g, '')).filter((t) => t && !NAME_SUFFIX.has(t));
}

/**
 * Do two names (tokens in given-name-first order) describe the same name?
 * First and last must be equal; where both give a middle name or initial
 * they must agree. `nickname` also lets "Sam" stand for "Samuel".
 */
function namesAgree(a, b, { nickname = false } = {}) {
  if (a.length < 2 || b.length < 2 || a[a.length - 1] !== b[b.length - 1]) return false;
  const [x, y] = [a[0], b[0]];
  const firstOk = x === y || (nickname && Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x)));
  if (!firstOk) return false;
  const [ma, mb] = [a.slice(1, -1), b.slice(1, -1)];
  for (let i = 0; i < Math.min(ma.length, mb.length); i += 1) {
    const [p, q] = [ma[i], mb[i]];
    if (!(p === q || (p.length === 1 && q.startsWith(p)) || (q.length === 1 && p.startsWith(q)))) return false;
  }
  return true;
}

const subjectTokens = (subject) => personTokens(subject.variants?.[0] || subject.name);
/** The phrases to search for: the name as given and, when it has initials, without them. */
const searchNames = (subject) => uniq((subject.variants?.length ? subject.variants : [subject.name]).map((v) => clean(String(v).replace(/"/g, '')))).slice(0, 2);
/** The words of the name as written, without initials or suffixes: ["Trevor", "Milton"]. */
function nameWords(subject) {
  const variants = subject.variants?.length ? subject.variants : [subject.name];
  return clean(String(variants[variants.length - 1]).replace(/"/g, '')).split(' ').filter((w) => !NAME_SUFFIX.has(w.toLowerCase().replace(/\./g, '')));
}
const surnameOf = (subject) => { const w = nameWords(subject); return w.length >= 2 ? w[w.length - 1] : ''; };

/** EDGAR lists people as "Last First Middle": the same tokens, given name first. */
function edgarPersonTokens(entity) {
  const t = personTokens(entity);
  return t.length >= 2 ? [...t.slice(1), t[0]] : t;
}

const NAME_RUN = /(?:[A-ZÀ-Þ][A-Za-zÀ-ÿ'’-]*\.?|["“][^"”]{1,24}["”])(?:\s+(?:[A-ZÀ-Þ][A-Za-zÀ-ÿ'’-]*\.?|["“][^"”]{1,24}["”]|de|van|von|del|la|le|bin|al))+/g;

/** Is the subject named in this free text, allowing a middle initial or name ("Trevor R. Milton")? */
function namesPerson(text, subject, options) {
  const want = subjectTokens(subject);
  if (want.length < 2) return false;
  for (const run of String(text || '').match(NAME_RUN) || []) {
    const tokens = personTokens(run);
    for (let i = 0; i < tokens.length - 1; i += 1) {
      for (let j = i + 1; j < Math.min(tokens.length, i + 5); j += 1) if (namesAgree(tokens.slice(i, j + 1), want, options)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ companies */

const ORG_SUFFIX = /\b(the|inc|incorporated|llc|ltd|limited|corp|corporation|co|company|companies|plc|lp|llp|sa|sas|ag|nv|bv|gmbh|holdings?|group)\b/g;
const ORG_DESCRIPTOR = /^(?:(?:trading|international|global|technologies|technology|labs|systems|software|worldwide|enterprises|industries|usa|us|digital|services|solutions|networks|payments|motors?|pharmaceuticals|therapeutics|ai)\s*)+$/;
const ORG_WORD = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|company|co|lp|l\.p|llp|plc|trust|fund|funds|etf|partners|partnership|holdings?|capital|ventures|group|bank|bancorp|foundation|associates|management|investments?|investors|enterprises|sa|se|ag|nv|gmbh|reit|acquisition|technologies|labs|series)\b\.?/i;
// Trusts and accounts held for children are never reported.
const MINOR_ENTITY = /\b(FBO|CHILDREN'?S?|MINORS?|UTMA|UGMA|CUSTODIAN|GRANDCHILDREN'?S?)\b/i;

const companyCore = (name) => stripAccents(name).toLowerCase().replace(/\./g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(ORG_SUFFIX, ' ').replace(/\s+/g, ' ').trim();

/**
 * How closely a filer's name matches a company: 2 when it is the same name
 * give or take the legal form ("Stripe, Inc." for "Stripe"), 1 when it only
 * adds a generic word ("FTX Trading Ltd." for "FTX"), 0 otherwise ("WeWork
 * Property Investors Fund A LP" is not WeWork).
 */
function companyTier(a, b) {
  const [x, y] = [companyCore(a), companyCore(b)];
  if (x.length < 2 || y.length < 2) return 0;
  if (x === y) return 2;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return long.startsWith(`${short} `) && ORG_DESCRIPTOR.test(long.slice(short.length + 1)) ? 1 : 0;
}
const sameCompany = (a, b) => companyTier(a, b) > 0;
const filerKey = (e) => e.cik || e.name;

/**
 * Which filers in a search result are the company itself. An exact name
 * beats a looser one ("Nikola Corp", not "Nikola Labs Inc.", for "Nikola");
 * when only looser names answer and they are different filers, the result
 * is ambiguous and nothing may be reported on the company's name alone.
 */
function companyFilers(hits, company, entitiesOf = (h) => h.entities.slice(0, 1)) {
  const tiers = new Map();
  for (const h of hits) {
    for (const e of entitiesOf(h)) {
      const tier = companyTier(e.name, company);
      if (tier) tiers.set(filerKey(e), Math.max(tier, tiers.get(filerKey(e)) || 0));
    }
  }
  const best = Math.max(0, ...tiers.values());
  const keys = new Set([...tiers].filter(([, tier]) => tier === best).map(([key]) => key));
  return { keys, exact: best === 2, ambiguous: best === 1 && keys.size > 1, is: (h) => entitiesOf(h).some((e) => keys.has(filerKey(e))) };
}

const looksLikeOrg = (entity) => Boolean(entity?.tickers) || ORG_WORD.test(entity?.name || '') || /[0-9&]/.test(entity?.name || '');
const knownCompany = (subject, text) => [...(subject.anchors?.companies?.values?.() || [])].some((a) => a.test(text));
/** True when one of the names is a known company of the person, give or take the legal form (not merely containing it). */
const exactKnownIssuer = (subject, names) => [...(subject.anchors?.companies?.values?.() || [])]
  .some((a) => names.some((n) => n && companyTier(n, a.value) === 2));
const entityLabel = (e) => (e.tickers ? `${e.name} (${e.tickers})` : e.name);
/** The known company this name is, give or take the legal form or a generic word, or null. */
const sameAsKnown = (subject, name) => [...(subject.anchors?.companies?.values?.() || [])].find((a) => companyTier(name, a.value) > 0) || null;

/**
 * SEC registrants (CIKs) already tied to the person by a confirmed filing: a
 * Form D that lists them, or the company's own filing. A later filing by the
 * same registrant under another name (WeWork Companies Inc. became The We
 * Company) is theirs by registry identifier, not by a name that a namesake
 * could share. Kept beside the anchors, out of their export.
 */
function knownCiks(subject) {
  const anchors = subject.anchors || (subject.anchors = {});
  if (!anchors.ciks) Object.defineProperty(anchors, 'ciks', { value: new Set(), enumerable: false, writable: true, configurable: true });
  return anchors.ciks;
}
const hasCik = (subject, cik) => Boolean(cik) && Boolean(knownCiks(subject).has(cik));
function noteCik(subject, cik) {
  if (!cik) return;
  const set = knownCiks(subject);
  if (typeof set.add === 'function') set.add(cik);
  else if (typeof set.set === 'function') set.set(cik, { value: cik, origin: 'found', test: () => false });
}
const tiedByCik = (subject, g) => g.entities.some((e) => hasCik(subject, e.cik));

/* ------------------------------------------------------------------ requests */

/** Request options for every SEC call: the job's deadline and, when the owner declared one, their contact user agent. */
function secOptions(ctx, extra = {}) {
  const declared = clean(process.env.SEC_USER_AGENT);
  return { deadline: ctx.deadline, ...(declared ? { headers: { 'User-Agent': declared } } : {}), ...extra };
}

let documentsBlockedUntil = 0;
const documentsBlocked = () => Date.now() < documentsBlockedUntil;
const registrantCache = new Map(); // CIK -> { names, at }
/** Forget a refusal by the document host and the registrant names read (tests). */
export function __resetSecForTests() { documentsBlockedUntil = 0; registrantCache.clear(); }
const noteRefusal = (error) => { if (error?.status === 403 || error?.status === 429) documentsBlockedUntil = Date.now() + BLOCK_PAUSE_MS; };

/**
 * Read one page or filing document from www.sec.gov, or null when it cannot
 * be had. That host refuses clients it does not recognise; after a refusal
 * no further document is asked for during the pause, so a check never
 * hammers it. Used only to enrich a search result, so it never throws.
 */
async function openDocument(url, ctx) {
  if (documentsBlocked()) return null;
  if (ctx.deadline && ctx.deadline - Date.now() < 3500) return null;
  try {
    return await getText(url, secOptions(ctx, { timeoutMs: 9000, maxBytes: DOCUMENT_MAX_BYTES }));
  } catch (error) {
    noteRefusal(error);
    return null;
  }
}

const registrantKnown = (cik) => { const c = registrantCache.get(cik); return Boolean(c && Date.now() - c.at < REGISTRANT_TTL_MS); };
/** A registrant's current and former names from EDGAR's submissions record, or null when it cannot be had. */
async function registrantNames(cik, ctx) {
  const cached = registrantCache.get(cik);
  if (cached && Date.now() - cached.at < REGISTRANT_TTL_MS) return cached.names;
  if (ctx.deadline && ctx.deadline - Date.now() < 3500) return null;
  try {
    const json = await getJson(`${SUBMISSIONS_URL}/CIK${cik}.json`, secOptions(ctx, { timeoutMs: 6000 }));
    const names = uniq([clean(json?.name), ...(Array.isArray(json?.formerNames) ? json.formerNames.map((f) => clean(f?.name)) : [])]);
    registrantCache.set(cik, { names, at: Date.now() });
    return names;
  } catch {
    return null;
  }
}

/**
 * Is the filer of this filing a registrant tied to the person? Either its CIK
 * is already known from a confirmed filing, or one of its EDGAR names (now or
 * formerly) is a known company of theirs, give or take the legal form. Returns
 * { cik, filer, names, via } and remembers the CIK, or null.
 */
async function filerTie(subject, g, ctx) {
  const filer = g.entities[0];
  if (!filer?.cik) return null;
  const names = uniq([filer.name, ...((await registrantNames(filer.cik, ctx)) || [])]);
  let via = null;
  for (const n of names) {
    const a = sameAsKnown(subject, n);
    if (a) { via = { name: n, anchor: a.value }; break; }
  }
  if (!via && !hasCik(subject, filer.cik)) return null;
  noteCik(subject, filer.cik);
  return { cik: filer.cik, filer: filer.name, names, via };
}

/** The tie of a filing whose filer CIK is already known, without asking EDGAR anything. */
const cikTie = (subject, g) => (g.entities[0]?.cik && hasCik(subject, g.entities[0].cik) ? { cik: g.entities[0].cik, filer: g.entities[0].name, names: [g.entities[0].name], via: null } : null);

/** The registrant's EDGAR names, as companies of the person (the tie is the registry identifier). */
const registrantThreads = (tie) => tie.names.slice(0, 5)
  .map((n) => makeThread('company', n, `a name of SEC registrant ${Number(tie.cik)}, ${tie.via ? `which has filed as ${tie.via.name}` : 'tied to the person by an earlier filing'}`, { trusted: true }));

/** A name-only finding by a registrant tied to the person is theirs: graded by that tie. */
function gradeByTie(subject, finding, fields, tie) {
  if (!finding || finding.match !== 'possible' || !tie) return finding;
  const why = tie.via && companyTier(tie.via.name, tie.filer) !== 2 ? `, which also filed as ${tie.via.name}` : '';
  return makeFinding(subject, { ...fields, match: 'confirmed', matchReasons: [`filed by ${tie.filer} (SEC CIK ${Number(tie.cik)})${why}, a company the person is confirmed at`] }) || finding;
}

/**
 * A name-only finding from a filing by a registrant tied to the person that was not read: the full-text index
 * found the name in it, but no passage shows how, so it is 'likely' at most.
 */
function likelyByTie(subject, finding, fields, tie) {
  if (!finding || finding.match !== 'possible' || !tie) return finding;
  return makeFinding(subject, { ...fields, match: 'likely', matchReasons: [`filed by ${tie.filer} (SEC CIK ${Number(tie.cik)}), a company the person is confirmed at; the document was not read`] }) || finding;
}

/** "Nikola Corp  (NKLA)  (CIK 0001731289)" -> { name, tickers, cik } */
function parseEntity(display) {
  const s = clean(display);
  if (!s) return null;
  const m = s.match(/^(.*?)\s*(?:\(([A-Z0-9][A-Z0-9.,\- ]{0,40})\)\s*)?\(CIK (\d{1,10})\)$/);
  return m ? { name: m[1].trim(), tickers: (m[2] || '').trim(), cik: m[3].padStart(10, '0') } : { name: s, tickers: '', cik: '' };
}

/** One search hit (a document inside a filing) as plain fields. Returns null for hits that must not be used. */
function parseHit(raw) {
  const s = raw?._source;
  const id = String(raw?._id || '');
  const colon = id.indexOf(':');
  if (!s || colon < 1) return null;
  const adsh = id.slice(0, colon);
  const file = id.slice(colon + 1);
  const entities = (s.display_names || []).map(parseEntity).filter((e) => e && e.name);
  if (!entities.length || entities.some((e) => MINOR_ENTITY.test(e.name))) return null;
  const cik = String((s.ciks || [])[0] || entities[0].cik || '').replace(/^0+/, '');
  if (!cik || !file) return null;
  const folder = `${ARCHIVES_URL}/${cik}/${adsh.replace(/-/g, '')}`;
  const fileType = clean(s.file_type || s.form);
  const rawUrl = `${folder}/${file}`;
  return {
    adsh, file, entities, fileType,
    form: clean(s.form || s.file_type),
    rootForm: clean((s.root_forms || [])[0] || s.form || s.file_type),
    date: s.file_date || null,
    period: s.period_ending || null,
    items: Array.isArray(s.items) ? s.items.map(String) : [],
    main: !/^EX-/i.test(fileType),
    readable: /\.(htm|html|txt)$/i.test(file),
    rawUrl,
    // XML forms are shown through the SEC's own stylesheet, which is what a person can read
    url: s.xsl && /\.xml$/i.test(file) ? `${folder}/${s.xsl}/${file}` : rawUrl,
  };
}

/** Run one full-text search (up to 100 documents per call). Throws when the search itself fails. */
async function searchFilings(params, ctx) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  qs.set('dateRange', 'custom');
  qs.set('startdt', INDEX_START);
  qs.set('enddt', today());
  const json = await getJson(`${SEARCH_URL}?${qs}`, secOptions(ctx));
  const list = json?.hits?.hits;
  if (!Array.isArray(list)) throw new Error('SEC full-text search returned an unexpected answer');
  const hits = list.map(parseHit).filter(Boolean);
  return { hits, total: Math.max(Number(json.hits.total?.value) || 0, hits.length) };
}

/** Documents grouped into filings, in the order the search ranked them. */
function groupByFiling(hits) {
  const groups = new Map();
  hits.forEach((h, rank) => {
    if (!groups.has(h.adsh)) groups.set(h.adsh, { adsh: h.adsh, form: h.form, rootForm: h.rootForm, date: h.date, period: h.period, items: h.items, entities: h.entities, docs: [], rank });
    groups.get(h.adsh).docs.push(h);
  });
  // The document to show and read: the filing's own text before an exhibit, a page before its PDF copy.
  for (const g of groups.values()) g.best = g.docs.find((d) => d.main && d.readable) || g.docs.find((d) => d.main) || g.docs.find((d) => d.readable) || g.docs[0];
  return [...groups.values()];
}

const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

/** One thread per (kind, value); a thread seen both ways is trusted. */
function dedupeThreads(threads) {
  const out = new Map();
  for (const t of threads) {
    if (!t) continue;
    const key = `${t.kind}|${t.value.toLowerCase()}`;
    const seen = out.get(key);
    if (!seen) out.set(key, t);
    else if (t.trusted && !seen.trusted) out.set(key, { ...seen, trusted: true });
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ describing a filing */

const NOTABLE_ITEMS = {
  '1.03': 'bankruptcy or receivership', '1.05': 'material cybersecurity incident', '3.01': 'delisting notice',
  '4.01': 'change of auditor', '4.02': 'earlier financial statements can no longer be relied on',
  '5.01': 'change in control', '5.02': 'departure or appointment of directors or officers',
};
const EXEMPTIONS = { '04': 'Rule 504', '05': 'Rule 505', '06': 'Rule 506', '06B': 'Rule 506(b)', '06C': 'Rule 506(c)', '4A5': 'Securities Act Section 4(a)(5)' };

const docLabel = (doc) => (doc.main ? '' : ` (exhibit ${doc.fileType.replace(/^EX-/i, '')})`);
const notableItem = (items) => items.map((i) => NOTABLE_ITEMS[i]).find(Boolean) || '';
const filersOf = (g) => listText(g.entities.map((e) => e.name), 3);

/** One line built only from the search index's own fields. */
function recordLine(g) {
  const isD = g.rootForm === 'D';
  const items = g.items.length
    ? (isD ? `exemption claimed: ${g.items.map((i) => EXEMPTIONS[String(i).toUpperCase()] || i).join(', ')}` : `items ${g.items.map((i) => (NOTABLE_ITEMS[i] ? `${i} (${NOTABLE_ITEMS[i]})` : i)).join(', ')}`)
    : '';
  const where = g.docs && g.docs.some((d) => !d.main) ? `name found in: ${uniq(g.docs.map((d) => (d.main ? 'the main document' : `exhibit ${d.fileType.replace(/^EX-/i, '')}`))).slice(0, 4).join(', ')}` : '';
  return [`Form ${g.form}`, `filed ${g.date || 'on an unknown date'} by ${listText(g.entities.map(entityLabel), 4)}`, g.period ? `period ${g.period}` : '', items, where].filter(Boolean).join('; ');
}

/* ------------------------------------------------------------------ reading a filing */

/**
 * The readable text of a filing document. Paragraphs, list items and table
 * rows end in a line break; everything inside one is on a single line, so a
 * passage can be cut where the filing itself breaks.
 */
function filingText(body) {
  const raw = String(body || '');
  const isHtml = /<(?:html|body|div|p|td|font|span)\b/i.test(raw.slice(0, 200000));
  // In HTML a line break in the source means nothing; in a plain-text filing a blank line ends a paragraph.
  const source = isHtml ? raw.replace(/\s+/g, ' ') : raw.replace(/\r/g, '').replace(/\n[ \t]*\n\s*/g, '\u0001').replace(/\s+/g, ' ').replace(/\u0001/g, '<br>');
  return fixControlChars(decodeEntities(htmlToText(source))).replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}

/** The readable text of a filing document, or null when it could not be opened. */
async function documentText(doc, ctx) {
  if (!doc.readable) return null;
  const body = await openDocument(doc.rawUrl, ctx);
  return body ? filingText(body) : null;
}

const NOT_SENTENCE_END = '(?<!\\b(?:Mr|Mrs|Ms|Dr|Messrs|Inc|Corp|Co|Ltd|No|Nos|Jr|Sr|St|vs|v|[A-Z]))';
// Where a passage may start or stop: a line break of the filing, or the end of a sentence.
const BOUNDARY = new RegExp(`\\n+|${NOT_SENTENCE_END}[.!?]["”’)]*[ ]+(?=["“(]?[A-Z])`, 'g');
// A sentence that gives someone's address is not diligence: it is cut from quoted passages.
const ADDRESS_HINT = /\b(?:address (?:of|for|is)|addresses (?:of|for|are)|P\.?\s?O\.?\s+Box|c\/o|resid(?:es|ing) (?:at|in)|residence (?:at|is))\b/i;

/** A passage as it is quoted (one line) and as it is read for threads (the filing's line breaks become sentence ends). */
const flat = (passage) => String(passage || '').replace(/\s*\n\s*/g, ' ').trim();
const asSentences = (passage) => String(passage || '').replace(/([^.!?:;,\n])\s*\n\s*/g, '$1. ').replace(/\s*\n\s*/g, ' ').trim();

/**
 * The text around [start, end), opened and closed on sentence or paragraph
 * boundaries where they are in reach. Line breaks of the filing are kept.
 */
function excerptAround(text, start, end, { lead = 260, trail = 420, max = 620 } = {}) {
  const lo = Math.max(0, start - lead);
  const hi = Math.min(text.length, end + trail);
  let a = lo;
  let openClean = lo === 0;
  for (const m of text.slice(lo, start).matchAll(BOUNDARY)) { a = lo + m.index + m[0].length; openClean = true; }
  if (!openClean) a = Math.max(lo, start - 120);
  let b = -1;
  for (const m of text.slice(end, hi).matchAll(BOUNDARY)) {
    const at = end + m.index + (m[0][0] === '\n' ? 0 : m[0].trimEnd().length);
    if (at - a > max) break;
    b = at;
  }
  let closeClean = b >= 0;
  // The document's own end, when it is in reach, is the best place to stop.
  if (hi === text.length && hi - a <= max) { b = hi; closeClean = true; }
  if (!closeClean) b = Math.min(hi, end + 200, a + max);
  const raw = text.slice(a, b);
  // Sentences that only give an address are left out, unless they are the ones that name the person.
  const kept = [];
  let last = 0;
  const keep = (from, to) => {
    const piece = raw.slice(from, to);
    const holdsName = a + from < end && a + to > start;
    if (holdsName || !ADDRESS_HINT.test(piece)) kept.push(piece);
  };
  for (const m of raw.matchAll(BOUNDARY)) { keep(last, m.index + m[0].length); last = m.index + m[0].length; }
  keep(last, raw.length);
  let out = kept.join('').trim();
  // A cut made exactly at the matched term (lead 0) starts on a whole word: only a cut mid-text drops its first, partial word.
  if (!openClean) out = `… ${a === start ? out : out.replace(/^\S*[ ]+/, '')}`;
  if (!closeClean) out = `${out.replace(/[ ]+\S*$/, '')} …`;
  return out;
}

// Words that stand before a name without being part of it ("Chairman Trevor Milton", "and Trevor Milton").
const NAME_LEADERS = new Set(('mr mrs ms miss dr prof professor sir dame lord lady hon honorable judge justice senator sen rep representative congressman congresswoman governor gov mayor'
  + ' president chairman chairwoman chairperson chair director directors officer officers founder founders cofounder co-founder ceo cfo coo cto executive chief secretary treasurer partner member manager trustee'
  + ' defendant defendants plaintiff plaintiffs respondent respondents petitioner name names signature signed by attention attn dear and or the of to from with for against versus vs v messrs between'
  + ' former formerly then current our its his her their billionaire entrepreneur investor analyst author editor contact signatory witness purchaser holder stockholder shareholder seller buyer lender borrower'
  + ' guarantor employee consultant advisor adviser inc llc corp ltd company corporation nominee nominees independent').split(' '));
// Words that open a sentence before a bare surname ("After Milton resigned").
const SENTENCE_OPENERS = new Set(('after before when while if because although though since however thereafter once until unless whether where as that but so yet thus also both neither either instead despite during following upon under'
  + ' over among through without within according regarding concerning by in on at this these those such each any all no not').split(' '));
// A trust or account held for a child: the person named there is never reported.
const MINOR_CONTEXT = /\b(?:FBO|F\/B\/O|UTMA|UGMA|[Cc]ustodian (?:for|of)|(?:a|the) minor\b|[Mm]inors\b|[Cc]hildren'?s? [Tt]rust|[Cc]hildrens\b|[Gg]randchildren'?s? [Tt]rust)/;

/** Is this mention inside a longer name ("Erin Elizabeth Holmes", "Elizabeth Holmes-Smith", "J. Adam Neumann")? */
function insideLongerName(text, spot) {
  if (/^-[A-Za-zÀ-ÿ]/.test(text.slice(spot.end, spot.end + 2))) return true;
  const m = text.slice(Math.max(0, spot.start - 40), spot.start).match(/(?:^|[\s(“"])([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*\.?)[ ]+$/);
  if (!m) return false;
  const word = m[1];
  const bare = word.replace(/\.$/, '');
  if (NAME_LEADERS.has(bare.toLowerCase())) return false;
  if (/^[A-Z]\.$/.test(word)) return true; // an initial
  if (word.endsWith('.')) return false; // an abbreviation, or the end of the sentence before
  return spot.text === spot.text.toUpperCase() ? /^[A-ZÀ-Þ'’-]{2,}$/.test(bare) : /^[A-ZÀ-Þ][a-zà-ÿ'’-]+$/.test(bare);
}

/** Does the document name someone else with the same surname ("Ned S. Holmes")? Then "Mr. Holmes" may not be the person. */
function sharesSurname(text, subject, surname) {
  const want = subjectTokens(subject);
  const re = new RegExp(`(?<![A-Za-z-])([A-ZÀ-Þ][a-zà-ÿ'’-]+)[ ]+(?:[A-Z]\\.?[ ]+)?${escapeRe(surname)}(?![A-Za-z-])`, 'g');
  for (const m of text.matchAll(re)) {
    const given = stripAccents(m[1]).toLowerCase().replace(/['’]/g, '');
    if (NAME_LEADERS.has(given) || SENTENCE_OPENERS.has(given) || want.slice(0, -1).includes(given)) continue;
    return true;
  }
  return false;
}

/**
 * Where the person is named in a document.
 *   own     mentions that are the person's own name; with `honorific`, also
 *           "Mr. Surname" (when no one else in the document has the surname),
 *           and with `informal` the first name used on its own ("Adam's"),
 *           which only a company's own filing about its founder does
 *   longer  mentions inside a longer name: most likely someone else
 */
function nameSpots(text, subject, { honorific = false, informal = false } = {}) {
  const own = [];
  const longer = [];
  for (const spot of subject.hasName.positions(text)) {
    if (MINOR_CONTEXT.test(text.slice(Math.max(0, spot.start - 70), spot.end + 70))) continue;
    (insideLongerName(text, spot) ? longer : own).push(spot);
  }
  if (own.length && (honorific || informal)) {
    const words = nameWords(subject);
    const surname = words[words.length - 1];
    const add = (re) => { for (const m of text.matchAll(re)) own.push({ start: m.index, end: m.index + m[0].length, text: m[0] }); };
    if (honorific && words.length >= 2 && !sharesSurname(text, subject, surname)) add(new RegExp(`\\b(?:Mr|Ms|Mrs|Dr)\\.?[ ]+${escapeRe(surname)}(?![A-Za-z-])`, 'g'));
    if (informal && words.length >= 2 && words[0].length >= 4) add(new RegExp(`(?<![A-Za-z-])${escapeRe(words[0])}[’']s(?![A-Za-z])`, 'g'));
    own.sort((x, y) => x.start - y.start);
  }
  return { own, longer };
}

// Sentence ends inside a quoted passage ("Mr." and an initial are not ends; a semicolon is).
const SENTENCE_SPLIT = new RegExp(`${NOT_SENTENCE_END}[.!?;]["”’)]*\\s+`);

/**
 * How serious a passage is, read only from the sentences that name the
 * person: a merger deck's career bio of another executive ("... through its
 * bankruptcy") says nothing about them. 'info' when no sentence names them.
 */
function personSeverity(subject, passage) {
  const text = asSentences(passage);
  const surname = surnameOf(subject);
  const honorific = surname && !sharesSurname(text, subject, surname) ? new RegExp(`\\b(?:Mr|Ms|Mrs|Dr)\\.?[ ]+${escapeRe(surname)}(?![A-Za-z-])`) : null;
  const sentences = text.split(SENTENCE_SPLIT).filter((s) => subject.hasName(s) || (honorific && honorific.test(s)));
  return sentences.length ? severityFromText(sentences.join(' ')) : 'info';
}
/** Exhibits (decks, press releases, agreements) and 8-Ks talk about many people: only the person's own sentences are graded. */
const passageSeverity = (subject, g, quote) => (!g.best.main || /^8-K/.test(g.rootForm) ? personSeverity(subject, quote) : severityFromText(quote));

/**
 * The best place in a document: each spot (a mention of the name) is scored
 * by what stands within `radius` characters of it. `score(window, offset)`
 * returns { points, start?, end? } or null; the passage then spans the name
 * and the supporting term.
 */
function bestSpot(text, spots, score, radius = 300) {
  let best = null;
  const step = Math.max(1, Math.ceil(spots.length / 160)); // a long document: sample the mentions evenly
  for (let i = 0; i < spots.length; i += step) {
    const spot = spots[i];
    const lo = Math.max(0, spot.start - radius);
    const s = score(text.slice(lo, Math.min(text.length, spot.end + radius)), lo);
    if (!s || !(s.points > 0)) continue;
    if (!best || s.points > best.points) best = { points: s.points, start: Math.min(spot.start, s.start ?? spot.start), end: Math.max(spot.end, s.end ?? spot.end) };
  }
  return best;
}

const CAREER_WORDS = /\b(co-?founders?|founders?|founded|chief executive|CEO|president|chair(?:man|woman|person)?|directors?|officer|has served|serves as|served as|appointed|resign\w*|stepped down|terminat\w*|joined|age \d{2})\b/gi;
const careerScore = (window) => ({ points: 1 + new Set((window.match(CAREER_WORDS) || []).map((w) => w.toLowerCase())).size });
/** A passage that also names a company already tied to the person is the one to quote: it shows whose record this is. */
const preferKnown = (subject, score) => (window, offset) => {
  const s = score(window, offset);
  if (!(s && s.points > 0 && knownCompany(subject, window))) return s;
  // The passage is stretched to take in the company's name, so the quote itself shows whose record this is.
  const at = knownCompanySpot(subject, window);
  return { ...s, points: s.points + 6, ...(at ? { start: Math.min(s.start ?? offset + at.start, offset + at.start), end: Math.max(s.end ?? offset + at.end, offset + at.end) } : {}) };
};
/** Where in a window a known company of the person is written (its name as recorded, or without the legal form), nearest the window's middle (the name), or null. */
function knownCompanySpot(subject, window) {
  let best = null;
  const mid = window.length / 2;
  const gap = (m) => Math.abs(m.start + (m.end - m.start) / 2 - mid);
  for (const a of subject.anchors?.companies?.values?.() || []) {
    if (!a.test(window)) continue;
    const core = companyCore(a.value);
    const forms = uniq([clean(a.value), core.length >= 3 ? core.split(' ').map(escapeRe).join('[\\s.,&-]+') : '']);
    for (const f of forms) {
      const re = new RegExp(`(?<![A-Za-z0-9])${f === clean(a.value) ? escapeRe(f) : f}(?![A-Za-z0-9])`, 'gi');
      for (const m of window.matchAll(re)) {
        if (!/[A-Z0-9]/.test(m[0][0])) continue; // a company's name is written with a capital
        const here = { start: m.index, end: m.index + m[0].length };
        if (!best || gap(here) < gap(best)) best = here;
      }
    }
  }
  return best;
}

const KIN_WORD = /\b(brothers?(?:-in-law)?|sisters?(?:-in-law)?(?! (?:compan|corporation|entit|fund|firm|subsidiar|organi[sz]ation|bank|brand|plant|hotel|propert|publication|ship))|siblings?|spouses?|wife|husband|father(?:-in-law)?|mother(?:-in-law)?(?! (?:company|ship|board|lode|vessel))|step(?:father|mother|brother|sister)|cousins?|uncle|aunt|married to|domestic partner)\b/i;
const FAMILY_TERM = /\b(immediate family|family members?|members? of (?:his|her|the|their) (?:immediate )?family|family relationships?)\b/i;
const RELATED_TERM = /\b(related[- ](?:part(?:y|ies)|persons?)|[Ff]amily (?:[Tt]rust|[Ff]oundation|[Oo]ffice|[Pp]artnership|[Hh]oldings|L\.?L\.?C\.?|L\.?P\.?|[Ll]imited [Pp]artnership))/i;
function kinScore(window, offset) {
  const kin = KIN_WORD.exec(window);
  const family = FAMILY_TERM.exec(window);
  const related = RELATED_TERM.exec(window);
  const hit = kin || family || related;
  if (!hit) return null;
  return { points: (kin ? 4 : 0) + (family ? 2 : 0) + (related ? 1 : 0), start: offset + hit.index, end: offset + hit.index + hit[0].length };
}

// A founder's dealings with their own company: buildings leased to it, loans, a trademark sold to it.
const DEAL_TERM = /\b(leases?|leased|leasing|landlord|loans?|loaned|promissory notes?|trademarks?|purchased from|sold to|rent(?:al)?|reimburs\w*|paid (?:to|by)|payments? (?:to|of|from))\b/i;
const DEAL_POINTS = 10;
/** Dealings next to the name outrank a passage that only mentions a relative or a marriage. */
function dealScore(window, offset) {
  const kin = kinScore(window, offset);
  const deals = [...window.matchAll(new RegExp(DEAL_TERM.source, 'gi'))];
  if (!deals.length) return kin;
  const first = deals[0];
  return { points: DEAL_POINTS + new Set(deals.map((m) => m[0].toLowerCase())).size + (kin ? 1 : 0), start: offset + first.index, end: offset + first.index + first[0].length };
}

/**
 * A passage that names the person, read from the filing.
 *   null   the document could not be opened
 *   false  it was read and does not name the person (the name is part of a
 *          longer one, or stands in a trust held for a child)
 * `trustFiler`: the filer is a company already tied to the person, so a
 * mention glued to another word is still theirs.
 */
async function namedPassage(doc, ctx, { score = careerScore, trustFiler = false } = {}) {
  const text = await documentText(doc, ctx);
  if (!text) return null;
  const { own, longer } = nameSpots(text, ctx.subject);
  const spots = own.length ? own : (trustFiler ? longer : []);
  if (!spots.length) return false;
  const spot = bestSpot(text, spots, preferKnown(ctx.subject, score)) || spots[0];
  return excerptAround(text, spot.start, spot.end);
}

/** Threads a passage offers, read sentence by sentence. Filings call a predecessor "Legacy X": the company is X. */
function passageThreads(subject, passage, url, trusted) {
  return threadsFromResult(subject, { title: '', snippet: asSentences(passage), url }, { trusted })
    .map((t) => (t.kind === 'company' ? makeThread('company', t.value.replace(/^(?:Legacy|New|Old|Former)\s+/, ''), t.why, { trusted: t.trusted }) : t));
}

/* ------------------------------------------------------------------ relatives in a disclosure */

const PERSON = "[A-ZÀ-Þ][a-zA-ZÀ-ÿ'’-]+(?:\\s+(?:[A-Z]\\.|de|van|von|bin|al|del|la|le|[A-ZÀ-Þ][a-zA-ZÀ-ÿ'’-]+)){1,3}";
const KIN = 'brother-in-law|sister-in-law|father-in-law|mother-in-law|brother|sister|sibling|spouse|wife|husband|father|mother|stepfather|stepmother|cousin|uncle|aunt';
// What makes a relative relevant here: the filing gives them a part in the company's business.
const BUSINESS_ROLE = /\b(employ\w*|serv(?:es|ed|ing) as|officer|director|president|chief|manager|owner|owns|owned|controls?|controlled|founder|partner|consult\w*|compensation|salary|paid|lease[sd]?|leasing|landlord|purchas\w*|loan\w*|lender|invest\w*|stockholder|shareholder|trustee|affiliate\w*|vendor|supplier|contractor)\b/i;
const NOT_A_PERSON = /^(The|Our|We|In|On|At|And|But|Mr|Mrs|Ms|Dr|Each|Such|This|That|Certain|Company|Chief|President|Chairman|Director|Executive|Board|Related|Party)\b|\b(Inc|LLC|Ltd|Corp|Capital|Ventures|Partners|Company|Fund|Trust|Holdings|Agreement|Board|Committee|Officer|Director|Chairman|President)\b/;

// A clause that goes on with a verb is about the name just before it ("Jane Roe, the sister of Mr. Roe, is employed as").
const PREDICATE_START = /^[\s,]*(?:(?:and|who)\s+)?(?:also\s+)?(?:is|are|was|were|has|have|had|serves?|served|works?|worked|holds?|held|owns?|owned|controls?|controlled|receives?|received|leases?|leased|provides?|provided|acts?|acted|became|becomes|remains?|remained|joined|employ\w*)\b/i;
const TITLE_WORD = /^(?:[A-Z][A-Za-z&'’-]*|of|and|for|the|our|its)$/;

/** The phrase a role word opens, cut at the clause's next comma: "employees of Legacy Acme", "serves as our Vice President of Sales". */
function rolePhrase(region, at) {
  const words = region.slice(0, at).split(/\s+/).filter(Boolean);
  let back = 0;
  // the start of a title the role word ends ("Vice President")
  while (back < 3 && words.length - back > 0 && /^[A-Z][a-z]+$/.test(words[words.length - 1 - back])) back += 1;
  const lead = back ? `${words.slice(words.length - back).join(' ')} ` : '';
  const tail = region.slice(at).split(/[,;.]/)[0].trim().split(/\s+/).slice(0, 10).join(' ');
  return clean(`${lead}${tail}`).replace(/\s+(?:and|or|the|of|our|its|a|an)$/i, '');
}

/**
 * Relatives a related-party passage names, in the phrasing filings use
 * ("Jane Roe, the sister of Mr. Roe, is employed as ..."). Kept only when the
 * clause that names the relative gives them a part in the business: the
 * words after their name when the clause goes on about them, or the words
 * before it ("employees of Legacy Acme, including Ms. Roe's relatives, ...")
 * when no one else is named there. A role that follows another person's name
 * ("Jim Doe, our Chief Legal Officer") is that person's. Sons and daughters
 * are never read.
 */
function relativesInDisclosure(subject, passage) {
  const words = nameWords(subject);
  const surname = escapeRe(words[words.length - 1]);
  const full = subject.variants.map((v) => v.split(/\s+/).map(escapeRe).join('\\s+')).join('|');
  const who = `(?:(?:Mr|Ms|Mrs|Dr)\\.?\\s+${surname}|${full})`;
  const possessor = `(?:(?:Mr|Ms|Mrs|Dr)\\.?\\s+${surname}|${full}${words[0].length >= 4 ? `|${escapeRe(words[0])}` : ''})`;
  const text = flat(passage);
  if (mentionsMinor(text) || isSensitive(text)) return [];
  // Someone else named in a stretch of the clause: an honorific, a name with an initial, a name with an
  // appositive ("Jim Doe, our ..."), or the person themselves.
  const otherPeople = (region, relative) => {
    const re = new RegExp(`\\b(?:Mr|Ms|Mrs|Dr)\\.?\\s+[A-ZÀ-Þ][A-Za-zÀ-ÿ'’-]+|[A-ZÀ-Þ][a-zà-ÿ'’-]+\\s+[A-Z]\\.\\s+[A-ZÀ-Þ][a-zà-ÿ'’-]+|(?:${PERSON})(?=,\\s+(?:our|the|its|their|his|her|who)\\b)|(?<![A-Za-z])${possessor}(?![A-Za-z])`, 'g');
    return [...region.matchAll(re)].filter((m) => !m[0].includes(relative) && !relative.includes(m[0])).map((m) => m.index);
  };
  const clauseStart = (at) => {
    let a = 0;
    for (const m of text.slice(0, at).matchAll(BOUNDARY)) a = m.index + m[0].length;
    return Math.max(a, text.lastIndexOf(';', at - 1) + 1);
  };
  const clauseEnd = (at) => {
    const rest = text.slice(at);
    const m = [...rest.matchAll(BOUNDARY)][0];
    const semi = rest.indexOf(';');
    return at + Math.min(m ? m.index : rest.length, semi >= 0 ? semi : rest.length);
  };
  /** The role the words after `from` give the name just before it, when the clause goes on about that name. */
  const roleAfter = (from, relative) => {
    const region = text.slice(from, clauseEnd(from));
    if (!PREDICATE_START.test(region)) return '';
    const cut = otherPeople(region, relative)[0];
    const own = cut === undefined ? region : region.slice(0, cut);
    const m = own.match(BUSINESS_ROLE);
    return m ? rolePhrase(own, m.index) : '';
  };
  /** The role the words before `to` in the same clause give, when no one else is named there. */
  const roleBefore = (to, relative) => {
    const region = text.slice(clauseStart(to), to);
    if (otherPeople(region, relative).length) return '';
    const all = [...region.matchAll(new RegExp(BUSINESS_ROLE.source, 'gi'))];
    return all.length ? rolePhrase(region, all[all.length - 1].index) : '';
  };
  const found = new Map();
  const add = (rawName, relation, start, end, aboutRelative = true) => {
    const name = clean(rawName).replace(/[’']s$/, '').replace(/[,.;:]+$/, '');
    const parts = name.split(' ');
    if (parts.length < 2 || parts.length > 4 || NOT_A_PERSON.test(name) || subject.hasName(name)) return;
    let role = (aboutRelative && roleAfter(end, name)) || roleBefore(start, name);
    // elsewhere in the passage, a clause about the relative by name ("Jane Roe serves as ...")
    for (const m of text.matchAll(new RegExp(`(?<![A-Za-z])${escapeRe(name)}(?![A-Za-z])`, 'g'))) {
      if (role) break;
      role = roleAfter(m.index + m[0].length, name);
    }
    if (!role) return; // family only: not our business
    if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, relation: relation.toLowerCase(), role });
  };
  const end = (m) => m.index + m[0].length;
  for (const m of text.matchAll(new RegExp(`(${PERSON}),\\s+(?:who\\s+is\\s+)?(?:the|a)\\s+(${KIN})\\s+of\\s+${who}`, 'g'))) add(m[1], m[2], m.index, end(m));
  for (const m of text.matchAll(new RegExp(`(${PERSON})\\s+is\\s+(?:the\\s+|a\\s+)?(${KIN})\\s+of\\s+${who}`, 'g'))) add(m[1], m[2], m.index, end(m));
  for (const m of text.matchAll(new RegExp(`${possessor}[’']s\\s+(${KIN}),?\\s+(${PERSON})`, 'g'))) add(m[2], m[1], m.index, end(m));
  for (const m of text.matchAll(new RegExp(`\\b(${KIN})\\s+of\\s+${who},\\s+(${PERSON})`, 'g'))) add(m[2], m[1], m.index, end(m));
  // "Adam is married to Rebekah Neumann" (the clause goes on about Adam) / "Rebekah Neumann is married to Mr. Neumann"
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z])${possessor}\\s+is\\s+married\\s+to\\s+(${PERSON})`, 'g'))) add(m[1], 'spouse', m.index, end(m), false);
  for (const m of text.matchAll(new RegExp(`(${PERSON})\\s+is\\s+married\\s+to\\s+${who}`, 'g'))) add(m[1], 'spouse', m.index, end(m));
  // "Mr. Roe's relatives, Jane Roe and John Roe, ..." / "Mr. Roe's brothers, Jim Roe and Joe Roe"
  for (const m of text.matchAll(new RegExp(`${possessor}[’']s\\s+(relatives|brothers|sisters|siblings|cousins),?\\s+(${PERSON})(?:,?\\s+and\\s+(${PERSON}))?`, 'g'))) {
    const relation = m[1].toLowerCase().replace(/s$/, '');
    add(m[2], relation, m.index, end(m));
    if (m[3]) add(m[3], relation, m.index, end(m));
  }
  return [...found.values()];
}

/* ------------------------------------------------------------------ Form D */

const xmlInner = (xml, name) => (String(xml || '').match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')) || [])[1] || '';
const xmlBlocks = (xml, name) => [...String(xml || '').matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => m[1]);
const xmlValue = (xml, name) => clean(decodeEntities(xmlInner(xml, name).replace(/<[^>]+>/g, ' ')));
const NO_VALUE = /^(none|n\/?a|not applicable|-+|\.+)?$/i;
const money = (v) => (/^\d+(\.\d+)?$/.test(v) ? `$${Number(v).toLocaleString('en-US')}` : v);
const properCase = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, p, c) => p + c.toUpperCase()));

/**
 * The fields of a Form D that matter: issuer, incorporation, first sale,
 * amounts and the related persons with their roles. Address and phone nodes
 * (issuerAddress, issuerPhoneNumber, relatedPersonAddress) are never read.
 */
export function parseFormD(xml) {
  if (!/<edgarSubmission[\s>]/i.test(String(xml || ''))) return null;
  const issuer = xmlInner(xml, 'primaryIssuer');
  const year = xmlInner(issuer, 'yearOfInc');
  const firstSale = xmlInner(xml, 'dateOfFirstSale');
  const signature = xmlInner(xml, 'signature');
  const persons = xmlBlocks(xml, 'relatedPersonInfo').map((block) => {
    const nameBlock = xmlInner(block, 'relatedPersonName');
    const first = xmlValue(nameBlock, 'firstName');
    const last = xmlValue(nameBlock, 'lastName');
    const isOrg = NO_VALUE.test(first) || ORG_WORD.test(last);
    const name = properCase(clean(isOrg ? last : `${first} ${xmlValue(nameBlock, 'middleName')} ${last}`));
    return { name, isOrg, roles: xmlBlocks(block, 'relationship').map((r) => clean(decodeEntities(r))).filter(Boolean), clarification: xmlValue(block, 'relationshipClarification') };
  }).filter((p) => p.name.length > 1);
  return {
    issuerName: xmlValue(issuer, 'entityName'),
    jurisdiction: xmlValue(issuer, 'jurisdictionOfInc'),
    entityType: xmlValue(issuer, 'entityType'),
    previousNames: uniq([...xmlBlocks(xmlInner(issuer, 'issuerPreviousNameList'), 'previousName'), ...xmlBlocks(xmlInner(issuer, 'edgarPreviousNameList'), 'previousName')].map((n) => clean(decodeEntities(n))).filter((n) => !NO_VALUE.test(n))),
    yearOfInc: xmlValue(year, 'value') || (/<overFiveYears>\s*true/i.test(year) ? 'more than five years before the filing' : /<yetToBeFormed>\s*true/i.test(year) ? 'yet to be formed' : ''),
    firstSale: xmlValue(firstSale, 'value') || (/<yetToOccur>\s*true/i.test(firstSale) ? 'yet to occur' : ''),
    isAmendment: /<isAmendment>\s*true/i.test(String(xml)),
    industry: xmlValue(xml, 'industryGroupType'),
    totalOffering: xmlValue(xml, 'totalOfferingAmount'),
    totalSold: xmlValue(xml, 'totalAmountSold'),
    signer: { name: properCase(xmlValue(signature, 'nameOfSigner')), title: xmlValue(signature, 'signatureTitle') },
    persons,
  };
}

async function readFormD(hit, ctx) {
  const xml = await openDocument(hit.rawUrl, ctx);
  return xml ? parseFormD(xml) : null;
}

/**
 * How a Form D relates to the subject: named with a role, only the signer, a
 * longer name that merely contains theirs, or not named. `nickname` lets the
 * notice's formal name ("Samuel") stand for the name given ("Sam"); it is
 * only used when the issuer is already a known company of the person.
 */
function subjectOnFormD(doc, subject, { nickname = false } = {}) {
  const want = subjectTokens(subject);
  const person = doc.persons.find((p) => !p.isOrg && namesAgree(personTokens(p.name), want, { nickname }));
  if (person) return { person };
  if (doc.signer.name && namesAgree(personTokens(doc.signer.name), want, { nickname })) return { signer: doc.signer };
  const lookalike = [...doc.persons.map((p) => p.name), doc.signer.name].some((n) => n && subject.hasName(n));
  return lookalike ? { namesake: true } : {};
}

const rolesText = (roles) => (roles.length ? joinAnd(roles) : 'a related person');

const CEO_TITLE = /\b(?:chief executive(?: officer)?|CEO)\b/i;
/**
 * Does the notice say the person is the issuer's chief executive? Form D only
 * offers "Executive Officer", which a finance chief also ticks, so the
 * clarification of their entry or the title they signed under must say so.
 */
function ceoOnFormD(doc, on) {
  if (on.person && on.person.roles.some((r) => /executive officer/i.test(r)) && CEO_TITLE.test(on.person.clarification || '')) return true;
  const signedAsCeo = CEO_TITLE.test(doc.signer.title || '') && !/\b(?:former|interim|acting|co-?)\b/i.test(doc.signer.title || '');
  if (on.signer && signedAsCeo) return true;
  if (on.person && signedAsCeo && doc.signer.name && namesAgree(personTokens(doc.signer.name), personTokens(on.person.name))) return true;
  return false;
}

/**
 * A confirmed Form D that states the person is the issuer's CEO records the
 * role for the span the notices cover (first to last notice that names them):
 * a news item from that time about "<issuer>'s CEO" may then be about them.
 * The span is never left open, since a notice says nothing about when they left.
 */
function noteFormDRole(subject, issuerNames, dates, origin) {
  const days = uniq(dates.map((d) => String(d || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).sort();
  if (!days.length) return;
  for (const org of uniq(issuerNames.map(clean)).slice(0, 2)) addRoleAnchor(subject, { org, role: 'ceo', from: days[0], to: days[days.length - 1], origin });
}
/** "Sam Bankman-Fried (listed as Samuel Bankman-Fried)" when the notice writes the name differently. */
const asListed = (subject, listed) => (listed && !subject.hasName(listed) ? `${subject.name} (listed as ${listed})` : subject.name);

function formDTitle(form, issuerName, subject, on, fallback) {
  if (on.person) return `Form ${form} filed by ${issuerName} names ${asListed(subject, on.person.name)} as ${rolesText(on.person.roles)}`;
  if (on.signer) return `Form ${form} filed by ${issuerName} is signed by ${asListed(subject, on.signer.name)}${on.signer.title ? ` (${on.signer.title})` : ''}`;
  return fallback;
}

/** The supporting line for a Form D, from its own fields. */
function formDQuote(doc, { person, signer, others = [] }) {
  const issuerFacts = [doc.entityType, doc.jurisdiction].filter(Boolean).join(', ');
  return [
    `Issuer: ${doc.issuerName}${issuerFacts ? ` (${issuerFacts})` : ''}`,
    doc.previousNames.length ? `previous names: ${doc.previousNames.slice(0, 3).join(', ')}` : '',
    doc.yearOfInc ? `year of incorporation: ${doc.yearOfInc}` : '',
    person ? `related person: ${person.name}, ${rolesText(person.roles)}${person.clarification ? ` (${person.clarification})` : ''}` : '',
    doc.firstSale ? `date of first sale: ${doc.firstSale}` : '',
    doc.totalOffering ? `total offering amount: ${money(doc.totalOffering)}` : '',
    doc.totalSold ? `total amount sold: ${money(doc.totalSold)}` : '',
    doc.industry ? `industry: ${doc.industry}` : '',
    others.length ? `other related persons: ${others.slice(0, 6).map((p) => `${p.name} (${p.roles.join(', ') || 'related person'})`).join(', ')}` : '',
    signer || doc.signer.name ? `signed by ${(signer || doc.signer).name}${(signer || doc.signer).title ? `, ${(signer || doc.signer).title}` : ''}` : '',
  ].filter(Boolean).join('; ');
}

const officerRank = (p) => (p.roles.some((r) => /executive/i.test(r)) ? 0 : p.roles.some((r) => /director/i.test(r)) ? 1 : 2);

/**
 * The other people on Form D notices that name the subject, executives
 * first, as associate threads. The same person written two ways ("Steven M.
 * Langman", "Steven Langman") is listed once.
 */
function associateThreads(entries, max = 8) {
  const people = new Map();
  for (const { doc, person, issuerName, trusted } of entries) {
    for (const p of doc.persons) {
      if (p === person || p.isOrg || p.name.split(' ').length < 2) continue;
      const tokens = personTokens(p.name);
      const key = `${tokens[0]} ${tokens[tokens.length - 1]}`;
      const seen = people.get(key);
      if (!seen || officerRank(p) < seen.rank) people.set(key, { name: seen?.name || p.name, rank: officerRank(p), why: `${rolesText(p.roles)} of ${issuerName} on the same Form D`, trusted: trusted || Boolean(seen?.trusted) });
      else if (trusted) seen.trusted = true;
    }
  }
  return [...people.values()].sort((a, b) => a.rank - b.rank).slice(0, max).map((p) => makeThread('associate', p.name, p.why, { trusted: p.trusted }));
}

/* ------------------------------------------------------------------ person: Form D */

async function personFormD(ctx) {
  const { subject } = ctx;
  const names = searchNames(subject);
  let requests = 0;
  const hits = [];
  const seen = new Set();
  for (const name of names) {
    const result = await searchFilings({ q: `"${name}"`, forms: 'D' }, ctx);
    requests += 1;
    for (const h of result.hits) if (!seen.has(h.adsh)) { seen.add(h.adsh); hits.push(h); }
  }
  // A notice lists people by their formal name ("Samuel", a middle name), which the exact phrase misses.
  // For an uncommon surname the notices are few enough to read and check.
  let bySurname = false;
  if (!hits.length) {
    const surname = surnameOf(subject);
    if (surname.length < 4) return { findings: [] };
    const result = await searchFilings({ q: `"${surname}"`, forms: 'D' }, ctx);
    requests += 1;
    if (!result.hits.length || result.total > SURNAME_MAX_HITS) return { findings: [] };
    hits.push(...result.hits);
    bySurname = true;
  }

  // One entry per issuer: the latest notice is the record, the others give the span.
  const issuers = new Map();
  for (const h of hits) {
    const key = filerKey(h.entities[0]);
    if (!issuers.has(key)) issuers.set(key, { filings: [] });
    issuers.get(key).filings.push(h);
  }
  const list = [...issuers.values()].map((i) => {
    const filings = i.filings.sort(byDateDesc);
    return { filings, latest: filings[0], name: filings[0].entities[0].name, names: uniq(filings.map((f) => f.entities[0].name)) };
  }).map((i) => ({ ...i, known: knownCompany(subject, i.names.join('. ')) }))
    .sort((a, b) => Number(b.known) - Number(a.known) || byDateDesc(a.latest, b.latest)).slice(0, 10);

  const read = list.slice(0, Math.max(1, 4 - requests));
  const docs = await mapLimit(read, 2, (i) => readFormD(i.latest, ctx));
  const findings = [];
  const threads = [];
  const named = [];
  let unread = 0;
  list.forEach((issuer, index) => {
    const doc = docs[index] || null;
    const g = { ...issuer.latest, docs: [issuer.latest] };
    const known = issuer.known || Boolean(doc && knownCompany(subject, [doc.issuerName, ...doc.previousNames].join('. ')));
    const on = doc ? subjectOnFormD(doc, subject, { nickname: known }) : {};
    if (on.namesake) return; // the filing names someone whose longer name only contains the subject's
    if (bySurname && !on.person && !on.signer) return; // found by surname alone: only a notice that lists the person counts
    if (!doc) unread += 1;
    const span = issuer.filings.length > 1 ? `; named on ${issuer.filings.length} Form D notices by this issuer between ${issuer.filings[issuer.filings.length - 1].date} and ${issuer.latest.date}` : '';
    const finding = makeFinding(subject, {
      source: PERSON_ID, sourceLabel: 'SEC Form D notices (private fundraises)', category: 'corporate', severity: 'info',
      title: formDTitle(g.form, issuer.name, subject, on, `Form ${g.form} filed by ${issuer.name} mentions ${subject.name}`),
      quote: `${doc ? formDQuote(doc, on) : recordLine(g)}${span}`,
      url: g.url, date: g.date,
      // Only a notice that lists the person, or an issuer that is exactly a known company, is graded by its names.
      // Otherwise EDGAR's phrase hit is all there is, and an issuer that merely resembles a known company ("Red
      // Stripe Holdings LLC" for Stripe) must not confirm a namesake.
      ...(on.person || on.signer || exactKnownIssuer(subject, [...issuer.names, ...(doc ? [doc.issuerName, ...doc.previousNames] : [])])
        ? { matchText: [subject.name, ...issuer.names, ...(doc ? [doc.issuerName, ...doc.previousNames, ...doc.persons.map((p) => p.name)] : [])].join('. ') }
        : { match: 'possible', matchReasons: ['name found by full-text search; issuer not verified'] }),
      data: { form: g.form, accession: g.adsh, issuer: issuer.name, ...(on.person ? { roles: on.person.roles } : {}), filings: issuer.filings.slice(0, 12).map((f) => ({ form: f.form, date: f.date, url: f.url })) },
    });
    if (!finding) return;
    findings.push(finding);
    const trusted = finding.match !== 'possible';
    // A confirmed notice that lists the person (or is filed by exactly their company) ties the registrant to them.
    if (finding.match === 'confirmed' && doc) noteCik(subject, issuer.latest.entities[0].cik);
    // A notice of a company already tied to the person that states they are its CEO records the tenure the notices show.
    if (finding.match === 'confirmed' && doc && known && ceoOnFormD(doc, on)) noteFormDRole(subject, [doc.issuerName || issuer.name], bySurname ? [issuer.latest.date] : issuer.filings.map((f) => f.date), finding.id);
    threads.push(makeThread('company', issuer.name, on.person ? `Form D names the person as ${rolesText(on.person.roles)}` : 'a Form D by this issuer names the person', { trusted }));
    if (doc && on.person) named.push({ doc, person: on.person, issuerName: issuer.name, trusted });
  });
  threads.push(...associateThreads(named));
  const notes = [];
  if (unread && documentsBlocked()) notes.push('SEC filing documents could not be opened, so roles are not shown for some Form D notices.');
  return { findings, threads: dedupeThreads(threads), notes };
}

/* ------------------------------------------------------------------ person: every filing that names them */

const OWN_PASS_FORMS = new Set(['D', '3', '4', '5']);
const FORM_WEIGHT = [[/^(DEF 14A|DEFM14A|10-K|S-1|F-1|SC 13D|20-F|1-A)/, 3], [/^(8-K|6-K|S-4|DEFA14A|SC 13G|10-Q|424B)/, 2]];
const formWeight = (g) => (g.items.includes('5.02') ? 3 : (FORM_WEIGHT.find(([re]) => re.test(g.rootForm)) || [null, 1])[1]);

/**
 * The filings worth showing: known companies first, then the weightier
 * forms, newest first, a few per filer. Filings by companies not yet tied
 * to the person are matched by name alone, so only a handful are kept.
 */
function pickFilings(groups, subject, { max = 14, perFiler = 4, maxNameOnly = 6 } = {}) {
  const ranked = groups.map((g) => ({ ...g, known: Boolean(g.own) || knownCompany(subject, g.entities.map((e) => e.name).join('. ')) || tiedByCik(subject, g), weight: formWeight(g) }))
    .sort((a, b) => Number(b.known) - Number(a.known) || b.weight - a.weight || byDateDesc(a, b) || a.rank - b.rank);
  const perKey = new Map();
  const out = [];
  let nameOnly = 0;
  for (const g of ranked) {
    const filer = filerKey(g.entities[0]);
    const formKey = `${filer}|${g.rootForm}`;
    if ((perKey.get(filer) || 0) >= perFiler || (perKey.get(formKey) || 0) >= 2) continue;
    if (!g.known && nameOnly >= maxNameOnly) continue;
    if (!g.known) nameOnly += 1;
    perKey.set(filer, (perKey.get(filer) || 0) + 1);
    perKey.set(formKey, (perKey.get(formKey) || 0) + 1);
    out.push(g);
    if (out.length >= max) break;
  }
  return out;
}

/** Issuers (by first filer) with at least one filing whose passage was read. A filing of theirs with no passage adds nothing. */
const quotedFilers = (groups, passageOf) => new Set(groups.filter((g, i) => typeof passageOf(g, i) === 'string').map((g) => filerKey(g.entities[0])));

// A proxy statement or a notice of a board change that names the person with a role is that company speaking about its own people.
const ROLE_AT_FILER = /\b(directors?|officers?|chief|president|chair(?:man|woman|person)?|co-?founders?|founders?|nominees?|board|appointed|elected|resign\w*)\b/i;

/** "our Co-Founder and Chief Executive Officer, Jane Roe": any filer's own main document speaking of its founder. */
function founderAtFiler(subject, passage) {
  const names = (subject.variants?.length ? subject.variants : [subject.name]).map((v) => clean(String(v).replace(/"/g, '')).split(' ').map(escapeRe).join('\\s+'));
  return new RegExp(`\\bour\\s+(?:co-?)?founder,?\\s+(?:and|&)\\s+chief\\s+executive\\s+officer,?\\s+(?:${names.join('|')})(?![A-Za-z-])`, 'i').test(flat(passage));
}
/** The filer's own notice about its people: a board change, a proxy, or its main document naming its founder and CEO. */
const ownNoticeOf = (subject, g, finding, passage) => finding.match !== 'possible' && Boolean(passage) && g.entities.length === 1
  && (((g.items.includes('5.02') || /^DEF 14A/.test(g.rootForm)) && ROLE_AT_FILER.test(passage)) || (g.best.main && founderAtFiler(subject, passage)));

/**
 * Company threads for the filers of the findings just built (one per
 * company, never the person themselves). A filer is followed only when it
 * is already a known company of the person, or its own proxy statement or
 * board-change notice names them with a role; any other filer that names
 * them in two or more filings is recorded, not followed.
 */
function filerThreads(subject, entries, groups, why) {
  const want = subjectTokens(subject);
  const filings = new Map();
  for (const g of groups) for (const e of g.entities) filings.set(e.name, (filings.get(e.name) || 0) + 1);
  const byName = new Map();
  for (const { g, finding, passage } of entries) {
    for (const e of g.entities) {
      if (!looksLikeOrg(e) || namesAgree(edgarPersonTokens(e.name), want)) continue;
      const tied = knownCompany(subject, e.name) || hasCik(subject, e.cik) || ownNoticeOf(subject, g, finding, passage);
      byName.set(e.name, { trusted: Boolean(byName.get(e.name)?.trusted) || tied, count: filings.get(e.name) || 1 });
    }
  }
  return [...byName].filter(([, v]) => v.trusted || v.count >= 2).slice(0, 8).map(([name, v]) => makeThread('company', name, why(v.count), { trusted: v.trusted }));
}

async function personMentions(ctx) {
  const { subject } = ctx;
  const { hits, total } = await searchFilings({ q: searchNames(subject).map((n) => `"${n}"`).join(' OR ') }, ctx);
  const groups = groupByFiling(hits.filter((h) => !OWN_PASS_FORMS.has(h.rootForm)));
  if (!groups.length) return { findings: [] };
  const picked = pickFilings(groups, subject);
  const passages = await mapLimit(picked.slice(0, 3), 2, (g) => namedPassage(g.best, ctx, { trustFiler: g.known }));
  // A company's own prospectus, proxy or annual report under a name not yet known may be the person's company
  // renamed: its registrant record says so. A record already read is free; others only within the run's few requests.
  let budget = Math.max(0, 3 - passages.length);
  const lookups = picked.slice(0, passages.length)
    .filter((g, i) => typeof passages[i] === 'string' && !g.known && g.entities.length === 1 && OWN_DISCLOSURE.test(g.rootForm) && g.entities[0].cik)
    .filter((g) => registrantKnown(g.entities[0].cik) || (budget > 0 && (budget -= 1) >= 0)).slice(0, 2);
  const looked = await mapLimit(lookups, 2, (g) => filerTie(subject, g, ctx));
  const tieFor = new Map(lookups.map((g, i) => [g.adsh, looked[i]]));

  const findings = [];
  const threads = [];
  const entries = [];
  const quoted = quotedFilers(picked.slice(0, passages.length), (g, i) => passages[i]);
  picked.forEach((g, i) => {
    const passage = i < passages.length ? passages[i] : null;
    if (passage === false) return; // the index matched the words, but the document does not name the person
    if (!passage && quoted.has(filerKey(g.entities[0]))) return; // the same issuer's filing with a passage already stands for it
    const item = notableItem(g.items);
    const title = `${g.form}${docLabel(g.best)} filed by ${filersOf(g)} mentions ${subject.name}${item ? ` (${item})` : ''}`;
    const quote = passage ? flat(passage) : recordLine(g);
    const fields = {
      source: PERSON_ID, sourceLabel: 'SEC EDGAR full-text search', category: 'corporate',
      title, quote, url: g.best.url, date: g.date,
      severity: passage ? passageSeverity(subject, g, quote) : 'info',
      matchText: [subject.name, ...g.entities.map((e) => e.name), quote].join('. '),
      data: { form: g.form, accession: g.adsh, filers: g.entities.map((e) => e.name), items: g.items },
    };
    // A passage read from a filing by a registrant already tied to the person (by CIK) is theirs; a filing of
    // theirs that was not read names the person somewhere in it, so it is likely theirs.
    const tie = cikTie(subject, g) || tieFor.get(g.adsh) || null;
    const finding = passage ? gradeByTie(subject, makeFinding(subject, fields), fields, tie) : likelyByTie(subject, makeFinding(subject, fields), fields, tie);
    if (!finding) return;
    if (passage && tieFor.get(g.adsh) && finding.match === 'confirmed') threads.push(...registrantThreads(tieFor.get(g.adsh)));
    findings.push(finding);
    entries.push({ g, finding, passage });
    if (finding.match === 'confirmed' && g.entities.length === 1 && (sameAsKnown(subject, g.entities[0].name) || ownNoticeOf(subject, g, finding, passage))) noteCik(subject, g.entities[0].cik);
    if (passage) threads.push(...passageThreads(subject, passage, g.best.url, finding.match !== 'possible'));
  });
  threads.push(...filerThreads(subject, entries, groups, (n) => `${plural(n, 'SEC filing')} by this company ${n === 1 ? 'names' : 'name'} the person`));
  const notes = [];
  if (total > findings.length && findings.length) notes.push(`SEC full-text search lists ${total} documents naming ${subject.name}; the ${plural(findings.length, 'most relevant filing is', 'most relevant filings are')} shown.`);
  return { findings, threads: dedupeThreads(threads), notes };
}

/* ------------------------------------------------------------------ person: insider reports */

/** Issuer and reporting owners of a Form 3/4/5, with each owner's stated relationship. The owner address is never read. */
export function parseOwnership(xml) {
  if (!/<ownershipDocument[\s>]/i.test(String(xml || ''))) return null;
  const issuer = xmlInner(xml, 'issuer');
  return {
    issuerName: xmlValue(issuer, 'issuerName'),
    issuerCik: xmlValue(issuer, 'issuerCik').padStart(10, '0'),
    symbol: xmlValue(issuer, 'issuerTradingSymbol'),
    owners: xmlBlocks(xml, 'reportingOwner').map((block) => {
      const rel = xmlInner(block, 'reportingOwnerRelationship');
      const yes = (name) => /^(1|true)$/i.test(xmlValue(rel, name));
      const officerTitle = xmlValue(rel, 'officerTitle');
      const otherText = xmlValue(rel, 'otherText');
      const roles = [
        yes('isDirector') ? 'director' : '',
        yes('isOfficer') ? `officer${officerTitle ? ` (${officerTitle})` : ''}` : '',
        yes('isTenPercentOwner') ? 'owner of more than 10%' : '',
        yes('isOther') ? (otherText || 'other reporting person') : '',
      ].filter(Boolean);
      return { cik: xmlValue(xmlInner(block, 'reportingOwnerId'), 'rptOwnerCik').padStart(10, '0'), name: xmlValue(xmlInner(block, 'reportingOwnerId'), 'rptOwnerName'), roles };
    }),
  };
}

async function personInsider(ctx) {
  const { subject } = ctx;
  const want = subjectTokens(subject);
  const words = nameWords(subject);
  if (want.length < 2 || words.length < 2) return { findings: [] };
  // EDGAR's own lookup of filer names, which lists people surname first
  const lookup = await getJson(`${SEARCH_URL}?${new URLSearchParams({ keysTyped: `${words[words.length - 1]} ${words[0]}` })}`, secOptions(ctx));
  if (!Array.isArray(lookup?.hits?.hits)) throw new Error('SEC filer lookup returned an unexpected answer');
  const owners = lookup.hits.hits
    .map((h) => ({ cik: String(h?._id || '').padStart(10, '0'), entity: clean(h?._source?.entity) }))
    .filter((o) => /^\d{10}$/.test(o.cik) && o.entity && !looksLikeOrg({ name: o.entity }) && namesAgree(edgarPersonTokens(o.entity), want))
    .slice(0, 3);
  if (!owners.length) return { findings: [] };

  const { hits, total } = await searchFilings({ ciks: owners.map((o) => o.cik).join(','), forms: '3,4,5' }, ctx);
  // One entry per (reporting person, issuer)
  const groups = new Map();
  for (const h of hits) {
    const owner = owners.find((o) => h.entities.some((e) => e.cik === o.cik));
    const others = h.entities.filter((e) => !owners.some((o) => o.cik === e.cik));
    if (!owner || !others.length) continue;
    const issuer = others.find((e) => e.tickers) || others[others.length - 1];
    const key = `${owner.cik}|${filerKey(issuer)}`;
    if (!groups.has(key)) groups.set(key, { owner, issuer, filings: [], vehicles: new Map() });
    const g = groups.get(key);
    g.filings.push(h);
    for (const e of others) if (e !== issuer && looksLikeOrg(e)) g.vehicles.set(e.name, e);
  }
  const list = [...groups.values()].map((g) => ({ ...g, filings: g.filings.sort(byDateDesc) })).sort((a, b) => b.filings.length - a.filings.length).slice(0, 5);
  if (!list.length) return { findings: [] };

  // Read the relationship from the reports themselves: the latest for the two main issuers, and the first as well when there is only one issuer.
  const toRead = list.length === 1
    ? uniq([list[0].filings[0], list[0].filings[list[0].filings.length - 1]]).map((filing) => ({ g: list[0], filing }))
    : list.slice(0, 2).map((g) => ({ g, filing: g.filings[0] }));
  const reports = await mapLimit(toRead, 2, async ({ filing }) => { const xml = await openDocument(filing.rawUrl, ctx); return xml ? parseOwnership(xml) : null; });

  const findings = [];
  const threads = [];
  for (const g of list) {
    const latest = g.filings[0];
    const first = g.filings[g.filings.length - 1];
    const stated = toRead.map((r, i) => ({ ...r, report: reports[i] })).filter((r) => r.g === g && r.report)
      .map((r) => ({ date: r.filing.date, roles: (r.report.owners.find((o) => o.cik === g.owner.cik) || { roles: [] }).roles })).filter((r) => r.roles.length);
    const allRoles = uniq(stated.flatMap((r) => r.roles));
    const issuerName = entityLabel(g.issuer);
    const forms = uniq(g.filings.map((f) => f.rootForm)).sort();
    const formsText = `Form${forms.length === 1 ? '' : 's'} ${joinAnd(forms)}`;
    const vehicles = [...g.vehicles.keys()];
    const title = allRoles.length
      ? `Insider reports: ${subject.name} filed as ${joinAnd(allRoles)} of ${issuerName}`
      : `Insider reports (${formsText}) filed by ${subject.name} for ${issuerName}`;
    const quote = [
      `Reporting owner: ${g.owner.entity}`, `issuer: ${issuerName}`,
      g.filings.length === 1 ? `1 report on ${formsText}, filed ${latest.date}` : `${g.filings.length}${total > hits.length ? ' or more' : ''} reports on ${formsText} between ${first.date} and ${latest.date}`,
      vehicles.length ? `filed together with ${listText(vehicles, 4)}` : '',
      ...stated.map((r) => `relationship stated on ${r.date}: ${r.roles.join(', ')}`),
    ].filter(Boolean).join('; ');
    const finding = makeFinding(subject, {
      source: PERSON_ID, sourceLabel: 'SEC insider reports (Forms 3, 4 and 5)', category: 'corporate', severity: 'info',
      title, quote, url: latest.url, date: latest.date,
      matchText: [subject.name, g.owner.entity, g.issuer.name, ...vehicles].join('. '),
      data: { issuer: g.issuer.name, tickers: g.issuer.tickers || null, reports: g.filings.length, firstReport: first.date, lastReport: latest.date, roles: allRoles, vehicles },
    });
    if (!finding) continue;
    findings.push(finding);
    const trusted = finding.match !== 'possible';
    threads.push(makeThread('company', g.issuer.name, allRoles.length ? `SEC insider reports state the person is ${joinAnd(allRoles)}` : 'the person filed SEC insider reports for this company', { trusted }));
    for (const v of vehicles.slice(0, 4)) threads.push(makeThread('company', v, `holding vehicle that files insider reports together with the person (${g.issuer.name})`, { trusted }));
  }
  return { findings, threads: dedupeThreads(threads) };
}

/* ------------------------------------------------------------------ person: related parties and family */

const RELATED_QUERY = '"related party" OR "immediate family" OR "family member" OR family OR brother OR sister OR spouse OR wife OR husband OR father OR mother';
const RELATED_FORMS = 'S-1,S-4,S-11,F-1,F-4,1-A,10-K,20-F,DEF 14A,DEFM14A,424B3,424B4,8-K';
// A prospectus sets out a founder's dealings at greatest length; then the yearly proxy and annual report.
const RELATED_WEIGHT = [[/^(S-1|F-1|1-A)/, 4], [/^(DEF 14A|DEFM14A|10-K)/, 3], [/^(424B|S-4|F-4|S-11|20-F)/, 2]];
// Searched beside RELATED_QUERY (EDGAR's search takes no brackets: the name and then any one of the terms).
const DEALINGS_QUERY = '"related party transactions" OR lease OR landlord OR loan OR "promissory note" OR trademark OR "purchased from"';
const MAIN_DISCLOSURE = /^(S-1|F-1|DEF 14A)$/;
// A filer's own account of itself and its people: where it names its founder's relatives and dealings.
const OWN_DISCLOSURE = /^(S-1|F-1|DEF 14A|10-K)$/;
/** A relative or family member next to the name (not a related-party term alone). */
const kinOnlyScore = (window, offset) => {
  if (!KIN_WORD.test(window) && !FAMILY_TERM.test(window)) return null;
  const s = kinScore(window, offset);
  return s && BUSINESS_ROLE.test(window) ? { ...s, points: s.points + 3 } : s; // a relative with a part in the business first
};
const RELATED_MAX_READS = 5;
// A prospectus sets out each kind of dealing in its own paragraph: one passage of each kind is kept.
const DEAL_FAMILIES = [
  /\b(leases?|leased|leasing|landlord|sublease\w*)\b/i,
  /\b(loans?|loaned|promissory notes?|lines? of credit|credit facilit(?:y|ies))\b/i,
  /\b(trademarks?|intellectual property|purchased from)\b/i,
];
const DEAL_PASSAGES_MAX = 3;
const PASSAGE_GAP = 560; // passages closer than this repeat one another
const farFrom = (spot, chosen) => chosen.every((c) => spot.start > c.end + PASSAGE_GAP || spot.end < c.start - PASSAGE_GAP);
const familyScore = (re) => (window, offset) => {
  const m = re.exec(window);
  return m ? { points: DEAL_POINTS, start: offset + m.index, end: offset + m.index + m[0].length } : null;
};
// "other members of his family": the company's dealings with the founder's family, with no relative named.
const OTHER_FAMILY = /\bother members of (?:his|her|their) (?:immediate )?family\b/i;

async function personRelated(ctx) {
  const { subject } = ctx;
  const names = searchNames(subject);
  const hits = [];
  const seen = new Set();
  // The family terms, then the founder's dealings with the company (leases, loans, a trademark), which a prospectus sets out apart from them.
  for (const q of [...names.map((name) => `"${name}" ${RELATED_QUERY}`), `"${names[0]}" ${DEALINGS_QUERY}`]) {
    const result = await searchFilings({ q, forms: RELATED_FORMS }, ctx);
    for (const h of result.hits) if (!seen.has(`${h.adsh}:${h.file}`)) { seen.add(`${h.adsh}:${h.file}`); hits.push(h); }
  }
  // Exhibits (employment and indemnity agreements) use these words as boilerplate: only main documents disclose dealings.
  const groups = groupByFiling(hits.filter((h) => h.main && h.readable));
  if (!groups.length) return { findings: [] };
  const ranked = groups.map((g) => ({ ...g, known: knownCompany(subject, g.entities.map((e) => e.name).join('. ')), weight: (RELATED_WEIGHT.find(([re]) => re.test(g.rootForm)) || [null, 1])[1] }))
    .sort((a, b) => Number(b.known) - Number(a.known) || b.weight - a.weight || byDateDesc(a, b));
  // One document per filer and kind of form (an S-1 and its amendments repeat the same passage), and every filer once before any filer twice.
  const perFiler = new Map();
  const kinds = new Set();
  for (const g of ranked) {
    const filer = filerKey(g.entities[0]);
    if (kinds.has(`${filer}|${g.rootForm}`)) continue;
    kinds.add(`${filer}|${g.rootForm}`);
    if (!perFiler.has(filer)) perFiler.set(filer, []);
    perFiler.get(filer).push(g);
  }
  const distinct = [];
  for (let round = 0; distinct.length < kinds.size; round += 1) for (const list of perFiler.values()) if (list[round]) distinct.push(list[round]);
  const toRead = distinct.slice(0, Math.max(3, 4 - names.length));
  // The main prospectus or proxy of a company already tied to the person is always read: it is where their dealings are set out.
  for (const list of perFiler.values()) {
    if (toRead.length >= RELATED_MAX_READS) break;
    if (!list[0].known || toRead.some((g) => list.includes(g) && MAIN_DISCLOSURE.test(g.rootForm))) continue;
    const main = list.find((g) => MAIN_DISCLOSURE.test(g.rootForm));
    if (main) toRead.push(main);
  }
  const read = await mapLimit(toRead, 2, async (g) => {
    const text = await documentText(g.best, ctx);
    if (!text) return null;
    // A filer not known by name may be the person's company under another name: its registrant record says so.
    const tie = g.known ? cikTie(subject, g) : (OWN_DISCLOSURE.test(g.rootForm) && subject.hasName(text) ? await filerTie(subject, g, ctx) : null);
    const known = g.known || Boolean(tie);
    // Only a company's own filing calls its founder "Mr. Surname" or by first name throughout.
    const { own } = nameSpots(text, subject, { honorific: true, informal: known });
    const spot = bestSpot(text, own, dealScore);
    if (!spot) return false;
    const passages = [{ passage: excerptAround(text, spot.start, spot.end, { lead: 200, trail: 360 }), dealing: spot.points >= DEAL_POINTS }];
    const chosen = [spot];
    const ownDisclosure = known && OWN_DISCLOSURE.test(g.rootForm) && passages[0].dealing;
    // The company's own prospectus, proxy or annual report sets out leases, loans and a trademark bought from the
    // founder in separate paragraphs: the best passage of each kind is its own record.
    if (ownDisclosure) {
      for (const family of DEAL_FAMILIES) {
        if (chosen.length >= DEAL_PASSAGES_MAX) break;
        const s = bestSpot(text, own, familyScore(family));
        if (!s || !farFrom(s, chosen)) continue;
        chosen.push(s);
        passages.push({ passage: excerptAround(text, s.start, s.end, { lead: 200, trail: 360 }), dealing: true, term: text.slice(s.start, s.end).match(family)?.[0] });
      }
    }
    // It also sets out relatives it employs apart from the founder's dealings: that passage is reported too, when it
    // gives a relative a part in the business, or speaks of "other members of his family" without naming anyone.
    if (ownDisclosure) {
      const kin = bestSpot(text, own, (window, offset) => {
        const s = kinOnlyScore(window, offset);
        return s && OTHER_FAMILY.test(window) ? { ...s, points: s.points + 3 } : s;
      });
      const passage = kin && farFrom(kin, chosen) ? excerptAround(text, kin.start, kin.end, { lead: 200, trail: 360 }) : '';
      // A passage about unnamed family members is quoted only when it names no relative at all.
      const unnamed = (p) => OTHER_FAMILY.test(flat(p)) && !KIN_WORD.test(flat(p)) && !sharesSurname(flat(p), subject, surnameOf(subject))
        && !mentionsMinor(flat(p)) && !isSensitive(flat(p)) && !relativesFromText(subject, asSentences(p)).length;
      if (passage && (relativesInDisclosure(subject, passage).length || unnamed(passage))) passages.push({ passage, dealing: false, relative: true });
    }
    return { passages, tie };
  });

  const findings = [];
  const threads = [];
  const entries = [];
  toRead.forEach((g, i) => {
    if (!read[i]) return; // not opened, or the terms are nowhere near the name
    const { tie } = read[i];
    if (tie) threads.push(...registrantThreads(tie));
    const titles = new Set();
    for (const { passage, dealing, relative, term } of read[i].passages) {
      const quote = flat(passage);
      const filers = filersOf(g);
      const kin = KIN_WORD.exec(quote);
      const deal = dealing && (term ? [term] : DEAL_TERM.exec(quote));
      const about = deal ? `in a passage about dealings with the company (${deal[0].toLowerCase()})`
        : kin ? `in a passage about a relative (${kin[0].toLowerCase()})` : relative || FAMILY_TERM.test(quote) ? 'in a passage about immediate family members' : 'in a related-party disclosure';
      const relatives = [...relativesFromText(subject, asSentences(passage)).map((r) => ({ name: r.name, relation: r.relation, role: r.role })), ...relativesInDisclosure(subject, passage)];
      // Each passage of one filing is its own record, so each needs its own title.
      let title = `${g.form} filed by ${filers} names ${subject.name} ${about}`;
      for (let n = 2; titles.has(title); n += 1) title = `${g.form} filed by ${filers} names ${subject.name} ${about} (passage ${n})`;
      titles.add(title);
      const fields = {
        source: PERSON_ID, sourceLabel: 'SEC EDGAR full-text search', category: 'related',
        title,
        quote, url: g.best.url, date: g.date,
        severity: atLeast(deal ? 'medium' : 'low', passageSeverity(subject, g, quote)),
        matchText: [subject.name, ...g.entities.map((e) => e.name), quote].join('. '),
        data: { form: g.form, accession: g.adsh, filers: g.entities.map((e) => e.name), ...(relatives[0] ? { person: relatives[0].name } : {}) },
      };
      const finding = gradeByTie(subject, makeFinding(subject, fields), fields, tie);
      if (!finding) continue;
      findings.push(finding);
      entries.push({ g, finding, passage: null });
      const trusted = finding.match !== 'possible';
      for (const r of relatives) threads.push(makeThread('relative', r.name, `${r.relation}; named in a related-party disclosure by ${filers}`, { trusted, relation: r.relation, ...(r.role ? { role: r.role } : {}) }));
      for (const a of associatesFromText(subject, asSentences(passage))) threads.push(makeThread('associate', a.name, a.why, { trusted }));
    }
  });
  threads.push(...filerThreads(subject, entries, groups, () => 'discloses related-party or family dealings that name the person'));
  const notes = [];
  const unread = read.filter((r) => r === null).length;
  const unchecked = distinct.length - toRead.length + unread;
  if (unread && documentsBlocked()) notes.push(`SEC lists ${plural(distinct.length, 'filing')} that name ${subject.name} and use related-party or family terms, but the documents could not be opened to check that the terms refer to this person.`);
  else if (unchecked > 0) notes.push(`${plural(unchecked, 'more SEC filing names', 'more SEC filings name')} ${subject.name} and ${unchecked === 1 ? 'uses' : 'use'} related-party or family terms; ${unchecked === 1 ? 'its passage was' : 'their passages were'} not read.`);
  return { findings, threads: dedupeThreads(threads), notes };
}

/* ------------------------------------------------------------------ person: relatives in the company's own filings */

const FAMILY_QUERY = 'brother OR sister OR spouse OR "immediate family" OR relatives';
const FAMILY_WORD = /\b(relatives?|brothers?(?:-in-law)?|sisters?(?:-in-law)?|siblings?|spouses?|wife|husband|father(?:-in-law)?|cousins?|immediate family)\b/i;

/**
 * Does "Mr. Surname" at `at` refer to the person? The last full name with
 * that surname written before it must be theirs: a filing that also names a
 * brother calls each of them "Mr. Surname" in turn.
 */
function honorificIsPerson(text, at, subject, surname) {
  const before = text.slice(Math.max(0, at - 2500), at);
  const re = new RegExp(`(?<![A-Za-z-])([A-ZÀ-Þ][a-zà-ÿ'’-]+(?:[ ]+[A-Z]\\.)?[ ]+${escapeRe(surname)})(?![A-Za-z-])`, 'g');
  let last = null;
  for (const m of before.matchAll(re)) {
    const given = stripAccents(m[1].split(/\s+/)[0]).toLowerCase();
    if (NAME_LEADERS.has(given) || SENTENCE_OPENERS.has(given)) continue;
    last = m[1];
  }
  return Boolean(last) && namesPerson(last, subject);
}

/**
 * Relatives a company tied to the person names in its own prospectus, proxy
 * or annual report ("Mr. Milton's relatives, Jane Milton and John Milton,
 * employees of the Company"). Searched by surname and limited to that
 * company's filings; reported only when the filing also names the person in
 * full and gives the relative a part in the business.
 */
async function personFamily(ctx) {
  const { subject } = ctx;
  const surname = surnameOf(subject);
  if (surname.length < 3) return { findings: [] };
  const companies = uniq([subject.company, ...[...(subject.anchors?.companies?.values?.() || [])].map((a) => a.value)].map(clean)).slice(0, 2);
  if (!companies.length) return { findings: [] };
  const candidates = [];
  for (const company of companies) {
    const { hits } = await searchFilings({ q: `"${surname}" ${FAMILY_QUERY}`, entityName: company, forms: RELATED_FORMS }, ctx);
    const filers = companyFilers(hits, company);
    if (filers.ambiguous) continue; // several companies resemble the name: none is known to be the person's
    const groups = groupByFiling(hits.filter((h) => h.main && h.readable && filers.is(h)))
      .map((g) => ({ ...g, weight: (RELATED_WEIGHT.find(([re]) => re.test(g.rootForm)) || [null, 1])[1] }))
      .sort((a, b) => b.weight - a.weight || byDateDesc(a, b));
    if (groups[0]) candidates.push(groups[0]);
  }
  const read = await mapLimit(candidates.slice(0, 2), 2, async (g) => {
    const text = await documentText(g.best, ctx);
    if (!text || !subject.hasName(text)) return text ? false : null; // the filing must name the person in full
    const spots = [...subject.hasName.positions(text)];
    const otherHonorific = []; // "Ms. Surname" that refers to someone else: no passage around it is used
    for (const m of text.matchAll(new RegExp(`\\b(?:Mr|Ms|Mrs|Dr)\\.?[ ]+${escapeRe(surname)}(?![A-Za-z-])`, 'g'))) {
      if (honorificIsPerson(text, m.index, subject, surname)) spots.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      else otherHonorific.push(m.index);
    }
    spots.sort((x, y) => x.start - y.start);
    // Only a passage that names a relative with a part in the business counts.
    let best = null;
    for (const spot of spots.slice(0, 400)) {
      if (otherHonorific.some((at) => at > spot.start - 700 && at < spot.end + 1000)) continue;
      const lo = Math.max(0, spot.start - 120);
      const window = text.slice(lo, Math.min(text.length, spot.end + 300));
      const kin = FAMILY_WORD.exec(window);
      if (!kin) continue;
      const passage = excerptAround(text, Math.min(spot.start, lo + kin.index), Math.max(spot.end, lo + kin.index + kin[0].length), { lead: 160, trail: 360 });
      const relatives = relativesInDisclosure(subject, passage);
      if (relatives.length && (!best || relatives.length > best.relatives.length)) best = { passage, relatives };
    }
    return best || false;
  });

  const findings = [];
  const threads = [];
  candidates.slice(0, 2).forEach((g, i) => {
    if (!read[i]) return;
    const { passage, relatives } = read[i];
    const quote = flat(passage);
    const filers = filersOf(g);
    const finding = makeFinding(subject, {
      source: PERSON_ID, sourceLabel: 'SEC EDGAR full-text search', category: 'related',
      title: `${g.form} filed by ${filers} names relatives of ${subject.name} in company roles: ${listText(relatives.map((r) => `${r.name} (${r.relation})`), 3)}`,
      quote, url: g.best.url, date: g.date,
      severity: atLeast('low', passageSeverity(subject, g, quote)),
      // The filing is the company's own and names the person in full elsewhere; the passage may call them "Mr. Surname".
      matchText: [subject.name, ...g.entities.map((e) => e.name), quote].join('. '),
      data: { form: g.form, accession: g.adsh, filers: g.entities.map((e) => e.name), relatives: relatives.map((r) => ({ name: r.name, relation: r.relation, role: r.role })) },
    });
    if (!finding) return;
    findings.push(finding);
    const trusted = finding.match !== 'possible';
    for (const r of relatives) threads.push(makeThread('relative', r.name, `${r.relation}; named with a part in the business by ${filers}`, { trusted, relation: r.relation, role: r.role }));
  });
  const notes = read.some((r) => r === null) && documentsBlocked() ? ['SEC filing documents could not be opened, so relatives named in the company\'s own filings were not checked.'] : [];
  return { findings, threads: dedupeThreads(threads), notes };
}

/* ------------------------------------------------------------------ person: enforcement */

/** The rows of an SEC enforcement list page (litigation releases or administrative proceedings). */
function parseReleaseList(html) {
  const page = String(html || '');
  if (!/views-table|no-results-text|view-empty/i.test(page)) throw new Error('The SEC enforcement list returned an unexpected page');
  const body = (page.match(/<tbody[\s\S]*?<\/tbody>/i) || [''])[0];
  const rows = [];
  for (const tr of body.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const link = tr.match(/release-view__respondents['"]?\s*>\s*<a\s[^>]*?href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    let url;
    try { url = new URL(decodeEntities(link[1]), SEC_SITE).toString(); } catch { continue; }
    const field = (name) => clean(decodeEntities(htmlToText((tr.match(new RegExp(`subfield_${name}"[\\s\\S]*?subfield_value"\\s*>([\\s\\S]*?)</span>`, 'i')) || [])[1] || '')));
    rows.push({ url, respondents: clean(decodeEntities(htmlToText(link[2]))), number: field('release_number'), fileNumber: field('file_number'), date: (tr.match(/datetime=["']([^"']+)["']/i) || [])[1] || null });
  }
  const totals = page.match(/(\d[\d,]*)\s+to\s+(\d[\d,]*)\s+of\s+(\d[\d,]*)\s+items/i);
  return { rows, total: totals ? Number(totals[3].replace(/,/g, '')) : rows.length };
}

async function releaseList(kind, populate, ctx) {
  try {
    return parseReleaseList(await getText(`${SEC_SITE}/enforcement-litigation/${kind}?${new URLSearchParams({ populate })}`, secOptions(ctx)));
  } catch (error) {
    noteRefusal(error);
    throw error;
  }
}

const ENFORCEMENT_WORDS = /\b(charg(?:ed|es|ing)|complaint|alleg\w+|fraud\w*|judgment|settle\w*|penalt\w*|injunction|barred?|violat\w+|misled|misleading|indict\w*|convict\w*|sentenced|disgorge\w*)\b/gi;
const enforcementScore = (window) => ({ points: 1 + new Set((window.match(ENFORCEMENT_WORDS) || []).map((w) => w.toLowerCase())).size });

/**
 * A litigation release as { passage, text }: the passage that names the
 * person (their full name, else their surname), and the release's whole
 * text, which is short and about its respondents only, for identity grading.
 */
async function readRelease(row, ctx) {
  let path = '';
  try { path = new URL(row.url).pathname; } catch { return null; }
  if (!/^\/enforcement-litigation\/litigation-releases\/lr-[\w-]+\/?$/i.test(path)) return null; // older releases are PDF or plain-text files
  const html = await openDocument(row.url, ctx);
  if (!html) return null;
  let text = filingText((html.match(/<main[\s\S]*<\/main>/i) || [html])[0]);
  const start = text.search(/Litigation Release No\./i);
  if (start > 0) text = text.slice(start);
  let spots = ctx.subject.hasName.positions(text);
  if (!spots.length) {
    const surname = surnameOf(ctx.subject);
    spots = surname ? [...text.matchAll(new RegExp(`(?<![A-Za-z-])${escapeRe(surname)}(?![A-Za-z-])`, 'g'))].map((m) => ({ start: m.index, end: m.index + m[0].length })) : [];
  }
  if (!spots.length) return null;
  const spot = bestSpot(text, spots, preferKnown(ctx.subject, enforcementScore), 240) || spots[0];
  return { passage: excerptAround(text, spot.start, spot.end, { lead: 240, trail: 420 }), text: flat(text).slice(0, 8000), complaint: complaintCited(text) };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "July 29, 2021" / "Sept. 3, 2021" -> "2021-07-29", or null. */
function isoDate(written) {
  const m = clean(written).match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  const month = m && MONTHS[m[1].toLowerCase()];
  return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

/**
 * The case a litigation release cites, from its caption: "Securities and
 * Exchange Commission v. Jane Roe, No. 1:21-cv-06445 (S.D.N.Y. filed July 29,
 * 2021)". The release itself may be years later (a judgment, a dismissal);
 * the complaint is dated when it was filed.
 */
function complaintCited(text) {
  const m = String(text || '').match(/(?:Securities and Exchange Commission|SEC)\s+v\.\s+([^\n]{2,200}?)\s*,\s*(?:Civil Action\s+|Case\s+)?No\.\s*([0-9][\w:.-]{3,30}(?:\s*\([A-Z]{2,5}\))?)\s*\(([^()\n]{2,60}?)[,;]?\s+filed\s+([A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4})\)/);
  if (!m) return null;
  const filed = isoDate(m[4]);
  return filed ? { caption: flat(m[0]).replace(/\s+,/g, ','), defendants: clean(m[1]), number: clean(m[2]), court: clean(m[3]), filed } : null;
}

async function personEnforcement(ctx) {
  const { subject } = ctx;
  const surname = surnameOf(subject);
  if (surname.length < 2) return { findings: [] };
  // The lists match any respondent text containing the surname, so "Trevor R. Milton" is found too; rows are then checked against the full name.
  const [court, admin] = await Promise.allSettled([releaseList('litigation-releases', surname, ctx), releaseList('administrative-proceedings', surname, ctx)]);
  if (court.status === 'rejected' && admin.status === 'rejected') throw court.reason;
  const notes = [];
  if (court.status === 'rejected' || admin.status === 'rejected') notes.push(`SEC ${court.status === 'rejected' ? 'litigation releases' : 'administrative proceedings'} could not be searched this time.`);
  const named = (row) => namesPerson(row.respondents, subject, { nickname: true });
  let courtRows = court.status === 'fulfilled' ? court.value.rows.filter(named) : [];
  if (court.status === 'fulfilled' && court.value.total > court.value.rows.length) {
    // A common surname fills more than one page: ask again for the exact name.
    try {
      const exact = (await releaseList('litigation-releases', clean(subject.name), ctx)).rows.filter(named);
      courtRows = [...courtRows, ...exact.filter((row) => !courtRows.some((r) => r.url === row.url))];
    } catch { /* the first answer stands */ }
  }
  const adminRows = admin.status === 'fulfilled' ? admin.value.rows.filter(named) : [];
  courtRows = courtRows.slice(0, 6);
  const releases = await mapLimit(courtRows.slice(0, 2), 2, (row) => readRelease(row, ctx));

  const findings = [];
  const threads = [];
  const build = (row, kind, release) => {
    const label = kind === 'court' ? 'SEC litigation release' : 'SEC administrative proceeding';
    const exact = subject.hasName(row.respondents);
    const title = `${label}${row.number ? ` ${row.number}` : ''}: ${row.respondents.length > 150 ? `${row.respondents.slice(0, 149).trimEnd()}…` : row.respondents}${exact ? '' : ` (${subject.name})`}`;
    const quote = release ? flat(release.passage) : [`Respondents: ${row.respondents}`, row.number ? `Release No. ${row.number}` : '', row.fileNumber ? `File No. ${row.fileNumber}` : ''].filter(Boolean).join('; ');
    const finding = makeFinding(subject, {
      source: PERSON_ID, sourceLabel: kind === 'court' ? 'SEC litigation releases' : 'SEC administrative proceedings', category: 'regulatory',
      title, quote, url: row.url, date: row.date,
      severity: atLeast('medium', severityFromText(`${title} ${quote}`)),
      matchText: [subject.name, row.respondents, release ? release.text : ''].join('. '),
      data: { release: row.number || null, respondents: row.respondents, ...(row.fileNumber ? { fileNumber: row.fileNumber } : {}) },
    });
    if (!finding) return;
    findings.push(finding);
    if (release) threads.push(...passageThreads(subject, release.passage, row.url, finding.match !== 'possible'));
  };
  // The complaint a release cites is its own record, dated when it was filed: the release that announced the
  // charges is not always listed under the person's name, and a later release (a judgment, a dismissal) still cites it.
  const complaints = new Set();
  const buildComplaint = (row, release) => {
    const c = release?.complaint;
    if (!c || complaints.has(c.number) || !namesPerson(c.defendants, subject, { nickname: true })) return;
    complaints.add(c.number);
    const finding = makeFinding(subject, {
      source: PERSON_ID, sourceLabel: 'SEC litigation releases', category: 'regulatory', severity: 'high',
      title: `SEC complaint filed in ${c.court}: SEC v. ${c.defendants}, No. ${c.number}`,
      quote: c.caption, url: row.url, date: c.filed,
      matchText: [subject.name, row.respondents, release.text].join('. '),
      data: { caseNumber: c.number, court: c.court, filed: c.filed, citedIn: row.number || null },
    });
    if (finding) findings.push(finding);
  };
  courtRows.forEach((row, i) => { build(row, 'court', releases[i] || null); buildComplaint(row, releases[i] || null); });
  adminRows.slice(0, 4).forEach((row) => build(row, 'admin', null));
  return { findings, threads: dedupeThreads(threads), notes };
}

/* ------------------------------------------------------------------ person: SEC press releases */

/** The rows of the SEC newsroom's press-release list: title, link, date and release number. */
export function parsePressList(html) {
  const page = String(html || '');
  if (!/views-table|views-empty|view-empty|no-results/i.test(page)) throw new Error('The SEC press-release list returned an unexpected page');
  const body = (page.match(/<tbody[\s\S]*?<\/tbody>/i) || [''])[0];
  const rows = [];
  for (const tr of body.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const link = tr.match(/<a\s[^>]*?href=['"](\/newsroom\/press-releases\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const number = clean(htmlToText((tr.match(/field-release-number[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || ''));
    rows.push({ url: new URL(decodeEntities(link[1]), SEC_SITE).toString(), title: clean(decodeEntities(htmlToText(link[2]))), number, date: (tr.match(/datetime=["']([^"']+)["']/i) || [])[1] || null });
  }
  return rows;
}

async function pressList(query, ctx) {
  try {
    return parsePressList(await getText(`${SEC_SITE}/newsroom/press-releases?${new URLSearchParams({ combine: query })}`, secOptions(ctx)));
  } catch (error) {
    noteRefusal(error);
    throw error;
  }
}

/** A press release's passage about the person, or false when it does not name them (null when it could not be opened). */
async function readPress(row, ctx) {
  const html = await openDocument(row.url, ctx);
  if (!html) return null;
  let text = filingText((html.match(/<main[\s\S]*<\/main>/i) || [html])[0]);
  const start = text.search(/For Immediate Release/i);
  if (start > 0) text = text.slice(start);
  const end = text.search(/Last Reviewed or Updated/i);
  if (end > 0) text = text.slice(0, end);
  const { subject } = ctx;
  if (!subject.hasName(text) && !namesPerson(text, subject, { nickname: true })) return false;
  let spots = subject.hasName.positions(text);
  if (!spots.length) {
    // "Trevor R. Milton": the full name with a middle initial; the passage is placed at the surname.
    const surname = surnameOf(subject);
    spots = [...text.matchAll(new RegExp(`(?<![A-Za-z-])${escapeRe(surname)}(?![A-Za-z-])`, 'g'))].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  }
  const spot = bestSpot(text, spots, preferKnown(subject, enforcementScore), 240) || spots[0];
  return { passage: excerptAround(text, spot.start, spot.end, { lead: 240, trail: 420 }), text: flat(text).slice(0, 8000) };
}

/**
 * SEC press releases (the newsroom) that name the person. The list searches
 * titles only, and a charging release is often titled by the company ("SEC
 * Charges Founder of Acme Corp. With Fraud"), so the person's name and their
 * company are both searched; a release found by the company is kept only
 * when its text names the person.
 */
async function personPress(ctx) {
  const { subject } = ctx;
  const company = clean(subject.company || [...(subject.anchors?.companies?.values?.() || [])][0]?.value || '');
  const queries = uniq([clean(subject.name), company]).filter((q) => q.length >= 2);
  const lists = await Promise.allSettled(queries.map((q) => pressList(q, ctx)));
  if (lists.every((l) => l.status === 'rejected')) throw lists[0].reason;
  const byName = (lists[0].status === 'fulfilled' ? lists[0].value : []).map((row) => ({ ...row, named: namesPerson(row.title, subject, { nickname: true }) }));
  const adverse = new RegExp(ENFORCEMENT_WORDS.source, 'i');
  const byCompany = (lists[1]?.status === 'fulfilled' ? lists[1].value : []).filter((row) => adverse.test(row.title));
  const rows = [];
  for (const row of [...byName.filter((r) => r.named), ...byCompany.map((r) => ({ ...r, named: namesPerson(r.title, subject, { nickname: true }) }))]) {
    if (!rows.some((r) => r.url === row.url)) rows.push(row);
  }
  const shown = rows.slice(0, 4);
  const read = await mapLimit(shown.slice(0, 2), 2, (row) => readPress(row, ctx));

  const findings = [];
  const threads = [];
  shown.forEach((row, i) => {
    const release = i < read.length ? read[i] : null;
    if (release === false) return; // read, and it does not name the person
    if (!release && !row.named) return; // found by the company and not read: nothing ties it to the person
    const quote = release ? flat(release.passage) : row.title;
    const finding = makeFinding(subject, {
      source: PERSON_ID, sourceLabel: 'SEC press releases', category: 'regulatory',
      title: `SEC press release${row.number ? ` ${row.number}` : ''}: ${row.title}${row.named ? '' : ` (names ${subject.name})`}`,
      quote, url: row.url, date: row.date,
      severity: atLeast('medium', severityFromText(`${row.title} ${quote}`)),
      matchText: [subject.name, row.title, release ? release.text : ''].join('. '),
      data: { release: row.number || null },
    });
    if (!finding) return;
    findings.push(finding);
    if (release) threads.push(...passageThreads(subject, release.passage, row.url, finding.match !== 'possible'));
  });
  const notes = lists.some((l) => l.status === 'rejected') ? ['Some SEC press releases could not be searched this time.'] : [];
  return { findings, threads: dedupeThreads(threads), notes };
}

/* ------------------------------------------------------------------ company: Form D */

// The legal form a name may carry without becoming another name.
const LEGAL_FORM = new Set(['the', 'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'companies', 'plc', 'lp', 'llp', 'sa', 'sas', 'ag', 'nv', 'bv', 'gmbh']);
const nameWordsOf = (name) => stripAccents(name).toLowerCase().replace(/\./g, '').replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
/** Does the issuer's name add words beyond the company's own and a legal form ("Flow Holdings, Inc." for "Flow")? */
function addsWords(issuerName, company) {
  const want = new Set(nameWordsOf(company));
  return nameWordsOf(issuerName).some((w) => !want.has(w) && !LEGAL_FORM.has(w));
}
/** A Form D listing three or more people, none of them the person or a known associate. */
function strangersOnly(subject, doc) {
  const people = doc.persons.filter((p) => !p.isOrg);
  if (people.length < 3) return false;
  const associates = [...(subject.anchors?.people?.values?.() || [])];
  return !people.some((p) => subject.hasName(p.name) || associates.some((a) => a.test(p.name)));
}

async function companyFormD(task, ctx) {
  const { subject } = ctx;
  const company = clean(String(task.value).replace(/"/g, ''));
  // A company the person only sat on the board of, invested in or once worked at: only a notice that names them counts.
  const affiliate = task.tie === 'affiliate';
  const { hits } = await searchFilings({ entityName: company, forms: 'D' }, ctx);
  // Funds and affiliates that merely carry the name are left to the person's own Form D lookup.
  const filers = companyFilers(hits, company);
  const own = hits.filter(filers.is).sort(byDateDesc);
  if (!own.length) return { findings: [] };
  const namedOnly = filers.ambiguous || affiliate;
  // Normally the latest, the earliest and the one before the latest. When several different filers
  // merely resemble the name, the latest of each is read and only a notice that names the person is kept.
  const toRead = (filers.ambiguous
    ? [...new Map(own.map((h) => [filerKey(h.entities[0]), h])).values()]
    : uniq([own[0], own[own.length - 1], own[1]])).slice(0, 3);
  const docs = await mapLimit(toRead, 2, (h) => readFormD(h, ctx));
  const docFor = new Map(toRead.map((h, i) => [h.adsh, docs[i]]));
  const shown = uniq([...toRead, ...own]).slice(0, 5);

  const findings = [];
  const threads = [];
  const named = [];
  const ceoNotices = [];
  for (const h of shown) {
    const doc = docFor.get(h.adsh) || null;
    const g = { ...h, docs: [h] };
    const issuerName = h.entities[0].name;
    const on = doc ? subjectOnFormD(doc, subject, { nickname: true }) : {};
    const isNamed = Boolean(on.person || on.signer);
    if (namedOnly && !isNamed) continue;
    // An issuer whose name adds words to the company's ("Flow Holdings, Inc." for Flow) may be another business that
    // shares it, and a notice listing several people none of whom is the person or a known associate is not theirs.
    if (!isNamed && (addsWords(issuerName, company) || (doc && strangersOnly(subject, doc)))) continue;
    const others = doc ? doc.persons.filter((p) => p !== on.person) : [];
    const facts = doc ? [doc.totalSold ? `${money(doc.totalSold)} sold` : '', doc.firstSale ? `first sale ${doc.firstSale}` : ''].filter(Boolean).join(', ') : '';
    const finding = makeFinding(subject, {
      source: COMPANY_ID, sourceLabel: 'SEC Form D notices (private fundraises)', category: 'corporate', severity: 'info',
      title: formDTitle(h.form, issuerName, subject, on, `Form ${h.form} filed by ${issuerName}: private fundraise${facts ? ` (${facts})` : ''}`),
      quote: doc ? formDQuote(doc, { ...on, others }) : recordLine(g), url: h.url, date: h.date,
      ...(isNamed
        ? { matchText: [subject.name, issuerName, company, doc.issuerName, ...doc.previousNames].join('. ') }
        : { match: 'company', matchReasons: [filers.exact ? `a filing by ${issuerName}, a company tied to the person` : `a filing by ${issuerName}, whose name matches ${company}, a company tied to the person`] }),
      data: { form: h.form, accession: h.adsh, issuer: issuerName, ...(doc ? { yearOfIncorporation: doc.yearOfInc || null, firstSale: doc.firstSale || null, totalOffering: doc.totalOffering || null, totalSold: doc.totalSold || null, relatedPersons: doc.persons.slice(0, 20).map((p) => ({ name: p.name, roles: p.roles })) } : {}) },
    });
    if (!finding) continue;
    findings.push(finding);
    if (!doc) continue;
    if (isNamed && finding.match === 'confirmed') noteCik(subject, h.entities[0].cik);
    if (isNamed && finding.match === 'confirmed' && !affiliate && ceoOnFormD(doc, on)) ceoNotices.push({ issuer: doc.issuerName || issuerName, date: h.date, id: finding.id });
    // Co-executives are followed only from a notice that also names the person.
    if (on.person) named.push({ doc, person: on.person, issuerName, trusted: true });
    // An earlier name is the same company; it is followed when the notice ties the person to it.
    for (const previous of doc.previousNames.slice(0, 3)) if (!sameCompany(previous, company)) threads.push(makeThread('company', previous, `earlier name of ${issuerName} on its Form D`, { trusted: isNamed }));
  }
  threads.push(...associateThreads(named));
  for (const issuer of uniq(ceoNotices.map((n) => n.issuer))) {
    const mine = ceoNotices.filter((n) => n.issuer === issuer);
    noteFormDRole(subject, [issuer], mine.map((n) => n.date), mine[0].id);
  }
  const notes = [];
  if (docs.some((d) => !d) && documentsBlocked()) notes.push('SEC filing documents could not be opened, so amounts and officers are not shown for some Form D notices.');
  else if (affiliate && !findings.length) notes.push(`No Form D notice filed by a company named ${company} lists the person as an officer, director or promoter.`);
  return { findings, threads: dedupeThreads(threads), notes };
}

/* ------------------------------------------------------------------ company: cyber-incident reports */

// Covers the phrases INCIDENT_TERM recognises: before Item 1.05, an 8-K described an incident in its own words (Clorox 2023: "unauthorized activity").
const CYBER_QUERY = '"Item 1.05" OR "cybersecurity incident" OR "cybersecurity attack" OR "cyber attack" OR cyberattack OR ransomware OR "unauthorized access" OR "unauthorized activity" OR "unauthorized third party" OR "security incident" OR "data breach"';
const INCIDENT_TERM = /\b(Item\s+1\.05|cybersecurity incident|cyber(?:security)?[- ]attack|ransomware|unauthori[sz]ed (?:access|actor|activity|third part(?:y|ies)|part(?:y|ies)|person|individual)s?|data breach|security incident)\b/i;

async function companyCyber(task, ctx) {
  const { subject } = ctx;
  const company = clean(String(task.value).replace(/"/g, ''));
  const { hits } = await searchFilings({ q: CYBER_QUERY, forms: '8-K', entityName: company }, ctx);
  const filers = companyFilers(hits, company, (h) => h.entities);
  if (filers.ambiguous) return { findings: [] }; // several different companies resemble the name: none can be reported as this one
  const groups = groupByFiling(hits.filter(filers.is))
    .map((g) => ({ ...g, formal: g.items.includes('1.05') }))
    // Item 1.05 is the formal report (since December 2023); before that incidents were reported in the body of an 8-K under Items 7.01 or 8.01.
    .filter((g) => g.formal || (g.best.main && g.items.some((i) => i === '7.01' || i === '8.01')))
    .sort((a, b) => Number(b.formal) - Number(a.formal) || byDateDesc(a, b)).slice(0, 4);
  if (!groups.length) return { findings: [] };
  const passages = await mapLimit(groups.slice(0, 2), 2, async (g) => {
    const text = await documentText(g.best, ctx);
    if (!text) return null;
    const m = INCIDENT_TERM.exec(text);
    return m ? excerptAround(text, m.index, m.index + m[0].length, { lead: 0, trail: 560, max: 600 }) : false;
  });
  const findings = [];
  groups.forEach((g, i) => {
    const passage = i < passages.length ? passages[i] : null;
    if (!g.formal && passage === false) return; // the 8-K was read and does not describe an incident
    const filer = (g.entities.find((e) => filers.keys.has(filerKey(e))) || g.entities[0]).name;
    const title = g.formal ? `8-K Item 1.05: ${filer} reported a material cybersecurity incident`
      : passage ? `${g.form} filed by ${filer} reports a cybersecurity incident or unauthorized access`
      : `${g.form} filed by ${filer} refers to a cybersecurity incident or unauthorized access (passage not read)`;
    const finding = makeFinding(subject, {
      source: COMPANY_ID, sourceLabel: 'SEC 8-K cyber-incident reports', category: 'exposure', severity: 'medium',
      title, quote: passage ? flat(passage) : recordLine(g), url: g.best.url, date: g.date,
      match: 'company', matchReasons: [filers.exact ? `an SEC filing by ${filer}, a company tied to the person` : `an SEC filing by ${filer}, whose name matches ${company}, a company tied to the person`],
      data: { form: g.form, accession: g.adsh, items: g.items, eventDate: g.period || null },
    });
    if (finding) findings.push(finding);
  });
  return { findings };
}

/* ------------------------------------------------------------------ company: filings naming the person with it */

async function companyJoint(task, ctx) {
  const { subject } = ctx;
  const company = clean(String(task.value).replace(/"/g, ''));
  const name = searchNames(subject)[0];
  // The company's own filings that name the person, and anyone's filings whose text holds both names.
  const [mine, both] = await Promise.all([
    searchFilings({ q: `"${name}"`, entityName: company }, ctx),
    searchFilings({ q: `"${name}" "${company}"` }, ctx),
  ]);
  const seen = new Set();
  const hits = [...mine.hits, ...both.hits].filter((h) => !OWN_PASS_FORMS.has(h.rootForm) && !seen.has(`${h.adsh}:${h.file}`) && seen.add(`${h.adsh}:${h.file}`));
  const filers = companyFilers(hits, company, (h) => h.entities);
  const groups = groupByFiling(hits).map((g) => ({ ...g, own: !filers.ambiguous && g.entities.some((e) => filers.keys.has(filerKey(e))) }));
  if (!groups.length) return { findings: [] };
  const own = pickFilings(groups.filter((g) => g.own), subject, { max: 4, perFiler: 4 });
  const others = pickFilings(groups.filter((g) => !g.own), subject, { max: 3, perFiler: 2, maxNameOnly: 3 });

  // For someone else's filing, both names in one long document proves little: read it and keep the company only when it stands next to the name.
  const companyNear = new RegExp(`(?<![A-Za-z0-9])${escapeRe(company)}(?![A-Za-z0-9])`, 'i');
  const nearScore = (window, offset) => { const m = companyNear.exec(window); return m ? { points: 2, start: offset + m.index, end: offset + m.index + m[0].length } : { points: 1 }; };
  const toRead = [...own.slice(0, 1).map((g) => ({ g, score: careerScore })), ...others.slice(0, own.length ? 1 : 2).map((g) => ({ g, score: nearScore }))];
  const read = await mapLimit(toRead, 2, ({ g, score }) => namedPassage(g.best, ctx, { score, trustFiler: g.own }));
  const passageFor = new Map(toRead.map(({ g }, i) => [g.adsh, read[i]]));

  const findings = [];
  const threads = [];
  const entries = [];
  const quoted = quotedFilers([...own, ...others], (g) => passageFor.get(g.adsh));
  for (const g of [...own, ...others]) {
    const passage = passageFor.has(g.adsh) ? passageFor.get(g.adsh) : null;
    if (passage === false) continue;
    if (!passage && quoted.has(filerKey(g.entities[0]))) continue; // the same issuer's filing with a passage already stands for it
    const item = notableItem(g.items);
    const title = `${g.form}${docLabel(g.best)} filed by ${filersOf(g)} mentions ${subject.name}${item ? ` (${item})` : ''}`;
    const quote = passage ? flat(passage) : recordLine(g);
    const fields = {
      source: COMPANY_ID, sourceLabel: 'SEC EDGAR full-text search', category: 'corporate',
      title, quote, url: g.best.url, date: g.date,
      severity: passage ? passageSeverity(subject, g, quote) : 'info',
      matchText: [subject.name, ...g.entities.map((e) => e.name), ...(g.own ? [company] : []), quote].join('. '),
      data: { form: g.form, accession: g.adsh, filers: g.entities.map((e) => e.name), items: g.items },
    };
    // A filing by a registrant already tied to the person (by CIK) is graded by that tie, as in the person's own search.
    const tie = cikTie(subject, g);
    const finding = passage ? gradeByTie(subject, makeFinding(subject, fields), fields, tie) : likelyByTie(subject, makeFinding(subject, fields), fields, tie);
    if (!finding) continue;
    if (!g.own && finding.match === 'possible') finding.matchReasons = ['matched by name only', `the filing's text also contains "${company}", not necessarily next to the name`];
    findings.push(finding);
    entries.push({ g, finding, passage });
    if (passage) threads.push(...passageThreads(subject, passage, g.best.url, finding.match !== 'possible'));
  }
  threads.push(...filerThreads(subject, entries, groups, (n) => `${plural(n, 'SEC filing')} by this company ${n === 1 ? 'names' : 'name'} the person`));
  return { findings, threads: dedupeThreads(threads) };
}

/* ------------------------------------------------------------------ the connectors */

export const secPersonConnector = {
  id: PERSON_ID,
  label: PERSON_LABEL,
  kinds: ['subject'],
  prior: 0.65,
  timeoutMs: 20000,
  plan() {
    return [
      { template: 'formd', prior: 0.75, why: 'private fundraises that name the person as an officer, director or promoter' },
      { template: 'all', prior: 0.7, why: 'every SEC filing whose text contains the name' },
      { template: 'enforcement', prior: 0.6, why: 'SEC litigation releases and administrative proceedings' },
      { template: 'insider', prior: 0.5, why: 'companies the person reported on as an officer, director or large shareholder' },
      { template: 'related', prior: 0.45, why: 'filings that disclose dealings with relatives or related parties' },
      { template: 'press', prior: 0.5, why: 'SEC press releases about charges or settlements that name the person' },
      { template: 'family', prior: 0.35, why: 'relatives the person\'s company names in its own filings with a part in the business' },
    ];
  },
  async run(task, ctx) {
    switch (task?.template) {
      case 'formd': return personFormD(ctx);
      case 'insider': return personInsider(ctx);
      case 'related': return personRelated(ctx);
      case 'press': return personPress(ctx);
      case 'family': return personFamily(ctx);
      case 'enforcement': return personEnforcement(ctx);
      default: return personMentions(ctx);
    }
  },
};

export const secCompanyConnector = {
  id: COMPANY_ID,
  label: COMPANY_LABEL,
  kinds: ['company'],
  prior: 0.55,
  timeoutMs: 20000,
  plan(thread) {
    return [
      { template: 'formd', prior: 0.6, why: 'the company\'s private fundraises and who is named on them' },
      { template: 'joint', prior: 0.55, why: 'filings that name the person together with the company' },
      // A company the person was only an affiliate of: its own incidents do not reflect on them.
      ...(thread?.tie === 'affiliate' ? [] : [{ template: 'cyber', prior: 0.3, why: 'cyber incidents the company reported to the SEC' }]),
    ];
  },
  async run(task, ctx) {
    if (!clean(task?.value)) return { findings: [] };
    switch (task?.template) {
      case 'cyber': return task.tie === 'affiliate' ? { findings: [] } : companyCyber(task, ctx);
      case 'joint': return companyJoint(task, ctx);
      default: return companyFormD(task, ctx);
    }
  },
};
