/**
 * Web archive: earlier versions of what a person said about themselves, and
 * how it changed.
 *
 * The Internet Archive's Wayback Machine keeps dated copies of public pages:
 * LinkedIn profiles, Crunchbase and AngelList pages, company team pages,
 * speaker bios. Reading several copies of the same page shows the claims a
 * search engine no longer surfaces: a degree that was later reworded, an
 * employer that was dropped, a title that grew.
 *
 * One connector, several lookups (each scored on its own):
 *   subject  guessed profile addresses (linkedin.com/in/first-last, ...), and
 *            listings of everything saved under a name-shaped address
 *            (old linkedin.com/pub/first-last/<id>, indeed.com/r/First-Last/<id>)
 *   url      a profile, bio or speaker page another source found: the main path
 *   handle   that handle's GitHub and Twitter pages
 *   domain   a company's team / about / leadership pages: when the person
 *            appears on them and how their title or bio changed
 *
 * Requests (verified 2026-11-14):
 *   copies of one address   GET web.archive.org/cdx/search/cdx?url=<page>&output=json
 *                           &fl=timestamp,endtimestamp,original,digest,length,groupcount
 *                           &filter=statuscode:200&filter=mimetype:text/html&collapse=timestamp:6
 *                           one row per month; 0.3 s, sometimes 7 s
 *   addresses under a name  GET web.archive.org/web/timemap/json?url=<prefix>&matchType=prefix|domain
 *                           &collapse=urlkey&fl=original,mimetype,timestamp,endtimestamp,groupcount,uniqcount
 *                           the archive queues these for about 5 s, then 3 to 25 s; under load it
 *                           answers 503 with a page titled "Temporarily Offline"
 *   one copy as served      GET web.archive.org/web/<timestamp>id_/<address>   (no archive toolbar);
 *                           a timestamp with no copy redirects to the nearest one
 *
 * At most 6 requests per lookup: one listing and a few copies.
 *
 * Identity: a guessed address is very often somebody else with the same
 * name. A page counts as the person's only when its own name line is theirs;
 * it is graded confirmed or likely only when its text also names a company,
 * school or associate already tied to them. A page that carries only the
 * name stays "possible" and none of its threads are followed. A copy of a
 * guessed address is "possible" unless its own text names the company the
 * user entered or two anchors (then "likely", never more), and nothing on a
 * guessed address is followed; a profile linked from a record already tied
 * to the person is at least "likely".
 *
 * Privacy: location lines are never read, contact details are removed, and
 * resumes are reduced to headline, roles and education (archiveClaims.js).
 */
import { request, mapLimit, htmlToText, HttpError } from '../http';
import { makeFinding, makeThread } from '../finding';
import { matchSubject, nameTokens } from '../identity';
import { profileFromUrl } from '../extract';
import { isBlockedUrl } from '../guardrails';
import { extractClaims, compareClaims, claimsQuote, claimsHeadline, claimsSignature, roleText, educationText, sameOrg, orgKey } from './archiveClaims';

const ID = 'web-archive';
const LABEL = 'Web archive (earlier versions of profiles and bios)';
const WB = 'https://web.archive.org';

const MAX_REQUESTS = 6; // per lookup: listings and copies together
const MAX_SNAPSHOTS = 4; // copies read of one page
const MAX_CHANGES = 6; // differences reported per page
const LIST_TIMEOUT_MS = 14000;
const WIDE_LIST_TIMEOUT_MS = 24000;
const SNAPSHOT_TIMEOUT_MS = 10000;
const CACHE_MS = 15 * 60 * 1000;

const SEVERITY_ORDER = { medium: 0, low: 1, info: 2 };
/** Words that mark a list of people with titles (used to tell a team page from a parked or empty one). */
const ROLE_WORD = /\b(chief|ceo|cto|cfo|coo|president|founder|director|officer|chairman|vice president|vp|partner)\b/gi;

// ---------- small helpers ----------

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const iso = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
const ym = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}`;
const tsMs = (ts) => Date.UTC(Number(ts.slice(0, 4)), Number(ts.slice(4, 6) || 1) - 1, Number(ts.slice(6, 8) || 1), Number(ts.slice(8, 10) || 0), Number(ts.slice(10, 12) || 0), Number(ts.slice(12, 14) || 0));
const msTs = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);
const timeLeft = (ctx) => (ctx && ctx.deadline ? ctx.deadline - Date.now() : Infinity);
/** "http://www.example.com:80/team" -> "http://www.example.com/team" (old copies were indexed with the port). */
const cleanOriginal = (u) => String(u || '').replace(/^(https?:\/\/[^/]+?):(?:80|443)(?=\/|$)/i, '$1').replace(/#.*$/, '');
/** The copy as a person should open it (with the archive's date bar). */
export const replayUrl = (ts, original) => `${WB}/web/${ts}/${cleanOriginal(original)}`;
/** The copy as the site served it (what the extractors read). */
const rawUrl = (ts, original) => `${WB}/web/${ts}id_/${cleanOriginal(original)}`;

// ---------- which page is this ----------

const FAMILIES = [
  { key: 'linkedin', template: 'archive.linkedin', host: /(^|\.)linkedin\.com$/, label: 'LinkedIn', noun: 'profile' },
  { key: 'indeed', template: 'archive.indeed', host: /(^|\.)indeed\.com$/, label: 'Indeed', noun: 'resume' },
  { key: 'angel', template: 'archive.angel', host: /^(angel\.co|wellfound\.com)$/, label: 'AngelList', noun: 'profile' },
  { key: 'crunchbase', template: 'archive.crunchbase', host: /(^|\.)crunchbase\.com$/, label: 'Crunchbase', noun: 'profile' },
  { key: 'aboutme', template: 'archive.aboutme', host: /^about\.me$/, label: 'about.me', noun: 'profile' },
  { key: 'github', template: 'archive.github', host: /^github\.com$/, label: 'GitHub', noun: 'profile' },
  { key: 'twitter', template: 'archive.twitter', host: /^(twitter\.com|x\.com)$/, label: 'Twitter', noun: 'profile' },
];
const hostOfPage = (page) => String(page || '').split('/')[0];
function familyOf(page) {
  const host = hostOfPage(page);
  return FAMILIES.find((f) => f.host.test(host)) || { key: 'page', template: 'archive.page', label: host, noun: 'page' };
}

const TRACKING = /^(utm_[a-z]+|trk|ref|ref_src|ref_url|source|fbclid|gclid|locale|lang|originalsubdomain|mc_[a-z]+|igshid|s|t)$/i;
const NOT_PAGES = /(^|\.)(archive\.org|google\.[a-z.]+|bing\.com|duckduckgo\.com|facebook\.com|instagram\.com|youtube\.com|youtu\.be|tiktok\.com|wikipedia\.org|wikidata\.org|reddit\.com)$/;

/**
 * The address of a page as the archive indexes it: no scheme, no "www.",
 * no tracking parameters; profile addresses cut back to the profile itself.
 * Returns null for something that is not a page worth tracking over time.
 */
export function pageOf(url) {
  let raw = String(url || '').trim();
  const inner = raw.match(/^https?:\/\/web\.archive\.org\/web\/[0-9*]+(?:[a-z]{2}_)?\/(.+)$/i);
  if (inner) [, raw] = inner;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || NOT_PAGES.test(host) || isBlockedUrl(`https://${host}/`)) return null;
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (/\.(pdf|docx?|pptx?|xlsx?|jpe?g|png|gif|svg|webp|mp4|mp3|zip|json|xml|rss)$/i.test(path)) return null;
  let query = '';
  if (/(^|\.)linkedin\.com$/.test(host)) {
    // fr.linkedin.com/in/x and uk.linkedin.com/in/x are the same profile; the archive keeps most copies under linkedin.com
    host = 'linkedin.com';
    const m = path.match(/^\/in\/[^/]+/i) || path.match(/^\/pub\/[^/]+(?:\/[0-9a-z]{1,4}){0,3}/i);
    if (!m || /^\/pub\/dir(\/|$)/i.test(path)) return null; // company pages, posts, name directories
    [path] = m;
  } else if (/^(twitter\.com|x\.com)$/.test(host)) {
    const m = path.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (!m || /^(home|search|explore|i|intent|share|hashtag|login|signup)$/i.test(m[1])) return null; // a tweet or a site page, not a profile
    host = 'twitter.com'; // where the older copies are
    path = `/${m[1]}`;
  } else if (host === 'github.com') {
    const m = path.match(/^\/([A-Za-z0-9-]{1,39})\/?$/);
    if (!m) return null; // a repository, not a profile
    path = `/${m[1]}`;
  } else if (/(^|\.)crunchbase\.com$/.test(host)) {
    const m = path.match(/^\/person\/[^/]+/i);
    if (!m) return null;
    host = 'crunchbase.com';
    [path] = m;
  } else {
    const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
    if (kept.length && kept.length <= 3) query = `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
  }
  path = path.replace(/\/+$/, '');
  return `${host}${path || '/'}${query}`;
}

const NOT_COMPANY_DOMAIN = /(^|\.)(linkedin\.com|twitter\.com|x\.com|github\.com|facebook\.com|instagram\.com|youtube\.com|medium\.com|substack\.com|gmail\.com|google\.com|outlook\.com|yahoo\.com|crunchbase\.com|angel\.co|wellfound\.com|about\.me|wikipedia\.org|archive\.org|indeed\.com|apple\.com|amazon\.com|microsoft\.com|wordpress\.com|blogspot\.com)$/;
function domainOf(value) {
  const v = String(value || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) || NOT_COMPANY_DOMAIN.test(v) || isBlockedUrl(`https://${v}/`)) return null;
  return v;
}

