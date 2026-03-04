import handler from '../../../src/pages/api/process-content';
import { createMockReq, createMockRes } from './testUtils';

jest.mock('../../../src/pages/api/process-content', () => {
  const actual = jest.requireActual('../../../src/pages/api/process-content');
  return {
    __esModule: true,
    ...actual,
    default: actual.default,
  };
});

describe('/api/process-content route', () => {
  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { results: [] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid request. Query and results array are required.',
    });
  });

  it('returns 400 when results is not an array', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'founders', results: null },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid request. Query and results array are required.',
    });
  });

  it('returns success with processedContent for valid requests', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'founders',
        results: [
          {
            title: 'Acme',
            snippet: 'Acme is building workflow software for operators.',
            url: 'https://example.com/acme',
          },
        ],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('processedContent');
    expect(Array.isArray(res.body.processedContent)).toBe(true);
  });
});
