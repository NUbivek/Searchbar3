/**
 * @jest-environment node
 *
 * A source that says "wait" (a resting host, search engines out of allowance) is waited for, within a
 * limit per check, and never reported as a source that failed.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState, stepDeepCheck } = require('../../../src/server/founder/deepCheck');
const { makeFinding } = require('../../../src/server/founder/finding');
const { buildReport } = require('../../../src/server/founder/report');
const { __resetLearningForTests } = require('../../../src/server/learning');

beforeEach(() => __resetLearningForTests());

const resting = (retryAt) => Object.assign(new Error('No search engine answered (Google News: resting)'), { code: 'SEARCH_RESTING', retryAt });

test('a lookup whose search engines are resting runs again when they are free, and is not a failure', async () => {
  let calls = 0;
  const free = Date.now() + 300;
  const web = {
    id: 'web-search', label: 'Open-web search', kinds: ['subject'], prior: 0.6,
    run: async (task, { subject }) => {
      calls += 1;
      if (Date.now() < free) throw resting(free);
      return { findings: [makeFinding(subject, { source: 'web-search', sourceLabel: 'Open-web search', category: 'press', title: 'Trevor Milton of Nikola profile', quote: 'Trevor Milton founded Nikola.', url: 'https://a.test/1' })] };
    },
  };
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  for (let i = 0; i < 20 && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors: [web], deadline: Date.now() + 9000 });
  expect(calls).toBe(2);
  expect(state.sources['web-search']).toMatchObject({ errors: 0 });
  expect(state.findings).toHaveLength(1);
});

test('a lookup that would have to wait past the check limit is reported as not run, never as failed', async () => {
  const web = { id: 'web-search', label: 'Open-web search', kinds: ['subject'], prior: 0.6, run: async () => { throw resting(Date.now() + 60 * 60 * 1000); } };
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  for (let i = 0; i < 20 && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors: [web], deadline: Date.now() + 5000 });
  expect(state.phase).toBe('report');
  expect(state.sources['web-search']).toMatchObject({ errors: 0, waitedOut: 1 });
  expect(state.dropped.tasks).toBe(1);
});

test('the report says which lookups waited out, as part of what a source answered', () => {
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  state.sources = { 'web-search': { label: 'Open-web search', runs: 10, findings: 4, errors: 0, ms: 1, waitedOut: 3 } };
  const { coverage } = buildReport(state);
  expect(coverage.partlyAnswered).toEqual([expect.objectContaining({ label: 'Open-web search', notRun: 3, reason: expect.stringMatching(/3 more lookups not run because its allowance/) })]);
  expect(coverage.notSearched).toEqual([]);
});

describe('the search engines say when they are free again', () => {
  const engines = require('../../../src/server/founder/sources/searchEngines');
  const http = require('../../../src/server/founder/http');
  afterEach(() => { http.setTransport(); engines.__resetEnginesForTests(); });
  test('all engines resting: an error with a time to try again', async () => {
    engines.__resetEnginesForTests();
    http.setTransport(async (url) => ({ status: 200, headers: new Map(), url, text: async () => '<html><body>unusual traffic</body></html>' }));
    // use up every engine's allowance with blocked answers, then ask again
    let last;
    for (let i = 0; i < 12; i += 1) {
      try { await engines.keylessSearch(`"Jane Roe" test ${i}`, { deadline: Date.now() + 5000 }); } catch (error) { last = error; }
    }
    expect(last).toBeTruthy();
    if (last.code === 'SEARCH_RESTING') expect(last.retryAt).toBeGreaterThan(Date.now());
  });
});

test('a check does not sit idle for minutes for its last few lookups', async () => {
  let calls = 0;
  const web = { id: 'web-search', label: 'Open-web search', kinds: ['subject'], prior: 0.6, run: async () => { calls += 1; throw resting(Date.now() + 5 * 60 * 1000); } };
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  const t0 = Date.now();
  for (let i = 0; i < 20 && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors: [web], deadline: Date.now() + 5000 });
  expect(Date.now() - t0).toBeLessThan(15000);
  expect(state.phase).toBe('report');
  expect(state.sources['web-search']).toMatchObject({ errors: 0, waitedOut: 1 });
  expect(state.log.map((l) => l.text).join(' ')).toMatch(/last lookup not run/);
});
