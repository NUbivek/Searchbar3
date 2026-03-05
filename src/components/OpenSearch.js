import React, { useState, useRef, useEffect } from 'react';
import ModelSelector from './ModelSelector';
import SourceSelector from './SourceSelector';
import SimplifiedLLMResults, { FollowUpChat } from './search/results/SimplifiedLLMResults';
import { isLLMResult } from '../utils/isLLMResult';
import DegradedBanner from './search/DegradedBanner';
import { postSearchRequest } from '../utils/clientApi';

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
      
      // Make actual API call to the search endpoint
      const data = await postSearchRequest({
        query: searchQuery,
        mode: 'open',
        model: selectedModel,
        sources: selectedSources,
        customUrls,
        files: uploadedFiles,
        useLLM: true
      });
      
      setApiMeta({
        status: data?.status || null,
        degradedSources: Array.isArray(data?.degradedSources) ? data.degradedSources : [],
        failSoftContent: data?.failSoftContent || null
      });

      // Log the response for debugging
      console.log('Search API response structure:', {
        hasLLMResults: !!data.llmResults,
        hasContent: !!data.content,
        topLevelKeys: Object.keys(data).slice(0, 8),
        llmFlags: data.isLLMResults || data.isLLMResult || data.__isImmutableLLMResult
      });
      
      // Enhanced LLM detection using utility function
      console.log('Performing LLM result detection on response data');
      
      if (isLLMResult(data)) {
        console.log('✅ Successfully detected LLM-formatted results');
        
        // Determine if we should use a property or the whole object
        if (data.llmResults && isLLMResult(data.llmResults)) {
          console.log('Using nested llmResults from response');
          setResults({
            ...data.llmResults,
            __isImmutableLLMResult: true,
            isLLMResult: true,
            query: searchQuery
          });
        } else {
          // Use the whole response when it's the LLM result itself
          console.log('Using entire response as LLM result');
          setResults({
            ...data,
            __isImmutableLLMResult: true,
            isLLMResult: true,
            query: searchQuery
          });
        }
      } else if (data.content && typeof data.content === 'string') {
        // Explicitly format as LLM result when content is present
        console.log('Formatting content property as LLM result');
        setResults({
          content: data.content,
          isLLMResult: true,
          __isImmutableLLMResult: true,
          query: searchQuery
        });
      } else if (data.results) {
        // Fallback to regular results
        console.log('Using regular search results array');
        setResults(data.results);
      } else if (typeof data === 'string') {
        // Handle case where response might be a plain string
        console.log('Handling string response');
        setResults([data]);
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
