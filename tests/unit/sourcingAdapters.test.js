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
