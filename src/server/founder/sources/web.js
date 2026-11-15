/**
 * Open-web and news search for the deep background check.
 *
 * Two sources, both built on the keyless engines in searchEngines.js:
 *
 *   web-search    one search per question about the person ("name" lawsuit,
 *                 "name" resume, their LinkedIn page, ...), about a company
 *                 tied to them, or about them TOGETHER with an associate,
 *                 relative, school or handle. Each question is its own
 *                 query pattern, scored separately by the learning loop.
 *   news-archive  news search by date window, so coverage from years ago
 *                 surfaces and not only this year's.
 *
 * An associate or relative is never searched on their own: every query for
 * them carries the subject's quoted name, and a result that does not name
 * the subject is dropped when it is graded (finding.js).
 */
import { makeFinding, makeThread, severityFromText } from '../finding';
import { threadsFromResult, relativesFromText, profileFromUrl, mentions } from '../extract';
import { nameTokens } from '../identity';
import { keylessSearch, ENGINES } from './searchEngines';

const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };
/** How many records that name only the company (not the person) one lookup may add: the most serious first. */
const COMPANY_ONLY_MAX = { web: 3, news: 4 };

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const phrase = (s) => `"${tidy(String(s || '').replace(/["“”„]/g, ''))}"`;
const any = (...words) => `(${words.join(' OR ')})`;
const hostOf = (url) => { try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return String(s); } };
const onHost = (host, list) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** Lookups whose query pattern has at least this prior may use the metered search services when every keyless engine came back empty. */
export const METERED_PRIOR = 0.7;

const LEGAL_SUFFIX = /[,\s]+(?:inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|plc|llp|lp|gmbh|ag|ug|kg|sas|sasu|sarl|sa|s\.a|s\.l|bv|b\.v|nv|oy|ab|pty|pte|holdings?)\.?$/i;
/** "Theranos, Inc." -> "Theranos": the name people and the press actually use. */
export function shortCompany(name) {
  let s = tidy(name);
  for (let i = 0; i < 2; i += 1) s = s.replace(LEGAL_SUFFIX, '').trim();
  return s || tidy(name);
}

/* ------------------------------------------------------------------ query templates */

const ADVERSE = {
  fr: any('procès', 'fraude', 'escroquerie', 'enquête', 'condamné', '"mis en examen"', 'liquidation'),
  de: any('Klage', 'Betrug', 'Ermittlungen', 'verurteilt', 'Insolvenz', 'Skandal'),
  es: any('demanda', 'fraude', 'estafa', 'investigación', 'condenado', 'quiebra'),
};
const LANGUAGE_LABEL = { fr: 'French', de: 'German', es: 'Spanish' };

const FIRST_NAMES = {
  fr: 'jean pierre françois francois benoît benoit guillaume thibault thibaut timothée timothee antoine mathieu matthieu étienne etienne yann loïc loic cédric cedric aurélien aurelien jérôme jerome rémi remi hervé herve thierry pascal olivier stéphane stephane frédéric frederic ludovic gaël gael maxime clément clement hélène helene amélie amelie céline celine margaux océane'.split(' '),
  de: 'jürgen juergen hans klaus wolfgang matthias günther gunther jörg joerg dieter heinz uwe rainer lutz detlef holger torsten thorsten björn bjoern friedrich ulrich manfred helmut heike ute anke silke'.split(' '),
  es: 'josé jose juan carlos javier pablo diego alejandro santiago jorge luis miguel sergio andrés andres fernando rafael enrique ignacio álvaro alvaro gonzalo joaquín joaquin maría lucía mercedes pilar inés'.split(' '),
};
const LANGUAGE_SIGNS = {
  fr: { letters: /[çèêëàâùûîïôœ]/i, org: /\b(SAS|SASU|SARL|S\.A\.S\.?|S\.A\.R\.L\.?|France|Paris|Lyon|École|Ecole|Université|Sorbonne|HEC|ESSEC|Polytechnique|Sciences Po|INSEAD)\b/, tld: /\.fr$/ },
  de: { letters: /[äöüß]/i, org: /\b(GmbH|mbH|AG|UG|KG|e\.V\.|Deutschland|Berlin|München|Hamburg|Universität|Hochschule|RWTH|WHU)\b/, tld: /\.(de|at)$/ },
  es: { letters: /[ñ¿¡]/i, org: /\b(S\.L\.U?\.?|S\.A\. de C\.V\.|España|Madrid|Barcelona|México|Universidad|IESE|ESADE|Tecnológico)\b/, tld: /\.(es|mx|ar|cl|pe)$/ },
};

