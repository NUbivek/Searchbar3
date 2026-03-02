const axios = require('axios');
const logger = require('./logger');
const { searchCompany, getFilings } = require('./edgarUtils');
const { MARKET_DATA_SOURCES, VC_FIRMS } = require('./dataSources');
const { deepWebSearch, enrichResults } = require('./deepWebSearch');
const { 
  VERIFIED_DATA_SOURCES, 
  getVerifiedSourcesByCategory, 
  getAllVerifiedSources,
  searchVerifiedSources 
} = require('./verifiedDataSources');
const { 
  searchEmployees, 
  getAllSocialHandles 
} = require('./companyEmployeeData');

// API base URL
const getBaseUrl = () => {
  if (typeof window !== 'undefined') {
    // Client-side
    return window.location.origin;
  } else {
    // Server-side
    return process.env.NODE_ENV === 'development' 
      ? 'http://localhost:3010' 
      : process.env.NEXT_PUBLIC_BASE_URL || '';
  }
};

// Handler for verified data sources
const handleVerifiedDataSources = async (query, verifiedDataSources) => {
  try {
    // Filter the verified data sources based on the query
    const filteredSources = verifiedDataSources.filter(source => {
      const searchString = JSON.stringify(source).toLowerCase();
      return query.toLowerCase().split(' ').every(term => searchString.includes(term));
    });

    // Transform the filtered sources into search results
    return filteredSources.map(source => ({
      title: source.name,
      content: `${source.name} - ${source.specialty?.join(', ')}`,
      source: source.name,
      url: source.research_portals?.public || source.research_portals?.startup || '',
      type: 'verified_data',
      relevance: 0.9,
      metadata: {
        specialty: source.specialty,
        focus: source.focus,
        handles: source.handles,
        verified: source.verified
      }
    }));
  } catch (error) {
    console.error('Error handling verified data sources:', error);
    return [];
  }
};

// Helper function to handle verified data sources by category
const handleVerifiedCategory = async (query, category) => {
  try {
    const sources = getVerifiedSourcesByCategory(category);
    
    return handleVerifiedDataSources(query, sources);
  } catch (error) {
    console.error(`Error handling ${category} sources:`, error);
    return [];
  }
};

// Handler for market data sources
const handleMarketDataSources = async (query, type = 'financial') => {
  try {
    const sources = MARKET_DATA_SOURCES[type] || [];
    const filteredSources = sources.filter(source => {
      const searchString = JSON.stringify(source).toLowerCase();
      return query.toLowerCase().split(' ').every(term => searchString.includes(term));
    });

    return filteredSources.map(source => ({
      title: source.name,
      content: `${source.name} - ${source.specialty?.join(', ')}`,
      source: source.name,
      url: source.research_portals?.public || '',
      type: 'market_data',
      relevance: 0.9,
      metadata: {
        specialty: source.specialty,
        dataTypes: source.data_types,
        handles: source.handles,
        verified: source.verified
      }
    }));
  } catch (error) {
    console.error(`Error handling market data sources (${type}):`, error);
    return [];
  }
};

// Handler for VC firms data
const handleVCFirmsData = async (query) => {
  try {
    const firms = Object.values(VC_FIRMS);
    const filteredFirms = firms.filter(firm => {
      const searchString = JSON.stringify(firm).toLowerCase();
      return query.toLowerCase().split(' ').every(term => searchString.includes(term));
    });

    return filteredFirms.map(firm => ({
      title: firm.name,
      content: `${firm.name} - ${firm.focus?.join(', ')}`,
      source: firm.name,
      url: '',
      type: 'vc_firm',
      relevance: 0.9,
      metadata: {
        focus: firm.focus,
        handles: firm.handles,
        aum: firm.aum,
        tier: firm.tier,
        verified: firm.verified
      }
    }));
  } catch (error) {
    console.error('Error handling VC firms data:', error);
    return [];
  }
};

