jest.mock('../../src/utils/urlExtraction', () => ({
  fetchUrlContent: jest.fn(),
  buildUrlSearchResult: jest.fn((payload) => {
    if (!payload || payload.status === 'error' || !payload.content) {
      return null;
    }

    return {
      title: payload.title || payload.url,
      content: payload.content,
      url: payload.url,
      source: 'custom',
      type: 'custom_url',
      relevance: 0.8,
    };
  }),
}));

const { fetchUrlContent } = require('../../src/utils/urlExtraction');
const { sourceHandlers } = require('../../src/utils/sourceIntegration');

describe('sourceIntegration custom URL handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns only successful extracted custom URL results', async () => {
    fetchUrlContent
      .mockResolvedValueOnce({
        status: 'ok',
        url: 'https://example.com/a',
        title: 'A',
        content: 'Alpha signal',
      })
      .mockResolvedValueOnce({
        status: 'error',
        url: 'https://example.com/b',
        title: null,
        content: '',
        error: 'Unsupported content type',
      });

    const results = await sourceHandlers.custom('seed startup', [
      'https://example.com/a',
      'https://example.com/b',
    ]);

    expect(fetchUrlContent).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: 'A',
      content: 'Alpha signal',
      url: 'https://example.com/a',
      source: 'custom',
      type: 'custom_url',
      relevance: 0.8,
    });
  });

  test('returns empty array when no custom URLs are provided', async () => {
    const results = await sourceHandlers.custom('query', []);

    expect(results).toEqual([]);
    expect(fetchUrlContent).not.toHaveBeenCalled();
  });
});
