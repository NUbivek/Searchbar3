/**
 * The profile, read by a model: what a person's public profile page would
 * show (current role, every earlier role with years, education with degree
 * and field, board and advisory seats, companies founded, investments,
 * awards and lists, and the city they are based in), read out of the records
 * already tied to them.
 *
 * A model can invent things or read a colleague's career as the person's, so
 * nothing it says is kept on its word. Every item must cite a record and give
 * a short quote from it, and the code then checks that:
 *   - the record exists and is tied to the person (confirmed or likely, never
 *     a name-only match);
 *   - the quote appears in that record's text, word for word (spacing, case
 *     and punctuation aside);
 *   - the organisation, school, title or award appears in the quote;
 *   - the sentence the quote comes from is about the person: it opens on
 *     their name or on "She/He/They" right after a sentence that does, or it
 *     is a labelled field of a profile page whose title names them;
 *   - nothing about family, health, religion, age or home survives.
 * Years, degrees and titles are kept only when the quote states them.
 * What passes is merged with the pattern-read profile (profile.js).
 */
import { chatJson } from '../llm/providers';
import { restoreSubject } from './identity';
import { sentencesOf, opensOnSubject, placeOnly, maskSubject, bringsInSomeoneElse, HANDOFF, RELATION, NAME_RUN, isPersonRun } from './profile';
import { isSensitive, mentionsMinor } from './guardrails';

const str = { type: 'string' };
// a plain integer (0 when the record gives no year): every model's structured-output mode accepts it
const yr = { type: 'integer' };
const cited = (props) => ({
  type: 'array',
  items: {
    type: 'object',
    properties: { ...props, record: { type: 'integer' }, quote: str },
    required: [...Object.keys(props), 'record', 'quote'],
    additionalProperties: false,
  },
});

export const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    roles: cited({ org: str, title: str, from: yr, to: yr, current: { type: 'boolean' } }),
    education: cited({ school: str, degree: str, field: str, from: yr, to: yr }),
    boards: cited({ org: str, role: str }),
    founded: cited({ org: str, year: yr }),
    investments: cited({ org: str }),
    recognition: cited({ title: str, year: yr }),
    basedIn: cited({ text: str }),
  },
  required: ['roles', 'education', 'boards', 'founded', 'investments', 'recognition', 'basedIn'],
  additionalProperties: false,
};

