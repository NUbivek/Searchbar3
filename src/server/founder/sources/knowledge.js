/**
 * Knowledge-graph identity, public roles, and publicly documented family and
 * related-party ties.
 *
 *   wikidata            who the person is in the public knowledge graph:
 *                       education, employers, organisations founded or led,
 *                       public office, and the relatives the graph names,
 *                       each with their own public role
 *   wikipedia           the article about the person: summary, the paragraphs
 *                       that report a legal or controversy matter, career and
 *                       education statements
 *   littlesis           a curated relationship database: positions, board
 *                       seats, ownership, education, membership, family ties
 *   nonprofit-filings   US Form 990 filings that list the person as an
 *                       officer, director or trustee of a nonprofit or
 *                       foundation. Only the organisation search and the
 *                       filings themselves are read: the people search page
 *                       of the filings site asks automated visitors not to
 *                       use it, so it is not used. A person is therefore
 *                       found only at a foundation named after them or their
 *                       family, or at their company's own foundation.
 *
 * Two rules run through all four.
 *
 * Namesakes. A name alone never picks a record. Wikidata and LittleSis are
 * resolved to one entry only when that entry's own description, employers or
 * organisations match what is known about the subject; when two entries are
 * close, or none matches, nothing is returned and a note says why. A wrong
 * entry would poison everything read from it.
 *
 * Relatives. A relative is reported only when the source itself states the
 * kinship AND gives that relative a public business, political or
 * philanthropic role. Nobody born less than 18 years ago is ever reported
 * (the birth year is read for that test alone and never leaves this file),
 * nor a child of unknown age, nor a spouse or child without a public role.
 * An unmarried partner is reported only with a role in an organisation the
 * subject is also tied to. Political donations and political fundraising
 * ties (bundlers, fundraisers, donors, campaign committees) are dropped
 * unread. Officers
 * of a nonprofit who merely share the subject's surname are not relatives:
 * they are mentioned in a note as unconfirmed.
 */
import { getJson, getText, mapLimit } from '../http';
import { makeFinding, makeThread, severityFromText } from '../finding';
import { nameTokens, matchSubject, companyKeyStrict } from '../identity';
import { threadsFromResult, relativesFromText, associatesFromText, mentions } from '../extract';
import { isSensitive, mentionsMinor } from '../guardrails';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unique = (list) => [...new Set(list.filter(Boolean))];
const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const thisYear = () => new Date().getUTCFullYear();
/** Text the privacy rules would reject is left out, so the rest of the record survives. */
const safe = (s) => (isSensitive(s) || mentionsMinor(s) ? '' : clean(s));
/** "American businessman (born 1982)" -> "American businessman": a birth year is never shown. */
const noBirth = (s) => clean(String(s ?? '').replace(/\s*\((?:born|b\.)[^)]*\)/gi, '').replace(/\s*\(\s*\d{4}\s*[-–—]\s*(?:\d{4})?\s*\)/g, '').replace(/,?\s+born\s+(?:in\s+)?\d{4}\b/gi, ''));
const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };

/**
 * Born at least this many calendar years ago is certainly 18. Only the year
 * is known, so 18 years by subtraction could still be a 17-year-old.
 */
const ADULT_YEARS = 19;
const isMinorByYear = (birthYear) => Number.isFinite(birthYear) && thisYear() - birthYear < ADULT_YEARS;

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'esq']);
const bareTokens = (name) => {
  const tokens = nameTokens(String(name || '').replace(/\([^)]*\)/g, ' '));
  while (tokens.length > 2 && SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens;
};

/**
 * Is `candidate` (a name the source gives as its own field) the subject's
 * name? Compared as words, ignoring case, accents and suffixes: first and
 * last names must be equal; the source may carry extra middle names, and a
 * middle initial of the subject may be missing or spelled out, but a full
 * middle name of the subject may not be dropped ("Sam Fried" is not
 * "Sam Bankman-Fried").
 */
export function sameName(subject, candidate) {
  const want = bareTokens(subject?.name);
  const got = bareTokens(candidate);
  if (want.length < 2 || got.length < 2) return false;
  if (want[0] !== got[0] || want[want.length - 1] !== got[got.length - 1]) return false;
  const wantMid = want.slice(1, -1);
  const gotMid = got.slice(1, -1);
  if (!gotMid.length) return wantMid.every((t) => t.length === 1);
  let from = 0;
  for (const w of wantMid) {
    let hit = -1;
    for (let k = from; k < gotMid.length && hit < 0; k += 1) {
      const g = gotMid[k];
      if (g === w || (w.length === 1 && g.startsWith(w)) || (g.length === 1 && w.startsWith(g))) hit = k;
    }
    if (hit < 0) return false;
    from = hit + 1;
  }
  return true;
}

const surnameOf = (name) => {
  const tokens = bareTokens(name);
  return tokens.length >= 2 ? tokens[tokens.length - 1] : '';
};
const sharesSurname = (subject, other) => {
  const mine = surnameOf(subject?.name);
  return mine.length >= 3 && surnameOf(other) === mine && !sameName(subject, other);
};

/** "2003-01-01T00:00:00Z" -> "2003"; "2019-05-01..." -> "2019-05"; "2022-11-11..." -> "2022-11-11". */
function shortDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return /^\d{4}$/.test(String(value || '')) ? String(value) : '';
  if (m[2] === '00' || (m[2] === '01' && m[3] === '01')) return m[1];
  if (m[3] === '00' || m[3] === '01') return `${m[1]}-${m[2]}`;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
const span = (start, end, pointInTime) => {
  const a = shortDate(start);
  const b = shortDate(end);
  if (a && b) return a === b ? a : `${a} to ${b}`;
  if (a) return `from ${a}`;
  if (b) return `until ${b}`;
  return shortDate(pointInTime);
};
const inBrackets = (s) => (s ? ` (${s})` : '');
/** A date makeFinding accepts, from a partial one ("2019-05" -> "2019-05-01"). */
const findingDate = (value) => {
  const s = shortDate(value);
  return s.length === 7 ? `${s}-01` : s || null;
};

/* ------------------------------------------------------------------ *
 * Wikidata
 * ------------------------------------------------------------------ */

const WD_ID = 'wikidata';
const WD_LABEL = 'Wikidata (public knowledge graph)';
const WD_SEARCH = 'https://www.wikidata.org/w/api.php';
const WD_SPARQL = 'https://query.wikidata.org/sparql';
const MAX_CANDIDATES = 8;
const MAX_RELATIVES = 12;

const qidOf = (uri) => (String(uri || '').match(/Q\d+$/) || [''])[0];
const entityUrl = (qid) => `https://www.wikidata.org/wiki/${qid}`;
/** A link that opens the entity page at one statement. */
const statementUrl = (st, fallbackQid) => {
  const m = String(st || '').match(/entity\/statement\/([A-Za-z0-9-]+)$/);
  return m ? `https://www.wikidata.org/entity/statement/${m[1]}` : entityUrl(fallbackQid);
};
const wd = (qids) => qids.map((q) => `wd:${q}`).join(' ');
const en = (v, label) => `OPTIONAL { ${v} rdfs:label ${label} . FILTER(LANG(${label})='en') }`;

async function sparql(query, ctx) {
  const json = await getJson(`${WD_SPARQL}?format=json&query=${encodeURIComponent(query)}`, { accept: 'application/sparql-results+json', deadline: ctx.deadline, timeoutMs: 14000 });
  const rows = json?.results?.bindings;
  if (!Array.isArray(rows)) throw new Error('Wikidata returned an answer that could not be read');
  return rows.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v?.value ?? ''])));
}

/** Who each candidate is: description, other names, employers, organisations founded or led, schools. */
const candidateQuery = (qids) => `SELECT ?c ?cLabel ?cDesc (MAX(?sl) AS ?sitelinks) (MIN(?by) AS ?birthYear) (MAX(?dy) AS ?deathYear) (SAMPLE(?art) AS ?article) (GROUP_CONCAT(DISTINCT ?alt; separator='|') AS ?aliases) (GROUP_CONCAT(DISTINCT ?empLabel; separator='|') AS ?employers) (GROUP_CONCAT(DISTINCT ?orgLabel; separator='|') AS ?orgs) (GROUP_CONCAT(DISTINCT ?schoolLabel; separator='|') AS ?schools) WHERE { VALUES ?c { ${wd(qids)} } ?c wdt:P31 wd:Q5 . ${en('?c', '?cLabel')} OPTIONAL { ?c schema:description ?cDesc . FILTER(LANG(?cDesc)='en') } OPTIONAL { ?c skos:altLabel ?alt . FILTER(LANG(?alt)='en') } OPTIONAL { ?c wikibase:sitelinks ?sl } OPTIONAL { ?c wdt:P569 ?dob . BIND(YEAR(?dob) AS ?by) } OPTIONAL { ?c wdt:P570 ?dod . BIND(YEAR(?dod) AS ?dy) } OPTIONAL { ?art schema:about ?c ; schema:isPartOf <https://en.wikipedia.org/> . } OPTIONAL { ?c wdt:P108 ?emp . ?emp rdfs:label ?empLabel . FILTER(LANG(?empLabel)='en') } OPTIONAL { { ?org wdt:P112|wdt:P169|wdt:P488|wdt:P3320|wdt:P127|wdt:P1037 ?c } UNION { ?c wdt:P1830 ?org } ?org rdfs:label ?orgLabel . FILTER(LANG(?orgLabel)='en') } OPTIONAL { ?c wdt:P69 ?school . ?school rdfs:label ?schoolLabel . FILTER(LANG(?schoolLabel)='en') } } GROUP BY ?c ?cLabel ?cDesc`;

/**
 * The person's own statements, one row per statement, with its link and
 * dates. The optimizer hint matters: without it the endpoint plans the
 * inverse links (organisation -> founded by -> person) badly and times out.
 */
const profileQuery = (qid) => `SELECT ?kind ?st ?val ?valLabel ?jurLabel ?degreeLabel ?majorLabel ?ofLabel ?roleLabel ?start ?end ?pit WHERE { hint:Query hint:optimizer "None" . VALUES ?person { wd:${qid} } { VALUES (?p ?ps ?kind) { (p:P108 ps:P108 'employer') (p:P69 ps:P69 'educated at') (p:P39 ps:P39 'position held') (p:P106 ps:P106 'occupation') (p:P1830 ps:P1830 'owner of') (p:P1399 ps:P1399 'convicted of') (p:P856 ps:P856 'official website') (p:P2002 ps:P2002 'X username') (p:P2037 ps:P2037 'GitHub username') (p:P6634 ps:P6634 'LinkedIn personal profile ID') (p:P2087 ps:P2087 'Crunchbase person ID') } ?person ?p ?st . ?st ?ps ?val . OPTIONAL { ?st pq:P512 ?degree . ?degree rdfs:label ?degreeLabel . FILTER(LANG(?degreeLabel)='en') } OPTIONAL { ?st pq:P812 ?major . ?major rdfs:label ?majorLabel . FILTER(LANG(?majorLabel)='en') } OPTIONAL { ?st pq:P642 ?of . ?of rdfs:label ?ofLabel . FILTER(LANG(?ofLabel)='en') } OPTIONAL { ?st pq:P39 ?role . ?role rdfs:label ?roleLabel . FILTER(LANG(?roleLabel)='en') } OPTIONAL { ?val wdt:P1001 ?jur . ?jur rdfs:label ?jurLabel . FILTER(LANG(?jurLabel)='en') } } UNION { VALUES (?ip ?ips ?kind) { (p:P112 ps:P112 'founded by') (p:P127 ps:P127 'owned by') (p:P169 ps:P169 'chief executive officer') (p:P488 ps:P488 'chairperson') (p:P3320 ps:P3320 'board member') (p:P1037 ps:P1037 'director / manager') } ?st ?ips ?person . ?val ?ip ?st . } ?st wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end } OPTIONAL { ?st pq:P585 ?pit } ${en('?val', '?valLabel')} } LIMIT 400`;

/**
 * Relatives as the graph states them, from the person's page and from the
 * relative's own page (inverse links). ?stated is the property as written on
 * the relative's page. The birth year is read only to exclude minors.
 */
