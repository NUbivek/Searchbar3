/**
 * The one shape every source connector returns, so the deep check can merge,
 * rank, cite and display findings from very different sources the same way.
 *
 * Finding
 *   id           stable id (source + url + title)
 *   source       connector id, e.g. 'sec-fts'
 *   sourceLabel  what the user sees, e.g. 'SEC EDGAR full-text search'
 *   category     one of CATEGORIES
 *   title        one line: what the record is
 *   quote        text taken from the source that supports it (never written by us)
 *   url          where to verify it
 *   date         ISO date of the record itself (filing, snapshot, article), or null
 *   match        'confirmed' | 'likely' | 'possible' | 'company'
 *                ('company': a record about the subject's company, not the person)
 *   matchReasons why it was graded that way
 *   severity     'high' | 'medium' | 'low' | 'info'  (how much it matters if true)
 *   data         optional structured extras for the UI (case number, snapshot time, ...)
 *   matchFixed   true when the source set the grade by hand: it is never re-graded
 *   gradeText    the text the grade was read from, cleaned by the privacy rules (internal; stripped before the page sees it)
 *
 * Thread: something new worth pulling on, found while reading a source.
 *   { kind: 'company'|'school'|'associate'|'relative'|'handle'|'domain'|'url', value, why,
 *     trusted?: boolean   true when it came from a record graded confirmed or likely
 *     relation?: string   for relatives: 'father', 'spouse', ... }
 *
 * A connector's run() resolves to { findings: Finding[], threads: Thread[], notes: string[] }.
 */
import { matchSubject } from './identity';
import { matterOutcome } from './names';
import { sanitizeFinding, cleanSentences, isSafeUrl } from './guardrails';

export const CATEGORIES = {
  identity: 'Identity',
  career: 'Career and roles',
  education: 'Education',
  archive: 'Archived versions',
  litigation: 'Courts and litigation',
  regulatory: 'Regulators and enforcement',
  sanctions: 'Sanctions and watchlists',
  leaks: 'Published leak databases',
  corporate: 'Company records',
  ip: 'Patents and publications',
  press: 'Press',
  related: 'Related parties and family ties',
  exposure: 'Breach and leak-site exposure',
};

export const SEVERITIES = ['high', 'medium', 'low', 'info'];
/**
 * What a thread can be. 'associate' is another named person tied to the
 * subject in business (a co-founder, a co-defendant); 'relative' is a family
 * member the source places in a public business, political or
 * philanthropic role. Neither gets a background check of their own: they are
 * screened against watchlists and searched only together with the subject.
 * 'alias' is another name of the subject themselves (a former or maiden name, a birth name, "also known as"),
 * read from a record tied to them: records filed under it are searched and graded 'likely' at most
 * (identity.addNameAlias).
 */
export const THREAD_KINDS = ['company', 'school', 'associate', 'relative', 'handle', 'domain', 'url', 'alias'];

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Text that is safe to store: no NUL characters and no half of a surrogate
 * pair (an emoji cut in two, or a stray "&#55357;" decoded from a page).
 * Either one makes the database refuse the whole saved check.
 */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

const clip = (s, n) => {
  const str = cleanText(s).replace(/\s+/g, ' ').trim();
  if (str.length <= n) return str;
  let cut = str.slice(0, n - 1);
  // never cut an emoji (a surrogate pair) in half
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
};

