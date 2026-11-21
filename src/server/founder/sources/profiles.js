/**
 * Public developer and maker profiles.
 *
 *   github           the person's GitHub account: how old it is, what it says
 *                    about their company, how much public work sits behind
 *                    it. Supports (or fails to support) a claimed engineering
 *                    history.
 *   hacker-news      Hacker News: stories about the person or their company
 *                    with their points and dates (founders are discussed
 *                    candidly there), and the person's own account.
 *   linked-accounts  Keybase: which other accounts and websites the holder of
 *                    a handle has publicly proven to be theirs.
 *
 * What a profile says about its owner (name, company, bio) is the owner's
 * own claim, and every title says so. An account is tied to the subject only
 * when it states their name together with a known company or website, or
 * when it was reached through a handle already tied to them; the same handle
 * on another service is not, by itself, the same person. E-mail addresses
 * and locations on a profile are never read into a finding.
 */
import { getJson, mapLimit, htmlToText } from '../http';
import { makeFinding, makeThread, severityFromText } from '../finding';
import { threadsFromResult, profileFromUrl, mentions } from '../extract';
import { nameTokens, matchSubject } from '../identity';
import { cleanSentences } from '../guardrails';
import { companyKeys } from '../../founderCheck';
import { personNameFits, knownCompanyOf, companyNamesOf } from './scholar';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const count = (n) => Number(n || 0).toLocaleString('en-US');
/**
 * A bio the privacy rules would reject is left out, so the rest of the
 * profile survives; e-mail addresses and the like in what is kept are removed
 * (it is also the text the grade is read from, which is stored with the record).
 */
const safe = (s) => clean(cleanSentences(clean(s)).text);
const EMPTY = () => ({ findings: [], threads: [], notes: [] });
const MATCH_RANK = { confirmed: 3, likely: 2, company: 2, possible: 1 };
const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };

/* ------------------------------------------------- whose account is this? */

// Common short forms of given names: a profile under "Bill Gates" may be William Gates's.
const SHORT_FORMS = [
  ['patrick', 'pat', 'paddy'], ['patricia', 'pat', 'patty', 'trish'], ['william', 'bill', 'billy', 'will', 'liam'], ['robert', 'bob', 'bobby', 'rob', 'robbie'],
  ['elizabeth', 'liz', 'lizzie', 'beth', 'betty', 'eliza'], ['richard', 'rick', 'rich', 'dick'], ['james', 'jim', 'jimmy', 'jamie'], ['john', 'jack', 'johnny'],
  ['michael', 'mike', 'mick', 'mikey'], ['thomas', 'tom', 'tommy'], ['joseph', 'joe', 'joey'], ['daniel', 'dan', 'danny'], ['david', 'dave'],
  ['christopher', 'chris'], ['christina', 'chris', 'tina'], ['christine', 'chris'], ['matthew', 'matt'], ['andrew', 'andy', 'drew'], ['anthony', 'tony'],
  ['edward', 'ed', 'eddie', 'ted'], ['benjamin', 'ben'], ['samuel', 'sam'], ['samantha', 'sam'], ['alexander', 'alex', 'sasha'], ['alexandra', 'alex', 'sasha'],
  ['nicholas', 'nick'], ['jonathan', 'jon'], ['steven', 'steve'], ['stephen', 'steve'], ['timothy', 'tim'], ['gregory', 'greg'], ['peter', 'pete'],
  ['charles', 'charlie', 'chuck'], ['katherine', 'kate', 'katie', 'kathy'], ['catherine', 'kate', 'cathy'], ['jennifer', 'jen', 'jenny'],
  ['margaret', 'maggie', 'meg', 'peggy'], ['susan', 'sue'], ['rebecca', 'becky'], ['victoria', 'vicky', 'tori'], ['jessica', 'jess'], ['abigail', 'abby'],
  ['nathaniel', 'nate', 'nat'], ['nathan', 'nate'], ['zachary', 'zach', 'zack'], ['frederick', 'fred'], ['lawrence', 'larry'], ['kenneth', 'ken'],
  ['ronald', 'ron'], ['donald', 'don'], ['douglas', 'doug'], ['jeffrey', 'jeff'], ['gerald', 'jerry'], ['raymond', 'ray'],
];
/** Whether a stated given name can be the subject's: the same, an initial, a short form or the start of it. */
function sameGiven(want, got) {
  if (want === got) return true;
  if (got.length === 1) return want[0] === got;
  if (got.length >= 3 && (want.startsWith(got) || got.startsWith(want))) return true;
  return SHORT_FORMS.some((forms) => forms.includes(want) && forms.includes(got));
}

/**
 * The name an account states, against the subject's: 'same', 'other' (a
 * different family name, or the same family name with a different given
 * name: a brother or a co-founder is not the subject) or 'unknown'.
 */
function statedName(subject, name) {
  const n = clean(name);
  if (!n) return 'unknown';
  if (personNameFits(subject, n)) return 'same';
  const want = nameTokens(subject.name);
  const got = nameTokens(n);
  if (want.length < 2 || got.length < 2) return 'unknown'; // a first name only, a nickname
  const last = want[want.length - 1];
  if (!got.includes(last)) return 'other';
  if (got[0] === last) return 'unknown'; // a reversed name
  // The given name may sit anywhere before the family name ("J. Patrick Collison").
  if (got.slice(0, got.lastIndexOf(last)).some((t) => want.slice(0, -1).some((w) => sameGiven(w, t)))) return 'unknown';
  return 'other';
}