/**
 * Languages worth a second, non-English pass, judged from the name, the
 * company and what is already known (schools, domains). A hint, not a fact:
 * at most two languages, and nothing when there is no sign at all.
 * @returns {Array<'fr'|'de'|'es'>}
 */
export function languageHints(subject) {
  const first = String(subject?.name || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  const orgs = [subject?.company, ...[...(subject?.anchors?.companies?.values?.() || [])].map((a) => a.value), ...[...(subject?.anchors?.schools?.values?.() || [])].map((a) => a.value)].filter(Boolean).join(' | ');
  const domains = [...(subject?.anchors?.domains?.values?.() || [])].map((a) => String(a.value).toLowerCase());
  const out = [];
  for (const lang of ['fr', 'de', 'es']) {
    const sign = LANGUAGE_SIGNS[lang];
    const companyAsDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(subject?.company || '').trim()) && sign.tld.test(String(subject.company).trim().toLowerCase());
    if (FIRST_NAMES[lang].includes(first) || sign.letters.test(subject?.name || '') || sign.org.test(orgs) || companyAsDomain || domains.some((d) => sign.tld.test(d))) out.push(lang);
  }
  // "é" alone is as French as it is Spanish: only count it when nothing else spoke.
  if (!out.length && /é/i.test(subject?.name || '')) out.push('fr');
  return out.slice(0, 2);
}

function subjectTemplates(subject) {
  const name = phrase(subject.name);
  const company = shortCompany(subject.company);
  const co = company ? (/\s/.test(company) ? phrase(company) : company) : '';
  const tokens = String(subject.name).trim().split(/\s+/);
  const firstName = tokens[0];
  const surname = tokens[tokens.length - 1];
  const out = [];
  const add = (id, query, prior, why, extra = {}) => out.push({ template: `q.${id}`, params: { query, ...extra }, prior, why });
  const reference = { prefer: 'reference' }; // when the web engines are resting: an encyclopedia entry before headlines

  add('profile', co ? `${name} ${co}` : name, 0.8, 'who they are and what they run', reference);
  add('linkedin', `${name}${co ? ` ${co}` : ''} site:linkedin.com/in`, 0.75, 'their LinkedIn profile');
  add('lawsuit', `${name} ${any('lawsuit', 'sued', 'court', 'complaint')}`, 0.7, 'lawsuits and court cases that name them');
  add('fraud', `${name} ${any('fraud', 'scam', 'investigation', 'indicted', 'charged')}`, 0.7, 'fraud allegations, investigations and charges');
  add('prior-ventures', `${name} ${any('founder', '"co-founder"', 'CEO')}${company ? ` -${phrase(company)}` : ''}`, 0.6, 'companies they founded or ran before', reference);
  add('employment', `${name} ${any('fired', 'ousted', 'resigned', 'harassment', 'misconduct')}`, 0.55, 'how they left earlier roles');
  add('regulatory', `${name} ${any('SEC', 'FTC', 'regulator', 'fine', 'settlement')}`, 0.55, 'regulators, fines and settlements');
  add('education', `${name} ${any('graduated', 'alumni', 'degree', 'university')}`, 0.5, 'where they studied', reference);
  add('insolvency', `${name} ${any('bankruptcy', 'insolvency', 'liquidation', '"shut down"')}`, 0.5, 'bankruptcies and companies that were wound up');
  add('resume', `${name} ${any('resume', 'CV', '"curriculum vitae"')}`, 0.45, 'a published resume or CV');
  add('interviews', `${name} ${any('interview', 'podcast', 'keynote')}`, 0.45, 'interviews and talks, in their own words');
  add('family', `${name} ${any('"son of"', '"daughter of"', 'father', 'mother', 'brother', 'sister', 'married')}`, 0.4, 'family members in public business or political roles', { family: true, ...reference });
  add('forums', `${name} ${any('site:reddit.com', 'site:news.ycombinator.com')}`, 0.4, 'what forums say about them');
  if (surname && tokens.length > 1) {
    add('family-business', `"${surname.replace(/"/g, '')} family" ${any('business', 'heir', 'dynasty')} ${co ? any(firstName, co) : firstName}`, 0.35, 'a family business or fortune behind them', { family: true, ...reference });
  }
  add('related-party', `${name} ${any('"family office"', '"related party"', 'trust', 'nominee')}`, 0.35, 'family offices, trusts and related parties');
  for (const lang of languageHints(subject)) {
    add(`adverse-${lang}`, `${name} ${ADVERSE[lang]}`, 0.4, `lawsuits and fraud allegations reported in ${LANGUAGE_LABEL[lang]}`, { lang });
  }
  return out;
}

