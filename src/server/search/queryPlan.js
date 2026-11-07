/**
 * Query understanding for diligence searches.
 *
 * Splits a query like "open ai latest funding" into:
 *   entity candidate  "open ai"   (what the search is about)
 *   intents           ['funding'] (what the user wants to know)
 *   recency           true        ("latest": newest first)
 * and builds per-source retrieval queries. After retrieval, resolveEntity()
 * confirms the entity from how sources actually write it ("OpenAI") and
 * returns a matcher used to drop results that are not about it.
 */

export const INTENTS = {
  funding: /\b(funding|fundraise|fundraising|raise[sd]?|raising|round|valuation|valued|investors?|investments?|backers?|series\s?[a-h]|seed|pre-seed|capital)\b/i,
  competitors: /\b(competitors?|competition|competitive|rivals?|alternatives?|versus|vs\.?|compared?|comparison|landscape)\b/i,
  team: /\b(founders?|co-?founders?|founded|ceo|cto|cfo|team|leadership|executives?|management|hires?|hired|people)\b/i,
  financials: /\b(revenue|arr|mrr|profit|profitable|margin|burn|growth|financials?|earnings|ebitda|customers?|users)\b/i,
  product: /\b(products?|launch(?:es|ed)?|features?|platform|technology|roadmap|releases?)\b/i,
  legal: /\b(lawsuits?|sued|litigation|regulators?|regulatory|fines?|investigation|antitrust)\b/i,
};

const RECENCY_RE = /\b(latest|recent|recently|newest|new|current|currently|this\s+(?:year|month|week|quarter)|today|now)\b/i;
const YEAR_RE = /\b(20[12]\d)\b/;

// Words that describe what the user wants, not who it is about
const QUERY_STOPWORDS = new Set((
  'the a an of for about on in at to and or with from by is are was were be been what who whom which how much many when where why ' +
  'did does do has have had its it their there this that these those me my our tell show give find get list any all ' +
  'latest recent recently newest new current currently today now news update updates info information details overview ' +
  'funding fundraise fundraising raise raised raises raising round rounds valuation valued investor investors investment investments backers backer capital seed pre-seed ' +
  'competitor competitors competition competitive rival rivals alternative alternatives versus vs compared compare comparison landscape ' +
  'founder founders co-founder co-founders cofounder founded ceo cto cfo team leadership executive executives management hire hires hired people ' +
  'revenue arr mrr profit profitable margin burn growth financial financials earnings ebitda customers users ' +
  'product products launch launches launched feature features platform technology roadmap release releases ' +
  'lawsuit lawsuits sued litigation regulator regulators regulatory fine fines investigation antitrust ' +
  'series year month week quarter company startup'
).split(/\s+/));

// Topical words: a query made only of these is a topic search, not a company
export const GENERIC_WORDS = new Set((
  'ai ml llm llms genai agent agents agentic model models open source open-source data cloud security cyber cybersecurity saas b2b b2c ' +
  'fintech healthtech biotech edtech proptech insurtech climate climatetech energy robotics hardware software enterprise consumer ' +
  'market markets industry sector space startups companies infrastructure devtools developer developers tools platform apps app ' +
  'payments banking crypto web3 blockchain mobility logistics supply chain retail ecommerce e-commerce marketplace health healthcare ' +
  'quantum chips semiconductors semiconductor gpu gpus compute api apis automation analytics vertical horizontal deep tech defense ' +
  'legal legaltech law insurance accounting hr sales marketing fintech design media gaming food agriculture agtech travel real estate ' +
  'manufacturing construction education research science scientific medical pharma drug drugs bio venture vc private equity'
).split(/\s+/));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function detectIntents(query) {
  return Object.entries(INTENTS).filter(([, re]) => re.test(query)).map(([name]) => name);
}

/**
 * @param {string} rawQuery
 * @returns {{ query, entityCandidate, entityTokens, intents, recency, year, isGenericCandidate }}
 */
