import { processFile } from '../../src/utils/fileProcessing';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import { promises as fs } from 'fs';

jest.mock('pdf-parse', () => jest.fn());
jest.mock('mammoth', () => ({
  extractRawText: jest.fn(),
}));
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    unlink: jest.fn(),
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

describe('fileProcessing node upload formats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.readFile.mockResolvedValue(Buffer.from('fake-binary'));
  });

  test('processes node-uploaded PDF files with extracted text', async () => {
    pdf.mockResolvedValue({
      text: 'PDF extracted content',
      numpages: 3,
      info: { Author: 'test' },
    });

    const result = await processFile({
      originalFilename: 'brief.pdf',
      filepath: '/tmp/brief.pdf',
      size: 1024,
      mimetype: 'application/pdf',
    });

    expect(fs.readFile).toHaveBeenCalledWith('/tmp/brief.pdf');
    expect(pdf).toHaveBeenCalled();
    expect(result.name).toBe('brief.pdf');
    expect(result.content).toBe('PDF extracted content');
    expect(result.metadata.pageCount).toBe(3);
  });

  test('processes node-uploaded DOCX files with extracted text', async () => {
    mammoth.extractRawText.mockResolvedValue({
      value: 'DOCX extracted content',
      messages: [],
    });

    const result = await processFile({
      originalFilename: 'memo.docx',
      filepath: '/tmp/memo.docx',
      size: 2048,
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(fs.readFile).toHaveBeenCalledWith('/tmp/memo.docx');
    expect(mammoth.extractRawText).toHaveBeenCalled();
    expect(result.name).toBe('memo.docx');
    expect(result.content).toBe('DOCX extracted content');
    expect(result.metadata).toEqual({ messages: [] });
  });
});
