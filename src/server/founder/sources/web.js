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
  // what they started next, and who backed it: coverage of a later venture usually names the famous one too, so nothing is excluded
  add('later-ventures', `${name} ${any('raises', 'funding', '"backed by"', 'launches', '"new company"')}`, 0.55, 'companies they started later and who invested in them');
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

function companyTemplates(companyName, subject) {
  const short = shortCompany(companyName);
  const c = phrase(short);
  const out = [
    { template: 'q.company-legal', params: { query: `${c} ${any('lawsuit', 'fraud', 'investigation')}` }, prior: 0.55, why: 'lawsuits and investigations at this company' },
    { template: 'q.company-leadership', params: { query: `${c} ${any('founder', 'CEO')}`, prefer: 'reference' }, prior: 0.5, why: 'who founded and ran this company' },
    { template: 'q.company-distress', params: { query: `${c} ${any('shutdown', 'layoffs', 'bankruptcy')}` }, prior: 0.45, why: 'whether this company shut down, cut staff or went bankrupt' },
    // no separate data-breach lookup: the breach registers (another source) cover it, and the search allowance is shared by the whole check
  ];
  // A one-word name ("Flow") is also an ordinary word: its funding news is only found next to the person's name.
  if (!/\s/.test(short) && subject?.name) {
    out.push({ template: 'q.company-funding', params: { query: `${c} ${phrase(subject.name)} ${any('funding', 'raises', 'investors', 'led')}` }, prior: 0.45, why: 'who invested in this company, with the person named' });
  }
  out.push({ template: 'q.company-backers', params: { query: `${c} ${any('adviser', 'advisor', 'shareholder', 'board')}` }, prior: 0.35, why: 'advisers, shareholders and board members of this company' });
  return out;
}

/**
 * Joint queries only: the subject's quoted name is always in the query. One
 * lookup per person: the trouble words are optional (the other person's own
 * name closes the OR group, so any page naming both still matches), which
 * lets them lift disputes to the top without a second search.
 */
function jointTemplates(kind, otherName, subject) {
  const name = phrase(subject.name);
  const other = phrase(otherName);
  const who = kind === 'relative' ? 'this relative' : 'this associate';
  return [
    { template: `q.${kind}-joint`, params: { query: `${name} ${other} ${any('lawsuit', 'fraud', 'investigation', 'settlement', 'dispute', other)}`, prefer: 'reference' }, prior: 0.5, why: `what is reported about them together with ${who}, disputes first` },
  ];
}

/** The query patterns for a thread. Ids are stable: learning is keyed on them. */
export function webTemplates(thread, subject) {
  const value = tidy(thread?.value);
  if (!subject?.name || !thread?.kind) return [];
  if (thread.kind === 'subject') return subjectTemplates(subject);
  if (!value) return [];
  if (thread.kind === 'company') return companyTemplates(value, subject);
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

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Words that, right after a one-word company name, keep it a company ("Nikola Motors", "Square Inc"), not part of another name ("Nikola Jokic"). */
const COMPANY_WORD = /^(?:Inc|Incorporated|Corp|Corporation|Co|Company|LLC|Ltd|Limited|Plc|GmbH|AG|SA|Group|Holdings?|Motors|Technologies|Technology|Tech|Labs?|Systems|Software|Therapeutics|Pharma|Pharmaceuticals|Bio|Biosciences|Health|Energy|Capital|Ventures|Financial|Bank|Partners|Media|Networks|Robotics|AI|CEO|CTO|CFO|COO|Founder|Founders|Co-?founder|President|Chairman|Board|Executives?|Employees|Investors?|Shareholders?|Shares|Stock|IPO)\b/;
/** Headline case ("Stripe Settles Lawsuit Over Fees"): a capital after the name says nothing there. */
const titleCase = (title) => {
  const words = String(title || '').split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && w.length > 3);
  return words.length >= 3 && words.filter((w) => /^[A-Z]/.test(w)).length / words.length >= 0.7;
};
/** A legal form right after the name ("We, Inc.", "Flow LLC"): the one word that makes any name a company. */
const LEGAL_FORM_AFTER = /^,?\s+(?:Inc|Incorporated|LLC|L\.L\.C|Ltd|Limited|Corp|Corporation|Co|Company|PLC|LLP|GmbH|AG|SA|SAS|SARL|BV|NV)\b/i;
/** Plain words a company may be called ("We", "Open", "Next"): written as a name they still say nothing on their own. */
const PLAIN_WORDS = new Set('a an the we us our you your it its they them he she his her i me my on in at by of to for and or but so if as up out all any one new now how what why who when where here there this that these those with from into over about more most some just only also best first next open real true get go do be can will may yes no not'.split(' '));
/** How many words either side of the company name the subject's surname may be and still place it. */
const SURNAME_NEAR_WORDS = 5;

