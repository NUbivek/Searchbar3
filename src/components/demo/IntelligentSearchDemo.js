import React, { useState } from 'react';
import { IntelligentSearchResults } from '../search/results';

/**
 * Demo component for showcasing intelligent search results
 * @returns {JSX.Element} Rendered demo component
 */
const IntelligentSearchDemo = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState(null);

  // Handle search form submission
  const handleSearch = async (e) => {
    e.preventDefault();
    
    if (!query.trim()) {
      return;
    }
    
    setIsSearching(true);
    setError(null);
    
    try {
      // Simulate search API call
      // /api/search only accepts POST
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      
      if (!response.ok) {
        throw new Error(`Search failed with status: ${response.status}`);
      }
      
      const data = await response.json();
      setResults(data.results || []);
    } catch (err) {
      console.error('Search error:', err);
      setError(err.message || 'An error occurred during search');
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="intelligent-search-demo">
      <div className="search-header">
        <h1>Intelligent Search</h1>
        <p>Try searching for business topics like "market analysis for electric vehicles" or technical topics like "react component optimization"</p>
      </div>
      
      <form className="search-form" onSubmit={handleSearch}>
        <div className="search-input-container">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter your search query..."
            className="search-input"
          />
          <button type="submit" className="search-button" disabled={isSearching}>
            {isSearching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>
      
      {error && (
        <div className="search-error">
          <p>{error}</p>
        </div>
      )}
      
      {isSearching && (
        <div className="search-loading">
          <div className="spinner"></div>
          <p>Searching for "{query}"...</p>
        </div>
      )}
      
      {!isSearching && results && (
        <div className="search-results-container">
          <IntelligentSearchResults 
            results={results} 
            query={query} 
            options={{
              showMetrics: true,
              useEnhancedView: true,
              extractBusinessInsights: true
            }}
          />
        </div>
      )}
      
      {/* Example search suggestions */}
      {!results && !isSearching && (
        <div className="search-suggestions">
          <h3>Try these example searches:</h3>
          <ul>
            <li><button onClick={() => setQuery('market analysis for electric vehicles')}>Market analysis for electric vehicles</button></li>
            <li><button onClick={() => setQuery('financial performance of tech companies')}>Financial performance of tech companies</button></li>
            <li><button onClick={() => setQuery('react component optimization techniques')}>React component optimization techniques</button></li>
            <li><button onClick={() => setQuery('latest medical research on diabetes')}>Latest medical research on diabetes</button></li>
          </ul>
        </div>
      )}
      
      {/* Add some CSS for the demo */}
      <style jsx>{`
        .intelligent-search-demo {
          max-width: 1200px;
          margin: 0 auto;
          padding: 2rem;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
        }
        
        .search-header {
          text-align: center;
          margin-bottom: 2rem;
        }
        
        .search-header h1 {
          font-size: 2.5rem;
          margin-bottom: 0.5rem;
          color: #0066cc;
        }
        
        .search-header p {
          font-size: 1.1rem;
          color: #555;
        }
        
        .search-form {
          margin-bottom: 2rem;
        }
        
        .search-input-container {
          display: flex;
          max-width: 800px;
          margin: 0 auto;
        }
        
        .search-input {
          flex: 1;
          padding: 0.8rem 1rem;
          font-size: 1.1rem;
          border: 2px solid #ddd;
          border-radius: 4px 0 0 4px;
          outline: none;
          transition: border-color 0.2s;
        }
        
        .search-input:focus {
          border-color: #0066cc;
        }
        
        .search-button {
          padding: 0.8rem 1.5rem;
          font-size: 1.1rem;
          background-color: #0066cc;
          color: white;
          border: none;
          border-radius: 0 4px 4px 0;
          cursor: pointer;
          transition: background-color 0.2s;
        }
        
        .search-button:hover {
          background-color: #0055aa;
        }
        
        .search-button:disabled {
          background-color: #999;
          cursor: not-allowed;
        }
        
        .search-error {
          padding: 1rem;
          margin-bottom: 1rem;
          background-color: #ffebee;
          border-left: 4px solid #f44336;
          color: #d32f2f;
        }
        
        .search-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 2rem;
        }
        
        .spinner {
          width: 40px;
          height: 40px;
          border: 4px solid rgba(0, 102, 204, 0.2);
          border-radius: 50%;
          border-top-color: #0066cc;
          animation: spin 1s linear infinite;
          margin-bottom: 1rem;
        }
        
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        .search-suggestions {
          margin-top: 2rem;
          padding: 1.5rem;
          background-color: #f5f9ff;
          border-radius: 8px;
        }
        
        .search-suggestions h3 {
          margin-top: 0;
          color: #0066cc;
        }
        
        .search-suggestions ul {
          list-style: none;
          padding: 0;
        }
        
        .search-suggestions li {
          margin-bottom: 0.8rem;
        }
        
        .search-suggestions button {
          background: none;
          border: none;
          color: #0066cc;
          text-decoration: underline;
          cursor: pointer;
          font-size: 1rem;
          padding: 0;
        }
        
        .search-suggestions button:hover {
          color: #0055aa;
        }
        
        .search-results-container {
          margin-top: 2rem;
        }
      `}</style>
    </div>
  );
};

export default IntelligentSearchDemo;
