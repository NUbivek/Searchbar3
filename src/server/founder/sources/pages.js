/**
 * Page reader: opens a page that is about the person (a team or bio page,
 * a personal site, a profile or interview a search found) and keeps the
 * sentences about their career and education.
 *
 * A search result carries two lines of a page; the page itself says where
 * they studied and worked. Only pages the check already tied to the person
 * are opened, one request each, identified as an automated reader, and only
 * when the site's robots.txt allows it. Social networks (LinkedIn, X,
 * Facebook, Instagram) are never opened: they do not permit automated
 * reading. Their public profile lines come from search results instead.
 */
import { getText, request, htmlToText } from '../http';
import { cached } from '../cache';
import { makeFinding, severityFromText } from '../finding';
import { threadsFromResult, profileFromUrl } from '../extract';
import { isBlockedUrl } from '../guardrails';
import { bioSentences } from '../profile';

const ID = 'page-reader';
/** The name this reader answers to in a robots.txt (the product token of the User-Agent it sends). */
const READER_TOKEN = 'diligence-research';
const LABEL = 'Bio and interview pages';
/** Pages read per check. */
export const MAX_PAGES = 10;
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

async function allowedByRobots(url, deadline) {
  const u = new URL(url);
  const rules = await cached(`robots:${u.origin}`, 24 * 3600 * 1000, async () => {
    try {
      const text = await getText(`${u.origin}/robots.txt`, { timeoutMs: 6000, deadline, retries: 0, maxBytes: 512 * 1024 });
      return { text: String(text || '').slice(0, 200000) };
    } catch (error) {
      // No robots file (404 and the like) places no limit. Anything else (a timeout, a server error) is
      // thrown, so it is remembered for a few minutes only and the page is left alone meanwhile.
      if (error?.status >= 400 && error.status < 500 && error.status !== 429) return { text: '' };
      throw error;
    }
  }, { persist: false }).catch(() => null);
  if (!rules) return false;
  return robotsAllow(parseRobots(rules.text), `${u.pathname}${u.search}`);
}

const pageTitle = (html) => {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 160) : '';
};

export const pageReaderConnector = {
  id: ID,
  label: LABEL,
  kinds: ['url'],
  prior: 0.72,
  timeoutMs: 20000,
  maxParallel: 3,
  plan(thread) {
    return readable(thread.value) ? [{ template: 'read', prior: 0.72, why: 'what this page says about their career and education' }] : [];
  },
  async run(task, ctx) {
    const { subject } = ctx;
    const url = task.value;
    const empty = { findings: [], threads: [], notes: [] };
    if (!readable(url)) return empty;
    // every page opened counts, whether or not it yielded a record
    const read = new Set((ctx.done ? ctx.done() : []).filter((k) => String(k).startsWith(`${ID}|`)).map((k) => String(k).split('|')[2]));
    if (read.size >= MAX_PAGES && !read.has(url)) return { ...empty, notes: [`Not opened (${MAX_PAGES} pages already read in this check): ${hostOf(url)}`] };
    if (!(await allowedByRobots(url, ctx.deadline))) return { ...empty, notes: [`${hostOf(url)} does not allow automated reading of this page; it was not opened.`] };

    const response = await request(url, { timeoutMs: 15000, deadline: ctx.deadline, retries: 0, maxBytes: 3 * 1024 * 1024, accept: 'text/html,application/xhtml+xml' });
    // A link that lands somewhere else is judged again where it landed: never a social network or a
    // people-search site, and only where that site allows automated reading.
    const landed = response.url || url;
    if (hostOf(landed) !== hostOf(url) && (!readable(landed) || !(await allowedByRobots(landed, ctx.deadline)))) {
      return { ...empty, notes: [`${hostOf(url)} sent the reader to ${hostOf(landed)}, which is not read; nothing was kept.`] };
    }
    const html = response.text;
    const title = pageTitle(html);
    const text = htmlToText(html);
    // The page must name the person; a page that does not is not about them, whatever linked to it.
    if (!subject.hasName(`${title}\n${text}`)) return empty;
    // About them: their name is in the page's own title, or the page names them again and again.
    const namings = text.split(/\n+/).filter((line) => subject.hasName(line)).length;
    const aboutThem = subject.hasName(title) || namings >= 3;
    const sentences = bioSentences(subject, text, { aboutThem });
    const naming = sentences.find((s) => subject.hasName(s.text))?.text || '';
    if (!sentences.length) return empty;

    const host = hostOf(url);
    const findings = [];
    for (const kind of ['career', 'education']) {
      const mine = sentences.filter((s) => s.kind === kind).slice(0, kind === 'career' ? 6 : 3);
      if (!mine.length) continue;
      const quote = mine.map((s) => s.text).join(' ');
      const finding = makeFinding(subject, {
        source: ID, sourceLabel: LABEL, category: kind,
        title: `${kind === 'career' ? 'Career' : 'Education'}, as told on ${host}${title ? `: ${title}` : ''}`,
        quote: quote.slice(0, 690),
        // graded on the page's own title and these sentences, which name the person
        matchText: `${title}\n${naming}\n${quote}`,
        url,
        severity: severityFromText(quote, subject),
        data: { kind: 'bio', page: url },
      });
      if (finding) findings.push(finding);
    }
    const trusted = findings.some((f) => f.match === 'confirmed' || f.match === 'likely');
    const threads = findings.length
      ? threadsFromResult(subject, { title, snippet: sentences.map((s) => s.text).join(' ').slice(0, 2500), url }, { trusted }).filter((t) => t.kind !== 'url')
      : [];
    return { findings, threads, notes: [] };
  },
};
