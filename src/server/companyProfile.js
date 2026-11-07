/**
 * Company profile: gathers structured facts a VC needs (funding rounds,
 * investors, key people, competitors, headcount, public-company data) from
 * the app's existing integrations.
 *
 * Purely extractive. Every item carries the exact sentence it was taken from
 * and `sourceIndex`, the 1-based `n` of the entry in `sources`. Nothing is
 * inferred or generated; parsed fields (amount, round, lead) are only ever
 * substrings of that quote.
 *
 * Sources (run in parallel, each with a timeout, none can throw):
 * - curated registry (primary: most targets are private companies)
 * - Hacker News (Algolia, keyless)
 * - web search (Serper/Tavily; returns [] without keys)
 * - SEC EDGAR + FMP for public-company data (only shown when they match)
 */
import axios from 'axios';
import { searchCuratedSources } from '../utils/sources/curatedIndex';
import { searchHackerNews } from '../utils/sources/hackernewsAlgolia';
import { FACT_RE, cleanText, formatDate, sourceLabel } from '../utils/evidence';

const { getFilings } = require('../utils/edgarUtils');
const { performSearch, sourceHandlers } = require('../utils/sourceIntegration');
const { DATA_PROVIDERS } = require('../utils/dataSources');

const PROVIDER_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_SOURCES = 60;
const cache = new Map();

