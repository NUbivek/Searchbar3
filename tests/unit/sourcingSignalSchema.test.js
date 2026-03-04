const { normalizeSignal } = require('../../src/sourcing/normalizer');
const { validateStartupSignal, validateStartupSignals } = require('../../src/sourcing/signalSchema');

describe('startup signal schema', () => {
  function buildValidSignal() {
    return normalizeSignal({
      source: {
        id: 'A-HN-ALGOLIA',
        name: 'Hacker News Algolia',
        region: 'Global',
        thesis_tags: ['ai'],
        stage_bias: ['seed'],
        method: { url: 'https://example.com' },
        cadence: { tier: 'A' },
      },
      item: {
        title: 'Acme AI Inc.',
        url: 'https://example.com/post?utm_source=test',
        content: 'Raised a seed round for AI infrastructure',
        publishedAt: '2026-03-03T00:00:00.000Z',
      },
      query: 'acme ai',
    });
  }

  test('validateStartupSignal accepts normalized signal shape', () => {
    const signal = buildValidSignal();
    const validation = validateStartupSignal(signal);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  test('validateStartupSignal rejects malformed signal payload', () => {
    const signal = buildValidSignal();
    signal.thesis_tags = [];
    signal.confidence = 2;
    signal.published_at = 'not-a-date';
    signal.evidence = 'bad-evidence';

    const validation = validateStartupSignal(signal);

    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'thesis_tags must be a non-empty array',
      'confidence must be a number between 0 and 1',
      'published_at must be a valid ISO date string',
      'evidence must be an object',
    ]));
  });

  test('validateStartupSignals reports per-entry indexing for batch payloads', () => {
    const validSignal = buildValidSignal();
    const invalidSignal = {
      signal_id: 'x',
      company_name: '',
    };

    const validation = validateStartupSignals([validSignal, invalidSignal]);

    expect(validation.valid).toBe(false);
    expect(validation.results).toHaveLength(2);
    expect(validation.results[0].valid).toBe(true);
    expect(validation.results[1].valid).toBe(false);
    expect(validation.errors.some((error) => error.startsWith('[1]'))).toBe(true);
  });
});
