import { getUserId } from '../../../server/auth';
import { chatComplete, chatJson, describeChain, llmStatus } from '../../../server/llm/providers';

/**
 * GET /api/debug/llm-check            -> the order the model chain would use now, per task (no model is called)
 * GET /api/debug/llm-check?run=chat   -> one tiny real call for that task (chat | analysis | extract | json),
 *                                        to confirm a provider accepts the request the chain sends
 *
 * Open in development and on preview deployments (which sit behind the
 * host's own sign-in); in production it requires a signed-in session.
 * Never returns keys.
 */
export const config = { maxDuration: 60 };

const RUNS = ['chat', 'analysis', 'extract', 'json'];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const open = process.env.NODE_ENV !== 'production' || process.env.VERCEL_ENV === 'preview';
  if (!open) {
    const userId = await getUserId(req, res);
    if (!userId) return res.status(401).json({ error: 'Sign in to view model diagnostics.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const run = String(req.query.run || '');
  const personal = req.query.personal === '1';
  const deadline = Date.now() + 50000;

  if (!run) {
    const [analysis, chat, extract] = await Promise.all(['analysis', 'chat', 'extract'].map((task) => describeChain({ task, personal })));
    return res.status(200).json({ providers: llmStatus().map(({ id, label, enabled }) => ({ id, label, enabled })), analysis, chat, extract });
  }
  if (!RUNS.includes(run)) return res.status(400).json({ error: `run must be one of: ${RUNS.join(', ')}` });

  const started = Date.now();
  if (run === 'json') {
    const schema = { type: 'object', properties: { capital: { type: 'string' }, country: { type: 'string' } }, required: ['capital', 'country'], additionalProperties: false };
    const out = await chatJson([{ role: 'user', content: 'Which city is the capital of France? Answer for the country France.' }], { schema, name: 'capital', deadline, personal, check: (d) => /paris/i.test(String(d?.capital)) });
    return res.status(200).json({ run, ok: Boolean(out), ms: Date.now() - started, ...(out ? { provider: out.providerLabel, model: out.model, data: out.data, skipped: out.skipped } : {}) });
  }
  const out = await chatComplete(
    [{ role: 'system', content: 'You are a careful analyst. Answer in one short sentence.' }, { role: 'user', content: 'A company was founded in 2012 and shut down in 2019. For how many years did it operate? Reply with the number and the word "years".' }],
    { task: run, maxTokens: 200, deadline, personal, accept: (text) => /\b(7|seven)\b/i.test(text) },
  );
  return res.status(200).json({ run, ok: Boolean(out), ms: Date.now() - started, ...(out ? { provider: out.providerLabel, model: out.model, answerMs: out.ms, text: out.text.slice(0, 160), skipped: out.skipped } : {}) });
}
