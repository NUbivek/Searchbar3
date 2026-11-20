/**
 * Deep background check, one step per request (a full check takes minutes,
 * a serverless request does not).
 *
 *   POST { action: 'start', name, company }  -> { jobId, progress }
 *   POST { action: 'step', jobId }           -> { progress }            while collecting
 *                                            -> { done: true, report }  when finished
 *   POST { action: 'brief', jobId }          -> { done: true, report }  one more try at the written summary,
 *                                               with other models, when the first ran out of time
 *   GET  ?jobId=                             -> { progress, report? }
 *
 * The browser calls 'step' until it gets `done`. State lives in the job
 * store between calls. Sign-in is required unless FOUNDER_DEEP_PUBLIC=true:
 * a check gathers a lot about one person and uses shared free quotas, so it
 * is tied to an account and limited per hour.
 */
import { normalizePersonName } from '../../../server/founderCheck';
import { getUserId } from '../../../server/auth';
import { startState, stepDeepCheck, progressOf } from '../../../server/founder/deepCheck';
import { buildReport, writeDeepBrief, quotedDeepBrief } from '../../../server/founder/report';
import { createJob, getJob, saveJob, recentJobCount, clientLabel } from '../../../server/founder/jobStore';
import { CONNECTORS } from '../../../server/founder/sources';
import { findGaps } from '../../../server/founder/gaps';
import { readProfile } from '../../../server/founder/profileModel';
import { llmConfigured } from '../../../server/llm/providers';

// ---------------------------------------------------------------- network pairing (begin)
// The signed-in user's own contacts, matched to the check (see server/founder/networkLink.js).
// Nothing from a contact is stored in the check or sent out, except that a contact's company may
// anchor a check started without one, exactly as if the user had typed it. Read live on every
// answer, so a contact removed from the Network Map tab is gone from the report too.
const linker = () => import('../../../server/founder/networkLink');
/** The company to start with: the one typed, or (none typed) the one contact with this full name. */
async function networkSeed(signedIn, owner, name, company) {
  if (!signedIn || company) return null;
  try { return await (await linker()).companySeed(owner, name, company); } catch { return null; }
}
/** Resolves to `fallback` once `until` (a clock time) passes, so a slow part never holds the answer. */
function by(promise, until, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, until - Date.now())); }),
  ]).finally(() => clearTimeout(timer));
}
/**
 * Investors of the person's company, looked up once when the report is built, never past `until`.
 * -> { investors, missed }: missed when the lookup did not finish (the report then says so).
 */
async function networkInvestors(signedIn, owner, report, until) {
  if (!signedIn) return { investors: [], missed: false };
  const MISSED = { investors: [], missed: true };
  return by((async () => {
    try {
      const link = await linker();
      const store = await import('../../../server/network/store');
      if (!(await store.countContacts(owner))) return { investors: [], missed: false };
      const { investors, complete } = await link.lookupInvestorsResult(report.company || report.profile?.company, { timeoutMs: Math.min(8000, until - Date.now()) });
      return { investors, missed: !complete };
    } catch { return MISSED; }
  })(), until, MISSED);
}
const NETWORK_SLOW = { available: false, reason: 'Your network took too long to read. Open the report again to see who you know around this person.' };
/** The finished report with the network pairing beside it (never saved in the check), read only until `until`. */
async function withNetwork(signedIn, owner, state, until) {
  const report = state.report;
  if (!report) return report;
  if (!signedIn) return { ...report, network: { available: false, reason: 'Sign in and import your network in the Network Map tab to see who you know around this person.' } };
  const wait = Math.min(NETWORK_MS, until - Date.now());
  // Too little time left on this request: answer without it rather than run out of time (the next read attaches it).
  if (wait < NETWORK_MIN_MS) return { ...report, network: NETWORK_SLOW };
  try {
    const link = await linker();
    const network = await by(
      link.networkForReport(owner, report, { investors: state.networkInvestors || [], seededCompany: state.networkSeed?.company || null, investorsMissed: Boolean(state.networkInvestorsMissed) }),
      Date.now() + wait, NETWORK_SLOW,
    );
    return { ...report, network };
  } catch {
    return { ...report, network: { available: false, reason: 'Your network could not be read just now.' } };
  }
}
// ---------------------------------------------------------------- network pairing (end)

export const config = { api: { responseLimit: '6mb', bodyParser: { sizeLimit: '16kb' } }, maxDuration: 60 };