const relativesQuery = (qid) => `SELECT ?rel ?relLabel ?relDesc ?prop ?stated ?kinshipLabel (MAX(?by) AS ?birthYear) (MAX(?dy) AS ?deathYear) (MAX(?sl) AS ?sitelinks) (MAX(?ended) AS ?tieEnded) (GROUP_CONCAT(DISTINCT ?occLabel; separator='; ') AS ?occupations) WHERE { hint:Query hint:optimizer "None" . VALUES ?person { wd:${qid} } { VALUES (?p ?ps ?prop) { (p:P26 ps:P26 'spouse') (p:P22 ps:P22 'father') (p:P25 ps:P25 'mother') (p:P3373 ps:P3373 'sibling') (p:P40 ps:P40 'child') (p:P1038 ps:P1038 'relative') (p:P451 ps:P451 'partner') } ?person ?p ?st . ?st ?ps ?rel . OPTIONAL { ?st pq:P1039 ?kinship . ?kinship rdfs:label ?kinshipLabel . FILTER(LANG(?kinshipLabel)='en') } OPTIONAL { ?st pq:P582 ?ended } } UNION { VALUES (?ip ?prop ?stated) { (wdt:P26 'spouse' 'spouse') (wdt:P40 'parent' 'child') (wdt:P3373 'sibling' 'sibling') (wdt:P22 'child' 'father') (wdt:P25 'child' 'mother') (wdt:P1038 'relative' 'relative') (wdt:P451 'partner' 'unmarried partner') } ?rel ?ip ?person . } ?rel wdt:P31 wd:Q5 . OPTIONAL { ?rel wdt:P569 ?dob . BIND(YEAR(?dob) AS ?by) } OPTIONAL { ?rel wdt:P570 ?dod . BIND(YEAR(?dod) AS ?dy) } OPTIONAL { ?rel wikibase:sitelinks ?sl } ${en('?rel', '?relLabel')} OPTIONAL { ?rel schema:description ?relDesc . FILTER(LANG(?relDesc)='en') } OPTIONAL { ?rel wdt:P106 ?occ . ?occ rdfs:label ?occLabel . FILTER(LANG(?occLabel)='en') } } GROUP BY ?rel ?relLabel ?relDesc ?prop ?stated ?kinshipLabel`;

/**
 * Roles of the person and of each relative, in one flat list. Organisations
 * that appear for both are found by intersecting in code: asking the graph
 * for the intersection directly (relatives nested with roles) times out.
 */
const rolesQuery = (qids) => `SELECT ?who ?role ?st ?org ?orgLabel ?jurLabel ?start ?end WHERE { hint:Query hint:optimizer "None" . VALUES ?who { ${wd(qids)} } { VALUES (?ip ?ips ?role) { (p:P112 ps:P112 'founded by') (p:P169 ps:P169 'chief executive officer') (p:P127 ps:P127 'owned by') (p:P488 ps:P488 'chairperson') (p:P3320 ps:P3320 'board member') (p:P1037 ps:P1037 'director / manager') } ?st ?ips ?who . ?org ?ip ?st . } UNION { VALUES (?p ?ps ?role) { (p:P108 ps:P108 'employer') (p:P1830 ps:P1830 'owner of') (p:P39 ps:P39 'position held') } ?who ?p ?st . ?st ?ps ?org . OPTIONAL { ?org wdt:P1001 ?jur . ?jur rdfs:label ?jurLabel . FILTER(LANG(?jurLabel)='en') } } ?st wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end } ${en('?org', '?orgLabel')} } LIMIT 600`;

const listOf = (s) => unique(String(s || '').split('|').map(clean));

/** A candidate's fit with what is known about the subject: their companies first, then schools. */
function scoreCandidate(subject, c) {
  let score = 0;
  const roles = [...c.employers, ...c.orgs].join(' | ');
  for (const a of subject.anchors.companies.values()) {
    if (a.test(roles)) score += 4;
    else if (a.test(c.description)) score += 3;
  }
  for (const a of subject.anchors.schools.values()) if (a.test(c.schools.join(' | '))) score += 2;
  for (const a of subject.anchors.people.values()) if (a.test(c.description)) score += 1;
  return score;
}

const describe = (list) => list.slice(0, 5).map((c) => c.description || 'no description').join('; ');

/**
 * Pick the one entity that is the subject, or say why none was picked.
 * @returns {{ status: 'resolved'|'none'|'unclear', entity?: object, by?: 'context'|'name', note?: string }}
 */
export function chooseCandidate(subject, candidates) {
  const year = thisYear();
  const fits = candidates.filter((c) => c.label && (sameName(subject, c.label) || c.aliases.some((a) => sameName(subject, a)))
    // someone long dead is not the person an investor is asking about
    && !(c.deathYear && c.deathYear < year - 30) && !(c.birthYear && c.birthYear < 1900));
  if (!fits.length) return { status: 'none' };
  const ranked = fits.map((c) => ({ ...c, score: scoreCandidate(subject, c) })).sort((a, b) => b.score - a.score || b.sitelinks - a.sitelinks);
  const [top, second] = ranked;
  const hints = [...subject.anchors.companies.values(), ...subject.anchors.schools.values()].map((a) => a.value);
  const people = ranked.length === 1 ? 'one person' : `${ranked.length} people`;
  if (top.score >= 2) {
    if (!second || top.score - second.score >= 2) return { status: 'resolved', entity: top, by: 'context' };
    return { status: 'unclear', note: `Wikidata lists more than one ${subject.name} tied to ${hints.slice(0, 2).join(' or ')} (${describe(ranked.filter((c) => c.score > 0))}). None was used, because the right one could not be told apart.` };
  }
  if (!hints.length && ranked.length === 1) return { status: 'resolved', entity: top, by: 'name' };
  if (hints.length) return { status: 'unclear', note: `Wikidata lists ${people} named ${subject.name} (${describe(ranked)}), but nothing in ${ranked.length === 1 ? 'that record' : 'those records'} mentions ${hints.slice(0, 2).join(' or ')}. None was used.` };
  return { status: 'unclear', note: `Wikidata lists ${people} named ${subject.name} (${describe(ranked)}). None was used: add the company so the right one can be picked.` };
}

const resolved = new Map(); // subject key -> { at, promise }
const RESOLVE_TTL_MS = 10 * 60 * 1000;
/** Forget resolved entities (tests). */
export function __resetKnowledgeForTests() {
  resolved.clear();
}

async function findEntity(subject, ctx) {
  const searchName = subject.variants?.[subject.variants.length - 1] || subject.name;
  const url = `${WD_SEARCH}?action=query&list=search&srsearch=${encodeURIComponent(`${searchName} haswbstatement:P31=Q5`)}&srlimit=${MAX_CANDIDATES}&srprop=snippet%7Ctitlesnippet&format=json`;
  const json = await getJson(url, { deadline: ctx.deadline });
  const hits = json?.query?.search;
  if (!Array.isArray(hits)) throw new Error('Wikidata search returned an answer that could not be read');
  const qids = unique(hits.map((h) => String(h?.title || '')).filter((t) => /^Q\d+$/.test(t)));
  if (!qids.length) return { status: 'none' };
  const rows = await sparql(candidateQuery(qids), ctx);
  const candidates = rows.map((r) => ({
    qid: qidOf(r.c),
    label: clean(r.cLabel),
    description: safe(noBirth(r.cDesc)),
    aliases: listOf(r.aliases),
    employers: listOf(r.employers),
    orgs: listOf(r.orgs),
    schools: listOf(r.schools),
    sitelinks: Number(r.sitelinks) || 0,
    birthYear: Number(r.birthYear) || null,
    deathYear: Number(r.deathYear) || null,
    article: /^https:\/\/en\.wikipedia\.org\/wiki\//.test(r.article || '') ? r.article : '',
  })).filter((c) => c.qid);
  return chooseCandidate(subject, candidates);
}

/** Resolve once per subject while the server instance is warm: the profile and family lookups share it. */
function resolveEntity(subject, ctx) {
  const key = [subject.name.toLowerCase(), ...[...subject.anchors.companies.keys()].sort(), '|', ...[...subject.anchors.schools.keys()].sort()].join('\u0001');
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.promise;
  const promise = findEntity(subject, ctx);
  resolved.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (resolved.get(key)?.promise === promise) resolved.delete(key); });
  if (resolved.size > 200) resolved.delete(resolved.keys().next().value);
  return promise;
}

/** What the grader is shown with every record of a resolved entity: the entity's own context. */
const entityContext = (subject, e) => `${subject.name}. ${e.label}: ${e.description}. Employers: ${e.employers.join('; ')}. Organisations: ${e.orgs.join('; ')}. Schools: ${e.schools.join('; ')}.`;

const wdFinding = (ctx, entity, f) => makeFinding(ctx.subject, {
  source: WD_ID, sourceLabel: WD_LABEL, severity: 'info', ...f,
  matchText: `${entityContext(ctx.subject, entity)} ${f.title} ${f.quote || ''}`,
});

