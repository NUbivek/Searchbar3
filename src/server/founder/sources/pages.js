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
import { addCompanyAlias } from '../identity';
import { companyKeys } from '../names';
import { cached, isCutShort } from '../cache';
import { makeFinding, makeThread, severityFromText } from '../finding';
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
// theorg.com: org charts are read from search snippets only (web.js q.profiles), never opened.
const NEVER = /(?:^|\.)(?:linkedin\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|threads\.net|youtube\.com|youtu\.be|reddit\.com|news\.google\.com|google\.com|bing\.com|duckduckgo\.com|archive\.org|wikipedia\.org|wikidata\.org|github\.com|crunchbase\.com|pitchbook\.com|theorg\.com|sec\.gov)$/i;
/** The most of a page that is read: a bio or an article is far shorter, and the text passes are linear in it. */
export const MAX_HTML_CHARS = 1000000;
const NOT_A_PAGE = /\.(?:pdf|docx?|pptx?|xlsx?|zip|png|jpe?g|gif|mp[34]|mov)(?:$|[?#])/i;

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

/**
 * A host that is not a public web site: an address written as numbers (IPv4 or IPv6), localhost, or a name
 * that only exists on a private network (.local, .internal, .localhost, .lan, .home.arpa). The http client also
 * refuses private addresses that a name resolves to; this keeps such links from being planned at all.
 */
function privateHost(u) {
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^\d+(?:\.\d+){0,3}$/.test(h) || /^0x[0-9a-f]+$/i.test(h) || h.includes(':')) return true;
  if (h === 'localhost' || /\.(?:localhost|local|internal|lan|intranet|corp|home\.arpa)$/.test(h) || !h.includes('.')) return true;
  // only the web's own ports
  return Boolean(u.port) && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'));
}

/** May this page be opened at all? */
export function readable(url) {
  const host = hostOf(url);
  if (!host || !/^https?:/i.test(url) || NEVER.test(host) || NOT_A_PAGE.test(url) || isBlockedUrl(url)) return false;
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (privateHost(u) || u.username || u.password) return false;
  const profile = profileFromUrl(url);
  return !profile || !['linkedin', 'x', 'github', 'facebook', 'instagram', 'crunchbase'].includes(profile.platform);
}

/** A site whose about and team pages may be read: a plain host name, never a social network or a people-search site. */
function siteOf(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  // a port other than the web's own is not a public site's about page
  const port = raw.match(/:(\d+)$/)?.[1];
  if (port && port !== '80' && port !== '443') return null;
  const v = raw.replace(/:\d+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) || /^[\d.]+$/.test(v)) return null;
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
  // The loader runs on its own deadline (cache.js gives it one): a robots file shared by several lookups is not
  // cut short, or remembered as failed, because the first caller's step was ending. This caller waits only
  // until its own deadline.
  const rules = await cached(`robots:${u.origin}`, 24 * 3600 * 1000, async ({ deadline: loadDeadline } = {}) => {
    try {
      // A robots file may redirect (to the https or www origin); never into a site the reader does not open.
      // Private addresses are refused by the http client on every hop.
      const text = await request(`${u.origin}/robots.txt`, {
        timeoutMs: 6000, deadline: loadDeadline || deadline, retries: 0, maxBytes: 512 * 1024,
        onHop: (next) => (NEVER.test(hostOf(next)) || isBlockedUrl(next) ? 'the robots file redirects to a site the reader never opens' : true),
      }).then((r) => r.text);
      return { text: String(text || '').slice(0, 200000) };
    } catch (error) {
      // No robots file (404 and the like) places no limit. Anything else (a timeout, a server error) is
      // thrown, so it is remembered for a few minutes only and the page is left alone meanwhile.
      if (error?.status >= 400 && error.status < 500 && error.status !== 429) return { text: '' };
      throw error;
    }
  }, { persist: false, deadline }).catch((error) => {
    // Cut short by the step's deadline, or the host is resting: that says nothing about the robots file, and
    // the page must not be dropped for the whole check as "could not be read". Thrown as an HttpError (onHop
    // passes those through as they are), so the lookup runs again in the next step or once the host is free.
    if (waitable(error)) throw asWaitable(error, `${u.origin}/robots.txt`);
    return null;
  });
  if (!rules) return 'unknown';
  return robotsAllow(parseRobots(rules.text), `${u.pathname}${u.search}`) ? 'allowed' : 'disallowed';
}

