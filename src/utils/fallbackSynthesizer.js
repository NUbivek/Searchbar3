/**
 * Fallback Synthesizer
 *
 * Used when no LLM is configured or the LLM call fails. It produces an
 * response in the standard section structure (SUMMARY, KEY POINTS, DETAILED
 * ANALYSIS, DIFFERENT PERSPECTIVES, FOLLOW-UP QUESTIONS), filled only with
 * sentences quoted from the search results and cited to them. It never
 * writes claims of its own (the previous version filled these sections with
 * generic template prose and citations that did not match the sources).
 *
 * The response shape is unchanged: { content, query, followUpQuestions,
 * sourceMap, categories, metadata } plus the LLM flags the UI expects.
 */
const resultDetector = require('./llm/resultDetector');
const { FUNDING_RE, FACT_RE, cleanText, formatDate, sourceLabel } = require('./evidence');

// Same numbering as the ranked list the UI shows (15 results plus the
// user's own documents); the caller already capped it.
const MAX_SOURCES = 25;
const MAX_POINTS = 8;

// What the user asked, detected from the query when the caller gives no plan
const INTENT_RES = {
  funding: /\b(funding|fundraise|fundraising|raise[sd]?|raising|round|valuation|valued|investors?|investments?|backers?|series\s?[a-h]|seed|pre-seed|capital)\b/i,
  competitors: /\b(competitors?|competition|competitive|rivals?|alternatives?|versus|vs\.?|compared?|comparison|landscape)\b/i,
  team: /\b(founders?|co-?founders?|founded|ceo|cto|cfo|team|leadership|executives?|management|hires?|hired|people)\b/i,
  financials: /\b(revenue|arr|mrr|profit|profitable|margin|burn|growth|financials?|earnings|ebitda|customers?|users)\b/i,
  product: /\b(products?|launch(?:es|ed)?|features?|platform|technology|roadmap|releases?)\b/i,
  legal: /\b(lawsuits?|sued|litigation|regulators?|regulatory|fines?|investigation|antitrust)\b/i,
};
const detectIntents = (query) => Object.entries(INTENT_RES).filter(([, re]) => re.test(String(query || ''))).map(([name]) => name);
const STOPWORDS = new Set('a an and are as at be by for from has have how in into is it its of on or that the this to was were what when where which who why will with about vs'.split(' '));
function queryTerms(query) {
  return (String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9.+&'-]*/g) || [])
    .filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/**
 * Rank a result's sentences by relevance. ctx (from the query plan):
 *   entityTest(sentence) -> true when the sentence names the entity
 *   intentRes            -> regexes for what the user asked (funding, team...)
 * In entity mode a sentence must name the entity. The title is a candidate
 * too (many news/HN results are headline-only).
 */
function rankedSentences(result, terms, ctx = {}) {
  const text = cleanText(result.snippet);
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length >= 20 && s.length <= 400);
  const title = cleanText(result.title);
  const candidates = sentences.map((sentence, position) => ({ sentence, position }));
  if (title.length >= 20 && !sentences.some((x) => x.includes(title))) candidates.push({ sentence: title, position: -1 });
  return candidates
    .map(({ sentence, position }) => {
      const lower = sentence.toLowerCase();
      if (ctx.entityTest && !ctx.entityTest(sentence)) return { sentence, position, score: 0 };
      let score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0) + (ctx.entityTest ? 2 : 0);
      for (const re of ctx.intentRes || []) if (re.test(sentence)) score += 2;
      if (FUNDING_RE.test(sentence)) score += 0.5;
      if (FACT_RE.test(sentence)) score += 0.5;
      return { sentence, position, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.position - b.position);
}

/** Pick the most query-relevant sentence from a result (title as fallback). */
function bestSentence(result, terms, ctx) {
  const [top] = rankedSentences(result, terms, ctx);
  if (top) return top.sentence;
  const title = cleanText(result.title);
  return title.length >= 10 ? title : null;
}

const normSentence = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function primaryEntity(query) {
  // "Acme Robotics Series B" -> "Acme Robotics": stop at funding words.
  const trimmed = String(query || '').split(/\b(?:Series|Seed|Pre-seed|Round|Funding|Raise|Valuation|IPO)\b/i)[0];
  const names = (trimmed.match(/[A-Z][A-Za-z0-9.&'-]*(?:\s+[A-Z][A-Za-z0-9.&'-]*)*/g) || [])
    .filter((n) => n.length > 1);
  return names[0] || null;
}

/**
 * Diligence questions that go one step past what the user asked: a funding
 * query gets valuation / investors / use of proceeds, a competitor query
 * gets positioning and pricing, a team query gets key hires. The user's own
 * question is never asked back. Each topic's questions are tagged so the
 * generic set skips the topics already asked about.
 */
const FOLLOW_UPS = {
  funding: (e) => [
    `Who led ${e}'s most recent round, and at what valuation?`,
    `What will ${e} use the new capital for, and how long is its runway?`,
    `Which existing investors took part, and did any insiders sell shares?`,
    `When is ${e}'s next round or liquidity event expected?`,
  ],
  competitors: (e) => [
    `How does ${e} position itself against those competitors on product and pricing?`,
    `Which customers has ${e} recently won from, or lost to, its rivals?`,
    `How does ${e}'s growth compare with its closest competitors?`,
  ],
  team: (e) => [
    `Who are ${e}'s key recent hires and departures?`,
    `What did ${e}'s founders build before, and who sits on its board?`,
    `How is ${e}'s leadership team compensated and how is equity split?`,
  ],
  financials: (e) => [
    `What are ${e}'s current revenue growth and burn rate?`,
    `How concentrated is ${e}'s revenue among its largest customers?`,
    `When does ${e} expect to reach profitability?`,
  ],
  product: (e) => [
    `What do customers say about ${e}'s product, and how is retention trending?`,
    `How does ${e}'s roadmap compare with what competitors are shipping?`,
    `Which usage metrics has ${e} disclosed?`,
  ],
  legal: (e) => [
    `What is the status and potential financial exposure of ${e}'s legal matters?`,
    `Which regulators are involved, and what remedies are sought?`,
    `How has ${e} responded publicly, and has it changed its practices?`,
  ],
};
// Generic questions, tagged by the topic they would repeat
const GENERIC_FOLLOW_UPS = [
  { topic: 'funding', q: (e) => `Who led ${e}'s most recent round, and at what valuation?` },
  { topic: 'competitors', q: (e) => `Who are ${e}'s closest competitors, and how do they compare?` },
  { topic: 'team', q: (e) => `What is known about ${e}'s founders and leadership team?` },
  { topic: 'financials', q: (e) => `What is ${e}'s revenue, and how fast is it growing?` },
];

function generateFollowUpQuestions(query, entityName = null, intents = null) {
  const entity = entityName || primaryEntity(query);
  const asked = Array.isArray(intents) ? intents : detectIntents(query);
  if (entity) {
    const out = [];
    const add = (q) => { if (q && !out.includes(q)) out.push(q); };
    // Deeper questions on the asked topics first (two per topic)
    for (const topic of asked) (FOLLOW_UPS[topic] ? FOLLOW_UPS[topic](entity) : []).slice(0, 2).forEach(add);
    // Then other topics the user did not ask about
    for (const g of GENERIC_FOLLOW_UPS) if (!asked.includes(g.topic)) add(g.q(entity));
    return out.slice(0, 4);
  }
  return [
    `Which companies in this space raised money in the last 12 months?`,
    `Which investors are most active here?`,
    `What are the main risks or open questions in this market?`,
  ];
}

const THEMES = [
  { title: 'Funding and Investors', pattern: /\b(rais(e|es|ed|ing)|funding|series [a-e]|seed|round|valuation|valued|investors?|led by|backed|portfolio)\b/i },
  { title: 'Business and Financials', pattern: /(\$|€|£)\s?\d|\b(arr|revenue|margin|burn|runway|customers|profit|growth|ipo)\b/i },
  { title: 'Product and Technology', pattern: /\b(launch(es|ed)?|product|platform|model|release[sd]?|feature|api|technology|open-source|open-weight)\b/i },
  { title: 'Market and Competition', pattern: /\b(market|compet\w*|rival|industry|sector|landscape|share)\b/i },
  { title: 'Team and Leadership', pattern: /\b(ceo|cto|founder|co-founder|hire[sd]?|appoint\w*|executive|team|headcount|employees)\b/i },
];

/** Who is speaking: used for DIFFERENT PERSPECTIVES (grouped by source kind). */
function perspectiveOf(result, entityWords) {
  const host = (() => { try { return new URL(result.url).hostname.toLowerCase(); } catch { return ''; } })();
  const category = String(result.sourceCategory || result.metadata?.category || '');
  if (result.source === 'file' || result.source === 'custom') return 'Your Documents';
  if (result.type === 'portfolio_listing' || /portfolio|investor|vc_/.test(category)) return 'Investor View';
  if (entityWords.some((w) => w.length > 3 && host.includes(w))) return 'Company Announcements';
  if (['hackernews', 'reddit', 'twitter', 'x'].includes(result.source)) return 'Community Discussion';
  if (category === 'market_analysis') return 'Analyst Commentary';
  return 'Press Coverage';
}

function cite(result, index) {
  const date = formatDate(result.publishedAt || result.date || result.timestamp);
  return `(${sourceLabel(result)}${date ? `, ${date}` : ''}) [Source ${index + 1}]`;
}

/**
 * A quoted sentence for running prose: "Sentence (Publisher, date) [Source n]."
 * The sentence's own full stop moves after the citation so that joined
 * sentences read as sentences; a headline with no punctuation gets one.
 */
function prose(sentence, result, index) {
  const trimmed = String(sentence).trim();
  const end = (trimmed.match(/[.!?]+$/) || ['.'])[0];
  return `${trimmed.replace(/[.!?]+$/, '')} ${cite(result, index)}${end}`;
}

/**
 * Original section structure (SUMMARY, KEY POINTS, DETAILED ANALYSIS,
 * DIFFERENT PERSPECTIVES, FOLLOW-UP QUESTIONS), filled only with sentences
 * quoted from the results and cited to them.
 */
function createSynthesizedContent(query, results, ctx = {}) {
  const terms = queryTerms(ctx.termsQuery || query);
  const entity = ctx.entityName || primaryEntity(query);
  const entityWords = String(entity || '').toLowerCase().split(/\s+/).filter(Boolean);
  const used = new Set();
  const take = (sentence) => { used.add(normSentence(sentence)); return sentence; };
  const unused = (sentence) => !used.has(normSentence(sentence));

  // Candidate sentences from every result (results are already ranked)
  const ranked = results.map((result, index) => ({ result, index, sentences: rankedSentences(result, terms, ctx) }));

  // SUMMARY: answer first. For "latest", lead with the newest relevant
  // source; then the strongest distinct sentences from other sources.
  const withSentences = ranked.filter((r) => r.sentences.length);
  const time = (r) => Date.parse(r.result.publishedAt || r.result.date || r.result.timestamp || '') || 0;
  const leadPool = ctx.recency ? [...withSentences].sort((a, b) => time(b) - time(a)) : withSentences;
  const summaryLines = [];
  const summarySources = new Set();
  for (const r of [...leadPool.slice(0, 1), ...withSentences]) {
    if (summaryLines.length >= 3) break;
    if (summarySources.has(r.index)) continue; // one sentence per source
    const s = r.sentences.find((x) => unused(x.sentence));
    if (s) {
      summarySources.add(r.index);
      summaryLines.push(prose(take(s.sentence), r.result, r.index));
    }
  }
  const curatedCount = results.filter((r) => r.source === 'curated').length;
  const dated = results.map((r) => formatDate(r.publishedAt || r.date || r.timestamp)).filter(Boolean).sort();
  const coverage = `Based on ${results.length} source${results.length === 1 ? '' : 's'} ${entity ? `about ${entity}` : `for "${query}"`}` +
    `${curatedCount ? ` (${curatedCount} from your curated sources)` : ''}` +
    `${dated.length ? `, dated ${dated[0]} to ${dated[dated.length - 1]}` : ''}.`;

  // KEY POINTS: the core facts, so they may repeat what the summary quoted
  used.clear();
  const perSource = results.length <= 2 ? 5 : results.length <= 4 ? 2 : 1;
  const keyPoints = [];
  for (const { result, index, sentences } of ranked) {
    const picked = sentences.filter((x) => unused(x.sentence)).slice(0, perSource).sort((a, b) => a.position - b.position);
    for (const s of picked) {
      if (keyPoints.length >= MAX_POINTS) break;
      keyPoints.push(`• ${take(s.sentence)} ${cite(result, index)}`);
    }
  }
  if (keyPoints.length === 0) {
    results.slice(0, 5).forEach((r, i) => keyPoints.push(`• ${cleanText(r.title)} ${cite(r, i)}`));
  }
  // Detailed analysis and perspectives must not repeat the key points
  for (const line of keyPoints) used.add(normSentence(line.replace(/^• /, '').replace(/\s*\([^)]*\)\s*\[Source \d+\]$/, '')));

  // DETAILED ANALYSIS: remaining quoted sentences grouped by theme
  const themed = THEMES.map((theme) => {
    const lines = [];
    for (const { result, index, sentences } of ranked) {
      for (const s of sentences) {
        if (lines.length >= 3) break;
        if (theme.pattern.test(s.sentence) && unused(s.sentence)) lines.push(prose(take(s.sentence), result, index));
      }
    }
    return lines.length ? `### ${theme.title}\n\n${lines.join(' ')}` : null;
  }).filter(Boolean);
  const detailed = themed.length
    ? themed.join('\n\n')
    : 'The sources contain no further detail beyond the key points above.';

  // DIFFERENT PERSPECTIVES: one quoted line per kind of source
  const byPerspective = new Map();
  for (const { result, index, sentences } of ranked) {
    const kind = perspectiveOf(result, entityWords);
    if (byPerspective.has(kind)) continue;
    const sentence = sentences[0]?.sentence;
    if (sentence) byPerspective.set(kind, `• **${kind}**: ${sentence} ${cite(result, index)}`);
  }
  const perspectives = byPerspective.size > 1
    ? [...byPerspective.values()].join('\n')
    : `• Only one kind of source covers this query (${[...byPerspective.keys()][0] || 'none'}). Add sources (Web, Verified, your own URLs or documents) for other viewpoints.`;

  const dateStr = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return [
    '## SUMMARY',
    coverage,
    '',
    summaryLines.join(' '),
    '',
    '## KEY POINTS',
    keyPoints.join('\n'),
    '',
    '## DETAILED ANALYSIS',
    detailed,
    '',
    '## DIFFERENT PERSPECTIVES',
    perspectives,
    '',
    '## FOLLOW-UP QUESTIONS',
    generateFollowUpQuestions(query, entity, ctx.intents).map((q) => `• ${q}`).join('\n'),
    '',
    '---',
    `*Results synthesized from ${results.length} sources on ${dateStr}*`,
    '',
    `*Note: ${ctx.reason || 'No AI model is configured'}, so every statement above is quoted from the cited source. For most accurate information, please verify with original sources.*`,
  ].join('\n');
}

