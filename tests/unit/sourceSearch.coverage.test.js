jest.mock('../../src/utils/cache', () => ({
  searchCache: {
    generateKey: jest.fn(() => 'cache-key'),
    getOrSet: jest.fn(async (_key, _source, fn) => fn()),
  },
}));

jest.mock('../../src/utils/rateLimiter', () => ({
  rateLimiter: {
    checkLimit: jest.fn(async () => {}),
  },
}));

jest.mock('../../src/utils/errorHandling', () => ({
  withRetry: jest.fn(async (fn) => fn()),
}));

jest.mock('../../src/utils/deepWebSearch', () => ({
  deepWebSearch: jest.fn(),
}));

jest.mock('../../src/utils/webScraper', () => ({
  scrapeSource: jest.fn(),
}));

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const { deepWebSearch } = require('../../src/utils/deepWebSearch');
const { scrapeSource } = require('../../src/utils/webScraper');
const { searchSources } = require('../../src/utils/sourceSearch');

describe('sourceSearch utility coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses Promise.allSettled semantics for open-mode source failures', async () => {
    axios.get.mockResolvedValueOnce({
      data: [{ text: 'x post', id: '1', author: 'a', created_at: '2026-01-01' }],
    });
    deepWebSearch.mockRejectedValueOnce(new Error('web down'));
    scrapeSource.mockResolvedValueOnce([{ title: 'fallback source', content: 'ok' }]);

    const results = await searchSources('query', {
      mode: 'open',
      selectedSources: ['X', 'Web', 'Crunchbase'],
      customUrls: [],
      uploadedFiles: [],
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((item) => item.type === 'twitter')).toBe(true);
    expect(results.some((item) => item.title === 'fallback source')).toBe(true);
  });

  test('adds normalized custom URL and uploaded file results in verified mode', async () => {
    const results = await searchSources('founder signal', {
      mode: 'verified',
      selectedSources: [],
      customUrls: ['https://example.com/company'],
      uploadedFiles: [{ name: 'memo.txt', content: 'traction doubled' }],
    });

    expect(results.some((item) => item.type === 'custom_url')).toBe(true);
    expect(results.some((item) => item.type === 'uploaded_file')).toBe(true);
    expect(results.find((item) => item.type === 'uploaded_file').content).toContain('traction doubled');
  });
});
