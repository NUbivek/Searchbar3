/**
 * Two more indexes of ransomware leak-site posts, so that one index being
 * down does not blank the leak-site screen. COMPANY or DOMAIN level only:
 * never searched for a person.
 *
 *   leak-sites-ransomfeed  RansomFeed (ransomfeed.it, CC BY 4.0): a live,
 *                          daily-updated index of leak-site victim posts
 *                          since 2021, searched by name (one request per
 *                          search word, paced at one every two seconds).
 *   leak-sites-archive     ransomwatch (github.com/joshhighet/ransomwatch,
 *                          public domain): a frozen archive of about 16,000
 *                          leak-site posts from January 2020 to June 2025,
 *                          downloaded whole at most once a day and matched
 *                          here. A historical backstop, never proof that a
 *                          company is not listed today.
 *
 * Both list claims made by criminals: every record says "claimed, unverified".
 *
 * Read and kept: the victim's name as listed, the group, the date, and (for
 * RansomFeed) the victim's website, country and sector. Never read or
 * returned: the attacker-written description, victim notes, dataset links,
 * hashes, screenshots, magnet and onion links, city and region. Of a victim
 * title only the part that is the company's own name is ever shown (the
 * rest of a headline is written by the attacker).
 *
 * Matching follows exposure.js exactly (its exported companyKey, matchOrgName
 * and ownNameIn). Both indexes match by substring ("uber" returns "Zuber
 * Gardner CPAs", and RansomFeed also searches the attacker's description), so
 * every row is re-checked against the company's name, every legal name the
 * check has learned for it, and its own website. A match is the company's
 * ("company") only on its own website or on its exact name when that name is
 * not one ordinary word; anything else is a possible namesake ("possible",
 * with "check it is the same company"). No record here is ever graded about
 * the person.
 */
import { getJson, HOST_GAP_MS, decodeEntities } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { isOrdinaryWordCompany, companyKeys } from '../names';
import { companyKey, matchOrgName, ownNameIn, registrableDomain, orgTokens } from './exposure';

// RansomFeed states no rate limit; the research notes ask for about one request every two seconds.
// (Set here so this file needs no change elsewhere; an integrator may move it into http.js HOST_GAP_MS.)
if (HOST_GAP_MS['api.ransomfeed.it'] === undefined) HOST_GAP_MS['api.ransomfeed.it'] = 2000;

const switchedOff = (id) => String(process.env.FOUNDER_SOURCES_OFF || '').split(',').map((x) => x.trim()).filter(Boolean).includes(id);
const OFF_REASON = 'This source is not enabled on this deployment.';

const CATEGORY = 'exposure';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_SOURCE = 8;
const KINDS = ['company', 'domain'];

/* ------------------------------------------------------------------ */
/* Shared: what to search and how a row matches (as exposure.js)       */
/* ------------------------------------------------------------------ */

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const squash = (tokens) => tokens.join('');
const dropThe = (tokens) => (tokens.length > 1 && tokens[0] === 'the' ? tokens.slice(1) : tokens);
const containsRun = (tokens, want) => {
  for (let i = 0; i + want.length <= tokens.length; i += 1) if (want.every((t, j) => tokens[i + j] === t)) return true;
  return false;
};
const isDomainText = (v) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(v || ''));
/** "2023-09-14 20:39:00" -> "2023-09-14" (the source's own calendar day). */
const isoDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
  return m && +m[1] >= 1990 && +m[1] <= 2100 && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const field = (label, value) => { const v = oneLine(value); return v ? `${label}: ${v}${/[.!?]$/.test(v) ? '' : '.'}` : ''; };
const MATCH_RANK = { exact: 0, padded: 1, leading: 2, contains: 3 };
const MATCH_REASON = {
  exact: (company) => `the organisation's name matches ${company}`,
  padded: (company) => `the organisation's name is ${company} followed by general words: check it is the same company`,
  leading: (company) => `the entry begins with the name ${company}`,
  contains: (company) => `the entry names ${company}`,
};

/** Mail, social and hosting domains shared by millions (the same list exposure.js uses): a listing of one says nothing. */
const SHARED_DOMAINS = new Set(('gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com gmx.com mail.com zoho.com '
  + 'linkedin.com twitter.com x.com facebook.com instagram.com threads.net youtube.com tiktok.com reddit.com github.com gitlab.com github.io medium.com substack.com wordpress.com blogspot.com tumblr.com '
  + 'google.com wikipedia.org crunchbase.com angel.co wellfound.com about.me notion.site wixsite.com squarespace.com webflow.io herokuapp.com vercel.app netlify.app bit.ly t.co linktr.ee archive.org '
  + 'telegram.org t.me discord.com discord.gg slack.com zoom.us dropbox.com').split(' '));

