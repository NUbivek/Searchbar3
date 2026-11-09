/**
 * Ask your network.
 *
 *   POST { question: string, contacts?: Contact[], target?: string, llm?: boolean }
 *   -> { question, filters: { companies, roles, keywords, locations, intent },
 *        parsedBy: 'rules'|'llm'|'target', intent, contactCount,
 *        results: [{ contact, score, reasons }], total, notes,
 *        intro?: { target, direct, viaInvestors: [{ investor, evidence, contacts, total }],
 *                  investorsChecked, viaPastEmployees: [], profileStatus, notes } }
 *
 * Signed in: searches the saved contacts (body contacts are ignored unless
 * the database is unavailable). Signed out: searches the contacts the
 * browser sends, which are used for this request only and never stored.
 * Contacts are never sent to an LLM or any other external service; at most
 * the question text is.
 */
import { getUserId } from '../../../server/auth';
import { persistenceMode } from '../../../server/db';
import { listContacts, MAX_CONTACTS_PER_USER } from '../../../server/network/store';
import { answerQuestion } from '../../../server/network/query';
import { normalizeContact } from '../../../utils/network/parseContacts';

// Question interpretation (up to 12s) plus the intro-path profile lookup
// (up to 25s) can exceed Vercel's 10s default.
export const config = { api: { bodyParser: { sizeLimit: '15mb' } }, maxDuration: 60 };

/**
 * Signed-out contacts come from the browser with only the fields scoring
 * uses (no email). `key` is the browser's identity key for the contact, so
 * results can be matched back to the graph without sending the email that
 * the key may be derived from.
 */
function bodyContacts(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_CONTACTS_PER_USER).map((c) => {
    const clean = normalizeContact(c, c?.source);
    if (!clean) return null;
    const key = typeof c?.key === 'string' && /^[uen]:/.test(c.key) ? c.key.slice(0, 600) : '';
    return key ? { ...clean, key } : clean;
  }).filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { question, contacts, target, llm } = req.body || {};
  const q = typeof question === 'string' ? question.trim().slice(0, 500) : '';
  const t = typeof target === 'string' ? target.trim().slice(0, 120) : '';
  if (!q && !t) return res.status(400).json({ error: 'Ask a question, e.g. "Who do I know at Stripe?"' });
  if (Array.isArray(contacts) && contacts.length > MAX_CONTACTS_PER_USER) {
    return res.status(413).json({ error: `Too many contacts: the limit is ${MAX_CONTACTS_PER_USER.toLocaleString('en-US')}.` });
  }

  try {
    let list = null;
    let from = 'request';
    const userId = await getUserId(req, res);
    if (userId && persistenceMode() !== 'none') {
      try {
        list = await listContacts(userId);
        from = 'saved';
      } catch (error) {
        console.warn('Network query: saved contacts unavailable:', error.message);
      }
    }
    if (!list || (!list.length && Array.isArray(contacts) && contacts.length)) {
      list = bodyContacts(contacts);
      from = 'request';
    }
    const answer = await answerQuestion(list, { question: q || `Intro paths to ${t}`, target: t || undefined, useLlm: llm !== false });
    return res.status(200).json({ ...answer, contactsFrom: from });
  } catch (error) {
    console.error('Network query failed:', error);
    return res.status(500).json({
      error: 'Could not search your network. Please try again.',
      ...(process.env.NODE_ENV === 'development' ? { detail: String(error.message || error) } : {}),
    });
  }
}