/** The error is a step running out of time, or a host asking to be left alone: the lookup should run again, not fail. */
export function waitable(error) {
  return Boolean(error) && (isCutShort(error) || error.code === 'resting' || Number(error.retryAt) > 0);
}
function asWaitable(error, url) {
  if (error instanceof HttpError) return error;
  return new HttpError(String(error?.message || 'Out of time'), {
    url, retryable: true, retryAt: Number(error?.retryAt) || null, code: error?.code === 'resting' ? 'resting' : 'deadline',
  });
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
  const found = await cached(`wayback-available:${target}`, 6 * 3600 * 1000, async ({ deadline: loadDeadline } = {}) => {
    const data = await getJson(`https://archive.org/wayback/available?url=${encodeURIComponent(target)}`, { timeoutMs: 10000, deadline: loadDeadline || deadline, retries: 0 });
    const c = data?.archived_snapshots?.closest;
    return c && c.available && String(c.status) === '200' && /^\d{14}$/.test(String(c.timestamp)) ? { timestamp: String(c.timestamp) } : { timestamp: null };
  }, { persist: false, deadline });
  if (!found?.timestamp) return null;
  const ts = found.timestamp;
  if (!take()) throw new PageLimit();
  // The archive's copy redirects to the nearest capture, always within web.archive.org; anything else is not followed.
  const response = await request(`https://web.archive.org/web/${ts}id_/${target}`, {
    timeoutMs: PAGE_TIMEOUT_MS, deadline, retries: 0, maxBytes: 3 * 1024 * 1024, accept: 'text/html,application/xhtml+xml',
    onHop: (next) => (hostOf(next) === 'web.archive.org' ? true : 'the web archive sent the reader to another site'),
  });
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
  // Every redirect hop is judged before it is opened (http.js asks onHop): never a social network or a
  // people-search site, never a private address (http.js), and only where robots.txt allows this reader.
  // The first address was judged above.
  const sameSite = (next) => hostOf(next) === hostOf(url);
  const onHop = async (next, { hop }) => {
    if (hop === 0) return true;
    if (!readable(next)) return 'leads to a site the reader never opens';
    const v = await robotsVerdict(next, deadline);
    if (v === 'allowed') return true;
    return v === 'disallowed' ? 'robots.txt does not allow it' : 'its robots file could not be read';
  };
  let response;
  try {
    response = await request(url, { timeoutMs: PAGE_TIMEOUT_MS, deadline, retries: 0, maxBytes: 3 * 1024 * 1024, accept: 'text/html,application/xhtml+xml', onHop });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    // A redirect the reader turned down, or an address that is not public: nothing was sent there, and the
    // archive is not asked for a copy of a page the reader may not read.
    if (error.code === 'refused') {
      const landed = error.hopUrl || url;
      if (sameSite(landed)) return { status: /robots\.txt does not/.test(String(error.message)) ? 'robots' : /could not be read/.test(String(error.message)) ? 'unknown' : 'elsewhere', landed };
      return { status: 'elsewhere', landed };
    }
    if (error.code === 'blocked') return error.hopUrl && error.hopUrl !== url ? { status: 'elsewhere', landed: error.hopUrl } : { status: 'missing' };
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
  // A file that is not a web page (a PDF, an image) is not read as one.
  const type = String((typeof response.headers?.get === 'function' ? response.headers.get('content-type') : response.headers?.['content-type']) || '').toLowerCase();
  if (type && !/html|xml|text\/plain/.test(type)) return { status: 'not-page', type: type.split(';')[0].trim() };
  // Backstop: the landed address is judged again (a transport that followed redirects on its own).
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
 * A cookie-consent page, a sign-in or subscription wall served in place of the article (HTTP 200): what is
 * read there is the wall, not the page. Judged on the visible text: short, and saying what a wall says.
 */
const WALL_WORDS = /\b(?:subscribe to (?:continue|read)|subscribers? only|to continue reading|already a subscriber|create a free account to|sign in to (?:continue|read)|log in to (?:continue|read)|we value your privacy|cookie (?:settings|preferences|consent)|accept all cookies|manage (?:your )?(?:privacy|cookie) (?:settings|choices)|before you continue|your privacy choices|paywall)\b/i;
export function isWallPage(html) {
  const text = pageText(String(html || '').slice(0, MAX_HTML_CHARS));
  return WALL_WORDS.test(text) && text.replace(/\s+/g, ' ').length < 6000;
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

/** The page's <title>, found with two plain searches (no pattern that backtracks over the whole page). */
const pageTitle = (html) => {
  const h = String(html);
  const lower = h.toLowerCase();
  let at = lower.indexOf('<title');
  // "<titlebar>" and the like are not the title element
  while (at >= 0 && !/[\s>]/.test(lower[at + 6] || '')) at = lower.indexOf('<title', at + 6);
  if (at < 0) return '';
  const open = lower.indexOf('>', at);
  if (open < 0) return '';
  const close = lower.indexOf('</title', open);
  if (close < 0) return '';
  return htmlToText(h.slice(open + 1, Math.min(close, open + 2000))).slice(0, 160);
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
export function readPage(subject, { url, html: rawHtml, archived = null, template = 'read' }) {
  const empty = { findings: [], threads: [] };
  // A page larger than any bio or article is read up to MAX_HTML_CHARS: every pass below is linear in it
  const html = String(rawHtml || '').slice(0, MAX_HTML_CHARS);
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
  // Where each sentence sits on the page: a quote reads in the page's order (the kept sentences are ranked, what
  // they did before first, only to choose which are kept).
  const pageOrder = sentencesOf(allText);
  const posOf = (t) => { const i = pageOrder.indexOf(t); return i >= 0 ? i : pageOrder.length + Math.max(0, allText.indexOf(t)); };
  // On a page about them, their first name alone names them too (the rule bioSentences reads them by)
  const fullFirst = aboutThem ? firstNameAsFull(subject) : (x) => x;
  const namesThem = (x) => subject.hasName(x) || subject.hasName(fullFirst(x));
  for (const kind of ['career', 'education']) {
    const chosen = sentences.filter((s) => s.kind === kind).slice(0, kind === 'career' ? 8 : 3).map((s) => s.text);
    // A "She/He" sentence reads with the sentence naming the person before it: that sentence joins this record
    // (from the page, within two sentences back), or the pronoun sentence is left out rather than stand alone.
    const texts = [];
    for (const t of [...chosen].sort((a, b) => posOf(a) - posOf(b))) {
      if (PRONOUN_LEAD.test(t) && !namesThem(t) && !texts.some((x) => namesThem(x) && posOf(x) < posOf(t))) {
        const at = pageOrder.indexOf(t);
        const lead = at > 0 ? pageOrder.slice(Math.max(0, at - 2), at).reverse().find((x) => namesThem(x) && !tellsAnother(subject, x)) : null;
        if (!lead) continue;
        if (!texts.includes(lead)) texts.push(lead);
      }
      if (!texts.includes(t)) texts.push(t);
    }
    texts.sort((a, b) => posOf(a) - posOf(b));
    if (!texts.length) continue;
    const quote = texts.join(' ');
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
  'not-page': (host) => `${host} answered with a file that is not a web page; it was not read.`,
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
  let out = readPage(subject, { url, html: page.html, archived: page.archived || null, template: task.template });
  const what = page.archived?.why === 'unanswered' ? 'did not answer in time' : 'turned the reader away';
  const notes = page.archived ? [`${hostOf(url)} ${what}; its page was read from the web archive's copy of ${DAY(page.archived.date)}.`] : [];
  if (out.findings.length) return { ...out, notes };
  // A consent or subscription wall served in place of the page (HTTP 200) is not the page: the archive's copy
  // usually holds the article. Tried only for a page the check tied to the person, while the limit allows.
  const host = hostOf(url);
  if (!page.archived && isWallPage(page.html)) {
    let copy = null;
    let failed = false;
    if (ctx.deadline && ctx.deadline - Date.now() < ARCHIVE_MIN_MS) failed = true;
    else {
      try { copy = await archivedCopy(url, ctx.deadline, { take: budget.take }); } catch { failed = true; }
    }
    if (copy) {
      out = readPage(subject, { url, html: copy.html, archived: { date: copy.date, replay: copy.replay, why: 'wall' }, template: task.template });
      if (out.findings.length) return { ...out, notes: [`${host} showed a consent or subscription page; the page was read from the web archive's copy of ${DAY(copy.date)}.`] };
    }
    return { ...empty, notes: [failed
      ? `${host} showed a consent or subscription page instead of the article, and the web archive could not be checked; the page could not be read.`
      : `${host} showed a consent or subscription page instead of the article${copy ? ', and the web archive\'s copy says nothing about them either' : ' and the web archive holds no copy'}; the page could not be read.`] };
  }
  // Opened, but nothing on it is about the person: said, so an empty result is not read as a clean page.
  return { ...empty, notes: [...notes, `${host}: the page was opened but says nothing about ${subject.name}'s career or education that could be kept.`] };
}

/**
 * The company's legal name as its own site states it in the footer ("© 2024 Merge API, Inc. All rights
 * reserved."). Taken only when the name begins with the company's own name, so a hosting provider's or a
 * parent's footer is not read as the company's.
 * @returns {string} '' when the page states none
 */
const LEGAL_FORM = '(?:Inc\\.?|Incorporated|LLC|L\\.L\\.C\\.|Ltd\\.?|Limited|Corp\\.?|Corporation|PBC|GmbH|AG|S\\.A\\.S\\.?|SAS|S\\.A\\.|B\\.V\\.|N\\.V\\.|Pty\\.? Ltd\\.?|Pte\\.? Ltd\\.?|plc|PLC|Co\\.)';
const FOOTER_NAME = new RegExp(`(?:©|&copy;|\\(c\\)|Copyright)\\s*(?:(?:19|20)\\d{2}\\s*(?:[-–]\\s*(?:(?:19|20)\\d{2}|present)\\s*)?)?,?\\s*([A-Z][A-Za-z0-9&.'’ -]{0,60}?,?\\s${LEGAL_FORM})(?=[\\s.,;|]|$)`, 'g');
export function legalNameFromFooter(html, company) {
  const text = htmlToText(String(html || '').slice(-200000)); // the footer is at the end
  const key = (companyKeys(company)[0] || '').replace(/\s+/g, '');
  if (!key) return '';
  for (const m of text.matchAll(FOOTER_NAME)) {
    const name = m[1].replace(/\s+/g, ' ').trim();
    const own = (companyKeys(name)[0] || name.toLowerCase()).replace(/\s+/g, '');
    if (own.startsWith(key)) return name.replace(/\s+(?:All rights.*)$/i, '');
  }
  return '';
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
  // The company's own site (its first label is the company's name, as web.js hands it on): its footer gives the
  // legal name, which registers, filings and trademarks are searched by (an ordinary word alone finds namesakes).
  const company = ownCompanyOf(subject, site);
  let legal = '';
  let legalAt = '';
  // Each path is judged on its own: one page that fails does not stop the others from being asked, and what
  // could not be read is said, so a failed read never looks like a site with nothing about the person.
  let settled = 0; // paths that got an answer (read, missing, closed by robots ...)
  const failed = []; // paths that could not be read, with why
  let cut = false;
  for (const path of SITE_PATHS) {
    if (requests >= SITE_MAX_REQUESTS || kept >= SITE_MAX_KEPT) break;
    if (ctx.deadline && Date.now() > ctx.deadline - 3000) {
      // Out of time before any page answered: handed back as cut short, so the step loop runs it again.
      if (!settled) throw new HttpError(`Out of time before the about and team pages of ${site} could be read`, { url: `https://${site}`, retryable: true, code: 'deadline' });
      cut = true;
      break;
    }
    const url = `https://${site}${path}`;
    requests += 1;
    let page;
    // A guessed address that turns the reader away is left alone (the web archive's own lookup reads the
    // team pages' history); only pages the site serves are read here.
    try {
      page = await openPage(url, ctx.deadline, { archiveFallback: false, take: budget.take });
    } catch (error) {
      if (waitable(error)) {
        // Nothing read yet: the whole lookup waits for the next step or for the host (retryAt). Something read:
        // the rest of the host is just as unavailable now, so stop and say what was not read.
        if (!settled) throw error;
        failed.push({ path, why: 'out of time' });
        cut = true;
        break;
      }
      // A 403, a server error, a reset: this page could not be read; the next path is still asked.
      failed.push({ path, why: error?.status ? `HTTP ${error.status}` : 'no answer' });
      continue;
    }
    settled += 1;
    if (page.status === 'limit') { if (!kept) notes.push(limitNote); break; }
    if (page.status === 'robots') continue;
    if (page.status === 'unknown') { notes.push(NOTE.unknown(site)); break; }
    if (page.status !== 'ok') continue;
    if (!legal && company) {
      legal = legalNameFromFooter(page.html, company);
      if (legal) legalAt = url;
    }
    const out = readPage(subject, { url, html: page.html });
    if (!out.findings.length) continue;
    kept += 1;
    findings.push(...out.findings);
    threads.push(...out.threads);
  }
  // Every page asked failed: the lookup failed, and is reported as failed (never as a site read with nothing found).
  if (failed.length && !settled) {
    throw new HttpError(`The about and team pages of ${site} could not be read (${failed.map((f) => `${f.path}: ${f.why}`).join('; ')})`, { url: `https://${site}`, retryable: true });
  }
  if (failed.length) notes.push(`Some about and team pages of ${site} could not be read (${failed.map((f) => `${f.path}: ${f.why}`).join('; ')}); what they say is not in this report.`);
  else if (cut) notes.push(`Time ran out before all the about and team pages of ${site} were read; what the others say is not in this report.`);
  if (legal) {
    const record = makeFinding(subject, {
      source: ID, sourceLabel: LABEL, category: 'corporate',
      title: `Legal name on ${site}: ${legal}`,
      quote: `The site's own footer names the company ${legal}.`,
      url: legalAt, severity: 'info', match: 'company', matchReasons: [`the website of ${company}`],
      data: { kind: 'legal-name', company, legalName: legal, domain: site },
    });
    if (record) {
      findings.push(record);
      // A known name of the company from now on: the loop asks registers, filings and trademarks again under it.
      addCompanyAlias(subject, { company, alias: legal, origin: record.id });
      addCompanyAlias(subject, { company, alias: site, origin: record.id });
      const t = makeThread('company', legal, `legal name of ${company}, from its website`, { trusted: true });
      if (t) threads.push(t);
    }
  }
  return { findings, threads, notes };
}

/** The subject's company whose own site this is (its first label is the company's name), or ''. */
function ownCompanyOf(subject, site) {
  const label = site.split('.')[0].replace(/[^a-z0-9]/g, '');
  const names = [subject.company, ...[...(subject.anchors?.companies?.values?.() || [])].filter((a) => a.origin === 'given').map((a) => a.value)].filter(Boolean);
  for (const n of names) {
    const k = (companyKeys(n)[0] || '').replace(/[^a-z0-9]/g, '');
    if (k.length >= 3 && [k, `${k}hq`, `get${k}`, `${k}app`, `try${k}`].includes(label)) return n;
  }
  return '';
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
