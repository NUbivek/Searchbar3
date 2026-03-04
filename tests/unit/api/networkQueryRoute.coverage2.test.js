let mockCreate;

jest.mock('together', () => ({
  TogetherAI: jest.fn(() => ({
    chat: {
      completions: {
        create: (...args) => mockCreate(...args),
      },
    },
  })),
}));

import handler from '../../../src/pages/api/network/query';
import { createMockReq, createMockRes } from './testUtils';

describe('/api/network/query', () => {
  beforeEach(() => {
    mockCreate = jest.fn();
  });

  test('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns 400 when query is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        networkData: { nodes: [] },
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  test('returns 400 when network data is invalid', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operators',
        networkData: null,
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Valid network data is required' });
  });

  test('returns 400 when source is invalid', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operators',
        networkData: { nodes: [] },
        source: 'email',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Valid source is required (linkedin, twitter, or facebook)',
    });
  });

  test('returns 200 and enriches matches with node data on success', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              matches: [
                {
                  id: '1',
                  name: 'Alice',
                  relevance: 'High',
                  reasoning: 'Strong fit',
                },
              ],
              summary: 'One strong match',
              relatedIndustries: ['AI'],
              suggestedConnections: [],
            }),
          },
        },
      ],
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operators',
        source: 'linkedin',
        networkData: {
          nodes: [
            {
              id: '1',
              name: 'Alice Doe',
              company: 'Acme',
            },
          ],
          edges: [],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].nodeData).toEqual({
      id: '1',
      name: 'Alice Doe',
      company: 'Acme',
    });
  });

  test('returns 500 when LLM response is not valid JSON', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: 'not-json',
          },
        },
      ],
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operators',
        source: 'linkedin',
        networkData: { nodes: [], edges: [] },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to parse LLM response');
    expect(res.body.rawResponse).toBe('not-json');
  });

  test('returns 500 when Together request fails', async () => {
    mockCreate.mockRejectedValue(new Error('boom'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operators',
        source: 'linkedin',
        networkData: { nodes: [], edges: [] },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe(
      'An error occurred while processing the network query'
    );
    expect(res.body.details).toBe('boom');
  });
});
