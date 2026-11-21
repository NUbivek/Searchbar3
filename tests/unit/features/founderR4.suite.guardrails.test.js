/**
 * Round 4 (review 2026-11-21): the deep check drops a spouse headline the way the quick brief does
 * (guardrails.js WEDDING_TITLE, asked for by the quickbrief engineer).
 */
const { sanitizeFinding, WEDDING_TITLE } = require('../../../src/server/founder/guardrails');

const rec = (title) => ({ title, quote: 'Jane Roe runs Zetafold.', url: 'https://news.test/a', category: 'press', source: 'news-archive' });

describe('a headline about a marriage or a spouse is private family life', () => {
  test.each([
    'Zetafold founder Jane Roe marries longtime partner',
    'Jane Roe and her husband buy a ranch',
    'Jane Roe, with her new fiancé, at the gala',
    'Jane Roe divorces after ten years',
    'Jane Roe weds in Napa',
  ])('%s is dropped', (title) => {
    expect(WEDDING_TITLE.test(title)).toBe(true);
    expect(sanitizeFinding(rec(title))).toBeNull();
  });
  test.each([
    'Zetafold raises $40M led by Index',
    'Jane Roe and her co-founder on building Zetafold',
  ])('%s is kept', (title) => {
    expect(sanitizeFinding(rec(title))).not.toBeNull();
  });
});

test('a related-party record that states the relative\'s role keeps its "(married to)" title', () => {
  const kept = sanitizeFinding({ title: 'S-1/A filed by We Co. names Adam Neumann in a passage about a relative (married to)', quote: 'Adam is married to Rebekah Neumann. Rebekah Neumann is a co-founder and an executive officer.', url: 'https://www.sec.gov/x', category: 'related', source: 'sec-filings' });
  expect(kept).not.toBeNull();
  expect(sanitizeFinding({ title: 'Adam Neumann weds Rebekah Paltrow', quote: 'Rebekah Neumann, a co-founder, married Adam.', url: 'https://news.test/w', category: 'related', source: 'news-archive' })).toBeNull();
});
