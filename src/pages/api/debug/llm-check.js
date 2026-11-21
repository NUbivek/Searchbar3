import { debugAccess } from '../../../server/auth';
import { chatComplete, chatJson, describeChain, llmStatus } from '../../../server/llm/providers';
import { sampleState, sampleSearchers, SAMPLE_SUBJECT } from '../../../server/founder/sample';
import { runFounderCheck } from '../../../server/founderCheck';
import { buildReport, writeDeepBrief } from '../../../server/founder/report';
import { findGaps } from '../../../server/founder/gaps';
import { readProfile } from '../../../server/founder/profileModel';

/**
 * GET /api/debug/llm-check            -> the order the model chain would use now, per task (no model is called)
 * GET /api/debug/llm-check?run=chat   -> one tiny real call for that task (chat | analysis | extract | json),
 *                                        to confirm a provider accepts the request the chain sends
 * GET /api/debug/llm-check?run=brief  -> the deep background check's report writer on a fictional sample
 * GET /api/debug/llm-check?run=gaps   -> its second reader on the same fictional sample
 * GET /api/debug/llm-check?run=profile -> its profile reader (roles, education, boards) on the same fictional sample,
 *                                        with checks of what it should find, so a silent fall back to rules shows
 * GET /api/debug/llm-check?run=quick  -> the quick brief's writer on fictional search results (no search is made)
 *
 * Who may call it is decided by debugAccess (src/server/auth.js): open in
 * development; on a preview deployment open behind the host's own sign-in but
 * limited per caller and per deployment each hour; in production any signed-in
 * account (the allow-list applies when set; signed out gets 401 and is asked to
 * sign in), limited per account each hour and, for model runs, all accounts together.
 * Every run is bounded in time, never returns keys, and a run that fails
 * answers with a plain message, never the inner error.
 */
export const config = { maxDuration: 60 };

const RUNS = ['chat', 'analysis', 'extract', 'json', 'brief', 'gaps', 'profile', 'quick'];

/** A skipped provider's reason, cut short: it is for telling services apart, not for reading their errors. */
const skippedOf = (list) => (Array.isArray(list) ? list.slice(0, 12).map(({ provider, model, why }) => ({ provider, model, why: String(why || '').slice(0, 80) })) : undefined);

/**
 * What the profile reader should find in the fictional sample: her studies at Harrowgate, her earlier role
 * running Tidewater Drones, her director's seat at Lumenfold Robotics, and nothing about her brother Casey
 * (a relative is never given a role in her profile).
 */
function profileChecks(profile) {
  const roles = [...(profile?.resume?.roles || []), ...(profile?.roles || []), ...(profile?.boards || [])];
  const schools = [...(profile?.resume?.education || []), ...(profile?.education || [])];
  const text = (x) => Object.values(x || {}).filter((v) => typeof v === 'string').join(' ');
  return {
    harrowgateEducation: schools.some((e) => /Harrowgate/i.test(text(e))),
    tidewaterChiefExecutive: roles.some((r) => /Tidewater/i.test(text(r)) && /chief executive|\bCEO\b|ran|founder/i.test(text(r))),
    lumenfoldDirector: roles.some((r) => /Lumenfold/i.test(text(r)) && /director|founder|chief executive|\bCEO\b/i.test(text(r))),
    noRoleForCasey: !JSON.stringify(profile || {}).match(/Casey/i),
  };
}

/** The route always answers inside its own time limit, whatever a model service does. */
const within = (promise, ms) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
  ]);
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const run = String(req.query?.run || '');
  if (!(await debugAccess(req, res, { route: 'llm-check', costly: Boolean(run) }))) return undefined;
  res.setHeader('Cache-Control', 'no-store');
  try {
    return await answer(req, res, run);
  } catch (error) {
    // The inner error can name addresses or a service's own words; it goes to the server log only.
    console.error('llm-check run failed:', error?.message);
    return res.status(500).json({ run, ok: false, error: 'The run failed.' });
  }
}

