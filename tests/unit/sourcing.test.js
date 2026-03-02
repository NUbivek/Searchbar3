const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateRegistry } = require('../../src/sourcing/schema');
const { normalizeSignal } = require('../../src/sourcing/normalizer');
const { runPipeline } = require('../../src/sourcing/runner');

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
      title: 'Acme AI',
      url: 'https://example.com/post?utm_source=test',
      content: 'Raised a round',
      publishedAt: '2026-03-02T00:00:00.000Z',
    };

    const signalA = normalizeSignal({ source, item, query: 'acme' });
    const signalB = normalizeSignal({ source, item, query: 'acme' });

    expect(signalA.signal_id).toBe(signalB.signal_id);
    expect(signalA.company_name).toBe('Acme AI');
    expect(signalA.item_url).toBe('https://example.com/post');
    expect(signalA.stage_guess).toBe('seed');
    expect(signalA.thesis_tags).toEqual(['ai']);
  });

  test('runPipeline writes only net-new signals on repeated runs', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchbar3-sourcing-'));
    const registryPath = path.join(tempDir, 'registry.json');
    const outputPath = path.join(tempDir, 'signals.jsonl');
    const statePath = path.join(tempDir, 'source_state.json');

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
      frequency: 'daily',
      force: true,
    });

    const secondRun = await runPipeline({
      registryPath,
      outputPath,
      statePath,
      frequency: 'daily',
      force: true,
    });

    const writtenLines = fs.readFileSync(outputPath, 'utf-8').trim().split('\n');

    expect(firstRun.emittedCount).toBe(1);
    expect(secondRun.emittedCount).toBe(0);
    expect(writtenLines).toHaveLength(1);
  });
});
