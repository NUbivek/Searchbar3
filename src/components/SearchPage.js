'use client';

import { useState } from 'react';
import { SearchModes, OPEN_SOURCE_TYPES } from '../utils/constants';
import ModelSelector from './ModelSelector';
import SourceSelector from './SourceSelector';
import SearchResultsWrapper from './SearchResultsWrapper';
import SearchErrorBoundary from './SearchErrorBoundary';
import FileUpload from './FileUpload';
import UrlInput from './UrlInput';

function normalizeClientError(error) {
  const message = String(error?.message || '').trim();
  const lower = message.toLowerCase();

  if (!message) {
    return 'Search request failed. Please try again.';
  }

  if (
    lower === 'load failed' ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network request failed')
  ) {
    return 'Unable to reach the search API right now. Check your connection and try again.';
  }

  if (lower.includes('non-json response')) {
    return 'Search API returned an unexpected response. Please retry in a moment.';
  }

  return message;
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState(SearchModes.VERIFIED);
  const [selectedModel, setSelectedModel] = useState('mistral');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchResults, setSearchResults] = useState(null);
  const [showCustomSources, setShowCustomSources] = useState(false);
  const [selectedSources, setSelectedSources] = useState([]);

  const handleSearch = async () => {
    if (!query.trim()) return;

    setIsLoading(true);
    setError(null);
    setSearchResults(null);

    try {
      // Use the correct API endpoint
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          query: query.trim(), 
          mode, 
          model: selectedModel,
          sources: selectedSources 
        }),
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await response.text();
        throw new Error(
          `Server returned non-JSON response (status ${response.status})${text ? `: ${text.slice(0, 140)}` : ''}`
        );
      }

      const data = await response.json();
      
      // Check for error response even with status 200
      // LLM error objects have specific properties we can check for
      if (!response.ok || data?.error || data?.errorType || 
          (data?.content && typeof data.content === 'string' && data.content.includes('error-message'))) {
        console.error('Search error detected in response', data);
        if (data?.errorMessage) {
          throw new Error(data.errorMessage);
        } else if (data?.message) {
          throw new Error(data.message);
        } else if (data?.error) {
          throw new Error(typeof data.error === 'string' ? data.error : 'Search failed');
        } else {
          throw new Error('Search failed');
        }
      }
      
      console.log('Search results:', data);
      
      // Set search results, ensuring we have a valid array
      if (data && (Array.isArray(data.results) || Array.isArray(data))) {
        setSearchResults(data);
      } else if (data && data.content) {
        // Handle LLM result object format
        setSearchResults(data);
      } else {
        // Create a default structure if the response doesn't match expected format
        setSearchResults([{
          type: 'assistant',
          content: 'No results found for your query. Please try a different search term.'
        }]);
      }
    } catch (error) {
      setError(normalizeClientError(error));
      console.error('Search error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <div className="text-center mb-8">
        <h1 className="text-[32px] font-bold text-[#1E3A8A] mb-2">Research Hub</h1>
        <p className="text-gray-600">
          Search across verified sources and market data
        </p>
      </div>

      <div className="flex justify-center mb-8">
        <SourceSelector mode={mode} onModeChange={setMode} />
      </div>

      <div className="relative mb-6">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter your search query"
          className="w-full px-4 py-2.5 pr-[180px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#0066FF]"
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <ModelSelector
            selectedModel={selectedModel}
            onModelSelect={setSelectedModel}
          />
          <button
            onClick={handleSearch}
            disabled={isLoading}
            className="px-5 py-1.5 bg-[#0066FF] text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            Search
          </button>
        </div>
      </div>

      {mode === SearchModes.OPEN && (
        <div className="flex flex-wrap gap-2 mb-8">
          {OPEN_SOURCE_TYPES.map((source) => (
            <button
              key={source.id}
              onClick={() => {
                if (source.id === 'files_url') {
                  setShowCustomSources(true);
                } else {
                  setSelectedSources(prev => 
                    prev.includes(source.id)
                      ? prev.filter(id => id !== source.id)
                      : [...prev, source.id]
                  );
                }
              }}
              className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                selectedSources.includes(source.id)
                  ? 'bg-[#0066FF] text-white'
                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
              }`}
            >
              {source.name}
            </button>
          ))}
        </div>
      )}

      {showCustomSources && (
        <div className="mb-8 p-4 bg-gray-50 rounded-lg">
          <FileUpload />
          <div className="mt-4">
            <UrlInput />
          </div>
        </div>
      )}

      <SearchErrorBoundary>
        <SearchResultsWrapper 
          results={searchResults}
          isLoading={isLoading}
          error={error}
          query={query}
        />
      </SearchErrorBoundary>
    </div>
  );
}
