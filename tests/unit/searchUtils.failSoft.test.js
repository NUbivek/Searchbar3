describe('searchUtils verified fail-soft wrappers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('performVerifiedSearch returns empty array when verified handler throws', async () => {
    jest.doMock('../../src/utils/sourceIntegration', () => ({
      sourceHandlers: {
        verified: jest.fn().mockRejectedValue(new Error('verified source failed')),
      },
      performSearch: jest.fn(),
    }));

    const { performVerifiedSearch } = require('../../src/utils/searchUtils');
    const result = await performVerifiedSearch('ai startup');

    expect(result).toEqual([]);
  });

  test('searchVerifiedSources returns empty array when verifiedSearch wrapper throws', async () => {
    jest.doMock('../../src/utils/sourceIntegration', () => ({
      sourceHandlers: {
        verified: jest.fn().mockResolvedValue([]),
      },
      performSearch: jest.fn(),
    }));

    jest.doMock('../../src/utils/verifiedSearch', () => ({
      searchVerifiedSources: jest.fn().mockRejectedValue(new Error('verified wrapper failed')),
    }));

    const { searchVerifiedSources } = require('../../src/utils/searchUtils');
    const result = await searchVerifiedSources('seed funding', { category: 'VC & Startups' });

    expect(result).toEqual([]);
  });
});
