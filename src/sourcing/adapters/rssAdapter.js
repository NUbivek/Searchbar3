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
    const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

    return itemBlocks.slice(0, 20).map((block) => ({
      title: extractTag(block, 'title'),
      url: extractTag(block, 'link'),
      content: extractTag(block, 'description'),
      publishedAt: extractTag(block, 'pubDate') || new Date().toISOString(),
      confidence: 0.7,
      signal_type: 'mention',
    }));
  }
}

module.exports = {
  RssAdapter,
};
