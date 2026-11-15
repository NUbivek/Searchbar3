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
 * name stays "possible" and none of its threads are followed.
 *
 * Privacy: location lines are never read, contact details are removed, and
 * resumes are reduced to headline, roles and education (archiveClaims.js).
 */
import { getJson, request, mapLimit, htmlToText, HttpError } from '../http';
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
  const json = await getJson(url, { deadline: ctx.deadline, timeoutMs: LIST_TIMEOUT_MS });
  return tableRows(json, 'list of copies')
    .filter((r) => /^\d{14}$/.test(String(r.timestamp)) && r.original)
    .map((r) => ({ ts: String(r.timestamp), end: /^\d{14}$/.test(String(r.endtimestamp)) ? String(r.endtimestamp) : String(r.timestamp), original: String(r.original), digest: String(r.digest || ''), length: Number(r.length) || 0, count: Math.max(1, Number(r.groupcount) || 1) }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Every saved address under a prefix (or on a whole domain), one row per address. */
async function listUnder(prefix, ctx, { domain = false, filters = [], limit = 80, timeoutMs = WIDE_LIST_TIMEOUT_MS } = {}) {
  const extra = filters.map((f) => `&filter=${encodeURIComponent(f)}`).join('');
  const url = `${WB}/web/timemap/json?url=${encodeURIComponent(prefix)}&matchType=${domain ? 'domain' : 'prefix'}&collapse=urlkey&output=json&fl=original,mimetype,timestamp,endtimestamp,groupcount,uniqcount&filter=statuscode:200&filter=mimetype:text/html${extra}&limit=${limit}`;
  const json = await getJson(url, { deadline: ctx.deadline, timeoutMs, retries: 0 });
  return tableRows(json, 'list of addresses')
    .filter((r) => /^\d{14}$/.test(String(r.timestamp)) && r.original)
    .map((r) => ({ ts: String(r.timestamp), end: /^\d{14}$/.test(String(r.endtimestamp)) ? String(r.endtimestamp) : String(r.timestamp), original: String(r.original), digest: '', length: 0, count: Math.max(1, Number(r.groupcount) || 1) }));
}

/** One saved copy, as the site served it. The time is read back from the final address: the archive redirects to the nearest copy. */
async function fetchSnapshot(ts, original, ctx) {
  const res = await request(rawUrl(ts, original), { deadline: ctx.deadline, timeoutMs: SNAPSHOT_TIMEOUT_MS });
  const html = String(res.text || '');
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
async function readPage(page, ctx, budget) {
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
  const picks = pickCaptures(rows, Math.max(1, Math.min(MAX_SNAPSHOTS, budget.left)));
  const read = await readCopies(picks, ctx, budget);
  info.versions = read.versions;
  info.blocked = read.blocked.length;
  // A copy that is only a sign-in wall: read the nearest other month instead, while the allowance lasts.
  const spare = [];
  for (const wall of read.blocked) {
    const near = rows.filter((r) => !picks.includes(r) && !spare.includes(r)).sort((a, b) => Math.abs(tsMs(a.ts) - tsMs(wall.ts)) - Math.abs(tsMs(b.ts) - tsMs(wall.ts)))[0];
    if (near) spare.push(near);
  }
  if (spare.length && budget.left > 0 && timeLeft(ctx) > 4000) {
    const more = await readCopies(spare.slice(0, budget.left), ctx, budget).catch(() => ({ versions: [], blocked: [] }));
    info.blocked += more.blocked.length;
    for (const v of more.versions) if (!info.versions.some((x) => x.ts === v.ts)) info.versions.push(v);
    info.versions.sort((a, b) => a.ts.localeCompare(b.ts));
  }
  if (read.tried > 0) remember(key, info);
  return info;
}

// ---------- turning what was read into findings ----------

const quoted = (s, n = 80) => `"${clip(s, n)}"`;

/** One line that says what changed, for a finding's title. */
export function describeChange(d) {
  if (d.field === 'headline') return `${d.aspect === 'title' ? 'title' : 'headline'} changed from ${quoted(d.before)} to ${quoted(d.after)}`;
  if (d.field === 'bio') return 'bio rewritten';
  if (d.field === 'education') {
    if (d.change === 'changed') return `${d.aspect === 'dates' ? 'education dates' : 'degree'} changed from ${quoted(d.before)} to ${quoted(d.after)}`;
    if (d.change === 'removed') return d.aspect === 'section' ? `education no longer listed (${quoted(d.before, 110)})` : `${d.aspect === 'degree' ? 'degree' : 'school'} no longer listed: ${quoted(d.before, 110)}`;
    return `education added: ${quoted(d.after, 110)}`;
  }
  if (d.change === 'changed') return `${d.aspect === 'dates' ? 'role dates' : 'role'} changed from ${quoted(d.before)} to ${quoted(d.after)}`;
  if (d.change === 'removed') return d.aspect === 'section' ? `roles no longer listed (${quoted(d.before, 110)})` : `role no longer listed: ${quoted(d.before, 110)}`;
  return `role added: ${quoted(d.after, 110)}`;
}

const NOT_AN_EMPLOYER = /^(self[- ]?employed|freelanc\w*|independent|stealth\b.*|confidential|n\/?a|various|unemployed|retired|student|none|private|consultant)$/i;

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
      for (const d of compareClaims(older, cur.claims)) {
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
    title: `${what}: ${describeChange(d)} between ${ym(before.ts)} and ${ym(after.ts)}`,
    quote: `Before (${iso(before.ts)}): ${d.before ? `"${clip(d.before, 290)}"` : 'not listed'} After (${iso(after.ts)}): ${d.after ? `"${clip(d.after, 290)}"` : 'not listed'}`,
    url: replayUrl(after.ts, after.original),
    date: after.ts,
    severity: d.severity,
    data: { kind: 'change', page, field: d.field, change: d.change, before: d.before, after: d.after, fromDate: iso(before.ts), toDate: iso(after.ts), fromUrl: replayUrl(before.ts, before.original), toUrl: replayUrl(after.ts, after.original) },
  }));
}

