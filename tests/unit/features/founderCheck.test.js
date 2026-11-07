jest.mock('../../../src/utils/sources/curatedIndex', () => ({ searchCuratedSources: jest.fn() }));
jest.mock('../../../src/utils/sources/hackernewsAlgolia', () => ({ searchHackerNews: jest.fn() }));
jest.mock('../../../src/utils/searchUtils', () => ({ performSimpleSearch: jest.fn() }));

const { runFounderCheck, extractFounderEvidence, nameMatcher, LITIGATION_DISCLAIMER } = require('../../../src/server/founderCheck');

const R = (over) => ({ title: 'Untitled', url: `https://example.com/${Math.abs(JSON.stringify(over).length)}-${over.title}`, content: '', source: 'curated', sourceName: 'Example News', publishedAt: '2024-06-01T00:00:00Z', ...over });

const RESULTS = [
  R({ title: 'Mistral raises funding', url: 'https://news.example/a', content: 'Jane Doe co-founded Acme Robotics in 2019 with two partners. In 2015, Jane Doe joined Google DeepMind as a researcher. Mistral is growing fast.' }),
  R({ title: 'Profile', url: 'https://news.example/b', content: 'Jane Doe was previously at Initech before starting her company. She is the former CTO of Globex Corp according to filings.' }),
  R({ title: 'Different Jane', url: 'https://news.example/c', content: 'jane doe is mentioned in lowercase here in 2010 when she joined Foo Inc. Jane Doelittle founded Bar Ltd in 2012.' }),
  R({ title: 'Jane Doe sued by former employer', url: 'https://news.example/d', content: 'The lawsuit alleges that Jane Doe took trade secrets in 2021 when she left.' }),
];

function allItems(out) {
  return [...out.timeline, ...out.pastCompanies, ...out.litigation, ...out.press];
}

describe('founderCheck extraction', () => {
  test('strict, case-sensitive full-name matching', () => {
    const m = nameMatcher('Jane Doe');
    expect(m('Jane Doe joined.')).toBe(true);
    expect(m('jane doe joined.')).toBe(false);
    expect(m('Jane Doelittle joined.')).toBe(false);
    expect(m('J. Doe joined.')).toBe(false);
    const out = extractFounderEvidence({ name: 'Jane Doe', results: RESULTS });
    for (const item of allItems(out)) expect(item.quote).toMatch(/Jane Doe(?![a-z])/);
    expect(out.sources.map((s) => s.url)).not.toContain('https://news.example/c');
  });

  test('years extracted and timeline sorted ascending', () => {
    const out = extractFounderEvidence({ name: 'Jane Doe', results: RESULTS });
    const years = out.timeline.map((t) => t.year);
    expect(years).toEqual([2015, 2019, 2021]);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    for (const t of out.timeline) expect(t.quote).toContain(String(t.year));
  });

  test('past-company patterns', () => {
    const out = extractFounderEvidence({ name: 'Jane Doe', results: RESULTS });
    const companies = out.pastCompanies.map((c) => c.company);
    expect(companies).toEqual(expect.arrayContaining(['Acme Robotics', 'Initech', 'Google DeepMind']));
    expect(companies).not.toContain('Bar Ltd');
    expect(companies).not.toContain('Foo Inc');
    // "former CTO of Globex Corp" sentence does not contain the name, so it is not used.
    expect(companies).not.toContain('Globex Corp');
  });

  test('company ranking and possible-different-person flag', () => {
    const out = extractFounderEvidence({ name: 'Jane Doe', company: 'Mistral', results: RESULTS });
    expect(out.press[0].mentionsCompany || !out.press[0].possibleDifferentPerson).toBe(true);
    const flagged = out.press.filter((p) => p.possibleDifferentPerson).map((p) => out.sources[p.sourceIndex].url);
    expect(flagged).toEqual(expect.arrayContaining(['https://news.example/b', 'https://news.example/d']));
    expect(flagged).not.toContain('https://news.example/a');
  });

  test('every item has a valid sourceIndex', () => {
    const out = extractFounderEvidence({ name: 'Jane Doe', company: 'Mistral', results: RESULTS });
    expect(allItems(out).length).toBeGreaterThan(0);
    for (const item of allItems(out)) {
      expect(Number.isInteger(item.sourceIndex)).toBe(true);
      expect(out.sources[item.sourceIndex]).toBeDefined();
      expect(out.sources[item.sourceIndex].url).toMatch(/^https:\/\//);
    }
    out.sources.forEach((s, i) => expect(s.n).toBe(i + 1));
  });
});

describe('runFounderCheck', () => {
  test('empty sources: nothing invented, litigation disclaimer present, unavailable sources listed', async () => {
    const out = await runFounderCheck({ name: 'Nobody Known' }, {
      searchers: {
        curated: async () => [], hackernews: async () => [], web: async () => [],
        courtlistener: async () => { throw new Error('CourtListener skipped: requires token'); },
        webConfigured: () => false,
      },
    });
    expect(out.timeline).toEqual([]);
    expect(out.pastCompanies).toEqual([]);
    expect(out.litigation).toEqual([]);
    expect(out.press).toEqual([]);
    expect(out.sources).toEqual([]);
    expect(out.litigationDisclaimer).toBe(LITIGATION_DISCLAIMER);
    expect(out.litigationDisclaimer).toMatch(/NOT evidence of a clean record/);
    const names = out.unavailableSources.map((u) => u.source);
    expect(names).toEqual(expect.arrayContaining(['Web search', 'CourtListener', 'LinkedIn']));
  });

  test('merges searchers and dedupes by URL', async () => {
    const out = await runFounderCheck({ name: 'Jane Doe', company: 'Mistral' }, {
      searchers: {
        curated: async () => RESULTS, hackernews: async () => [RESULTS[3]], web: async () => RESULTS,
        courtlistener: async () => [], webConfigured: () => true,
      },
    });
    const urls = out.sources.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const item of allItems(out)) expect(out.sources[item.sourceIndex]).toBeDefined();
    expect(out.unavailableSources.map((u) => u.source)).not.toContain('Web search');
  });
});
