/**
 * Two more academic records, each its own source so each is reported
 * (answered, failed, not run) on its own:
 *
 *   datacite-theses   theses and dissertations that university repositories
 *                     register with DataCite (Warwick, Lincoln, ETH Zurich and
 *                     many other European and US repositories). A thesis in a
 *                     repository is independent proof of a degree: the school
 *                     that granted it, the kind of degree where the record
 *                     says, and the year. It complements Crossref and
 *                     theses.fr, which the academic-record source searches.
 *   nsf-awards        US National Science Foundation awards on which the
 *                     person is the principal investigator: the institution
 *                     or startup that received it (SBIR, STTR and I-Corps
 *                     awards name the company), the program, the amount and
 *                     the dates. A dated role the government itself records.
 *                     A company lookup lists the NSF awards to the company.
 *
 * Matching. A record is kept only when the name the source gives as its own
 * field (the thesis author, the investigator) is the person's full name. That
 * alone stays 'possible', with a reason that asks to verify identity. A record
 * is raised to 'likely', never further, only when it carries a second fact
 * that is the person's: the school or company it names is one already known
 * for them, or the thesis carries an ORCID that an earlier tied record gave
 * them. As in the academic-record source, when several people share the name
 * and the only tie is one school, the record stays 'possible' (a namesake may
 * have studied there too). The grade is set here and is final: the check's
 * later re-reading must not lift a record to 'confirmed' on a company name.
 *
 * Privacy. The NSF answer always carries e-mail addresses, phone numbers and
 * street addresses (the service ignores requests to leave them out); none of
 * them is read into a record or into the cache, and the e-mail address inside
 * each co-investigator entry is cut off. Abstracts are never kept. A thesis
 * record keeps its title, author, school, year, degree, supervisors and link;
 * its description and subjects are never requested. A title the privacy rules
 * would reject (a health topic) is left out of the record.
 *
 * Absence proves nothing: most universities do not register theses with
 * DataCite, and most founders never held an NSF award. The notes say so.
 */
import { getJson, HttpError } from '../http';
import { cached } from '../cache';
import { makeFinding, makeThread } from '../finding';
import { nameTokens } from '../identity';
import { isSensitive, mentionsMinor } from '../guardrails';
import { person, sameName, sameCompany } from './courts';
import { personNameFits, sameSchool } from './scholar';
import { companyGrade } from './government';

/* ------------------------------------------------------------------ helpers */

