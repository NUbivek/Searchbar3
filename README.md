# Research Hub Search Application

> **IMPORTANT**: For a comprehensive guide to the search and UI flow in all circumstances, please refer to the [USER FLOW DOCUMENTATION](./USER_FLOW.md) first.

A sophisticated search application that integrates multiple data sources, including verified platforms, market data, and open research sources, to provide comprehensive research capabilities.

## Features

### Open Research
- **Web Search**: General web results using Serper API
- **Verified Sources**: Access to LinkedIn, Twitter, and Reddit data
- **Custom URLs**: Add and search specific websites
- **File Upload**: Process and search through uploaded documents
- **LLM Processing**: AI-powered insights from search results

### Network Map
- **Professional Network Visualization**: View your connections across platforms
- **LinkedIn Integration**: Professional network data
- **Twitter Integration**: Social media connections
- **Reddit Integration**: Community participation

### Verified Sources
- **LinkedIn**: Professional network search with OAuth 2.0 authentication
- **Twitter/X**: Social media insights with Bearer token authentication
- **Reddit**: Community discussions with OAuth 2.0 authentication
- **Carta**: Equity management and cap table information

### Market Data Sources
- **Financial Modeling Prep (FMP)**:
  - Real-time stock quotes and market data
  - Visual indicators for price changes (↑/↓)
  - Exchange information and market cap
  - Volume and price change percentages
- **FRED**: Economic data and indicators
- **Bloomberg**: Financial news and market analysis
- **Reuters**: Global financial news and data
- **WSJ**: Market insights and financial reporting

### Open Research Sources
- **Substack**: Newsletter and blog content
- **Medium**: Article and publication search
- **Crunchbase**: Company and startup information
- **Pitchbook**: Investment and market data

### LLM Processing
- **Multi-Model Support**: Integrated with multiple LLM providers and models:
  - Together API: mixtral-8x7b, mistral-7b, gemma-7b
  - Perplexity API: sonar-small-chat
- **Smart Fallback System**: Automatic fallbacks between models and providers
- **Comprehensive Error Handling**: Ensures consistent user experience even when APIs fail
- **Source Preservation**: Maintains source attribution throughout the processing pipeline
- **Dynamic Content Generation**: Creates summaries, insights, and follow-up questions

### Core Functionality
- Multi-source parallel search processing
- Real-time results aggregation
- Source-specific rate limiting
- Intelligent error handling and fallbacks
- Modern, responsive UI with Tailwind CSS
- Smart stock symbol extraction
- Market data visualization
- Advanced search result scoring system

### LLM Integration
- **Mixtral-8x7b**: Primary LLM model for processing search results
- **Llama-2-70b**: Alternative high-performance model
- **Gemma-2-9b**: Lightweight model option
- **Automatic Fallback**: Graceful degradation to Mixtral if other models fail

## Architecture

### Frontend
- **Framework**: Next.js with React
- **Components**:
  - `OpenSearch.js`: Open research interface
  - `VerifiedSearch.js`: Verified sources interface
  - `SourceSelector.js`: Source selection management
  - `SearchResults.js`: Results display
  - `FileUpload.js`: File processing
  - `UrlInput.js`: Custom URL handling
  - `MarketData.js`: Stock and financial data display
  - `MetricsCalculator.js`: Search result scoring system

### Backend
- **API Routes** (`/src/pages/api/`):
  - `/search/*`: Source-specific search handlers
  - `/llm/*`: Language model processing
  - `/middleware/*`: Request processing
  - `/market/*`: Financial data endpoints

### Utilities
- `rateLimiter.js`: API request throttling
- `logger.js`: Structured logging
- `combinedSearch.js`: Multi-source search orchestration
- `calculatorUtils.js`: Metrics calculation utilities
- `contextDetector.js`: Query context detection

## Search Components

The application uses a sophisticated multi-component search architecture:

### Core Components
- **SearchResults**: Central component for displaying all search results
- **LLMResults**: Displays AI-synthesized answers with sources
- **TraditionalResults**: Displays web search results in a traditional format
- **SearchResultsWrapper**: Adapter component that handles format conversion between different data structures

### Recent Improvements (v0.5.0)
- Fixed critical issues with Verified Sources search results display
- Enhanced format conversion between chat history and search results
- Improved error handling and content processing
- Added comprehensive debug logging throughout search components

For detailed documentation on search components, see [SEARCH_COMPONENTS.md](./docs/SEARCH_COMPONENTS.md).

## Search Metrics System