// ---------- whose page is this ----------

const plainWords = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’.]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const CREDENTIALS = new Set(['phd', 'mba', 'md', 'cfa', 'cpa', 'jd', 'esq', 'jr', 'sr', 'ii', 'iii', 'msc', 'bsc', 'pe', 'he', 'him', 'she', 'her', 'they', 'them']);

/**
 * Is this profile's name line the subject's name? Case does not matter here
 * (2010 LinkedIn pages print names in lower case), a middle initial may come
 * or go, and trailing credentials are ignored.
 */
export function nameIs(subject, name) {
  const got = plainWords(name);
  while (got.length > 2 && CREDENTIALS.has(got[got.length - 1])) got.pop();
  if (got.length < 2) return false;
  return (subject.variants && subject.variants.length ? subject.variants : [subject.name]).some((variant) => {
    const want = plainWords(variant);
    if (want.length < 2) return false;
    if (want.join(' ') === got.join(' ')) return true;
    if (got[0] !== want[0] || got[got.length - 1] !== want[want.length - 1]) return false;
    const middle = (a, b) => a.slice(1, -1).every((w) => w.length === 1 || b.includes(w));
    return middle(got, want) && middle(want, got);
  });
}

/** A profile belongs to whoever its name line says; a page that lists several people counts when it names the subject. */
function ownsPage(subject, claims) {
  if (claims.named === true) return true;
  if (claims.named === false) return false;
  return nameIs(subject, claims.name);
}

/**
 * The page's text for identity grading. Old pages often print names in lower
 * case or split them ("we work" for WeWork): an employer or school that is a
 * known anchor once case, spaces and "Inc" are ignored is added in the
 * anchor's own spelling so the matcher sees it.
 */
function contextText(claims, subject) {
  const text = [claims.headline, ...claims.roles.map(roleText), ...claims.education.map(educationText), claims.bioText].filter(Boolean).join('. ');
  if (!subject || !subject.anchors) return text;
  const names = [...claims.roles.map((r) => r.org), ...claims.education.map((e) => e.school)].filter(Boolean).map(orgKey);
  const extra = [];
  for (const kind of ['companies', 'schools']) {
    for (const a of (subject.anchors[kind] || new Map()).values()) {
      if (!a.test(text) && names.includes(orgKey(a.value))) extra.push(a.value);
    }
  }
  return extra.length ? `${text}. ${extra.join('. ')}` : text;
}

// ---------- the archive ----------

const pageCache = new Map();
/** Forget the pages read so far (tests). */
export function __resetArchiveCacheForTests() { pageCache.clear(); }
function remember(key, info) {
  if (pageCache.size > 150) pageCache.delete(pageCache.keys().next().value);
  pageCache.set(key, { at: Date.now(), info });
}

/**
 * The archive's own page for clients it takes for abusive bots. It can come back with a normal status in
 * place of a listing or a saved copy: it is a refusal, not a timeout and not the page that was asked for.
 */
const BOT_WALL = /suspected abusive (?:bot )?traffic|abusive bot traffic/i;
function botWall(text, url) {
  if (!BOT_WALL.test(String(text || '').slice(0, 4000))) return null;
  const error = new HttpError('The web archive turned automated requests away (it suspected bot traffic)', { url });
  error.botWall = true;
  return error;
}

/** A listing from the archive, parsed; its bot wall is reported as such. */
async function archiveJson(url, options) {
  const res = await request(url, { accept: 'application/json', ...options });
  try {
    return JSON.parse(res.text);
  } catch {
    throw botWall(res.text, url) || new HttpError('Response was not JSON', { url });
  }
}

function tableRows(json, what) {
  if (!Array.isArray(json)) throw new HttpError(`The web archive returned an unexpected ${what}`);
  if (json.length < 2) return [];
  const [head, ...rows] = json;
  if (!Array.isArray(head)) throw new HttpError(`The web archive returned an unexpected ${what}`);
  return rows.filter(Array.isArray).map((row) => Object.fromEntries(head.map((name, i) => [name, row[i]])));
}