// ---------------------------------------------------------------- helpers

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-sensitive whole-word matcher, same rule as the curated index. */
function wordRe(term, flags = '') {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(term)}($|[^A-Za-z0-9])`, flags);
}

// Generic trailing words that are often dropped in press ("Mistral AI" -> "Mistral").
const SUFFIXES = /\s+(AI|Inc\.?|Labs?|Technologies|Technology|Tech|HQ|Corp\.?|Corporation|Ltd\.?|LLC|GmbH|SAS|SA|Co\.?|Company|Group|Holdings|Software|Systems|Health|Bio|Robotics|Finance|Security)$/;

/**
 * Names that identify the company. The short form (suffix dropped) is only
 * trusted within a result that also identifies the company another way.
 */
export function companyAliases(name) {
  const full = String(name || '').trim().replace(/\s+/g, ' ');
  const short = full.replace(SUFFIXES, '').trim();
  return { full, short: short !== full && short.length >= 3 && /^[A-Z0-9]/.test(short) ? short : null };
}

function resultText(r) {
  const content = cleanText(r?.content);
  const snippet = cleanText(r?.snippet);
  return `${cleanText(r?.title)} ${content.length >= snippet.length ? content : snippet}`;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** Does this result really concern the company? (no false matches) */
export function mentionsCompany(result, aliases) {
  const text = resultText(result);
  if (wordRe(aliases.full).test(text)) return true;
  if (!aliases.short) return false;
  if (!wordRe(aliases.short).test(text)) return false;
  // Short form only counts when the result is the company's own (site/feed).
  const slug = aliases.short.toLowerCase().replace(/[^a-z0-9]/g, '');
  const host = hostOf(result?.url || result?.link).replace(/[^a-z0-9.]/g, '');
  const name = String(result?.sourceName || '');
  return (slug.length >= 4 && host.split('.').some((part) => part === slug))
    || wordRe(aliases.full).test(name) || wordRe(aliases.short).test(name);
}

/** Title plus sentences of the body, each a verbatim span of the source. */
function quotesOf(result) {
  const out = [];
  const title = cleanText(result?.title).replace(/\s+\(portfolio: [^)]*\)$/, '');
  if (title.length >= 10) out.push(title);
  const content = cleanText(result?.content);
  const snippet = cleanText(result?.snippet);
  const body = content.length >= snippet.length ? content : snippet;
  for (const s of body.split(/(?<=[.!?])\s+/)) {
    if (s.length >= 20 && s.length <= 450 && !out.includes(s)) out.push(s);
  }
  return out;
}

function sentenceMentions(sentence, aliases, allowShort) {
  if (wordRe(aliases.full).test(sentence)) return true;
  return Boolean(allowShort && aliases.short && wordRe(aliases.short).test(sentence));
}

function aliasIndex(sentence, aliases, allowShort) {
  const terms = [aliases.full, allowShort ? aliases.short : null].filter(Boolean);
  let best = -1;
  for (const t of terms) {
    const m = wordRe(t).exec(sentence);
    if (m) {
      const idx = m.index + m[1].length;
      if (best === -1 || idx < best) best = idx;
    }
  }
  return best;
}

// ------------------------------------------------------- funding parsing

const MONEY_RE = /([$€£])\s?(\d{1,4}(?:[.,]\d{1,3})?)\s?(billion|million|bn|mn|[BMK])\b|\b(?:(USD|EUR|GBP)\s?)(\d{1,4}(?:[.,]\d{1,3})?)\s?(billion|million|bn|mn|[BMK])\b|\b(\d{1,4}(?:[.,]\d{1,3})?)\s(billion|million)\s(dollars|euros|pounds)\b|\b(\d{1,4}(?:[.,]\d{1,3})?)\s?(billion|million|bn|mn|[BMK])\s?([$€£])/gi;
const ROUND_RE = /\b(pre-seed|seed|series [a-h]\d?)\b(?!-)|\b(growth|angel|bridge|mezzanine)\s+(?:funding|financing|round|investment)\b/i;
const RAISE_RE = /\b(rais(?:e|es|ed|ing)|secur(?:e|es|ed|ing)|clos(?:e|es|ed|ing)|land(?:s|ed)?|bag(?:s|ged)?|nab(?:s|bed)?|gets?|got|receiv(?:e|es|ed)|announc(?:e|es|ed)[^.]{0,40}\b(?:funding|round|investment))\b/i;
const NOT_OURS_BEFORE = /\b(rivals?|competitors?|competing|like|than|such as|including|vs\.?|versus|alternative to|unlike)\s*$/i;
const VALUATION_BEFORE = /(valuation|valued at|valuing[^,.]{0,30}at)\s*(of\s*)?(more than|over|about|around|nearly|roughly|up to)?\s*$/i;
const CURRENCY = { $: 'USD', '€': 'EUR', '£': 'GBP', usd: 'USD', eur: 'EUR', gbp: 'GBP', dollars: 'USD', euros: 'EUR', pounds: 'GBP' };

function moneyMatches(sentence) {
  const out = [];
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(sentence))) {
    const sym = m[1] || m[4] || m[9] || m[12] || '';
    const num = parseFloat(String(m[2] || m[5] || m[7] || m[10]).replace(',', '.'));
    const unit = String(m[3] || m[6] || m[8] || m[11] || '').toLowerCase();
    const mult = /^(billion|bn|b)$/.test(unit) ? 1e9 : /^(million|mn|m)$/.test(unit) ? 1e6 : unit === 'k' ? 1e3 : 1;
    out.push({ text: m[0].trim(), index: m.index, currency: CURRENCY[sym.toLowerCase()] || CURRENCY[sym] || null, value: num * mult });
  }
  return out;
}

const NAME_STOP = /^(the|a|an|its|existing|new|other|several|some|various|investors?|participation|backers?)$/i;

function splitInvestorList(text) {
  return String(text || '')
    .split(/,\s*(?:and\s+)?|\s+and\s+|\s*&\s+(?=[A-Z][a-z]+ [A-Z])/)
    .map((s) => s.replace(/^(?:and|as well as|also|existing investors?|investors?|from)\s+/i, '').replace(/^the\s+/i, '').trim())
    .map((s) => s.replace(/\s*\(.*$/, '').replace(/['’]s$/, '').trim())
    .filter((s) => /^[A-Z0-9]/.test(s) && s.length >= 2 && s.length <= 60 && !NAME_STOP.test(s) && s.split(/\s+/).length <= 6);
}

const LIST_END = /(?=\s+(?:with participation|with additional|with backing|alongside|at an?\b|at the\b|to\s|for\s|bringing|valuing|which|that|in a\b|in its\b|as part|according)|[.;:!?(]|,\s*(?:with|bringing|valuing|which|according|at|as|and others)\b|\s+-\s|$)/;

function leadInvestorsOf(sentence) {
  const m = /\b(?:co-)?led by\s+(.+)/i.exec(sentence);
  if (!m) return [];
  const span = m[1].split(LIST_END)[0];
  return splitInvestorList(span);
}

function participantsOf(sentence) {
  const m = /\b(?:with participation (?:from|by)|participation from|alongside|joined by|other investors include|investors include|backed by)\s+(.+)/i.exec(sentence);
  if (!m) return [];
  return splitInvestorList(m[1].split(LIST_END)[0]);
}

/**
 * Parse one sentence as a funding announcement by this company.
 * Returns null unless the company is the subject of a raise verb.
 */
export function parseFundingSentence(sentence, aliases, allowShort = true) {
  const at = aliasIndex(sentence, aliases, allowShort);
  if (at === -1) return null;
  if (NOT_OURS_BEFORE.test(sentence.slice(Math.max(0, at - 30), at))) return null;
  const rest = sentence.slice(at);
  const verb = RAISE_RE.exec(rest);
  // The raise verb has to follow the company name closely (it is the subject).
  if (!verb || verb.index > 90) return null;
  const afterVerbStart = at + verb.index;

  const money = moneyMatches(sentence).filter((mm) => mm.index >= afterVerbStart
    && !VALUATION_BEFORE.test(sentence.slice(Math.max(0, mm.index - 45), mm.index)));
  const roundMatch = ROUND_RE.exec(sentence);
  const round = roundMatch ? (roundMatch[1] || roundMatch[2]).replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Pre-Seed$/, 'Pre-seed') : null;
  const amount = money[0] || null;
  if (!amount && !round) return null;
  const amountRightAfterVerb = amount && /^\b(rais|secur|clos|land|bag|nab)/i.test(verb[0])
    && /^[\s\w]{0,12}$/.test(sentence.slice(afterVerbStart + verb[0].length, amount.index).replace(/\b(a|an|its|new|fresh|another|more than|over|nearly|about|around)\b/gi, ''));
  if (!amountRightAfterVerb && !/\b(fund|funding|round|financing|investment|capital|seed|series|led by|backed|investors?)\b/i.test(sentence)) return null;
  return {
    round,
    amount: amount ? amount.text : null,
    currency: amount ? amount.currency : null,
    amountValue: amount ? amount.value : null,
    leadInvestors: leadInvestorsOf(sentence),
    participants: participantsOf(sentence),
  };
}

// ------------------------------------------------------- other extractors

const ROLE_RE = /\b(co-?founders?|founders?|CEO|CTO|COO|CFO|CPO|CRO|chief [a-z]+ officer|president|chair(?:man|woman)?|general counsel|head of [A-Za-z]+|VP of [A-Za-z]+)\b/i;
const PERSON = "[A-Z][a-zà-ÿ'’-]+(?:\\s(?:de|van|von|da|le|la|[A-Z][a-zà-ÿ'’-]+)){1,2}";

function personFrom(sentence, aliases) {
  const patterns = [
    new RegExp(`(${PERSON}),\\s(?:the\\s)?(?:co-?founder|Co-?founder|founder|Founder|CEO|CTO|COO|CFO|CPO|CRO|chief|Chief|president|President|chair|Chair|head of|Head of|VP)`),
    new RegExp(`\\b(?:co-?founder|founder|CEO|CTO|COO|CFO|CPO|president|chair(?:man|woman)?)(?:\\sand\\s(?:CEO|CTO|COO|CFO))?\\s(${PERSON})`),
    new RegExp(`\\b(?:[Cc]o-?)?[Ff]ounded by\\s(${PERSON})`),
  ];
  for (const re of patterns) {
    const m = re.exec(sentence);
    if (!m) continue;
    const name = m[1].trim();
    if (name === aliases.full || name === aliases.short || wordRe(name).test(aliases.full)) continue;
    if (!/^[A-Z]/.test(name)) continue;
    return name;
  }
  return null;
}

const COMPETITOR_RE = /\b(compet(?:e|es|ing|itor|itors|ition)|rivals?|rivalry|alternative to|challenger|takes? on|taking on|versus|vs\.?|head-to-head|market leader)\b/i;
const HEADCOUNT_RE = /\b\d[\d,.]*\+?\s?(?:k\s)?(?:full-time\s)?(employees|staff|people|engineers|researchers|workers|team members|FTEs?)\b|\b(headcount|workforce|employs\s+(?:about|around|over|more than|nearly)?\s?\d|team of\s+(?:about|around|over|more than|nearly)?\s?\d|lay(?:s|ing)? off|laid off|layoffs?|hiring\s+\d)\b/i;

// ------------------------------------------------------- providers

async function curatedProvider(aliases) {
  const queries = [aliases.full, `${aliases.full} funding round investors`];
  if (aliases.short) queries.push(aliases.short);
  const settled = await Promise.allSettled(queries.map((q) => searchCuratedSources(q, { limit: 40, waitMs: 8000 })));
  return settled.flatMap((s) => (s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : []));
}

async function hnProvider(aliases) {
  const r = await searchHackerNews(aliases.full, { limit: 20, timeoutMs: 8000 });
  return (Array.isArray(r) ? r : []).map((x) => ({ ...x, sourceName: 'Hacker News' }));
}

async function webProvider(aliases) {
  // Raw provider results (performSimpleSearch would also run an LLM summary).
  const queries = [`"${aliases.full}" funding round led by`, `"${aliases.full}" CEO founder employees competitors`];
  const settled = await Promise.allSettled(queries.map((q) => performSearch(q, ['web'], { timeoutMs: 12000 })));
  return settled.flatMap((s) => (s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : []))
    .map((x) => ({ ...x, url: x.url || x.link, source: 'web' }));
}

// SEC company list (name -> CIK). Keyless; SEC requires a descriptive User-Agent.
let tickerCache = null;
async function secTickers() {
  if (tickerCache && Date.now() - tickerCache.at < 24 * 3600 * 1000) return tickerCache.list;
  const ua = DATA_PROVIDERS?.government_data?.edgar?.headers?.['User-Agent'] || 'Searchbar3-Research research@example.com';
  const res = await axios.get('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': ua }, timeout: 8000 });
  const list = Object.values(res?.data || {});
  if (list.length) tickerCache = { at: Date.now(), list };
  return list;
}

const CORP_SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|holdings?|group|sa|nv|ag|se|class [a-c]|the)\b/g;
export function normalizeCompany(s) {
  return String(s || '').toLowerCase().replace(/[.,&'’/-]/g, ' ').replace(CORP_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}

async function edgarProvider(aliases) {
  const target = normalizeCompany(aliases.full);
  if (!target) return null;
  const list = await secTickers();
  const hit = list.find((c) => normalizeCompany(c.title) === target);
  if (!hit) return null;
  const cik = String(hit.cik_str);
  const sub = await getFilings(cik);
  if (!sub || !sub.name) return null;
  const recent = sub.filings?.recent || {};
  const filings = [];
  const forms = recent.form || [];
  for (let i = 0; i < forms.length && filings.length < 8; i += 1) {
    if (!/^(10-K|10-Q|8-K|S-1|20-F|40-F|DEF 14A)$/.test(forms[i])) continue;
    const acc = String(recent.accessionNumber?.[i] || '');
    filings.push({
      form: forms[i],
      filingDate: recent.filingDate?.[i] || null,
      reportDate: recent.reportDate?.[i] || null,
      url: acc && recent.primaryDocument?.[i]
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${recent.primaryDocument[i]}`
        : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
    });
  }
  return {
    name: sub.name,
    cik,
    tickers: sub.tickers || (hit.ticker ? [hit.ticker] : []),
    exchanges: sub.exchanges || [],
    sicDescription: sub.sicDescription || null,
    stateOfIncorporation: sub.stateOfIncorporation || null,
    fiscalYearEnd: sub.fiscalYearEnd || null,
    filings,
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
  };
}

