const {
  normalizeSearchResponseV1,
  validateSearchResponseV1,
} = require('../../../src/utils/contracts/searchResponse');

describe('SearchResponseV1 contract', () => {
  test('normalizes partial payload into stable envelope', () => {
    const normalized = normalizeSearchResponseV1({
      status: 'ok',
      results: null,
      degradedSources: ['web', 'web', null],
      synthesis: { enabled: 1 },
    });

    expect(normalized.status).toBe('ok');
    expect(normalized.results).toEqual([]);
    expect(normalized.degradedSources).toEqual(['web']);
    expect(normalized.synthesis).toEqual({
      enabled: true,
      provider: null,
      model: null,
      content: null,
    });
    expect(normalized.llmProcessed).toBe(false);
  });

  test('validates a compliant payload', () => {
    const payload = normalizeSearchResponseV1({
      status: 'fail-soft',
      results: [],
      degradedSources: ['web'],
      synthesis: {
        enabled: false,
        provider: null,
        model: null,
        content: null,
      },
      llmProcessed: false,
    });

    const validation = validateSearchResponseV1(payload);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  test('rejects invalid payload shape', () => {
    const validation = validateSearchResponseV1({
      status: 'error',
      results: {},
      degradedSources: 'web',
      synthesis: null,
      llmProcessed: 'no',
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'status must be one of: ok, degraded, fail-soft',
      'results must be an array',
      'degradedSources must be an array',
      'synthesis must be an object',
      'llmProcessed must be a boolean',
    ]));
  });
});