const STEP_MS = 40000;
// The report step's shares of the 60s limit, counted from the start of the request. Each part is cut off at its
// share, and the report is answered without the optional parts rather than run out of time:
//   the profile read by a model ends first (it shares the model chain with the brief, so the brief has it alone after),
//   the brief is asked to finish by BRIEF_MS and is cut off at BRIEF_HARD_MS (the records-only brief stands in),
//   the investor lookup ends by INVESTORS_MS, then the save, then the network read ends by NETWORK_UNTIL_MS,
//   leaving a few seconds for the save to run long and for the answer to go out.
export const REPORT_BUDGET = { PROFILE_MS: 34000, BRIEF_MS: 44000, BRIEF_HARD_MS: 47000, INVESTORS_MS: 51000, NETWORK_UNTIL_MS: 56000 };
const NETWORK_MS = 4000;
const NETWORK_MIN_MS = 750;
const REPORT_MS = REPORT_BUDGET.BRIEF_MS;
export const MAX_JOBS_PER_HOUR = 12;

/** The second reader (gaps.js) needs an AI model; without one the loop simply stops when it runs dry. */
const reviewer = () => (llmConfigured() ? findGaps : null);

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

/**
 * Starts by one owner are taken one at a time in this server instance, so a
 * burst of parallel starts cannot all pass the hourly count before any of
 * them is recorded. (Across instances the job store's own insert enforces
 * the limit when it supports `limit`.)
 */
const starting = new Map();
async function oneStartAtATime(owner, fn) {
  const before = starting.get(owner) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = before.then(() => mine);
  starting.set(owner, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (starting.get(owner) === tail) starting.delete(owner);
  }
}

/** Who is asking: the signed-in user, or (only when public checks are allowed) a label for their address. */
async function ownerOf(req, res) {
  const userId = await getUserId(req, res);
  if (userId) return { owner: userId, signedIn: true };
  if (process.env.FOUNDER_DEEP_PUBLIC === 'true') return { owner: `anon:${clientLabel(clientIp(req))}`, signedIn: false };
  return { owner: null, signedIn: false };
}

const BUSY = { error: 'Another request is already working on this check.' };
/** Save, unless another request saved this check first (then the caller answers 409 and the page reads the job again). */
async function saveNext(id, state, status) {
  const rev = Number(state.rev) || 0;
  state.rev = rev + 1;
  return saveJob(id, { state, status, expectRev: rev });
}

/** The brief assembled from the records, when the model's brief did not come back within its share of the time. */
function briefRanOut(report) {
  const reason = 'The AI model ran out of time';
  return { brief: quotedDeepBrief(report, reason), briefInfo: { mode: 'quoted', reason, tried: [], retry: true } };
}

