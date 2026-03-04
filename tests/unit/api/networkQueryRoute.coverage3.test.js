import handler from '../../../src/pages/api/network/query';
import { createMockReq } from './testUtils';

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

var mockCreate;

jest.mock('together', () => {
  mockCreate = jest.fn();
  return {
    TogetherAI: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
  };
});

describe('/api/network/query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        networkData: { nodes: [{ id: 'n1' }] },
        source: 'linkedin',
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Query is required' });
  });

  it('returns 400 when network data is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find intros',
        source: 'linkedin',
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Valid network data is required' });
  });

  it('returns 400 when source is invalid', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find intros',
        networkData: { nodes: [{ id: 'n1' }] },
        source: 'email',
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Valid source is required (linkedin, twitter, or facebook)',
    });
  });

  it('returns parsed results and attaches node data to matches', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Found a relevant operator.',
              matches: [
                { id: 'n1', confidence: 0.91 },
                { id: 'missing', confidence: 0.2 },
              ],
            }),
          },
        },
      ],
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operator investors',
        source: 'linkedin',
        networkData: {
          nodes: [
            { id: 'n1', name: 'Alice Operator', title: 'Partner' },
            { id: 'n2', name: 'Bob Builder', title: 'Founder' },
          ],
        },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(mockCreate).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      summary: 'Found a relevant operator.',
      matches: [
        {
          id: 'n1',
          confidence: 0.91,
          nodeData: { id: 'n1', name: 'Alice Operator', title: 'Partner' },
        },
        {
          id: 'missing',
          confidence: 0.2,
          nodeData: null,
        },
      ],
    });
  });

  it('returns 500 when the LLM response is not valid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
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
        query: 'find operator investors',
        source: 'twitter',
        networkData: { nodes: [{ id: 'n1' }] },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Failed to parse LLM response',
      rawResponse: 'not json',
    });
  });

  it('returns 500 when the upstream request throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Together timeout'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operator investors',
        source: 'facebook',
        networkData: { nodes: [{ id: 'n1' }] },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'An error occurred while processing the network query',
      details: 'Together timeout',
    });
  });
});
