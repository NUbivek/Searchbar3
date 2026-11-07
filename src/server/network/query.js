/**
 * "Ask your network": a deterministic matching engine over the user's own
 * imported contacts.
 *
 *   parseQuestion("Who do I know at Stripe?")
 *     -> { companies: ['Stripe'], roles: [], keywords: [], locations: [], intent: 'who-at' }
 *   scoreContacts(contacts, filters) -> ranked matches, each with reasons
 *   introPaths(contacts, 'Stripe')    -> direct contacts + contacts at Stripe's investors
 *
 * Optionally an LLM turns an unusual question into the same filter shape. It
 * only ever receives the question text, never contact data. Contacts are
 * never sent to any external service.
 */
import { chatComplete } from '../llm/providers';
import { buildCompanyProfile } from '../companyProfile';
import { normalizeCompanyKey, companyMatch, dedupeKey } from '../../utils/network/parseContacts';

export const INTENTS = ['who-at', 'role', 'intro-path', 'general'];
const MAX_RESULTS = 100;

// ------------------------------------------------------------ vocab

/** Role groups: `ask` recognises the role in a question; `match` tests a title. */
export const ROLE_GROUPS = [
  { label: 'software engineers', bonus: /\b(software|swe|sde|developer|programmer)\b/i, ask: /\b(software\s+engineer(?:s|ing)?|swes?|sdes?|software\s+developers?|programmers?|coders?)\b/i, match: /\b(software|engineer(?:ing)?|developer|swe|sde|programmer|devops|sre|full[- ]?stack|front[- ]?end|back[- ]?end|architect)\b/i },
  { label: 'engineers', ask: /\b(engineers?|engineering|developers?|devs)\b/i, match: /\b(engineer(?:ing)?|developer|swe|sde|programmer|devops|sre|architect)\b/i },
  { label: 'product managers', ask: /\b(product\s+(?:managers?|leads?|owners?|people|folks)|pms)\b/i, match: /\b(product\s+(?:manager|lead|owner|management|director)|head of product|vp,? product|cpo|pm)\b/i },
  { label: 'designers', ask: /\b(designers?|ux|ui\/ux)\b/i, match: /\b(design(?:er)?|ux|ui)\b/i },
  { label: 'data scientists', ask: /\b(data\s+(?:scientists?|science|engineers?|people|folks)|ml\s+engineers?|machine\s+learning\s+(?:engineers?|people)|analysts?)\b/i, match: /\b(data|machine learning|ml|analyst|analytics|scientist)\b/i },
  { label: 'founders', ask: /\b(co-?founders?|founders?|entrepreneurs?)\b/i, match: /\b(co-?founder|founder|founding)\b/i },
  { label: 'ceos', ask: /\b(ceos?|chief executives?)\b/i, match: /\b(ceo|chief executive)\b/i },
  { label: 'ctos', ask: /\b(ctos?|chief technology officers?)\b/i, match: /\b(cto|chief technology)\b/i },
  { label: 'cfos', ask: /\b(cfos?|chief financial officers?|finance leaders?)\b/i, match: /\b(cfo|chief financial|vp,? finance|head of finance)\b/i },
  { label: 'executives', ask: /\b(executives?|execs?|leadership|leaders|c-?suite|senior leaders?|vps?|directors?|heads? of)\b/i, match: /\b(ceo|cto|cfo|coo|cmo|cpo|chief|president|vp|vice president|svp|evp|head of|director|managing director|general manager|gm)\b/i },
  { label: 'investors', ask: /\b(investors?|vcs?|venture\s+capitalists?|angels?|angel\s+investors?|fund\s+managers?)\b/i, match: /\b(investor|investing|investments?|venture|vc|general partner|managing partner|principal|angel|fund)\b/i, alsoCompany: /\b(capital|ventures?|partners|vc|fund)\b/i },
  { label: 'recruiters', ask: /\b(recruiters?|recruiting|talent\s+(?:partners?|acquisition|people)|hiring\s+managers?)\b/i, match: /\b(recruit\w*|talent|sourcer|people ops|human resources|hr)\b/i },
  { label: 'marketing', ask: /\b(marketing|marketers?|growth\s+(?:people|leads?|marketers?)|brand\s+people)\b/i, match: /\b(marketing|marketer|growth|brand|cmo|communications|content)\b/i },
  { label: 'sales', ask: /\b(sales(?:people|\s+people)?|account\s+executives?|business\s+development|bizdev|bd\s+people)\b/i, match: /\b(sales|account executive|account manager|business development|bdr|sdr|partnerships|revenue)\b/i },
  { label: 'lawyers', ask: /\b(lawyers?|attorneys?|counsel|legal\s+(?:people|folks|team))\b/i, match: /\b(lawyer|attorney|counsel|legal|solicitor|barrister)\b/i },
  { label: 'consultants', ask: /\b(consultants?|consulting|advisors?|advisers?)\b/i, match: /\b(consultant|consulting|advisor|adviser)\b/i },
  { label: 'researchers', ask: /\b(researchers?|scientists?|professors?|phds?|academics?)\b/i, match: /\b(research\w*|scientist|professor|ph\.?d|postdoc|lecturer)\b/i },
  { label: 'doctors', ask: /\b(doctors?|physicians?|clinicians?|surgeons?|nurses?)\b/i, match: /\b(md|doctor|physician|surgeon|clinician|nurse)\b/i },
];