/**
 * Findings and threads for one page that was read.
 * `discovered`: the page came from a listing of look-alike addresses, so a
 * name-only match is reported in one line and the page itself becomes a
 * thread when it is tied to the subject.
 */
function reportPage(subject, info, { discovered = false, guessed = false } = {}) {
  const out = { findings: [], threads: [], notes: [], found: info.rows.length > 0, named: false, level: 'none' };
  if (!info.rows.length) return out;
  const fam = familyOf(info.page);
  const what = `${fam.label} ${fam.noun}`;
  if (info.blocked) out.notes.push(`${info.blocked} saved ${info.blocked === 1 ? 'copy' : 'copies'} of ${info.page} showed a sign-in wall instead of the ${fam.noun}.`);
  const own = info.versions.filter((v) => ownsPage(subject, v.claims));
  if (!own.length) {
    if (info.versions.length) out.notes.push(`The saved copies of ${info.page} that were read do not name ${subject.name}.`);
    return out;
  }
  out.named = true;
  const matchText = `${subject.name}. ${own.map((v) => contextText(v.claims, subject)).join('. ')}`.slice(0, 8000);
  out.level = matchSubject(subject, matchText).level;
  const trusted = out.level === 'confirmed' || out.level === 'likely';
  const page = info.address;
  const base = { source: ID, sourceLabel: LABEL, category: 'archive', matchText };
  const first = info.rows[0].ts;
  const last = info.rows.reduce((max, r) => (r.end > max ? r.end : max), info.rows[info.rows.length - 1].ts);
  let versions = distinctVersions(own);
  // A guessed address that only carries the name is most often a namesake: say it in two lines, not a history.
  const brief = guessed && !trusted;
  if (brief) versions = versions.slice(-1);

  if (trusted || !discovered) {
    out.findings.push(makeFinding(subject, {
      ...base,
      title: info.captures === 1 ? `${what} archived once, on ${iso(first)}` : ym(first) === ym(last) ? `${what} archived ${info.captures} times in ${ym(first)}` : `${what} archived ${info.captures} times between ${ym(first)} and ${ym(last)}`,
      quote: claimsQuote(own[own.length - 1].claims, 300),
      url: `${WB}/web/*/${info.page}`,
      date: last,
      severity: 'info',
      data: { kind: 'snapshot', page, first: iso(first), last: iso(last), captures: info.captures },
    }));
  }
  for (const v of versions) {
    const line = claimsHeadline(v.claims);
    if (!line) continue;
    out.findings.push(makeFinding(subject, {
      ...base,
      title: `${what} as of ${iso(v.ts)}: ${line}`,
      quote: claimsQuote(v.claims),
      url: replayUrl(v.ts, v.original),
      date: v.ts,
      severity: 'info',
      data: { kind: 'snapshot', page, capturedAt: iso(v.ts) },
    }));
  }
  const changes = brief ? [] : changeFindings(subject, base, what, page, versions);
  out.findings.push(...changes);
  if (changes.some((f) => f && f.data.change === 'removed')) out.notes.push(`Something missing from a later copy of ${info.page} can also mean the site showed less that day (for example to visitors who were not signed in): open both copies before relying on it.`);
  if (!brief && versions.length === 1 && own.length > 1) out.notes.push(`${what}: the ${own.length} copies read between ${ym(own[0].ts)} and ${ym(own[own.length - 1].ts)} say the same thing.`);
  out.findings = out.findings.filter(Boolean);

  // Threads: employers, schools and the other profiles the page links to. Followed only when the page is tied to the subject.
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
  for (const v of [...own].reverse()) {
    for (const r of v.claims.roles) {
      if (r.org && r.org.length <= 80 && !NOT_AN_EMPLOYER.test(r.org) && !subject.hasName(r.org)) add('company', r.org, `${r.title ? `${clip(r.title, 60)}; ` : ''}listed on their ${what} (${ym(v.ts)})`);
    }
    for (const e of v.claims.education) {
      if (e.school && e.school.length <= 100 && !schools.some((x) => sameOrg(x, e.school))) { schools.push(e.school); add('school', e.school, `listed on their ${what} (${ym(v.ts)})`); }
    }
    for (const link of v.claims.links || []) {
      const profile = profileFromUrl(link);
      if (profile && pageOf(profile.url) && pageOf(profile.url) !== info.page) add('url', profile.url, `linked from their ${what}`, { platform: profile.platform });
    }
  }
  if (discovered && trusted) add('url', `https://${info.page}`, `their ${what}, found in the web archive`);
  return out;
}

