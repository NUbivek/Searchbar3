const { fetchUrlContent, buildUrlSearchResult } = require('../../src/utils/urlExtraction');

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');

describe('urlExtraction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns error payload for invalid URLs', async () => {
    const result = await fetchUrlContent('notaurl');

    expect(result.status).toBe('error');
    expect(result.error).toBe('Invalid URL');
  });

  test('extracts title, description, and text from HTML', async () => {
    axios.get.mockResolvedValue({
      data: '<html><head><title>Example</title><meta name="description" content="Desc"></head><body><h1>Hello</h1><p>World</p></body></html>',
      headers: {
        'content-type': 'text/html',
      },
    });

    const result = await fetchUrlContent('https://example.com');

    expect(result.status).toBe('ok');
    expect(result.title).toBe('Example');
    expect(result.description).toBe('Desc');
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('World');
  });

  test('builds a search result from extracted payload', () => {
    const searchResult = buildUrlSearchResult({
      url: 'https://example.com',
      status: 'ok',
      title: 'Example',
      description: 'Desc',
      content: 'Body copy',
    });

    expect(searchResult).toEqual(expect.objectContaining({
      title: 'Example',
      source: 'custom',
      type: 'custom_url',
      content: 'Body copy',
    }));
  });
});
