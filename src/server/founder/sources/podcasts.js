/**
 * Podcast episodes that name the person: interviews in their own words, and
 * investigative or news episodes about them. One source:
 *
 *   podcast-episodes  Apple's podcast directory search (itunes.apple.com/search,
 *                     media=podcast, entity=podcastEpisode). One search for the
 *                     person's full name with their company, and one for the
 *                     full name alone. The answer gives each episode's title,
 *                     show, release date, description and page link.
 *
 * Off by default. The search service is documented and needs no account, but
 * the host's robots.txt disallows the /search path, so the owner must turn it
 * on deliberately: FOUNDER_SOURCES_ON (comma-separated ids) must contain
 * 'podcast-episodes'. FOUNDER_SOURCES_OFF still switches it off. The service
 * asks for about 20 calls a minute; this file spaces its calls 3.1 seconds
 * apart and the connector runs one lookup at a time.
 *
 * Which episodes count. Only the episode's own title and description are read
 * (the show's name is not: a show hosted by a namesake names them in every
 * episode). An episode counts only when that text names the person in full.
 * When the person's surname is a very common one, or their company's name is
 * a single word once the legal form is set aside, the text must also name a
 * company known to be theirs; otherwise a namesake cannot be told apart. (A
 * common name with no company known therefore finds nothing.)
 *
 * Grades. No episode is ever 'confirmed': a description is a show's own
 * summary, not a record. The strongest grade is 'likely', and only when the
 * same text names the person and a second fact already tied to them (their
 * company, a school, a co-founder, a handle). The full name alone stays
 * 'possible', with "name match only, verify identity" in the title. Grades are
 * fixed here, so a later re-grade cannot lift one to 'confirmed'.
 *
 * Never kept: audio and preview links, artwork, the feed address, the show's
 * artist ids. Description sentences that the privacy rules reject (health,
 * religion, children, immigration and so on) are left out of the quote, and
 * contact details are removed from what is kept.
 *
 * Search results are about the person, so they are not put in the shared
 * cache (cache.js holds public reference data only).
 */
import { getJson, HttpError } from '../http';
import { makeFinding, severityFromText } from '../finding';
import { matchSubject, nameTokens, companyKeyStrict } from '../identity';
import { isSensitive, mentionsMinor, redactPII } from '../guardrails';
import { person, namesPerson } from './courts';

export const PODCASTS_ID = 'podcast-episodes';
const LABEL = 'Podcast episodes (Apple Podcasts directory)';
const SEARCH = 'https://itunes.apple.com/search';
export const RESULT_LIMIT = 25;
const MAX_FINDINGS = 10;
const GAP_MS = 3100; // about 20 calls a minute, as the service asks

/* ------------------------------------------------------------------ switches */

const listed = (name, id) => String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean).includes(id);
const isOn = () => listed('FOUNDER_SOURCES_ON', PODCASTS_ID) && !listed('FOUNDER_SOURCES_OFF', PODCASTS_ID);

/* ------------------------------------------------------------------ pacing */

const nextSlot = new Map();
let pacing = true;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitTurn(url, deadline) {
  if (!pacing) return;
  const host = new URL(url).hostname;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  if (deadline && at + 2000 > deadline) throw new HttpError('Out of time before the request could start', { url, retryable: true });
  nextSlot.set(host, at + GAP_MS);
  if (at > now) await sleep(at - now);
}

/** For tests: turn the spacing off (true) or back on (false), and forget earlier turns. */
export function __resetPodcastsForTests({ unpaced = true } = {}) {
  pacing = !unpaced;
  nextSlot.clear();
}

/* ------------------------------------------------------------------ text */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const ENTITIES = { amp: '&', quot: '"', apos: "'", '#39': "'", lt: '<', gt: '>', nbsp: ' ' };
const plain = (s) => clean(String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|quot|apos|#39|lt|gt|nbsp);/g, (m, k) => ENTITIES[k])
  .replace(/https?:\/\/\S+/g, ' '));
