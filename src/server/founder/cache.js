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
 * Every copy keeps the time it was really downloaded. When a refresh fails,
 * an older copy may stand in for it, but only up to maxStaleMs old, and
 * cachedEntry() tells the caller the copy's date and that it is not fresh,
 * so a report can say "list as of ..." instead of passing an old screen off
 * as current.
 *
 * Only public reference data belongs here: never anything about the person
 * being checked.
 */
import { query, queryOne, persistenceMode } from '../db';
import { cleanText } from './finding';

// Kept on the process, not the module: the development server reloads modules while it runs, and a
// check in progress must not vanish when it does.
const memory = process.env.NODE_ENV === "test" ? new Map() : (globalThis.__founderSourceCache || (globalThis.__founderSourceCache = new Map()));
const inflight = new Map(); // key -> Promise of an entry
const failures = new Map(); // key -> { until, error }: a failed load with no usable older copy
/**
 * How long a failed load with no older copy is remembered before it is retried. Short, so a check that
 * runs for several minutes gets a second attempt; the HTTP client already rests hosts that ask for it.
 */
export const FAILURE_HOLD_MS = 60 * 1000;
/** After a failed refresh, the older copy is served without another download attempt for this long. */
export const STALE_RETRY_MS = 10 * 60 * 1000;
/** The oldest copy ever served after a failed refresh, unless the caller sets maxStaleMs. */
export const MAX_STALE_MS = 7 * 24 * 3600 * 1000;
/** A list loader started by cache gets at least this long, whatever the first caller's own deadline. */
export const MIN_LOAD_MS = 25 * 1000;
/** Pause before the one retry after a server error (HTTP 5xx). */
export const RETRY_5XX_PAUSE_MS = 1500;
/** Values larger than this stay in memory only. */
export const MAX_STORED_BYTES = 6 * 1024 * 1024;

// Shared copies only in the hosted database. The local embedded one (PGlite) runs inside the server's own
// memory, and repeatedly writing multi-megabyte lists into it crashed it; locally, memory alone is enough.
const useDb = () => persistenceMode() === 'neon';

async function readStored(key) {
  if (!useDb()) return null;
  try {
    const row = await queryOne('SELECT body, fetched_at FROM source_cache WHERE key = $1', [key]);
    if (!row) return null;
    const value = typeof row.body === 'string' ? JSON.parse(row.body) : row.body;
    const at = new Date(row.fetched_at).getTime();
    return Number.isFinite(at) ? { at, value } : null;
  } catch (error) {
    console.warn(`source cache read failed (${key}):`, error.message);
    return null;
  }
}