The application uses a sophisticated metrics system to evaluate search results:

### Metrics Components
- **MetricsCalculator**: Central component for calculating all metrics
- **RelevanceCalculator**: Calculates how well results match the query
- **AccuracyCalculator**: Evaluates factual correctness and reliability
- **CredibilityCalculator**: Assesses source trustworthiness

### Key Features
- Context-aware scoring based on query type (financial, medical, etc.)
- User preference integration for personalized results
- Threshold-based filtering to ensure quality
- Visual indicators for result quality (colors and labels)

For detailed documentation on the metrics system, see [METRICS_SYSTEM.md](./docs/METRICS_SYSTEM.md).

## Setup

1. **Clone and Install**:
   ```bash
   git clone https://github.com/yourusername/searchbar.git
   cd searchbar
   npm install
   ```

2. **Environment Configuration**:
   Copy `.env.local.example` (or `.env.local.sample`) to `.env.local` and fill in your API keys:
   ```env
   # LLM API Keys
   TOGETHER_API_KEY=your_together_api_key
   PERPLEXITY_API_KEY=your_perplexity_api_key

   # Search API Keys
   SERPER_API_KEY=your_serper_api_key

   # Social Media APIs
   TWITTER_API_KEY=your_twitter_api_key
   LINKEDIN_CLIENT_ID=your_linkedin_client_id
   LINKEDIN_CLIENT_SECRET=your_linkedin_client_secret
   REDDIT_CLIENT_ID=your_reddit_client_id
   REDDIT_CLIENT_SECRET=your_reddit_client_secret

   # Market Data APIs
   FMP_API_KEY=your_fmp_api_key
   FRED_API_KEY=your_fred_api_key
   ```

3. **Development Server**:
   ```bash
   npm run dev
   ```

## API Integration Details

### Financial Modeling Prep (FMP)
- API key authentication
- Rate limit: 300 requests/minute
- Real-time stock quotes and market data
- Features:
  - Stock price and market data with visual indicators
  - Price change percentages and volume
  - Market cap and exchange information
  - Company financials and ratios
  - Smart symbol extraction from queries
  - Fallback to web search for unknown symbols

### LinkedIn
- OAuth 2.0 with client credentials
- Rate limit: 100 requests/minute
- Fallback: Serper API for search results

### Twitter/X
- Bearer token authentication
- Rate limit: 500 requests/15-minutes
- Fallback: Serper API for search results

### Reddit
- OAuth 2.0 with client credentials
- Rate limit: 60 requests/minute
- Fallback: Serper API for search results

### Web Search (Serper)
- API key authentication
- Rate limit: 100 requests/minute
- Used for general web search and fallback

## Error Handling

1. **API Failures**:
   - Automatic fallback to Serper API
   - Retry mechanism with exponential backoff
   - Detailed error logging

2. **Rate Limiting**:
   - Per-source rate limiting
   - Queue system for concurrent requests
   - Clear user feedback on limits

3. **Data Validation**:
   - Input sanitization
   - Response format verification
   - Error recovery strategies

4. **LLM Processing**:
   - Automatic model fallback system
   - Graceful handling of empty results
   - Detailed error logging with response inspection
   - Fallback to Mixtral-8x7b when other models fail

## Security

1. **API Key Management**:
   - Environment variables
   - Server-side only access
   - Key rotation support

2. **Request Validation**:
   - Input sanitization
   - Rate limiting
   - CORS configuration

## Testing

- **Unit Tests**: Component and utility testing
- **Integration Tests**: API endpoint testing
- **End-to-End Tests**: Full search flow testing

## Performance Optimization

1. **Search Optimization**:
   - Parallel API requests
   - Response caching
   - Result deduplication

2. **UI Performance**:
   - Code splitting
   - Lazy loading
   - Debounced search

## Environment Diagnostics

Use this endpoint to validate configuration safely (no secret values returned):

- `GET /api/debug/env-check`

For provider readiness reference, see:

- `PROVIDER_CAPABILITY_MATRIX.md`

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - See LICENSE file for details

## UI Layout

The application now consists of two main tabs:

1. **Open Research** (Default tab)
   - Comprehensive search across multiple sources
   - Includes Web, Verified Sources, Academic, and News
   - Custom URL and file upload capabilities
   - LLM-powered insights and summaries

2. **Network Map** 
   - Visual representation of professional connections
   - LinkedIn, Twitter, and Reddit network visualization
   - Connection exploration and insights
   - No search functionality - purely for network visualization
