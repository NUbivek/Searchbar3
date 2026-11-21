/**
 * Deep background check, one step per request (a full check takes minutes,
 * a serverless request does not).
 *
 *   POST { action: 'start', name, company,     -> { jobId, progress, assumed?, networkSuggestion? }
 *          website?, profileUrl?, place?,           The owner's running check of the same person from the last
 *          otherCompanies?: [], school?,            hour is handed back instead of starting another.
 *          otherNames?: [], useNetworkCompany?,
 *          askNetwork?, confirmedCompany? }      -> { needsConfirm: { company, question } } (nothing started)
 *                                                   With no company typed, the one contact with this name is
 *                                                   a question for the user first (askNetwork: the page can
 *                                                   ask it); only after a yes (confirmedCompany) is that
 *                                                   company assumed, with the network as its origin.
 *   POST { action: 'step', jobId }           -> { progress }            while collecting
 *                                            -> { done: true, report }  when finished
 *                                            -> 409 while another request works on the same check
 *   POST { action: 'brief', jobId }          -> { done: true, report }  one more try at the written summary,
 *                                               with other models, when the first ran out of time
 *   GET  ?jobId=                             -> { progress, report? }
 *   GET  ?name=&company=                     -> the account's latest unexpired check of that person
 *                                               (running or finished), or 404
 *   GET  ?list=1                             -> { jobs: [{ id, name, company, state, when, redFlags }] }
 *
 * The browser calls 'step' until it gets `done`. State lives in the job
 * store between calls. Sign-in is required unless FOUNDER_DEEP_PUBLIC=true:
 * a check gathers a lot about one person and uses shared free quotas, so it
 * is tied to an account and limited per hour.
 */
import { getUserId, requireFounderUser } from '../../../server/auth';
import { startState, stepDeepCheck, progressOf, stopCollecting, validateCheckInput, validateOrgName, validatePersonName } from '../../../server/founder/deepCheck';
import { createSubject } from '../../../server/founder/identity';
import { buildReport, writeDeepBrief, quotedDeepBrief } from '../../../server/founder/report';
import { createJob, getJob, saveJob, recentJobCount, recentJobCountAll, oldestRecentJobAt, clientLabel, leaseJob, releaseLease, findLatestJob, listJobs } from '../../../server/founder/jobStore';
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
/**
 * The company to start with when none was typed: the one contact with this full name, and only once the user
 * said yes to it (`confirmedCompany`), so a namesake in the network never silently decides who is checked.
 *   -> { seed: { company, origin: 'network' } } after a yes that still holds
 *   -> { suggestion: { company, question } } when there is a contact to ask about
 *   -> {} otherwise (signed out, a company typed, no single contact, or the network could not be read)
 */
async function networkSeed(signedIn, owner, name, company, confirmedCompany) {
  if (!signedIn || company) return {};
  try {
    const link = await linker();
    const confirmed = String(confirmedCompany || '').trim();
    if (confirmed) {
      const seed = await link.companySeed(owner, name, '', { confirmedCompany: confirmed });
      return seed?.company ? { seed: { company: seed.company, origin: 'network' } } : {};
    }
    const suggestion = await link.seedSuggestion(owner, name, '');
    return suggestion?.company ? { suggestion: { company: suggestion.company, question: suggestion.question } } : {};
  } catch {
    return {};
  }
}
/** Resolves to `fallback` once `until` (a clock time) passes, so a slow part never holds the answer. */
function by(promise, until, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, until - Date.now())); }),
  ]).finally(() => clearTimeout(timer));
}
/** The companies whose investors are looked up: the person's company, then up to two they founded earlier. */
function investorCompanies(report) {
  const out = [];
  const add = (c) => { const v = String(c || '').trim(); if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v); };
  add(report.company || report.profile?.company);
  for (const f of report.profile?.founded || []) add(f?.org);
  return out.slice(0, 3);
}
/**
 * Investors of the person's companies (the current one and up to two they founded before), looked up once
 * when the report is built, never past `until`. Only company names are ever used as search terms.
 * -> { investors, missed }: missed when a lookup did not finish (the report then says so).
 */
