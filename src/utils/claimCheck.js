/**
 * Claim checking across sources (no AI model needed).
 *
 * Extracts funding and valuation figures from each source's text, groups
 * them by claim (e.g. "Series D amount", "valuation"), and reports whether
 * independent sources agree:
 *   corroborated  - 2+ different sites report the same figure (within 5%)
 *   single-source - only one site reports it
 *   conflict      - sites report different figures for the same claim
 * Every claim keeps the quoted sentence and the 1-based source numbers.
 */

const CURRENCY = { '$': 'USD', 'US$': 'USD', '€': 'EUR', '£': 'GBP', 'USD': 'USD', 'EUR': 'EUR', 'GBP': 'GBP' };
const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };

const MONEY_RE = /(US\$|\$|€|£|USD|EUR|GBP)\s?(\d+(?:[.,]\d+)?)\s?(k|m|mm|mn|b|bn|t|thousand|million|billion|trillion)\b/gi;
const ROUND_RE = /\b(pre-seed|seed|series [a-h]|growth round|bridge round)\b/i;
const VALUATION_RE = /\b(valuation|valued at|values (?:it|the company)|post-money|pre-money)\b/i;
const FUNDING_RE = /\b(rais(?:e|es|ed|ing)|funding|round|investment|secures?|closes?)\b/i;

function sentencesOf(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((s) => s.length > 15);
}

function parseMoney(match) {
  const currency = CURRENCY[match[1].toUpperCase()] || CURRENCY[match[1]] || 'USD';
  const amount = parseFloat(match[2].replace(',', '.')) * (SCALE[match[3].toLowerCase()] || 1);
  return { currency, amount };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url || '');
  }
}

export function formatAmount({ amount, currency }) {
  const symbol = { USD: '$', EUR: '€', GBP: '£' }[currency] || `${currency} `;
  if (amount >= 1e12) return `${symbol}${+(amount / 1e12).toFixed(2)}T`;
  if (amount >= 1e9) return `${symbol}${+(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `${symbol}${+(amount / 1e6).toFixed(1)}M`;
  if (amount >= 1e3) return `${symbol}${+(amount / 1e3).toFixed(0)}K`;
  return `${symbol}${amount}`;
}

// "valuation" right after the amount ("at a $1.25 trillion valuation",
// "$2B post-money") or right before it ("valued at $2B", "valuing it at $2B")
const VALUATION_AFTER_RE = /^\s*(?:valuation|post-money|pre-money|value\b|worth\b)/i;
const VALUATION_BEFORE_RE = /\b(valuation(?: of)?|valued(?: it| the company)? at|values (?:it|the company) at|valuing (?:it|the company) at|post-money(?: valuation)?(?: of)?|pre-money(?: valuation)?(?: of)?)\s*(?:of\s*)?$/i;
// "a $750m Series F in June at $44bn", "closed its round at $5B": "at" after a
// round word names the valuation even without the word itself.
const ROUND_AT_RE = /\b(round|series [a-h]|financing|funding|raise)\b[^$€£]{0,30}\bat\s*(?:an?\s*)?$/i;

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const MONTH_YEAR_RE = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(20\\d\\d)\\b`, 'i');
const YEAR_ONLY_RE = /\b(20\d\d)\b/;

