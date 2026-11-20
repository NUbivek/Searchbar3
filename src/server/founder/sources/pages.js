/**
 * Page reader: opens pages that are about the person and keeps what they say
 * about their career and education.
 *
 * A search result carries two lines of a page; the page itself says where
 * they studied and worked. What is opened, best yield first:
 *   url     a page the check already tied to the person: a team or bio page,
 *           a personal site, a profile, an author or speaker page, podcast
 *           show notes, an interview, an article in an established
 *           publication whose search snippet names them
 *   domain  a site tied to the person (their company's, their own): its
 *           about, team and leadership pages, where they exist
 *
 * Every page is one request, identified as an automated reader, paced per
 * host (http.js), and only when the site's robots.txt allows it. Social
 * networks (LinkedIn, X, Facebook, Instagram) are never opened: they do not
 * permit automated reading. Their public profile lines come from search
 * results instead.
 *
 * When a page that robots.txt allows turns the reader away (HTTP 403 or 429)
 * or does not answer in time, its most recent copy in the Internet Archive is
 * read instead (the archive permits automated reading), and the record says
 * so, with the date of the copy. A page robots.txt closes to us is never read,
 * from the site or from the archive.
 *
 * Besides the visible sentences, the page's own structured data is read: a
 * schema.org Person (job title, employer, school, profile links) whose name is
 * the person's, an organisation that lists them among its founders, the page's
 * summary line (meta and OpenGraph description), and definition-list bios
 * ("Education: ..."). Contact, birth and family fields are never read.
 *
 * Requests (verified 2026-11-20):
 *   robots            GET <origin>/robots.txt
 *   page              GET <page>
 *   archive copy      GET https://archive.org/wayback/available?url=<page>
 *                     -> { archived_snapshots: { closest: { available, status, timestamp, url } } }
 *                     GET https://web.archive.org/web/<timestamp>id_/<page>   (the page as served)
 */
import { request, htmlToText, getJson, HttpError } from '../http';
import { cached } from '../cache';
import { makeFinding, severityFromText } from '../finding';
import { threadsFromResult, profileFromUrl, structuredData, personFacts, threadsFromFacts } from '../extract';
import { isBlockedUrl } from '../guardrails';
import { bioSentences, sentencesOf } from '../profile';
import { replayUrl } from './archive';

const ID = 'page-reader';
/** The name this reader answers to in a robots.txt (the product token of the User-Agent it sends). */
const READER_TOKEN = 'diligence-research';
const LABEL = 'Bio and interview pages';
/** Page requests per check: every page and every archive request counts (an archive copy is two), robots files do not. */
export const MAX_PAGES = 18;
/** A site lookup tries at most this many of its about/team pages, and keeps at most SITE_MAX_KEPT. */
export const SITE_PATHS = ['/about', '/team', '/leadership', '/about-us', '/company', '/our-team', '/people', '/founders'];
export const SITE_MAX_REQUESTS = 4;
const SITE_MAX_KEPT = 2;
const PAGE_TIMEOUT_MS = 12000;
const NEVER = /(?:^|\.)(?:linkedin\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|threads\.net|youtube\.com|youtu\.be|reddit\.com|news\.google\.com|google\.com|bing\.com|duckduckgo\.com|archive\.org|wikipedia\.org|wikidata\.org|github\.com|crunchbase\.com|pitchbook\.com|sec\.gov)$/i;
const NOT_A_PAGE = /\.(?:pdf|docx?|pptx?|xlsx?|zip|png|jpe?g|gif|mp[34]|mov)(?:$|[?#])/i;

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

/** May this page be opened at all? */
export function readable(url) {
  const host = hostOf(url);
  if (!host || !/^https?:/i.test(url) || NEVER.test(host) || NOT_A_PAGE.test(url) || isBlockedUrl(url)) return false;
  const profile = profileFromUrl(url);
  return !profile || !['linkedin', 'x', 'github', 'facebook', 'instagram', 'crunchbase'].includes(profile.platform);
}

/** A site whose about and team pages may be read: a plain host name, never a social network or a people-search site. */
function siteOf(value) {
  const v = String(value || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) return null;
  if (!readable(`https://${v}/about`) || /(?:^|\.)(?:medium\.com|substack\.com|wordpress\.com|blogspot\.com|about\.me|wellfound\.com|angel\.co)$/.test(v)) return null;
  return v;
}

/**
 * Which kind of page a url thread is, from why it was handed on. The template is the learning key, so each
 * kind is scored on its own yield; the prior orders them before anything is learned.
 */
export function readPlanFor(thread) {
  const why = String(thread?.why || '').toLowerCase();
  if (/article naming them/.test(why)) return { template: 'read.press', prior: 0.6, why: 'what this article says about their career and education' };
  if (/podcast|interview|show notes|speaker|author/.test(why)) return { template: 'read.talk', prior: 0.7, why: 'what this interview, talk or author page says about their career and education' };
  return { template: 'read', prior: 0.78, why: 'what this page says about their career and education' };
}

/**
 * The rules of a robots.txt that apply to this reader: its own group when
 * the file names it, else the group for every client.
 * @returns {Array<{ allow: boolean, re: RegExp, length: number }>}
 */
export function parseRobots(text, agent = READER_TOKEN) {
  const groups = []; // { agents: [], rules: [] }
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !current) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      lastWasAgent = false;
      if (!value) continue; // "Disallow:" with nothing allows everything
      const pattern = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
      current.rules.push({ allow: field === 'allow', re: new RegExp(`^${pattern}`), length: value.length });
    } else lastWasAgent = false;
  }
  // its own product token only: a group for "research" or "ai" is someone else's
  const mine = groups.filter((g) => g.agents.includes(agent));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