/** Industry / topic keywords: `ask` in the question, `terms` searched in titles and companies. */
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

const LOCATION_ALIASES = {
  sf: ['san francisco', 'sf', 'bay area'],
  'san francisco': ['san francisco', 'sf', 'bay area'],
  'bay area': ['san francisco', 'bay area', 'palo alto', 'oakland', 'san jose', 'mountain view', 'menlo park', 'berkeley'],
  nyc: ['new york', 'nyc', 'brooklyn', 'manhattan'],
  'new york': ['new york', 'nyc', 'brooklyn', 'manhattan'],
  la: ['los angeles', 'la'],
  'los angeles': ['los angeles', 'la'],
  uk: ['united kingdom', 'uk', 'london', 'england'],
  us: ['united states', 'usa', 'us'],
  usa: ['united states', 'usa', 'us'],
};

const STOPWORDS = new Set((
  'a an the of for about on in at to and or with from by is are was were be been what who whom which how when where why ' +
  'do does did i me my mine we our us you your know knows knew find show list give get tell any anyone anybody someone somebody ' +
  'people person persons folks contacts contact connections connection network friends friend everyone all some might could should would can ' +
  'work works working worked employed there that this these those have has had them they their please help me intro introduction introductions ' +
  'warm path paths reach into via through connect job jobs opportunities opportunity role roles industry sector space field ' +
  'currently now based located near around who\'s whos'
).split(/\s+/));

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term) => new RegExp(`(^|[^a-z0-9])${escapeRe(String(term).toLowerCase())}($|[^a-z0-9])`, 'i');
const cleanList = (list, max = 10) => {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

// ------------------------------------------------------------ parsing

/** Trim a captured company phrase: drop trailing clauses and filler. */
function cleanEntity(raw) {
  let s = String(raw || '').replace(/[?!.;:]+.*$/, '').trim();
  s = s.split(/\s+(?:in\s+my|in\s+the|from\s+my|who|that|which|whose|where|and\s+who|or|based|located|near|as|for|right\s+now|currently|in|with)\b/i)[0];
  s = s.replace(/^(?:the|a|an)\s+/i, '').replace(/[,'"“”]+$/g, '').replace(/^["“']+/, '').trim();
  s = s.replace(/'s$/i, '').trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return '';
  if (words.every((w) => STOPWORDS.has(w.toLowerCase()))) return '';
  if (/^(my|our|your)\b/i.test(s)) return '';
  return s.slice(0, 80);
}

const INTRO_PATTERNS = [
  /\b(?:warm\s+)?intro(?:duction)?s?(?:\s+paths?)?\s+(?:to|into|with|at|for)\s+(.+)$/i,
  /\bwho\s+(?:can|could|might)\s+(?:introduce|intro|connect|refer)\s+me\s+(?:to|with|into)\s+(.+)$/i,
  /\b(?:get|be)\s+(?:introduced|intro'?d|referred)\s+(?:to|into|at)\s+(.+)$/i,
  /\b(?:paths?|routes?)\s+(?:in)?to\s+(.+)$/i,
];

const COMPANY_PATTERNS = [
  /\b(?:works?|working|worked|employed|employees?|staff)\s+(?:at|for|with)\s+(.+)$/i,
  /\b(?:know|knows|people|anyone|anybody|someone|contacts?|connections?|folks|friends|engineers?|developers?|founders?|managers?|designers?|investors?|recruiters?|executives?|leaders?|team|sales|marketers?|employees?)\s+(?:at|@)\s+(.+)$/i,
  /\b(?:at|@)\s+(.+)$/i,
];

/** Rule-based question -> filters. */
export function parseQuestionRules(question) {
  const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const filters = { companies: [], roles: [], keywords: [], locations: [], intent: 'general' };
  if (!q) return filters;
  let rest = q;

  for (const re of INTRO_PATTERNS) {
    const m = q.match(re);
    const company = m && cleanEntity(m[1]);
    if (company) {
      filters.companies.push(company);
      filters.intent = 'intro-path';
      rest = rest.replace(m[0], ' ');
      break;
    }
  }
  if (filters.intent !== 'intro-path') {
    for (const re of COMPANY_PATTERNS) {
      const m = q.match(re);
      const company = m && cleanEntity(m[1]);
      const generic = company && company.split(' ').length === 1
        && [...KEYWORD_GROUPS, ...ROLE_GROUPS].some((g) => g.ask.test(company));
      if (company && !generic) {
        filters.companies.push(company);
        rest = rest.replace(new RegExp(`\\b(?:at|@|for|with)\\s+${escapeRe(company)}`, 'i'), ' ');
        break;
      }
    }
  }

  // Roles: a specific group wins over its generic parent ("software engineers" vs "engineers").
  const lower = rest.toLowerCase();
  for (const g of ROLE_GROUPS) {
    if (!g.ask.test(lower)) continue;
    if (g.label === 'engineers' && filters.roles.includes('software engineers')) continue;
    if (g.label === 'executives' && filters.roles.some((r) => ['ceos', 'ctos', 'cfos'].includes(r))) continue;
    filters.roles.push(g.label);
  }
  for (const g of KEYWORD_GROUPS) {
    if (g.ask.test(lower)) {
      // "ai" inside "data scientists" style role phrases is already covered by the role
      if (g.label === 'venture capital' && filters.roles.includes('investors')) continue;
      filters.keywords.push(g.label);
    }
  }

  // Locations: "in/based in/near <Capitalised Place>" or a known short form.
  const locRe = /\b(?:based\s+in|located\s+in|living\s+in|in|near|around)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}(?:,\s*[A-Z][A-Za-z.'-]*)?)/g;
  let lm;
  while ((lm = locRe.exec(rest))) {
    const place = lm[1].trim();
    const isKeyword = KEYWORD_GROUPS.some((g) => g.ask.test(place)) || ROLE_GROUPS.some((g) => g.ask.test(place));
    if (!isKeyword && !filters.companies.some((c) => c.toLowerCase() === place.toLowerCase())) filters.locations.push(place);
  }
  const shortLoc = lower.match(/\b(?:in|based in|near|around)\s+(sf|nyc|la|the bay area|bay area|new york|san francisco|los angeles|london|uk|usa|us)\b/);
  if (shortLoc) {
    const place = shortLoc[1].replace(/^the\s+/, '');
    if (!filters.locations.some((l) => l.toLowerCase() === place)) filters.locations.push(place);
  }

  if (filters.intent !== 'intro-path') {
    if (filters.companies.length) filters.intent = 'who-at';
    else if (filters.roles.length) filters.intent = 'role';
  }

  // Nothing recognised: fall back to the meaningful words as keywords.
  if (!filters.companies.length && !filters.roles.length && !filters.keywords.length && !filters.locations.length) {
    const words = rest.toLowerCase().replace(/[^a-z0-9&+.\- ]+/g, ' ').split(/\s+/)
      .map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ''))
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
    filters.keywords = cleanList(words, 6);
  }
  filters.companies = cleanList(filters.companies, 5);
  filters.roles = cleanList(filters.roles);
  filters.keywords = cleanList(filters.keywords);
  filters.locations = cleanList(filters.locations, 5);
  return filters;
}

/** Validate an LLM (or client) filter object into the canonical shape, or null. */
export function validateFilters(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const f = {
    companies: cleanList(obj.companies, 5),
    roles: cleanList(obj.roles),
    keywords: cleanList(obj.keywords),
    locations: cleanList(obj.locations, 5),
    intent: INTENTS.includes(obj.intent) ? obj.intent : null,
  };
  if (!f.intent) {
    if (f.companies.length) f.intent = 'who-at';
    else if (f.roles.length) f.intent = 'role';
    else f.intent = 'general';
  }
  if (f.intent === 'intro-path' && !f.companies.length) f.intent = 'general';
  if (!f.companies.length && !f.roles.length && !f.keywords.length && !f.locations.length) return null;
  return f;
}

function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const LLM_SYSTEM = `You turn a question about someone's professional network into search filters.
Return ONLY a JSON object: {"companies": [], "roles": [], "keywords": [], "locations": [], "intent": "who-at" | "role" | "intro-path" | "general"}.
companies: organisation names mentioned. roles: job roles (e.g. "software engineers", "investors", "founders").
keywords: industries or topics (e.g. "fintech", "ai"). locations: places. intent: "intro-path" when asking for an introduction or path to a company,
"who-at" when asking who works at a company, "role" when asking for a kind of person, otherwise "general". Use [] when absent. No commentary.`;

/** Ask the configured LLM for filters. Sends only the question text. */
export async function parseQuestionWithLlm(question, { complete = chatComplete } = {}) {
  try {
    const result = await complete([
      { role: 'system', content: LLM_SYSTEM },
      { role: 'user', content: String(question).slice(0, 500) },
    ], { maxTokens: 300, temperature: 0, timeoutMs: 12000 });
    if (!result?.text) return null;
    return validateFilters(extractJson(result.text));
  } catch {
    return null;
  }
}

/**
 * Question -> { filters, parsedBy }. Rules first; the LLM (when configured
 * and allowed) is only consulted when the rules recognised nothing specific.
 */
export async function parseQuestion(question, { useLlm = true, complete } = {}) {
  const rules = parseQuestionRules(question);
  const specific = rules.companies.length || rules.roles.length || rules.locations.length
    || rules.keywords.some((k) => KEYWORD_GROUPS.some((g) => g.label === k));
  if (specific || !useLlm || String(question || '').trim().split(/\s+/).length < 2) {
    return { filters: rules, parsedBy: 'rules' };
  }
  const llm = await parseQuestionWithLlm(question, complete ? { complete } : undefined);
  if (llm) return { filters: llm, parsedBy: 'llm' };
  return { filters: rules, parsedBy: 'rules' };
}

// ------------------------------------------------------------ scoring

/** Company relation including a looser "same first word" rule for search. */
export function companyRelation(contactKey, targetKey) {
  const strict = companyMatch(contactKey, targetKey);
  if (strict) return strict;
  if (!contactKey || !targetKey) return null;
  const a = contactKey.split(' ');
  const b = targetKey.split(' ');
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 1 && short[0].length >= 3 && long[0] === short[0]) return 'related';
  return null;
}

const roleGroupFor = (label) => {
  const l = String(label).toLowerCase();
  return ROLE_GROUPS.find((g) => g.label === l) || ROLE_GROUPS.find((g) => g.ask.test(l)) || null;
};
const keywordGroupFor = (label) => {
  const l = String(label).toLowerCase();
  return KEYWORD_GROUPS.find((g) => g.label === l) || KEYWORD_GROUPS.find((g) => g.ask.test(l)) || null;
};

const publicContact = (c) => ({
  key: dedupeKey(c),
  name: c.name,
  company: c.company || '',
  position: c.position || '',
  location: c.location || '',
  profileUrl: c.profileUrl || '',
  connectedOn: c.connectedOn || null,
  source: c.source,
});

/**
 * Score every contact against the filters. All given categories must match
 * (company AND role AND location); keywords match if any one does.
 * Returns { results: [{ contact, score, reasons }], total, notes }.
 */
export function scoreContacts(contacts, filters, { limit = MAX_RESULTS } = {}) {
  const f = {
    companies: filters?.companies || [], roles: filters?.roles || [],
    keywords: filters?.keywords || [], locations: filters?.locations || [],
  };
  const targets = f.companies.map((name) => ({ name, key: normalizeCompanyKey(name), re: wordRe(name) })).filter((t) => t.key);
  const roles = f.roles.map((label) => {
    const g = roleGroupFor(label);
    return g ? { label: g.label, match: g.match, alsoCompany: g.alsoCompany, bonus: g.bonus } : { label, match: wordRe(label.replace(/s$/i, '')) };
  });
  const keywords = f.keywords.map((label) => {
    const g = keywordGroupFor(label);
    return g ? { label: g.label, res: g.terms.map((t) => ({ term: t, re: wordRe(t) })) } : { label, res: [{ term: label, re: wordRe(label) }] };
  });
  const locations = f.locations.map((place) => {
    const aliases = LOCATION_ALIASES[place.toLowerCase()] || [place];
    return { place, res: aliases.map((a) => wordRe(a)) };
  });

  const notes = [];
  const list = Array.isArray(contacts) ? contacts : [];
  if (locations.length && !list.some((c) => c.location)) {
    notes.push('None of your contacts have a location (LinkedIn\'s Connections export does not include one), so location filters cannot match.');
  }
  if (!targets.length && !roles.length && !keywords.length && !locations.length) {
    return { results: [], total: 0, notes: ['Ask about a company, a role, an industry or a place, e.g. "Who do I know at Stripe?"'] };
  }

  const scored = [];
  for (const c of list) {
    const reasons = [];
    let score = 0;
    const companyKey = normalizeCompanyKey(c.company);
    const position = String(c.position || '');
    const tagText = (c.tags || []).join(' ');

    if (targets.length) {
      let best = null;
      for (const t of targets) {
        const rel = companyRelation(companyKey, t.key);
        if (rel === 'exact') { best = { pts: 100, reason: `Works at ${c.company}` }; break; }
        if ((rel === 'contains' || rel === 'within') && (!best || best.pts < 80)) best = { pts: 80, reason: `Works at ${c.company} (matches ${t.name})` };
        else if (rel === 'related' && (!best || best.pts < 60)) best = { pts: 60, reason: `Company "${c.company}" looks related to ${t.name}` };
        else if (!rel && position && t.re.test(position) && (!best || best.pts < 35)) best = { pts: 35, reason: `Title mentions ${t.name}: "${position.slice(0, 80)}"` };
      }
      if (!best) continue;
      score += best.pts;
      reasons.push(best.reason);
    }

    if (roles.length) {
      const hits = roles.filter((r) => r.match.test(position) || (r.alsoCompany && r.alsoCompany.test(c.company || '')));
      if (!hits.length) continue;
      for (const r of hits) {
        score += 40 + (r.bonus && r.bonus.test(position) ? 10 : 0);
        reasons.push(position ? `Title "${position.slice(0, 80)}" matches ${r.label}` : `Company "${c.company}" matches ${r.label}`);
      }
    }

    if (keywords.length) {
      const text = `${position} ${c.company || ''} ${tagText}`;
      const hits = [];
      for (const k of keywords) {
        const term = k.res.find((x) => x.re.test(text));
        if (term) hits.push({ label: k.label, term: term.term });
      }
      if (!hits.length) continue;
      for (const h of hits.slice(0, 3)) {
        score += 15;
        reasons.push(h.label === h.term ? `Mentions ${h.label}` : `Mentions ${h.label} ("${h.term}")`);
      }
    }

    if (locations.length) {
      const loc = String(c.location || '');
      const hit = loc && locations.find((l) => l.res.some((re) => re.test(loc)));
      if (!hit) continue;
      score += 20;
      reasons.push(`Located in ${loc}`);
    }

    scored.push({ contact: publicContact(c), score, reasons });
  }

  scored.sort((a, b) => b.score - a.score
    || String(b.contact.connectedOn || '').localeCompare(String(a.contact.connectedOn || ''))
    || a.contact.name.localeCompare(b.contact.name));
  return { results: scored.slice(0, limit), total: scored.length, notes };
}

// ------------------------------------------------------------ intro paths

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Investors named in a company profile (investors + round leads), deduped. */
export function investorsFromProfile(profile) {
  const out = [];
  const add = (name, evidence) => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = normalizeCompanyKey(clean);
    if (!key || out.some((i) => i.key === key)) return;
    out.push({ name: clean, key, evidence });
  };
  for (const inv of profile?.investors || []) add(inv?.name, inv?.evidence || 'investor');
  for (const round of profile?.fundingRounds || []) {
    for (const lead of round?.leadInvestors || []) add(lead, `led ${round.round || 'a round'}`);
  }
  return out.slice(0, 40);
}