/** The saved copies of one address that were served normally, one row per month, oldest first. */
async function listCaptures(page, ctx) {
  const url = `${WB}/cdx/search/cdx?url=${encodeURIComponent(page)}&output=json&fl=timestamp,endtimestamp,original,digest,length,groupcount&filter=statuscode:200&filter=mimetype:text/html&collapse=timestamp:6&limit=400`;
  const json = await archiveJson(url, { deadline: ctx.deadline, timeoutMs: LIST_TIMEOUT_MS });
  return tableRows(json, 'list of copies')
    .filter((r) => /^\d{14}$/.test(String(r.timestamp)) && r.original)
    .map((r) => ({ ts: String(r.timestamp), end: /^\d{14}$/.test(String(r.endtimestamp)) ? String(r.endtimestamp) : String(r.timestamp), original: String(r.original), digest: String(r.digest || ''), length: Number(r.length) || 0, count: Math.max(1, Number(r.groupcount) || 1) }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Every saved address under a prefix (or on a whole domain), one row per address. */
async function listUnder(prefix, ctx, { domain = false, filters = [], limit = 80, timeoutMs = WIDE_LIST_TIMEOUT_MS } = {}) {
  const extra = filters.map((f) => `&filter=${encodeURIComponent(f)}`).join('');
  const url = `${WB}/web/timemap/json?url=${encodeURIComponent(prefix)}&matchType=${domain ? 'domain' : 'prefix'}&collapse=urlkey&output=json&fl=original,mimetype,timestamp,endtimestamp,groupcount,uniqcount&filter=statuscode:200&filter=mimetype:text/html${extra}&limit=${limit}`;
  const json = await archiveJson(url, { deadline: ctx.deadline, timeoutMs, retries: 0 });
  return tableRows(json, 'list of addresses')
    .filter((r) => /^\d{14}$/.test(String(r.timestamp)) && r.original)
    .map((r) => ({ ts: String(r.timestamp), end: /^\d{14}$/.test(String(r.endtimestamp)) ? String(r.endtimestamp) : String(r.timestamp), original: String(r.original), digest: '', length: 0, count: Math.max(1, Number(r.groupcount) || 1) }));
}

/** One saved copy, as the site served it. The time is read back from the final address: the archive redirects to the nearest copy. */
async function fetchSnapshot(ts, original, ctx) {
  const res = await request(rawUrl(ts, original), { deadline: ctx.deadline, timeoutMs: SNAPSHOT_TIMEOUT_MS });
  const html = String(res.text || '');
  const wall = botWall(html, res.url);
  if (wall) throw wall;
  if (/<title>\s*Internet Archive: Temporarily Offline/i.test(html.slice(0, 800))) throw new HttpError('The web archive is temporarily offline', { url: res.url, retryable: true });
  const actual = (String(res.url || '').match(/\/web\/(\d{14})/) || [])[1] || ts;
  return { ts: actual, original, html };
}

/**
 * Which copies to read: the earliest, the latest, and the ones in between
 * where the page changed most. Without reading a copy the only signs of a
 * change are a new content digest and a lasting step in the page's size (a
 * section added, a redesign), so those steps are what is looked for; when
 * nothing stands out, copies spread evenly over the years. Stub copies (a
 * redirect notice, an empty shell) are passed over.
 */
export function pickCaptures(rows, max = MAX_SNAPSHOTS) {
  if (!Array.isArray(rows) || !rows.length || max < 1) return [];
  const real = rows.filter((r) => !r.length || r.length >= 1500);
  const usable = real.length >= 2 || (real.length === 1 && rows.length === 1) ? real : rows;
  if (usable.length <= max) return [...usable];
  const first = usable[0];
  const last = usable[usable.length - 1];
  if (max === 1) return [last];
  const chosen = [first, last];
  const span = Math.max(1, tsMs(last.ts) - tsMs(first.ts));
  const far = (row, gap) => chosen.every((c) => Math.abs(tsMs(c.ts) - tsMs(row.ts)) >= gap);
  const median = (list) => { const sorted = list.map((r) => r.length).sort((x, y) => x - y); return sorted[Math.floor(sorted.length / 2)] || 0; };
  const steps = [];
  for (let i = 1; i < usable.length - 1; i += 1) {
    const before = median(usable.slice(Math.max(0, i - 3), i));
    const after = median(usable.slice(i, i + 3));
    if (!before || !after || (usable[i].digest && usable[i].digest === usable[i - 1].digest)) continue;
    const step = Math.abs(Math.log(after / before));
    if (step >= 0.15) steps.push({ row: usable[i], step });
  }
  steps.sort((a, b) => b.step - a.step);
  for (const { row } of steps) {
    if (chosen.length >= max) break;
    if (far(row, span / 12)) chosen.push(row);
  }
  while (chosen.length < max) {
    let best = null;
    let bestGap = 0;
    for (const row of usable) {
      if (chosen.includes(row) || (row.digest && chosen.some((c) => c.digest === row.digest))) continue;
      const gap = Math.min(...chosen.map((c) => Math.abs(tsMs(c.ts) - tsMs(row.ts))));
      if (gap > bestGap) { best = row; bestGap = gap; }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen.sort((x, y) => x.ts.localeCompare(y.ts));
}

/**
 * Read the given copies. Returns { versions, blocked, tried }; throws when
 * the archive failed on every one of them (a copy that is simply missing
 * does not count as a failure).
 */
async function readCopies(targets, ctx, budget, { measure = false } = {}) {
  const results = await mapLimit(targets, 2, async (target) => {
    if (budget.left < 1 || timeLeft(ctx) < 2500) return { skipped: true, target };
    budget.left -= 1;
    try {
      return { target, snap: await fetchSnapshot(target.ts, target.original, ctx) };
    } catch (error) {
      return { target, error };
    }
  });
  const versions = [];
  const blocked = [];
  let failure = null;
  let tried = 0;
  for (const r of results) {
    if (!r || r.skipped) continue;
    tried += 1;
    if (r.error) { if (r.error.status !== 404) failure = failure || r.error; continue; }
    const claims = extractClaims(r.snap.html, r.target.original, { person: ctx.subject.hasName });
    if (claims.blocked) { blocked.push(r.target); continue; }
    if (versions.some((v) => v.ts === r.snap.ts && v.original === r.target.original)) continue;
    versions.push({ ts: r.snap.ts, original: r.target.original, claims, ...(measure ? { roleWords: (htmlToText(r.snap.html).match(ROLE_WORD) || []).length } : {}) });
  }
  if (tried > 0 && !versions.length && !blocked.length && failure) throw failure;
  versions.sort((a, b) => a.ts.localeCompare(b.ts));
  return { versions, blocked, tried };
}

/** List one page's copies and read a few of them, spread over time. */
async function readPage(page, ctx, budget, { reserve = 0 } = {}) {
  const key = `${ctx.subject.name}|${page}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  budget.left -= 1;
  let rows;
  try {
    rows = await listCaptures(page, ctx);
  } catch (error) {
    if (error && error.status === 403) rows = []; // the site asked the archive not to show its copies
    else throw error;
  }
  const info = { page, address: rows.length ? cleanOriginal(rows[rows.length - 1].original) : `https://${page}`, rows, captures: rows.reduce((n, r) => n + r.count, 0), versions: [], blocked: 0 };
  if (!rows.length) { remember(key, info); return info; }
  const picks = pickCaptures(rows, Math.max(1, Math.min(MAX_SNAPSHOTS, budget.left - reserve)));
  const read = await readCopies(picks, ctx, budget);
  info.versions = read.versions;
  info.blocked = read.blocked.length;
  // A copy that is only a sign-in wall: read the nearest other month instead, while the allowance lasts.
  const spare = [];
  for (const wall of read.blocked) {
    const near = rows.filter((r) => !picks.includes(r) && !spare.includes(r)).sort((a, b) => Math.abs(tsMs(a.ts) - tsMs(wall.ts)) - Math.abs(tsMs(b.ts) - tsMs(wall.ts)))[0];
    if (near) spare.push(near);
  }
  if (spare.length && budget.left - reserve > 0 && timeLeft(ctx) > 4000) {
    const more = await readCopies(spare.slice(0, budget.left - reserve), ctx, budget).catch(() => ({ versions: [], blocked: [] }));
    info.blocked += more.blocked.length;
    for (const v of more.versions) if (!info.versions.some((x) => x.ts === v.ts)) info.versions.push(v);
    info.versions.sort((a, b) => a.ts.localeCompare(b.ts));
  }
  if (read.tried > 0) remember(key, info);
  return info;
}

// ---------- turning what was read into findings ----------

/** Does the text name the person: their full name, or their first name used alone (as their own bio does)? */
function namesThem(subject, text) {
  const t = String(text || '');
  if (!t) return false;
  if (subject.hasName(t)) return true;
  const first = nameTokens(subject.name)[0] || '';
  return first.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(t);
}
/** The structured claims of a version, for the profile: titles with employers and dates, schools with degrees. */
function claimFields(c) {
  const roles = (c.roles || []).filter((r) => r.org && !NOT_AN_EMPLOYER.test(r.org)).slice(0, 12).map((r) => ({ title: r.title || '', org: r.org, dates: r.dates || '' }));
  const education = (c.education || []).slice(0, 6).map((e) => ({ school: e.school, degree: e.degree || '', dates: e.dates || '' }));
  return { format: c.format || '', ...(c.headline ? { headline: c.headline } : {}), roles, education };
}
/** Does a version say anything at all (a name line alone, or a builder's placeholder, says nothing)? */
const saysSomething = (c) => Boolean(c && (c.headline || c.bioText || (c.roles || []).length || (c.education || []).length));

const quoted = (s, n = 80) => `"${clip(s, n)}"`;

/** One line that says what changed, for a finding's title. */
export function describeChange(d) {
  if (d.field === 'headline') return `${d.aspect === 'title' ? 'title' : 'headline'} changed from ${quoted(d.before)} to ${quoted(d.after)}`;
  if (d.field === 'bio') return d.expanded ? 'bio expanded' : 'bio rewritten';
  if (d.field === 'education') {
    if (d.change === 'changed') return `${d.aspect === 'dates' ? 'education dates' : 'degree'} changed from ${quoted(d.before)} to ${quoted(d.after)}`;
    if (d.change === 'removed') return d.aspect === 'section' ? `education no longer listed (${quoted(d.before, 110)})` : `${d.aspect === 'degree' ? 'degree' : 'school'} no longer listed: ${quoted(d.before, 110)}`;
    if (d.aspect === 'degree') return `degree added to ${quoted(d.before, 80)}: now ${quoted(d.after, 110)}`;
    return `education added: ${quoted(d.after, 110)}`;
  }
  if (d.change === 'changed') return `${d.aspect === 'dates' ? 'role dates' : 'role'} changed from ${quoted(d.before)} to ${quoted(d.after)}`;
  if (d.change === 'removed') return d.aspect === 'section' ? `roles no longer listed (${quoted(d.before, 110)})` : `role no longer listed: ${quoted(d.before, 110)}`;
  return `role added: ${quoted(d.after, 110)}`;
}

const NOT_AN_EMPLOYER = /^(self[- ]?employed|freelanc\w*|independent|stealth\b.*|confidential|n\/?a|various|unemployed|retired|student|none|private|consultant|tba|tbd|tbc|coming soon|[-–—]+|options?)$/i;

const LEVEL_RANK = { none: 0, possible: 1, likely: 2, confirmed: 3 };
const TIED = (level) => level === 'confirmed' || level === 'likely';
const orgsOf = (c) => [...c.roles.map((r) => r.org), ...c.education.map((e) => e.school)].filter((o) => o && !NOT_AN_EMPLOYER.test(o));
const linksOf = (c) => (c.links || []).map((l) => pageOf(l)).filter(Boolean);
/** Do two copies list at least one employer or school in common? */
function sharesOrg(a, b) {
  const theirs = orgsOf(b);
  return orgsOf(a).some((x) => theirs.some((y) => sameOrg(x, y)));
}
/** Do two copies share an employer, a school or a linked profile? */
function sharesLine(a, b) {
  if (sharesOrg(a, b)) return true;
  const theirs = linksOf(b);
  return linksOf(a).some((x) => theirs.includes(x));
}
/** How many different anchors a grade rests on ("names Theranos", "names Stanford University"). */
const anchorCount = (reasons) => new Set((reasons || []).filter((r) => /^names /.test(r)).map((r) => r.toLowerCase())).size;
/** The weaker of two fixed grades (no fix means the copy was graded on its own text). */
const weakerFix = (a, b) => (!a ? b || null : !b ? a : LEVEL_RANK[a.match] <= LEVEL_RANK[b.match] ? a : b);

const wordSet = (s) => new Set(plainWords(s).filter((w) => w.length > 1));
/** The newer text keeps every word of the older one and only adds: an expansion, not an edit. */
function onlyAdds(before, after) {
  const A = wordSet(before);
  const B = wordSet(after);
  return A.size > 0 && B.size > A.size && [...A].every((w) => B.has(w));
}

/** Names of schools: sent as a school thread, never as an employer. */
const SCHOOL_WORDS = /(^|[\s,(])(lyc[ée]es?|[ée]coles?|universit(y|ies|é|e|at|ät|à|a)|institut(e|o)?|ENS|ENSAE|ParisTech|Polytechnique|T[ée]l[ée]com (?:Paris|SudParis|Bretagne)|Sciences Po|college|coll[èe]ge)(?=$|[\s,.)'’-])/i;
const LOOKS_LIKE_HOST = /^(https?:|www\.)|\b[a-z0-9-]+\.(com|net|org|io|co)\b/i;
/**
 * Is this employer name worth following? Not a fragment of another name on the
 * same copy ("Lyc" of "Lycée Hoche"), not a name cut after an initial
 * ("Lycée H"), not an address, and not three letters or fewer unless it is an
 * acronym that other copies of the page list too.
 */
export function usableOrg(org, siblings = [], elsewhere = []) {
  const name = String(org || '').trim();
  if (!name || LOOKS_LIKE_HOST.test(name)) return false;
  if (/\s[A-Z]\.?$/.test(name)) return false;
  const low = name.toLowerCase();
  if (siblings.some((o) => { const other = String(o || '').trim().toLowerCase(); return other.length > low.length && other.startsWith(low); })) return false;
  const letters = name.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length <= 3) {
    if (!/^[A-Z0-9&.\s]+$/.test(name) || letters.length < 2) return false;
    return elsewhere.some((o) => String(o || '').trim() === name);
  }
  return true;
}

/** Copies that say the same thing collapse into one version, remembered with the last date it was seen. */
function distinctVersions(versions) {
  const out = [];
  for (const v of versions) {
    const sig = claimsSignature(v.claims);
    const prev = out[out.length - 1];
    if (prev && prev.sig === sig) { prev.lastSeen = v; continue; }
    out.push({ ...v, sig, lastSeen: v });
  }
  return out;
}

const ORG_FILLER = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'the']);
/** Does this text name the organisation? "Co-founder and CEO of WeWork" and "we work" both name "WeWork, Inc.". */
export function textNamesOrg(text, org) {
  const want = plainWords(org).filter((w) => !ORG_FILLER.has(w)).join('');
  if (want.length < 3) return false;
  const words = plainWords(text);
  for (let i = 0; i < words.length; i += 1) {
    let joined = '';
    for (let j = i; j < Math.min(words.length, i + 4) && joined.length < want.length; j += 1) {
      joined += words[j];
      if (joined === want) return true;
    }
  }
  return false;
}

const OPEN_END = /\b(present|current|now|today|ongoing)\b/i;
/** A role shown as current ("2010 - Present") that a later copy shows with an end ("2010 - Sep 2019"). */
const roleEnded = (before, after) => OPEN_END.test(String(before || '')) && !OPEN_END.test(String(after || ''))
  && /(?:[-–—]|\bto\b)\s*(?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2}\b/.test(String(after || ''));

/**
 * Role differences as a reader should weigh them: an employer the newer copy still names in its bio or
 * headline is not gone (the roles table did not show it that day); a title that only grew ("Co-Founder" to
 * "Co-Founder & CEO") is noted, not flagged; a role shown as current that later has an end date is a
 * change of dates, reported at low severity.
 */
function adjustRoleChanges(list, older, newer) {
  const oldRoles = (older && older.roles) || [];
  const newRoles = (newer && newer.roles) || [];
  const out = [];
  for (const d of list) {
    if (d.field !== 'role') { out.push(d); continue; }
    if (d.change === 'removed' && d.aspect !== 'section' && d.about && (textNamesOrg(newer.bioText, d.about) || textNamesOrg(newer.headline, d.about))) continue;
    if (d.change === 'changed' && d.aspect === 'title') {
      const was = oldRoles.find((r) => roleText(r) === d.before);
      const now = newRoles.find((r) => roleText(r) === d.after);
      if (was && now && onlyAdds(was.title, now.title)) {
        out.push(roleEnded(was.dates, now.dates) ? { ...d, aspect: 'dates', severity: 'low' } : { ...d, severity: 'info' });
        continue;
      }
    }
    out.push(d);
  }
  // the same role, same title, shown as current and later with an end date: the comparison treats that as leaving a job and says nothing
  for (const was of oldRoles) {
    if (!was.org || !OPEN_END.test(String(was.dates || ''))) continue;
    const before = roleText(was);
    if (out.some((d) => d.field === 'role' && d.before === before)) continue;
    const now = newRoles.find((r) => r.org && sameOrg(r.org, was.org) && roleText(r) !== before && roleEnded(was.dates, r.dates));
    if (now) out.push({ field: 'role', change: 'changed', before, after: roleText(now), about: was.org, aspect: 'dates', severity: 'low' });
  }
  return out;
}

/**
 * The differences between versions, oldest to newest. Each part of a page
 * (headline, roles, education, bio) is compared with the last earlier
 * version that showed that part, so a copy that happens to lack a section
 * (a different layout, a shortened view) does not turn into "removed" and
 * then "added" again.
 */
function changeFindings(subject, base, what, page, versions) {
  const changes = [];
  const lastWith = { headline: null, role: null, education: null, bio: null };
  const has = {
    headline: (c) => Boolean(c.headline), role: (c) => c.roles.length > 0, education: (c) => c.education.length > 0, bio: (c) => Boolean(c.bioText),
  };
  versions.forEach((cur, i) => {
    if (i > 0) {
      const prev = versions[i - 1];
      const from = (field) => (has[field](cur.claims) && lastWith[field] ? lastWith[field] : prev);
      const older = {
        format: from('headline').claims.format,
        headline: from('headline').claims.headline,
        roles: from('role').claims.roles,
        education: from('education').claims.education,
        bioText: from('bio').claims.bioText,
      };
      for (const raw of adjustRoleChanges(compareClaims(older, cur.claims), older, cur.claims)) {
        // A bio on a page that is not a profile (a blog post's author box, a company's about page) is told about the
        // person only when it names them: another employee's bio beside their name is not their claim.
        if (raw.field === 'bio' && cur.claims.format === 'page' && !namesThem(subject, raw.before) && !namesThem(subject, raw.after)) continue;
        // Words only added to a bio or a profile tagline say more, not something different: noted, not flagged.
        const expanded = raw.change === 'changed' && (raw.field === 'bio' || (raw.field === 'headline' && raw.aspect !== 'title')) && onlyAdds(raw.before, raw.after);
        let d = expanded ? { ...raw, severity: 'info', expanded: true } : raw;
        // a degree that appears on a copy with masked lines is shown less sure: the older view may have hidden it
        if (cur.claims.masked && d.aspect === 'degree' && d.change === 'added') d = { ...d, severity: 'low' };
        // a copy with lines hidden behind asterisks cannot show that something is gone or was reworded, only what was added
        if (cur.claims.masked && d.change !== 'added') continue;
        const source = from(d.field);
        changes.push({ d, before: source.lastSeen || source, after: cur });
      }
    }
    for (const field of Object.keys(lastWith)) if (has[field](cur.claims) && !cur.claims.masked) lastWith[field] = cur;
  });
  // the same difference seen again against a later copy is one change
  const seenChange = new Set();
  const unique = changes.filter(({ d }) => { const k = `${d.field}|${d.change}|${d.before}|${d.after}`; if (seenChange.has(k)) return false; seenChange.add(k); return true; });
  unique.sort((a, b) => SEVERITY_ORDER[a.d.severity] - SEVERITY_ORDER[b.d.severity]);
  return unique.slice(0, MAX_CHANGES).map(({ d, before, after }) => makeFinding(subject, {
    ...base,
    ...(after.matchText ? { matchText: after.matchText } : {}),
    // a change is only as sure as the less sure of its two copies
    ...(weakerFix(before.fix, after.fix) || {}),
    title: `${what}: ${describeChange(d)} between ${ym(before.ts)} and ${ym(after.ts)}`,
    quote: `Before (${iso(before.ts)}): ${d.before ? `"${clip(d.before, 290)}"` : 'not listed'} After (${iso(after.ts)}): ${d.after ? `"${clip(d.after, 290)}"` : 'not listed'}`,
    url: replayUrl(after.ts, after.original),
    date: after.ts,
    severity: d.severity,
    data: { kind: 'change', page, field: d.field, change: d.change, before: d.before, after: d.after, fromDate: iso(before.ts), toDate: iso(after.ts), fromUrl: replayUrl(before.ts, before.original), toUrl: replayUrl(after.ts, after.original) },
  }));
}

const GUESSED_FIX = { match: 'possible', matchReasons: ['matched by name only: an address guessed from the name is often a namesake\'s'] };
const MERGED_FIX = { match: 'possible', matchReasons: ['this copy also lists lines found only in copies not tied to them: it may mix two people'] };
const CONFLICTED_FIX = { match: 'possible', matchReasons: ['shares a line with a copy of the page that may mix two people'] };

/**
 * Grades on a guessed address. A copy keeps its own grade, capped at "likely", only when its own text names
 * the company the user entered, or two different anchors, and no copy of the page looks like a mix of two
 * people (a copy tied by a single anchor that shares a line with a copy not tied to them). Every other copy
 * is "possible". A copy is never lifted through another copy.
 */
function liftGuessed(subject, graded) {
  const given = [...((subject.anchors && subject.anchors.companies) || new Map()).values()].filter((a) => a.origin === 'given');
  const namedAnchors = (g) => [...new Set((g.reasons || []).filter((r) => /^names /.test(r)).map((r) => r.slice(6)))];
  const lifted = graded.filter((g) => g.level === 'confirmed' && (given.some((a) => a.test(g.text)) || anchorCount(g.reasons) >= 2));
  for (const g of graded) {
    if (lifted.includes(g)) continue;
    const links = lifted.filter((t) => anchorCount(t.reasons) < 2 && sharesLine(t.v.claims, g.v.claims));
    if (!links.length) continue;
    g.conflicted = true;
    for (const t of links) t.merged = true;
  }
  const mixed = graded.some((g) => g.conflicted || g.merged);
  for (const g of graded) {
    if (!mixed && lifted.includes(g)) {
      const own = given.filter((a) => a.test(g.text)).map((a) => a.value);
      const names = [...new Set([...own, ...namedAnchors(g)])].slice(0, 2);
      g.level = 'likely';
      g.fix = { match: 'likely', matchReasons: [`address guessed from the name, but this copy names ${names.join(' and ')}`] };
    } else {
      g.level = 'possible';
      g.fix = GUESSED_FIX;
    }
  }
}

/**
 * Findings and threads for one page that was read.
 * `discovered`: the page came from a listing of look-alike addresses, so a
 * name-only match is reported in one line and the page itself becomes a
 * thread when it is tied to the subject.
 * `guessed`: the address was guessed from the name: a line is "possible"
 * unless its copy is lifted by liftGuessed (then "likely"), and nothing on
 * it is followed.
 * `linkedFrom`: the address was linked from a record tied to the subject: its
 * copies that carry the name and nothing at odds with the tied copies are
 * graded at least "likely", so their history is told.
 */
function reportPage(subject, info, { discovered = false, guessed = false, linkedFrom = null } = {}) {
  const out = { findings: [], threads: [], notes: [], found: info.rows.length > 0, named: false, level: 'none', directLevel: 'none' };
  if (!info.rows.length) return out;
  const fam = familyOf(info.page);
  const what = `${fam.label} ${fam.noun}`;
  if (info.blocked) out.notes.push(`${info.blocked} saved ${info.blocked === 1 ? 'copy' : 'copies'} of ${info.page} showed a sign-in wall instead of the ${fam.noun}.`);
  // A copy that names them but says nothing else (a builder's placeholder text, an empty shell) is not kept.
  const named = info.versions.filter((v) => ownsPage(subject, v.claims));
  const own = named.filter((v) => saysSomething(v.claims));
  if (!own.length) {
    if (named.length) out.notes.push(`The saved copies of ${info.page} that were read name ${subject.name} but say nothing else about them.`);
    else if (info.versions.length) out.notes.push(`The saved copies of ${info.page} that were read do not name ${subject.name}.`);
    return out;
  }
  out.named = true;
  // Each copy is graded on its own text: a namesake's copy of the same address must not borrow a tie from the person's copy.
  const graded = own.map((v) => {
    const text = `${subject.name}. ${contextText(v.claims, subject)}`.slice(0, 8000);
    const m = matchSubject(subject, text);
    return { v, text, level: m.level, direct: TIED(m.level) && !guessed, reasons: m.reasons, fix: null };
  });
  out.directLevel = graded.reduce((best, g) => (LEVEL_RANK[g.level] > LEVEL_RANK[best] ? g.level : best), 'none');
  const directlyTied = graded.filter((g) => g.direct);
  // A copy that names no anchor but lists an employer, school or link of a tied copy is the same person's page at
  // another time, but only when that tied copy rests on two anchors or more. A copy tied by one anchor that shares
  // lines with untied copies may be a merged profile (the person's company next to a namesake's career): every
  // copy involved stays "possible" and nothing on them is followed.
  for (const g of graded) {
    if (g.direct || guessed) continue;
    const links = directlyTied.filter((t) => sharesLine(t.v.claims, g.v.claims));
    if (!links.length) continue;
    const strong = links.find((t) => anchorCount(t.reasons) >= 2);
    if (strong) {
      g.text = `${g.text}. ${contextText(strong.v.claims, subject)}`.slice(0, 8000);
      g.level = matchSubject(subject, g.text).level;
      continue;
    }
    g.conflicted = true;
    g.level = 'possible';
    g.fix = CONFLICTED_FIX;
    for (const t of links) t.merged = true;
  }
  for (const t of directlyTied) if (t.merged) { t.direct = false; t.level = 'possible'; t.fix = MERGED_FIX; }
  // A profile linked from a record tied to them: a copy that carries their name and nothing at odds with the tied copies is theirs.
  if (linkedFrom && !guessed) {
    const anyDirect = graded.some((g) => g.direct);
    for (const g of graded) {
      if (TIED(g.level) || g.conflicted || g.merged) continue;
      if (anyDirect && orgsOf(g.v.claims).length) continue;
      g.level = 'likely';
      g.fix = { match: 'likely', matchReasons: [`profile linked from ${linkedFrom}`] };
    }
  }
  if (guessed) liftGuessed(subject, graded);
  for (const g of graded) g.tied = TIED(g.level);
  out.level = graded.reduce((best, g) => (LEVEL_RANK[g.level] > LEVEL_RANK[best] ? g.level : best), 'none');
  const trusted = graded.some((g) => g.tied);
  // The history is told over the tied copies only; with none tied, over all of them (every line then stays "possible").
  const history = trusted ? graded.filter((g) => g.tied) : graded;
  const others = trusted ? graded.filter((g) => !g.tied) : [];
  const latest = history[history.length - 1];
  const page = info.address;
  const base = { source: ID, sourceLabel: LABEL, category: 'archive' };
  const first = info.rows[0].ts;
  const last = info.rows.reduce((max, r) => (r.end > max ? r.end : max), info.rows[info.rows.length - 1].ts);
  let versions = distinctVersions(history.map((g) => ({ ...g.v, matchText: g.text, fix: g.fix })));
  // A guessed address is most often a namesake: say it in two lines, not a history (unless copies of it were lifted on their own text).
  const brief = guessed && !trusted;
  if (brief) versions = versions.slice(-1);

  // One record per page: its latest version, carrying how often and over what time the page was saved. An earlier
  // version is its own record only when it lists an employer, a school or a degree the latest does not (what it
  // adds to the profile); otherwise it is folded into the latest's data. The changes are told separately.
  const span = info.captures === 1 ? `archived once, on ${iso(first)}` : ym(first) === ym(last) ? `archived ${info.captures} times in ${ym(first)}` : `archived ${info.captures} times between ${ym(first)} and ${ym(last)}`;
  const summarise = trusted || !discovered;
  const snapshotOf = (v, matchText, fix = null, extra = null) => {
    const line = claimsHeadline(v.claims);
    if (!line && !extra) return;
    out.findings.push(makeFinding(subject, {
      ...base,
      matchText,
      ...(fix || {}),
      title: extra
        ? `${what}${line ? ` as of ${iso(v.ts)}: ${line}` : ''}${line ? ` (${span})` : ` ${span}`}`
        : `${what} as of ${iso(v.ts)}: ${line}`,
      quote: claimsQuote(v.claims, extra ? 300 : 680),
      // the page's summary keeps its address in the archive's calendar, so another lookup of the page folds into it
      url: extra ? `${WB}/web/*/${info.page}` : replayUrl(v.ts, v.original),
      date: extra ? last : v.ts,
      severity: 'info',
      // the version's own fields, so the profile can read roles and schools as a record (not from a sentence)
      data: { kind: 'snapshot', page, capturedAt: iso(v.ts), claims: claimFields(v.claims), ...(extra || {}) },
    }));
  };
  const latestV = versions[versions.length - 1];
  const latestOrgs = orgsOf(latestV.claims);
  const latestDegrees = new Set(latestV.claims.education.map((e) => `${orgKey(e.school)}|${e.degree}`));
  // A version graded differently from the latest (tied through another copy, held back as a possible mix) keeps
  // its own record: folding it would lend it the latest's grade.
  const levelOf = (v) => (v.fix && v.fix.match) || matchSubject(subject, v.matchText || '').level;
  const latestLevel = levelOf(latestV);
  const addsToProfile = (v) => levelOf(v) !== latestLevel
    || orgsOf(v.claims).some((o) => !latestOrgs.some((x) => sameOrg(x, o)))
    || v.claims.education.some((e) => e.degree && !latestDegrees.has(`${orgKey(e.school)}|${e.degree}`));
  const folded = [];
  const kept = [];
  for (const v of versions.slice(0, -1)) {
    if (addsToProfile(v)) kept.push(v);
    else folded.push({ date: iso(v.ts), line: claimsHeadline(v.claims), url: replayUrl(v.ts, v.original) });
  }
  if (summarise) {
    snapshotOf(latestV, latestV.matchText || latest.text, latestV.fix || latest.fix || null, {
      first: iso(first), last: iso(last), captures: info.captures, replay: replayUrl(latestV.ts, latestV.original),
      ...(folded.length ? { versions: folded } : {}),
    });
  } else snapshotOf(latestV, latestV.matchText, latestV.fix);
  for (const v of kept) snapshotOf(v, v.matchText, v.fix);
  // copies that carry only the name, next to copies tied to the person: one line each, graded on their own text, never diffed
  const otherSigs = new Set();
  for (const g of others) {
    const sig = claimsSignature(g.v.claims);
    if (otherSigs.has(sig)) continue;
    otherSigs.add(sig);
    snapshotOf(g.v, g.text, g.fix);
  }
  const changes = brief ? [] : changeFindings(subject, base, what, page, versions);
  out.findings.push(...changes);
  if (changes.some((f) => f && f.data.change === 'removed')) out.notes.push(`Something missing from a later copy of ${info.page} can also mean the site showed less that day (for example to visitors who were not signed in): open both copies before relying on it.`);
  if (!brief && versions.length === 1 && history.length > 1) out.notes.push(`${what}: the ${history.length} copies read between ${ym(history[0].v.ts)} and ${ym(latest.v.ts)} say the same thing.`);
  if (graded.some((g) => g.merged)) out.notes.push(`A saved copy of ${info.page} lists ${subject.name}'s company next to lines found only in copies not tied to them: it may mix two people, so it is kept as "possible" and nothing on it was followed.`);
  if (others.length) out.notes.push(`${others.length} saved ${others.length === 1 ? 'copy' : 'copies'} of ${info.page} carry ${subject.name}'s name but nothing else tied to them; ${others.length === 1 ? 'it was' : 'they were'} not compared with the others and may be someone else's.`);
  out.findings = out.findings.filter(Boolean);

  // Threads: employers, schools and the other profiles the page links to. Trusted only from copies that name an
  // anchor themselves (never from a copy tied through another copy, a merged copy or a guessed address), and
  // never for a name first listed on a copy that is not tied to them.
  if (guessed) return out;
  const seen = new Set();
  const counts = { company: 0, school: 0, url: 0 };
  const caps = { company: 12, school: 6, url: 5 };
  const add = (kind, value, why, extra = {}) => {
    const key = `${kind}|${String(value).toLowerCase()}`;
    if (seen.has(key) || counts[kind] >= caps[kind]) return;
    const thread = makeThread(kind, value, why, { trusted, ...extra });
    if (!thread) return;
    seen.add(key);
    counts[kind] += 1;
    out.threads.push(thread);
  };
  const schools = [];
  const byTime = [...graded].sort((a, b) => a.v.ts.localeCompare(b.v.ts));
  /** Was this name (or link) listed on a copy not tied to them before any tied copy listed it? */
  const firstUntied = (match) => { const first = byTime.find((g) => match(g.v.claims)); return Boolean(first) && !first.direct; };
  const school = (value, why, tie) => {
    if (schools.some((x) => sameOrg(x, value))) return;
    schools.push(value);
    add('school', value, why, tie);
  };
  // directly tied copies first (newest first), so a name a tied copy shares with an untied one keeps its trust
  for (const g of [...graded].reverse().sort((a, b) => Number(b.direct) - Number(a.direct))) {
    const { v } = g;
    const names = orgsOf(v.claims);
    const elsewhere = graded.filter((x) => x !== g).flatMap((x) => orgsOf(x.v.claims));
    const tieFor = (name) => ({ trusted: g.direct && !firstUntied((c) => orgsOf(c).some((o) => sameOrg(o, name))) });
    for (const r of v.claims.roles) {
      if (!r.org || r.org.length > 80 || NOT_AN_EMPLOYER.test(r.org) || subject.hasName(r.org)) continue;
      if (!usableOrg(r.org, names.filter((o) => o !== r.org), elsewhere)) continue;
      if (SCHOOL_WORDS.test(r.org)) school(r.org, `listed on their ${what} (${ym(v.ts)})`, tieFor(r.org));
      else add('company', r.org, `${r.title ? `${clip(r.title, 60)}; ` : ''}listed on their ${what} (${ym(v.ts)})`, tieFor(r.org));
    }
    for (const e of v.claims.education) {
      if (!e.school || e.school.length > 100 || !usableOrg(e.school, names.filter((o) => o !== e.school), elsewhere)) continue;
      school(e.school, `listed on their ${what} (${ym(v.ts)})`, tieFor(e.school));
    }
    for (const link of v.claims.links || []) {
      const profile = profileFromUrl(link);
      const target = profile && pageOf(profile.url);
      if (!target || target === info.page) continue;
      add('url', profile.url, `linked from their ${what}`, { platform: profile.platform, trusted: g.direct && !firstUntied((c) => linksOf(c).includes(target)) });
    }
  }
  if (discovered && graded.some((g) => g.direct)) add('url', `https://${info.page}`, `their ${what}, found in the web archive`);
  return out;
}

/** Profile addresses the check already holds from records tied to the subject (when the loop provides them). */
function knownPages(ctx) {
  let list = [];
  try { list = typeof ctx.knownUrls === 'function' ? ctx.knownUrls() || [] : []; } catch { list = []; }
  return list.map((u) => pageOf(typeof u === 'string' ? u : u && u.value)).filter(Boolean);
}

/**
 * The record a profile address was linked from, from the thread's reason ("linked from their Crunchbase
 * profile", "linkedin profile listed on Wikidata"); null when the address was not given by a tied record.
 */
export function linkedSource(why, page) {
  const text = String(why || '').trim();
  if (!text || familyOf(page).key === 'page' || /found in the web archive/i.test(text)) return null;
  const from = text.match(/\blinked from (.{3,80})$/i) || text.match(/\blisted on (?:the )?(.{3,80})$/i) || text.match(/\bprofile (?:on|from) (?:the )?(.{3,80})$/i);
  if (from) return clip(from[1].replace(/^their\s+/i, 'their '), 80);
  return /\bprofile\b/i.test(text) ? 'a record tied to them' : null;
}

const merge = (into, part) => {
  into.findings.push(...part.findings);
  into.threads.push(...part.threads);
  into.notes.push(...part.notes);
};

// ---------- the lookups ----------

/** Guessed or given addresses: read the first one that turns out to be the person's page. */
async function runPages(allPages, ctx, budget, { guessed = false, linkedFrom = null } = {}) {
  const out = { findings: [], threads: [], notes: [] };
  const empty = [];
  const unchecked = [];
  let pages = allPages;
  if (guessed) {
    // A profile address already known from a record tied to them makes a guess on that site pointless, and a
    // different guessed address there is someone else's.
    const known = knownPages(ctx);
    pages = allPages.filter((page) => !known.some((k) => familyOf(k).key !== 'page' && familyOf(k).key === familyOf(page).key));
    if (!pages.length) return out;
  }
  for (const [i, page] of pages.entries()) {
    if (budget.left < 2 || timeLeft(ctx) < 3000) { unchecked.push(...pages.slice(i)); break; }
    // a guessed spelling keeps two requests (a listing and a copy) for each spelling after it: the first one is often a namesake
    const reserve = guessed ? (pages.length - i - 1) * 2 : 0;
    const info = await readPage(page, ctx, budget, { reserve });
    if (!info.rows.length) { empty.push(page); continue; }
    const part = reportPage(ctx.subject, info, { guessed, linkedFrom });
    merge(out, part);
    if (part.directLevel === 'confirmed' || part.directLevel === 'likely' || (part.named && !guessed)) break; // their page: the other spelling is not needed
  }
  if (empty.length && !out.findings.length) out.notes.push(`The web archive holds no readable copy of ${empty.join(' or ')}.`);
  if (unchecked.length) out.notes.push(`${unchecked.join(' and ')} ${unchecked.length === 1 ? 'was' : 'were'} not checked in the web archive this time (the lookup reached its limit).`);
  return out;
}

/** Everything saved under a name-shaped address (old LinkedIn and Indeed addresses end in an id that cannot be guessed). */
async function runPrefix(prefix, ctx, budget) {
  const out = { findings: [], threads: [], notes: [] };
  budget.left -= 1;
  const rows = await listUnder(prefix, ctx, { limit: 80 });
  const fam = familyOf(prefix);
  const pages = new Map();
  for (const row of rows) {
    const page = pageOf(row.original);
    if (!page || !page.toLowerCase().startsWith(prefix.toLowerCase().replace(/\/$/, ''))) continue;
    const known = pages.get(page);
    if (!known) pages.set(page, { page, ...row });
    else pages.set(page, { ...known, ts: row.ts < known.ts ? row.ts : known.ts, end: row.end > known.end ? row.end : known.end, count: known.count + row.count, original: row.count > known.count ? row.original : known.original });
  }
  const candidates = [...pages.values()].sort((a, b) => b.count - a.count || b.end.localeCompare(a.end));
  if (!candidates.length) {
    out.notes.push(`The web archive lists no saved ${fam.label} ${fam.noun} under ${prefix}.`);
    return out;
  }
  const picks = candidates.slice(0, Math.max(1, Math.min(4, budget.left)));
  // the latest copy of each: later copies of a profile carry more
  const read = await readCopies(picks.map((c) => ({ ts: c.end, original: c.original, page: c.page })), ctx, budget);
  let namesakes = 0;
  let readable = 0;
  for (const c of picks) {
    const version = read.versions.find((v) => cleanOriginal(v.original) === cleanOriginal(c.original));
    if (!version) continue;
    readable += 1;
    const info = { page: c.page, address: cleanOriginal(c.original), rows: [{ ts: c.ts, end: c.end, original: c.original, count: c.count }], captures: c.count, versions: [version], blocked: 0 };
    const part = reportPage(ctx.subject, info, { discovered: true });
    if (part.named && part.level === 'possible') { namesakes += 1; if (namesakes > 2) continue; }
    merge(out, part);
  }
  if (!readable) out.notes.push(`The web archive lists ${candidates.length} ${fam.label} ${fam.noun} address${candidates.length === 1 ? '' : 'es'} under ${prefix} but holds no readable copy of ${candidates.length === 1 ? 'it' : 'the ones tried'}.`);
  else if (candidates.length > picks.length) out.notes.push(`${candidates.length} ${fam.label} ${fam.noun} addresses are saved under ${prefix}; the ${picks.length} with the most copies were read.`);
  return out;
}

const TEAM_WORDS = '(team|leadership|leaders|management|executive|founder|people|staff|principals|partners|board|directors|officers|about|company|who-we-are|our-story|bios?)';
const TEAM_NOISE = '.*/(careers?|jobs?|blog|news|press|media|events?|products?|support|help|docs?|wp-content|wp-json|assets|static|tag|category|author|feed|legal|search|scripts?|styles?|images?|img|bundles|cdn-cgi)(/.*)?';

/** How much an address looks like a team or leadership page (0: not at all). */
export function teamPageScore(original, subject) {
  let u;
  try { u = new URL(original); } catch { return 0; }
  if (u.search && u.search.length > 1) return 0;
  let path = u.pathname.toLowerCase();
  try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  if (/\.(js|css|png|jpe?g|gif|svg|ico|pdf|xml|json|txt|woff2?)$/.test(path)) return 0;
  const segs = path.split('/').filter(Boolean);
  if (!segs.length || segs.length > 3) return 0;
  if (segs.some((s) => /^(careers?|jobs?|blog|news|press|media|events?|products?|support|help|docs?|wp-content|wp-json|assets|static|tag|category|author|feed|legal|privacy|terms|search|login|signup|cdn-cgi|scripts?|styles?|images?|img|app|api|bundles)$/.test(s))) return 0;
  const last = segs[segs.length - 1].replace(/\.(s?html?|php|aspx?|jsp|cfm)$/, '');
  const words = last.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...list) => list.some((w) => words.includes(w));
  let score = 0;
  if (has('team', 'leadership', 'leaders', 'management', 'executives', 'executive', 'founders', 'founder', 'people', 'staff', 'principals', 'partners', 'bod', 'board', 'directors', 'officers')) score = 5;
  else if (has('about', 'aboutus', 'company', 'who', 'story', 'bios', 'bio')) score = 3;
  const tokens = nameTokens(subject.name);
  const [firstName, lastName] = [tokens[0] || '', tokens[tokens.length - 1] || ''];
  // a page of their own: /team/jane-roe, /people/roe, /about/jr.shtml
  if (lastName.length >= 4 && path.includes(lastName)) score = Math.max(score, 6);
  else if (segs.length >= 2 && firstName && lastName && new RegExp(`^${firstName[0]}[a-z]?${lastName[0]}$`).test(last)) score = Math.max(score, 4.5);
  else if (!score && segs.length >= 2 && /^(team|leadership|management|people|about|company|bios?)$/.test(segs[0])) score = 1.5;
  if (!score) return 0;
  return score - (segs.length - 1) * 0.5;
}

const TEAM_GUESSES = ['leadership', 'team', 'about'];

/** The copies of a domain's usual team addresses (/leadership, /team, /about), first one found, as one row per address; null when none could be asked. */
async function guessTeamPages(domain, ctx, budget) {
  let answered = 0;
  for (const path of TEAM_GUESSES) {
    if (budget.left < 3 || timeLeft(ctx) < 5000) break;
    budget.left -= 1;
    let rows;
    try { rows = await listCaptures(`${domain}/${path}`, ctx); } catch (error) { if (error && error.botWall) throw error; continue; }
    answered += 1;
    if (!rows.length) continue;
    const last = rows[rows.length - 1];
    return [{ ts: rows[0].ts, end: rows.reduce((max, r) => (r.end > max ? r.end : max), last.ts), original: last.original, digest: '', length: 0, count: rows.reduce((n, r) => n + r.count, 0) }];
  }
  return answered ? [] : null;
}

/** A company's team pages over time: when the person is named on them and what stands beside their name. */
async function runDomain(domain, ctx, budget) {
  const subject = ctx.subject;
  const out = { findings: [], threads: [], notes: [] };
  const tokens = nameTokens(subject.name);
  const lastName = tokens[tokens.length - 1] || '';
  const words = lastName.length >= 4 && /^[a-z0-9]+$/.test(lastName) ? TEAM_WORDS.replace(/\)$/, `|${lastName})`) : TEAM_WORDS;
  budget.left -= 1;
  let rows;
  try {
    // leave time for the fallback below when the archive is slow
    const wait = Math.max(5000, Math.min(WIDE_LIST_TIMEOUT_MS, timeLeft(ctx) - 9000));
    rows = await listUnder(domain, ctx, { domain: true, filters: [`urlkey:.*\\)/.*${words}.*`, `!urlkey:${TEAM_NOISE}`], limit: 150, timeoutMs: wait });
  } catch (error) {
    if (!(error && (error.retryable || error.status >= 500))) throw error;
    // The listing of a whole site is queued and can time out; the usual team addresses listed one by one answer in under a second.
    rows = await guessTeamPages(domain, ctx, budget);
    if (!rows) throw error;
    out.notes.push(`The web archive did not list ${domain} in time; its usual team page addresses were checked instead.`);
  }
  const pages = rows.map((row) => ({ ...row, score: teamPageScore(row.original, subject) })).filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count).slice(0, 3);
  if (!pages.length) {
    out.notes.push(`The web archive lists no team, leadership or about page for ${domain}.`);
    return out;
  }
  // First and last copy of the best pages, then a middle copy of the best one: five copies at most.
  const targets = [];
  const want = (p, ts) => { if (!targets.some((t) => t.page === p && t.ts === ts)) targets.push({ page: p, ts, original: p.original }); };
  const [p1, p2, p3] = pages;
  want(p1, p1.ts);
  if (p1.end !== p1.ts) want(p1, p1.end);
  if (p2) want(p2, p2.ts);
  if (p1.count > 2 && tsMs(p1.end) - tsMs(p1.ts) > 2 * 365 * 86400000) want(p1, msTs((tsMs(p1.ts) + tsMs(p1.end)) / 2));
  if (p2 && p2.end !== p2.ts) want(p2, p2.end);
  if (p3) want(p3, p3.ts);
  const read = await readCopies(targets.slice(0, Math.max(1, Math.min(5, budget.left))), ctx, budget, { measure: true });
  const versions = read.versions;
  if (!versions.length) {
    out.notes.push(`The web archive lists team pages for ${domain} but did not return a readable copy.`);
    return out;
  }
  const named = versions.filter((v) => v.claims.named === true);
  const captures = pages.reduce((n, p) => n + p.count, 0);
  if (!named.length) {
    out.notes.push(`${subject.name} is not named on the saved team pages of ${domain} that were read (${versions.map((v) => ym(v.ts)).join(', ')}).`);
    return out;
  }
  const matchText = `${subject.name}. ${named.map((v) => contextText(v.claims, subject)).join('. ')}. ${domain}`.slice(0, 8000);
  const base = { source: ID, sourceLabel: LABEL, category: 'archive', matchText };
  const what = `${domain} team page`;
  const first = named[0];
  const last = named[named.length - 1];
  // a later copy of the same page that is still a list of people with titles, without this person
  const gone = versions.find((v) => v.ts > last.ts && v.claims.named === false && cleanOriginal(v.original) === cleanOriginal(last.original) && v.roleWords >= 3);
  out.findings.push(makeFinding(subject, {
    ...base,
    title: named.length === 1
      ? `${subject.name} named on a ${domain} team page saved on ${iso(first.ts)}`
      : `${subject.name} named on ${domain} team pages in saved copies from ${ym(first.ts)} to ${ym(last.ts)}`,
    quote: claimsQuote(last.claims, 300),
    url: replayUrl(first.ts, first.original),
    date: last.ts,
    severity: 'info',
    data: { kind: 'snapshot', page: `https://${domain}`, first: iso(first.ts), last: iso(last.ts), captures, copiesRead: versions.length, copiesNaming: named.length, pages: pages.map((p) => cleanOriginal(p.original)) },
  }));
  const distinct = distinctVersions(named);
  for (const v of distinct) {
    out.findings.push(makeFinding(subject, {
      ...base,
      title: `${what} as of ${iso(v.ts)}: ${claimsHeadline(v.claims) || `names ${subject.name}`}`,
      quote: claimsQuote(v.claims),
      url: replayUrl(v.ts, v.original),
      date: v.ts,
      severity: 'info',
      data: { kind: 'snapshot', page: cleanOriginal(v.original), capturedAt: iso(v.ts) },
    }));
  }
  // Changes are read within one address only: /leadership and /board saying different things is not a retitle.
  const byPage = new Map();
  for (const v of named) {
    const key = pageOf(v.original) || cleanOriginal(v.original);
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(v);
  }
  const changes = [];
  for (const group of byPage.values()) {
    changes.push(...changeFindings(subject, base, what, cleanOriginal(group[group.length - 1].original), distinctVersions(group)));
  }
  out.findings.push(...changes.filter(Boolean).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]).slice(0, MAX_CHANGES));
  if (gone) {
    const before = claimsHeadline(last.claims) || `names ${subject.name}`;
    out.findings.push(makeFinding(subject, {
      ...base,
      title: `${what}: ${subject.name} no longer listed between ${ym(last.ts)} and ${ym(gone.ts)}`,
      quote: `Before (${iso(last.ts)}): "${clip(before, 290)}" After (${iso(gone.ts)}): not listed`,
      url: replayUrl(gone.ts, gone.original),
      date: gone.ts,
      severity: 'low',
      data: { kind: 'change', page: cleanOriginal(last.original), field: 'role', change: 'removed', before, after: '', fromDate: iso(last.ts), toDate: iso(gone.ts), fromUrl: replayUrl(last.ts, last.original), toUrl: replayUrl(gone.ts, gone.original) },
    }));
  }
  out.findings = out.findings.filter(Boolean);
  return out;
}

