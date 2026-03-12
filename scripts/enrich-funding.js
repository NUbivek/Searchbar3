#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { inferFundingSignals, inferInvestorSignals } = require('../src/sourcing/enrichment');

const DATA_DIR = path.join(process.cwd(), 'data');
const SIGNALS_PATH = path.join(DATA_DIR, 'signals.jsonl');
const CACHE_PATH = path.join(DATA_DIR, 'funding_cache.json');
const REQUEST_TIMEOUT_MS = 8000;
const COMPANY_DELAY_MS = 1500;
const FUNDING_KEYWORD_RE = /raised|raises|funding|round|million|billion|seed|series\s*[a-d]|backed|invests|investment|secures|closes/i;

function parseArgs(argv) {
  const out = { limit: null, highOnly: false, dryRun: false, domains: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') {
      out.limit = Number(argv[i + 1] || 0) || null;
      i += 1;
    } else if (arg === '--high-only') {
      out.highOnly = true;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--domains') {
      out.domains = String(argv[i + 1] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      i += 1;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFetch() {
  const mod = await import('node-fetch');
  return mod.default;
}

async function fetchText(url, headers = {}) {
  const fetch = await getFetch();
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function loadSignals() {
  return fs.readFileSync(SIGNALS_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  fs.writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRoundType(value) {
  const v = String(value || '').trim().toLowerCase().replace(/[_-]/g, ' ');
  if (!v) return 'Unknown';
  if (v.includes('pre seed')) return 'Pre-Seed';
  if (v === 'seed' || v.includes(' seed')) return 'Seed';
  if (v.includes('series a')) return 'Series A';
  if (v.includes('series b')) return 'Series B';
  if (v.includes('series c')) return 'Series C';
  if (v.includes('series d') || v.includes('series e') || v.includes('growth')) return 'Series D+';
  if (v.includes('grant')) return 'Grant';
  return 'Unknown';
}

function amountLooksSane(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 10000) return null;
  if (n > 50000000000) return null;
  return Math.round(n);
}

function monthStringFromDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function stripTags(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function domainRoot(domain) {
  return String(domain || '').split('.')[0].toLowerCase().replace(/-/g, '');
}

function titleCase(value) {
  return String(value || '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function canonicalCompanyName(name, domain) {
  const rawName = String(name || '').trim();
  const root = domainRoot(domain);
  if (!rawName) return titleCase(root);
  const compact = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const rootCompact = root.replace(/[^a-z0-9]/g, '');
  if (compact === `${rootCompact}com` || compact === `${rootCompact}io` || compact === `${rootCompact}ai` || compact === `${rootCompact}co`) {
    return titleCase(root);
  }
  return rawName;
}

function isConfidentMatch(articleTitle, companyName, domain) {
  const t = normalizeText(articleTitle);
  const root = domainRoot(domain);
  const nameWords = normalizeName(companyName)
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const allWordsMatch = nameWords.length > 0 && nameWords.every((w) => t.includes(w));
  const rootMatch = root.length > 3 && t.includes(root);
  if (!allWordsMatch && !rootMatch) return false;
  if (!FUNDING_KEYWORD_RE.test(articleTitle)) return false;
  return true;
}

function looksLikeValuationHeadline(title, parsedAmount) {
  return /valuation/i.test(String(title || '')) && Number(parsedAmount || 0) >= 1000000000;
}

function parseFundingText(text, { source, title, publishedAt }) {
  const funding = inferFundingSignals(text);
  if (funding.funding_signal !== 'present') return null;
  const amount = amountLooksSane(funding.funding_amount_guess);
  if (!amount) return null;
  const investorInfo = inferInvestorSignals(text);
  return {
    last_funding_amount_usd: amount,
    last_funding_round: normalizeRoundType(funding.funding_round_guess),
    last_funding_date: monthStringFromDate(publishedAt),
    total_funding_usd: amount,
    investors: investorInfo.investor_list_guess || [],
    funding_source: source,
    confidence: source === 'Google News' || source === 'TechCrunch' ? 'medium' : 'low',
    _debug_source: source,
    _debug_title: title,
    _debug_raw: text.slice(0, 800),
  };
}

async function fetchGoogleNews(companyName, companyDomain) {
  const query = encodeURIComponent(`"${companyName}" funding raised`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchText(url, { Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' });
  const items = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/g)]
    .map((m) => ({
      title: stripTags(m[1]),
      description: stripTags(m[2]),
      pubDate: String(m[3] || '').trim(),
    }));
  for (const item of items) {
    if (!isConfidentMatch(item.title, companyName, companyDomain)) continue;
    const parsed = parseFundingText(`${item.title}. ${item.description}`, {
      source: 'Google News',
      title: item.title,
      publishedAt: item.pubDate,
    });
    if (parsed && looksLikeValuationHeadline(item.title, parsed.last_funding_amount_usd)) continue;
    if (parsed) return parsed;
  }
  return null;
}

async function fetchTechCrunch(companyName, companyDomain) {
  const xml = await fetchText('https://techcrunch.com/feed/', { Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' });
  const items = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/g)]
    .map((m) => ({
      title: stripTags(m[1]),
      description: stripTags(m[2]),
      pubDate: String(m[3] || '').trim(),
    }));
  for (const item of items) {
    if (!isConfidentMatch(item.title, companyName, companyDomain)) continue;
    const parsed = parseFundingText(`${item.title}. ${item.description}`, {
      source: 'TechCrunch',
      title: item.title,
      publishedAt: item.pubDate,
    });
    if (parsed && looksLikeValuationHeadline(item.title, parsed.last_funding_amount_usd)) continue;
    if (parsed) return parsed;
  }
  return null;
}

async function fetchCompanyNews(companyName, companyDomain) {
  const urls = [
    `https://${companyDomain}/press`,
    `https://${companyDomain}/news`,
    `https://${companyDomain}`,
  ];
  for (const url of urls) {
    try {
      const html = await fetchText(url);
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = stripTags(titleMatch ? titleMatch[1] : companyName);
      if (!isConfidentMatch(title, companyName, companyDomain) && !normalizeText(html).includes(normalizeName(companyName))) continue;
      const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
      const text = `${title}. ${stripTags(ogDescMatch ? ogDescMatch[1] : '')}. ${stripTags(html).slice(0, 3000)}`;
      const parsed = parseFundingText(text, {
        source: 'Company News',
        title,
        publishedAt: null,
      });
      if (parsed) return parsed;
    } catch {}
  }
  return null;
}

function emptyResult() {
  return {
    last_funding_amount_usd: null,
    last_funding_round: 'Unknown',
    last_funding_date: null,
    total_funding_usd: null,
    investors: [],
    funding_source: 'not found',
    confidence: 'not_found',
    _debug_source: null,
    _debug_title: null,
    _debug_raw: '',
  };
}

function cacheIsFresh(entry) {
  return entry && typeof entry === 'object' && entry.confidence && entry.confidence !== 'stale';
}

function collectTargets(signals, cache, options) {
  const byDomain = new Map();
  for (const sig of signals) {
    const companyDomain = String(sig.company_domain || '').trim().toLowerCase();
    if (!companyDomain) continue;
    if (options.domains.length && !options.domains.includes(companyDomain)) continue;
    if (options.highOnly && sig.signal_weight !== 'high') continue;
    if (!options.domains.length && cacheIsFresh(cache[companyDomain])) continue;
    const existing = byDomain.get(companyDomain);
    const next = {
      companyDomain,
      companyName: canonicalCompanyName(sig.company_name, companyDomain),
      signalWeight: sig.signal_weight || 'low',
    };
    if (!existing) {
      byDomain.set(companyDomain, next);
      continue;
    }
    const rank = { high: 3, medium: 2, low: 1 };
    if ((rank[next.signalWeight] || 0) > (rank[existing.signalWeight] || 0)) {
      byDomain.set(companyDomain, next);
    }
  }
  const targets = [...byDomain.values()].sort((a, b) => a.companyName.localeCompare(b.companyName));
  return options.limit ? targets.slice(0, options.limit) : targets;
}

async function enrichCompany(target) {
  const attempts = [
    () => fetchGoogleNews(target.companyName, target.companyDomain),
    () => fetchTechCrunch(target.companyName, target.companyDomain),
    () => fetchCompanyNews(target.companyName, target.companyDomain),
  ];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result && result.confidence !== 'not_found') return result;
    } catch {}
  }
  return emptyResult();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const signals = loadSignals();
  const cache = loadCache();
  const targets = collectTargets(signals, cache, options);

  if (options.dryRun) {
    console.log(`Would enrich ${targets.length} companies:`);
    targets.forEach((target, idx) => {
      console.log(`${idx + 1}. ${target.companyName} | ${target.companyDomain} | ${target.signalWeight}`);
    });
    return;
  }

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const result = await enrichCompany(target);
    cache[target.companyDomain] = {
      last_funding_amount_usd: result.last_funding_amount_usd,
      last_funding_round: result.last_funding_round,
      last_funding_date: result.last_funding_date,
      total_funding_usd: result.total_funding_usd,
      investors: result.investors,
      funding_source: result.funding_source,
      confidence: result.confidence,
      enriched_at: new Date().toISOString(),
      _debug_source: result._debug_source,
      _debug_title: result._debug_title,
      _debug_raw: result._debug_raw,
    };
    writeCache(cache);
    console.log(`${i + 1}/${targets.length} ${target.companyName} | ${target.companyDomain} | ${result.confidence} | ${result.funding_source} | ${result._debug_title || 'no match'}`);
    await sleep(COMPANY_DELAY_MS);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