// Enhanced handler for social media sources
const handleSocialMediaSearch = async (query, platform, handle = null) => {
  try {
    const SERPER_API_KEY = process.env.SERPER_API_KEY;
    
    if (!SERPER_API_KEY) {
      logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
      return [];
    }

    // If a specific handle is provided, target that handle
    const searchQuery = handle 
      ? `site:${platform}.com ${handle} ${query}`
      : `site:${platform}.com ${query}`;

    const response = await axios.post(
      'https://google.serper.dev/search',
      {
        q: searchQuery,
        gl: 'us',
        hl: 'en',
        num: 10,
      },
      {
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    const organicResults = response.data.organic || [];
    
    return organicResults.map(result => ({
      title: result.title,
      content: result.snippet,
      url: result.link,
      source: platform,
      type: 'social_media',
      relevance: 0.85,
      metadata: {
        platform: platform,
        handle: handle
      }
    }));
  } catch (error) {
    logger.error(`Error in ${platform} search:`, error);
    return [];
  }
};

// Enhanced handler for website scraping
const handleWebsiteScrape = async (query, domain) => {
  try {
    const SERPER_API_KEY = process.env.SERPER_API_KEY;
    
    if (!SERPER_API_KEY) {
      logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
      return [];
    }

    const response = await axios.post(
      'https://google.serper.dev/search',
      {
        q: `site:${domain} ${query}`,
        gl: 'us',
        hl: 'en',
        num: 10,
      },
      {
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    const organicResults = response.data.organic || [];
    
    // Enrich results with additional metadata
    return organicResults.map(result => ({
      title: result.title,
      content: result.snippet,
      url: result.link,
      source: domain,
      type: 'website_scrape',
      relevance: 0.9,
      metadata: {
        domain: domain
      }
    }));
  } catch (error) {
    logger.error(`Error scraping ${domain}:`, error);
    return [];
  }
};

// Handler for verified data sources with social media integration
const handleVerifiedDataSourcesWithSocial = async (query, verifiedDataSources) => {
  try {
    // Filter the verified data sources based on the query
    const filteredSources = verifiedDataSources.filter(source => {
      const searchString = JSON.stringify(source).toLowerCase();
      return query.toLowerCase().split(' ').every(term => searchString.includes(term));
    });

    // Create base results from the sources
    const baseResults = filteredSources.map(source => ({
      title: source.name,
      content: `${source.name} - ${source.specialty?.join(', ')}`,
      source: source.name,
      url: source.research_portals?.public || source.research_portals?.startup || '',
      type: 'verified_data',
      relevance: 0.9,
      metadata: {
        specialty: source.specialty,
        focus: source.focus,
        handles: source.handles,
        verified: source.verified
      }
    }));

    // For each source with social media handles, also search those platforms
    const socialPromises = [];
    for (const source of filteredSources) {
      if (source.handles) {
        for (const [platform, handle] of Object.entries(source.handles)) {
          if (platform && handle && ['x', 'twitter', 'linkedin', 'substack', 'reddit'].includes(platform)) {
            socialPromises.push(handleSocialMediaSearch(query, platform, handle));
          }
        }
      }
    }

    // Wait for all social media searches to complete (fail-soft)
    const socialSettled = await Promise.allSettled(socialPromises);
    const socialResults = socialSettled
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value || []);

    // Combine and return all results
    return [...baseResults, ...socialResults];
  } catch (error) {
    console.error('Error handling verified data sources with social:', error);
    return [];
  }
};

// Source handlers
const sourceHandlers = {
  // Web search using Serper API
  web: async (query) => {
    try {
      const SERPER_API_KEY = process.env.SERPER_API_KEY;
      
      if (!SERPER_API_KEY) {
        logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
        return [];
      }

      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: query,
          gl: 'us',
          hl: 'en',
          num: 10,
        },
        {
          headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const organicResults = response.data.organic || [];
      
      return organicResults.map(result => ({
        title: result.title,
        content: result.snippet,
        url: result.link,
        source: 'web'
      }));
    } catch (error) {
      logger.error('Error in web search:', error);
      return [];
    }
  },

  // LinkedIn search using web search API with site:linkedin.com
  linkedin: async (query) => {
    try {
      const SERPER_API_KEY = process.env.SERPER_API_KEY;
      
      if (!SERPER_API_KEY) {
        logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
        return [];
      }

      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: `site:linkedin.com ${query}`,
          gl: 'us',
          hl: 'en',
          num: 5,
        },
        {
          headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const organicResults = response.data.organic || [];
      
      return organicResults.map(result => ({
        title: result.title,
        content: result.snippet,
        url: result.link,
        source: 'linkedin'
      }));
    } catch (error) {
      logger.error('Error in LinkedIn search:', error);
      return [];
    }
  },

  // Twitter/X search using web search API with site:twitter.com
  x: async (query) => {
    try {
      const SERPER_API_KEY = process.env.SERPER_API_KEY;
      
      if (!SERPER_API_KEY) {
        logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
        return [];
      }

      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: `site:twitter.com ${query}`,
          gl: 'us',
          hl: 'en',
          num: 5,
        },
        {
          headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const organicResults = response.data.organic || [];
      
      return organicResults.map(result => ({
        title: result.title,
        content: result.snippet,
        url: result.link,
        source: 'twitter'
      }));
    } catch (error) {
      logger.error('Error in Twitter search:', error);
      return [];
    }
  },

  // Twitter/X search (alias)
  twitter: async (query) => {
    return sourceHandlers.x(query);
  },

  // Reddit search using web search API with site:reddit.com
  reddit: async (query) => {
    try {
      const SERPER_API_KEY = process.env.SERPER_API_KEY;
      
      if (!SERPER_API_KEY) {
        logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
        return [];
      }

      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: `site:reddit.com ${query}`,
          gl: 'us',
          hl: 'en',
          num: 5,
        },
        {
          headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const organicResults = response.data.organic || [];
      
      return organicResults.map(result => ({
        title: result.title,
        content: result.snippet,
        url: result.link,
        source: 'reddit'
      }));
    } catch (error) {
      logger.error('Error in Reddit search:', error);
      return [];
    }
  },

  // Substack search using web search API with site:substack.com
  substack: async (query) => {
    try {
      const SERPER_API_KEY = process.env.SERPER_API_KEY;
      
      if (!SERPER_API_KEY) {
        logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
        return [];
      }

      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: `site:substack.com ${query}`,
          gl: 'us',
          hl: 'en',
          num: 5,
        },
        {
          headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const organicResults = response.data.organic || [];
      
      return organicResults.map(result => ({
        title: result.title,
        content: result.snippet,
        url: result.link,
        source: 'substack'
      }));
    } catch (error) {
      logger.error('Error in Substack search:', error);
      return [];
    }
  },

  // Medium search using web search API with site:medium.com
  medium: async (query) => {
    try {
      const SERPER_API_KEY = process.env.SERPER_API_KEY;
      
      if (!SERPER_API_KEY) {
        logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
        return [];
      }

      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: `site:medium.com ${query}`,
          gl: 'us',
          hl: 'en',
          num: 5,
        },
        {
          headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const organicResults = response.data.organic || [];
      
      return organicResults.map(result => ({
        title: result.title,
        content: result.snippet,
        url: result.link,
        source: 'medium'
      }));
    } catch (error) {
      logger.error('Error in Medium search:', error);
      return [];
    }
  },

  // Crunchbase search using web search API with site:crunchbase.com
  crunchbase: async (query) => {
    try {
      const SERPER_API_KEY = process.env.SERPER_API_KEY;
      
      if (!SERPER_API_KEY) {
        logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
        return [];
      }

      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: `site:crunchbase.com ${query}`,
          gl: 'us',
          hl: 'en',
          num: 5,
        },
        {
          headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const organicResults = response.data.organic || [];
      
      return organicResults.map(result => ({
        title: result.title,
        content: result.snippet,
        url: result.link,
        source: 'crunchbase'
      }));
    } catch (error) {
      logger.error('Error in Crunchbase search:', error);
      return [];
    }
  },

  // Pitchbook search using web search API with site:pitchbook.com
  pitchbook: async (query) => {
    try {
      const SERPER_API_KEY = process.env.SERPER_API_KEY;
      
      if (!SERPER_API_KEY) {
        logger.warn('SERPER_API_KEY is not defined; returning fail-soft []');
        return [];
      }

      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: `site:pitchbook.com ${query}`,
          gl: 'us',
          hl: 'en',
          num: 5,
        },
        {
          headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const organicResults = response.data.organic || [];
      
      return organicResults.map(result => ({
        title: result.title,
        content: result.snippet,
        url: result.link,
        source: 'pitchbook'
      }));
    } catch (error) {
      logger.error('Error in Pitchbook search:', error);
      return [];
    }
  },

  // FMP search
  fmp: async (query) => {
    try {
      const FMP_API_KEY = process.env.FMP_API_KEY;
      
      if (!FMP_API_KEY) {
        logger.warn('FMP_API_KEY is not defined; returning fail-soft []');
        return [];
      }

      // Search for companies
      const response = await axios.get(
        `https://financialmodelingprep.com/api/v3/search?query=${encodeURIComponent(query)}&limit=10&apikey=${FMP_API_KEY}`
      );

      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      // Get company profiles for the first 3 results
      const topResults = response.data.slice(0, 3);
      const profilePromises = topResults.map(company => 
        axios.get(`https://financialmodelingprep.com/api/v3/profile/${company.symbol}?apikey=${FMP_API_KEY}`)
      );
      
      const profilesSettled = await Promise.allSettled(profilePromises);
      const profiles = profilesSettled.filter(p => p.status === 'fulfilled').map(p => p.value);
      
      return profiles
        .filter(profile => profile.data && Array.isArray(profile.data) && profile.data.length > 0)
        .map(profile => {
          const company = profile.data[0];
          return {
            title: `${company.companyName} (${company.symbol})`,
            content: `${company.description || 'No description available'} | Price: $${company.price} | Industry: ${company.industry || 'N/A'} | Sector: ${company.sector || 'N/A'}`,
            url: company.website || `https://financialmodelingprep.com/financial-summary/${company.symbol}`,
            source: 'fmp'
          };
        });
    } catch (error) {
      logger.error('Error in FMP search:', error);
      return [];
    }
  },

  // SEC search using EDGAR API
  sec: async (query) => {
    try {
      // Use the searchCompany function from edgarUtils.js
      const companies = await searchCompany(query);
      
      if (!companies || !Array.isArray(companies) || companies.length === 0) {
        return [];
      }
      
      // Get filings for the top 3 companies
      const topCompanies = companies.slice(0, 3);
      const filingsPromises = topCompanies.map(company => 
        getFilings(company.cik)
      );
      
      const filingSettled = await Promise.allSettled(filingsPromises);
      const filingResults = filingSettled
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value || []);
      
      // Flatten and format results
      return filingResults
        .flat()
        .map(filing => ({
          title: `${filing.companyName} - ${filing.formType}`,
          content: `Filing Date: ${filing.filingDate} | Description: ${filing.description || 'No description available'}`,
          url: filing.url || `https://www.sec.gov/edgar/browse/?CIK=${filing.cik}`,
          source: 'sec'
        }));
    } catch (error) {
      logger.error('Error in SEC search:', error);
      return [];
    }
  },

  // EDGAR search (alias to SEC)
  edgar: async (query) => {
    return sourceHandlers.sec(query);
  },

  // Custom URL source handler
  custom: async (query, customUrls) => {
    try {
      if (!customUrls || customUrls.length === 0) {
        return [];
      }

      logger.info(`Processing ${customUrls.length} custom URLs with query: ${query}`);
      
      // Process each URL and return results
      const results = customUrls.map(url => ({
        title: `Custom Source: ${url}`,
        content: `This is a custom source from URL: ${url}. Query: ${query}`,
        url: url,
        source: 'custom',
        type: 'custom_url',
        relevance: 0.8
      }));
      
      return results;
    } catch (error) {
      logger.error(`Error processing custom URLs:`, error);
      return [];
    }
  },

  // File source handler
  file: async (query, files) => {
    try {
      if (!files || files.length === 0) {
        return [];
      }

      logger.info(`Processing ${files.length} files for query: ${query}`);
      
      // Process each file and return results
      const results = files.map(file => ({
        title: `File Source: ${file.name}`,
        content: `This is a file source from: ${file.name}. Size: ${file.size} bytes. Query: ${query}`,
        url: '#',
        source: 'file',
        type: 'uploaded_file',
        relevance: 0.8
      }));
      
      return results;
    } catch (error) {
      logger.error(`Error processing files:`, error);
      return [];
    }
  },

  // Handler for verified data sources
  verifiedData: handleVerifiedDataSourcesWithSocial,

  // Handler for verified sources (used by performVerifiedSearch)
  verified: async (query, options = {}) => {
    try {
      // Use the verifiedData handler with the query
      return await handleVerifiedDataSourcesWithSocial(query, options.verifiedDataSources || []);
    } catch (error) {
      logger.error('Error in verified source handler:', error);
      return [];
    }
  },

  // Add handlers for additional verified source categories
  strategy_consulting: (query) => handleVerifiedCategory(query, 'Strategy Consulting'),
  investment_banks: (query) => handleVerifiedCategory(query, 'Investment Banks'),
  market_data: (query) => handleVerifiedCategory(query, 'Market Research & Data'),
  vc_firms: (query) => handleVerifiedCategory(query, 'Startup Research'),
  professional_services: (query) => handleVerifiedCategory(query, 'Professional Services'),
  research_firms: (query) => handleVerifiedCategory(query, 'Tech Research'),
  
  // Add handlers for additional data sources from dataSources.js
  financial_market_data: (query) => handleMarketDataSources(query, 'financial'),
  industry_market_data: (query) => handleMarketDataSources(query, 'industry'),
  vc_firms_data: handleVCFirmsData,
  
  // Social media platform handlers
  x: (query) => handleSocialMediaSearch(query, 'twitter'),
  twitter: (query) => handleSocialMediaSearch(query, 'twitter'),
  linkedin: (query) => handleSocialMediaSearch(query, 'linkedin'),
  reddit: (query) => handleSocialMediaSearch(query, 'reddit'),
  substack: (query) => handleSocialMediaSearch(query, 'substack'),
  
  // Website scraping handlers for specific domains
  carta: async (query) => {
    try {
      const results = await handleWebsiteScrape(query, 'carta.com');
      
      // Add additional context about Carta
      return results.map(result => ({
        ...result,
        content: `${result.content}\n\nCarta is a technology company that specializes in capitalization table management and valuation software. They provide equity management solutions for companies, investors, and employees.`,
        metadata: {
          ...result.metadata,
          companyInfo: {
            name: 'Carta',
            founded: 2012,
            founders: 'Henry Ward and Manu Kumar',
            headquarters: 'San Francisco, California',
            description: 'Carta provides equity management solutions, cap table management, 409A valuations, and portfolio insights for companies, investors, and employees.',
            services: ['Cap Table Management', 'Equity Management', '409A Valuations', 'Portfolio Management', 'Investor Services']
          }
        }
      }));
    } catch (error) {
      logger.error(`Error processing Carta search:`, error);
      return [];
    }
  },
  crunchbase: (query) => handleWebsiteScrape(query, 'crunchbase.com'),
  pitchbook: (query) => handleWebsiteScrape(query, 'pitchbook.com'),
  cbinsights: (query) => handleWebsiteScrape(query, 'cbinsights.com'),
  
  // Handler for employee social media handles
  employee_handles: async (query) => {
    try {
      // Search for employees matching the query
      const matchingEmployees = searchEmployees(query);
      
      if (matchingEmployees.length === 0) {
        return [];
      }
      
      // Format results for display
      return matchingEmployees.map(employee => ({
        title: `${employee.name} - ${employee.title} at ${employee.company}`,
        snippet: `Social handles: ${Object.entries(employee.handles || {})
          .map(([platform, handle]) => `${platform}: ${handle}`)
          .join(', ')}`,
        link: employee.handles?.linkedin ? `https://linkedin.com${employee.handles.linkedin}` : 
              employee.handles?.x ? `https://x.com${employee.handles.x.replace('@', '')}` : '',
        source: 'Company Employee Data',
        date: new Date().toISOString(),
        verified: true
      }));
    } catch (error) {
      console.error('Error searching employee handles:', error);
      return [];
    }
  },
};

/**
 * Perform search across multiple sources
 * @param {string} query - The search query
 * @param {Array<string>} sources - Array of source names to search
 * @returns {Promise<Array>} - Array of search results
 */
const withTimeout = (promise, ms = 8000, label = 'source') => {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        logger.warn(`Timeout in ${label} after ${ms}ms; returning fail-soft []`);
        resolve([]);
      }, ms);
    })
  ]).finally(() => clearTimeout(timer));
};

const performSearch = async (query, sources = ['web']) => {
  try {
    if (!query) {
      logger.warn('performSearch called without query; returning fail-soft []');
      return [];
    }

    // Validate sources
    const validSources = sources.filter(source => 
      typeof sourceHandlers[source] === 'function'
    );

    if (validSources.length === 0) {
      logger.warn(`No valid sources provided, defaulting to web search`);
      validSources.push('web');
    }

    // Execute searches in parallel (fail-soft per source)
    const searchPromises = validSources.map(source =>
      withTimeout(
        sourceHandlers[source](query)
          .catch(error => {
            logger.error(`Error in ${source} search:`, error);
            return []; // Return empty array on error
          }),
        8000,
        `${source} search`
      )
    );

    const settled = await Promise.allSettled(searchPromises);
    const results = settled
      .filter(item => item.status === 'fulfilled')
      .map(item => item.value);

    // Flatten results
    return results.flat();
  } catch (error) {
    logger.error('Error in performSearch:', error);
    return [];
  }
};

module.exports = { sourceHandlers, performSearch };
