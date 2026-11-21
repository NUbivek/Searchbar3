/**
 * Where a deep background check lives between requests.
 *
 * A deep check runs for minutes, far longer than one serverless request, so
 * the browser asks for it one step at a time and the state is kept here: in
 * the database when there is one (Neon in production, PGlite locally), and
 * in memory otherwise (enough for one local process or a test).
 *
 * Jobs are short-lived: a report about a person is not something to keep
 * around. Anything older than RETENTION_HOURS is never served again, and is
 * deleted when a job is started, read or listed (at most every few minutes).
 *
 * When there is a database it is the only copy: a job is never also kept in
 * this instance's memory, because another server instance may have moved it
 * on since. A failed database read or write throws (error.code
 * 'JOB_STORE_UNAVAILABLE') instead of quietly carrying on, so the caller
 * never reports progress that was not saved or runs a step on an old copy.
 *
 * One request at a time may work on a job (leaseJob): a retry that overlaps a
 * slow first request, or a second tab, would otherwise send every lookup of the
 * step a second time and, in memory, change the same state object twice.
 */
import crypto from 'crypto';
import { query, queryOne, persistenceMode } from '../db';
import { cleanText } from './finding';

export const RETENTION_HOURS = 72;
const RETENTION_MS = RETENTION_HOURS * 3600 * 1000;
/** How long one request may hold a job: a step is cut at 40 s and a request at 60 s. */
export const LEASE_MS = 55000;
// Kept on the process, not the module: the development server reloads modules while it runs, and a
// check in progress must not vanish when it does.
const memory = process.env.NODE_ENV === "test" ? new Map() : (globalThis.__founderJobs || (globalThis.__founderJobs = new Map()));
// Leases in memory mode: job id -> { token, until }
const leases = new Map();

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

// A memory copy is handed out and taken in as a deep copy: two requests on one job must never share (and so
// change) one state object, and a caller that changes its copy has changed nothing until it saves.
const copy = (value) => (value === undefined ? undefined : (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))));
const expired = (job, now = Date.now()) => !job || !(job.updatedAt >= now - RETENTION_MS);
// The lease lives beside the state in the database row; it is never part of the state a caller sees.
const LEASE_FIELDS = ['leaseUntil', 'leaseId'];
function withoutLease(state) {
  if (!state || typeof state !== 'object' || !LEASE_FIELDS.some((k) => k in state)) return state;
  const out = { ...state };
  for (const k of LEASE_FIELDS) delete out[k];
  return out;
}

function forgetOldInMemory() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of memory) if (!(job.updatedAt >= cutoff)) { memory.delete(id); leases.delete(id); }
}

/**
 * Delete every job past the retention period. Run on start, read and list, at most once every few minutes
 * per instance in the database, so the stated retention holds even when no new check is started.
 * Never throws: a failed clean-up must not stop the request that asked for it (reads filter by age anyway).
 */
