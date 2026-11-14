/**
 * What has worked before, so the next run tries the best first.
 *
 * Three things are scored, each as (tries, wins, time):
 *   kind 'query'   a search-query pattern   win = it returned usable evidence
 *   kind 'source'  a data source            win = it answered with records
 *   kind 'model'   an AI model, per task    win = its answer passed validation
 * (kind 'model-day' counts calls per day to the models with a small daily
 * allowance, so the last few can be kept for reports.)
 *
 * Scores are kept in the database when one is configured (so every server
 * instance and every later run benefits) and always in memory. Ranking uses
 * the observed win rate, blended with a prior for things tried too few times
 * to judge, plus a small bonus for the under-tried so new options still get
 * a turn (upper confidence bound). Nothing here is required for correctness:
 * if the database is unreachable the app simply ranks by the priors.
 */
import { query, persistenceMode } from './db';

const memory = new Map(); // "kind|key" -> { tries, wins, totalMs }
const loadedAt = new Map(); // kind -> epoch ms of the last database read
const RELOAD_MS = 10 * 60 * 1000;
const PRIOR_STRENGTH = 6;

const k = (kind, key) => `${kind}|${key}`;

async function loadFromDatabase(kind) {
  if (persistenceMode() === 'none') return;
  const last = loadedAt.get(kind) || 0;
  if (Date.now() - last < RELOAD_MS) return;
  loadedAt.set(kind, Date.now());
  try {
    const rows = await query('SELECT key, tries, wins, total_ms FROM learning_stats WHERE kind = $1', [kind]);
    for (const row of rows) {
      const local = memory.get(k(kind, row.key));
      // Keep whichever copy has seen more: this instance may have counted runs not yet in the database.
      if (!local || Number(row.tries) >= local.tries) {
        memory.set(k(kind, row.key), { tries: Number(row.tries), wins: Number(row.wins), totalMs: Number(row.total_ms) });
      }
    }
  } catch {
    // no database, or the table is not there yet: memory only
  }
}

/**
 * Stats for one kind: Map(key -> { tries, wins, totalMs }).
 * @param {'query'|'source'|'model'} kind
 */
export async function loadStats(kind) {
  await loadFromDatabase(kind);
  const out = new Map();
  for (const [id, value] of memory) {
    if (id.startsWith(`${kind}|`)) out.set(id.slice(kind.length + 1), { ...value });
  }
  return out;
}

/**
 * Record outcomes. `win` may be true/false or a number between 0 and 1
 * (partial credit, e.g. a query that returned evidence but nothing new).
 * @param {'query'|'source'|'model'} kind
 * @param {Array<{ key: string, win: boolean|number, ms?: number }>} outcomes
 */
export async function recordStats(kind, outcomes) {
  const merged = new Map();
  for (const o of outcomes || []) {
    if (!o || !o.key) continue;
    const win = typeof o.win === 'number' ? Math.max(0, Math.min(1, o.win)) : (o.win ? 1 : 0);
    const m = merged.get(o.key) || { tries: 0, wins: 0, totalMs: 0 };
    m.tries += 1;
    m.wins += win;
    m.totalMs += Math.max(0, Math.round(o.ms || 0));
    merged.set(o.key, m);
  }
  for (const [key, add] of merged) {
    const cur = memory.get(k(kind, key)) || { tries: 0, wins: 0, totalMs: 0 };
    memory.set(k(kind, key), { tries: cur.tries + add.tries, wins: cur.wins + add.wins, totalMs: cur.totalMs + add.totalMs });
  }
  if (persistenceMode() === 'none' || merged.size === 0) return;
  try {
    await Promise.all([...merged].map(([key, add]) => query(
      `INSERT INTO learning_stats (kind, key, tries, wins, total_ms) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (kind, key) DO UPDATE SET tries = learning_stats.tries + EXCLUDED.tries,
         wins = learning_stats.wins + EXCLUDED.wins, total_ms = learning_stats.total_ms + EXCLUDED.total_ms, updated_at = now()`,
      [kind, key.slice(0, 300), add.tries, add.wins, add.totalMs],
    )));
  } catch {
    // learning is best-effort
  }
}

/**
 * Expected usefulness of one option, between 0 and 1.
 * @param {{ tries: number, wins: number }|undefined} stat
 * @param {number} prior what to assume before any evidence (0..1)
 */
export function expectedValue(stat, prior = 0.5) {
  const tries = stat?.tries || 0;
  const wins = stat?.wins || 0;
  return (wins + prior * PRIOR_STRENGTH) / (tries + PRIOR_STRENGTH);
}

/**
 * Order options best-first: observed win rate blended with each option's
 * prior, plus an exploration bonus for options tried rarely.
 * @param {Array<{ key: string, prior?: number }>} options
 * @param {Map<string, { tries: number, wins: number }>} stats
 * @param {{ explore?: number }} settings explore = weight of the bonus (0 disables it)
 */
export function rankByLearning(options, stats, { explore = 0.25 } = {}) {
  const total = [...stats.values()].reduce((n, s) => n + (s.tries || 0), 0) + 1;
  const scored = options.map((o, i) => {
    const stat = stats.get(o.key);
    const tries = stat?.tries || 0;
    const bonus = explore * Math.sqrt(Math.log(total + 1) / (tries + 1));
    return { o, i, score: expectedValue(stat, o.prior ?? 0.5) + bonus };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => ({ ...x.o, score: Number(x.score.toFixed(4)) }));
}

/**
 * Drop scores of one kind that have not been touched for `days` days (used
 * for per-day counters, which are only useful for a day or two).
 */
export async function pruneStats(kind, days) {
  const cutoff = Number(days);
  if (persistenceMode() === 'none' || !Number.isFinite(cutoff) || cutoff <= 0) return;
  try {
    await query(`DELETE FROM learning_stats WHERE kind = $1 AND updated_at < now() - ($2 || ' days')::interval`, [kind, String(Math.floor(cutoff))]);
  } catch {
    // best effort
  }
}

/** Forget everything held in memory (tests). */
export function __resetLearningForTests() {
  memory.clear();
  loadedAt.clear();
}
