/**
 * Industry / topic vocabulary shared by "Ask your network" (server) and the
 * pages that look up who in your network covers a sector (browser).
 * `ask` recognises the topic in free text; `terms` are searched in titles
 * and company names.
 */
export const KEYWORD_GROUPS = [
  { label: 'fintech', ask: /\b(fintech|financial\s+services|payments?|banking|finance)\b/i, terms: ['fintech', 'payments', 'payment', 'bank', 'banking', 'financial', 'finance', 'lending', 'insurance', 'capital markets', 'trading', 'wealth'] },
  { label: 'healthcare', ask: /\b(health\s?care|health|healthtech|medical|medicine|hospitals?|pharma)\b/i, terms: ['health', 'healthcare', 'medical', 'medicine', 'hospital', 'clinic', 'clinical', 'pharma', 'biotech', 'therapeutics', 'patient'] },
  { label: 'ai', ask: /\b(ai|a\.i\.|artificial\s+intelligence|machine\s+learning|ml|llms?|genai|generative\s+ai|deep\s+learning)\b/i, terms: ['ai', 'artificial intelligence', 'machine learning', 'ml', 'llm', 'deep learning', 'genai', 'nlp', 'computer vision'] },
  { label: 'crypto', ask: /\b(crypto|web3|blockchain|bitcoin|ethereum|defi)\b/i, terms: ['crypto', 'web3', 'blockchain', 'bitcoin', 'ethereum', 'defi', 'token'] },
  { label: 'saas', ask: /\b(saas|b2b\s+software|enterprise\s+software)\b/i, terms: ['saas', 'software', 'enterprise', 'cloud', 'platform'] },
  { label: 'climate', ask: /\b(climate|climatetech|cleantech|energy|sustainability|renewables?)\b/i, terms: ['climate', 'energy', 'solar', 'renewable', 'sustainability', 'carbon', 'battery', 'cleantech'] },
  { label: 'education', ask: /\b(edtech|education|teaching|schools?|universit(?:y|ies))\b/i, terms: ['education', 'edtech', 'school', 'university', 'teacher', 'learning', 'college', 'academy'] },
  { label: 'security', ask: /\b(security|cybersecurity|cyber|infosec)\b/i, terms: ['security', 'cyber', 'cybersecurity', 'infosec', 'identity'] },
  { label: 'gaming', ask: /\b(gaming|games|video\s+games)\b/i, terms: ['gaming', 'games', 'game', 'esports'] },
  { label: 'ecommerce', ask: /\b(e-?commerce|retail|consumer\s+goods|cpg|dtc)\b/i, terms: ['ecommerce', 'e-commerce', 'retail', 'consumer', 'cpg', 'dtc', 'marketplace'] },
  { label: 'biotech', ask: /\b(biotech|life\s+sciences|biology|genomics)\b/i, terms: ['biotech', 'bio', 'life sciences', 'genomics', 'therapeutics', 'pharma'] },
  { label: 'real estate', ask: /\b(real\s+estate|proptech|property)\b/i, terms: ['real estate', 'proptech', 'property', 'realty', 'housing'] },
  { label: 'media', ask: /\b(media|journalism|journalists?|publishing|news)\b/i, terms: ['media', 'journalist', 'editor', 'publishing', 'news', 'reporter', 'writer'] },
  { label: 'venture capital', ask: /\b(venture\s+capital|vc\s+firms?|venture)\b/i, terms: ['venture', 'capital', 'ventures', 'vc', 'partners', 'fund'] },
];


/** Sector labels mentioned in free text (a question, an answer, a company profile), most specific first. */
export function sectorKeywordsFrom(text, { max = 3 } = {}) {
  const t = String(text || '');
  const out = [];
  for (const g of KEYWORD_GROUPS) {
    if (g.label === 'venture capital' || g.label === 'saas') continue;
    if (g.ask.test(t)) out.push(g.label);
    if (out.length >= max) break;
  }
  return out;
}
