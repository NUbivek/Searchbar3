/**
 * The person's own public professional footprint, beyond GitHub, Hacker News
 * and Keybase (profiles.js) and ORCID, Crossref and OpenAlex (scholar.js).
 *
 *   semantic-scholar  Semantic Scholar author records: papers, citations and
 *                     h-index under the person's full name, and the
 *                     affiliations the record states.
 *   stack-overflow    Stack Overflow accounts under the person's full name, or
 *                     the exact account a record tied to them links to.
 *   npm-packages      the software packages an npm account maintains, for a
 *                     handle already tied to the person.
 *   bluesky           Bluesky profiles: the exact account a record tied to the
 *                     person links to (with its recent posts that name their
 *                     company or report a dispute), the same handle on
 *                     Bluesky, and accounts found by name (namesakes possible).
 *   mastodon          a Mastodon profile on its own server, for a handle or
 *                     link already tied to the person, with the links the
 *                     account has proven to control.
 *   writing-feeds     posts on a Medium or Substack page a record tied to the
 *                     person links to, read from the page's public feed.
 *
 * Every source here answers without an account or sign-up. Pages that are not
 * services built for programs (Mastodon servers, writing feeds) are opened
 * only when their robots.txt allows this reader.
 *
 * Whose account is it? What a profile says (name, bio) is the owner's own
 * claim, and every title says so. An account found by searching a name is
 * kept only when it states the person's full name, and stays 'possible' unless
 * the grade (makeFinding) finds a known company or site of theirs in what the
 * account says; on Bluesky a name search never goes above 'possible'. An
 * account reached through the exact link or handle a record tied to the person
 * gives is 'likely'. The same handle on another service is not, by itself, the
 * same person: it is kept only when it states the person's name or proves a
 * link to something already known to be theirs. No source sets 'confirmed' by
 * hand. E-mail addresses, locations and similar on a profile are never read.
 */
