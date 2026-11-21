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
import { threadsFromResult, relativesFromText, profileFromUrl, mentions, handleFitsSubject } from '../extract';
import { nameTokens } from '../identity';
import { isOrdinaryWordCompany, companyKeys, companyMention } from '../names';
import { keylessSearch, ENGINES, engineHealth, resolveHeadline, SEARCH_COUNT_KEYS } from './searchEngines';

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
/**
 * The seed of a check: the person's profile, LinkedIn, education, background, interviews and earlier
 * ventures. These run first (deepCheck.js orders them ahead of everything else in the first round) and
 * may always use the backup search service, within its hourly limit. Other lookups that may use it leave
 * SEED_RESERVE uses of the hour for the seed of the next check.
 */
export const SEED_TEMPLATES = ['q.profile', 'q.linkedin', 'q.linkedin-any', 'q.education', 'q.background', 'q.interviews', 'q.prior-ventures'];
/**
 * Web questions a news headline cannot answer well: the seed and the adverse questions. When every general web
 * search is resting they wait for one (keylessSearch needGeneral) a couple of times in the check, rather than
 * being answered from headlines and counted as searched.
 */
export const NEEDS_GENERAL = new Set([...SEED_TEMPLATES, 'q.lawsuit', 'q.fraud', 'q.allegations']);
/** How many times in one check a lookup may wait for a general web search before it settles for the news feeds. */
export const GENERAL_WAITS = 2;
export const SEED_RESERVE = SEED_TEMPLATES.length;
/** Is there room in this hour's backup-search uses for a lookup that is not part of a seed? */
export function meteredRoomBeyondSeed() {
  try {
    const { metered } = engineHealth();
    return metered.usedThisHour + SEED_RESERVE < metered.hourlyLimit;
  } catch {
    return true;
  }
}

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
  pt: any('processo', 'fraude', 'investigação', 'condenado', 'falência', 'preso'),
  it: any('causa', 'truffa', 'frode', 'indagato', 'condannato', 'fallimento'),
  nl: any('rechtszaak', 'fraude', 'oplichting', 'onderzoek', 'veroordeeld', 'faillissement'),
  sv: any('stämning', 'bedrägeri', 'utredning', 'dömd', 'konkurs', 'åtal'),
  pl: any('pozew', 'oszustwo', 'śledztwo', 'skazany', 'upadłość', 'zarzuty'),
  ja: any('訴訟', '詐欺', '逮捕', '起訴', '破産', '不正'),
  ko: any('소송', '사기', '체포', '기소', '파산', '횡령'),
  zh: any('诉讼', '欺诈', '诈骗', '调查', '逮捕', '破产'),
  he: any('תביעה', 'הונאה', 'חקירה', '"כתב אישום"', 'הורשע', '"פשיטת רגל"'),
  hi: any('मुकदमा', 'धोखाधड़ी', 'जांच', 'गिरफ्तार', 'दिवालिया'),
  id: any('gugatan', 'penipuan', 'penyelidikan', 'ditangkap', 'divonis', 'pailit'),
  tr: any('dava', 'dolandırıcılık', 'soruşturma', 'tutuklandı', 'mahkum', 'iflas'),
};
const LANGUAGE_LABEL = { fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian', nl: 'Dutch', sv: 'Swedish', pl: 'Polish', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', he: 'Hebrew', hi: 'Hindi', id: 'Indonesian', tr: 'Turkish' };

