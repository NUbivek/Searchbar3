/**
 * Answer generation: one LLM call over the ranked sources (free provider
 * chain), validated; otherwise the extractive (quoted) digest.
 * Output keeps the documented sections: SUMMARY, KEY POINTS, DETAILED
 * ANALYSIS, DIFFERENT PERSPECTIVES, FOLLOW-UP QUESTIONS.
 */
import { chatComplete, PROVIDERS, providerEnabled } from '../llm/providers';
import { synthesizeFromResults } from '../../utils/fallbackSynthesizer';
import { INTENTS, entityRegex, mentionMatches } from './queryPlan';

// One numbering everywhere: the answer cites the ranked list the UI shows
// (15 ranked results plus the user's own documents), never a shorter copy.
const MAX_SOURCES_FOR_LLM = 25;
const SECTIONS = ['## SUMMARY', '## KEY POINTS', '## DETAILED ANALYSIS', '## DIFFERENT PERSPECTIVES', '## FOLLOW-UP QUESTIONS'];
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const dateOf = (r) => { const t = Date.parse(r.publishedAt || r.date || r.timestamp || ''); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };

const SYSTEM_PROMPT = `You are an investment due-diligence research analyst. Answer the user's question using ONLY the numbered sources provided.

Rules:
- Answer the question directly in the first sentence of SUMMARY.
- Cite every factual sentence or bullet with [Source n] using the numbers given. Never cite a number that is not listed.
- Never add facts that are not in the sources. If the sources do not answer part of the question, say so plainly.
- When sources disagree (amounts, dates, valuations, claims), say so in DIFFERENT PERSPECTIVES and cite each side.
- When the question asks for the latest or recent information, prefer the newest dated sources and give dates.
- Ignore sources that are not about the subject.

Format (Markdown, exactly these sections, in this order):
## SUMMARY
(1-2 short paragraphs)
## KEY POINTS
(4-8 bullets starting with "• ")
## DETAILED ANALYSIS
(### subsections with short paragraphs)
## DIFFERENT PERSPECTIVES
(bullets: what company announcements, investors, press and community sources each say, or where they disagree)
## FOLLOW-UP QUESTIONS
(3-5 bullets starting with "• ": specific diligence questions the sources leave open)
Then one final line: CONFIDENCE: High|Medium|Low - <reason based on how many independent, recent sources support the main claims>`;

function sourcesBlock(results) {
  return results.map((r, i) => {
    const text = String(r.content || r.snippet || '').replace(/\s+/g, ' ').slice(0, 500);
    return `[Source ${i + 1}] ${r.title}\nPublisher: ${r.sourceName || hostOf(r.url)}${dateOf(r) ? ` | Date: ${dateOf(r)}` : ''} | Type: ${r.sourceTierLabel || r.type || 'web'}\nURL: ${r.url}\nText: ${text || '(headline only)'}`;
  }).join('\n\n');
}

/**
 * Models cite in different styles: gpt-oss uses 【3】 or 【3†source】, others
 * [3], [1, 2], [S3], (Source 3), [Source: 3]. Normalize all to [Source n].
 */
