import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import ModelSelector from './ModelSelector';
import SourceSelector from './SourceSelector';
import SimplifiedLLMResults, { FollowUpChat } from './search/results/SimplifiedLLMResults';
import { isLLMResult } from '../utils/isLLMResult';
import DegradedBanner from './search/DegradedBanner';

function normalizeClientError(error) {
  const axiosMessage = error?.response?.data?.error;
  if (typeof axiosMessage === 'string' && axiosMessage.trim()) {
    return axiosMessage;
  }

  const message = String(error?.message || '').trim();
  const lower = message.toLowerCase();

  if (!message) {
    return 'Search request failed. Please try again.';
  }

  if (
    lower === 'load failed' ||
    lower.includes('failed to fetch') ||
    lower.includes('network error') ||
    lower.includes('network request failed')
  ) {
    return 'Unable to reach the search API right now. Check your connection and try again.';
  }

  return message;
}

function resolveSearchEndpoints() {
  if (typeof window === 'undefined') {
    return ['/api/search'];
  }

  const host = window.location.hostname || '';
  const isLocal = host === 'localhost' || host === '127.0.0.1';

  if (isLocal) {
    return ['/api/search', 'http://127.0.0.1:3001/api/search'];
  }

  return [
    'https://searchbar3.vercel.app/api/search',
    'https://api.research.bivek.ai/api/search',
    'https://research.bivek.ai/api/search',
    '/api/search'
  ];
}

function resolveHackerNewsFallbackEndpoints(query) {
  const encodedQuery = encodeURIComponent(query || '');
  if (typeof window === 'undefined') {
    return [`/api/search/hackernews?q=${encodedQuery}`];
  }

  const host = window.location.hostname || '';
  const isLocal = host === 'localhost' || host === '127.0.0.1';

  if (isLocal) {
    return [
      `/api/search/hackernews?q=${encodedQuery}`,
      `http://127.0.0.1:3001/api/search/hackernews?q=${encodedQuery}`
    ];
  }

  return [
    `https://searchbar3.vercel.app/api/search/hackernews?q=${encodedQuery}`,
    `https://api.research.bivek.ai/api/search/hackernews?q=${encodedQuery}`,
    `https://research.bivek.ai/api/search/hackernews?q=${encodedQuery}`,
    `/api/search/hackernews?q=${encodedQuery}`
  ];
}

