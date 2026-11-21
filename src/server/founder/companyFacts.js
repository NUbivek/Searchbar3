/**
 * What the records say about the person's company: its legal names and
 * domains, the year it was founded, its funding rounds and investors, and
 * where it stands (valuation, headcount, customers, revenue). Read in code,
 * with no model, from records tied to the person (confirmed or likely) or to
 * the company (graded 'company'); never from a record matched by name only.
 *
 * A company typed as one ordinary word ("Ramp", "Merge") is searched far
 * better under its legal name ("Ramp Business Corp"), so a legal name found
 * in a record tied by more than the bare word (an SEC filing naming the person
 * as officer, a register entry naming them, the company site's own footer) is
 * offered to identity.js (learnCompanyNames) and the loop asks the registers
 * again under it. A sentence that names only the bare ordinary word in a
 * record tied to nothing is never read as the company's.
 *
 * Every line keeps the ids of the records that state it, and a number is never
 * cut: a sentence too long to show whole is shortened only between words.
 */
import { companyMention, companyKeyStrict, isOrdinaryWordCompany } from './names';
import { addCompanyAlias } from './identity';
import { privacyReason } from './guardrails';

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TIED = new Set(['confirmed', 'likely']);
const REGISTERS = new Set(['uk-companies-house', 'fr-companies', 'us-state-registries', 'lei-register']);
const THIS_YEAR = new Date().getUTCFullYear();
const yearOf = (y) => { const n = Number(String(y || '').slice(0, 4)); return Number.isInteger(n) && n >= 1900 && n <= THIS_YEAR + 1 ? n : null; };

/** Sentences of a record (search snippets also split on " | " and " · "). */
function sentences(text) {
  return String(text || '')
    .replace(/\b(Inc|Corp|Co|Ltd|St|Jr|Sr|vs|U\.S|Mr|Mrs|Ms|Dr)\./g, '$1\u0001')
    .split(/(?<=[.!?])\s+(?=["“'(]?[A-Z0-9$])|\n+|\s+[·|]\s+/)
    .map((s) => tidy(s.replace(/\u0001/g, '.')))
    .filter((s) => s.length >= 12);
}

/**
 * Shorten a sentence to about `max` characters around position `at` without cutting a word or a number:
 * "$1,850,000,000" stays whole, and "…" marks what was left out.
 */
export function clipAround(text, at = 0, max = 280) {
  const t = tidy(text);
  if (t.length <= max) return t;
  let from = Math.max(0, Math.min(at - Math.floor(max / 3), t.length - max));
  let to = Math.min(t.length, from + max);
  // move both ends out to whitespace, so neither falls inside a word or a figure
  while (from > 0 && !/\s/.test(t[from - 1])) from -= 1;
  while (to < t.length && !/\s/.test(t[to])) to += 1;
  return `${from > 0 ? '…' : ''}${t.slice(from, to).trim()}${to < t.length ? '…' : ''}`;
}

/** Does `name` begin with the company's own name ("Ramp Business Corp" for Ramp, "Nikola Corp" for Nikola)? */
export function startsWithCompany(name, company) {
  const a = companyKeyStrict(name);
  const b = companyKeyStrict(company);
  return Boolean(a && b) && (a === b || a.startsWith(`${b} `));
}

const LEGAL_TAIL = /(?:,?\s+(?:Inc\.?|Incorporated|LLC|L\.L\.C\.|Ltd\.?|Limited|Corp\.?|Corporation|Co\.|GmbH|AG|PBC|P\.B\.C\.|plc|PLC|LLP|L\.P\.|Pty\.? Ltd\.?|B\.V\.|N\.V\.|S\.A\.S?\.?|SAS))+$/;
const titleCaseIfShouting = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Llc|Ltd|Inc|Plc|Uk|Us|Usa)\b/g, (m) => (m.length <= 3 ? m.toUpperCase() : m)) : s);

/**
 * The names and domains known for the company, each with the records that give them.
 * @returns {{ legalNames: Array<{ name, ids }>, domains: Array<{ domain, ids }> }}
 */
