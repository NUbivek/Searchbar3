/**
 * POST /api/founder { name, company?, model?, brief? } : founder background check (public).
 * GET /api/founder?name=&company=&model=&brief= still works for the page as it is, but never from another site.
 *
 * Every item is quoted from a cited source; the brief is AI-written with every line checked against its source
 * when a free model is configured, otherwise quoted. `brief`:
 *   - absent or 'auto': one call, sources and brief together (as before);
 *   - '0': sources and facts only, fast; the brief is then asked for with
 *   - 'only': the brief for the sources just found (same name and company), from a short-lived cache.
 *
 * Fair use: each address (signed out) or account (signed in) may run a generous number of checks; a script that
 * calls in a loop is told to wait. Signed-in users with an imported network also get backchannel references:
 * their own contacts at the founder's current and past companies (never sent to any external service).
 */
import { runFounderCheck, runFounderBrief, validateFounderInput } from '../../../server/founderCheck';
import { getUserId } from '../../../server/auth';
import { clientLabel } from '../../../server/founder/jobStore';
import { query, persistenceMode } from '../../../server/db';

export const config = { api: { responseLimit: '4mb' }, maxDuration: 60 };

const MAX_REFERENCE_COMPANIES = 15;

/**
 * Checks allowed per window. A person using the page runs a few checks a minute at most (and a sources-first
 * check followed by its brief counts once); a script calling in a loop is stopped within seconds.
 */
export const QUICK_LIMITS = {
  signedOut: [{ minutes: 10, max: 15 }, { minutes: 60, max: 40 }],
  signedIn: [{ minutes: 10, max: 30 }, { minutes: 60, max: 120 }],
  // all signed-out visitors together, so many addresses cannot drain the searches either
  everyone: [{ minutes: 60, max: 600 }],
};
const WAIT_MESSAGE = 'Many checks have been run from here in a short time. Please wait a few minutes, then try again.';

const memoryHits = new Map(); // "owner|minutes|bucket" -> count (one server instance)
/** For tests. */
export function __resetQuickLimitsForTests() { memoryHits.clear(); }

/**
 * Count one check for `owner` in each window and say whether it is over. On the hosted database the count is
 * shared by every server instance (one atomic statement per window); otherwise it is kept in memory.
 * @returns {Promise<number>} 0 when allowed, else seconds to wait
 */
async function countHit(owner, windows) {
  const now = Date.now();
  let wait = 0;
  for (const { minutes, max } of windows) {
    const span = minutes * 60000;
    const bucket = Math.floor(now / span);
    const key = `quick-hits:${owner}|${minutes}|${bucket}`;
    let count = null;
    if (persistenceMode() === 'neon') {
      try {
        const rows = await query(
          `INSERT INTO source_cache (key, body, fetched_at) VALUES ($1, to_jsonb(1), now())
           ON CONFLICT (key) DO UPDATE SET body = to_jsonb(COALESCE((source_cache.body #>> '{}')::int, 0) + 1), fetched_at = now()
           RETURNING (body #>> '{}')::int AS n`,
          [key],
        );
        count = Number(rows?.[0]?.n);
        if (Math.random() < 0.02) query("DELETE FROM source_cache WHERE key LIKE 'quick-hits:%' AND fetched_at < now() - interval '3 hours'").catch(() => {});
      } catch {
        count = null; // the database is unavailable: count in memory instead
      }
    }
    if (!Number.isFinite(count)) {
      count = (memoryHits.get(key) || 0) + 1;
      memoryHits.set(key, count);
      if (memoryHits.size > 5000) {
        for (const k of memoryHits.keys()) {
          const [, mins, b] = k.split('|');
          if (Number(b) < Math.floor(now / (Number(mins) * 60000))) memoryHits.delete(k);
        }
      }
    }
    if (count > max) wait = Math.max(wait, Math.ceil(((bucket + 1) * span - now) / 1000));
  }
  return wait;
}

const clientIp = (req) => String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

/** The request's fields, from a JSON body (POST) or the query string (GET). */
function input(req) {
  const from = req.method === 'POST' ? (typeof req.body === 'string' ? safeJson(req.body) : req.body || {}) : req.query || {};
  const pick = (k) => (typeof from[k] === 'string' ? from[k] : Array.isArray(from[k]) ? String(from[k][0] || '') : from[k] == null ? '' : String(from[k]));
  return { name: pick('name'), company: pick('company'), model: pick('model') || 'auto', brief: pick('brief') };
}
function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