function companyTemplates(companyName) {
  const c = phrase(shortCompany(companyName));
  return [
    { template: 'q.company-legal', params: { query: `${c} ${any('lawsuit', 'fraud', 'investigation')}` }, prior: 0.55, why: 'lawsuits and investigations at this company' },
    { template: 'q.company-leadership', params: { query: `${c} ${any('founder', 'CEO')}`, prefer: 'reference' }, prior: 0.5, why: 'who founded and ran this company' },
    { template: 'q.company-distress', params: { query: `${c} ${any('shutdown', 'layoffs', 'bankruptcy')}` }, prior: 0.45, why: 'whether this company shut down, cut staff or went bankrupt' },
    { template: 'q.company-breach', params: { query: `${c} "data breach"` }, prior: 0.35, why: 'data breaches at this company' },
  ];
}

/** Joint queries only: the subject's quoted name is always in the query. */
function jointTemplates(kind, otherName, subject) {
  const name = phrase(subject.name);
  const other = phrase(otherName);
  const who = kind === 'relative' ? 'this relative' : 'this associate';
  return [
    { template: `q.${kind}-joint`, params: { query: `${name} ${other}`, prefer: 'reference' }, prior: 0.5, why: `what is reported about them together with ${who}` },
    { template: `q.${kind}-adverse`, params: { query: `${name} ${other} ${any('lawsuit', 'fraud', 'investigation', 'settlement', 'dispute')}` }, prior: 0.35, why: `disputes that name them together with ${who}` },
  ];
}

/** The query patterns for a thread. Ids are stable: learning is keyed on them. */
export function webTemplates(thread, subject) {
  const value = tidy(thread?.value);
  if (!subject?.name || !thread?.kind) return [];
  if (thread.kind === 'subject') return subjectTemplates(subject);
  if (!value) return [];
  if (thread.kind === 'company') return companyTemplates(value);
  if (thread.kind === 'associate' || thread.kind === 'relative') return subject.hasName(value) ? [] : jointTemplates(thread.kind, value, subject);
  if (thread.kind === 'school') return [{ template: 'q.school', params: { query: `${phrase(subject.name)} ${phrase(value)}`, prefer: 'reference' }, prior: 0.5, why: 'whether this school and the person are named together' }];
  if (thread.kind === 'handle') return [{ template: 'q.handle', params: { query: `${phrase(value.replace(/^@/, ''))} ${phrase(subject.name)}` }, prior: 0.4, why: 'what is posted under this handle with their name' }];
  return [];
}

