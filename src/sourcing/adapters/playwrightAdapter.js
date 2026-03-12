const { chromium } = require('playwright');
const { HtmlListAdapter } = require('./htmlListAdapter');

class PlaywrightAdapter {
  constructor(source, options = {}) {
    this.source = source;
    this.timeoutMs = options.timeoutMs || 30000;
  }

  async run({ query }) {
    const url = this.source.method?.url;
    if (!url) {
      throw new Error('No URL configured');
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: this.timeoutMs });
      await page.waitForSelector('a[href], h2, h3', { timeout: 8000 }).catch(() => {});
      const html = await page.content();
      const staticAdapter = new HtmlListAdapter(this.source, {
        timeoutMs: this.timeoutMs,
        _htmlOverride: html,
      });
      return staticAdapter.run({ query });
    } finally {
      await browser.close();
    }
  }
}

module.exports = {
  PlaywrightAdapter,
};
