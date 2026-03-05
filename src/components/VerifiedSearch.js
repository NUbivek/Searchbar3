import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { logger } from '../utils/logger';
import SearchResultsWrapper from './SearchResultsWrapper';
import { IntelligentSearchResults, SimpleLLMResults } from './search/results';
import { SearchModes, MODEL_OPTIONS } from '../utils/constants';
import { processWithLLM } from '../utils/search-legacy';
import FileUpload from './FileUpload';
import UrlInput from './UrlInput';
import { getAllVerifiedSources } from '../utils/verifiedDataSources';
import { ALL_VERIFIED_SOURCES } from '../utils/allVerifiedSources';
import { safeStringify } from '../utils/reactUtils';
import { executeSearch, getSourcesFromSelection } from '../utils/search/searchFlowHelper';
import { FaSpinner, FaSearch } from 'react-icons/fa';
import SourceSelector from './SourceSelector';
import { buildApiUrl } from '../utils/clientApi';

export default function VerifiedSearch({ isNetworkMapMode = false, selectedModel, setSelectedModel }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifiedResults, setVerifiedResults] = useState([]);
  const [selectedSources, setSelectedSources] = useState(['linkedin', 'twitter', 'reddit']);
  const [customUrls, setCustomUrls] = useState([]);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [chatHistory, setChatHistory] = useState([]);
  const chatEndRef = useRef(null);
  
  // Scroll to bottom when chat updates
  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  
  useEffect(() => {
    scrollToBottom();
  }, [chatHistory]);

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

  const handleFollowUpSearch = (followUpQuery) => {
    setQuery(followUpQuery);
    handleSearch(followUpQuery);
  };

  const handleSearch = async (searchQuery = query) => {
    if (!searchQuery.trim()) return;
    
    setLoading(true);
    
    // Add user query to chat history
    setChatHistory(prev => [...prev, { 
      type: 'user',
      content: searchQuery
    }]);
    
    try {
      // Prepare search options
      const searchOptions = {
        sources: selectedSources,
        customUrls,
        uploadedFiles,
        model: selectedModel
      };
      
      console.log('Sending unified search request:', { query: searchQuery, options: searchOptions });
      
      // Call the main search API directly
      const response = await axios.post(buildApiUrl('/api/search'), {
        query: searchQuery,
        mode: 'verified',
        useLLM: true,
        model: selectedModel,
        sources: selectedSources,
        customUrls: customUrls,
        files: uploadedFiles
      }, {
        timeout: 120000, // 2 minute timeout
        timeoutErrorMessage: 'Search request timed out. The operation may be taking too long to complete.'
      });
      
      const data = response.data;
      
      console.log('Search API response structure:', {
        hasLLMResults: !!data.llmResults,
        hasContent: !!data.content,
        topLevelKeys: Object.keys(data).slice(0, 8),
        llmFlags: data.isLLMResults || data.isLLMResult || data.__isImmutableLLMResult
      });
      
      // Check for LLM results first
      if (data.llmResults || data.isLLMResults || data.isLLMResult || data.__isImmutableLLMResult) {
        console.log('Detected LLM results in the response');
        
        // Use the LLM results directly
        const llmContent = data.llmResults || data;
        setVerifiedResults([llmContent]);
        
        // Add LLM results to chat history
        setChatHistory(prev => [...prev, { 
          type: 'assistant',
          content: llmContent
        }]);
      } else {
        // Fallback to traditional results handling
        const resultsArray = data.results || [];
        console.log('Using traditional results array:', resultsArray.length, 'items');
        
        setVerifiedResults(resultsArray);
        
        // Add results to chat history
        setChatHistory(prev => [...prev, { 
          type: 'assistant',
          content: resultsArray
        }]);
      }
      
    } catch (error) {
      console.error('Search error:', error);
      
      // Create appropriate error message based on the error type
      let errorMessage = 'An error occurred while searching. Please try again.';
      
      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Search request timed out. Please try a more specific query or select fewer sources.';
      } else if (error.response?.data?.error) {
        errorMessage = error.response.data.error;
      } else if (error.message) {
        errorMessage = `Error: ${error.message}`;
      }
      
      console.log('Setting error message:', errorMessage);
      
      // Add error message to chat history
      setChatHistory(prev => [...prev, { 
        type: 'assistant',
        content: errorMessage
      }]);
    } finally {
      setLoading(false);
    }
  };

  // If in Network Map mode, display only the network visualization without search functionality
  if (isNetworkMapMode) {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="mb-4">
            <h2 className="text-xl font-semibold">Network Map</h2>
            <p className="text-gray-600">
              Visualize your professional network and connections across platforms.
            </p>
          </div>
          
          <div className="flex space-x-4 mb-6">
            <div className="w-full">
              <SourceSelector 
                mode="verified"
                selectedSources={selectedSources}
                onSourceToggle={handleSourceToggle}
                onCustomSourceAdd={handleCustomSourceAdd}
                onFileUpload={handleFileUpload}
                isLoading={loading}
              />
            </div>
          </div>
          
          {/* Network Visualization Placeholder */}
          <div className="border rounded-lg p-6 bg-gray-50 min-h-[400px] flex items-center justify-center">
            <div className="text-center">
              <h3 className="text-lg font-medium mb-2">Network Visualization</h3>
              <p className="text-gray-500 mb-4">Select sources to visualize your network connections</p>
              
              {selectedSources.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl mx-auto">
                  {selectedSources.map(source => (
                    <div key={source} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
                      <div className="font-medium capitalize">{source}</div>
                      <div className="text-sm text-gray-500">Connected</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Regular Verified Search mode with search functionality
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold">Verified Sources Search</h2>
          <p className="text-gray-600">
            Search across trusted platforms including LinkedIn, Twitter, and Reddit.
          </p>
        </div>
        
        <div className="flex mb-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search verified sources..."
            className="flex-grow form-input rounded-l-md border-gray-300 focus:border-blue-500 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            disabled={loading || selectedSources.length === 0}
          />
          <button
            onClick={() => handleSearch()}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-r-md flex items-center"
            disabled={loading || !query.trim() || selectedSources.length === 0}
          >
            {loading ? <FaSpinner className="animate-spin" /> : <FaSearch />}
            <span className="ml-2">Search</span>
          </button>
        </div>
        
        <div className="flex space-x-4">
          <div className="w-full">
            <SourceSelector 
              mode="verified"
              selectedSources={selectedSources}
              onSourceToggle={handleSourceToggle}
              onCustomSourceAdd={handleCustomSourceAdd}
              onFileUpload={handleFileUpload}
              isLoading={loading}
            />
          </div>
        </div>
      </div>
      
      <div className="bg-white rounded-xl shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center h-full p-8">
            <FaSpinner className="animate-spin text-blue-600" size={24} />
          </div>
        ) : (
          <>
            {chatHistory.length > 0 && (
              <SimpleLLMResults 
                results={chatHistory}
                onFollowUpSearch={handleFollowUpSearch}
                query={query}
                showTabs={true}
                forceShowTabs={false}
                defaultTab="Results"
              />
            )}
          </>
        )}
        <div ref={chatEndRef} />
      </div>
    </div>
  );
}
