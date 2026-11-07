/**
 * Data-room document Q&A.
 *
 * Documents are split into ~800-character passages (whole sentences where
 * possible, with overlap), ranked against the question with BM25, and the
 * answer is built only from the top passages:
 *
 *  - With Together configured: the model sees passages labelled [D1], [D2]...
 *    (and [S1]... for curated sources when requested) and must cite every
 *    sentence. Its output is then verified: sentences citing labels that do
 *    not exist, sentences with no citation, and sentences with numbers that
 *    do not appear in the cited passages are dropped. If nothing verifiable
 *    remains, the answer falls back to extractive quoting.
 *  - Without Together: the best-matching sentences are quoted verbatim with
 *    their [Dn] labels.
 *
 * Nothing here invents content: every sentence returned either is a verbatim
 * quote or carries a citation to a passage the caller also receives.
 */
import { completeWithTogether, togetherConfigured } from './together';
import { searchCuratedSources } from '../utils/sources/curatedIndex';

export const PASSAGE_SIZE = 800;
export const PASSAGE_OVERLAP = 160;
const TOP_PASSAGES = 8;
const TOP_SOURCES = 5;
const SOURCE_TEXT_LIMIT = 700;
export const NOT_FOUND_TEXT = 'Not found in the documents.';
export const EXTRACTIVE_NOTE = 'Quoted from your documents (no AI model configured)';
export const FALLBACK_NOTE = 'Quoted from your documents (the AI answer could not be verified against the passages)';

const STOPWORDS = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it its ' +
  'me my of on or our so than that the their them then there these they this those to was we were what when where which ' +
  'who whom why will with would you your about tell give show please any all also much many').split(' '));