async function fmpProvider(aliases) {
  if (!sourceHandlers?.fmp) return [];
  const results = await sourceHandlers.fmp(aliases.full);
  const target = normalizeCompany(aliases.full);
  return (Array.isArray(results) ? results : [])
    .filter((r) => normalizeCompany(String(r.title || '').replace(/\s*\([^)]*\)\s*$/, '')) === target);
}

// ------------------------------------------------------- builder

export async function buildCompanyProfile(rawName, { useCache = true } = {}) {
  const aliases = companyAliases(rawName);
  const key = aliases.full;
  if (useCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.profile;
  }

  const [curatedS, hnS, webS, edgarS, fmpS] = await Promise.allSettled([
    withTimeout(curatedProvider(aliases), PROVIDER_TIMEOUT_MS, []),
    withTimeout(hnProvider(aliases), PROVIDER_TIMEOUT_MS, []),
    withTimeout(webProvider(aliases), PROVIDER_TIMEOUT_MS + 5000, []),
    withTimeout(edgarProvider(aliases), PROVIDER_TIMEOUT_MS, null),
    withTimeout(fmpProvider(aliases), PROVIDER_TIMEOUT_MS, []),
  ]);
  const val = (s, fb) => (s.status === 'fulfilled' && s.value != null ? s.value : fb);
  const curated = val(curatedS, []);
  const hn = val(hnS, []);
  const web = val(webS, []);
  const edgar = val(edgarS, null);
  const fmp = val(fmpS, []);

  // Keep only results that actually concern this company; dedupe by URL.
  const seen = new Set();
  const kept = [];
  for (const r of [...curated, ...web, ...hn]) {
    const url = r?.url || r?.link;
    if (!url || !r?.title) continue;
    const k = String(url).replace(/[?#].*$/, '').replace(/\/$/, '');
    if (seen.has(k)) continue;
    if (!mentionsCompany(r, aliases)) continue;
    seen.add(k);
    kept.push(r);
  }

  const sources = [];
  const sourceNumber = new Map();
  const addSource = (r, typeOverride) => {
    if (sourceNumber.has(r)) return sourceNumber.get(r);
    const n = sources.length + 1;
    sources.push({
      n,
      title: cleanText(r.title),
      url: r.url || r.link,
      sourceName: sourceLabel(r),
      date: formatDate(r.publishedAt || r.date || (r.source === 'hackernews' ? r.timestamp : null)),
      type: typeOverride || r.type || r.source || 'web',
    });
    sourceNumber.set(r, n);
    return n;
  };

  const fundingRounds = [];
  const investors = new Map();
  const keyPeople = [];
  const competitors = [];
  const headcount = [];
  const otherFacts = [];
  const used = new Set();

  const addInvestor = (name, evidence, sourceIndex) => {
    const k = name.toLowerCase();
    const rank = { 'portfolio listing': 3, 'led round': 2, participated: 1 };
    const prev = investors.get(k);
    if (!prev || rank[evidence] > rank[prev.evidence]) investors.set(k, { name, evidence, sourceIndex });
  };

  for (const r of kept.slice(0, MAX_SOURCES)) {
    const n = addSource(r);

    // Portfolio listing: the investor (page owner) lists exactly this company.
    if (r.type === 'portfolio_listing') {
      const listed = cleanText(r.title).replace(/\s+\(portfolio: [^)]*\)$/, '');
      if (listed === aliases.full || (aliases.short && listed === aliases.short)) {
        const investor = String(r.sourceName || '').replace(/\s+(Portfolio|Companies|Feed|RSS)(\s+Page)?$/i, '').trim();
        if (investor) addInvestor(investor, 'portfolio listing', n);
      }
      continue;
    }

    const allowShort = mentionsCompany(r, aliases);
    for (const quote of quotesOf(r)) {
      if (!sentenceMentions(quote, aliases, allowShort)) continue;
      const qk = quote.toLowerCase();
      if (used.has(qk)) continue;

      const funding = parseFundingSentence(quote, aliases, allowShort);
      if (funding) {
        used.add(qk);
        funding.leadInvestors.forEach((inv) => addInvestor(inv, 'led round', n));
        funding.participants.forEach((inv) => addInvestor(inv, 'participated', n));
        // The same rounds is often reported in several places (headline + body,
        // several outlets): merge when the amounts are equal or the round names match.
        const same = fundingRounds.find((fr) => (funding.amountValue && fr.amountValue
          && fr.currency === funding.currency && Math.abs(fr.amountValue - funding.amountValue) < 1e-6 * fr.amountValue
          && (!fr.round || !funding.round || fr.round === funding.round))
          || (funding.round && fr.round === funding.round && fr.sourceIndex === n));
        const entry = {
          round: funding.round,
          amount: funding.amount,
          currency: funding.currency,
          amountValue: funding.amountValue,
          date: sources[n - 1].date,
          leadInvestors: funding.leadInvestors,
          quote,
          sourceIndex: n,
          otherSources: [],
        };
        if (same) {
          // Keep the more detailed quote as primary; both remain cited.
          const richer = (x) => (x.round ? 1 : 0) + (x.amount ? 1 : 0) + x.leadInvestors.length;
          if (richer(entry) > richer(same)) {
            const prev = { quote: same.quote, sourceIndex: same.sourceIndex };
            Object.assign(same, entry, { otherSources: [...same.otherSources, prev] });
          } else if (same.sourceIndex !== n || same.quote !== quote) {
            same.otherSources.push({ quote, sourceIndex: n });
            if (!same.leadInvestors.length && entry.leadInvestors.length) same.leadInvestors = entry.leadInvestors;
          }
        } else {
          fundingRounds.push(entry);
        }
        if (COMPETITOR_RE.test(quote) && competitors.length < 10) competitors.push({ quote, sourceIndex: n });
        continue;
      }
      if (ROLE_RE.test(quote) && keyPeople.length < 12) {
        const name = personFrom(quote, aliases);
        const role = (ROLE_RE.exec(quote) || [])[1] || null;
        if (name || /\bfounded by\b/i.test(quote)) {
          used.add(qk);
          keyPeople.push({ ...(name ? { name } : {}), ...(role ? { role } : {}), quote, sourceIndex: n });
          continue;
        }
      }
      if (HEADCOUNT_RE.test(quote) && headcount.length < 8) {
        used.add(qk);
        headcount.push({ quote, sourceIndex: n });
        continue;
      }
      if (COMPETITOR_RE.test(quote) && competitors.length < 10) {
        used.add(qk);
        competitors.push({ quote, sourceIndex: n });
        continue;
      }
      if (FACT_RE.test(quote) && otherFacts.length < 12) {
        used.add(qk);
        otherFacts.push({ quote, sourceIndex: n });
      }
    }
  }

  // Sources that ended up unused are still listed: they mention the company.
  let publicData = null;
  if (edgar || (fmp && fmp.length)) {
    publicData = { sec: null, market: [] };
    if (edgar) {
      const n = addSource({ title: `${edgar.name} — SEC EDGAR filings (CIK ${edgar.cik})`, url: edgar.url, sourceName: 'SEC EDGAR', publishedAt: edgar.filings[0]?.filingDate || null }, 'sec_filing');
      publicData.sec = { ...edgar, sourceIndex: n };
    }
    for (const f of fmp || []) {
      const n = addSource({ title: f.title, url: f.url, sourceName: 'Financial Modeling Prep' }, 'market_data');
      publicData.market.push({ title: cleanText(f.title), quote: cleanText(f.content), sourceIndex: n });
    }
  }

  fundingRounds.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  fundingRounds.forEach((fr) => { delete fr.amountValue; });

  const profile = {
    name: aliases.full,
    generatedAt: new Date().toISOString(),
    sources,
    fundingRounds,
    investors: [...investors.values()],
    keyPeople,
    competitors,
    headcount,
    otherFacts,
    publicData,
    coverage: {
      curated: kept.filter((r) => r.source === 'curated').length,
      web: kept.filter((r) => r.source !== 'curated' && r.source !== 'hackernews').length,
      hn: kept.filter((r) => r.source === 'hackernews').length,
      total: kept.length,
    },
  };
  if (useCache) cache.set(key, { at: Date.now(), profile });
  return profile;
}

export default buildCompanyProfile;