async function writeStored(key, value) {
  if (!useDb()) return;
  try {
    const body = JSON.stringify(value, (_key, v) => (typeof v === 'string' ? cleanText(v) : v));
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
 * The error says the call was cut short by a deadline (the caller ran out of time), not that the source
 * failed. Such a load is never remembered as a failure: the next caller, with time left, tries again.
 */
export function isCutShort(error) {
  if (!error) return false;
  if (error.code === 'deadline') return true;
  return /^Out of time\b/i.test(String(error.message || ''));
}

/**
 * The host answered with a server error (500, 502, 504): worth one more try after a short pause. A 503 is
 * left out because request() already tries it again itself (and rests the host when it persists).
 */
const isServerError = (error) => [500, 502, 504].includes(Number(error?.status));

const outOfTime = (key) => {
  const error = new Error(`Out of time waiting for ${key.split(':')[0] || 'the list'} to load`);
  error.code = 'deadline';
  error.retryable = true;
  return error;
};

/** Describe an entry for the caller: the value, when it was downloaded, and whether it is still fresh. */
const describe = (entry, ttlMs, now = Date.now()) => ({
  value: entry.value,
  at: entry.at,
  fresh: now - entry.at < ttlMs,
  ageMs: Math.max(0, now - entry.at),
});

/**
 * Like cached(), but returns { value, at, fresh, ageMs }: `at` is when the copy
 * was really downloaded (epoch ms), and `fresh` is false whenever an older copy
 * stands in for a failed refresh. A report that screens a list should show
 * "list as of <at>" when fresh is false.
 *
 * @param {string} key      stable name, e.g. 'watchlist:us-csl:v1' (bump the suffix when the shape changes)
 * @param {number} ttlMs    how long a copy counts as fresh
 * @param {(opts: { deadline: number }) => Promise<any>} loader  downloads and returns the compact, JSON-safe value.
 *   It receives its own deadline, at least MIN_LOAD_MS away and independent of any one caller, and should
 *   pass that deadline to request() rather than the caller's.
 * @param {{ persist?: boolean, deadline?: number, maxStaleMs?: number, failureHoldMs?: number, loadMs?: number, retryPauseMs?: number }} [options]
 *   persist: false keeps it in memory only.
 *   deadline: this caller's own deadline (epoch ms). When it passes before the load ends, this caller gets an
 *     'Out of time' error (code 'deadline'), while the shared load goes on for later callers.
 *   maxStaleMs: the oldest copy served after a failed refresh (default 7 days). Older than that, the error is thrown.
 *   failureHoldMs: how long a failure with no usable copy is remembered (default FAILURE_HOLD_MS).
 *   loadMs: the loader's own time budget (default and minimum MIN_LOAD_MS).
 *   retryPauseMs: pause before the one retry after a 5xx (default RETRY_5XX_PAUSE_MS).
 */
export async function cachedEntry(key, ttlMs, loader, {
  persist = true, deadline = null, maxStaleMs = MAX_STALE_MS, failureHoldMs = FAILURE_HOLD_MS, loadMs = MIN_LOAD_MS, retryPauseMs = RETRY_5XX_PAUSE_MS,
} = {}) {
  const now = Date.now();
  const inMemory = memory.get(key);
  if (inMemory && now - inMemory.at < ttlMs) return describe(inMemory, ttlMs, now);
  // An older copy held after a failed refresh: served (marked not fresh) until the next retry is due
  if (inMemory && inMemory.holdUntil && now < inMemory.holdUntil && now - inMemory.at <= maxStaleMs) return describe(inMemory, ttlMs, now);

  let work = inflight.get(key);
  if (!work) {
    const failed = failures.get(key);
    if (failed) {
      if (now < failed.until) throw failed.error;
      failures.delete(key);
    }
    work = (async () => {
      const stored = persist ? await readStored(key) : null;
      if (stored && Date.now() - stored.at < ttlMs) {
        memory.set(key, stored);
        return stored;
      }
      const loaderDeadline = Date.now() + Math.max(MIN_LOAD_MS, loadMs);
      try {
        let value;
        try {
          value = await loader({ deadline: loaderDeadline });
        } catch (error) {
          // One more try after a server error, which is often a single bad answer from a busy host
          if (!isServerError(error) || Date.now() + retryPauseMs > loaderDeadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryPauseMs));
          value = await loader({ deadline: loaderDeadline });
        }
        const entry = { at: Date.now(), value };
        memory.set(key, entry);
        failures.delete(key);
        // writeStored catches its own errors; the catch here only guards against surprises
        if (persist) writeStored(key, value).catch(() => {});
        return entry;
      } catch (error) {
        // The newest older copy we have, with its real download time
        const candidates = [inMemory, stored].filter(Boolean).sort((a, b) => b.at - a.at);
        const stale = candidates[0];
        if (stale && Date.now() - stale.at <= maxStaleMs) {
          // Keep serving the old copy for a while instead of retrying on every lookup; its date is not changed
          const held = { at: stale.at, value: stale.value, holdUntil: Date.now() + Math.min(ttlMs, STALE_RETRY_MS) };
          memory.set(key, held);
          return held;
        }
        // A load cut short by a deadline says nothing about the source: the next caller tries again
        if (!isCutShort(error)) failures.set(key, { until: Date.now() + failureHoldMs, error });
        throw error;
      }
    })();
    inflight.set(key, work);
    // Clear the shared load when it settles, whoever is still waiting for it
    work.then(() => inflight.delete(key), () => inflight.delete(key));
  }

  // Each caller waits only until its own deadline; the shared load is not abandoned
  let entry;
  if (deadline) {
    const left = deadline - Date.now();
    if (left <= 0) throw outOfTime(key);
    let timer;
    try {
      entry = await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(outOfTime(key)), left); })]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    entry = await work;
  }
  return describe(entry, ttlMs);
}

/**
 * Return the cached value for `key`, loading it when it is missing or older
 * than `ttlMs`. When the load fails and an older copy no older than
 * maxStaleMs exists, the older copy is returned (a day-old sanctions list
 * beats no list); use cachedEntry() to learn its date. Otherwise the error is
 * thrown so the source is recorded as having failed, and that failure is
 * remembered for failureHoldMs so later lookups fail at once instead of
 * downloading the whole file again from a struggling host. A load cut short
 * by a deadline is never remembered as a failure. A server error (5xx) gets
 * one retry after a short pause before it counts as a failure.
 *
 * The database copy is written in the background: the caller gets the value
 * as soon as it is loaded, not after a multi-megabyte write.
 *
 * Same arguments and options as cachedEntry().
 *
 * cached() drops the copy's date, so a caller cannot tell a week-old copy
 * from today's. It is for values that only help a lookup along (robots rules,
 * an archive pointer). A source that reports a screen or a search as clean
 * ("no match", "no recall", "found no entry") must use cachedEntry() and,
 * when `fresh` is false, say "list as of <date>" and mark the lookup partial:
 * an old copy must never pass for a current clean result.
 */
export async function cached(key, ttlMs, loader, options = {}) {
  return (await cachedEntry(key, ttlMs, loader, options)).value;
}

/** For tests. */
export function __resetCacheForTests() {
  memory.clear();
  inflight.clear();
  failures.clear();
}
