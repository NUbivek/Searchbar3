import axios from 'axios';
import { performSimpleSearch, performSimpleVerifiedSearch } from '../../../utils/searchUtils';
import { logger } from '../../../utils/logger';
import { processWithLLM } from '../../../utils/llmProcessing';
import { synthesizeFromResults } from '../../../utils/fallbackSynthesizer';
import { processCategories } from '../../../components/search/categories/processors/CategoryProcessor';
import { deepWebSearch } from '../../../utils/deepWebSearch';
import { normalizeSearchResponseV1 } from '../../../utils/contracts/searchResponse';

// Define valid sources
const VALID_SOURCES = ['web', 'linkedin', 'twitter', 'reddit', 'substack', 'medium', 'crunchbase', 'pitchbook', 'verified'];

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

    // Log search request
    logger.info('Open search request:', { query, model, sources });

    let results = [];
    let llmResponse = null;
    let categories = [];
    const degradedSources = [];
    const normalizedFiles = Array.isArray(uploadedFiles) && uploadedFiles.length > 0 ? uploadedFiles : files;

    // Check if verified sources is selected
    if (sources.includes('verified')) {
      // Use all verified sources (fmp, sec, edgar)
      const verifiedResults = await performSimpleVerifiedSearch(query, ['fmp', 'sec', 'edgar'], {
        model,
        customUrls,
        uploadedFiles: normalizedFiles
      });
      results = [...results, ...verifiedResults];
      
      // Filter out 'verified' from sources for regular search
      const otherSources = sources.filter(source => source !== 'verified');
      
      // Only perform regular search if there are other sources selected
      if (otherSources.length > 0) {
        // Perform regular search with selected sources
        if (otherSources.includes('web')) {
          console.log(`DEBUG: Executing web search for: "${query}"`);
          const webResults = await deepWebSearch(query, { maxResults: 10 });
          console.log(`DEBUG: Web search returned ${webResults.length} results`);
          if (webResults.length === 0) {
            degradedSources.push('web');
          }
          results = [...results, ...webResults];
        } else {
          const otherResults = await performSimpleSearch(query, otherSources, {
            model,
            customUrls,
            uploadedFiles: normalizedFiles
          });
          results = [...results, ...otherResults];
        }
      }
    } else {
      // Perform regular search with selected sources
      if (sources.includes('web')) {
        console.log(`DEBUG: Executing web search for: "${query}"`);
        const webResults = await deepWebSearch(query, { maxResults: 10 });
        console.log(`DEBUG: Web search returned ${webResults.length} results`);
        if (webResults.length === 0) {
          degradedSources.push('web');
        }
        results = [...results, ...webResults];
      } else {
        results = await performSimpleSearch(query, sources, {
          model,
          customUrls,
          uploadedFiles: normalizedFiles
        });
      }
    }

    // Generate LLM response if requested
    if (useLLM && model) {
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
    
    // Return the full LLM response object instead of just the content
    return res.status(200).json(normalizeSearchResponseV1({
      results,
      status: results.length > 0 ? (degradedSources.length > 0 ? 'degraded' : 'ok') : 'fail-soft',
      degradedSources: Array.from(new Set(degradedSources)),
      query,
      timestamp: new Date().toISOString(),
      // Return the complete LLM response object with all the flags
      ...(llmResponse ? llmResponse : { content: null }),
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
