/**
 * Breach and leak-site exposure of a COMPANY or a DOMAIN. Never of a person.
 *
 * Three sources, all public indexes that publish metadata only:
 *   leak-sites        RansomLook: victim posts crawled from ransomware and
 *                     extortion leak sites, and its catalogue of breached
 *                     databases. Claims made by criminals: always labelled
 *                     "claimed, unverified".
 *   breach-catalogue  Have I Been Pwned: the public catalogue of known
 *                     breaches (downloaded whole once a day, matched here).
 *   breach-registers  Notices companies filed with regulators: the
 *                     California and Washington Attorneys General, the
 *                     Oregon Department of Justice, and enforcement action
 *                     by the UK Information Commissioner's Office.
 *
 * What is kept: organisation, group, dates, counts, data-class labels and
 * the official link. What is never read or returned: the attacker-written
 * description, screenshots, page captures, magnet links and onion links.
 *
 * Matching. Every one of these sources searches by substring ("uber" returns
 * "Huber", "The Shubert Organization", "St. Hubert's Church"), so every row
 * is re-checked here against the normalised company name:
 *   - a name of two or more words must appear whole, at word boundaries;
 *   - a one-word name must be the organisation's name, not a word inside it
 *     ("Apple Inc." yes; "Apple Valley Unified School District" no;
 *     "Target Corporation" yes; "TJG, Inc. d/b/a Target Marketing" no);
 *   - a name that is too short or too general ("AI", "The Company") is not
 *     searched by name at all;
 *   - a domain matches only the same registrable domain.
 *
 * Grading. A match is the company's ("company") only when it rests on the
 * company's own domain, or on its exact name when that name is not one
 * ordinary word ("Theranos", "Change Healthcare"; not "Bolt" or "Merge"). A
 * match on an ordinary word alone, or one that adds a general word ("Meta
 * Financial Group"), is a possible namesake: graded "possible", kept off the
 * timeline, and, where the company's own domain was looked up and nothing
 * names it, the record says so.
 *
 * The federal health register (HHS OCR) is not included: its export needs a
 * session and three chained requests, which is too slow for a live lookup.
 */
import { getJson, getText, htmlToText } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { isSensitive, mentionsMinor } from '../guardrails';
import { isOrdinaryWordCompany, companyKeys } from '../names';

const switchedOff = (id) => String(process.env.FOUNDER_SOURCES_OFF || '').split(',').map((x) => x.trim()).filter(Boolean).includes(id);
const OFF_REASON = 'This source is not enabled on this deployment.';

const CATEGORY = 'exposure';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_SOURCE = 8;

/* ------------------------------------------------------------------ */
/* Company names                                                       */
/* ------------------------------------------------------------------ */

/** Legal forms: carry no identity ("Theranos, Inc." is "Theranos"). */
const LEGAL = new Set('inc incorporated llc llp lllp lp ltd limited plc gmbh ag sa sas sarl srl spa bv nv ab oy oyj as asa aps kk pte pty corp corporation co company pc pllc aplc se kg ug sl ltda lda na'.split(' '));
/** Words a legal name adds to a brand without saying anything about it ("Uber Technologies", "Meta Platforms", "T-Mobile USA"). */
const PADDING = new Set('technologies technology tech labs lab platforms holdings holding international global worldwide enterprises companies ai usa us uk america americas europe com io app online'.split(' '));
/**
 * General words that a legal name also adds ("FTX Trading", "Adobe Systems",
 * "Revolve Group"), but that just as often belong to a different company
 * with the same first word ("Summit Financial Group", "Compass Group USA").
 * A match that rests on one of these is reported with a caution.
 */
const SECTOR = new Set('group financial services solutions trading markets payments motor motors network networks systems software digital interactive brands industries'.split(' '));
const DESCRIPTORS = new Set([...PADDING, ...SECTOR]);
const STOPWORDS = new Set(['the', 'and', 'of', 'a', 'an', 'for', 'in', 'at', 'to']);
/** Where one organisation's name ends and another begins inside a register entry. */
const SEGMENT_SPLIT = /[()[\]/;:|]|\s[-–—]\s|\b(?:d\/b\/a|dba|doing business as|a\/k\/a|aka|f\/k\/a|fka|formerly known as|formerly|on behalf of|c\/o|trading as|t\/a|(?:a |an )?(?:subsidiary|division|affiliate|unit|part|member) of)\b/i;

const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const squash = (tokens) => tokens.join('');
const isFiller = (t) => LEGAL.has(t) || DESCRIPTORS.has(t);
const dropThe = (tokens) => (tokens.length > 1 && tokens[0] === 'the' ? tokens.slice(1) : tokens);
const startsWith = (tokens, want) => want.length > 0 && want.length <= tokens.length && want.every((t, i) => tokens[i] === t);
const containsRun = (tokens, want) => {
  for (let i = 0; i + want.length <= tokens.length; i += 1) if (want.every((t, j) => tokens[i + j] === t)) return true;
  return false;
};
const withoutTrailing = (tokens, drop) => {
  const out = tokens.slice();
  while (out.length && drop(out[out.length - 1])) out.pop();
  return out;
};

/** Lowercase words of an organisation name: "T-Mobile U.S.A., Inc." -> ["t", "mobile", "usa", "inc"]. */
export function orgTokens(text) {
  return stripAccents(text).toLowerCase()
    .replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, '')) // l.l.c. -> llc, n.a. -> na
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The normalised form of a company name used for matching.
 *   full      the name without "The" and without legal forms: "Uber Technologies, Inc." -> [uber, technologies]
 *   core      `full` without trailing generic words: [uber]
 *   specific  false when nothing distinctive is left ("AI", "The Company", "Global Holdings")
 * @param {string} name
 */
export function companyKey(name) {
  // a bracketed aside is not part of the name: "Block (formerly Square)" is searched as Block
  const plain = oneLine(String(name || '').replace(/\s*[([][^)\]]*[)\]]/g, ' ')) || oneLine(name);
  let full = withoutTrailing(dropThe(orgTokens(plain)), (t) => LEGAL.has(t));
  if (full.every((t) => STOPWORDS.has(t))) full = [];
  const core = withoutTrailing(full, (t) => DESCRIPTORS.has(t));
  const specific = squash(core).length >= 3 && !core.every((t) => STOPWORDS.has(t) || isFiller(t));
  return { name: plain, full, core, specific };
}

const HOST_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(?::\d+)?(?:[/?#].*)?$/i;
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'or', 'ne', 'go', 'gob', 'ltd', 'plc', 'nom', 'sch']);

/**
 * The registrable domain of a host or URL: "https://www.shop.example.co.uk/x" -> "example.co.uk".
 * Returns '' when the value is not a domain.
 */