// ---------- planning ----------

function subjectPlans(subject) {
  const tokens = nameTokens(subject.name);
  if (tokens.length < 2) return [];
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const dash = tokens.join('-');
  const joined = tokens.join('');
  const uniq = (list) => [...new Set(list)].slice(0, 2);
  return [
    { template: 'archive.crunchbase', params: { pages: uniq([`crunchbase.com/person/${dash}`, `crunchbase.com/person/${first}-${last}`]) }, prior: 0.55, why: 'earlier versions of their Crunchbase profile' },
    { template: 'archive.linkedin', params: { pages: uniq([`linkedin.com/in/${joined}`, `linkedin.com/in/${dash}`]) }, prior: 0.5, why: 'earlier versions of their LinkedIn profile' },
    { template: 'archive.angel', params: { pages: uniq([`angel.co/${dash}`, `angel.co/u/${dash}`]) }, prior: 0.4, why: 'earlier versions of their AngelList profile' },
    { template: 'archive.linkedin-pub', params: { prefix: `linkedin.com/pub/${dash}/` }, prior: 0.3, why: 'LinkedIn profiles saved under their name before 2016' },
    { template: 'archive.aboutme', params: { pages: uniq([`about.me/${joined}`, `about.me/${first}.${last}`]) }, prior: 0.25, why: 'earlier versions of their about.me page' },
    { template: 'archive.linkedin-id', params: { prefix: `linkedin.com/in/${dash}-` }, prior: 0.25, why: 'LinkedIn profiles saved under their name with a number after it' },
    { template: 'archive.indeed', params: { prefix: `indeed.com/r/${dash}/` }, prior: 0.15, why: 'resumes saved under their name on Indeed' },
  ];
}

