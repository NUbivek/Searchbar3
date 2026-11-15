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

/** Who is asking: the signed-in user, or (only when public checks are allowed) a label for their address. */
async function ownerOf(req, res) {
  const userId = await getUserId(req, res);
  if (userId) return { owner: userId, signedIn: true };
  if (process.env.FOUNDER_DEEP_PUBLIC === 'true') return { owner: `anon:${clientLabel(clientIp(req))}`, signedIn: false };
  return { owner: null, signedIn: false };
}

/** The report without internal fields, ready for the page. */
function publicReport(report) {
  const strip = ({ score, step, via, matchFixed, ...rest }) => rest;
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
      if (await recentJobCount(owner, 60) >= MAX_JOBS_PER_HOUR) {
        return res.status(429).json({ error: 'You have started many checks in the last hour. Try again later.' });
      }
      const state = startState({ name, company });
      const { id } = await createJob({ name, company, owner, state });
      const { progress } = await stepDeepCheck(state, { connectors: CONNECTORS, deadline: startedAt + STEP_MS, review: reviewer() });
      await saveJob(id, { state, status: 'running' });
      return res.status(200).json({ jobId: id, progress });
    }

    if (body.action === 'step') {
      const job = await getJob(String(body.jobId || ''), { owner });
      if (!job) return res.status(404).json({ error: 'This check was not found. It may have expired; run it again.' });
      const { state } = job;
      if (state.report) return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: state.report });
      if (state.phase === 'collect') {
        const { progress } = await stepDeepCheck(state, { connectors: CONNECTORS, deadline: startedAt + STEP_MS, review: reviewer() });
        await saveJob(job.id, { state, status: 'running' });
        return res.status(200).json({ jobId: job.id, progress });
      }
      // Collecting is over: build the report and write the brief.
      const report = buildReport(state);
      const { brief, briefInfo } = await writeDeepBrief(report, { deadline: startedAt + REPORT_MS });
      state.report = publicReport({ ...report, brief, briefInfo });
      state.phase = 'done';
      await saveJob(job.id, { state, status: 'done' });
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
        await saveJob(job.id, { state, status: 'done' });
      }
      return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: state.report });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('Deep founder check failed:', error.message);
    return res.status(500).json({ error: 'The deep check failed. Please try again.' });
  }
}