export function registrableDomain(value) {
  const m = HOST_RE.exec(String(value || '').trim());
  if (!m) return '';
  const labels = m[1].toLowerCase().split('.');
  const take = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Every registrable domain written inside a piece of text ("Acme (acme-corp.com)" -> ["acme-corp.com"]). */
function domainsIn(text) {
  const out = new Set();
  for (const m of String(text || '').toLowerCase().matchAll(/(?<![a-z0-9@.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(?![a-z0-9-])/g)) {
    const domain = registrableDomain(m[1]);
    if (domain) out.add(domain);
  }
  return [...out];
}

/**
 * Is this organisation name (as a source wrote it) the company?
 * @param {{ full: string[], core: string[], specific: boolean }} key from companyKey
 * @param {string} recordName
 * @returns {'exact'|'padded'|'leading'|'contains'|null}
 *   exact     the organisation is named exactly this (legal forms and empty words such as "Technologies" aside), or its domain is
 *   padded    the same, but the entry adds a general word that may belong to another company ("Summit Financial Group" for Summit)
 *   leading   the entry starts with the company's name followed by a legal form ("Capita plc and ...")
 *   contains  the company's name of two or more words appears whole inside the entry
 */
export function matchOrgName(key, recordName) {
  if (!key || !key.full.length) return null;
  const raw = oneLine(recordName);
  // An entry that is a domain is the company only when its name part is the company's name:
  // "mgmresorts.com" is MGM Resorts, "stripe-payments.io" is not Stripe.
  const domain = registrableDomain(raw);
  if (domain) {
    if (!key.specific) return null;
    const label = domain.split('.')[0].replace(/-/g, '');
    return label === squash(key.full) || (key.core.length < key.full.length && label === squash(key.core)) ? 'exact' : null;
  }
  const whole = dropThe(orgTokens(raw));
  if (!whole.length) return null;
  const segments = [whole, ...raw.split(SEGMENT_SPLIT).map((s) => dropThe(orgTokens(s)))].filter((s) => s.length);
  const grades = segments.map((seg) => isCompanyName(key, seg));
  if (grades.includes('exact')) return 'exact';
  if (grades.includes('padded')) return 'padded';
  if (!key.specific) return null; // short or generic names: only an entry named exactly this, nothing looser

  const leading = segments.some((seg) => {
    if (!startsWith(seg, key.full)) return false;
    let i = key.full.length;
    while (i < seg.length && DESCRIPTORS.has(seg[i])) i += 1;
    return i < seg.length && LEGAL.has(seg[i]);
  });
  if (leading) return 'leading';
  if (key.full.length >= 2 && containsRun(whole, key.full)) return 'contains';
  return null;
}

/**
 * Is this one name (already separated from its neighbours) the company
 * itself, legal forms and general words aside?
 * @param {{ full: string[], core: string[], specific: boolean }} key
 * @param {string[]} tokens from orgTokens
 * @returns {'exact'|'padded'|null} 'padded' when the match rests on a general word that could belong to another company
 */
function isCompanyName(key, tokens) {
  if (!tokens.length) return null;
  if (!key.specific) return startsWith(tokens, key.full) && tokens.slice(key.full.length).every((t) => LEGAL.has(t)) ? 'exact' : null;
  const graded = (extra) => (extra.some((t) => SECTOR.has(t)) ? 'padded' : 'exact');
  if (startsWith(tokens, key.full) && tokens.slice(key.full.length).every(isFiller)) return graded(tokens.slice(key.full.length));
  const trimmed = withoutTrailing(tokens, isFiller);
  if (squash(trimmed) === squash(key.full)) return graded(tokens.slice(trimmed.length)); // "We Work Inc." for WeWork
  // The company was given with a general word ("Uber Technologies", "Mistral AI") and the entry is the bare brand.
  return key.core.length < key.full.length && squash(withoutTrailing(tokens, (t) => LEGAL.has(t))) === squash(key.core) ? 'exact' : null;
}

/**
 * The part of a longer entry that is the company's own name, as the source
 * wrote it ("Change Healthcare - Optum - UnitedHealth" -> "Change Healthcare"),
 * or '' when no part is. Used where the rest of the entry must not be shown.
 */
export function ownNameIn(key, recordName) {
  if (!key || !key.full.length) return '';
  const raw = oneLine(String(recordName || '').replace(/<[^>]*>/g, ' '));
  const parts = [raw, ...raw.split(SEGMENT_SPLIT)]
    .map((p) => oneLine(p).replace(/^[\s,.;:!?'"-]+|[\s,;:!?'"-]+$/g, ''))
    .filter((p) => p && p.length <= 80 && !/[<>{}\\]|https?:/i.test(p) && !registrableDomain(p));
  return parts.filter((p) => isCompanyName(key, dropThe(orgTokens(p)))).sort((x, y) => x.length - y.length)[0] || '';
}

const MATCH_REASON = {
  exact: (company) => `the organisation's name matches ${company}`,
  padded: (company) => `the organisation's name is ${company} followed by general words: check it is the same company`,
  leading: (company) => `the entry begins with the name ${company}`,
  contains: (company) => `the entry names ${company}`,
  partial: (company) => `the entry contains a legal name of ${company} inside a longer name`,
};
const MATCH_RANK = { exact: 0, padded: 1, leading: 2, contains: 3, partial: 4 };

/** What to type into a source's search box: the brand without legal forms and generic words. */
function searchTerm(name) {
  const words = oneLine(name).replace(/^the\s+/i, '').split(' ');
  while (words.length > 1) {
    const t = orgTokens(words[words.length - 1]);
    if (t.every(isFiller)) words.pop(); else break;
  }
  return words.join(' ').replace(/^[\s,.;:!?'"()]+|[\s,.;:!?'"()]+$/g, '');
}

/**
 * Mail, social and hosting domains shared by millions of people. A breach of
 * one of them says nothing about the subject, unless it is their company.
 */
const SHARED_DOMAINS = new Set(('gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com gmx.com mail.com zoho.com '
  + 'linkedin.com twitter.com x.com facebook.com instagram.com threads.net youtube.com tiktok.com reddit.com github.com gitlab.com github.io medium.com substack.com wordpress.com blogspot.com tumblr.com '
  + 'google.com wikipedia.org crunchbase.com angel.co wellfound.com about.me notion.site wixsite.com squarespace.com webflow.io herokuapp.com vercel.app netlify.app bit.ly t.co linktr.ee archive.org '
  + 'telegram.org t.me discord.com discord.gg slack.com zoom.us dropbox.com').split(' '));

const tooGeneralNote = (name) => `Breach and leak-site records were not searched for "${oneLine(name)}": the name is too short or too general to match reliably.`;

/**
 * What a task asks for, or why it must not be run.
 * @returns {{ kind: 'company', key: object, term: string } | { kind: 'domain', domain: string } | { skip: true, note?: string }}
 */
function targetOf(task, ctx, kinds) {
  const value = oneLine(task?.value);
  if (!value || !kinds.includes(task?.kind)) return { skip: true };
  const subject = ctx?.subject;
  if (task.kind === 'domain') {
    const domain = registrableDomain(value);
    if (!domain) return { skip: true };
    // The person's own site (firstlast.com) is about a person, not a company: never searched here.
    const label = domain.split('.')[0].replace(/[^a-z0-9]/g, '');
    if ((subject?.slugs || []).some((slug) => String(slug).replace(/[^a-z0-9]/g, '') === label)) return { skip: true };
    if (SHARED_DOMAINS.has(domain)) {
      const companies = [subject?.company, ...[...(subject?.anchors?.companies?.values?.() || [])].map((a) => a.value)].filter(Boolean);
      if (!companies.some((c) => matchOrgName(companyKey(c), domain) === 'exact')) return { skip: true };
    }
    return { kind: 'domain', domain };
  }
  // Breach sources are never searched for a person, even when a person's name arrives as a "company".
  if (typeof subject?.hasName === 'function' && subject.hasName(value)) return { skip: true };
  const key = companyKey(value);
  if (!key.full.length) return { skip: true, note: tooGeneralNote(value) };
  return { kind: 'company', key, term: searchTerm(key.name) };
}

/**
 * The company's own registrable domains the check knows. A domain counts when the check has learned it for this
 * company (identity.addCompanyAlias: { of } names the company, whatever the label), or when it is one of the
 * subject's own domains and its name part is the company's name or begins with it ("nikolamotor.com" for Nikola).
 * Used to tell the company's own breach from a namesake's, and a listing on another website from one on its own.
 * @param {{ name: string, full: string[], core: string[], specific: boolean }} key from companyKey
 * @returns {string[]}
 */
export function companyOwnDomains(key, ctx) {
  const out = new Set();
  if (!key || !key.full.length) return [];
  const subject = ctx?.subject;
  const isDomainText = (v) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(v || ''));
  const of = companyKeys(key.name)[0] || key.name.toLowerCase();
  // Learned for this very company: its own whatever the label says ("block.xyz" for Square).
  for (const a of subject?.anchors?.aliases?.values?.() || []) {
    if (a?.of !== of || !isDomainText(a.value)) continue;
    const d = registrableDomain(a.value);
    if (d && !SHARED_DOMAINS.has(d)) out.add(d);
  }
  // One of the subject's domains, of any company: only when its name part is this company's name, or begins with
  // its distinctive name ("nikolamotor" for Nikola; never a three-letter prefix, which too many words begin with).
  const stems = [squash(key.full), squash(key.core)].filter((s, i, all) => s.length >= 4 && all.indexOf(s) === i);
  // The person's own site ("nikolatesla.com" for Nikola Tesla) is about the person, never the company's website.
  const slugs = new Set((subject?.slugs || []).map((slug) => String(slug).replace(/[^a-z0-9]/g, '')));
  for (const a of [...(subject?.anchors?.domains?.values?.() || []), ...[...(subject?.anchors?.aliases?.values?.() || [])].filter((x) => isDomainText(x?.value))]) {
    const d = registrableDomain(a?.value);
    if (!d || SHARED_DOMAINS.has(d)) continue;
    const label = d.split('.')[0].replace(/-/g, '');
    if (slugs.has(label)) continue;
    if (matchOrgName(key, d) === 'exact' || (key.specific && stems.some((s) => label.startsWith(s)))) out.add(d);
  }
  return [...out];
}

function ownDomainsOf(key, ctx) {
  return new Set(companyOwnDomains(key, ctx));
}

/** Fuller legal names the check has learned for this company (identity.addCompanyAlias), of two words or more. */
function legalNamesOf(key, ctx) {
  const of = companyKeys(key.name)[0] || key.name.toLowerCase();
  return [...(ctx?.subject?.anchors?.aliases?.values?.() || [])]
    .filter((a) => a.of === of && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(a.value || '')) && companyKey(a.value).full.length >= 2)
    .map((a) => a.value);
}

/** A key matched only whole: its bare brand alone ("Harvey" of "Harvey AI") does not count as the name. */
const wholeKey = (key) => ({ ...key, core: key.full });

/**
 * Did a record match the company only through its bare brand: "Harvey" (or harvey.com) for "Harvey AI",
 * "Mistral, Inc." for "Mistral AI"? The bare brand is a shorter name than the one given, so whether it alone
 * may stand for the company is judged on the brand, not on the longer name.
 */
export function bareBrandOnly(key, recordName) {
  if (!key || !key.full.length || key.core.length >= key.full.length) return false;
  return Boolean(matchOrgName(key, recordName)) && !matchOrgName(wholeKey(key), recordName);
}

/**
 * Is the company named distinctively enough for this record's match on its name alone to stand for it? Judged on
 * the form that matched: the full name given ("Harvey AI", two words) or, when only the bare brand matched, the
 * brand ("Harvey", an ordinary first name: not enough).
 */
export function distinctiveMatch(key, recordName = '', bareOnly = undefined) {
  if (!key || !key.specific) return false;
  const bare = bareOnly === undefined ? bareBrandOnly(key, recordName) : Boolean(bareOnly);
  const words = bare ? key.core : key.full;
  return words.length >= 2 || !isOrdinaryWordCompany(words.join(' '));
}

/**
 * How a learned legal name ("Bolt Financial, Inc.") matches a record: 'exact' when one part of the entry is that
 * name (legal forms and empty words such as "Technologies" aside), 'partial' when the name only appears inside a
 * longer one ("Lightning Bolt Financial Advisors LLC": another firm), else null. Only 'exact' may tie a record.
 */
export function legalNameMatch(legalName, recordName) {
  const k = wholeKey(companyKey(legalName));
  if (k.full.length < 2) return null;
  if (matchOrgName(k, recordName) === 'exact') return 'exact';
  return containsRun(dropThe(orgTokens(recordName)), k.full) ? 'partial' : null;
}

/** Is the distinctive name the company's: ordinary or bare-brand names (see distinctiveMatch) are not. */
const distinctiveName = (key, recordName = '', bareOnly = undefined) => distinctiveMatch(key, recordName, bareOnly);

/**
 * The grade of a record matched by name: the company's when the match is on its own domain or on its exact,
 * distinctive name; otherwise a possible namesake. `domainNote` says that the company's own domain was looked
 * up and named nowhere. `bareOnly` says the record matched only through the company's bare brand (worked out
 * from `recordName` when not given).
 */
function gradeMatch(target, grade, { onOwnDomain = false, domainNote = '', recordName = '', ctx = null, bareOnly = undefined } = {}) {
  if (target.kind === 'domain' || onOwnDomain) return { match: 'company', severity: 'medium', extra: {} };
  // A legal name learned for the company ("Uber Technologies, Inc.", "Merge API, Inc.") that is the entry's name is the company
  // (whole and on its own: the bare brand of "Uber Technologies" alone does not count, nor the name inside a longer one)
  const byLegalName = Boolean(recordName) && legalNamesOf(target.key, ctx).some((n) => legalNameMatch(n, recordName) === 'exact');
  const strong = byLegalName || ((grade === 'exact' || grade === 'leading' || grade === 'contains') && distinctiveName(target.key, recordName, bareOnly));
  if (strong) return { match: 'company', severity: 'medium', extra: {} };
  const why = grade === 'padded'
    ? `the name adds a general word to ${target.key.name}, so it may be another company`
    : grade === 'partial'
      ? `the company's legal name appears inside a longer name, so it may be another company`
      : `"${target.key.name}" is an ordinary word other organisations also use, so it may be another company`;
  return { match: 'possible', severity: 'low', why, extra: { excludeFromTimeline: true, companyNamesake: true, ...(domainNote ? { ownDomainChecked: domainNote } : {}) } };
}

/** How an organisation name matches the company: its own name, or a legal name learned for it ("Merge API, Inc."). */
function nameGradeOf(target, name, ctx) {
  const grade = matchOrgName(target.key, name);
  if (grade === 'exact') return grade;
  const legal = legalNamesOf(target.key, ctx).map((n) => legalNameMatch(n, name));
  if (legal.includes('exact')) return 'exact';
  return grade || (legal.includes('partial') ? 'partial' : null);
}

/** The learned legal name of the company that a text is named (as learned: "Merge API, Inc."), or ''. */
function legalNameIn(target, text, ctx) {
  return legalNamesOf(target.key, ctx).find((n) => legalNameMatch(n, text) === 'exact') || '';
}

/** The grade fields of a regulator notice matched by name (notices carry no website). */
function registerGrade(target, grade, recordName, ctx) {
  const g = gradeMatch(target, grade, { recordName, ctx });
  return { severity: g.severity, match: g.match, matchReasons: [MATCH_REASON[grade](target.key.name), ...(g.why ? [g.why] : [])] };
}

/* ------------------------------------------------------------------ */
/* Dates and numbers                                                   */
/* ------------------------------------------------------------------ */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const validIso = (y, m, d) => (y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
/** "2023-09-14 22:18:15.880069" or "2021-08-24T00:00:00.000" -> "2023-09-14" (the source's own calendar day, no timezone shift). */
const isoDay = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim()); return m ? validIso(+m[1], +m[2], +m[3]) : null; };
/** "10/7/2026" (US order) -> "2026-10-07". */
const usDay = (s) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || '')); return m ? validIso(+m[3], +m[1], +m[2]) : null; };
/** "15 October 2025" -> "2025-10-15". */
const ukDay = (s) => {
  const m = /(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/.exec(String(s || ''));
  if (!m) return null;
  const month = MONTHS.findIndex((name) => name.toLowerCase().startsWith(m[2].slice(0, 3).toLowerCase()));
  return month < 0 ? null : validIso(+m[3], month + 1, +m[1]);
};
/** "2025-10-15" -> "15 October 2025". */
const longDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : ''; };
/** 2079648 or "10,683,178" -> "2,079,648"; '' when it is not a positive whole number. */
const count = (n) => {
  const s = String(n ?? '').replace(/[,\s]/g, '');
  if (!/^\d{1,15}$/.test(s) || Number(s) <= 0) return '';
  return Number(s).toLocaleString('en-US');
};
/** "Label: value." as one sentence of a quote (no doubled full stop after "Inc."). */
const field = (label, value) => { const v = oneLine(value); return v ? `${label}: ${v}${/[.!?]$/.test(v) ? '' : '.'}` : ''; };
const newestFirst = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
const bestFirst = (a, b) => (MATCH_RANK[a.grade] ?? 9) - (MATCH_RANK[b.grade] ?? 9) || newestFirst(a, b);

/* ------------------------------------------------------------------ */
/* 1. Ransomware leak-site listings (RansomLook)                       */
/* ------------------------------------------------------------------ */

const LEAK_SITES_ID = 'leak-sites';
const LEAK_SITES_KINDS = ['company', 'domain'];
const RANSOMLOOK = 'https://www.ransomlook.io';
const RANSOMLOOK_LABEL = 'RansomLook (ransomlook.io, CC BY 4.0)';

/**
 * One search of the index. Only the fields listed here are ever read: the
 * post's description, link, magnet and screenshot stay in the response body
 * and go no further.
 */
async function ransomlookSearch(q, deadline) {
  const body = await getJson(`${RANSOMLOOK}/api/search?q=${encodeURIComponent(q)}`, { deadline, timeoutMs: 7000 });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('The leak-site index returned an unexpected response');
  const posts = (Array.isArray(body.posts) ? body.posts : []).map((p) => ({ title: oneLine(p?.post_title), group: oneLine(p?.group_name), seen: isoDay(p?.discovered) })).filter((p) => p.title);
  const leaks = (Array.isArray(body.leaks) ? body.leaks : []).map((l) => ({
    name: oneLine(l?.name).toLowerCase(), records: count(l?.records), indexed: isoDay(l?.indexed),
    columns: Array.isArray(l?.columns) ? l.columns.map((c) => oneLine(c)) : [],
  })).filter((l) => l.name);
  return { posts, leaks };
}

/** A group's name fit to show: "eraleign (apt73)", "inc ransom". */
const groupName = (g) => oneLine(g).replace(/[^\p{L}\p{N} ._()-]+/gu, '').slice(0, 40).trim();
/** The index's own page for a group. The address uses the name exactly as the index writes it; a changed name leads nowhere. */
const groupPage = (raw) => (raw && raw.length <= 60 && !/[/\\?#\u0000-\u001f]/.test(raw) ? `${RANSOMLOOK}/group/${encodeURIComponent(raw)}` : `${RANSOMLOOK}/recent`);
/**
 * A link that opens a page of the index at the row naming this organisation
 * (a "text fragment": browsers that do not know it simply open the page).
 */
const atText = (pageUrl, text) => (text ? `${pageUrl}#:~:text=${encodeURIComponent(text).replace(/-/g, '%2D')}` : pageUrl);

const FIELD_LABELS = [
  [/e-?mail/, 'Email addresses'],
  [/ssn|social|passport|national|tax|licen[cs]e/, 'Government ID numbers'],
  [/pass|pwd|hash|salt/, 'Passwords'],
  [/phone|mobile|tel\b|telephone|cell/, 'Phone numbers'],
  [/dob|birth/, 'Dates of birth'],
  [/card|cc_?num|iban|bank|account_?num/, 'Payment or bank details'],
  [/addr|street|city|zip|postal|postcode|state|country/, 'Addresses'],
  [/user_?name|login|user_?id|uid\b|nick/, 'Usernames or IDs'],
  [/first_?name|last_?name|full_?name|surname|^name$|_name$/, 'Names'],
  [/^ip|ip_?addr|_ip$/, 'IP addresses'],
  [/gender|sex\b/, 'Genders'],
  [/company|employer|job|title|position/, 'Employment details'],
];
/** Column names of a breached database as generic data-class labels (never the data). */
export function dataFieldLabels(columns) {
  const labels = [];
  let other = 0;
  for (const column of columns || []) {
    const c = String(column || '').toLowerCase().trim();
    if (!c) continue;
    const hit = FIELD_LABELS.find(([re]) => re.test(c));
    if (!hit) other += 1; else if (!labels.includes(hit[1])) labels.push(hit[1]);
  }
  if (other) labels.push(labels.length ? `${other} other field${other === 1 ? '' : 's'}` : `${other} field${other === 1 ? '' : 's'}`);
  return labels;
}

export const leakSiteConnector = {
  id: LEAK_SITES_ID,
  label: 'Ransomware leak-site listings (RansomLook)',
  kinds: LEAK_SITES_KINDS,
  prior: 0.3,
  timeoutMs: 16000,
  enabled: () => !switchedOff(LEAK_SITES_ID),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const target = targetOf(task, ctx, LEAK_SITES_KINDS);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    if (target.kind === 'company' && (!target.key.specific || orgTokens(target.term).join('').length < 3)) {
      return { findings: [], threads: [], notes: [tooGeneralNote(task.value)] };
    }

    // The name and the domain reach different records, so a multi-word name is also searched joined up ("mgmresorts"),
    // and the company's own website, when known, is searched too: a listing that names it is the company's, and when
    // none does, a listing that matches only the name says so.
    // Every website known to be the company's decides what is its own; at most two are searched.
    const own = target.kind === 'company' ? [...ownDomainsOf(target.key, ctx)] : [];
    const queries = [{ q: target.kind === 'domain' ? target.domain : target.term }];
    if (target.kind === 'company') {
      const joined = squash(target.key.core);
      if (joined.length >= 5 && joined !== target.term.toLowerCase()) queries.push({ q: joined });
      for (const d of own.slice(0, 2)) if (!queries.some((x) => x.q === d)) queries.push({ q: d, domain: d });
    }
    const posts = [];
    const leaks = [];
    const domainAnswered = [];
    for (let i = 0; i < queries.length; i += 1) {
      try {
        const found = await ransomlookSearch(queries[i].q, ctx.deadline);
        posts.push(...found.posts);
        leaks.push(...found.leaks);
        if (queries[i].domain) domainAnswered.push(queries[i].domain);
      } catch (error) {
        if (i === 0) throw error; // the main search failed: the source is down
      }
    }

    const company = target.kind === 'company' ? target.key.name : target.domain;
    const namesOwn = (text) => domainsIn(text).some((d) => own.includes(d));
    const gradeOf = (name) => (target.kind === 'company'
      ? (namesOwn(name) ? 'exact' : nameGradeOf(target, name, ctx))
      : (domainsIn(name).includes(target.domain) ? 'exact' : null));
    const reasonOf = (grade, onOwn) => (target.kind === 'company'
      ? (onOwn ? `the listing names the company's own website (${own.join(', ')})` : MATCH_REASON[grade](company))
      : `exact match on the domain ${target.domain}`);
    // Said on a name-only listing when the company's own website was searched and no listing names it
    const domainNote = domainAnswered.length && !posts.some((p) => namesOwn(p.title)) ? `No listing names ${domainAnswered.join(' or ')}.` : '';

    // One finding per group (each group has one public page in the index), dated at first sight.
    // Only the organisation's own name is shown: never the rest of a headline written by the attacker.
    const listings = new Map();
    for (const post of posts) {
      const grade = gradeOf(post.title);
      if (!grade) continue;
      const group = groupName(post.group);
      const entry = listings.get(group.toLowerCase()) || { group, page: groupPage(post.group), grade, names: [], days: new Set(), onOwn: false, whole: false };
      if ((MATCH_RANK[grade] ?? 9) < (MATCH_RANK[entry.grade] ?? 9)) entry.grade = grade;
      if (target.kind === 'company' && namesOwn(post.title)) entry.onOwn = true;
      // A post that names the company by more than its bare brand ("Harvey AI", not only "Harvey")
      if (target.kind !== 'company' || !bareBrandOnly(target.key, post.title)) entry.whole = true;
      const shown = target.kind === 'company' ? (ownNameIn(target.key, post.title) || legalNameIn(target, post.title, ctx) || (namesOwn(post.title) ? domainsIn(post.title).find((d) => own.includes(d)) : '')) : '';
      if (shown) entry.names.push(shown);
      if (post.seen) entry.days.add(post.seen);
      listings.set(group.toLowerCase(), entry);
    }
    const sameAsGiven = (name) => squash(dropThe(orgTokens(name))) === squash(dropThe(orgTokens(company)));
    const postFindings = [...listings.values()].map((entry) => {
      // the name as listed ("Uber Technologies" for Uber); the given spelling when it is the same name
      const organisation = entry.names.some(sameAsGiven) ? company : entry.names.sort((x, y) => x.length - y.length)[0] || company;
      const days = [...entry.days].sort();
      const first = days[0] || null;
      const last = days[days.length - 1] || null;
      const by = entry.group || 'an extortion group';
      const g = gradeMatch(target, entry.grade, { onOwnDomain: entry.onOwn, domainNote, recordName: organisation, ctx, bareOnly: !entry.whole });
      return {
        grade: entry.grade, date: first,
        finding: makeFinding(ctx.subject, {
          source: LEAK_SITES_ID, sourceLabel: RANSOMLOOK_LABEL, category: CATEGORY,
          title: `${organisation} listed by ${by} on a ransomware leak site (claimed, unverified)`,
          quote: [field('Victim listed', organisation), field('Group', by), field('First seen', first), days.length > 1 ? `Listed on ${days.length} dates, most recently ${last}.` : '', g.match === 'possible' ? domainNote : ''].filter(Boolean).join(' '),
          url: atText(entry.page, organisation),
          date: first, severity: g.severity, match: g.match, matchReasons: [reasonOf(entry.grade, entry.onOwn), ...(g.why ? [g.why] : [])],
          data: { organisation, group: entry.group || null, firstSeen: first, lastSeen: last, listings: Math.max(1, days.length), nameMatch: entry.onOwn ? 'domain' : entry.grade, status: 'claimed, unverified', ...g.extra },
        }),
      };
    });

    // The index's catalogue of breached databases, by the company's own domain. The catalogue is one
    // public page, so the entries found (nearly always one) are reported as one finding.
    const entries = [];
    const seenLeaks = new Set();
    for (const leak of leaks) {
      const domain = registrableDomain(leak.name);
      const id = `${leak.name}|${leak.records}|${leak.indexed}`;
      if (!domain || seenLeaks.has(id)) continue;
      // With the company's own website known, only that website's entries are the company's (a "merge.cd" is not merge.dev)
      const hit = target.kind === 'company' ? (own.length ? own.includes(domain) : matchOrgName(target.key, leak.name) === 'exact') : domain === target.domain;
      if (!hit) continue;
      seenLeaks.add(id);
      entries.push({ ...leak, labels: dataFieldLabels(leak.columns), date: leak.indexed });
    }
    entries.sort(newestFirst);
    const leakFindings = [];
    if (entries.length) {
      const shown = entries.slice(0, 4);
      const [top] = shown;
      const describe = (e) => [field('Records', e.records), field('Data fields', e.labels.join(', ')), field('Indexed', e.indexed)].filter(Boolean).join(' ');
      const names = [...new Set(entries.map((e) => e.name))];
      // Matched by name only: a catalogue of bare-brand domains ("harvey.com" for Harvey AI) is judged on the brand
      const g = gradeMatch(target, 'exact', { onOwnDomain: own.length > 0, bareOnly: target.kind === 'company' && entries.every((e) => bareBrandOnly(target.key, e.name)) });
      leakFindings.push(makeFinding(ctx.subject, {
        source: LEAK_SITES_ID, sourceLabel: RANSOMLOOK_LABEL, category: CATEGORY,
        title: entries.length === 1
          ? `${top.name} appears in a catalogue of breached databases${top.records ? `: ${top.records} records` : ''} (unverified listing)`
          : `${names.length === 1 ? top.name : company} has ${entries.length} entries in a catalogue of breached databases (unverified listings)`,
        quote: entries.length === 1 ? describe(top) : shown.map((e) => `${e.name}. ${describe(e)}`).join(' '),
        url: atText(`${RANSOMLOOK}/leaks`, top.name),
        date: top.indexed, severity: g.severity, match: g.match,
        matchReasons: [target.kind === 'company' ? (own.length ? `the domain ${top.name} is the company's own website` : `the domain ${top.name} matches the name ${company}`) : reasonOf('exact'), ...(g.why ? [g.why] : [])],
        data: {
          domain: top.name, records: top.records || null, dataFields: top.labels, indexed: top.indexed, status: 'unverified listing', ...g.extra,
          ...(entries.length > 1 ? { entries: shown.map((e) => ({ domain: e.name, records: e.records || null, dataFields: e.labels, indexed: e.indexed })) } : {}),
        },
      }));
    }

    const findings = [...postFindings.sort(bestFirst).slice(0, MAX_PER_SOURCE).map((x) => x.finding), ...leakFindings].filter(Boolean);
    return { findings, threads: [], notes: [] };
  },
};

/* ------------------------------------------------------------------ */
/* 2. Known data breaches (Have I Been Pwned catalogue)                */
/* ------------------------------------------------------------------ */

const CATALOGUE_ID = 'breach-catalogue';
const CATALOGUE_KINDS = ['company', 'domain'];
const HIBP = 'https://haveibeenpwned.com';
const HIBP_LABEL = 'Have I Been Pwned (haveibeenpwned.com, CC BY 4.0)';
const HIBP_CACHE_KEY = 'exposure:hibp-breaches:v1';
/** Data-class labels that name a protected matter: shown as one general label. */
const PROTECTED_CLASS = /sexual|hiv|health|medical|religio|disabilit|ethnic|\braces?\b|politic|drug|citizenship|nationalit|immigra|family|parenting|spouse|deceased|biometric/i;
const ABBREVIATION = /(?:\b(?:Inc|Ltd|Corp|Co|Mr|Mrs|Ms|Dr|St|No|vs|approx|U\.S|U\.K|e\.g|i\.e)|\b[A-Z])\.$/;

/** Text a source wrote, or '' when it touches a protected matter or a child (the record is kept, the text is not). */
// A breach description that names a protected kind of data ("a mental health start-up exposed therapy notes") is
// left out: the data-class label already says sensitive details were exposed.
const publishable = (text) => { const t = oneLine(text); return t && !isSensitive(t) && !mentionsMinor(t) && !PROTECTED_CLASS.test(t) ? t : ''; };

/** The first sentence of the catalogue's own description, as plain text. */
function firstSentence(html) {
  const text = oneLine(htmlToText(html)).replace(/\s+([.,;:!?])/g, '$1'); // a stripped link leaves "breach ."
  const re = /[.!?](?=\s+["“(]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(text))) {
    const sentence = text.slice(0, m.index + 1);
    if (sentence.length >= 40 && !ABBREVIATION.test(sentence)) return sentence.length <= 400 ? sentence : '';
  }
  return text.length <= 400 ? text : '';
}

/** The catalogue as a compact index; only entries that are a breach of an organisation. */
function compactCatalogue(list) {
  if (!Array.isArray(list)) throw new Error('The breach catalogue returned an unexpected response');
  return list
    .filter((b) => b && b.Name && b.Title && !b.IsSpamList && !b.IsStealerLog && !b.IsMalware && !b.IsFabricated)
    .map((b) => ({
      name: String(b.Name),
      title: oneLine(b.Title),
      domain: registrableDomain(b.Domain),
      breachDate: isoDay(b.BreachDate),
      addedDate: isoDay(b.AddedDate),
      count: Number.isFinite(Number(b.PwnCount)) ? Number(b.PwnCount) : 0,
      classes: Array.isArray(b.DataClasses) ? b.DataClasses.map((c) => oneLine(c)).filter(Boolean) : [],
      verified: Boolean(b.IsVerified),
      summary: firstSentence(b.Description),
    }));
}

/**
 * The catalogue, downloaded once a day. The download runs on its own time (the cache's loader deadline), so a
 * caller short of time does not fail it for everyone; a caller out of time gets an error, not an empty list.
 * `asOf` is set when an older copy stood in for a failed refresh.
 */
async function loadCatalogue(deadline) {
  const entry = await cachedEntry(HIBP_CACHE_KEY, DAY_MS, async ({ deadline: loadDeadline } = {}) => compactCatalogue(await getJson(`${HIBP}/api/v3/breaches`, { deadline: loadDeadline, timeoutMs: 12000 })), { deadline });
  return { list: entry.value, asOf: entry.fresh ? '' : new Date(entry.at).toISOString().slice(0, 10) };
}

export const breachCatalogueConnector = {
  id: CATALOGUE_ID,
  label: 'Known data breaches (Have I Been Pwned catalogue)',
  kinds: CATALOGUE_KINDS,
  prior: 0.3,
  timeoutMs: 15000,
  enabled: () => !switchedOff(CATALOGUE_ID),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const target = targetOf(task, ctx, CATALOGUE_KINDS);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    const { list: catalogue, asOf } = await loadCatalogue(ctx.deadline);
    const notes = asOf ? [`The breach catalogue could not be refreshed; its copy of ${asOf} was searched.`] : [];

    // The company's own website, when the check already knows it ("bolt.com" for Bolt): an entry of the same
    // name on another website ("Bolt", bolt.cd, a file-sharing site) is a namesake, not this company.
    const ownDomains = target.kind === 'company' ? ownDomainsOf(target.key, ctx) : new Set();

    const hits = [];
    for (const entry of catalogue) {
      if (target.kind === 'company' && ownDomains.size && entry.domain && !ownDomains.has(entry.domain)) continue;
      if (target.kind === 'domain') {
        if (entry.domain && entry.domain === target.domain) hits.push({ entry, grade: 'exact', reason: `exact match on the domain ${target.domain}`, date: entry.breachDate });
        continue;
      }
      if (entry.domain && ownDomains.has(entry.domain)) {
        hits.push({ entry, grade: 'exact', onOwn: true, reason: `the breached website ${entry.domain} is the company's own`, date: entry.breachDate });
        continue;
      }
      const byName = nameGradeOf(target, entry.title, ctx);
      const byDomain = entry.domain && matchOrgName(target.key, entry.domain) === 'exact';
      // A bare-brand title ("Harvey") on a website named by the full name ("harveyai.com") is not bare-brand only
      const wholeDomain = byDomain && !bareBrandOnly(target.key, entry.domain);
      if (byName) hits.push({ entry, grade: byName, bareOnly: bareBrandOnly(target.key, entry.title) && !wholeDomain, reason: MATCH_REASON[byName](target.key.name), date: entry.breachDate });
      else if (byDomain) hits.push({ entry, grade: 'exact', bareOnly: bareBrandOnly(target.key, entry.domain), reason: `the domain ${entry.domain} matches the name ${target.key.name}`, date: entry.breachDate });
    }
    // Where the company's own website is known and no entry is on it, a name-only entry says so
    const domainNote = ownDomains.size && !hits.some((h) => h.onOwn) ? `No entry in the catalogue is for ${[...ownDomains].join(' or ')}.` : '';

    const findings = hits.sort(bestFirst).slice(0, MAX_PER_SOURCE).map(({ entry, grade, reason, onOwn, bareOnly }) => {
      // Labels of the kinds of data, generalised where a label names a protected matter.
      const classes = [...new Set(entry.classes.map((c) => (PROTECTED_CLASS.test(c) || isSensitive(c) ? 'Sensitive personal details' : c)))];
      const summary = publishable(entry.summary);
      const accounts = count(entry.count);
      const when = longDate(entry.breachDate);
      const g = gradeMatch(target, grade, { onOwnDomain: Boolean(onOwn), domainNote, recordName: entry.title, ctx, bareOnly });
      return makeFinding(ctx.subject, {
        source: CATALOGUE_ID, sourceLabel: HIBP_LABEL, category: CATEGORY,
        title: `${entry.title} data breach${when ? `, ${when}` : ''}${accounts ? `: ${accounts} accounts` : ''}`,
        quote: [field('Website', entry.domain), field('Compromised data', classes.join(', ')), entry.verified ? 'Verified breach.' : 'Unverified breach.', summary, g.match === 'possible' ? domainNote : ''].filter(Boolean).join(' '),
        url: `${HIBP}/Breach/${encodeURIComponent(entry.name)}`,
        date: entry.breachDate, severity: g.severity, match: g.match, matchReasons: [reason, ...(g.why ? [g.why] : [])],
        data: { organisation: entry.title, domain: entry.domain || null, breachDate: entry.breachDate, addedDate: entry.addedDate, accounts: entry.count || null, dataClasses: classes, verified: entry.verified, nameMatch: grade, ...g.extra },
      });
    }).filter(Boolean);
    return { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ */
/* 3. Regulator breach registers                                       */
/* ------------------------------------------------------------------ */

const REGISTERS_ID = 'breach-registers';
const REGISTERS_KINDS = ['company'];
const REGISTER_TIMEOUT_MS = 8000;

const CA_PAGE_SIZE = 50;
const WA_LIMIT = 200;

/** California Attorney General: the notice list, searched by organisation (the result page links each notice). */
async function californiaNotices(target, ctx, notes) {
  const label = 'California Attorney General data breach list (oag.ca.gov)';
  const listUrl = 'https://oag.ca.gov/privacy/databreach/list';
  const html = await getText(`${listUrl}?field_sb24_org_name_value=${encodeURIComponent(target.term)}`, { deadline: ctx.deadline, timeoutMs: REGISTER_TIMEOUT_MS, accept: 'text/html' });
  if (!/field_sb24_org_name_value/.test(html)) throw new Error('The California breach list returned an unexpected page');
  const out = [];
  let listed = 0;
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const org = /<td\b[^>]*views-field-field-sb24-org-name[^>]*>\s*(?:<a\b[^>]*href="([^"]+)"[^>]*>)?([\s\S]*?)(?:<\/a>|<\/td>)/i.exec(row);
    if (!org) continue;
    listed += 1;
    const organisation = oneLine(htmlToText(org[2]));
    const grade = nameGradeOf(target, organisation, ctx);
    if (!grade) continue;
    const href = String(org[1] || '').replace(/&amp;/g, '&');
    const url = /^https:\/\/oag\.ca\.gov\//i.test(href) ? href : href.startsWith('/') ? `https://oag.ca.gov${href}` : listUrl;
    const breachCell = /views-field-field-sb24-breach-date[^>]*>([\s\S]*?)<\/td>/i.exec(row);
    const reportedCell = /views-field-created[^>]*>([\s\S]*?)<\/td>/i.exec(row);
    const breachDates = oneLine(htmlToText(breachCell ? breachCell[1] : '')).replace(/\s*,\s*/g, ', ');
    const reportedText = oneLine(htmlToText(reportedCell ? reportedCell[1] : ''));
    const reported = usDay(reportedText);
    out.push({
      grade, date: reported,
      finding: makeFinding(ctx.subject, {
        source: REGISTERS_ID, sourceLabel: label, category: CATEGORY,
        title: `${organisation}: data breach notice filed with the California Attorney General${reported ? `, reported ${longDate(reported)}` : ''}`,
        quote: [field('Organization Name', organisation), field('Date(s) of Breach', breachDates), field('Reported Date', reportedText)].filter(Boolean).join(' '),
        url, date: reported, ...registerGrade(target, grade, organisation, ctx),
        data: { register: 'California Attorney General', organisation, reported, breachDates: breachDates || null, affected: null, nameMatch: grade, ...gradeMatch(target, grade, { recordName: organisation, ctx }).extra },
      }),
    });
  }
  // The list shows 50 entries a page, newest first; a very common word can fill more than one.
  if (listed >= CA_PAGE_SIZE) notes.push(`The California Attorney General's breach list has more than ${CA_PAGE_SIZE} entries containing "${target.term}"; only the ${CA_PAGE_SIZE} most recent were read.`);
  return out;
}

/** Washington Attorney General: breach notifications published as open data. */
async function washingtonNotices(target, ctx, notes) {
  const label = 'Washington Attorney General data breach notifications (data.wa.gov)';
  const resource = 'https://data.wa.gov/resource/sb4j-ca4h';
  const like = target.term.toUpperCase().replace(/[%_]/g, ' ').replace(/'/g, "''");
  const rows = await getJson(`${resource}.json?$where=${encodeURIComponent(`upper(name) like '%${like}%'`)}&$order=${encodeURIComponent('datesubmitted DESC')}&$limit=${WA_LIMIT}`, { deadline: ctx.deadline, timeoutMs: REGISTER_TIMEOUT_MS });
  if (!Array.isArray(rows)) throw new Error('The Washington breach register returned an unexpected response');
  if (rows.length >= WA_LIMIT) notes.push(`The Washington Attorney General's breach register has more than ${WA_LIMIT} entries containing "${target.term}"; only the ${WA_LIMIT} most recent were read.`);
  const out = [];
  for (const row of rows) {
    const organisation = oneLine(row?.name);
    const grade = nameGradeOf(target, organisation, ctx);
    if (!grade) continue;
    const reported = isoDay(row.datesubmitted);
    const start = isoDay(row.datestart);
    const end = isoDay(row.dateend);
    const affected = count(row.washingtoniansaffected);
    const cause = oneLine(row.databreachcause);
    const attack = oneLine(row.cyberattacktype);
    const breachDates = start && end && end !== start ? `${start} to ${end}` : start || end || '';
    const id = /^\d{1,12}$/.test(String(row.id ?? '')) ? String(row.id) : '';
    out.push({
      grade, date: reported,
      finding: makeFinding(ctx.subject, {
        source: REGISTERS_ID, sourceLabel: label, category: CATEGORY,
        title: `${organisation}: data breach notice filed with the Washington Attorney General${reported ? `, reported ${longDate(reported)}` : ''}${affected ? ` (${affected} Washington residents affected)` : ''}`,
        quote: [
          field('Name', organisation), field('Date submitted', reported), field('Breach dates', breachDates),
          field('Cause', cause ? `${cause}${attack ? ` (${attack})` : ''}` : ''), field('Washingtonians affected', affected),
          field('Days to identify the breach', count(row.daystoidentifybreach)),
          field('Days elapsed before notification', count(row.dayselapsedbeforenotification)),
        ].filter(Boolean).join(' '),
        url: id ? `${resource}/${id}.json` : 'https://data.wa.gov/d/sb4j-ca4h',
        date: reported, ...registerGrade(target, grade, organisation, ctx),
        data: { register: 'Washington Attorney General', organisation, reported, breachDates: breachDates || null, affected: affected || null, cause: cause || null, attackType: attack || null, nameMatch: grade, ...gradeMatch(target, grade, { recordName: organisation, ctx }).extra },
      }),
    });
  }
  return out;
}

/**
 * Oregon Department of Justice: the breach list's own search. The list has
 * no page per notice, so every notice links to the list itself; when a
 * company has several they are reported together as one record (two records
 * with one link would be taken for duplicates).
 */
async function oregonNotices(target, ctx) {
  const label = 'Oregon Department of Justice data breach list (justice.oregon.gov)';
  const listUrl = 'https://justice.oregon.gov/consumer/databreach/';
  const html = await getText('https://justice.oregon.gov/consumer/DataBreach/Home/SearchBreaches', {
    method: 'POST', body: `organization=${encodeURIComponent(target.term)}&start=&end=`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, deadline: ctx.deadline, timeoutMs: REGISTER_TIMEOUT_MS, accept: 'text/html',
  });
  if (!/<table\b[^>]*id="grid"/i.test(html)) throw new Error('The Oregon breach list returned an unexpected page');
  const body = (/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(html) || [])[1] || '';
  const notices = [];
  for (const row of body.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => oneLine(htmlToText(m[1])));
    if (cells.length < 6) continue;
    const [organisation, reportedText, breachText, discoveredText, , affectedText] = cells;
    const grade = nameGradeOf(target, organisation, ctx);
    if (!grade) continue;
    const [from, to] = breachText.split(/\s+-\s+/).map((s) => oneLine(s));
    const breachDates = from && to && to !== from ? `${from} - ${to}` : from || to || '';
    const affected = count(affectedText);
    notices.push({
      grade, organisation, reported: usDay(reportedText), date: usDay(reportedText), breachDates, affected,
      quote: [field('Organization', organisation), field('Reported Date', reportedText), field('Dates of Breach', breachDates), field('Dates of Discovery', discoveredText), field('Number Affected', affected)].filter(Boolean).join(' '),
    });
  }
  if (!notices.length) return [];
  const base = { source: REGISTERS_ID, sourceLabel: label, category: CATEGORY, url: listUrl };
  if (notices.length === 1) {
    const [n] = notices;
    return [{
      grade: n.grade, date: n.reported,
      finding: makeFinding(ctx.subject, {
        ...base,
        title: `${n.organisation}: data breach notice filed with the Oregon Department of Justice${n.reported ? `, reported ${longDate(n.reported)}` : ''}${n.affected ? ` (${n.affected} people affected)` : ''}`,
        quote: n.quote, date: n.reported, ...registerGrade(target, n.grade, n.organisation, ctx),
        data: { register: 'Oregon Department of Justice', organisation: n.organisation, reported: n.reported, breachDates: n.breachDates || null, affected: n.affected || null, nameMatch: n.grade, ...gradeMatch(target, n.grade, { recordName: n.organisation, ctx }).extra },
      }),
    }];
  }
  notices.sort(newestFirst);
  const best = notices.slice().sort(bestFirst)[0];
  const latest = notices[0].reported;
  return [{
    grade: best.grade, date: latest,
    finding: makeFinding(ctx.subject, {
      ...base,
      title: `${best.organisation}: ${notices.length} data breach notices filed with the Oregon Department of Justice${latest ? `, most recently reported ${longDate(latest)}` : ''}`,
      quote: notices.slice(0, 4).map((n) => n.quote).join(' '),
      date: latest, ...registerGrade(target, best.grade, best.organisation, ctx),
      data: {
        register: 'Oregon Department of Justice', organisation: best.organisation, reported: latest, nameMatch: best.grade, ...gradeMatch(target, best.grade, { recordName: best.organisation, ctx }).extra,
        notices: notices.slice(0, MAX_PER_SOURCE).map((n) => ({ organisation: n.organisation, reported: n.reported, breachDates: n.breachDates || null, affected: n.affected || null })),
      },
    }),
  }];
}

/** UK Information Commissioner's Office: fines, reprimands and enforcement notices against organisations. */
async function icoActions(target, ctx, notes) {
  const label = "UK Information Commissioner's Office enforcement action (ico.org.uk, Open Government Licence v3.0)";
  const body = await getJson('https://ico.org.uk/api/search', {
    method: 'POST', body: { filters: [], pageNumber: 1, order: 'newest', term: target.term, rootPageId: 17222 },
    deadline: ctx.deadline, timeoutMs: REGISTER_TIMEOUT_MS,
  });
  if (!body || !Array.isArray(body.results)) throw new Error('The ICO enforcement list returned an unexpected response');
  if (Number(body.pagination?.totalPages) > 1) notes.push(`The UK Information Commissioner's Office list has more than one page of results for "${target.term}"; only the most recent ${body.results.length} were read.`);
  const out = [];
  for (const row of body.results) {
    // The list also holds action against named individuals: only an entry titled with the company is kept.
    const organisation = oneLine(row?.title);
    const grade = nameGradeOf(target, organisation, ctx);
    if (!grade) continue;
    const meta = oneLine(row.filterItemMetaData);
    const date = ukDay(meta) || isoDay(row.createdDateTime);
    const action = oneLine(meta.replace(/^\d{1,2}\s+[A-Za-z]+\s+\d{4}\s*,?\s*/, '').split(',')[0]);
    const path = String(row.url || '');
    out.push({
      grade, date,
      finding: makeFinding(ctx.subject, {
        source: REGISTERS_ID, sourceLabel: label, category: CATEGORY,
        title: `${organisation}: UK Information Commissioner's Office enforcement action${action ? ` (${action})` : ''}${date ? `, ${longDate(date)}` : ''}`,
        quote: publishable(htmlToText(row.description)) || [field('Organisation', organisation), field('Action', meta)].filter(Boolean).join(' '),
        url: /^\/[^/]/.test(path) ? `https://ico.org.uk${path}` : 'https://ico.org.uk/action-weve-taken/enforcement/',
        date, ...registerGrade(target, grade, organisation, ctx),
        data: { register: "UK Information Commissioner's Office", organisation, reported: date, action: action || null, breachDates: null, affected: null, nameMatch: grade, ...gradeMatch(target, grade, { recordName: organisation, ctx }).extra },
      }),
    });
  }
  return out;
}

/** Said once per check (the same line every time), so the gap is never silent. */
export const REGISTERS_COVERAGE = "Regulator breach registers searched: the California and Washington Attorneys General, the Oregon Department of Justice and the UK Information Commissioner's Office. The US federal register of health-data breaches (HHS) is not searched, and a company with no entry may still have had a breach.";

const REGISTERS = [
  { name: 'the California Attorney General', read: californiaNotices },
  { name: 'the Washington Attorney General', read: washingtonNotices },
  { name: 'the Oregon Department of Justice', read: oregonNotices },
  { name: "the UK Information Commissioner's Office", read: icoActions },
];

export const breachRegistersConnector = {
  id: REGISTERS_ID,
  label: 'Regulator breach registers',
  kinds: REGISTERS_KINDS,
  prior: 0.35,
  timeoutMs: 12000,
  enabled: () => !switchedOff(REGISTERS_ID),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const target = targetOf(task, ctx, REGISTERS_KINDS);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    if (!target.key.specific || orgTokens(target.term).join('').length < 3) return { findings: [], threads: [], notes: [tooGeneralNote(task.value)] };

    const limits = [];
    const settled = await Promise.allSettled(REGISTERS.map((r) => r.read(target, ctx, limits)));
    const failed = REGISTERS.filter((r, i) => settled[i].status === 'rejected');
    if (failed.length === REGISTERS.length) {
      throw new Error(`None of the regulator breach registers could be read (${String(settled[0].reason?.message || settled[0].reason).slice(0, 80)})`);
    }
    const findings = settled
      .flatMap((s) => (s.status === 'fulfilled' ? s.value.sort(bestFirst).slice(0, MAX_PER_SOURCE) : []))
      .sort(newestFirst)
      .map((x) => x.finding)
      .filter(Boolean);
    const notes = [REGISTERS_COVERAGE, ...limits];
    if (failed.length) notes.push(`Regulator breach registers: ${failed.map((r) => r.name).join(', ')} could not be read for ${target.key.name}, so ${failed.length === 1 ? 'that register was' : 'those registers were'} not searched.`);
    return { findings, threads: [], notes };
  },
};

export const exposureConnectors = [leakSiteConnector, breachCatalogueConnector, breachRegistersConnector];