const FIRST_NAMES = {
  fr: 'jean pierre françois francois benoît benoit guillaume thibault thibaut timothée timothee antoine mathieu matthieu étienne etienne yann loïc loic cédric cedric aurélien aurelien jérôme jerome rémi remi hervé herve thierry pascal olivier stéphane stephane frédéric frederic ludovic gaël gael maxime clément clement hélène helene amélie amelie céline celine margaux océane'.split(' '),
  de: 'jürgen juergen hans klaus wolfgang matthias günther gunther jörg joerg dieter heinz uwe rainer lutz detlef holger torsten thorsten björn bjoern friedrich ulrich manfred helmut heike ute anke silke'.split(' '),
  es: 'josé jose juan carlos javier pablo diego alejandro santiago jorge luis miguel sergio andrés andres fernando rafael enrique ignacio álvaro alvaro gonzalo joaquín joaquin maría lucía mercedes pilar inés'.split(' '),
};
const LANGUAGE_SIGNS = {
  fr: { letters: /[çèêëàâùûîïôœ]/i, org: /\b(SAS|SASU|SARL|S\.A\.S\.?|S\.A\.R\.L\.?|France|Paris|Lyon|École|Ecole|Université|Sorbonne|HEC|ESSEC|Polytechnique|Sciences Po|INSEAD)\b/, tld: /\.fr$/ },
  de: { letters: /[äöüß]/i, org: /\b(GmbH|mbH|AG|UG|KG|e\.V\.|Deutschland|Berlin|München|Hamburg|Universität|Hochschule|RWTH|WHU)\b/, tld: /\.(de|at)$/ },
  es: { letters: /[ñ¿¡]/i, org: /\b(S\.L\.U?\.?|S\.A\. de C\.V\.|España|Madrid|Barcelona|México|Universidad|IESE|ESADE|Tecnológico)\b/, tld: /\.(es|mx|ar|cl|pe)$/ },
  // The other languages are judged from places and domains only: a first name says little about where someone works.
  pt: { letters: /[ãõ]/i, org: /\b(Ltda\.?|Brasil|São Paulo|Rio de Janeiro|Lisboa|Portugal|Universidade)\b/, tld: /\.(br|pt)$/ },
  it: { org: /\b(S\.r\.l\.?|S\.p\.A\.?|Srl|SpA|Italia|Milano|Roma|Torino|Bocconi|Politecnico di)\b/, tld: /\.it$/ },
  nl: { org: /\b(B\.V\.|BV|N\.V\.|Nederland|Amsterdam|Rotterdam|Utrecht|Eindhoven|Universiteit)\b/, tld: /\.nl$/ },
  sv: { letters: /[å]/i, org: /\b(Aktiebolag|Sverige|Stockholm|Göteborg|Uppsala|KTH)\b/, tld: /\.se$/ },
  pl: { letters: /[ąęłńśźż]/i, org: /\b(Sp\. z o\.o\.|Polska|Warszawa|Kraków|Wrocław|Politechnika)\b/, tld: /\.pl$/ },
  ja: { letters: /[぀-ヿ]/, org: /\b(K\.K\.|Kabushiki Kaisha|Japan|Tokyo|Osaka|Kyoto)\b|株式会社/, tld: /\.(jp)$/ },
  ko: { letters: /[가-힯]/, org: /\b(Korea|Seoul|KAIST|Yonsei)\b|주식회사/, tld: /\.(kr)$/ },
  zh: { letters: /[一-鿿]/, org: /\b(Beijing|Shanghai|Shenzhen|Hangzhou|Tsinghua|Peking University|Hong Kong|Taiwan|Taipei)\b|有限公司/, tld: /\.(cn|tw|hk)$/ },
  he: { letters: /[֐-׿]/, org: /\b(Israel|Tel Aviv|Jerusalem|Haifa|Technion)\b/, tld: /\.il$/ },
  hi: { letters: /[ऀ-ॿ]/, org: /\b(Pvt\.? Ltd\.?|Private Limited|Bengaluru|Bangalore|Mumbai|New Delhi|Gurugram|IIM)\b/, tld: /\.in$/ },
  id: { org: /\b(Tbk|Indonesia|Jakarta|Bandung|Surabaya)\b/, tld: /\.(id)$/ },
  tr: { letters: /[ğış]/, org: /\b(A\.Ş\.|Türkiye|Turkey|Istanbul|İstanbul|Ankara|Boğaziçi)\b/, tld: /\.(tr)$/ },
};
/** Countries (as names or two-letter codes) a user or a register may give, and the language worth searching in. */
const COUNTRY_LANG = {
  fr: 'fr', france: 'fr', de: 'de', germany: 'de', deutschland: 'de', at: 'de', austria: 'de', es: 'es', spain: 'es', mx: 'es', mexico: 'es', ar: 'es', argentina: 'es', cl: 'es', chile: 'es', co: 'es', colombia: 'es',
  br: 'pt', brazil: 'pt', brasil: 'pt', pt: 'pt', portugal: 'pt', it: 'it', italy: 'it', nl: 'nl', netherlands: 'nl', 'the netherlands': 'nl', se: 'sv', sweden: 'sv',
  pl: 'pl', poland: 'pl', jp: 'ja', japan: 'ja', kr: 'ko', 'south korea': 'ko', korea: 'ko', cn: 'zh', china: 'zh', tw: 'zh', taiwan: 'zh', hk: 'zh', 'hong kong': 'zh',
  il: 'he', israel: 'he', in: 'hi', india: 'hi', id: 'id', indonesia: 'id', tr: 'tr', turkey: 'tr', 'türkiye': 'tr', turkiye: 'tr',
};
/** The languages of the countries the subject carries (a place the user gave, a register's country), in order. */
function countryLanguages(subject) {
  const raw = [subject?.country, subject?.place, subject?.jurisdiction, ...(Array.isArray(subject?.countries) ? subject.countries : [])]
    .filter(Boolean).map((v) => String(v).toLowerCase().trim());
  const out = [];
  for (const v of raw) {
    // A US state register ("us_de", "US-CO") is English: its two letters are a state, not a country.
    if (/^(?:us|usa|united states)(?:$|[\s_,-])/.test(v)) continue;
    // "Paris, France": the last part names the country
    const parts = [v, ...v.split(/[,/|]/).map((x) => x.trim())].filter(Boolean);
    const lang = parts.map((x) => COUNTRY_LANG[x]).find(Boolean);
    if (lang && !out.includes(lang)) out.push(lang);
  }
  return out;
}

/** The domains known for the subject's companies: the domain anchors and the domains learned as a company's names. */
function knownDomains(subject) {
  const out = [...(subject?.anchors?.domains?.values?.() || [])].map((a) => String(a.value).toLowerCase());
  for (const a of subject?.anchors?.aliases?.values?.() || []) if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(a.value))) out.push(String(a.value).toLowerCase());
  return [...new Set(out)];
}

/**
 * Languages worth a second, non-English pass, judged from a place the user gave or a register's country
 * (subject.country / place / jurisdiction / countries), the company's domain, the name, the company and what is
 * already known (schools, domains). A hint, not a fact: at most two languages (each costs a lookup or two), and
 * nothing when there is no sign at all.
 * @returns {string[]} language codes ('fr', 'pt', 'ja', ...)
 */
