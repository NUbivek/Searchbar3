import handler from '../../../src/pages/api/network/query';
import { createMockReq, createMockRes } from './testUtils';

let mockCreate;

jest.mock('together', () => {
  const TogetherAI = jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args) => mockCreate(...args),
      },
    },
  }));

  return { TogetherAI };
});

describe('/api/network/query', () => {
  const originalApiKey = process.env.TOGETHER_API_KEY;

  beforeEach(() => {
    mockCreate = jest.fn();
    jest.clearAllMocks();
    process.env.TOGETHER_API_KEY = 'test-key';
  });

  afterAll(() => {
    if (originalApiKey === undefined) {
      delete process.env.TOGETHER_API_KEY;
    } else {
      process.env.TOGETHER_API_KEY = originalApiKey;
    }
  });

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
      body: {
        networkData: { nodes: [{ id: '1' }] },
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('returns 400 when network data is invalid', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find founders',
        networkData: {},
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Valid network data is required' });
  });

  it('returns 400 when source is invalid', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find founders',
        networkData: { nodes: [{ id: '1' }] },
        source: 'github',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Valid source is required (linkedin, twitter, or facebook)',
    });
  });

  it('returns parsed matches with node data on success', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Found two relevant people',
              matches: [
                { id: 'a1', reason: 'Strong operator fit' },
                { id: 'b2', reason: 'Prior domain experience' },
              ],
            }),
          },
        },
      ],
    });

    const networkData = {
      nodes: [
        { id: 'user', name: 'Me' },
        {
          id: 'a1',
          name: 'Alice',
          company: 'Acme',
          position: 'Partner',
          location: 'SF',
        },
        {
          id: 'b2',
          name: 'Bob',
          company: 'Bravo',
          position: 'Founder',
          location: 'NYC',
        },
      ],
    };

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operator investors',
        networkData,
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toBe('Found two relevant people');
    expect(res.body.matches).toHaveLength(2);
    expect(res.body.matches[0]).toEqual(
      expect.objectContaining({
        id: 'a1',
        reason: 'Strong operator fit',
        nodeData: expect.objectContaining({ id: 'a1', name: 'Alice' }),
      })
    );
    expect(res.body.matches[1]).toEqual(
      expect.objectContaining({
        id: 'b2',
        reason: 'Prior domain experience',
        nodeData: expect.objectContaining({ id: 'b2', name: 'Bob' }),
      })
    );
  });

  it('returns 500 when LLM response is not valid JSON', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: 'not json',
          },
        },
      ],
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find people',
        networkData: { nodes: [{ id: '1', name: 'Alice' }] },
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to parse LLM response',
      rawResponse: 'not json',
    });
  });

  it('returns 500 when Together request fails', async () => {
    mockCreate.mockRejectedValue(new Error('Together unavailable'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find people',
        networkData: { nodes: [{ id: '1', name: 'Alice' }] },
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'An error occurred while processing the network query',
      details: 'Together unavailable',
    });
  });
});