function generateCategories(results) {
  // Category names from components/search/categories/types/DefaultCategories.js
  const toItem = (r) => ({ title: r.title, content: r.snippet, url: r.url });
  const categories = [
    { id: 'key-insights', name: 'Key Insights', items: results.slice(0, 3).map(toItem) },
  ];
  const financial = results.filter((r) => FUNDING_RE.test(`${r.title} ${r.snippet}`) || FACT_RE.test(r.snippet));
  if (financial.length) categories.push({ id: 'financial-data', name: 'Financial Data', items: financial.slice(0, 5).map(toItem) });
  const company = results.filter((r) => r.type === 'portfolio_listing' || r.source === 'file' || r.source === 'custom');
  if (company.length) categories.push({ id: 'company-information', name: 'Company Information', items: company.slice(0, 5).map(toItem) });
  return categories;
}

function createEmptyResponse(query) {
  return resultDetector.addLLMFlags({
    content: [
      '## SUMMARY',
      `No sources returned results for "${query}".`,
      '',
      '## KEY POINTS',
      '• Nothing was found in the curated sources or the other selected sources.',
      '• For a private company, try its exact name, a founder\'s name, or its product name.',
      '',
      '## DETAILED ANALYSIS',
      'There is no source material to analyze for this query.',
      '',
      '## DIFFERENT PERSPECTIVES',
      '• Web and site-specific sources (Crunchbase, PitchBook, LinkedIn, X) need a search API key; Verified covers public companies only.',
      '',
      '## FOLLOW-UP QUESTIONS',
      ...generateFollowUpQuestions(query).map((q) => `• ${q}`),
    ].join('\n'),
    query,
    followUpQuestions: generateFollowUpQuestions(query),
    sourceMap: {},
    categories: [],
    metadata: { synthesized: true, extractive: true, timestamp: new Date().toISOString(), totalSources: 0 },
  }, true);
}

