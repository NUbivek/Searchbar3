/**
 * Round 4 (review 2026-11-21), the changes asked for by the engineers who finished before the suite pass:
 * each test names the request it covers.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const { buildReport, reportCompanyFacts } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
const rec = (o) => ({ id: `su-${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', severity: 'info', quote: '', match: 'confirmed', matchReasons: [], url: `https://su.test/${seq}`, ...o });
function state(name, company, findings, extra = {}) {
  const s = startState({ name, company });
  s.findings = findings;
  return Object.assign(s, extra);
}
const items = (report) => report.sections.flatMap((s) => s.items);

describe('sources-company: the founding year marks only the company\'s own domains as an earlier holder\'s', () => {
  const founded = [
    rec({ title: 'Zetafold was founded in 2021', quote: 'Zetafold was founded in 2021 by Jane Roe.', category: 'corporate' }),
    rec({ title: 'Jane Roe profile', quote: 'Jane Roe co-founded Zetafold in 2021.', category: 'career' }),
  ];
  test('the domain of an earlier start-up keeps its history', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      ...founded,
      rec({ title: 'oldventure.com: registered 2012-05-01', source: 'domain-history', category: 'corporate', match: 'likely', date: '2012-05-01', data: { domain: 'oldventure.com', registered: '2012-05-01' } }),
    ]));
    const domain = items(report).find((f) => f.source === 'domain-history');
    expect(domain.data.earlierHolder).toBeUndefined();
  });
  test("the company's own domain registered before the founding is still marked", () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      ...founded,
      rec({ title: 'zetafold.com: registered 2012-05-01', source: 'domain-history', category: 'corporate', match: 'company', date: '2012-05-01', data: { domain: 'zetafold.com', registered: '2012-05-01' } }),
    ]));
    const domain = items(report).find((f) => f.source === 'domain-history');
    expect(domain.data.earlierHolder).toBe(true);
  });
  test('a domain whose own founding year the source gave is judged by that year', () => {
    const report = buildReport(state('Jane Roe', 'Zetafold', [
      ...founded,
      rec({ title: 'zf.io: registered 2012-05-01', source: 'domain-history', category: 'corporate', match: 'company', date: '2012-05-01', data: { domain: 'zf.io', registered: '2012-05-01', foundedYear: 2021 } }),
    ]));
    const domain = items(report).find((f) => f.source === 'domain-history');
    expect(domain.data.earlierHolder).toBe(true);
  });
});

describe('live-funding-junk: a company fact with no record among the report\'s sources is not shown', () => {
  test('entries whose cites are empty are dropped, and founded needs a cite', () => {
    const cite = (ids) => (ids || []).filter((id) => id === 'r1').map(() => 1);
    const out = reportCompanyFacts({
      funding: [{ amount: '$2B', ids: ['r10'] }, { round: 'Series A', amount: '$10M', ids: ['r1'] }],
      investors: [{ name: 'Ghost Capital', ids: [] }],
      standing: [{ text: 'valued at $1B', ids: ['r9'] }],
      legalNames: [{ name: 'Zetafold, Inc.', ids: ['r1'] }],
      domains: [{ domain: 'nowhere.com', ids: ['r7'] }],
      founded: { year: 2019, ids: ['r8'] },
    }, cite, { company: 'Zetafold' });
    expect(out.funding).toEqual([expect.objectContaining({ amount: '$10M', cites: [1] })]);
    expect(out.investors).toEqual([]);
    expect(out.standing).toEqual([]);
    expect(out.domains).toEqual([]);
    expect(out.founded).toBeNull();
    expect(out.legalNames).toHaveLength(1);
  });
  test('nothing cited at all is no company facts', () => {
    expect(reportCompanyFacts({ funding: [{ amount: '$2B', ids: ['r10'] }] }, () => [], {})).toBeNull();
  });
});

describe('loop-given-earlier-companies-unscreened: coverage says which typed earlier companies were screened', () => {
  test('a typed venture is screened; a very large employer is checked only for ties to the person', () => {
    const s = startState({ name: 'Jane Roe', company: 'Zetafold', otherCompanies: ['Oldco Labs', 'Google'] });
    s.findings = [];
    s.threads = {
      a: { kind: 'company', value: 'Oldco Labs', why: 'an earlier company given', trusted: true, tie: 'affiliate', venture: true },
      b: { kind: 'company', value: 'Google', why: 'an earlier company given', trusted: true, tie: 'affiliate' },
      c: { kind: 'company', value: 'Zetafold', why: 'the company given', trusted: true, tie: 'primary' },
    };
    const report = buildReport(s);
    expect(report.coverage.givenCompanies).toEqual([
      { name: 'Oldco Labs', screened: true },
      { name: 'Google', screened: false },
    ]);
  });
});

describe('resume-note-not-rendered: a model-read profile keeps the note and the program', () => {
  const { mergeProfile } = require('../../../src/server/founder/profileModel');
  test('"left without a degree" and "Y Combinator S15" survive the merge', () => {
    const out = mergeProfile(
      { education: [{ school: 'Stanford University', note: 'left without a degree', cites: [2] }], founded: [{ org: 'Zetafold', program: 'Y Combinator S15', cites: [3] }] },
      { education: [{ school: 'Stanford University', degree: null, cites: [1] }], founded: [{ org: 'Zetafold', year: 2015, cites: [1] }] },
    );
    expect(out.education[0].note).toBe('left without a degree');
    expect(out.founded[0].program).toBe('Y Combinator S15');
  });
});
