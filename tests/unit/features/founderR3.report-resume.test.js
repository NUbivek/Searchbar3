/**
 * The report reads profile.resume and profile.companyFacts (design decision 2): dated career and company
 * events reach the timeline with their citations, earlier employers in the resume tie a broker record, and
 * the report's own leads join the resume's.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
jest.mock('../../../src/server/founder/profile', () => {
  const actual = jest.requireActual('../../../src/server/founder/profile');
  return {
    ...actual,
    buildProfile: (subject, findings, threads) => ({
      ...actual.buildProfile(subject, findings, threads),
      resume: {
        roles: [
          { org: 'Ramp', title: 'Co-CEO', from: 2019, to: null, current: true, ids: ['bio1'], basis: 'text' },
          { org: 'Paribus', title: 'Co-Founder and CEO', from: 2014, to: 2019, current: false, ids: ['bio1', 'bio2'], basis: 'text' },
        ],
        education: [{ school: 'Harvard University', degree: 'BA', field: 'Economics', from: null, to: 2012, ids: ['bio2'], basis: 'text' }],
        founded: [{ org: 'Paribus', year: 2014, with: [], outcome: 'acquired by Capital One in 2016', ids: ['bio1'] }],
        boards: [], investments: [], recognition: [],
        leads: [{ text: 'Financial analyst in New York, 2012 to 2014', why: 'one profile names the firm', ids: ['bio2'] }],
      },
      companyFacts: { legalNames: [], domains: [], founded: { year: 2019, ids: ['bio1'] }, funding: [{ round: 'Series D', amount: '$300M', date: '2025-11', lead: 'Lightspeed', investors: [], ids: ['bio2'] }], investors: [], standing: [] },
    }),
  };
});
const { buildReport } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

const rec = (o) => ({ source: 'web-search', sourceLabel: 'Web', category: 'career', severity: 'info', quote: '', match: 'confirmed', matchReasons: [], ...o });
function state(findings) {
  const s = startState({ name: 'Eric Glyman', company: 'Ramp' });
  s.findings = findings;
  return s;
}

test('dated resume and company events are on the timeline with their citations', () => {
  const report = buildReport(state([
    rec({ id: 'bio1', title: 'Eric Glyman, co-CEO of Ramp', url: 'https://a.test/1' }),
    rec({ id: 'bio2', title: 'Eric Glyman profile', url: 'https://a.test/2' }),
    rec({ id: 'dom', source: 'domain-history', category: 'corporate', match: 'company', title: 'ramp.com: registered 1994-03-14', url: 'https://rdap.org/domain/ramp.com', date: '1994-03-14', data: { domain: 'ramp.com', registered: '1994-03-14' } }),
  ]));
  const rows = report.timeline.map((t) => `${t.date}|${t.title}`);
  expect(rows).toEqual(expect.arrayContaining([
    '2014|Founded Paribus (acquired by Capital One in 2016)',
    '2012|BA in Economics, Harvard University',
    '2019|Ramp founded',
    '2025-11|Ramp raised $300M Series D, led by Lightspeed',
  ]));
  expect(rows.some((r) => r.startsWith('1994'))).toBe(false);
  // the founding year comes from the company facts
  expect(report.sections.flatMap((s) => s.items).find((f) => f.source === 'domain-history').title).toMatch(/earlier holder.*founded in 2019/);
  expect(report.timeline.every((t) => t.n >= 1)).toBe(true);
  expect(report.companyFacts.funding[0].cites).toEqual([2]);
  expect(report.profile.roles[0]).toMatchObject({ org: 'Ramp', title: 'Co-CEO', current: true });
  expect(report.profile.education[0]).toMatchObject({ degree: 'BA', field: 'Economics' });
});

test('an earlier employer from the resume ties a minor broker record; the report adds its lead to the resume leads', () => {
  const report = buildReport(state([
    rec({ id: 'bio1', title: 'Eric Glyman, co-CEO of Ramp', url: 'https://a.test/1' }),
    rec({ id: 'bio2', title: 'Eric Glyman profile', url: 'https://a.test/2' }),
    rec({ id: 'fin', source: 'finra-brokercheck', category: 'regulatory', match: 'possible', title: 'Eric Glyman (CRD 9)', quote: 'Eric Glyman, CRD 9. Firms: Paribus Securities (2015 to 2016).', url: 'https://finra.test/9', date: '2015' }),
    rec({ id: 'bad', source: 'news-archive', category: 'press', severity: 'high', match: 'possible', title: 'Eric Glyman of Paribus indicted', url: 'https://n.test/1', date: '2016-01-01' }),
  ]));
  const all = report.sections.flatMap((s) => s.items);
  expect(all.find((f) => f.id === 'fin').match).toBe('likely');
  expect(all.find((f) => f.id === 'bad').match).toBe('possible');
  expect(report.redFlags).toHaveLength(0);
  expect(report.profile.leads.map((l) => l.text)).toEqual(['Financial analyst in New York, 2012 to 2014', 'Eric Glyman of Paribus indicted']);
});