export function normalizeCitations(text) {
  const list = (nums) => nums.split(/\s*[,;]\s*|\s*(?:and|&)\s*/i).map((x) => x.trim()).filter(Boolean)
    .flatMap((x) => {
      const range = x.match(/^(\d+)\s*[–-]\s*(\d+)$/);
      if (range) { const out = []; for (let n = Number(range[1]); n <= Math.min(Number(range[2]), Number(range[1]) + 20); n += 1) out.push(n); return out; }
      const n = x.match(/^S?(\d+)$/i);
      return n ? [Number(n[1])] : [];
    });
  const fmt = (nums) => { const ns = list(nums); return ns.length ? ns.map((n) => `[Source ${n}]`).join(' ') : null; };
  return String(text || '')
    .replace(/【\s*(?:source\s*)?(\d+)(?:†[^】]*)?】/gi, (m, n) => `[Source ${n}]`)
    .replace(/\[(?:sources?|src|ref|s)?\s*:?\s*((?:S?\d+)(?:\s*(?:[,;–-]|and|&)\s*S?\d+)*)\](?!\()/gi, (m, nums) => fmt(nums) || m)
    .replace(/\((?:sources?|src)\s*:?\s*(\d+(?:\s*(?:[,;–-]|and|&)\s*\d+)*)\)/gi, (m, nums) => fmt(nums) || m);
}

/** Remove citations to sources that do not exist; true when output is usable. */
export function validateAnswer(text, sourceCount, sections = SECTIONS) {
  // Reasoning models may include their thinking; never show it
  let content = normalizeCitations(String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '')).trim();
  // Some models wrap output in code fences or add a preface before SUMMARY
  content = content.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '');
  // "**## TIMELINE**" or "## SUMMARY**" -> "## TIMELINE" (bold markers around headings)
  content = content.replace(/^[ \t]*(?:\*\*|__)?[ \t]*(#{2,4})[ \t]*(?:\*\*|__)?[ \t]*(.+?)[ \t]*(?:\*\*|__)?[ \t]*$/gm, (m, h, title) => `${h} ${title.replace(/^(\*\*|__)|(\*\*|__)$/g, '').trim()}`);
  const start = content.indexOf(sections[0]);
  if (start < 0) return { ok: false, reason: `missing ${sections[0].replace(/^#+\s*/, '')} section` };
  content = content.slice(start);
  const missing = sections.filter((h) => !content.includes(h));
  if (missing.length > 1) return { ok: false, reason: `missing sections: ${missing.join(', ')}` };
  let removed = 0;
  content = content.replace(/\[Sources? (\d+)\]/g, (m, nums) => {
    const valid = nums.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount);
    if (valid.length === 0) { removed += 1; return ''; }
    return valid.map((n) => `[Source ${n}]`).join(' ');
  });
  const citations = (content.match(/\[Source \d+\]/g) || []).length;
  if (citations === 0) return { ok: false, reason: 'no valid citations' };
  // Models write it as "CONFIDENCE: High - ...", "**CONFIDENCE:** High – ..." etc.
  const conf = content.match(/^[ \t>*_#-]*CONFIDENCE[*_\s]*:[*_\s]*(High|Medium|Low)(?![a-z])[*_]*\s*[-–—:]?\s*(.*)$/im);
  if (conf) content = content.replace(conf[0], '').trim();
  // "- • point" -> "• point" (the format the prompt and the quoted digest use)
  content = content.replace(/^([ \t]*)[-*][ \t]*•[ \t]*/gm, '$1• ');
  const confidence = conf ? { level: conf[1], reason: conf[2].replace(/[*_]+/g, '').trim() } : null;
  return { ok: true, content, citations, removedCitations: removed, confidence };
}

export function llmConfigured() {
  return PROVIDERS.some(providerEnabled);
}

// ---------------------------------------------------------------------------
// Line-by-line support check (used by the founder quick brief; generateAnswer does not call it)
// ---------------------------------------------------------------------------

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, hundred: 100 };
// Capitalised words that say nothing checkable on their own: sentence starters, pronouns, months, role titles
// (models paraphrase "chief executive" as "CEO"), section words.
const NOT_A_NAME = new Set(`the a an he she they his her their it its this that these those in on at for with from by of to and or but not no yes as after before since during while when where who which what why how there here
also however although though both each either neither most more some many several one two three four five six seven eight nine ten
january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday
jan feb mar apr jun jul aug sep sept oct nov dec q1 q2 q3 q4 h1 h2 fy early mid late spring summer autumn fall winter
ceo cto coo cfo cpo cro cmo cio vp svp evp chief executive officer president chair chairman chairwoman founder co-founder cofounder director partner head
source sources summary note confirm verify ask check review consider question questions red flags open press career education litigation regulatory past companies roles timeline confidence
mr mrs ms dr prof jr sr inc corp ltd llc co plc sa ag gmbh`.split(/\s+/));
// A sentence that only says something was not found, or repeats the coverage caveat, needs no citation.
// "No litigation or regulatory actions involving X are mentioned in the sources" is one too (seen from a live model).
const NEGATIVE = /\b(?:not found|no (?:[\p{L}\p{N}'’&.-]+[ ,]+){0,12}?(?:found|mentions?|mentioned|results?|records?|sources?|identified|reported|listed|known|disclosed|appears?|appeared|exists?)|none (?:found|identified|reported|mentioned|known)|not evidence of|absence of|could not be (?:found|confirmed|verified)|nothing (?:was )?found|there (?:is|are|was|were) no)\b/iu;
// ... unless it goes on to state something after all ("No conviction was found, but he was sued by X").
const CONTRAST = /\b(?:but|however|although|though|except|yet|while)\b/i;
const onlyNegative = (claim) => NEGATIVE.test(claim) && !CONTRAST.test(claim);
// A reference question or a request to the reader states nothing: "Confirm whether any litigation exists",
// "Ask about the 2021 lawsuit?", "**Verification of funding:** Confirm the seed round".
const ASKING = /^(?:[^:]{0,60}:\s*)?(?:ask|confirm|verify|check|request|clarify|obtain|review|seek|probe|explore|determine|establish|find out|whether|what|why|how|who|when|which|did|does|do|is|are|was|were|has|have|had|can|could|should|would)\b/i;
const isAsking = (claim) => /\?\s*$/.test(claim) || ASKING.test(claim);
// Markdown emphasis a model adds around a label ("**Sept 2025:** Closed a round") says nothing about names.
const plain = (text) => String(text || '').replace(/\*\*|__|`/g, '').replace(/(^|\s)\*(?=\S)|(?<=\S)\*(?=\s|$)/g, '$1');
const YEAR = /\b(?:19|20)\d{2}\b/g;
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text a claim may be checked against: lower case, accents folded, "1,300" as "1300", "two" also as "2". */
function prepareSource(text) {
  const t = fold(text).replace(/(\d),(?=\d{3}\b)/g, '$1');
  const words = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|hundred)\b/g, (m) => `${m} ${NUMBER_WORDS[m]}`);
  return { text: words, dotless: words.replace(/\./g, '') };
}

/** Numbers in a claim that its source must give: years, amounts, counts ("Source n" markers are removed first). */
function claimNumbers(sentence) {
  const s = sentence.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const years = s.match(YEAR) || [];
  const numbers = (s.replace(YEAR, ' ').match(/\d+(?:\.\d+)?/g) || []).filter((n) => n !== '0');
  return { years, numbers };
}

/** Runs of capitalised words: organisation, school and place names a claim gives. */
function claimNames(text, ignore) {
  const sentence = plain(text);
  const runs = [];
  const re = /(?<![\p{L}\p{N}])[A-Z][\p{L}\p{N}&'’.-]*(?:\s+(?:(?:of|de|du|la|and|&|for)\s+)?[A-Z][\p{L}\p{N}&'’.-]*)*/gu;
  // where a clause starts: the sentence itself, and whatever follows a label or a dash ("2026: Advocated for ...",
  // "Funding: Closed a round"). A single capitalised word there is capitalised anyway, like the first of a sentence.
  const startsClause = (i) => i === 0 || /(?:[:;—–]|\s-)\s*$/.test(sentence.slice(0, i)) || /^\s*$/.test(sentence.slice(0, i));
  for (const m of sentence.matchAll(re)) {
    const tokens = m[0].split(/\s+/)
      .map((w) => w.replace(/['’]s$/, '').replace(/[.,;:'’-]+$/, ''))
      .filter((w) => /^[A-Z]/.test(w) && !NOT_A_NAME.has(w.toLowerCase()) && !ignore.has(fold(w)) && w.length >= 2);
    if (!tokens.length) continue;
    // the first word of a sentence or clause is capitalised anyway: on its own it is not a name
    if (startsClause(m.index) && m[0].split(/\s+/).length === 1) continue;
    runs.push(tokens);
  }
  return runs;
}

/** Does `src` (from prepareSource) give every year and number, and at least one word of each name, of the claim? */
function supports(src, sentence, ignore) {
  const { years, numbers } = claimNumbers(sentence);
  for (const y of years) if (!new RegExp(`(?<!\\d)${y}(?!\\d)`).test(src.text)) return `the year ${y} is not in the source`;
  for (const n of numbers) if (!new RegExp(`(?<![\\d.])${escRe(n)}(?![\\d]|\\.\\d)`).test(src.text)) return `the number ${n} is not in the source`;
  for (const run of claimNames(sentence, ignore)) {
    const found = run.some((w) => {
      const word = fold(w).replace(/\./g, '');
      return word.length >= 2 && new RegExp(`(?<![\\p{L}\\p{N}])${escRe(word)}(?![\\p{L}\\p{N}])`, 'u').test(src.dotless);
    });
    if (!found) return `"${run.join(' ')}" is not in the source`;
  }
  return null;
}

/**
 * Legal and regulatory matters, each with the words a source may use for it. A sentence that states one of these
 * ("convicted", "sued", "fined", "fraud") is kept only when a source it cites, tied to the person by more than the
 * name, uses a word of the same matter: a paraphrase ("charged" for "indicted") passes, an invented conviction does
 * not. The claim side is narrow on purpose ("charged with", not "charges a fee"), so ordinary lines are untouched.
 */
const LEGAL_MATTERS = [
  { claim: /\b(?:convict(?:ed|ion|ions)?|found guilty|pleaded guilty|pleads guilty|guilty plea|sentenced|imprisoned|jailed)\b/, source: /\b(?:convict\w*|guilty|sentenc\w*|prison|imprison\w*|jail\w*|plea)\b/ },
  { claim: /\b(?:charged (?:with|by|over|in)|(?:criminal|fraud|federal|civil) charges|charges (?:of|against|over|filed)|indict(?:ed|ment|ments)?|prosecuted|prosecution)\b/, source: /\b(?:charg\w*|indict\w*|accus\w*|prosecut\w*)\b/ },
  { claim: /\b(?:su(?:ed|es|ing)|lawsuits?|litigation|class[- ]action|plaintiffs?|defendants?)\b/, source: /\b(?:su(?:e|ed|es|ing|it|its)|lawsuits?|litigat\w*|plaintiffs?|defendants?|class[- ]action|complaint|court)\b/ },
  { claim: /\b(?:fraud\w*|ponzi|embezzl\w*|misappropriat\w*)\b/, source: /\b(?:fraud\w*|ponzi|embezzl\w*|misappropriat\w*|scam\w*|deceiv\w*|decept\w*)\b/ },
  { claim: /\b(?:fined|fines? (?:of|by|from)|penalt(?:y|ies)|sanctioned)\b/, source: /\b(?:fine[sd]?|penalt\w*|sanction\w*)\b/ },
  { claim: /\b(?:settled (?:a |the )?(?:lawsuit|suit|case|charges|claims|allegations|with)|settlement)\b/, source: /\b(?:settl\w*)\b/ },
  { claim: /\b(?:investigat(?:ed|ion|ions|ing)|probe[ds]?|subpoena(?:ed|s)?|inquiry)\b/, source: /\b(?:investigat\w*|probe[ds]?|subpoena\w*|inquir\w*)\b/ },
  { claim: /\b(?:arrest(?:ed)?|detained)\b/, source: /\b(?:arrest\w*|detain\w*|custody)\b/ },
  { claim: /\b(?:bankrupt(?:cy|cies)?|insolven(?:t|cy))\b/, source: /\b(?:bankrupt\w*|insolven\w*|chapter (?:7|11)|liquidat\w*)\b/ },
  { claim: /\b(?:misconduct|harass(?:ed|ment)|wrongdoing)\b/, source: /\b(?:misconduct|harass\w*|wrongdoing)\b/ },
  { claim: /\b(?:alleg(?:ed|ations?|es|edly)|accused)\b/, source: /\b(?:alleg\w*|accus\w*|charg\w*|claim\w*)\b/ },
  { claim: /\b(?:injunction|restraining order)\b/, source: /\b(?:injunct\w*|restrain\w*)\b/ },
  { claim: /\b(?:enforcement action|regulatory action|cease[- ]and[- ]desist|consent (?:order|decree))\b/, source: /\b(?:enforcement|regulat\w*|cease|consent|order)\b/ },
];
// Regulators named by their initials: case-sensitive, so "sec" (a second) is not one.
const LEGAL_AGENCY = /\b(?:SEC|FTC|DOJ|CFTC|FCA|FBI|FINRA|OFAC|CMA|CNIL|ICO|AMF)\b/g;
// A yes/no reference question states nothing ("Ask whether she has ever been sued?"); "Why was she convicted?" does.
const YES_NO_QUESTION = /^(?:(?:ask|confirm|verify|check|request|review)\s+(?:\w+\s+){0,3}?(?:whether|if)\b|(?:is|are|has|have|had|was|were|did|does|do)\b|whether\b)[^?]*\?\s*$/i;

/**
 * Why a sentence's legal matter is not stated by its cited, tied sources, or null (no matter, or it is stated). A
 * string is an unsupported legal matter; `{ minor }` is a regulator's initials alone, missing like any other name.
 */
function legalUnsupported(claim, citedTied) {
  if (YES_NO_QUESTION.test(claim)) return null;
  const c = fold(claim);
  const matters = LEGAL_MATTERS.filter((m) => m.claim.test(c));
  const agencies = [...new Set(claim.match(LEGAL_AGENCY) || [])];
  if (!matters.length && !agencies.length) return null;
  if (!citedTied) return matters.length ? 'states a legal matter that no cited source tied to the person gives' : { minor: 'names a regulator, with no cited source tied to the person' };
  const src = fold(citedTied);
  for (const m of matters) if (!m.source.test(src)) return 'states a legal matter that its cited source does not give';
  // a regulator named without a legal matter ("filed with the SEC") is checked like any name: removed when its
  // source lacks it, but not counted as an invented legal matter
  for (const a of agencies) if (!new RegExp(`\\b${a}\\b`).test(citedTied)) return matters.length ? `names ${a}, which its cited source does not` : { minor: `"${a}" is not in the source` };
  return null;
}

/** Split a line into sentences, each keeping its own citations ("x. [Source 1] y" -> "x [Source 1].", "y"). */
function lineSentences(body) {
  const moved = body.replace(/([.!?])((?:\s*\[Source \d+\])+)/g, '$2$1');
  const out = [];
  let start = 0;
  const re = /(?<=[.!?])\s+(?=["“(]?[A-Z0-9•])/g;
  let m;
  while ((m = re.exec(moved))) {
    const piece = moved.slice(start, m.index);
    // "Inc." "U.S." "Dr." or a lone initial do not end a sentence
    if (/(?:^|[\s(])(?:[A-Z]|Inc|Corp|Co|Ltd|Jr|Sr|Mr|Mrs|Ms|Dr|St|No|vs|U\.S|e\.g|i\.e|Ph\.D|Prof)\.$/.test(piece)) continue;
    out.push(piece);
    start = m.index + m[0].length;
  }
  out.push(moved.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Check an answer line by line against the text of the sources it cites. Every sentence or bullet must carry
 * a [Source n] whose text gives its years, numbers and (at least one word of each of) its capitalised names;
 * a sentence that does not is removed. "Not found" sentences need no citation, and in `advisorySections` an
 * uncited line (a reference question, "confirm the role history") is allowed when the sources as a whole support
 * what it names. In `failSections` (litigation) `failAfter` uncited or unsupported lines fail the whole answer (one by
 * default), and when more than `maxDropShare` of the checked sentences go, or fewer than `minKept` stay, the answer
 * fails too, so the caller can ask another model. `inherit`: a sentence without a marker rests on the nearest
 * cited sentence of its own line. `elsewhere`: a fact the cited source lacks but another source tied to the subject
 * gives is kept (a loose citation); only what no such source gives is removed. `legalTerms`: a sentence in any
 * section that states a legal or regulatory matter (charged, convicted, sued, fined, fraud, a regulator) is kept only
 * when a source it cites, tied to the subject by more than the name, uses words of that matter; `elsewhere` never
 * rescues it. Each such removal counts toward `failAfter` wherever it sits, since an invented legal matter is the
 * worst thing a brief can say.
 *
 * @param {string} content an answer that passed validateAnswer (sections and [Source n] markers normalised)
 * @param {Map<number, {text: string, weak?: boolean}>|Object} sources the text each source number stands for;
 *   `weak`: tied to the subject by name only
 * @param {{ failSections?: string[], advisorySections?: string[], weakDropSections?: string[], ignoreWords?: string[],
 *   maxDropShare?: number, emptySection?: string|null, inherit?: boolean, elsewhere?: boolean, failAfter?: number, minKept?: number,
 *   legalTerms?: boolean }} [opts]
 * @returns {{ ok: boolean, content: string, checked: number, dropped: number, reasons: string[], reason?: string }}
 */
export function checkClaims(content, sources, opts = {}) {
  const {
    failSections = [], advisorySections = [], weakDropSections = [], ignoreWords = [], maxDropShare = 0.2, emptySection = null,
    inherit = false, elsewhere = false, failAfter = 1, minKept = 0, legalTerms = false,
  } = opts;
  const map = sources instanceof Map ? sources : new Map(Object.entries(sources || {}).map(([k, v]) => [Number(k), v]));
  const prepared = new Map([...map].map(([n, v]) => [n, prepareSource(v?.text || '')]));
  const everything = prepareSource([...map.values()].map((v) => v?.text || '').join(' \n '));
  // every source that is tied to the subject by more than the name: what "said elsewhere" may rest on
  const strong = prepareSource([...map.values()].filter((v) => !v?.weak).map((v) => v?.text || '').join(' \n '));
  const tiedTexts = [...map.values()].filter((v) => !v?.weak).map((v) => v?.text || '').filter(Boolean);
  const ignore = new Set(ignoreWords.flatMap((w) => String(w || '').split(/\s+/)).filter(Boolean).map(fold));
  const reasons = [];
  let checked = 0;
  let dropped = 0;
  let kept_ = 0;
  let failedLines = 0;
  let failed = null;
  let section = '';
  const lines = [];
  for (const line of String(content || '').split('\n')) {
    if (/^\s*#{1,6}\s/.test(line)) {
      // a "### sub-heading" stays inside its "## SECTION"
      if (/^\s*#{1,2}\s/.test(line)) section = line.trim();
      lines.push(line);
      continue;
    }
    // blank lines and italic notes the caller wrote (the coverage caveat) stay as they are
    if (!line.trim() || /^\s*\*[^*\n].*\*\s*$/.test(line) && !/\[Source \d+\]/.test(line)) { lines.push(line); continue; }
    const [, marker, body] = line.match(/^(\s*(?:[-*+•]\s*|\d{1,3}[.)]\s+)?)([\s\S]*)$/);
    const kept = [];
    const sentences = lineSentences(body);
    const citesOf = sentences.map((sentence) => [...new Set([...sentence.matchAll(/\[Source (\d+)\]/g)].map((x) => Number(x[1])).filter((n) => prepared.has(n)))]);
    sentences.forEach((sentence, i) => {
      let valid = citesOf[i];
      // Models often write two or three sentences and cite once at the end of the paragraph or bullet: a sentence
      // with no marker of its own rests on the next cited sentence of the same line, or failing that the one before.
      if (!valid.length && inherit) valid = citesOf.slice(i + 1).find((c) => c.length) || citesOf.slice(0, i).reverse().find((c) => c.length) || [];
      const claim = sentence.replace(/\s*\[Source \d+\]/g, '').trim();
      const { years, numbers } = claimNumbers(claim);
      if (!claim || /^[.;,]$/.test(claim)) return;
      if (!valid.length && onlyNegative(claim) && !years.length && !numbers.length) { kept.push(sentence); return; }
      checked += 1;
      const inFail = failSections.includes(section);
      let why = null;
      let legal = false;
      // "no litigation was found" and a reference question in an advisory section state no legal matter
      if (legalTerms && !onlyNegative(claim) && !(advisorySections.includes(section) && isAsking(plain(claim)))) {
        // only sources tied to the subject by more than the name may carry a legal matter
        const tied = valid.filter((n) => !map.get(n)?.weak).map((n) => map.get(n)?.text || '').join(' \n ');
        why = legalUnsupported(claim, tied);
        if (typeof why === 'string') {
          // Not in the source it cites. A person whose public record is a fraud trial has it in most of their
          // sources, and a live model cites loosely (every answer about Elizabeth Holmes was refused): when two
          // or more other sources tied to the person state the same matter, the citation is loose and the
          // sentence stays. With one such source the sentence goes but is not an invented matter; with none it
          // goes and counts as invented.
          const backers = tiedTexts.filter((t) => legalUnsupported(claim, t) === null).length;
          if (backers >= 2) why = null;
          else legal = backers === 0;
        } else if (why) {
          why = why.minor;
        }
      }
      if (why) {
        // removed below; never rescued by another source
      } else if (!valid.length) {
        why = advisorySections.includes(section) ? supports(everything, claim, ignore) : 'no citation';
      } else if (weakDropSections.includes(section) && valid.every((n) => map.get(n)?.weak)) {
        why = 'cites only sources that match the name alone';
      } else {
        why = supports(prepareSource(valid.map((n) => map.get(n)?.text || '').join(' \n ')), claim, ignore);
        // A fact the cited source lacks but another source about the person gives is a loose citation, not an
        // invented fact: the sentence stays. A year, number or name that no such source gives is removed.
        if (why && elsewhere && !supports(strong, claim, ignore)) why = null;
      }
      if (why) {
        dropped += 1;
        reasons.push(`${why}: ${claim.slice(0, 80)}`);
        // a legal line that cites only name-only sources is dropped quietly; unsupported ones count against the answer
        if (legal || (inFail && why !== 'cites only sources that match the name alone')) {
          failedLines += 1;
          if (failedLines >= failAfter && !failed) {
            failed = legal && !inFail
              ? `${failedLines === 1 ? 'an unsupported legal line' : `${failedLines} unsupported legal lines`} (the last under ${section.replace(/^#+\s*/, '')})`
              : `${failedLines === 1 ? 'an unsupported line' : `${failedLines} unsupported lines`} under ${section.replace(/^#+\s*/, '')}`;
          }
        }
        return;
      }
      kept_ += 1;
      // citations to numbers that are not sources go; the valid ones stay
      kept.push(sentence.replace(/\s*\[Source (\d+)\]/g, (m, n) => (prepared.has(Number(n)) ? m : '')));
    });
    if (kept.length) lines.push(`${marker}${kept.join(' ')}`);
  }
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (emptySection) {
    // a section left with nothing under it says so
    // (the next heading, or the end of the whole text: a blank line between a heading and its body is not empty)
    out = out.replace(/^(##\s[^\n]+)(?=\s*(?:\n##\s|(?![\s\S])))/gm, `$1\n${emptySection}`);
  }
  if (failed) return { ok: false, content: out, checked, dropped, reasons, reason: failed };
  if (checked > 0 && dropped / checked > maxDropShare) return { ok: false, content: out, checked, dropped, reasons, reason: `${dropped} of ${checked} lines were not supported by their sources` };
  if (checked > 0 && dropped === checked) return { ok: false, content: out, checked, dropped, reasons, reason: 'no line was supported by its sources' };
  if (kept_ < minKept) return { ok: false, content: out, checked, dropped, reasons, reason: `only ${kept_} supported line${kept_ === 1 ? '' : 's'} were left` };
  return { ok: true, content: out, checked, dropped, reasons };
}

/**
 * @param {Object} plan query plan
 * @param {{ mode, name }} entity resolved entity
 * @param {Object[]} results ranked results
 * @param {{ model?: string, useLLM?: boolean }} options
 */
export async function generateAnswer(plan, entity, results, { model = 'auto', useLLM = true, deadline = null } = {}) {
  const top = results.slice(0, MAX_SOURCES_FOR_LLM);
  const sourceMap = Object.fromEntries(top.map((r, i) => [String(i + 1), { title: r.title, url: r.url, sourceName: r.sourceName || hostOf(r.url), date: dateOf(r), type: r.type || r.source }]));
  let reason = 'AI answers are not enabled on this deployment';
  // "provider:model" from the model menu; anything else is ignored, and the
  // answer says so instead of silently using another model.
  const requested = typeof model === 'string' && model && model !== 'auto' ? model : null;
  const requestedModel = requested ? requested.split(':').slice(1).join(':') : null;
  const modelNote = (used) => (requested && (!requestedModel || used !== requestedModel)
    ? `Requested model "${requested}" is not available${used ? `; used ${used} instead` : ''}`
    : null);

  if (useLLM && top.length > 0 && llmConfigured()) {
    const today = new Date().toISOString().slice(0, 10);
    const user = `Today's date: ${today}
Question: ${plan.query}
${entity.mode === 'entity' ? `Subject: ${entity.name}\n` : ''}${plan.intents.length ? `The user wants: ${plan.intents.join(', ')}${plan.recency ? ' (latest)' : ''}\n` : plan.recency ? 'The user wants the latest information\n' : ''}
Sources:
${sourcesBlock(top)}`;
    // An answer that fails the structure and citation checks sends the request to the next model
    const out = await chatComplete([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], {
      preferred: model, maxTokens: 3000, deadline,
      accept: (text) => validateAnswer(text, top.length).ok,
    });
    if (out) {
      const checked = validateAnswer(out.text, top.length);
      if (checked.ok) {
        return {
          content: checked.content,
          sourceMap,
          llm: { provider: out.provider, providerLabel: out.providerLabel, model: out.model, confidence: checked.confidence, removedCitations: checked.removedCitations, skipped: out.skipped || [], modelNote: modelNote(out.model) },
        };
      }
      reason = `The AI answer failed validation (${checked.reason})`;
      console.warn('LLM answer rejected:', checked.reason);
    } else {
      reason = 'The AI model was unavailable';
    }
  }

  // Extractive fallback, aware of the entity and intent
  const regex = entity.mode === 'entity' ? entityRegex(entity.tokens && entity.tokens.length ? entity.tokens : plan.entityTokens) : null;
  const ctx = {
    entityName: entity.mode === 'entity' ? entity.name : null,
    entityTest: regex ? (sentence) => mentionMatches(sentence, new RegExp(regex.source, regex.flags)).length > 0 : null,
    intentRes: plan.intents.map((i) => INTENTS[i]),
    intents: plan.intents,
    recency: plan.recency,
    termsQuery: plan.entityCandidate || plan.query,
    reason,
  };
  const synthesized = synthesizeFromResults(plan.query, top, ctx);
  return { content: synthesized.content, sourceMap: synthesized.sourceMap, categories: synthesized.categories, llm: null, fallbackReason: reason, modelNote: modelNote(null) };
}
