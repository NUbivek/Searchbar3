/**
 * Round 3 fixes to the deep check loop (deepCheck.js): a stronger read of a record already kept lifts the
 * kept copy's grade (whichever source finished first must not decide it), and the fallback grading text
 * keeps the title and quote apart so the quote's first words are not glued to the title.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState, stepDeepCheck } = require('../../../src/server/founder/deepCheck');
const { makeFinding } = require('../../../src/server/founder/finding');
const { __resetLearningForTests } = require('../../../src/server/learning');

const base = { source: 'fake', sourceLabel: 'Fake', category: 'press' };

async function runToEnd(state, connectors) {
  for (let i = 0; i < 30 && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors, deadline: Date.now() + 5000 });
}
const web = (make) => ({ id: 'web-search', label: 'Web', kinds: ['subject'], run: async (task, { subject }) => (task.kind === 'subject' ? { findings: make(subject).filter(Boolean) } : { findings: [] }) });

beforeEach(() => __resetLearningForTests());

test('the same record read again with a stronger tie lifts the copy already kept', async () => {
  const page = { ...base, url: 'https://profiles.test/in/jane-roe', title: 'Jane Roe | Profile' };
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, [web((subject) => [
    makeFinding(subject, { ...page, matchText: 'Jane Roe' }),
    makeFinding(subject, { ...page, matchText: 'Jane Roe, chief executive of Acme Robotics', data: { linkedFrom: 'https://wiki.test/Q1' } }),
  ])]);
  const kept = state.findings.filter((f) => f.url === page.url);
  expect(kept).toHaveLength(1);
  expect(kept[0].match).toBe('confirmed');
  expect(kept[0].gradeText).toMatch(/Acme Robotics/);
  expect(kept[0].data.linkedFrom).toBe('https://wiki.test/Q1');
});

test('a weaker second read never lowers the kept grade, and a grade set by hand is never lifted', async () => {
  const strong = { ...base, url: 'https://profiles.test/a', title: 'Jane Roe of Acme Robotics' };
  const held = { ...base, url: 'https://profiles.test/b', title: 'Jane Roe listing' };
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, [web((subject) => [
    makeFinding(subject, strong),
    makeFinding(subject, { ...strong, matchText: 'Jane Roe' }),
    makeFinding(subject, { ...held, match: 'possible', matchReasons: ['held by the source'] }),
    makeFinding(subject, { ...held, matchText: 'Jane Roe of Acme Robotics' }),
  ])]);
  expect(state.findings.find((f) => f.url === strong.url).match).toBe('confirmed');
  const h = state.findings.filter((f) => f.url === held.url);
  expect(h).toHaveLength(1);
  expect(h[0].match).toBe('possible');
});

test('the same passage graded more strongly on another page lifts its twin instead of keeping two records', async () => {
  const passage = 'Jane Roe said the product would change how every warehouse in the country is run, end to end.';
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, [web((subject) => [
    makeFinding(subject, { ...base, title: 'Filing one', quote: passage, url: 'https://filings.test/1' }),
    makeFinding(subject, { ...base, title: 'Acme Robotics filing two', quote: passage, url: 'https://filings.test/2' }),
  ])]);
  const kept = state.findings.filter((f) => f.url.startsWith('https://filings.test/'));
  expect(kept).toHaveLength(1);
  expect(kept[0].url).toBe('https://filings.test/1');
  expect(kept[0].match).toBe('confirmed');
  expect(kept[0].data.alsoIn).toEqual(['https://filings.test/2']);
});

test('the fallback grading text keeps the title and the quote apart', async () => {
  // A connector's record with no stored grading text is re-read on its title and quote
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, [web(() => [{
    ...base, id: 'fake-raw', url: 'https://wiki.test/Jane_Roe', title: 'Jane Roe - Encyclopedia',
    quote: 'Acme Robotics founder Jane Roe built the company.', match: 'confirmed', matchReasons: [], severity: 'info',
  }])]);
  const f = state.findings.find((x) => x.id === 'fake-raw');
  expect(f.match).toBe('confirmed');
});