import { getJson, getText, htmlToText, HttpError } from '../http';
import { makeFinding, makeThread, severityFromText } from '../finding';
import { profileFromUrl } from '../extract';
import { nameTokens, matchSubject } from '../identity';
import { cleanSentences } from '../guardrails';
import { personNameFits, namesakeOrgs, maskOrgs } from './scholar';
import { parseRobots, robotsAllow } from './pages';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const count = (n) => Number(n || 0).toLocaleString('en-US');
/** Only the sentences the privacy rules reject are left out; contact details in what is kept are removed. */
const safe = (s) => clean(cleanSentences(clean(s)).text);
const EMPTY = () => ({ findings: [], threads: [], notes: [] });
const day = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const t = typeof value === 'number' ? value * 1000 : Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const hostOf = (url) => { try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const MATCH_RANK = { confirmed: 3, likely: 2, company: 2, possible: 1 };

/* ------------------------------------------------------ whose account is it */

/**
 * The name an account states, against the subject's: 'same' (the full name),
 * 'other' (a different family name) or 'unknown' (none, a first name only, or
 * the same family name with another given name, which may be a short form).
 */
export function statedName(subject, name) {
  const n = clean(name);
  if (!n) return 'unknown';
  if (personNameFits(subject, n)) return 'same';
  const want = nameTokens(subject.name);
  const got = nameTokens(n);
  if (want.length < 2 || got.length < 2) return 'unknown';
  return got.includes(want[want.length - 1]) ? 'unknown' : 'other';
}

/** Known companies, websites or handles of the subject that a text names. */
function knownIn(subject, text, kinds) {
  const out = [];
  for (const kind of kinds) for (const a of (subject.anchors[kind] || new Map()).values()) if (a.test(text)) out.push(a.value);
  return out;
}

/**
 * Grade an account reached through a handle or link from a record tied to the
 * person. `exact`: the link or handle names this very account on this service.
 * Returns the fields for makeFinding, or null when the account states another
 * person's name or (not exact) nothing ties it to the person.
 */
function gradeReached(subject, { name, text, handle, exact }) {
  const stated = statedName(subject, name);
  if (stated === 'other') return null;
  const linked = knownIn(subject, text, ['domains', 'handles']).filter((v) => v.toLowerCase() !== String(handle).toLowerCase());
  if (exact) {
    if (stated === 'same' && matchSubject(subject, `${subject.name}. ${text}`).level === 'confirmed') return { matchText: `${subject.name}. ${clean(name)}. ${text}` };
    const reasons = ['reached through the exact profile link or handle given by a record tied to the person'];
    if (stated === 'same') reasons.push("states the person's name");
    return { match: 'likely', matchReasons: [...reasons, ...[...knownIn(subject, text, ['companies']), ...linked].slice(0, 2).map((k) => `names ${k}`)] };
  }
  if (stated === 'same') return { matchText: `${subject.name}. ${clean(name)}. ${text}` };
  if (linked.length) return { match: 'likely', matchReasons: [`the same handle, ${handle}, on another service`, ...linked.slice(0, 3).map((k) => `links to ${k}`)] };
  return null;
}

/**
 * Grade an account found by searching for the name (its stated name already
 * fits). A school alone does not tell one namesake from another when several
 * accounts carry the name, so the record is then held at 'possible'.
 */
function gradeNamed(subject, matchText, namesakes, selfDescribed = '') {
  const graded = matchSubject(subject, matchText);
  const telling = ['people', 'handles', 'domains'].some((kind) => [...(subject.anchors[kind] || new Map()).values()].some((a) => a.test(matchText)));
  // What an account says about itself is its owner's claim: found by the name, it is 'likely' at most.
  if (graded.level === 'confirmed' && selfDescribed) {
    return { fields: { match: 'likely', matchReasons: [...graded.reasons.slice(0, 3), `self-described on ${selfDescribed}`] }, held: true };
  }
  if (graded.level !== 'likely' || telling || namesakes < 2) return { fields: { matchText }, held: false };
  return { fields: { match: 'possible', matchReasons: [`${graded.reasons[0]}, but ${namesakes} accounts carry this name and that alone does not tell them apart`] }, held: true };
}

/* --------------------------------------------- links a profile points to */

const SHARED_HOSTS = [
  'github.com', 'github.io', 'gitlab.com', 'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com', 'youtu.be',
  'medium.com', 'substack.com', 'notion.site', 'linktr.ee', 'about.me', 'google.com', 'bit.ly', 't.co', 'wordpress.com', 'blogspot.com',
  'bsky.app', 'bsky.social', 'mastodon.social', 'threads.net', 'tiktok.com', 'reddit.com', 'stackoverflow.com', 'npmjs.com', 'keybase.io',
  'vercel.app', 'netlify.app', 'herokuapp.com', 'pages.dev', 'semanticscholar.org', 'orcid.org', 'arxiv.org', 'crunchbase.com', 'wellfound.com',
];
const TWO_LEVEL_SUFFIX = /\.(?:co|com|org|ac|net|gov|edu)\.[a-z]{2}$/;

/** Threads from a link on an account tied to the person: a known profile page, or their own website. */
function linkThreads(link, why) {
  const raw = clean(link);
  if (!raw) return [];
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return []; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return [];
  const profile = profileFromUrl(url.href);
  if (profile) {
    const out = [makeThread('url', profile.url, `${profile.platform} profile ${why}`, { trusted: true, platform: profile.platform })];
    if (profile.platform === 'github' || profile.platform === 'x') out.push(makeThread('handle', profile.handle, `${profile.platform} handle ${why}`, { trusted: true, platform: profile.platform }));
    return out.filter(Boolean);
  }
  if (SHARED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return [];
  const labels = host.split('.');
  return [makeThread('domain', labels.slice(TWO_LEVEL_SUFFIX.test(host) ? -3 : -2).join('.'), `website ${why}`, { trusted: true })].filter(Boolean);
}

function dedupeThreads(threads) {
  const seen = new Map();
  for (const t of threads.filter(Boolean)) {
    const key = `${t.kind}|${t.value.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

/** The service a handle task's handle comes from ('' when not known). */
function platformOf(task) {
  const hint = clean(task?.platform || task?.why).toLowerCase();
  const m = hint.match(/^(github|x|twitter|hacker ?news|bluesky|mastodon|npm|medium|substack|stack overflow)\b/);
  if (!m) return clean(task?.platform).toLowerCase();
  return m[1] === 'twitter' ? 'x' : m[1].replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------ robots.txt */

/** The token this reader answers to in a robots.txt (as the page reader). */
const READER_TOKEN = 'diligence-research';
const ROBOTS_TTL_MS = 24 * 3600 * 1000;
const robotsMemo = new Map(); // origin -> { until, rules }  (only robots.txt files actually read, or missing)

/**
 * May this reader open the URL? A missing robots.txt (4xx) places no limit; one that was read is obeyed.
 * One that cannot be read (timeout, 5xx, 429, refused, out of time) is neither: the lookup fails with a
 * retryable error, keeping the original message ("Out of time ...", "Timed out ...", "... left alone ...")
 * first so the loop re-queues it or counts a failure, never a "does not allow" note on a clean result.
 * A failure is not remembered, so the next lookup on that host asks again.
 */
async function robotsAllows(url, deadline) {
  const u = new URL(url);
  let entry = robotsMemo.get(u.origin);
  if (!entry || entry.until < Date.now()) {
    try {
      const text = await getText(`${u.origin}/robots.txt`, { timeoutMs: 6000, deadline, retries: 0, maxBytes: 512 * 1024 });
      entry = { until: Date.now() + ROBOTS_TTL_MS, rules: parseRobots(String(text || '').slice(0, 200000), READER_TOKEN) };
    } catch (error) {
      const missing = error?.status >= 400 && error.status < 500 && error.status !== 429;
      if (!missing) {
        throw new HttpError(`${clean(error?.message) || 'No answer'} (reading the robots.txt of ${u.hostname})`, {
          status: error?.status ?? null, url: `${u.origin}/robots.txt`, retryable: true, retryAt: error?.retryAt ?? null,
        });
      }
      entry = { until: Date.now() + ROBOTS_TTL_MS, rules: [] };
    }
    if (robotsMemo.size >= 200) robotsMemo.delete(robotsMemo.keys().next().value);
    robotsMemo.set(u.origin, entry);
  }
  return robotsAllow(entry.rules, `${u.pathname}${u.search}`);
}

/** For tests: forget what was learned between lookups. */
export function __resetPresenceForTests() {
  robotsMemo.clear();
  seBackoffUntil = 0;
}

/* -------------------------------------------------------- Semantic Scholar */

const S2_SEARCH = 'https://api.semanticscholar.org/graph/v1/author/search';
const S2_LABEL = 'Semantic Scholar author records';
const S2_FIELDS = 'name,affiliations,homepage,paperCount,citationCount,hIndex,url,externalIds,papers.title,papers.year,papers.venue';

/** The names an author record goes by: its own, and the names other bibliographies list it under. */
const s2Names = (a) => [clean(a?.name), ...(Array.isArray(a?.externalIds?.DBLP) ? a.externalIds.DBLP.map(clean) : [])].filter(Boolean);

function s2Finding(subject, author, name, grade) {
  const papers = (Array.isArray(author.papers) ? author.papers : [])
    .filter((p) => clean(p?.title))
    .sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
  const affiliations = (Array.isArray(author.affiliations) ? author.affiliations : []).map(safe).filter(Boolean).slice(0, 5);
  const latest = papers.find((p) => Number(p.year) > 0);
  const quote = [
    affiliations.length ? `Affiliations: ${affiliations.join('; ')}` : '',
    author.homepage ? `Homepage: ${clean(author.homepage)}` : '',
    papers.length ? `Papers: ${papers.slice(0, 6).map((p) => `${safe(p.title)}${p.venue || p.year ? ` (${[clean(p.venue), p.year].filter(Boolean).join(', ')})` : ''}`).filter((s) => !s.startsWith(' (')).join('; ')}` : '',
  ].filter(Boolean).join(' | ');
  return makeFinding(subject, {
    source: 'semantic-scholar', sourceLabel: S2_LABEL, category: 'ip',
    title: `Semantic Scholar author record "${name}": ${count(author.paperCount)} papers, ${count(author.citationCount)} citations, h-index ${Number(author.hIndex) || 0}`,
    quote,
    url: clean(author.url) || `https://www.semanticscholar.org/author/${encodeURIComponent(author.authorId)}`,
    date: latest ? String(latest.year) : null,
    severity: 'info',
    ...grade,
    data: { authorId: clean(author.authorId), papers: Number(author.paperCount) || 0, citations: Number(author.citationCount) || 0, hIndex: Number(author.hIndex) || 0, affiliations },
  });
}

async function semanticScholar(subject, ctx) {
  if (nameTokens(subject.name).length < 2) return EMPTY();
  const body = await getJson(`${S2_SEARCH}?query=${encodeURIComponent(subject.name)}&fields=${S2_FIELDS}&limit=20`, { deadline: ctx.deadline, retries: 0 });
  if (!body || !Array.isArray(body.data)) throw new Error('Semantic Scholar answered without a list of authors');
  const named = body.data
    .map((a) => ({ author: a, name: s2Names(a).find((n) => personNameFits(subject, n)) }))
    .filter((x) => x.name && x.author?.authorId);
  const pairs = [];
  for (const { author, name } of named) {
    // Graded on what the record says of the author (affiliations, homepage) only: a paper's title or venue
    // ("Mercury levels in salmon", "Ramp metering") is a topic, not an employer. Titles stay in the quote.
    const affiliations = (author.affiliations || []).map(clean).filter(Boolean);
    const text = maskOrgs([...affiliations, clean(author.homepage)].filter(Boolean).join('. '), namesakeOrgs(subject, affiliations));
    const grade = gradeNamed(subject, `${subject.name}. ${name}. ${text}`, named.length, 'the author record');
    const finding = s2Finding(subject, author, name, grade.fields);
    if (!finding) continue;
    if (grade.held) finding.matchFixed = true;
    pairs.push({ author, finding });
  }
  pairs.sort((a, b) => MATCH_RANK[b.finding.match] - MATCH_RANK[a.finding.match] || (Number(b.author.citationCount) || 0) - (Number(a.author.citationCount) || 0));
  const kept = pairs.slice(0, 3);
  const threads = kept.filter((p) => p.finding.match !== 'possible').flatMap((p) => linkThreads(p.author.homepage, 'given as the homepage on their Semantic Scholar record'));
  const notes = named.length > 1 ? [`${named.length} Semantic Scholar author records carry this name; the ${kept.length} most relevant are listed.`] : [];
  return { findings: kept.map((p) => p.finding), threads: dedupeThreads(threads), notes };
}

export const semanticScholarConnector = {
  id: 'semantic-scholar',
  label: S2_LABEL,
  kinds: ['subject'],
  prior: 0.25,
  maxParallel: 1,
  timeoutMs: 12000,
  async run(task, ctx) {
    return task.kind === 'subject' ? semanticScholar(ctx.subject, ctx) : EMPTY();
  },
};

/* ---------------------------------------------------------- Stack Overflow */

const SE = 'https://api.stackexchange.com/2.3';
const SE_LABEL = 'Stack Overflow public profiles';
// A saved response shape: the default fields plus the profile's "about me" and website (created with /filters/create).
const SE_FILTER = '!SyjNqbwGU2NWZ1y5pj';
const SE_USER_URL = /^https?:\/\/(?:www\.)?stackoverflow\.com\/users\/(\d{1,12})(?:[/?#]|$)/i;
let seBackoffUntil = 0;

async function seGet(path, ctx) {
  if (seBackoffUntil > Date.now()) {
    const error = new Error('Stack Overflow asked for a pause between lookups; this one was not run');
    error.retryable = true;
    throw error;
  }
  const body = await getJson(`${SE}${path}${path.includes('?') ? '&' : '?'}site=stackoverflow&filter=${SE_FILTER}`, { deadline: ctx.deadline, retries: 0 });
  if (Number(body?.backoff) > 0) seBackoffUntil = Date.now() + Number(body.backoff) * 1000;
  if (!body || !Array.isArray(body.items)) throw new Error('Stack Overflow answered without a list of accounts');
  return body;
}

function seFinding(subject, user, grade) {
  const name = seName(user);
  const about = safe(htmlToText(user.about_me || ''));
  const site = /^https?:\/\//i.test(user.website_url || '') && !/^mailto:/i.test(user.website_url) ? clean(user.website_url) : '';
  const created = day(user.creation_date);
  return makeFinding(subject, {
    source: 'stack-overflow', sourceLabel: SE_LABEL, category: 'identity',
    title: `Stack Overflow account "${name}" (self-described): reputation ${count(user.reputation)}${created ? `, member since ${created}` : ''}`,
    quote: [about && `About: ${about.slice(0, 500)}`, site && `Website: ${site}`].filter(Boolean).join(' | '),
    url: clean(user.link) || `https://stackoverflow.com/users/${user.user_id}`,
    date: created,
    severity: 'info',
    ...grade,
    data: { userId: Number(user.user_id) || null, reputation: Number(user.reputation) || 0, website: site || null },
  });
}

/** Stack Exchange sends names with HTML entities ("O&#39;Brien"). */
const seName = (user) => clean(htmlToText(user?.display_name || ''));
const seText = (user) => [safe(htmlToText(user.about_me || '')), clean(user.website_url)].filter(Boolean).join('. ');

async function stackOverflowByName(subject, ctx) {
  if (nameTokens(subject.name).length < 2) return EMPTY();
  const body = await seGet(`/users?inname=${encodeURIComponent(subject.name)}&pagesize=20&order=desc&sort=reputation`, ctx);
  const named = body.items.filter((u) => u && u.user_type !== 'does_not_exist' && statedName(subject, seName(u)) === 'same');
  const pairs = [];
  for (const user of named) {
    const grade = gradeNamed(subject, `${subject.name}. ${seName(user)}. ${seText(user)}`, named.length, 'the profile');
    const finding = seFinding(subject, user, grade.fields);
    if (!finding) continue;
    if (grade.held) finding.matchFixed = true;
    pairs.push({ user, finding });
  }
  pairs.sort((a, b) => MATCH_RANK[b.finding.match] - MATCH_RANK[a.finding.match] || (Number(b.user.reputation) || 0) - (Number(a.user.reputation) || 0));
  const kept = pairs.slice(0, 3);
  const threads = kept.filter((p) => p.finding.match !== 'possible').flatMap((p) => linkThreads(p.user.website_url, 'given on their Stack Overflow profile'));
  return { findings: kept.map((p) => p.finding), threads: dedupeThreads(threads), notes: [] };
}

async function stackOverflowAccount(subject, id, ctx) {
  const body = await seGet(`/users/${id}`, ctx);
  const user = body.items[0];
  if (!user) return EMPTY();
  const grade = gradeReached(subject, { name: seName(user), text: seText(user), handle: String(id), exact: true });
  if (!grade) return { findings: [], threads: [], notes: [`The Stack Overflow account ${id} states a different name and was left out.`] };
  const finding = seFinding(subject, user, grade);
  if (!finding) return EMPTY();
  return { findings: [finding], threads: dedupeThreads(linkThreads(user.website_url, 'given on their Stack Overflow profile')), notes: [] };
}

export const stackOverflowConnector = {
  id: 'stack-overflow',
  label: SE_LABEL,
  kinds: ['subject', 'url'],
  prior: 0.2,
  maxParallel: 1,
  timeoutMs: 12000,
  async run(task, ctx) {
    if (task.kind === 'subject') return stackOverflowByName(ctx.subject, ctx);
    const m = task.kind === 'url' ? clean(task.value).match(SE_USER_URL) : null;
    return m ? stackOverflowAccount(ctx.subject, m[1], ctx) : EMPTY();
  },
};

/* --------------------------------------------------------------------- npm */

const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search';
const NPM_LABEL = 'npm software packages';
const NPM_NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/i;

/** The GitHub account that holds a package's code, read from its repository or homepage link. */
const repoOwner = (links) => {
  for (const link of [links?.repository, links?.homepage, links?.bugs]) {
    const m = clean(link).match(/github\.com[/:]([A-Za-z0-9-]{1,39})\//i);
    if (m) return m[1];
  }
  return '';
};

async function npmPackages(subject, task, ctx) {
  const handle = clean(task.value).replace(/^@/, '');
  if (!NPM_NAME.test(handle)) return EMPTY();
  const platform = platformOf(task);
  const body = await getJson(`${NPM_SEARCH}?text=${encodeURIComponent(`maintainer:${handle}`)}&size=50`, { deadline: ctx.deadline });
  if (!body || !Array.isArray(body.objects)) throw new Error('npm answered without a list of packages');
  // Only the account's own packages: the search can return near matches. E-mail addresses are never read.
  const packages = body.objects
    .map((o) => ({ pkg: o?.package || {}, monthly: Number(o?.downloads?.monthly) || 0 }))
    .filter(({ pkg }) => clean(pkg.name) && (pkg.maintainers || []).some((m) => clean(m?.username).toLowerCase() === handle.toLowerCase()))
    .sort((a, b) => b.monthly - a.monthly);
  if (!packages.length) return EMPTY();
  const owners = packages.map(({ pkg }) => repoOwner(pkg.links).toLowerCase()).filter(Boolean);
  const linksText = packages.map(({ pkg }) => [pkg.links?.homepage, pkg.links?.repository].map(clean).join(' ')).join(' ');
  let grade;
  if (platform === 'npm') {
    grade = { match: 'likely', matchReasons: ['reached through the exact npm account given by a record tied to the person'] };
  } else if (platform === 'github' && owners.includes(handle.toLowerCase())) {
    grade = { match: 'likely', matchReasons: [`its packages' code is kept under the GitHub account ${handle}, already tied to the person`] };
  } else {
    grade = gradeReached(subject, { name: '', text: linksText, handle, exact: false });
  }
  if (!grade) return EMPTY(); // the same name on npm, with nothing tying it to the person
  const total = packages.reduce((sum, p) => sum + p.monthly, 0);
  const latest = packages.map(({ pkg }) => clean(pkg.date)).filter(Boolean).sort().pop() || null;
  const top = packages.slice(0, 8);
  const finding = makeFinding(subject, {
    source: 'npm-packages', sourceLabel: NPM_LABEL, category: 'career',
    title: `npm account ${handle} maintains ${count(packages.length)} package${packages.length === 1 ? '' : 's'} (about ${count(total)} downloads a month), most used: ${top.slice(0, 3).map(({ pkg }) => clean(pkg.name)).join(', ')}`,
    quote: top.map(({ pkg, monthly }) => `${clean(pkg.name)}${pkg.description ? `: ${safe(pkg.description).slice(0, 120)}` : ''} (${count(monthly)}/month)`).join(' | '),
    url: `https://www.npmjs.com/~${encodeURIComponent(handle)}`,
    date: latest,
    severity: 'info',
    ...grade,
    data: { handle, packages: packages.length, monthlyDownloads: total, top: top.map(({ pkg, monthly }) => ({ name: clean(pkg.name), monthly })) },
  });
  return { findings: [finding].filter(Boolean), threads: [], notes: [] };
}

export const npmPackagesConnector = {
  id: 'npm-packages',
  label: NPM_LABEL,
  kinds: ['handle'],
  prior: 0.2,
  timeoutMs: 12000,
  async run(task, ctx) {
    return task.kind === 'handle' ? npmPackages(ctx.subject, task, ctx) : EMPTY();
  },
};

/* ----------------------------------------------------------------- Bluesky */

const BSKY = 'https://public.api.bsky.app/xrpc';
const BSKY_LABEL = 'Bluesky public profiles';
const BSKY_HANDLE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const BSKY_DID = /^did:(?:plc|web):[a-z0-9._:%-]{3,200}$/i;
const BSKY_URL = /^https?:\/\/(?:www\.)?bsky\.app\/profile\/([^/?#]+)\/?$/i;

/** A profile's own-domain handle (not one on bsky.social): Bluesky checks that the holder controls that domain. */
const ownDomain = (handle) => (/\.bsky\.social$/i.test(handle) ? '' : String(handle).toLowerCase());

function bskyProfileFinding(subject, p, grade) {
  const handle = clean(p.handle);
  const name = clean(p.displayName);
  const bio = safe(p.description);
  const joined = day(p.createdAt);
  const facts = [`${count(p.followersCount)} followers`, p.postsCount !== undefined ? `${count(p.postsCount)} posts` : '', joined ? `joined ${joined}` : ''].filter(Boolean).join(', ');
  return makeFinding(subject, {
    source: 'bluesky', sourceLabel: BSKY_LABEL, category: 'identity',
    title: `Bluesky account @${handle} (self-described: ${name ? `name "${name}"` : 'no name stated'})${facts ? `: ${facts}` : ''}`,
    quote: [name, bio && `Bio: ${bio}`, ownDomain(handle) ? `Handle is the domain ${handle}, which Bluesky checks the holder controls` : ''].filter(Boolean).join(' | '),
    url: `https://bsky.app/profile/${handle}`,
    date: joined,
    severity: 'info',
    ...grade,
    data: { handle, did: clean(p.did), name, followers: Number(p.followersCount) || 0, posts: Number(p.postsCount) || 0 },
  });
}

// Case matters: "US" (the country) is not "us".
const FIRST_PERSON = /\b(?:I|I'm|I've|[Ww]e|[Ww]e're|[Ww]e've|[Mm]y|[Oo]ur|me|us)\b/;
/**
 * The severity of the person's own post. A post about someone else's dispute
 * ("the lawsuit against our customer was dismissed") is not a matter of
 * theirs: above 'low' only when a sentence that reports the matter also names
 * their company or speaks in the first person.
 */
export function ownPostSeverity(subject, text) {
  const severity = severityFromText(text, subject);
  if (severity !== 'high' && severity !== 'medium') return severity;
  const sentences = String(text || '').split(/(?<=[.!?])\s+/);
  const theirs = sentences.some((x) => severityFromText(x, subject) !== 'info'
    && (knownIn(subject, x, ['companies']).length > 0 || FIRST_PERSON.test(x.replace(/\b(?:our|my) (?:customers?|clients?|partners?|friends?|competitors?|investors?)\b/gi, ' '))));
  return theirs ? severity : 'low';
}

/** The person's recent posts that name a known company of theirs or report a dispute, from an account tied to them. */
async function bskyPosts(subject, profile, profileFinding, ctx) {
  const body = await getJson(`${BSKY}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(profile.did)}&limit=50&filter=posts_no_replies`, { deadline: ctx.deadline, retries: 0 });
  const feed = Array.isArray(body?.feed) ? body.feed : [];
  const out = [];
  for (const item of feed) {
    if (item?.reason || item?.post?.author?.did !== profile.did) continue; // a repost is someone else's words
    const text = safe(item.post?.record?.text);
    if (!text) continue;
    const companies = knownIn(subject, text, ['companies']);
    const severity = ownPostSeverity(subject, text);
    if (severity === 'info' && !companies.length) continue;
    const rkey = String(item.post.uri || '').split('/').pop();
    if (!/^[a-z0-9]{6,20}$/i.test(rkey)) continue;
    const date = day(item.post.record?.createdAt);
    const finding = makeFinding(subject, {
      source: 'bluesky', sourceLabel: BSKY_LABEL, category: 'press',
      title: `Bluesky post by @${clean(profile.handle)} (the person's own words${date ? `, ${date}` : ''}): ${text.slice(0, 140)}`,
      quote: text,
      url: `https://bsky.app/profile/${clean(profile.handle)}/post/${rkey}`,
      date,
      severity,
      match: 'likely',
      matchReasons: [`posted from the Bluesky account @${clean(profile.handle)}, graded ${profileFinding.match}`, ...companies.slice(0, 2).map((c) => `names ${c}`)],
      // The person's own statement: the report keeps it out of red flags
      data: { likes: Number(item.post.likeCount) || 0, reposts: Number(item.post.repostCount) || 0, ownStatement: true },
    });
    if (finding) out.push(finding);
    if (out.length >= 5) break;
  }
  return out;
}

async function bskyProfile(actor, ctx) {
  try {
    return await getJson(`${BSKY}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, { deadline: ctx.deadline, retries: 0 });
  } catch (error) {
    if (error?.status === 400 || error?.status === 404) return null; // "Profile not found" for a well-formed handle
    throw error;
  }
}

async function bskyAccount(subject, actor, exact, ctx) {
  const p = await bskyProfile(actor, ctx);
  if (!p || !p.did || !p.handle) return EMPTY();
  const handle = clean(p.handle);
  const text = [safe(p.description), ownDomain(handle)].filter(Boolean).join('. ');
  const grade = gradeReached(subject, { name: clean(p.displayName), text, handle, exact });
  if (!grade) {
    return statedName(subject, p.displayName) === 'other'
      ? { findings: [], threads: [], notes: [`The Bluesky account @${handle} states a different name and was left out.`] }
      : EMPTY();
  }
  const finding = bskyProfileFinding(subject, p, grade);
  if (!finding) return EMPTY();
  const findings = [finding];
  const notes = [];
  const threads = [];
  if (finding.match !== 'possible') {
    if (ownDomain(handle)) threads.push(...linkThreads(handle, 'that their Bluesky handle is on (Bluesky checks control of the domain)'));
    try {
      findings.push(...await bskyPosts(subject, p, finding, ctx));
    } catch (error) {
      notes.push(`Recent Bluesky posts of @${handle} could not be read (${clean(error?.message) || 'no answer'}).`);
    }
  }
  return { findings, threads: dedupeThreads(threads), notes };
}

async function bskySearch(subject, ctx) {
  if (nameTokens(subject.name).length < 2) return EMPTY();
  const body = await getJson(`${BSKY}/app.bsky.actor.searchActors?q=${encodeURIComponent(subject.name)}&limit=25`, { deadline: ctx.deadline, retries: 0 });
  if (!body || !Array.isArray(body.actors)) throw new Error('Bluesky answered without a list of accounts');
  const named = body.actors.filter((a) => a?.handle && statedName(subject, a.displayName) === 'same');
  const findings = [];
  const threads = [];
  for (const a of named.slice(0, 5)) {
    const handle = clean(a.handle);
    // A display name and a bio are anyone's to write: found by name, an account stays possible, unless its
    // handle is a website already known to be the person's (Bluesky checks control of a domain handle).
    const domain = ownDomain(handle);
    const knownDomain = domain && knownIn(subject, domain, ['domains']).length > 0;
    const grade = knownDomain
      ? { match: 'likely', matchReasons: [`its handle is ${domain}, a website already tied to the person, and Bluesky checks control of it`] }
      : { match: 'possible', matchReasons: [`found by searching the name on Bluesky; ${named.length > 1 ? `${named.length} accounts carry it, and ` : ''}a profile's name and bio are its owner's own claim`] };
    const finding = bskyProfileFinding(subject, a, grade);
    if (!finding) continue;
    findings.push(finding);
    if (knownDomain) threads.push(makeThread('url', `https://bsky.app/profile/${handle}`, 'Bluesky profile whose handle is a website of the person', { trusted: true, platform: 'bluesky' }));
  }
  return { findings: findings.slice(0, 3), threads: dedupeThreads(threads), notes: [] };
}

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const LEGAL_FORM = /[,\s]+(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|sas|sa|plc|bv|ag)\.?$/i;

/**
 * The company's own Bluesky account: one whose handle is a website already known to be the company's
 * (Bluesky checks control of a domain handle). Without a known website, a company of several words is
 * matched only when the handle's first label and the display name are both exactly its name. A one-word
 * company name is also a first name or a surname (Nikola, Ramp, Mercury), so a personal account like
 * "Nikola Petrov" at nikola.dev, or even "Nikola" alone, could pass; it is kept only through a known
 * website. A company record, never a record about the person.
 */
async function bskyCompany(subject, company, ctx) {
  const plain = clean(company.replace(LEGAL_FORM, '')) || clean(company);
  const key = compact(plain);
  if (key.length < 3) return EMPTY();
  const oneWord = plain.split(/[^A-Za-z0-9]+/).filter(Boolean).length < 2;
  const body = await getJson(`${BSKY}/app.bsky.actor.searchActors?q=${encodeURIComponent(plain)}&limit=25`, { deadline: ctx.deadline, retries: 0 });
  if (!body || !Array.isArray(body.actors)) throw new Error('Bluesky answered without a list of accounts');
  const knownDomains = [...(subject.anchors.domains || new Map()).values()].map((a) => a.value.toLowerCase().replace(/^www\./, ''));
  const findings = [];
  for (const a of body.actors) {
    const domain = ownDomain(clean(a?.handle));
    if (!domain || !a.did) continue;
    // Bluesky checks control of the whole handle, so a subdomain of a known site is held by that site's owner.
    const known = knownDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
    const shownName = clean(clean(a.displayName).replace(LEGAL_FORM, '')) || clean(a.displayName);
    const named = !oneWord && compact(domain.split('.')[0]) === key && compact(shownName) === key;
    if (!known && !named) continue;
    const finding = bskyProfileFinding(subject, a, {
      match: 'company',
      matchReasons: [known ? `its handle is ${domain}, a website of ${plain}` : `its handle is the website ${domain} and it is named ${clean(a.displayName)}`],
    });
    if (finding) findings.push(finding);
    if (findings.length >= 2) break;
  }
  return { findings, threads: [], notes: [] };
}

export const blueskyConnector = {
  id: 'bluesky',
  label: BSKY_LABEL,
  kinds: ['subject', 'company', 'handle', 'url'],
  prior: 0.25,
  timeoutMs: 15000,
  async run(task, ctx) {
    const { subject } = ctx;
    if (task.kind === 'subject') return bskySearch(subject, ctx);
    if (task.kind === 'company') return bskyCompany(subject, clean(task.value), ctx);
    if (task.kind === 'url') {
      const m = clean(task.value).match(BSKY_URL);
      const actor = m ? decodeURIComponent(m[1]) : '';
      return actor && (BSKY_HANDLE.test(actor) || BSKY_DID.test(actor)) ? bskyAccount(subject, actor, true, ctx) : EMPTY();
    }
    if (task.kind === 'handle') {
      const handle = clean(task.value).replace(/^@/, '');
      const own = platformOf(task) === 'bluesky';
      // The same handle on Bluesky's own domain; only kept when it states the person's name or links to their site.
      const actor = own ? handle : /^[A-Za-z0-9-]{3,18}$/.test(handle) ? `${handle.toLowerCase()}.bsky.social` : '';
      return actor && BSKY_HANDLE.test(actor) ? bskyAccount(subject, actor, own, ctx) : EMPTY();
    }
    return EMPTY();
  },
};

/* ---------------------------------------------------------------- Mastodon */

const MASTODON_LABEL = 'Mastodon public profiles';
const MASTODON_USER = /^[A-Za-z0-9_]{1,30}$/;
const HOST = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
// Sites whose profile addresses also read "/@name" but are not Mastodon servers.
const NOT_MASTODON = /(?:^|\.)(?:medium\.com|substack\.com|tiktok\.com|youtube\.com|threads\.net|instagram\.com|bsky\.app|x\.com|twitter\.com|github\.com|linkedin\.com|vimeo\.com|pinterest\.com|soundcloud\.com|flickr\.com)$/i;

/** "@user@host", "user@host" or "https://host/@user" -> { user, host }, or null. */
export function mastodonAddress(value, kind) {
  const v = clean(value);
  if (kind === 'url') {
    const m = v.match(/^https:\/\/([^/?#]+)\/@([A-Za-z0-9_]{1,30})\/?$/i);
    return m && HOST.test(m[1]) && !NOT_MASTODON.test(m[1].toLowerCase()) ? { user: m[2], host: m[1].toLowerCase() } : null;
  }
  const m = v.match(/^@?([A-Za-z0-9_]{1,30})@([^@\s/]+)$/);
  return m && HOST.test(m[2]) && !NOT_MASTODON.test(m[2].toLowerCase()) ? { user: m[1], host: m[2].toLowerCase() } : null;
}

/** The links on a Mastodon profile, with whether the server checked the account controls each one. */
function mastodonLinks(fields) {
  return (Array.isArray(fields) ? fields : []).map((f) => {
    const html = String(f?.value || '');
    const href = (html.match(/href="(https?:\/\/[^"]+)"/i) || [])[1] || (htmlToText(html).match(/https?:\/\/\S+/) || [])[0] || '';
    return { label: clean(htmlToText(f?.name || '')), url: clean(href), verified: Boolean(f?.verified_at) };
  }).filter((l) => /^https?:\/\//i.test(l.url) && !/^mailto:/i.test(l.url));
}

async function mastodonAccount(subject, { user, host }, ctx) {
  const url = `https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(user)}`;
  if (!(await robotsAllows(url, ctx.deadline))) return { findings: [], threads: [], notes: [`${host} does not allow automated reading of its profiles; the Mastodon account @${user} on ${host} was not read.`] };
  let a;
  try {
    a = await getJson(url, { deadline: ctx.deadline, retries: 0 });
  } catch (error) {
    if (error?.status === 404 || error?.status === 410) return EMPTY(); // no such account
    throw error;
  }
  if (!a || !a.acct || !a.url) throw new Error(`${host} did not answer as a Mastodon server`);
  const links = mastodonLinks(a.fields);
  const verified = links.filter((l) => l.verified);
  const note = safe(htmlToText(a.note || ''));
  const name = clean(a.display_name);
  const handle = `${clean(a.username) || user}@${host}`;
  // Only links the server checked count as proof; unchecked ones are the owner's claim like the bio.
  const grade = gradeReached(subject, { name, text: [note, ...verified.map((l) => l.url)].join('. '), handle, exact: true });
  if (!grade) return { findings: [], threads: [], notes: [`The Mastodon account @${clean(a.username) || user} on ${host} states a different name and was left out.`] };
  const joined = day(a.created_at);
  const finding = makeFinding(subject, {
    source: 'mastodon', sourceLabel: MASTODON_LABEL, category: 'identity',
    title: `Mastodon account @${clean(a.username) || user} on ${host} (self-described: ${name ? `name "${name}"` : 'no name stated'}): ${count(a.followers_count)} followers, ${count(a.statuses_count)} posts${joined ? `, joined ${joined}` : ''}`,
    quote: [name, note && `Bio: ${note.slice(0, 500)}`, ...links.slice(0, 6).map((l) => `${l.label || 'Link'}: ${l.url}${l.verified ? ' (control checked by the server)' : ''}`)].filter(Boolean).join(' | '),
    url: /^https:\/\//i.test(a.url) && hostOf(a.url) === host ? clean(a.url) : `https://${host}/@${user}`,
    date: joined,
    severity: 'info',
    ...grade,
    data: { user: clean(a.username) || user, server: host, followers: Number(a.followers_count) || 0, posts: Number(a.statuses_count) || 0, links: links.map(({ label, url: link, verified: v }) => ({ label, url: link, verified: v })) },
  });
  if (!finding) return EMPTY();
  const threads = finding.match === 'possible' ? [] : verified.flatMap((l) => linkThreads(l.url, 'proven on their Mastodon profile'));
  return { findings: [finding], threads: dedupeThreads(threads), notes: [] };
}

export const mastodonConnector = {
  id: 'mastodon',
  label: MASTODON_LABEL,
  kinds: ['handle', 'url'],
  prior: 0.2,
  timeoutMs: 15000,
  async run(task, ctx) {
    if (task.kind !== 'handle' && task.kind !== 'url') return EMPTY();
    const address = mastodonAddress(task.value, task.kind);
    return address && MASTODON_USER.test(address.user) ? mastodonAccount(ctx.subject, address, ctx) : EMPTY();
  },
};

/* ------------------------------------------------- Medium and Substack feeds */

const FEEDS_LABEL = 'Medium and Substack writing';
const MAX_POSTS = 6;

/** The feed of a Medium or Substack page, or null when the link is not one. */
export function feedFor(link) {
  const profile = profileFromUrl(link);
  if (profile?.platform === 'medium' && /^[A-Za-z0-9._-]{1,60}$/.test(profile.handle)) {
    return { platform: 'Medium', page: `https://medium.com/@${profile.handle}`, feed: `https://medium.com/feed/@${profile.handle}` };
  }
  if (profile?.platform === 'substack' && /^[a-z0-9-]{1,63}$/.test(profile.handle)) {
    return { platform: 'Substack', page: `https://${profile.handle}.substack.com`, feed: `https://${profile.handle}.substack.com/feed` };
  }
  return null;
}

const tag = (xml, name) => {
  const m = String(xml).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return clean(htmlToText(raw));
};

/** The parts of an RSS feed that are used: the channel's title and author, and each post's title, link, by-line and date. */
export function parseFeed(xml) {
  const text = String(xml || '');
  if (!/<rss\b|<channel\b/i.test(text)) return null;
  const channel = text.replace(/<item\b[\s\S]*?<\/item>/gi, '');
  const items = [...text.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => ({
    title: tag(m[0], 'title'),
    link: tag(m[0], 'link'),
    creator: tag(m[0], 'dc:creator'),
    date: tag(m[0], 'pubDate'),
    summary: tag(m[0], 'description') || tag(m[0], 'content:encoded'),
  })).filter((i) => i.title && /^https?:\/\//i.test(i.link));
  return { title: tag(channel, 'title'), author: tag(channel, 'itunes:author') || tag(channel, 'itunes:name'), items };
}

/** The author a feed states for its page: Medium's "Stories by Ev Williams on Medium", Substack's podcast author. */
const feedAuthor = (feed, platform) => {
  if (platform === 'Medium') return (feed.title.match(/^Stories by (.+?) on Medium$/i) || [])[1] || '';
  return feed.author;
};

async function writingFeed(subject, where, ctx) {
  if (!(await robotsAllows(where.feed, ctx.deadline))) return { findings: [], threads: [], notes: [`${hostOf(where.feed)} does not allow automated reading of its feed; ${where.page} was not read.`] };
  const xml = await getText(where.feed, { deadline: ctx.deadline, retries: 0, accept: 'application/rss+xml, application/xml, text/xml', maxBytes: 4 * 1024 * 1024 });
  const feed = parseFeed(xml);
  if (!feed) throw new Error(`${where.platform} did not answer with a feed for ${where.page}`);
  const author = clean(feedAuthor(feed, where.platform));
  const pageState = statedName(subject, author);
  // A page with several writers is read for the person's own posts only.
  const posts = feed.items.filter((i) => {
    const byline = statedName(subject, i.creator);
    return byline === 'same' || (byline === 'unknown' && pageState !== 'other');
  });
  if (!posts.length) {
    return pageState === 'other' && !feed.items.some((i) => statedName(subject, i.creator) === 'same')
      ? { findings: [], threads: [], notes: [`${where.page} is written by ${author}, not the person; it was left out.`] }
      : EMPTY();
  }
  const findings = [];
  for (const post of posts.slice(0, MAX_POSTS)) {
    const summary = safe(post.summary).slice(0, 400);
    const title = safe(post.title);
    if (!title) continue;
    const byline = statedName(subject, post.creator) === 'same' || pageState === 'same';
    const date = day(post.date);
    let link = post.link;
    try { const u = new URL(post.link); u.search = ''; link = u.href; } catch { /* keep as given */ }
    const finding = makeFinding(subject, {
      source: 'writing-feeds', sourceLabel: FEEDS_LABEL, category: 'press',
      title: `${where.platform} post${byline ? ` by ${clean(post.creator) || author}` : ''} (the person's own writing${date ? `, ${date}` : ''}): ${title}`,
      quote: summary,
      url: link,
      date,
      severity: severityFromText(`${title}. ${summary}`, subject),
      match: 'likely',
      matchReasons: [`published on ${where.page}, linked from a record tied to the person`, ...(byline ? ["the by-line is the person's name"] : [])],
      data: { page: where.page, platform: where.platform },
    });
    if (finding) findings.push(finding);
  }
  const notes = posts.length > MAX_POSTS ? [`${posts.length} recent posts on ${where.page}; the ${MAX_POSTS} newest are listed.`] : [];
  return { findings, threads: [], notes };
}

export const writingFeedsConnector = {
  id: 'writing-feeds',
  label: FEEDS_LABEL,
  kinds: ['url'],
  prior: 0.3,
  timeoutMs: 15000,
  async run(task, ctx) {
    const where = task.kind === 'url' ? feedFor(clean(task.value)) : null;
    return where ? writingFeed(ctx.subject, where, ctx) : EMPTY();
  },
};
