jest.mock('../../../src/utils/envValidation', () => ({
  getEnvDiagnostics: jest.fn()
}));

import handler from '../../../src/pages/api/debug/env-check';
import { getEnvDiagnostics } from '../../../src/utils/envValidation';
import { createMockReq, createMockRes } from './testUtils';

describe('api/debug/env-check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns diagnostics and timestamp for GET requests', async () => {
    const diagnostics = {
      required: [{ key: 'TOGETHER_API_KEY', status: 'missing' }],
      optional: [{ key: 'SERPER_API_KEY', status: 'present' }]
    };
    getEnvDiagnostics.mockReturnValue(diagnostics);

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(getEnvDiagnostics).toHaveBeenCalledWith(process.env);
    expect(res.statusCode).toBe(200);
    expect(res.body.diagnostics).toEqual(diagnostics);
    expect(typeof res.body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
  });
});
