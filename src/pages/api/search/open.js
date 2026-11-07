import axios from 'axios';
import { performSimpleSearch, performSimpleVerifiedSearch } from '../../../utils/searchUtils';
import { logger } from '../../../utils/logger';
import { searchHackerNews } from '../../../utils/sources/hackernewsAlgolia';
import { processWithLLM } from '../../../utils/llmProcessing';
import { synthesizeFromResults } from '../../../utils/fallbackSynthesizer';
import { processCategories } from '../../../components/search/categories/processors/CategoryProcessor';
import { normalizeSearchResponseV1 } from '../../../utils/contracts/searchResponse';

// Define valid sources
// Must list every source the UI offers; unlisted ones were silently dropped (Carta was).
const VALID_SOURCES = ['curated', 'web', 'linkedin', 'twitter', 'reddit', 'substack', 'medium', 'crunchbase', 'pitchbook', 'carta', 'verified'];

function normalizeSources(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',').map((s) => s.trim())
      : [];

  const aliasMap = {
    x: 'twitter',
    'x.com': 'twitter',
    'verified sources': 'verified',
    'curated sources': 'curated'
  };

  const normalized = raw
    .map((source) => String(source || '').trim().toLowerCase())
    .map((source) => aliasMap[source] || source)
    .filter((source) => VALID_SOURCES.includes(source));

  return normalized.length > 0 ? Array.from(new Set(normalized)) : ['web'];
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract query and other parameters from request body
    const {
      query,
      sources = ['web'],
      model,
      customUrls = [],
      uploadedFiles = [],
      files = [],
      useLLM = true
    } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const normalizedSources = normalizeSources(sources);

    // Log search request
    logger.info('Open search request:', { query, model, sources: normalizedSources });

    let results = [];
    let llmResponse = null;
    let categories = [];
    const degradedSources = [];
    const normalizedFiles = Array.isArray(uploadedFiles) && uploadedFiles.length > 0 ? uploadedFiles : files;

    // Search every selected source together. (Previously, selecting Web
    // searched only Web and silently ignored the other selected sources.)
    const searchSources = normalizedSources.filter(source => source !== 'verified');
    const searches = [];
    const searchGroups = [];

    if (normalizedSources.includes('verified')) {
      // Public-company data (FMP, SEC, EDGAR); usually empty for private companies.
      searches.push(performSimpleVerifiedSearch(query, ['fmp', 'sec', 'edgar'], {
        model,
        customUrls,
        uploadedFiles: normalizedFiles
      }).then(found => ({ sources: ['verified'], found })));
      searchGroups.push(['verified']);
    }

    if (searchSources.length > 0 || customUrls.length > 0 || normalizedFiles.length > 0) {
      searches.push(performSimpleSearch(query, searchSources, {
        model,
        customUrls,
        uploadedFiles: normalizedFiles
      }).then(found => ({ sources: searchSources, found })));
      searchGroups.push(searchSources);
    }

    // Each search group fails independently: a failure or an empty group
    // marks its sources degraded without discarding the other groups' results.
    const settled = await Promise.allSettled(searches);
    // If every group failed, it's a whole-request failure: let the outer
    // handler return its fail-soft response with the error.
    if (settled.length > 0 && settled.every(outcome => outcome.status === 'rejected')) {
      throw settled[0].reason;
    }
    settled.forEach((outcome, i) => {
      if (outcome.status !== 'fulfilled') {
        logger.error('Open search group failed:', outcome.reason?.message || outcome.reason);
        degradedSources.push(...(searchGroups[i] || []));
        return;
      }
      const { sources: groupSources, found } = outcome.value;
      const groupResults = Array.isArray(found) ? found : [];
      results = [...results, ...groupResults];
      if (groupResults.length === 0) {
        degradedSources.push(...groupSources);
        return;
      }
      // Within a group that returned something, flag selected sources that
      // contributed nothing (only when results say which source they are from).
      const labelled = groupResults.filter(r => r && r.source);
      if (labelled.length === 0 || groupSources.length < 2) return;
      const contributed = new Set(labelled.map(r => String(r.source).toLowerCase()));
      const contributedBy = (source) => {
        if (source === 'twitter') return contributed.has('twitter') || contributed.has('x');
        if (['crunchbase', 'pitchbook', 'carta'].includes(source)) {
          return [...contributed].some(c => c.includes(source));
        }
        return contributed.has(source);
      };
      degradedSources.push(...groupSources.filter(source => !contributedBy(source)));
    });

    // No-key fallback: if every selected source came back empty (e.g. no
    // search API keys configured), use Hacker News so the page isn't blank.
    if (results.length === 0) {
      try {
        const hnResults = await searchHackerNews(query);
        if (hnResults.length > 0) {
          results = hnResults;
        }
      } catch (hnError) {
        console.error('Hacker News fallback failed:', hnError.message);
        degradedSources.push('hackernews');
      }
    }

    // Generate LLM response if requested
    if (useLLM && model && results.length > 0) {
      try {
        console.log('DEBUG: Attempting to process with LLM - model:', model, 'results:', results.length);
        llmResponse = await processWithLLM({
          query,
          sources: results,
          model,
          maxTokens: 1024,
          temperature: 0.7
        });
        
        // Debug the LLM response
        console.log('DEBUG: LLM Response received:', {
          hasContent: !!llmResponse?.content,
          contentLength: llmResponse?.content?.length || 0,
          hasFlags: !!llmResponse?.__isImmutableLLMResult,
          metadata: llmResponse?.metadata || 'none',
          isError: !!llmResponse?.isError,
          errorType: llmResponse?.errorType || null
        });
      } catch (llmError) {
        console.error('DEBUG: Error generating LLM response:', llmError.message);
        logger.error('Error generating LLM response:', llmError);
      }
    }

    // Guaranteed free fallback: synthesize from search results when LLM/auth fails
    const shouldUseFallbackSynth =
      !llmResponse ||
      llmResponse.isError === true ||
      !!llmResponse.error ||
      !!llmResponse.errorType ||
      !llmResponse?.content;

    if (useLLM && shouldUseFallbackSynth) {
      try {
        const synthesized = synthesizeFromResults(query, results);
        llmResponse = {
          ...synthesized,
          metadata: {
            ...(synthesized?.metadata || {}),
            fallback: 'local-synthesizer'
          }
        };
      } catch (synthError) {
        logger.error('Error generating synthesized fallback response:', synthError);
      }
    }

    // Generate categories
    try {
      // Process categories based on query and search results
      categories = await processCategories(results, query, {
        includeBusinessMetrics: true,
        llmResponse
      });
    } catch (categoryError) {
      logger.error('Error generating categories:', categoryError);
      categories = [];
    }

    // Debug the final response structure
    console.log('DEBUG: Final API response structure:', {
      hasResults: !!results,
      resultsCount: results?.length || 0,
      hasLLMResponse: !!llmResponse,
      hasLLMContent: !!llmResponse?.content,
      hasCategories: !!categories,
      categoriesCount: categories?.length || 0
    });
    
    // Merge only display-safe LLM fields; never let LLM payload override top-level contract status
    const llmPayload = llmResponse ? {
      content: llmResponse.content ?? null,
      sourceMap: llmResponse.sourceMap || {},
      metadata: llmResponse.metadata || {},
      __isImmutableLLMResult: !!llmResponse.__isImmutableLLMResult,
      isLLMResult: !!llmResponse.isLLMResult,
      llmProcessed: llmResponse.llmProcessed !== false
    } : {
      content: null
    };

    return res.status(200).json(normalizeSearchResponseV1({
      results,
      status: results.length > 0 ? (degradedSources.length > 0 ? 'degraded' : 'ok') : 'fail-soft',
      degradedSources: Array.from(new Set(degradedSources)),
      query,
      timestamp: new Date().toISOString(),
      ...llmPayload,
      ...(results.length === 0 ? {
        failSoftContent: {
          message: 'No live sources returned results right now.',
          suggestions: [
            'Try a more specific query',
            'Check provider readiness at /api/debug/env-check',
            'Try Web + HackerNews sources'
          ]
        }
      } : {}),
      categories
    }));
  } catch (error) {
    logger.error('Error in open search API:', error);
    return res.status(200).json(normalizeSearchResponseV1({
      results: [],
      status: 'fail-soft',
      degradedSources: ['open-search'],
      error: 'An error occurred during search',
      message: error.message,
      content: null,
      categories: []
    }));
  }
}
