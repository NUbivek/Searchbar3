import axios from 'axios';
import { logger } from '../../../utils/logger';
import { withRetry } from '../../../utils/errorHandling';
import { rateLimit } from '../../../utils/rateLimiter';
import { normalizeSearchResponseV1 } from '../../../utils/contracts/searchResponse';
const { fetchUrlContent } = require('../../../utils/urlExtraction');

// Constants
const MAX_CUSTOM_URLS = 10;
const MAX_UPLOADED_FILES = 5;
const REQUEST_TIMEOUT = 10000; // 10 seconds
const MAX_CONTENT_LENGTH = 100000; // 100KB
const VALID_MODELS = ['mixtral-8x7b', 'mistral-7b', 'deepseek-70b', 'gemma-7b'];
const VALID_MODES = ['default', 'analysis', 'summary'];
const VALID_SOURCES = ['web', 'news', 'academic', 'market_data'];

// Validate URL format
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// Validate file object
function isValidFile(file) {
  return file && 
    typeof file === 'object' && 
    typeof file.name === 'string' && 
    typeof file.content === 'string' &&
    file.content.length > 0 &&
    file.content.length <= MAX_CONTENT_LENGTH;
}

// Sanitize and truncate content
function sanitizeContent(content) {
  if (typeof content !== 'string') return '';
  return content
    .slice(0, MAX_CONTENT_LENGTH)
    .replace(/[<>]/g, '')
    .trim();
}