async function backchannelReferences(userId, result, typedCompany) {
  try {
    if (!userId) return { available: false, reason: 'Sign in and import your network to see people you know at these companies.' };
    const network = await import('../../../server/network/store');
    if (typeof network.findContactsAtCompanies !== 'function') return { available: false, reason: 'Network data is not available.' };
    const total = typeof network.countContacts === 'function' ? await network.countContacts(userId) : null;
    if (total === 0) {
      return { available: false, reason: 'Import your network (LinkedIn Connections.csv or any CSV of contacts) to see people you know at these companies.' };
    }
    const companies = [...new Set([
      typedCompany,
      result.company,
      result.currentRole?.company,
      ...(result.profiles || []).map((p) => p.company),
      ...(result.pastCompanies || []).map((p) => p.company),
    ].filter(Boolean).map((c) => String(c).trim()))].slice(0, MAX_REFERENCE_COMPANIES);
    if (companies.length === 0) {
      return { available: true, checked: total, companies, contacts: [], reason: 'No company could be found for this person in the sources, so there is nothing to match your network against. Add the company to the check.' };
    }
    const contacts = await network.findContactsAtCompanies(userId, companies);
    return { available: true, checked: total, companies, contacts: (contacts || []).slice(0, 50) };
  } catch (error) {
    return { available: false, reason: 'Network data is not available right now.' };
  }
}

export default async function handler(req, res) {
  const startedAt = Date.now(); // the brief must finish inside maxDuration (60s)
  // nothing this route answers may be kept by a browser or a shared cache, errors included
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // A GET started by another site (an image tag, a link) would spend searches in the visitor's name: refused.
  const site = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (req.method === 'GET' && (site === 'cross-site' || ['image', 'script', 'style', 'iframe', 'embed', 'object'].includes(String(req.headers?.['sec-fetch-dest'] || '').toLowerCase()))) {
    return res.status(403).json({ error: 'Run the check from the Founder Check page.' });
  }

  const asked = input(req);
  if (!String(asked.name || '').trim()) return res.status(400).json({ error: 'name is required' });
  const checked = validateFounderInput({ name: asked.name, company: asked.company });
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  const { name, company } = checked;
  const model = /^[\w.:/-]{1,120}$/.test(asked.model) ? asked.model : 'auto';
  const mode = asked.brief === '0' || asked.brief === 'false' || asked.brief === 'none' ? 'none' : asked.brief === 'only' ? 'only' : 'auto';

  let userId = null;
  try { userId = await getUserId(req, res); } catch { userId = null; }
  const owner = userId ? `user:${userId}` : `anon:${clientLabel(clientIp(req))}`;

  try {
    // The brief for sources just found is part of the same check and is not counted again.
    if (mode !== 'only') {
      const wait = (await countHit(owner, userId ? QUICK_LIMITS.signedIn : QUICK_LIMITS.signedOut))
        || (userId ? 0 : await countHit('everyone', QUICK_LIMITS.everyone));
      if (wait > 0) {
        res.setHeader('Retry-After', String(wait));
        return res.status(429).json({ error: WAIT_MESSAGE, retryAfter: wait });
      }
    }
    const deadline = startedAt + 47000;
    if (mode === 'only') {
      const out = await runFounderBrief({ name, company, model, deadline, cacheScope: owner });
      if (!out.fromCache) {
        // the sources were no longer held, so the whole check ran: it counts like one
        await countHit(owner, userId ? QUICK_LIMITS.signedIn : QUICK_LIMITS.signedOut);
        const references = await referencesWithin(userId, out, company);
        return res.status(200).json({ ...out, references });
      }
      return res.status(200).json(out);
    }
    const result = await runFounderCheck({ name, company, model, deadline, brief: mode, cacheScope: owner });
    const references = await referencesWithin(userId, result, company);
    return res.status(200).json({ ...result, references });
  } catch (error) {
    console.error('Founder check failed:', error.message);
    return res.status(500).json({ error: 'Founder check failed. Please try again.' });
  }
}

/** The brief is never held up by the network lookup: three seconds, then it goes out without it. */
function referencesWithin(userId, result, company) {
  let timer;
  return Promise.race([
    backchannelReferences(userId, result, company),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ available: false, reason: 'The network lookup took too long; run the check again to see people you know.' }), 3000); }),
  ]).finally(() => clearTimeout(timer));
}
