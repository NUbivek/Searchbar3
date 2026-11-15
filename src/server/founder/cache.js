/**
 * A cache for public list files that a source downloads whole (a sanctions
 * list, a breach catalogue, a company directory).
 *
 * These files are megabytes and change at most daily, while a serverless
 * instance lives for minutes. So a value is looked for in three places, in
 * order: this process's memory, the database (shared by every instance),
 * and only then the network. A source should cache the small index it
 * builds from the file (names, dates, links), not the raw download.
 *
 * Only public reference data belongs here: never anything about the person
 * being checked.
 */
import { query, queryOne, persistenceMode } from '../db';

const memory = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> Promise
/** Values larger than this stay in memory only. */
export const MAX_STORED_BYTES = 6 * 1024 * 1024;

const useDb = () => persistenceMode() !== 'none';

async function readStored(key) {
  if (!useDb()) return null;
  try {
    const row = await queryOne('SELECT body, fetched_at FROM source_cache WHERE key = $1', [key]);
    if (!row) return null;
    const value = typeof row.body === 'string' ? JSON.parse(row.body) : row.body;
    return { at: new Date(row.fetched_at).getTime(), value };
  } catch (error) {
    console.warn(`source cache read failed (${key}):`, error.message);
    return null;
  }
}

async function writeStored(key, value) {
  if (!useDb()) return;
  try {
    const body = JSON.stringify(value);
    if (body.length > MAX_STORED_BYTES) return;
    await query(
      `INSERT INTO source_cache (key, body, fetched_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, fetched_at = now()`,
      [key, body],
    );
  } catch (error) {
    console.warn(`source cache write failed (${key}):`, error.message);
  }
}

/**
 * Return the cached value for `key`, loading it when it is missing or older
 * than `ttlMs`. When the load fails and an older copy exists, the older copy
 * is returned (a day-old sanctions list beats no list); otherwise the error
 * is thrown so the source is recorded as having failed.
 *
 * @param {string} key      stable name, e.g. 'watchlist:us-csl:v1' (bump the suffix when the shape changes)
 * @param {number} ttlMs    how long a copy counts as fresh
 * @param {() => Promise<any>} loader  downloads and returns the compact, JSON-safe value
 * @param {{ persist?: boolean }} [options]  persist: false keeps it in memory only
 */
export async function cached(key, ttlMs, loader, { persist = true } = {}) {
  const now = Date.now();
  const inMemory = memory.get(key);
  if (inMemory && now - inMemory.at < ttlMs) return inMemory.value;
  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    const stored = persist ? await readStored(key) : null;
    if (stored && now - stored.at < ttlMs) {
      memory.set(key, stored);
      return stored.value;
    }
    try {
      const value = await loader();
      memory.set(key, { at: Date.now(), value });
      if (persist) await writeStored(key, value);
      return value;
    } catch (error) {
      const stale = inMemory || stored;
      if (stale) {
        // Keep serving the old copy for a while instead of retrying on every lookup
        memory.set(key, { at: Date.now() - ttlMs + Math.min(ttlMs, 10 * 60 * 1000), value: stale.value });
        return stale.value;
      }
      throw error;
    }
  })();
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

/** For tests. */
export function __resetCacheForTests() {
  memory.clear();
  inflight.clear();
}
