/**
 * Ask your network.
 *
 *   POST { question?: string, target?: string, fromPage?: boolean, llm?: boolean,
 *          today?: 'YYYY-MM-DD', filters?: { sources?: string[], directOnly?: boolean },
 *          contacts?: Contact[] }
 *   -> { question, filters: { companies, roles, keywords, locations, tags, industries,
 *                             connected, intent, lens, exclude?, notUsed?, ... },
 *        understood: string[] (what was read, in plain words: "Tagged “prospect”", "In New York"),
 *        parsedBy: 'rules'|'llm'|'target', intent, contactCount,
 *        results: [{ contact, score, reasons }] (at most 100), total,
 *        keys: string[] (the contact key of every match, uncapped, in rank order),
 *        notes,
 *        intro?: { target, direct, directTotal, keys, viaInvestors: [{ investor, evidence, contacts, total }],
 *                  investorsChecked, viaPastEmployees: [], profileStatus, notes } }
 *
 * The question is answered over the people in view: `filters.sources` and
 * `filters.directOnly` (the page's source chips and "direct only") are
 * applied before anything is ranked or counted.
 *
 * `target` is a company given as data (the page's "Intro paths" button) and
 * `fromPage` marks a question the page built itself (its examples): neither
 * is ever sent to a model, so no company name or tag from the file can reach
 * one. The model is used only for a question the user typed, only when the
 * rules read nothing from it, only when signed in, and at most a few times an
 * hour per person. Signed out it is never used.
 *
 * Signed in: searches the saved contacts (body contacts are ignored unless
 * the database is unavailable). Signed out: searches the contacts the
 * browser sends, which are used for this request only and never stored.
 * Contacts are never sent to an LLM or any other external service. With no
 * contacts at all the answer is 400.
 *
 * `today` is the browser's own date, so "this year" and "this month" are the
 * user's, not the server's.
 */
import { getUserId } from '../../../server/auth';
import { persistenceMode } from '../../../server/db';
import { listContacts, MAX_CONTACTS_PER_USER } from '../../../server/network/store';
import { answerQuestion } from '../../../server/network/query';
import { chatComplete } from '../../../server/llm/providers';
import { normalizeContact, SOURCES } from '../../../utils/network/parseContacts';

// Question interpretation (up to 12s) plus the intro-path profile lookup
// (up to 25s) can exceed Vercel's 10s default.
export const config = { api: { bodyParser: { sizeLimit: '15mb' } }, maxDuration: 60 };

// Model reads per signed-in person per hour; past it the rules answer alone.
export const MODEL_READS_PER_HOUR = 20;
const HOUR_MS = 3600000;
const modelReads = new Map(); // userId -> timestamps of recent model reads

/** True (and counted) when this person may have one more question read by the model. */
function takeModelRead(userId, now = Date.now()) {
  const recent = (modelReads.get(userId) || []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= MODEL_READS_PER_HOUR) { modelReads.set(userId, recent); return false; }
  recent.push(now);
  modelReads.set(userId, recent);
  // Keep the table small: forget people with nothing in the last hour.
  if (modelReads.size > 5000) for (const [k, v] of modelReads) if (!v.some((t) => now - t < HOUR_MS)) modelReads.delete(k);
  return true;
}
export function __resetModelReadsForTests() { modelReads.clear(); }

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
    const out = key ? { ...clean, key } : clean;
    // "Direct only" needs to know who came through a colleague.
    if (c?.relationship === 'firm') { out.relationship = 'firm'; if (typeof c.via === 'string') out.via = c.via.slice(0, 120); }
    return out;
  }).filter(Boolean);
}

/** The people in view: only the sources switched on, and only direct contacts when asked. */
function inView(list, filters) {
  if (!filters || typeof filters !== 'object') return list;
  const sources = Array.isArray(filters.sources) ? filters.sources.filter((s) => SOURCES.includes(s)) : null;
  const directOnly = filters.directOnly === true;
  if (!sources && !directOnly) return list;
  const allowed = sources ? new Set(sources) : null;
  return list.filter((c) => (!allowed || allowed.has(c.source)) && !(directOnly && c.relationship === 'firm'));
}

/** The browser's date when it is a real date within two days of the server's; otherwise none. */
function clientToday(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t) || Math.abs(t - Date.now()) > 2 * 86400000) return undefined;
  return value;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { question, contacts, target, llm, fromPage, filters, today } = req.body || {};
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
    list = inView(list, filters);
    if (!list.length) {
      return res.status(400).json({ error: 'There are no contacts to search yet. Add your contacts first.' });
    }
    // The model only for a question the user typed, signed in, and only while
    // the hourly allowance lasts: it is counted when the model is actually
    // asked (the rules answer most questions alone).
    const typed = !!q && !t && fromPage !== true;
    const complete = async (messages, options) => (takeModelRead(userId) ? chatComplete(messages, options) : null);
    const answer = await answerQuestion(list, {
      question: q || `Intro paths to ${t}`,
      target: t || undefined,
      fromPage: fromPage === true,
      useLlm: typed && llm !== false && !!userId,
      complete,
      today: clientToday(today),
    });
    return res.status(200).json({ ...answer, contactsFrom: from });
  } catch (error) {
    console.error('Network query failed:', error);
    return res.status(500).json({
      error: 'Could not search your network. Please try again.',
      ...(process.env.NODE_ENV === 'development' ? { detail: String(error.message || error) } : {}),
    });
  }
}
