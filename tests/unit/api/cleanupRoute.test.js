jest.mock('fs', () => ({
  existsSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

const fs = require('fs');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/cleanup').default;

describe('/api/cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  test('deletes the file when it exists', async () => {
    fs.existsSync.mockReturnValue(true);

    const req = createMockReq({
      method: 'POST',
      body: JSON.stringify({ filePath: '/tmp/example.txt' }),
    });
    const res = createMockRes();

    await handler(req, res);

    expect(fs.existsSync).toHaveBeenCalledWith('/tmp/example.txt');
    expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/example.txt');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test('returns success when the file is already missing', async () => {
    fs.existsSync.mockReturnValue(false);

    const req = createMockReq({
      method: 'POST',
      body: JSON.stringify({ filePath: '/tmp/missing.txt' }),
    });
    const res = createMockRes();

    await handler(req, res);

    expect(fs.existsSync).toHaveBeenCalledWith('/tmp/missing.txt');
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test('returns fail-soft payload when the request body is invalid JSON', async () => {
    const req = createMockReq({
      method: 'POST',
      body: '{invalid',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      success: false,
      degradedSources: ['cleanup'],
      error: 'Cleanup failed',
    });
  });
});