/** The report without internal fields, ready for the page. */
function publicReport(report) {
  const strip = ({ score, step, via, matchFixed, gradeText, ...rest }) => rest;
  return {
    ...report,
    redFlags: report.redFlags.map(strip),
    companyMatters: (report.companyMatters || []).map(strip),
    possibleNamesake: report.possibleNamesake.map(strip),
    sections: report.sections.map((s) => ({ ...s, items: s.items.map(strip) })),
    claimChanges: report.claimChanges.map(strip),
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { owner, signedIn } = await ownerOf(req, res);
    if (!owner) return res.status(401).json({ error: 'Sign in to run a deep background check.', signIn: true });

    if (req.method === 'GET') {
      const job = await getJob(String(req.query.jobId || ''), { owner });
      if (!job) return res.status(404).json({ error: 'This check was not found. It may have expired; run it again.' });
      return res.status(200).json({ jobId: job.id, progress: progressOf(job.state), ...(job.state.report ? { done: true, report: await withNetwork(signedIn, owner, job.state, startedAt + REPORT_BUDGET.NETWORK_UNTIL_MS) } : {}) });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.action === 'start') {
      const name = normalizePersonName(body.name);
      const typedCompany = String(body.company || '').trim().replace(/\s+/g, ' ');
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (name.split(' ').length < 2) return res.status(400).json({ error: 'Enter the full name (first and last name).' });
      if (name.length > 120 || typedCompany.length > 120) return res.status(400).json({ error: 'name and company must be 120 characters or fewer' });
      const seed = await networkSeed(signedIn, owner, name, typedCompany); // network pairing
      const company = seed ? seed.company : typedCompany;
      const state = startState({ name, company });
      if (seed) state.networkSeed = { company: seed.company }; // network pairing
      // The count and the record of the new job happen under one lock, and the
      // job store may refuse the insert itself (limited) when the hour is full.
      // A job that could not be recorded throws and ends in a 500, never a check run from memory.
      const created = await oneStartAtATime(owner, async () => {
        if (await recentJobCount(owner, 60) >= MAX_JOBS_PER_HOUR) return null;
        const job = await createJob({ name, company, owner, state, limit: { minutes: 60, max: MAX_JOBS_PER_HOUR } });
        return job && job.id && !job.limited ? job : null;
      });
      if (!created) {
        return res.status(429).json({ error: 'You have started many checks in the last hour. Try again later.' });
      }
      const { id } = created;
      const { progress } = await stepDeepCheck(state, { connectors: CONNECTORS, deadline: startedAt + STEP_MS, review: reviewer() });
      await saveNext(id, state, 'running');
      return res.status(200).json({ jobId: id, progress });
    }

    if (body.action === 'step') {
      const job = await getJob(String(body.jobId || ''), { owner });
      if (!job) return res.status(404).json({ error: 'This check was not found. It may have expired; run it again.' });
      const { state } = job;
      if (state.report) return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: await withNetwork(signedIn, owner, state, startedAt + REPORT_BUDGET.NETWORK_UNTIL_MS) });
      if (state.phase === 'collect') {
        const { progress } = await stepDeepCheck(state, { connectors: CONNECTORS, deadline: startedAt + STEP_MS, review: reviewer() });
        if (!(await saveNext(job.id, state, 'running'))) return res.status(409).json(BUSY);
        return res.status(200).json({ jobId: job.id, progress });
      }
      // Collecting is over: build the report and write the brief.
      const report = buildReport(state);
      // The profile is read by a model while the brief is written. Each has its own share of the time and is cut
      // off at it: readProfile never throws and falls back to the profile read by patterns; a brief that has not
      // come back is replaced by the brief assembled from the records, and the page can ask for one more try.
      const [{ brief, briefInfo }, profile] = await Promise.all([
        by(writeDeepBrief(report, { deadline: startedAt + REPORT_BUDGET.BRIEF_MS }), startedAt + REPORT_BUDGET.BRIEF_HARD_MS, null)
          .then((out) => out || briefRanOut(report)),
        by(readProfile(report, state, { deadline: startedAt + REPORT_BUDGET.PROFILE_MS }), startedAt + REPORT_BUDGET.PROFILE_MS + 1500, null)
          .then((p) => p || report.profile || null),
      ]);
      state.report = publicReport({ ...report, profile, brief, briefInfo });
      state.phase = 'done';
      const { investors, missed } = await networkInvestors(signedIn, owner, state.report, startedAt + REPORT_BUDGET.INVESTORS_MS); // network pairing
      state.networkInvestors = investors;
      if (missed) state.networkInvestorsMissed = true; else delete state.networkInvestorsMissed;
      if (!(await saveNext(job.id, state, 'done'))) return res.status(409).json(BUSY);
      return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: await withNetwork(signedIn, owner, state, startedAt + REPORT_BUDGET.NETWORK_UNTIL_MS) });
    }

    if (body.action === 'brief') {
      const job = await getJob(String(body.jobId || ''), { owner });
      if (!job || !job.state.report) return res.status(404).json({ error: 'This check was not found. It may have expired; run it again.' });
      const { state } = job;
      const info = state.report.briefInfo;
      if (info?.mode === 'quoted' && info.retry) {
        // Cut off at the same share as the first try; then the records-only brief stays, and no further try is offered.
        const out = await by(writeDeepBrief(state.report, { deadline: startedAt + REPORT_MS, avoid: info.tried || [] }), startedAt + REPORT_BUDGET.BRIEF_HARD_MS, null);
        state.report = out
          ? { ...state.report, brief: out.brief, briefInfo: { ...out.briefInfo, retry: false } }
          : { ...state.report, briefInfo: { ...info, retry: false } };
        if (!(await saveNext(job.id, state, 'done'))) return res.status(409).json(BUSY);
      }
      return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: await withNetwork(signedIn, owner, state, startedAt + REPORT_BUDGET.NETWORK_UNTIL_MS) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('Deep founder check failed:', error.message);
    // The check itself is fine; it could not be saved or loaded just now. The page tries the same step again.
    if (error.code === 'JOB_STORE_UNAVAILABLE') return res.status(503).json({ error: 'The check could not be saved or loaded just now. Try again in a moment.' });
    return res.status(500).json({ error: 'The deep check failed. Please try again.' });
  }
}
