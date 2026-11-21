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
import { runFounderCheck, runFounderBrief } from '../../../server/founderCheck';
import { validatePersonName, validateOrgName } from '../../../server/founder/deepCheck';
import { getUserId, callerAddress } from '../../../server/auth';
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

// The address the host set (its own headers, else the last forwarded hop), never the first hop: a client can
// write anything there, and would dodge the limit with a new made-up address on every call.
const clientIp = (req) => callerAddress(req);

/**
 * The request's fields, from a JSON body (POST) or the query string (GET). A body the framework did not parse as
 * JSON is not read: only a text/plain or form post, which another site can send without asking, arrives as text.
 */
function input(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const from = req.method === 'POST' ? body : req.query || {};
  const pick = (k) => (typeof from[k] === 'string' ? from[k] : Array.isArray(from[k]) ? String(from[k][0] || '') : from[k] == null ? '' : String(from[k]));
  return { name: pick('name'), company: pick('company'), model: pick('model') || 'auto', brief: pick('brief') };
}

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
  // A request started by another site (an image tag, a link, a script's no-cors POST) would spend searches and the
  // visitor's allowance in their name: refused, whatever the method.
  const site = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site' || (req.method === 'GET' && ['image', 'script', 'style', 'iframe', 'embed', 'object'].includes(String(req.headers?.['sec-fetch-dest'] || '').toLowerCase()))) {
    return res.status(403).json({ error: 'Run the check from the Founder Check page.' });
  }
  // A POST must be JSON: a browser asks the server before sending JSON from another site (and this route does not
  // agree), while a text/plain or form post goes out unasked. Older browsers send no Sec-Fetch-Site, so this holds
  // where the check above cannot.
  if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers?.['content-type'] || ''))) {
    return res.status(415).json({ error: 'Run the check from the Founder Check page.' });
  }

  const asked = input(req);
  if (!String(asked.name || '').trim()) return res.status(400).json({ error: 'name is required' });
  // The deep check's validators, so both routes accept and refuse the same names. The quick brief needs the full
  // name: a one-word name is only told apart by its company in the deep check's stricter grading.
  const org = validateOrgName(asked.company);
  if (!org.ok) return res.status(400).json({ error: org.error });
  // Quotation marks and a possessive ("Jane" Doe's) were always dropped here before the check; the searches quote
  // the name themselves, so nothing is lost and no operator gets through.
  const person = validatePersonName(String(asked.name || '').replace(/["“”„]/g, ' ').replace(/[’']s\b/g, ''));
  if (!person.ok) return res.status(400).json({ error: person.error });
  if (person.name.split(/\s+/).length < 2) return res.status(400).json({ error: 'Enter the full name (first and last name). The deep check accepts one-word names with a company.' });
  const { name } = person;
  const company = org.value;
  const model = /^[\w.:/-]{1,120}$/.test(asked.model) ? asked.model : 'auto';
  const mode = asked.brief === '0' || asked.brief === 'false' || asked.brief === 'none' ? 'none' : asked.brief === 'only' ? 'only' : 'auto';

  let userId = null;
  try { userId = await getUserId(req, res); } catch { userId = null; }
  const owner = userId ? `user:${userId}` : `anon:${clientLabel(clientIp(req))}`;

  const count = async () => (await countHit(owner, userId ? QUICK_LIMITS.signedIn : QUICK_LIMITS.signedOut))
    || (userId ? 0 : await countHit('everyone', QUICK_LIMITS.everyone));
  const tooMany = (wait) => {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: WAIT_MESSAGE, retryAfter: wait });
  };
  try {
    // The brief for sources just found is part of the same check and is not counted again (the held sources are
    // used once, so one counted check gives one brief).
    if (mode !== 'only') {
      const wait = await count();
      if (wait > 0) return tooMany(wait);
    }
    const deadline = startedAt + 47000;
    if (mode === 'only') {
      let refused = 0;
      // The sources are no longer held (or were used already), so the whole check runs again: it is counted like
      // one, and refused like one, before any search or model call.
      const onMiss = async () => {
        const wait = await count();
        if (wait > 0) { refused = wait; throw new Error('fair-use limit'); }
      };
      let out;
      try {
        out = await runFounderBrief({ name, company, model, deadline, cacheScope: owner, onMiss });
      } catch (error) {
        if (refused) return tooMany(refused);
        throw error;
      }
      if (!out.fromCache) {
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
