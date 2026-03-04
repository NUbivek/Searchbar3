const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildPlan } = require('../../src/sourcing/planner');
const { computeCoverageStats, validateCoverageTargets } = require('../../src/sourcing/coverage');
const { applyRuntimePreset, loadRegistry } = require('../../src/sourcing/registry');
const { validateRegistry, validateRegistryEntry } = require('../../src/sourcing/schema');
const { normalizeSignal } = require('../../src/sourcing/normalizer');
const {
  getEffectiveDegradedCooldownMs,
  getDegradedCooldownMs,
  getRateLimitMaxRuns,
  getRateLimitWindowMs,
  isRateLimited,
  matchesExecutionMode,
  pruneRecentRunTimestamps,
  runPipeline,
  shouldRunSource,
} = require('../../src/sourcing/runner');

describe('sourcing foundation', () => {
  test('validateRegistry accepts the seeded registry', () => {
    const registryPath = path.join(process.cwd(), 'sources', 'registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    const validation = validateRegistry(registry);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  test('loadRegistry applies runtime policy presets with explicit overrides preserved', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-registry-preset-'));
    const registryPath = path.join(tempDir, 'registry.json');

    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          id: 'A-RSS',
          name: 'RSS Source',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/rss.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Preset test',
        },
        {
          id: 'C-HTML',
          name: 'HTML Source',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'html', url: 'https://example.com' },
          cadence: { tier: 'C', frequency: 'monthly' },
          query_strategy: { type: 'list_page' },
          requires_auth: false,
          adapter: 'html_list',
          runtime: { maxRunsPerWindow: 9 },
          notes: 'Preset override test',
        },
      ], null, 2),
      'utf-8'
    );

    const loaded = loadRegistry(registryPath);
    const explicitPreset = applyRuntimePreset({
      id: 'X',
      method: { type: 'api' },
      cadence: { tier: 'B' },
      runtime: { maxRunsPerWindow: 11 },
    });

    expect(loaded[0].runtime.maxRunsPerWindow).toBe(4);
    expect(loaded[0].runtime.rateLimitWindowHours).toBe(4);
    expect(loaded[0].runtime.cooldownHoursAfterDegraded).toBe(12);
    expect(loaded[1].runtime.maxRunsPerWindow).toBe(9);
    expect(loaded[1].runtime.rateLimitWindowHours).toBe(24);
    expect(loaded[1].runtime.cooldownHoursAfterDegraded).toBe(24);
    expect(explicitPreset.runtime.maxRunsPerWindow).toBe(11);
    expect(explicitPreset.runtime.cooldownHoursAfterDegraded).toBe(8);
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

  test('shouldRunSource enforces degraded cooldown when configured', () => {
    const source = {
      id: 'A-COOLDOWN',
      cadence: { tier: 'A', frequency: 'daily' },
      runtime: {
        cooldownHoursAfterDegraded: 48,
        cooldownBackoffMultiplier: 1.5,
        maxCooldownHours: 168,
      },
    };
    const state = {
      sources: {
        'A-COOLDOWN': {
          last_run_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
          last_status: 'degraded',
          consecutive_degraded_count: 2,
        },
      },
    };

    expect(getDegradedCooldownMs(source)).toBe(48 * 60 * 60 * 1000);
    expect(getEffectiveDegradedCooldownMs(source, state.sources['A-COOLDOWN'])).toBe(
      48 * 60 * 60 * 1000 * 1.5 * 2
    );
    expect(shouldRunSource(source, state, {})).toBe(false);
    expect(shouldRunSource(source, state, { force: true })).toBe(true);
  });

  test('shouldRunSource enforces rolling rate limits when configured', () => {
    const source = {
      id: 'A-RATE-LIMITED',
      cadence: { tier: 'A', frequency: 'daily' },
      runtime: {
        maxRunsPerWindow: 2,
        rateLimitWindowHours: 6,
      },
    };
    const now = Date.now();
    const state = {
      sources: {
        'A-RATE-LIMITED': {
          recent_run_timestamps: [
            new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            new Date(now - 30 * 60 * 1000).toISOString(),
            new Date(now - 10 * 60 * 60 * 1000).toISOString(),
          ],
        },
      },
    };

    expect(getRateLimitMaxRuns(source)).toBe(2);
    expect(getRateLimitWindowMs(source)).toBe(6 * 60 * 60 * 1000);
    expect(pruneRecentRunTimestamps(source, state.sources['A-RATE-LIMITED'], now)).toHaveLength(2);
    expect(isRateLimited(source, state.sources['A-RATE-LIMITED'], now)).toBe(true);
    expect(shouldRunSource(source, state, {})).toBe(false);
    expect(shouldRunSource(source, state, { force: true })).toBe(true);
  });

  test('shouldRunSource feature-flags auth-required sources by default', () => {
    const source = {
      id: 'B-AUTH-ONLY',
      requires_auth: true,
      cadence: { tier: 'B', frequency: 'weekly' },
    };
    const state = { sources: {} };

    expect(shouldRunSource(source, state, {})).toBe(false);
    expect(shouldRunSource(source, state, { includeAuthSources: true })).toBe(true);
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
          id: 'A-COOLDOWN',
          name: 'A Cooldown',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/cooldown.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          runtime: { cooldownHoursAfterDegraded: 48 },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Cooling down source',
        },
        {
          id: 'A-RATE-LIMITED',
          name: 'A Rate Limited',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/limited.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          runtime: {
            maxRunsPerWindow: 2,
            rateLimitWindowHours: 6
          },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Rate limited source',
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
          'A-COOLDOWN': {
            last_run_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
            last_status: 'degraded',
            consecutive_degraded_count: 2,
          },
          'A-RATE-LIMITED': {
            last_run_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            recent_run_timestamps: [
              new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
              new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            ],
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
    expect(plan.groupedDueSoon.A).toHaveLength(1);
    expect(plan.dueSoonSources).toHaveLength(1);
    expect(plan.dueSoonSources[0].id).toBe('A-SOON');
    expect(plan.deferredCount).toBe(4);
    expect(plan.deferredSources.find((entry) => entry.id === 'A-COOLDOWN').reason).toBe('cooldown_after_degraded');
    expect(plan.deferredSources.find((entry) => entry.id === 'A-RATE-LIMITED').reason).toBe('rate_limited');
    expect(plan.deferredSources.find((entry) => entry.id === 'C-DEFERRED').reason).toBe('excluded_by_mode');
    expect(plan.nextDueByTier.A).toBe(plan.dueSoonSources[0].nextDueAt);
    expect(plan.nextDueByTier.C).toBe(plan.deferredSources.find((entry) => entry.id === 'C-DEFERRED').nextDueAt);
    expect(plan.nextDueByFrequency.daily).toBe(plan.dueSoonSources[0].nextDueAt);
    expect(plan.nextDueByFrequency.monthly).toBe(
      plan.deferredSources.find((entry) => entry.id === 'C-DEFERRED').nextDueAt
    );
  });

  test('buildPlan marks auth-required sources as deferred when auth sources are disabled', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-plan-auth-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const statePath = path.join(tempDir, 'source_state.json');

    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          id: 'B-AUTH-SOURCE',
          name: 'Auth Source',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'api', url: 'https://example.com/api' },
          cadence: { tier: 'B', frequency: 'weekly' },
          query_strategy: { type: 'search_api' },
          requires_auth: true,
          adapter: 'api_search',
          notes: 'Auth required source',
        },
      ], null, 2),
      'utf-8'
    );

    fs.writeFileSync(statePath, JSON.stringify({ sources: {}, seen_signal_ids: {} }, null, 2), 'utf-8');

    const plan = buildPlan({ registryPath, statePath });
    const deferred = plan.deferredSources.find((entry) => entry.id === 'B-AUTH-SOURCE');

    expect(plan.dueCount).toBe(0);
    expect(plan.deferredCount).toBe(1);
    expect(deferred.reason).toBe('auth_disabled');
  });

  test('coverage stats enforce source count and RSS/HTML mix targets', () => {
    const registry = [
      {
        id: 'A',
        method: { type: 'rss' },
        cadence: { tier: 'A' },
        adapter: 'rss',
        region: 'Global',
      },
      {
        id: 'B',
        method: { type: 'html' },
        cadence: { tier: 'B' },
        adapter: 'html_list',
        region: 'US',
      },
      {
        id: 'C',
        method: { type: 'api' },
        cadence: { tier: 'C' },
        adapter: 'api_search',
        region: 'EU',
      },
    ];

    const stats = computeCoverageStats(registry);
    expect(stats.totalSources).toBe(3);
    expect(stats.htmlLikeCount).toBe(2);
    expect(stats.htmlLikeRatio).toBeCloseTo(2 / 3);

    const failingValidation = validateCoverageTargets(registry, {
      minimumSourceCount: 4,
      minimumHtmlLikeRatio: 0.7,
    });
    expect(failingValidation.valid).toBe(false);
    expect(failingValidation.errors).toHaveLength(2);

    const passingValidation = validateCoverageTargets(registry, {
      minimumSourceCount: 3,
      minimumHtmlLikeRatio: 0.6,
    });
    expect(passingValidation.valid).toBe(true);
  });

  test('runPipeline writes only net-new signals on repeated runs', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const outputPath = path.join(tempDir, 'signals.jsonl');
    const statePath = path.join(tempDir, 'source_state.json');
    const rollupPath = path.join(tempDir, 'daily_rollup.csv');
    const categoryExportPath = path.join(tempDir, 'category_rollup.csv');
    const crmExportPath = path.join(tempDir, 'crm_export.csv');
    const sourceHealthPath = path.join(tempDir, 'source_health.csv');
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
      categoryExportPath,
      crmExportPath,
      sourceHealthPath,
      runReportPath,
      frequency: 'daily',
      force: true,
    });

    const secondRun = await runPipeline({
      registryPath,
      outputPath,
      statePath,
      rollupPath,
      categoryExportPath,
      crmExportPath,
      sourceHealthPath,
      runReportPath,
      frequency: 'daily',
      force: true,
    });

    const writtenLines = fs.readFileSync(outputPath, 'utf-8').trim().split('\n');
    const rollupLines = fs.readFileSync(rollupPath, 'utf-8').trim().split('\n');
    const categoryLines = fs.readFileSync(categoryExportPath, 'utf-8').trim().split('\n');
    const crmLines = fs.readFileSync(crmExportPath, 'utf-8').trim().split('\n');
    const sourceHealthLines = fs.readFileSync(sourceHealthPath, 'utf-8').trim().split('\n');
    const runReport = JSON.parse(fs.readFileSync(runReportPath, 'utf-8'));

    expect(firstRun.emittedCount).toBe(1);
    expect(firstRun.rollupCount).toBe(1);
    expect(firstRun.categoryExportCount).toBe(1);
    expect(firstRun.crmExportCount).toBe(1);
    expect(firstRun.sourceHealthCount).toBe(1);
    expect(secondRun.emittedCount).toBe(0);
    expect(secondRun.rollupCount).toBe(0);
    expect(secondRun.categoryExportCount).toBe(0);
    expect(secondRun.crmExportCount).toBe(0);
    expect(secondRun.sourceHealthCount).toBe(1);
    expect(writtenLines).toHaveLength(1);
    expect(rollupLines).toHaveLength(1);
    expect(categoryLines).toHaveLength(1);
    expect(crmLines).toHaveLength(1);
    expect(sourceHealthLines).toHaveLength(2);
    expect(runReport.emittedCount).toBe(0);
    expect(runReport.runCount).toBe(1);
    expect(runReport.breakdowns.byStage).toEqual({});
    expect(runReport.sourceHealthCount).toBe(1);
  });

  test('runPipeline dedupes overlapping companies across sources using aliases', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-dedupe-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const outputPath = path.join(tempDir, 'signals.jsonl');
    const statePath = path.join(tempDir, 'source_state.json');
    const rollupPath = path.join(tempDir, 'daily_rollup.csv');
    const categoryExportPath = path.join(tempDir, 'category_rollup.csv');
    const crmExportPath = path.join(tempDir, 'crm_export.csv');
    const sourceHealthPath = path.join(tempDir, 'source_health.csv');
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
      categoryExportPath,
      crmExportPath,
      sourceHealthPath,
      runReportPath,
      force: true,
    });

    const writtenLines = fs.readFileSync(outputPath, 'utf-8').trim().split('\n');
    const categoryLines = fs.readFileSync(categoryExportPath, 'utf-8').trim().split('\n');
    const sourceHealthLines = fs.readFileSync(sourceHealthPath, 'utf-8').trim().split('\n');
    const runReport = JSON.parse(fs.readFileSync(runReportPath, 'utf-8'));

    expect(result.emittedCount).toBe(1);
    expect(result.categoryExportCount).toBe(1);
    expect(result.crmExportCount).toBe(1);
    expect(result.sourceHealthCount).toBe(2);
    expect(result.summaries[1].dedupedCount).toBe(1);
    expect(writtenLines).toHaveLength(1);
    expect(categoryLines).toHaveLength(2);
    expect(sourceHealthLines).toHaveLength(3);
    expect(runReport.dedupedCount).toBe(1);
    expect(runReport.categoryExportCount).toBe(1);
    expect(runReport.sourceHealthCount).toBe(2);
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

  test('runPipeline increments degraded streak on repeated failures', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-degraded-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const statePath = path.join(tempDir, 'source_state.json');
    const outputPath = path.join(tempDir, 'signals.jsonl');
    const rollupPath = path.join(tempDir, 'daily_rollup.csv');
    const categoryExportPath = path.join(tempDir, 'category_rollup.csv');
    const crmExportPath = path.join(tempDir, 'crm_export.csv');
    const sourceHealthPath = path.join(tempDir, 'source_health.csv');
    const runReportPath = path.join(tempDir, 'latest_run_summary.json');

    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          id: 'A-BROKEN',
          name: 'Broken Feed',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/broken.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Broken source',
        },
      ], null, 2),
      'utf-8'
    );

    global.fetch = jest.fn()
      .mockRejectedValueOnce(new Error('network fail'))
      .mockRejectedValueOnce(new Error('still failing'));

    await runPipeline({
      registryPath,
      statePath,
      outputPath,
      rollupPath,
      categoryExportPath,
      crmExportPath,
      sourceHealthPath,
      runReportPath,
      force: true,
    });

    await runPipeline({
      registryPath,
      statePath,
      outputPath,
      rollupPath,
      categoryExportPath,
      crmExportPath,
      sourceHealthPath,
      runReportPath,
      force: true,
    });

    const savedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const sourceHealthLines = fs.readFileSync(sourceHealthPath, 'utf-8').trim().split('\n');

    expect(savedState.sources['A-BROKEN'].consecutive_degraded_count).toBe(2);
    expect(sourceHealthLines).toHaveLength(2);
    expect(sourceHealthLines[1]).toContain('"2"');
  });

  test('runPipeline records recent run timestamps for rate-limit accounting', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-budget-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const statePath = path.join(tempDir, 'source_state.json');
    const outputPath = path.join(tempDir, 'signals.jsonl');
    const rollupPath = path.join(tempDir, 'daily_rollup.csv');
    const categoryExportPath = path.join(tempDir, 'category_rollup.csv');
    const crmExportPath = path.join(tempDir, 'crm_export.csv');
    const sourceHealthPath = path.join(tempDir, 'source_health.csv');
    const runReportPath = path.join(tempDir, 'latest_run_summary.json');

    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          id: 'A-BUDGETED',
          name: 'Budgeted Feed',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/budgeted.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          runtime: { maxRunsPerWindow: 3, rateLimitWindowHours: 6 },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Budgeted source',
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

    await runPipeline({
      registryPath,
      statePath,
      outputPath,
      rollupPath,
      categoryExportPath,
      crmExportPath,
      sourceHealthPath,
      runReportPath,
      force: true,
    });

    await runPipeline({
      registryPath,
      statePath,
      outputPath,
      rollupPath,
      categoryExportPath,
      crmExportPath,
      sourceHealthPath,
      runReportPath,
      force: true,
    });

    const savedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const sourceHealthLines = fs.readFileSync(sourceHealthPath, 'utf-8').trim().split('\n');

    expect(savedState.sources['A-BUDGETED'].recent_run_timestamps).toHaveLength(2);
    expect(sourceHealthLines).toHaveLength(2);
    expect(sourceHealthLines[1]).toContain('"2"');
  });

  test('runPipeline skips auth-required sources without blocking no-auth sources', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-auth-skip-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const outputPath = path.join(tempDir, 'signals.jsonl');
    const statePath = path.join(tempDir, 'source_state.json');
    const rollupPath = path.join(tempDir, 'daily_rollup.csv');
    const categoryExportPath = path.join(tempDir, 'category_rollup.csv');
    const crmExportPath = path.join(tempDir, 'crm_export.csv');
    const sourceHealthPath = path.join(tempDir, 'source_health.csv');
    const runReportPath = path.join(tempDir, 'latest_run_summary.json');
    const originalFetch = global.fetch;
    let fetchMock;

    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        {
          id: 'A-NOAUTH',
          name: 'No Auth Feed',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/noauth.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'No auth source',
        },
        {
          id: 'B-AUTH',
          name: 'Auth Feed',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: ['software'],
          stage_bias: ['seed'],
          method: { type: 'rss', url: 'https://example.com/auth.xml' },
          cadence: { tier: 'B', frequency: 'weekly' },
          query_strategy: { type: 'feed' },
          requires_auth: true,
          adapter: 'rss',
          notes: 'Auth source',
        },
      ], null, 2),
      'utf-8'
    );

    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <rss><channel>
          <item>
            <title>No Auth Startup</title>
            <link>https://example.com/noauth-startup</link>
            <description>Seed startup profile</description>
            <pubDate>2026-03-02T00:00:00.000Z</pubDate>
          </item>
        </channel></rss>
      `,
    });
    global.fetch = fetchMock;

    const result = await runPipeline({
      registryPath,
      outputPath,
      statePath,
      rollupPath,
      categoryExportPath,
      crmExportPath,
      sourceHealthPath,
      runReportPath,
    });

    global.fetch = originalFetch;

    expect(result.runCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.emittedCount).toBe(1);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].sourceId).toBe('A-NOAUTH');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(outputPath)).toBe(true);
  });
});
