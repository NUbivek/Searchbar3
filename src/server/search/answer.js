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
ceo cto coo cfo cpo cro cmo cio vp svp evp chief executive officer president chair chairman chairwoman founder co-founder cofounder director partner head
source sources summary note confirm verify ask check review consider question questions red flags open press career education litigation regulatory past companies roles timeline confidence
mr mrs ms dr prof jr sr inc corp ltd llc co plc sa ag gmbh`.split(/\s+/));
// A sentence that only says something was not found, or repeats the coverage caveat, needs no citation.
const NEGATIVE = /\b(?:not found|no (?:\w+ ){0,3}(?:found|mentions?|results?|records?|sources?)|none found|not evidence of|absence of|could not be (?:found|confirmed)|nothing (?:was )?found)\b/i;
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
function claimNames(sentence, ignore) {
  const runs = [];
  const re = /(?<![\p{L}\p{N}])[A-Z][\p{L}\p{N}&'’.-]*(?:\s+(?:(?:of|de|du|la|and|&|for)\s+)?[A-Z][\p{L}\p{N}&'’.-]*)*/gu;
  for (const m of sentence.matchAll(re)) {
    const tokens = m[0].split(/\s+/)
      .map((w) => w.replace(/['’]s$/, '').replace(/[.,;:'’-]+$/, ''))
      .filter((w) => /^[A-Z]/.test(w) && !NOT_A_NAME.has(w.toLowerCase()) && !ignore.has(fold(w)) && w.length >= 2);
    if (!tokens.length) continue;
    // the first word of a sentence is capitalised anyway: on its own it is not a name
    if (m.index === 0 && m[0].split(/\s+/).length === 1) continue;
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
 * gives is kept (a loose citation); only what no such source gives is removed.
 *
 * @param {string} content an answer that passed validateAnswer (sections and [Source n] markers normalised)
 * @param {Map<number, {text: string, weak?: boolean}>|Object} sources the text each source number stands for;
 *   `weak`: tied to the subject by name only
 * @param {{ failSections?: string[], advisorySections?: string[], weakDropSections?: string[], ignoreWords?: string[],
 *   maxDropShare?: number, emptySection?: string|null, inherit?: boolean, elsewhere?: boolean, failAfter?: number, minKept?: number }} [opts]
 * @returns {{ ok: boolean, content: string, checked: number, dropped: number, reasons: string[], reason?: string }}
 */
export function checkClaims(content, sources, opts = {}) {
  const {
    failSections = [], advisorySections = [], weakDropSections = [], ignoreWords = [], maxDropShare = 0.2, emptySection = null,
    inherit = false, elsewhere = false, failAfter = 1, minKept = 0,
  } = opts;
  const map = sources instanceof Map ? sources : new Map(Object.entries(sources || {}).map(([k, v]) => [Number(k), v]));
  const prepared = new Map([...map].map(([n, v]) => [n, prepareSource(v?.text || '')]));
  const everything = prepareSource([...map.values()].map((v) => v?.text || '').join(' \n '));
  // every source that is tied to the subject by more than the name: what "said elsewhere" may rest on
  const strong = prepareSource([...map.values()].filter((v) => !v?.weak).map((v) => v?.text || '').join(' \n '));
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
      if (!valid.length && NEGATIVE.test(claim) && !years.length && !numbers.length) { kept.push(sentence); return; }
      checked += 1;
      const inFail = failSections.includes(section);
      let why = null;
      if (!valid.length) {
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
        if (inFail && why !== 'cites only sources that match the name alone') {
          failedLines += 1;
          if (failedLines >= failAfter && !failed) failed = `${failedLines === 1 ? 'an unsupported line' : `${failedLines} unsupported lines`} under ${section.replace(/^#+\s*/, '')}`;
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
