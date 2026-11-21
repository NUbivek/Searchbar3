/**
 * @jest-environment node
 */
const mockRows = new Map();
jest.mock('../../../src/server/db', () => ({
  persistenceMode: jest.fn(() => 'neon'),
  query: jest.fn(async (text, params) => {
    if (/INSERT INTO source_cache/.test(text)) mockRows.set(params[0], { body: params[1], fetched_at: new Date().toISOString() });
    return [];
  }),
  queryOne: jest.fn(async (text, params) => mockRows.get(params[0]) || null),
}));

const cache = require('../../../src/server/founder/cache');
const { HttpError } = require('../../../src/server/founder/http');

const { cached, __resetCacheForTests } = cache;
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  mockRows.clear();
  __resetCacheForTests();
  jest.clearAllMocks();
});

describe('cache R3: a load cut short by a deadline is not a failure', () => {
  test('an "Out of time" error is thrown to its caller but not remembered', async () => {
    const cut = jest.fn(async () => { throw new HttpError('Out of time before the request could start', { retryable: true, code: 'deadline' }); });
    await expect(cached('watchlist:x:v1', DAY, cut)).rejects.toThrow(/Out of time/);
    const loader = jest.fn(async () => ({ names: ['a'] }));
    await expect(cached('watchlist:x:v1', DAY, loader)).resolves.toEqual({ names: ['a'] });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('the loader gets its own deadline of at least 25 s; a caller whose deadline passes gets "Out of time" while the load goes on', async () => {
    let release;
    let given = null;
    const loader = jest.fn(({ deadline }) => { given = deadline; return new Promise((resolve) => { release = () => resolve({ names: ['late'] }); }); });
    const started = Date.now();
    const hurried = cached('watchlist:y:v1', DAY, loader, { deadline: Date.now() + 30 });
    await expect(hurried).rejects.toMatchObject({ code: 'deadline' });
    expect(given).toBeGreaterThanOrEqual(started + cache.MIN_LOAD_MS);
    // A later caller shares the same load instead of starting another
    const patient = cached('watchlist:y:v1', DAY, loader);
    release();
    await expect(patient).resolves.toEqual({ names: ['late'] });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('cache R3: one retry after a server error', () => {
  test('a 500 on a list download is tried once more before it counts as failed', async () => {
    let n = 0;
    const loader = jest.fn(async () => { n += 1; if (n === 1) throw new HttpError('HTTP 500', { status: 500 }); return { rows: 3 }; });
    await expect(cached('debarment:ebrd:v1', DAY, loader, { retryPauseMs: 1 })).resolves.toEqual({ rows: 3 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('two server errors in a row fail, and a 404 is not retried', async () => {
    const down = jest.fn(async () => { throw new HttpError('HTTP 502', { status: 502 }); });
    await expect(cached('a:v1', DAY, down, { retryPauseMs: 1 })).rejects.toMatchObject({ status: 502 });
    expect(down).toHaveBeenCalledTimes(2);
    const gone = jest.fn(async () => { throw new HttpError('HTTP 404', { status: 404 }); });
    await expect(cached('b:v1', DAY, gone, { retryPauseMs: 1 })).rejects.toMatchObject({ status: 404 });
    expect(gone).toHaveBeenCalledTimes(1);
  });
});

describe('cache R3: an old copy is never passed off as fresh', () => {
  const storeCopy = (key, ageMs, value) => mockRows.set(key, { body: JSON.stringify(value), fetched_at: new Date(Date.now() - ageMs).toISOString() });
  const failing = async () => { throw new Error('host down'); };

  test('a copy served after a failed refresh carries its real date and fresh: false, also on the next lookup', async () => {
    storeCopy('watchlist:eu:v1', 2 * DAY, { names: ['old'] });
    const first = await cache.cachedEntry('watchlist:eu:v1', DAY, failing);
    expect(first.value).toEqual({ names: ['old'] });
    expect(first.fresh).toBe(false);
    expect(Date.now() - first.at).toBeGreaterThanOrEqual(2 * DAY - 1000);
    // the held copy is served from memory without another download, and still says it is old
    const loader = jest.fn(failing);
    const second = await cache.cachedEntry('watchlist:eu:v1', DAY, loader);
    expect(loader).not.toHaveBeenCalled();
    expect(second.fresh).toBe(false);
    expect(second.at).toBe(first.at);
  });

  test('a copy older than maxStaleMs is not served: the failure is thrown', async () => {
    storeCopy('watchlist:eu:v1', 8 * DAY, { names: ['ancient'] });
    await expect(cached('watchlist:eu:v1', DAY, failing)).rejects.toThrow('host down');
    __resetCacheForTests();
    storeCopy('watchlist:un:v1', 3 * DAY, { names: ['old'] });
    await expect(cached('watchlist:un:v1', DAY, failing, { maxStaleMs: 2 * DAY })).rejects.toThrow('host down');
  });

  test('a fresh load says fresh: true with its download time', async () => {
    const entry = await cache.cachedEntry('k:v1', DAY, async () => ({ a: 1 }));
    expect(entry).toMatchObject({ value: { a: 1 }, fresh: true });
    expect(Math.abs(Date.now() - entry.at)).toBeLessThan(1000);
  });

  test('a failure with no copy is remembered for about a minute, not five', () => {
    expect(cache.FAILURE_HOLD_MS).toBeLessThanOrEqual(60 * 1000);
  });
});
