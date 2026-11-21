/**
 * @jest-environment node
 *
 * Three things seen in a real browser on a live report (Eric Glyman / Ramp, 2026-11-21): the brief's gaps list
 * printed the internal names of twenty search questions, its screens section named every source (4,000
 * characters), and six sources each got a line for lookups left unrun when the check ended.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState } = require('../../../src/server/founder/deepCheck');
const { buildReport, quotedDeepBrief } = require('../../../src/server/founder/report');

function report() {
  const state = startState({ name: 'Eric Glyman', company: 'Ramp' });
  const src = (label, extra = {}) => ({ label, runs: 4, findings: 0, errors: 0, ms: 1, ...extra });
  state.sources = {
    'web-search': src('Open-web search', { runs: 30, findings: 12, partial: Array.from({ length: 19 }, (_, i) => `open web: q.topic-${i} (news headlines or the encyclopedia only)`).concat(['open web: q.resume (the page could not be read)']) }),
    bluesky: src('Bluesky public profiles', { notRun: 14 }),
    'stack-overflow': src('Stack Overflow public profiles', { notRun: 12 }),
    mastodon: src('Mastodon public profiles', { notRun: 12 }),
    'sanctions-lists': src('Sanctions lists (US, UN, EU, UK, Canada)'),
    'us-exclusions': src('US federal exclusion lists (SAM.gov, HHS OIG)'),
    'cfpb-complaints': src('US consumer complaints about financial companies (CFPB)'),
    'fda-recalls': src('US FDA recalls and enforcement reports (openFDA)'),
    'fincen-actions': src('FinCEN enforcement actions (US anti-money-laundering regulator)'),
  };
  return buildReport(state);
}

test('the gaps list counts headline-only questions and never prints a question\'s internal name', () => {
  const r = report();
  const brief = quotedDeepBrief(r, 'no model');
  expect(brief).not.toMatch(/\bq\.[a-z]/);
  expect(brief).toMatch(/19 questions were answered from news headlines or the encyclopedia only/);
  const web = r.coverage.partlyAnswered.find((s) => s.label === 'Open-web search');
  expect(web.reason).not.toMatch(/\bq\.[a-z]/);
  expect(web.parts).toHaveLength(20); // the detail stays in the data
});

test('sources whose only shortfall is lookups left unrun at the end share one line', () => {
  const brief = quotedDeepBrief(report(), 'no model');
  expect(brief).toMatch(/38 lower-priority lookups were left unrun when the check ended, in 3 sources that answered the rest: Bluesky public profiles, Stack Overflow public profiles, Mastodon public profiles/);
  expect(brief).not.toMatch(/Bluesky public profiles answered only in part/);
});

test('the screens section names watchlist screens and counts the rest', () => {
  const brief = quotedDeepBrief(report(), 'no model');
  const section = brief.slice(brief.indexOf('## PUBLIC-RECORD SCREENS'), brief.indexOf('## GAPS'));
  expect(section).toMatch(/Sanctions and watchlists: no match in Sanctions lists \(US, UN, EU, UK, Canada\), US federal exclusion lists/);
  expect(section).toMatch(/Regulators and filings: 3 screens answered with no match/);
  expect(section).not.toMatch(/FinCEN enforcement actions/);
});