const sentences = (s) => plain(s).split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).map(clean).filter(Boolean);
/** A sentence the privacy rules would reject is dropped; contact details in the rest are removed. */
const safe = (s) => (isSensitive(s) || mentionsMinor(s) ? '' : clean(redactPII(s)));
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);
// Show boilerplate that says nothing about the episode
const BOILERPLATE = /\b(?:privacy policy|privacy notice|do-not-sell|ad choices|adchoices|learn more about your ad|hosted on|listen ad-free|subscribe (?:to|on)|patreon\.com|sponsored by|use code|promo code)\b/i;

/* ------------------------------------------------------------------ names */

// The most frequent surnames in the US census, and a few that are as frequent worldwide. A full name with one of
// these is shared by many people, so an episode must also name the person's company. Data, kept short.
const COMMON_SURNAMES = new Set(`smith johnson williams brown jones garcia miller davis rodriguez martinez hernandez lopez gonzalez
wilson anderson thomas taylor moore jackson martin lee perez thompson white harris sanchez clark ramirez lewis robinson walker
young allen king wright scott torres nguyen hill flores green adams nelson baker hall rivera campbell mitchell carter roberts
gomez phillips evans turner diaz parker cruz edwards collins reyes stewart morris morales murphy cook rogers gutierrez ortiz
morgan cooper peterson bailey reed kelly howard ramos kim cox ward richardson watson brooks chavez wood james bennett gray
mendoza ruiz hughes price alvarez castillo sanders patel myers long ross foster jimenez
wang li zhang liu chen yang huang zhao wu zhou xu sun ma zhu hu guo lin he gao luo
singh kumar sharma khan shah ali ahmed park choi jung kang cho yoon tran le pham silva santos oliveira pereira ferreira
muller schmidt schneider fischer weber meyer wagner becker`.split(/\s+/).filter(Boolean));

/** A name many people carry: a very frequent surname, or a surname of two letters or fewer. */
export function isCommonName(name) {
  const t = nameTokens(name);
  if (t.length < 2) return true;
  const surname = t[t.length - 1];
  return surname.length <= 2 || COMMON_SURNAMES.has(surname);
}

/** True when the company's name is one word once the legal form is set aside (or there is none). */
const oneWordCompany = (company) => companyKeyStrict(company).split(' ').filter(Boolean).length < 2;

/* ------------------------------------------------------------------ the search */

/** The search request for a term. */
export const searchUrl = (term) => `${SEARCH}?${new URLSearchParams({ term, media: 'podcast', entity: 'podcastEpisode', limit: String(RESULT_LIMIT) }).toString()}`;