async function runWebSearchWithFallback(query, searchId) {
  const serperApiKey = process.env.SERPER_API_KEY;
  const tavilyApiKey = process.env.TAVILY_API_KEY;

  if (tavilyApiKey) {
    logger.info(`[${searchId}] Calling Tavily API`);
    const tavilyResponse = await withRetry(() => axios.post(
      'https://api.tavily.com/search',
      {
        api_key: tavilyApiKey,
        query,
        search_depth: 'basic',
        max_results: 10
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
        validateStatus: (status) => status >= 200 && status < 500
      }
    )).catch((error) => {
      logger.error(`[${searchId}] Tavily API error:`, error.response?.data || error.message);
      return null;
    });

    if (tavilyResponse && tavilyResponse.status === 200) {
      const normalized = {
        ...tavilyResponse,
        data: {
          ...tavilyResponse.data,
          organic: (tavilyResponse.data?.results || []).map((item) => ({
            title: item.title || 'Untitled',
            snippet: item.content || '',
            link: item.url || ''
          }))
        }
      };
      return { response: normalized, provider: 'tavily' };
    }

    logger.warn(`[${searchId}] Tavily unavailable, trying Serper fallback`);
  }

  if (serperApiKey) {
    logger.info(`[${searchId}] Calling Serper API fallback`);
    const serperResponse = await withRetry(() => axios.post(
      'https://google.serper.dev/search',
      {
        q: query,
        num: 10,
        gl: 'us',
        hl: 'en'
      },
      {
        headers: {
          'X-API-KEY': serperApiKey,
          'Content-Type': 'application/json'
        },
        timeout: REQUEST_TIMEOUT,
        validateStatus: (status) => status >= 200 && status < 500
      }
    )).catch((error) => {
      logger.error(`[${searchId}] Serper API error:`, error.response?.data || error.message);
      return null;
    });

    if (serperResponse && serperResponse.status === 200) {
      return { response: serperResponse, provider: 'serper' };
    }
  }

  return { response: null, provider: null };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const searchId = Math.random().toString(36).substring(7);

  try {
    const { 
      query, 
      customUrls = [], 
      uploadedFiles = [], 
      model = 'mixtral-8x7b',
      customMode = 'default',
      selectedSources = ['web']
    } = req.body;

    const failSoft = (overrides = {}) => normalizeSearchResponseV1({
      results: [],
      sources: [],
      summary: {
        content: '',
        sourceMap: {}
      },
      status: 'fail-soft',
      degradedSources: ['web'],
      synthesis: {
        enabled: false,
        provider: null,
        model: model || null,
        content: null,
      },
      ...overrides
    });
    
    // Input validation
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ message: 'Valid query string is required' });
    }

    if (!VALID_MODELS.includes(model)) {
      return res.status(400).json({ 
        message: `Invalid model. Must be one of: ${VALID_MODELS.join(', ')}` 
      });
    }

    if (!VALID_MODES.includes(customMode)) {
      return res.status(400).json({ 
        message: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}` 
      });
    }

    const invalidSources = selectedSources.filter(source => !VALID_SOURCES.includes(source));
    if (invalidSources.length > 0) {
      return res.status(400).json({ 
        message: `Invalid sources: ${invalidSources.join(', ')}. Must be one of: ${VALID_SOURCES.join(', ')}` 
      });
    }

    if (customUrls.length > MAX_CUSTOM_URLS) {
      return res.status(400).json({ 
        message: `Maximum ${MAX_CUSTOM_URLS} custom URLs allowed` 
      });
    }

    if (uploadedFiles.length > MAX_UPLOADED_FILES) {
      return res.status(400).json({ 
        message: `Maximum ${MAX_UPLOADED_FILES} files allowed` 
      });
    }

    // Validate customUrls
    if (customUrls.length > 0) {
      const invalidUrls = customUrls.filter(url => !isValidUrl(url));
      if (invalidUrls.length > 0) {
        return res.status(400).json({ 
          message: 'Invalid URLs provided',
          invalidUrls 
        });
      }
    }

    // Validate uploadedFiles
    if (uploadedFiles.length > 0) {
      const invalidFiles = uploadedFiles.filter(file => !isValidFile(file));
      if (invalidFiles.length > 0) {
        return res.status(400).json({ 
          message: 'Invalid files provided',
          invalidFiles: invalidFiles.map(f => f?.name || 'unnamed') 
        });
      }
    }

    // Rate limit check
    await rateLimit('Web');

    logger.info(`[${searchId}] Processing web search for query: ${query}`);

    if (!process.env.SERPER_API_KEY && !process.env.TAVILY_API_KEY) {
      return res.status(200).json(failSoft({
        message: 'No search provider key configured (SERPER_API_KEY or TAVILY_API_KEY)'
      }));
    }
    const { response, provider } = await runWebSearchWithFallback(query, searchId);
    if (!response || response.status !== 200) {
      return res.status(200).json(failSoft({
        message: 'Search provider request failed (Serper/Tavily)'
      }));
    }
    logger.info(`[${searchId}] Search provider used: ${provider}`);

    const sources = [];
    const sourceMap = {};

    // Process organic results
    if (response.data?.organic) {
      response.data.organic
        .filter(result => result.link && result.title)
        .forEach((result, index) => {
          const sourceId = `web-${index}`;
          sources.push({
            type: 'WebResult',
            content: sanitizeContent(result.snippet || ''),
            url: result.link,
            timestamp: new Date().toISOString(),
            title: result.title,
            confidence: 1.0,
            sourceId
          });
          sourceMap[sourceId] = {
            url: result.link,
            title: result.title,
            source: 'web'
          };
        });
      logger.info(`[${searchId}] Added ${response.data.organic.length} organic results`);
    }

    // Process knowledge graph if available
    if (response.data?.knowledgeGraph) {
      const kg = response.data.knowledgeGraph;
      if (kg.title && kg.description) {
        const sourceId = 'kg-0';
        sources.push({
          type: 'KnowledgeGraph',
          content: sanitizeContent(kg.description),
          url: kg.url || null,
          timestamp: new Date().toISOString(),
          title: kg.title,
          confidence: 1.0,
          sourceId
        });
        sourceMap[sourceId] = {
          url: kg.url || null,
          title: kg.title,
          source: 'knowledge_graph'
        };
        logger.info(`[${searchId}] Added knowledge graph result`);
      }
    }

    // Process "People Also Ask" if available
    if (response.data?.peopleAlsoAsk) {
      response.data.peopleAlsoAsk
        .filter(item => item.question && item.snippet)
        .forEach((item, index) => {
          const sourceId = `paa-${index}`;
          sources.push({
            type: 'RelatedQuestion',
            content: sanitizeContent(item.snippet),
            url: item.link || null,
            timestamp: new Date().toISOString(),
            title: item.question,
            confidence: 0.8,
            sourceId
          });
          sourceMap[sourceId] = {
            url: item.link || null,
            title: item.question,
            source: 'people_also_ask'
          };
        });
      logger.info(`[${searchId}] Added ${response.data.peopleAlsoAsk.length} related questions`);
    }

    // Process uploaded files if any
    if (uploadedFiles.length > 0) {
      uploadedFiles.forEach((file, index) => {
        const sourceId = `file-${index}`;
        sources.push({
          type: 'UploadedFile',
          content: sanitizeContent(file.content),
          url: null,
          timestamp: new Date().toISOString(),
          title: file.name,
          confidence: 1.0,
          sourceId
        });
        sourceMap[sourceId] = {
          url: null,
          title: file.name,
          source: 'uploaded_file'
        };
      });
      logger.info(`[${searchId}] Added ${uploadedFiles.length} uploaded files`);
    }

    // Process custom URLs if any
    if (customUrls.length > 0) {
      const customResults = await Promise.allSettled(
        customUrls.map(async (url, index) => {
          const fetched = await fetchUrlContent(url, {
            timeoutMs: REQUEST_TIMEOUT,
            maxBytes: MAX_CONTENT_LENGTH,
            textLimit: MAX_CONTENT_LENGTH
          });

          if (fetched.status !== 'ok' || !fetched.content) {
            logger.error(`[${searchId}] Failed to fetch custom URL ${url}:`, fetched.error || 'No content');
            return null;
          }

            return {
              type: 'CustomUrl',
              content: sanitizeContent(fetched.content),
              url,
              timestamp: new Date().toISOString(),
              title: fetched.title || url,
              confidence: 1.0,
              sourceId: `custom-${index}`
            };
        })
      );

      customResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          const source = result.value;
          sources.push(source);
          sourceMap[source.sourceId] = {
            url: source.url,
            title: source.title,
            source: 'custom_url'
          };
        }
      });

      logger.info(`[${searchId}] Processed ${customUrls.length} custom URLs`);
    }

    res.json(normalizeSearchResponseV1({
      results: sources,
      sources, 
      status: sources.length > 0 ? 'ok' : 'fail-soft',
      degradedSources: sources.length > 0 ? [] : ['web'],
      summary: {
        content: '', // Will be filled by LLM processing
        sourceMap
      },
      synthesis: {
        enabled: false,
        provider: null,
        model: model || null,
        content: '',
      },
    }));
  } catch (error) {
    logger.error(`[${searchId}] Search error:`, error);
    res.status(200).json(normalizeSearchResponseV1({
      results: [],
      sources: [],
      status: 'fail-soft',
      degradedSources: ['web'],
      summary: {
        content: '',
        sourceMap: {}
      },
      message: 'Search failed',
      error: error.message,
      synthesis: {
        enabled: false,
        provider: null,
        model: null,
        content: null,
      },
    }));
  }
}