/* ------------------------------------------------------------------ results -> findings and threads */

const IDENTITY_HOSTS = ['linkedin.com', 'crunchbase.com', 'wellfound.com', 'angel.co', 'about.me'];
const COURT_HOSTS = ['courtlistener.com', 'pacermonitor.com', 'justia.com', 'casetext.com', 'unicourt.com', 'docketbird.com', 'docketalarm.com', 'pacer.gov', 'uscourts.gov', 'supremecourt.gov', 'leagle.com', 'casemine.com', 'caselaw.findlaw.com', 'law.cornell.edu', 'plainsite.org', 'trellis.law', 'govinfo.gov', 'courts.ca.gov', 'nycourts.gov', 'courts.delaware.gov', 'bailii.org', 'judiciary.uk', 'canlii.org', 'austlii.edu.au', 'legifrance.gouv.fr', 'courdecassation.fr'];
const REGULATOR_HOSTS = ['sec.gov', 'justice.gov', 'ftc.gov', 'finra.org', 'cftc.gov', 'consumerfinance.gov', 'occ.gov', 'occ.treas.gov', 'federalreserve.gov', 'fdic.gov', 'treasury.gov', 'fincen.gov', 'fda.gov', 'hhs.gov', 'dol.gov', 'eeoc.gov', 'nlrb.gov', 'fbi.gov', 'fcc.gov', 'oag.ca.gov', 'ag.ny.gov', 'dfs.ny.gov', 'dfpi.ca.gov', 'nasaa.org', 'fca.org.uk', 'sfo.gov.uk', 'ico.org.uk', 'esma.europa.eu', 'amf-france.org', 'cnil.fr', 'bafin.de', 'cnmv.es', 'consob.it', 'finma.ch', 'asic.gov.au', 'sebi.gov.in', 'mas.gov.sg', 'sfc.hk', 'osc.ca', 'bcsc.bc.ca'];
const DOCKET_WORDS = /\b(?:Case|Docket|Civil Action|Cause)\s+No\.?\s*[\w:.-]*\d|\b\d{1,2}:\d{2}-(?:cv|cr|bk|mc|md)-\d{2,}/i;

/** Where a result belongs, from the site it is on and what it says. */
export function categoryFor(host, text, task = {}) {
  if (onHost(host, IDENTITY_HOSTS)) return 'identity';
  if (onHost(host, COURT_HOSTS) || DOCKET_WORDS.test(text)) return 'litigation';
  if (onHost(host, REGULATOR_HOSTS)) return 'regulatory';
  if (task.kind === 'school' && task.value && mentions(text, task.value)) return 'education';
  if (/(?:\.edu|\.ac\.[a-z]{2}|\.edu\.[a-z]{2})$/.test(host) && /education|school/.test(task.template || '')) return 'education';
  return 'press';
}

const BIO_PATH = /\/(?:team|our-team|about|about-us|people|leadership|management|founders|staff|who-we-are|bios?|speakers?|profiles?|authors?|partners|board)(?:\/|$|[-_.])/i;
const RESUME_WORDS = /\b(?:resume|résumé|cv|curriculum[-_ ]?vitae)\b/i;

/**
 * Profile, bio and resume pages: pages whose older versions are worth
 * reading (another source fetches them from the web archives). The shared
 * extractor covers LinkedIn, Crunchbase, Wellfound and about.me pages whose
 * address carries the person's name; this adds the ones it cannot see.
 */
