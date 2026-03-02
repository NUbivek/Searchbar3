const cheerio = require('cheerio');
const { BaseAdapter } = require('./baseAdapter');

class HtmlListAdapter extends BaseAdapter {
  async run({ query }) {
    const url = this.resolveUrl(query);
    const html = await this.fetchText(url);
    const $ = cheerio.load(html);
    const extractConfig = this.source.method?.extract || {};
    const itemSelector = extractConfig.itemSelector || 'a[href]';
    const linkSelector = extractConfig.linkSelector || null;
    const titleSelector = extractConfig.titleSelector || null;
    const contentSelector = extractConfig.contentSelector || null;
    const urlAttribute = extractConfig.urlAttribute || 'href';
    const limit = Number.isInteger(extractConfig.limit) ? extractConfig.limit : 20;
    const excludePatterns = Array.isArray(extractConfig.excludePatterns)
      ? extractConfig.excludePatterns.map((pattern) => new RegExp(pattern, 'i'))
      : [];
    const seenUrls = new Set();
    const results = [];

    $(itemSelector).each((_, element) => {
      if (results.length >= limit) {
        return false;
      }

      const node = $(element);
      const linkNode = linkSelector ? node.find(linkSelector).first() : node;
      const titleNode = titleSelector ? node.find(titleSelector).first() : linkNode;
      const contentNode = contentSelector ? node.find(contentSelector).first() : null;
      const href = linkNode.attr(urlAttribute);
      const title = titleNode.text().replace(/\s+/g, ' ').trim();
      const content = contentNode
        ? contentNode.text().replace(/\s+/g, ' ').trim()
        : title;

      if (!href || !title || title.length < 2) {
        return;
      }

      const absoluteUrl = new URL(href, this.source.method.url).toString();

      if (excludePatterns.some((pattern) => pattern.test(absoluteUrl) || pattern.test(title))) {
        return;
      }

      if (seenUrls.has(absoluteUrl)) {
        return;
      }

      seenUrls.add(absoluteUrl);
      results.push({
        title,
        url: absoluteUrl,
        content,
        publishedAt: new Date().toISOString(),
        confidence: 0.55,
        signal_type: 'directory_listing',
      });
    });

    return results;
  }
}

module.exports = {
  HtmlListAdapter,
};
