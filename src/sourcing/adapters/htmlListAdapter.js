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

function readMergedValues($, rootNode, selectors, attributeName, joinWith) {
  if (!selectors.length) {
    return '';
  }

  const values = [];
  const seen = new Set();

  for (const selector of selectors) {
    rootNode.find(selector).each((_, element) => {
      const node = $(element);
      const value = readNodeValue(node, attributeName);

      if (!value || seen.has(value)) {
        return;
      }

      seen.add(value);
      values.push(value);
    });
  }

  return values.join(joinWith);
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
    const companyNameSelectors = toSelectorList(extractConfig.companyNameSelector, null);
    const companyWebsiteSelectors = toSelectorList(extractConfig.companyWebsiteSelector, null);
    const excludeSelectors = toSelectorList(extractConfig.excludeSelectors, null);
    const urlAttribute = extractConfig.urlAttribute || 'href';
    const itemUrlAttribute = extractConfig.itemUrlAttribute || null;
    const titleAttribute = extractConfig.titleAttribute || null;
    const contentAttribute = extractConfig.contentAttribute || null;
    const companyNameAttribute = extractConfig.companyNameAttribute || null;
    const companyWebsiteUrlAttribute = extractConfig.companyWebsiteUrlAttribute || 'href';
    const mergeContentSelectors = extractConfig.mergeContentSelectors === true;
    const contentJoinWith = extractConfig.contentJoinWith || ' ';
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
        const contentNode = mergeContentSelectors
          ? null
          : firstMatchingNode($, node, contentSelectors, null);
        const companyNameNode = firstMatchingNode($, node, companyNameSelectors, null);
        const companyWebsiteNode = firstMatchingNode($, node, companyWebsiteSelectors, null);
        const href =
          (linkNode && linkNode.attr(urlAttribute)) ||
          (itemUrlAttribute ? node.attr(itemUrlAttribute) : '') ||
          '';
        const title = readNodeValue(titleNode, titleAttribute);
        const content = (
          mergeContentSelectors
            ? readMergedValues($, node, contentSelectors, contentAttribute, contentJoinWith)
            : readNodeValue(contentNode, contentAttribute)
        ) || title;
        const companyName = readNodeValue(companyNameNode, companyNameAttribute);
        const companyWebsite = companyWebsiteNode
          ? new URL(companyWebsiteNode.attr(companyWebsiteUrlAttribute), this.source.method.url).toString()
          : '';

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
          company_name: companyName || undefined,
          company_website: companyWebsite || undefined,
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
