class BaseAdapter {
  constructor(source, options = {}) {
    this.source = source;
    this.timeoutMs = options.timeoutMs || 10000;
  }

  resolveUrl(query) {
    const template = this.source.method?.url || '';
    return template.replace('{{query}}', encodeURIComponent(query || ''));
  }

  async fetchText(url) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'User-Agent': 'Searchbar3-Sourcing/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
  }

  async fetchJson(url) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'User-Agent': 'Searchbar3-Sourcing/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  async run() {
    throw new Error('Adapter must implement run()');
  }
}

module.exports = {
  BaseAdapter,
};