const PROMPT = `You read public records about one person and fill in their professional profile, the way their public profile page would show it.
Use ONLY the numbered records. Never use outside knowledge. Only facts about THIS person: a colleague's, co-founder's or relative's job or school is not theirs.
For every item give "record" (the record number) and "quote": a short passage copied word for word from that record (one sentence or less) that states the fact and names the organisation, school or award.
Copy names exactly as the record writes them. Use "" for a title, degree or field the record does not state, and 0 for a year it does not state.
- roles: every job, current and earlier. "title" as written, "from"/"to" years, "current" true only when the record says it is their role now.
- education: school, degree (e.g. "MBA", "BS"), field of study, years.
- boards: board seats and advisory roles ("role" e.g. "board member", "advisor").
- founded: companies or organisations they founded or co-founded, with the year.
- investments: companies they invested in personally (angel or investor).
- recognition: awards and lists (e.g. "Forbes 30 Under 30"), with the year.
- basedIn: the city or metro area where they are based, at most one item. Never an address.
Leave out anything about family, children, health, religion, age or where they live beyond the city. Empty lists are fine and better than guesses.`;

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// Compare text as words: case, punctuation, curly quotes and dashes aside
export const flat = (s) => ` ${String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const contains = (hay, needle) => { const n = flat(needle); return n.trim().length > 0 && flat(hay).includes(n); };
const squash = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// A professional profile holds none of these (profile.js KIN, plus age and home)
const PRIVATE = /\b(?:husband|wife|spouse|boyfriend|girlfriend|fianc[ée]e?|married|father|mother|dad|mom|parents?(?!\s+(?:company|companies|firm|group|organi[sz]ation))|son|daughter|brother|sister|siblings?|uncle|aunt|cousin|grand(?:father|mother|son|daughter|child\w*)|children|kids?|childhood|grew up|born|raised (?:in|by)|\d{1,3}[- ]years?[- ]old|aged? \d|birthday|home ?town|home address|lives (?:at|on)|apartment)\b/i;
// What the quote must say for each kind of fact
const SAYS = {
  boards: /\b(?:board|advis\w*|directors?|trustees?|chair\w*|governors?|overseers?)\b/i,
  founded: /\b(?:co-?found\w*|found(?:ed|er|ers|ing)|started|launched|created|establish\w*|built)\b/i,
  investments: /\b(?:invest\w*|angel|backed|backer|portfolio|seed|stake|funded|LP)\b/i,
  basedIn: /\b(?:based|location|located|lives in|resides in|living in|works? (?:out of|from)|area)\b/i,
};

const LEAD_IN = /^["“'(]?(?:(?:Before|Prior to|After|Previously|Earlier|Formerly|In \d{4}|Today|Now)\b[^,]{0,70},\s*)?/;
/**
 * In the words leading up to an organisation, is the organisation tied to somebody else? "recruited Bob Smith,
 * a former Google engineer", "Jane Roe's co-founder Bob Smith studied at Stanford", "hired a former Google engineer".
 */
function leadsToSomeoneElse(subject, before) {
  const m = maskSubject(subject, before);
  if (HANDOFF.test(m) || RELATION.test(m)) return true;
  // a name followed by an appositive or a verb of its own is the subject of that clause
  const named = new RegExp(`(${NAME_RUN.source})(?:\\s*,\\s*(?:a|an|the|who|whose|our|her|his|their|its|former|then|now)\\b|\\s+(?:studied|studies|worked|works|was|is|joined|joins|led|leads|served|serves|earned|graduated|holds|held|spent|previously|formerly|had|has|attended|received|ran|runs|heads|headed)\\b)`, 'gu');
  for (const x of m.matchAll(named)) {
    // "Jane Roe and Bob Smith worked at Google": a joint subject, so the fact is hers too
    if (/•\s*(?:and|&)\s*$/.test(m.slice(0, x.index))) continue;
    if (isPersonRun(x[1])) return true;
  }
  return false;
}

// What ties the person to an organisation in a role or a school in their education
const ROLE_LINK = /\b(?:work(?:ed|s|ing)?|join(?:ed|s|ing)?|was|were|is|are|been|be|serv(?:ed|es|ing)|led|leads?|leading|ran|runs?|running|held|holds?|spent|intern(?:ed|s)?|began|begins|started|starts|became|becomes|promoted|manag(?:ed|es|ing)|head(?:ed|s|ing)?|consult(?:ed|s|ing)|taught|teach(?:es|ing)?|co-?founded|founded|built|launched|as|career|stint|tenure|role|employed|returned)\b/i;
const EDU_LINK = /\b(?:stud(?:ied|ies|ying)|graduat\w*|earn(?:ed|s|ing)?|receiv(?:ed|es)|holds?|held|attend(?:ed|s|ing)?|complet(?:ed|es)|degree|alum\w*|enrolled|went to|major(?:ed|ing)?|minor(?:ed)?|class of|educated|trained|research(?:ed)?|PhD|Ph\.D|MBA|M\.B\.A|BS|BA|MS|MA|B\.S|B\.A|M\.S|M\.A|bachelor\w*|master\w*|doctora\w*|J\.?D|from|at)\b/i;

const BIO = (f) => f.data?.kind === 'bio';
const TEXT_RICH = { career: 3, identity: 3, education: 3, press: 2, archive: 2, related: 1, corporate: 1 };
// A record the page reader made: its title is ours, the sentences are the page's
export const recordText = (f) => (BIO(f) ? String(f.quote || '') : `${String(f.title || '').replace(/[.!?]*$/, '')}. ${f.quote || ''}`);

/**
 * The records to read: tied to the person, with text in them, pages about the person first, under a size cap.
 */
export function profileRecords(findings, { max = 36, maxChars = 16000 } = {}) {
  const tied = (findings || [])
    .filter((f) => (f.match === 'confirmed' || f.match === 'likely') && `${f.title || ''} ${f.quote || ''}`.length >= 30)
    .map((f) => ({ f, weight: (BIO(f) ? 10 : 0) + (TEXT_RICH[f.category] ?? 0.5) + Math.min(2, (f.quote || '').length / 300) + (f.match === 'confirmed' ? 0.5 : 0) }))
    .sort((a, b) => b.weight - a.weight)
    .map((x) => x.f);
  const out = [];
  let size = 0;
  for (const f of tied) {
    const text = recordText(f).slice(0, 1200);
    if (out.length >= max || size + text.length > maxChars) break;
    size += text.length;
    out.push(f);
  }
  return out;
}

/**
 * The sentences of a record that are about the person: they open on the person's name (or first name on a
 * page about them), or on "She/He/They" right after one that does; on a profile page whose title names
 * them, its labelled fields ("Experience: ...", "Education: ...", "Location: ...") too.
 * Sentences about family, health, religion, children or home are never theirs to quote.
 */
export function sentencesAboutThem(subject, f) {
  const bio = BIO(f);
  const titleNamesThem = subject.hasName(f.title || '');
  const out = [];
  let carry = 0;
  for (const s of sentencesOf(recordText(f))) {
    // a sentence on "She/He/They" (after an optional "Before that," lead-in) is theirs only right after one naming them
    const pronoun = /^["“'(]?(?:She|He|They|Her|His|Their)\b/i.test(s.replace(LEAD_IN, ''));
    const opens = !pronoun && opensOnSubject(subject, s, { firstName: bio });
    const follows = pronoun && carry > 0;
    const field = titleNamesThem && /^(?:Experience|Education|Location|Current|Previous|Past|Headline)\s*:/i.test(s);
    // "Jane Roe and Bob Smith founded Acme. He previously ...", "She hired Bob Smith. He previously ...":
    // once someone else is in the text, the next "He/She" may be them, so nothing after it carries over
    const another = (opens || follows) && bringsInSomeoneElse(subject, s);
    carry = another ? 0 : opens ? 2 : follows ? carry - 1 : 0;
    if (!(opens || follows || field)) continue;
    if (PRIVATE.test(s) || isSensitive(s) || mentionsMinor(s)) continue;
    out.push(s);
  }
  return out;
}

/** The sentence about them that a quote comes from, when every piece of the quote lies in one sentence about them. */
function sentenceAboutThem(quote, about) {
  const pieces = sentencesOf(quote).length ? sentencesOf(quote) : [tidy(quote)];
  if (!pieces.every((p) => about.some((s) => flat(s).includes(flat(p))))) return null;
  return about.find((s) => flat(s).includes(flat(pieces[0]))) || null;
}

/** Where `main` sits in `text`, case aside (-1 when it is not there as written). */
const indexOfMain = (text, main) => String(text).toLowerCase().indexOf(String(main).toLowerCase());
const YEAR_OK = (y) => Number.isInteger(y) && y >= 1950 && y <= new Date().getUTCFullYear() + 1;
const hasYear = (text, y) => new RegExp(`(?<!\\d)${y}(?!\\d)`).test(text);
// the clause after an organisation ends at a semicolon, a comma not followed by a year, or a new clause
const CLAUSE_END = /;|,\s+(?!\(?\d{4}|present\b|now\b|today\b)|\s+(?:and|but|while|after|before|when|who|which|where|whose|then|later)\s|\.(?:\s|$)/i;
const LEAD_YEARS = /^["“'(]?(?:In|Since|From|By|As of|Between|Until|Through)\s+(\d{4})(?:\s*(?:[-–—]|to|and|until|through)\s*(\d{4}))?\s*,/i;

/**
 * A year the model gives, kept only when the quote prints it beside the organisation: right after it in the same
 * clause ("Stripe (2015–2018)", "Acme in 2020", "Google from 2012 to 2017"), just before it ("the 2019 Forbes 30
 * Under 30"), or in a lead-in that opens the quote ("In 2018, Jane Roe founded Acme"). A year elsewhere in the
 * quote is another fact ("Jane Roe, who graduated in 2010, joined Stripe").
 */
export function yearBeside(quote, main, y) {
  if (!YEAR_OK(y)) return null;
  const q = String(quote || '');
  const i = indexOfMain(q, main);
  if (i < 0) return null;
  const rest = q.slice(i + String(main).length, i + String(main).length + 60);
  const cut = rest.search(CLAUSE_END);
  if (hasYear(cut < 0 ? rest : rest.slice(0, cut), y)) return y;
  if (new RegExp(`(?<!\\d)${y}(?:['’]s)?\\s*$`).test(q.slice(Math.max(0, i - 12), i))) return y;
  const lead = q.match(LEAD_YEARS);
  if (lead && (Number(lead[1]) === y || Number(lead[2]) === y) && lead[0].length <= i) return y;
  return null;
}

// A title, degree or field is kept only as the quote states it: as words, or as the quote's own tokens with the
// dots taken out ("M.B.A." for "MBA"). Never a run of letters inside a longer word ("CTO" in "director").
export const stated = (quote, value, maxLen = 80) => {
  const v = tidy(value);
  if (!v || v.length > maxLen) return null;
  if (contains(quote, v)) return v;
  const want = squash(v);
  if (want.length < 2 || v.length > 12) return null;
  const tokens = String(quote || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    for (let n = 1; n <= 3 && i + n <= tokens.length; n += 1) if (squash(tokens.slice(i, i + n).join('')) === want) return v;
  }
  return null;
};

// A role is the person's role now only when the quote says so and says nothing of it being over
const FORMER = /\b(?:former(?:ly)?|previous(?:ly)?|was|were|until|left|leaving|prior|past|earlier|had been|once|retired|departed|stepped down|ex)\b|\bex-/i;
const PRESENT = /\b(?:present|current(?:ly)?|now|today|serves|leads|runs|heads|works|manages|oversees|holds)\b/i;

/**
 * Check a model's profile against the records. Pure: no network.
 * @param {object} subject from identity
 * @param {object[]} records the records the model was shown, in order (record n = records[n - 1])
 * @param {object} data the model's answer (PROFILE_SCHEMA)
 * @returns {{ roles, education, boards, founded, investments, recognition, basedIn, kept: number, dropped: number }}
 */
export function verifyProfile(subject, records, data) {
  const out = { roles: [], education: [], boards: [], founded: [], investments: [], recognition: [], basedIn: null, kept: 0, dropped: 0 };
  const aboutCache = new Map();
  const nameWords = new Set(flat(subject.name).trim().split(' '));
  const check = (x, kind, mainField) => {
    const n = x?.record;
    const f = Number.isInteger(n) && n >= 1 && n <= records.length ? records[n - 1] : null;
    if (!f || !(f.match === 'confirmed' || f.match === 'likely')) return null;
    const quote = tidy(x.quote);
    const main = tidy(x[mainField]);
    if (quote.length < 8 || quote.length > 400 || main.length < 2 || main.length > 90) return null;
    // the quote is the record's own words, and names the organisation (or school, award, place)
    if (!contains(recordText(f), quote) || !contains(quote, main)) return null;
    // the organisation is not the person themself
    if (flat(main).trim().split(' ').every((w) => nameWords.has(w))) return null;
    if (SAYS[kind] && !SAYS[kind].test(quote)) return null;
    if (PRIVATE.test(quote) || isSensitive(quote) || mentionsMinor(quote)) return null;
    if (!aboutCache.has(f.id)) aboutCache.set(f.id, sentencesAboutThem(subject, f));
    const sentence = sentenceAboutThem(quote, aboutCache.get(f.id));
    if (!sentence) return null;
    // the organisation or school is tied to the person in that sentence, not to someone else named on the way to it
    if (kind === 'roles' || kind === 'education') {
      const at = indexOfMain(sentence, main);
      if (at < 0) return null;
      const before = sentence.slice(0, at);
      if (leadsToSomeoneElse(subject, before)) return null;
      const field = /^(?:Experience|Education|Location|Current|Previous|Past|Headline)\s*:/i.test(sentence);
      const link = kind === 'roles' ? ROLE_LINK : EDU_LINK;
      // "Jane Roe, CEO of Acme" and "Jane Roe (Stripe, 2015-2018)" tie the role by apposition
      const apposed = /^\s*[•]\s*[,(–—-]/.test(maskSubject(subject, before.replace(LEAD_IN, '')));
      if (!field && !apposed && !link.test(before) && !link.test(sentence.slice(at + main.length, at + main.length + 30))) return null;
    }
    return { f, quote, main };
  };
  const take = (kind, list, build, cap = 15) => {
    for (const x of Array.isArray(list) ? list.slice(0, 30) : []) {
      const ok = check(x, kind, kind === 'education' ? 'school' : kind === 'recognition' ? 'title' : kind === 'basedIn' ? 'text' : 'org');
      const item = ok && build(x, ok);
      if (!item || out[kind].length >= cap) { out.dropped += 1; continue; }
      out[kind].push({ ...item, ids: [ok.f.id], quote: ok.quote });
      out.kept += 1;
    }
  };
  take('roles', data?.roles, (x, { quote, main }) => {
    const from = yearBeside(quote, main, x.from);
    const to = yearBeside(quote, main, x.to);
    // "is" counts only before the organisation ("Jane Roe is the CEO of Acme"), and never beside "former" or "was"
    const at = indexOfMain(quote, main);
    const current = Boolean(x.current) && !to && !FORMER.test(quote) && (PRESENT.test(quote) || (at > 0 && /\b(?:is|are)\b/i.test(quote.slice(0, at))));
    return { org: main, title: stated(quote, x.title), from, to: from && to && to < from ? null : to, current };
  }, 25);
  take('education', data?.education, (x, { quote, main }) => ({ school: main, degree: stated(quote, x.degree, 40), field: stated(quote, x.field, 60), from: yearBeside(quote, main, x.from), to: yearBeside(quote, main, x.to) }));
  take('boards', data?.boards, (x, { quote, main }) => ({ org: main, role: stated(quote, x.role, 40) }));
  take('founded', data?.founded, (x, { quote, main }) => ({ org: main, year: yearBeside(quote, main, x.year) }));
  take('investments', data?.investments, (x, { main }) => ({ org: main }), 20);
  take('recognition', data?.recognition, (x, { quote, main }) => ({ title: main, year: yearBeside(quote, main, x.year) }));
  const places = [];
  const saved = out.basedIn;
  out.basedIn = places;
  take('basedIn', data?.basedIn, (x, { main }) => { const text = placeOnly(main); return text ? { text } : null; }, 1);
  out.basedIn = places[0] || saved;
  return out;
}

// ---- merging with the pattern-read profile, in the report's form (citations are record numbers) ----

const SUFFIX = /\b(?:the|inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|lp|llp|group|holdings)\b/g;
export const orgKey = (s) => flat(s).replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
const union = (a, b) => [...new Set([...(a || []), ...(b || [])])].sort((x, y) => x - y).slice(0, 6);

function mergeList(first, second, keyOf, fill = []) {
  const out = [];
  const at = new Map();
  for (const item of [...first, ...second]) {
    const key = keyOf(item);
    if (!key) continue;
    if (!at.has(key)) { at.set(key, out.length); out.push({ ...item, cites: [...(item.cites || [])] }); continue; }
    const kept = out[at.get(key)];
    kept.cites = union(kept.cites, item.cites);
    for (const field of fill) if ((kept[field] == null || kept[field] === '') && item[field] != null && item[field] !== '') kept[field] = item[field];
  }
  return out;
}

const startOf = (r) => (r.current ? 10000 : 0) + (r.from || r.to || 0);

/**
 * Merge verified model items into a report profile (report.js reportProfile shape). Model items come first; the
 * pattern-read ones fill gaps and add their citations. Roles are sorted current first, then by start year, latest first.
 * @param {object|null} base report.profile (may be null)
 * @param {object} verified from verifyProfile, items carrying `cites` (record numbers)
 */
export function mergeProfile(base, verified) {
  const b = base || {};
  const v = verified || {};
  const roles = mergeList(v.roles || [], b.roles || [], (r) => (r.org ? `${orgKey(r.org)}|${squash(r.title || '')}` : null), ['title', 'from', 'to']);
  // a pattern-read role with no title merges into the model's role at the same organisation
  const byOrg = new Map();
  const merged = [];
  for (const r of roles) {
    const k = orgKey(r.org);
    const prior = byOrg.get(k);
    if (prior && (!r.title || !prior.title)) {
      prior.cites = union(prior.cites, r.cites);
      for (const f of ['title', 'from', 'to']) if (prior[f] == null && r[f] != null) prior[f] = r[f];
      prior.current = prior.current || r.current;
      continue;
    }
    if (!prior) byOrg.set(k, r);
    merged.push(r);
  }
  merged.sort((x, y) => startOf(y) - startOf(x));
  const education = mergeList(v.education || [], b.education || [], (e) => (e.school ? orgKey(e.school) : null), ['degree', 'field', 'from', 'to']);
  const boards = mergeList(v.boards || [], b.boards || [], (e) => (e.org ? orgKey(e.org) : null), ['role']);
  const founded = mergeList(v.founded || [], b.founded || [], (e) => (e.org ? orgKey(e.org) : null), ['year']);
  const investments = mergeList(v.investments || [], b.investments || [], (e) => (e.org ? orgKey(e.org) : null));
  const recognition = mergeList(v.recognition || [], b.recognition || [], (e) => (e.title ? flat(e.title).trim() : null), ['year']);
  const basedIn = v.basedIn || b.basedIn || null;
  const now = merged.find((r) => r.current && r.title);
  const headline = b.headline || (now ? `${now.title}, ${now.org}` : null);
  return {
    ...b,
    headline,
    headlineCites: b.headline ? b.headlineCites || [] : now ? now.cites : [],
    company: b.company || null,
    roles: merged.slice(0, 25),
    education: education.slice(0, 12),
    earlier: merged.filter((r) => !r.current).map((r) => ({ org: r.org, role: r.title || null, cites: r.cites })).slice(0, 15),
    boards: boards.slice(0, 12),
    founded: founded.slice(0, 12),
    investments: investments.slice(0, 20),
    recognition: recognition.slice(0, 12),
    basedIn,
    about: b.about || [],
    links: b.links || [],
  };
}

const hasAny = (p) => Boolean(p && (p.headline || p.roles?.length || p.education?.length || p.boards?.length || p.founded?.length || p.investments?.length || p.recognition?.length || p.basedIn || p.about?.length || p.links?.length));

/**
 * Ask a model to read the profile, keep what the records bear out, and merge it into the report's profile.
 * Never throws; on any failure (no model, deadline, nothing verified) it returns the report's profile unchanged.
 * @param {object} report from buildReport (its `sources` give each record's number)
 * @param {object} state the check's state (its findings carry the quotes)
 * @param {{ deadline?: number, complete?: Function }} options
 * @returns {Promise<object|null>} the profile to put in report.profile
 */
export async function readProfile(report, state, { deadline = null, complete = chatJson } = {}) {
  const base = report?.profile || null;
  try {
    const numberOf = new Map((report?.sources || []).map((s) => [s.id, s.n]));
    const records = profileRecords((state?.findings || []).filter((f) => numberOf.has(f.id)));
    if (records.length < 1) return base;
    if (deadline && deadline - Date.now() < 4000) return base;
    const subject = restoreSubject({ name: state.name, company: state.company, anchors: state.anchors });
    const block = records.map((f, i) => `[${i + 1}] (${f.sourceLabel || f.source}${BIO(f) ? '; a page about the person' : ''}${f.date ? `; ${f.date}` : ''})\n${recordText(f).slice(0, 1200)}`).join('\n\n');
    const user = `Person: ${state.name}${state.company ? `\nCompany: ${state.company}` : ''}\n\nRecords:\n${block}`;
    const out = await complete([{ role: 'system', content: PROMPT }, { role: 'user', content: user }], {
      schema: PROFILE_SCHEMA, name: 'profile', deadline, personal: true, maxTokens: 2500,
      hedgeMs: 5000, // a slow first service is joined by the others (llm/providers.js)
      check: (d) => Boolean(d) && typeof d === 'object' && !Array.isArray(d),
    });
    if (!out?.data) return base;
    const verified = verifyProfile(subject, records, out.data);
    if (!verified.kept) return base;
    const toCites = (list) => list.map(({ ids, quote, ...rest }) => ({ ...rest, cites: ids.map((id) => numberOf.get(id)).filter(Boolean) })).filter((x) => x.cites.length);
    const v = {
      roles: toCites(verified.roles), education: toCites(verified.education), boards: toCites(verified.boards),
      founded: toCites(verified.founded), investments: toCites(verified.investments), recognition: toCites(verified.recognition),
      basedIn: verified.basedIn ? toCites([verified.basedIn])[0] || null : null,
    };
    const merged = mergeProfile(base, v);
    return hasAny(merged) ? { ...merged, readBy: 'model' } : base;
  } catch {
    return base;
  }
}