async function fetchPublicFallbackResults(query) {
  const encodedQuery = encodeURIComponent(query || '');
  const timeoutMs = 10000;
  const abortWithTimeout = (signalController) => setTimeout(() => signalController.abort(), timeoutMs);

  const wikipediaPromise = (async () => {
    const controller = new AbortController();
    const timeout = abortWithTimeout(controller);
    try {
      const resp = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodedQuery}&utf8=1&format=json&origin=*`,
        { signal: controller.signal }
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data?.query?.search || []).slice(0, 5).map((item) => ({
        title: item.title || 'Wikipedia Result',
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title || '')}`,
        snippet: String(item.snippet || '').replace(/<[^>]+>/g, ''),
        content: String(item.snippet || '').replace(/<[^>]+>/g, ''),
        source: 'Wikipedia'
      }));
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  })();

  const hnPromise = (async () => {
    const controller = new AbortController();
    const timeout = abortWithTimeout(controller);
    try {
      const resp = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodedQuery}&hitsPerPage=8`, {
        signal: controller.signal
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data?.hits || [])
        .filter((item) => item?.url || item?.story_url)
        .slice(0, 8)
        .map((item) => ({
          title: item.title || item.story_title || 'HackerNews Result',
          url: item.url || item.story_url,
          snippet: item.story_text || item.comment_text || '',
          content: item.story_text || item.comment_text || '',
          source: 'HackerNews'
        }));
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  })();

  const [wikiResults, hnResults] = await Promise.all([wikipediaPromise, hnPromise]);
  return [...wikiResults, ...hnResults];
}

function normalizeText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isHackerNewsSource(result) {
  const src = String(result?.source || '').toLowerCase();
  const url = String(result?.url || '').toLowerCase();
  return src.includes('hackernews') || url.includes('news.ycombinator.com');
}

function cleanupLowSignalResults(results = []) {
  const cleaned = results
    .filter(Boolean)
    .map((item) => ({
      ...item,
      title: normalizeText(item.title || 'Untitled'),
      snippet: normalizeText(item.snippet || item.content || '').slice(0, 360),
      content: normalizeText(item.content || item.snippet || '').slice(0, 800),
    }));

  const nonShowHN = cleaned.filter((item) => !String(item.title || '').toLowerCase().startsWith('show hn:'));
  return nonShowHN.length > 0 ? nonShowHN : cleaned;
}

export default function OpenSearch({ selectedModel, setSelectedModel }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Only select Web by default
  const [selectedSources, setSelectedSources] = useState(['Web']);
  const [customUrls, setCustomUrls] = useState([]);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [apiMeta, setApiMeta] = useState({ status: null, degradedSources: [], failSoftContent: null });
  const [hasSearched, setHasSearched] = useState(false);
  const resultsContainerRef = useRef(null);

  // Scroll to bottom of results when new results are loaded
  const scrollToBottom = () => {
    if (resultsContainerRef.current) {
      resultsContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  };

  useEffect(() => {
    if (query) {
      scrollToBottom();
    }
  }, [query]);

  const handleSourceToggle = (source) => {
    if (selectedSources.includes(source)) {
      setSelectedSources(selectedSources.filter(s => s !== source));
    } else {
      setSelectedSources([...selectedSources, source]);
    }
  };

  const handleCustomSourceAdd = (url) => {
    if (!customUrls.includes(url)) {
      setCustomUrls([...customUrls, url]);
    }
  };

  const handleFileUpload = (files) => {
    setUploadedFiles([...uploadedFiles, ...files]);
  };

  const handleModelChange = (model) => {
    setSelectedModel(model);
  };

  // Follow-up search functionality temporarily disabled
  const handleFollowUpSearch = (followUpQuery) => {
    setQuery(followUpQuery);
    setHasSearched(true); // Make sure to set hasSearched to true
    handleSearch(followUpQuery);
  };

  const handleSearch = async (searchQuery = query) => {
    if (!searchQuery.trim()) return;

    setLoading(true);
    setError(null);

    try {
      console.log('Performing search for query:', searchQuery);
      console.log('Selected sources:', selectedSources);
      console.log('Using model:', selectedModel);
      
      const payload = {
        query: searchQuery,
        mode: 'open',
        model: selectedModel,
        sources: selectedSources,
        customUrls: customUrls,
        files: uploadedFiles,
        useLLM: true
      };

      let response = null;
      let lastError = null;

      for (const endpoint of resolveSearchEndpoints()) {
        try {
          response = await axios.post(endpoint, payload, { timeout: 20000 });
          break;
        } catch (endpointError) {
          lastError = endpointError;
          console.warn(`Search endpoint failed: ${endpoint}`, endpointError?.response?.status || endpointError?.message);
        }
      }

      if (!response) {
        let fallbackResponse = null;
        let fallbackError = null;

        for (const fallbackEndpoint of resolveHackerNewsFallbackEndpoints(searchQuery)) {
          try {
            fallbackResponse = await axios.get(fallbackEndpoint, { timeout: 20000 });
            break;
          } catch (endpointError) {
            fallbackError = endpointError;
            console.warn(`HN fallback endpoint failed: ${fallbackEndpoint}`, endpointError?.response?.status || endpointError?.message);
          }
        }

        if (fallbackResponse?.data) {
          const fallbackResults = Array.isArray(fallbackResponse.data?.results)
            ? fallbackResponse.data.results
            : [];
          const publicFallbackResults = fallbackResults.length > 0
            ? []
            : await fetchPublicFallbackResults(searchQuery);
          const mergedFallbackResults = fallbackResults.length > 0
            ? fallbackResults
            : publicFallbackResults;
          response = {
            data: {
              status: 'degraded',
              query: searchQuery,
              results: mergedFallbackResults,
              degradedSources: ['web'],
              failSoftContent: mergedFallbackResults.length === 0 ? {
                message: 'Primary search API is unavailable right now. Showing limited fallback results.',
                suggestions: ['Try again in a minute', 'Try a different query', 'Check provider readiness at /api/debug/env-check']
              } : null
            }
          };
        } else {
          const publicFallbackResults = await fetchPublicFallbackResults(searchQuery);
          if (publicFallbackResults.length > 0) {
            response = {
              data: {
                status: 'degraded',
                query: searchQuery,
                results: publicFallbackResults,
                degradedSources: ['web'],
                failSoftContent: null
              }
            };
          }
        }

        if (!response) {
          throw fallbackError || lastError || new Error('No search endpoint responded');
        } else {
          console.warn('Using degraded fallback search path');
        }
      }
      
      setApiMeta({
        status: response.data?.status || null,
        degradedSources: Array.isArray(response.data?.degradedSources) ? response.data.degradedSources : [],
        failSoftContent: response.data?.failSoftContent || null
      });

      const responseData = response.data || {};
      const responseResults = Array.isArray(responseData.results) ? responseData.results : [];
      const llmAuthError =
        responseData?.errorType === 'auth_error' ||
        responseData?.llmResults?.errorType === 'auth_error' ||
        String(responseData?.error || '').toLowerCase().includes('authentication failed') ||
        String(responseData?.content || '').toLowerCase().includes('authentication failed');
      const isHNHeavy =
        responseResults.length > 0 &&
        responseResults.every((result) => isHackerNewsSource(result));

      let cleanedResults = cleanupLowSignalResults(responseResults);

      // If response is HN-heavy and low-signal, ask the dedicated HN route for a broader set
      // and reuse only cleaned top entries.
      if (isHNHeavy && cleanedResults.length <= 2) {
        try {
          for (const fallbackEndpoint of resolveHackerNewsFallbackEndpoints(searchQuery)) {
            const hnExpanded = await axios.get(fallbackEndpoint, { timeout: 15000 });
            if (Array.isArray(hnExpanded?.data?.results) && hnExpanded.data.results.length > 0) {
              cleanedResults = cleanupLowSignalResults(hnExpanded.data.results).slice(0, 8);
              break;
            }
          }
        } catch (expandError) {
          console.warn('Could not expand HackerNews result set:', expandError?.message || expandError);
        }
      }

      // Log the response for debugging
      console.log('Search API response structure:', {
        hasLLMResults: !!response.data.llmResults,
        hasContent: !!response.data.content,
        topLevelKeys: Object.keys(response.data).slice(0, 8),
        llmFlags: response.data.isLLMResults || response.data.isLLMResult || response.data.__isImmutableLLMResult
      });
      
      // Enhanced LLM detection using utility function
      console.log('Performing LLM result detection on response data');
      
      if (llmAuthError && cleanedResults.length > 0) {
        console.warn('LLM auth error detected; rendering source results instead of auth wrapper.');
        setResults(cleanedResults);
      } else if (isLLMResult(response.data)) {
        console.log('✅ Successfully detected LLM-formatted results');
        
        // Determine if we should use a property or the whole object
        if (response.data.llmResults && isLLMResult(response.data.llmResults)) {
          console.log('Using nested llmResults from response');
          setResults({
            ...response.data.llmResults,
            __isImmutableLLMResult: true,
            isLLMResult: true,
            query: searchQuery
          });
        } else {
          // Use the whole response when it's the LLM result itself
          console.log('Using entire response as LLM result');
          setResults({
            ...response.data,
            __isImmutableLLMResult: true,
            isLLMResult: true,
            query: searchQuery
          });
        }
      } else if (response.data.content && typeof response.data.content === 'string') {
        // Explicitly format as LLM result when content is present
        console.log('Formatting content property as LLM result');
        setResults({
          content: response.data.content,
          isLLMResult: true,
          __isImmutableLLMResult: true,
          query: searchQuery
        });
      } else if (response.data.results) {
        // Fallback to regular results
        console.log('Using regular search results array');
        setResults(cleanedResults);
      } else if (typeof response.data === 'string') {
        // Handle case where response might be a plain string
        console.log('Handling string response');
        setResults([response.data]);
      } else {
        // Create empty result if nothing found
        console.log('No recognizable results format');
        setResults([]);
      }
      
      setHasSearched(true);
      
    } catch (err) {
      console.error('Search error:', err.response?.data || err.message);
      setError(normalizeClientError(err));
      // Set empty results
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6">
      <div className="mb-6">
        {/* Search interface */}
        <div className="mb-4">
          <div className="flex w-full">
            <div className="flex-grow bg-gray-100 rounded-l-md border border-gray-300">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search across sources..."
                className="w-full bg-transparent border-none focus:outline-none focus:ring-0 px-4 py-2"
              />
            </div>
            <div className="flex">
              <div className="w-[150px] bg-gray-100 border-y border-r border-gray-300">
                <ModelSelector 
                  selectedModel={selectedModel} 
                  onChange={handleModelChange}
                />
              </div>
              <button
                onClick={() => handleSearch()}
                disabled={loading}
                className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-r-md disabled:opacity-50"
              >
                {loading ? 'Searching...' : 'Search'}
              </button>
            </div>
          </div>
        </div>
        
        {/* Source selector */}
        <SourceSelector
          mode="open"
          selectedSources={selectedSources}
          onSourceToggle={handleSourceToggle}
          onCustomSourceAdd={handleCustomSourceAdd}
          onFileUpload={handleFileUpload}
          isLoading={loading}
        />
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-10">
          <p className="text-gray-600">Searching... This may take a moment.</p>
        </div>
      ) : (
        <div ref={resultsContainerRef}>
          {hasSearched && apiMeta.degradedSources.length > 0 && (
            <DegradedBanner degradedSources={apiMeta.degradedSources} status={apiMeta.status} />
          )}

          {hasSearched && query && (
            <>
              <SimplifiedLLMResults 
                query={query}
                results={results}
                onFollowUpSearch={handleFollowUpSearch}
              />

              {Array.isArray(results) && results.length === 0 && (
                <div className="mt-4 border rounded-md p-4 bg-amber-50 border-amber-200 text-amber-900">
                  <div className="font-semibold mb-1">No direct results yet</div>
                  <p className="text-sm mb-2">Try refining your query or enabling additional sources. The system is in fail-soft mode, so it will keep returning a safe response.</p>
                  <ul className="list-disc ml-5 text-sm">
                    {(apiMeta.failSoftContent?.exampleQueries || [
                      'AI infrastructure Series B deals 2024',
                      'SaaS ARR multiples Q4 2024',
                      'Robotics logistics startup funding'
                    ]).map((q) => <li key={q}>{q}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
