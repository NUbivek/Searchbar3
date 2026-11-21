/**
 * @jest-environment node
 *
 * R4 (review 2026-11-21), searchEngines.js: a seed or adverse question that needs a general web search goes to
 * the backup search service before it settles for news headlines (web-needgeneral-never-waits).
 */
jest.mock('../../../src/server/search/retrieve', () => ({
  searchWeb: jest.fn(async () => []),
  webSearchConfigured: jest.fn(() => false),
}));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

import { searchWeb, webSearchConfigured } from '../../../src/server/search/retrieve';
import { ENGINES, keylessSearch, __resetEnginesForTests } from '../../../src/server/founder/sources/searchEngines';

const MINUTE = 60 * 1000;
const hit = (n) => ({ title: `Result ${n} about Jane Roe`, snippet: `Snippet ${n}`, url: `https://example.com/story-${n}`, date: null });
let now;
function stub(answers = {}) {
  const spies = {};
  for (const e of ENGINES) {
    const answer = answers[e.id];
    spies[e.id] = jest.spyOn(e, 'search').mockImplementation(async () => {
      if (answer === undefined) return [];
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }
  return spies;
}
const useUpDdg = async () => { for (let i = 0; i < 4; i += 1) await keylessSearch(`"Someone Else" q${i}`); };

beforeEach(() => {
  __resetEnginesForTests();
  searchWeb.mockReset();
  webSearchConfigured.mockReset();
  now = Date.parse('2026-11-21T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

describe('web-needgeneral-never-waits', () => {
  test('DuckDuckGo allowance used: a seed question goes to the backup service before the news feeds', async () => {
    webSearchConfigured.mockReturnValue(true);
    searchWeb.mockResolvedValue([{ title: 'Jane Roe - founder of Acme', snippet: 'Jane Roe studied at MIT', url: 'https://acme.example.com/team', date: null }]);
    const spies = stub({ ddg: [hit(9)], gnews: [hit(1)] });
    await useUpDdg();
    const out = await keylessSearch('"Jane Roe"', { needGeneral: true, allowMetered: true });
    expect(searchWeb).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ engine: 'metered', general: true, headlinesOnly: false });
    expect(spies.gnews).not.toHaveBeenCalled();
  });

  test('the backup service found nothing: the general search answered, so the news feeds are asked, not counted as headlines only', async () => {
    webSearchConfigured.mockReturnValue(true);
    searchWeb.mockResolvedValue([]);
    stub({ ddg: [hit(9)], gnews: [hit(1)] });
    await useUpDdg();
    const out = await keylessSearch('"Jane Roe"', { needGeneral: true, allowMetered: true });
    expect(searchWeb).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ engine: 'gnews', general: true, headlinesOnly: false });
  });

  test('the backup service failing does not stop the wait for DuckDuckGo', async () => {
    webSearchConfigured.mockReturnValue(true);
    searchWeb.mockRejectedValue(new Error('down'));
    const spies = stub({ ddg: [hit(9)], gnews: [hit(1)] });
    await useUpDdg();
    now += 5 * MINUTE;
    const error = await keylessSearch('"Jane Roe"', { needGeneral: true, allowMetered: true }).then(() => null, (e) => e);
    expect(error?.code).toBe('SEARCH_RESTING');
    expect(spies.gnews).not.toHaveBeenCalled();
    expect(searchWeb).toHaveBeenCalledTimes(1);
  });

  test('a lookup that may not use the backup service still waits as before', async () => {
    webSearchConfigured.mockReturnValue(true);
    stub({ ddg: [hit(9)], gnews: [hit(1)] });
    await useUpDdg();
    now += 5 * MINUTE;
    const error = await keylessSearch('"Jane Roe"', { needGeneral: true }).then(() => null, (e) => e);
    expect(error?.code).toBe('SEARCH_RESTING');
    expect(searchWeb).not.toHaveBeenCalled();
  });
});
