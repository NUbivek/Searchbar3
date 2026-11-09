# Changelog

All notable changes to this project will be documented in this file.

## [0.7.0] - 2026-11-08

### Security
- Removed routes that allowed unauthenticated file deletion (`/api/cleanup`),
  reflected request headers including cookies (`/api/debug-info`), and
  fetched arbitrary URLs server-side (`/api/fetch-url`, `/api/webScrape`),
  plus the dead OAuth relay, helper modules exposed as routes
  (`/api/middleware*`), the catch-all route and the Edge middleware that
  logged every API request and set `Access-Control-Allow-Origin: *` with
  credentials. Removed the matching CORS headers and legacy `routes` from
  `vercel.json`.
- `/api/debug/env-check` now requires a signed-in session in production.
- `/api/alerts` and `listAlerts` clamp `limit` to 1..500 (a negative limit
  returned 500).
- `/api/upload` writes to the OS temp directory (Vercel's filesystem is
  read-only outside `/tmp`), deletes the uploaded copy right after parsing,
  and requires the file extension and declared MIME type to agree.
- Method checks on `/api/network/twitter` and `/api/llm/models`;
  `maxDuration: 60` on `/api/company`, `/api/workspaces/[id]/ask` and
  `/api/llm/models`.

### Fixed
- PDF uploads: the custom page renderer returned objects, so extracted text
  was `[object Object]`. The default extractor is used; a PDF with no text
  layer (scan) and an unreadable file now get different messages.
- `pdf-parse` updated to 1.1.4 (maintained 1.x line, same API).

### Removed
- 463 unreachable files under `src/` (archived components, `.bak`/`.old`
  copies, zero-byte placeholders, legacy search/LLM/auth routes and the
  utilities only they used), the dead Express app in `server/`, root-level
  backups and scratch scripts, GitHub Pages deploy workflow and `CNAME`,
  legacy port-switch and category-debug scripts, and tests that only
  covered deleted code.
- Unused dependencies (`ai`, `d3`, `date-fns`, `@heroicons/react`,
  `@tailwindcss/forms`, `jsdom`, `multer`, `node-fetch`, `openai`,
  `pdf-lib`, `puppeteer`, `react-force-graph`, `react-query`,
  `react-syntax-highlighter`, `together`, `undici`, `uuid`, `winston`,
  `zod`, `node-cache`, `react-tooltip`, `lucide-react`, `react-markdown`,
  `dotenv`) and unused dev dependencies (`concurrently`, `cross-env`,
  `wait-on`, `style-loader`, `css-loader`, `postcss-loader`, `raw-loader`,
  `typescript`, `@types/*`). `d3-force` is now an explicit dependency.
- `env-config.txt`, `.codex/`, `research-hub-api/`, `.vscode/settings.json`
  and `.DS_Store` files are no longer tracked.

### Changed
- `npm test` runs jest. `npm run smoke:api` checks the live routes only.
- README, USER_FLOW and `.env.local.example` rewritten to describe the code
  that exists; stale design and troubleshooting documents removed.

## [0.6.0] - 2025-03-01

### Changed
- Renamed "Verified Sources" tab to "Network Map"
- Removed search functionality from Network Map tab
- Made "Open Research" the default tab on application load
- Restructured UI layout for improved user experience
- Maintained verified sources search functionality within Open Research tab

### Improved
- Enhanced Network Map visualization
- Streamlined search flow in Open Research tab
- Updated documentation to reflect new UI layout

## [0.5.0] - 2025-02-25

### Fixed
- Fixed critical issue with Verified Sources search not displaying results
- Resolved data format inconsistencies between different search components
- Fixed content rendering issues in search results

### Improved
- Enhanced SearchResultsWrapper with robust format detection and conversion
- Improved LLMResults component with better error handling and content processing
- Added comprehensive debug logging throughout search components
- Implemented smarter content extraction and formatting for different data types

### Technical Changes
- Added format conversion between chat history and search results formats
- Implemented proper synthesizedAnswer format handling for different content types
- Enhanced type checking throughout search components
- Added fallbacks for missing content and improved error handling

## [0.4.0] - 2025-02-25

### Added
- Enhanced markdown styling for LLM responses with special formatting for Key Takeaways and Further Considerations
- Improved table styling for better data presentation
- Custom scrollbar styling for search results

### Changed
- Updated DeepSeek model to use DeepSeek-R1-Distill-Qwen-1.5B for better performance
- Restructured LLM prompt to generate more categorical and direct responses
- Enhanced UI for search results and LLM responses with improved visual hierarchy
- Optimized follow-up question interface with better styling

### Improved
- LLM responses now organized into logical categories with Key Takeaways section
- Better visual separation between different types of content
- More intuitive navigation through search results

## [0.3.0] - 2025-02-25

### Added
- Carta integration as a verified source for equity management information
- Automatic LLM model fallback mechanism for improved reliability
- Enhanced error handling in LLM processing with detailed error logging
- Support for multiple LLM models (Mixtral, Llama-2, Gemma)

### Changed
- Updated API route exports to use ES modules syntax for Next.js compatibility
- Improved error handling in verified sources search
- Enhanced LLM processing to handle empty results gracefully
- Updated environment variable configuration

### Fixed
- 500 Internal Server Error in verified sources search API route
- DeepSeek model integration issues with Together API
- Error handling in LLM processing
- Source handler parameter structure in custom and file handlers

## [0.2.0] - 2025-02-25

### Added
- Financial Modeling Prep (FMP) API integration for real-time market data
- Support for stock symbol extraction and market data retrieval
- Enhanced market data formatting with up/down arrows and color indicators
- Bloomberg, Reuters, and WSJ integration for financial news
- FRED API integration for economic data

### Changed
- Improved error handling in market data API calls
- Enhanced response formatting for market data results
- Updated environment variable handling for API keys
- Optimized web search fallback for market data queries

### Fixed
- Market data API authentication issues
- Symbol extraction for stock queries
- Rate limiting for financial data APIs
- Error handling for invalid API keys

## [0.1.0] - 2025-02-24

### Added
- Initial release with basic search functionality
- LinkedIn, Twitter, and Reddit integrations
- Web search using Serper API
- Support for Substack and Medium content
- File upload and processing capabilities
- Custom URL handling
- Rate limiting and error handling
- Modern UI with Tailwind CSS

### Changed
- Optimized search result processing
- Enhanced error handling and logging
- Improved API response formatting

### Fixed
- Rate limiting issues
- Authentication handling
- Search result aggregation
- File processing errors