export function understandQuery(rawQuery) {
  const query = String(rawQuery || '').trim().replace(/\s+/g, ' ');
  const words = query.match(/[\p{L}\p{N}][\p{L}\p{N}.&'+-]*/gu) || [];
  const entityTokens = [];
  for (const w of words) {
    const lower = w.toLowerCase().replace(/'s$/, '');
    if (QUERY_STOPWORDS.has(lower) || YEAR_RE.test(w)) continue;
    entityTokens.push(w.replace(/'s$/i, ''));
  }
  const entityCandidate = entityTokens.join(' ');
  const yearMatch = query.match(YEAR_RE);
  return {
    query,
    entityCandidate,
    entityTokens,
    intents: detectIntents(query),
    recency: RECENCY_RE.test(query),
    year: yearMatch ? Number(yearMatch[1]) : null,
    isGenericCandidate: entityTokens.length > 0 && entityTokens.every((t) => GENERIC_WORDS.has(t.toLowerCase())),
  };
}

/**
 * Regex matching the candidate as it might be written: spaced, hyphenated
 * or joined ("open ai" -> "Open AI", "Open-AI", "OpenAI"). Case-insensitive;
 * mentionMatches() then requires the source to write it as a proper name.
 */
export function entityRegex(tokens) {
  if (!tokens || tokens.length === 0) return null;
  const body = tokens.map(escapeRe).join('[\\s-]?');
  return new RegExp(`(?<![\\p{L}\\p{N}-])${body}(?![\\p{L}\\p{N}]|-[\\p{L}])`, 'giu');
}

/** Mentions of the entity written as a proper name (each word capitalized). */
export function mentionMatches(text, regex) {
  if (!regex) return [];
  const out = [];
  for (const m of String(text || '').matchAll(regex)) {
    const words = m[0].split(/[\s-]+/);
    if (words.every((w) => /^[\p{Lu}\p{N}]/u.test(w))) out.push(m[0]);
  }
  return out;
}

const resultText = (r) => `${r.title || ''} ${r.content || r.snippet || ''}`;

// A headline in Title Case capitalizes every word, so a capitalized match
// there is weak evidence for a name that is also an ordinary word ("Ramp Up").
function isTitleCase(text) {
  const words = String(text || '').match(/\p{L}[\p{L}'’-]*/gu) || [];
  const long = words.filter((w) => w.length > 3);
  return long.length >= 3 && long.filter((w) => /^\p{Lu}/u.test(w)).length / long.length >= 0.8;
}

const NEWS_VERBS = 'raises|raised|raising|secures|secured|lands|closes|closed|gets|nabs|bags|valued|hits|reaches|launches|launched|unveils|introduces|debuts|releases|announces|acquires|acquired|buys|hires|appoints|names|expands|partners|files|sues|sued|faces|cuts|lays|plans|wins|signs|opens|is|has|was|says|reports|posts|tops|doubles|triples|valuation|ceo|cfo|cto|founder|co-founder';
const DESCRIPTORS = 'startup|start-up|company|firm|unicorn|fintech|platform|provider|maker|giant|rival|competitor|upstart|scaleup|scale-up|app|lab|labs|developer|player';
const PHRASAL = /^(up|down|off|out|in|on|over|away|back)\b/i;

/**
 * For a single-word name in a Title Case headline, the capital letter says
 * nothing ("Model 3 Ramp Up"). Accept it only in name-like positions: at the
 * start of the headline, before a news verb ("Harvey Raises"), or after a
 * descriptor ("Legal AI Startup Harvey").
 */
function nameLikeInTitleCase(title, regex) {
  const t = String(title || '');
  for (const m of t.matchAll(new RegExp(regex.source, regex.flags))) {
    if (!/^[\p{Lu}\p{N}]/u.test(m[0])) continue;
    const before = t.slice(0, m.index).trim();
    const after = t.slice(m.index + m[0].length).replace(/^['’]s\b/, '').trim();
    if (PHRASAL.test(after)) continue;
    if (!before || /[:|–—-]$/.test(before)) return true;
    if (new RegExp(`^(${NEWS_VERBS})\\b`, 'i').test(after)) return true;
    if (new RegExp(`\\b(${DESCRIPTORS})$`, 'i').test(before)) return true;
  }
  return false;
}

function candidateSubsequences(tokens, raw) {
  const out = [];
  const seen = new Set();
  const push = (arr) => { const k = arr.join(' '); if (arr.length && !seen.has(k)) { seen.add(k); out.push(arr); } };
  push(tokens);
  // Words the user capitalized ("Harvey legal AI" -> "Harvey") are a strong hint
  const capped = tokens.filter((t) => /^\p{Lu}/u.test(t) && !GENERIC_WORDS.has(t.toLowerCase()));
  if (capped.length && /\p{Ll}/u.test(raw)) push(capped);
  for (let len = tokens.length - 1; len >= 1; len -= 1) {
    for (let i = 0; i + len <= tokens.length; i += 1) push(tokens.slice(i, i + len));
  }
  return out;
}

function evaluateCandidate(tokens, results) {
  const regex = entityRegex(tokens);
  const forms = new Map();
  let sentenceCase = 0; // mentions outside Title Case headlines
  let lowercaseUses = 0; // the same word used as an ordinary word
  const plain = new RegExp(regex.source, 'giu');
  for (const r of results) {
    const titleMentions = mentionMatches(r.title, regex);
    const bodyMentions = mentionMatches(r.content || r.snippet, regex);
    for (const m of [...titleMentions, ...bodyMentions]) forms.set(m, (forms.get(m) || 0) + 1);
    if (bodyMentions.length || (titleMentions.length && !isTitleCase(r.title))) sentenceCase += 1;
    for (const m of `${r.title} ${r.content || r.snippet || ''}`.matchAll(plain)) if (/^\p{Ll}/u.test(m[0])) lowercaseUses += 1;
  }
  const ranked = [...forms.entries()].sort((a, b) => b[1] - a[1]);
  const joinedUsed = tokens.length > 1 && ranked.some(([form]) => !/[\s-]/.test(form));
  const generic = tokens.every((t) => GENERIC_WORDS.has(t.toLowerCase()));
  // Single-word names are checked strictly in Title Case headlines; multi-word
  // and joined names ("Mistral AI", "OpenAI") are distinctive enough.
  return { regex, ranked, joinedUsed, generic, sentenceCase, strict: tokens.length === 1, ambiguousWord: tokens.length === 1 && lowercaseUses > 0 };
}

/**
 * Decide whether the query is about a specific entity, using how the
 * retrieved sources write it. Returns { mode: 'entity'|'topic', name, tokens,
 * matcher, inTitle }.
 *  - Tries the whole candidate, then the words the user capitalized, then
 *    shorter sub-phrases ("Harvey legal AI" -> "Harvey").
 *  - Generic words alone are a topic, unless sources write them joined as a
 *    name ("open ai" -> "OpenAI").
 *  - A name that is also an ordinary word ("Ramp") must be backed by
 *    mentions outside Title Case headlines, and then only such mentions count.
 */
export function resolveEntity(plan, results = []) {
  const tokens = plan.entityTokens || [];
  if (tokens.length === 0) return { mode: 'topic', name: null, tokens: [], matcher: null };
  for (const cand of candidateSubsequences(tokens, plan.query)) {
    const ev = evaluateCandidate(cand, results);
    if (ev.ranked.length === 0) continue;
    if (ev.generic && !ev.joinedUsed) continue;
    if (ev.ambiguousWord && ev.sentenceCase === 0) continue;
    const name = (ev.joinedUsed ? ev.ranked.find(([form]) => !/[\s-]/.test(form)) : ev.ranked[0])[0];
    const fresh = () => new RegExp(ev.regex.source, ev.regex.flags);
    const inBody = (r) => mentionMatches(r.content || r.snippet, fresh()).length > 0;
    const inTitle = (r) => {
      if (mentionMatches(String(r.title || ''), fresh()).length === 0) return false;
      if (!ev.strict || !isTitleCase(r.title)) return true;
      return nameLikeInTitleCase(r.title, ev.regex);
    };
    return {
      mode: 'entity',
      name,
      tokens: cand,
      matcher: (r) => inBody(r) || inTitle(r),
      inTitle,
    };
  }
  return { mode: 'topic', name: null, tokens: [], matcher: null };
}

const INTENT_PHRASE = {
  funding: 'funding round',
  competitors: 'competitors',
  team: 'founders leadership',
  financials: 'revenue',
  product: 'product launch',
  legal: 'lawsuit',
};

/** Query text for web and site-specific search engines. */
export function webQuery(plan) {
  const subject = plan.entityCandidate || plan.query;
  const phrase = plan.intents.map((i) => INTENT_PHRASE[i]).filter(Boolean).join(' ');
  const when = plan.year ? ` ${plan.year}` : '';
  return `${subject} ${phrase}${when}`.trim();
}
