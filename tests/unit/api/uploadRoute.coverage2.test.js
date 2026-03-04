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

  test.each([
    ['deck.pdf', 'application/pdf', 'pdf extracted text'],
    ['memo.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx extracted text'],
    ['table.csv', 'text/csv', 'csv extracted text'],
    ['notes.txt', 'text/plain', 'txt extracted text'],
  ])('returns parsed payload for %s', async (filename, mimetype, content) => {
    const parsedFile = {
      originalFilename: filename,
      newFilename: `tmp-${filename}`,
      mimetype,
      size: 128,
      filepath: `/tmp/${filename}`,
    };

    formidable.mockImplementation(() => ({
      parse: (_req, cb) => cb(null, {}, { files: parsedFile }),
    }));

    processFile.mockResolvedValue({
      name: filename,
      type: mimetype,
      size: 128,
      content,
      metadata: { parser: 'mock' },
    });

    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0]).toMatchObject({
      name: filename,
      type: mimetype,
      content,
      error: null,
    });
  });

  test('returns fail-soft payload when form parsing throws', async () => {
    formidable.mockImplementation(() => ({
      parse: (_req, cb) => cb(new Error('parse failed')),
    }));

    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Upload failed',
      details: 'parse failed',
      degradedSources: ['upload'],
    });
  });
});
