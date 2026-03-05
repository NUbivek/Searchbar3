import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { logger } from '../../../utils/logger';
import SearchResultsWrapper from '../../SearchResultsWrapper';
import { SimpleLLMResults } from '../results';
import { MODEL_OPTIONS } from '../../../utils/constants';
import FileUpload from '../../FileUpload';
import UrlInput from '../../UrlInput';
import { safeStringify } from '../../../utils/reactUtils';
import { FaSpinner, FaSearch } from 'react-icons/fa';
import SourceSelector from '../../SourceSelector';
import { buildApiUrl } from '../../../utils/clientApi';

/**
 * EnhancedSearch component with LLM processing capabilities
 * This is an improved version of the VerifiedSearch component
 * that directly uses the main search API
 */
export default function EnhancedSearch({ isNetworkMapMode = false, selectedModel, setSelectedModel }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
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
  
  // Handler for model change
  const handleModelChange = (e) => {
    if (setSelectedModel) {
      setSelectedModel(e.target.value);
    }
  };

  // Handler for search submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    const searchQuery = query.trim();
    
    if (!searchQuery) return;
    
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
      
      console.log('Sending search request:', { query: searchQuery, options: searchOptions });
      
      // Call the main search API directly
      const response = await axios.post(buildApiUrl('/api/search'), {
        query: searchQuery,
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
        setSearchResults([llmContent]);
        
        // Add LLM results to chat history
        setChatHistory(prev => [...prev, { 
          type: 'assistant',
          content: llmContent
        }]);
      } else {
        // Fallback to traditional results handling
        const resultsArray = data.results || [];
        console.log('Using traditional results array:', resultsArray.length, 'items');
        
        setSearchResults(resultsArray);
        
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
        type: 'error',
        content: errorMessage
      }]);
    } finally {
      setLoading(false);
    }
  };

  // Handle follow-up search
  const handleFollowUpSearch = (followUpQuery) => {
    setQuery(followUpQuery);
    handleSubmit({ preventDefault: () => {} });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <form onSubmit={handleSubmit} className="flex flex-col space-y-4">
          <div className="flex flex-col md:flex-row space-y-2 md:space-y-0 md:space-x-4">
            <div className="flex-grow relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <FaSearch className="text-gray-400" />
              </div>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Ask a research question..."
              />
            </div>
            
            <div className="flex-shrink-0">
              <select
                value={selectedModel}
                onChange={handleModelChange}
                className="block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              >
                {MODEL_OPTIONS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </div>
            
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-blue-300"
            >
              {loading ? (
                <>
                  <FaSpinner className="animate-spin -ml-1 mr-2 h-4 w-4" />
                  Searching...
                </>
              ) : (
                'Search'
              )}
            </button>
          </div>
          
          <div className="flex flex-col md:flex-row space-y-4 md:space-y-0 md:space-x-4">
            <div className="w-full md:w-2/3">
              <SourceSelector 
                selectedSources={selectedSources} 
                setSelectedSources={setSelectedSources} 
              />
            </div>
            
            <div className="w-full md:w-1/3 space-y-2">
              <UrlInput 
                customUrls={customUrls} 
                setCustomUrls={setCustomUrls} 
              />
              <FileUpload 
                uploadedFiles={uploadedFiles} 
                setUploadedFiles={setUploadedFiles} 
              />
            </div>
          </div>
        </form>
      </div>
      
      <div className="space-y-4">
        {chatHistory.length > 0 && (
          <div className="chat-container border border-gray-200 rounded-lg p-4 max-h-[600px] overflow-y-auto bg-white">
            {chatHistory.map((message, index) => (
              <div 
                key={index} 
                className={`mb-4 ${message.type === 'user' ? 'text-right' : 'text-left'}`}
              >
                <div 
                  className={`inline-block max-w-xl rounded-lg px-4 py-2 ${
                    message.type === 'user' 
                      ? 'bg-blue-100 text-blue-800' 
                      : message.type === 'error'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {message.type === 'user' ? (
                    <p>{message.content}</p>
                  ) : message.type === 'error' ? (
                    <p>{message.content}</p>
                  ) : (
                    <SimpleLLMResults results={message.content} query={query} onFollowUpSearch={handleFollowUpSearch} />
                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}
