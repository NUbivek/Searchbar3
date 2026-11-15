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
import { buildReport, writeDeepBrief } from '../../../server/founder/report';
import { createJob, getJob, saveJob, recentJobCount, clientLabel } from '../../../server/founder/jobStore';
import { CONNECTORS } from '../../../server/founder/sources';
import { findGaps } from '../../../server/founder/gaps';
import { llmConfigured } from '../../../server/llm/providers';

export const config = { api: { responseLimit: '6mb', bodyParser: { sizeLimit: '16kb' } }, maxDuration: 60 };

const STEP_MS = 40000;
const REPORT_MS = 50000;
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
    const { owner } = await ownerOf(req, res);
    if (!owner) return res.status(401).json({ error: 'Sign in to run a deep background check.', signIn: true });

    if (req.method === 'GET') {
      const job = await getJob(String(req.query.jobId || ''), { owner });
      if (!job) return res.status(404).json({ error: 'This check was not found. It may have expired; run it again.' });
      return res.status(200).json({ jobId: job.id, progress: progressOf(job.state), ...(job.state.report ? { done: true, report: job.state.report } : {}) });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.action === 'start') {
      const name = normalizePersonName(body.name);
      const company = String(body.company || '').trim().replace(/\s+/g, ' ');
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (name.split(' ').length < 2) return res.status(400).json({ error: 'Enter the full name (first and last name).' });
      if (name.length > 120 || company.length > 120) return res.status(400).json({ error: 'name and company must be 120 characters or fewer' });
      const state = startState({ name, company });
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
      if (state.report) return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: state.report });
      if (state.phase === 'collect') {
        const { progress } = await stepDeepCheck(state, { connectors: CONNECTORS, deadline: startedAt + STEP_MS, review: reviewer() });
        if (!(await saveNext(job.id, state, 'running'))) return res.status(409).json(BUSY);
        return res.status(200).json({ jobId: job.id, progress });
      }
      // Collecting is over: build the report and write the brief.
      const report = buildReport(state);
      const { brief, briefInfo } = await writeDeepBrief(report, { deadline: startedAt + REPORT_MS });
      state.report = publicReport({ ...report, brief, briefInfo });
      state.phase = 'done';
      if (!(await saveNext(job.id, state, 'done'))) return res.status(409).json(BUSY);
      return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: state.report });
    }

    if (body.action === 'brief') {
      const job = await getJob(String(body.jobId || ''), { owner });
      if (!job || !job.state.report) return res.status(404).json({ error: 'This check was not found. It may have expired; run it again.' });
      const { state } = job;
      const info = state.report.briefInfo;
      if (info?.mode === 'quoted' && info.retry) {
        const { brief, briefInfo } = await writeDeepBrief(state.report, { deadline: startedAt + REPORT_MS, avoid: info.tried || [] });
        state.report = { ...state.report, brief, briefInfo: { ...briefInfo, retry: false } };
        if (!(await saveNext(job.id, state, 'done'))) return res.status(409).json(BUSY);
      }
      return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: state.report });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('Deep founder check failed:', error.message);
    // The check itself is fine; it could not be saved or loaded just now. The page tries the same step again.
    if (error.code === 'JOB_STORE_UNAVAILABLE') return res.status(503).json({ error: 'The check could not be saved or loaded just now. Try again in a moment.' });
    return res.status(500).json({ error: 'The deep check failed. Please try again.' });
  }
}