const merge = (into, part) => {
  into.findings.push(...part.findings);
  into.threads.push(...part.threads);
  into.notes.push(...part.notes);
};

// ---------- the lookups ----------

/** Guessed or given addresses: read the first one that turns out to be the person's page. */
async function runPages(pages, ctx, budget, { guessed = false } = {}) {
  const out = { findings: [], threads: [], notes: [] };
  const empty = [];
  for (const page of pages) {
    if (budget.left < 2 || timeLeft(ctx) < 3000) break;
    const info = await readPage(page, ctx, budget);
    if (!info.rows.length) { empty.push(page); continue; }
    const part = reportPage(ctx.subject, info, { guessed });
    merge(out, part);
    if (part.level === 'confirmed' || part.level === 'likely' || (part.named && !guessed)) break; // their page: the other spelling is not needed
  }
  if (empty.length && !out.findings.length) out.notes.push(`The web archive holds no readable copy of ${empty.join(' or ')}.`);
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
    try { rows = await listCaptures(`${domain}/${path}`, ctx); } catch { continue; }
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
  out.findings.push(...changeFindings(subject, base, what, `https://${domain}`, distinct));
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
  return [{ template: fam.template, params: { pages: [page] }, prior: fam.key === 'page' ? 0.5 : 0.65, why: `earlier versions of this ${fam.key === 'page' ? 'page' : `${fam.label} ${fam.noun}`}` }];
}

function handlePlans(thread) {
  const handle = String(thread.value || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_-]{2,39}$/.test(handle)) return [];
  const why = String(thread.why || '').toLowerCase();
  const onlyGithub = /github/.test(why);
  const onlyTwitter = /twitter|(^|\W)x(\W|$)/.test(why);
  const plans = [];
  if (!onlyTwitter && /^[A-Za-z0-9-]+$/.test(handle)) plans.push({ template: 'archive.github', params: { pages: [`github.com/${handle}`] }, prior: 0.35, why: 'earlier versions of this GitHub profile' });
  if (!onlyGithub && /^[A-Za-z0-9_]{2,15}$/.test(handle)) plans.push({ template: 'archive.twitter', params: { pages: [`twitter.com/${handle}`] }, prior: 0.4, why: 'earlier versions of this Twitter bio' });
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
    else out = await runPages((params.pages || []).map((p) => pageOf(p)).filter(Boolean), ctx, budget, { guessed: task.kind === 'subject' });
    return { findings: out.findings.filter(Boolean), threads: out.threads.filter(Boolean), notes: [...new Set(out.notes)] };
  },
};
