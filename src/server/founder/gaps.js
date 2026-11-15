/**
 * The second reader. When the loop runs dry, a model reads the records
 * collected so far and says what has not been followed up yet: a company or
 * school the patterns in extract.js missed, a co-founder, a relative the
 * record places in a public role, and a few searches that would test a
 * claim. This is how the check keeps improving on its own first pass.
 *
 * A model can invent things, so nothing it says is trusted on its word.
 * Every proposal must point at a record, and the code then checks:
 *   - that record exists and is already tied to the person (not a namesake);
 *   - the proposed name appears in that record's own text, letter for letter;
 *   - a relative is stated as kin in the same sentence that gives them a
 *     public role (the same rule as extract.js), and is not a minor;
 *   - a search names the person, so nobody else gets a search of their own.
 * Whatever fails is dropped. What passes is followed like any other thread.
 */
import { chatJson } from '../llm/providers';
import { restoreSubject } from './identity';
import { makeThread } from './finding';
import { mentions, publicRelativeIn, plausiblePersonName } from './extract';
import { isSensitive, mentionsMinor, isBlockedUrl } from './guardrails';

const item = (extra) => ({
  type: 'object',
  properties: { name: { type: 'string' }, record: { type: 'integer' }, ...extra },
  required: ['name', 'record', ...Object.keys(extra)],
  additionalProperties: false,
});

export const GAP_SCHEMA = {
  type: 'object',
  properties: {
    companies: { type: 'array', items: item({ role: { type: 'string' } }) },
    schools: { type: 'array', items: item({}) },
    people: { type: 'array', items: item({ tie: { type: 'string', enum: ['business', 'legal', 'family'] }, detail: { type: 'string' } }) },
    searches: { type: 'array', items: { type: 'string' } },
  },
  required: ['companies', 'schools', 'people', 'searches'],
  additionalProperties: false,
};

const PROMPT = `You help a diligence analyst find what a background check has not looked at yet.
You get numbered records already collected about one person, and the list of threads already followed.
Use ONLY the records. Never use outside knowledge. Copy every name exactly as it is written in the record you cite.
Return:
- companies: organisations the person founded, led, worked at, invested in or sat on the board of that are NOT in the followed list. "role" = what the record says the person did there.
- schools: universities or schools the person attended that are NOT in the followed list.
- people: other people tied to the person. tie "business" = co-founder, business partner, investor, employer. tie "legal" = named with them in a lawsuit, charge or settlement. tie "family" ONLY when the record itself states the kinship AND gives that relative a business, political or philanthropic role; never list children or anyone described only as family. "detail" = the words of the record that state the tie.
- searches: up to 6 web searches that would test a claim in the records or fill an obvious gap (an unexplained gap between jobs, a degree stated once, a dispute mentioned without its outcome). Each must contain the person's full name in double quotes.
Give the record number for every item. Empty lists are fine and better than guesses.`;

// A search must be about the person's professional record, never their private life
const PRIVATE_SEARCH = /\b(child|children|kids?|baby|toddler|teen(?:ager)?s?|grandchild\w*|minor|home|house|address|lives? (?:in|at)|phone|e-?mail|girlfriend|boyfriend|dating|affair|divorce|custody|wedding|health|illness|sick|religio\w*|church|mosque|synagogue|temple|salary|net worth|birthday|date of birth|age)\b/i;

const TEXT_RICH = { press: 3, identity: 3, career: 3, archive: 3, related: 3, litigation: 2, regulatory: 2, education: 2, corporate: 1, ip: 1, leaks: 1, sanctions: 1, exposure: 0 };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// The title and the quote are separate sentences: a role in the title must not attach to a name in the quote
const textOf = (f) => `${String(f.title || '').replace(/[.!?]*$/, '')}. ${f.quote || ''}`;

