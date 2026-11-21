/**
 * Final pass (suite): the brief-side halves of the report fields added in round 3.
 * The person's own posts are never a red flag in the AI brief; a record about an earlier holder of a domain
 * (or one kept off the timeline) never makes a claim "check out"; the search-coverage note reaches the model.
 */
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(),
  PROVIDERS: [{ id: 'groq' }],
  providerEnabled: jest.fn(() => true),
}));
const { buildReport, writeDeepBrief, DEEP_SECTIONS } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');

let seq = 0;
const rec = (o) => ({ id: `s${(seq += 1)}`, source: 'news-archive', sourceLabel: 'News', category: 'press', severity: 'info', quote: '', match: 'confirmed', matchReasons: [], ...o });
const section = (brief, heading) => (brief.split(`## ${heading}\n`)[1] || '').split('\n## ')[0];

function build() {
  const s = startState({ name: 'Jane Roe', company: 'Zeta' });
  s.findings = [
    rec({ title: 'Jane Roe, CEO of Zeta, charged with securities fraud', quote: 'Jane Roe, chief executive of Zeta, was charged with securities fraud.', url: 'https://m.test/1', category: 'regulatory', severity: 'high', date: '2024-02-01', source: 'doj-press-releases', sourceLabel: 'US Department of Justice' }),
    rec({ title: 'Jane Roe founded Zeta in 2019', quote: 'Jane Roe founded Zeta in 2019 after five years at Acme Bank.', url: 'https://m.test/2', category: 'career', date: '2019-01-01' }),
    rec({ title: 'Jane Roe: I was sued by my landlord over unpaid rent', quote: 'In a post, Jane Roe wrote that she was sued by her landlord over unpaid rent.', url: 'https://m.test/3', category: 'press', date: '2022-01-01', data: { ownStatement: true } }),
    rec({ title: 'zeta.test was registered in 2009', quote: 'The domain zeta.test was first registered in 2009 by an earlier holder.', url: 'https://m.test/4', category: 'career', date: '2009-01-01', source: 'domain-history', sourceLabel: 'Domain history', data: { earlierHolder: true } }),
  ];
  const report = buildReport(s);
  report.coverage.searchNote = 'Web search answered 3 of 9 searches';
  return report;
}
const n = (report, re) => report.sources.find((x) => re.test(x.title)).n;

function answer(report, edits = {}) {
  const fraud = n(report, /securities fraud/);
  const founded = n(report, /founded Zeta/);
  const body = {
    'BOTTOM LINE': `Jane Roe founded Zeta in 2019 [Source ${founded}]. She was charged with securities fraud in 2024 [Source ${fraud}].`,
    'RED FLAGS': `• Charged with securities fraud, February 2024 [Source ${fraud}]`,
    'CAREER AND EDUCATION': `• Founded Zeta in 2019 [Source ${founded}]`,
    COMPANY: `• Zeta was founded in 2019 [Source ${founded}]`,
    'WHAT CHECKS OUT': `• The Justice Department record names her as Zeta's chief executive [Source ${fraud}]`,
    'CLAIMS THAT CHANGED OVER TIME': 'None found.',
    'RELATED PARTIES': 'None found.',
    'PUBLIC-RECORD SCREENS': '• Sanctions and watchlists: not asked in this check.',
    'GAPS AND UNVERIFIED CLAIMS': '• Her years at Acme Bank are stated only in a press profile.',
    'QUESTIONS FOR THE FOUNDER': '• What is the status of the 2024 charges?\n• Confirm the years at Acme Bank.\n• Share the incorporation papers of Zeta.\n• Has any regulator contacted Zeta?',
    ...edits,
  };
  return `${DEEP_SECTIONS.map((h) => `${h}\n${body[h.slice(3)]}`).join('\n\n')}\nCONFIDENCE: Medium - official record`;
}
async function run(report, text) {
  const complete = jest.fn(async (messages, o) => (o.accept(text) ? { text, providerLabel: 'G', model: 'm' } : null));
  return { ...(await writeDeepBrief(report, { complete })), complete };
}

test('a red flag that cites only the person\'s own post is removed', async () => {
  const report = build();
  const own = n(report, /landlord/);
  const fraud = n(report, /securities fraud/);
  const { brief, briefInfo } = await run(report, answer(report, { 'RED FLAGS': `• Charged with securities fraud, February 2024 [Source ${fraud}]\n• Sued by a landlord over unpaid rent [Source ${own}]` }));
  expect(briefInfo.mode).toBe('ai');
  expect(section(brief, 'RED FLAGS')).toMatch(/securities fraud/);
  expect(section(brief, 'RED FLAGS')).not.toMatch(/landlord/);
});

test('what checks out never rests only on an earlier holder\'s domain record', async () => {
  const report = build();
  const dom = n(report, /earlier holder/);
  const fraud = n(report, /securities fraud/);
  const { brief, briefInfo } = await run(report, answer(report, { 'WHAT CHECKS OUT': `• The Justice Department record names her as Zeta's chief executive [Source ${fraud}]\n• The zeta.test domain dates from 2009 [Source ${dom}]` }));
  expect(briefInfo.mode).toBe('ai');
  expect(section(brief, 'WHAT CHECKS OUT')).toMatch(/Justice Department/);
  expect(section(brief, 'WHAT CHECKS OUT')).not.toMatch(/2009/);
});

test('the coverage text given to the model carries the search note', async () => {
  const report = build();
  const { complete } = await run(report, answer(report));
  expect(complete.mock.calls[0][0][1].content).toMatch(/Web search answered 3 of 9 searches/);
});