/** Lowercase word/number tokens with stopwords removed and a light plural strip. */
export function tokenize(text) {
  const raw = String(text || '').toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?/g) || [];
  const out = [];
  for (let t of raw) {
    if (STOPWORDS.has(t)) continue;
    if (t.length > 3 && /[a-z]s$/.test(t) && !t.endsWith('ss')) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

/** Split text into sentence-like units (sentence ends and line breaks). */
export function splitSentences(text) {
  return String(text || '')
    .split(/\n+|(?<=[.!?])\s+(?=["'(\[$]?[A-Z0-9])/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

function hardSplit(sentence, size) {
  const parts = [];
  for (let i = 0; i < sentence.length; i += size) parts.push(sentence.slice(i, i + size));
  return parts;
}

/**
 * Split one document into overlapping passages.
 * Passages are built from whole sentences up to ~size characters; each new
 * passage starts with the trailing sentences of the previous one (up to
 * ~overlap characters) so facts on a boundary appear intact in one passage.
 */
export function chunkDocument(doc, { size = PASSAGE_SIZE, overlap = PASSAGE_OVERLAP } = {}) {
  const docId = doc?.id ?? doc?.docId ?? null;
  const docName = doc?.name ?? doc?.docName ?? 'Document';
  const units = splitSentences(doc?.content).flatMap((s) => (s.length > size ? hardSplit(s, size - overlap) : [s]));
  const passages = [];
  let current = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    passages.push({ docId, docName, passageIndex: passages.length, text: current.join(' ') });
    // Carry trailing sentences forward as overlap.
    const carry = [];
    let carried = 0;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      if (carried + current[i].length > overlap) break;
      carry.unshift(current[i]);
      carried += current[i].length + 1;
    }
    // A single sentence longer than the overlap: carry its tail characters.
    if (!carry.length) {
      const last = current[current.length - 1];
      const tail = last.slice(-overlap).replace(/^\S*\s/, '');
      if (tail) { carry.push(tail); carried = tail.length + 1; }
    }
    current = carry;
    length = carried;
  };
  let fresh = 0; // sentences added since the last flush
  for (const unit of units) {
    if (length + unit.length > size && fresh > 0) {
      flush();
      fresh = 0;
    }
    current.push(unit);
    length += unit.length + 1;
    fresh += 1;
  }
  if (fresh > 0) flush();
  return passages;
}

/**
 * Rank items by BM25 against the question. Each item needs a `text` field.
 * Returns items with score > 0, best first, each with a `score` property.
 */
export function bm25Rank(question, items, { k1 = 1.5, b = 0.75, limit = Infinity } = {}) {
  const queryTerms = [...new Set(tokenize(question))];
  if (!queryTerms.length || !items?.length) return [];
  const docs = items.map((item) => {
    const tokens = tokenize(item.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { item, tf, len: tokens.length };
  });
  const N = docs.length;
  const avgLen = docs.reduce((sum, d) => sum + d.len, 0) / N || 1;
  const df = new Map();
  for (const term of queryTerms) df.set(term, docs.filter((d) => d.tf.has(term)).length);
  const scored = [];
  for (const d of docs) {
    let score = 0;
    for (const term of queryTerms) {
      const f = d.tf.get(term);
      if (!f) continue;
      const n = df.get(term);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
    }
    if (score > 0) scored.push({ ...d.item, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit);
}

const LABEL_GROUP_RE = /\[((?:[DS]\d+)(?:\s*[,;]\s*[DS]?\d+)*)\]/g;

function labelsIn(sentence) {
  const labels = [];
  for (const match of sentence.matchAll(LABEL_GROUP_RE)) {
    let prefix = 'D';
    for (const part of match[1].split(/\s*[,;]\s*/)) {
      const m = part.match(/^([DS])?(\d+)$/);
      if (!m) continue;
      if (m[1]) prefix = m[1];
      labels.push(`${prefix}${m[2]}`);
    }
  }
  return labels;
}

// Any bracketed thing that looks like a citation, valid format or not.
const ANY_CITATION_RE = /\[[A-Za-z]*\s*\d+(?:\s*[,;]\s*[A-Za-z]*\s*\d+)*\]/g;

const normNumber = (n) => n.replace(/,/g, '');

/** Numbers stated in a sentence (labels removed) must appear in the cited text. */
function numbersSupported(sentence, citedText) {
  const stripped = sentence.replace(ANY_CITATION_RE, ' ');
  const numbers = stripped.match(/\d[\d,]*(?:\.\d+)?/g) || [];
  if (!numbers.length) return true;
  const haystack = normNumber(citedText);
  return numbers.every((n) => {
    const v = normNumber(n).replace(/\.0+$/, '');
    return new RegExp(`(^|[^0-9.])${v.replace('.', '\\.')}(?![0-9])`).test(haystack);
  });
}

/**
 * Verify a model answer against the labelled context.
 * @returns {{ sentences: string[], used: Set<string>, saidNotFound: boolean }}
 */
export function verifyAnswer(text, contextByLabel) {
  const kept = [];
  const used = new Set();
  let saidNotFound = false;
  const sentences = String(text || '')
    .replace(/<\/?answer>/gi, '')
    .split(/\n+|(?<=[.!?](?:\s*\[[^\]]+\])*)\s+(?=[A-Z0-9"'($*-])/)
    .map((s) => s.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (/not found in the documents/i.test(sentence)) { saidNotFound = true; continue; }
    const labels = labelsIn(sentence);
    const looseCount = (sentence.match(ANY_CITATION_RE) || []).length;
    if (!labels.length || looseCount === 0) continue; // uncited
    if (!labels.every((l) => contextByLabel.has(l))) continue; // invented label
    // Any malformed bracket citation alongside valid ones: drop to be safe.
    const wellFormed = (sentence.match(LABEL_GROUP_RE) || []).length;
    if (wellFormed !== looseCount) continue;
    const citedText = labels.map((l) => contextByLabel.get(l).text).join(' ');
    if (!numbersSupported(sentence, citedText)) continue;
    kept.push(sentence);
    labels.forEach((l) => used.add(l));
  }
  return { sentences: kept, used, saidNotFound };
}

function toCitation(entry) {
  if (entry.kind === 'source') {
    return { label: entry.label, sourceName: entry.sourceName, title: entry.title, url: entry.url, text: entry.text };
  }
  return { label: entry.label, docId: entry.docId, docName: entry.docName, passageIndex: entry.passageIndex, text: entry.text };
}

/** Quote the best-matching sentences verbatim from the labelled context. */
export function extractiveAnswer(question, context, { min = 3, max = 5 } = {}) {
  const sentences = [];
  for (const entry of context) {
    for (const s of splitSentences(entry.text)) sentences.push({ text: s, label: entry.label });
  }
  const ranked = bm25Rank(question, sentences);
  const picked = [];
  const seen = new Set();
  const top = ranked[0]?.score || 0;
  for (const s of ranked) {
    const key = s.text.toLowerCase();
    if (seen.has(key)) continue;
    // Beyond the minimum, only keep sentences that are reasonably strong matches.
    if (picked.length >= min && s.score < top * 0.5) break;
    seen.add(key);
    picked.push(s);
    if (picked.length >= max) break;
  }
  const used = new Set(picked.map((s) => s.label));
  return {
    answer: picked.map((s) => `"${s.text}" [${s.label}]`).join('\n'),
    used,
    count: picked.length,
  };
}

function buildPrompt(question, context) {
  const blocks = context.map((entry) => (entry.kind === 'source'
    ? `[${entry.label}] (curated source: ${entry.sourceName}${entry.title ? ` - ${entry.title}` : ''})\n${entry.text}`
    : `[${entry.label}] (document: ${entry.docName}, passage ${entry.passageIndex + 1})\n${entry.text}`)).join('\n\n');
  return `You are an investment diligence analyst answering a question using ONLY the passages below.

Rules:
- Use only facts stated in the passages. Do not use outside knowledge, do not estimate, do not calculate new figures.
- End every sentence with the label of the passage that supports it, e.g. [D1] or [D2][S1]. Only use labels that appear below.
- Copy numbers exactly as written in the passages.
- If the passages do not answer the question, reply exactly: ${NOT_FOUND_TEXT}
- Be concise: 1 to 5 sentences. No preamble.

Passages:
${blocks}

Question: ${question}

<answer>
`;
}

async function loadSourceContext(question) {
  try {
    const results = await searchCuratedSources(question, { limit: TOP_SOURCES, waitMs: 4000 });
    return (results || []).slice(0, TOP_SOURCES).map((r, i) => ({
      kind: 'source',
      label: `S${i + 1}`,
      sourceName: r.sourceName || 'Curated source',
      title: r.title || '',
      url: r.url || null,
      text: String(r.content || r.snippet || r.title || '').replace(/\s+/g, ' ').trim().slice(0, SOURCE_TEXT_LIMIT),
    })).filter((s) => s.text);
  } catch (error) {
    console.warn('Curated source search failed for data-room question:', error.message);
    return [];
  }
}

/**
 * @param {{ question: string, documents: Array<{id, name, content}>, includeSources?: boolean }} input
 * @returns {Promise<{ answer: string, mode: 'ai'|'extractive', citations: Array, passages: Array, notFound: boolean, note?: string, model?: string }>}
 */
export async function answerQuestion({ question, documents = [], includeSources = false }) {
  const q = String(question || '').trim();
  const allPassages = (documents || []).flatMap((doc) => chunkDocument(doc));
  const topPassages = bm25Rank(q, allPassages, { limit: TOP_PASSAGES });
  const docContext = topPassages.map((p, i) => ({ ...p, kind: 'document', label: `D${i + 1}` }));
  const sourceContext = includeSources ? await loadSourceContext(q) : [];
  const context = [...docContext, ...sourceContext];
  const passages = context.map(toCitation);
  const contextByLabel = new Map(context.map((c) => [c.label, c]));

  if (!context.length) {
    return {
      answer: NOT_FOUND_TEXT,
      mode: togetherConfigured() ? 'ai' : 'extractive',
      citations: [],
      passages: [],
      notFound: true,
      documentCount: (documents || []).length,
    };
  }

  const extractive = (note) => {
    // Documents first (3-5 sentences); curated sources only add up to 2 strong
    // matches so generic source hits never crowd out the data room.
    const docEx = extractiveAnswer(q, docContext);
    const srcEx = sourceContext.length ? extractiveAnswer(q, sourceContext, { min: 1, max: 2 }) : { count: 0, answer: '', used: new Set() };
    const count = docEx.count + srcEx.count;
    if (!count) {
      return { answer: NOT_FOUND_TEXT, mode: 'extractive', citations: [], passages, notFound: true, note };
    }
    const used = new Set([...docEx.used, ...srcEx.used]);
    return {
      answer: [docEx.answer, srcEx.answer].filter(Boolean).join('\n'),
      mode: 'extractive',
      note: srcEx.count ? note.replace('your documents', 'your documents and curated sources') : note,
      citations: context.filter((c) => used.has(c.label)).map(toCitation),
      passages,
      notFound: docEx.count === 0 && srcEx.count === 0,
      foundInDocuments: docEx.count > 0,
    };
  };

  if (!togetherConfigured()) return extractive(EXTRACTIVE_NOTE);

  const completion = await completeWithTogether(buildPrompt(q, context), { maxTokens: 600, temperature: 0.1 });
  if (!completion?.text) return extractive(FALLBACK_NOTE);

  const verified = verifyAnswer(completion.text, contextByLabel);
  if (!verified.sentences.length) {
    // The model declined and nothing in the retrieved passages matches strongly either.
    return extractive(FALLBACK_NOTE);
  }
  return {
    answer: verified.sentences.join(' '),
    mode: 'ai',
    model: completion.model,
    citations: context.filter((c) => verified.used.has(c.label)).map(toCitation),
    passages,
    notFound: false,
  };
}