/** Known companies, websites (and, when asked, handles) of the subject that a piece of text names. */
function knownIn(subject, text, kinds = ['companies', 'domains']) {
  const out = [];
  for (const kind of kinds) {
    for (const a of subject.anchors[kind].values()) if (a.test(text)) out.push(a.value);
  }
  return out;
}

/**
 * The service a handle task's handle comes from, read from the task (or the
 * start of the reason it was offered: "x handle ...", "GitHub login ..."), or
 * '' when that is not known.
 */
function handlePlatform(task) {
  const stated = clean(task?.platform).toLowerCase();
  const hint = stated || clean(task?.why).toLowerCase();
  if (/^(?:x|twitter)\b/.test(hint)) return 'x';
  if (/^github\b/.test(hint)) return 'github';
  if (/^hacker ?news\b|^hn\b/.test(hint)) return 'hacker news';
  return stated;
}

/**
 * How an account should be graded: the fields to hand to makeFinding, or
 * null when it states someone else's name.
 *  - it states the subject's name: graded on that name plus what the profile says;
 *  - it states no name, was reached through a handle of the subject and links
 *    back to a known website or handle of theirs: likely;
 *  - it states no name and names a known company, and the handle is known to
 *    come from this same service: likely (the same handle on another service
 *    may be anyone, and a company is named by thousands of its staff);
 *  - otherwise: possible, and nothing it links to is followed.
 */
function gradeAccount(subject, { name, text, handle, samePlatform = false }) {
  const stated = statedName(subject, name);
  if (stated === 'other') return null;
  if (stated === 'same') return { matchText: `${subject.name}. ${clean(name)}. ${text} ${handle}` };
  const linked = knownIn(subject, text, ['domains', 'handles']).filter((v) => v.toLowerCase() !== handle.toLowerCase());
  const known = samePlatform ? [...knownIn(subject, text, ['companies']), ...linked] : linked;
  if (known.length) return { match: 'likely', matchReasons: [`reached through the handle ${handle}`, ...known.slice(0, 3).map((k) => `names ${k}`)] };
  const why = samePlatform ? 'only' : 'only, and the handle may belong to someone else on this service';
  return { match: 'possible', matchReasons: [`reached through the handle ${handle} ${why}: the account does not state the person's name`] };
}

/**
 * Grading for an account found by searching for the name, when several
 * accounts carry it. A known company, website, co-founder or handle on the
 * profile tells the subject from a namesake; a school alone does not (the
 * account was picked out of the namesakes), so it then stays "possible".
 */
function gradeNamedAccount(subject, matchText, namesakes, selfDescribed = '') {
  const graded = matchSubject(subject, matchText);
  // Anyone can open an account in someone's name and company: found by the name, what it says of itself makes it
  // 'likely' at most, and the cap is kept when the record is graded again.
  if (graded.level === 'confirmed' && selfDescribed) {
    return { fields: { match: 'likely', matchReasons: [...graded.reasons.slice(0, 3), `self-described on ${selfDescribed}`] }, held: true };
  }
  const telling = ['people', 'handles', 'domains'].some((kind) => [...subject.anchors[kind].values()].some((a) => a.test(matchText)));
  if (graded.level !== 'likely' || telling || namesakes < 2) return { fields: { matchText }, held: false };
  return { fields: { match: 'possible', matchReasons: [`${graded.reasons[0]}, but ${namesakes} accounts carry this name and a school alone does not tell them apart`] }, held: true };
}

/* ------------------------------------------ links a profile points to */

// Hosts where a link is a page on someone else's site, not the person's own website.
const SHARED_HOSTS = [
  'github.com', 'github.io', 'gitlab.com', 'gitlab.io', 'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'youtu.be', 'medium.com', 'substack.com', 'notion.site', 'notion.so', 'linktr.ee', 'about.me', 'google.com',
  'bit.ly', 't.co', 't.me', 'wordpress.com', 'blogspot.com', 'tumblr.com', 'wixsite.com', 'carrd.co', 'bsky.app', 'mastodon.social',
  'threads.net', 'tiktok.com', 'reddit.com', 'news.ycombinator.com', 'keybase.io', 'calendly.com', 'crunchbase.com', 'wellfound.com',
  'angel.co', 'dev.to', 'hashnode.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'pages.dev', 'web.app', 'stackoverflow.com',
];
const TWO_LEVEL_SUFFIX = /\.(?:co|com|org|ac|net|gov|edu)\.[a-z]{2}$/;

/**
 * Threads from a link on a profile already tied to the subject: a profile
 * page (and its handle) on a known service, or the person's own website as
 * a domain. Links to shared hosts lead nowhere useful and are skipped.
 */
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

function dedupeThreads(threads, skipHandle = '') {
  const seen = new Map();
  for (const t of threads.filter(Boolean)) {
    if (t.kind === 'handle' && skipHandle && t.value.toLowerCase() === skipHandle.toLowerCase()) continue;
    const key = `${t.kind}|${t.value.toLowerCase()}`;
    if (!seen.has(key) || (t.trusted && !seen.get(key).trusted)) seen.set(key, t);
  }
  return [...seen.values()];
}

/* ------------------------------------------------------------------ GitHub */

