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
const { processFile } = require('../../../src/utils/fileProcessing');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/upload').default;

describe('/api/upload coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 400 when no supported files are parsed', async () => {
    formidable.mockImplementation(() => ({
      parse: (_req, cb) => cb(null, {}, {}),
    }));

    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('No supported files uploaded');
  });

  test('returns 200 with parsed file payloads', async () => {
    const parsedFile = {
      originalFilename: 'test.txt',
      newFilename: 'tmp123.txt',
      mimetype: 'text/plain',
      size: 11,
      filepath: '/tmp/test.txt',
    };

    formidable.mockImplementation(() => ({
      parse: (_req, cb) => cb(null, {}, { files: parsedFile }),
    }));

    processFile.mockResolvedValue({
      name: 'test.txt',
      type: 'text/plain',
      size: 11,
      content: 'hello world',
      metadata: { lines: 1 },
    });

    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(processFile).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0]).toMatchObject({
      name: 'test.txt',
      type: 'text/plain',
      content: 'hello world',
      error: null,
    });
  });

  test('returns 500 when form parsing throws', async () => {
    formidable.mockImplementation(() => ({
      parse: (_req, cb) => cb(new Error('parse failed')),
    }));

    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Upload failed');
    expect(res.body.details).toBe('parse failed');
  });
});