const INVERSE_KINDS = new Set(['founded by', 'owned by', 'chief executive officer', 'chairperson', 'board member', 'director / manager']);
const ORG_KINDS = ['founded by', 'chief executive officer', 'chairperson', 'board member', 'director / manager', 'owned by', 'owner of', 'employer'];
const ROLE_PHRASE = { 'founded by': 'founder', 'chief executive officer': 'chief executive officer', chairperson: 'chairperson', 'board member': 'board member', 'director / manager': 'director or manager', 'owned by': 'owner', 'owner of': 'owner', employer: 'employed' };
const POLITICAL_OFFICE = /\b(minister|senator|member of (?:the )?(?:[\w'’.-]+ ){0,4}?(?:parliament|congress|senate|house of|assembly|council|bundestag|knesset|duma|cabinet|legislat\w+|chamber)|prime minister|head of (?:state|government)|president of (?:the )?(?:republic|united states|[A-Z][a-z]+)|vice president of|mayor|governor|ambassador|secretary of (?:state|the treasury|defen[cs]e|commerce|\w+)|attorney general|member of parliament|lawmaker|councillor|council member|commissioner|chancellor of|deputy of|supreme court|justice of|congress(?:man|woman))\b/i;
const NOT_A_COMPANY = /\b(University|College|School|Academy|Institut[eo]?|Hospital|Ministry|Department of|Government|Army|Navy|Air Force|Parliament|Senate|Congress|Court)\b/i;
const SECONDARY_SCHOOL = /\b(high school|secondary school|preparatory|prep school|grammar school|lyc[ée]e|gymnasium|day school|elementary|middle school|kindergarten)\b/i;

/** A statement in the graph's own words: "FTX: chief executive officer Sam Bankman-Fried (start time 2019-05; end time 2022-11-11)". */
function statementText(row, personLabel) {
  const qualifiers = [
    row.roleLabel && `position held ${row.roleLabel}`,
    row.ofLabel && `of ${row.ofLabel}`,
    row.degreeLabel && `academic degree ${row.degreeLabel}`,
    row.majorLabel && `academic major ${row.majorLabel}`,
    row.jurLabel && `applies to jurisdiction ${row.jurLabel}`,
    shortDate(row.start) && `start time ${shortDate(row.start)}`,
    shortDate(row.end) && `end time ${shortDate(row.end)}`,
    shortDate(row.pit) && `point in time ${shortDate(row.pit)}`,
  ].filter(Boolean);
  const kind = row.kind || row.role;
  const value = row.valLabel || row.orgLabel;
  return `${INVERSE_KINDS.has(kind) ? `${value}: ${kind} ${personLabel}` : `${personLabel}: ${kind} ${value}`}${inBrackets(qualifiers.join('; '))}`;
}

const earliest = (list) => list.filter(Boolean).sort()[0] || '';
const latest = (list) => list.filter(Boolean).sort().slice(-1)[0] || '';

/** Several statements of the same office (one per term) become one office with its whole span. */
function mergeOffices(rows, labelKey = 'valLabel', idKey = 'val') {
  const offices = new Map();
  for (const r of rows) {
    const label = clean(r[labelKey]);
    if (!label) continue;
    const key = qidOf(r[idKey]) || label.toLowerCase();
    const o = offices.get(key) || { office: label, jurisdictions: new Set(), starts: [], ends: [], openEnded: false, rows: [], of: clean(r.ofLabel) };
    if (r.jurLabel) o.jurisdictions.add(clean(r.jurLabel));
    if (!o.rows.some((x) => x.st === r.st)) {
      o.rows.push(r);
      if (r.start) o.starts.push(r.start);
      if (r.end) o.ends.push(r.end); else o.openEnded = true;
    }
    offices.set(key, o);
  }
  return [...offices.values()].map((o) => {
    const jurisdiction = [...o.jurisdictions].join(', ');
    return {
      office: o.office, jurisdiction, of: o.of, rows: o.rows,
      political: Boolean(jurisdiction) || POLITICAL_OFFICE.test(o.office),
      start: earliest(o.starts), end: o.openEnded ? '' : latest(o.ends),
      when: span(earliest(o.starts), o.openEnded ? '' : latest(o.ends)),
    };
  });
}

function profileResult(ctx, entity, rows) {
  const { subject } = ctx;
  const findings = [];
  const threads = [];
  const person = entity.label;
  const usable = rows.filter((r) => r.kind && (r.valLabel || /^(official website|X username|GitHub username|LinkedIn personal profile ID|Crunchbase person ID)$/.test(r.kind)));
  const of = (kind) => usable.filter((r) => r.kind === kind);
  const push = (f) => { const made = wdFinding(ctx, entity, f); if (made) findings.push(made); return made; };

  // Who this is
  const occupations = unique(of('occupation').map((r) => safe(r.valLabel))).filter((o) => !/donor/i.test(o)).slice(0, 8);
  const identity = push({
    category: 'identity',
    title: entity.description ? `${person}: ${entity.description}` : `${person} (Wikidata entry)`,
    quote: [`${person}: ${entity.description || 'no description'}`, occupations.length ? `${person}: occupation ${occupations.join('; ')}` : ''].filter(Boolean).join('. '),
    url: entityUrl(entity.qid),
    severity: severityFromText(entity.description),
    data: { wikidataId: entity.qid },
  });
  const trusted = Boolean(identity) && identity.match !== 'possible';

  // Education: one record per school
  const schools = new Map();
  for (const r of of('educated at')) {
    const key = qidOf(r.val) || r.valLabel;
    const s = schools.get(key) || { name: clean(r.valLabel), rows: [] };
    if (!s.rows.some((x) => x.st === r.st)) s.rows.push(r);
    schools.set(key, s);
  }
  for (const s of [...schools.values()].slice(0, 8)) {
    const best = s.rows.find((r) => r.degreeLabel) || s.rows[0];
    const degree = unique(s.rows.map((r) => clean(r.degreeLabel))).join(', ');
    const major = unique(s.rows.map((r) => clean(r.majorLabel))).join(', ');
    const when = span(earliest(s.rows.map((r) => r.start)), latest(s.rows.map((r) => r.end)), best.pit);
    push({
      category: 'education',
      title: `${person}: educated at ${s.name}${degree ? `, ${degree}` : ''}${major ? ` in ${major}` : ''}${inBrackets(when)}`,
      quote: s.rows.map((r) => statementText(r, person)).join('. '),
      url: statementUrl(best.st, entity.qid),
      date: findingDate(latest(s.rows.map((r) => r.end)) || earliest(s.rows.map((r) => r.start))),
    });
    if (!SECONDARY_SCHOOL.test(s.name)) threads.push(makeThread('school', s.name, `educated at${inBrackets(when)} (Wikidata)`, { trusted }));
  }

  // Career: one record per organisation, with every role the graph states there
  const orgs = new Map();
  for (const r of usable.filter((x) => ORG_KINDS.includes(x.kind))) {
    const key = qidOf(r.val) || r.valLabel;
    const o = orgs.get(key) || { name: clean(r.valLabel), rows: [] };
    if (!o.rows.some((x) => x.st === r.st)) o.rows.push(r);
    orgs.set(key, o);
  }
  const rank = (o) => Math.min(...o.rows.map((r) => ORG_KINDS.indexOf(r.kind)));
  const ordered = [...orgs.values()].sort((a, b) => rank(a) - rank(b) || latest(b.rows.map((r) => r.start)).localeCompare(latest(a.rows.map((r) => r.start))));
  for (const o of ordered.slice(0, 14)) {
    o.rows.sort((a, b) => ORG_KINDS.indexOf(a.kind) - ORG_KINDS.indexOf(b.kind));
    const phrases = unique(o.rows.map((r) => `${r.roleLabel && r.kind === 'employer' ? clean(r.roleLabel) : ROLE_PHRASE[r.kind]}${inBrackets(span(r.start, r.end, r.pit))}`));
    push({
      category: 'career',
      title: `${person} at ${o.name}: ${phrases.join('; ')}`,
      quote: o.rows.map((r) => statementText(r, person)).join('. '),
      url: statementUrl(o.rows[0].st, entity.qid),
      date: findingDate(earliest(o.rows.map((r) => r.start)) || earliest(o.rows.map((r) => r.end || r.pit))),
    });
    // a university or ministry someone merely worked at is not a company to look into; one they founded or led is
    const onlyEmployed = o.rows.every((r) => r.kind === 'employer');
    if (!(onlyEmployed && NOT_A_COMPANY.test(o.name)) && threads.filter((t) => t?.kind === 'company').length < 10) {
      threads.push(makeThread('company', o.name, `${phrases[0]} (Wikidata)`, { trusted }));
    }
  }

  // Positions: public office is a watchlist matter; anything else is career
  const offices = mergeOffices(of('position held'));
  for (const o of offices.filter((x) => x.political).slice(0, 8)) {
    const where = o.jurisdiction && !o.office.toLowerCase().includes(o.jurisdiction.toLowerCase()) ? `, ${o.jurisdiction}` : '';
    push({
      category: 'sanctions',
      severity: 'low',
      title: `Politically exposed person: ${o.office}${where}${inBrackets(o.when)}`,
      quote: o.rows.slice(0, 4).map((r) => statementText(r, person)).join('. '),
      url: statementUrl(o.rows[0].st, entity.qid),
      date: findingDate(o.start || o.end),
      data: { office: o.office, jurisdiction: o.jurisdiction || null },
    });
  }
  const otherPositions = offices.filter((x) => !x.political);
  if (otherPositions.length) {
    push({
      category: 'career',
      title: `${person}: position held, ${otherPositions.slice(0, 5).map((o) => `${o.office}${o.of ? ` of ${o.of}` : ''}${inBrackets(o.when)}`).join('; ')}`,
      quote: otherPositions.flatMap((o) => o.rows).slice(0, 6).map((r) => statementText(r, person)).join('. '),
      url: statementUrl(otherPositions[0].rows[0].st, entity.qid),
      date: findingDate(otherPositions[0].start || otherPositions[0].end),
    });
  }

  // A conviction the graph records
  for (const r of of('convicted of').slice(0, 4)) {
    push({
      category: 'litigation',
      severity: 'high',
      title: `${person}: convicted of ${clean(r.valLabel)}${inBrackets(shortDate(r.pit) || span(r.start, r.end))}`,
      quote: statementText(r, person),
      url: statementUrl(r.st, entity.qid),
      date: findingDate(r.pit || r.start || r.end),
    });
  }

  // Pages and handles the graph links to the person
  if (entity.article) threads.push(makeThread('url', entity.article, 'English Wikipedia article about the person', { trusted, platform: 'wikipedia' }));
  const idOf = (kind) => of(kind).map((r) => clean(r.val)).filter((v) => /^[A-Za-z0-9_.-]{2,60}$/.test(v))[0];
  const x = idOf('X username');
  if (x) {
    threads.push(makeThread('url', `https://x.com/${x}`, 'x profile listed on Wikidata', { trusted, platform: 'x' }));
    threads.push(makeThread('handle', x, 'x handle listed on Wikidata', { trusted, platform: 'x' }));
  }
  const github = idOf('GitHub username');
  if (github) {
    threads.push(makeThread('url', `https://github.com/${github}`, 'github profile listed on Wikidata', { trusted, platform: 'github' }));
    threads.push(makeThread('handle', github, 'github handle listed on Wikidata', { trusted, platform: 'github' }));
  }
  const linkedin = idOf('LinkedIn personal profile ID');
  if (linkedin) threads.push(makeThread('url', `https://linkedin.com/in/${linkedin}`, 'linkedin profile listed on Wikidata', { trusted, platform: 'linkedin' }));
  const crunchbase = idOf('Crunchbase person ID');
  if (crunchbase) threads.push(makeThread('url', `https://crunchbase.com/person/${crunchbase}`, 'crunchbase profile listed on Wikidata', { trusted, platform: 'crunchbase' }));
  for (const r of of('official website').slice(0, 2)) {
    let host = '';
    try { host = new URL(r.val).hostname.toLowerCase().replace(/^www\./, ''); } catch { host = ''; }
    if (host && !/(^|\.)(linkedin|twitter|x|facebook|instagram|github|medium|substack|linktr|youtube|wikipedia)\.[a-z.]+$/.test(host)) {
      threads.push(makeThread('domain', host, 'personal website listed on Wikidata', { trusted }));
    }
  }

  const notes = entity.by === 'name' ? [`Wikidata has one person named ${subject.name} (${entity.description || 'no description'}). No company was given to confirm it is the same person, so its records are shown as possible matches only.`] : [];
  const seen = new Set();
  return { findings, threads: threads.filter((t) => t && !seen.has(`${t.kind}|${t.value.toLowerCase()}`) && seen.add(`${t.kind}|${t.value.toLowerCase()}`)), notes };
}

const KIN_LABEL = { spouse: 'spouse', father: 'father', mother: 'mother', sibling: 'sibling', child: 'child', relative: 'relative', partner: 'unmarried partner', parent: 'child' };
const KIN_ORDER = ['spouse', 'father', 'mother', 'sibling', 'child', 'partner', 'parent', 'relative'];
const BUSINESS_ROLE = /\b(business\w*|executive|entrepreneur|investor|venture capitalist|financier|banker|industrialist|chief \w+ officer|magnate|real estate developer|fund manager|company director|board member|philanthropist|hedge fund manager|merchant banker)\b/i;
const POLITICAL_ROLE = /\b(politician|diplomat|civil servant|government official|public official|minister|judge|lobbyist|ambassador|statesman|stateswoman|military officer|monarch|aristocrat|member of parliament)\b/i;
const ORG_ROLES = new Set(['founded by', 'chief executive officer', 'chairperson', 'board member', 'director / manager', 'owned by', 'owner of']);

/** One relative per person, from the rows of the relatives query. */
function mergeRelatives(rows, subjectQid) {
  const byId = new Map();
  for (const r of rows) {
    const qid = qidOf(r.rel);
    if (!qid || qid === subjectQid || !clean(r.relLabel)) continue;
    const rel = byId.get(qid) || { qid, name: clean(r.relLabel), description: safe(noBirth(r.relDesc)), props: new Set(), direct: new Set(), stated: new Map(), kinship: '', birthYear: null, deathYear: null, sitelinks: 0, ended: false, occupations: [] };
    rel.props.add(r.prop);
    if (r.stated) rel.stated.set(r.prop, r.stated); else rel.direct.add(r.prop);
    if (r.kinshipLabel) rel.kinship = clean(r.kinshipLabel);
    if (r.tieEnded) rel.ended = true;
    const by = Number(r.birthYear);
    if (by) rel.birthYear = Math.max(rel.birthYear || 0, by);
    if (Number(r.deathYear)) rel.deathYear = Number(r.deathYear);
    rel.sitelinks = Math.max(rel.sitelinks, Number(r.sitelinks) || 0);
    rel.occupations = unique([...rel.occupations, ...String(r.occupations || '').split(';').map(safe)]);
    byId.set(qid, rel);
  }
  return [...byId.values()].map((rel) => {
    const prop = KIN_ORDER.find((p) => rel.props.has(p));
    const extended = prop === 'relative';
    let relation = extended ? (rel.kinship || 'relative') : prop;
    if (rel.ended && (prop === 'spouse' || prop === 'partner')) relation = `former ${relation}`;
    return { ...rel, prop, extended, relation };
  });
}

/** May this relative be considered at all? Never a minor, never a child of unknown age, never an ancestor from another century. */
function eligibleRelative(rel) {
  if (isMinorByYear(rel.birthYear)) return false;
  if ((rel.prop === 'child') && !rel.birthYear) return false;
  if (rel.birthYear && rel.birthYear < 1920) return false;
  if (rel.deathYear && rel.deathYear < thisYear() - 25) return false;
  return true;
}

function roleRowText(r, name) {
  return statementText({ kind: r.role, valLabel: r.orgLabel, start: r.start, end: r.end, jurLabel: r.role === 'position held' ? r.jurLabel : '' }, name);
}

function familyResult(ctx, entity, relatives, roleRows) {
  const person = entity.label;
  const findings = [];
  const threads = [];
  const push = (f) => { const made = wdFinding(ctx, entity, f); if (made) findings.push(made); return made; };
  const rowsOf = (qid) => roleRows.filter((r) => qidOf(r.who) === qid && clean(r.orgLabel));
  const orgKey = (r) => qidOf(r.org) || clean(r.orgLabel).toLowerCase();
  const mine = new Map();
  for (const r of rowsOf(entity.qid)) if (r.role !== 'position held') mine.set(orgKey(r), [...(mine.get(orgKey(r)) || []), r]);

  for (const rel of relatives) {
    const rows = rowsOf(rel.qid);
    const orgRoles = rows.filter((r) => ORG_ROLES.has(r.role));
    const employers = rows.filter((r) => r.role === 'employer');
    const offices = mergeOffices(rows.filter((r) => r.role === 'position held'), 'orgLabel', 'org');
    const publicOffices = offices.filter((o) => o.political);
    const shared = rows.filter((r) => r.role !== 'position held' && mine.has(orgKey(r)));
    const occupationText = rel.occupations.join('; ');
    const inBusiness = orgRoles.length > 0 || BUSINESS_ROLE.test(occupationText);
    const business = inBusiness || offices.some((o) => !o.political);
    const political = publicOffices.length > 0 || POLITICAL_ROLE.test(occupationText);
    const working = orgRoles.length > 0 || employers.length > 0 || offices.length > 0;

    // The rule: kinship is stated by the graph (it is, or the row would not exist) AND the relative has a public
    // business, political or philanthropic role. Merely being employed somewhere (a professor, a doctor) is not one,
    // unless the employer is also one of the subject's organisations.
    let show = business || political || shared.length > 0;
    if (rel.prop === 'partner') show = shared.length > 0; // an unmarried partner only with a role in the subject's organisations
    if (rel.extended) show = inBusiness || political || shared.length > 0; // extended kin only with a business or political nexus (a title such as "president" of a society is not one)
    if (!rel.birthYear && rel.prop !== 'father' && rel.prop !== 'mother' && rel.prop !== 'parent' && rel.prop !== 'spouse') show = show && working; // age unknown: only someone with a working role
    if (!show) continue;

    const byOrg = new Map();
    for (const r of orgRoles) byOrg.set(orgKey(r), { org: clean(r.orgLabel), roles: unique([...(byOrg.get(orgKey(r))?.roles || []), ROLE_PHRASE[r.role]]) });
    const publicOccupations = rel.occupations.filter((o) => BUSINESS_ROLE.test(o) || POLITICAL_ROLE.test(o));
    const occupations = publicOccupations.length ? publicOccupations : rel.occupations.slice(0, 2);
    const roleParts = [
      ...[...byOrg.values()].slice(0, 3).map((o) => `${o.roles.join(' and ')} of ${o.org}`),
      ...publicOffices.slice(0, 2).map((o) => `${o.office}${inBrackets(o.when)}`),
      ...offices.filter((o) => !o.political).slice(0, 1).map((o) => o.office),
      ...(occupations.length ? [occupations.slice(0, 3).join(', ')] : []),
      ...(employers.length ? [`employed at ${unique(employers.map((r) => clean(r.orgLabel))).slice(0, 3).join(', ')}`] : []),
    ];
    const role = roleParts.slice(0, 3).join('; ') || rel.occupations.slice(0, 3).join(', ');
    const relationLabel = rel.prop === 'child' ? 'Adult child' : capitalise(rel.relation);
    // the kinship as the graph states it: on the person's own page when it is there, else on the relative's
    const kinStatement = rel.direct.has(rel.prop)
      ? `${person}: ${KIN_LABEL[rel.prop]} ${rel.name}${rel.extended && rel.kinship ? ` (kinship to subject ${rel.kinship})` : ''}`
      : `${rel.name}: ${rel.stated.get(rel.prop) || KIN_LABEL[rel.prop]} ${person}`;
    const statements = [
      kinStatement,
      rel.occupations.length ? `${rel.name}: occupation ${rel.occupations.slice(0, 5).join('; ')}` : '',
      ...unique(rows.map((r) => roleRowText(r, rel.name))).slice(0, 6),
    ].filter(Boolean);
    const made = push({
      category: 'related',
      title: `${relationLabel}: ${rel.name}, ${role}`,
      quote: statements.join('. '),
      url: entityUrl(rel.qid),
      data: { person: rel.name, relation: rel.relation, role },
    });
    if (!made) continue;
    threads.push(makeThread('relative', rel.name, `${rel.relation}; ${role} (Wikidata)`, { relation: rel.relation, role, trusted: made.match !== 'possible' }));

    // The relative holds public office: the subject is a family member of a politically exposed person
    for (const o of publicOffices.slice(0, 2)) {
      push({
        category: 'sanctions',
        severity: 'low',
        title: `Politically exposed person in the family: ${rel.relation} ${rel.name}, ${o.office}${inBrackets(o.when)}`,
        quote: [kinStatement, ...o.rows.slice(0, 3).map((r) => roleRowText(r, rel.name))].join('. '),
        url: statementUrl(o.rows[0].st, rel.qid),
        date: findingDate(o.start || o.end),
        data: { person: rel.name, relation: rel.relation, office: o.office, jurisdiction: o.jurisdiction || null },
      });
    }

    // Organisations the graph ties to both of them
    const seen = new Set();
    for (const r of shared) {
      if (seen.has(orgKey(r)) || seen.size >= 4) continue;
      seen.add(orgKey(r));
      const theirs = shared.filter((x) => orgKey(x) === orgKey(r));
      push({
        category: 'related',
        severity: 'low',
        title: `Related-party overlap: ${rel.name} (${rel.relation}) and ${person} are both tied to ${clean(r.orgLabel)}`,
        quote: unique([...theirs.map((x) => roleRowText(x, rel.name)), ...mine.get(orgKey(r)).map((x) => roleRowText(x, person))]).join('. '),
        url: statementUrl(theirs[0].st, rel.qid),
        date: findingDate(earliest(theirs.map((x) => x.start))),
        data: { person: rel.name, relation: rel.relation, organisation: clean(r.orgLabel) },
      });
    }
  }
  return { findings, threads: threads.filter(Boolean), notes: [] };
}

export const wikidataConnector = {
  id: WD_ID,
  label: WD_LABEL,
  kinds: ['subject'],
  prior: 0.6,
  timeoutMs: 20000,
  plan(thread) {
    if (thread.kind !== 'subject') return [];
    return [
      { template: 'profile', prior: 0.65, why: 'education, employers, organisations founded or led, public office' },
      { template: 'family', prior: 0.5, why: 'relatives the graph names in a public role, and organisations they share' },
    ];
  },
  /**
   * template 'profile' | 'family'; with no template both are run (at most
   * five requests: search, candidates, profile, relatives, roles).
   */
  async run(task, ctx) {
    if (task.kind !== 'subject') return { findings: [], threads: [], notes: [] };
    const { subject } = ctx;
    const found = await resolveEntity(subject, ctx);
    if (found.status !== 'resolved') return { findings: [], threads: [], notes: found.note ? [found.note] : [] };
    const entity = { ...found.entity, by: found.by };
    const wantProfile = task.template !== 'family';
    const wantFamily = task.template !== 'profile';
    const out = { findings: [], threads: [], notes: [] };
    const add = (r) => { out.findings.push(...r.findings); out.threads.push(...r.threads); out.notes.push(...r.notes); };

    const profile = async () => add(profileResult(ctx, entity, await sparql(profileQuery(entity.qid), ctx)));
    const family = async () => {
      if (entity.by === 'name') {
        // A namesake's family must never be shown: relatives are read only once the entry is tied to the subject by more than a name.
        if (!wantProfile) out.notes.push(`Family ties on Wikidata were not read for ${subject.name}: the entry is matched by name only. Add the company to confirm it is the same person.`);
        return;
      }
      const relatives = mergeRelatives(await sparql(relativesQuery(entity.qid), ctx), entity.qid).filter(eligibleRelative)
        .sort((a, b) => b.sitelinks - a.sitelinks).slice(0, MAX_RELATIVES);
      if (!relatives.length) return;
      const roleRows = await sparql(rolesQuery([entity.qid, ...relatives.map((r) => r.qid)]), ctx);
      add(familyResult(ctx, entity, relatives, roleRows));
    };
    await Promise.all([wantProfile ? profile() : null, wantFamily ? family() : null]);
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * Wikipedia
 * ------------------------------------------------------------------ */

const WP_ID = 'wikipedia';
const WP_LABEL = 'Wikipedia';
const WP_URL = /^https?:\/\/([a-z]{2,3}(?:-[a-z]+)?)\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i;
const WP_NAMESPACE = /^(Special|Talk|User|User talk|Wikipedia|File|Category|Help|Template|Portal|Draft|Module|MediaWiki):/i;
const MAX_LEGAL_FINDINGS = 14;
const QUOTE_CHARS = 640;

/** { lang, title } for a Wikipedia article link, or null for any other link. */
export function parseWikipediaUrl(url) {
  const m = String(url || '').match(WP_URL);
  if (!m) return null;
  let title = m[2].split(/%23/i)[0];
  try { title = decodeURIComponent(title); } catch { /* keep as given */ }
  title = title.replace(/_/g, ' ').trim();
  if (!title || WP_NAMESPACE.test(title)) return null;
  return { lang: m[1].toLowerCase(), title };
}

const WP_SKIP_SECTION = /^(references|external links|see also|notes|footnotes|further reading|bibliography|sources|citations|works cited|filmography|discography|publications|selected (?:works|publications|bibliography)|works|books|awards|honou?rs|recognition|accolades|in popular culture|popular culture|in (?:the )?media|media portrayals?|cultural depictions?|depictions?|portrayals?|gallery|explanatory notes)\b/i;
/** Sections about private life: read for relatives in public roles, never quoted. */
const WP_PRIVATE_SECTION = /\b(personal life|private life|family|marriage|relationships?|health|illness|death|religio\w*|beliefs)\b/i;
/** No bare "life": "Personal life" is not where a school is reported, and quoting it leaks private matters. */
const WP_EARLY_SECTION = /\b(early life|early years|education|background|childhood|youth|biography)\b/i;
const WP_CAREER_SECTION = /\b(career|business|work|compan(?:y|ies)|ventures?|invest\w*|professional|entrepreneur\w*|founding|research|history|activities|projects?)\b/i;
/** Sentences that are private however they are worded: residence, birth, partners. */
const WP_PRIVATE_SENTENCE = /\b(was born|born (?:on|in|to)\b|birthday|lives in|resides in|residence in|home in|neighbou?rhood|mansion|gave birth|married|wedding|engaged to|dating|girlfriend|boyfriend|fianc[ée]e?|romantic\w*|divorc\w*|honeymoon)\b/i;
const LEGAL_MATTER = /\b(lawsuits?|sued|sues|suing|litigation|court|judge|jury|juror|indict\w*|convict\w*|acquitt\w*|plead(?:ed|s)?|pled|guilty|sentenc\w*|prison|imprison\w*|incarcerat\w*|charged|charges|trial|prosecut\w*|settle(?:d|ment)|subpoena\w*|fined|penalt(?:y|ies)|bankruptc\w*|injunction|arbitration|appeal(?:ed|s)?|verdict|defendants?|plaintiffs?|arrest\w*|extradit\w*|restitution|forfeit\w*|Securities and Exchange Commission|SEC|Department of Justice|DOJ|CFTC|FTC|FBI|regulators?|attorney general|grand jury)\b/;
const EDUCATION_WORDS = /\b(graduat\w*|attended|studied|enrolled|dropped out|drop out|degree|bachelor\w*|master'?s|MBA|Ph\.?D\.?|doctorate|doctoral|university|college|school|institute|alumn\w*|scholarship|thesis)\b/i;
const CAREER_WORDS = /\b(co-?founded|founded|co-?founder|founder|joined|appointed|named|became|served as|worked|hired|launched|started|established|CEO|chief executive|chairman|chairwoman|chair|president|director|partner|board|acquired|raised|invested|valuation|valued|stepped down|resigned|left the|sold|merged|IPO|went public)\b/i;
/** Military or national service: part of a career, often reported under early life. */
const SERVICE_WORDS = /\bserved\b[^.]{0,40}?\b(?:in|with) the (?:[\w'’-]+ ){0,3}?(?:navy|army|air force|marines?|marine corps|military|defen[cs]e forces?|coast guard|national guard)\b/i;
/** A funding round or deal with its amount ("raised $350 million"). */
const FUNDING_AMOUNT = /(?:US)?[$€£]\s?[\d.,]+\s*(?:million|billion|bn|m)\b/i;
const careerSentence = (x) => CAREER_WORDS.test(x) || SERVICE_WORDS.test(x) || FUNDING_AMOUNT.test(x);

const WP_ABBREVIATION = /\b(v|vs|Inc|Corp|Ltd|Co|Mr|Mrs|Ms|Dr|Jr|Sr|St|No|Prof|Gen|Sen|Rep|Gov|U\.S|et al)\.(?=\s)/g;
/** A middle or first initial ("Robert F. Kennedy", "J. Smith"): not the end of a sentence. */
const WP_INITIAL = /\b([A-Z])\.(?=\s+[A-Z])/g;
/** Sentences of a paragraph, verbatim. */
const sentencesIn = (text) => clean(text).replace(WP_ABBREVIATION, '$1\u0001').replace(WP_INITIAL, '$1\u0001').split(/(?<=[.!?]["”]?)\s+(?=[A-Z"“])/).map((s) => s.replace(/\u0001/g, '.').trim()).filter((s) => s.length > 20 && s.length < 700);
/** May this sentence be quoted? Not when it is about private life, a child, or a protected matter. */
const quotable = (s) => !WP_PRIVATE_SENTENCE.test(s) && !isSensitive(s) && !mentionsMinor(s);
/** The latest year a quotation names that is not in the future ("pleaded guilty in 2022" -> "2022"), or null. */
function yearOf(text) {
  const years = (String(text || '').match(/\b(?:19|20)\d{2}\b/g) || []).map(Number).filter((y) => y <= thisYear());
  return years.length ? String(Math.max(...years)) : null;
}
/** The sentences, in order, that fit in a quotation. */
function fitSentences(sentences, limit = QUOTE_CHARS) {
  const out = [];
  let used = 0;
  for (const s of sentences) {
    if (used + s.length + 1 > limit && out.length) break;
    out.push(s);
    used += s.length + 1;
    if (used >= limit) break;
  }
  return out;
}
/** Take sentences in order while they fit in a quotation. */
const fitQuote = (sentences, limit = QUOTE_CHARS) => fitSentences(sentences, limit).join(' ');

/** The article as sections: [{ heading, top, paragraphs }], the lead first with an empty heading. */
export function articleSections(extract) {
  const parts = String(extract || '').split(/^(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$/m);
  const sections = [{ heading: '', top: '', text: parts[0] || '' }];
  let top = '';
  for (let i = 1; i + 2 < parts.length + 1; i += 3) {
    const level = parts[i].length;
    const heading = clean(parts[i + 1]);
    if (level === 2) top = heading;
    sections.push({ heading, top: top || heading, text: parts[i + 2] || '' });
  }
  return sections.map((s) => ({ heading: s.heading, top: s.top, paragraphs: s.text.split(/\n+/).map(clean).filter((p) => p.length > 40) }))
    .filter((s) => s.paragraphs.length);
}

/**
 * The article calls its subject by surname ("Holmes founded ..."). The
 * thread extractors only read sentences that give the full name, so bare
 * surname mentions are expanded first. Used for finding threads only: quoted
 * text is never altered.
 */
function withFullName(subject, text) {
  const tokens = String(subject.name || '').split(/\s+/);
  const surname = tokens[tokens.length - 1] || '';
  if (tokens.length < 2 || surname.length < 3) return text;
  const re = new RegExp(`(?<![A-Za-zÀ-ÿ'’-])(?<![A-ZÀ-Þ][A-Za-zÀ-ÿ'’-]*\\s)(?<![A-Z]\\.\\s)${escapeRe(surname)}(?![A-Za-zÀ-ÿ-])(?!\\s+(?:[A-ZÀ-Þ][a-zà-ÿ]|II\\b|III\\b|IV\\b|Jr\\b|Sr\\b))`, 'g');
  return String(text).replace(re, subject.name);
}

/**
 * In the subject's own article, "He founded ..." right after a sentence
 * that names the subject is about the subject: the pronoun is replaced with
 * the full name so the company extractor reads it. Only a run of sentences
 * that starts with one naming the subject is rewritten (the same rule the
 * associate and relative extractors follow). Used for finding threads only.
 */
function withPronouns(subject, text) {
  let named = false;
  return String(text).split(/(?<=[.!?]["”]?)\s+(?=[A-Z"“])/).map((sentence) => {
    if (subject.hasName(sentence)) { named = true; return sentence; }
    if (named && /^(?:He|She)\s/.test(sentence)) return sentence.replace(/^(?:He|She)(?=\s)/, subject.name);
    named = false;
    return sentence;
  }).join(' ');
}

/** A link that opens the article at a section. The "#" is written "%23" so each section has its own address; Wikipedia redirects it to the section. */
const sectionUrl = (articleUrl, heading) => (heading ? `${articleUrl}%23${encodeURIComponent(heading.replace(/\s+/g, '_'))}` : articleUrl);
/**
 * The same section reporting several matters: each finding still needs its
 * own address (the check keeps one finding per address and category), so a
 * later one points at a word of its own text (a text fragment; a browser that
 * cannot find it simply opens the section).
 */
function distinctUrl(used, url, quote) {
  if (!used.has(url)) { used.add(url); return url; }
  const words = unique(String(quote).match(/[A-Za-z][A-Za-z'-]{5,}/g) || []);
  for (const w of words) {
    const candidate = `${url}${url.includes('%23') ? '' : '%23'}%3A~%3Atext%3D${encodeURIComponent(w)}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
  return url;
}

/** A company the person founded or runs (or the one given); an affiliate (a stake, an investment) is not read. */
const primaryCompany = (x) => x?.kind === 'company' && (!x.tie || x.tie === 'primary');

/**
 * The company's own article: who founded it with the person, advisers and
 * shareholders it names, and relatives it gives a role there. Only an
 * article whose title is the company's name and that names the person in
 * full is read (a company that merely shares the name never does), and only
 * sentences that name the person, or follow straight on from one, are read
 * for people. Threads only: nothing from it is quoted as a record.
 */
async function wpCompany(task, ctx) {
  const empty = { findings: [], threads: [], notes: [] };
  if (!primaryCompany(task)) return empty;
  const { subject } = ctx;
  const company = clean(task.value);
  const key = companyKeyStrict(company);
  if (key.length < 3) return empty;
  const titles = unique([company, `${company} (company)`]).join('|');
  const api = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageprops%7Cinfo&explaintext=1&exsectionformat=wiki&redirects=1&inprop=url&titles=${encodeURIComponent(titles)}&format=json&formatversion=2`;
  const json = await getJson(api, { deadline: ctx.deadline });
  if (!json?.query || !Array.isArray(json.query.pages)) throw new Error('Wikipedia returned an answer that could not be read');
  const doc = json.query.pages.find((p) => p && !p.missing && p.extract && !(p.pageprops && 'disambiguation' in p.pageprops)
    && companyKeyStrict(clean(p.title).replace(/\s*\([^)]*\)\s*$/, '')) === key);
  if (!doc) return empty;
  const sections = articleSections(String(doc.extract)).filter((s) => !WP_SKIP_SECTION.test(s.heading) && !WP_SKIP_SECTION.test(s.top)
    && !WP_PRIVATE_SECTION.test(s.heading) && !WP_PRIVATE_SECTION.test(s.top));
  // Bare surnames are not expanded here: in a company article "Roe" may be a relative or another founder.
  const text = withPronouns(subject, sections.flatMap((s) => s.paragraphs).join(' ').slice(0, 20000));
  const about = sentencesIn(text).filter((x) => subject.hasName(x));
  if (!about.length) return empty;
  const title = clean(doc.title);
  const trusted = matchSubject(subject, clean(`${subject.name}. ${company}. ${title}. ${about.join(' ')}`).slice(0, 3900)).level !== 'possible';
  const threads = [];
  for (const a of associatesFromText(subject, text).slice(0, 8)) threads.push(makeThread('associate', a.name, `${a.why} (Wikipedia article on ${title})`, { trusted }));
  for (const r of relativesFromText(subject, text).slice(0, 4)) {
    threads.push(makeThread('relative', r.name, `${r.relation}; ${r.role} (Wikipedia article on ${title})`, { trusted, relation: r.relation, role: r.role }));
  }
  const seen = new Set();
  return { ...empty, threads: threads.filter((t) => t && !seen.has(`${t.kind}|${t.value.toLowerCase()}`) && seen.add(`${t.kind}|${t.value.toLowerCase()}`)) };
}

export const wikipediaConnector = {
  id: WP_ID,
  label: WP_LABEL,
  kinds: ['url', 'company'],
  prior: 0.7,
  timeoutMs: 15000,
  /** Only Wikipedia article links, and the person's own companies, become a lookup: any other link costs nothing here. */
  plan(thread) {
    if (primaryCompany(thread)) return [{ template: 'company-article', prior: 0.5, why: 'the Wikipedia article about the company: co-founders, advisers and shareholders it names' }];
    return thread.kind === 'url' && parseWikipediaUrl(thread.value) ? [{ template: 'article', why: 'the Wikipedia article about the person' }] : [];
  },
  async run(task, ctx) {
    const empty = { findings: [], threads: [], notes: [] };
    if (task.kind === 'company') return wpCompany(task, ctx);
    const page = task.kind === 'url' ? parseWikipediaUrl(task.value) : null;
    if (!page) return empty;
    const { subject } = ctx;
    const api = `https://${page.lang}.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageprops%7Cinfo%7Crevisions&rvprop=timestamp&explaintext=1&exsectionformat=wiki&redirects=1&inprop=url&titles=${encodeURIComponent(page.title)}&format=json&formatversion=2`;
    const json = await getJson(api, { deadline: ctx.deadline });
    const doc = json?.query?.pages?.[0];
    if (!json?.query || !Array.isArray(json.query.pages)) throw new Error('Wikipedia returned an answer that could not be read');
    if (!doc || doc.missing || !doc.extract) return empty;
    const title = clean(doc.title);
    if (doc.pageprops && 'disambiguation' in doc.pageprops) {
      return { ...empty, notes: [`The Wikipedia page "${title}" is a list of different people and things with that name, so it was not used.`] };
    }
    // Only the article about the person: one that merely mentions them is left to the web sources.
    if (!sameName(subject, title)) return empty;

    const articleUrl = doc.canonicalurl || `https://${page.lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const revised = doc.revisions?.[0]?.timestamp || null;
    const description = safe(noBirth(doc.pageprops?.['wikibase-shortdesc']));
    const fullText = String(doc.extract).replace(/\s*\((?:[^()]*;\s*)?born\b[^()]*\)/gi, '');
    const sections = articleSections(fullText).filter((s) => !WP_SKIP_SECTION.test(s.heading) && !WP_SKIP_SECTION.test(s.top));
    // The grader sees the article: it is one record about one person, so a known company anywhere in it ties the record to the subject.
    // Only what may be quoted is shown to it (the text it grades from is kept with each finding): never private-life sections or sentences.
    // Sentences naming something already known come first, so the kept text still holds them.
    const anchors = [...subject.anchors.companies.values(), ...subject.anchors.schools.values(), ...subject.anchors.people.values()];
    const readable = sections.filter((s) => !WP_PRIVATE_SECTION.test(s.heading) && !WP_PRIVATE_SECTION.test(s.top))
      .flatMap((s) => s.paragraphs.flatMap(sentencesIn)).filter(quotable);
    const tying = readable.filter((x) => anchors.some((a) => a.test(x)));
    const context = clean(`${subject.name}. ${title}${description ? `: ${description}` : ''}. ${unique([...tying, ...readable]).join(' ')}`).slice(0, 3900);
    const trusted = matchSubject(subject, context).level !== 'possible';
    // The last edit of the article is not the date of anything it reports: a finding carries a year only when its own text gives one.
    const build = (f) => makeFinding(subject, { source: WP_ID, sourceLabel: WP_LABEL, date: null, severity: 'info', ...f, data: { ...(f.data || {}), revisedAt: revised }, matchText: context });
    const findings = [];
    // Sentences already quoted by a matter record: not quoted again (the rest of their paragraph still may be).
    const quoted = new Set();
    const summarised = new Set();
    const usedUrls = new Set();

    // 1. Who the article says this is
    const lead = sections.find((s) => !s.heading);
    const leadSentences = (lead?.paragraphs || []).flatMap(sentencesIn).filter(quotable);
    if (leadSentences.length) {
      const said = fitSentences(leadSentences.slice(0, 4));
      const quote = said.join(' ');
      findings.push(build({ category: 'identity', title: `${title}${description ? `: ${description}` : ''} (Wikipedia article)`, quote, url: articleUrl, severity: severityFromText(quote), data: { wikidataId: doc.pageprops?.wikibase_item || null } }));
      for (const x of said) summarised.add(x);
    }

    // 2. Each paragraph that reports a legal, regulatory or controversy matter
    const matters = [];
    sections.forEach((s, si) => {
      if (WP_PRIVATE_SECTION.test(s.heading) || WP_PRIVATE_SECTION.test(s.top)) return;
      s.paragraphs.forEach((p, pi) => {
        // the opening paragraph is the identity summary: a matter it reports beyond what the summary quotes (medium or higher) still gets its own record
        const opening = !s.heading && pi === 0;
        const picked = sentencesIn(p).filter(quotable).filter((x) => (opening ? !summarised.has(x) && SEVERITY_RANK[severityFromText(x)] >= SEVERITY_RANK.medium : severityFromText(x) !== 'info'));
        if (!picked.length) return;
        const said = fitSentences(picked);
        const quote = said.join(' ');
        const severity = severityFromText(quote);
        matters.push({ s, p, said, quote, severity, order: si * 1000 + pi, legal: LEGAL_MATTER.test(quote) });
      });
    });
    matters.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.order - b.order);
    for (const m of matters.slice(0, MAX_LEGAL_FINDINGS)) {
      const first = sentencesIn(m.quote)[0] || m.quote;
      findings.push(build({
        category: m.legal ? 'litigation' : 'press',
        title: `${title} (Wikipedia, ${m.s.heading ? `"${m.s.heading}"` : 'summary'}): ${first.length > 130 ? `${first.slice(0, 129).trimEnd()}…` : first}`,
        quote: m.quote,
        url: distinctUrl(usedUrls, sectionUrl(articleUrl, m.s.heading), m.quote),
        severity: m.severity,
        date: yearOf(m.quote),
        data: { section: m.s.heading || null },
      }));
      for (const x of m.said) quoted.add(x);
    }

    // 3. Education and career statements
    const pick = (list, test) => unique(list.flatMap((s) => s.paragraphs.flatMap(sentencesIn))).filter((x) => !quoted.has(x) && quotable(x) && test(x));
    const eduSections = sections.filter((s) => s.heading && (WP_EARLY_SECTION.test(s.heading) || WP_EARLY_SECTION.test(s.top)) && !WP_CAREER_SECTION.test(s.heading)
      && !WP_PRIVATE_SECTION.test(s.heading) && !WP_PRIVATE_SECTION.test(s.top));
    const eduSource = eduSections.length ? eduSections : (lead ? [lead] : []);
    const eduSentences = pick(eduSource, (x) => EDUCATION_WORDS.test(x));
    if (eduSentences.length) {
      const heading = eduSections[0]?.heading || '';
      findings.push(build({ category: 'education', title: `${title}: education as described on Wikipedia${heading ? ` ("${heading}")` : ''}`, quote: fitQuote(eduSentences), url: sectionUrl(articleUrl, heading), data: { section: heading || null } }));
    }
    const careerUrls = new Set();
    const careerQuoted = new Set();
    const careerTops = unique(sections.filter((s) => s.heading && WP_CAREER_SECTION.test(s.top) && !WP_PRIVATE_SECTION.test(s.top)).map((s) => s.top)).slice(0, 4);
    for (const top of careerTops) {
      const group = sections.filter((s) => s.top === top && !WP_PRIVATE_SECTION.test(s.heading));
      const sentences = pick(group, careerSentence);
      if (!sentences.length) continue;
      const said = fitSentences(sentences);
      for (const x of said) careerQuoted.add(x);
      const quote = said.join(' ');
      const url = distinctUrl(careerUrls, sectionUrl(articleUrl, top), quote);
      findings.push(build({ category: 'career', title: `${title}: career as described on Wikipedia ("${top}")`, quote, url, severity: severityFromText(quote), data: { section: top } }));
    }
    if (!careerTops.length && leadSentences.length > 4) {
      const said = fitSentences(leadSentences.slice(4).filter((x) => !quoted.has(x) && careerSentence(x)));
      for (const x of said) careerQuoted.add(x);
      if (said.length) findings.push(build({ category: 'career', title: `${title}: career as described on Wikipedia`, quote: said.join(' '), url: distinctUrl(careerUrls, articleUrl, said.join(' ')) }));
    }
    // Military or national service reported outside the career sections (often under early life)
    const serviceSections = sections.filter((s) => s.heading && !WP_PRIVATE_SECTION.test(s.heading) && !WP_PRIVATE_SECTION.test(s.top));
    const service = pick(serviceSections, (x) => SERVICE_WORDS.test(x) && !careerQuoted.has(x));
    if (service.length) {
      const where = serviceSections.find((s) => s.paragraphs.some((p) => sentencesIn(p).includes(service[0])));
      const quote = fitQuote(service);
      findings.push(build({ category: 'career', title: `${title}: military or national service as described on Wikipedia`, quote, url: distinctUrl(careerUrls, sectionUrl(articleUrl, where?.heading || ''), quote), data: { section: where?.heading || null } }));
    }

    // 4. Threads: companies, schools, associates, and relatives the article gives a public role
    const threads = [];
    const seen = new Set();
    const take = (t) => {
      if (!t || t.kind === 'url' || t.kind === 'handle') return;
      const key = `${t.kind}|${t.value.toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); threads.push(t); }
    };
    for (const s of sections.slice(0, 24)) {
      const text = withFullName(subject, s.paragraphs.join(' ').slice(0, 9000));
      if (WP_PRIVATE_SECTION.test(s.heading) || WP_PRIVATE_SECTION.test(s.top)) {
        // private-life sections are read for one thing only: a relative the same sentence places in a public role
        for (const r of relativesFromText(subject, text)) take(makeThread('relative', r.name, `${r.relation}; ${r.role} (Wikipedia)`, { trusted, relation: r.relation, role: r.role }));
        continue;
      }
      for (const t of threadsFromResult(subject, { title, snippet: withPronouns(subject, text), url: articleUrl }, { trusted })) take(t);
      for (const a of associatesFromText(subject, text)) take(makeThread('associate', a.name, `${a.why} (Wikipedia)`, { trusted }));
    }
    const cap = { company: 10, school: 5, associate: 8, relative: 6 };
    const count = {};
    const kept = threads.filter((t) => { count[t.kind] = (count[t.kind] || 0) + 1; return count[t.kind] <= (cap[t.kind] ?? 4); });

    return { findings: findings.filter(Boolean), threads: kept, notes: [] };
  },
};

/* ------------------------------------------------------------------ *
 * LittleSis
 * ------------------------------------------------------------------ */

const LS_ID = 'littlesis';
const LS_LABEL = 'LittleSis (public relationship database)';
const LS_API = 'https://littlesis.org/api';
const LS_SITE = 'https://littlesis.org';
/**
 * Relationship categories kept. 5 (political donations) is dropped unread,
 * as are 6 (transactions), 7 (lobbying), 8 (social ties), 11 and 12.
 */
const LS_POSITION = 1;
const LS_EDUCATION = 2;
const LS_MEMBERSHIP = 3;
const LS_FAMILY = 4;
const LS_PROFESSIONAL = 9;
const LS_OWNERSHIP = 10;
/** A professional tie that is a business one (a podcast appearance or a friendship is not). */
const LS_BUSINESS_TIE = /\b(partner|co-?founder|cofounder|investor|advis\w*|collaborator|colleague|business|board|director|executive)\b/i;
const LS_KEPT = new Set([LS_POSITION, LS_EDUCATION, LS_MEMBERSHIP, LS_FAMILY, LS_PROFESSIONAL, LS_OWNERSHIP]);
/**
 * Political money in any category: a "Fundraiser Collaborator" tie, a
 * bundler, a donor, a contribution, a role on a campaign committee or a
 * political action committee. Dropped unread, whatever category it is filed under.
 */
const LS_POLITICAL_MONEY = /\b(fund-?rais\w*|bundl(?:er|ers|ed|ing)|donors?|donat\w*|contributions?|campaign (?:committee|finance|contributor)|political action committee|super ?PACs?)\b/i;
const LS_POLITICAL_COMMITTEE = /\b(political action committee|victory fund|leadership fund|(?:campaign|(?:re-?)?election|exploratory) committee|for (?:president|senate|congress|governor|mayor)|(?:democratic|republican) national committee)\b/i;
/** "PAC" only in capitals: "Pac-12" is a sports conference. */
const LS_PAC = /\b(?:Super ?)?PACs?\b/;
const lsPoliticalMoney = (r) => {
  const tie = `${r.description} ${r.mine} ${r.theirs}`;
  const other = r.other?.name || '';
  return LS_POLITICAL_MONEY.test(tie) || LS_PAC.test(tie) || LS_POLITICAL_COMMITTEE.test(other) || LS_PAC.test(other);
};
const LS_PUBLIC_TYPES = /\b(Business Person|Political Candidate|Elected Representative|Public Official|Lobbyist|Philanthropist)\b/i;
const LS_PUBLIC_BLURB = /\b(founder|co-?founder|CEO|CFO|COO|chief|chair\w*|president|director|board|trustee|partner at|managing partner|general partner|investor|owner|heir\w* to|executive|officer|politician|senator|congress\w*|representative|governor|mayor|minister|ambassador|judge|secretary|official|philanthropist|foundation|businessman|businesswoman|entrepreneur|financier|banker|developer|magnate|candidate)\b/i;

/** LittleSis answers a few calls with a JSON body; anything else is a failure. */
async function lsJson(path, ctx) {
  const json = await getJson(`${LS_API}${path}`, { deadline: ctx.deadline });
  if (!json || !Array.isArray(json.data)) throw new Error('LittleSis returned an answer that could not be read');
  return json.data;
}

/** "https://littlesis.org/person/438160-Christian_Holmes" -> { id: 438160, name: 'Christian Holmes', kind: 'person', url } */
export function parseLittleSisLink(link) {
  const m = String(link || '').match(/littlesis\.org\/(person|org|entities)\/(\d+)-([^/?#]+)/);
  if (!m) return null;
  let name = m[3];
  try { name = decodeURIComponent(name); } catch { /* keep */ }
  return { id: Number(m[2]), name: clean(name.replace(/_/g, ' ')), kind: m[1], url: `${LS_SITE}/${m[1]}/${m[2]}-${m[3]}` };
}

/** "2009-00-00" -> "2009"; "2014-05-00" -> "2014-05". */
const lsDate = (value) => {
  const m = String(value || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m || m[1] === '0000') return '';
  if (!m[2] || m[2] === '00') return m[1];
  if (!m[3] || m[3] === '00') return `${m[1]}-${m[2]}`;
  return `${m[1]}-${m[2]}-${m[3]}`;
};
const lsSpan = (a) => {
  const from = lsDate(a.start_date);
  const to = lsDate(a.end_date);
  if (from && to) return from === to ? from : `${from} to ${to}`;
  if (from) return a.is_current === false ? `from ${from}, ended` : `from ${from}`;
  if (to) return `until ${to}`;
  return a.is_current === false ? 'past' : '';
};

/** Each relationship row as { id, category, other, subjectIsFirst, ... } seen from the given entity. */
function lsRelationships(rows, entityId) {
  return rows.map((r) => {
    const a = r?.attributes || {};
    const first = parseLittleSisLink(r?.entity);
    const second = parseLittleSisLink(r?.related);
    const subjectIsFirst = Number(a.entity1_id) === Number(entityId);
    const other = subjectIsFirst ? second : first;
    return {
      id: Number(r?.id || a.id),
      category: Number(a.category_id),
      description: clean(a.description),
      mine: clean(subjectIsFirst ? a.description1 : a.description2),
      theirs: clean(subjectIsFirst ? a.description2 : a.description1),
      attrs: a,
      other,
      url: r?.self || `${LS_SITE}/relationships/${r?.id || a.id}`,
    };
  }).filter((r) => r.other && LS_KEPT.has(r.category) && !lsPoliticalMoney(r));
}

const lsCandidate = (e) => {
  const a = e?.attributes || {};
  return {
    id: Number(e?.id || a.id),
    name: clean(a.name),
    blurb: safe(noBirth(a.blurb)),
    summary: String(a.summary || '').slice(0, 4000),
    aliases: Array.isArray(a.aliases) ? a.aliases.map(clean) : [],
    types: Array.isArray(a.types) ? a.types.map(clean) : [],
    person: a.primary_ext === 'Person',
    url: parseLittleSisLink(e?.links?.self)?.url || `${LS_SITE}/entities/${e?.id}`,
    birth: Number(String(a.start_date || '').slice(0, 4)) || null,
  };
};

function lsScore(subject, c, rels) {
  const text = [c.blurb, c.summary, ...(rels || []).map((r) => `${r.other.name} ${r.description}`)].join(' | ');
  let score = 0;
  for (const a of subject.anchors.companies.values()) if (a.test(text)) score += 4;
  for (const a of subject.anchors.schools.values()) if (a.test(text)) score += 2;
  for (const a of subject.anchors.people.values()) if (a.test(text)) score += 1;
  return score;
}

/** Find the subject's entry: name first, then their companies in the entry or its relationships. */
async function lsResolve(subject, ctx) {
  const hits = (await lsJson(`/entities/search?q=${encodeURIComponent(subject.name)}`, ctx)).map(lsCandidate);
  const named = hits.filter((c) => c.person && c.id && (sameName(subject, c.name) || c.aliases.some((x) => sameName(subject, x))));
  if (!named.length) return { status: 'none' };
  const hints = [...subject.anchors.companies.values(), ...subject.anchors.schools.values()].map((a) => a.value);
  // The relationships of the two most likely entries are read anyway: they are what the findings come from, and they settle which entry is the subject.
  const looked = named.slice(0, 2);
  // One after another: the site asks for ten seconds between requests, so asking at once gains nothing
  const rels = [];
  for (const c of looked) rels.push(lsRelationships(await lsJson(`/entities/${c.id}/relationships`, ctx), c.id));
  const ranked = looked.map((c, i) => ({ c, rels: rels[i], score: lsScore(subject, c, rels[i]) })).sort((a, b) => b.score - a.score);
  const [top, second] = ranked;
  const others = named.length > looked.length;
  const what = ranked.map((r) => r.c.blurb || 'no description').join('; ');
  if (top.score >= 2 && (!second || top.score - second.score >= 2)) return { status: 'resolved', by: 'context', entity: top.c, rels: top.rels };
  if (top.score >= 2) return { status: 'unclear', note: `LittleSis lists more than one ${subject.name} tied to ${hints.slice(0, 2).join(' or ')} (${what}). None was used, because the right one could not be told apart.` };
  if (hints.length) return { status: 'unclear', note: `LittleSis lists ${named.length === 1 ? 'one person' : `${named.length} people`} named ${subject.name} (${what}), but nothing in ${named.length === 1 ? 'that entry' : 'those entries'} mentions ${hints.slice(0, 2).join(' or ')}. None was used.` };
  if (named.length === 1 && !others) return { status: 'resolved', by: 'name', entity: top.c, rels: top.rels };
  return { status: 'unclear', note: `LittleSis lists ${named.length} people named ${subject.name} (${what}). None was used: add the company so the right one can be picked.` };
}

const LS_SPOUSE = /\b(wife|husband|spouse|ex-wife|ex-husband|former (?:wife|husband|spouse))\b/i;
const LS_PARTNER = /\b(partner|boyfriend|girlfriend|fianc[ée]e?|companion)\b/i;
const LS_CHILD = /\b(son|daughter|child|stepson|stepdaughter|stepchild)\b/i;
const LS_PARENT = /\b(father|mother|parent|stepfather|stepmother)\b/i;
const LS_SIBLING = /\b(brother|sister|sibling|half-brother|half-sister)\b/i;

/** spouse | partner | child | parent | sibling | extended, from the words LittleSis gives the relative. */
const lsKin = (word) => (LS_SPOUSE.test(word) ? 'spouse' : LS_CHILD.test(word) && !/grand|in-law/i.test(word) ? 'child' : LS_PARTNER.test(word) ? 'partner' : LS_PARENT.test(word) && !/grand|in-law/i.test(word) ? 'parent' : LS_SIBLING.test(word) && !/in-law/i.test(word) ? 'sibling' : 'extended');

function lsResult(ctx, entity, rels, family) {
  const { subject } = ctx;
  const person = entity.name;
  const context = `${subject.name}. ${person}: ${entity.blurb}. ${rels.filter((r) => r.category !== LS_FAMILY && r.category !== LS_PROFESSIONAL).map((r) => r.other.name).join('; ')}.`;
  const findings = [];
  const threads = [];
  const push = (f) => { const made = makeFinding(subject, { source: LS_ID, sourceLabel: LS_LABEL, severity: 'info', ...f, matchText: `${context} ${f.title} ${f.quote || ''}` }); if (made) findings.push(made); return made; };

  const identity = push({ category: 'identity', title: `${person}: ${entity.blurb || 'LittleSis entry'}`, quote: `${person}: ${entity.blurb || 'no description'}. Types: ${entity.types.join(', ')}`, url: entity.url, data: { littleSisId: entity.id } });
  const trusted = Boolean(identity) && identity.match !== 'possible' && entity.by === 'context';

  // Positions, board seats, ownership, membership, education
  const myOrgs = new Set();
  for (const r of rels.filter((x) => [LS_POSITION, LS_OWNERSHIP, LS_MEMBERSHIP, LS_EDUCATION].includes(x.category)).slice(0, 24)) {
    const when = lsSpan(r.attrs);
    const org = r.other.name;
    myOrgs.add(org.toLowerCase());
    const board = r.attrs?.category_attributes?.is_board === true;
    const what = r.category === LS_POSITION ? (r.mine || r.theirs || (board ? 'board member' : 'position'))
      : r.category === LS_OWNERSHIP ? 'shareholder' // an ownership tie is a stake (often an investment), not running the company
      : r.category === LS_MEMBERSHIP ? (r.mine ? `member (${r.mine})` : 'member')
      : (r.mine || 'student');
    const made = push({
      category: r.category === LS_EDUCATION ? 'education' : 'career',
      title: r.category === LS_EDUCATION ? `${person}: student at ${org}${r.mine ? `, ${r.mine}` : ''}${inBrackets(when)}` : `${person}: ${what}${board && !/board/i.test(what) ? ' (board)' : ''} ${r.category === LS_POSITION ? 'at' : 'of'} ${org}${inBrackets(when)}`,
      quote: r.description + (r.mine ? `. ${r.mine}` : ''),
      url: r.url,
      date: findingDate(lsDate(r.attrs.start_date)),
      data: { organisation: org, relationshipId: r.id },
    });
    if (!made) continue;
    if (r.category === LS_EDUCATION) {
      if (!SECONDARY_SCHOOL.test(org)) threads.push(makeThread('school', org, `student${inBrackets(when)} (LittleSis)`, { trusted }));
    } else if (r.other.kind !== 'person' && r.category !== LS_MEMBERSHIP && threads.filter((t) => t?.kind === 'company').length < 10) {
      threads.push(makeThread('company', org, `${what}${inBrackets(when)} (LittleSis)`, { trusted }));
    }
  }

  // Business partners named by the database: associates, never checked on their own
  for (const r of rels.filter((x) => x.category === LS_PROFESSIONAL && x.other.kind === 'person' && LS_BUSINESS_TIE.test(`${x.mine} ${x.theirs}`)).slice(0, 6)) {
    threads.push(makeThread('associate', r.other.name, `${r.mine || 'professional relationship'} (LittleSis)`, { trusted }));
  }

  // Family: only once the entry is tied to the subject by more than a name
  const notes = [];
  if (entity.by === 'name') {
    notes.push(`LittleSis has one person named ${subject.name} (${entity.blurb || 'no description'}). No company was given to confirm it is the same person, so its records are shown as possible matches only and family ties were not read.`);
  } else {
    const relatives = new Map(family.map((e) => [Number(e?.id), lsCandidate(e)]));
    for (const r of rels.filter((x) => x.category === LS_FAMILY).slice(0, 12)) {
      const rel = relatives.get(r.other.id) || { name: r.other.name, blurb: '', types: [], birth: null, url: r.other.url };
      const word = r.theirs || 'relative';
      const kin = lsKin(word);
      if (rel.birth && isMinorByYear(rel.birth)) continue;
      if (kin === 'child' && !rel.birth) continue; // a child of unknown age is never shown
      const blurb = rel.blurb;
      const ownCompanies = [...subject.anchors.companies.values()].some((a) => a.test(blurb)) || [...myOrgs].some((o) => o.length > 3 && mentions(blurb, o));
      const publicRole = LS_PUBLIC_TYPES.test(rel.types.join(' ')) || LS_PUBLIC_BLURB.test(blurb);
      let show = Boolean(blurb) && publicRole;
      if (kin === 'partner') show = Boolean(blurb) && ownCompanies; // an unmarried partner only with a role in the subject's organisations
      if (!show) continue;
      const relationLabel = kin === 'child' ? `Adult child (${word})` : capitalise(word);
      const made = push({
        category: 'related',
        title: `${relationLabel}: ${rel.name}, ${blurb}`,
        quote: `${r.description}. ${rel.name}: ${word}. ${rel.name}: ${blurb}`,
        url: rel.url,
        data: { person: rel.name, relation: word, role: blurb },
      });
      if (made) threads.push(makeThread('relative', rel.name, `${word}; ${blurb} (LittleSis)`, { relation: word, role: blurb, trusted: made.match !== 'possible' }));
    }
  }
  const seen = new Set();
  return { findings, threads: threads.filter((t) => t && !seen.has(`${t.kind}|${t.value.toLowerCase()}`) && seen.add(`${t.kind}|${t.value.toLowerCase()}`)), notes };
}

/** The company's own entry: the person's roles there, read from the company's side. */
async function lsCompany(task, ctx) {
  const { subject } = ctx;
  const company = clean(task.value);
  const orgs = (await lsJson(`/entities/search?q=${encodeURIComponent(company)}`, ctx)).map(lsCandidate)
    .filter((c) => !c.person && c.id && [c.name, ...c.aliases].some((n) => mentions(n, company) || mentions(company, n)));
  if (!orgs.length) return { findings: [], threads: [], notes: [] };
  const org = orgs.find((c) => [c.name, ...c.aliases].some((n) => n.toLowerCase() === company.toLowerCase())) || orgs[0];
  const rels = lsRelationships(await lsJson(`/entities/${org.id}/relationships`, ctx), org.id)
    .filter((r) => r.other.kind !== 'org' && sameName(subject, r.other.name) && [LS_POSITION, LS_OWNERSHIP, LS_MEMBERSHIP].includes(r.category));
  const findings = [];
  for (const r of rels.slice(0, 6)) {
    const when = lsSpan(r.attrs);
    const what = r.category === LS_POSITION ? (r.theirs || 'position') : r.category === LS_OWNERSHIP ? 'shareholder' : 'member';
    const made = makeFinding(subject, {
      source: LS_ID, sourceLabel: LS_LABEL, category: 'career', severity: 'info',
      title: `${r.other.name}: ${what} at ${org.name}${inBrackets(when)}`,
      quote: r.description + (r.theirs ? `. ${r.theirs}` : ''),
      url: r.url,
      date: findingDate(lsDate(r.attrs.start_date)),
      matchText: `${r.other.name} ${what} at ${org.name} (${company}). ${r.description}`,
      data: { organisation: org.name, relationshipId: r.id },
    });
    if (made) findings.push(made);
  }
  return { findings, threads: [], notes: [] };
}

export const littleSisConnector = {
  id: LS_ID,
  label: LS_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.45,
  timeoutMs: 36000,
  /** subject: search, relationships of at most two entries, family; company: search, relationships. At most four requests. */
  async run(task, ctx) {
    if (task.kind === 'company') return lsCompany(task, ctx);
    if (task.kind !== 'subject') return { findings: [], threads: [], notes: [] };
    const found = await lsResolve(ctx.subject, ctx);
    if (found.status !== 'resolved') return { findings: [], threads: [], notes: found.note ? [found.note] : [] };
    const entity = { ...found.entity, by: found.by };
    const hasFamily = found.rels.some((r) => r.category === LS_FAMILY);
    const family = hasFamily && found.by === 'context' ? await lsJson(`/entities/${entity.id}/connections?category_id=${LS_FAMILY}`, ctx) : [];
    return lsResult(ctx, entity, found.rels, family);
  },
};

/* ------------------------------------------------------------------ *
 * US nonprofit filings (Form 990)
 * ------------------------------------------------------------------ */

const NP_ID = 'nonprofit-filings';
const NP_LABEL = 'US nonprofit filings (Form 990)';
const NP_SITE = 'https://projects.propublica.org/nonprofits';
const NP_XML = 'https://gt990datalake-rawdata.s3.amazonaws.com/EfileData/XmlFiles';
const MAX_FILINGS_READ = 2;
/** Name-only listings at more organisations than this are taken to be several people. */
const MAX_NAME_ONLY_ORGS = 3;

const xmlValue = (block, tag) => clean((String(block).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1]).replace(/&amp;/g, '&');

/** Officers, directors and trustees of a filing: names and titles only (no addresses, no contributors). */
export function parse990(xml) {
  const doc = String(xml || '');
  if (!/<Return\b/.test(doc)) throw new Error('The Form 990 filing could not be read');
  const officers = [];
  for (const tag of ['Form990PartVIISectionAGrp', 'OfficerDirTrstKeyEmplGrp', 'OfficerDirectorTrusteeEmplGrp', 'OfficerDirectorTrusteeKeyEmplGrp']) {
    for (const m of doc.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))) {
      const name = xmlValue(m[1], 'PersonNm');
      if (name) officers.push({ name, title: xmlValue(m[1], 'TitleTxt') });
    }
  }
  return {
    officers,
    period: xmlValue(doc, 'TaxPeriodEndDt'),
    form: xmlValue(doc, 'ReturnTypeCd'),
    familyTies: xmlValue(doc, 'FamilyOrBusinessRlnInd'),
  };
}

const titleCase = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
const NP_FOUNDATION = /\b(foundation|fund|trust|institute|charitable)\b/i;

/** The organisation search of the filings site; it answers 404 when nothing matches. */
async function npSearch(q, ctx) {
  let json;
  try {
    json = await getJson(`${NP_SITE}/api/v2/search.json?q=${encodeURIComponent(q)}`, { deadline: ctx.deadline });
  } catch (error) {
    if (error?.status === 404) return [];
    throw error;
  }
  if (!json || !Array.isArray(json.organizations)) throw new Error('The nonprofit filings search returned an answer that could not be read');
  return json.organizations;
}

/** An organisation's latest filing: { filing, objectId }, or null when it has no record or no readable filing. */
async function npLatestFiling(org, ctx) {
  let detail = null;
  try {
    detail = await getJson(`${NP_SITE}/api/v2/organizations/${org.ein}.json`, { deadline: ctx.deadline });
  } catch (error) {
    if (error?.status === 404) return null; // listed by the search, but no record of its own
    throw error;
  }
  const objectId = detail?.organization?.latest_object_id;
  const filing = objectId ? await readFiling(objectId, ctx) : null;
  return filing ? { filing, objectId } : null;
}

/** The subject's own lines in a filing, as rows for nonprofitResult. */
function npRows(subject, org, { filing, objectId }) {
  const year = (filing.period || '').slice(0, 4);
  return filing.officers.filter((x) => sameName(subject, x.name))
    .map((x) => ({ name: titleCase(x.name), role: titleCase(x.title), ein: String(org.ein), org: clean(org.name), year, objectId }));
}

async function readFiling(objectId, ctx) {
  try {
    return parse990(await getText(`${NP_XML}/${objectId}_public.xml`, { deadline: ctx.deadline, accept: 'application/xml' }));
  } catch {
    return null; // a filing not yet in the data lake (it lags) is no failure of the search itself
  }
}

/** Findings for the organisations where the subject is listed, from the people search rows and (where read) the filing itself. */
function nonprofitResult(ctx, rows, filings, { companyOnly = '' } = {}) {
  const { subject } = ctx;
  const findings = [];
  const threads = [];
  const notes = [];
  const surname = surnameOf(subject.name);
  const byOrg = new Map();
  for (const r of rows) {
    const o = byOrg.get(r.ein) || { ein: r.ein, org: r.org, rows: [] };
    o.rows.push(r);
    byOrg.set(r.ein, o);
  }
  for (const o of [...byOrg.values()].slice(0, 10)) {
    const years = unique(o.rows.map((r) => r.year)).sort();
    const latest = o.rows.slice().sort((a, b) => b.year.localeCompare(a.year))[0];
    const roles = unique(o.rows.map((r) => r.role)).slice(0, 3);
    const when = years.length > 1 ? `${years[0]} to ${years[years.length - 1]} filings` : years[0] ? `${years[0]} filing` : '';
    const filing = filings.get(o.ein);
    const listed = filing?.officers.filter((x) => sameName(subject, x.name)) || [];
    // A surname in the organisation's name is not a family tie ("Robert Wood Johnson Foundation" for a John Johnson).
    // It is one only when the filing marks family or business ties among its officers AND another officer shares the surname.
    const orgSharesSurname = surname.length >= 3 && new RegExp(`\\b${escapeRe(surname)}\\b`, 'i').test(o.org);
    const kinOnBoard = (filing?.officers || []).some((x) => sharesSurname(subject, x.name));
    const family = orgSharesSurname && /^(1|true)$/i.test(filing?.familyTies || '') && kinOnBoard;
    const quote = [
      `${latest.name}: ${roles.join('; ')} at ${o.org}${years.length ? ` (filings for ${years.join(', ')})` : ''}`,
      ...listed.slice(0, 2).map((x) => `Form ${filing.form || '990'}${filing.period ? ` for the period ending ${filing.period}` : ''} lists ${x.name}, ${x.title}`),
    ].join('. ');
    const made = makeFinding(subject, {
      source: NP_ID, sourceLabel: NP_LABEL,
      category: family ? 'related' : 'career',
      severity: family ? 'low' : 'info',
      title: family ? `Family foundation: ${titleCase(subject.name)} listed as ${roles.join(', ').toLowerCase()} of ${o.org}${inBrackets(when)}` : `${latest.name}: ${roles.join(', ').toLowerCase()} of ${o.org}, a US nonprofit${inBrackets(when)}`,
      quote,
      url: `${NP_SITE}/organizations/${o.ein}`,
      date: years.length ? years[years.length - 1] : null,
      matchText: `${latest.name} ${roles.join(' ')} ${o.org}`,
      data: { organisation: o.org, ein: o.ein, roles, years, ...(orgSharesSurname ? { orgSharesSurname: true } : {}), ...(filing?.familyTies ? { familyOrBusinessTiesAmongOfficers: /^(1|true)$/i.test(filing.familyTies) } : {}) },
    });
    if (!made) continue;
    findings.push(made);
    threads.push(makeThread('company', o.org, `${roles[0] || 'officer'} (Form 990)`, { trusted: made.match !== 'possible' }));
    // Officers who share the subject's surname are not relatives on this evidence alone
    const namesakes = unique((filing?.officers || []).filter((x) => sharesSurname(subject, x.name)).map((x) => `${titleCase(x.name)} (${titleCase(x.title)})`));
    if (namesakes.length) notes.push(`${o.org}: ${namesakes.slice(0, 4).join('; ')} ${namesakes.length === 1 ? 'shares' : 'share'} a surname with the subject: unconfirmed. Not treated as ${namesakes.length === 1 ? 'a relative' : 'relatives'} unless another source states the family tie.`);
  }
  if (companyOnly && !findings.length) return { findings: [], threads: [], notes: [] };
  // The same name on the boards of many unrelated organisations is several people: without anything tying one of them to the subject, none is shown.
  const tied = findings.filter((f) => f.match !== 'possible');
  if (!tied.length && byOrg.size > MAX_NAME_ONLY_ORGS) {
    return { findings: [], threads: [], notes: [`US nonprofit filings list ${byOrg.size} organisations with an officer or director named ${titleCase(subject.name)} (${[...byOrg.values()].slice(0, 4).map((o) => o.org).join('; ')}${byOrg.size > 4 ? '; ...' : ''}). Nothing in them ties any to the subject${subject.company ? ` or ${subject.company}` : ''}, so they are most likely other people with the same name and none is shown.`] };
  }
  return { findings, threads: threads.filter(Boolean), notes };
}

export const nonprofitFilingsConnector = {
  id: NP_ID,
  label: NP_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.35,
  timeoutMs: 15000,
  /**
   * subject: the organisation search for foundations named after the person
   * or their family, then the record and latest filing of at most two of them
   * (at most five requests), kept only where the filing lists the person.
   * company: the organisation search for the company's own foundation, its
   * record, and its latest filing, kept only when the subject is an officer.
   * The filings site's people search is not used: the site asks automated
   * visitors not to use that page.
   */
  async run(task, ctx) {
    const { subject } = ctx;
    if (task.kind === 'company') {
      const company = clean(task.value);
      const found = await npSearch(`"${company}"`, ctx);
      const org = found.find((o) => mentions(o?.name, company) && NP_FOUNDATION.test(o?.name || ''));
      if (!org) return { findings: [], threads: [], notes: [] };
      const read = await npLatestFiling(org, ctx);
      if (!read) return { findings: [], threads: [], notes: [] };
      const rows = npRows(subject, org, read);
      if (!rows.length) return { findings: [], threads: [], notes: [] };
      return nonprofitResult(ctx, rows, new Map([[String(org.ein), read.filing]]), { companyOnly: company });
    }
    if (task.kind !== 'subject') return { findings: [], threads: [], notes: [] };
    const surname = surnameOf(subject.name);
    const first = bareTokens(subject.name)[0] || '';
    if (surname.length < 3) return { findings: [], threads: [], notes: [] };
    const named = (await npSearch(`"${surname}" foundation`, ctx))
      .filter((o) => o?.ein && NP_FOUNDATION.test(o?.name || '') && new RegExp(`\\b${escapeRe(surname)}\\b`, 'i').test(o.name));
    // the person's own foundation first ("Jane and John Roe Foundation"), then the family's
    const ranked = named.map((o, i) => ({ o, i, own: first.length > 1 && new RegExp(`\\b${escapeRe(first)}\\b`, 'i').test(o.name) ? 0 : 1 }))
      .sort((a, b) => a.own - b.own || a.i - b.i).map((x) => x.o);
    const toRead = ranked.slice(0, MAX_FILINGS_READ);
    const read = await mapLimit(toRead, 2, (o) => npLatestFiling(o, ctx).catch(() => null));
    const rows = [];
    const filings = new Map();
    toRead.forEach((o, i) => {
      if (!read[i]) return;
      const mine = npRows(subject, o, read[i]);
      if (!mine.length) return;
      rows.push(...mine);
      filings.set(String(o.ein), read[i].filing);
    });
    if (!rows.length) return { findings: [], threads: [], notes: [] };
    return nonprofitResult(ctx, rows, filings);
  },
};
