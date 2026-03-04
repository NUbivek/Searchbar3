jest.mock('formidable', () => jest.fn());

jest.mock('../../../src/utils/fileProcessing', () => ({
  processFile: jest.fn(),
  cleanupFiles: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const formidable = require('formidable');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/upload').default;

describe('/api/upload validation errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 400 for max file size parse errors', async () => {
    formidable.mockImplementation(() => ({
      parse: (_req, cb) => cb({ code: 1009, message: 'maxFileSize exceeded' }),
    }));

    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Upload validation failed',
      details: 'maxFileSize exceeded',
    });
  });

  test('returns 500 for unknown parse failures', async () => {
    formidable.mockImplementation(() => ({
      parse: (_req, cb) => cb(new Error('unexpected parser failure')),
    }));

    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Upload failed',
      details: 'unexpected parser failure',
    });
  });
});
