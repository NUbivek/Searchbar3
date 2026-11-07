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
    const text = String(r.content || r.snippet || '').replace(/\s+/g, ' ').slice(0, 700);
    return `[Source ${i + 1}] ${r.title}\nPublisher: ${r.sourceName || hostOf(r.url)}${dateOf(r) ? ` | Date: ${dateOf(r)}` : ''} | Type: ${r.sourceTierLabel || r.type || 'web'}\nURL: ${r.url}\nText: ${text || '(headline only)'}`;
  }).join('\n\n');
}

/** Remove citations to sources that do not exist; true when output is usable. */
export function validateAnswer(text, sourceCount) {
  let content = String(text || '').trim();
  // Some models wrap output in code fences or add a preface before SUMMARY
  content = content.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '');
  const start = content.indexOf('## SUMMARY');
  if (start < 0) return { ok: false, reason: 'missing SUMMARY section' };
  content = content.slice(start);
  const missing = SECTIONS.filter((h) => !content.includes(h));
  if (missing.length > 1) return { ok: false, reason: `missing sections: ${missing.join(', ')}` };
  let removed = 0;
  content = content.replace(/\[Sources?\s*([\d,\s–-]+)\]/gi, (m, nums) => {
    const valid = nums.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount);
    if (valid.length === 0) { removed += 1; return ''; }
    return valid.map((n) => `[Source ${n}]`).join(' ');
  });
  const citations = (content.match(/\[Source \d+\]/g) || []).length;
  if (citations === 0) return { ok: false, reason: 'no valid citations' };
  const conf = content.match(/^CONFIDENCE:\s*(High|Medium|Low)\b\s*[-–:]?\s*(.*)$/im);
  if (conf) content = content.replace(conf[0], '').trim();
  return { ok: true, content, citations, removedCitations: removed, confidence: conf ? { level: conf[1], reason: conf[2].trim() } : null };
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
export async function generateAnswer(plan, entity, results, { model = 'auto', useLLM = true } = {}) {
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
    const out = await chatComplete([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], { preferred: model, maxTokens: 1800 });
    if (out) {
      const checked = validateAnswer(out.text, top.length);
      if (checked.ok) {
        return {
          content: checked.content,
          sourceMap,
          llm: { provider: out.provider, providerLabel: out.providerLabel, model: out.model, confidence: checked.confidence, removedCitations: checked.removedCitations },
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
