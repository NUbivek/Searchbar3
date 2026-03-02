const { BaseAdapter } = require('./baseAdapter');

function pickItems(payload, itemPath) {
  if (!itemPath) {
    return Array.isArray(payload) ? payload : [];
  }

  return itemPath.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') {
      return [];
    }

    return current[key];
  }, payload) || [];
}

function pickValue(item, path, fallback = '') {
  if (!path) {
    return fallback;
  }

  const result = path.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    return current[key];
  }, item);

  return result == null ? fallback : result;
}

class ApiSearchAdapter extends BaseAdapter {
  async run({ query }) {
    const url = this.resolveUrl(query);
    const payload = await this.fetchJson(url);
    const itemPath = this.source.method?.item_path || 'items';
    const extractConfig = this.source.method?.extract || {};
    const limit = Number.isInteger(extractConfig.limit) ? extractConfig.limit : 20;
    const fieldPaths = {
      title: extractConfig.titlePath || 'title',
      url: extractConfig.urlPath || 'url',
      content: extractConfig.contentPath || 'description',
      publishedAt: extractConfig.publishedAtPath || 'publishedAt',
      companyName: extractConfig.companyNamePath || 'company_name',
      companyWebsite: extractConfig.companyWebsitePath || 'company_website',
    };
    const items = pickItems(payload, itemPath);

    return (Array.isArray(items) ? items : []).slice(0, limit).map((item) => ({
      title: pickValue(item, fieldPaths.title, item.title || item.name || ''),
      url: pickValue(item, fieldPaths.url, item.url || item.link || ''),
      content: pickValue(item, fieldPaths.content, item.description || item.summary || item.snippet || ''),
      publishedAt: pickValue(item, fieldPaths.publishedAt, item.publishedAt || item.created_at || item.pubDate || new Date().toISOString()),
      confidence: 0.65,
      signal_type: 'api_match',
      company_name: pickValue(item, fieldPaths.companyName, item.company_name || item.name || item.title || ''),
      company_website: pickValue(item, fieldPaths.companyWebsite, item.company_website || item.website || item.domain || ''),
    }));
  }
}

module.exports = {
  ApiSearchAdapter,
};
