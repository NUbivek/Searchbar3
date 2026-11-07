/**
 * Fallback Synthesizer
 *
 * Used when no LLM is configured or the LLM call fails. It produces an
 * EXTRACTIVE digest: every statement is a sentence taken from a search
 * result and cited to that result. It never writes analysis, "perspectives"
 * or claims of its own. (The previous version filled sections with generic
 * template prose and hardcoded "[Source 1, Source 2]" citations that did not
 * correspond to the sources, which is unacceptable for diligence work.)
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

function createSynthesizedContent(query, results) {
  const terms = queryTerms(query);
  const dated = results.map((r) => formatDate(r.publishedAt || r.date || r.timestamp)).filter(Boolean).sort();
  const curatedCount = results.filter((r) => r.source === 'curated').length;

  // With few sources (e.g. an uploaded memo or a single URL), each document
  // is the main evidence, so quote several of its relevant sentences.
  const perSource = results.length <= 2 ? 5 : results.length <= 4 ? 2 : 1;
  const points = [];
  results.forEach((result, index) => {
    if (points.length >= MAX_POINTS) return;
    const date = formatDate(result.publishedAt || result.date || result.timestamp);
    const cite = `*(${sourceLabel(result)}${date ? `, ${date}` : ''})* [Source ${index + 1}]`;
    const picked = rankedSentences(result, terms).slice(0, perSource)
      .sort((a, b) => a.position - b.position)
      .map((s) => s.sentence);
    if (picked.length === 0) {
      const fallback = bestSentence(result, terms);
      if (fallback) picked.push(fallback);
    }
    for (const sentence of picked) {
      if (points.length >= MAX_POINTS) break;
      points.push(`- ${sentence} ${cite}`);
    }
  });

  const fundingPoints = results
    .map((r, i) => ({ r, i, s: bestSentence(r, terms) }))
    .filter(({ s }) => s && FUNDING_RE.test(s))
    .slice(0, 4)
    .map(({ r, i, s }) => `- ${s} *(${sourceLabel(r)})* [Source ${i + 1}]`);

  const sourceList = results
    .map((r, i) => {
      const date = formatDate(r.publishedAt || r.date || r.timestamp);
      return `${i + 1}. [${cleanText(r.title).slice(0, 140)}](${r.url}): ${sourceLabel(r)}${date ? `, ${date}` : ''}`;
    })
    .join('\n');

  const coverage = [
    `${results.length} source${results.length === 1 ? '' : 's'} found`,
    curatedCount ? `${curatedCount} from your curated sources` : null,
    dated.length ? `dated ${dated[0]} to ${dated[dated.length - 1]}` : null,
  ].filter(Boolean).join(', ');

  const generated = new Date().toISOString().slice(0, 16).replace('T', ' ');

  return [
    '## SUMMARY',
    `${coverage}. No AI model is configured, so this is a digest of what the sources themselves say, not an analysis. Each point below is quoted from the cited source.`,
    '',
    '## KEY POINTS',
    points.join('\n') || '- The sources did not contain a usable sentence about this query.',
    ...(fundingPoints.length ? ['', '## FUNDING AND INVESTOR MENTIONS', fundingPoints.join('\n')] : []),
    '',
    '## SOURCES',
    sourceList,
    '',
    '## FOLLOW-UP QUESTIONS',
    generateFollowUpQuestions(query).map((q) => `- ${q}`).join('\n'),
    '',
    '---',
    `*Extractive digest of ${results.length} sources, generated ${generated} UTC. Verify claims in the original sources.*`,
  ].join('\n');
}

function generateCategories(results) {
  const toItem = (r) => ({ title: r.title, content: r.snippet, url: r.url });
  const categories = [
    { id: 'key-insights', name: 'Key Insights', items: results.slice(0, 3).map(toItem) },
  ];
  const funding = results.filter((r) => FUNDING_RE.test(`${r.title} ${r.snippet}`));
  if (funding.length) categories.push({ id: 'funding', name: 'Funding & Investors', items: funding.slice(0, 5).map(toItem) });
  const portfolio = results.filter((r) => r.type === 'portfolio_listing');
  if (portfolio.length) categories.push({ id: 'portfolio', name: 'Investor Portfolios', items: portfolio.slice(0, 5).map(toItem) });
  return categories;
}

function createEmptyResponse(query) {
  return resultDetector.addLLMFlags({
    content: [
      '## SUMMARY',
      `No sources returned results for "${query}".`,
      '',
      '## KEY POINTS',
      '- Nothing was found in the curated sources or the other selected sources.',
      '- For a private company, try its exact name, a founder\'s name, or its product name.',
      '- Web and site-specific sources (Crunchbase, PitchBook, LinkedIn, X) need a search API key to be configured.',
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