export function languageHints(subject) {
  const first = String(subject?.name || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  const orgs = [subject?.company, ...[...(subject?.anchors?.companies?.values?.() || [])].map((a) => a.value), ...[...(subject?.anchors?.schools?.values?.() || [])].map((a) => a.value)].filter(Boolean).join(' | ');
  const domains = knownDomains(subject);
  const company = String(subject?.company || '').trim().toLowerCase();
  const companyAsDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(company) ? company : '';
  // A place stated outright comes first, then a company's own domain, then the softer signs.
  const out = [...countryLanguages(subject)];
  const push = (lang) => { if (!out.includes(lang)) out.push(lang); };
  for (const [lang, sign] of Object.entries(LANGUAGE_SIGNS)) {
    if ((companyAsDomain && sign.tld.test(companyAsDomain)) || domains.some((d) => sign.tld.test(d))) push(lang);
  }
  for (const [lang, sign] of Object.entries(LANGUAGE_SIGNS)) {
    if ((FIRST_NAMES[lang] || []).includes(first) || (sign.letters && sign.letters.test(subject?.name || '')) || sign.org.test(orgs)) push(lang);
  }
  // "é" alone is as French as it is Spanish: only count it when nothing else spoke.
  if (!out.length && /é/i.test(subject?.name || '')) out.push('fr');
  return out.slice(0, 2);
}

/* ------------------------------------------------------------------ the company's names */

const isDomainLike = (v) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(v || '').trim());
const labelKey = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Every known name of a company: its short name, the legal names and domains learned for it (identity.js
 * addCompanyAlias), and a known domain whose first label is the company's name ("merge.dev" for Merge).
 * `ordinary`: the name is one ordinary word (Ramp, Merge), which on its own names a thousand things.
 */
export function companyNames(subject, company) {
  const short = shortCompany(company);
  const key = companyKeys(company)[0] || String(company || '').toLowerCase();
  const aliases = [...(subject?.anchors?.aliases?.values?.() || [])].filter((a) => a.of === key || a.of === (companyKeys(short)[0] || '')).map((a) => String(a.value));
  const legal = [...new Set(aliases.filter((a) => !isDomainLike(a)))];
  const own = labelKey(short);
  const domains = [...new Set([
    ...aliases.filter(isDomainLike).map((d) => d.toLowerCase()),
    ...[...(subject?.anchors?.domains?.values?.() || [])].map((a) => String(a.value).toLowerCase()).filter((d) => own.length >= 3 && [own, `${own}hq`, `get${own}`, `${own}app`, `try${own}`].includes(d.split('.')[0])),
  ])];
  return { short, legal, domains, ordinary: isOrdinaryWordCompany(short) };
}

/**
 * How a search names a company. A distinctive name is searched by every known name ("Theranos" OR "Theranos,
 * Inc."). An ordinary word is never searched alone: by its legal names and domain when they are known
 * ("Ramp Business Corporation" OR "ramp.com"), else together with the person's name.
 */
