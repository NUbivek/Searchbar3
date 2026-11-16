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

const { cached, __resetCacheForTests, MAX_STORED_BYTES } = require('../../../src/server/founder/cache');
const db = require('../../../src/server/db');

beforeEach(() => {
  mockRows.clear();
  __resetCacheForTests();
  jest.clearAllMocks();
});

describe('source cache', () => {
  test('loads once, then serves from memory', async () => {
    const loader = jest.fn(async () => ({ names: ['a'] }));
    expect(await cached('list:v1', 60000, loader)).toEqual({ names: ['a'] });
    expect(await cached('list:v1', 60000, loader)).toEqual({ names: ['a'] });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('a new instance reads the stored copy instead of downloading again', async () => {
    await cached('list:v1', 60000, async () => ({ names: ['a'] }));
    __resetCacheForTests(); // a cold start
    const loader = jest.fn(async () => ({ names: ['b'] }));
    expect(await cached('list:v1', 60000, loader)).toEqual({ names: ['a'] });
    expect(loader).not.toHaveBeenCalled();
  });

  test('an old stored copy is refreshed', async () => {
    mockRows.set('list:v1', { body: JSON.stringify({ names: ['old'] }), fetched_at: new Date(Date.now() - 100000).toISOString() });
    expect(await cached('list:v1', 60000, async () => ({ names: ['new'] }))).toEqual({ names: ['new'] });
    expect(JSON.parse(mockRows.get('list:v1').body)).toEqual({ names: ['new'] });
  });

  test('when the download fails an older copy is served, and without one the error is thrown', async () => {
    mockRows.set('list:v1', { body: JSON.stringify({ names: ['old'] }), fetched_at: new Date(Date.now() - 100000).toISOString() });
    const failing = jest.fn(async () => { throw new Error('down'); });
    expect(await cached('list:v1', 60000, failing)).toEqual({ names: ['old'] });
    // and it does not hammer the source on the very next lookup
    expect(await cached('list:v1', 60000, failing)).toEqual({ names: ['old'] });
    expect(failing).toHaveBeenCalledTimes(1);
    await expect(cached('other:v1', 60000, failing)).rejects.toThrow('down');
  });

  test('concurrent lookups share one download', async () => {
    let calls = 0;
    const loader = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return { n: calls }; };
    const [a, b] = await Promise.all([cached('list:v1', 60000, loader), cached('list:v1', 60000, loader)]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  test('very large values and persist:false stay in memory only', async () => {
    await cached('big:v1', 60000, async () => ({ blob: 'x'.repeat(MAX_STORED_BYTES + 10) }));
    await cached('mem:v1', 60000, async () => ({ a: 1 }), { persist: false });
    expect(mockRows.has('big:v1')).toBe(false);
    expect(mockRows.has('mem:v1')).toBe(false);
    expect(db.queryOne).toHaveBeenCalledTimes(1); // only big:v1 looked in the database
  });
});
