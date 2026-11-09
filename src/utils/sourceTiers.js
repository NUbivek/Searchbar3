/**
 * Source quality tiers for diligence: filings > reputable press > blogs >
 * forums. Uses the project's reputation table (SourceReputationScorer) for
 * press, the curated registry's own categories, and known domains.
 *
 * The host decides first: a sec.gov filing or a TechCrunch article found
 * through Hacker News is a filing or press, not "forum". The retrieving
 * source only decides when the host says nothing.
 */
import { SOURCE_REPUTATION_DB } from '../components/search/sources/SourceReputationScorer';

export const TIERS = {
  filing: { rank: 1, label: 'Filing / official' },
  press: { rank: 2, label: 'Reputable press' },
  blog: { rank: 3, label: 'Blog / newsletter' },
  forum: { rank: 4, label: 'Forum / social' },
  other: { rank: 3, label: 'Other web' },
};

const FILING_DOMAINS = /(^|\.)(sec\.gov|gov|europa\.eu|companieshouse\.gov\.uk|find-and-update\.company-information\.service\.gov\.uk)$/;
const FORUM_DOMAINS = /(^|\.)(reddit\.com|news\.ycombinator\.com|twitter\.com|x\.com|bsky\.app|quora\.com|stocktwits\.com|facebook\.com|linkedin\.com)$/;
const BLOG_DOMAINS = /(^|\.)(medium\.com|substack\.com|wordpress\.com|blogspot\.com|ghost\.io|beehiiv\.com)$/;
const FILING_SOURCES = ['sec', 'edgar', 'fmp', 'fred'];
const FORUM_SOURCES = ['hackernews', 'reddit', 'twitter', 'x', 'linkedin'];

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** @returns {'filing'|'press'|'blog'|'forum'|'other'} */
export function sourceTier(result = {}) {
  const source = String(result.source || '').toLowerCase();
  if (source === 'file') return 'other';

  // 1. The host of the page itself
  const host = hostOf(result.url || result.link);
  if (host) {
    if (FILING_DOMAINS.test(host)) return 'filing';
    if (FORUM_DOMAINS.test(host)) return 'forum';
    if (BLOG_DOMAINS.test(host)) return 'blog';
    const rep = SOURCE_REPUTATION_DB[host];
    if (rep && ['news', 'business', 'tech', 'educational', 'government'].includes(rep.category)) {
      return rep.category === 'government' ? 'filing' : 'press';
    }
    if (rep && rep.category === 'blog') return 'blog';
  }

  // 2. What the retrieving source knows about it
  if (FILING_SOURCES.includes(source)) return 'filing';
  if (source === 'curated') {
    const category = String(result.sourceCategory || result.metadata?.category || '');
    if (/news|funding/.test(category)) return 'press';
    if (/portfolio|investor|accelerator/.test(category)) return 'press'; // first-party investor listings
    return 'blog'; // market analysis, engineering and company blogs
  }
  if (FORUM_SOURCES.includes(source)) return 'forum';
  return 'other';
}

/** Only filings, official records and market data count as verified. */
export function isVerifiedSource(result = {}) {
  return sourceTier(result) === 'filing';
}

export function tierInfo(result) {
  const tier = sourceTier(result);
  return { tier, ...TIERS[tier] };
}

/** Stable sort: better tiers first, original order within a tier. */
export function sortByTier(results = []) {
  return results
    .map((r, i) => ({ r, i, rank: TIERS[sourceTier(r)].rank }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ r }) => r);
}

/**
 * Keep results published within maxAgeDays. Undated results are kept but
 * marked `undated: true` so the UI can show that the date is unknown.
 */
export function filterByAge(results = [], maxAgeDays = 0) {
  if (!maxAgeDays) return results;
  const cutoff = Date.now() - maxAgeDays * 86400000;
  return results.filter((r) => {
    const t = Date.parse(r.publishedAt || r.date || r.timestamp || '');
    if (Number.isNaN(t)) {
      r.undated = true;
      return true;
    }
    return t >= cutoff;
  });
}
