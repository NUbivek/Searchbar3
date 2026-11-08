/**
 * Persistence for signed-in users. Every query is scoped by user_id, so a
 * user can only read or change their own rows.
 */
import { query, queryOne } from './db';

const LIMITS = { query: 500, summary: 20000, name: 120, note: 10000, title: 500, url: 2000, excerpt: 2000, docName: 255, docContent: 2_000_000 };
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

// ---------- search history ----------
export async function recordSearch(userId, { workspaceId = null, query: q, sources = [], summary = '', topSources = [], resultCount = 0 }) {
  if (workspaceId && !(await getWorkspaceRow(userId, workspaceId))) workspaceId = null;
  return queryOne(
    `INSERT INTO searches (user_id, workspace_id, query, sources, summary, top_sources, result_count)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7) RETURNING id, created_at`,
    [userId, workspaceId, cut(q, LIMITS.query), JSON.stringify(sources || []), cut(summary, LIMITS.summary),
      JSON.stringify((topSources || []).slice(0, 15)), Number(resultCount) || 0]
  );
}

export async function listSearches(userId, { workspaceId = null, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (workspaceId) {
    return query(
      `SELECT id, workspace_id, query, sources, summary, top_sources, result_count, created_at
       FROM searches WHERE user_id = $1 AND workspace_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [userId, workspaceId, lim]
    );
  }
  return query(
    `SELECT s.id, s.workspace_id, w.name AS workspace_name, s.query, s.sources, s.result_count, s.created_at
     FROM searches s LEFT JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
    [userId, lim]
  );
}

export async function getSearch(userId, id) {
  return queryOne(`SELECT * FROM searches WHERE user_id = $1 AND id = $2`, [userId, id]);
}

export async function deleteSearch(userId, id) {
  const rows = await query(`DELETE FROM searches WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, id]);
  return rows.length > 0;
}

export async function moveSearch(userId, id, workspaceId) {
  if (workspaceId && !(await getWorkspaceRow(userId, workspaceId))) return false;
  const rows = await query(
    `UPDATE searches SET workspace_id = $3 WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, id, workspaceId || null]
  );
  return rows.length > 0;
}

// ---------- workspaces ----------
export async function getWorkspaceRow(userId, id) {
  return queryOne(`SELECT * FROM workspaces WHERE user_id = $1 AND id = $2`, [userId, id]);
}

export async function listWorkspaces(userId) {
  return query(
    `SELECT w.id, w.name, w.company, w.created_at, w.updated_at,
       (SELECT count(*)::int FROM searches s WHERE s.workspace_id = w.id) AS search_count,
       (SELECT count(*)::int FROM notes n WHERE n.workspace_id = w.id) AS note_count,
       (SELECT count(*)::int FROM saved_sources ss WHERE ss.workspace_id = w.id) AS source_count,
       (SELECT count(*)::int FROM documents d WHERE d.workspace_id = w.id) AS document_count
     FROM workspaces w WHERE w.user_id = $1 ORDER BY w.updated_at DESC`,
    [userId]
  );
}

export async function createWorkspace(userId, { name, company }) {
  const clean = cut(name, LIMITS.name)?.trim();
  if (!clean) throw Object.assign(new Error('A workspace needs a name.'), { status: 400 });
  return queryOne(
    `INSERT INTO workspaces (user_id, name, company) VALUES ($1, $2, $3) RETURNING *`,
    [userId, clean, cut(company, LIMITS.name)?.trim() || clean]
  );
}

export async function updateWorkspace(userId, id, { name, company }) {
  return queryOne(
    `UPDATE workspaces SET name = COALESCE($3, name), company = COALESCE($4, company), updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, id, cut(name, LIMITS.name)?.trim() || null, cut(company, LIMITS.name)?.trim() || null]
  );
}

export async function touchWorkspace(userId, id) {
  await query(`UPDATE workspaces SET updated_at = now() WHERE user_id = $1 AND id = $2`, [userId, id]);
}

export async function deleteWorkspace(userId, id) {
  const rows = await query(`DELETE FROM workspaces WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, id]);
  return rows.length > 0;
}

export async function getWorkspaceDetail(userId, id) {
  const workspace = await getWorkspaceRow(userId, id);
  if (!workspace) return null;
  const [searches, notes, sources, documents] = await Promise.all([
    listSearches(userId, { workspaceId: id, limit: 200 }),
    query(`SELECT id, body, created_at FROM notes WHERE user_id = $1 AND workspace_id = $2 ORDER BY created_at DESC`, [userId, id]),
    query(`SELECT id, title, url, source_name, published_at, excerpt, created_at FROM saved_sources WHERE user_id = $1 AND workspace_id = $2 ORDER BY created_at DESC`, [userId, id]),
    query(`SELECT id, name, size, created_at FROM documents WHERE user_id = $1 AND workspace_id = $2 ORDER BY created_at DESC`, [userId, id]),
  ]);
  return { workspace, searches, notes, sources, documents };
}

// ---------- notes ----------
export async function addNote(userId, workspaceId, body) {
  const text = cut(body, LIMITS.note)?.trim();
  if (!text) throw Object.assign(new Error('Note is empty.'), { status: 400 });
  if (!(await getWorkspaceRow(userId, workspaceId))) return null;
  const note = await queryOne(
    `INSERT INTO notes (workspace_id, user_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at`,
    [workspaceId, userId, text]
  );
  await touchWorkspace(userId, workspaceId);
  return note;
}

export async function deleteNote(userId, workspaceId, noteId) {
  const rows = await query(`DELETE FROM notes WHERE user_id = $1 AND workspace_id = $2 AND id = $3 RETURNING id`, [userId, workspaceId, noteId]);
  return rows.length > 0;
}