/**
 * Create an extractive, cited digest from raw search results.
 * @param {string} query
 * @param {Array} results
 * @returns {Object} LLM-shaped response (flagged as synthesized)
 */
function synthesizeFromResults(query, results, ctx = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    return createEmptyResponse(query);
  }

  // Keep every result in its position: Source n in the digest is result n
  // in the list the UI shows (and in the claim check).
  const validResults = results
    .slice(0, MAX_SOURCES)
    .map((result) => ({
      ...result,
      title: cleanText(result?.title) || 'Untitled',
      snippet: cleanText(result?.snippet || result?.content || result?.description),
      url: result?.url || result?.link || '#',
    }));

  if (validResults.every((result) => !result.snippet && result.title === 'Untitled')) {
    return createEmptyResponse(query);
  }

  const sourceMap = {};
  validResults.forEach((result, index) => {
    sourceMap[String(index + 1)] = {
      title: result.title,
      url: result.url,
      type: result.type || result.source || 'web',
      sourceName: sourceLabel(result),
      date: formatDate(result.publishedAt || result.date || result.timestamp),
    };
  });

  return resultDetector.addLLMFlags({
    content: createSynthesizedContent(query, validResults, ctx),
    query,
    followUpQuestions: generateFollowUpQuestions(query, ctx.entityName, ctx.intents),
    sourceMap,
    categories: generateCategories(validResults),
    metadata: {
      synthesized: true,
      extractive: true,
      timestamp: new Date().toISOString(),
      totalSources: validResults.length,
    },
  }, true);
}

module.exports = {
  synthesizeFromResults,
};