/** Every registrable domain written inside a piece of text. */
function domainsIn(text) {
  const out = new Set();
  for (const m of String(text || '').toLowerCase().matchAll(/(?<![a-z0-9@.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(?![a-z0-9-])/g)) {
    const d = registrableDomain(m[1]);
    if (d) out.add(d);
  }
  return [...out];
}

const tooGeneralNote = (name) => `Leak-site listings were not searched for "${oneLine(name)}": the name is too short or too general to match reliably.`;

/**
 * What a task asks for, or why it must not be run. A person's name is never searched, nor the person's own
 * site, nor a shared mail or social domain that is not the company's.
 */
function targetOf(task, ctx) {
  const value = oneLine(task?.value);
  if (!value || !KINDS.includes(task?.kind)) return { skip: true };
  const subject = ctx?.subject;
  if (task.kind === 'domain') {
    const domain = registrableDomain(value);
    if (!domain) return { skip: true };
    const label = domain.split('.')[0].replace(/[^a-z0-9]/g, '');
    if ((subject?.slugs || []).some((slug) => String(slug).replace(/[^a-z0-9]/g, '') === label)) return { skip: true };
    if (SHARED_DOMAINS.has(domain)) {
      const companies = [subject?.company, ...[...(subject?.anchors?.companies?.values?.() || [])].map((a) => a.value)].filter(Boolean);
      if (!companies.some((c) => matchOrgName(companyKey(c), domain) === 'exact')) return { skip: true };
    }
    return { kind: 'domain', domain };
  }
  if (typeof subject?.hasName === 'function' && subject.hasName(value)) return { skip: true };
  const key = companyKey(value);
  if (!key.full.length || !key.specific || squash(key.core.length ? key.core : key.full).length < 3) return { skip: true, note: tooGeneralNote(value) };
  return { kind: 'company', key };
}

/** The company's own websites the check knows, when their name part is the company's name. */
function ownDomainsOf(key, ctx) {
  const out = new Set();
  const subject = ctx?.subject;
  const values = [...(subject?.anchors?.domains?.values?.() || []), ...[...(subject?.anchors?.aliases?.values?.() || [])].filter((a) => isDomainText(a.value))].map((a) => a.value);
  for (const value of values) {
    const d = registrableDomain(value);
    if (d && !SHARED_DOMAINS.has(d) && matchOrgName(key, d) === 'exact') out.add(d);
  }
  return [...out];
}

/** Every fuller legal name the check has learned for this company (identity.addCompanyAlias), of two words or more. */
function legalNamesOf(key, ctx) {
  const of = companyKeys(key.name)[0] || key.name.toLowerCase();
  return [...(ctx?.subject?.anchors?.aliases?.values?.() || [])]
    .filter((a) => a.of === of && !isDomainText(a.value) && companyKey(a.value).full.length >= 2)
    .map((a) => a.value);
}
const legalNameIn = (key, text, ctx) => {
  const tokens = dropThe(orgTokens(text));
  return legalNamesOf(key, ctx).find((n) => containsRun(tokens, companyKey(n).full)) || '';
};

/** Named distinctively enough for its exact name alone to stand for it (not one ordinary word: phase 1 matcher). */
const distinctiveName = (key) => key.specific && (key.full.length >= 2 || !isOrdinaryWordCompany(key.full.join(' ')));

/**
 * The grade of one matched listing. 'company' only on the company's own website, or on its exact, distinctive
 * name or a learned legal name; otherwise a possible namesake. Never a grade about the person.
 */
function gradeListing(target, grade, { onOwnDomain = false, recordName = '', ctx = null, domainNote = '' } = {}) {
  if (target.kind === 'domain' || onOwnDomain) return { match: 'company', severity: 'medium', extra: {} };
  const byLegalName = Boolean(recordName) && Boolean(legalNameIn(target.key, recordName, ctx));
  if (byLegalName || ((grade === 'exact' || grade === 'leading' || grade === 'contains') && distinctiveName(target.key))) {
    return { match: 'company', severity: 'medium', extra: {} };
  }
  const why = grade === 'padded'
    ? `the name adds a general word to ${target.key.name}, so it may be another company: check it is the same company`
    : `"${target.key.name}" is an ordinary word other organisations also use, so it may be another company: check it is the same company`;
  return { match: 'possible', severity: 'low', why, extra: { excludeFromTimeline: true, companyNamesake: true, ...(domainNote ? { ownDomainChecked: domainNote } : {}) } };
}

/**
 * How one listing matches: { grade, onOwn } or null. A company is matched on its own name (or a learned
 * legal name) in the victim title, or on its own website; a domain on that domain only.
 */
function matchListing(target, own, ctx, victim, website = '') {
  const site = registrableDomain(website);
  if (target.kind === 'domain') {
    return site === target.domain || domainsIn(victim).includes(target.domain) ? { grade: 'exact', onOwn: true } : null;
  }
  if ((site && own.includes(site)) || domainsIn(victim).some((d) => own.includes(d))) return { grade: 'exact', onOwn: true };
  let grade = matchOrgName(target.key, victim);
  if (grade !== 'exact' && legalNameIn(target.key, victim, ctx)) grade = 'exact';
  // A website whose name is the company's ("mgmresorts.com") counts as the name, unless the company's own site is
  // known and this is another one (a "merge.cd" is not merge.dev).
  if (!grade && site && !own.length && matchOrgName(target.key, site) === 'exact') grade = 'exact';
  if (grade && site && own.length && !own.includes(site) && grade !== 'exact') return null;
  return grade ? { grade, onOwn: false } : null;
}

/** The company's own name as the listing writes it, never the rest of an attacker's headline. */
function shownName(target, own, ctx, victim) {
  if (target.kind === 'domain') return target.domain;
  return ownNameIn(target.key, victim) || legalNameIn(target.key, victim, ctx) || domainsIn(victim).find((d) => own.includes(d)) || '';
}

/** A group's name fit to show: "eraleign (apt73)", "inc ransom". */
const groupName = (g) => oneLine(g).replace(/[^\p{L}\p{N} ._()-]+/gu, '').slice(0, 40).trim();

/**
 * Group matched listings into one finding per group (a group re-posting a victim is one claim), best match and
 * newest first, at most MAX_PER_SOURCE.
 */
function groupListings(rows, target, own, ctx) {
  const byGroup = new Map();
  for (const row of rows) {
    const hit = matchListing(target, own, ctx, row.victim, row.website);
    if (!hit) continue;
    const group = groupName(row.group) || 'an extortion group';
    const entry = byGroup.get(group.toLowerCase()) || { group, grade: hit.grade, onOwn: false, names: [], days: new Set(), rows: [] };
    if ((MATCH_RANK[hit.grade] ?? 9) < (MATCH_RANK[entry.grade] ?? 9)) entry.grade = hit.grade;
    if (hit.onOwn) entry.onOwn = true;
    const name = shownName(target, own, ctx, row.victim);
    if (name) entry.names.push(name);
    if (row.day) entry.days.add(row.day);
    entry.rows.push(row);
    byGroup.set(group.toLowerCase(), entry);
  }
  const company = target.kind === 'company' ? target.key.name : target.domain;
  const sameAsGiven = (name) => squash(dropThe(orgTokens(name))) === squash(dropThe(orgTokens(company)));
  return [...byGroup.values()].map((entry) => {
    const days = [...entry.days].sort();
    return {
      ...entry,
      organisation: entry.names.some(sameAsGiven) ? company : entry.names.sort((x, y) => x.length - y.length)[0] || company,
      first: days[0] || null,
      last: days[days.length - 1] || null,
      dates: days.length,
    };
  }).sort((a, b) => (Number(b.onOwn) - Number(a.onOwn)) || ((MATCH_RANK[a.grade] ?? 9) - (MATCH_RANK[b.grade] ?? 9)) || String(b.first || '').localeCompare(String(a.first || '')))
    .slice(0, MAX_PER_SOURCE);
}

const reasonOf = (target, own, entry) => {
  if (target.kind === 'domain') return `exact match on the domain ${target.domain}`;
  if (entry.onOwn) return `the listing names the company's own website (${own.join(', ') || 'its domain'})`;
  return MATCH_REASON[entry.grade](target.key.name);
};

/* ------------------------------------------------------------------ */
/* 1. RansomFeed: a second live index                                  */
/* ------------------------------------------------------------------ */

const RANSOMFEED_ID = 'leak-sites-ransomfeed';
const RANSOMFEED_API = 'https://api.ransomfeed.it';
const RANSOMFEED_SITE = 'https://ransomfeed.it';
const RANSOMFEED_LABEL = 'RansomFeed (ransomfeed.it, CC BY 4.0)';
/** The index answers at most this many rows per search, newest first. */
const RANSOMFEED_ROWS = 100;
const MAX_QUERIES = 4;

/**
 * One search. Only the fields listed here are ever read: the description, victim notes, dataset links, hash,
 * city and region stay in the response body and go no further.
 */
async function ransomfeedSearch(term, deadline) {
  const body = await getJson(`${RANSOMFEED_API}/search/${encodeURIComponent(term)}`, { deadline, timeoutMs: 8000, maxBytes: 2 * 1024 * 1024 });
  if (!Array.isArray(body)) throw new Error('The RansomFeed index returned an unexpected response');
  // A changed format must not read as "no match": rows without a victim and a group mean the shape changed.
  if (body.length && !body.some((r) => r && typeof r === 'object' && 'victim' in r && 'gang' in r)) throw new Error('The RansomFeed index changed its format');
  return {
    capped: body.length >= RANSOMFEED_ROWS,
    rows: body.map((r) => ({
      id: /^\d{1,10}$/.test(String(r?.id ?? '')) ? String(r.id) : '',
      victim: oneLine(decodeEntities(String(r?.victim ?? ''))).slice(0, 200),
      group: oneLine(r?.gang),
      day: isoDay(r?.date),
      website: /^none$/i.test(oneLine(r?.website)) ? '' : oneLine(r?.website).slice(0, 120),
      country: oneLine(r?.country).slice(0, 40),
      sector: oneLine(r?.work_sector).slice(0, 60),
    })).filter((r) => r.victim),
  };
}

/** The search words for a target: the index matches a single word by substring and finds nothing for two words. */
function ransomfeedTerms(target, own) {
  if (target.kind === 'domain') return [target.domain];
  const out = [];
  const add = (t) => { const v = String(t || '').toLowerCase(); if (v.length >= 3 && !out.includes(v)) out.push(v); };
  add(squash(target.key.full)); // "mgmresorts", "uber"
  add(squash(target.key.core)); // "Uber Technologies" -> "uber"
  if (target.key.full.length > 1) add(target.key.full[0]); // "change" catches "Change HealthCare - OPTUM"
  for (const d of own) add(d);
  return out.slice(0, MAX_QUERIES);
}

/** The index's own page for a post. */
const postPage = (id) => (id ? `${RANSOMFEED_SITE}/index.php?page=post_details&id_post=${id}` : `${RANSOMFEED_SITE}/`);

export const ransomfeedConnector = {
  id: RANSOMFEED_ID,
  label: 'Ransomware leak-site claims (RansomFeed)',
  kinds: KINDS,
  prior: 0.25,
  timeoutMs: 20000,
  maxParallel: 1,
  enabled: () => !switchedOff(RANSOMFEED_ID),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const target = targetOf(task, ctx);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    const own = target.kind === 'company' ? ownDomainsOf(target.key, ctx).slice(0, 2) : [];
    const terms = ransomfeedTerms(target, own);

    const rows = [];
    const notes = [];
    const partial = [];
    const searched = [];
    for (let i = 0; i < terms.length; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const found = await ransomfeedSearch(terms[i], ctx.deadline);
        rows.push(...found.rows);
        searched.push(terms[i]);
        if (found.capped) notes.push(`RansomFeed holds more than ${RANSOMFEED_ROWS} posts containing "${terms[i]}"; only the ${RANSOMFEED_ROWS} most recent were read.`);
      } catch (error) {
        if (i === 0) throw error; // the main search did not answer: the source failed, never "no match"
        partial.push(`RansomFeed search for "${terms[i]}"`);
        notes.push(`RansomFeed: the search for "${terms[i]}" could not be completed (${String(error?.message || error).slice(0, 80)}).`);
      }
    }

    // The same post found by two words is one post.
    const seen = new Set();
    const unique = rows.filter((r) => { const k = r.id || `${r.victim}|${r.group}|${r.day}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const entries = groupListings(unique, target, own, ctx);
    const domainNote = own.length && !entries.some((e) => e.onOwn) ? `No RansomFeed post names ${own.join(' or ')}.` : '';
    const what = target.kind === 'company' ? target.key.name : target.domain;

    const findings = entries.map((entry) => {
      const g = gradeListing(target, entry.grade, { onOwnDomain: entry.onOwn, recordName: entry.organisation, ctx, domainNote });
      const firstRow = entry.rows.slice().sort((a, b) => String(a.day || '').localeCompare(String(b.day || '')))[0];
      const site = registrableDomain(firstRow.website);
      const country = entry.rows.map((r) => r.country).find((c) => c && !/^(none|unknown|n\/a)$/i.test(c)) || '';
      const sector = entry.rows.map((r) => r.sector).find((s) => s && !/^(none|unknown|not found|n\/a)$/i.test(s)) || '';
      return makeFinding(ctx.subject, {
        source: RANSOMFEED_ID, sourceLabel: RANSOMFEED_LABEL, category: CATEGORY,
        title: `${entry.organisation} listed by ${entry.group} on a ransomware leak site (claimed, unverified)`,
        quote: [
          field('Victim listed', entry.organisation), field('Group', entry.group), field('Website', site), field('First seen', entry.first),
          entry.dates > 1 ? `Listed on ${entry.dates} dates, most recently ${entry.last}.` : '',
          'A claim published by the group; not verified.', g.match === 'possible' ? domainNote : '',
        ].filter(Boolean).join(' '),
        url: postPage(firstRow.id),
        date: entry.first, severity: g.severity, match: g.match,
        matchReasons: [reasonOf(target, own, entry), ...(g.why ? [g.why] : [])],
        data: {
          organisation: entry.organisation, group: entry.group, domain: site || null, country: country || null, sector: sector || null,
          firstSeen: entry.first, lastSeen: entry.last, listings: Math.max(1, entry.dates), posts: entry.rows.map((r) => r.id).filter(Boolean).slice(0, 10),
          nameMatch: entry.onOwn ? 'domain' : entry.grade, status: 'claimed, unverified', ...g.extra,
        },
      });
    }).filter(Boolean);

    if (!findings.length && searched.length) {
      notes.push(`RansomFeed's index of ransomware leak-site posts (2021 to now) was searched for ${what} (${searched.map((t) => `"${t}"`).join(', ')}); no post names it. An index lists only what extortion groups publish, so this is not proof that no breach happened.`);
    }
    return { findings, threads: [], notes, ...(partial.length ? { partial } : {}) };
  },
};

/* ------------------------------------------------------------------ */
/* 2. ransomwatch: a frozen archive, 2020 to June 2025                 */
/* ------------------------------------------------------------------ */

const ARCHIVE_ID = 'leak-sites-archive';
const ARCHIVE_URL = 'https://raw.githubusercontent.com/joshhighet/ransomwatch/main/posts.json';
const ARCHIVE_LABEL = 'ransomwatch leak-site archive (github.com/joshhighet/ransomwatch, public domain)';
const ARCHIVE_CACHE_KEY = 'exposure:ransomwatch-posts:v1';
/** The archive held 16,072 posts when it was frozen; far fewer means a truncated or replaced file. */
const ARCHIVE_MIN_POSTS = 10000;

/**
 * The archive as a compact index: [title, group, day] per post. Only these three fields exist in the file.
 * A file that is not a list, is much shorter than the frozen archive, or whose rows lost their fields throws.
 */
export function compactArchive(list) {
  if (!Array.isArray(list)) throw new Error('The ransomwatch archive returned an unexpected response');
  const posts = [];
  for (const p of list) {
    const title = oneLine(decodeEntities(String(p?.post_title ?? ''))).slice(0, 160);
    if (!title) continue;
    posts.push([title, groupName(p?.group_name), isoDay(p?.discovered)]);
  }
  if (posts.length < ARCHIVE_MIN_POSTS) throw new Error(`The ransomwatch archive held ${posts.length} readable posts instead of about 16,000: its format may have changed`);
  return posts;
}

async function loadArchive(deadline) {
  const entry = await cachedEntry(ARCHIVE_CACHE_KEY, DAY_MS, async ({ deadline: loadDeadline } = {}) => compactArchive(
    await getJson(ARCHIVE_URL, { deadline: loadDeadline, timeoutMs: 20000, maxBytes: 6 * 1024 * 1024 }),
  ), { deadline });
  if (!Array.isArray(entry.value) || entry.value.length < ARCHIVE_MIN_POSTS) throw new Error('The ransomwatch archive copy is empty');
  return { posts: entry.value, asOf: entry.fresh ? '' : new Date(entry.at).toISOString().slice(0, 10) };
}

/** A cheap first pass over 16,000 titles: only titles that contain one of these squashed forms are matched properly. */
function prefilterForms(target, own, ctx) {
  if (target.kind === 'domain') return [target.domain.split('.')[0].replace(/[^a-z0-9]/g, '')];
  const forms = [squash(target.key.full), squash(target.key.core), ...own.map((d) => d.split('.')[0].replace(/[^a-z0-9]/g, '')),
    ...legalNamesOf(target.key, ctx).map((n) => squash(companyKey(n).core.length ? companyKey(n).core : companyKey(n).full))];
  return [...new Set(forms.filter((f) => f && f.length >= 3))];
}

export const ransomwatchArchiveConnector = {
  id: ARCHIVE_ID,
  label: 'Ransomware leak-site archive, 2020 to June 2025 (ransomwatch)',
  kinds: KINDS,
  prior: 0.15,
  timeoutMs: 15000,
  enabled: () => !switchedOff(ARCHIVE_ID),
  unavailableReason: OFF_REASON,
  async run(task, ctx) {
    const target = targetOf(task, ctx);
    if (target.skip) return { findings: [], threads: [], notes: target.note ? [target.note] : [] };
    const { posts, asOf } = await loadArchive(ctx.deadline);
    const newest = posts.reduce((m, p) => (p[2] && p[2] > m ? p[2] : m), '');
    const notes = [];
    if (asOf) notes.push(`The ransomwatch archive could not be refreshed; its copy of ${asOf} was searched.`);

    const own = target.kind === 'company' ? ownDomainsOf(target.key, ctx).slice(0, 2) : [];
    const forms = prefilterForms(target, own, ctx);
    const rows = [];
    for (const [title, group, day] of posts) {
      const flat = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!forms.some((f) => flat.includes(f))) continue;
      rows.push({ victim: title, group, day, website: '' });
    }
    const entries = groupListings(rows, target, own, ctx);
    const domainNote = own.length && !entries.some((e) => e.onOwn) ? `No archived post names ${own.join(' or ')}.` : '';
    const what = target.kind === 'company' ? target.key.name : target.domain;

    const findings = entries.map((entry) => {
      const g = gradeListing(target, entry.grade, { onOwnDomain: entry.onOwn, recordName: entry.organisation, ctx, domainNote });
      return makeFinding(ctx.subject, {
        source: ARCHIVE_ID, sourceLabel: ARCHIVE_LABEL, category: CATEGORY,
        title: `${entry.organisation} listed by ${entry.group} on a ransomware leak site, archived (claimed, unverified)`,
        quote: [
          field('Victim listed', entry.organisation), field('Group', entry.group), field('First seen', entry.first),
          entry.dates > 1 ? `Listed on ${entry.dates} dates, most recently ${entry.last}.` : '',
          `A claim published by the group; not verified. From an archive that stops in ${newest ? newest.slice(0, 7) : 'mid-2025'}.`,
          g.match === 'possible' ? domainNote : '',
        ].filter(Boolean).join(' '),
        url: ARCHIVE_URL,
        date: entry.first, severity: g.severity, match: g.match,
        matchReasons: [reasonOf(target, own, entry), ...(g.why ? [g.why] : [])],
        data: {
          organisation: entry.organisation, group: entry.group, firstSeen: entry.first, lastSeen: entry.last, listings: Math.max(1, entry.dates),
          archiveEnds: newest || null, nameMatch: entry.onOwn ? 'domain' : entry.grade, status: 'claimed, unverified', ...g.extra,
        },
      });
    }).filter(Boolean);

    notes.push(findings.length
      ? `The ransomwatch archive stops on ${newest || 'a date in mid-2025'} and is no longer updated: later listings are not in it.`
      : `The ransomwatch archive of ${posts.length.toLocaleString('en-US')} leak-site posts (January 2020 to ${newest || 'mid-2025'}) was searched for ${what}; no archived post names it. It is a frozen archive, not a current screen, and no listing is not proof that no breach happened.`);
    return { findings, threads: [], notes };
  },
};

export const leakSitesMoreConnectors = [ransomfeedConnector, ransomwatchArchiveConnector];