export function companyQueryRef(subject, company) {
  const { short, legal, domains, ordinary } = companyNames(subject, company);
  const strong = [...legal.map(phrase), ...domains.map(phrase)];
  if (ordinary) {
    if (strong.length) return strong.length === 1 ? strong[0] : any(...strong.slice(0, 4));
    return `${phrase(short)} ${phrase(subject.name)}`;
  }
  const all = [phrase(short), ...strong].slice(0, 4);
  return all.length === 1 ? all[0] : any(...all);
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

  // The seed: the lookups that build the profile (who they are, where they worked and studied, their own
  // words). They run first in a check and may use the backup search service when the keyless engines are
  // resting (SEED_TEMPLATES). LinkedIn and the earlier-career question come first among them: their snippets
  // carry the experience and education lines no other source gives.
  const seed = { seed: true };
  add('profile', co ? `${name} ${co}` : name, 0.8, 'who they are and what they run', { ...reference, ...seed });
  add('linkedin', `${name}${co ? ` ${co}` : ''} site:linkedin.com/in`, 0.8, 'their LinkedIn profile', seed);
  // Without the company: the snippet of their profile often lists earlier employers and schools. Only searched for
  // a name that is not common (a common name's profiles are mostly namesakes'); the results are graded as usual.
  if (co && !subject.common) add('linkedin-any', `${name} site:linkedin.com/in`, 0.72, 'their LinkedIn profile, as search snippets show it', seed);
  add('lawsuit', `${name} ${any('lawsuit', 'sued', 'court', 'complaint')}`, 0.7, 'lawsuits and court cases that name them');
  add('fraud', `${name} ${any('fraud', 'scam', 'investigation', 'indicted', 'charged')}`, 0.7, 'fraud allegations, investigations and charges');
  // Misconduct headlines say "accused of" or "allegations"; criminal outcomes "arrested", "convicted", "sentenced".
  add('allegations', `${name} ${any('accused', 'allegations', 'arrested', 'convicted', 'sentenced', '"pleaded guilty"', '"class action"', 'sanctioned')}`, 0.68, 'accusations, arrests, convictions and class actions');
  // Earlier ventures: coverage of them nearly always names the famous company too, so it stays in the query
  // (excluding it left mostly namesakes who are founders). Without a company, the plain founder question.
  if (co) add('prior-ventures', `${name} ${co} ${any('"previously founded"', '"before founding"', '"serial entrepreneur"', '"first company"', '"sold his"', '"sold her"', '"co-founded"', 'acquired')}`, 0.6, 'companies they founded or ran before', { ...reference, ...seed });
  else add('prior-ventures', `${name} ${any('founder', '"co-founder"', 'CEO')}`, 0.6, 'companies they founded or ran before', { ...reference, ...seed });
  // what they started next, and who backed it: coverage of a later venture usually names the famous one too, so nothing is excluded
  add('later-ventures', `${name} ${any('raises', 'funding', '"backed by"', 'launches', '"new company"')}`, 0.55, 'companies they started later and who invested in them');
  add('employment', `${name} ${any('fired', 'ousted', 'resigned', 'harassment', 'misconduct')}`, 0.55, 'how they left earlier roles');
  add('regulatory', `${name} ${any('SEC', 'FTC', 'regulator', 'fine', 'settlement', '"attorney general"')}`, 0.55, 'regulators, fines and settlements');
  add('education', `${name}${co ? ` ${co}` : ''} ${any('graduated', 'alumni', 'degree', 'university', 'studied')}`, co ? 0.7 : 0.5, 'where they studied', { ...reference, ...seed });
  add('background', `${name}${co ? ` ${co}` : ''} ${any('previously', 'formerly', '"prior to"', '"before founding"', '"worked at"')}`, 0.78, 'where they worked before', { ...reference, ...seed });
  // Early-career roles a founder profile skips ("analyst at Credit Suisse"): no company, so namesakes are graded down.
  add('roles', `${name} ${any('analyst', 'associate', '"investment banking"', '"private equity"', 'engineer', '"product manager"', 'consultant')}`, 0.5, 'earlier jobs and titles');
  // Org-chart and company-database pages: their search snippets list a title and an employer. Snippets only:
  // the page reader never opens these sites.
  add('profiles', `${name} ${any('site:theorg.com', 'site:crunchbase.com')}`, 0.45, 'their title on org-chart and company-database pages, as search snippets show it');
  add('insolvency', `${name} ${any('bankruptcy', 'insolvency', 'liquidation', '"shut down"')}`, 0.5, 'bankruptcies and companies that were wound up');
  add('resume', `${name} ${any('resume', 'CV', '"curriculum vitae"')}`, 0.45, 'a published resume or CV');
  add('interviews', `${name} ${any('interview', 'podcast', 'keynote', 'TEDx', 'speaker', 'fireside')}`, 0.45, 'interviews and talks, in their own words', seed);
  add('family', `${name} ${any('"son of"', '"daughter of"', 'father', 'mother', 'brother', 'sister', 'married')}`, 0.4, 'family members in public business or political roles', { family: true, ...reference });
  add('forums', `${name} ${any('site:reddit.com', 'site:news.ycombinator.com')}`, 0.4, 'what forums say about them');
  if (surname && tokens.length > 1) {
    add('family-business', `"${surname.replace(/"/g, '')} family" ${any('business', 'heir', 'dynasty')} ${co ? any(firstName, co) : firstName}`, 0.35, 'a family business or fortune behind them', { family: true, ...reference });
  }
  add('related-party', `${name} ${any('"family office"', '"related party"', 'trust', 'nominee')}`, 0.35, 'family offices, trusts and related parties');
  for (const lang of languageHints(subject)) {
    if (!ADVERSE[lang]) continue;
    add(`adverse-${lang}`, `${name} ${ADVERSE[lang]}`, 0.4, `lawsuits and fraud allegations reported in ${LANGUAGE_LABEL[lang]}`, { lang });
  }
  return out;
}