export function companyNames(subject, findings = [], threads = []) {
  const company = tidy(subject?.company);
  const names = new Map();
  const domains = new Map();
  if (!company) return { legalNames: [], domains: [] };
  const addName = (raw, id) => {
    const name = tidy(String(raw || '').replace(/[.,;:]+$/, (m) => (/\.$/.test(m) && LEGAL_TAIL.test(raw) ? '.' : '')));
    if (name.length < 3 || name.length > 90 || !startsWithCompany(name, company) || subject.hasName?.(name)) return;
    const key = companyKeyStrict(name) + (LEGAL_TAIL.test(name) ? '|legal' : '');
    if (!names.has(key)) names.set(key, { name: titleCaseIfShouting(name), ids: new Set() });
    if (id) names.get(key).ids.add(id);
  };
  const addDomain = (raw, id) => {
    const d = String(raw || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(d) || !/\.[a-z]{2,}$/.test(d)) return;
    if (!domains.has(d)) domains.set(d, { domain: d, ids: new Set() });
    if (id) domains.get(d).ids.add(id);
  };
  const ids = new Set((findings || []).map((f) => f.id));
  // what the check already learned (identity.js anchors), with the record that taught it
  for (const a of subject?.anchors?.aliases?.values?.() || []) {
    const origin = ids.has(a.origin) ? a.origin : null;
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(a.value)) addDomain(a.value, origin); else addName(a.value, origin);
  }
  for (const a of subject?.anchors?.domains?.values?.() || []) addDomain(a.value, ids.has(a.origin) ? a.origin : null);
  for (const t of threads || []) {
    if (t?.kind === 'domain' && t.trusted !== false && /company|website|site of|domain/i.test(t.why || '')) {
      addDomain(t.value, (t.evidence || []).map((e) => e?.id).find((x) => ids.has(x)) || null);
    }
  }
  for (const f of findings || []) {
    const d = f.data || {};
    // An SEC filing that names the person as an officer of the issuer: the issuer is the company's legal name
    if (/^sec/.test(f.source || '') && TIED.has(f.match) && d.issuer) {
      const named = (d.roles && d.roles.length) || (d.relatedPersons || []).some((p) => subject.hasName(p.name || ''));
      if (named) addName(d.issuer, f.id);
    }
    // A register entry that names the person as an officer
    if (REGISTERS.has(f.source) && TIED.has(f.match) && d.company) addName(d.company, f.id);
    // The legal name the company's own site prints in its footer (page reader), and that site's domain
    if (d.kind === 'legal-name' && f.match !== 'possible') {
      if (d.legalName) addName(d.legalName, f.id);
      if (d.domain) addDomain(d.domain, f.id);
    }
    // The domain record of the company itself
    if (f.source === 'domain-history' && f.match !== 'possible') {
      const m = String(f.title || '').match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+):/i);
      if (m) addDomain(m[1], f.id);
    }
  }
  // The company site's own legal footer ("© 2024 Merge API, Inc."), on a page of a known company domain
  const known = [...domains.keys()];
  for (const f of findings || []) {
    if (f.match === 'possible') continue;
    let host = '';
    try { host = new URL(String(f.data?.page || f.url || '')).hostname.toLowerCase().replace(/^www\./, ''); } catch { host = ''; }
    if (!host || !known.some((k) => host === k || host.endsWith(`.${k}`))) continue;
    const text = `${f.title || ''} ${f.quote || ''}`;
    for (const m of text.matchAll(/(?:©|\(c\)|Copyright)\s*(?:\d{4}\s*(?:[-–]\s*\d{4}\s*)?)?([A-Z][\w&.'’ -]{1,50}?(?:,?\s+(?:Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Limited|GmbH|PBC)))(?![\w])/g)) addName(m[1], f.id);
  }
  const out = (map, key) => [...map.values()].map((x) => ({ [key]: x[key], ids: [...x.ids] }));
  // the bare typed name is not a legal name
  return { legalNames: out(names, 'name').filter((x) => companyKeyStrict(x.name) !== companyKeyStrict(company) || LEGAL_TAIL.test(x.name)), domains: out(domains, 'domain') };
}

/**
 * Offer the legal names and domains found to identity.js, so the registers, SEC, trademarks, lobbying,
 * complaints, awards and the entity register are asked again under them. Only names from a record tied by
 * more than the bare word (companyNames reads only those) and only with that record as the origin.
 * @returns {string[]} the names newly learned
 */
export function learnCompanyNames(subject, findings = [], threads = []) {
  if (!subject?.company) return [];
  const { legalNames, domains } = companyNames(subject, findings, threads);
  const learned = [];
  const byId = new Map((findings || []).map((f) => [f.id, f]));
  // The origin says how strongly the record is tied ('found:' confirmed, 'weak:' anything less), so the check can
  // see which record produced the name and never re-grade that record on it.
  const originOf = (id) => { const f = byId.get(id); return f && f.match === 'confirmed' && !f.assumedTie ? `found:${id}` : `weak:${id}`; };
  for (const x of [...legalNames.map((n) => ({ v: n.name, ids: n.ids })), ...domains.map((d) => ({ v: d.domain, ids: d.ids }))]) {
    if (!x.ids.length) continue;
    if (addCompanyAlias(subject, { company: subject.company, alias: x.v, origin: originOf(x.ids[0]) })) learned.push(x.v);
  }
  return learned;
}

/* ---------------------------------------------------------------- funding and standing */

const MONEY = '\\$\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:million|billion|trillion|[MBK]|bn|mn)\\b)?';
const ROUND = '(?:pre-seed|seed(?:\\s+round)?|Series\\s+[A-H](?:-?\\d)?(?:\\s+(?:round|extension))?|growth round|funding round|venture round|tender offer)';
const RAISE = /\b(?:rais(?:e[sd]?|ing)|closed|clos(?:es|ing)|secur(?:e[sd]?|ing)|land(?:s|ed)|bag(?:s|ged)|nab(?:s|bed)|announc(?:e[sd]|ing)|completed|gets|got|picks up|picked up)\b/i;
const NOT_INVESTOR = /^(?:the|a|an|and|its|their|his|her|existing|new|other|several|many|investors?|participation|backers?|funds?)$/i;

/** Investor names from a list: "Accel, NEA and Addition" (never the person or the company itself). */
function investorList(subject, text, company) {
  const out = [];
  for (const part of String(text || '').split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s+(?=[A-Z])/)) {
    const n = tidy(part.replace(/^(?:existing investors?|investors?|backers?|including|such as|and)\s+/i, '').replace(/\s+(?:among others|and others|as well)$/i, '').replace(/[.;:]+$/, ''));
    if (n.length < 2 || n.length > 50 || !/^[A-Z0-9]/.test(n) || NOT_INVESTOR.test(n) || n.split(/\s+/).length > 6) continue;
    if (subject.hasName(n) || startsWithCompany(n, company)) continue;
    if (/\b(?:valuation|million|billion|round|Series)\b|\$/i.test(n)) continue;
    out.push(n);
  }
  return out;
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const monthNo = (m) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(String(m).slice(0, 3).toLowerCase()) + 1;
/** A date the sentence itself gives ("in May 2021", "in 2022"), else the record's own date. */
function dateIn(sentence, fallback) {
  const m = sentence.match(new RegExp(`\\b(?:in|on|since)\\s+(?:(${MONTHS})\\.?\\s+(?:\\d{1,2},\\s+)?)?((?:19|20)\\d\\d)\\b`));
  if (m) return m[1] ? `${m[2]}-${String(monthNo(m[1])).padStart(2, '0')}` : m[2];
  return fallback ? String(fallback).slice(0, 10) : null;
}
const moneyKey = (s) => String(s || '').toLowerCase().replace(/[\s,$]/g, '').replace(/million|mn/, 'm').replace(/billion|bn/, 'b');

/**
 * The company's facts from the records.
 * @returns {{ legalNames, domains, founded: { year, ids }|null, funding: Array, investors: Array, standing: Array }}
 */
export function buildCompanyFacts(subject, findings = [], threads = []) {
  const company = tidy(subject?.company);
  const { legalNames, domains } = companyNames(subject, findings, threads);
  const empty = { legalNames, domains, founded: null, funding: [], investors: [], standing: [] };
  if (!company) return empty;
  const forms = [company, ...legalNames.map((n) => n.name)];
  const aliases = [...legalNames.map((n) => n.name), ...domains.map((d) => d.domain)];
  const ordinary = isOrdinaryWordCompany(company);
  // In a record that names the person (tied), the company written as a capitalised name is the company. In a
  // record tied only to the company, the matcher must still see it as the company in that sentence.
  const formRe = new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'u');
  const namesCompany = (s, f) => {
    if (!formRe.test(s) && !aliases.some((a) => s.toLowerCase().includes(a.toLowerCase()))) return false;
    if (TIED.has(f.match)) return true;
    const m = companyMention(company, s, { aliases });
    return m.named && (!ordinary || m.strength !== 'none');
  };
  // an archive "changed" record repeats two snapshots side by side: the snapshots themselves are read
  const usable = (findings || []).filter((f) => (TIED.has(f.match) || f.match === 'company') && f.data?.kind !== 'change');

  const foundedVotes = new Map(); // year -> Set(ids)
  const funding = new Map();
  const investors = new Map();
  const standing = new Map();
  const vote = (year, id) => { const y = yearOf(year); if (!y) return; if (!foundedVotes.has(y)) foundedVotes.set(y, new Set()); foundedVotes.get(y).add(id); };
  const addInvestor = (name, id) => { const k = name.toLowerCase(); if (!investors.has(k)) investors.set(k, { name, ids: new Set() }); investors.get(k).ids.add(id); };
  const addRound = (r, id) => {
    const key = `${(r.round || '').toLowerCase()}|${moneyKey(r.amount)}`;
    if (!funding.has(key)) funding.set(key, { round: r.round || null, amount: r.amount || null, date: r.date || null, lead: r.lead || null, investors: [], ids: new Set() });
    const x = funding.get(key);
    x.ids.add(id);
    if (!x.lead && r.lead) x.lead = r.lead;
    if (!x.date && r.date) x.date = r.date;
    for (const i of r.investors || []) if (!x.investors.includes(i)) x.investors.push(i);
  };
  const addStanding = (kind, figure, text, id, date) => {
    const key = `${kind}|${moneyKey(figure)}`;
    if (!standing.has(key)) standing.set(key, { kind, text, date: date || null, ids: new Set() });
    standing.get(key).ids.add(id);
  };
  const co = `(?:${forms.map(esc).join('|')})`;

  for (const f of usable) {
    const d = f.data || {};
    // Y Combinator lists the year the company was founded
    if (f.source === 'yc-directory' && d.yearFounded && (f.match === 'company' || TIED.has(f.match)) && startsWithCompany(d.company || String(f.quote || '').split(/\s+[—(]/)[0], company)) vote(d.yearFounded, f.id);
    // A Form D of the company: the amount offered and sold, as filed
    if (/^sec/.test(f.source || '') && d.form === 'D' && d.issuer && startsWithCompany(d.issuer, company)) {
      const q = String(f.quote || '');
      const offered = (q.match(/total offering amount:\s*(\$[\d,]+|Indefinite)/i) || [])[1];
      const sold = (q.match(/total amount sold:\s*(\$[\d,]+)/i) || [])[1];
      const first = (q.match(/date of first sale:\s*(\d{4}-\d{2}-\d{2})/i) || [])[1] || d.firstSale || null;
      if (offered || sold) addRound({ round: 'Form D offering', amount: [offered && `${offered} offered`, sold && `${sold} sold`].filter(Boolean).join('; '), date: first || f.date || null }, f.id);
    }
    const text = f.data?.kind === 'bio' ? String(f.quote || '') : `${f.title || ''}. ${f.quote || ''}`;
    for (const s of sentences(text)) {
      if (s.length > 600 || privacyReason(s) || !namesCompany(s, f)) continue;
      // founding year: "Merge was founded in 2020", "started Merge in 2020", "Ramp, founded in 2019", "Merge began in 2020"
      for (const re of [
        new RegExp(`${co}(?:['’]s)?,?\\s+(?:was\\s+|is\\s+)?(?:co-?)?(?:founded|started|launched|established|incorporated)\\s+(?:in\\s+)?(?:(?:${MONTHS})\\.?\\s+)?((?:19|20)\\d\\d)\\b`, 'u'),
        new RegExp(`\\b(?:co-?founded|founded|started|launched)\\s+${co}\\s+in\\s+(?:(?:${MONTHS})\\.?\\s+)?((?:19|20)\\d\\d)\\b`, 'u'),
        new RegExp(`${co}\\s+(?:began|was born)\\s+in\\s+((?:19|20)\\d\\d)\\b`, 'u'),
        new RegExp(`${co}[^.;]{0,40}?\\bFounded:?\\s+((?:19|20)\\d\\d)\\b`, 'u'),
      ]) { const m = s.match(re); if (m) vote(m[1], f.id); }

      // funding: "Merge raises $55M Series B led by Accel", "raised $4.5M in seed funding led by NEA, with ..."
      const money = new RegExp(`(${MONEY})(?:\\s+(?:in\\s+)?(?:a\\s+|its\\s+|new\\s+)*(${ROUND})(?:\\s+(?:funding|financing|round))?)?`, 'gi');
      for (const m of s.matchAll(money)) {
        const before = s.slice(Math.max(0, m.index - 70), m.index);
        const after = s.slice(m.index + m[0].length, m.index + m[0].length + 220);
        const round = m[2] ? tidy(m[2]).replace(/^series/i, 'Series').replace(/^seed(?: round)?$/i, 'Seed').replace(/^pre-seed$/i, 'Pre-seed') : (after.match(new RegExp(`^\\s*(?:in\\s+)?(?:a\\s+|its\\s+)?(${ROUND})`, 'i')) || [])[1] || null;
        const isValuation = /^\s*(?:post-money\s+|pre-money\s+)?valuation\b/i.test(after) || /\b(?:valued at|valuation of|valuation to|worth)\s*$/i.test(before) || /\bat an?\s*$/i.test(before);
        if (isValuation) {
          addStanding('valuation', m[1], clipAround(s, m.index), f.id, dateIn(s, f.date));
          continue;
        }
        if (/\b(?:revenue|ARR|sales)\b/i.test(after.slice(0, 40)) || /\b(?:revenue|ARR|sales)\s+(?:of\s+)?$/i.test(before)) {
          addStanding('revenue', m[1], clipAround(s, m.index), f.id, dateIn(s, f.date));
          continue;
        }
        if (!(RAISE.test(before) || round)) continue;
        const lead = (after.match(/\bled by\s+([A-Z][^,;.()]{1,60}?)(?=\s*(?:,|;|\.|\(|$|\s+with\b|\s+and\s+(?:participation|existing|others)|\s+alongside\b|\s+at\b|\s+in\b|\s+on\b))/) || [])[1] || null;
        const more = (after.match(/\b(?:with participation from|participation from|alongside|joined by|investors include|backed by|from investors)\s+([^.;()]{3,220})/i) || [])[1] || '';
        const list = investorList(subject, more, company);
        const leadClean = lead ? investorList(subject, lead, company)[0] || null : null;
        addRound({ round, amount: tidy(m[1]), date: dateIn(s, f.date), lead: leadClean, investors: list }, f.id);
        if (leadClean) addInvestor(leadClean, f.id);
        for (const i of list) addInvestor(i, f.id);
      }
      // "valued at $44 billion", "a $22.5 billion valuation" already read above; "investors include A, B and C"
      const inv = s.match(/\b(?:investors include|is backed by|backed by investors such as|investors such as|backers include)\s+([^.;()]{3,220})/i);
      if (inv) for (const i of investorList(subject, inv[1], company)) addInvestor(i, f.id);
      // headcount and customers: "about 200 employees", "7,000+ B2B companies", "used by over 70,000 businesses"
      for (const m of s.matchAll(/(?<![\d$.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\+)?\s*(?:(?:thousand|million)\s+)?(?:[A-Z][\w-]*\s+)?(employees|staff|people|customers|businesses|companies|clients|users)\b/g)) {
        const kind = /employees|staff|people/.test(m[3]) ? 'headcount' : 'customers';
        if (kind === 'headcount' && !/\b(?:employ\w*|staff|team|headcount|workforce|people)\b/i.test(s)) continue;
        if (kind === 'customers' && !/\b(?:customers?|clients?|used by|serv(?:es|ing)|power(?:s|ing)|users)\b/i.test(s)) continue;
        addStanding(kind, `${m[1]}${m[2] || ''}`, clipAround(s, m.index), f.id, dateIn(s, f.date));
      }
    }
  }
  const ranked = [...foundedVotes.entries()].sort((a, b) => b[1].size - a[1].size || a[0] - b[0]);
  const fin = (list) => list.map((x) => ({ ...x, ids: [...x.ids] }));
  return {
    legalNames, domains,
    founded: ranked[0] ? { year: ranked[0][0], ids: [...ranked[0][1]] } : null,
    funding: fin([...funding.values()]).sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))),
    investors: fin([...investors.values()]).sort((a, b) => b.ids.length - a.ids.length).slice(0, 25),
    standing: fin([...standing.values()]).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 20),
  };
}

/**
 * The company facts in the report's form: finding ids become citation numbers; a line no cited record
 * states is left out. Null when nothing is known.
 * @param {object} facts from buildCompanyFacts
 * @param {(ids: string[]) => number[]} cite
 */
export function publishCompanyFacts(facts, cite) {
  if (!facts) return null;
  const withCites = (list) => (list || []).map(({ ids, ...rest }) => ({ ...rest, cites: cite(ids || []) })).filter((x) => x.cites.length);
  const out = {
    legalNames: withCites(facts.legalNames),
    domains: withCites(facts.domains),
    founded: facts.founded && cite(facts.founded.ids).length ? { year: facts.founded.year, cites: cite(facts.founded.ids) } : null,
    funding: withCites(facts.funding),
    investors: withCites(facts.investors),
    standing: withCites(facts.standing),
  };
  const has = out.legalNames.length || out.domains.length || out.founded || out.funding.length || out.investors.length || out.standing.length;
  return has ? out : null;
}
