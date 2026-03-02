import { processFile } from '../../src/utils/fileProcessing';

function makeBrowserFile(name, text) {
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
  };
}

describe('fileProcessing', () => {
  test('processes txt uploads from browser-style files', async () => {
    const result = await processFile(makeBrowserFile('notes.txt', 'hello world'));

    expect(result.name).toBe('notes.txt');
    expect(result.content).toBe('hello world');
    expect(result.metadata).toEqual({});
  });

  test('processes csv uploads from browser-style files', async () => {
    const file = makeBrowserFile('rows.csv', 'name,role\nA,Founder\nB,CEO');
    const result = await processFile(file);

    expect(result.name).toBe('rows.csv');
    expect(result.content).toContain('A, Founder');
    expect(result.metadata.columns).toEqual(['name', 'role']);
  });
});
