/**
 * The page's side of a deep check: talking to /api/founder/deep and
 * remembering which check belongs to which person.
 *
 * A check runs for minutes, one step per request, and its state is saved on
 * the server between steps (kept 72 hours). So nothing is lost when the
 * connection drops, the tab is closed or the visitor signs in on the way:
 *   - each step that fails because the network or the server hiccupped is
 *     tried again, patiently (about two minutes, and for as long as the
 *     browser says it is offline);
 *   - the check's id is kept in this browser (localStorage, refreshed on
 *     every step), and the server is asked for the account's latest check of
 *     this person, so any tab picks the check up again instead of starting
 *     another one (each start uses one of the hour's checks).
 */

const KEEP_HOURS = 72; // as long as the server keeps a check (jobStore RETENTION_HOURS)
export const PATIENCE_MS = 120000;
const BACKOFF_MS = [1500, 3000, 5000, 8000, 12000, 15000];

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request to the deep-check route. Throws an Error carrying the status, and `failed` when the check itself ended. */
export async function call(body) {
  const r = await fetch('/api/founder/deep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return answer(r);
}

async function answer(r) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(data.error || `Request failed (${r.status})`);
    error.status = r.status;
    if (data.failed) error.failed = true;
    if (data.field) error.field = data.field;
    if (data.signIn) error.signIn = true;
    if (Number.isFinite(Number(data.retryAfter))) error.retryAfter = Number(data.retryAfter);
    throw error;
  }
  return data;
}

/** A request that failed on the way (no answer) or with a server error, which a later try can fix. */
export const isTransient = (error) => Boolean(error) && !error.failed && (!error.status || error.status >= 500);

/** Resolves when the browser is online again (at once when it is). */
function online() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { window.removeEventListener('online', done); resolve(); };
    window.addEventListener('online', done);
  });
}

/**
 * `fn` tried again on network drops and server errors, with growing waits, for about two minutes of
 * being online. Time spent offline does not count: the try after it waits for the 'online' event.
 * Anything else (sign-in, a refused name, the hourly limit, a check that ended) is thrown at once.
 */
export async function patiently(fn, { patience = PATIENCE_MS, onRetry = null } = {}) {
  let spent = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransient(error)) throw error;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      if (spent + delay > patience) throw error;
      onRetry?.(error, attempt + 1);
      await wait(delay);
      spent += delay;
      await online();
    }
  }
}

/** The check as the server has it: { jobId, progress, done?, report?, failed? }, or null when it is gone. */
export async function readJob(jobId) {
  const r = await fetch(`/api/founder/deep?jobId=${encodeURIComponent(jobId)}`);
  if (r.status === 404) return null;
  return answer(r);
}

/** The account's latest unexpired check of this person (running or finished), or null. */
export async function latestJob(name, company = '') {
  const q = new URLSearchParams({ name });
  if (company) q.set('company', company);
  const r = await fetch(`/api/founder/deep?${q}`);
  if (r.status === 404) return null;
  return answer(r);
}

/** The account's recent checks for the "Recent checks" list: [{ id, name, company, state, when, redFlags }]. */
export async function recentJobs() {
  const r = await fetch('/api/founder/deep?list=1');
  if (!r.ok) return null;
  const data = await r.json().catch(() => ({}));
  return Array.isArray(data.jobs) ? data.jobs : null;
}

/** One step, tried again patiently: the check's state is saved between steps, so a retry loses nothing. */
async function stepPatiently(jobId, action, opts) {
  return patiently(async () => {
    try {
      return await call({ action, jobId });
    } catch (error) {
      // Another request on this check finished first (another tab): read where it stands and carry on from there
      if (error.status === 409) {
        const now = await readJob(jobId).catch(() => null);
        if (now) return now;
        const busy = new Error('busy');
        busy.status = 503; // read again shortly
        throw busy;
      }
      throw error;
    }
  }, opts);
}

// One request at a time per check. Two steps on one job would run the same lookups twice and the
// later save would wipe out the other's records, so a step (or brief) waits for any request on that
// job still in flight: from an earlier run, a "run again" of the same query, or the page before a remount.
const inFlight = new Map();
export async function step(jobId, action = 'step', opts = {}) {
  while (inFlight.has(jobId)) await inFlight.get(jobId).catch(() => null);
  const request = stepPatiently(jobId, action, opts);
  inFlight.set(jobId, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(jobId) === request) inFlight.delete(jobId);
  }
}