// Like clip, but keeps line breaks: the grade reads a new line as a new sentence, so the title's last
// words and the quote's first word ("Wikipedia" + "Nikola") must not be glued into one capitalised run.
const clipLines = (s, n) => {
  const str = cleanText(s).replace(/[^\S\n]+/g, ' ').replace(/ ?\n[\s]*/g, '\n').trim();
  if (str.length <= n) return str;
  let cut = str.slice(0, n - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
};

const isoDate = (value) => {
  if (!value) return null;
  const s = String(value).trim();
  // Wayback timestamps: 20190314120000
  const wb = s.match(/^(\d{4})(\d{2})(\d{2})(\d{6})?$/);
  if (wb) return `${wb[1]}-${wb[2]}-${wb[3]}`;
  if (/^\d{4}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};

/**
 * Build a finding, grade it against the subject, and apply the privacy
 * rules. Returns null when the record does not name the subject (unless
 * `match` is given, for records tied to the subject structurally, such as a
 * registry entry for their company) or when the guardrails reject it.
 *
 * @param {object} subject from identity.createSubject
 * @param {{ source: string, sourceLabel: string, category: string, title: string, quote?: string, url: string,
 *           date?: string, severity?: string, data?: object, matchText?: string, match?: string, matchReasons?: string[] }} f
 */
export function makeFinding(subject, f) {
  if (!f || !f.source || !f.url || !f.title) return null;
  if (!CATEGORIES[f.category]) throw new Error(`Unknown finding category: ${f.category}`);
  // Only an absolute http(s) link is stored: the page renders it as <a href>, and a scraped javascript: or
  // data: link would run script on the site with the investor's session.
  if (!isSafeUrl(f.url)) return null;
  let match = f.match || null;
  let reasons = f.matchReasons || [];
  // A grade the source set by hand (a company record, a held 'possible') is final: the loop must not
  // re-read the title later and upgrade it. A graded record remembers the text it was graded on, so a
  // re-grade reads the same text (the structured context the source supplied), not just title and quote.
  const matchFixed = Boolean(match) || Boolean(f.matchFixed);
  // Title and quote on separate lines, so each is read as its own sentence.
  const text = f.matchText || `${f.title}\n${f.quote || ''}`;
  // The grade text is cleaned by the same rules as the quote, so a re-grade never reads a private sentence.
  const gradeText = match ? null : clipLines(cleanSentences(cleanText(text).slice(0, PRE_CLIP)).text, 1500);
  // The record's own date goes to the grade, so a role held at that time (a CEO tenure) can count.
  // A re-grade reads the same date back from the finding's `date`.
  const date = isoDate(f.date);
  let basis = null;
  if (!match) {
    const graded = matchSubject(subject, text, { date });
    if (graded.level === 'none') return null;
    match = graded.level;
    reasons = graded.reasons;
    // Which anchors carried the grade: a likely grade resting only on an encyclopedia link or an event another
    // record reports must not make the record's threads trusted, nor (event only) a red flag.
    if (Array.isArray(graded.basis) && graded.basis.length) basis = graded.basis;
  }
  // The matter's outcome and the person's part in it (acquitted, dismissed, settled, pardoned; plaintiff, witness),
  // kept so the report can show it beside the matter. Read from the cleaned grade text, never a private sentence.
  let data = f.data || null;
  if (!data?.outcome && subject && typeof subject.hasName === 'function') {
    const told = matterOutcome(gradeText || clipLines(cleanSentences(cleanText(text).slice(0, PRE_CLIP)).text, 1500), { person: subject.hasName });
    if (told.outcome || told.role) data = { ...(data || {}), outcome: { outcome: told.outcome || null, role: told.role || null } };
  }
  // The privacy rules run on the full text before it is clipped: a phone number or a birth date cut in half
  // at the clip would no longer be recognised. The text is only pre-cut to a bound the rules can read quickly.
  const finding = sanitizeFinding({
    id: `${f.source}-${hash(`${f.url}|${f.title}`)}`,
    source: f.source,
    sourceLabel: f.sourceLabel || f.source,
    category: f.category,
    title: clip(f.title, PRE_CLIP),
    quote: clipLines(f.quote || '', PRE_CLIP),
    url: String(f.url).trim(),
    date,
    match,
    matchReasons: reasons,
    severity: SEVERITIES.includes(f.severity) ? f.severity : 'info',
    ...(matchFixed ? { matchFixed: true } : {}),
    ...(basis ? { matchBasis: basis } : {}),
    ...(data ? { data } : {}),
  });
  if (!finding) return null;
  finding.title = clipClean(finding.title, 220);
  finding.quote = clipClean(finding.quote, 700);
  if (!finding.title) return null;
  // The grade text is kept on the finding because a re-grade later in the run (also after the saved check is
  // resumed) must read the same text. It holds only sentences that passed the privacy rules, and deep.js strips
  // it before the page sees it.
  if (gradeText) finding.gradeText = gradeText;
  return finding;
}

// How much raw text the privacy rules read before the final clip (well past the 700 shown, so nothing cut at
// this bound can reach the page).
const PRE_CLIP = 4000;

// Clip text the rules have already cleaned. A run of digits the clip cuts at the end ("… 415-55…") is dropped:
// the rules saw the whole number and did not call it a phone, but half a number is no use to anyone either.
function clipClean(s, n) {
  const out = clip(s, n);
  if (!out.endsWith('…')) return out;
  return out.replace(/(?<![\w/.-])\+?\(?\d[\d\s().-]{3,}…$/, (m) => ((m.match(/\d/g) || []).length >= 5 && /[\s().-]/.test(m.slice(0, -1)) ? '…' : m));
}

const HIGH = /\b(indict(?:s|ed|ments?)?|convict(?:s|ed|ions?)?|plead(?:ed|s)? guilty|pled guilty|found guilty|guilty verdict|guilty of|jailed|sentenced|imprison\w*|felony|criminal charges?|charged with|securities fraud|wire fraud|bank fraud|fraud charges|ponzi|embezzl\w*|money launder\w*|bribe\w*|racketeer\w*|insider trading|sanctioned|sanctions list|debarred|barred from|disqualified|banned from|arrest(?:ed)?|extradit\w*|wanted by|cease[- ]and[- ]desist)\b/i;
const MEDIUM = /\b(landlord to|related[- ]party (?:transactions?|deals?)|self[- ]dealing|conflicts? of interest|bankrupt|chapter 11|lawsuits?|sued|sues|suing|class[- ]action|complaint filed|settle(?:d|s|ment)|investigat(?:ion|ed|ing)|probe|subpoena\w*|fined|penalt(?:y|ies)|bankruptc(?:y|ies)|insolven\w*|liquidat\w*|receivership|fraud|misconduct|misappropriat\w*|harass\w*|discriminat\w*|retaliat\w*|whistleblower|allegations?|alleged(?:ly)?|accus(?:ed|es|ing|ations?)|attorneys? general\b[^.;]{0,60}?\b(?:letters?|investigat\w*|demands?|subpoena\w*|inquir(?:y|ies)|probe)|fired(?! up)|ousted|forced out|terminated for cause|(?:steps?|stepped|stepping) down (?:under|amid) (?:\w+ )?pressure|breach of (?:contract|fiduciary)|default judgment|judgments? against|damages awards?|ordered to pay|restitution|arbitrat\w*|claw(?:s|ed|ing)?[- ]?backs?|restraining order|data breach|ransomware)\b/i;
const LOW = /\b(resign(?:ed|s|ation)|stepped down|steps down|departed|controvers\w*|dispute[ds]?|layoffs?|shut(?:s|ting)? down|shutdown|wound down|dissolved|struck off|criticis\w*|criticiz\w*|backlash|restat(?:ed|ement))\b/i;

// A probe or inquiry that a regulator declined, closed, dropped or cleared ("CMA decides not to
// investigate", "regulator closes its inquiry into the deal"). The gap between the verb and the probe
// word may not announce a new or widened one, or tie the probe to something else ("closed amid a probe").
const PROBE_WORD = String.raw`(?:probes?|investigat\w*|inquir(?:y|ies))`;
// Prepositions are barred too, so "shares dropped 5% on an SEC probe" is not read as a dropped probe.
const PROBE_GAP = String.raw`(?:(?!\b(?:open\w*|launch\w*|start\w*|begin\w*|began|new|another|second|separate|expand\w*|widen\w*|reopen\w*|amid|after|following|during|despite|while|as|over|because|on|in|at|by|with|of|from|for)\b(?!-))[^.;]){0,40}?`;
const NEGATED_PROBE = new RegExp(
  String.raw`\b(?:(?:won['’]?t|will not|would not|did not|declin\w* to|decid\w* not to|refus\w* to)\s+(?:investigat\w*|(?:open|launch|pursue|begin|start|proceed with)\b${PROBE_GAP}\b${PROBE_WORD})`
  // "won't face a probe": only after a plain negation ("refuses to face a probe" is someone dodging one)
  + String.raw`|(?:won['’]?t|will not|would not|did not)\s+(?:face|be subject to)\b${PROBE_GAP}\b${PROBE_WORD}`
  + String.raw`|(?:clos(?:es|ed|ing)?|drop(?:s|ped|ping)?|clear(?:s|ed|ing)?|end(?:s|ed|ing)?|conclud(?:es|ed|ing)?)\b${PROBE_GAP}\b${PROBE_WORD}`
  // "CMA rejects probe into ...", "rules out an investigation". Not "dismisses lead investigator" (a firing)
  // nor "rejects probe findings" (a party disputing a probe's result, which is still adverse).
  + String.raw`|(?:reject(?:s|ed|ing)?|rul(?:es|ed|ing) out|dismiss(?:es|ed)?)\b${PROBE_GAP}\b(?:probes?|investigations?|inquir(?:y|ies))\b(?!\s+(?:findings?|allegations?|claims?|reports?|results?|conclusions?|conclud\w*|found)\b)`
  + String.raw`|clear(?:s|ed|ing)?\b[^.;]{0,60}?\b(?:after|following) (?:an? |its |the |a \w+ )?${PROBE_WORD})\b`,
  'i',
);
// What a clause still reports once a cleared probe is taken out of it: a real outcome keeps the clause.
const OUTCOME = /\b(fined|penalt(?:y|ies)|settle(?:d|s|ment)|ordered to pay|judgments? against|damages awards?|restitution|arbitration awards?|claw(?:s|ed|ing)?[- ]?backs?|subpoena\w*|bankruptc(?:y|ies)|receivership|ousted|forced out|fired(?! up))\b/i;
// An article or claim the record says was defamatory or libellous: the only adverse content is the
// disputed publication itself, so a lawsuit over it is low, not medium.
const DISPUTED_PUBLICATION = /\b(?:article|story|stories|report|piece|column|op-?ed|editorial|post|book|documentary|podcast|blog|tweet|claims?|statements?)\b[^.;]{0,220}\b(?:defamatory|libell?ous)\b/i;
// What the publication said: the criminal-matter word must come after one of these to be the disputed claim.
const CLAIMING = /\b(?:claim(?:s|ed|ing)?|alleg\w*|say(?:s|ing)?|said|suggest\w*|accus\w*|that)\b/i;
const DISPUTED_BLOCK = new RegExp(`${OUTCOME.source}|\\b(investigat\\w*|probes?|inquir(?:y|ies)|misconduct|harass\\w*|discriminat\\w*|whistleblower|data breach|ransomware)\\b`, 'i');

/** The text without its clauses that only report a probe that was declined, closed or cleared. */
function withoutClearedProbes(t) {
  if (!NEGATED_PROBE.test(t)) return t;
  return t.split(/(?<=[.;!?])\s+|\n+/).filter((clause) => {
    const m = clause.match(NEGATED_PROBE);
    if (!m) return true;
    const rest = clause.replace(m[0], ' ');
    // keep a clause that still reports a criminal matter or an outcome (a fine, a settlement)
    return HIGH.test(rest) || OUTCOME.test(rest);
  }).join(' ');
}

function rawSeverity(t) {
  if (HIGH.test(t)) return 'high';
  if (MEDIUM.test(t)) return 'medium';
  if (LOW.test(t)) return 'low';
  return 'info';
}

// An aside about another named person: "Jane Roe, who was convicted of wire fraud," or "Jane Roe, the
// former chief executive charged with fraud." It runs from the comma after the name to the next comma or
// full stop, and only when it opens on a relative pronoun or a criminal-matter verb within a few words.
const OTHER_PERSON_ASIDE = /\b([A-Z][\p{L}'’-]+ [A-Z][\p{L}'’-]+), (?:(?:an?|the) )?(?:[\p{L}'’-]+ ){0,4}?(?:who|convicted|charged|sentenced|accused|indicted|jailed|imprisoned|arrested)\b[^,.;]*/gu;
const OBJECT_PRONOUN = /\b(?:him|his|her|hers|them|their)\b/i;

/**
 * The text without asides that report a criminal matter of someone other than the subject. An aside that
 * names the subject, the subject's company or a pronoun that could point back at them is kept.
 */
function withoutOtherPeoplesMatters(t, subject) {
  if (!subject || typeof subject.hasName !== 'function') return t;
  const companies = [subject.company, ...(subject.anchors?.companies ? [...subject.anchors.companies.keys()] : [])]
    .map((c) => String(c || '').toLowerCase().trim()).filter((c) => c.length >= 2);
  return t.replace(OTHER_PERSON_ASIDE, (span, name) => {
    if (subject.hasName(name) || subject.hasName(span) || OBJECT_PRONOUN.test(span)) return span;
    const lower = span.toLowerCase();
    if (companies.some((c) => lower.includes(c))) return span;
    return name;
  });
}

// Outcomes that end a matter in the person's favour.
const EXCULPATORY = new Set(['acquitted', 'overturned', 'vacated', 'dismissed', 'dropped', 'won']);
// The person was not the one accused.
const NOT_ACCUSED = new Set(['plaintiff', 'witness', 'victim', 'juror']);
// Words of a conviction and its sentence: a pardon follows one, so they are part of the pardoned matter.
const CONVICTION_WORDS = /\b(?:convict(?:s|ed|ions?)?|found guilty|guilty verdict|plead(?:ed|s)? guilty|pled guilty|sentenced|imprison\w*|jailed)\b/gi;

/**
 * How much a record would matter if it is about the subject, judged from
 * its own words. Sources that know better (a sanctions list, a court
 * docket) set the severity themselves. With the subject, a criminal matter
 * told about another named person in an aside ("Jane Roe, who was convicted
 * of fraud") does not count against the subject.
 * The outcome and the person's part are read too (names.matterOutcome): an acquittal, a dismissal, dropped charges,
 * a vacated or overturned conviction or a case the person won is 'low' unless the text still reports another
 * criminal matter; a pardon is 'medium'; the person as plaintiff, witness, victim or juror (and not accused) is
 * 'low'. The outcome itself is for the finding's data (matterOutcome), so the report can show it beside the matter.
 */
export function severityFromText(text, subject = null) {
  const t = withoutOtherPeoplesMatters(String(text || ''), subject);
  const graded = gradeByOutcome(t, subject, rawSeverity(withoutClearedProbes(t)));
  return graded;
}

function gradeByOutcome(t, subject, base) {
  const person = subject && typeof subject.hasName === 'function' ? subject.hasName : null;
  const { outcome, role, rest } = matterOutcome(t, { person });
  if (outcome === 'pardoned') {
    // What is left once the pardon and the conviction it ends are taken out: a new criminal matter keeps 'high'.
    const left = rawSeverity(withoutClearedProbes(rest.replace(CONVICTION_WORDS, ' ')));
    if (left === 'high') return disputedSeverity(t, base);
    return 'medium';
  }
  if (outcome && EXCULPATORY.has(outcome)) {
    const left = rawSeverity(withoutClearedProbes(rest));
    if (left === 'high') return disputedSeverity(t, base);
    return left === 'medium' && !NOT_ACCUSED.has(role) && outcome !== 'won' ? 'medium' : 'low';
  }
  if (role && NOT_ACCUSED.has(role) && (base === 'high' || base === 'medium')) return 'low';
  return disputedSeverity(t, base);
}

function disputedSeverity(t, sev) {
  if (sev === 'low' || sev === 'info') return sev;
  const disputed = t.match(DISPUTED_PUBLICATION);
  if (!disputed || DISPUTED_BLOCK.test(t)) return sev;
  if (sev === 'medium') return 'low';
  // high: only when every criminal-matter word is inside the disputed claim itself
  // ("an article claiming he was indicted, which he called defamatory")
  const rest = t.slice(0, disputed.index) + t.slice(disputed.index + disputed[0].length);
  if (HIGH.test(rest)) return sev;
  const crime = disputed[0].match(HIGH);
  return crime && CLAIMING.test(disputed[0].slice(0, crime.index)) ? 'low' : sev;
}

/** A thread to pull, or null when it is not usable. */
export function makeThread(kind, value, why = '', extra = {}) {
  const v = String(value || '').replace(/\s+/g, ' ').trim();
  if (!THREAD_KINDS.includes(kind) || v.length < 2 || v.length > 200) return null;
  // a url thread is fetched and may be shown as a link: http(s) only
  if (kind === 'url' && !isSafeUrl(v)) return null;
  return { kind, value: v, why: clip(cleanSentences(cleanText(why).slice(0, PRE_CLIP), { kin: false }).text, 160), ...extra };
}

/** Normalise whatever a connector returned into { findings, threads, notes }. */
export function connectorResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  return {
    findings: (Array.isArray(r.findings) ? r.findings : []).filter(Boolean),
    threads: (Array.isArray(r.threads) ? r.threads : []).filter(Boolean),
    notes: (Array.isArray(r.notes) ? r.notes : []).filter(Boolean).map(String),
  };
}
