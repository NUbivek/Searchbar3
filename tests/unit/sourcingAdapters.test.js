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

  test('HtmlListAdapter honors exclude selectors and external company website detection', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <section class="portfolio-card" data-portfolio-item="1">
            <a class="internal-link" href="/portfolio/acme">Profile</a>
            <h3 data-company-name="Acme AI"></h3>
            <p class="summary">Applied AI workflow tools</p>
            <a class="company-site" href="https://acme.ai">Website</a>
          </section>
          <section class="portfolio-card newsletter-signup" data-portfolio-item="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <h3 data-company-name="Ignore Co"></h3>
            <p class="summary">Should be excluded</p>
            <a class="company-site" href="https://ignore.example">Website</a>
          </section>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://signalfire.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['h3'],
          titleAttribute: 'data-company-name',
          contentSelector: ['.summary'],
          companyNameSelector: ['h3'],
          companyNameAttribute: 'data-company-name',
          companyWebsiteSelector: ['.company-site'],
          excludeSelectors: ['.newsletter-signup'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Acme AI');
    expect(results[0].company_name).toBe('Acme AI');
    expect(results[0].company_website).toBe('https://acme.ai/');
    expect(results[0].url).toBe('https://signalfire.com/portfolio/acme');
  });

  test('HtmlListAdapter supports data-company-card portfolio extraction patterns', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/orbit">Open</a>
            <h3 data-company-name="Orbit Labs"></h3>
            <p class="description">Developer workflow platform</p>
            <p class="excerpt">Backed by early-stage funds</p>
            <div class="company-site">
              <a href="https://orbitlabs.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-card footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <h3 data-company-name="Ignore"></h3>
            <p class="description">Ignore this</p>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://pear.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['h3'],
          titleAttribute: 'data-company-name',
          contentSelector: ['.description', '.excerpt'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['h3'],
          companyNameAttribute: 'data-company-name',
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Orbit Labs');
    expect(results[0].content).toBe('Developer workflow platform | Backed by early-stage funds');
    expect(results[0].company_name).toBe('Orbit Labs');
    expect(results[0].company_website).toBe('https://orbitlabs.ai/');
    expect(results[0].url).toBe('https://pear.vc/portfolio/orbit');
  });

  test('HtmlListAdapter supports company-name class and subtext in portfolio cards', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/helix">Profile</a>
            <div class="company-name">Helix Systems</div>
            <p class="description">B2B infrastructure software</p>
            <p class="subtext">Scaling across enterprise buyers</p>
            <div class="company-site">
              <a href="https://helixsystems.com">Site</a>
            </div>
          </article>
          <article class="portfolio-card cta-banner" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.20vc.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.cta-banner'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Helix Systems');
    expect(results[0].content).toBe('B2B infrastructure software | Scaling across enterprise buyers');
    expect(results[0].company_name).toBe('Helix Systems');
    expect(results[0].company_website).toBe('https://helixsystems.com/');
    expect(results[0].url).toBe('https://www.20vc.com/portfolio/helix');
  });

  test('HtmlListAdapter supports company directories with subtext and footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="company-card" data-company-card="1">
            <a class="internal-link" href="/companies/nova">Profile</a>
            <div class="company-name">Nova Ledger</div>
            <p class="description">Finance workflow tooling</p>
            <p class="subtext">Focused on early-stage CFO teams</p>
            <div class="company-site">
              <a href="https://novaledger.com">Site</a>
            </div>
          </article>
          <article class="company-card footer-cta" data-company-card="2">
            <a class="internal-link" href="/companies/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://seedcamp.com/companies/',
        extract: {
          itemSelector: ['.company-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/companies/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Nova Ledger');
    expect(results[0].content).toBe('Finance workflow tooling | Focused on early-stage CFO teams');
    expect(results[0].company_name).toBe('Nova Ledger');
    expect(results[0].company_website).toBe('https://novaledger.com/');
    expect(results[0].url).toBe('https://seedcamp.com/companies/nova');
  });

  test('HtmlListAdapter supports portfolio cards with company-name selectors and banner exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/vector">Profile</a>
            <div class="company-name">Vector Stack</div>
            <p class="description">AI workflow infra</p>
            <p class="subtext">Adopted by enterprise engineering teams</p>
            <div class="company-site">
              <a href="https://vectorstack.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-card cta-banner" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.firstminute.capital/portfolio',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.cta-banner'],
          includePatterns: ['/portfolio'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Vector Stack');
    expect(results[0].content).toBe('AI workflow infra | Adopted by enterprise engineering teams');
    expect(results[0].company_name).toBe('Vector Stack');
    expect(results[0].company_website).toBe('https://vectorstack.ai/');
    expect(results[0].url).toBe('https://www.firstminute.capital/portfolio/vector');
  });

  test('HtmlListAdapter supports localglobe-style portfolio cards with subtext and footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/lattice">Profile</a>
            <div class="company-name">Lattice Health</div>
            <p class="description">Care coordination software</p>
            <p class="subtext">Used by distributed clinical teams</p>
            <div class="company-site">
              <a href="https://latticehealth.com">Site</a>
            </div>
          </article>
          <article class="portfolio-card footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.localglobe.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Lattice Health');
    expect(results[0].content).toBe('Care coordination software | Used by distributed clinical teams');
    expect(results[0].company_name).toBe('Lattice Health');
    expect(results[0].company_website).toBe('https://latticehealth.com/');
    expect(results[0].url).toBe('https://www.localglobe.vc/portfolio/lattice');
  });

  test('HtmlListAdapter supports kima-style portfolio cards with banner exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/signalflow">Profile</a>
            <div class="company-name">SignalFlow</div>
            <p class="description">Embedded fintech tooling</p>
            <p class="subtext">Used by payment and treasury teams</p>
            <div class="company-site">
              <a href="https://signalflow.io">Site</a>
            </div>
          </article>
          <article class="portfolio-card cta-banner" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.kimaventures.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.cta-banner'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('SignalFlow');
    expect(results[0].content).toBe('Embedded fintech tooling | Used by payment and treasury teams');
    expect(results[0].company_name).toBe('SignalFlow');
    expect(results[0].company_website).toBe('https://signalflow.io/');
    expect(results[0].url).toBe('https://www.kimaventures.com/portfolio/signalflow');
  });

  test('HtmlListAdapter supports speedinvest-style portfolio cards with banner exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/arcgrid">Profile</a>
            <div class="company-name">ArcGrid</div>
            <p class="description">Developer infra orchestration</p>
            <p class="subtext">Used by distributed product teams</p>
            <div class="company-site">
              <a href="https://arcgrid.dev">Site</a>
            </div>
          </article>
          <article class="portfolio-card footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://speedinvest.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('ArcGrid');
    expect(results[0].content).toBe('Developer infra orchestration | Used by distributed product teams');
    expect(results[0].company_name).toBe('ArcGrid');
    expect(results[0].company_website).toBe('https://arcgrid.dev/');
    expect(results[0].url).toBe('https://speedinvest.com/portfolio/arcgrid');
  });

  test('HtmlListAdapter supports eqt-style portfolio cards with banner exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/solstice">Profile</a>
            <div class="company-name">Solstice Data</div>
            <p class="description">Climate analytics software</p>
            <p class="subtext">Used by finance and sustainability teams</p>
            <div class="company-site">
              <a href="https://solsticedata.com">Site</a>
            </div>
          </article>
          <article class="portfolio-card cta-banner" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://eqtventures.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.cta-banner'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Solstice Data');
    expect(results[0].content).toBe('Climate analytics software | Used by finance and sustainability teams');
    expect(results[0].company_name).toBe('Solstice Data');
    expect(results[0].company_website).toBe('https://solsticedata.com/');
    expect(results[0].url).toBe('https://eqtventures.com/portfolio/solstice');
  });

  test('HtmlListAdapter supports northzone-style portfolio cards with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/opal">Profile</a>
            <div class="company-name">Opal Finance</div>
            <p class="description">Consumer fintech infrastructure</p>
            <p class="subtext">Used by banking product teams</p>
            <div class="company-site">
              <a href="https://opalfinance.com">Site</a>
            </div>
          </article>
          <article class="portfolio-card footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://northzone.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Opal Finance');
    expect(results[0].content).toBe('Consumer fintech infrastructure | Used by banking product teams');
    expect(results[0].company_name).toBe('Opal Finance');
    expect(results[0].company_website).toBe('https://opalfinance.com/');
    expect(results[0].url).toBe('https://northzone.com/portfolio/opal');
  });

  test('HtmlListAdapter supports general-catalyst-style portfolio cards with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/pulsecare">Profile</a>
            <div class="company-name">PulseCare</div>
            <p class="description">AI-enabled care operations</p>
            <p class="subtext">Used by provider ops and clinical teams</p>
            <div class="company-site">
              <a href="https://pulsecare.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-card footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.generalcatalyst.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('PulseCare');
    expect(results[0].content).toBe('AI-enabled care operations | Used by provider ops and clinical teams');
    expect(results[0].company_name).toBe('PulseCare');
    expect(results[0].company_website).toBe('https://pulsecare.ai/');
    expect(results[0].url).toBe('https://www.generalcatalyst.com/portfolio/pulsecare');
  });

  test('HtmlListAdapter supports accel company directories with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="company-card" data-company-card="1">
            <a class="internal-link" href="/companies/beacon">Profile</a>
            <div class="company-name">Beacon AI</div>
            <p class="description">Workflow automation for support teams</p>
            <p class="subtext">Used by enterprise CX teams</p>
            <div class="company-site">
              <a href="https://beaconai.com">Site</a>
            </div>
          </article>
          <article class="company-card footer-cta" data-company-card="2">
            <a class="internal-link" href="/companies/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.accel.com/companies',
        extract: {
          itemSelector: ['.company-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/companies/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Beacon AI');
    expect(results[0].content).toBe('Workflow automation for support teams | Used by enterprise CX teams');
    expect(results[0].company_name).toBe('Beacon AI');
    expect(results[0].company_website).toBe('https://beaconai.com/');
    expect(results[0].url).toBe('https://www.accel.com/companies/beacon');
  });

  test('HtmlListAdapter supports index-style portfolio cards with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/tidal">Profile</a>
            <div class="company-name">Tidal Ops</div>
            <p class="description">Enterprise workflow orchestration</p>
            <p class="subtext">Used by finance and operations teams</p>
            <div class="company-site">
              <a href="https://tidalops.com">Site</a>
            </div>
          </article>
          <article class="portfolio-card footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.indexventures.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Tidal Ops');
    expect(results[0].content).toBe('Enterprise workflow orchestration | Used by finance and operations teams');
    expect(results[0].company_name).toBe('Tidal Ops');
    expect(results[0].company_website).toBe('https://tidalops.com/');
    expect(results[0].url).toBe('https://www.indexventures.com/portfolio/tidal');
  });

  test('HtmlListAdapter supports lightspeed-style portfolio cards with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-card" data-company-card="1">
            <a class="internal-link" href="/portfolio/meridian">Profile</a>
            <div class="company-name">Meridian Cloud</div>
            <p class="description">Enterprise cloud operations software</p>
            <p class="subtext">Used by global product teams</p>
            <div class="company-site">
              <a href="https://meridiancloud.com">Site</a>
            </div>
          </article>
          <article class="portfolio-card footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://lsvp.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-card'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Meridian Cloud');
    expect(results[0].content).toBe('Enterprise cloud operations software | Used by global product teams');
    expect(results[0].company_name).toBe('Meridian Cloud');
    expect(results[0].company_website).toBe('https://meridiancloud.com/');
    expect(results[0].url).toBe('https://lsvp.com/portfolio/meridian');
  });

  test('HtmlListAdapter supports frst-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/harbor">Profile</a>
            <div class="company-name">Harbor Ledger</div>
            <p class="description">Accounting automation for finance teams</p>
            <p class="subtext">Used by modern CFO and ops teams</p>
            <div class="company-site">
              <a href="https://harborledger.com">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.frst.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Harbor Ledger');
    expect(results[0].content).toBe('Accounting automation for finance teams | Used by modern CFO and ops teams');
    expect(results[0].company_name).toBe('Harbor Ledger');
    expect(results[0].company_website).toBe('https://harborledger.com/');
    expect(results[0].url).toBe('https://www.frst.vc/portfolio/harbor');
  });

  test('HtmlListAdapter supports elaia-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/atlas">Profile</a>
            <div class="company-name">Atlas Compute</div>
            <p class="description">AI infrastructure for industrial systems</p>
            <p class="subtext">Used by manufacturing and robotics teams</p>
            <div class="company-site">
              <a href="https://atlascompute.com">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.elaia.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Atlas Compute');
    expect(results[0].content).toBe('AI infrastructure for industrial systems | Used by manufacturing and robotics teams');
    expect(results[0].company_name).toBe('Atlas Compute');
    expect(results[0].company_website).toBe('https://atlascompute.com/');
    expect(results[0].url).toBe('https://www.elaia.com/portfolio/atlas');
  });

  test('HtmlListAdapter supports sequoia arc company directories with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/companies/latticeflow">Profile</a>
            <div class="company-name">LatticeFlow</div>
            <p class="description">Model evaluation for enterprise AI teams</p>
            <p class="subtext">Used by platform and ML engineering groups</p>
            <div class="company-site">
              <a href="https://latticeflow.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/companies/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.sequoiacap.com/arc/companies/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/companies/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LatticeFlow');
    expect(results[0].content).toBe('Model evaluation for enterprise AI teams | Used by platform and ML engineering groups');
    expect(results[0].company_name).toBe('LatticeFlow');
    expect(results[0].company_website).toBe('https://latticeflow.ai/');
    expect(results[0].url).toBe('https://www.sequoiacap.com/companies/latticeflow');
  });

  test('HtmlListAdapter supports omers ventures-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/clearpath">Profile</a>
            <div class="company-name">ClearPath Systems</div>
            <p class="description">Security operations for cloud-native teams</p>
            <p class="subtext">Used by enterprise infrastructure groups</p>
            <div class="company-site">
              <a href="https://clearpathsystems.com">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.omersventures.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('ClearPath Systems');
    expect(results[0].content).toBe('Security operations for cloud-native teams | Used by enterprise infrastructure groups');
    expect(results[0].company_name).toBe('ClearPath Systems');
    expect(results[0].company_website).toBe('https://clearpathsystems.com/');
    expect(results[0].url).toBe('https://www.omersventures.com/portfolio/clearpath');
  });

  test('HtmlListAdapter supports kindred-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/signalgrid">Profile</a>
            <div class="company-name">SignalGrid</div>
            <p class="description">Workflow automation for data teams</p>
            <p class="subtext">Used by analytics and infra operators</p>
            <div class="company-site">
              <a href="https://signalgrid.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://kindredcapital.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('SignalGrid');
    expect(results[0].content).toBe('Workflow automation for data teams | Used by analytics and infra operators');
    expect(results[0].company_name).toBe('SignalGrid');
    expect(results[0].company_website).toBe('https://signalgrid.io/');
    expect(results[0].url).toBe('https://kindredcapital.vc/portfolio/signalgrid');
  });

  test('HtmlListAdapter supports byfounders-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/nordstack">Profile</a>
            <div class="company-name">NordStack</div>
            <p class="description">Infrastructure automation for B2B teams</p>
            <p class="subtext">Used by finance and ops organizations</p>
            <div class="company-site">
              <a href="https://nordstack.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://byfounders.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('NordStack');
    expect(results[0].content).toBe('Infrastructure automation for B2B teams | Used by finance and ops organizations');
    expect(results[0].company_name).toBe('NordStack');
    expect(results[0].company_website).toBe('https://nordstack.io/');
    expect(results[0].url).toBe('https://byfounders.vc/portfolio/nordstack');
  });

  test('HtmlListAdapter supports cherry-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/keystone">Profile</a>
            <div class="company-name">Keystone Labs</div>
            <p class="description">Developer workflow tooling for platform teams</p>
            <p class="subtext">Used by modern engineering organizations</p>
            <div class="company-site">
              <a href="https://keystonelabs.dev">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.cherry.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Keystone Labs');
    expect(results[0].content).toBe('Developer workflow tooling for platform teams | Used by modern engineering organizations');
    expect(results[0].company_name).toBe('Keystone Labs');
    expect(results[0].company_website).toBe('https://keystonelabs.dev/');
    expect(results[0].url).toBe('https://www.cherry.vc/portfolio/keystone');
  });

  test('HtmlListAdapter supports playfair-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/brightlayer">Profile</a>
            <div class="company-name">BrightLayer</div>
            <p class="description">Automation tooling for finance and ops teams</p>
            <p class="subtext">Used by modern B2B operating teams</p>
            <div class="company-site">
              <a href="https://brightlayer.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://playfair.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('BrightLayer');
    expect(results[0].content).toBe('Automation tooling for finance and ops teams | Used by modern B2B operating teams');
    expect(results[0].company_name).toBe('BrightLayer');
    expect(results[0].company_website).toBe('https://brightlayer.io/');
    expect(results[0].url).toBe('https://playfair.vc/portfolio/brightlayer');
  });

  test('HtmlListAdapter supports seedtogrow-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/pulsemesh">Profile</a>
            <div class="company-name">PulseMesh</div>
            <p class="description">Workflow orchestration for ops teams</p>
            <p class="subtext">Used by finance and support organizations</p>
            <div class="company-site">
              <a href="https://pulsemesh.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://seedtogrow.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('PulseMesh');
    expect(results[0].content).toBe('Workflow orchestration for ops teams | Used by finance and support organizations');
    expect(results[0].company_name).toBe('PulseMesh');
    expect(results[0].company_website).toBe('https://pulsemesh.io/');
    expect(results[0].url).toBe('https://seedtogrow.vc/portfolio/pulsemesh');
  });

  test('HtmlListAdapter supports hoxton-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/opsforge">Profile</a>
            <div class="company-name">OpsForge</div>
            <p class="description">Workflow systems for operations teams</p>
            <p class="subtext">Used by finance, support, and revenue orgs</p>
            <div class="company-site">
              <a href="https://opsforge.com">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.hoxtonventures.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsForge');
    expect(results[0].content).toBe('Workflow systems for operations teams | Used by finance, support, and revenue orgs');
    expect(results[0].company_name).toBe('OpsForge');
    expect(results[0].company_website).toBe('https://opsforge.com/');
    expect(results[0].url).toBe('https://www.hoxtonventures.com/portfolio/opsforge');
  });

  test('HtmlListAdapter supports seedcamp companies directories with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/companies/ledgerlane">Profile</a>
            <div class="company-name">LedgerLane</div>
            <p class="description">Finance workflow tooling for modern operators</p>
            <p class="subtext">Used by startup finance and ops teams</p>
            <div class="company-site">
              <a href="https://ledgerlane.co">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/companies/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://seedcamp.com/companies/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/companies/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LedgerLane');
    expect(results[0].content).toBe('Finance workflow tooling for modern operators | Used by startup finance and ops teams');
    expect(results[0].company_name).toBe('LedgerLane');
    expect(results[0].company_website).toBe('https://ledgerlane.co/');
    expect(results[0].url).toBe('https://seedcamp.com/companies/ledgerlane');
  });

  test('HtmlListAdapter supports nineyards-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/anchorgrid">Profile</a>
            <div class="company-name">AnchorGrid</div>
            <p class="description">Enterprise workflow systems for finance teams</p>
            <p class="subtext">Used by B2B operations and platform groups</p>
            <div class="company-site">
              <a href="https://anchorgrid.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.nineyards.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('AnchorGrid');
    expect(results[0].content).toBe('Enterprise workflow systems for finance teams | Used by B2B operations and platform groups');
    expect(results[0].company_name).toBe('AnchorGrid');
    expect(results[0].company_website).toBe('https://anchorgrid.io/');
    expect(results[0].url).toBe('https://www.nineyards.vc/portfolio/anchorgrid');
  });

  test('HtmlListAdapter supports lemonade-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/sparkcart">Profile</a>
            <div class="company-name">SparkCart</div>
            <p class="description">Consumer checkout tools for modern retailers</p>
            <p class="subtext">Used by commerce and payments teams across Europe</p>
            <div class="company-site">
              <a href="https://sparkcart.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://lemonade.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('SparkCart');
    expect(results[0].content).toBe('Consumer checkout tools for modern retailers | Used by commerce and payments teams across Europe');
    expect(results[0].company_name).toBe('SparkCart');
    expect(results[0].company_website).toBe('https://sparkcart.io/');
    expect(results[0].url).toBe('https://lemonade.vc/portfolio/sparkcart');
  });

  test('HtmlListAdapter supports anthemis-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/ledgerflow">Profile</a>
            <div class="company-name">LedgerFlow</div>
            <p class="description">Fintech workflow systems for modern banking teams</p>
            <p class="subtext">Used by compliance and operations teams across Europe</p>
            <div class="company-site">
              <a href="https://ledgerflow.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://anthemis.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LedgerFlow');
    expect(results[0].content).toBe('Fintech workflow systems for modern banking teams | Used by compliance and operations teams across Europe');
    expect(results[0].company_name).toBe('LedgerFlow');
    expect(results[0].company_website).toBe('https://ledgerflow.io/');
    expect(results[0].url).toBe('https://anthemis.com/portfolio/ledgerflow');
  });

  test('HtmlListAdapter supports fintech collective-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/treasurymesh">Profile</a>
            <div class="company-name">TreasuryMesh</div>
            <p class="description">Banking infrastructure software for enterprise finance teams</p>
            <p class="subtext">Used by treasury, risk, and CFO organizations</p>
            <div class="company-site">
              <a href="https://treasurymesh.com">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.fintech.io/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('TreasuryMesh');
    expect(results[0].content).toBe('Banking infrastructure software for enterprise finance teams | Used by treasury, risk, and CFO organizations');
    expect(results[0].company_name).toBe('TreasuryMesh');
    expect(results[0].company_website).toBe('https://treasurymesh.com/');
    expect(results[0].url).toBe('https://www.fintech.io/portfolio/treasurymesh');
  });

  test('HtmlListAdapter supports creative destruction lab-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/ventures/quantforge">Profile</a>
            <div class="company-name">QuantForge</div>
            <p class="description">Applied AI systems for industrial robotics teams</p>
            <p class="subtext">Used by labs, operators, and manufacturing groups</p>
            <div class="company-site">
              <a href="https://quantforge.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/ventures/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://creativedestructionlab.com/ventures/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/ventures/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('QuantForge');
    expect(results[0].content).toBe('Applied AI systems for industrial robotics teams | Used by labs, operators, and manufacturing groups');
    expect(results[0].company_name).toBe('QuantForge');
    expect(results[0].company_website).toBe('https://quantforge.ai/');
    expect(results[0].url).toBe('https://creativedestructionlab.com/ventures/quantforge');
  });

  test('HtmlListAdapter supports torch capital-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/shopmesh">Profile</a>
            <div class="company-name">ShopMesh</div>
            <p class="description">Consumer commerce infrastructure for modern retail brands</p>
            <p class="subtext">Used by growth, merchandising, and ops teams</p>
            <div class="company-site">
              <a href="https://shopmesh.co">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.torchcapital.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('ShopMesh');
    expect(results[0].content).toBe('Consumer commerce infrastructure for modern retail brands | Used by growth, merchandising, and ops teams');
    expect(results[0].company_name).toBe('ShopMesh');
    expect(results[0].company_website).toBe('https://shopmesh.co/');
    expect(results[0].url).toBe('https://www.torchcapital.com/portfolio/shopmesh');
  });

  test('HtmlListAdapter supports chapter one-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/marketlane">Profile</a>
            <div class="company-name">MarketLane</div>
            <p class="description">Marketplace tooling for modern consumer brands</p>
            <p class="subtext">Used by growth, catalog, and operations teams</p>
            <div class="company-site">
              <a href="https://marketlane.co">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://chapterone.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('MarketLane');
    expect(results[0].content).toBe('Marketplace tooling for modern consumer brands | Used by growth, catalog, and operations teams');
    expect(results[0].company_name).toBe('MarketLane');
    expect(results[0].company_website).toBe('https://marketlane.co/');
    expect(results[0].url).toBe('https://chapterone.com/portfolio/marketlane');
  });

  test('HtmlListAdapter supports forerunner-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/cartpilot">Profile</a>
            <div class="company-name">CartPilot</div>
            <p class="description">Commerce operations tooling for modern consumer brands</p>
            <p class="subtext">Used by merchandising, logistics, and growth teams</p>
            <div class="company-site">
              <a href="https://cartpilot.co">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.forerunnerventures.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('CartPilot');
    expect(results[0].content).toBe('Commerce operations tooling for modern consumer brands | Used by merchandising, logistics, and growth teams');
    expect(results[0].company_name).toBe('CartPilot');
    expect(results[0].company_website).toBe('https://cartpilot.co/');
    expect(results[0].url).toBe('https://www.forerunnerventures.com/portfolio/cartpilot');
  });

  test('HtmlListAdapter supports pear-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/foundrykit">Profile</a>
            <div class="company-name">FoundryKit</div>
            <p class="description">Early-stage tooling for startup builders and operators</p>
            <p class="subtext">Used by founders, product, and engineering teams</p>
            <div class="company-site">
              <a href="https://foundrykit.co">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://pear.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('FoundryKit');
    expect(results[0].content).toBe('Early-stage tooling for startup builders and operators | Used by founders, product, and engineering teams');
    expect(results[0].company_name).toBe('FoundryKit');
    expect(results[0].company_website).toBe('https://foundrykit.co/');
    expect(results[0].url).toBe('https://pear.vc/portfolio/foundrykit');
  });

  test('HtmlListAdapter supports floodgate-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/stackpilot">Profile</a>
            <div class="company-name">StackPilot</div>
            <p class="description">Early-stage product tooling for startup teams</p>
            <p class="subtext">Used by founders, engineering, and go-to-market teams</p>
            <div class="company-site">
              <a href="https://stackpilot.dev">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://floodgate.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('StackPilot');
    expect(results[0].content).toBe('Early-stage product tooling for startup teams | Used by founders, engineering, and go-to-market teams');
    expect(results[0].company_name).toBe('StackPilot');
    expect(results[0].company_website).toBe('https://stackpilot.dev/');
    expect(results[0].url).toBe('https://floodgate.com/portfolio/stackpilot');
  });

  test('HtmlListAdapter supports xyz-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/ledgergrid">Profile</a>
            <div class="company-name">LedgerGrid</div>
            <p class="description">Seed-stage tooling for software and fintech teams</p>
            <p class="subtext">Used by product, finance, and engineering operators</p>
            <div class="company-site">
              <a href="https://ledgergrid.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://xyz.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LedgerGrid');
    expect(results[0].content).toBe('Seed-stage tooling for software and fintech teams | Used by product, finance, and engineering operators');
    expect(results[0].company_name).toBe('LedgerGrid');
    expect(results[0].company_website).toBe('https://ledgergrid.io/');
    expect(results[0].url).toBe('https://xyz.vc/portfolio/ledgergrid');
  });

  test('HtmlListAdapter supports alpine-style portfolio items with banner exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/orbitops">Profile</a>
            <div class="company-name">OrbitOps</div>
            <p class="description">Space infrastructure automation for defense and logistics teams</p>
            <p class="subtext">European early-stage deeptech operator stack</p>
            <div class="company-site">
              <a href="https://orbitops.eu">Site</a>
            </div>
          </article>
          <article class="portfolio-item cta-banner" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.alpinespace.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.cta-banner'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OrbitOps');
    expect(results[0].content).toBe('Space infrastructure automation for defense and logistics teams | European early-stage deeptech operator stack');
    expect(results[0].company_name).toBe('OrbitOps');
    expect(results[0].company_website).toBe('https://orbitops.eu/');
    expect(results[0].url).toBe('https://www.alpinespace.vc/portfolio/orbitops');
  });

  test('HtmlListAdapter supports openocean-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/datamesh-cloud">Profile</a>
            <div class="company-name">DataMesh Cloud</div>
            <p class="description">Distributed data workflows for modern analytics teams</p>
            <p class="subtext">European enterprise stack for data and AI operators</p>
            <div class="company-site">
              <a href="https://datameshcloud.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://openocean.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('DataMesh Cloud');
    expect(results[0].content).toBe('Distributed data workflows for modern analytics teams | European enterprise stack for data and AI operators');
    expect(results[0].company_name).toBe('DataMesh Cloud');
    expect(results[0].company_website).toBe('https://datameshcloud.io/');
    expect(results[0].url).toBe('https://openocean.vc/portfolio/datamesh-cloud');
  });

  test('HtmlListAdapter supports sunstone-style portfolio items with banner exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/nordstack">Profile</a>
            <div class="company-name">NordStack</div>
            <p class="description">Enterprise workflow tooling for Nordic finance and ops teams</p>
            <p class="subtext">B2B infrastructure stack for compliance and automation</p>
            <div class="company-site">
              <a href="https://nordstack.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item cta-banner" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.sunstone.life/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.cta-banner'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('NordStack');
    expect(results[0].content).toBe('Enterprise workflow tooling for Nordic finance and ops teams | B2B infrastructure stack for compliance and automation');
    expect(results[0].company_name).toBe('NordStack');
    expect(results[0].company_website).toBe('https://nordstack.io/');
    expect(results[0].url).toBe('https://www.sunstone.life/portfolio/nordstack');
  });

  test('HtmlListAdapter supports nordic-makers-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/fjordops">Profile</a>
            <div class="company-name">FjordOps</div>
            <p class="description">Nordic workflow infrastructure for finance and operations teams</p>
            <p class="subtext">B2B stack for automation, compliance, and reporting</p>
            <div class="company-site">
              <a href="https://fjordops.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://nordicmakers.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('FjordOps');
    expect(results[0].content).toBe('Nordic workflow infrastructure for finance and operations teams | B2B stack for automation, compliance, and reporting');
    expect(results[0].company_name).toBe('FjordOps');
    expect(results[0].company_website).toBe('https://fjordops.io/');
    expect(results[0].url).toBe('https://nordicmakers.vc/portfolio/fjordops');
  });

  test('HtmlListAdapter supports moonfire-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/cartloop">Profile</a>
            <div class="company-name">CartLoop</div>
            <p class="description">Marketplace infrastructure for cross-border commerce and fulfillment</p>
            <p class="subtext">Consumer and logistics tooling for scalable operators</p>
            <div class="company-site">
              <a href="https://cartloop.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://moonfire.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('CartLoop');
    expect(results[0].content).toBe('Marketplace infrastructure for cross-border commerce and fulfillment | Consumer and logistics tooling for scalable operators');
    expect(results[0].company_name).toBe('CartLoop');
    expect(results[0].company_website).toBe('https://cartloop.io/');
    expect(results[0].url).toBe('https://moonfire.com/portfolio/cartloop');
  });

  test('HtmlListAdapter supports atlantic-labs-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/climategrid">Profile</a>
            <div class="company-name">ClimateGrid</div>
            <p class="description">Climate analytics infrastructure for operators and industrial buyers</p>
            <p class="subtext">European marketplaces and workflow software for energy teams</p>
            <div class="company-site">
              <a href="https://climategrid.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://atlanticlabs.de/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('ClimateGrid');
    expect(results[0].content).toBe('Climate analytics infrastructure for operators and industrial buyers | European marketplaces and workflow software for energy teams');
    expect(results[0].company_name).toBe('ClimateGrid');
    expect(results[0].company_website).toBe('https://climategrid.io/');
    expect(results[0].url).toBe('https://atlanticlabs.de/portfolio/climategrid');
  });

  test('HtmlListAdapter supports headline-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/shopmesh">Profile</a>
            <div class="company-name">ShopMesh</div>
            <p class="description">Commerce infrastructure for omnichannel brands and marketplaces</p>
            <p class="subtext">Consumer tooling for growth, retention, and operations</p>
            <div class="company-site">
              <a href="https://shopmesh.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://headline.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('ShopMesh');
    expect(results[0].content).toBe('Commerce infrastructure for omnichannel brands and marketplaces | Consumer tooling for growth, retention, and operations');
    expect(results[0].company_name).toBe('ShopMesh');
    expect(results[0].company_website).toBe('https://shopmesh.io/');
    expect(results[0].url).toBe('https://headline.com/portfolio/shopmesh');
  });

  test('HtmlListAdapter supports rtp-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/pipelane">Profile</a>
            <div class="company-name">PipeLane</div>
            <p class="description">Enterprise workflow and integration tooling for revenue teams</p>
            <p class="subtext">Global SaaS stack for operators, data sync, and automation</p>
            <div class="company-site">
              <a href="https://pipelane.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.rtp.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('PipeLane');
    expect(results[0].content).toBe('Enterprise workflow and integration tooling for revenue teams | Global SaaS stack for operators, data sync, and automation');
    expect(results[0].company_name).toBe('PipeLane');
    expect(results[0].company_website).toBe('https://pipelane.io/');
    expect(results[0].url).toBe('https://www.rtp.vc/portfolio/pipelane');
  });

  test('HtmlListAdapter supports notion-capital-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/revmesh">Profile</a>
            <div class="company-name">RevMesh</div>
            <p class="description">Revenue operations infrastructure for scaling SaaS companies</p>
            <p class="subtext">European enterprise tooling for finance, GTM, and automation</p>
            <div class="company-site">
              <a href="https://revmesh.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.notion.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('RevMesh');
    expect(results[0].content).toBe('Revenue operations infrastructure for scaling SaaS companies | European enterprise tooling for finance, GTM, and automation');
    expect(results[0].company_name).toBe('RevMesh');
    expect(results[0].company_website).toBe('https://revmesh.io/');
    expect(results[0].url).toBe('https://www.notion.vc/portfolio/revmesh');
  });

  test('HtmlListAdapter supports seed-x-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/brandflow">Profile</a>
            <div class="company-name">BrandFlow</div>
            <p class="description">Commerce operating system for emerging consumer brands</p>
            <p class="subtext">US growth tooling for lifecycle, retention, and merchandising teams</p>
            <div class="company-site">
              <a href="https://brandflow.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://seedx.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('BrandFlow');
    expect(results[0].content).toBe('Commerce operating system for emerging consumer brands | US growth tooling for lifecycle, retention, and merchandising teams');
    expect(results[0].company_name).toBe('BrandFlow');
    expect(results[0].company_website).toBe('https://brandflow.io/');
    expect(results[0].url).toBe('https://seedx.vc/portfolio/brandflow');
  });

  test('HtmlListAdapter supports freestyle-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/creatorloop">Profile</a>
            <div class="company-name">CreatorLoop</div>
            <p class="description">Consumer creator tooling for monetization and audience workflows</p>
            <p class="subtext">US software stack for creators, community, and lifecycle growth</p>
            <div class="company-site">
              <a href="https://creatorloop.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://freestyle.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('CreatorLoop');
    expect(results[0].content).toBe('Consumer creator tooling for monetization and audience workflows | US software stack for creators, community, and lifecycle growth');
    expect(results[0].company_name).toBe('CreatorLoop');
    expect(results[0].company_website).toBe('https://creatorloop.io/');
    expect(results[0].url).toBe('https://freestyle.vc/portfolio/creatorloop');
  });

  test('HtmlListAdapter supports base10-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/datagrid">Profile</a>
            <div class="company-name">DataGrid</div>
            <p class="description">Enterprise infrastructure for workflow automation and data orchestration</p>
            <p class="subtext">US software tooling for ops, finance, and infrastructure teams</p>
            <div class="company-site">
              <a href="https://datagrid.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://base10.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('DataGrid');
    expect(results[0].content).toBe('Enterprise infrastructure for workflow automation and data orchestration | US software tooling for ops, finance, and infrastructure teams');
    expect(results[0].company_name).toBe('DataGrid');
    expect(results[0].company_website).toBe('https://datagrid.io/');
    expect(results[0].url).toBe('https://base10.vc/portfolio/datagrid');
  });

  test('HtmlListAdapter supports south-park-style company directories with company-path filters', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/companies/opsgrid">Profile</a>
            <div class="company-name">OpsGrid</div>
            <p class="description">Founder community software for operator workflows and collaboration</p>
            <p class="subtext">US marketplace and productivity tooling for early-stage teams</p>
            <div class="company-site">
              <a href="https://opsgrid.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/companies/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://southparkcommons.com/companies/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/companies/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsGrid');
    expect(results[0].content).toBe('Founder community software for operator workflows and collaboration | US marketplace and productivity tooling for early-stage teams');
    expect(results[0].company_name).toBe('OpsGrid');
    expect(results[0].company_website).toBe('https://opsgrid.io/');
    expect(results[0].url).toBe('https://southparkcommons.com/companies/opsgrid');
  });

  test('HtmlListAdapter supports haystack-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/stackpilot">Profile</a>
            <div class="company-name">StackPilot</div>
            <p class="description">Developer infrastructure for deployment orchestration and observability workflows</p>
            <p class="subtext">US platform tooling for infra, ops, and data teams</p>
            <div class="company-site">
              <a href="https://stackpilot.dev">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://haystack.vc/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('StackPilot');
    expect(results[0].content).toBe('Developer infrastructure for deployment orchestration and observability workflows | US platform tooling for infra, ops, and data teams');
    expect(results[0].company_name).toBe('StackPilot');
    expect(results[0].company_website).toBe('https://stackpilot.dev/');
    expect(results[0].url).toBe('https://haystack.vc/portfolio/stackpilot');
  });

  test('HtmlListAdapter supports felicis-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/agentdesk">Profile</a>
            <div class="company-name">AgentDesk</div>
            <p class="description">AI-native workflow tooling for support automation and operator productivity</p>
            <p class="subtext">US software stack for automation, orchestration, and team efficiency</p>
            <div class="company-site">
              <a href="https://agentdesk.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://felicis.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('AgentDesk');
    expect(results[0].content).toBe('AI-native workflow tooling for support automation and operator productivity | US software stack for automation, orchestration, and team efficiency');
    expect(results[0].company_name).toBe('AgentDesk');
    expect(results[0].company_website).toBe('https://agentdesk.ai/');
    expect(results[0].url).toBe('https://felicis.com/portfolio/agentdesk');
  });

  test('HtmlListAdapter supports amplify-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/flowgraph">Profile</a>
            <div class="company-name">FlowGraph</div>
            <p class="description">Developer infrastructure for distributed systems and data-intensive workflows</p>
            <p class="subtext">US software stack for infra, data, and backend teams</p>
            <div class="company-site">
              <a href="https://flowgraph.dev">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://amplifypartners.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('FlowGraph');
    expect(results[0].content).toBe('Developer infrastructure for distributed systems and data-intensive workflows | US software stack for infra, data, and backend teams');
    expect(results[0].company_name).toBe('FlowGraph');
    expect(results[0].company_website).toBe('https://flowgraph.dev/');
    expect(results[0].url).toBe('https://amplifypartners.com/portfolio/flowgraph');
  });

  test('HtmlListAdapter supports battery-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/runtimegrid">Profile</a>
            <div class="company-name">RuntimeGrid</div>
            <p class="description">Enterprise developer tooling for observability, deployment, and platform operations</p>
            <p class="subtext">US infrastructure software for platform and backend teams</p>
            <div class="company-site">
              <a href="https://runtimegrid.dev">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.battery.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('RuntimeGrid');
    expect(results[0].content).toBe('Enterprise developer tooling for observability, deployment, and platform operations | US infrastructure software for platform and backend teams');
    expect(results[0].company_name).toBe('RuntimeGrid');
    expect(results[0].company_website).toBe('https://runtimegrid.dev/');
    expect(results[0].url).toBe('https://www.battery.com/portfolio/runtimegrid');
  });

  test('HtmlListAdapter supports scale-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/launchstack">Profile</a>
            <div class="company-name">LaunchStack</div>
            <p class="description">Enterprise software tooling for product analytics, growth, and workflow visibility</p>
            <p class="subtext">US SaaS infrastructure for product, ops, and go-to-market teams</p>
            <div class="company-site">
              <a href="https://launchstack.io">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://scalevp.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LaunchStack');
    expect(results[0].content).toBe('Enterprise software tooling for product analytics, growth, and workflow visibility | US SaaS infrastructure for product, ops, and go-to-market teams');
    expect(results[0].company_name).toBe('LaunchStack');
    expect(results[0].company_website).toBe('https://launchstack.io/');
    expect(results[0].url).toBe('https://scalevp.com/portfolio/launchstack');
  });

  test('HtmlListAdapter supports redpoint-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/agentpath">Profile</a>
            <div class="company-name">AgentPath</div>
            <p class="description">AI developer tooling for model workflows, observability, and deployment orchestration</p>
            <p class="subtext">US infrastructure software for ML, platform, and product teams</p>
            <div class="company-site">
              <a href="https://agentpath.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://redpoint.com/portfolio/',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('AgentPath');
    expect(results[0].content).toBe('AI developer tooling for model workflows, observability, and deployment orchestration | US infrastructure software for ML, platform, and product teams');
    expect(results[0].company_name).toBe('AgentPath');
    expect(results[0].company_website).toBe('https://agentpath.ai/');
    expect(results[0].url).toBe('https://redpoint.com/portfolio/agentpath');
  });

  test('HtmlListAdapter supports nea-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/launchmesh">Profile</a>
            <div class="company-name">LaunchMesh</div>
            <p class="description">Enterprise AI infrastructure for data routing, orchestration, and product workflows</p>
            <p class="subtext">US software stack for platform, data, and engineering teams</p>
            <div class="company-site">
              <a href="https://launchmesh.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.nea.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LaunchMesh');
    expect(results[0].content).toBe('Enterprise AI infrastructure for data routing, orchestration, and product workflows | US software stack for platform, data, and engineering teams');
    expect(results[0].company_name).toBe('LaunchMesh');
    expect(results[0].company_website).toBe('https://launchmesh.ai/');
    expect(results[0].url).toBe('https://www.nea.com/portfolio/launchmesh');
  });

  test('HtmlListAdapter supports canaan-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/databridge">Profile</a>
            <div class="company-name">DataBridge</div>
            <p class="description">Healthcare and fintech infrastructure for secure enterprise workflows</p>
            <p class="subtext">US B2B software for compliance, payments, and data orchestration</p>
            <div class="company-site">
              <a href="https://databridge.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.canaan.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('DataBridge');
    expect(results[0].content).toBe('Healthcare and fintech infrastructure for secure enterprise workflows | US B2B software for compliance, payments, and data orchestration');
    expect(results[0].company_name).toBe('DataBridge');
    expect(results[0].company_website).toBe('https://databridge.ai/');
    expect(results[0].url).toBe('https://www.canaan.com/portfolio/databridge');
  });

  test('HtmlListAdapter supports ggv-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/marketgrid">Profile</a>
            <div class="company-name">MarketGrid</div>
            <p class="description">AI-first B2B workflow software for enterprise operations and commerce teams</p>
            <p class="subtext">US platform for customer data, routing, and automation orchestration</p>
            <div class="company-site">
              <a href="https://marketgrid.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.ggv.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('MarketGrid');
    expect(results[0].content).toBe('AI-first B2B workflow software for enterprise operations and commerce teams | US platform for customer data, routing, and automation orchestration');
    expect(results[0].company_name).toBe('MarketGrid');
    expect(results[0].company_website).toBe('https://marketgrid.ai/');
    expect(results[0].url).toBe('https://www.ggv.com/portfolio/marketgrid');
  });

  test('HtmlListAdapter supports craft-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/stackpilot">Profile</a>
            <div class="company-name">StackPilot</div>
            <p class="description">Marketplace and SaaS automation platform for revenue and product workflows</p>
            <p class="subtext">US AI-native operating software for customer lifecycle and data orchestration</p>
            <div class="company-site">
              <a href="https://stackpilot.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.craftventures.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('StackPilot');
    expect(results[0].content).toBe('Marketplace and SaaS automation platform for revenue and product workflows | US AI-native operating software for customer lifecycle and data orchestration');
    expect(results[0].company_name).toBe('StackPilot');
    expect(results[0].company_website).toBe('https://stackpilot.ai/');
    expect(results[0].url).toBe('https://www.craftventures.com/portfolio/stackpilot');
  });

  test('HtmlListAdapter supports merit-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/opslayer">Profile</a>
            <div class="company-name">OpsLayer</div>
            <p class="description">AI-native B2B software for enterprise operations, workflow automation, and reporting</p>
            <p class="subtext">US platform for orchestration, compliance, and infrastructure coordination</p>
            <div class="company-site">
              <a href="https://opslayer.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.merit.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsLayer');
    expect(results[0].content).toBe('AI-native B2B software for enterprise operations, workflow automation, and reporting | US platform for orchestration, compliance, and infrastructure coordination');
    expect(results[0].company_name).toBe('OpsLayer');
    expect(results[0].company_website).toBe('https://opslayer.ai/');
    expect(results[0].url).toBe('https://www.merit.vc/portfolio/opslayer');
  });

  test('HtmlListAdapter supports primary-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/routebase">Profile</a>
            <div class="company-name">RouteBase</div>
            <p class="description">AI-native SaaS workflow platform for go-to-market, operations, and analytics teams</p>
            <p class="subtext">US software for orchestration, customer systems, and execution automation</p>
            <div class="company-site">
              <a href="https://routebase.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.primary.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('RouteBase');
    expect(results[0].content).toBe('AI-native SaaS workflow platform for go-to-market, operations, and analytics teams | US software for orchestration, customer systems, and execution automation');
    expect(results[0].company_name).toBe('RouteBase');
    expect(results[0].company_website).toBe('https://routebase.ai/');
    expect(results[0].url).toBe('https://www.primary.vc/portfolio/routebase');
  });

  test('HtmlListAdapter supports bessemer-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/cloudgrid">Profile</a>
            <div class="company-name">CloudGrid</div>
            <p class="description">Cloud and AI infrastructure for enterprise data, workflow, and platform operations</p>
            <p class="subtext">US software stack for orchestration, observability, and application delivery</p>
            <div class="company-site">
              <a href="https://cloudgrid.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.bvp.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('CloudGrid');
    expect(results[0].content).toBe('Cloud and AI infrastructure for enterprise data, workflow, and platform operations | US software stack for orchestration, observability, and application delivery');
    expect(results[0].company_name).toBe('CloudGrid');
    expect(results[0].company_website).toBe('https://cloudgrid.ai/');
    expect(results[0].url).toBe('https://www.bvp.com/portfolio/cloudgrid');
  });

  test('HtmlListAdapter supports first round-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/signalops">Profile</a>
            <div class="company-name">SignalOps</div>
            <p class="description">AI and SaaS tooling for customer systems, execution, and product analytics</p>
            <p class="subtext">US workflow software for operators, GTM teams, and internal platform tooling</p>
            <div class="company-site">
              <a href="https://signalops.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.firstround.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('SignalOps');
    expect(results[0].content).toBe('AI and SaaS tooling for customer systems, execution, and product analytics | US workflow software for operators, GTM teams, and internal platform tooling');
    expect(results[0].company_name).toBe('SignalOps');
    expect(results[0].company_website).toBe('https://signalops.ai/');
    expect(results[0].url).toBe('https://www.firstround.com/portfolio/signalops');
  });

  test('HtmlListAdapter supports uncork-style portfolio items with footer exclusions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <article class="portfolio-item" data-company-card="1">
            <a class="internal-link" href="/portfolio/stackgrid">Profile</a>
            <div class="company-name">StackGrid</div>
            <p class="description">Developer and SaaS workflow tooling for internal systems and team operations</p>
            <p class="subtext">US software for orchestration, reporting, and execution across product and ops teams</p>
            <div class="company-site">
              <a href="https://stackgrid.ai">Site</a>
            </div>
          </article>
          <article class="portfolio-item footer-cta" data-company-card="2">
            <a class="internal-link" href="/portfolio/ignore">Ignore</a>
            <div class="company-name">Ignore Co</div>
          </article>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://uncork.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('StackGrid');
    expect(results[0].content).toBe('Developer and SaaS workflow tooling for internal systems and team operations | US software for orchestration, reporting, and execution across product and ops teams');
    expect(results[0].company_name).toBe('StackGrid');
    expect(results[0].company_website).toBe('https://stackgrid.ai/');
    expect(results[0].url).toBe('https://uncork.com/portfolio/stackgrid');
  });

  test('HtmlListAdapter extracts Bessemer-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="portfolio-item">
            <a class="internal-link" href="/portfolio/ledgerloop"></a>
            <div class="company-name">LedgerLoop</div>
            <div class="description">Embedded finance and treasury tooling for modern software companies</div>
            <div class="subtext">US fintech infrastructure for programmable workflows, cash visibility, and payments orchestration</div>
            <div class="company-site"><a href="https://ledgerloop.com/">Visit</a></div>
          </div>
          <div class="footer-cta">
            <a href="/portfolio/ignore-me">Ignore me</a>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.bvp.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LedgerLoop');
    expect(results[0].content).toBe('Embedded finance and treasury tooling for modern software companies | US fintech infrastructure for programmable workflows, cash visibility, and payments orchestration');
    expect(results[0].company_name).toBe('LedgerLoop');
    expect(results[0].company_website).toBe('https://ledgerloop.com/');
    expect(results[0].url).toBe('https://www.bvp.com/portfolio/ledgerloop');
  });

  test('HtmlListAdapter extracts Index-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="portfolio-item">
            <a class="internal-link" href="/portfolio/flowmesh"></a>
            <div class="company-name">Flowmesh</div>
            <div class="description">Infrastructure for developer workflow automation and internal orchestration</div>
            <div class="subtext">US platform software for tooling teams managing API, data, and product operations</div>
            <div class="company-site"><a href="https://flowmesh.dev/">Visit</a></div>
          </div>
          <div class="footer-cta">
            <a href="/portfolio/ignore-me">Ignore me</a>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.indexventures.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Flowmesh');
    expect(results[0].content).toBe('Infrastructure for developer workflow automation and internal orchestration | US platform software for tooling teams managing API, data, and product operations');
    expect(results[0].company_name).toBe('Flowmesh');
    expect(results[0].company_website).toBe('https://flowmesh.dev/');
    expect(results[0].url).toBe('https://www.indexventures.com/portfolio/flowmesh');
  });

  test('HtmlListAdapter extracts Founder Collective-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="portfolio-item">
            <a class="internal-link" href="/portfolio/launchdeck"></a>
            <div class="company-name">LaunchDeck</div>
            <div class="description">Workflow software for operators, founders, and GTM teams shipping product faster</div>
            <div class="subtext">US SaaS tooling for planning, execution, and automation across startup operating systems</div>
            <div class="company-site"><a href="https://launchdeck.io/">Visit</a></div>
          </div>
          <div class="footer-cta">
            <a href="/portfolio/ignore-me">Ignore me</a>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.foundercollective.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LaunchDeck');
    expect(results[0].content).toBe('Workflow software for operators, founders, and GTM teams shipping product faster | US SaaS tooling for planning, execution, and automation across startup operating systems');
    expect(results[0].company_name).toBe('LaunchDeck');
    expect(results[0].company_website).toBe('https://launchdeck.io/');
    expect(results[0].url).toBe('https://www.foundercollective.com/portfolio/launchdeck');
  });

  test('HtmlListAdapter extracts Slow Ventures-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="portfolio-item">
            <a class="internal-link" href="/portfolio/marketlane"></a>
            <div class="company-name">MarketLane</div>
            <div class="description">Consumer marketplace infrastructure for transactions, identity, and payments</div>
            <div class="subtext">US startup tooling for operator teams running commerce, onboarding, and monetization systems</div>
            <div class="company-site"><a href="https://marketlane.co/">Visit</a></div>
          </div>
          <div class="footer-cta">
            <a href="/portfolio/ignore-me">Ignore me</a>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.slow.co/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('MarketLane');
    expect(results[0].content).toBe('Consumer marketplace infrastructure for transactions, identity, and payments | US startup tooling for operator teams running commerce, onboarding, and monetization systems');
    expect(results[0].company_name).toBe('MarketLane');
    expect(results[0].company_website).toBe('https://marketlane.co/');
    expect(results[0].url).toBe('https://www.slow.co/portfolio/marketlane');
  });

  test('HtmlListAdapter extracts Lux-style company entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="portfolio-item">
            <a class="internal-link" href="/companies/quantforge"></a>
            <div class="company-name">QuantForge</div>
            <div class="description">AI and deep tech infrastructure for model deployment, data systems, and simulation</div>
            <div class="subtext">US platform tooling for technical teams building frontier software, research systems, and developer ops</div>
            <div class="company-site"><a href="https://quantforge.ai/">Visit</a></div>
          </div>
          <div class="footer-cta">
            <a href="/companies/ignore-me">Ignore me</a>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.luxcapital.com/companies',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/companies/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('QuantForge');
    expect(results[0].content).toBe('AI and deep tech infrastructure for model deployment, data systems, and simulation | US platform tooling for technical teams building frontier software, research systems, and developer ops');
    expect(results[0].company_name).toBe('QuantForge');
    expect(results[0].company_website).toBe('https://quantforge.ai/');
    expect(results[0].url).toBe('https://www.luxcapital.com/companies/quantforge');
  });

  test('HtmlListAdapter extracts SignalFire-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="portfolio-item">
            <a class="internal-link" href="/portfolio/modelgrid"></a>
            <div class="company-name">ModelGrid</div>
            <div class="description">AI infrastructure for evaluation, deployment, and agent observability in production systems</div>
            <div class="subtext">US platform tooling for engineering teams shipping model-backed workflows and automation systems</div>
            <div class="company-site"><a href="https://modelgrid.ai/">Visit</a></div>
          </div>
          <div class="footer-cta">
            <a href="/portfolio/ignore-me">Ignore me</a>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://signalfire.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('ModelGrid');
    expect(results[0].content).toBe('AI infrastructure for evaluation, deployment, and agent observability in production systems | US platform tooling for engineering teams shipping model-backed workflows and automation systems');
    expect(results[0].company_name).toBe('ModelGrid');
    expect(results[0].company_website).toBe('https://modelgrid.ai/');
    expect(results[0].url).toBe('https://signalfire.com/portfolio/modelgrid');
  });

  test('HtmlListAdapter extracts Pear-style company entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="portfolio-item">
            <a class="internal-link" href="/companies/buildlane"></a>
            <div class="company-name">BuildLane</div>
            <div class="description">Software infrastructure for startup builders managing products, workflows, and delivery</div>
            <div class="subtext">US tooling for founders and operators coordinating planning, execution, and customer systems</div>
            <div class="company-site"><a href="https://buildlane.co/">Visit</a></div>
          </div>
          <div class="footer-cta">
            <a href="/companies/ignore-me">Ignore me</a>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://pear.vc/companies',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/companies/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('BuildLane');
    expect(results[0].content).toBe('Software infrastructure for startup builders managing products, workflows, and delivery | US tooling for founders and operators coordinating planning, execution, and customer systems');
    expect(results[0].company_name).toBe('BuildLane');
    expect(results[0].company_website).toBe('https://buildlane.co/');
    expect(results[0].url).toBe('https://pear.vc/companies/buildlane');
  });

  test('HtmlListAdapter extracts Pair VC-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="portfolio-item">
            <a class="internal-link" href="/portfolio/shipyard"></a>
            <div class="company-name">Shipyard</div>
            <div class="description">Startup tooling for finance, workflow automation, and operator execution across software teams</div>
            <div class="subtext">US SaaS infrastructure for founders building product, revenue, and internal operating systems</div>
            <div class="company-site"><a href="https://shipyard.run/">Visit</a></div>
          </div>
          <div class="footer-cta">
            <a href="/portfolio/ignore-me">Ignore me</a>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://pair.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Shipyard');
    expect(results[0].content).toBe('Startup tooling for finance, workflow automation, and operator execution across software teams | US SaaS infrastructure for founders building product, revenue, and internal operating systems');
    expect(results[0].company_name).toBe('Shipyard');
    expect(results[0].company_website).toBe('https://shipyard.run/');
    expect(results[0].url).toBe('https://pair.vc/portfolio/shipyard');
  });

  test('HtmlListAdapter extracts Uncork-style founder portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <div class="portfolio-item">
            <a class="internal-link" href="/portfolio/railstack"></a>
            <div class="company-name">RailStack</div>
            <div class="description">Startup infrastructure for data workflows, reporting, and internal operating systems</div>
            <div class="subtext">US tooling for operator teams managing finance, product, and customer execution across SaaS companies</div>
            <div class="company-site"><a href="https://railstack.io/">Visit</a></div>
          </div>
          <div class="footer-cta">
            <a href="/portfolio/ignore-me">Ignore me</a>
          </div>
        </body></html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://uncork.com/portfolio',
        extract: {
          itemSelector: ['.portfolio-item'],
          linkSelector: ['.internal-link'],
          titleSelector: ['.company-name'],
          contentSelector: ['.description', '.subtext'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name'],
          companyWebsiteSelector: ['.company-site a'],
          excludeSelectors: ['.footer-cta'],
          includePatterns: ['/portfolio/'],
        },
      },
    });

    const results = await adapter.run({ query: '' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('RailStack');
    expect(results[0].content).toBe('Startup infrastructure for data workflows, reporting, and internal operating systems | US tooling for operator teams managing finance, product, and customer execution across SaaS companies');
    expect(results[0].company_name).toBe('RailStack');
    expect(results[0].company_website).toBe('https://railstack.io/');
    expect(results[0].url).toBe('https://uncork.com/portfolio/railstack');
  });

  test('HtmlListAdapter extracts Founders First-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/atlasops">View</a>
              <div class="company-name">AtlasOps</div>
              <div class="description">Workflow automation for customer operations and revenue teams</div>
              <div class="subtext">US startup helping sales, success, and finance teams run cross-functional playbooks</div>
              <div class="company-site"><a href="https://atlasops.com/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.foundersfirst.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="foundersfirst.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'atlas' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('AtlasOps');
    expect(results[0].content).toBe('US startup helping sales, success, and finance teams run cross-functional playbooks | Workflow automation for customer operations and revenue teams');
    expect(results[0].company_name).toBe('AtlasOps');
    expect(results[0].company_website).toBe('https://atlasops.com/');
    expect(results[0].url).toBe('https://www.foundersfirst.vc/portfolio/atlasops');
  });

  test('HtmlListAdapter extracts Stacked VC-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/stackflow">View</a>
              <div class="company-name">StackFlow</div>
              <div class="description">Infrastructure software for distributed developer and finance teams</div>
              <div class="subtext">US startup helping operator-led teams manage product delivery, data pipelines, and internal execution</div>
              <div class="company-site"><a href="https://stackflow.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://www.stacked.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="stacked.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'stack' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('StackFlow');
    expect(results[0].content).toBe('US startup helping operator-led teams manage product delivery, data pipelines, and internal execution | Infrastructure software for distributed developer and finance teams');
    expect(results[0].company_name).toBe('StackFlow');
    expect(results[0].company_website).toBe('https://stackflow.io/');
    expect(results[0].url).toBe('https://www.stacked.vc/portfolio/stackflow');
  });

  test('HtmlListAdapter extracts Focus-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/focusgrid">View</a>
              <div class="company-name">FocusGrid</div>
              <div class="description">Security and fintech tooling for modern operations teams</div>
              <div class="subtext">US startup helping finance, compliance, and infrastructure teams automate core internal workflows</div>
              <div class="company-site"><a href="https://focusgrid.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://focus.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="focus.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'focus' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('FocusGrid');
    expect(results[0].content).toBe('US startup helping finance, compliance, and infrastructure teams automate core internal workflows | Security and fintech tooling for modern operations teams');
    expect(results[0].company_name).toBe('FocusGrid');
    expect(results[0].company_website).toBe('https://focusgrid.io/');
    expect(results[0].url).toBe('https://focus.vc/portfolio/focusgrid');
  });

  test('HtmlListAdapter extracts Operators VC-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/opscore">View</a>
              <div class="company-name">OpsCore</div>
              <div class="description">Operator software for revenue, onboarding, and internal execution</div>
              <div class="subtext">US startup helping SaaS teams automate post-sales workflows, finance operations, and product handoffs</div>
              <div class="company-site"><a href="https://opscore.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operators.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operators.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsCore');
    expect(results[0].content).toBe('US startup helping SaaS teams automate post-sales workflows, finance operations, and product handoffs | Operator software for revenue, onboarding, and internal execution');
    expect(results[0].company_name).toBe('OpsCore');
    expect(results[0].company_website).toBe('https://opscore.io/');
    expect(results[0].url).toBe('https://operators.vc/portfolio/opscore');
  });

  test('HtmlListAdapter extracts Operator Capital-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/ledgerloop">View</a>
              <div class="company-name">LedgerLoop</div>
              <div class="description">Operator-led software for finance and GTM execution teams</div>
              <div class="subtext">US startup helping revenue, finance, and onboarding teams coordinate internal systems and reporting</div>
              <div class="company-site"><a href="https://ledgerloop.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operatorcapital.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operatorcapital.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ledger' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LedgerLoop');
    expect(results[0].content).toBe('US startup helping revenue, finance, and onboarding teams coordinate internal systems and reporting | Operator-led software for finance and GTM execution teams');
    expect(results[0].company_name).toBe('LedgerLoop');
    expect(results[0].company_website).toBe('https://ledgerloop.io/');
    expect(results[0].url).toBe('https://operatorcapital.vc/portfolio/ledgerloop');
  });

  test('HtmlListAdapter extracts Exec VC-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/execgrid">View</a>
              <div class="company-name">ExecGrid</div>
              <div class="description">Operator-led software for B2B execution and internal workflows</div>
              <div class="subtext">US startup helping product, finance, and customer teams coordinate internal systems and delivery</div>
              <div class="company-site"><a href="https://execgrid.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://exec.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="exec.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'exec' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('ExecGrid');
    expect(results[0].content).toBe('US startup helping product, finance, and customer teams coordinate internal systems and delivery | Operator-led software for B2B execution and internal workflows');
    expect(results[0].company_name).toBe('ExecGrid');
    expect(results[0].company_website).toBe('https://execgrid.io/');
    expect(results[0].url).toBe('https://exec.vc/portfolio/execgrid');
  });

  test('HtmlListAdapter extracts Exec Founders-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/foundergrid">View</a>
              <div class="company-name">FounderGrid</div>
              <div class="description">Operator-led workflow software for B2B execution teams</div>
              <div class="subtext">US startup helping finance, customer, and product teams coordinate delivery and internal systems</div>
              <div class="company-site"><a href="https://foundergrid.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://execfounders.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="execfounders.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'founder' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('FounderGrid');
    expect(results[0].content).toBe('US startup helping finance, customer, and product teams coordinate delivery and internal systems | Operator-led workflow software for B2B execution teams');
    expect(results[0].company_name).toBe('FounderGrid');
    expect(results[0].company_website).toBe('https://foundergrid.io/');
    expect(results[0].url).toBe('https://execfounders.vc/portfolio/foundergrid');
  });

  test('HtmlListAdapter extracts Ops Ventures-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/opsgrid">View</a>
              <div class="company-name">OpsGrid</div>
              <div class="description">Operator-led workflow software for B2B execution teams</div>
              <div class="subtext">US startup helping finance, customer, and product teams coordinate internal delivery and systems</div>
              <div class="company-site"><a href="https://opsgrid.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://opsventures.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="opsventures.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsGrid');
    expect(results[0].content).toBe('US startup helping finance, customer, and product teams coordinate internal delivery and systems | Operator-led workflow software for B2B execution teams');
    expect(results[0].company_name).toBe('OpsGrid');
    expect(results[0].company_website).toBe('https://opsgrid.io/');
    expect(results[0].url).toBe('https://opsventures.vc/portfolio/opsgrid');
  });

  test('HtmlListAdapter extracts Operators Guild-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/guildops">View</a>
              <div class="company-name">GuildOps</div>
              <div class="description">Operator-led workflow software for revenue and delivery teams</div>
              <div class="subtext">US startup helping product, finance, and customer teams coordinate internal systems and execution</div>
              <div class="company-site"><a href="https://guildops.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operatorsguild.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operatorsguild.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'guild' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('GuildOps');
    expect(results[0].content).toBe('US startup helping product, finance, and customer teams coordinate internal systems and execution | Operator-led workflow software for revenue and delivery teams');
    expect(results[0].company_name).toBe('GuildOps');
    expect(results[0].company_website).toBe('https://guildops.io/');
    expect(results[0].url).toBe('https://operatorsguild.vc/portfolio/guildops');
  });

  test('HtmlListAdapter extracts Executor Guild-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/execraft">View</a>
              <div class="company-name">Execraft</div>
              <div class="description">Operator-led execution software for B2B teams</div>
              <div class="subtext">US startup helping finance, customer, and product teams coordinate systems and delivery</div>
              <div class="company-site"><a href="https://execraft.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://executorguild.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="executorguild.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'exec' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Execraft');
    expect(results[0].content).toBe('US startup helping finance, customer, and product teams coordinate systems and delivery | Operator-led execution software for B2B teams');
    expect(results[0].company_name).toBe('Execraft');
    expect(results[0].company_website).toBe('https://execraft.io/');
    expect(results[0].url).toBe('https://executorguild.vc/portfolio/execraft');
  });

  test('HtmlListAdapter extracts Operator Mesh-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/meshops">View</a>
              <div class="company-name">MeshOps</div>
              <div class="description">Operator-led execution software for internal systems teams</div>
              <div class="subtext">US startup helping finance, product, and customer teams coordinate delivery and process execution</div>
              <div class="company-site"><a href="https://meshops.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operatormesh.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operatormesh.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'mesh' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('MeshOps');
    expect(results[0].content).toBe('US startup helping finance, product, and customer teams coordinate delivery and process execution | Operator-led execution software for internal systems teams');
    expect(results[0].company_name).toBe('MeshOps');
    expect(results[0].company_website).toBe('https://meshops.io/');
    expect(results[0].url).toBe('https://operatormesh.vc/portfolio/meshops');
  });

  test('HtmlListAdapter extracts Operator Pattern-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/patternops">View</a>
              <div class="company-name">PatternOps</div>
              <div class="description">Operator-first execution software for GTM and internal systems teams</div>
              <div class="subtext">US startup helping product, finance, and revenue teams coordinate workflows and process execution</div>
              <div class="company-site"><a href="https://patternops.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operatorpattern.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operatorpattern.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'pattern' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('PatternOps');
    expect(results[0].content).toBe('US startup helping product, finance, and revenue teams coordinate workflows and process execution | Operator-first execution software for GTM and internal systems teams');
    expect(results[0].company_name).toBe('PatternOps');
    expect(results[0].company_website).toBe('https://patternops.io/');
    expect(results[0].url).toBe('https://operatorpattern.vc/portfolio/patternops');
  });

  test('HtmlListAdapter extracts Ops Foundry-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/foundryops">View</a>
              <div class="company-name">FoundryOps</div>
              <div class="description">Operator-led execution tooling for internal systems teams</div>
              <div class="subtext">US startup helping finance, revenue, and product teams coordinate workflows and delivery</div>
              <div class="company-site"><a href="https://foundryops.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://opsfoundry.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="opsfoundry.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'foundry' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('FoundryOps');
    expect(results[0].content).toBe('US startup helping finance, revenue, and product teams coordinate workflows and delivery | Operator-led execution tooling for internal systems teams');
    expect(results[0].company_name).toBe('FoundryOps');
    expect(results[0].company_website).toBe('https://foundryops.io/');
    expect(results[0].url).toBe('https://opsfoundry.vc/portfolio/foundryops');
  });

  test('HtmlListAdapter extracts Ops Engine-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/engineops">View</a>
              <div class="company-name">EngineOps</div>
              <div class="description">Operator-led internal systems tooling for execution-heavy teams</div>
              <div class="subtext">US startup helping finance, product, and revenue teams coordinate delivery, workflows, and execution</div>
              <div class="company-site"><a href="https://engineops.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://opsengine.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="opsengine.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'engine' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('EngineOps');
    expect(results[0].content).toBe('US startup helping finance, product, and revenue teams coordinate delivery, workflows, and execution | Operator-led internal systems tooling for execution-heavy teams');
    expect(results[0].company_name).toBe('EngineOps');
    expect(results[0].company_website).toBe('https://engineops.io/');
    expect(results[0].url).toBe('https://opsengine.vc/portfolio/engineops');
  });

  test('HtmlListAdapter extracts Ops Works-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/workops">View</a>
              <div class="company-name">WorkOps</div>
              <div class="description">Operator-led workflow tooling for execution-heavy internal teams</div>
              <div class="subtext">US startup helping finance, product, and customer teams coordinate systems, process, and delivery</div>
              <div class="company-site"><a href="https://workops.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://opsworks.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="opsworks.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'work' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('WorkOps');
    expect(results[0].content).toBe('US startup helping finance, product, and customer teams coordinate systems, process, and delivery | Operator-led workflow tooling for execution-heavy internal teams');
    expect(results[0].company_name).toBe('WorkOps');
    expect(results[0].company_website).toBe('https://workops.io/');
    expect(results[0].url).toBe('https://opsworks.vc/portfolio/workops');
  });

  test('HtmlListAdapter extracts Ops Track-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/opstracker">View</a>
              <div class="company-name">OpsTracker</div>
              <div class="description">Operational workflow software for finance and GTM teams.</div>
              <div class="subtext">US startup helping teams manage execution across systems and approvals.</div>
              <div class="company-site"><a href="https://opstracker.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://opstrack.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="opstrack.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsTracker');
    expect(results[0].content).toBe('US startup helping teams manage execution across systems and approvals. | Operational workflow software for finance and GTM teams.');
    expect(results[0].company_name).toBe('OpsTracker');
    expect(results[0].company_website).toBe('https://opstracker.io/');
    expect(results[0].url).toBe('https://opstrack.vc/portfolio/opstracker');
  });

  test('HtmlListAdapter extracts Ops Loop-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/opslooper">View</a>
              <div class="company-name">OpsLooper</div>
              <div class="description">Execution workflow software for operator-led teams.</div>
              <div class="subtext">US startup helping finance, revenue, and customer teams run repeatable processes.</div>
              <div class="company-site"><a href="https://opslooper.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://opsloop.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="opsloop.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsLooper');
    expect(results[0].content).toBe('US startup helping finance, revenue, and customer teams run repeatable processes. | Execution workflow software for operator-led teams.');
    expect(results[0].company_name).toBe('OpsLooper');
    expect(results[0].company_website).toBe('https://opslooper.io/');
    expect(results[0].url).toBe('https://opsloop.vc/portfolio/opslooper');
  });

  test('HtmlListAdapter extracts Ops Mesh-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/opsmeshpro">View</a>
              <div class="company-name">OpsMesh Pro</div>
              <div class="description">Operator tooling for multi-team workflow execution.</div>
              <div class="subtext">US startup helping finance, support, and GTM teams coordinate approvals and delivery.</div>
              <div class="company-site"><a href="https://opsmeshpro.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://opsmesh.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="opsmesh.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsMesh Pro');
    expect(results[0].content).toBe('US startup helping finance, support, and GTM teams coordinate approvals and delivery. | Operator tooling for multi-team workflow execution.');
    expect(results[0].company_name).toBe('OpsMesh Pro');
    expect(results[0].company_website).toBe('https://opsmeshpro.io/');
    expect(results[0].url).toBe('https://opsmesh.vc/portfolio/opsmeshpro');
  });

  test('HtmlListAdapter extracts Ops Grid-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/opsgridhq">View</a>
              <div class="company-name">OpsGrid HQ</div>
              <div class="description">Workflow control software for operations-heavy teams.</div>
              <div class="subtext">US startup helping finance, legal, and GTM teams coordinate reviews, approvals, and launches.</div>
              <div class="company-site"><a href="https://opsgridhq.com/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://opsgrid.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="opsgrid.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsGrid HQ');
    expect(results[0].content).toBe('US startup helping finance, legal, and GTM teams coordinate reviews, approvals, and launches. | Workflow control software for operations-heavy teams.');
    expect(results[0].company_name).toBe('OpsGrid HQ');
    expect(results[0].company_website).toBe('https://opsgridhq.com/');
    expect(results[0].url).toBe('https://opsgrid.vc/portfolio/opsgridhq');
  });

  test('HtmlListAdapter extracts Operating Systems-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/opscontrol">View</a>
              <div class="company-name">OpsControl</div>
              <div class="description">Operator-led workflow infrastructure for execution-heavy teams.</div>
              <div class="subtext">US startup helping finance, support, and GTM teams manage approvals, handoffs, and launch coordination.</div>
              <div class="company-site"><a href="https://opscontrol.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operatingsystems.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operatingsystems.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsControl');
    expect(results[0].content).toBe('US startup helping finance, support, and GTM teams manage approvals, handoffs, and launch coordination. | Operator-led workflow infrastructure for execution-heavy teams.');
    expect(results[0].company_name).toBe('OpsControl');
    expect(results[0].company_website).toBe('https://opscontrol.io/');
    expect(results[0].url).toBe('https://operatingsystems.vc/portfolio/opscontrol');
  });

  test('HtmlListAdapter extracts Operator Systems-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/opsnavigator">View</a>
              <div class="company-name">OpsNavigator</div>
              <div class="description">Operator software for workflow orchestration and execution governance.</div>
              <div class="subtext">US startup helping finance, support, and GTM teams coordinate launches, approvals, and cross-functional handoffs.</div>
              <div class="company-site"><a href="https://opsnavigator.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operatorsystems.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operatorsystems.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsNavigator');
    expect(results[0].content).toBe('US startup helping finance, support, and GTM teams coordinate launches, approvals, and cross-functional handoffs. | Operator software for workflow orchestration and execution governance.');
    expect(results[0].company_name).toBe('OpsNavigator');
    expect(results[0].company_website).toBe('https://opsnavigator.io/');
    expect(results[0].url).toBe('https://operatorsystems.vc/portfolio/opsnavigator');
  });

  test('HtmlListAdapter extracts Operator Stack-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/opsstacker">View</a>
              <div class="company-name">OpsStacker</div>
              <div class="description">Operator workflow software for systemized execution across launches, approvals, and internal handoffs.</div>
              <div class="subtext">US startup helping finance, support, and GTM teams coordinate approvals, launches, and process controls.</div>
              <div class="company-site"><a href="https://opsstacker.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operatorstack.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operatorstack.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('OpsStacker');
    expect(results[0].content).toBe('US startup helping finance, support, and GTM teams coordinate approvals, launches, and process controls. | Operator workflow software for systemized execution across launches, approvals, and internal handoffs.');
    expect(results[0].company_name).toBe('OpsStacker');
    expect(results[0].company_website).toBe('https://opsstacker.io/');
    expect(results[0].url).toBe('https://operatorstack.vc/portfolio/opsstacker');
  });

  test('HtmlListAdapter extracts Operator Fabric-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/fabricops">View</a>
              <div class="company-name">FabricOps</div>
              <div class="description">Operator tooling for automation infrastructure and repeatable execution across internal workflows.</div>
              <div class="subtext">US startup helping finance, support, and GTM teams systemize approvals, launches, and process handoffs.</div>
              <div class="company-site"><a href="https://fabricops.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operatorfabric.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operatorfabric.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('FabricOps');
    expect(results[0].content).toBe('US startup helping finance, support, and GTM teams systemize approvals, launches, and process handoffs. | Operator tooling for automation infrastructure and repeatable execution across internal workflows.');
    expect(results[0].company_name).toBe('FabricOps');
    expect(results[0].company_website).toBe('https://fabricops.io/');
    expect(results[0].url).toBe('https://operatorfabric.vc/portfolio/fabricops');
  });

  test('HtmlListAdapter extracts Operator Router-style portfolio entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <html>
          <body>
            <div class="portfolio-item">
              <a class="internal-link" href="/portfolio/routerops">View</a>
              <div class="company-name">RouterOps</div>
              <div class="description">Workflow routing software for systemized execution across approvals, launches, and internal handoffs.</div>
              <div class="subtext">US startup helping finance, support, and GTM teams coordinate routing, approvals, and process execution.</div>
              <div class="company-site"><a href="https://routerops.io/">Website</a></div>
            </div>
            <div class="footer-cta">
              <a href="/portfolio/footer-link">Ignore</a>
            </div>
          </body>
        </html>
      `,
    });

    const adapter = new HtmlListAdapter({
      method: {
        url: 'https://operatorrouter.vc/portfolio',
        extract: {
          itemSelector: ['.portfolio-item', '.portfolio-card'],
          linkSelector: ['a[href*="/portfolio/"]', 'a[href]'],
          titleSelector: ['.company-name', 'h2'],
          contentSelector: ['.subtext', '.description'],
          mergeContentSelectors: true,
          contentJoinWith: ' | ',
          companyNameSelector: ['.company-name', 'h2'],
          companyWebsiteSelector: [
            'a[href*="http"]:not([href*="operatorrouter.vc"])',
            '.company-site a[href]',
          ],
          includePatterns: ['/portfolio/'],
          excludeSelectors: ['.footer-cta', '.cta-banner'],
        },
      },
    });

    const results = await adapter.run({ query: 'ops' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('RouterOps');
    expect(results[0].content).toBe('US startup helping finance, support, and GTM teams coordinate routing, approvals, and process execution. | Workflow routing software for systemized execution across approvals, launches, and internal handoffs.');
    expect(results[0].company_name).toBe('RouterOps');
    expect(results[0].company_website).toBe('https://routerops.io/');
    expect(results[0].url).toBe('https://operatorrouter.vc/portfolio/routerops');
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
