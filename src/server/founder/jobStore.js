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
 */
import crypto from 'crypto';
import { query, queryOne, persistenceMode } from '../db';

export const RETENTION_HOURS = 72;
const memory = new Map();

const useDb = () => persistenceMode() !== 'none';

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
 * @returns {Promise<{ id: string }>}
 */
export async function createJob({ name, company = '', owner = null, state }) {
  const id = newJobId();
  const record = { id, owner, name, company, status: 'running', state, createdAt: Date.now(), updatedAt: Date.now() };
  memory.set(id, record);
  forgetOldInMemory();
  if (useDb()) {
    try {
      await query(`DELETE FROM founder_jobs WHERE updated_at < now() - interval '${RETENTION_HOURS} hours'`);
      await query('INSERT INTO founder_jobs (id, user_id, name, company, status, state) VALUES ($1, $2, $3, $4, $5, $6)', [id, owner, name, company || null, 'running', JSON.stringify(state)]);
    } catch (error) {
      console.warn('founder job not persisted:', error.message);
    }
  }
  return { id };
}

/** Load a job, or null. Only its owner may read it when `owner` is given. */
export async function getJob(id, { owner = undefined } = {}) {
  if (!id || typeof id !== 'string' || id.length > 64) return null;
  let record = null;
  if (useDb()) {
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
    }
  }
  if (!record) record = memory.get(id) || null;
  if (!record) return null;
  if (owner !== undefined && record.owner && record.owner !== owner) return null;
  return record;
}

/** Save a job's state and status. */
export async function saveJob(id, { state, status = 'running' }) {
  const current = memory.get(id);
  if (current) memory.set(id, { ...current, state, status, updatedAt: Date.now() });
  if (useDb()) {
    try {
      await query('UPDATE founder_jobs SET state = $2, status = $3, updated_at = now() WHERE id = $1', [id, JSON.stringify(state), status]);
    } catch (error) {
      console.warn('founder job not saved:', error.message);
    }
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
      // fall through to memory
    }
  }
  const cutoff = Date.now() - minutes * 60000;
  return [...memory.values()].filter((j) => j.owner === owner && j.createdAt >= cutoff).length;
}

/** Forget in-memory jobs (tests). */
export function __resetJobsForTests() {
  memory.clear();
}
