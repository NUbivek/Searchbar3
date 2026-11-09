/**
 * MeasuredMetrics.js
 *
 * Implements docs/METRICS_SYSTEM.md with every component MEASURED from
 * evidence the result actually contains. A component with no evidence is
 * reported as "not measured" (value null) and its weight is redistributed to
 * the measured components of the same metric; it is never filled with a
 * default such as 0.5. Each component returns { value, measured, evidence }.
 *
 * Components and weights (from the calculators / METRICS_SYSTEM.md):
 *   Relevance   = query match .40, recency .35, content quality .15, domain .10
 *                 (+ personalization when user preferences are supplied)
 *   Accuracy    = data verification .30, source reliability .30,
 *                 factual consistency .25, external validation .15
 *   Credibility = source reputation .40, author expertise .25,
 *                 citation quality .20, verification factors .15
 *   Overall     = context-weighted average (Financial 30/40/30, Medical
 *                 25/40/35, News 40/30/30, Technical 35/40/25,
 *                 Academic 25/35/40, General 33/33/34)
 *
 * Cross-source components (factual consistency, external validation) use a
 * corpus built once per result set with buildCorpus().
 */
import { SOURCE_REPUTATION_DB } from '../sources/SourceReputationScorer';
import { CONTEXT_WEIGHTS } from './utils/calculatorData';
import { sourceTier } from '../../../utils/sourceTiers';
import { extractClaims } from '../../../utils/claimCheck';

export const COMPONENT_WEIGHTS = {
  relevance: { queryMatch: 0.40, recency: 0.35, contentQuality: 0.15, domainRelevance: 0.10, personalization: 0.10 },
  accuracy: { dataVerification: 0.30, sourceReliability: 0.30, factualConsistency: 0.25, externalValidation: 0.15 },
  credibility: { sourceReputation: 0.40, authorExpertise: 0.25, citationQuality: 0.20, verificationFactors: 0.15 },
};

const GENERAL_WEIGHTS = { RELEVANCE: 0.33, ACCURACY: 0.33, CREDIBILITY: 0.34 };
const STOPWORDS = new Set('a an and are as at be by for from has have how in into is it its of on or that the this to was were what when where which who why will with about vs'.split(' '));
const CREDENTIALS = /\b(phd|ph\.d|md|jd|mba|cfa|cpa|professor|dr\.|analyst|economist|reporter|editor|correspondent|partner|researcher)\b/i;
const ATTRIBUTION = /\b(according to|said in a statement|told [A-Z]|said\b|announced|reported|filed with|data from|per a|in a filing|press release|spokesperson|source:)/gi;
const MONEY = /(?:[$€£]|USD|EUR)\s?\d[\d,.]*\s?(?:k|m|mn|b|bn|million|billion|thousand)?/gi;
const PERCENT = /\d+(?:\.\d+)?\s?%/g;
const DATE_MENTION = /\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/gi;
const PEER_REVIEW = /peer[- ]reviewed|refereed|doi\.org|doi:|published in the journal/i;
const DOMAIN_TOPICS = {
  financial: /bloomberg|wsj|ft\.com|reuters|cnbc|marketwatch|sec\.gov|morningstar|barrons|economist/,
  business: /techcrunch|crunchbase|forbes|businessinsider|hbr\.org|fortune|axios|theinformation|sifted|pitchbook|venturebeat/,
  technical: /arstechnica|theverge|wired|github|stackoverflow|ieee|acm\.org|arxiv|huggingface/,
};
const CURATED_TOPIC = {
  financial: /funding|investor|portfolio|venture|market_analysis/,
  business: /funding|startup|venture|portfolio|investor|accelerator|market_analysis|saas|fintech|ecosystem|news/,
  technical: /developer|engineering|ai_|infrastructure|tools/,
};