/**
 * Who could introduce the user to `target`?
 *  direct:        contacts at the company itself
 *  viaInvestors:  contacts at the company's investors (from public sources), grouped by investor
 *  viaPastEmployees: [] (the exports carry no employment history)
 */
export async function introPaths(contacts, target, { profileLoader = buildCompanyProfile, timeoutMs = 25000 } = {}) {
  const company = String(target || '').trim().slice(0, 120);
  const direct = scoreContacts(contacts, { companies: [company] }).results;
  const notes = [];
  let investors = [];
  let profileStatus = 'ok';
  try {
    const profile = await withTimeout(Promise.resolve(profileLoader(company)), timeoutMs);
    investors = investorsFromProfile(profile);
    if (!investors.length) notes.push(`No investors for ${company} were found in public sources, so investor paths could not be checked.`);
  } catch (error) {
    profileStatus = 'unavailable';
    notes.push(`Could not load ${company}'s investors right now (${error.message}); showing direct contacts only.`);
  }

  const list = Array.isArray(contacts) ? contacts : [];
  const keyed = list.map((c) => ({ c, key: normalizeCompanyKey(c.company) })).filter((x) => x.key);
  const viaInvestors = [];
  for (const inv of investors) {
    const people = [];
    for (const { c, key } of keyed) {
      const rel = companyRelation(key, inv.key);
      if (!rel) continue;
      people.push({
        contact: publicContact(c),
        score: rel === 'exact' ? 100 : rel === 'related' ? 60 : 80,
        reasons: [`Works at ${c.company}, an investor in ${company} (${inv.evidence})`],
      });
    }
    if (people.length) {
      people.sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name));
      viaInvestors.push({ investor: inv.name, evidence: inv.evidence, contacts: people.slice(0, 50), total: people.length });
    }
  }
  viaInvestors.sort((a, b) => b.total - a.total);
  notes.push('Past employees cannot be identified: the imported data has no employment history.');
  return {
    target: company,
    direct,
    viaInvestors,
    investorsChecked: investors.map((i) => i.name),
    viaPastEmployees: [],
    profileStatus,
    notes,
  };
}

/** Full pipeline used by the API route. */
export async function answerQuestion(contacts, { question, target, useLlm = true, profileLoader, complete } = {}) {
  const parsed = target
    ? { filters: { companies: [String(target).trim().slice(0, 120)], roles: [], keywords: [], locations: [], intent: 'intro-path' }, parsedBy: 'target' }
    : await parseQuestion(question, { useLlm, complete });
  const { filters } = parsed;
  const response = {
    question: String(question || '').slice(0, 500),
    filters,
    parsedBy: parsed.parsedBy,
    intent: filters.intent,
    contactCount: Array.isArray(contacts) ? contacts.length : 0,
  };
  if (filters.intent === 'intro-path' && filters.companies[0]) {
    const intro = await introPaths(contacts, filters.companies[0], profileLoader ? { profileLoader } : undefined);
    return { ...response, results: intro.direct, total: intro.direct.length, intro, notes: intro.notes };
  }
  const { results, total, notes } = scoreContacts(contacts, filters);
  return { ...response, results, total, notes };
}