const companyKey = (s) => shortCompany(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** A company thread whose source places it in the person's past: "(past)", an earlier name, a Form D, a Wikipedia career passage, a closed span of years. */
const PRIOR_VENTURE = /\(past\)|\bearlier\b|\bformer(?:ly)?\b|\bprevious(?:ly)?\b|\bform d\b|\bwikipedia\b|\b(?:19|20)\d\d\s*[-–]\s*(?:19|20)\d\d\b/i;

function companyTemplates(companyName, subject, thread = {}) {
  const short = shortCompany(companyName);
  // Every known name of the company, and never an ordinary word on its own (companyQueryRef)
  const c = companyQueryRef(subject, companyName);
  const { domains, legal } = companyNames(subject, companyName);
  const person = subject?.name ? phrase(subject.name) : '';
  const out = [
    // State attorneys general write to companies in letters and demands the news rarely carries: asked here too
    { template: 'q.company-legal', params: { query: `${c} ${any('lawsuit', 'fraud', 'investigation', '"class action"', 'sanctions', '"attorney general"')}` }, prior: 0.55, why: 'lawsuits, investigations and attorney-general actions at this company' },
    { template: 'q.company-leadership', params: { query: `${c} ${any('founder', 'CEO')}`, prefer: 'reference' }, prior: 0.5, why: 'who founded and ran this company' },
    { template: 'q.company-distress', params: { query: `${c} ${any('shutdown', 'layoffs', 'bankruptcy')}` }, prior: 0.45, why: 'whether this company shut down, cut staff or went bankrupt' },
    // no separate data-breach lookup: the breach registers (another source) cover it, and the search allowance is shared by the whole check
  ];
  // Funding rounds: the company with its domain or legal name (press releases carry both). A one-word name with
  // neither is asked with the person's name; a distinctive name is asked as it is (q.company-investors).
  const fundingAnchor = domains[0] ? phrase(domains[0]) : legal[0] ? phrase(legal[0]) : !/\s/.test(short) && person ? person : '';
  if (fundingAnchor) {
    out.push({ template: 'q.company-funding', params: { query: `${phrase(short)} ${fundingAnchor} ${any('raises', '"Series A"', '"Series B"', '"seed round"', '"led by"', 'valuation')}` }, prior: 0.5, why: 'the funding rounds of this company and who led them' });
  }
  out.push({ template: 'q.company-backers', params: { query: `${c} ${any('adviser', 'advisor', 'shareholder', 'board')}` }, prior: 0.5, why: 'advisers, shareholders and board members of this company' });
  // the funding lookup above already asks who led the rounds when it runs
  if (!fundingAnchor) out.push({ template: 'q.company-investors', params: { query: `${c} ${any('"led by"', '"lead investor"', '"Series A"', '"Series B"', '"Series C"')}` }, prior: 0.45, why: 'who led and joined the funding rounds of this company' });
  // A French company's advisers, shareholders and conflicts of interest are often reported only in French.
  if (languageHints(subject).includes('fr')) {
    out.push({ template: 'q.company-backers-fr', params: { query: `${c} ${any('actionnaire', 'conseiller', '"ancien ministre"', `"conflit d'intérêts"`)}`, lang: 'fr' }, prior: 0.4, why: 'advisers, shareholders and conflicts of interest at this company, reported in French' });
  }
  // An earlier venture: an old lawsuit about it is found with an encyclopedia or a general web search, not a recent news feed.
  const given = subject?.company ? companyKey(subject.company) : '';
  if (subject?.name && thread.tie !== 'affiliate' && companyKey(companyName) !== given && PRIOR_VENTURE.test(String(thread.why || ''))) {
    out.push({ template: 'q.company-prior-legal', params: { query: `${phrase(short)} ${phrase(subject.name)} ${any('sued', 'lawsuit', 'judgment')}`, prefer: 'reference', allowMetered: true }, prior: 0.55, why: 'lawsuits about an earlier venture that name the person' });
  }
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
  if (thread.kind === 'company') return companyTemplates(value, subject, thread);
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
/** Podcast show notes, interviews and talks: pages in the person's own words, usually with an introduction of their career. */
const TALK_PATH = /\/(?:podcasts?|podcast-episodes?|episodes?|show-?notes|interviews?|fireside(?:-chats?)?|talks?|webinars?|conversations?)(?:\/|$|[-_.])/i;
/**
 * Established publications and press-release wires: an article there whose search snippet names the
 * person is worth opening even when its headline does not (founder profiles, funding stories, appointment
 * announcements). Paywalled titles are left out (nothing to read), and every page is still opened only
 * when the site's robots.txt allows it (pages.js).
 */
export const PRESS_HOSTS = ['techcrunch.com', 'venturebeat.com', 'geekwire.com', 'sifted.eu', 'fortune.com', 'fastcompany.com', 'inc.com', 'forbes.com', 'businessinsider.com', 'cnbc.com', 'axios.com', 'theverge.com', 'wired.com', 'siliconangle.com', 'news.crunchbase.com', 'theguardian.com', 'bbc.com', 'bbc.co.uk', 'prnewswire.com', 'businesswire.com', 'globenewswire.com', 'eu-startups.com', 'tech.eu', 'maddyness.com', 'lesechos.fr', 'yourstory.com', 'inc42.com', 'techinasia.com', 'betakit.com', 'builtin.com', 'entrepreneur.com', 'thenextweb.com', 'protocol.com', 'semafor.com'];
const companyLabelKey = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** Is this host the company's own site? Its first label is the company's name ("merge.dev" for Merge, "acmerobotics.com" for Acme Robotics). */
function companySite(subject, host) {
  const label = host.split('.')[0];
  if (label.length < 3) return false;
  const names = [subject.company, ...[...(subject.anchors?.companies?.values?.() || [])].filter((a) => a.origin === 'given').map((a) => a.value)].filter(Boolean);
  return names.some((n) => { const k = companyLabelKey(shortCompany(n)); return k.length >= 3 && (label === k || label === `${k}hq` || label === `get${k}` || label === `${k}app`); });
}
/** Is the address the profile page itself (not a post, an episode or an article under it)? */
function isProfileRoot(url, profile) {
  try {
    const u = new URL(String(url));
    const root = new URL(profile.url);
    return u.hostname.toLowerCase().replace(/^www\./, '') === root.hostname.toLowerCase().replace(/^www\./, '') && u.pathname.replace(/\/+$/, '') === root.pathname.replace(/\/+$/, '');
  } catch { return false; }
}
/** Does the title start with the person's name ("Arthur Mensch - Mistral AI | LinkedIn"), as a profile's own title does? */
function titleOpensWithName(subject, title) {
  const t = String(title || '');
  const first = typeof subject.hasName.positions === 'function' ? subject.hasName.positions(t)[0] : null;
  if (first) return first.start <= 2;
  return subject.hasName(t) && t.trim().length < 120 && subject.hasName(t.split(/\s[-|–—·:]\s/)[0]);
}
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
  const namesThem = subject.hasName(result.title) || subject.hasName(result.snippet || '');
  const deep = path.split('/').filter(Boolean).length;
  if (profile) {
    // A profile whose address does not carry the name ("/in/amensch"): only when the result is the profile page
    // itself and its title opens with the person's name (its owner). A post on someone else's newsletter or blog
    // ("Shensi Ding - Merge (#74) - by David Politis" on notanotherceo.substack.com) names the guest, not the
    // owner: the interviewer's newsletter is never the person's own.
    if (handleFitsSubject(subject, profile.handle) || (isProfileRoot(result.url, profile) && titleOpensWithName(subject, result.title))) {
      out.push(makeThread('url', profile.url, `${profile.platform} profile`, { trusted, platform: profile.platform }));
    }
    // A newsletter post or essay (substack.com/p/..., medium.com/@x/...) that names them: often an interview
    if ((profile.platform === 'substack' || profile.platform === 'medium') && finding.match === 'confirmed' && namesThem && deep >= 2) add('interview or article page about them');
    return out.filter(Boolean);
  }
  // The company's own site, seen on a record tied to the person: its about and team pages are read (pages.js)
  if (finding.match === 'confirmed' && companySite(subject, host)) out.push(makeThread('domain', host, 'company website', { trusted }));
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
    // A page whose own headline names the person (a profile, an interview, a founder story) is about them:
    // worth opening for what it says of their career and education. Never the front page of a site.
    else if (finding.match === 'confirmed' && subject.hasName(result.title) && deep >= 1 && !/news\.google\.com$/.test(host)) add('page about them');
    // Podcast show notes and interviews: the guest's introduction usually tells their career
    else if (finding.match === 'confirmed' && namesThem && !result.host && !result.publisher && TALK_PATH.test(path) && deep >= 2) add('podcast or interview page');
    // A newsletter post or essay on someone's Substack or Medium that names them (often an interview): read for
    // what it says, never taken as their own newsletter (the shared extractor no longer reads a post as a profile)
    else if (finding.match === 'confirmed' && namesThem && ((/\.substack\.com$/.test(host) && /^\/p\//.test(path)) || (host === 'medium.com' && /^\/@[^/]+\/[^/]+/.test(path))) && deep >= 2) add('interview or article page about them');
    // An established publication's article whose snippet names them, though its headline does not
    else if (finding.match === 'confirmed' && namesThem && !result.host && onHost(host, PRESS_HOSTS) && deep >= 1) add('article naming them');
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
  // An ordinary word ("Ramp", "Merge") names a boat ramp or an Ethereum upgrade as easily as the company: a record
  // that does not name the person is the company's only when it gives a learned legal name or domain, a legal form
  // right after the word ("Ramp Business Corporation"), or is on the company's own site. Never the bare word.
  const ordinary = isOrdinaryWordCompany(company);
  const known = ordinary ? companyNames(subject || {}, task.value) : null;
  const strongMention = ordinary
    ? (text) => { const m = companyMention(task.value, String(text), { aliases: [...known.legal, ...known.domains], person: subject?.hasName || null, personWords: nameTokens(subject?.name || '') }); return m.named && m.strength === 'strong'; }
    : null;
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
    if (ordinary) {
      if (host && known.domains.length && onHost(host, known.domains)) return true;
      if (strongMention(str)) return true; // a learned legal name or domain, or a legal form right after the word
    }
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
      // An ordinary word is never placed by its capital or the word after it ("a lawsuit against Ramp" may be a
      // boat ramp's operator): only by what ties it above.
      if (ordinary || weakHere || m.index < titleEnd) continue;
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
  const key = companyKey;
  const bare = key(title.replace(/\s*\([^)]*\)\s*$/, ''));
  if (!bare) return 'other';
  const names = [subject.name, ...(subject.variants || []), subject.company, task?.kind === 'company' ? task.value : '',
    ...['companies', 'people'].flatMap((kind) => [...(subject.anchors?.[kind]?.values?.() || [])].map((a) => a.value))];
  if (names.some((n) => n && key(n) === bare)) return 'subject';
  // "Neumann", "Trevor": the surname or first name alone is a page of namesakes
  const tokens = String(subject.name || '').trim().split(/\s+/);
  if (tokens.length > 1 && [tokens[0], tokens[tokens.length - 1]].some((t) => key(t) === bare)) return 'list';
  return 'other';
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

/** How many Wikipedia articles about something else (background mentions) one check keeps. */
export const WIKI_OTHER_MAX = 3;
/** The background Wikipedia records the web and news sources already kept in this check. */
function backgroundWikiCount(ctx) {
  let list = [];
  try { list = typeof ctx?.findings === 'function' ? ctx.findings() || [] : []; } catch { list = []; }
  return list.filter((f) => f && (f.source === WEB_ID || f.source === NEWS_ID) && f.data?.background).length;
}

const YEAR_IN = /(?<![\p{L}\p{N}$£€.,])((?:19[89]|20[0-9])\d)(?![\p{L}\p{N}%])/gu;
/**
 * Whether a result's date (a news feed's publication or re-publication date) may not be when the story
 * happened: the address or the headline names an earlier year ("/2019/05/...", "... in 2020"), or the
 * headline calls the person CEO of a company in the present tense after their tenure there ended.
 */
export function dateApprox(subject, r) {
  const year = Number(String(r?.date || '').slice(0, 4));
  if (!year) return false;
  const earlier = (text) => [...String(text || '').matchAll(YEAR_IN)].some((m) => Number(m[1]) < year);
  let path = '';
  try { const u = new URL(String(r.url)); path = safeDecode(`${u.pathname}${u.search}`); } catch { path = ''; }
  if (earlier(path) || earlier(r.title)) return true;
  const day = String(r.date).slice(0, 10);
  for (const role of subject?.anchors?.roles?.values?.() || []) {
    if (role.to && day > role.to && typeof role.test === 'function' && subject.hasName(r.title) && role.test(String(r.title || ''))) return true;
  }
  return false;
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
function collect(subject, task, results, { source, sourceLabel, category = null, family = false, companyOnlyMax = 3, knownWiki = new Set(), backgroundKept = 0 }) {
  let background = backgroundKept;
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
    // A date that may be a re-publication: kept, marked, and not used to grade the record (a CEO tenure).
    const approx = Boolean(base.date) && dateApprox(subject, r);
    if (approx) base.data = { ...(base.data || {}), dateApprox: true };
    const wiki = wikipediaTitle(r.url);
    const wikiKind = wiki ? wikipediaKind(subject, task, wiki) : null;
    if (wikiKind === 'list') continue;
    // the encyclopedia source already read this article
    if (wiki && knownWiki.has(wikiKey(r.url))) continue;
    // An article about something else that mentions the person: background at most, never confirmed,
    // and never a record about the company alone.
    if (wikiKind === 'other') {
      base.severity = 'info';
      base.data = { ...(base.data || {}), background: true };
    }
    const grade = (b) => {
      if (!approx) return makeFinding(subject, b);
      const made = makeFinding(subject, { ...b, date: null });
      return made ? { ...made, date: b.date } : made;
    };
    let finding = grade(base);
    if (finding && wikiKind === 'other') {
      // kept only when the text also names something tied to them (their company): a name alone in
      // an article about a film, an honours list or a namesake is not about them; and only a few per check
      if (finding.match !== 'confirmed' || background >= WIKI_OTHER_MAX) continue;
      background += 1;
      finding = grade({ ...base, match: 'possible', matchReasons: [`Wikipedia article about ${wiki}, not about the person`] });
    }
    if (!finding) {
      // About the company the task gave us, not the person: kept when it reports trouble, and marked as such.
      if (namesCompany && !subject.hasName(text) && namesCompany(text, { title: r.title, host }) && base.severity !== 'info') {
        const record = grade({ ...base, match: 'company', matchReasons: [`names ${task.value}`] });
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
/** Is the task one of the seed lookups about the person? Read from our own patterns, never from what the task carries. */
function isSeed(task, subject) {
  if (task.kind !== 'subject' || !SEED_TEMPLATES.includes(task.template)) return false;
  return Boolean(webTemplates({ kind: 'subject', value: task.value }, subject).find((t) => t.template === task.template)?.params?.seed);
}
/** May this lookup use the backup search service? Seeds always may; other high-value lookups while the seed reserve is left. */
function meteredAllowed(task, subject, planned) {
  if (isSeed(task, subject)) return true;
  if (!(priorOf(task, subject, webTemplates) >= METERED_PRIOR || Boolean(planned.allowMetered))) return false;
  return meteredRoomBeyondSeed();
}

/**
 * Count one open-web question in the check's own tally (ctx.spend): answered by a general web search, by the news
 * feeds or the encyclopedia only ("headlines"), or not at all ("none"). The report's coverage line is built from
 * these (searchEngines.searchCoverageNote), so a question only headlines answered is never called searched.
 */
function tally(ctx, kind) {
  try { if (typeof ctx?.spend === 'function') ctx.spend(SEARCH_COUNT_KEYS[kind], 1, Infinity); } catch { /* counting is best effort */ }
}
/** Has this lookup already waited for a general web search as often as one check allows? Takes one wait when not. */
function mayWait(ctx, task) {
  if (typeof ctx?.spend !== 'function') return false;
  try { return ctx.spend(`web-search:wait|${task.template}|${String(task.value || '').toLowerCase()}`, 1, GENERAL_WAITS); } catch { return false; }
}
const HEADLINES_NOTE = 'Some open-web questions were answered from news headlines or the encyclopedia only, because no general web search was available to take them; those questions are listed as not searched on the open web.';

/** How many Google News headlines one check may look up on Bing News to find the article's own address. */
export const RESOLVE_MAX = 3;
const RESOLVE_KEY = 'web-search:resolve';
/**
 * Google News gives a forwarding link and no snippet, so the page reader never reads the article. For a
 * headline that names the person, on an established publication, tied to them: ask Bing News for the same
 * headline on the same site (a few per check), and hand the article's own address to the page reader.
 */
async function articleThreads(subject, results, findings, ctx) {
  const out = [];
  for (const r of results) {
    if (!r.host || !/(^|\.)news\.google\.com$/i.test(hostOf(r.url)) || !onHost(r.host, PRESS_HOSTS) || !subject.hasName(r.title)) continue;
    const f = findings.find((x) => x.url === r.url);
    if (!f || f.match !== 'confirmed') continue;
    if (ctx?.deadline && ctx.deadline - Date.now() < 4000) break;
    if (typeof ctx?.spend === 'function' && !ctx.spend(RESOLVE_KEY, 1, RESOLVE_MAX)) break;
    // eslint-disable-next-line no-await-in-loop
    const url = await resolveHeadline(r.title, r.host, { deadline: ctx?.deadline }).catch(() => null);
    if (url) {
      const t = makeThread('url', url, 'article naming them', { trusted: true });
      if (t) out.push(t);
    }
  }
  return out;
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
    // The seed and the adverse questions wait for a general web search (twice at most in a check) instead of
    // settling for headlines; past that they take what the news feeds give, and say so.
    const needGeneral = task.kind === 'subject' && NEEDS_GENERAL.has(task.template) && !planned.news && mayWait(ctx, task);

    let search;
    try {
      search = await keylessSearch(query, {
        news: Boolean(planned.news), withinDays: planned.withinDays, num: 10, deadline: ctx.deadline,
        // the metered services are kept for the lookups that matter most: the seed first
        allowMetered: meteredAllowed(task, subject, planned),
        lang: planned.lang, prefer: planned.prefer, accept: acceptFor(subject, task), needGeneral,
      });
    } catch (error) {
      if (error?.code !== 'SEARCH_RESTING') tally(ctx, 'none');
      throw error;
    }
    const { results, tried } = search;
    const { findings, threads } = collect(subject, task, results, { source: WEB_ID, sourceLabel: WEB_LABEL, family: Boolean(planned.family), companyOnlyMax: COMPANY_ONLY_MAX.web, knownWiki: knownWikiPages(ctx), backgroundKept: backgroundWikiCount(ctx) });
    threads.push(...await articleThreads(subject, results, findings, ctx));
    const notes = pauseNotes(tried);
    if (search.headlinesOnly) {
      tally(ctx, 'headlines');
      notes.push(HEADLINES_NOTE);
      // Not searched on the open web: listed as such (deepCheck reports `partial` parts as not searched), and the
      // pattern is not scored on it (a headline feed finding nothing says nothing about the question).
      return { findings, threads, notes, partial: [`open web: ${planned.why || task.template || 'a question'} (news headlines or the encyclopedia only)`], noLearn: true, headlinesOnly: true };
    }
    tally(ctx, search.general ? 'general' : 'none');
    return { findings, threads, notes };
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
// Misconduct headlines say "accused" or "allegations"; criminal outcomes "arrested", "convicted", "sentenced".
// The news feeds take far more questions than the general web search, so the wider terms go here.
const NEWS_ADVERSE = any('lawsuit', 'fraud', 'investigation', 'charged', 'accused', 'allegations', 'arrested', 'convicted', 'sentenced', 'bankruptcy', 'scandal', 'fired', 'settlement');
const COMPANY_ADVERSE = any('lawsuit', 'fraud', 'investigation', 'bankruptcy', 'layoffs', '"shut down"', 'scandal', 'settlement', 'sanctions', '"class action"', '"attorney general"');

/** The dates of a window, counted back from today: { after, before } as ISO days. */
export function windowDates(id, now = Date.now()) {
  const w = [...NEWS_WINDOWS, ...COMPANY_NEWS_WINDOWS].find((x) => x.id === id);
  if (!w) return {};
  const day = (daysAgo) => new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10);
  return { after: w.fromDays == null ? '1995-01-01' : day(w.fromDays), before: day(w.toDays) };
}

/**
 * News lookups for a thread. The person: an adverse-terms pass for every window, and a plain pass for the
 * three most recent; board seats, investments, awards and lists (the profile's boards, investments and
 * recognition); and an adverse pass in the local press of each language languageHints gives (its own news
 * edition). A company: an adverse-terms pass for the last three years and one for everything older.
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
    // One question for the positive footprint (the news feeds take long OR groups): board seats, investments, awards and lists
    out.push({ template: 'n.recognition', params: { query: `${name} ${any('"joins board"', '"board of directors"', 'trustee', '"angel investor"', '"invested in"', '"30 Under 30"', '"40 Under 40"', 'award', '"named to"', 'honoree')}`, news: true }, prior: 0.35, why: 'board seats, investments, awards and lists reported in the press' });
    for (const lang of languageHints(subject)) {
      if (!ADVERSE[lang]) continue;
      out.push({ template: `n.adverse-${lang}`, params: { query: `${name} ${ADVERSE[lang]}`, news: true, lang }, prior: 0.4, why: `lawsuits and fraud allegations in the ${LANGUAGE_LABEL[lang]}-language press` });
    }
    return out;
  }
  if (thread.kind === 'company' && tidy(thread.value)) {
    // For a company only the adverse pass: general company news says little about the person and would use up the lookup budget.
    // An ordinary word is never searched alone (companyQueryRef).
    const c = companyQueryRef(subject, thread.value);
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
    const { results, tried } = await keylessSearch(query, { news: true, after, before, num: 15, deadline: ctx.deadline, lang: planned.lang, accept: acceptFor(subject, task) });
    const { findings, threads } = collect(subject, task, results, { source: NEWS_ID, sourceLabel: NEWS_LABEL, category: 'press', companyOnlyMax: COMPANY_ONLY_MAX.news, knownWiki: knownWikiPages(ctx), backgroundKept: backgroundWikiCount(ctx) });
    // Google News gives no snippet and a forwarding link: find the article itself for the page reader
    threads.push(...await articleThreads(subject, results, findings, ctx));
    return { findings, threads, notes: pauseNotes(tried) };
  },
};
