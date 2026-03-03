const cheerio = require('cheerio');
const { BaseAdapter } = require('./baseAdapter');

function toSelectorList(value, fallback) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  if (typeof value === 'string' && value.trim()) {
    return [value];
  }

  return fallback ? [fallback] : [];
}

function firstMatchingNode($, rootNode, selectors, fallbackNode) {
  for (const selector of selectors) {
    const match = rootNode.find(selector).first();

    if (match.length > 0) {
      return match;
    }
  }

  return fallbackNode || null;
}

function readNodeValue(node, attributeName) {
  if (!node || node.length === 0) {
    return '';
  }

  if (attributeName) {
    return (node.attr(attributeName) || '').replace(/\s+/g, ' ').trim();
  }

  return node.text().replace(/\s+/g, ' ').trim();
}

class HtmlListAdapter extends BaseAdapter {
  async run({ query }) {
    const url = this.resolveUrl(query);
    const html = await this.fetchText(url);
    const $ = cheerio.load(html);
    const extractConfig = this.source.method?.extract || {};
    const itemSelectors = toSelectorList(extractConfig.itemSelector, 'a[href]');
    const linkSelectors = toSelectorList(extractConfig.linkSelector, null);
    const titleSelectors = toSelectorList(extractConfig.titleSelector, null);
    const contentSelectors = toSelectorList(extractConfig.contentSelector, null);
    const excludeSelectors = toSelectorList(extractConfig.excludeSelectors, null);
    const urlAttribute = extractConfig.urlAttribute || 'href';
    const itemUrlAttribute = extractConfig.itemUrlAttribute || null;
    const titleAttribute = extractConfig.titleAttribute || null;
    const contentAttribute = extractConfig.contentAttribute || null;
    const limit = Number.isInteger(extractConfig.limit) ? extractConfig.limit : 20;
    const excludePatterns = Array.isArray(extractConfig.excludePatterns)
      ? extractConfig.excludePatterns.map((pattern) => new RegExp(pattern, 'i'))
      : [];
    const includePatterns = Array.isArray(extractConfig.includePatterns)
      ? extractConfig.includePatterns.map((pattern) => new RegExp(pattern, 'i'))
      : [];
    const seenUrls = new Set();
    const results = [];

    for (const itemSelector of itemSelectors) {
      $(itemSelector).each((_, element) => {
        if (results.length >= limit) {
          return false;
        }

        const node = $(element);

        if (
          excludeSelectors.some((selector) => node.is(selector) || node.find(selector).length > 0)
        ) {
          return;
        }

        const linkNode = firstMatchingNode($, node, linkSelectors, node);
        const titleNode = firstMatchingNode($, node, titleSelectors, linkNode || node);
        const contentNode = firstMatchingNode($, node, contentSelectors, null);
        const href =
          (linkNode && linkNode.attr(urlAttribute)) ||
          (itemUrlAttribute ? node.attr(itemUrlAttribute) : '') ||
          '';
        const title = readNodeValue(titleNode, titleAttribute);
        const content = readNodeValue(contentNode, contentAttribute) || title;

        if (!href || !title || title.length < 2) {
          return;
        }

        const absoluteUrl = new URL(href, this.source.method.url).toString();
        const haystack = [absoluteUrl, title, content].join(' ');

        if (excludePatterns.some((pattern) => pattern.test(haystack))) {
          return;
        }

        if (includePatterns.length > 0 && !includePatterns.some((pattern) => pattern.test(haystack))) {
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

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }
}

module.exports = {
  HtmlListAdapter,
};