/**
 * A test for "this result is about the company the task is about", or null
 * when the task is not about a company. Takes the text and the result's site.
 *
 * A one-word name ("Nikola", "Square") is also a first name or a plain word,
 * so it must be written as a name (capitalised), and not as the first half of
 * another name ("Nikola Jokic", "Square Enix"). Wherever a capital says
 * nothing (a headline-case title, "Flow Characteristics Of ...", or the start
 * of a title or sentence, "Flow investigation of ..."), and always for a name
 * of three letters or fewer, a plain word ("We") or a word the same text also
 * uses in lower case ("... stagnation point flow"), the result
 * must place it some other way: a legal form right after it ("Nikola Corp"),
 * the company's own site, the subject's surname within five words, or the
 * subject's own name.
 */
function companyTest(task, subject) {
  const company = task.kind === 'company' ? shortCompany(task.value) : '';
  if (!company) return null;
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(company)}(?![A-Za-z0-9])`, 'gi');
  if (/\s/.test(company)) return (text) => String(text).search(re) >= 0;
  // "We", "AI", "Flo": too short or too plain to be read as the company from its capital letter alone
  const weak = company.length <= 3 || PLAIN_WORDS.has(company.toLowerCase());
  const full = tidy(task.value);
  const fullRe = weak && full.toLowerCase() !== company.toLowerCase() && /\s/.test(full)
    ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(full).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`, 'i') : null;
  const tokens = nameTokens(subject?.name || '');
  const surname = tokens.length > 1 ? tokens[tokens.length - 1] : '';
  const surnameRe = surname ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(surname)}(?![\\p{L}\\p{N}])`, 'iu') : null;
  const domains = [...(subject?.anchors?.domains?.values?.() || [])].map((a) => String(a.value).toLowerCase().replace(/^www\./, ''));
  const lowerRe = company !== company.toLowerCase() ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(company.toLowerCase())}(?![A-Za-z0-9])`) : null;
  return (text, { title = null, host = '' } = {}) => {
    const str = String(text);
    if (fullRe && fullRe.test(str)) return true; // the full name as given ("We Holdings Ltd")
    const mentions = [...str.matchAll(re)].filter((m) => /^[A-Z0-9]/.test(m[0]));
    if (!mentions.length) return false;
    // the same word written plainly elsewhere ("... stagnation point flow") says the text is using the word, not the name
    const weakHere = weak || Boolean(lowerRe && lowerRe.test(str));
    // where the snippet starts in "title snippet": a sentence start too
    const snippetStart = title != null ? String(title).length + 1 : -1;
    const sentenceStart = (m) => m.index === snippetStart || /^[\s"“'‘(\[]*$/.test(str.slice(0, m.index)) || /[.!?:;]["”’)]?\s+["“'‘(\[]*$/.test(str.slice(0, m.index));
    if (host && domains.length && onHost(host, domains)) return true;
    if (typeof subject?.hasName === 'function' && subject.hasName(str)) return true;
    const after = (m) => str.slice(m.index + m[0].length);
    const surnameNear = (m) => {
      if (!surnameRe) return false;
      const before = str.slice(0, m.index).split(/\s+/).filter(Boolean).slice(-SURNAME_NEAR_WORDS).join(' ');
      const next = after(m).split(/\s+/).filter(Boolean).slice(0, SURNAME_NEAR_WORDS).join(' ');
      return surnameRe.test(before) || surnameRe.test(next);
    };
    const nextWord = (m) => after(m).match(/^\s+([A-Z][\p{L}\p{N}'’&-]*)/u)?.[1] || '';
    // a mention in a headline-case title cannot be read by its capitals; the rest of the text (the snippet) can
    const titleEnd = title != null && titleCase(title) ? String(title).length : 0;
    for (const m of mentions) {
      if (LEGAL_FORM_AFTER.test(after(m))) return true; // "Nikola Corp", "We, Inc."
      if (surnameNear(m)) return true; // "Founder Milton: Nikola settles"
      if (weakHere || m.index < titleEnd) continue;
      // the last word of the title is followed by the snippet, not by a word of the same name
      const next = m.index + m[0].length === snippetStart - 1 ? '' : nextWord(m);
      if (next && COMPANY_WORD.test(next)) return true; // "Nikola Motors", "Square Inc"
      // On position alone: a capital mid-sentence ("regulators fined Nikola, the truck maker"; "a suit against
      // Nikola over trucks"). A capital at the start of a sentence or title says nothing ("Flow investigation
      // of ..."), and a capitalised word after it may make it part of another name ("Nikola Jokic").
      if (!next && !sentenceStart(m)) return true;
    }
    return false;
  };
}

/* Wikipedia articles found by the web search. The article about the person is read by its own
   source; an article about something else (an event, a list, another company) only mentions them. */
const WIKI_URL = /^https?:\/\/[a-z]{2,3}(?:-[a-z]+)?\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i;
/** "Milton (surname)", "Arthur (given name)", "Mensch (disambiguation)": lists of namesakes, never about the person. */
const WIKI_NAME_LIST = /\((?:surname|given name|first name|name|family name|disambiguation)\)$/i;

/** The title of the Wikipedia article a link opens, or '' when it is not one. */
export function wikipediaTitle(url) {
  const m = String(url || '').match(WIKI_URL);
  return m ? tidy(safeDecode(m[1]).replace(/_/g, ' ')) : '';
}

/**
 * What a Wikipedia article is about, judged from its title: 'list' (a page of
 * namesakes: dropped), 'subject' (the person, a company or person already tied
 * to them, or the company the task is about) or 'other'.
 */
export function wikipediaKind(subject, task, title) {
  if (WIKI_NAME_LIST.test(title)) return 'list';
  // the title must BE the name, not contain it: "Nikola Tesla" is not about Nikola the company
  const key = (s) => shortCompany(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const bare = key(title.replace(/\s*\([^)]*\)\s*$/, ''));
  if (!bare) return 'other';
  const names = [subject.name, ...(subject.variants || []), subject.company, task?.kind === 'company' ? task.value : '',
    ...['companies', 'people'].flatMap((kind) => [...(subject.anchors?.[kind]?.values?.() || [])].map((a) => a.value))];
  return names.some((n) => n && key(n) === bare) ? 'subject' : 'other';
}

/** One key per Wikipedia article: language and title, so the mobile site, an anchor (#History) or an encoded title still match. */
function wikiKey(url) {
  const title = wikipediaTitle(url);
  if (!title) return '';
  const lang = String(url).match(/^https?:\/\/([a-z]{2,3}(?:-[a-z]+)?)\./i)?.[1]?.toLowerCase() || '';
  return `${lang}|${title.toLowerCase()}`;
}

/** The Wikipedia articles the encyclopedia source already turned into records in this check. */
const WIKIPEDIA_SOURCE = 'wikipedia';
function knownWikiPages(ctx) {
  let list = [];
  try { list = typeof ctx?.findings === 'function' ? ctx.findings() || [] : []; } catch { list = []; }
  return new Set(list.filter((f) => f && f.source === WIKIPEDIA_SOURCE).map((f) => wikiKey(f.url)).filter(Boolean));
}

/**
 * Is a search result worth keeping? It names the person, or (for a lookup
 * about one of their companies) it names that company and reports trouble.
 * Engines whose results all fail this count as having found nothing.
 */
function acceptFor(subject, task) {
  const namesCompany = companyTest(task, subject);
  return (r) => {
    const text = `${r.title} ${r.snippet || ''}`;
    return subject.hasName(text) || (Boolean(namesCompany) && namesCompany(text, { title: r.title, host: r.host || hostOf(r.url) }) && severityFromText(text) !== 'info');
  };
}

/**
 * Grade each result, turn the ones that name the subject into findings, and
 * read them for threads.
 */
function collect(subject, task, results, { source, sourceLabel, category = null, family = false, companyOnlyMax = 3, knownWiki = new Set() }) {
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
  const namesCompany = companyTest(task, subject);

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
    const wiki = wikipediaTitle(r.url);
    const wikiKind = wiki ? wikipediaKind(subject, task, wiki) : null;
    if (wikiKind === 'list') continue;
    // the encyclopedia source already read this article
    if (wiki && knownWiki.has(wikiKey(r.url))) continue;
    // An article about something else that mentions the person: background at most, never confirmed,
    // and never a record about the company alone.
    if (wikiKind === 'other') base.severity = 'info';
    let finding = makeFinding(subject, base);
    if (finding && wikiKind === 'other') {
      // kept only when the text also names something tied to them (their company): a name alone in
      // an article about a film, an honours list or a namesake is not about them
      if (finding.match !== 'confirmed') continue;
      finding = makeFinding(subject, { ...base, match: 'possible', matchReasons: [`Wikipedia article about ${wiki}, not about the person`] });
    }
    if (!finding) {
      // About the company the task gave us, not the person: kept when it reports trouble, and marked as such.
      if (namesCompany && !subject.hasName(text) && namesCompany(text, { title: r.title, host }) && base.severity !== 'info') {
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
    const { findings, threads } = collect(subject, task, results, { source: WEB_ID, sourceLabel: WEB_LABEL, family: Boolean(planned.family), companyOnlyMax: COMPANY_ONLY_MAX.web, knownWiki: knownWikiPages(ctx) });
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
/** A company gets two wider windows: its trouble is rarer news than the person's, and the search allowance is shared by the whole check. */
export const COMPANY_NEWS_WINDOWS = [
  { id: 'last-3y', label: 'the last 3 years', fromDays: 3 * YEAR_DAYS, toDays: -1, prior: 0.45 },
  { id: 'before-3y', label: 'more than 3 years ago', fromDays: null, toDays: 3 * YEAR_DAYS, prior: 0.32 },
];
/** The person's windows that also get a plain pass (no trouble words): a later venture's funding news is often 3 to 8 years old; older plain coverage rarely changes the picture. */
const PLAIN_WINDOWS = new Set(['recent', '1-3y', '3-8y']);
const NEWS_ADVERSE = any('lawsuit', 'fraud', 'investigation', 'charged', 'bankruptcy', 'scandal', 'fired', 'settlement');
const COMPANY_ADVERSE = any('lawsuit', 'fraud', 'investigation', 'bankruptcy', 'layoffs', '"shut down"', 'scandal', 'settlement');

/** The dates of a window, counted back from today: { after, before } as ISO days. */
export function windowDates(id, now = Date.now()) {
  const w = [...NEWS_WINDOWS, ...COMPANY_NEWS_WINDOWS].find((x) => x.id === id);
  if (!w) return {};
  const day = (daysAgo) => new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10);
  return { after: w.fromDays == null ? '1995-01-01' : day(w.fromDays), before: day(w.toDays) };
}

/**
 * News lookups for a thread. The person: an adverse-terms pass for every
 * window, and a plain pass for the three most recent. A company: an
 * adverse-terms pass for the last three years and one for everything older.
 */
export function newsTemplates(thread, subject) {
  if (!subject?.name || !thread?.kind) return [];
  const out = [];
  if (thread.kind === 'subject') {
    const name = phrase(subject.name);
    const company = shortCompany(subject.company);
    const co = company ? (/\s/.test(company) ? phrase(company) : company) : '';
    for (const w of NEWS_WINDOWS) {
      // The company narrows recent coverage to the right person; further back they may not have been there yet.
      if (PLAIN_WINDOWS.has(w.id)) out.push({ template: `n.${w.id}`, params: { query: co ? `${name} ${co}` : name, window: w.id, news: true }, prior: w.prior, why: `press coverage from ${w.label}` });
      out.push({ template: `n.${w.id}-adverse`, params: { query: `${name} ${NEWS_ADVERSE}`, window: w.id, news: true }, prior: Math.round((w.prior + 0.03) * 100) / 100, why: `lawsuits, investigations and scandals reported ${w.id === 'recent' ? 'in' : ''} ${w.label}`.replace(/\s+/g, ' ') });
    }
    return out;
  }
  if (thread.kind === 'company' && tidy(thread.value)) {
    // For a company only the adverse pass: general company news says little about the person and would use up the lookup budget.
    const c = phrase(shortCompany(thread.value));
    for (const w of COMPANY_NEWS_WINDOWS) {
      out.push({ template: `n.company-${w.id}`, params: { query: `${c} ${COMPANY_ADVERSE}`, window: w.id, news: true }, prior: w.prior, why: `trouble at this company reported ${w.id === 'last-3y' ? 'in' : ''} ${w.label}`.replace(/\s+/g, ' ') });
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
    const { findings, threads } = collect(subject, task, results, { source: NEWS_ID, sourceLabel: NEWS_LABEL, category: 'press', companyOnlyMax: COMPANY_ONLY_MAX.news, knownWiki: knownWikiPages(ctx) });
    return { findings, threads, notes: pauseNotes(tried) };
  },
};
