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
 *     public role (the same rule as extract.js), and is not a minor; a
 *     name the record calls kin is a relative whatever tie the model gave;
 *   - a business or legal tie is stated in a sentence that names the person;
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
const PRIVATE_SEARCH = /\b(child|children|kids?|baby|toddler|teen(?:ager)?s?|grandchild\w*|minor|home|house|address|lives? (?:in|at)|phone|e-?mail|girlfriend|boyfriend|dating|affair|divorce|custody|wedding|health|illness|sick|religio\w*|church|mosque|synagogue|temple|salary|net worth|birthday|date of birth|age|born|birth\w*|nationality|citizen\w*|passport|visa|ethnic\w*|mother|father|parents?|wife|husband|spouse|siblings?|brother|sister|son|daughter|pregnan\w*|married|marriage)\b/i;

// Kinship stated next to a proposed name (the same words extract.js reads, less a bare "partner",
// which in a record is usually a business partner). A name tied this way is a relative, whatever tie the reader gave.
const KIN = /\b(?:father|mother|brother|sister|husband|wife|spouse|(?:life|domestic) partner|uncle|aunt|cousin|grandfather|grandmother|step-?father|step-?mother|(?:father|mother|brother|sister|son|daughter)-in-law|fianc[ée]e?|son|daughter|nephew|niece|grandson|granddaughter|step-?son|step-?daughter|scion|heir|heiress|married|parents?|siblings?|relatives?|family)\b/i;
// A business or legal tie must be stated in the sentence that names the person, not taken on the reader's word
const TIE_WORDS = {
  business: /\b(?:co-?found\w*|found(?:ed|er|ers|ing)|partners?|investors?|invest(?:ed|ing|ment)|board|directors?|employ\w*|hired|CEO|chief \w+|executives?|backers?|backed)\b/i,
  legal: /\b(?:co-?defendants?|defendants?|plaintiffs?|sued|sues|suing|charged|indicted|settle\w*|lawsuits?|complaint|court|trial|convicted)\b|\bvs?\.(?=\s)/i,
};
const ABBREVIATION = /\b(v|vs|Inc|Corp|Ltd|Co|Mr|Mrs|Ms|Dr|Jr|Sr|St|No|Prof|Gen|Sen|Rep|Gov)\.(?=\s)/g;
const sentencesOf = (text) => String(text || '').replace(/\s+/g, ' ').replace(ABBREVIATION, '$1\u0001')
  .split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((s) => s.replace(/\u0001/g, '.').trim()).filter(Boolean);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How a record ties a proposed person to the subject: 'kin' when kinship is stated beside the name, 'stated' when the tie's own words are in a sentence naming them, else null. */
function tieIn(text, name, tie) {
  const nameRe = new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, 'gi');
  let stated = false;
  for (const sentence of sentencesOf(text)) {
    for (const m of sentence.matchAll(nameRe)) {
      const near = sentence.slice(Math.max(0, m.index - 40), m.index + m[0].length + 30);
      if (KIN.test(near)) return 'kin';
      if ((TIE_WORDS[tie] || TIE_WORDS.business).test(sentence)) stated = true;
    }
  }
  return stated ? 'stated' : null;
}

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
  // Only trusted threads count as followed (the prompt lists only those): a name first seen in a
  // possible record and now proposed from a tied one is the rescue the second reading exists for
  const followed = new Set(Object.values(state.threads || {}).filter((t) => t.trusted).map((t) => `${t.kind}|${norm(t.value)}`));
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
    // a relative stays a relative whatever tie the reader gave: only a public role makes them followable
    const how = x.tie === 'family' ? 'kin' : tieIn(text, name, x.tie);
    if (!how) { dropped += 1; continue; }
    if (how === 'kin') {
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
