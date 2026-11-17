jest.mock('../../../src/utils/sources/curatedIndex', () => ({
  searchCuratedSources: jest.fn(),
  searchCuratedForEntity: jest.fn(async () => []),
  getCuratedIndexStatus: jest.fn(() => ({ ready: true, itemsAvailable: 3000, indexableSources: 135 })),
}));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(), PROVIDERS: [{ id: 'groq' }], providerEnabled: jest.fn(() => false) }));
jest.mock('../../../src/utils/sources/hackernewsAlgolia', () => ({ searchHackerNews: jest.fn() }));

const { extractFounderEvidence } = require('../../../src/server/founderCheck');

const R = (over) => ({ title: 'Untitled', content: '', source: 'curated', sourceName: 'Example News', publishedAt: '2024-06-01T00:00:00Z', ...over });

const companiesOf = (out) => out.pastCompanies.map((c) => c.company);

describe('founderCheck item 10: a role held by another named person is not the subject\'s', () => {
  test('second executive named in the same sentence does not add their company', () => {
    const out = extractFounderEvidence({
      name: 'Jane Doe',
      results: [R({
        url: 'https://news.example/pr',
        content: 'The partnership was announced by Jane Doe, co-founder and CEO of Acme Robotics, and Pierre Martin, CEO of Globex, in Paris.',
      })],
    });
    const cos = companiesOf(out);
    expect(cos).toContain('Acme Robotics');
    expect(cos).not.toContain('Globex');
  });

  test('other person first, subject second: still only the subject\'s company', () => {
    const out = extractFounderEvidence({
      name: 'Jane Doe',
      results: [R({
        url: 'https://news.example/pr2',
        content: 'Speakers included Pierre Martin, the CEO of Globex, and Jane Doe, founder of Acme Robotics.',
      })],
    });
    const cos = companiesOf(out);
    expect(cos).toContain('Acme Robotics');
    expect(cos).not.toContain('Globex');
  });

  test('the subject\'s own "Name, CEO of X" is still read', () => {
    const out = extractFounderEvidence({
      name: 'Jane Doe',
      results: [R({ url: 'https://news.example/p3', content: 'Jane Doe, CEO of Initech, spoke on Tuesday.' })],
    });
    expect(companiesOf(out)).toContain('Initech');
  });
});
