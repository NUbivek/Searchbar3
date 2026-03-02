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

class ApiSearchAdapter extends BaseAdapter {
  async run({ query }) {
    const url = this.resolveUrl(query);
    const payload = await this.fetchJson(url);
    const itemPath = this.source.method?.item_path || 'items';
    const items = pickItems(payload, itemPath);

    return (Array.isArray(items) ? items : []).slice(0, 20).map((item) => ({
      title: item.title || item.name || '',
      url: item.url || item.link || '',
      content: item.description || item.summary || item.snippet || '',
      publishedAt: item.publishedAt || item.created_at || item.pubDate || new Date().toISOString(),
      confidence: 0.65,
      signal_type: 'api_match',
      company_name: item.company_name || item.name || item.title || '',
      company_website: item.company_website || item.website || item.domain || '',
    }));
  }
}

module.exports = {
  ApiSearchAdapter,
};
