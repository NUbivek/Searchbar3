/**
 * Learning from outcomes: options that have worked are tried first, options
 * tried rarely still get a turn, and nothing breaks without a database.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), persistenceMode: jest.fn(() => 'none') }));
const db = require('../../../src/server/db');
const { recordStats, loadStats, rankByLearning, expectedValue, __resetLearningForTests } = require('../../../src/server/learning');

beforeEach(() => { __resetLearningForTests(); db.query.mockClear(); db.persistenceMode.mockReturnValue('none'); });

test('with no evidence, options keep their prior order', async () => {
  const ranked = rankByLearning([{ key: 'a', prior: 0.8 }, { key: 'b', prior: 0.4 }], await loadStats('query'));
  expect(ranked.map((x) => x.key)).toEqual(['a', 'b']);
});

test('an option that keeps winning overtakes one with a better prior that keeps failing', async () => {
  await recordStats('query', Array.from({ length: 12 }, () => ({ key: 'b', win: true, ms: 100 })));
  await recordStats('query', Array.from({ length: 12 }, () => ({ key: 'a', win: false, ms: 100 })));
  const stats = await loadStats('query');
  expect(stats.get('b')).toEqual({ tries: 12, wins: 12, totalMs: 1200 });
  expect(rankByLearning([{ key: 'a', prior: 0.8 }, { key: 'b', prior: 0.4 }], stats).map((x) => x.key)).toEqual(['b', 'a']);
  expect(expectedValue(stats.get('b'), 0.4)).toBeGreaterThan(0.75);
  expect(expectedValue(stats.get('a'), 0.8)).toBeLessThan(0.35);
});

test('an untried option gets an exploration bonus over a mediocre well-tried one', async () => {
  await recordStats('source', Array.from({ length: 40 }, (_, i) => ({ key: 'old', win: i % 2 === 0 })));
  const ranked = rankByLearning([{ key: 'old', prior: 0.5 }, { key: 'new', prior: 0.5 }], await loadStats('source'));
  expect(ranked[0].key).toBe('new');
  // with exploration off, equal expectations keep the given order
  expect(rankByLearning([{ key: 'old', prior: 0.5 }, { key: 'new', prior: 0.5 }], await loadStats('source'), { explore: 0 })[0].key).toBe('old');
});

test('partial credit and kinds are kept apart', async () => {
  await recordStats('model', [{ key: 'm1', win: 0.5 }, { key: 'm1', win: 1 }]);
  expect((await loadStats('model')).get('m1')).toMatchObject({ tries: 2, wins: 1.5 });
  expect((await loadStats('query')).has('m1')).toBe(false);
});

test('outcomes are written to the database when there is one, and a failing database is ignored', async () => {
  db.persistenceMode.mockReturnValue('pglite');
  db.query.mockResolvedValueOnce([{ key: 'seen', tries: 5, wins: 4, total_ms: 900 }]);
  expect((await loadStats('query')).get('seen')).toEqual({ tries: 5, wins: 4, totalMs: 900 });
  await recordStats('query', [{ key: 'seen', win: true, ms: 50 }]);
  expect(db.query).toHaveBeenLastCalledWith(expect.stringMatching(/INSERT INTO learning_stats/), ['query', 'seen', 1, 1, 50]);
  db.query.mockRejectedValueOnce(new Error('down'));
  await expect(recordStats('query', [{ key: 'seen', win: false }])).resolves.toBeUndefined();
  expect((await loadStats('query')).get('seen').tries).toBe(7);
});