let lastPurge = 0;
const PURGE_EVERY_MS = 5 * 60 * 1000;
export async function purgeExpired({ force = false } = {}) {
  if (!useDb()) { forgetOldInMemory(); return; }
  if (!force && Date.now() - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = Date.now();
  try {
    await query(`DELETE FROM founder_jobs WHERE updated_at < now() - interval '${RETENTION_HOURS} hours'`);
  } catch (error) {
    console.warn('old founder jobs not cleared:', error.message);
  }
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
    memory.set(id, { id, owner, name, company, status: 'running', state: copy(state), createdAt: Date.now(), updatedAt: Date.now() });
    return { id };
  }
  await purgeExpired({ force: true });
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

function fromRow(row) {
  if (!row) return null;
  const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
  return {
    id: row.id, owner: row.user_id, name: row.name, company: row.company || '', status: row.status,
    state: withoutLease(state),
    createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime(),
  };
}

/** Load a job, or null. Only its owner may read it when `owner` is given. A job past retention is not found. */
export async function getJob(id, { owner = undefined } = {}) {
  if (!id || typeof id !== 'string' || id.length > 64) return null;
  let record = null;
  if (!useDb()) {
    const stored = memory.get(id) || null;
    if (stored && expired(stored)) { memory.delete(id); leases.delete(id); return null; }
    record = stored ? { ...stored, state: copy(stored.state) } : null;
  } else {
    purgeExpired();
    try {
      const row = await queryOne(`SELECT id, user_id, name, company, status, state, created_at, updated_at FROM founder_jobs WHERE id = $1 AND updated_at > now() - interval '${RETENTION_HOURS} hours'`, [id]);
      record = fromRow(row);
      // a row the query did not filter (an older database copy, a test double) is still held to the period
      if (record && Number.isFinite(record.updatedAt) && expired(record)) record = null;
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
 * Take the job for one request. Returns { job, leaseId } when this request
 * may work on it, { busy: true } while another request holds it, or null
 * when there is no such job for this owner. The lease ends at `ms`, or when
 * the job is saved or released, whichever comes first.
 */
export async function leaseJob(id, { owner = undefined, ms = LEASE_MS } = {}) {
  if (!id || typeof id !== 'string' || id.length > 64) return null;
  const leaseId = crypto.randomBytes(9).toString('base64url');
  const now = Date.now();
  if (!useDb()) {
    const job = await getJob(id, { owner });
    if (!job) return null;
    const held = leases.get(id);
    if (held && held.until > now) return { busy: true };
    leases.set(id, { token: leaseId, until: now + ms });
    return { job, leaseId };
  }
  let row = null;
  try {
    // Taken in one statement, so two instances cannot both pass the check.
    const rows = await query(
      `UPDATE founder_jobs SET state = jsonb_set(jsonb_set(state, '{leaseUntil}', to_jsonb($3::bigint)), '{leaseId}', to_jsonb($4::text))
        WHERE id = $1 AND ($2::text IS NULL OR user_id IS NULL OR user_id = $2)
          AND updated_at > now() - interval '${RETENTION_HOURS} hours'
          AND COALESCE((state->>'leaseUntil')::bigint, 0) < $5
        RETURNING id, user_id, name, company, status, state, created_at, updated_at`,
      [id, owner === undefined ? null : owner, now + ms, leaseId, now],
    );
    row = rows && rows[0];
  } catch (error) {
    console.warn('founder job lease not taken:', error.message);
    throw unavailable('not leased', error);
  }
  if (row) return { job: fromRow(row), leaseId };
  // Nothing taken: either another request holds it, or there is no such job for this owner.
  return (await getJob(id, { owner })) ? { busy: true } : null;
}

/** Give a job back without saving (the request failed or had nothing to save). Never throws. */
export async function releaseLease(id, leaseId = null) {
  if (!id) return;
  if (!useDb()) {
    const held = leases.get(id);
    if (held && (!leaseId || held.token === leaseId)) leases.delete(id);
    return;
  }
  try {
    await query(`UPDATE founder_jobs SET state = state - 'leaseUntil' - 'leaseId' WHERE id = $1 AND ($2::text IS NULL OR state->>'leaseId' = $2)`, [id, leaseId]);
  } catch (error) {
    console.warn('founder job lease not released:', error.message);
  }
}

/**
 * Save a job's state and status. With `expectRev` (the state's `rev` as it
 * was loaded) the save only happens if nobody else saved in between: two
 * requests working on one check (a second tab, a retry that overlaps a slow
 * first request) must not overwrite each other's records. Returns false when
 * the other request got there first. A save ends the request's lease.
 */
export async function saveJob(id, { state, status = 'running', expectRev = null }) {
  const clean = withoutLease(state);
  if (!useDb()) {
    const current = memory.get(id);
    if (!current) return false;
    if (expectRev !== null && (Number(current.state?.rev) || 0) !== (Number(expectRev) || 0)) return false;
    memory.set(id, { ...current, state: copy(clean), status, updatedAt: Date.now() });
    leases.delete(id);
    return true;
  }
  try {
    if (expectRev === null) {
      await query('UPDATE founder_jobs SET state = $2, status = $3, updated_at = now() WHERE id = $1', [id, toStoredJson(clean), status]);
      return true;
    }
    const rows = await query(
      `UPDATE founder_jobs SET state = $2, status = $3, updated_at = now()
       WHERE id = $1 AND COALESCE((state->>'rev')::int, 0) = $4 RETURNING id`,
      [id, toStoredJson(clean), status, Number(expectRev) || 0],
    );
    return Boolean(rows && rows.length);
  } catch (error) {
    console.warn('founder job not saved:', error.message);
    throw unavailable('not saved', error);
  }
}

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * The owner's latest unexpired job for one person (and company, '' for none), running or finished, or null.
 * With `status` only jobs in that status; with `withinMinutes` only jobs started that recently.
 * Lets a page pick a check up again after a closed tab, a reload or a sign-in.
 */
export async function findLatestJob(owner, { name, company = '', status = null, withinMinutes = null } = {}) {
  if (!owner || !String(name || '').trim()) return null;
  if (!useDb()) {
    forgetOldInMemory();
    const since = withinMinutes ? Date.now() - withinMinutes * 60000 : -Infinity;
    const hit = [...memory.values()]
      .filter((j) => j.owner === owner && sameText(j.name, name) && sameText(j.company, company) && (!status || j.status === status) && j.createdAt >= since)
      // the latest started; of two started together, the one moved on last
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    return hit ? getJob(hit.id, { owner }) : null;
  }
  purgeExpired();
  let row = null;
  try {
    row = await queryOne(
      `SELECT id FROM founder_jobs
        WHERE user_id = $1 AND lower(name) = lower($2) AND lower(COALESCE(company, '')) = lower($3)
          AND updated_at > now() - interval '${RETENTION_HOURS} hours'
          AND ($4::text IS NULL OR status = $4)
          AND ($5::int IS NULL OR created_at > now() - ($5::int * interval '1 minute'))
        ORDER BY created_at DESC, updated_at DESC LIMIT 1`,
      [owner, cleanText(String(name).trim()), cleanText(String(company || '').trim()), status, withinMinutes ? Number(withinMinutes) : null],
    );
  } catch (error) {
    console.warn('founder jobs not listed:', error.message);
    throw unavailable('not loaded', error);
  }
  return row ? getJob(row.id, { owner }) : null;
}

/**
 * The owner's recent unexpired jobs, newest first, without their reports:
 * [{ id, name, company, status, createdAt, updatedAt, redFlags }].
 */
export async function listJobs(owner, { limit = 20 } = {}) {
  if (!owner) return [];
  const cap = Math.max(1, Math.min(50, Number(limit) || 20));
  const flagsOf = (v) => { const n = Number(v); return v === null || v === undefined || !Number.isFinite(n) ? null : n; };
  if (!useDb()) {
    forgetOldInMemory();
    return [...memory.values()]
      .filter((j) => j.owner === owner)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, cap)
      .map((j) => ({ id: j.id, name: j.name, company: j.company || '', status: j.status, createdAt: j.createdAt, updatedAt: j.updatedAt, redFlags: flagsOf(j.state?.report?.totals?.redFlags) }));
  }
  purgeExpired();
  try {
    const rows = await query(
      `SELECT id, name, company, status, created_at, updated_at, (state->'report'->'totals'->>'redFlags') AS red_flags
         FROM founder_jobs
        WHERE user_id = $1 AND updated_at > now() - interval '${RETENTION_HOURS} hours'
        ORDER BY updated_at DESC LIMIT $2`,
      [owner, cap],
    );
    return (rows || []).map((r) => ({ id: r.id, name: r.name, company: r.company || '', status: r.status, createdAt: new Date(r.created_at).getTime(), updatedAt: new Date(r.updated_at).getTime(), redFlags: flagsOf(r.red_flags) }));
  } catch (error) {
    console.warn('founder jobs not listed:', error.message);
    throw unavailable('not loaded', error);
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

/**
 * When the oldest of the owner's jobs started in the last `minutes` was created (ms), or null: the hourly limit
 * frees a slot `minutes` after it, so the page can say when another check can start.
 */
export async function oldestRecentJobAt(owner, minutes = 60) {
  if (!owner) return null;
  if (useDb()) {
    try {
      const row = await queryOne(`SELECT MIN(created_at) AS t FROM founder_jobs WHERE user_id = $1 AND created_at > now() - interval '${Number(minutes) || 60} minutes'`, [owner]);
      const t = row && row.t ? new Date(row.t).getTime() : NaN;
      return Number.isFinite(t) ? t : null;
    } catch {
      return null; // a courtesy for the message only
    }
  }
  const cutoff = Date.now() - minutes * 60000;
  const times = [...memory.values()].filter((j) => j.owner === owner && j.createdAt >= cutoff).map((j) => j.createdAt);
  return times.length ? Math.min(...times) : null;
}

/**
 * How many jobs all owners together started in the last `minutes`: a ceiling across accounts, so many new
 * accounts cannot drain the shared allowances of the sources between them.
 */
export async function recentJobCountAll(minutes = 60) {
  if (useDb()) {
    try {
      const row = await queryOne(`SELECT COUNT(*)::int AS n FROM founder_jobs WHERE created_at > now() - interval '${Number(minutes) || 60} minutes'`);
      if (row) return Number(row.n) || 0;
    } catch {
      // a courtesy limit, as for one owner: when the database cannot answer, the start is not blocked for it
    }
    return 0;
  }
  const cutoff = Date.now() - minutes * 60000;
  return [...memory.values()].filter((j) => j.createdAt >= cutoff).length;
}

/** Forget in-memory jobs (tests). */
export function __resetJobsForTests() {
  memory.clear();
  leases.clear();
  lastPurge = 0;
}

/** Move a memory job's clock (tests of retention). */
export function __ageJobForTests(id, ms) {
  const job = memory.get(id);
  if (job) { job.updatedAt -= ms; job.createdAt -= ms; }
}
