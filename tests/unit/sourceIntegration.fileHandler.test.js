const { sourceHandlers } = require('../../src/utils/sourceIntegration');

describe('sourceIntegration file handler', () => {
  test('uses extracted file content when provided by upload parser', async () => {
    const files = [
      {
        name: 'memo.txt',
        type: 'text/plain',
        size: 42,
        content: '  Founder update  Q1 traction  ',
        metadata: { lines: 1 },
      },
    ];

    const results = await sourceHandlers.file('founder update', files);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'File Source: memo.txt',
      content: 'Founder update Q1 traction',
      source: 'file',
      type: 'uploaded_file',
      relevance: 0.85,
      metadata: {
        fileType: 'text/plain',
        fileSize: 42,
        lines: 1,
      },
    });
  });

  test('returns fail-soft placeholder when parsed content is empty', async () => {
    const files = [
      {
        name: 'bad.pdf',
        type: 'application/pdf',
        size: 128,
        content: '',
        error: 'Invalid or corrupted PDF file',
      },
    ];

    const results = await sourceHandlers.file('seed query', files);

    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('had no extractable content');
    expect(results[0].relevance).toBe(0.35);
    expect(results[0].metadata.parseError).toBe('Invalid or corrupted PDF file');
  });
});
