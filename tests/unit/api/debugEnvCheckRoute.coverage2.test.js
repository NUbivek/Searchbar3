import handler from '../../../src/pages/api/debug/env-check';

jest.mock('../../../src/utils/envValidation', () => ({
  getEnvDiagnostics: jest.fn(() => ({
    ok: true,
    missingCore: [],
    providers: {
      twitter: false,
      linkedin: true
    },
    baseUrl: 'https://example.com',
    productionUrl: 'https://prod.example.com',
    useProductionCallbacks: true
  }))
}));

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('/api/debug/env-check', () => {
  it('returns 405 for non-GET requests', () => {
    const req = { method: 'POST' };
    const res = createRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
  });

  it('returns timestamped diagnostics for GET requests', () => {
    const req = { method: 'GET' };
    const res = createRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledTimes(1);

    const payload = res.json.mock.calls[0][0];
    expect(typeof payload.timestamp).toBe('string');
    expect(payload.diagnostics).toEqual({
      ok: true,
      missingCore: [],
      providers: {
        twitter: false,
        linkedin: true
      },
      baseUrl: 'https://example.com',
      productionUrl: 'https://prod.example.com',
      useProductionCallbacks: true
    });
  });
});