/** Does the rule set allow this path? The longest matching rule decides; a tie goes to allow. */
export function robotsAllow(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    if (!best || r.length > best.length || (r.length === best.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

/** 'allowed', 'disallowed', or 'unknown' (the robots file could not be read: the page is left alone). */
async function robotsVerdict(url, deadline) {
  const u = new URL(url);
  const rules = await cached(`robots:${u.origin}`, 24 * 3600 * 1000, async () => {
    try {
      const text = await request(`${u.origin}/robots.txt`, { timeoutMs: 6000, deadline, retries: 0, maxBytes: 512 * 1024 }).then((r) => r.text);
      return { text: String(text || '').slice(0, 200000) };
    } catch (error) {
      // No robots file (404 and the like) places no limit. Anything else (a timeout, a server error) is
      // thrown, so it is remembered for a few minutes only and the page is left alone meanwhile.
      if (error?.status >= 400 && error.status < 500 && error.status !== 429) return { text: '' };
      throw error;
    }
  }, { persist: false }).catch(() => null);
  if (!rules) return 'unknown';
  return robotsAllow(parseRobots(rules.text), `${u.pathname}${u.search}`) ? 'allowed' : 'disallowed';
}

/**
 * The page itself turned the reader away (HTTP 403 or 429) or did not answer in time: worth asking the archive
 * for its copy. A host we are leaving alone for now (it asked us to wait, or refused the connection) is not:
 * no request was made to it, and the step loop runs the lookup again once the host is free (its retryAt).
 */
const turnedAway = (error) => {
  const status = Number(error?.status) || 0;
  return status === 403 || status === 429 || /^Timed out after/i.test(String(error?.message || ''));
};
/** Below this much time before the deadline, a page that did not answer is handed back to run in the next step. */
const ARCHIVE_MIN_MS = 5000;

/** The check's page limit was reached before this request could be made. */
class PageLimit extends Error {
  constructor() { super(`${MAX_PAGES} pages already read in this check`); this.code = 'PAGE_LIMIT'; }
}

/**
 * The most recent copy of a page in the Internet Archive, as the site served it. Resolves to null only when
 * the archive answered that it holds no copy; a lookup that failed (an error, a timeout, no time left) throws,
 * so it is never reported as "the archive holds no copy".
 * @param {{ take?: () => boolean }} [options] take: draws one request from the check's page limit, false when spent
 * @returns {Promise<{ html: string, date: string, replay: string } | null>}
 */
export async function archivedCopy(url, deadline, { take = () => true } = {}) {
  const target = String(url).replace(/#.*$/, '');
  // checked here, not in the lookup, so a step that ran out of time does not leave a remembered failure behind
  if (deadline && deadline - Date.now() < 1500) throw new HttpError('Out of time', { url: target, retryable: true });
  if (!take()) throw new PageLimit();
  const found = await cached(`wayback-available:${target}`, 6 * 3600 * 1000, async () => {
    const data = await getJson(`https://archive.org/wayback/available?url=${encodeURIComponent(target)}`, { timeoutMs: 10000, deadline, retries: 0 });
    const c = data?.archived_snapshots?.closest;
    return c && c.available && String(c.status) === '200' && /^\d{14}$/.test(String(c.timestamp)) ? { timestamp: String(c.timestamp) } : { timestamp: null };
  }, { persist: false });
  if (!found?.timestamp) return null;
  const ts = found.timestamp;
  if (!take()) throw new PageLimit();
  const response = await request(`https://web.archive.org/web/${ts}id_/${target}`, { timeoutMs: PAGE_TIMEOUT_MS, deadline, retries: 0, maxBytes: 3 * 1024 * 1024, accept: 'text/html,application/xhtml+xml' });
  return { html: response.text, date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`, replay: replayUrl(ts, target) };
}

/**
 * Open one page, politely. Resolves to
 *   { status: 'ok', html, archived?: { date, replay } }
 *   { status: 'robots' }       robots.txt closes it to us (never read, not even from the archive)
 *   { status: 'unknown' }      robots.txt could not be read: left alone
 *   { status: 'elsewhere', landed }  it sent the reader to a site that is not read
 *   { status: 'missing' }      no such page (404 and the like)
 *   { status: 'refused', why }  it turned the reader away (why 'refused') or did not answer (why 'unanswered'),
 *                              and the archive answered that it holds no copy
 *   { status: 'limit' }        the check's page limit was reached first
 * Throws when the page could not be read and the archive could not be checked either (so the lookup counts
 * as failed, or runs again in the next step when the step's deadline cut it short), never a 'refused'.
 * take() draws one request from the check's page limit before each page or archive request.
 */
async function openPage(url, deadline, { archiveFallback = true, take = () => true } = {}) {
  const verdict = await robotsVerdict(url, deadline);
  if (verdict === 'disallowed') return { status: 'robots' };
  if (verdict === 'unknown') return { status: 'unknown' };
  if (!take()) return { status: 'limit' };
  let response;
  try {
    response = await request(url, { timeoutMs: PAGE_TIMEOUT_MS, deadline, retries: 0, maxBytes: 3 * 1024 * 1024, accept: 'text/html,application/xhtml+xml' });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status && error.status >= 400 && error.status < 500 && !turnedAway(error)) return { status: 'missing' };
    if (!turnedAway(error) || !archiveFallback) throw error;
    // It timed out because the deadline was near, not because the site is slow: there is no time to ask the
    // archive, so it is handed back as cut short (the step loop runs it again in the next step).
    if (!error.status && deadline && deadline - Date.now() < ARCHIVE_MIN_MS) throw error;
    const why = error.status ? 'refused' : 'unanswered';
    let copy;
    try {
      copy = await archivedCopy(url, deadline, { take });
    } catch (archiveError) {
      if (archiveError instanceof PageLimit) return { status: 'limit' };
      const what = why === 'refused' ? `turned the reader away (HTTP ${error.status})` : 'did not answer in time';
      throw new HttpError(`${hostOf(url)} ${what}, and the web archive could not be checked: ${String(archiveError?.message || archiveError)}`,
        { url, retryable: true, retryAt: archiveError?.retryAt || null });
    }
    if (!copy) return { status: 'refused', why };
    return { status: 'ok', html: copy.html, archived: { date: copy.date, replay: copy.replay, why } };
  }
  // A link that lands somewhere else (another site, or another page of the same site) is judged again where it
  // landed: never a social network or a people-search site, and only where robots.txt allows automated reading
  // of that page. A same-site redirect into a path robots.txt closes is not read.
  const landed = response.url || url;
  if (landed.replace(/#.*$/, '') === String(url).replace(/#.*$/, '')) return { status: 'ok', html: response.text };
  if (!readable(landed)) return { status: 'elsewhere', landed };
  const landedVerdict = await robotsVerdict(landed, deadline);
  if (landedVerdict !== 'allowed') {
    if (hostOf(landed) !== hostOf(url)) return { status: 'elsewhere', landed };
    return { status: landedVerdict === 'disallowed' ? 'robots' : 'unknown' };
  }
  return { status: 'ok', html: response.text };
}

/**
 * The page's visible text, with its navigation and footer left out (breadcrumbs and link lists are not
 * sentences) and a line break after every cell, term and definition, so labels do not run into sentences.
 */
export function pageText(html) {
  return htmlToText(stripBlocks(String(html || ''), ['nav', 'footer'])
    .replace(/<\/(dt|dd|td|th|figcaption|blockquote|header|label)>/gi, (m) => `${m}\n`)
    .replace(/<\/(a|button)>/gi, (m) => `${m} `));
}
/**
 * The html without its <nav> and <footer> blocks, in one pass (linear in the page's size). Only those
 * elements open a block: custom elements such as <nav-item> or <footer-links> do not. An opener with no
 * closer after it is left in place, and that tag is not searched for again (none can close later).
 */
export function stripBlocks(html, tags) {
  const open = new RegExp(`<(${tags.join('|')})(?=[\\s>/])`, 'gi');
  const closers = new Map(tags.map((t) => [t, new RegExp(`</${t}\\s*>`, 'gi')]));
  const unclosed = new Set();
  let out = '';
  let from = 0;
  let m;
  while ((m = open.exec(html))) {
    const tag = m[1].toLowerCase();
    if (unclosed.has(tag)) { if (unclosed.size === tags.length) break; continue; }
    const close = closers.get(tag);
    close.lastIndex = open.lastIndex;
    const end = close.exec(html);
    if (!end) { unclosed.add(tag); if (unclosed.size === tags.length) break; continue; }
    out += `${html.slice(from, m.index)} `;
    from = end.index + end[0].length;
    open.lastIndex = from;
  }
  return out + html.slice(from);
}

/** Words that mark a sentence about where someone worked or studied before: these are kept first. */
const PRIOR_HINT = /\b(?:previously|formerly|before|prior to|worked|joined|began (?:her|his|their) career|started (?:her|his|their) career|alum(?:na|nus|ni)?|veteran|spent \d+ years|served as|was an?|graduated|studied|attended|degree)\b|\bex-/i;
const FOUNDING = /\b(?:co-?)?found(?:ers?|ing|ed)\b|\bstarted\b|\blaunched\b/i;
const KIN_WORDS = /\b(?:husband|wife|spouse|father|mother|dad|mom|parents?|son|daughter|brother|sister|children|kids?|grew up|born)\b/i;
/**
 * The sentences of a page worth keeping, best first: bioSentences (profile.js) without the page's title
 * repeated or breadcrumb lines, plus sentences naming the person that say who founded what ("founders Jane
 * Roe and Bob Smith ..."), which tell co-founders even when they say nothing of a career.
 */
function keptSentences(subject, text, { title, aboutThem }) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const junk = (x) => /›|»|\s\|\s/.test(x) || (t && (x.toLowerCase() === t || (x.toLowerCase().startsWith(t) && x.length < t.length + 20)));
  const out = bioSentences(subject, text, { aboutThem, max: 20 }).filter((s) => !junk(s.text));
  const seen = new Set(out.map((s) => s.text.toLowerCase()));
  for (const x of sentencesOf(text)) {
    if (out.length >= 24) break;
    if (seen.has(x.toLowerCase()) || !subject.hasName(x) || !FOUNDING.test(x) || KIN_WORDS.test(x) || x.length > 400 || junk(x)) continue;
    seen.add(x.toLowerCase());
    out.push({ text: x, kind: 'career' });
  }
  // stable: what they did before first, then the page's order
  return out.map((s, i) => ({ s, i, score: PRIOR_HINT.test(s.text) ? 1 : 0 })).sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.s);
}

const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Replace the person's first name, used alone, by their full name (the rule bioSentences reads them by). */
function firstNameAsFull(subject) {
  const tokens = String(subject.name || '').trim().split(/\s+/);
  const first = tokens[0] || '';
  if (tokens.length < 2 || first.length < 4) return (x) => x;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escRe(first)}(?![\\p{L}\\p{N}])(?!\\s+(?!and\\b)[A-Z][\\p{L}'’-]+)`, 'gu');
  return (x) => String(x).replace(re, subject.name);
}

/*
 * On a page that is not their own (an article, or a page whose title and structured data do not name them), a
 * sentence that names the person may be about someone else: "Unlike Adam Neumann, who founded WeWork, Maria
 * Lopez studied at Stanford". There a sentence is kept only when they are what it is about: it opens with
 * their name (after at most a short lead-in such as "In 2015,"), or opens with a pronoun right after such a
 * sentence; and no one else's career is told in it (a comparison, a "who" clause or an aside naming another
 * person, or something of theirs: "Adam Neumann's wife ...").
 */
const PERSONISH = /[A-Z][a-z'’-]+\s+(?:[A-Z]\.\s+)?[A-Z][a-z'’-]+/;
const OTHER_LEAD = /\b(?:unlike|like|than|whereas|while|alongside|with|and|or|but|whom|whose|who|which|told|said|says|according|joins?|joined|hired|replaced|succeeded|vs)\b/i;
const PRONOUN_LEAD = /^(?:[^,;:]{0,40}[,;]\s*)?(?:he|she|they|his|her|their)\b/i;
const COMPARISON = /(?:^|[\s,;(])(?:unlike|like|than|whereas|as did)\s+[A-Z]/;
const OTHERS_CLAUSE = new RegExp(`(${PERSONISH.source}),?\\s+who\\b|,\\s*(${PERSONISH.source})\\s*,`, 'g');
const POSSESSIVE = /^\s*['’]s?\b/;

function tellsAnother(subject, s) {
  if (COMPARISON.test(s)) return true;
  for (const m of s.matchAll(OTHERS_CLAUSE)) if (!subject.hasName(m[1] || m[2])) return true;
  return false;
}
/** The sentences of the text that are about the person (see above), as a Set of their text. */
function sentencesLedByThem(subject, text, { aboutThem }) {
  const asThem = aboutThem ? firstNameAsFull(subject) : (x) => x;
  const led = new Set();
  let carry = 0;
  for (const raw of sentencesOf(text)) {
    const x = asThem(raw);
    const first = subject.hasName.positions(x)[0];
    let ok = false;
    if (first) {
      const prefix = x.slice(0, first.start);
      ok = prefix.length <= 40 && !OTHER_LEAD.test(prefix) && !PERSONISH.test(prefix) && !POSSESSIVE.test(x.slice(first.end)) && !tellsAnother(subject, x);
      carry = ok ? 2 : 0;
    } else if (carry > 0 && PRONOUN_LEAD.test(x) && !tellsAnother(subject, x)) {
      ok = true;
      carry -= 1;
    } else carry = 0;
    if (ok) led.add(raw);
  }
  return led;
}

const pageTitle = (html) => {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 160) : '';
};
const DAY = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${d} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
};

/**
 * What one page says about the person: career and education records (data.kind 'bio', data.page: the
 * profile builder reads them), a record of what the page's structured data states, and the threads both
 * give. A page that does not name the person gives nothing, whatever linked to it.
 * @returns {{ findings: Array, threads: Array }}
 */
export function readPage(subject, { url, html, archived = null, template = 'read' }) {
  const empty = { findings: [], threads: [] };
  const title = pageTitle(html);
  const data = structuredData(html);
  const text = pageText(html);
  // The page must name the person in what a visitor sees: its title, its text or its summary line.
  if (!subject.hasName(`${title}\n${text}\n${data.descriptions.join('\n')}`)) return empty;
  // About them: their name is in the page's own title, the page names them again and again, or its
  // structured data says the page's person is them.
  const namings = text.split(/\n+/).filter((line) => subject.hasName(line)).length;
  const personIsThem = data.persons.some((p) => subject.hasName(p.name) && p.name.trim().split(/\s+/).length >= 2);
  const aboutThem = subject.hasName(title) || namings >= 3 || personIsThem;
  // The page's own summary is read first, as its own lines; then the visible text.
  const allText = `${data.descriptions.join('\n')}\n${text}`;
  const titleIsThem = subject.hasName(title);
  const press = template === 'read.press';
  // Not their own page (an article, or a page whose title and data do not say it is theirs): only sentences
  // that are about them, never a sentence that names them while telling someone else's career.
  const strict = press || (!titleIsThem && !personIsThem);
  const led = strict ? sentencesLedByThem(subject, allText, { aboutThem }) : null;
  const sentences = keptSentences(subject, allText, { title, aboutThem }).filter((x) => !led || led.has(x.text));
  // Definition-list bios ("Education: ...") are read only on a page that is about them alone: on a team page
  // the list may be somebody else's.
  const facts = personFacts(subject, data, { definitionsAreTheirs: subject.hasName(title) && (personIsThem || !data.persons.length) });
  if (!sentences.length && !facts) return empty;
  const naming = sentences.find((s) => subject.hasName(s.text))?.text || '';

  const host = hostOf(url);
  const where = archived ? `${host} (the web archive's copy of ${DAY(archived.date)})` : host;
  const base = {
    source: ID, sourceLabel: LABEL,
    url: archived ? archived.replay : url,
    data: { kind: 'bio', page: url, ...(archived ? { archived: { date: archived.date, url: archived.replay } } : {}) },
  };
  const findings = [];
  for (const kind of ['career', 'education']) {
    const mine = sentences.filter((s) => s.kind === kind).slice(0, kind === 'career' ? 8 : 3);
    if (!mine.length) continue;
    const quote = mine.map((s) => s.text).join(' ');
    const finding = makeFinding(subject, {
      ...base, category: kind,
      title: `${kind === 'career' ? 'Career' : 'Education'}, as told on ${where}${title ? `: ${title}` : ''}`,
      quote: quote.slice(0, 690),
      // graded on the page's own title and these sentences, which name the person
      matchText: `${title}\n${naming}\n${quote}`,
      severity: severityFromText(quote, subject),
    });
    // An article whose title does not name them is not about them: what it says of their career is at most
    // possibly theirs (never a confirmed school or employer in the profile).
    if (finding && press && !titleIsThem && (finding.match === 'confirmed' || finding.match === 'likely')) {
      finding.match = 'possible';
      finding.matchReasons = [...(finding.matchReasons || []), 'an article that does not name them in its title'];
    }
    if (finding) findings.push(finding);
  }
  if (facts) {
    const finding = makeFinding(subject, {
      ...base, category: 'career',
      title: `Profile details in the page data of ${where}${title ? `: ${title}` : ''}`,
      quote: facts.line.slice(0, 690),
      matchText: `${title}\n${facts.line}`,
      severity: 'info',
      data: { ...base.data, structured: { titles: facts.titles, employers: facts.employers, schools: facts.schools, cofounders: facts.cofounders, foundersOf: facts.companiesFounded } },
    });
    if (finding) findings.push(finding);
  }
  const trusted = findings.some((f) => f.match === 'confirmed' || f.match === 'likely');
  if (!findings.length) return empty;
  // On a page about them they are called by their first name ("Shensi worked at a startup called Expanse"):
  // for reading threads only (never in the quote), that name stands for them, exactly where bioSentences
  // read it so (not when another surname follows it).
  const asThem = aboutThem ? firstNameAsFull(subject) : (x) => x;
  const threads = sentences.length
    ? threadsFromResult(subject, { title, snippet: sentences.map((s) => asThem(s.text)).join(' ').slice(0, 2500), url }, { trusted }).filter((t) => t.kind !== 'url')
    : [];
  // Profile links are followed only when the structured Person is them (personFacts checks the name).
  threads.push(...threadsFromFacts(subject, facts, { trusted }));
  return { findings, threads };
}

const BUDGET_KEY = `${ID}:requests`;
/**
 * The check's page limit: every page or archive request draws one from it before it is made (robots files
 * are not counted). The check keeps the count (ctx.spend), live across lookups running in parallel and saved
 * across steps. Without it, the lookups already done are counted (a site lookup as all the requests it may
 * make) plus this lookup's own requests.
 * @returns {{ take: () => boolean, full: () => boolean }}
 */
function pageBudget(ctx) {
  if (typeof ctx.spend === 'function') {
    return { take: () => ctx.spend(BUDGET_KEY, 1, MAX_PAGES), full: () => !ctx.spend(BUDGET_KEY, 0, MAX_PAGES - 1) };
  }
  let base = 0;
  for (const k of (ctx.done ? ctx.done() : [])) {
    const [source, kind] = String(k).split('|');
    if (source === ID) base += kind === 'domain' ? SITE_MAX_REQUESTS : 1;
  }
  let used = 0;
  return {
    take: () => { if (base + used + 1 > MAX_PAGES) return false; used += 1; return true; },
    full: () => base + used >= MAX_PAGES,
  };
}

const NOTE = {
  robots: (host) => `${host} does not allow automated reading of this page; it was not opened.`,
  unknown: (host) => `${host} did not say whether it allows automated reading (its robots file could not be read); the page was not opened.`,
  elsewhere: (host, landed) => `${host} sent the reader to ${hostOf(landed)}, which is not read; nothing was kept.`,
  refused: (host, _landed, why) => (why === 'unanswered'
    ? `${host} did not answer in time and the web archive holds no copy of the page; nothing was read.`
    : `${host} turned the reader away and the web archive holds no copy of the page; nothing was read.`),
  limit: (host) => `Not opened (${MAX_PAGES} pages already read in this check): ${host}`,
};

async function readOne(task, ctx) {
  const { subject } = ctx;
  const url = task.value;
  const empty = { findings: [], threads: [], notes: [] };
  if (!readable(url)) return empty;
  // every request made counts, whether or not it yielded a record
  const budget = pageBudget(ctx);
  if (budget.full()) return { ...empty, notes: [NOTE.limit(hostOf(url))] };
  const page = await openPage(url, ctx.deadline, { take: budget.take });
  if (page.status !== 'ok') return { ...empty, notes: NOTE[page.status] ? [NOTE[page.status](hostOf(url), page.landed, page.why)] : [] };
  const out = readPage(subject, { url, html: page.html, archived: page.archived || null, template: task.template });
  const what = page.archived?.why === 'unanswered' ? 'did not answer in time' : 'turned the reader away';
  const notes = page.archived ? [`${hostOf(url)} ${what}; its page was read from the web archive's copy of ${DAY(page.archived.date)}.`] : [];
  return { ...out, notes };
}

/** A site's about, team and leadership pages: those that exist, robots permitting, kept when they name the person. */
async function readSite(task, ctx) {
  const { subject } = ctx;
  const site = siteOf(task.value);
  const empty = { findings: [], threads: [], notes: [] };
  if (!site) return empty;
  const budget = pageBudget(ctx);
  const limitNote = `Not opened (${MAX_PAGES} pages already read in this check): the about and team pages of ${site}`;
  if (budget.full()) return { ...empty, notes: [limitNote] };
  const findings = [];
  const threads = [];
  const notes = [];
  let requests = 0;
  let kept = 0;
  for (const path of SITE_PATHS) {
    if (requests >= SITE_MAX_REQUESTS || kept >= SITE_MAX_KEPT) break;
    if (ctx.deadline && Date.now() > ctx.deadline - 3000) break;
    const url = `https://${site}${path}`;
    requests += 1;
    let page;
    // A guessed address that turns the reader away is left alone (the web archive's own lookup reads the
    // team pages' history); only pages the site serves are read here.
    try { page = await openPage(url, ctx.deadline, { archiveFallback: false, take: budget.take }); } catch { break; }
    if (page.status === 'limit') { if (!kept) notes.push(limitNote); break; }
    if (page.status === 'robots') continue;
    if (page.status === 'unknown') { notes.push(NOTE.unknown(site)); break; }
    if (page.status !== 'ok') continue;
    const out = readPage(subject, { url, html: page.html });
    if (!out.findings.length) continue;
    kept += 1;
    findings.push(...out.findings);
    threads.push(...out.threads);
  }
  return { findings, threads, notes };
}

export const pageReaderConnector = {
  id: ID,
  label: LABEL,
  kinds: ['url', 'domain'],
  prior: 0.72,
  // a page, and when it turns the reader away, the archive's copy of it
  timeoutMs: 38000,
  maxParallel: 3,
  plan(thread) {
    if (thread?.kind === 'domain') return siteOf(thread.value) ? [{ template: 'read.site', prior: 0.7, why: 'what the about, team and leadership pages of this site say about them' }] : [];
    return readable(thread?.value) ? [readPlanFor(thread)] : [];
  },
  async run(task, ctx) {
    return task.kind === 'domain' ? readSite(task, ctx) : readOne(task, ctx);
  },
};