const MONTH_ONLY_RE = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\b(?!\\s+20\\d\\d)`, 'i');
const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monKey = (m) => m.slice(0, 3).toLowerCase();

/** Publication month of a result: { label: "2026-oct", key: 24322 } or null. */
function publicationDate(result) {
  const t = Date.parse(result.publishedAt || result.date || result.timestamp || '');
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const month = d.getUTCMonth() + 1;
  return { label: `${d.getUTCFullYear()}-${Object.keys(MONTH_INDEX)[month - 1]}`, key: d.getUTCFullYear() * 12 + month, year: d.getUTCFullYear() };
}

/**
 * The date the sentence itself gives for the figure: "October 2026",
 * "in June" (year taken from the publication), or "2026". Recap sentences
 * ("after a $750m Series F in June") are dated by what they say, not by
 * when the article was published.
 */
function sentenceDate(sentence, pub) {
  const my = sentence.match(MONTH_YEAR_RE);
  if (my) return { label: `${my[2]}-${monKey(my[1])}`, key: Number(my[2]) * 12 + MONTH_INDEX[monKey(my[1])] };
  const m = sentence.match(MONTH_ONLY_RE);
  const y = sentence.match(YEAR_ONLY_RE);
  if (m) {
    const year = y ? Number(y[1]) : pub?.year;
    if (year) return { label: `${year}-${monKey(m[1])}`, key: year * 12 + MONTH_INDEX[monKey(m[1])] };
  }
  if (y) return { label: y[1], key: Number(y[1]) * 12 };
  return null;
}

/** "Nov 2026" from the sentence, else the publication month, else null (display). */
function roundDate(sentence, result) {
  const pub = publicationDate(result);
  return (sentenceDate(sentence, pub) || pub || {}).label || null;
}

// "after a $750m Series F in June", "up from $44bn": an earlier figure the
// sentence mentions for context, not the figure it reports.
const TOTAL_RE = /\b(in total|total (?:funding|raised|capital)|to date|so far|cumulative(?:ly)?|lifetime|all told|altogether|overall)\b/i;
// A sentence often reports one figure and recaps another: "raises $11B at a
// $1.25T valuation, up from $852B in March" or "raised $1.85B, bringing the
// total to $5B". Each figure is dated and judged by its own clause.
const CLAUSE_BOUNDARY_RE = /\s*\(|\)|;|,\s*(?=(?:up|down)\s+from\b)|\s+(?=(?:after|following|previously|compared|while|whereas|versus|bringing|taking|which brings|which takes)\b)|,\s+(?=(?:which|bringing|taking|up|down)\b)/gi;
function clauseAt(sentence, index) {
  let start = 0;
  let end = sentence.length;
  for (const m of sentence.matchAll(CLAUSE_BOUNDARY_RE)) {
    if (m.index < index) start = m.index + m[0].length;
    else if (m.index >= index) { end = m.index; break; }
  }
  return { text: sentence.slice(start, end), start };
}

const PRIOR_RE = /\b(previous(?:ly)?|prior|earlier|last(?:\s+[\w-]+)?\s+(?:round|year|fundrais\w*|financing)|up from|after (?:a|an|its|the|[A-Z][\w'’]+(?:['’]s)?)|following (?:a|an|its|the)|from (?:a|an|its)|compared (?:with|to)|was valued|had raised|previously valued|(?:a|two|three|\d+)\s+(?:years?|months?)\s+ago|(?:a|one|two|\d+)\s+years?\s+(?:to the day\s+)?after)\b[^$€£]{0,40}$/i;
// "...its €11.7 billion valuation from its last fundraising round a year ago"
const PRIOR_AFTER_RE = /^[^.$€£]{0,60}?\b(last(?:\s+[\w-]+)?\s+(?:round|year|fundrais\w*|financing)|(?:a|two|three|\d+)\s+(?:years?|months?)\s+ago|previous(?:ly)?|prior|earlier|at the time)\b/i;
// Undated web results: "in a new funding round", "the latest round", "said on
// Thursday" mark current news, so the figure is treated as this month's.
const CURRENT_NEWS_RE = /\b(new (?:funding )?round|latest (?:funding )?round|latest financing|just raised|today|this week|yesterday|on (?:monday|tuesday|wednesday|thursday|friday)|announced (?:today|on)|has raised|said it (?:had )?raised)\b/i;
const NOW_KEY = new Date().getUTCFullYear() * 12 + new Date().getUTCMonth() + 1;

/** Extract figure claims from one result. */
// A results page is about the company, but single sentences in it may not
// be: "Europe-based startups raised $24 billion in the quarter". With the
// company name known, a sentence must name it or use a generic subject
// ("the company", "it"), and market statistics are skipped.
const GENERIC_SUBJECT_RE = /\b(the (?:company|startup|firm|outfit|business|lab|group|maker|developer)|it|its|they|their)\b/i;
const MARKET_STATS_RE = /\b(startups|companies|firms|deals|rounds|sector|industry|quarter|Q[1-4]\s*20\d\d|region|europe-based|european|global|across the|in total across|the market)\b/i;
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function entityMentionTest(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean).map(escapeRe);
  if (!words.length) return null;
  const re = new RegExp(`(?:^|[^A-Za-z0-9])(?:${words.join('\\s+')}|${words.join('')})(?=$|[^A-Za-z0-9])`, 'i');
  return (text) => re.test(String(text || ''));
}

export function extractClaims(result, sourceNumber, { mentions = null } = {}) {
  const claims = [];
  // Table cells and elisions in snippets are separate statements
  const text = `${result.title || ''}. ${result.content || result.snippet || ''}`.replace(/\s*\|\s*|\[\.\.\.\]|\[…\]|\s+·\s+/g, '. ');
  for (const sentence of sentencesOf(text)) {
    if (mentions && !mentions(sentence)) {
      if (MARKET_STATS_RE.test(sentence) || !GENERIC_SUBJECT_RE.test(sentence)) continue;
    }
    const monies = [...sentence.matchAll(MONEY_RE)];
    if (monies.length === 0) continue;
    const round = (sentence.match(ROUND_RE) || [])[1];
    const isValuation = VALUATION_RE.test(sentence) || ROUND_AT_RE.test(sentence.slice(0, monies[monies.length - 1].index));
    const isFunding = FUNDING_RE.test(sentence) || Boolean(round);
    // "after a $750m Series F in June at $44bn": everything in the clause is an earlier figure
    const priorClause = PRIOR_RE.test(sentence.slice(0, monies[0].index)) && !CLAUSE_BOUNDARY_RE.test(sentence.slice(0, monies[0].index));
    CLAUSE_BOUNDARY_RE.lastIndex = 0;
    let prevKind = null;
    let priorCarry = false;
    // In a sentence that talks about a valuation, the largest figure is the
    // valuation ("could raise $30B at a $1.4 trillion valuation, up from $500B").
    const parsed = monies.map(parseMoney);
    const largest = Math.max(...parsed.map((x) => x.amount || 0));
    monies.forEach((m, idx) => {
      const money = parsed[idx];
      // Look at the words between this amount and its neighbours only, so
      // "$11 billion at a $1.25 trillion valuation" reads the valuation word
      // for the second amount, not the first.
      const prevEnd = idx > 0 ? monies[idx - 1].index + monies[idx - 1][0].length : 0;
      const nextStart = idx + 1 < monies.length ? monies[idx + 1].index : sentence.length;
      const before = sentence.slice(Math.max(prevEnd, m.index - 60), m.index);
      const after = sentence.slice(m.index + m[0].length, Math.min(nextStart, m.index + m[0].length + 40));
      const valuationHere = VALUATION_BEFORE_RE.test(before) || VALUATION_AFTER_RE.test(after) || ROUND_AT_RE.test(before);
      const largestOfSeveral = isValuation && monies.length > 1 && money.amount === largest;
      // In a valuation sentence a smaller figure is a raise only when a raise
      // verb sits right before it ("raise as much as $30B"); "up from $500B"
      // is a prior valuation and is left out.
      const raiseNear = /\b(rais\w*|secur\w*|clos\w*|land\w*|bag\w*|nab\w*|invest\w*|funding|round|financing)\b/i.test(before);
      const clause = clauseAt(sentence, m.index);
      let kind = null;
      if (valuationHere || largestOfSeveral || (isValuation && !isFunding)) kind = 'valuation';
      else if (isFunding && (!isValuation || raiseNear)) kind = 'raise';
      // "has raised $122B in total", "to date": a running total, not a round
      // "up from $852 billion in March": the same kind of figure as the one before it
      if (!kind && prevKind && /^\s*(?:up|down) from\b/i.test(clause.text)) kind = prevKind;
      prevKind = kind || prevKind;
      if (!kind) return;
      const pub = publicationDate(result);
      const said = sentenceDate(clause.text, pub) || null;
      const clauseBefore = sentence.slice(clause.start, m.index);
      const total = kind === 'raise' && TOTAL_RE.test(clause.text);
      // A clause that merely continues an earlier-figure clause ("..., which
      // valued the company at $13.7 billion") is earlier too.
      const ownPrior = priorClause || PRIOR_RE.test(before) || PRIOR_AFTER_RE.test(sentence.slice(m.index + m[0].length))
        || /^\s*(?:after|following|previously|compared|up from|down from)\b/i.test(clause.text)
        || /\b(previous(?:ly)?|prior|earlier|last (?:round|year))\b/i.test(clauseBefore);
      const continuation = /^\s*(?:which|that|valuing|valued|at|and|where)\b/i.test(clause.text);
      const isPrior = ownPrior || (priorCarry && continuation);
      priorCarry = isPrior;
      claims.push({
        key: kind === 'valuation' ? 'valuation' : `raise:${(round || 'unspecified').toLowerCase()}`,
        label: kind === 'valuation' ? 'Valuation' : `${round ? round.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Funding'} amount`,
        ...money,
        quote: sentence.trim(),
        source: sourceNumber,
        site: hostOf(result.url || result.link),
        when: (said || pub || {}).label || null,
        whenSentence: said ? said.label : null,
        whenPub: pub ? pub.label : null,
        whenKey: (said || pub || {}).key || 0,
        whenSentenceKey: said ? said.key : 0,
        whenPubKey: pub ? pub.key : 0,
        prior: isPrior,
        current: !said && CURRENT_NEWS_RE.test(clause.text),
        total,
        namedRound: Boolean(round),
      });
    });
  }
  return claims;
}

