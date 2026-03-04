import handler from '@/pages/api/search/substack';
import axios from 'axios';

jest.mock('axios');
jest.mock('@/utils/logger', () => ({
  logInfo: jest.fn(),
  logError: jest.fn(),
}));

function createRes() {
  const res = {};
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.setHeader = jest.fn((key, value) => {
    res.headers[key] = value;
    return res;
  });
  res.json = jest.fn((payload) => {
    res.body = payload;
    return res;
  });
  return res;
}

describe('/api/search/substack', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 405 for non-POST', async () => {
    const req = { method: 'GET', body: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.body).toEqual({ message: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = { method: 'POST', body: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toEqual({ message: 'Query is required' });
  });

  it('returns sources on successful Serper response', async () => {
    process.env.SERPER_API_KEY = 'test-key';
    axios.post.mockResolvedValueOnce({
      data: {
        organic: [
          {
            title: 'Post One',
            link: 'https://blog.example.com/post-1',
            snippet: 'First snippet',
          },
          {
            title: 'Post Two',
            link: 'https://blog.example.com/post-2',
            snippet: 'Second snippet',
          },
        ],
      },
    });

    const req = { method: 'POST', body: { query: 'ai infra' } };
    const res = createRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.sources).toEqual([
      {
        title: 'Post One',
        url: 'https://blog.example.com/post-1',
        snippet: 'First snippet',
        source: 'substack',
      },
      {
        title: 'Post Two',
        url: 'https://blog.example.com/post-2',
        snippet: 'Second snippet',
        source: 'substack',
      },
    ]);
  });

  it('returns fail-soft response when Serper key is missing', async () => {
    delete process.env.SERPER_API_KEY;

    const req = { method: 'POST', body: { query: 'ai infra' } };
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.sources).toEqual([]);
    expect(res.body.degradedSources).toContain('substack');
    expect(res.body.error).toBe('Missing SERPER_API_KEY');
  });

  it('returns fail-soft response when upstream request fails', async () => {
    process.env.SERPER_API_KEY = 'test-key';
    axios.post.mockRejectedValueOnce(new Error('upstream unavailable'));

    const req = { method: 'POST', body: { query: 'ai infra' } };
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.sources).toEqual([]);
    expect(res.body.degradedSources).toContain('substack');
    expect(res.body.error).toBe('upstream unavailable');
  });
});
