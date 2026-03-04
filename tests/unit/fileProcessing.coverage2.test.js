import { processFile, processUploadedFiles } from '../../src/utils/fileProcessing';

jest.mock('../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

function makeBrowserFile(name, text, overrides = {}) {
  return {
    name,
    size: text.length,
    mimetype: 'text/plain',
    async text() {
      return text;
    },
    async arrayBuffer() {
      return Buffer.from(text);
    },
    ...overrides,
  };
}

describe('fileProcessing coverage', () => {
  test('rejects unsupported file types', async () => {
    const file = makeBrowserFile('payload.exe', 'abc');
    await expect(processFile(file)).rejects.toThrow('Unsupported file type: exe');
  });

  test('rejects txt files above size limit before parsing', async () => {
    const overLimit = 10 * 1024 * 1024 + 1;
    const file = makeBrowserFile('huge.txt', 'tiny', { size: overLimit });

    await expect(processFile(file)).rejects.toThrow('File size exceeds limit');
  });

  test('returns invalid csv error for malformed csv input', async () => {
    const file = makeBrowserFile('bad.csv', 'name,role\n"unterminated');

    await expect(processFile(file)).rejects.toThrow('Invalid CSV file');
  });

  test('processUploadedFiles keeps successes and drops failures', async () => {
    const files = [
      makeBrowserFile('good.txt', 'ok'),
      makeBrowserFile('bad.bin', 'bad')
    ];

    const result = await processUploadedFiles(files);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('good.txt');
    expect(result[0].content).toBe('ok');
  });
});
