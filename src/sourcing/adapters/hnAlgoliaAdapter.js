const { BaseAdapter } = require('./baseAdapter');

class HNAlgoliaAdapter extends BaseAdapter {
  async run({ query }) {
    const url = this.resolveUrl(query);
    const payload = await this.fetchJson(url);
    const hits = Array.isArray(payload?.hits) ? payload.hits : [];

    return hits.slice(0, 20).map((hit) => ({
      title: hit.title || hit.story_title || '',
      url: hit.url || hit.story_url || '',
      content: hit.story_text || hit.comment_text || hit._highlightResult?.title?.value || '',
      publishedAt: hit.created_at || new Date().toISOString(),
      confidence: 0.8,
      signal_type: 'mention',
    }));
  }
}

module.exports = {
  HNAlgoliaAdapter,
};