function urlPlans(thread) {
  const page = pageOf(thread.value);
  if (!page) return [];
  const fam = familyOf(page);
  const linkedFrom = linkedSource(thread.why, page);
  return [{ template: fam.template, params: { pages: [page], ...(linkedFrom ? { linkedFrom } : {}) }, prior: fam.key === 'page' ? 0.5 : 0.65, why: `earlier versions of this ${fam.key === 'page' ? 'page' : `${fam.label} ${fam.noun}`}` }];
}

function handlePlans(thread) {
  const handle = String(thread.value || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_-]{2,39}$/.test(handle)) return [];
  const why = String(thread.why || '').toLowerCase();
  const onlyGithub = /github/.test(why);
  const onlyTwitter = /twitter|(^|\W)x(\W|$)/.test(why);
  const plans = [];
  // a handle given by a record tied to them (Wikidata, a linked profile) grades its pages as urlPlans does
  const from = (page) => { const linkedFrom = linkedSource(thread.why, page); return linkedFrom ? { linkedFrom } : {}; };
  if (!onlyTwitter && /^[A-Za-z0-9-]+$/.test(handle)) plans.push({ template: 'archive.github', params: { pages: [`github.com/${handle}`], ...from(`github.com/${handle}`) }, prior: 0.35, why: 'earlier versions of this GitHub profile' });
  if (!onlyGithub && /^[A-Za-z0-9_]{2,15}$/.test(handle)) plans.push({ template: 'archive.twitter', params: { pages: [`twitter.com/${handle}`], ...from(`twitter.com/${handle}`) }, prior: 0.4, why: 'earlier versions of this Twitter bio' });
  return plans;
}

