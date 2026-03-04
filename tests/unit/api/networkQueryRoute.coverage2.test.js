import handler from '../../../src/pages/api/network/query';

jest.mock('together', () => {
  const createMock = jest.fn();
  return {
    TogetherAI: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: createMock,
        },
      },
    })),
    __createMock: createMock,
  };
});

const { __createMock } = require('together');

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

describe('/api/network/query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TOGETHER_API_KEY = 'test-key';
  });

  it('returns 405 for non-POST requests', async () => {
    const req = { method: 'GET', body: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = { method: 'POST', body: { networkData: { nodes: [] }, source: 'linkedin' } };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('returns 400 when network data is invalid', async () => {
    const req = { method: 'POST', body: { query: 'who matters', networkData: {}, source: 'linkedin' } };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Valid network data is required' });
  });

  it('returns 400 when source is unsupported', async () => {
    const req = {
      method: 'POST',
      body: { query: 'who matters', networkData: { nodes: [] }, source: 'github' },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Valid source is required (linkedin, twitter, or facebook)' });
  });

  it('returns enhanced parsed matches on success', async () => {
    __createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'ok',
              matches: [{ id: 'node-1', score: 0.9 }],
            }),
          },
        },
      ],
    });

    const req = {
      method: 'POST',
      body: {
        query: 'find best contacts',
        source: 'linkedin',
        networkData: {
          nodes: [
            {
              id: 'node-1',
              name: 'Jane Doe',
              title: 'Investor',
              company: 'Fund',
              mutualConnections: 3,
            },
          ],
          edges: [],
        },
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(__createMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toBe('ok');
    expect(res.body.matches[0]).toMatchObject({
      id: 'node-1',
      score: 0.9,
      nodeData: expect.objectContaining({ id: 'node-1', name: 'Jane Doe' }),
    });
  });

  it('returns 500 when the model response is not valid JSON', async () => {
    __createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: 'not-json',
          },
        },
      ],
    });

    const req = {
      method: 'POST',
      body: {
        query: 'find best contacts',
        source: 'linkedin',
        networkData: { nodes: [], edges: [] },
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to parse LLM response');
    expect(res.body.rawResponse).toBe('not-json');
  });

  it('returns 500 when Together throws', async () => {
    __createMock.mockRejectedValue(new Error('upstream down'));

    const req = {
      method: 'POST',
      body: {
        query: 'find best contacts',
        source: 'twitter',
        networkData: { nodes: [], edges: [] },
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'An error occurred while processing the network query',
      details: 'upstream down',
    });
  });
});