const DAY_MS = 24 * 60 * 60 * 1000;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const uniq = (list) => [...new Set(list.filter(Boolean))];
const count = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${count(n)} ${Number(n) === 1 ? one : many}`;
const money = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' && Number(n) > 0 ? `$${Math.round(Number(n)).toLocaleString('en-US')}` : '');
/** Text the privacy rules would reject is left out, so the rest of the record survives. */
const safe = (s) => (isSensitive(s) || mentionsMinor(s) ? '' : clean(s));
/** "TREVOR R MILTON" -> "Trevor R Milton". */
const properCase = (s) => clean(s).toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
/** A search phrase without the characters that would break the query syntax. */
const phrase = (s) => clean(String(s || '').replace(/["\\():^~*?[\]{}!/]/g, ' '));
const isTied = (f) => f && (f.match === 'likely' || f.match === 'confirmed');
const looksLikeSchool = (name) => /univ|[ée]cole|coll[eè]ge|institut|school|polytech|academy|hochschule|politecnic|\b(?:ENS|MIT|ETH|EPFL|UCL|LSE)\b/i.test(name);

/** Records found earlier in this check, when the loop hands them over. */
function earlierFindings(ctx) {
  let list = [];
  try { list = typeof ctx?.findings === 'function' ? ctx.findings() : ctx?.findings; } catch { list = []; }
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

const anchorValues = (subject, kind) => [...(subject?.anchors?.[kind]?.values() || [])].map((a) => a.value).filter(Boolean);

/** The company or school already known for the subject that an institution name is, if any. */
function knownInstitution(subject, institution) {
  const name = clean(institution);
  if (!name) return null;
  const company = anchorValues(subject, 'companies').find((c) => sameCompany(name, c));
  if (company) return { kind: 'company', value: company };
  const school = anchorValues(subject, 'schools').find((s) => sameSchool(name, s));
  if (school) return { kind: 'school', value: school };
  return null;
}

/**
 * The grade of a record whose structured name is the subject's. `ties` are the
 * second facts found in the record (each { kind, value, why }). Never 'confirmed'.
 */
function gradeFor({ listedAs, ties, namesakes, registry, nameOnlyWhy }) {
  const strong = ties.filter((t) => t.kind !== 'school');
  if (strong.length) return { match: 'likely', matchReasons: [`listed as ${listedAs}; ${strong.map((t) => t.why).join('; ')}`] };
  if (ties.length && namesakes < 2) return { match: 'likely', matchReasons: [`listed as ${listedAs}; ${ties.map((t) => t.why).join('; ')}`] };
  if (ties.length) {
    return { match: 'possible', matchReasons: [`listed as ${listedAs}; ${ties[0].why}, but ${namesakes} people in ${registry} have this name and may share that school: verify identity`] };
  }
  return { match: 'possible', matchReasons: [`matched by name only (listed as ${listedAs}); ${nameOnlyWhy}: verify identity before relying on it`] };
}

/* ------------------------------------------------------------------ 1. DataCite theses */

const DC_ID = 'datacite-theses';
const DC_LABEL = 'University thesis repositories (DataCite)';
const DC_SEARCH = 'https://api.datacite.org/dois';
const DC_PAGE = 25;
const DC_FIELDS = 'doi,titles,creators,contributors,publisher,publicationYear,types,url';
const ORCID_RE = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/;

/** The kind of degree a record's own resource type states; "Thesis" when it does not say. */
export function degreeOf(resourceType) {
  const d = clean(resourceType);
  if (/\bph\.?\s?d\b|\bd\.?\s?phil\b|doctor|dissertation|promotion|\bdr\.|doktor/i.test(d)) return { kind: 'Doctoral thesis', degree: 'Doctorate' };
  if (/master|magister|\bm\.?\s?(?:a|s|sc|phil|eng|res|ba)\b|\bmsc\b|\bmba\b/i.test(d)) return { kind: "Master's thesis", degree: "Master's" };
  if (/bachelor|honou?rs|undergraduate|\bb\.?\s?(?:a|s|sc|eng)\b|\bbsc\b/i.test(d)) return { kind: 'Undergraduate thesis', degree: "Bachelor's" };
  return { kind: 'Thesis', degree: '' };
}

const publisherName = (p) => clean(typeof p === 'object' && p ? p.name : p);
const creatorName = (c) => clean(c?.givenName && c?.familyName ? `${c.givenName} ${c.familyName}` : c?.name);

/** The DataCite search for theses by authors with the subject's first and last name. */
function dataciteQuery(name) {
  const parts = clean(name).split(' ').map((p) => p.replace(/^[,.]+|[,.]+$/g, '')).filter(Boolean);
  if (parts.length < 2) return '';
  const first = phrase(parts[0]);
  const last = phrase(parts[parts.length - 1]);
  if (!first || !last) return '';
  return `types.resourceTypeGeneral:Dissertation AND ((creators.familyName:"${last}" AND creators.givenName:"${first}") OR creators.name:"${last}, ${first}")`;
}

/** One compact record per thesis: only the fields this source keeps. */
function compactThesis(item) {
  const a = item?.attributes;
  if (!a || typeof a !== 'object') return null;
  const creators = (Array.isArray(a.creators) ? a.creators : []).map((c) => ({
    name: creatorName(c),
    orcid: uniq((c?.nameIdentifiers || []).map((n) => (clean(n?.nameIdentifierScheme).toUpperCase() === 'ORCID' || /orcid/i.test(n?.nameIdentifier || '') ? (String(n?.nameIdentifier || '').match(ORCID_RE) || [])[1] : ''))),
    affiliations: uniq((c?.affiliation || []).map((x) => clean(typeof x === 'object' ? x?.name : x))).slice(0, 3),
  })).filter((c) => c.name);
  const supervisors = (Array.isArray(a.contributors) ? a.contributors : [])
    .filter((c) => /supervisor/i.test(c?.contributorType || ''))
    .map((c) => creatorName(c)).filter(Boolean).slice(0, 2);
  return {
    doi: clean(a.doi || item.id).toLowerCase(),
    title: clean((a.titles || [])[0]?.title),
    creators: creators.slice(0, 4),
    supervisors,
    publisher: publisherName(a.publisher),
    year: /^\d{4}$/.test(String(a.publicationYear || '')) ? String(a.publicationYear) : '',
    resourceType: clean(a.types?.resourceType),
    url: clean(a.url),
  };
}

async function dataciteTheses(name, ctx) {
  const q = dataciteQuery(name);
  if (!q) return { rows: [], total: 0 };
  const url = `${DC_SEARCH}?${new URLSearchParams({ query: q, 'page[size]': String(DC_PAGE), 'fields[dois]': DC_FIELDS })}`;
  return cached(`founder:datacite-theses:v1:${nameTokens(name).join(' ')}`, DAY_MS, async () => {
    const body = await getJson(url, { deadline: ctx.deadline, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 });
    if (!body || !Array.isArray(body.data) || !body.meta || typeof body.meta !== 'object') throw new HttpError('DataCite returned an unexpected answer to a thesis search', { url: DC_SEARCH });
    const rows = body.data.map(compactThesis);
    // Every record of a DataCite answer has attributes and a creator: when they are missing, the format has changed.
    if (body.data.length && rows.filter((r) => r && r.creators.length).length < body.data.length / 2) throw new HttpError('DataCite thesis records no longer carry their authors in the expected form', { url: DC_SEARCH });
    const total = Number(body.meta.total);
    return { rows: rows.filter(Boolean), total: Number.isFinite(total) ? total : rows.length };
  });
}

/** How many people the theses under the name belong to, at least: theses at different schools are different people, and so are different ORCIDs. */
function thesisAuthors(theses) {
  const schools = [];
  for (const t of theses) if (t.publisher && !schools.some((s) => sameSchool(s, t.publisher))) schools.push(t.publisher);
  const orcids = uniq(theses.flatMap((t) => t.author.orcid));
  return Math.max(1, schools.length, orcids.length);
}

/** ORCIDs that earlier records tied to the subject carry. */
const knownOrcids = (ctx) => new Set(earlierFindings(ctx).filter(isTied).map((f) => clean(f.data?.orcid)).filter(Boolean));

export const dataciteThesesConnector = {
  id: DC_ID,
  label: DC_LABEL,
  kinds: ['subject'],
  prior: 0.2,
  timeoutMs: 20000,
  async run(task, ctx) {
    const { subject } = ctx;
    const { rows, total } = await dataciteTheses(subject.name, ctx);
    const theses = [];
    for (const r of rows) {
      const author = r.creators.find((c) => personNameFits(subject, c.name));
      if (author && r.url && (r.title || r.publisher)) theses.push({ ...r, author });
    }
    const cut = total > rows.length;
    const notes = [];
    const partial = cut ? [`University theses (DataCite, first ${rows.length} of ${count(total)} read)`] : [];
    if (cut) notes.push(`DataCite lists ${count(total)} theses for authors named like ${subject.name}; the first ${rows.length} were read.`);
    if (!theses.length) {
      notes.push(`University thesis repositories registered with DataCite hold no thesis by an author named ${subject.name}${cut ? ' among the records read' : ''}. Most universities do not register theses there, so this neither confirms nor contradicts a degree.`);
      return { findings: [], threads: [], notes, ...(partial.length ? { partial } : {}) };
    }
    const namesakes = thesisAuthors(theses);
    const orcids = knownOrcids(ctx);
    const findings = [];
    const threads = [];
    let possible = 0;
    for (const t of theses) {
      const { kind, degree } = degreeOf(t.resourceType);
      const schools = uniq([t.publisher, ...t.author.affiliations]);
      const ties = [];
      for (const s of schools) {
        const known = knownInstitution(subject, s);
        if (known) ties.push({ ...known, why: `${known.kind === 'company' ? 'names' : 'granted by'} ${known.value}, already known for the person` });
      }
      const orcid = t.author.orcid.find((o) => orcids.has(o));
      if (orcid) ties.push({ kind: 'orcid', value: orcid, why: `carries ORCID ${orcid}, which an earlier record tied to the person` });
      const grade = gradeFor({ listedAs: t.author.name, ties: uniq(ties.map((x) => x.value)).map((v) => ties.find((x) => x.value === v)), namesakes, registry: 'the thesis repositories', nameOnlyWhy: 'no school already known for the person granted this thesis' });
      if (grade.match === 'possible' && (possible += 1) > 3) continue; // a few namesakes are enough to show the name is shared
      const topic = safe(t.title);
      const school = t.publisher;
      const where = [school, t.year].filter(Boolean).join(', ');
      const f = makeFinding(subject, {
        source: DC_ID, sourceLabel: DC_LABEL, category: 'education',
        title: `${kind}${topic ? `: ${topic}` : ''}${where ? ` (${where})` : ''}`,
        quote: [t.author.name, topic, t.resourceType && t.resourceType !== kind ? t.resourceType : '', school, t.year, t.supervisors.length ? `Supervised by ${t.supervisors.join(', ')}` : ''].filter(Boolean).join('. '),
        url: t.doi ? `https://doi.org/${t.doi}` : t.url,
        date: t.year || null,
        severity: 'info',
        ...grade,
        data: {
          registry: 'DataCite', kind, degree, school, year: t.year, institution: school, institutions: schools.slice(0, 4),
          ...(t.doi ? { doi: t.doi } : {}), ...(t.author.orcid[0] ? { orcid: t.author.orcid[0] } : {}),
          ...(t.supervisors.length ? { supervisors: t.supervisors } : {}),
        },
      });
      if (!f) continue;
      findings.push(f);
      if (isTied(f) && school && looksLikeSchool(school)) {
        const th = makeThread('school', school, `granted the ${kind.toLowerCase()} registered with DataCite`, { trusted: true });
        if (th) threads.push(th);
      }
    }
    if (namesakes > 1 && !findings.some(isTied)) notes.push(`Theses under the name ${subject.name} come from ${namesakes} different schools, so at least ${namesakes} people share it.`);
    return { findings, threads: uniqThreads(threads), notes, ...(partial.length ? { partial } : {}) };
  },
};