/** The optional start fields, only those given: { website, profileUrl, place, otherCompanies, school, otherNames }. */
export function detailsBody(details = {}) {
  const out = {};
  const text = (v) => String(v || '').trim();
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)).map(text).filter(Boolean);
  for (const k of ['website', 'profileUrl', 'place', 'school']) if (text(details[k])) out[k] = text(details[k]);
  for (const k of ['otherCompanies', 'otherNames']) { const l = list(details[k]); if (l.length) out[k] = l; }
  return out;
}

// One start at a time per query, so a remount while a check is being started picks up the same job instead of starting another.
const starting = new Map();
export function startJob(name, company, extra = {}) {
  const key = jobKey(name, company);
  if (!starting.has(key)) {
    const request = call({ action: 'start', name, company, ...extra })
      .then((data) => {
        if (data.jobId) { rememberJob(name, company, data.jobId); rememberStartDetails(data.jobId, detailsBody(extra)); }
        return data;
      })
      .finally(() => starting.delete(key));
    starting.set(key, request);
  }
  return starting.get(key);
}

// ------------------------------------------------------------ which check is this person's, in this browser
export const jobKey = (name, company) => `deep-check:${String(name || '').trim().toLowerCase()}|${String(company || '').trim().toLowerCase()}`;
function store() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}
/** The id of this person's check kept in this browser, while the server still keeps it. */
export function savedJob(name, company) {
  try {
    const raw = store()?.getItem(jobKey(name, company)) || window.sessionStorage?.getItem(jobKey(name, company));
    const saved = JSON.parse(raw || 'null');
    return saved && saved.jobId && Date.now() - Number(saved.at) < KEEP_HOURS * 3600000 ? saved.jobId : null;
  } catch {
    return null;
  }
}
export function rememberJob(name, company, jobId) {
  if (!jobId) return;
  try { store()?.setItem(jobKey(name, company), JSON.stringify({ jobId, at: Date.now() })); } catch { /* private window: the server lookup still finds it */ }
}
export function forgetJob(name, company) {
  try { store()?.removeItem(jobKey(name, company)); window.sessionStorage?.removeItem(jobKey(name, company)); } catch { /* nothing kept */ }
}

// ------------------------------------------------------------ optional details typed for a person (kept for the sign-in round trip)
const detailsKey = (name, company) => `deep-details:${String(name || '').trim().toLowerCase()}|${String(company || '').trim().toLowerCase()}`;
/** Kept in this tab only: they may name a profile or a city, and are needed only until the check starts. */
export function keepDetails(name, company, details) {
  try {
    const body = detailsBody(details);
    if (Object.keys(body).length) window.sessionStorage.setItem(detailsKey(name, company), JSON.stringify(body));
    else window.sessionStorage.removeItem(detailsKey(name, company));
  } catch { /* nothing kept */ }
}
export function keptDetails(name, company) {
  try { return JSON.parse(window.sessionStorage.getItem(detailsKey(name, company)) || 'null'); } catch { return null; }
}

// ------------------------------------------------------------ which details a check was started with (this tab)
const startedKey = (jobId) => `deep-started:${jobId}`;
/** Kept in this tab, like the details themselves: so a reopened check can say whether the details typed now were used. */
export function rememberStartDetails(jobId, body) {
  if (!jobId) return;
  try { window.sessionStorage.setItem(startedKey(jobId), JSON.stringify(body || {})); } catch { /* nothing kept */ }
}
/** The start details this tab sent for the check, or null when this tab did not start it. */
export function startDetailsOf(jobId) {
  try { return jobId ? JSON.parse(window.sessionStorage.getItem(startedKey(jobId)) || 'null') : null; } catch { return null; }
}
/**
 * Whether the details typed now went into the check `jobId`: 'used' (every detail typed was sent with it),
 * 'unused' (this tab started it with other details), 'unknown' (it was started elsewhere), or '' when no
 * detail is typed.
 */
export function detailsUse(jobId, details) {
  const typed = detailsBody(details || {});
  const keys = Object.keys(typed);
  if (!keys.length) return '';
  const sent = startDetailsOf(jobId);
  if (!sent) return 'unknown';
  const same = (a, b) => JSON.stringify(Array.isArray(a) ? a.map((x) => x.toLowerCase()) : String(a || '').toLowerCase())
    === JSON.stringify(Array.isArray(b) ? b.map((x) => String(x).toLowerCase()) : String(b || '').toLowerCase());
  return keys.every((k) => same(typed[k], sent[k])) ? 'used' : 'unused';
}
