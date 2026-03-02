const cheerio = require('cheerio');
const { BaseAdapter } = require('./baseAdapter');

class HtmlListAdapter extends BaseAdapter {
  async run({ query }) {
    const url = this.resolveUrl(query);
    const html = await this.fetchText(url);
    const $ = cheerio.load(html);
    const seenUrls = new Set();
    const results = [];

    $('a[href]').each((_, element) => {
      if (results.length >= 20) {
        return false;
      }

      const href = $(element).attr('href');
      const title = $(element).text().replace(/\s+/g, ' ').trim();

      if (!href || !title || title.length < 2) {
        return;
      }

      const absoluteUrl = new URL(href, this.source.method.url).toString();

      if (seenUrls.has(absoluteUrl)) {
        return;
      }

      seenUrls.add(absoluteUrl);
      results.push({
        title,
        url: absoluteUrl,
        content: title,
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