/* ------------------------------------------------------------------ 2. NSF awards */

const NS_ID = 'nsf-awards';
const NS_LABEL = 'US National Science Foundation awards (NSF)';
const NS_SEARCH = 'https://api.nsf.gov/services/v1/awards.json';
const NS_PAGE = 25;
const nsfUrl = (id) => `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${encodeURIComponent(id)}`;

/*
 * The NSF service publishes no request rate; one request a second is the pace
 * the research notes chose. Lookups of one check take turns here, before the
 * shared client's own spacing.
 */
const NSF_GAP_MS = 1100;
let nsfNextAt = 0;
let pacing = true;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function nsfTurn(deadline) {
  if (!pacing) return;
  const now = Date.now();
  const at = Math.max(now, nsfNextAt);
  if (deadline && at + 2000 > deadline) throw new HttpError('Out of time before the NSF request could start', { url: NS_SEARCH, retryable: true });
  nsfNextAt = at + NSF_GAP_MS;
  if (at > now) await sleep(at - now);
}

/** For tests: turn the NSF spacing off (true) or back on (false). */
export function __resetAcademicMoreForTests({ unpaced = true } = {}) {
  pacing = !unpaced;
  nsfNextAt = 0;
}

/** "07/15/2025" -> "2025-07-15". */
const usDate = (s) => {
  const m = String(s || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
};
/** "Harold Park parkhs@bu.edu" -> "Harold Park": the e-mail address is cut off and never kept. */
const withoutEmail = (s) => clean(String(s || '').replace(/\S+@\S+/g, ' '));

/**
 * One compact award: only the fields this source keeps. E-mail addresses,
 * phone numbers, street addresses, ZIP codes, the abstract and the program
 * officer are never read.
 */
function compactAward(a) {
  if (!a || typeof a !== 'object' || !a.id) return null;
  const amount = Number(a.fundsObligatedAmt) || Number(a.estimatedTotalAmt) || 0;
  return {
    id: clean(a.id),
    title: clean(a.title),
    awardee: clean(a.awardeeName),
    state: /^[A-Z]{2}$/.test(clean(a.awardeeStateCode)) ? clean(a.awardeeStateCode) : '',
    pi: clean([a.piFirstName, a.piMiddeInitial, a.piLastName].filter(Boolean).join(' ')) || withoutEmail((a.pi || [])[0]) || clean(a.pdPIName),
    piId: clean(a.piId),
    coPIs: (Array.isArray(a.coPDPI) ? a.coPDPI : []).map(withoutEmail).filter(Boolean).slice(0, 4),
    program: clean(a.fundProgramName),
    type: clean(a.transType),
    directorate: clean(a.dirAbbr),
    start: usDate(a.startDate),
    end: usDate(a.expDate),
    amount,
  };
}

async function nsfAwards(param, value, ctx) {
  const url = `${NS_SEARCH}?${new URLSearchParams({ [param]: value, rpp: String(NS_PAGE) })}`;
  return cached(`founder:nsf-awards:v1:${param}:${nameTokens(value).join(' ')}`, DAY_MS, async () => {
    await nsfTurn(ctx.deadline);
    const body = await getJson(url, { deadline: ctx.deadline, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 });
    const r = body?.response;
    if (!r || !Array.isArray(r.award) || !r.metadata || typeof r.metadata !== 'object') {
      const why = clean(r?.serviceNotification?.[0]?.notificationMessage || '');
      throw new HttpError(`The NSF award search returned an unexpected answer${why ? ` (${why.slice(0, 120)})` : ''}`, { url: NS_SEARCH });
    }
    const rows = r.award.map(compactAward);
    if (r.award.length && rows.filter(Boolean).length < r.award.length / 2) throw new HttpError('NSF award records no longer carry their identifiers in the expected form', { url: NS_SEARCH });
    const total = Number(r.metadata.totalCount);
    return { rows: rows.filter(Boolean), total: Number.isFinite(total) ? total : rows.length };
  });
}

const span = (start, end) => {
  const a = start.slice(0, 4);
  const b = end.slice(0, 4);
  return a && b ? (a === b ? a : `${a}–${b}`) : a || b;
};
const SMALL_BUSINESS = /\b(SBIR|STTR|small business)\b/i;

export const nsfAwardsConnector = {
  id: NS_ID,
  label: NS_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.15,
  timeoutMs: 25000,
  async run(task, ctx) {
    const { subject } = ctx;
    const who = person(subject);
    const findings = [];
    const threads = [];

    if (task.kind === 'company') {
      const company = clean(task.value);
      const { rows, total } = await nsfAwards('awardeeName', company, ctx);
      const cut = total > rows.length ? { partial: [`NSF awards (first ${rows.length} of ${count(total)} read)`] } : {};
      const own = rows.filter((r) => sameCompany(r.awardee, company));
      if (!own.length) {
        return { findings, threads, notes: [`The NSF award search holds no award to an organisation named ${company}${cut.partial ? ' among the records read' : ''}.`], ...cut };
      }
      own.sort((a, b) => (b.start || '').localeCompare(a.start || ''));
      const org = own[0].awardee;
      const states = uniq(own.map((r) => r.state));
      const sum = own.reduce((s, r) => s + r.amount, 0);
      const pis = uniq(own.map((r) => properCase(r.pi)));
      const programs = uniq(own.map((r) => r.program)).slice(0, 4);
      const years = span(own[own.length - 1].start || '', own[0].start || '');
      const lines = own.slice(0, 3).map((r) => [span(r.start, r.end), r.program, r.id, safe(r.title)].filter(Boolean).join(', '));
      const quote = `${org}${states.length ? ` (${states.join(', ')})` : ''}: ${plural(own.length, 'NSF award')}${money(sum) ? `, ${money(sum)} obligated` : ''}${years ? `, ${years}` : ''}`
        + `${pis.length ? `. Principal investigators: ${pis.slice(0, 5).join(', ')}` : ''}. ${lines.join('; ')}`;
      const subjectAs = pis.find((n) => sameName(n, who));
      const known = knownInstitution(subject, org);
      // The person as principal investigator of an award to a company already known for them: two facts, so 'likely'.
      // Their name on an award to a company not yet tied to them is a name match like any other.
      const grade = subjectAs && known
        ? { match: 'likely', matchReasons: [`listed as ${subjectAs}, principal investigator on an NSF award to ${org}, already known for the person`] }
        : subjectAs
          ? { match: 'possible', matchReasons: [`listed as ${subjectAs}, principal investigator on an NSF award to ${org}, which is not yet known for the person: verify identity`] }
          : companyGrade(company, `awardee ${org} is ${company}`);
      const f = makeFinding(subject, {
        source: NS_ID, sourceLabel: NS_LABEL, category: 'corporate',
        title: `${plural(own.length, 'NSF award')} to ${org}${years ? `, ${years}` : ''}`,
        quote, url: nsfUrl(own[0].id), date: own[0].start || null, severity: 'info',
        ...grade,
        data: { awards: own.length, total: sum, states, programs, institution: org, smallBusiness: own.some((r) => SMALL_BUSINESS.test(r.program)) },
      });
      if (f) findings.push(f);
      return { findings, threads, notes: [], ...cut };
    }

    const answers = [];
    const failures = [];
    for (const name of who.queryNames.slice(0, 2)) {
      try { answers.push(await nsfAwards('pdPIName', name, ctx)); } catch (error) { failures.push(error); }
    }
    if (!answers.length) throw failures[0] || new HttpError('The NSF award search did not answer', { url: NS_SEARCH });
    const seen = new Set();
    const rows = answers.flatMap((a) => a.rows).filter((r) => !seen.has(r.id) && seen.add(r.id));
    const total = answers.reduce((s, a) => s + a.total, 0);
    const read = answers.reduce((s, a) => s + a.rows.length, 0);
    const theirs = rows.filter((r) => sameName(r.pi, who)).sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    const namesakes = Math.max(1, uniq(theirs.map((r) => r.piId)).length);
    const notes = [];
    const partial = [];
    if (total > read) {
      partial.push(`NSF awards (first ${read} of ${count(total)} read)`);
      notes.push(`The NSF award search lists ${count(total)} awards for investigators named like ${who.name}; the first ${read} were read.`);
    }
    if (failures.length) {
      partial.push('NSF awards (one name form not searched)');
      notes.push(`The NSF award search answered for ${who.queryNames[0]} but not for ${who.queryNames[1]}, so awards filed under that form of the name were not searched.`);
    }
    if (!theirs.length) {
      notes.push(`The NSF award search holds no award with a principal investigator named ${who.name}${total > read ? ' among the records read' : ''}. Most founders never held one, so this says nothing either way.`);
      return { findings, threads, notes, ...(partial.length ? { partial } : {}) };
    }
    let possible = 0;
    for (const r of theirs) {
      const listedAs = properCase(r.pi);
      const known = knownInstitution(subject, r.awardee);
      const ties = known ? [{ ...known, why: `the award went to ${known.value}, already known for the person` }] : [];
      const grade = gradeFor({ listedAs, ties, namesakes, registry: 'the NSF award search', nameOnlyWhy: 'the institution that received the award is not one already known for the person' });
      if (grade.match === 'possible' && (possible += 1) > 4) continue;
      if (findings.length >= 8) break;
      const topic = safe(r.title);
      const dates = span(r.start, r.end);
      const quote = `${listedAs}, principal investigator, NSF award ${r.id} to ${r.awardee || 'an unnamed awardee'}${r.state ? ` (${r.state})` : ''}`
        + `${r.program ? `, ${r.program}` : ''}${r.type ? `, ${r.type}` : ''}${r.start ? `, ${r.start}${r.end ? ` to ${r.end}` : ''}` : ''}${money(r.amount) ? `, ${money(r.amount)}` : ''}`
        + `${topic ? `: ${topic}` : ''}${r.coPIs.length ? `. Co-investigators: ${r.coPIs.join(', ')}` : ''}.`;
      const f = makeFinding(subject, {
        source: NS_ID, sourceLabel: NS_LABEL, category: 'career',
        title: `NSF award ${r.id}${topic ? `: ${topic}` : ` to ${r.awardee}`}${dates ? ` (${dates})` : ''}`,
        quote, url: nsfUrl(r.id), date: r.start || null, severity: 'info',
        ...grade,
        data: {
          awardId: r.id, institution: r.awardee, role: 'Principal investigator', program: r.program, awardType: r.type,
          amount: r.amount || null, start: r.start, end: r.end, ...(r.state ? { state: r.state } : {}),
          smallBusiness: SMALL_BUSINESS.test(r.program),
        },
      });
      if (!f) continue;
      findings.push(f);
      if (isTied(f) && r.awardee) {
        const th = makeThread(looksLikeSchool(r.awardee) ? 'school' : 'company', r.awardee, `${who.name} is principal investigator on an NSF award there`, { trusted: true });
        if (th) threads.push(th);
      }
    }
    if (namesakes > 1 && !findings.some(isTied)) notes.push(`NSF awards under the name ${who.name} belong to ${namesakes} different investigators, so the name is shared.`);
    return { findings, threads: uniqThreads(threads), notes, ...(partial.length ? { partial } : {}) };
  },
};

const uniqThreads = (threads) => {
  const seen = new Set();
  return threads.filter((t) => {
    const k = `${t.kind}|${String(t.value).toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export const ACADEMIC_MORE_CONNECTORS = [dataciteThesesConnector, nsfAwardsConnector];
