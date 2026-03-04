import axios from 'axios';
import cheerio from 'cheerio';
import { logger } from '../../utils/logger';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { query, url, sources = [] } = req.body || {};
    // Handle both single URL and multiple sources
    if (url) {
      // Single URL case
      const content = await scrapeUrl(url);
      
      return res.status(200).json({
        title: url.split('/').pop() || 'Web Content',
        content,
        type: 'Web Content'
      });
    } else if (sources && sources.length > 0) {
      // Multiple sources case
      const settled = await Promise.allSettled(
        sources.map(source => scrapeSource(source, query))
      );

      const degradedSources = settled
        .map((result, index) => (result.status === 'rejected' ? sources[index] : null))
        .filter(Boolean);

      const results = settled
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);

      return res.status(200).json({
        status: results.flat().length > 0 ? (degradedSources.length > 0 ? 'degraded' : 'ok') : 'fail-soft',
        summary: `Found results across ${sources.length} sources`,
        degradedSources,
        results: results.flat()
      });
    } else {
      return res.status(400).json({ error: 'Either url or sources must be provided' });
    }
  } catch (error) {
    logger.error('Web scraping error:', error);
    return res.status(200).json({
      status: 'fail-soft',
      summary: 'Web scraping encountered an unexpected error',
      degradedSources: ['webScrape'],
      results: [],
      error: 'Scraping failed'
    });
  }
}

async function scrapeUrl(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    // Remove script and style elements
    $('script, style').remove();
    
    // Get the text content
    const title = $('title').text().trim();
    const metaDescription = $('meta[name="description"]').attr('content') || '';
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    
    // Limit content length
    const maxLength = 5000;
    const content = bodyText.length > maxLength 
      ? bodyText.substring(0, maxLength) + '...' 
      : bodyText;
    
    return `${title}\n\n${metaDescription}\n\n${content}`;
  } catch (error) {
    logger.error(`Error scraping URL ${url}:`, error);
    return `Failed to scrape content from ${url}`;
  }
}

async function scrapeSource(source, query) {
  const sourceConfigs = {
    'LinkedIn': {
      url: `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}`,
      selector: '.search-results__list .search-result',
      transform: ($el) => ({
        title: $el.find('.search-result__title').text().trim(),
        content: $el.find('.search-result__snippet').text().trim(),
        url: $el.find('.search-result__title a').attr('href'),
        author: $el.find('.search-result__author-name').text().trim()
      })
    },
    'Twitter': {
      url: `https://twitter.com/search?q=${encodeURIComponent(query)}&f=live`,
      selector: '[data-testid="tweet"]',
      transform: ($el) => ({
        title: $el.find('[data-testid="tweetText"]').first().text().trim(),
        content: $el.find('[data-testid="tweetText"]').text().trim(),
        url: $el.find('a[href*="/status/"]').attr('href'),
        author: $el.find('[data-testid="User-Name"]').text().trim()
      })
    },
    'Reddit': {
      url: `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&sort=relevance`,
      selector: '.Post',
      transform: ($el) => ({
        title: $el.find('[data-testid="post-title"]').text().trim(),
        content: $el.find('[data-testid="post-content"]').text().trim(),
        url: $el.find('[data-testid="post-title"]').parent('a').attr('href'),
        subreddit: $el.find('[data-testid="subreddit-name"]').text().trim()
      })
    },
    'Substack': {
      url: `https://substack.com/search?q=${encodeURIComponent(query)}`,
      selector: '.post-preview',
      transform: ($el) => ({
        title: $el.find('.post-preview-title').text().trim(),
        content: $el.find('.post-preview-description').text().trim(),
        url: $el.find('.post-preview-title a').attr('href'),
        author: $el.find('.post-preview-byline').text().trim()
      })
    },
    'Medium': {
      url: `https://medium.com/search?q=${encodeURIComponent(query)}`,
      selector: 'article',
      transform: ($el) => ({
        title: $el.find('h2').text().trim(),
        content: $el.find('section').text().trim(),
        url: $el.find('a').first().attr('href'),
        author: $el.find('a[data-testid="preview-author"]').text().trim()
      })
    },
    'Crunchbase': {
      url: `https://www.crunchbase.com/discover/organization/search/organizations/field/organizations/location_identifiers/${encodeURIComponent(query)}`,
      selector: '.mat-row',
      transform: ($el) => ({
        title: $el.find('.organization-name').text().trim(),
        content: $el.find('.description').text().trim(),
        url: 'https://www.crunchbase.com' + $el.find('.organization-name a').attr('href'),
        industry: $el.find('.industry').text().trim()
      })
    },
    'Pitchbook': {
      url: `https://pitchbook.com/profiles/search?q=${encodeURIComponent(query)}`,
      selector: '.search-result',
      transform: ($el) => ({
        title: $el.find('.company-name').text().trim(),
        content: $el.find('.company-description').text().trim(),
        url: 'https://pitchbook.com' + $el.find('.company-name a').attr('href'),
        industry: $el.find('.industry-tag').text().trim()
      })
    }
  };

  const config = sourceConfigs[source];
  if (!config) {
    logger.warn(`No scraping config found for source: ${source}`);
    return [];
  }

  try {
    const response = await axios.get(config.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://www.google.com/'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const results = [];

    $(config.selector).each((_, el) => {
      try {
        const $el = $(el);
        const result = config.transform($el);
        
        if (result.title && result.content) {
          results.push({
            ...result,
            source,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        logger.error(`Error transforming ${source} result:`, error);
      }
    });

    return results;
  } catch (error) {
    logger.error(`Error scraping ${source}:`, error);
    return [];
  }
}