function domainPlans(thread) {
  const domain = domainOf(thread.value);
  return domain ? [{ template: 'archive.team-page', params: { domain }, prior: 0.45, why: 'when they appear on the company’s team pages, and with what title' }] : [];
}

function plansFor(thread, subject) {
  if (!thread || !subject) return [];
  if (thread.kind === 'subject') return subjectPlans(subject);
  if (thread.kind === 'url') return urlPlans(thread);
  if (thread.kind === 'handle') return handlePlans(thread);
  if (thread.kind === 'domain') return domainPlans(thread);
  return [];
}

export const archiveConnector = {
  id: ID,
  label: LABEL,
  kinds: ['subject', 'url', 'handle', 'domain'],
  prior: 0.5,
  timeoutMs: 30000, // listings under a name are queued by the archive before they run

  plan(thread, subject) {
    return plansFor(thread, subject);
  },

  async run(task, ctx) {
    let params = task && task.params;
    if (!params) {
      const plans = plansFor({ kind: task.kind, value: task.value, why: task.why }, ctx.subject);
      params = (plans.find((p) => p.template === task.template) || plans[0] || {}).params;
    }
    if (!params) return { findings: [], threads: [], notes: [] };
    const budget = { left: MAX_REQUESTS };
    let out;
    if (params.domain) out = await runDomain(params.domain, ctx, budget);
    else if (params.prefix) out = await runPrefix(params.prefix, ctx, budget);
    else out = await runPages((params.pages || []).map((p) => pageOf(p)).filter(Boolean), ctx, budget, { guessed: task.kind === 'subject', linkedFrom: task.kind === 'url' || task.kind === 'handle' ? params.linkedFrom || null : null });
    return { findings: out.findings.filter(Boolean), threads: out.threads.filter(Boolean), notes: [...new Set(out.notes)] };
  },
};