/** The episode page link, without the referral parameter; null when it is not an Apple Podcasts page. */
function episodeLink(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:' || !/(?:^|\.)podcasts\.apple\.com$|(?:^|\.)itunes\.apple\.com$/.test(u.hostname)) return null;
    u.searchParams.delete('uo');
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Read the search answer into compact episodes: title, show, date, description and page link. Nothing else is
 * read (no audio, preview, artwork or feed links). An answer that is not the expected shape throws, so the lookup
 * is reported as failed and never as "no episodes".
 */
export function parseEpisodes(body, url = SEARCH) {
  if (!body || typeof body !== 'object' || !Number.isFinite(Number(body.resultCount)) || !Array.isArray(body.results)) {
    throw new HttpError('The podcast directory returned an answer in an unexpected format', { url });
  }
  if (Number(body.resultCount) > 0 && body.results.length === 0) throw new HttpError('The podcast directory reported results but sent none', { url });
  const episodes = [];
  for (const r of body.results) {
    if (!r || typeof r !== 'object') continue;
    if (r.wrapperType && r.wrapperType !== 'podcastEpisode' && r.kind !== 'podcast-episode') continue;
    const title = plain(r.trackName);
    const link = episodeLink(r.trackViewUrl);
    if (!title || !link) continue;
    const date = /^\d{4}-\d{2}-\d{2}/.test(String(r.releaseDate || '')) ? String(r.releaseDate).slice(0, 10) : null;
    const description = plain(r.description || r.shortDescription || '').slice(0, 4000);
    episodes.push({ title, show: plain(r.collectionName), date, description, url: link });
  }
  if (body.results.length > 0 && episodes.length === 0) {
    throw new HttpError('The podcast directory answered, but no episode had a title and page link (its format may have changed)', { url });
  }
  return episodes;
}

async function search(term, ctx) {
  const url = searchUrl(term);
  await waitTurn(url, ctx.deadline);
  // The service answers with "text/javascript"; getJson parses the body whatever the declared type.
  const body = await getJson(url, { deadline: ctx.deadline, timeoutMs: 12000, maxBytes: 2 * 1024 * 1024 });
  return { episodes: parseEpisodes(body, url), full: Array.isArray(body.results) && body.results.length >= RESULT_LIMIT };
}

/* ------------------------------------------------------------------ reading one episode */

// The person speaks on the episode: an interview, a conversation, a guest appearance.
const INTERVIEW = /\b(?:interview(?:s|ed)?|in conversation|conversation with|joins (?:us|me|the show|the podcast)|sits? down with|sat down with|talks? (?:with|to)|chats? with|speaks? with|our guest|my guest|guest(?:s)? (?:is|are|this week)|with (?:founder|ceo|co-?founder)|founder (?:and|&) ceo)\b/i;

/** Which sentences of the description to quote: those naming the person or the company, else the first ones. */
function quoteOf(ep, who, subject) {
  const named = [];
  const rest = [];
  for (const s of sentences(ep.description)) {
    if (BOILERPLATE.test(s)) continue;
    const kept = safe(s);
    if (!kept) continue;
    if (namesPerson(kept, who) || matchSubject(subject, `${subject.name}. ${kept}`).level === 'confirmed') named.push(kept);
    else rest.push(kept);
  }
  return clip([...named, ...rest].slice(0, 3).join(' '), 600);
}

/**
 * Grade one episode. Returns null when it does not count (the full name is not in its own title or description,
 * or a company is needed and not named), else the grade fields for makeFinding.
 */
export function gradeEpisode(subject, ep, { needsCompany }) {
  const who = person(subject);
  const text = `${ep.title}\n${ep.description}`;
  if (!namesPerson(ep.title, who) && !namesPerson(ep.description, who)) return null;
  const graded = matchSubject(subject, text, { date: ep.date });
  if (graded.level === 'none') return null;
  const company = graded.level === 'confirmed';
  if (needsCompany && !company) return null;
  if (graded.level === 'confirmed' || graded.level === 'likely') {
    return { match: 'likely', matchReasons: [`the episode names the person with ${graded.reasons.map((r) => r.replace(/^names\s+/, '')).slice(0, 2).join(' and ') || 'a fact already tied to them'}`, 'a show\'s own description, so at most likely'], company };
  }
  return { match: 'possible', matchReasons: ['matched by name only: the episode names the person but nothing else tied to them, so verify identity'], company };
}

function episodeFinding(subject, ep, grade) {
  const who = person(subject);
  const interview = INTERVIEW.test(`${ep.title} ${ep.description.slice(0, 600)}`);
  const year = (ep.date || '').slice(0, 4);
  const where = [ep.show && ep.show !== ep.title ? ep.show : '', year].filter(Boolean).join(', ');
  const base = `${interview ? 'Podcast interview' : 'Podcast episode'}: ${ep.title}${where ? ` (${where})` : ''}`;
  const title = grade.match === 'possible' ? `${base}: name match only, verify identity` : base;
  const quote = quoteOf(ep, who, subject);
  const severity = severityFromText(`${ep.title}. ${quote}`, subject);
  return makeFinding(subject, {
    source: PODCASTS_ID, sourceLabel: LABEL, category: 'press',
    title, quote, url: ep.url, date: ep.date, severity,
    match: grade.match, matchReasons: grade.matchReasons,
    data: { show: ep.show || null, kind: interview ? 'interview' : 'about', namesCompany: grade.company },
  });
}

/* ------------------------------------------------------------------ the connector */

const RANK = { likely: 2, possible: 1 };

export const podcastEpisodesConnector = {
  id: PODCASTS_ID,
  label: LABEL,
  kinds: ['subject'],
  prior: 0.3,
  maxParallel: 1,
  timeoutMs: 20000,
  enabled: () => isOn(),
  unavailableReason: 'Podcast episode search is not enabled on this deployment.',
  plan(thread, subject) {
    if (thread.kind !== 'subject') return [];
    const plans = [];
    if (clean(subject?.company)) plans.push({ template: 'podcasts:name-company', params: { withCompany: true }, prior: 0.35, why: 'podcast episodes naming the person with their company' });
    plans.push({ template: 'podcasts:name', params: { withCompany: false }, prior: 0.2, why: 'podcast episodes naming the person' });
    return plans;
  },
  async run(task, ctx) {
    const subject = ctx.subject;
    const name = clean(subject?.name || task.value);
    const company = clean(subject?.company);
    if (nameTokens(name).length < 2) {
      return { findings: [], threads: [], notes: [`Podcast episodes: "${name}" is not a full name, so episodes could not be searched.`], partial: ['name too short to search'] };
    }
    const withCompany = Boolean(task.params?.withCompany) && Boolean(company);
    const term = withCompany ? `${name} ${company}` : name;
    const common = isCommonName(name);
    const needsCompany = common || (Boolean(company) && oneWordCompany(company));
    const why = common ? `${name} is a common name` : `${company} is a one-word name`;
    const notes = [];
    const { episodes, full } = await search(term, ctx);
    if (!episodes.length) {
      notes.push(`Podcast episodes: searched Apple's podcast directory for "${term}" and it returned no episodes.`);
      return { findings: [], threads: [], notes };
    }
    const kept = [];
    let nameOnlyDropped = 0;
    for (const ep of episodes) {
      const grade = gradeEpisode(subject, ep, { needsCompany });
      if (!grade) {
        if (needsCompany && gradeEpisode(subject, ep, { needsCompany: false })) nameOnlyDropped += 1;
        continue;
      }
      kept.push({ ep, grade });
    }
    kept.sort((a, b) => (RANK[b.grade.match] - RANK[a.grade.match]) || String(b.ep.date || '').localeCompare(String(a.ep.date || '')));
    const findings = [];
    for (const { ep, grade } of kept.slice(0, MAX_FINDINGS)) {
      const f = episodeFinding(subject, ep, grade);
      if (f) findings.push(f);
    }
    if (!kept.length) {
      notes.push(`Podcast episodes: searched Apple's podcast directory for "${term}"; none of the ${episodes.length} episodes returned names ${name} in its own title or description${needsCompany ? ` together with ${company || 'a company known to be theirs'}` : ''}.`);
    } else {
      notes.push(`Podcast episodes: searched Apple's podcast directory for "${term}"; ${kept.length} of ${episodes.length} episodes name ${name}${kept.length > MAX_FINDINGS ? `; the ${MAX_FINDINGS} most recent of the strongest are kept` : ''}.`);
    }
    if (nameOnlyDropped) notes.push(`${nameOnlyDropped} more episode${nameOnlyDropped === 1 ? ' names' : 's name'} ${name} without naming the company and ${nameOnlyDropped === 1 ? 'was' : 'were'} left out, because ${why} and a namesake could not be ruled out.`);
    if (full) notes.push(`Only the ${RESULT_LIMIT} most relevant episodes the directory returned were read; there may be more.`);
    return { findings, threads: [], notes };
  },
};
