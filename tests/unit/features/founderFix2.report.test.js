/**
 * Second round of report fixes from grading real checks: which record leads
 * a matter, dates read from an encyclopaedia's own sentence, what the
 * timeline holds, and how partial or missing coverage is stated.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const { buildReport, quotedDeepBrief, NOT_COVERED } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
const rec = (o) => ({ id: `r${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', severity: 'info', quote: '', match: 'confirmed', ...o });
function state(findings, extra = {}) {
  const s = startState({ name: 'John Smith', company: 'Zeta' });
  s.findings = findings;
  return Object.assign(s, extra);
}

test('a matter is led by the court or prosecutor record, not a reposted forum thread', () => {
  const report = buildReport(state([
    rec({ source: 'hacker-news', sourceLabel: 'Hacker News', title: 'John Smith sentenced to four years in prison', url: 'https://news.ycombinator.com/item?id=1', date: '2023-12-18', severity: 'high' }),
    rec({ source: 'hacker-news', sourceLabel: 'Hacker News', title: 'John Smith sentenced to four years in prison', url: 'https://news.ycombinator.com/item?id=2', date: '2023-12-19', severity: 'high' }),
    rec({ title: 'John Smith sentenced to four years in prison', url: 'https://paper.test/a', date: '2023-12-18', severity: 'high' }),
    rec({ source: 'doj-press-releases', sourceLabel: 'US Department of Justice', category: 'press', title: 'Founder John Smith sentenced to four years in prison for securities fraud', url: 'https://justice.test/pr', date: '2023-12-18', severity: 'high' }),
  ]));
  expect(report.redFlags).toHaveLength(1);
  expect(report.redFlags[0].url).toBe('https://justice.test/pr');
  const all = report.sections.flatMap((s) => s.items);
  const forum = all.filter((f) => f.source === 'hacker-news');
  const doj = all.find((f) => f.source === 'doj-press-releases');
  expect(forum.every((f) => f.score <= doj.score)).toBe(true);
});

test('among tied records the encyclopaedia outranks news, and a name-only record never leads', () => {
  const report = buildReport(state([
    rec({ title: 'John Smith indicted on fraud charges by grand jury', url: 'https://paper.test/b', date: '2020-07-29', severity: 'high' }),
    rec({ source: 'wikipedia', sourceLabel: 'Wikipedia', category: 'litigation', title: 'John Smith (Wikipedia, "Legal"): John Smith indicted by a grand jury on fraud charges', url: 'https://en.wikipedia.org/wiki/John_Smith%23Legal', date: '2020', quote: 'On July 29, 2020, John Smith was indicted on fraud charges.', severity: 'high' }),
  ]));
  expect(report.redFlags).toHaveLength(1);
  expect(report.redFlags[0].source).toBe('wikipedia');
  expect(report.redFlags[0].more.map((m) => m.url)).toEqual(['https://paper.test/b']);
});

test('an encyclopaedia record is dated from its own sentence, never from the article\'s last edit', () => {
  const report = buildReport(state([
    rec({ source: 'wikipedia', category: 'litigation', title: 'A', url: 'https://w.test/1', date: '2021', quote: 'In July 2021, the jury returned a verdict. In 2019 he left.', severity: 'medium' }),
    rec({ source: 'wikipedia', category: 'litigation', title: 'B', url: 'https://w.test/2', date: '2020', quote: 'He was charged on 10 September 2020 and released.', severity: 'medium' }),
    // a saved record dated by the article's last edit: undated unless its text gives a date
    rec({ source: 'wikipedia', category: 'litigation', title: 'C', url: 'https://w.test/3', date: '2026-11-09', data: { revisedAt: '2026-11-09T10:00:00Z' }, quote: 'He settled the case in March 2018.', severity: 'medium' }),
    rec({ source: 'wikipedia', category: 'litigation', title: 'D', url: 'https://w.test/4', date: '2026-11-09', data: { revisedAt: '2026-11-09T10:00:00Z' }, quote: 'He settled the case.', severity: 'medium' }),
    // a date of another year is not the date of this record
    rec({ source: 'wikipedia', category: 'litigation', title: 'E', url: 'https://w.test/5', date: '2022', quote: 'Sued in March 2019, he lost the appeal in 2022.', severity: 'medium' }),
  ]));
  const date = (t) => report.sections.flatMap((s) => s.items).find((f) => f.title === t).date;
  expect(date('A')).toBe('2021-07');
  expect(date('B')).toBe('2020-09-10');
  expect(date('C')).toBe('2018-03');
  expect(date('D')).toBeNull();
  expect(date('E')).toBe('2022');
});

test('the timeline leaves out name-only records, same-name companies and further coverage, and keeps red flags', () => {
  const report = buildReport(state([
    rec({ source: 'doj-press-releases', category: 'press', title: 'John Smith convicted of wire fraud in Manhattan', url: 'https://justice.test/1', date: '2022-10-14', severity: 'high' }),
    rec({ title: 'Manhattan jury convicts John Smith of wire fraud', url: 'https://paper.test/1', date: '2022-10-15', severity: 'high', category: 'litigation' }),
    rec({ category: 'corporate', title: 'Zeta Holdings incorporated', url: 'https://reg.test/1', date: '1971-01-01', match: 'company', excludeFromTimeline: true }),
    rec({ category: 'corporate', title: 'Zeta Trading registered', url: 'https://reg.test/2', date: '1985-01-01', match: 'company', data: { excludeFromTimeline: true } }),
    rec({ category: 'career', title: 'A John Smith joins a bank', url: 'https://x.test/1', date: '1999-01-01', match: 'possible' }),
    rec({ category: 'career', title: 'John Smith founds Zeta', url: 'https://x.test/2', date: '2014-03-01' }),
  ]));
  expect(report.timeline.map((t) => t.title)).toEqual(['John Smith founds Zeta', 'John Smith convicted of wire fraud in Manhattan']);
});

test('coverage names partial answers, disabled sources, missing court dockets and non-English searches', () => {
  const s = state([], {
    sources: {
      'web-archive': { label: 'Web archive', runs: 30, findings: 4, errors: 17, lastError: 'HTTP 429' },
      'web-search': { label: 'Web search', runs: 10, findings: 3, errors: 1, lastError: 'timeout' },
      'court-dockets': { label: 'CourtListener', runs: 0, findings: 0, errors: 0, off: true, lastError: 'Needs an API token.' },
      'fr-companies': { label: 'French registry', runs: 2, findings: 1, errors: 0 },
    },
  });
  const report = buildReport(s);
  expect(report.coverage.partlyAnswered).toEqual([{ label: 'Web archive', failed: 17, lookups: 30, reason: '17 of 30 lookups failed: HTTP 429' }]);
  expect(report.coverage.notSearched).toEqual([{ label: 'CourtListener', reason: 'Needs an API token.', off: true }]);
  expect(report.coverage.notCovered[0]).toMatch(/CourtListener is not enabled.*state courts.*Chancery/);
  expect(report.coverage.notCovered).toContain('Most non-English press, and sources behind a login or paywall');
  expect(report.coverage.notCovered.some((x) => /not in English/.test(x))).toBe(false);
  const brief = quotedDeepBrief(report, 'test');
  expect(brief).toMatch(/CourtListener: not enabled on this deployment\./);
  expect(brief).not.toMatch(/CourtListener did not answer/);
  expect(brief).toMatch(/Web archive answered only in part: 17 of 30 lookups failed: HTTP 429/);
});

test('a search run in another language counts as non-English coverage; nothing special keeps the fixed list', () => {
  const plain = buildReport(state([], { sources: { 'web-search': { label: 'Web search', runs: 3, findings: 0, errors: 0 } } }));
  expect(plain.coverage.notCovered).toBe(NOT_COVERED);
  expect(plain.coverage.partlyAnswered).toEqual([]);
  const fr = buildReport(state([], {
    sources: { 'web-search': { label: 'Web search', runs: 3, findings: 0, errors: 0 } },
    done: ['web-search|subject|John Smith|adverse-fr'],
  }));
  expect(fr.coverage.notCovered).toContain('Most non-English press, and sources behind a login or paywall');
});