const text = (r) => `${r.title || ''}. ${r.content || r.snippet || ''}`.replace(/\s+/g, ' ').trim();
const body = (r) => String(r.content || r.snippet || '').replace(/\s+/g, ' ').trim();
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const clamp = (v) => Math.max(0, Math.min(1, v));
const measured = (value, evidence) => ({ value: clamp(value), measured: true, evidence });
const notMeasured = (evidence) => ({ value: null, measured: false, evidence });
const terms = (q) => (String(q || '').toLowerCase().match(/[a-z0-9][a-z0-9.+&'-]*/g) || []).filter((t) => !STOPWORDS.has(t) && t.length > 1);
const wordIn = (term, hay) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(hay);
const dateOf = (r) => { const t = Date.parse(r.publishedAt || r.date || r.publishedDate || r.timestamp || r.metadata?.date || ''); return Number.isNaN(t) ? null : t; };
const pct = (v) => `${Math.round(v * 100)}%`;

function reputationEntry(host) {
  if (!host) return null;
  if (SOURCE_REPUTATION_DB[host]) return { ...SOURCE_REPUTATION_DB[host], matched: host };
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i += 1) {
    const parent = parts.slice(i).join('.');
    if (SOURCE_REPUTATION_DB[parent]) return { ...SOURCE_REPUTATION_DB[parent], matched: parent };
  }
  const suffix = `.${parts[parts.length - 1]}`;
  if (SOURCE_REPUTATION_DB[suffix] && ['.gov', '.edu'].includes(suffix)) return { ...SOURCE_REPUTATION_DB[suffix], matched: suffix };
  return null;
}

// ---------------------------------------------------------------- relevance
function queryMatch(r, query) {
  const qs = terms(query);
  if (qs.length === 0) return notMeasured('empty query');
  const title = String(r.title || '').toLowerCase();
  const hay = text(r).toLowerCase();
  const inText = qs.filter((t) => wordIn(t, hay));
  const inTitle = qs.filter((t) => wordIn(t, title));
  const phrase = qs.length > 1 && hay.includes(qs.join(' '));
  const value = 0.6 * (inText.length / qs.length) + 0.3 * (inTitle.length / qs.length) + (phrase ? 0.1 : 0);
  return measured(value, `${inText.length}/${qs.length} query terms in text, ${inTitle.length} in title${phrase ? ', exact phrase' : ''}`);
}

function recency(r) {
  const t = dateOf(r);
  if (t == null) return notMeasured('no publication date');
  const days = (Date.now() - t) / 86400000;
  const value = days < 7 ? 1 : days < 30 ? 0.9 : days < 90 ? 0.8 : days < 180 ? 0.7 : days < 365 ? 0.6 : days < 730 ? 0.4 : days < 1095 ? 0.3 : 0.2;
  return measured(value, `published ${new Date(t).toISOString().slice(0, 10)} (${Math.max(0, Math.round(days))} days ago)`);
}

function contentQuality(r) {
  const b = body(r);
  if (!b) return notMeasured('no text');
  const n = b.length;
  let value = n < 80 ? 0.2 : n < 200 ? 0.4 : n < 600 ? 0.6 : n < 1500 ? 0.8 : 1;
  const specifics = (b.match(MONEY) || []).length + (b.match(PERCENT) || []).length;
  if (specifics > 0) value += 0.1;
  return measured(value, `${n} characters of text${specifics ? `, ${specifics} figures` : ''}`);
}

function domainRelevance(r, ctx) {
  const topic = ctx.isFinancialQuery ? 'financial' : ctx.isBusinessQuery ? 'business' : ctx.isTechnicalQuery ? 'technical' : null;
  if (!topic) return notMeasured('query has no specific domain context');
  if (r.source === 'curated') {
    const category = String(r.sourceCategory || r.metadata?.category || '');
    if (!category) return notMeasured('curated source without category');
    const hit = CURATED_TOPIC[topic].test(category);
    return measured(hit ? 1 : 0.4, `curated category "${category}" ${hit ? 'matches' : 'does not match'} ${topic} query`);
  }
  const host = hostOf(r.url || r.link);
  for (const [name, re] of Object.entries(DOMAIN_TOPICS)) {
    if (re.test(host)) return measured(name === topic ? 1 : 0.4, `${host} is a ${name} source; query is ${topic}`);
  }
  return notMeasured(`${host || 'source'} has no known topical focus`);
}

function personalization(r, prefs) {
  if (!prefs || !Array.isArray(prefs.preferredDomains) || prefs.preferredDomains.length === 0) return notMeasured('no user preferences');
  const host = hostOf(r.url || r.link);
  const hit = prefs.preferredDomains.some((d) => host.endsWith(String(d).toLowerCase()));
  return measured(hit ? 1 : 0.5, hit ? `${host} is a preferred source` : `${host} is not in preferred sources`);
}

// ----------------------------------------------------------------- accuracy
function dataVerification(r) {
  const b = text(r);
  if (b.length < 40) return notMeasured('too little text to check');
  const money = (b.match(MONEY) || []).length;
  const percents = (b.match(PERCENT) || []).length;
  const dates = (b.match(DATE_MENTION) || []).length;
  const attributions = (b.match(ATTRIBUTION) || []).length;
  const count = money + percents + dates + attributions;
  return measured(count / 4, `${count} verifiable specifics (${money} amounts, ${percents} percentages, ${dates} dates, ${attributions} attributions)`);
}

function reliabilityFromSource(r) {
  const tier = sourceTier(r);
  const host = hostOf(r.url || r.link);
  if (tier === 'filing') return { value: 0.95, why: `${host || r.source} is an official filing / government source` };
  if (r.source === 'curated') {
    const t = r.metadata?.tier;
    const v = { A: 0.85, B: 0.8, C: 0.75 }[t];
    if (v) return { value: tier === 'press' ? v : v - 0.1, why: `curated registry source, tier ${t} (${tier})` };
  }
  const rep = reputationEntry(host);
  if (rep) return { value: rep.reputation / 100, why: `${rep.matched} reputation ${rep.reputation}/100 (${rep.tier})` };
  if (tier === 'forum') return { value: 0.35, why: `${host || r.source} is a forum / social source` };
  if (tier === 'blog') return { value: 0.55, why: `${host} is a blog / newsletter platform` };
  return null;
}

function sourceReliability(r) {
  const rel = reliabilityFromSource(r);
  return rel ? measured(rel.value, rel.why) : notMeasured(`no reliability record for ${hostOf(r.url || r.link) || r.source || 'source'}`);
}

function factualConsistency(r, corpus) {
  const key = r.url || r.link;
  const statuses = corpus?.claimStatusByUrl?.get(key) || [];
  const comparable = statuses.filter((s) => s !== 'single-source');
  if (comparable.length === 0) {
    return notMeasured(statuses.length ? 'its figures appear in no other source' : 'no checkable figures');
  }
  const agree = comparable.filter((s) => s === 'corroborated').length;
  return measured(agree / comparable.length, `${agree}/${comparable.length} figures agree with other sources${agree < comparable.length ? ' (conflict found)' : ''}`);
}

function externalValidation(r, corpus) {
  // An official filing is the primary record itself; outside coverage is
  // not what validates it.
  if (sourceTier(r) === 'filing') return measured(0.9, 'official primary record (regulatory filing)');
  if (!corpus || corpus.size < 2) return notMeasured('only one source in this search');
  const others = corpus.corroboratingHosts.get(r.url || r.link) || new Set();
  const n = others.size;
  return measured(n === 0 ? 0.3 : n === 1 ? 0.7 : 1, n === 0 ? 'no other site reports the same story' : `also reported by ${[...others].slice(0, 3).join(', ')}`);
}

// -------------------------------------------------------------- credibility
function sourceReputation(r) {
  const rel = reliabilityFromSource(r);
  return rel ? measured(rel.value, rel.why) : notMeasured(`${hostOf(r.url || r.link) || 'source'} is not in the reputation database`);
}

function authorExpertise(r) {
  const author = r.author || r.authorDetails?.name || r.metadata?.author;
  if (!author) return notMeasured('no author information');
  const credentials = CREDENTIALS.test(String(author)) || CREDENTIALS.test(String(r.authorDetails?.title || ''));
  return measured(credentials ? 0.85 : 0.6, credentials ? `author ${author} has stated credentials` : `named author ${author}`);
}

function citationQuality(r) {
  const b = body(r);
  if (b.length < 150) return notMeasured('snippet too short to judge citations');
  const attributions = (b.match(ATTRIBUTION) || []).length;
  const quotes = (b.match(/["“][^"”]{15,}["”]/g) || []).length;
  const links = (b.match(/https?:\/\//g) || []).length;
  const signals = attributions + quotes + links;
  return measured(signals / 4, `${signals} citation signals (${attributions} attributions, ${quotes} quotes, ${links} links)`);
}

function verificationFactors(r) {
  const tier = sourceTier(r);
  const peer = PEER_REVIEW.test(text(r));
  const base = { filing: 1, press: 0.8, blog: 0.45, forum: 0.2 }[tier];
  if (base == null && !peer) return notMeasured('editorial process unknown');
  const value = Math.max(base ?? 0, peer ? 0.9 : 0);
  const label = { filing: 'regulated filing', press: 'editorial publication', blog: 'self-published blog', forum: 'user-generated forum' }[tier];
  return measured(value, `${label || 'unknown source type'}${peer ? ', peer-review indicators present' : ''}`);
}

// ------------------------------------------------------------- aggregation
function aggregate(components, weights) {
  let sum = 0;
  let weight = 0;
  let total = 0;
  for (const [name, w] of Object.entries(weights)) {
    if (!components[name]) continue;
    total += w;
    if (components[name].measured) {
      sum += components[name].value * w;
      weight += w;
    }
  }
  return { value: weight > 0 ? sum / weight : null, coverage: total > 0 ? weight / total : 0 };
}

export function contextWeights(ctx = {}) {
  if (ctx.isFinancialQuery) return CONTEXT_WEIGHTS.FINANCIAL;
  if (ctx.isMedicalQuery) return CONTEXT_WEIGHTS.MEDICAL;
  if (ctx.isNewsQuery) return CONTEXT_WEIGHTS.NEWS;
  if (ctx.isTechnicalQuery) return CONTEXT_WEIGHTS.TECHNICAL;
  if (ctx.isAcademicQuery) return CONTEXT_WEIGHTS.ACADEMIC;
  return GENERAL_WEIGHTS;
}

const significant = (title) => new Set(terms(title).filter((t) => t.length > 3));

/** Cross-source facts for a result set: claim agreement and story overlap. */
export function buildCorpus(results = []) {
  const list = results.filter((r) => r && (r.url || r.link));
  const claimStatusByUrl = new Map();
  const groups = new Map();
  list.forEach((r, i) => {
    for (const c of extractClaims(r, i + 1)) {
      const key = `${c.key}|${c.currency}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...c, url: r.url || r.link });
    }
  });
  for (const items of groups.values()) {
    for (const c of items) {
      const sameSite = (o) => o.site === c.site;
      const agree = items.some((o) => !sameSite(o) && Math.abs(o.amount - c.amount) / Math.max(o.amount, c.amount) <= 0.05);
      const disagree = items.some((o) => !sameSite(o) && Math.abs(o.amount - c.amount) / Math.max(o.amount, c.amount) > 0.05);
      const status = disagree ? 'conflict' : agree ? 'corroborated' : 'single-source';
      if (!claimStatusByUrl.has(c.url)) claimStatusByUrl.set(c.url, []);
      claimStatusByUrl.get(c.url).push(status);
    }
  }
  // Same story elsewhere: >=50% of significant title words shared with a
  // result from a different site.
  const corroboratingHosts = new Map();
  const titles = list.map((r) => ({ url: r.url || r.link, host: hostOf(r.url || r.link), words: significant(r.title) }));
  for (const a of titles) {
    const hosts = new Set();
    if (a.words.size >= 2) {
      for (const b of titles) {
        if (b.host === a.host || b.words.size < 2) continue;
        const shared = [...a.words].filter((w) => b.words.has(w)).length;
        if (shared / Math.min(a.words.size, b.words.size) >= 0.5) hosts.add(b.host);
      }
    }
    corroboratingHosts.set(a.url, hosts);
  }
  return { size: list.length, claimStatusByUrl, corroboratingHosts };
}

/**
 * Measure one result. Scores are 0-1 or null (no measurable evidence).
 * @param {Object} result
 * @param {string} query
 * @param {{ context?: Object, corpus?: Object, userPreferences?: Object }} options
 */
export function measureResult(result, query, options = {}) {
  const ctx = options.context || {};
  const corpus = options.corpus || null;
  const components = {
    relevance: {
      queryMatch: queryMatch(result, query),
      recency: recency(result),
      contentQuality: contentQuality(result),
      domainRelevance: domainRelevance(result, ctx),
      personalization: personalization(result, options.userPreferences),
    },
    accuracy: {
      dataVerification: dataVerification(result),
      sourceReliability: sourceReliability(result),
      factualConsistency: factualConsistency(result, corpus),
      externalValidation: externalValidation(result, corpus),
    },
    credibility: {
      sourceReputation: sourceReputation(result),
      authorExpertise: authorExpertise(result),
      citationQuality: citationQuality(result),
      verificationFactors: verificationFactors(result),
    },
  };
  const rel = aggregate(components.relevance, COMPONENT_WEIGHTS.relevance);
  const acc = aggregate(components.accuracy, COMPONENT_WEIGHTS.accuracy);
  const cred = aggregate(components.credibility, COMPONENT_WEIGHTS.credibility);

  const w = contextWeights(ctx);
  const parts = [[rel.value, w.RELEVANCE], [acc.value, w.ACCURACY], [cred.value, w.CREDIBILITY]].filter(([v]) => v != null);
  const wsum = parts.reduce((s, [, x]) => s + x, 0);
  const overall = wsum > 0 ? parts.reduce((s, [v, x]) => s + v * x, 0) / wsum : null;

  const all = [...Object.values(components.relevance), ...Object.values(components.accuracy), ...Object.values(components.credibility)];
  return {
    relevance: rel.value,
    accuracy: acc.value,
    credibility: cred.value,
    overall,
    coverage: {
      relevance: rel.coverage,
      accuracy: acc.coverage,
      credibility: cred.coverage,
      measuredComponents: all.filter((c) => c.measured).length,
      totalComponents: all.length,
    },
    weights: w,
    components,
  };
}

/** Human-readable breakdown for tooltips. */
export function describeMetric(metrics, metric) {
  const comps = metrics?.components?.[metric];
  if (!comps) return '';
  const lines = Object.entries(comps).map(([name, c]) => {
    const label = name.replace(/([A-Z])/g, ' $1').toLowerCase();
    return c.measured ? `${label}: ${pct(c.value)} (${c.evidence})` : `${label}: not measured (${c.evidence})`;
  });
  return lines.join('\n');
}
