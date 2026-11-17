/**
 * Third round of report fixes from grading real checks: rare events grouped by a date window, dates read
 * from the event's own sentence, a company's insolvency after the person left it, departures and
 * buy-backs filed as business history, and the courts and regulators of the company's country.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const { buildReport, quotedDeepBrief, NOT_COVERED } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
const rec = (o) => ({ id: `r${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', severity: 'high', quote: '', match: 'confirmed', ...o });
function state(findings, extra = {}) {
  const s = startState({ name: 'John Smith', company: 'Zeta' });
  s.findings = findings;
  return Object.assign(s, extra);
}

test('reports of one conviction are one red flag across a month boundary, whatever their headline words', () => {
  const report = buildReport(state([
    rec({ title: 'Jury convicts John Smith of securities fraud', url: 'https://a.test/1', date: '2022-10-14' }),
    rec({ title: 'Zeta founder John Smith found guilty on three counts', url: 'https://b.test/1', date: '2022-10-15' }),
    rec({ title: 'What the John Smith verdict means for electric trucks', url: 'https://c.test/1', date: '2022-11-02' }),
    // a conviction more than a month after the last report is another matter
    rec({ title: 'John Smith convicted again in a separate tax case', url: 'https://d.test/1', date: '2023-03-20' }),
    // the sentence is another kind of event
    rec({ title: 'John Smith sentenced to four years in prison', url: 'https://e.test/1', date: '2023-12-18' }),
  ]));
  expect(report.redFlags).toHaveLength(3);
  const conviction = report.redFlags.find((r) => r.more.length > 0);
  expect([conviction.url, ...conviction.more.map((m) => m.url)].sort()).toEqual(['https://a.test/1', 'https://b.test/1', 'https://c.test/1']);
});

test('two lawsuits in one month still need shared headline words to be one matter', () => {
  const report = buildReport(state([
    rec({ title: 'John Smith sued by former landlord over unpaid rent', url: 'https://a.test/2', date: '2021-05-03', severity: 'medium' }),
    rec({ title: 'Investors file lawsuit against John Smith over token sale', url: 'https://b.test/2', date: '2021-05-20', severity: 'medium' }),
  ]));
  expect(report.redFlags).toHaveLength(2);
});

test('a name-only report of the same event within three days stays a possible namesake, marked as maybe the same story', () => {
  const report = buildReport(state([
    rec({ title: 'Zeta founder John Smith receives a pardon', url: 'https://a.test/3', date: '2025-03-28' }),
    rec({ title: 'John Smith among those pardoned this week', url: 'https://b.test/3', date: '2025-03-30', match: 'possible' }),
    rec({ title: 'John Smith pardoned for a 1990 burglary', url: 'https://c.test/3', date: '2019-06-01', match: 'possible' }),
  ]));
  expect(report.redFlags).toHaveLength(1);
  expect(report.redFlags[0].more).toEqual([]);
  const near = report.possibleNamesake.find((p) => p.url === 'https://b.test/3');
  const far = report.possibleNamesake.find((p) => p.url === 'https://c.test/3');
  expect(near.sameStoryAs).toBe(report.redFlags[0].n);
  expect(far.sameStoryAs).toBeUndefined();
  expect(quotedDeepBrief(report, 'test')).toMatch(new RegExp(`same story`));
});

test('an encyclopaedia record is dated from the sentence that reports its event, not a later date in the quote', () => {
  const revised = { revisedAt: '2026-11-09T10:00:00Z' };
  const report = buildReport(state([
    rec({ source: 'wikipedia', category: 'career', title: 'John Smith resigned as chief executive of Zeta', url: 'https://w.test/a', date: '2026-11-09', data: revised, severity: 'info', quote: 'In September 2020, Smith resigned as chief executive. In September 2024 an arbitrator ordered him to repay $165 million.' }),
    // several dates and no sentence giving the event and a date: undated
    rec({ source: 'wikipedia', category: 'career', title: 'John Smith resigned from the board', url: 'https://w.test/b', date: '2026-11-09', data: revised, severity: 'info', quote: 'Smith resigned from the board. Filings dated March 2019 and May 2021 list his shares.' }),
    rec({ source: 'wikipedia', category: 'litigation', title: 'John Smith indicted', url: 'https://w.test/c', date: '2021', severity: 'info', quote: 'He was indicted on July 29, 2021 by a grand jury. A trial was set for December 2021.' }),
  ]));
  const date = (url) => report.sections.flatMap((s) => s.items).find((f) => f.url === url).date;
  expect(date('https://w.test/a')).toBe('2020-09');
  expect(date('https://w.test/b')).toBeNull();
  expect(date('https://w.test/c')).toBe('2021-07-29');
});

test("a company's insolvency after the person left it is a low company matter, not a personal red flag", () => {
  const anchors = { roles: [{ org: 'Zeta', role: 'ceo', from: '2010', to: '2019-09' }] };
  const after = rec({ title: 'Zeta, once led by John Smith, files for Chapter 11 bankruptcy', url: 'https://a.test/5', date: '2023-11-07' });
  const during = rec({ title: 'Zeta under John Smith nears bankruptcy', url: 'https://b.test/5', date: '2019-03-01' });
  const fraud = rec({ title: 'Zeta bankruptcy examiner says John Smith committed fraud', url: 'https://c.test/5', date: '2024-02-01' });
  const report = buildReport(state([after, during, fraud], { anchors }));
  const moved = report.companyMatters.find((m) => m.url === 'https://a.test/5');
  expect(moved).toMatchObject({ severity: 'low', afterTenure: { org: 'Zeta', to: '2019-09' } });
  expect(moved.title).toMatch(/after the person left Zeta in 2019-09/);
  expect(report.redFlags.map((r) => r.url).sort()).toEqual(['https://b.test/5', 'https://c.test/5']);
  // without a known end of the role nothing moves
  const plain = buildReport(state([{ ...after }]));
  expect(plain.redFlags.map((r) => r.url)).toEqual(['https://a.test/5']);
});

test('a departure or buy-back bid with no court term is business history, not litigation', () => {
  const report = buildReport(state([
    rec({ category: 'litigation', title: 'John Smith steps down as Zeta chief executive', url: 'https://a.test/6', date: '2019-09-24', severity: 'medium' }),
    rec({ category: 'litigation', title: 'John Smith makes a bid to buy back Zeta', url: 'https://b.test/6', date: '2024-03-01', severity: 'low' }),
    rec({ category: 'litigation', title: 'John Smith steps down after lawsuit', url: 'https://c.test/6', date: '2018-01-10', severity: 'medium' }),
  ]));
  const section = (url) => report.sections.find((s) => s.items.some((f) => f.url === url)).key;
  expect(section('https://a.test/6')).toBe('career');
  expect(section('https://b.test/6')).toBe('corporate');
  expect(section('https://c.test/6')).toBe('litigation');
});

test("the courts and regulators of the company's country are listed as not covered", () => {
  const fr = buildReport(state([rec({ source: 'fr-companies', category: 'corporate', title: 'Zeta SAS', url: 'https://f.test/1', severity: 'info', match: 'company' })]));
  expect(fr.coverage.notCovered).toContain('French court decisions (Judilibre/Légifrance) and AMF enforcement decisions');
  const jp = buildReport(state([rec({ source: 'lei-register', category: 'corporate', title: 'Zeta KK', url: 'https://l.test/1', severity: 'info', match: 'company', data: { jurisdiction: 'JP' } })]));
  expect(jp.coverage.notCovered).toContain('Court decisions and financial-regulator enforcement in Japan');
  // a register record matched by name only places nothing, and a US company adds nothing
  const namesake = buildReport(state([rec({ source: 'fr-companies', category: 'corporate', title: 'Zeta SARL', url: 'https://f.test/2', severity: 'info', match: 'possible' })]));
  expect(namesake.coverage.notCovered).toBe(NOT_COVERED);
  const us = buildReport(state([rec({ source: 'lei-register', category: 'corporate', title: 'Zeta Inc', url: 'https://l.test/2', severity: 'info', match: 'company', data: { jurisdiction: 'US-DE' } })]));
  expect(us.coverage.notCovered).toBe(NOT_COVERED);
});
