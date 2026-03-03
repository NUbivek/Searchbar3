const { ApiSearchAdapter } = require('../../src/sourcing/adapters/apiSearchAdapter');
const { HtmlListAdapter } = require('../../src/sourcing/adapters/htmlListAdapter');
const { RssAdapter } = require('../../src/sourcing/adapters/rssAdapter');

describe('sourcing adapters', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  test('RssAdapter respects configured tag mappings and limit', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <rss><channel>
          <entry><headline>First</headline><permalink>https://a.test/1</permalink><summary>One</summary><published>2026-03-02</published></entry>
          <entry><headline>Second</headline><permalink>https://a.test/2</permalink><summary>Two</summary><published>2026-03-03</published></entry>
        </channel></rss>
      `,
    });

    const adapter = new RssAdapter({
      method: {
        url: 'https://example.com/feed.xml',
        extract: {
          containerTag: 'entry',
          titleTag: 'headline',
          urlTag: 'permalink',
          contentTag: 'summary',
          publishedAtTag: 'published',
          limit: 1,
        },
      },
    });

    const results = await adapter.run();

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('First');
    expect(results[0].url).toBe('https://a.test/1');
  });

  test('HtmlListAdapter respects selectors and exclusion patterns', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="card">
            <a class="startup-link" href="/companies/acme">Acme</a>
            <p class="summary">Logistics software</p>
          </div>
          <div class="card">
            <a class="startup-link" href="/about">About</a>
            <p class="summary">Ignore me</p>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://example.com',
        extract: {
          itemSelector: '.card',
          linkSelector: '.startup-link',
          titleSelector: '.startup-link',
          contentSelector: '.summary',
          excludePatterns: ['/about'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Acme');
    expect(results[0].content).toBe('Logistics software');
    expect(results[0].url).toBe('https://example.com/companies/acme');
  });

  test('HtmlListAdapter supports array selectors, include patterns, and attribute reads', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="listing" data-url="/startups/acme-ai">
            <a class="nav-link" href="/pricing">Pricing</a>
            <h3 data-title="Acme AI"></h3>
            <p data-summary="Agentic workflow software"></p>
          </article>
          <article class="listing blocked" data-url="/legal/privacy">
            <h3 data-title="Privacy"></h3>
            <p data-summary="Ignore me"></p>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://example.com',
        extract: {
          itemSelector: ['.listing'],
          titleSelector: ['h3'],
          contentSelector: ['p'],
          titleAttribute: 'data-title',
          contentAttribute: 'data-summary',
          itemUrlAttribute: 'data-url',
          includePatterns: ['/startups/'],
          excludeSelectors: ['.blocked'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Acme AI');
    expect(results[0].content).toBe('Agentic workflow software');
    expect(results[0].url).toBe('https://example.com/startups/acme-ai');
  });

  test('HtmlListAdapter can merge content and extract company metadata', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="card">
            <a class="listing-link" href="/portfolio/acme">Visit</a>
            <h3 class="company">Acme Labs</h3>
            <p class="summary">AI workflow tooling</p>
            <p class="summary">Hiring engineers now</p>
            <a class="company-site" href="https://acme.ai">Website</a>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://example.com',
        extract: {
          itemSelector: '.card',
          linkSelector: '.listing-link',
          titleSelector: '.company',
          contentSelector: ['.summary'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: '.company',
          companyWebsiteSelector: '.company-site',
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('AI workflow tooling | Hiring engineers now');
    expect(results[0].company_name).toBe('Acme Labs');
    expect(results[0].company_website).toBe('https://acme.ai/');
  });

  test('ApiSearchAdapter respects configured field paths', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          records: [
            {
              attributes: {
                headline: 'Acme AI',
                permalink: 'https://example.com/acme',
                snippet: 'AI workflow startup',
              },
              company: {
                name: 'Acme AI',
                website: 'https://acme.ai',
              },
              timestamps: {
                published: '2026-03-02T00:00:00.000Z',
              },
            },
          ],
        },
      }),
    });

    const adapter = new ApiSearchAdapter({
      method: {
        url: 'https://example.com/api?q={{query}}',
        item_path: 'data.records',
        extract: {
          titlePath: 'attributes.headline',
          urlPath: 'attributes.permalink',
          contentPath: 'attributes.snippet',
          publishedAtPath: 'timestamps.published',
          companyNamePath: 'company.name',
          companyWebsitePath: 'company.website',
        },
      },
    });

    const results = await adapter.run({ query: 'acme' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Acme AI');
    expect(results[0].company_name).toBe('Acme AI');
    expect(results[0].company_website).toBe('https://acme.ai');
  });
});
