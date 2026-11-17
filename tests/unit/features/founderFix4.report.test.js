/**
 * Fourth round of report fixes from grading real checks: red flags ordered by the kind of event, a
 * company's insolvency after the person left it even when the record names them, minor step-down reports
 * joining the departure matter, records and roles of related parties, the screens that came back clean,
 * approximate dates and roles before a company's founding kept off the timeline, and encyclopaedia
 * articles about something else filed as background.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const { buildReport, quotedDeepBrief, cleanScreens } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
const rec = (o) => ({ id: `r${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', severity: 'medium', quote: '', match: 'confirmed', ...o });
function state(findings, extra = {}) {
  const s = startState({ name: 'John Smith', company: 'Zeta' });
  s.findings = findings;
  return Object.assign(s, extra);
}

test('red flags are ordered by the kind of event, not by record number', () => {
  const report = buildReport(state([
    // ranks first on score (high severity), but reports a deal
    rec({ title: 'John Smith refinancing talks, Zeta chair quoted', url: 'https://a.test/1', date: '2024-03-01', severity: 'high', quote: 'Smith said the refinancing would close soon.' }),
    rec({ title: 'Zeta filing shows John Smith related-party leases', url: 'https://b.test/1', date: '2019-08-14' }),
    rec({ title: 'John Smith steps down as Zeta chief under pressure', url: 'https://c.test/1', date: '2019-09-24' }),
    rec({ title: 'John Smith indicted on wire fraud charges', url: 'https://d.test/1', date: '2021-02-10' }),
    rec({ title: 'SEC charges John Smith over misleading statements', url: 'https://e.test/1', date: '2021-07-29', category: 'regulatory' }),
    rec({ title: 'Investors sue John Smith over token sale', url: 'https://f.test/1', date: '2020-01-10' }),
  ]));
  expect(report.redFlags.map((r) => r.url)).toEqual([
    'https://d.test/1', 'https://e.test/1', 'https://f.test/1', 'https://b.test/1', 'https://c.test/1', 'https://a.test/1',
  ]);
});

test("the insolvency of a company the person had left moves to company matters even when the record names them; a namesake's does not", () => {
  const anchors = { roles: [{ org: 'Zeta', role: 'ceo', from: '2010', to: '2019-09' }] };
  const report = buildReport(state([
    rec({ title: 'Zeta, founded by John Smith, goes bankrupt', url: 'https://a.test/2', date: '2023-11-07' }),
  ], { anchors }));
  expect(report.redFlags).toHaveLength(0);
  expect(report.companyMatters[0]).toMatchObject({ url: 'https://a.test/2', severity: 'low' });
  const namesake = buildReport(state([
    rec({ title: 'Zeta, founded by John Smith, goes bankrupt', url: 'https://b.test/2', date: '2023-11-07', match: 'possible' }),
  ], { anchors }));
  expect(namesake.companyMatters).toHaveLength(0);
  expect(namesake.possibleNamesake.map((p) => p.url)).toEqual(['https://b.test/2']);
});

test('minor step-down reports near the end of a known role join the departure red flag, and never make one alone', () => {
  const anchors = { roles: [{ org: 'Zeta', role: 'ceo', from: '2010', to: '2019-09-24' }] };
  const minor = [
    rec({ title: 'John Smith stepped down as Zeta CEO', url: 'https://b.test/3', date: '2019-09-25', severity: 'low', source: 'hacker-news' }),
    rec({ title: 'Zeta: John Smith steps down', url: 'https://c.test/3', date: '2019-10-02', severity: 'low' }),
    // years later: another matter
    rec({ title: 'John Smith steps down from a charity board', url: 'https://d.test/3', date: '2023-05-01', severity: 'low' }),
  ];
  const report = buildReport(state([
    rec({ title: 'John Smith forced out as Zeta chief under pressure', url: 'https://a.test/3', date: '2019-09-24' }),
    ...minor,
  ], { anchors }));
  expect(report.redFlags).toHaveLength(1);
  expect(report.redFlags[0].more.map((m) => m.url).sort()).toEqual(['https://b.test/3', 'https://c.test/3']);
  const alone = buildReport(state(minor.map((f) => ({ ...f })), { anchors }));
  expect(alone.redFlags).toHaveLength(0);
});

test('related parties get the records that list them or name them in full, and a role a record states', () => {
  const threads = {
    'associate|mark russell': { kind: 'associate', value: 'Mark Russell', trusted: true, role: null },
    'relative|jane smith': { kind: 'relative', value: 'Jane Smith', trusted: true, relation: 'sister', role: null },
    'associate|ann lee': { kind: 'associate', value: 'Ann Lee', trusted: true, role: null },
  };
  const report = buildReport(state([
    rec({ title: 'Zeta names Mark Russell, who became CEO after John Smith left', url: 'https://a.test/4', date: '2020-09-21', severity: 'info', quote: 'Mark Russell became CEO of Zeta.' }),
    rec({ title: 'Form D: Zeta Holdings', url: 'https://b.test/4', date: '2019-01-01', severity: 'info', source: 'sec-filings',
      data: { relatedPersons: [{ name: 'Jane Smith', roles: ['Director', 'Executive Officer'] }] } }),
    // name-only match for the subject: naming the party is not enough
    rec({ title: 'Ann Lee and John Smith at a gala', url: 'https://c.test/4', severity: 'info', match: 'possible' }),
    // the surname alone never attaches a record
    rec({ title: 'Smith family office invests in Zeta', url: 'https://d.test/4', severity: 'info', quote: 'Russell said nothing.' }),
  ], { threads }));
  const party = (name) => report.relatedParties.find((p) => p.name === name);
  expect(party('Mark Russell').records.map((r) => r.title)).toEqual(['Zeta names Mark Russell, who became CEO after John Smith left']);
  expect(party('Mark Russell').role).toBe('CEO');
  expect(party('Jane Smith').records.map((r) => r.title)).toEqual(['Form D: Zeta Holdings']);
  expect(party('Jane Smith').role).toBe('Director, Executive Officer');
  expect(party('Ann Lee').records).toEqual([]);
  expect(party('Ann Lee').role).toBeNull();
});

test('the brief lists the screens that came back clean, even with red flags', () => {
  const sources = {
    'sanctions-lists': { label: 'Sanctions lists', runs: 2, findings: 0, errors: 0 },
    'us-exclusions': { label: 'US exclusions', runs: 1, findings: 0, errors: 0 },
    'offshore-leaks': { label: 'ICIJ', runs: 1, findings: 0, errors: 0 },
    // a screen that found something, or failed a lookup, is not clean
    'wanted-lists': { label: 'Wanted lists', runs: 1, findings: 1, errors: 0 },
    'doj-press-releases': { label: 'DOJ', runs: 2, findings: 0, errors: 1 },
    gnews: { label: 'Google News', runs: 3, findings: 0, errors: 0 },
  };
  const report = buildReport(state([rec({ title: 'John Smith indicted', url: 'https://a.test/5', date: '2021-07-29' })], { sources }));
  expect(cleanScreens(report.coverage)).toEqual(['sanctions (US, UN, EU, UK, Canada)', 'US exclusion lists', 'ICIJ Offshore Leaks']);
  const brief = quotedDeepBrief(report, 'test');
  expect(brief).toMatch(/Screens with no match: sanctions \(US, UN, EU, UK, Canada\), US exclusion lists, ICIJ Offshore Leaks\./);
  expect(brief).not.toMatch(/Screens with no match:.*(?:wanted|DOJ)/);
});

test('approximate dates and roles that start before the company was founded stay off the timeline', () => {
  const report = buildReport(state([
    rec({ category: 'career', title: 'John Smith resigns from Zeta', url: 'https://a.test/6', date: '2024-09-01', severity: 'low', data: { dateApprox: true } }),
    rec({ category: 'career', source: 'wikidata', title: 'Zeta: chief executive officer John Smith (start time 2008-05)', url: 'https://b.test/6', date: '2008-05', severity: 'info', data: { roleStart: '2008-05', orgFounded: '2010' } }),
    rec({ category: 'career', title: 'John Smith joins Zeta board', url: 'https://c.test/6', date: '2012-01-01', severity: 'info' }),
  ]));
  expect(report.timeline.map((t) => t.title)).toEqual(['John Smith joins Zeta board']);
  expect(report.inconsistencies).toHaveLength(1);
  expect(report.inconsistencies[0].note).toMatch(/2008-05, before the company was founded \(2010\)/);
  expect(quotedDeepBrief(report, 'test')).toMatch(/Inconsistent record:/);
});

test('encyclopaedia articles about something else are background, at most three', () => {
  const other = (i) => rec({ title: `Article ${i} - Wikipedia`, url: `https://en.wikipedia.org/wiki/A${i}`, severity: 'info', match: 'possible',
    matchReasons: [`Wikipedia article about A${i}, not about the person`] });
  const report = buildReport(state([
    ...[1, 2, 3, 4, 5].map(other),
    rec({ title: 'John Smith profile', url: 'https://a.test/7', severity: 'info', data: { wikiKind: 'subject' } }),
  ]));
  const background = report.sections.find((s) => s.key === 'background');
  expect(background.title).toBe('Background');
  expect(background.items).toHaveLength(3);
  expect(report.sections.find((s) => s.key === 'press').items.map((f) => f.url)).toEqual(['https://a.test/7']);
  expect(report.totals.records).toBe(4);
});
