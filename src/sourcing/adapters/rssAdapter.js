const { BaseAdapter } = require('./baseAdapter');

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function extractTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

class RssAdapter extends BaseAdapter {
  async run() {
    const xml = await this.fetchText(this.source.method.url);
    const extractConfig = this.source.method?.extract || {};
    const containerTag = extractConfig.containerTag || 'item';
    const fields = {
      title: extractConfig.titleTag || 'title',
      url: extractConfig.urlTag || 'link',
      content: extractConfig.contentTag || 'description',
      publishedAt: extractConfig.publishedAtTag || 'pubDate',
    };
    const limit = Number.isInteger(extractConfig.limit) ? extractConfig.limit : 20;
    const itemBlocks = xml.match(new RegExp(`<${containerTag}\\b[\\s\\S]*?<\\/${containerTag}>`, 'gi')) || [];

    return itemBlocks.slice(0, limit).map((block) => ({
      title: extractTag(block, fields.title),
      url: extractTag(block, fields.url),
      content: extractTag(block, fields.content),
      publishedAt: extractTag(block, fields.publishedAt) || new Date().toISOString(),
      confidence: 0.7,
      signal_type: 'mention',
    }));
  }
}

module.exports = {
  RssAdapter,
};