// ---------- saved sources ----------
export async function saveSource(userId, workspaceId, { title, url, sourceName, publishedAt, excerpt }) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw Object.assign(new Error('A saved source needs an http(s) URL.'), { status: 400 });
  if (!(await getWorkspaceRow(userId, workspaceId))) return null;
  const row = await queryOne(
    `INSERT INTO saved_sources (workspace_id, user_id, title, url, source_name, published_at, excerpt)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, url) DO UPDATE SET title = EXCLUDED.title, excerpt = COALESCE(EXCLUDED.excerpt, saved_sources.excerpt)
     RETURNING id, title, url, source_name, published_at, excerpt, created_at`,
    [workspaceId, userId, cut(title, LIMITS.title) || url, cut(url, LIMITS.url), cut(sourceName, LIMITS.name), cut(publishedAt, 40), cut(excerpt, LIMITS.excerpt)]
  );
  await touchWorkspace(userId, workspaceId);
  return row;
}

export async function removeSource(userId, workspaceId, sourceId) {
  const rows = await query(`DELETE FROM saved_sources WHERE user_id = $1 AND workspace_id = $2 AND id = $3 RETURNING id`, [userId, workspaceId, sourceId]);
  return rows.length > 0;
}

// ---------- data-room documents ----------
export async function addDocument(userId, workspaceId, { name, content }) {
  const text = cut(content, LIMITS.docContent) || '';
  if (!text.trim()) throw Object.assign(new Error('The document has no readable text.'), { status: 400 });
  if (workspaceId && !(await getWorkspaceRow(userId, workspaceId))) return null;
  const row = await queryOne(
    `INSERT INTO documents (workspace_id, user_id, name, content, size) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, size, created_at`,
    [workspaceId || null, userId, cut(name, LIMITS.docName) || 'Document', text, text.length]
  );
  if (workspaceId) await touchWorkspace(userId, workspaceId);
  return row;
}

export async function getDocuments(userId, workspaceId, ids = null) {
  if (Array.isArray(ids) && ids.length) {
    return query(`SELECT id, name, content FROM documents WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, ids]);
  }
  return query(`SELECT id, name, content FROM documents WHERE user_id = $1 AND workspace_id = $2`, [userId, workspaceId]);
}

export async function deleteDocument(userId, workspaceId, docId) {
  const rows = await query(`DELETE FROM documents WHERE user_id = $1 AND workspace_id = $2 AND id = $3 RETURNING id`, [userId, workspaceId, docId]);
  return rows.length > 0;
}

// ---------- watchlist and alerts ----------
export async function listWatchlist(userId) {
  return query(
    `SELECT w.id, w.company, w.workspace_id, w.last_checked_at, w.created_at,
       (SELECT count(*)::int FROM alerts a WHERE a.watch_id = w.id AND a.seen = false) AS unseen
     FROM watchlist w WHERE w.user_id = $1 ORDER BY w.company`,
    [userId]
  );
}

export async function addWatch(userId, { company, workspaceId = null }) {
  const name = cut(company, LIMITS.name)?.trim();
  if (!name) throw Object.assign(new Error('Enter a company name to watch.'), { status: 400 });
  if (workspaceId && !(await getWorkspaceRow(userId, workspaceId))) workspaceId = null;
  return queryOne(
    `INSERT INTO watchlist (user_id, company, workspace_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, company) DO UPDATE SET workspace_id = COALESCE(EXCLUDED.workspace_id, watchlist.workspace_id)
     RETURNING *`,
    [userId, name, workspaceId]
  );
}

export async function removeWatch(userId, id) {
  const rows = await query(`DELETE FROM watchlist WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, id]);
  return rows.length > 0;
}

export async function listAlerts(userId, { unseenOnly = false, limit = 100 } = {}) {
  return query(
    `SELECT a.id, a.kind, a.title, a.url, a.source_name, a.published_at, a.seen, a.created_at, w.company
     FROM alerts a JOIN watchlist w ON w.id = a.watch_id
     WHERE a.user_id = $1 ${unseenOnly ? 'AND a.seen = false' : ''}
     ORDER BY a.created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
}

export async function markAlertsSeen(userId, ids = null) {
  if (Array.isArray(ids) && ids.length) {
    await query(`UPDATE alerts SET seen = true WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, ids]);
  } else {
    await query(`UPDATE alerts SET seen = true WHERE user_id = $1`, [userId]);
  }
}

/** All watches due for a check (oldest first), across users: for the cron job. */
export async function dueWatches(olderThanMinutes = 360, limit = 50) {
  return query(
    `SELECT id, user_id, company, last_checked_at FROM watchlist
     WHERE last_checked_at IS NULL OR last_checked_at < now() - ($1::text || ' minutes')::interval
     ORDER BY last_checked_at NULLS FIRST LIMIT $2`,
    [String(olderThanMinutes), limit]
  );
}

export async function recordWatchCheck(watch, alerts) {
  let inserted = 0;
  for (const alert of alerts) {
    const rows = await query(
      `INSERT INTO alerts (watch_id, user_id, kind, title, url, source_name, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (watch_id, url) DO NOTHING RETURNING id`,
      [watch.id, watch.user_id, cut(alert.kind, 40), cut(alert.title, LIMITS.title), cut(alert.url, LIMITS.url), cut(alert.sourceName, LIMITS.name), cut(alert.publishedAt, 40)]
    );
    inserted += rows.length;
  }
  await query(`UPDATE watchlist SET last_checked_at = now() WHERE id = $1`, [watch.id]);
  return inserted;
}
