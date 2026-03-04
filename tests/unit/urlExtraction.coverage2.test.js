const { fetchUrlContent, buildUrlSearchResult } = require('../../src/utils/urlExtraction');

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');

describe('urlExtraction coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns unsupported content type errors', async () => {
    axios.get.mockResolvedValue({
      data: 'binary-data',
      headers: {
        'content-type': 'application/pdf',
      },
    });

    const result = await fetchUrlContent('https://example.com/file.pdf');

    expect(result.status).toBe('error');
    expect(result.error).toContain('Unsupported content type');
  });

  test('returns empty status when html has no extractable body text', async () => {
    axios.get.mockResolvedValue({
      data: '<html><head><title>Only Scripts</title></head><body><script>var x=1;</script></body></html>',
      headers: {
        'content-type': 'text/html',
      },
    });

    const result = await fetchUrlContent('https://example.com/empty');

    expect(result.status).toBe('empty');
    expect(result.content).toBe('');
    expect(result.title).toBe('Only Scripts');
  });

  test('returns error payload when request throws', async () => {
    axios.get.mockRejectedValue(new Error('timeout'));

    const result = await fetchUrlContent('https://example.com/slow');

    expect(result.status).toBe('error');
    expect(result.error).toBe('timeout');
  });

  test('applies timeout/size/text limit options for guarded extraction', async () => {
    axios.get.mockResolvedValue({
      data: '<html><head><title>T</title></head><body><p>abcdefghijklmnopqrstuvwxyz</p></body></html>',
      headers: {
        'content-type': 'text/html',
      },
    });

    const result = await fetchUrlContent('https://example.com/guarded', {
      timeoutMs: 1234,
      maxBytes: 4321,
      textLimit: 5,
    });

    expect(axios.get).toHaveBeenCalledWith(
      'https://example.com/guarded',
      expect.objectContaining({
        timeout: 1234,
        maxContentLength: 4321,
        maxBodyLength: 4321,
      })
    );
    expect(result.status).toBe('ok');
    expect(result.content).toBe('abcde');
  });

  test('buildUrlSearchResult returns null on degraded payloads', () => {
    expect(buildUrlSearchResult({ status: 'error', content: 'x' })).toBeNull();
    expect(buildUrlSearchResult({ status: 'ok', content: '' })).toBeNull();
  });
});
