/**
 * Database access for signed-in features (history, workspaces, notes,
 * watchlists, alerts, data-room documents).
 *
 * - Production: Neon Postgres (DATABASE_URL, added by Vercel's Neon
 *   integration), via the serverless HTTP driver.
 * - Local development without DATABASE_URL: an embedded Postgres (PGlite)
 *   stored in .data/pglite, so the same SQL runs with nothing installed.
 * - Production without DATABASE_URL: persistence is unavailable and callers
 *   get a clear error instead of silently losing data.
 *
 * All queries are parameterized ($1, $2, ...). The schema is created
 * idempotently on first use.
 */
import fs from 'fs';
import path from 'path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspaces_user_idx ON workspaces(user_id);
CREATE TABLE IF NOT EXISTS searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  sources JSONB,
  summary TEXT,
  top_sources JSONB,
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS searches_user_idx ON searches(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS searches_workspace_idx ON searches(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saved_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source_name TEXT,
  published_at TEXT,
  excerpt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, url)
);
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, company)
);
CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id UUID NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source_name TEXT,
  published_at TEXT,
  seen BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (watch_id, url)
);
CREATE INDEX IF NOT EXISTS alerts_user_idx ON alerts(user_id, seen, created_at DESC);
`;

let clientPromise = null;
let schemaPromise = null;

export class PersistenceUnavailableError extends Error {
  constructor() {
    super('Saved history is not configured: add a Neon database (DATABASE_URL) in Vercel.');
    this.name = 'PersistenceUnavailableError';
    this.status = 503;
  }
}

export function persistenceMode() {
  if (process.env.DATABASE_URL) return 'neon';
  if (process.env.NODE_ENV !== 'production') return 'pglite';
  return 'none';
}

async function createClient() {
  const mode = persistenceMode();
  if (mode === 'neon') {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    return {
      query: async (text, params = []) => sql.query(text, params),
      exec: async (text) => {
        for (const statement of text.split(';').map((s) => s.trim()).filter(Boolean)) {
          await sql.query(statement);
        }
      },
    };
  }
  if (mode === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || path.join(process.cwd(), '.data', 'pglite');
    // PGlite does not create missing parent folders
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const db = new PGlite(dir);
    await db.waitReady;
    return {
      query: async (text, params = []) => (await db.query(text, params)).rows,
      exec: async (text) => { await db.exec(text); },
    };
  }
  throw new PersistenceUnavailableError();
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = createClient().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  const client = await clientPromise;
  if (!schemaPromise) {
    schemaPromise = client.exec(SCHEMA).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
  return client;
}

/** Run a parameterized query and return the rows. */
export async function query(text, params = []) {
  const client = await getClient();
  return client.query(text, params);
}

export async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

/** For tests: swap in a client (e.g. an in-memory PGlite). */
export function __setClientForTests(client) {
  clientPromise = client ? Promise.resolve(client) : null;
  schemaPromise = null;
}
