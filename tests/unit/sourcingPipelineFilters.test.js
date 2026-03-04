const fs = require('fs');
const os = require('os');
const path = require('path');

const { runPipeline } = require('../../src/sourcing/runner');

describe('sourcing pipeline filters', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('runPipeline filters signals missing stage/thesis classification', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-filter-'));
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
          id: 'A-FILTER-TEST',
          name: 'Filter Test Feed',
          region: 'Global',
          category: 'startup_news',
          thesis_tags: [],
          stage_bias: [],
          method: { type: 'rss', url: 'https://example.com/filter.xml' },
          cadence: { tier: 'A', frequency: 'daily' },
          query_strategy: { type: 'feed' },
          requires_auth: false,
          adapter: 'rss',
          notes: 'Filter test source',
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
            <description>General company update with no clear stage</description>
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

    const runReport = JSON.parse(fs.readFileSync(runReportPath, 'utf-8'));

    expect(result.emittedCount).toBe(0);
    expect(result.rollupCount).toBe(0);
    expect(result.categoryExportCount).toBe(0);
    expect(result.crmExportCount).toBe(0);
    expect(runReport.filteredCount).toBe(1);
    expect(result.summaries[0].filteredCount).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
  });
});
