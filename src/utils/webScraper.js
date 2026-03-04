import axios from 'axios';
import cheerio from 'cheerio';

const SCRAPING_CONFIGS = {
  'Crunchbase': {
    baseUrl: 'https://www.crunchbase.com/search/companies',
    selectors: {
      items: '.company-result',
      title: '.company-title',
      description: '.company-description',
      link: 'a.company-link'
    }
  },
  'Medium': {
    baseUrl: 'https://medium.com/search',
    selectors: {
      items: 'article',
      title: 'h2',
      description: 'p.preview-content',
      link: 'a.post-preview'
    }
  },
  'Substack': {
    baseUrl: 'https://substack.com/search',
    selectors: {
      items: '.post-preview',
      title: '.post-title',
      description: '.post-excerpt',
      link: 'a.post-link'
    }
  },
  'Pitchbook': {
    baseUrl: 'https://pitchbook.com/profiles',
    selectors: {
      items: '.profile-card',
      title: '.profile-name',
      description: '.profile-description',
      link: 'a.profile-link'
    }
  }
};

export async function scrapeSource(source, query) {
  const config = SCRAPING_CONFIGS[source];
  if (!config) {
    console.warn(`No scraping configuration for source: ${source}`);
    return [];
  }

  try {
    const response = await axios.get(config.baseUrl, {
      params: { q: query },
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ResearchBot/1.0;)'
      }
    });

    const $ = cheerio.load(response.data);
    const results = [];

    $(config.selectors.items).each((_, element) => {
      const $el = $(element);
      results.push({
        title: $el.find(config.selectors.title).text().trim(),
        content: $el.find(config.selectors.description).text().trim(),
        url: $el.find(config.selectors.link).attr('href'),
        type: source.toLowerCase(),
        timestamp: new Date().toISOString()
      });
    });

    return results;
  } catch (error) {
    console.error(`Error scraping ${source}:`, error);
    return [];
  }
} 
