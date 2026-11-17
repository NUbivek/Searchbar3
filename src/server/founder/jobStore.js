/**
 * Where a deep background check lives between requests.
 *
 * A deep check runs for minutes, far longer than one serverless request, so
 * the browser asks for it one step at a time and the state is kept here: in
 * the database when there is one (Neon in production, PGlite locally), and
 * in memory otherwise (enough for one local process or a test).
 *
 * Jobs are short-lived: a report about a person is not something to keep
 * around. Anything older than RETENTION_HOURS is deleted when a new job
 * starts.
 *
 * When there is a database it is the only copy: a job is never also kept in
 * this instance's memory, because another server instance may have moved it
 * on since. A failed database read or write throws (error.code
 * 'JOB_STORE_UNAVAILABLE') instead of quietly carrying on, so the caller
 * never reports progress that was not saved or runs a step on an old copy.
 */
import crypto from 'crypto';
import { query, queryOne, persistenceMode } from '../db';
import { cleanText } from './finding';

export const RETENTION_HOURS = 72;
// Kept on the process, not the module: the development server reloads modules while it runs, and a
// check in progress must not vanish when it does.
const memory = process.env.NODE_ENV === "test" ? new Map() : (globalThis.__founderJobs || (globalThis.__founderJobs = new Map()));

// Saved checks go to the hosted database only. A check's state is hundreds of kilobytes, and the local
// embedded database (PGlite) crashed under repeated writes of that size; locally, memory is enough.
const useDb = () => persistenceMode() === 'neon';

/** A store failure the caller should answer with "try again shortly". */
function unavailable(what, error) {
  const err = new Error(`founder job ${what}: ${error?.message || error}`);
  err.code = 'JOB_STORE_UNAVAILABLE';
  return err;
}

/**
 * JSON for a JSONB column. Postgres refuses a NUL character or half of a
 * surrogate pair anywhere in the text, and one bad character in one finding
 * would otherwise lose the whole save, so every string is cleaned on the way in.
 */
export function toStoredJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'string' ? cleanText(v) : v));
}

/** An unguessable job id. */
export function newJobId() {
  return crypto.randomBytes(18).toString('base64url');
}

/** A one-way label for a client address, so starts can be counted without storing the address. */
export function clientLabel(ip) {
  const salt = process.env.NEXTAUTH_SECRET || 'local';
  return crypto.createHash('sha256').update(`${salt}|${String(ip || 'unknown')}`).digest('hex').slice(0, 24);
}

function forgetOldInMemory() {
  const cutoff = Date.now() - RETENTION_HOURS * 3600 * 1000;
  for (const [id, job] of memory) if (job.updatedAt < cutoff) memory.delete(id);
}

/**
 * Create a job. `owner` is the user id (or a client label when signed out).
 * With `limit` ({ minutes, max }) the job is only created while the owner has
 * started fewer than `max` in the last `minutes`: counted and inserted in one
 * statement, so parallel starts on different server instances cannot all pass.
 * @returns {Promise<{ id: string|null, limited?: boolean }>}
 */