async function networkInvestors(signedIn, owner, report, until) {
  if (!signedIn) return { investors: [], missed: false };
  const MISSED = { investors: [], missed: true };
  return by((async () => {
    try {
      const link = await linker();
      const store = await import('../../../server/network/store');
      if (!(await store.countContacts(owner))) return { investors: [], missed: false };
      const companies = investorCompanies(report);
      if (!companies.length) return { investors: [], missed: false };
      // All companies under one time limit, each investor kept with the company it backed ({ name, of }), so the
      // report can say "an investor in Upfit Labs, which they founded". Any lookup that did not finish is said.
      const result = await link.lookupInvestorsForCompanies(companies, { timeoutMs: Math.min(8000, until - Date.now()), max: 3 });
      return { investors: (result?.investors || []).slice(0, 25), missed: !result?.complete };
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
// All accounts together: new accounts are cheap to make, the sources' shared allowances are not.
export const MAX_JOBS_ALL_PER_HOUR = 60;
const MANY_STARTED = 'Many checks have been started in the last hour. Try again later.';

/** The second reader (gaps.js) needs an AI model; without one the loop simply stops when it runs dry. */
const reviewer = () => (llmConfigured() ? findGaps : null);

/**
 * The client's address, for counting signed-out starts. Only an address the host itself sets is believed
 * (x-real-ip, x-vercel-forwarded-for), else the last x-forwarded-for hop (the one the host's own proxy
 * appended; the left-most is whatever the client sent), else the socket.
 */
export function clientIp(req) {
  const h = req.headers || {};
  const first = (v) => String(Array.isArray(v) ? v[0] : v || '').split(',')[0].trim();
  const last = (v) => String(Array.isArray(v) ? v[v.length - 1] : v || '').split(',').map((x) => x.trim()).filter(Boolean).pop() || '';
  return first(h['x-real-ip']) || first(h['x-vercel-forwarded-for']) || last(h['x-forwarded-for']) || String(req.socket?.remoteAddress || '');
}
/** Checks without sign-in, for local testing only: never honoured in production, whatever the switch says. */
const publicAllowed = () => process.env.FOUNDER_DEEP_PUBLIC === 'true' && (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test');

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

/**
 * Who is asking: the signed-in user, or (only when public checks are allowed, never in production) a label for
 * their address. Otherwise an account the allow-list leaves out is told so (403) and a signed-out visitor is
 * asked to sign in (401), by requireFounderUser itself: then `answered` is set and nothing else is sent.
 */
async function ownerOf(req, res) {
  if (publicAllowed()) {
    const userId = await getUserId(req, res);
    if (userId) return { owner: userId, signedIn: true };
    return { owner: `anon:${clientLabel(clientIp(req))}`, signedIn: false };
  }
  const userId = await requireFounderUser(req, res);
  return userId ? { owner: userId, signedIn: true } : { owner: null, signedIn: false, answered: true };
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

const NOT_FOUND = { error: 'This check was not found. It may have expired; run it again.' };
// A step that throws twice in a row ends collecting (the report is built from what was found); a report that
// cannot be assembled three times ends the check as failed, rather than failing the same way forever.
const FAILED_STEPS_TO_STOP = 2;
const REPORT_FAILURES_TO_STOP = 3;
const REPORT_FAILED = 'The report could not be assembled from this check. Run the check again.';

/** One line per check for the page's list (never the report itself). */
function jobLine(j) {
  const state = j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : 'running';
  return { id: j.id, name: j.name, company: j.company || '', state, when: new Date(j.updatedAt || j.createdAt || Date.now()).toISOString(), redFlags: j.redFlags ?? null };
}

/** What the page is told about a check: progress, and the report once there is one. */
async function answerFor(job, { signedIn, owner, startedAt }) {
  const { state } = job;
  if (state.phase === 'failed') return { jobId: job.id, progress: progressOf(state), failed: true, error: state.failure || REPORT_FAILED };
  return { jobId: job.id, progress: progressOf(state), ...(state.report ? { done: true, report: await withNetwork(signedIn, owner, state, startedAt + REPORT_BUDGET.NETWORK_UNTIL_MS) } : {}) };
}

/**
 * Note on the saved check that a step or the report failed, so the next request does not repeat the same
 * failure forever. Reads the saved copy (the failed request's copy may be half changed). Never throws.
 */
async function noteFailure(id, owner, what) {
  try {
    const fresh = await getJob(id, { owner });
    if (!fresh) return;
    const { state } = fresh;
    let status = 'running';
    if (what === 'step' && state.phase === 'collect') {
      state.failedSteps = (state.failedSteps || 0) + 1;
      if (state.failedSteps >= FAILED_STEPS_TO_STOP) stopCollecting(state, 'A step of the check failed twice in a row, so collecting stopped here. The report is built from what was found, and the lookups not run are listed as not run.');
    } else if (what === 'report') {
      state.reportFailures = (state.reportFailures || 0) + 1;
      if (state.reportFailures >= REPORT_FAILURES_TO_STOP) { state.phase = 'failed'; state.failure = REPORT_FAILED; status = 'failed'; }
    } else return;
    await saveNext(id, state, status);
  } catch (error) {
    console.warn('founder check failure not recorded:', error?.message);
  }
}

/**
 * The person's name must be one the matcher can find in a record; a name in a script it cannot read yet is
 * swapped for a readable other name the user gave, else refused with a plain reason.
 */
function readableName(value) {
  // typed in lower case ("jane roe") is still a readable name: records write it with capitals
  const titled = (n) => String(n).replace(/(^|[\s'’-])(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
  const readable = (n) => { try { const s = createSubject({ name: n }); return s.hasName(n) || s.hasName(titled(n)); } catch { return false; } };
  if (readable(value.name)) return { ok: true, value };
  const other = (value.otherNames || []).find(readable);
  if (other) return { ok: true, value: { ...value, name: other, otherNames: [value.name, ...value.otherNames.filter((n) => n !== other)] } };
  return { ok: false, error: 'Records cannot yet be matched to a name written in this script. Enter the name in Latin letters, and add this form under other names.' };
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { owner, signedIn, answered } = await ownerOf(req, res);
    if (!owner) return answered ? undefined : res.status(401).json({ error: 'Sign in to run a deep background check.', signIn: true });

    if (req.method === 'GET') {
      const q = req.query || {};
      // The account's recent checks, so the page can offer them again after a reload or a sign-in.
      if (q.list) return res.status(200).json({ jobs: (await listJobs(owner, { limit: 20 })).map(jobLine) });
      if (q.jobId) {
        const job = await getJob(String(q.jobId || ''), { owner });
        if (!job) return res.status(404).json(NOT_FOUND);
        return res.status(200).json(await answerFor(job, { signedIn, owner, startedAt }));
      }
      if (q.name) {
        // The latest unexpired check of this person for this account, running or finished.
        const company = validateOrgName(q.company);
        const person = validatePersonName(q.name, { company: company.ok ? company.value : '' });
        if (!person.ok || !company.ok) return res.status(400).json({ error: (person.ok ? company : person).error });
        const job = await findLatestJob(owner, { name: person.name, company: company.value });
        if (!job) return res.status(404).json(NOT_FOUND);
        return res.status(200).json(await answerFor(job, { signedIn, owner, startedAt }));
      }
      return res.status(400).json({ error: 'Say which check to read.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.action === 'start') {
      const checked = validateCheckInput(body);
      if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field });
      const named = readableName(checked.value);
      if (!named.ok) return res.status(400).json({ error: named.error, field: 'name' });
      const input = named.value;
      // The same person started in the last hour and still running: hand it back rather than use another slot.
      const running = await findLatestJob(owner, { name: input.name, company: input.company, status: 'running', withinMinutes: 60 });
      if (running && (running.state?.phase === 'collect' || running.state?.phase === 'report')) return res.status(200).json({ jobId: running.id, progress: progressOf(running.state), resumed: true });
      // network pairing: with no company typed, the one contact with this name is put to the user as a question
      // first. Only after a yes is its company assumed: it may make records likely, never confirmed, and the report
      // says so. A page that cannot ask yet gets the check without it, and the question beside it.
      const network = body.useNetworkCompany === false ? {} : await networkSeed(signedIn, owner, input.name, input.company, body.confirmedCompany);
      if (network.suggestion && body.askNetwork === true) return res.status(200).json({ needsConfirm: network.suggestion });
      const seed = network.seed || null;
      const state = startState({ ...input, assumedCompany: seed?.company || '' });
      if (seed) state.networkSeed = { company: seed.company, origin: 'network' }; // network pairing
      // The count and the record of the new job happen under one lock, and the
      // job store may refuse the insert itself (limited) when the hour is full.
      // A job that could not be recorded throws and ends in a 500, never a check run from memory.
      const created = await oneStartAtATime(owner, async () => {
        if (await recentJobCount(owner, 60) >= MAX_JOBS_PER_HOUR) return null;
        if (await recentJobCountAll(60) >= MAX_JOBS_ALL_PER_HOUR) return { everyone: true };
        const job = await createJob({ name: input.name, company: input.company, owner, state, limit: { minutes: 60, max: MAX_JOBS_PER_HOUR } });
        return job && job.id && !job.limited ? job : null;
      });
      if (!created) {
        // When the oldest of the hour's checks leaves the window a slot frees: the page says that time.
        const oldest = await oldestRecentJobAt(owner, 60).catch(() => null);
        const retryAfter = oldest ? Math.max(1, Math.ceil((oldest + 60 * 60000 - Date.now()) / 1000)) : null;
        if (retryAfter && typeof res.setHeader === 'function') res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'You have started many checks in the last hour. Try again later.', ...(retryAfter ? { retryAfter } : {}) });
      }
      if (created.everyone) return res.status(429).json({ error: MANY_STARTED });
      const { id } = created;
      const extra = seed ? { assumed: { company: seed.company } } : network.suggestion ? { networkSuggestion: network.suggestion } : {};
      // The first step runs now. If it fails or cannot be saved, the check still exists and its id goes back:
      // the page's next step carries on from the saved start, and no second slot is used.
      try {
        const { progress } = await stepDeepCheck(state, { connectors: CONNECTORS, deadline: startedAt + STEP_MS, review: reviewer() });
        await saveNext(id, state, 'running');
        return res.status(200).json({ jobId: id, progress, ...extra });
      } catch (error) {
        console.error('Deep founder check: first step not completed:', error.message);
        const saved = await getJob(id, { owner }).catch(() => null);
        return res.status(200).json({ jobId: id, progress: saved ? progressOf(saved.state) : null, ...extra });
      }
    }

    if (body.action === 'step' || body.action === 'brief') {
      // One request at a time works on a check: a second one is told it is busy before it sends anything out.
      const leased = await leaseJob(String(body.jobId || ''), { owner });
      if (!leased) return res.status(404).json(NOT_FOUND);
      if (leased.busy) return res.status(409).json(BUSY);
      const { job, leaseId } = leased;
      const { state } = job;
      let saved = false;
      let stage = 'step';
      const save = async (status) => { saved = await saveNext(job.id, state, status); return saved; };
      try {
        if (body.action === 'brief') {
          if (!state.report) return res.status(404).json(NOT_FOUND);
          const info = state.report.briefInfo;
          if (info?.mode === 'quoted' && info.retry) {
            // Cut off at the same share as the first try; then the records-only brief stays, and no further try is offered.
            const out = await by(writeDeepBrief(state.report, { deadline: startedAt + REPORT_MS, avoid: info.tried || [] }), startedAt + REPORT_BUDGET.BRIEF_HARD_MS, null);
            state.report = out
              ? { ...state.report, brief: out.brief, briefInfo: { ...out.briefInfo, retry: false } }
              : { ...state.report, briefInfo: { ...info, retry: false } };
            if (!(await save('done'))) return res.status(409).json(BUSY);
          }
          return res.status(200).json(await answerFor(job, { signedIn, owner, startedAt }));
        }
        if (state.phase === 'failed') return res.status(500).json({ error: state.failure || REPORT_FAILED, failed: true });
        if (state.report) return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: await withNetwork(signedIn, owner, state, startedAt + REPORT_BUDGET.NETWORK_UNTIL_MS) });
        if (state.phase === 'collect') {
          const { progress } = await stepDeepCheck(state, { connectors: CONNECTORS, deadline: startedAt + STEP_MS, review: reviewer() });
          if (state.failedSteps) state.failedSteps = 0;
          if (!(await save('running'))) return res.status(409).json(BUSY);
          return res.status(200).json({ jobId: job.id, progress });
        }
        // Collecting is over: build the report and write the brief.
        stage = 'report';
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
        if (!(await save('done'))) return res.status(409).json(BUSY);
        return res.status(200).json({ jobId: job.id, done: true, progress: progressOf(state), report: await withNetwork(signedIn, owner, state, startedAt + REPORT_BUDGET.NETWORK_UNTIL_MS) });
      } catch (error) {
        // A store that could not answer is not the check's fault: nothing is counted against it.
        if (!saved && error?.code !== 'JOB_STORE_UNAVAILABLE' && body.action === 'step') {
          await releaseLease(job.id, leaseId);
          await noteFailure(job.id, owner, stage);
          saved = true; // the failure note saved (and so released) it, or the lease was given back
        }
        throw error;
      } finally {
        if (!saved) await releaseLease(job.id, leaseId);
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('Deep founder check failed:', error.message);
    // The check itself is fine; it could not be saved or loaded just now. The page tries the same step again.
    if (error.code === 'JOB_STORE_UNAVAILABLE') return res.status(503).json({ error: 'The check could not be saved or loaded just now. Try again in a moment.' });
    return res.status(500).json({ error: 'The deep check failed. Please try again.' });
  }
}
