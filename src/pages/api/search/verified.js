import axios from 'axios';
import { performSimpleVerifiedSearch } from '../../../utils/searchUtils.js';
import { debug, info, error, warn } from '../../../utils/logger.js';
import { getAllVerifiedSources } from '../../../utils/verifiedDataSources.js';
import { sourceHandlers } from '../../../utils/sourceIntegration.js';
import { normalizeSearchResponseV1 } from '../../../utils/contracts/searchResponse';

export default async function handler(req, res) {
  // Create a logger object for compatibility
  const log = {
    debug,
    info,
    error,
    warn
  };

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { query, sources = [], model, customUrls = [], uploadedFiles = [], verifiedDataSources = [] } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    log.info('Verified search request:', { query, sources, model });

    // If no sources provided, return empty results
    if (sources.length === 0 && customUrls.length === 0 && uploadedFiles.length === 0) {
      return res.status(200).json(normalizeSearchResponseV1({
        results: [],
        status: 'ok',
        degradedSources: [],
        synthesis: {
          enabled: false,
          provider: null,
          model: model || null,
          content: null,
        },
      }));
    }

    // Initialize results array
    let results = [];

    // Process each source in parallel
    const sourcePromises = sources.map(async (source) => {
      try {
        // Get the appropriate handler for this source
        const handler = sourceHandlers[source];
        if (handler) {
          const sourceResults = await handler(query);
          return sourceResults;
        } else {
          log.warn(`No handler found for source: ${source}`);
          return [];
        }
      } catch (error) {
        log.error(`Error processing source ${source}:`, error);
        return [];
      }
    });

    // Process custom URLs if provided
    if (customUrls && customUrls.length > 0) {
      sourcePromises.push(sourceHandlers.custom(query, customUrls));
    }

    // Process uploaded files if provided
    if (uploadedFiles && uploadedFiles.length > 0) {
      sourcePromises.push(sourceHandlers.file(query, uploadedFiles));
    }

    // Process additional verified data sources if provided
    if (verifiedDataSources && verifiedDataSources.length > 0) {
      sourcePromises.push(sourceHandlers.verifiedData(query, verifiedDataSources));
    }

    // Wait for all source processing to complete
    const sourceResults = await Promise.allSettled(sourcePromises);

    // Flatten results
    results = sourceResults
      .filter((result) => result.status === 'fulfilled')
      .flatMap((result) => Array.isArray(result.value) ? result.value : []);

    // Sort results by relevance (if available) or other criteria
    results.sort((a, b) => {
      if (a.relevance && b.relevance) {
        return b.relevance - a.relevance;
      }
      return 0;
    });

    return res.status(200).json(normalizeSearchResponseV1({
      results,
      status: 'ok',
      degradedSources: [],
      synthesis: {
        enabled: false,
        provider: null,
        model: model || null,
        content: null,
      },
    }));
  } catch (error) {
    log.error('Verified search error:', error);
    return res.status(200).json(normalizeSearchResponseV1({
      results: [],
      status: 'fail-soft',
      degradedSources: ['verified'],
      error: error.message || 'An error occurred during search',
      synthesis: {
        enabled: false,
        provider: null,
        model: null,
        content: null,
      },
    }));
  }
}