async function answer(req, res, run) {
  const personal = req.query?.personal === '1';
  const deadline = Date.now() + 50000;

  if (!run) {
    const [analysis, chat, extract] = await Promise.all(['analysis', 'chat', 'extract'].map((task) => describeChain({ task, personal })));
    return res.status(200).json({ providers: llmStatus().map(({ id, label, enabled }) => ({ id, label, enabled })), analysis, chat, extract });
  }
  if (!RUNS.includes(run)) return res.status(400).json({ error: `run must be one of: ${RUNS.join(', ')}` });

  const started = Date.now();
  if (run === 'brief') {
    const report = buildReport(sampleState());
    const written = await within(writeDeepBrief(report, { deadline: Date.now() + 44000 }), 52000);
    if (!written) return res.status(200).json({ run, ok: false, ms: Date.now() - started, note: 'no model answered inside the time limit' });
    const { brief, briefInfo } = written;
    return res.status(200).json({ run, ok: briefInfo?.mode === 'ai', ms: Date.now() - started, briefInfo, brief });
  }
  if (run === 'gaps') {
    const found = await within(findGaps(sampleState(), { deadline: Date.now() + 30000 }), 45000);
    if (!found) return res.status(200).json({ run, ok: false, ms: Date.now() - started, note: 'no model answered inside the time limit' });
    return res.status(200).json({ run, ok: Boolean(found.model), ms: Date.now() - started, ...found });
  }
  if (run === 'profile') {
    const state = sampleState();
    const report = buildReport(state);
    // `trace` lets the reader say why it fell back (no records, no model, check failed, nothing verified).
    const trace = {};
    const profile = await within(readProfile(report, state, { deadline: Date.now() + 40000, trace }), 50000);
    const checks = profileChecks(profile);
    const readBy = profile?.readBy || 'rules';
    const ok = readBy === 'model' && Object.values(checks).every(Boolean);
    return res.status(200).json({ run, ok, ms: Date.now() - started, readBy, checks, ...(Object.keys(trace).length ? { trace } : {}), profile: profile || null });
  }
  if (run === 'quick') {
    const out = await within(runFounderCheck({ ...SAMPLE_SUBJECT, deadline: Date.now() + 44000 }, { searchers: sampleSearchers() }), 52000);
    if (!out) return res.status(200).json({ run, ok: false, ms: Date.now() - started, note: 'no model answered inside the time limit' });
    const sources = Array.isArray(out.sources) ? out.sources.length : 0;
    return res.status(200).json({ run, ok: out.briefInfo?.mode === 'ai', ms: Date.now() - started, mode: out.briefInfo?.mode || 'none', sources, briefInfo: out.briefInfo || null, brief: out.brief || null });
  }
  if (run === 'json') {
    const schema = { type: 'object', properties: { capital: { type: 'string' }, country: { type: 'string' } }, required: ['capital', 'country'], additionalProperties: false };
    const out = await within(chatJson([{ role: 'user', content: 'Which city is the capital of France? Answer for the country France.' }], { schema, name: 'capital', deadline, personal, check: (d) => /paris/i.test(String(d?.capital)) }), 52000);
    return res.status(200).json({ run, ok: Boolean(out), ms: Date.now() - started, ...(out ? { provider: out.providerLabel, model: out.model, data: out.data, skipped: skippedOf(out.skipped) } : {}) });
  }
  const out = await within(chatComplete(
    [{ role: 'system', content: 'You are a careful analyst. Answer in one short sentence.' }, { role: 'user', content: 'A company was founded in 2012 and shut down in 2019. For how many years did it operate? Reply with the number and the word "years".' }],
    { task: run, maxTokens: 200, deadline, personal, accept: (text) => /\b(7|seven)\b/i.test(text) },
  ), 52000);
  return res.status(200).json({ run, ok: Boolean(out), ms: Date.now() - started, ...(out ? { provider: out.providerLabel, model: out.model, answerMs: out.ms, text: String(out.text || '').slice(0, 160), skipped: skippedOf(out.skipped) } : {}) });
}
