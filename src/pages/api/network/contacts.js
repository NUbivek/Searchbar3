/**
 * The signed-in user's imported network contacts.
 *
 *   GET    -> { contacts: Contact[], stats }   (compact: empty fields omitted)
 *   POST   { source: 'linkedin'|'csv'|'x', contacts: Contact[] }
 *          -> { saved, duplicates, truncated, rejected, stats, contacts }
 *          Replaces all contacts from that source (max 30,000 per user);
 *          `contacts` are the rows now saved for that source, so the page
 *          does not have to download the whole network again.
 *   DELETE -> { deleted, stats }  (removes all of the user's network data)
 *
 * 401 when signed out, 503 when no database is configured.
 */
import { withUser } from '../../../server/apiHelpers';
import {
  replaceContacts, listContacts, deleteAllContacts, contactStats, compactContact, MAX_CONTACTS_PER_USER,
} from '../../../server/network/store';
import { normalizeContact, SOURCES } from '../../../utils/network/parseContacts';

export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };

export default withUser(['GET', 'POST', 'DELETE'], async (req, res, userId) => {
  if (req.method === 'GET') {
    const [contacts, stats] = await Promise.all([listContacts(userId), contactStats(userId)]);
    return res.status(200).json({ contacts: contacts.map(compactContact), stats });
  }

  if (req.method === 'DELETE') {
    const deleted = await deleteAllContacts(userId);
    return res.status(200).json({ deleted, stats: await contactStats(userId) });
  }

  const { source, contacts } = req.body || {};
  if (!SOURCES.includes(source)) {
    return res.status(400).json({ error: `source must be one of: ${SOURCES.join(', ')}` });
  }
  if (!Array.isArray(contacts)) {
    return res.status(400).json({ error: 'contacts must be an array' });
  }
  if (contacts.length > MAX_CONTACTS_PER_USER) {
    return res.status(413).json({ error: `Too many contacts: the limit is ${MAX_CONTACTS_PER_USER.toLocaleString('en-US')} per account.` });
  }
  const clean = contacts.map((c) => normalizeContact(c, source)).filter(Boolean);
  const result = await replaceContacts(userId, source, clean);
  return res.status(200).json({
    ...result,
    rejected: contacts.length - clean.length,
    stats: await contactStats(userId),
  });
});