export async function createJob({ name, company = '', owner = null, state, limit = null }) {
  const id = newJobId();
  const max = limit ? Number(limit.max) : null;
  const minutes = limit ? Number(limit.minutes) || 60 : 60;
  if (!useDb()) {
    forgetOldInMemory();
    if (max !== null) {
      const since = Date.now() - minutes * 60000;
      let recent = 0;
      for (const job of memory.values()) if (job.owner === owner && job.createdAt > since) recent += 1;
      if (recent >= max) return { id: null, limited: true };
    }
    memory.set(id, { id, owner, name, company, status: 'running', state, createdAt: Date.now(), updatedAt: Date.now() });
    return { id };
  }
  try {
    await query(`DELETE FROM founder_jobs WHERE updated_at < now() - interval '${RETENTION_HOURS} hours'`);
  } catch (error) {
    console.warn('old founder jobs not cleared:', error.message);
  }
  try {
if (max !== null) {
      const rows = await query(
        `INSERT INTO founder_jobs (id, user_id, name, company, status, state)
         SELECT $1, $2, $3, $4, $5, $6
         WHERE (SELECT count(*) FROM founder_jobs WHERE user_id = $2 AND created_at > now() - ($7 || ' minutes')::interval) < $8
         RETURNING id`,
        [...[id, owner, cleanText(name), company ? cleanText(company) : null, 'running', toStoredJson(state)], String(minutes), max],
      );
      if (!rows || rows.length === 0) return { id: null, limited: true };
    } else {
      await query('INSERT INTO founder_jobs (id, user_id, name, company, status, state) VALUES ($1, $2, $3, $4, $5, $6)', [id, owner, cleanText(name), company ? cleanText(company) : null, 'running', toStoredJson(state)]);
    }
  } catch (error) {
    console.warn('founder job not persisted:', error.message);
    throw unavailable('not persisted', error);
  }
  return { id };
}

/** Load a job, or null. Only its owner may read it when `owner` is given. */
export async function getJob(id, { owner = undefined } = {}) {
  if (!id || typeof id !== 'string' || id.length > 64) return null;
  let record = null;
  if (!useDb()) {
    record = memory.get(id) || null;
  } else {
    try {
      const row = await queryOne('SELECT id, user_id, name, company, status, state, created_at, updated_at FROM founder_jobs WHERE id = $1', [id]);
      if (row) {
        record = {
          id: row.id, owner: row.user_id, name: row.name, company: row.company || '', status: row.status,
          state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
          createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime(),
        };
      }
    } catch (error) {
      console.warn('founder job not loaded from the database:', error.message);
      throw unavailable('not loaded', error);
    }
  }
  if (!record) return null;
  if (owner !== undefined && record.owner && record.owner !== owner) return null;
  return record;
}

/**
 * Save a job's state and status. With `expectRev` (the state's `rev` as it
 * was loaded) the save only happens if nobody else saved in between: two
 * requests working on one check (a second tab, a retry that overlaps a slow
 * first request) must not overwrite each other's records. Returns false when
 * the other request got there first.
 */
export async function saveJob(id, { state, status = 'running', expectRev = null }) {
  if (!useDb()) {
    const current = memory.get(id);
    if (current) memory.set(id, { ...current, state, status, updatedAt: Date.now() });
    return true;
  }
  try {
    if (expectRev === null) {
      await query('UPDATE founder_jobs SET state = $2, status = $3, updated_at = now() WHERE id = $1', [id, toStoredJson(state), status]);
      return true;
    }
    const rows = await query(
      `UPDATE founder_jobs SET state = $2, status = $3, updated_at = now()
       WHERE id = $1 AND COALESCE((state->>'rev')::int, 0) = $4 RETURNING id`,
      [id, toStoredJson(state), status, Number(expectRev) || 0],
    );
    return Boolean(rows && rows.length);
  } catch (error) {
    console.warn('founder job not saved:', error.message);
    throw unavailable('not saved', error);
  }
}

/** How many jobs an owner started in the last `minutes` (to keep free quotas from being drained). */
export async function recentJobCount(owner, minutes = 60) {
  if (!owner) return 0;
  if (useDb()) {
    try {
      const row = await queryOne(`SELECT COUNT(*)::int AS n FROM founder_jobs WHERE user_id = $1 AND created_at > now() - interval '${Number(minutes) || 60} minutes'`, [owner]);
      if (row) return Number(row.n) || 0;
    } catch {
      // the count is a courtesy limit: when the database cannot answer, do not block the start
    }
    return 0;
  }
  const cutoff = Date.now() - minutes * 60000;
  return [...memory.values()].filter((j) => j.owner === owner && j.createdAt >= cutoff).length;
}

/** Forget in-memory jobs (tests). */
export function __resetJobsForTests() {
  memory.clear();
}