/**
 * @param {Array} results search results in display order (source n = index+1)
 * @returns {{ claims: Array, summary: { corroborated, singleSource, conflicts } }}
 */
// "in talks to raise $30B", "could raise up to $40B": a target, not a figure
// that was raised. Confirmed figures outrank targets when choosing the
// headline value, and a target never counts as a disagreement with a raise.
const SPECULATIVE_RE = /\b(in talks|talks to|seeks?|seeking|sought|plans? to|planning|could|may|might|reportedly (?:looking|seeking|planning|aiming)|looking to|aims?|aiming|targets?|targeting|would|considering|exploring|hopes?|wants?|expected to|set to|as much as|up to|potential(?:ly)?|proposed|rumou?red)\b/i;
export function isSpeculativeClaim(quote) {
  return SPECULATIVE_RE.test(String(quote || ''));
}

export function checkClaims(results = [], { entity = null } = {}) {
  const mentions = entityMentionTest(entity);
  const all = results.flatMap((r, i) => extractClaims(r, i + 1, { mentions }));
  // A raise with no round named ("Mistral raises €3B") that matches the
  // amount of a named round ("€3 billion in a Series D") is the same claim.
  const named = all.filter((c) => c.key.startsWith('raise:') && c.key !== 'raise:unspecified');
  for (const c of all) {
    if (c.key !== 'raise:unspecified') continue;
    const match = named.find((n) => n.currency === c.currency && Math.abs(n.amount - c.amount) / Math.max(n.amount, c.amount) <= 0.05);
    if (match) { c.key = match.key; c.label = match.label; c.namedRound = true; }
  }
  const groups = new Map();
  for (const c of all) {
    // Different currencies are different claims (no FX guessing)
    const key = `${c.key}|${c.currency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const claims = [];
  for (const items of groups.values()) {
    // Cluster figures that agree within 5%
    const clusters = [];
    for (const c of items) {
      const hit = clusters.find((cl) => Math.abs(cl.amount - c.amount) / Math.max(cl.amount, c.amount) <= 0.05);
      if (hit) hit.items.push(c);
      else clusters.push({ amount: c.amount, items: [c] });
    }
    const definite = (cl) => cl.items.filter((i) => !isSpeculativeClaim(i.quote) && !i.prior && !i.total);
    const siteCount = (list) => new Set(list.map((i) => i.site)).size;
    // A cluster's age follows the same rule as its dates: what the sentences
    // say, and only when none says anything, when the articles were published.
    // A figure is dated by what any sentence says about it ("a $750m Series F
    // in June"); only when no sentence names a date do publication months
    // stand in, and then only from the items that report the figure, not
    // from later recaps ("four months after raising $750M").
    const reporting = (cl) => (definite(cl).length ? definite(cl) : cl.items);
    const newest = (cl) => {
      const said = cl.items.map((i) => i.whenSentenceKey || 0).filter(Boolean);
      if (said.length) return Math.max(...said);
      const pub = reporting(cl).map((i) => i.whenPubKey || 0).filter(Boolean);
      if (pub.length) return Math.max(...pub);
      return reporting(cl).some((i) => i.current) ? NOW_KEY : 0;
    };
    const isTarget = (cl) => cl.items.every((i) => isSpeculativeClaim(i.quote));
    const isTotal = (cl) => cl.items.every((i) => i.total);
    const isPrior = (cl) => !isTarget(cl) && !isTotal(cl) && definite(cl).length === 0;
    // The headline figure is the newest confirmed figure that at least two
    // independent sites report; otherwise the most-reported confirmed one.
    // Targets and figures only mentioned as "earlier" never lead.
    const confirmed = clusters.filter((cl) => definite(cl).length > 0);
    const corroboratedNewest = confirmed.filter((cl) => siteCount(definite(cl)) >= 2).sort((a, b) => newest(b) - newest(a) || siteCount(definite(b)) - siteCount(definite(a)))[0];
    const mostCited = [...confirmed].sort((a, b) => siteCount(definite(b)) - siteCount(definite(a)) || newest(b) - newest(a))[0];
    // A group with no confirmed figure is context, not a claim: earlier
    // figures and running totals are dropped; a target is shown as one.
    if (!confirmed.length && !clusters.some(isTarget)) continue;
    const top = corroboratedNewest || mostCited || [...clusters].sort((a, b) => siteCount(b.items) - siteCount(a.items))[0];
    clusters.sort((a, b) => (a === top ? -1 : b === top ? 1 : 0) || newest(b) - newest(a));
    const sites = new Set(top.items.map((i) => i.site));
    // Two figures are a conflict only when they describe the same round: the
    // same named round, or the same month/year. Otherwise they are most
    // likely different rounds ("raised $6.6B in 2024", "raises $11B") and
    // are listed as different figures, not a disagreement.
    // A cluster is dated by what its sentences say; only when none of them
    // names a date does the publication month stand in.
    // A bare year ("in 2026") is too coarse to say two figures are the same round.
    const dates = (cl) => {
      const said = new Set(cl.items.map((i) => i.whenSentence).filter((d) => d && d.includes('-')));
      return said.size ? said : new Set(reporting(cl).map((i) => i.whenPub).filter(Boolean));
    };
    const sameRound = (a, b) => (a.items[0].namedRound && b.items[0].namedRound && a.items[0].key === b.items[0].key)
      || [...dates(a)].some((d) => dates(b).has(d));
    // Two figures for one round that differ 10x are a misread of one of them
    // (a valuation taken for a raise), not a disagreement between sources.
    const plausible = (a, b) => Math.max(a.amount, b.amount) / Math.max(1, Math.min(a.amount, b.amount)) < 10;
    const conflicting = clusters.slice(1).filter((cl) => sameRound(top, cl) && plausible(top, cl) && !isTarget(cl) && !isPrior(cl) && !isTotal(cl) && !isTarget(top));
    const status = isTarget(top) ? 'target' : conflicting.length > 0 ? 'conflict' : sites.size >= 2 ? 'corroborated' : 'single-source';
    const alternatives = clusters.slice(1).map((cl) => ({
      value: formatAmount({ amount: cl.amount, currency: items[0].currency }),
      sources: [...new Set(cl.items.map((i) => i.source))],
      quote: cl.items[0].quote,
      sameRound: sameRound(top, cl),
      speculative: isTarget(cl),
      prior: isPrior(cl),
      total: isTotal(cl),
      when: [...dates(cl)][0] || null,
    }));
    claims.push({
      label: items[0].label,
      value: formatAmount({ amount: top.amount, currency: items[0].currency }),
      status,
      sources: [...new Set(top.items.map((i) => i.source))],
      quote: top.items[0].quote,
      alternatives,
      ...(status !== 'conflict' && alternatives.length ? { note: 'different figures reported' } : {}),
    });
  }

  // Attach readable references (title + link) for each cited source number
  const ref = (n) => {
    const r = results[n - 1] || {};
    return { n, title: r.title || hostOf(r.url || r.link), url: r.url || r.link || null, site: hostOf(r.url || r.link) };
  };
  for (const claim of claims) {
    claim.sourceRefs = claim.sources.map(ref);
    claim.alternatives.forEach((alt) => { alt.sourceRefs = alt.sources.map(ref); });
  }

  const order = { conflict: 0, corroborated: 1, 'single-source': 2, target: 3 };
  claims.sort((a, b) => order[a.status] - order[b.status]);
  return {
    claims,
    summary: {
      corroborated: claims.filter((c) => c.status === 'corroborated').length,
      singleSource: claims.filter((c) => c.status === 'single-source').length,
      conflicts: claims.filter((c) => c.status === 'conflict').length,
    },
  };
}