function pageThreads(subject, result, finding) {
  let u;
  try { u = new URL(result.url); } catch { return []; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname;
  const page = `https://${u.hostname.toLowerCase()}${path.replace(/\/$/, '')}`;
  const trusted = finding.match !== 'possible';
  const out = [];
  const add = (why, extra = {}) => out.push(makeThread('url', page, why, { trusted, ...extra }));

  const profile = profileFromUrl(result.url);
  if (profile) {
    // a profile whose address does not carry the name ("/in/amensch"): only when the result itself names the person
    if (subject.hasName(result.title)) out.push(makeThread('url', profile.url, `${profile.platform} profile`, { trusted, platform: profile.platform }));
    return out.filter(Boolean);
  }
  if (onHost(host, ['indeed.com']) && (/^\/(?:r|me)\//.test(path) || /^(?:profile|resumes?)\./.test(host))) add('Indeed resume', { platform: 'indeed' });
  else if (onHost(host, ['crunchbase.com']) && /^\/person\//.test(path)) add('crunchbase profile', { platform: 'crunchbase' });
  else if (onHost(host, ['wellfound.com', 'angel.co']) && /^\/(?:u|p|people)\//.test(path)) add('wellfound profile', { platform: 'wellfound' });
  else if (/\.(?:pdf|docx?)$/i.test(path) && RESUME_WORDS.test(`${safeDecode(path).replace(/[-_/.]+/g, ' ')} ${result.title}`)) add('resume or CV');
  else {
    const tokens = nameTokens(subject.name);
    const label = host.split('.')[0].replace(/[^a-z0-9]/g, '');
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    if (tokens.length > 1 && (label === `${first}${last}` || label === `${last}${first}`)) {
      add('personal site');
      out.push(makeThread('domain', host, 'personal site', { trusted }));
    } else if (!result.host && !result.publisher && BIO_PATH.test(path) && path.split('/').filter(Boolean).length <= 4) add('team or bio page');
  }
  return out.filter(Boolean);
}

/** A test for "this text names the company the task is about", or null when the task is not about a company. */
function companyTest(task) {
  const company = task.kind === 'company' ? shortCompany(task.value) : '';
  if (!company) return null;
  const re = new RegExp(`(?<![A-Za-z0-9])${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi');
  // a one-word company name must appear capitalised, or "stripe" the pattern would count as Stripe the company
  return (text) => [...String(text).matchAll(re)].some((m) => /\s/.test(company) || /^[A-Z0-9]/.test(m[0]));
}

/**
 * Is a search result worth keeping? It names the person, or (for a lookup
 * about one of their companies) it names that company and reports trouble.
 * Engines whose results all fail this count as having found nothing.
 */
function acceptFor(subject, task) {
  const namesCompany = companyTest(task);
  return (r) => {
    const text = `${r.title} ${r.snippet || ''}`;
    return subject.hasName(text) || (Boolean(namesCompany) && namesCompany(text) && severityFromText(text) !== 'info');
  };
}

/**
 * Grade each result, turn the ones that name the subject into findings, and
 * read them for threads.
 */
function collect(subject, task, results, { source, sourceLabel, category = null, family = false, companyOnlyMax = 3 }) {
  const findings = [];
  const companyOnly = [];
  const threads = [];
  const seenThreads = new Set();
  const pushThread = (t) => {
    if (!t) return;
    const key = `${t.kind}|${t.value.toLowerCase()}`;
    if (seenThreads.has(key)) return;
    seenThreads.add(key);
    threads.push(t);
  };
  const namesCompany = companyTest(task);

  for (const r of results) {
    const text = `${r.title} ${r.snippet || ''}`;
    const host = r.host || hostOf(r.url);
    const base = {
      source, sourceLabel,
      category: category || categoryFor(host, text, task),
      title: r.title,
      quote: r.snippet || '',
      url: r.url,
      date: r.date || null,
      severity: severityFromText(text),
      ...(r.publisher ? { data: { publisher: r.publisher } } : {}),
    };
    const finding = makeFinding(subject, base);
    if (!finding) {
      // About the company the task gave us, not the person: kept when it reports trouble, and marked as such.
      if (namesCompany && !subject.hasName(text) && namesCompany(text) && base.severity !== 'info') {
        const record = makeFinding(subject, { ...base, match: 'company', matchReasons: [`names ${task.value}`] });
        if (record) companyOnly.push(record);
      }
      continue;
    }
    findings.push(finding);
    const trusted = finding.match === 'confirmed' || finding.match === 'likely';
    for (const t of threadsFromResult(subject, { title: r.title, snippet: r.snippet || '', url: r.url }, { trusted })) pushThread(t);
    for (const t of pageThreads(subject, r, finding)) pushThread(t);
    if (family) {
      for (const rel of relativesFromText(subject, r.snippet || '')) pushThread(makeThread('relative', rel.name, `${rel.relation}; ${rel.role}`, { trusted, relation: rel.relation, role: rel.role }));
    }
  }
  // Company-only records would otherwise crowd out what is about the person: the most serious few are enough.
  companyOnly.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return { findings: [...findings, ...companyOnly.slice(0, companyOnlyMax)], threads };
}

const engineLabel = (id) => ENGINES.find((e) => e.id === id)?.label || id;
const pauseNotes = (tried) => (tried || []).filter((t) => t.outcome === 'blocked')
  .map((t) => `${engineLabel(t.id)} asked for fewer searches and is paused for a while; the other search engines cover for it meanwhile.`);

/* ------------------------------------------------------------------ connector: open-web search */

const WEB_ID = 'web-search';
const WEB_LABEL = 'Open-web search';

/** The prior of the query pattern a task came from (its own pattern when it is one of ours, else what the task carries). */
function priorOf(task, subject, templates) {
  const mine = templates({ kind: task.kind, value: task.value }, subject).find((t) => t.template === task.template);
  if (mine) return mine.prior;
  return Number.isFinite(Number(task.prior)) ? Number(task.prior) : 0;
}

export const webSearchConnector = {
  id: WEB_ID,
  label: WEB_LABEL,
  kinds: ['subject', 'company', 'associate', 'relative', 'school', 'handle'],
  prior: 0.6,
  timeoutMs: 24000,
  plan: (thread, subject) => webTemplates(thread, subject),
  async run(task, ctx) {
    const { subject } = ctx;
    const planned = task.params?.query ? task.params : webTemplates({ kind: task.kind, value: task.value }, subject)[0]?.params;
    let query = tidy(planned?.query);
    if (!query) return { findings: [], threads: [], notes: [] };
    // Another person is only ever searched together with the subject.
    if ((task.kind === 'associate' || task.kind === 'relative') && !query.includes(phrase(subject.name))) query = `${phrase(subject.name)} ${phrase(task.value)}`;

    const { results, tried } = await keylessSearch(query, {
      news: Boolean(planned.news), withinDays: planned.withinDays, num: 10, deadline: ctx.deadline,
      // the metered services are kept for the lookups that matter most
      allowMetered: priorOf(task, subject, webTemplates) >= METERED_PRIOR,
      lang: planned.lang, prefer: planned.prefer, accept: acceptFor(subject, task),
    });
    const { findings, threads } = collect(subject, task, results, { source: WEB_ID, sourceLabel: WEB_LABEL, family: Boolean(planned.family), companyOnlyMax: COMPANY_ONLY_MAX.web });
    return { findings, threads, notes: pauseNotes(tried) };
  },
};

/* ------------------------------------------------------------------ connector: news archives */

const DAY_MS = 86400000;
const YEAR_DAYS = 365;
export const NEWS_WINDOWS = [
  { id: 'recent', label: 'the last 12 months', fromDays: YEAR_DAYS, toDays: -1, prior: 0.6 },
  { id: '1-3y', label: '1 to 3 years ago', fromDays: 3 * YEAR_DAYS, toDays: YEAR_DAYS, prior: 0.5 },
  { id: '3-8y', label: '3 to 8 years ago', fromDays: 8 * YEAR_DAYS, toDays: 3 * YEAR_DAYS, prior: 0.42 },
  { id: 'older', label: 'more than 8 years ago', fromDays: null, toDays: 8 * YEAR_DAYS, prior: 0.32 },
];
const NEWS_ADVERSE = any('lawsuit', 'fraud', 'investigation', 'charged', 'bankruptcy', 'scandal', 'fired', 'settlement');
const COMPANY_ADVERSE = any('lawsuit', 'fraud', 'investigation', 'bankruptcy', 'layoffs', '"shut down"', 'scandal', 'settlement');

/** The dates of a window, counted back from today: { after, before } as ISO days. */
export function windowDates(id, now = Date.now()) {
  const w = NEWS_WINDOWS.find((x) => x.id === id);
  if (!w) return {};
  const day = (daysAgo) => new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10);
  return { after: w.fromDays == null ? '1995-01-01' : day(w.fromDays), before: day(w.toDays) };
}

/** News lookups for a thread: every window, with a plain pass and an adverse-terms pass for the person. */
export function newsTemplates(thread, subject) {
  if (!subject?.name || !thread?.kind) return [];
  const out = [];
  if (thread.kind === 'subject') {
    const name = phrase(subject.name);
    const company = shortCompany(subject.company);
    const co = company ? (/\s/.test(company) ? phrase(company) : company) : '';
    for (const w of NEWS_WINDOWS) {
      // The company narrows recent coverage to the right person; further back they may not have been there yet.
      const plain = co && (w.id === 'recent' || w.id === '1-3y') ? `${name} ${co}` : name;
      out.push({ template: `n.${w.id}`, params: { query: plain, window: w.id, news: true }, prior: w.prior, why: `press coverage from ${w.label}` });
      out.push({ template: `n.${w.id}-adverse`, params: { query: `${name} ${NEWS_ADVERSE}`, window: w.id, news: true }, prior: Math.round((w.prior + 0.03) * 100) / 100, why: `lawsuits, investigations and scandals reported ${w.id === 'recent' ? 'in' : ''} ${w.label}`.replace(/\s+/g, ' ') });
    }
    return out;
  }
  if (thread.kind === 'company' && tidy(thread.value)) {
    // For a company only the adverse pass: general company news says little about the person and would use up the lookup budget.
    const c = phrase(shortCompany(thread.value));
    for (const w of NEWS_WINDOWS) {
      out.push({ template: `n.company-${w.id}`, params: { query: `${c} ${COMPANY_ADVERSE}`, window: w.id, news: true }, prior: Math.max(0.3, Math.round((w.prior - 0.1) * 100) / 100), why: `trouble at this company reported ${w.id === 'recent' ? 'in' : ''} ${w.label}`.replace(/\s+/g, ' ') });
    }
  }
  return out;
}

const NEWS_ID = 'news-archive';
const NEWS_LABEL = 'News archives';

export const newsArchiveConnector = {
  id: NEWS_ID,
  label: NEWS_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.5,
  timeoutMs: 26000,
  plan: (thread, subject) => newsTemplates(thread, subject),
  async run(task, ctx) {
    const { subject } = ctx;
    const planned = task.params?.query ? task.params : newsTemplates({ kind: task.kind, value: task.value }, subject)[0]?.params;
    const query = tidy(planned?.query);
    if (!query) return { findings: [], threads: [], notes: [] };
    const { after, before } = windowDates(planned.window);
    const { results, tried } = await keylessSearch(query, { news: true, after, before, num: 15, deadline: ctx.deadline, accept: acceptFor(subject, task) });
    const { findings, threads } = collect(subject, task, results, { source: NEWS_ID, sourceLabel: NEWS_LABEL, category: 'press', companyOnlyMax: COMPANY_ONLY_MAX.news });
    return { findings, threads, notes: pauseNotes(tried) };
  },
};
