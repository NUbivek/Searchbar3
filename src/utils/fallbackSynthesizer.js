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

const MAX_SOURCES = 12;
const MAX_POINTS = 8;
const STOPWORDS = new Set('a an and are as at be by for from has have how in into is it its of on or that the this to was were what when where which who why will with about vs'.split(' '));
function queryTerms(query) {
  return (String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9.+&'-]*/g) || [])
    .filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/** Rank a result's sentences by relevance to the query (facts and funding count too). */
function rankedSentences(result, terms) {
  const text = cleanText(result.snippet);
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length >= 20 && s.length <= 400);
  return sentences
    .map((sentence, position) => {
      const lower = sentence.toLowerCase();
      let score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
      if (FUNDING_RE.test(sentence)) score += 0.5;
      if (FACT_RE.test(sentence)) score += 0.5;
      return { sentence, position, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.position - b.position);
}

/** Pick the most query-relevant sentence from a result (title as fallback). */
function bestSentence(result, terms) {
  const [top] = rankedSentences(result, terms);
  if (top) return top.sentence;
  const title = cleanText(result.title);
  return title.length >= 10 ? title : null;
}

function primaryEntity(query) {
  // "Acme Robotics Series B" -> "Acme Robotics": stop at funding words.
  const trimmed = String(query || '').split(/\b(?:Series|Seed|Pre-seed|Round|Funding|Raise|Valuation|IPO)\b/i)[0];
  const names = (trimmed.match(/[A-Z][A-Za-z0-9.&'-]*(?:\s+[A-Z][A-Za-z0-9.&'-]*)*/g) || [])
    .filter((n) => n.length > 1);
  return names[0] || null;
}

function generateFollowUpQuestions(query) {
  const entity = primaryEntity(query);
  if (entity) {
    return [
      `Who led ${entity}'s most recent round, and at what valuation?`,
      `Who are ${entity}'s closest competitors, and how do they compare?`,
      `What is known about ${entity}'s founders and leadership team?`,
    ];
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
 * Original section structure (SUMMARY, KEY POINTS, DETAILED ANALYSIS,
 * DIFFERENT PERSPECTIVES, FOLLOW-UP QUESTIONS), filled only with sentences
 * quoted from the results and cited to them.
 */
function createSynthesizedContent(query, results) {
  const terms = queryTerms(query);
  const entity = primaryEntity(query);
  const entityWords = String(entity || '').toLowerCase().split(/\s+/).filter(Boolean);
  const used = new Set();
  const take = (sentence) => { used.add(sentence.toLowerCase()); return sentence; };
  const unused = (sentence) => !used.has(sentence.toLowerCase());

  // Candidate sentences from every result, ranked per result
  const ranked = results.map((result, index) => ({ result, index, sentences: rankedSentences(result, terms) }));

  // SUMMARY: the strongest sentence from up to 3 different sources
  const summaryLines = ranked
    .filter((r) => r.sentences.length)
    .slice(0, 3)
    .map(({ result, index, sentences }) => `${take(sentences[0].sentence)} ${cite(result, index)}`);
  const curatedCount = results.filter((r) => r.source === 'curated').length;
  const dated = results.map((r) => formatDate(r.publishedAt || r.date || r.timestamp)).filter(Boolean).sort();
  const coverage = `Based on ${results.length} source${results.length === 1 ? '' : 's'} for "${query}"` +
    `${curatedCount ? ` (${curatedCount} from your curated sources)` : ''}` +
    `${dated.length ? `, dated ${dated[0]} to ${dated[dated.length - 1]}` : ''}:`;

  // KEY POINTS: the core facts, so they may repeat what the summary quoted
  used.clear();
  const perSource = results.length <= 2 ? 5 : results.length <= 4 ? 2 : 1;
  const keyPoints = [];
  for (const { result, index, sentences } of ranked) {
    const picked = sentences.filter((s) => unused(s.sentence)).slice(0, perSource).sort((a, b) => a.position - b.position);
    for (const s of picked) {
      if (keyPoints.length >= MAX_POINTS) break;
      keyPoints.push(`• ${take(s.sentence)} ${cite(result, index)}`);
    }
  }
  if (keyPoints.length === 0) {
    results.slice(0, 5).forEach((r, i) => keyPoints.push(`• ${cleanText(r.title)} ${cite(r, i)}`));
  }

  // DETAILED ANALYSIS: remaining quoted sentences grouped by theme
  const themed = THEMES.map((theme) => {
    const lines = [];
    for (const { result, index, sentences } of ranked) {
      for (const s of sentences) {
        if (lines.length >= 3) break;
        if (theme.pattern.test(s.sentence) && unused(s.sentence)) lines.push(`${take(s.sentence)} ${cite(result, index)}`);
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
    const sentence = sentences[0]?.sentence || cleanText(result.title);
    if (sentence) byPerspective.set(kind, `• **${kind}**: ${sentence} ${cite(result, index)}`);
  }
  const perspectives = byPerspective.size > 1
    ? [...byPerspective.values()].join('\n')
    : `• Only one kind of source covers this query (${[...byPerspective.keys()][0] || 'none'}). Add sources (Web, Verified, your own URLs or documents) for other viewpoints.`;

  const dateStr = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return [
    '## SUMMARY',
    `${coverage} ${summaryLines.join(' ')}`.trim(),
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
    generateFollowUpQuestions(query).map((q) => `• ${q}`).join('\n'),
    '',
    '---',
    `*Results synthesized from ${results.length} sources on ${dateStr}*`,
    '',
    '*Note: No AI model is configured, so every statement above is quoted from the cited source. For most accurate information, please verify with original sources.*',
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
function synthesizeFromResults(query, results) {
  if (!Array.isArray(results) || results.length === 0) {
    return createEmptyResponse(query);
  }

  const validResults = results
    .map((result) => ({
      ...result,
      title: cleanText(result?.title) || 'Untitled',
      snippet: cleanText(result?.snippet || result?.content || result?.description),
      url: result?.url || result?.link || '#',
    }))
    .filter((result) => result.title && (result.snippet || result.title !== 'Untitled'))
    .slice(0, MAX_SOURCES);

  if (validResults.length === 0) {
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
    content: createSynthesizedContent(query, validResults),
    query,
    followUpQuestions: generateFollowUpQuestions(query),
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
