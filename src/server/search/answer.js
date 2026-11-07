/**
 * Answer generation: one LLM call over the ranked sources (free provider
 * chain), validated; otherwise the extractive (quoted) digest.
 * Output keeps the documented sections: SUMMARY, KEY POINTS, DETAILED
 * ANALYSIS, DIFFERENT PERSPECTIVES, FOLLOW-UP QUESTIONS.
 */
import { chatComplete, PROVIDERS, providerEnabled } from '../llm/providers';
import { synthesizeFromResults } from '../../utils/fallbackSynthesizer';
import { INTENTS, entityRegex, mentionMatches } from './queryPlan';

const MAX_SOURCES_FOR_LLM = 12;
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

/**
 * @param {Object} plan query plan
 * @param {{ mode, name }} entity resolved entity
 * @param {Object[]} results ranked results
 * @param {{ model?: string, useLLM?: boolean }} options
 */
export async function generateAnswer(plan, entity, results, { model = 'auto', useLLM = true, deadline = null } = {}) {
  const top = results.slice(0, MAX_SOURCES_FOR_LLM);
  const sourceMap = Object.fromEntries(top.map((r, i) => [String(i + 1), { title: r.title, url: r.url, sourceName: r.sourceName || hostOf(r.url), date: dateOf(r), type: r.type || r.source }]));
  let reason = 'No AI model is configured';

  if (useLLM && top.length > 0 && llmConfigured()) {
    const today = new Date().toISOString().slice(0, 10);
    const user = `Today's date: ${today}
Question: ${plan.query}
${entity.mode === 'entity' ? `Subject: ${entity.name}\n` : ''}${plan.intents.length ? `The user wants: ${plan.intents.join(', ')}${plan.recency ? ' (latest)' : ''}\n` : plan.recency ? 'The user wants the latest information\n' : ''}
Sources:
${sourcesBlock(top)}`;
    const out = await chatComplete([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], { preferred: model, maxTokens: 3000, deadline });
    if (out) {
      const checked = validateAnswer(out.text, top.length);
      if (checked.ok) {
        return {
          content: checked.content,
          sourceMap,
          llm: { provider: out.provider, providerLabel: out.providerLabel, model: out.model, confidence: checked.confidence, removedCitations: checked.removedCitations, skipped: out.skipped || [] },
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
    recency: plan.recency,
    termsQuery: plan.entityCandidate || plan.query,
    reason,
  };
  const synthesized = synthesizeFromResults(plan.query, top, ctx);
  return { content: synthesized.content, sourceMap: synthesized.sourceMap, categories: synthesized.categories, llm: null, fallbackReason: reason };
}