/** The records worth a second reading: tied to the person, with real text in them. */
export function recordsForReview(state, max = 45) {
  return state.findings
    .filter((f) => (f.match === 'confirmed' || f.match === 'likely') && (f.quote || '').length >= 40)
    .map((f) => ({ f, weight: (TEXT_RICH[f.category] ?? 1) + Math.min(2, (f.quote || '').length / 250) + (f.match === 'confirmed' ? 0.5 : 0) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max)
    .map((x) => x.f);
}

/**
 * Check a model's proposals against the records. Pure: no network.
 * @returns {{ threads: object[], searches: string[], dropped: number }}
 */
export function verifyGaps(state, records, data) {
  const subject = restoreSubject(state);
  const followed = new Set(Object.values(state.threads || {}).map((t) => `${t.kind}|${norm(t.value)}`));
  const known = (kind, value) => followed.has(`${kind}|${norm(value)}`);
  const threads = [];
  let dropped = 0;
  const seen = new Set();
  const recordAt = (n) => (Number.isInteger(n) && n >= 1 && n <= records.length ? records[n - 1] : null);
  const take = (thread) => {
    const key = thread && `${thread.kind}|${norm(thread.value)}`;
    if (!thread || seen.has(key)) { dropped += 1; return; }
    seen.add(key);
    threads.push(thread);
  };

  for (const kind of ['companies', 'schools']) {
    const threadKind = kind === 'companies' ? 'company' : 'school';
    for (const x of Array.isArray(data?.[kind]) ? data[kind].slice(0, 12) : []) {
      const record = recordAt(x?.record);
      const name = String(x?.name || '').trim();
      if (!record || name.length < 2 || name.length > 80 || !/[A-Za-z]/.test(name)) { dropped += 1; continue; }
      const text = textOf(record);
      // the record must name both the person and the organisation
      if (!subject.hasName(text) || !mentions(text, name) || subject.hasName(name) || known(threadKind, name)) { dropped += 1; continue; }
      // what the person did there (as the reader put it) decides how fully the company is checked
      const role = kind === 'companies' ? String(x.role || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
      take(makeThread(threadKind, name, `${role ? `${role}; ` : ''}named in a record about the person (${record.sourceLabel})`, { trusted: true }));
    }
  }

  for (const x of Array.isArray(data?.people) ? data.people.slice(0, 12) : []) {
    const record = recordAt(x?.record);
    const raw = String(x?.name || '').trim();
    if (!record) { dropped += 1; continue; }
    const text = textOf(record);
    const name = plausiblePersonName(raw, subject);
    if (!name || !subject.hasName(text) || !mentions(text, name) || mentionsMinor(text)) { dropped += 1; continue; }
    if (x.tie === 'family') {
      const kin = publicRelativeIn(subject, text, name);
      if (!kin || known('relative', name)) { dropped += 1; continue; }
      take(makeThread('relative', name, `${kin.relation}; described as ${kin.role} (${record.sourceLabel})`, { trusted: true, relation: kin.relation, role: kin.role }));
    } else {
      if (known('associate', name)) { dropped += 1; continue; }
      take(makeThread('associate', name, `${x.tie === 'legal' ? 'named with the person in a legal matter' : 'named with the person in business'} (${record.sourceLabel})`, { trusted: true }));
    }
  }

  const searches = [];
  for (const raw of Array.isArray(data?.searches) ? data.searches.slice(0, 10) : []) {
    const q = String(raw || '').replace(/\s+/g, ' ').trim();
    const site = q.match(/\bsite:(\S+)/i);
    if (q.length < 8 || q.length > 160 || !subject.hasName(q) || isSensitive(q) || mentionsMinor(q) || PRIVATE_SEARCH.test(q) || (site && isBlockedUrl(`https://${site[1]}`))) { dropped += 1; continue; }
    if (!searches.some((s) => norm(s) === norm(q))) searches.push(q);
    if (searches.length >= 6) break;
  }
  return { threads, searches, dropped };
}

/**
 * Ask a model what the check has missed, and keep only what the records bear out.
 * @param {object} state the check's state
 * @param {{ deadline?: number, complete?: Function }} options
 * @returns {Promise<{ threads: object[], searches: string[], dropped: number, model: string|null, note: string|null }>}
 */
export async function findGaps(state, { deadline = null, complete = chatJson } = {}) {
  const empty = { threads: [], searches: [], dropped: 0, model: null, note: null };
  const records = recordsForReview(state);
  if (records.length < 3) return empty;
  const followed = Object.values(state.threads || {}).filter((t) => t.trusted).map((t) => `${t.kind}: ${t.value}`);
  const block = records.map((f, i) => `[${i + 1}] (${f.sourceLabel}${f.date ? `, ${f.date}` : ''}) ${f.title}\n"${(f.quote || '').slice(0, 600)}"`).join('\n\n');
  const user = `Person: ${state.name}${state.company ? `\nCompany: ${state.company}` : ''}\n\nAlready followed:\n${followed.length ? followed.join('\n') : '(nothing yet)'}\n\nRecords:\n${block}`;
  let out = null;
  try {
    out = await complete([{ role: 'system', content: PROMPT }, { role: 'user', content: user }], {
      schema: GAP_SCHEMA, name: 'gaps', deadline, personal: true, maxTokens: 1800,
      check: (d) => Boolean(d) && typeof d === 'object' && !Array.isArray(d),
    });
  } catch {
    out = null;
  }
  if (!out?.data) return empty;
  const checked = verifyGaps(state, records, out.data);
  return { ...checked, model: out.model || null, note: null };
}