const GITHUB = 'https://api.github.com';
const GITHUB_LABEL = 'GitHub public profiles';
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_LIMIT_NOTE = "GitHub public profiles could not be read: the hourly allowance shared by this deployment's network address is used up, so they are missing from this check.";
// Not retried: an allowance that is used up stays used up for the hour. A deployment may set GITHUB_TOKEN (a
// token with no scopes, which costs nothing) for a larger hourly allowance of its own; without it, calls share
// the address's small one.
const githubGet = (path, ctx) => getJson(`${GITHUB}${path}`, {
  deadline: ctx.deadline, accept: 'application/vnd.github+json', retries: 0,
  headers: { 'X-GitHub-Api-Version': '2022-11-28', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
});
const rateLimited = (error) => error?.status === 403 || error?.status === 429;

/** A website field that holds an e-mail address instead of a link is not kept. */
const linkOnly = (s) => { const v = clean(s); return /^mailto:/i.test(v) || /^[^/\s]+@[^/\s]+$/.test(v) ? '' : v; };

/**
 * The city a profile states, and nothing finer: "Berlin, Germany" -> "Berlin". A location with a number in it
 * (a street, a postcode) or more than a few words is not kept at all.
 */
export function cityOf(location) {
  const first = clean(String(location || '').split(/[,;|/·•]/)[0]);
  if (!first || first.length > 40 || /\d|@|https?:/i.test(first) || first.split(' ').length > 4) return '';
  if (!/^[\p{L}][\p{L}' .-]*$/u.test(first)) return '';
  return clean(cleanSentences(first, { kin: false }).text);
}

/** The parts of a profile that are used. Its e-mail address is not among them; of the location, only the city. */
function githubProfile(p) {
  return {
    type: clean(p.type), login: clean(p.login), name: clean(p.name), company: clean(p.company), bio: safe(p.bio), blog: linkOnly(p.blog), city: cityOf(p.location),
    x: clean(p.twitter_username), repos: Number(p.public_repos) || 0, followers: Number(p.followers) || 0,
    createdAt: clean(p.created_at), updatedAt: clean(p.updated_at),
  };
}

/*
 * Reading a profile counts against a small hourly allowance, so the parts
 * that are used are remembered for an hour in this server instance's memory.
 */
const PROFILE_TTL_MS = 60 * 60 * 1000;
const profilesRead = new Map(); // login -> { at, profile }

async function githubUser(login, ctx) {
  const key = login.toLowerCase();
  const hit = profilesRead.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
  const raw = await githubGet(`/users/${encodeURIComponent(login)}`, ctx);
  if (!raw || typeof raw !== 'object' || !raw.login) throw new Error('GitHub answered without a profile');
  const profile = githubProfile(raw);
  if (profilesRead.size >= 300) profilesRead.delete(profilesRead.keys().next().value);
  profilesRead.set(key, { at: Date.now(), profile });
  return profile;
}

/** For tests: forget the profiles read so far. */
export function __resetProfilesForTests() {
  profilesRead.clear();
  workRead.clear();
}

const workRead = new Map(); // login -> { at, work }

/**
 * The public work behind an account: the organisations it is a public member
 * of and its most recently pushed repositories of its own (not forks). Best
 * effort: a part that cannot be read is left out, never shown as "none".
 * @returns {{ orgs: string[]|null, repos: object[]|null, limited: boolean }}
 */
async function githubWork(login, ctx) {
  const key = login.toLowerCase();
  const hit = workRead.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.work;
  const [orgs, repos] = await Promise.allSettled([
    githubGet(`/users/${encodeURIComponent(login)}/orgs?per_page=30`, ctx),
    githubGet(`/users/${encodeURIComponent(login)}/repos?sort=pushed&per_page=10&type=owner`, ctx),
  ]);
  const work = {
    orgs: orgs.status === 'fulfilled' && Array.isArray(orgs.value) ? orgs.value.map((o) => clean(o?.login)).filter((l) => GITHUB_LOGIN.test(l)).slice(0, 12) : null,
    repos: repos.status === 'fulfilled' && Array.isArray(repos.value)
      ? repos.value.filter((r) => r && !r.fork && clean(r.name))
        .map((r) => ({ name: clean(r.name), language: clean(r.language) || null, stars: Number(r.stargazers_count) || 0, pushedAt: clean(r.pushed_at).slice(0, 10) || null, description: safe(r.description).slice(0, 140) || null }))
        .sort((a, b) => b.stars - a.stars).slice(0, 5)
      : null,
    limited: [orgs, repos].some((r) => r.status === 'rejected' && rateLimited(r.reason)),
  };
  if (work.orgs || work.repos) {
    if (workRead.size >= 300) workRead.delete(workRead.keys().next().value);
    workRead.set(key, { at: Date.now(), work });
  }
  return work;
}

/** The public work, added to the account's finding: organisations, top repositories and their languages. */
function addWork(finding, work) {
  if (!finding || !work) return;
  const parts = [];
  if (work.orgs?.length) parts.push(`Public organisations: ${work.orgs.join(', ')}`);
  if (work.repos?.length) parts.push(`Repositories: ${work.repos.map((r) => `${r.name}${r.language || r.stars ? ` (${[r.language, r.stars ? `${count(r.stars)} stars` : ''].filter(Boolean).join(', ')})` : ''}`).join('; ')}`);
  if (parts.length) finding.quote = [finding.quote, ...parts].filter(Boolean).join(' | ').slice(0, 700);
  finding.data = {
    ...(finding.data || {}),
    ...(work.orgs ? { orgs: work.orgs } : {}),
    ...(work.repos ? { topRepos: work.repos, languages: [...new Set(work.repos.map((r) => r.language).filter(Boolean))] } : {}),
  };
}

const workLimitNote = (login) => `Part of the GitHub account ${login} (its organisations or repositories) could not be read: the hourly allowance shared by this deployment's network address is used up.`;

const YEAR_MS = 365 * 24 * 3600 * 1000;
/** An account with a history: over a year old, with public repositories or followers. */
const established = (profile, now = Date.now()) => {
  const t = Date.parse(profile.createdAt || '');
  return Number.isFinite(t) && now - t > YEAR_MS && (profile.repos > 0 || profile.followers > 0);
};

/** Whether one of the account's public organisations is a known company of the subject. */
function memberOfCompany(subject, orgs) {
  if (!orgs?.length) return '';
  for (const login of orgs) {
    if (knownCompanyOf(subject, login)) return login;
    for (const a of subject.anchors.companies.values()) {
      if (companyNamesOf(subject, a).some((n) => compactName(n).length >= 4 && compactName(n) === compactName(login))) return login;
    }
  }
  return '';
}

/** Whether the account's website is a known company's own domain (learned or written as the company's name). */
function blogOfCompany(subject, blog) {
  let host = '';
  try { host = new URL(/^https?:\/\//i.test(blog) ? blog : `https://${blog}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
  if (!host) return '';
  const domains = [...(subject.anchors.aliases?.values() || [])].map((a) => a.value).concat([...(subject.anchors.domains?.values() || [])].map((a) => a.value)).map((d) => String(d).toLowerCase());
  if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return host;
  const label = compactName(host.split('.')[0]);
  for (const a of subject.anchors.companies.values()) {
    if (companyNamesOf(subject, a).some((n) => compactName(n).length >= 4 && compactName(n) === label)) return host;
  }
  return '';
}

function githubFinding(subject, profile, grade) {
  const claims = [profile.name && `name "${profile.name}"`, profile.company && `company "${profile.company}"`].filter(Boolean).join(', ');
  const facts = [profile.createdAt && `account created ${profile.createdAt.slice(0, 10)}`, `${count(profile.repos)} public repositories`, `${count(profile.followers)} followers`].filter(Boolean).join(', ');
  return makeFinding(subject, {
    source: 'github', sourceLabel: GITHUB_LABEL, category: 'identity',
    title: `GitHub profile ${profile.login} (self-described: ${claims || 'no name or company stated'}): ${facts}`,
    quote: [profile.name, profile.company && `Company: ${profile.company}`, profile.bio && `Bio: ${profile.bio}`, profile.blog && `Blog: ${profile.blog}`, profile.city && `City: ${profile.city}`].filter(Boolean).join(' | '),
    url: `https://github.com/${profile.login}`,
    date: profile.createdAt || null,
    severity: 'info',
    ...grade,
    data: {
      login: profile.login, name: profile.name, company: profile.company, blog: profile.blog, x: profile.x || null,
      // what the profile says of its owner, for the profile page (self-described): bio, company and city
      bio: profile.bio || null, city: profile.city || null,
      publicRepos: profile.repos, followers: profile.followers, createdAt: profile.createdAt || null, updatedAt: profile.updatedAt || null,
    },
  });
}

/** What a profile tied to the subject leads to: its login, a linked X handle, the person's website. */
function githubThreads(profile, finding) {
  if (!finding || finding.match === 'possible') return [];
  return [
    makeThread('handle', profile.login, 'GitHub login of a profile tied to the person', { trusted: true, platform: 'github' }),
    profile.x ? makeThread('handle', profile.x, 'X handle linked from a profile tied to the person', { trusted: true, platform: 'x' }) : null,
    ...linkThreads(profile.blog, 'linked from their GitHub profile'),
  ];
}

const compactName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What a profile says about its owner, for grading. Companies are often
 * given as the company's own account ("@mistralai" for Mistral AI,
 * "@huggingface" for Hugging Face): when such an account is a known company
 * of the subject written without spaces, the company's name is spelled out
 * so the grader can see it.
 */
function githubText(subject, profile) {
  const text = [profile.company, profile.bio, profile.blog].filter(Boolean).join('. ');
  const accounts = new Set((text.match(/@[A-Za-z0-9][A-Za-z0-9-]{1,38}/g) || []).map(compactName));
  const spelled = [...subject.anchors.companies.values()].map((a) => a.value).filter((v) => compactName(v).length >= 5 && accounts.has(compactName(v)));
  return spelled.length ? `${text} (${spelled.join(', ')})` : text;
}

async function githubByName(subject, ctx) {
  if (nameTokens(subject.name).length < 2) return EMPTY();
  const name = (subject.variants[subject.variants.length - 1] || subject.name).replace(/"/g, '');
  let search;
  try {
    // Most-followed first: a founder's own account usually outranks namesakes and impostor accounts.
    search = await githubGet(`/search/users?q=${encodeURIComponent(`fullname:"${name}" type:user`)}&sort=followers&order=desc&per_page=8`, ctx);
  } catch (error) {
    if (rateLimited(error)) return { findings: [], threads: [], notes: [GITHUB_LIMIT_NOTE] };
    throw error;
  }
  if (!Array.isArray(search?.items)) throw new Error('GitHub answered without a list of accounts');
  const knownHandle = (login) => [...subject.anchors.handles.values()].some((a) => a.value.toLowerCase() === login.toLowerCase());
  const logins = search.items
    .filter((i) => i?.type === 'User' && GITHUB_LOGIN.test(i.login || '')).map((i) => i.login)
    .sort((a, b) => Number(knownHandle(b)) - Number(knownHandle(a)))
    .slice(0, 3);
  if (!logins.length) return EMPTY();
  let limited = false;
  let failure = null;
  const read = (await mapLimit(logins, 3, async (login) => {
    try { return await githubUser(login, ctx); } catch (error) {
      if (rateLimited(error)) limited = true; else if (error?.status !== 404) failure = error;
      return null;
    }
  })).filter(Boolean);
  if (!read.length && failure && !limited) throw failure;
  const namesakes = Math.max(Number(search.total_count) || 0, search.items.length);
  const pairs = [];
  for (const profile of read) {
    if (profile.type !== 'User' || statedName(subject, profile.name) !== 'same') continue;
    const grade = gradeNamedAccount(subject, `${subject.name}. ${profile.name}. ${githubText(subject, profile)} ${profile.login}`, namesakes, 'the GitHub profile');
    const finding = githubFinding(subject, profile, grade.fields);
    if (!finding) continue;
    if (grade.held) finding.matchFixed = true; // not upgraded later (the same school, or a self-described claim)
    pairs.push({ profile, finding });
  }
  pairs.sort((a, b) => MATCH_RANK[b.finding.match] - MATCH_RANK[a.finding.match] || b.profile.followers - a.profile.followers);
  const notes = limited ? [GITHUB_LIMIT_NOTE] : [];
  // Anyone can open an account in someone's name and company. When several claim to be the subject,
  // all are reported but only the most established one is followed.
  const tied = pairs.filter((p) => p.finding.match !== 'possible');
  if (tied.length > 1) notes.push(`${tied.length} GitHub accounts state this name and a known company (${tied.map((p) => p.profile.login).join(', ')}); only the most followed one, ${tied[0].profile.login}, is used to look further.`);
  let threads = [];
  if (tied.length) {
    const top = tied[0];
    const work = await githubWork(top.profile.login, ctx);
    if (work.limited && !limited) notes.push(workLimitNote(top.profile.login));
    addWork(top.finding, work);
    // A self-described account's links become leads only when something beyond its own words backs it: a history
    // (over a year old, with public work or followers), public membership of the company's organisation, or a
    // website on the company's own domain. A new, empty account in someone's name is not followed.
    const org = memberOfCompany(subject, work.orgs);
    const site = blogOfCompany(subject, top.profile.blog);
    if (org) top.finding.matchReasons = [...top.finding.matchReasons, `public member of the GitHub organisation ${org}`].slice(0, 5);
    if (site) top.finding.matchReasons = [...top.finding.matchReasons, `website on ${site}`].slice(0, 5);
    if (established(top.profile) || org || site) threads = dedupeThreads(githubThreads(top.profile, top.finding));
    else notes.push(`The GitHub account ${top.profile.login} states this name and a known company, but it is new and shows no public work, so its links were not followed.`);
  }
  return { findings: pairs.map((p) => p.finding), threads, notes };
}

async function githubByHandle(subject, handle, ctx, samePlatform = false) {
  if (!GITHUB_LOGIN.test(handle)) return EMPTY();
  let profile;
  try { profile = await githubUser(handle, ctx); } catch (error) {
    if (error?.status === 404) return EMPTY(); // no such account
    if (rateLimited(error)) return { findings: [], threads: [], notes: [GITHUB_LIMIT_NOTE] };
    throw error;
  }
  if (profile.type !== 'User') return EMPTY(); // an organisation's account is not a person's profile
  const grade = gradeAccount(subject, { name: profile.name, text: githubText(subject, profile), handle: profile.login, samePlatform });
  if (!grade) return { findings: [], threads: [], notes: [`The GitHub account "${profile.login}" states a different name and was left out.`] };
  const finding = githubFinding(subject, profile, grade);
  const notes = [];
  if (finding && finding.match !== 'possible') {
    const work = await githubWork(profile.login, ctx);
    addWork(finding, work);
    if (work.limited) notes.push(workLimitNote(profile.login));
  }
  return { findings: [finding].filter(Boolean), threads: dedupeThreads(githubThreads(profile, finding), handle), notes };
}

export const githubConnector = {
  id: 'github',
  label: GITHUB_LABEL,
  kinds: ['subject', 'handle'],
  prior: 0.45,
  timeoutMs: 12000,
  async run(task, ctx) {
    if (task.kind === 'handle') return githubByHandle(ctx.subject, clean(task.value).replace(/^@/, ''), ctx, handlePlatform(task) === 'github');
    if (task.kind === 'subject') return githubByName(ctx.subject, ctx);
    return EMPTY();
  },
};

/* ------------------------------------------------------------- Hacker News */

const HN_SEARCH = 'https://hn.algolia.com/api/v1/search';
const HN_USER = 'https://hacker-news.firebaseio.com/v0/user';
const HN_LABEL = 'Hacker News';
const HN_HANDLE = /^[A-Za-z0-9_-]{2,15}$/;
const CORPORATE_SUFFIX = /[,\s]+(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|sas|sa|plc|bv|ag|pte|pty)\.?$/i;
// Words that make a headline about a company as a business, not about a namesake of its name ("Nikola Tesla").
const BUSINESS = /\b(?:CEO|CTO|CFO|COO|founders?|co-?founders?|startup|raises?|raised|funding|valuation|valued|IPO|acquir\w+|acquisition|merger|investors?|shareholders?|shares|stock|layoffs?|lays off|employees|customers|revenue|bankrupt\w*|Chapter 11|SEC|FTC|DOJ|regulators?|Inc|Corp|company|launch(?:es|ed)?|announc\w+|Series [A-F]|partnership|partners with|deal|short[- ]seller|pricing|outage|shuts? down|shutdown|pivots?|(?:Show|Launch) HN)\b|\(YC [SWF]\d{2}\)|\$\s?\d/i;

async function hnStories(query, ctx) {
  const body = await getJson(`${HN_SEARCH}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=30`, { deadline: ctx.deadline });
  return (Array.isArray(body?.hits) ? body.hits : []).map((hit) => ({
    id: clean(hit.objectID),
    title: clean(hit.title),
    link: /^https?:\/\//i.test(hit.url || '') ? String(hit.url) : '',
    text: htmlToText(hit.story_text || '').replace(/\s+/g, ' ').slice(0, 3000),
    points: Number(hit.points) || 0,
    comments: Number(hit.num_comments) || 0,
    date: hit.created_at || null,
  })).filter((s) => /^\d+$/.test(s.id) && s.title);
}

/** The part of a post's own text around the person's name. */
function excerpt(text, subject) {
  const at = subject.hasName.positions(text)[0];
  if (!at) return text.slice(0, 320);
  const from = Math.max(0, at.start - 140);
  const to = Math.min(text.length, at.end + 220);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

/** An article whose address spells out the person's name ("/trevor-milton-indicted") is about that name. */
function linkNamesSubject(subject, link) {
  const tokens = nameTokens(subject.name);
  if (tokens.length < 2 || !link) return false;
  let path;
  try { path = decodeURIComponent(new URL(link).pathname).toLowerCase(); } catch { return false; }
  return new RegExp(`(?<![a-z0-9])${tokens[0]}[-_.]?${tokens[tokens.length - 1]}(?![a-z0-9])`).test(path);
}

/**
 * One story as a finding. `company` set: a story about that company which
 * does not name the person. The finding links to the article when there is
 * one (each article is then listed once across all press sources); the
 * discussion itself is in data.discussionUrl.
 */
function storyFinding(subject, story, company = '') {
  const discussion = `https://news.ycombinator.com/item?id=${story.id}`;
  const named = subject.hasName(`${story.title} ${story.text}`);
  const linkNamed = !named && linkNamesSubject(subject, story.link);
  const matchText = `${linkNamed ? `${subject.name}. ` : ''}${story.title}. ${story.text} ${story.link}`;
  return makeFinding(subject, {
    source: 'hacker-news', sourceLabel: HN_LABEL, category: 'press',
    title: `Hacker News (${count(story.points)} points, ${count(story.comments)} comments): ${story.title}`,
    quote: story.text ? excerpt(story.text, subject) : story.title,
    url: story.link || discussion,
    date: story.date,
    severity: severityFromText(story.title),
    ...(company ? companyStoryGrade(subject, story, company, matchText, named || linkNamed) : { matchText }),
    data: { points: story.points, comments: story.comments, discussionUrl: discussion },
  });
}

/**
 * A story about a company of the subject is a company record, unless it also
 * carries the person's full name (in its text or its article's address) and
 * grades as about them: it is then theirs, but 'likely' at most, since it was
 * found through the company.
 */
function companyStoryGrade(subject, story, company, matchText, fullName) {
  const graded = fullName ? matchSubject(subject, matchText, { date: story.date }) : { level: 'none', reasons: [] };
  if (graded.level === 'likely' || graded.level === 'confirmed') {
    const reasons = linkNamesSubject(subject, story.link) && !subject.hasName(`${story.title} ${story.text}`) ? ["the article's address names the person", ...graded.reasons] : graded.reasons;
    return { match: 'likely', matchReasons: reasons.slice(0, 4) };
  }
  return { match: 'company', matchReasons: [`about ${company}, a company of the subject`] };
}

/** The year the subject's tie to a company began, from a stated CEO tenure, or 0 when no source states it. */
function tieStartYear(subject, company) {
  const key = companyKeys(company)[0] || company.toLowerCase();
  const years = [...(subject.anchors.roles?.values() || [])]
    .filter((r) => (companyKeys(r.org || r.value)[0] || String(r.value).toLowerCase()) === key)
    .map((r) => Number(String(r.from).slice(0, 4)))
    .filter((y) => y > 0);
  return years.length ? Math.min(...years) : 0;
}

// What one organisation does with a product of its own ("Facebook launches Flow").
const PRODUCT_VERB = /^(?:launch(?:es|ed)?|releas(?:es|ed)|introduc(?:es|ed)|unveil(?:s|ed)?|open[- ]?sourc(?:es|ed)|ships?|shipped|debuts?|debuted|announc(?:es|ed))$/i;
const NOT_AN_ORG = new Set(['it', 'he', 'she', 'they', 'we', 'you', 'i', 'this', 'that', 'who', 'which', 'now', 'today', 'finally', 'also', 'and', 'or']);

/**
 * Whether a one-word company name is used for another organisation's product
 * in a story ("Facebook Launches Flow, a type checker"): a different
 * capitalised name directly before a product verb and the word. Names of the
 * subject and of their known companies and people do not count.
 */
function anotherOrgsProduct(subject, plain, text) {
  if (/\s/.test(plain)) return false;
  const re = new RegExp(`(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9.&]*)\\s+([A-Za-z-]+)\\s+(?:(?:its|a|the|new)\\s+)?${plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi');
  const own = new Set([
    ...nameTokens(subject.name),
    ...[...subject.anchors.companies.values(), ...subject.anchors.people.values()].flatMap((a) => nameTokens(a.value)),
    plain.toLowerCase(),
  ]);
  return [...text.matchAll(re)].some((m) => /^[A-Z]/.test(m[1]) && PRODUCT_VERB.test(m[2])
    && !NOT_AN_ORG.has(m[1].toLowerCase()) && !own.has(nameTokens(m[1])[0]));
}

function storyThreads(subject, pairs) {
  const threads = [];
  for (const { story, finding } of pairs) {
    if (finding.match === 'company') continue;
    threads.push(...threadsFromResult(subject, { title: story.title, snippet: story.text, url: story.link || finding.url }, { trusted: finding.match !== 'possible' }));
  }
  // Headlines are title-cased, so the name reader can over-capture a known
  // company together with the words before it ("Trump Pardons Nikola"): drop
  // a company thread that merely contains a known company of the subject.
  const known = [...subject.anchors.companies.values()].map((a) => compactName(a.value)).filter((v) => v.length >= 3);
  const overCaptured = (t) => t.kind === 'company' && known.some((k) => compactName(t.value) !== k && compactName(t.value).includes(k));
  return dedupeThreads(threads.filter((t) => t && !overCaptured(t))).slice(0, 20);
}

/** The same article is often submitted more than once: keep the submission that was discussed most. */
function bestPerArticle(pairs) {
  const byUrl = new Map();
  for (const p of pairs) {
    const prev = byUrl.get(p.finding.url);
    if (!prev || p.story.points > prev.story.points) byUrl.set(p.finding.url, p);
  }
  return [...byUrl.values()];
}

/** A story people actually talked about, as opposed to a link that sank without comment. */
const discussed = (story) => story.points >= 10 || story.comments >= 5;
/** Tied to the person first; then stories that were discussed; then what the headline says; then points. */
const byWeight = (a, b) => MATCH_RANK[b.finding.match] - MATCH_RANK[a.finding.match]
  || Number(discussed(b.story)) - Number(discussed(a.story))
  || SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity]
  || b.story.points - a.story.points;

async function hnAboutPerson(subject, ctx) {
  if (nameTokens(subject.name).length < 2) return EMPTY();
  const name = subject.variants[subject.variants.length - 1] || subject.name;
  const stories = await hnStories(`"${name.replace(/"/g, '')}"`, ctx);
  const pairs = bestPerArticle(stories.map((story) => ({ story, finding: storyFinding(subject, story) })).filter((p) => p.finding))
    .sort(byWeight)
    .slice(0, 15);
  return { findings: pairs.map((p) => p.finding), threads: storyThreads(subject, pairs), notes: [] };
}

async function hnAboutCompany(subject, company, ctx) {
  const plain = clean(company.replace(CORPORATE_SUFFIX, '')) || company;
  if (plain.length < 2) return EMPTY();
  const stories = await hnStories(`"${plain.replace(/"/g, '')}"`, ctx);
  const anchor = [...subject.anchors.companies.values()].find((a) => a.value.toLowerCase() === company.toLowerCase());
  const namesCompany = (text) => (anchor ? anchor.test(text) : mentions(text, plain));
  const hostKey = (companyKeys(company)[0] || '').replace(/\s+/g, '');
  const lastName = nameTokens(subject.name).pop() || '';
  const lastNameRe = lastName.length >= 4 ? new RegExp(`(?<![A-Za-z])${lastName}(?![A-Za-z])`, 'i') : null;
  const tieFrom = tieStartYear(subject, company);
  const pairs = [];
  for (const story of stories) {
    const text = `${story.title}. ${story.text}`;
    if (!namesCompany(text)) continue;
    if (subject.hasName(text)) { // names the person too: graded as a record about them
      const finding = storyFinding(subject, story);
      if (finding) pairs.push({ story, finding });
      continue;
    }
    // A company name is often an ordinary word or someone's first name: keep a story only when something else places it.
    // The article sits on the company's own site, or under the company's name on someone else's ("/nikola/").
    let ownAddress = false;
    try {
      const url = new URL(story.link);
      ownAddress = hostKey.length >= 4 && (url.hostname.toLowerCase().includes(hostKey) || url.pathname.toLowerCase().split('/').includes(hostKey));
    } catch { ownAddress = false; }
    const placed = ownAddress || (lastNameRe && lastNameRe.test(text)) || BUSINESS.test(story.title) || severityFromText(story.title) !== 'info';
    if (!placed || story.points < 3) continue;
    const finding = storyFinding(subject, story, company);
    if (!finding) continue;
    if (finding.match === 'company') {
      // Before the person's tie to the company began, the story is about the company without them;
      // and a one-word name used for another organisation's product is not the company.
      const year = Number(String(story.date || '').slice(0, 4));
      if (tieFrom && year && year < tieFrom) continue;
      if (anotherOrgsProduct(subject, plain, text)) continue;
    }
    pairs.push({ story, finding });
  }
  const kept = bestPerArticle(pairs)
    .sort(byWeight)
    .slice(0, 10);
  return { findings: kept.map((p) => p.finding), threads: storyThreads(subject, kept), notes: [] };
}

async function hnAccount(subject, handle, ctx, samePlatform = false) {
  if (!HN_HANDLE.test(handle)) return EMPTY();
  const user = await getJson(`${HN_USER}/${encodeURIComponent(handle)}.json`, { deadline: ctx.deadline });
  if (!user || !user.id) return EMPTY(); // the service answers "null" for a name nobody holds
  const id = clean(user.id);
  const about = htmlToText(user.about || '').replace(/\s+/g, ' ').trim();
  const created = Number(user.created) > 0 ? new Date(Number(user.created) * 1000).toISOString().slice(0, 10) : '';
  const grade = gradeAccount(subject, { name: subject.hasName(about) ? subject.name : '', text: safe(about), handle: id, samePlatform });
  const finding = makeFinding(subject, {
    source: 'hacker-news', sourceLabel: HN_LABEL, category: 'identity',
    title: `Hacker News account ${id} (self-described): ${[created && `created ${created}`, `karma ${count(user.karma)}`].filter(Boolean).join(', ')}`,
    quote: safe(about).slice(0, 600),
    url: `https://news.ycombinator.com/user?id=${encodeURIComponent(id)}`,
    date: created || null,
    severity: 'info',
    ...grade,
    data: { handle: id, karma: Number(user.karma) || 0, createdAt: created || null },
  });
  if (!finding) return EMPTY();
  const threads = finding.match === 'possible' ? [] : (about.match(/https?:\/\/[^\s<>"')\]]+/g) || []).slice(0, 4).flatMap((link) => linkThreads(link, 'linked from their Hacker News account'));
  return { findings: [finding], threads: dedupeThreads(threads, handle), notes: [] };
}

export const hackerNewsConnector = {
  id: 'hacker-news',
  label: HN_LABEL,
  kinds: ['subject', 'company', 'handle'],
  prior: 0.5,
  timeoutMs: 12000,
  async run(task, ctx) {
    if (task.kind === 'subject') return hnAboutPerson(ctx.subject, ctx);
    if (task.kind === 'company') return hnAboutCompany(ctx.subject, clean(task.value), ctx);
    if (task.kind === 'handle') return hnAccount(ctx.subject, clean(task.value).replace(/^@/, ''), ctx, handlePlatform(task) === 'hacker news');
    return EMPTY();
  },
};

/* ----------------------------------------------------------------- Keybase */

const KEYBASE = 'https://keybase.io/_/api/1.0/user/lookup.json';
const LINKED_LABEL = 'Linked accounts (Keybase identity proofs)';
const SERVICE = { twitter: 'X', github: 'GitHub', hackernews: 'Hacker News', reddit: 'Reddit', facebook: 'Facebook', dns: 'website', generic_web_site: 'website' };
const HANDLE_PLATFORM = { twitter: 'x', github: 'github', hackernews: 'hacker news' };

/** The accounts and websites a Keybase user has proven to control (each proof is checked by Keybase, not just stated). */
function provenLinks(them) {
  const seen = new Set();
  const out = [];
  for (const p of them?.proofs_summary?.all || []) {
    if (p?.state !== 1 || !p.nametag || !p.proof_type) continue; // 1 = the proof currently verifies
    const service = SERVICE[p.proof_type] || clean(p.proof_type);
    const key = `${service}|${String(p.nametag).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: p.proof_type, service, name: clean(p.nametag), url: clean(p.service_url) });
  }
  return out;
}

export const linkedAccountsConnector = {
  id: 'linked-accounts',
  label: LINKED_LABEL,
  kinds: ['handle'],
  prior: 0.3,
  timeoutMs: 12000,
  async run(task, ctx) {
    const { subject } = ctx;
    const handle = clean(task.value).replace(/^@/, '');
    if (task.kind !== 'handle' || !/^[A-Za-z0-9_.-]{1,39}$/.test(handle)) return EMPTY();
    // The thread says which service the handle is from when that is known; otherwise each is tried.
    const hint = `${task.platform || ''} ${task.why || ''}`.toLowerCase();
    const services = /\b(?:x|twitter)\b/.test(hint) ? ['twitter'] : /github/.test(hint) ? ['github'] : /hacker ?news/.test(hint) ? ['hackernews'] : ['github', 'twitter', 'hackernews'];
    const replies = await Promise.allSettled(services.map((service) => getJson(`${KEYBASE}?${service}=${encodeURIComponent(handle)}&fields=basics,profile,proofs_summary`, { deadline: ctx.deadline })));
    const answered = replies.filter((r) => r.status === 'fulfilled' && r.value?.status?.code === 0);
    if (!answered.length) {
      const failed = replies.find((r) => r.status === 'rejected');
      throw failed ? failed.reason : new Error(`Keybase lookup refused: ${clean(replies[0]?.value?.status?.name) || 'unknown reason'}`);
    }
    const accounts = new Map();
    for (const reply of answered) {
      for (const them of reply.value.them || []) {
        const username = clean(them?.basics?.username);
        if (username && !accounts.has(username)) accounts.set(username, them);
      }
    }
    const findings = [];
    const threads = [];
    const notes = [];
    for (const [username, them] of accounts) {
      const links = provenLinks(them);
      if (!links.length) continue;
      const fullName = clean(them.profile?.full_name);
      const bio = safe(them.profile?.bio); // the profile's location is not read
      // Only a lookup on the service the handle is known to come from reaches that handle's holder for certain.
      const grade = gradeAccount(subject, { name: fullName, text: `${bio}. ${links.map((l) => `${l.name} ${l.url}`).join(' ')}`, handle, samePlatform: services.length === 1 });
      if (!grade) { notes.push(`The Keybase account linked to the handle "${handle}" states a different name and was left out.`); continue; }
      const claims = [fullName && `name "${fullName}"`, bio && `bio "${bio}"`].filter(Boolean).join(', ');
      const created = Number(them.basics?.ctime) > 0 ? new Date(Number(them.basics.ctime) * 1000).toISOString().slice(0, 10) : null;
      const finding = makeFinding(subject, {
        source: 'linked-accounts', sourceLabel: LINKED_LABEL, category: 'identity',
        title: `Keybase account ${username} (self-described: ${claims || 'no name stated'}): proven control of ${links.map((l) => `${l.service} ${l.name}`).join(', ')}`,
        quote: [fullName, bio, ...links.map((l) => `${l.type}: ${l.name}`)].filter(Boolean).join(' | '),
        url: `https://keybase.io/${encodeURIComponent(username)}`,
        date: created,
        severity: 'info',
        ...grade,
        data: { keybase: username, name: fullName, links: links.map(({ service, name, url }) => ({ service, name, url })) },
      });
      if (!finding) continue;
      findings.push(finding);
      if (finding.match === 'possible') continue;
      for (const link of links) {
        if (HANDLE_PLATFORM[link.type]) threads.push(makeThread('handle', link.name, `${HANDLE_PLATFORM[link.type]} handle proven on Keybase by the same account holder`, { trusted: true, platform: HANDLE_PLATFORM[link.type] }));
        else if (link.service === 'website') threads.push(...linkThreads(link.name, 'proven on Keybase by the same account holder'));
      }
    }
    return { findings, threads: dedupeThreads(threads, handle), notes };
  },
};
