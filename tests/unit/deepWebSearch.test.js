import { deepWebSearch } from '../../src/utils/deepWebSearch';

describe('deepWebSearch', () => {
  test('returns an empty array when query is missing', async () => {
    const result = await deepWebSearch('');
    expect(result).toEqual([]);
  });

  test('returns an empty array when api key is missing', async () => {
    const result = await deepWebSearch('test query', { apiKey: '' });
    expect(result).toEqual([]);
  });
});
