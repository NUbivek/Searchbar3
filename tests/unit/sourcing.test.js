const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildPlan } = require('../../src/sourcing/planner');
const { validateRegistry, validateRegistryEntry } = require('../../src/sourcing/schema');
const { normalizeSignal } = require('../../src/sourcing/normalizer');
const { matchesExecutionMode, runPipeline, shouldRunSource } = require('../../src/sourcing/runner');

describe('sourcing foundation', () => {
  test('validateRegistry accepts the seeded registry', () => {
    const registryPath = path.join(process.cwd(), 'sources', 'registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    const validation = validateRegistry(registry);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  test('normalizeSignal produces a deterministic signal id and required fields', () => {
    const source = {
      id: 'A-HN-ALGOLIA',
      name: 'Hacker News Algolia',
      region: 'Global',
      thesis_tags: ['ai'],
      stage_bias: ['seed'],
      method: { url: 'https://example.com' },
    };
    const item = {
      title: 'Acme AI Inc.',
      url: 'https://example.com/post?utm_source=test',
      content: 'Raised a $12M Series A round led by Accel and backed by Lightspeed, and is now hiring with 12 open roles',
      company_website: 'https://acme.ai',
      confidence: 0.8,
      publishedAt: '2026-03-02T00:00:00.000Z',
    };

    const signalA = normalizeSignal({ source, item, query: 'acme' });
    const signalB = normalizeSignal({ source, item, query: 'acme' });

    expect(signalA.signal_id).toBe(signalB.signal_id);
    expect(signalA.company_name).toBe('Acme AI');
    expect(signalA.item_url).toBe('https://example.com/post');
    expect(signalA.stage_guess).toBe('series_a');
    expect(signalA.thesis_tags).toEqual(expect.arrayContaining(['ai']));
    expect(signalA.confidence).toBeGreaterThan(0.7);
    expect(signalA.score_components.website_present).toBe(true);
    expect(signalA.enrichment.company_root_domain).toBe('acme.ai');
    expect(signalA.enrichment.has_distinct_company_website).toBe(true);
    expect(signalA.enrichment.funding_signal).toBe('present');
    expect(signalA.enrichment.funding_round_guess).toBe('series_a');
    expect(signalA.enrichment.funding_amount_guess).toBe(12000000);
    expect(signalA.enrichment.funding_currency_guess).toBe('USD');
    expect(signalA.enrichment.investor_signal).toBe('present');
    expect(signalA.enrichment.lead_investor_guess).toBe('Accel');
    expect(signalA.enrichment.investor_list_guess).toEqual(expect.arrayContaining(['Accel']));
    expect(signalA.enrichment.hiring_signal).toBe('strong');
    expect(signalA.enrichment.open_roles_guess).toBe(12);
  });

  test('normalizeSignal infers thesis tags from content and query', () => {
    const signal = normalizeSignal({
      source: {
        id: 'A-TEST',
        name: 'Test',
        region: 'Global',
        thesis_tags: ['software'],
        stage_bias: ['seed'],
        method: { url: 'https://example.com' },
        cadence: { tier: 'A' },
      },
      item: {
        title: 'Freight API startup',
        content: 'AI workflow for supply chain payments with a 40 person team and €3M seed financing raised from Point Nine and Creandum',
        url: 'https://example.com/freight-api',
      },
      query: 'logistics fintech',
    });

    expect(signal.thesis_tags).toEqual(expect.arrayContaining([
      'software',
      'ai',
      'developer_tools',
      'logistics',
      'fintech',
    ]));
    expect(signal.enrichment.item_root_domain).toBe('example.com');
    expect(signal.enrichment.employee_count_guess).toBe(40);
    expect(signal.enrichment.funding_amount_guess).toBe(3000000);
    expect(signal.enrichment.funding_currency_guess).toBe('EUR');
    expect(signal.enrichment.investor_signal).toBe('present');
    expect(signal.enrichment.investor_list_guess).toEqual(expect.arrayContaining(['Point Nine', 'Creandum']));
  });

  test('validateRegistryEntry accepts generic adapter templates', () => {
    const baseEntry = {
      id: 'C-TEST-API',
      name: 'Test API',
      region: 'Global',
      category: 'startup_news',
      thesis_tags: ['software'],
      stage_bias: ['seed'],
      method: {
        type: 'api',
        url: 'https://example.com/items?q={{query}}',
      },
      cadence: {
        tier: 'C',
        frequency: 'monthly',
      },
      query_strategy: {
        type: 'search_api',
      },
      requires_auth: false,
      notes: 'Test entry',
    };

    const searchEntry = validateRegistryEntry({
      ...baseEntry,
      adapter: 'search_api',
      method: {
        ...baseEntry.method,
        extract: {
          titlePath: 'data.title',
        },
      },
    });

    const apiEntry = validateRegistryEntry({
      ...baseEntry,
      adapter: 'api_search',
    });

    const jsEntry = validateRegistryEntry({
      ...baseEntry,
      method: {
        type: 'js',
        url: 'https://example.com/list',
      },
      adapter: 'js_rendered',
    });

    expect(searchEntry.valid).toBe(true);
    expect(apiEntry.valid).toBe(true);
    expect(jsEntry.valid).toBe(true);
  });

  test('execution modes select the expected tiers and frequencies', () => {
    expect(matchesExecutionMode({
      cadence: { tier: 'A', frequency: 'daily' },
    }, 'daily')).toBe(true);

    expect(matchesExecutionMode({
      cadence: { tier: 'B', frequency: 'weekly' },
    }, 'daily')).toBe(false);

    expect(matchesExecutionMode({
      cadence: { tier: 'B', frequency: 'weekly' },
    }, 'weekly')).toBe(true);

    expect(matchesExecutionMode({
      cadence: { tier: 'C', frequency: 'monthly' },
    }, 'weekly')).toBe(false);

    expect(matchesExecutionMode({
      cadence: { tier: 'C', frequency: 'monthly' },
    }, 'monthly')).toBe(true);
  });

  test('shouldRunSource respects cadence mode filters before state age checks', () => {
    const state = { sources: {} };

    expect(shouldRunSource({
      cadence: { tier: 'A', frequency: 'daily' },
    }, state, { executionMode: 'daily' })).toBe(true);

    expect(shouldRunSource({
      cadence: { tier: 'C', frequency: 'monthly' },
    }, state, { executionMode: 'weekly' })).toBe(false);
  });

  test('buildPlan groups due sources and explains deferred ones', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-plan-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const statePath = path.join(tempDir, 'source_state.json');

    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          id: 'A-DUE',
          name: 'A Due',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/a.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Due source',
        },
        {
          id: 'A-SOON',
          name: 'A Soon',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/soon.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Soon source',
        },
        {
          id: 'C-DEFERRED',
          name: 'C Deferred',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/c.xml' },
          cadence: { tier: 'C', frequency: 'monthly' },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Deferred source',
        },
      ], null, 2),
      'utf-8'
    );

    fs.writeFileSync(
      statePath,
      JSON.stringify({
        sources: {
          'A-SOON': {
            last_run_at: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
          },
          'C-DEFERRED': {
            last_run_at: new Date().toISOString(),
          },
        },
      }, null, 2),
      'utf-8'
    );

    const plan = buildPlan({
      registryPath,
      statePath,
      executionMode: 'daily',
      withinHours: 24,
    });

    expect(plan.dueCount).toBe(1);
    expect(plan.dueSoonCount).toBe(1);
    expect(plan.groupedDue.A).toHaveLength(1);
    expect(plan.dueSoonSources).toHaveLength(1);
    expect(plan.dueSoonSources[0].id).toBe('A-SOON');
    expect(plan.deferredCount).toBe(2);
    expect(plan.deferredSources.find((entry) => entry.id === 'C-DEFERRED').reason).toBe('excluded_by_mode');
  });

  test('runPipeline writes only net-new signals on repeated runs', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const outputPath = path.join(tempDir, 'signals.jsonl');
    const statePath = path.join(tempDir, 'source_state.json');
    const rollupPath = path.join(tempDir, 'daily_rollup.csv');
    const crmExportPath = path.join(tempDir, 'crm_export.csv');
    const runReportPath = path.join(tempDir, 'latest_run_summary.json');

    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          id: 'A-TEST-FEED',
          name: 'Test Feed',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: {
            type: 'rss',
            url: 'https://example.com/feed.xml',
          },
          cadence: {
            tier: 'A',
            frequency: 'daily',
          },
          query_strategy: {
            type: 'feed',
          },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Fixture source',
        },
      ], null, 2),
      'utf-8'
    );

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <rss><channel>
          <item>
            <title>Acme</title>
            <link>https://example.com/acme</link>
            <description>Seed startup</description>
            <pubDate>2026-03-02T00:00:00.000Z</pubDate>
          </item>
        </channel></rss>
      `,
    });

    const firstRun = await runPipeline({
      registryPath,
      outputPath,
      statePath,
      rollupPath,
      crmExportPath,
      runReportPath,
      frequency: 'daily',
      force: true,
    });

    const secondRun = await runPipeline({
      registryPath,
      outputPath,
      statePath,
      rollupPath,
      crmExportPath,
      runReportPath,
      frequency: 'daily',
      force: true,
    });

    const writtenLines = fs.readFileSync(outputPath, 'utf-8').trim().split('\n');
    const rollupLines = fs.readFileSync(rollupPath, 'utf-8').trim().split('\n');
    const crmLines = fs.readFileSync(crmExportPath, 'utf-8').trim().split('\n');
    const runReport = JSON.parse(fs.readFileSync(runReportPath, 'utf-8'));

    expect(firstRun.emittedCount).toBe(1);
    expect(firstRun.rollupCount).toBe(1);
    expect(firstRun.crmExportCount).toBe(1);
    expect(secondRun.emittedCount).toBe(0);
    expect(secondRun.rollupCount).toBe(0);
    expect(secondRun.crmExportCount).toBe(0);
    expect(writtenLines).toHaveLength(1);
    expect(rollupLines).toHaveLength(1);
    expect(crmLines).toHaveLength(1);
    expect(runReport.emittedCount).toBe(0);
    expect(runReport.runCount).toBe(1);
    expect(runReport.breakdowns.byStage).toEqual({});
  });

  test('runPipeline dedupes overlapping companies across sources using aliases', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-dedupe-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const outputPath = path.join(tempDir, 'signals.jsonl');
    const statePath = path.join(tempDir, 'source_state.json');
    const rollupPath = path.join(tempDir, 'daily_rollup.csv');
    const crmExportPath = path.join(tempDir, 'crm_export.csv');
    const runReportPath = path.join(tempDir, 'latest_run_summary.json');

    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          id: 'A-FEED-ONE',
          name: 'Feed One',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/feed-one.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Fixture one'
        },
        {
          id: 'A-FEED-TWO',
          name: 'Feed Two',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/feed-two.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Fixture two'
        }
      ], null, 2),
      'utf-8'
    );

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `
          <rss><channel>
            <item>
              <title>Acme AI Inc.</title>
              <link>https://news.example.com/acme</link>
              <description>Seed startup profile</description>
              <pubDate>2026-03-02T00:00:00.000Z</pubDate>
            </item>
          </channel></rss>
        `,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `
          <rss><channel>
            <item>
              <title>Acme AI</title>
              <link>https://another.example.com/acme</link>
              <description>Another profile of the same startup</description>
              <pubDate>2026-03-02T00:00:00.000Z</pubDate>
            </item>
          </channel></rss>
        `,
      });

    const result = await runPipeline({
      registryPath,
      outputPath,
      statePath,
      rollupPath,
      crmExportPath,
      runReportPath,
      force: true,
    });

    const writtenLines = fs.readFileSync(outputPath, 'utf-8').trim().split('\n');
    const runReport = JSON.parse(fs.readFileSync(runReportPath, 'utf-8'));

    expect(result.emittedCount).toBe(1);
    expect(result.crmExportCount).toBe(1);
    expect(result.summaries[1].dedupedCount).toBe(1);
    expect(writtenLines).toHaveLength(1);
    expect(runReport.dedupedCount).toBe(1);
    expect(runReport.tierHealth.A.ok).toBe(2);
    expect(runReport.tierHealth.A.degraded).toBe(0);
    expect(runReport.tierHealth.A.emittedCount).toBe(1);
    expect(runReport.tierHealth.A.dedupedCount).toBe(1);
    expect(runReport.breakdowns.byStage.seed).toBe(1);
    expect(runReport.breakdowns.byCategory.startup_news).toBe(1);
    expect(runReport.breakdowns.hiringSignals.none).toBe(1);
    expect(runReport.breakdowns.topThesisTags[0].key).toBe('ai');
    expect(runReport.breakdowns.topSources[0].key).toBe('Feed One');
  });
});
