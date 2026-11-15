/**
 * @jest-environment node
 */
const mockRows = new Map();
let mockWriteGate = null; // when set, the database write waits on this promise
jest.mock('../../../src/server/db', () => ({
  persistenceMode: jest.fn(() => 'pglite'),
  query: jest.fn(async (text, params) => {
    if (mockWriteGate) await mockWriteGate;
    if (/INSERT INTO source_cache/.test(text)) mockRows.set(params[0], { body: params[1], fetched_at: new Date().toISOString() });
    return [];
  }),
  queryOne: jest.fn(async (text, params) => mockRows.get(params[0]) || null),
}));

const { cached, __resetCacheForTests, FAILURE_HOLD_MS } = require('../../../src/server/founder/cache');

beforeEach(() => {
  mockRows.clear();
  mockWriteGate = null;
  __resetCacheForTests();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('source cache fixes', () => {
  test('a failed load with no older copy is remembered, so later lookups do not download again', async () => {
    const failing = jest.fn(async () => { throw new Error('down'); });
    await expect(cached('list:v1', 60000, failing)).rejects.toThrow('down');
    await expect(cached('list:v1', 60000, failing)).rejects.toThrow('down');
    await expect(cached('list:v1', 60000, failing)).rejects.toThrow('down');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  test('the remembered failure expires, and a success clears it', async () => {
    const realNow = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow);
    const failing = jest.fn(async () => { throw new Error('down'); });
    await expect(cached('list:v1', 60000, failing)).rejects.toThrow('down');

    clock.mockReturnValue(realNow + FAILURE_HOLD_MS - 1);
    const loader = jest.fn(async () => ({ names: ['a'] }));
    await expect(cached('list:v1', 60000, loader)).rejects.toThrow('down');
    expect(loader).not.toHaveBeenCalled();

    clock.mockReturnValue(realNow + FAILURE_HOLD_MS + 1);
    expect(await cached('list:v1', 60000, loader)).toEqual({ names: ['a'] });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('a failure on one key does not block other keys', async () => {
    await expect(cached('list:v1', 60000, async () => { throw new Error('down'); })).rejects.toThrow('down');
    expect(await cached('other:v1', 60000, async () => ({ ok: true }))).toEqual({ ok: true });
  });

  test('the value is returned without waiting for the database write', async () => {
    let release;
    mockWriteGate = new Promise((r) => { release = r; });
    const result = await Promise.race([
      cached('list:v1', 60000, async () => ({ names: ['a'] })),
      new Promise((r) => setTimeout(() => r('timed out'), 200)),
    ]);
    expect(result).toEqual({ names: ['a'] });
    expect(mockRows.has('list:v1')).toBe(false); // still being written
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRows.has('list:v1')).toBe(true);
  });

  test('a failing database write does not fail the lookup', async () => {
    const db = require('../../../src/server/db');
    db.query.mockImplementationOnce(async () => { throw new Error('db down'); });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await cached('list:v1', 60000, async () => ({ names: ['a'] }))).toEqual({ names: ['a'] });
    await new Promise((r) => setTimeout(r, 0));
  });
});
