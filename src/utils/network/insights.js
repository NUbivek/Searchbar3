/**
 * What an uploaded network holds, in plain words, and the shortcuts built
 * from it. Everything here is read from the file: no fixed preset list, no
 * model, nothing leaves the browser. Pure functions, no React.
 *
 *   profileNetwork(contacts, { today })  the read-out, the shortcuts, three
 *                                        example questions and the
 *                                        arrangements that split the file
 *   labelFor(shortcut, count)            the shortcut's label for another
 *                                        count, in the right number
 *   narrowings(profile, active, limit)   the other shortcuts that narrow the
 *                                        current list, with their overlap
 *   shortcutFor(profile, keys)           the shortcut holding exactly these
 *                                        people, so it can show as pressed
 *   combine(profile, ids)                several shortcuts pressed together
 *                                        (AND), as one selection
 *   countIfAdded(profile, active, id)    how many would remain if `id` were
 *                                        pressed too
 *   listText(contacts) / listCsv(...)    the listed people, to copy or save
 *
 * A Shortcut is { id, type, label, short, one, many, count, keys, sort }:
 * `label` is the chip ("22 at Stripe", "1 engineer"), `one` / `many` what
 * follows a count of one or of several ("engineer" / "engineers"), `short`
 * the same as `many` (for a combined title), `keys` the person ids
 * (personNodeId) already in the shortcut's own order, `sort` 'senior' |
 * 'recent' | 'company'.
 *
 * The read-out comes twice: `sentences` as plain strings and `parts`, the
 * same sentences as [{ text, bold }] pieces, so a page can set the counts in
 * bold and leave a number inside a name ("met 2026") plain.
 */
import { classifyContact, familyByKey } from './roles';
import {
  industryOf, isSector, tagProfile, tagsOf, cityOf, usefulGroupings, defaultGrouping, companyFromEmail,
} from './grouping';
import { groupByCompany, companyKeyOf, personNodeId, seniority, NO_COMPANY_KEY } from './atlas';
import { normalizeCompanyKey } from './parseContacts';

const SHOWN = 6;
const MAX_CHIPS = 12;
const MAX_COMBINED = 3;
/** A shortcut needs at least this many people to be worth a slot. */
const MIN_PEOPLE = 3;
/** Two shortcuts that share this share of the larger one's people say the same thing. */
const SAME_PEOPLE = 0.8;
/** "Nearly everyone": a group this large is not news. */
const NEARLY_ALL = 0.9;
const DAY = 86400000;

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const byCountThenLabel = (a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label));

/** 'YYYY-MM-DD' (or a Date) to a UTC day number; null when unreadable. */
function dayOf(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : Math.floor(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / DAY);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : null;
}
/** The same calendar day one year earlier, as a day number. */
function yearBefore(day) {
  const d = new Date(day * DAY);
  return Math.floor(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()) / DAY);
}

// ------------------------------------------------------------ sentences with bold counts

/** A count to set in bold. */
const B = (n) => ({ bold: true, text: fmt(n) });
/**
 * A sentence as pieces: say`You know ${B(n)} people` gives
 * [{ text: 'You know ', bold: false }, { text: '544', bold: true }, ...].
 * A value may be a string, a B() count or an array of pieces.
 */
function say(strings, ...values) {
  const out = [];
  const push = (text, bold = false) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.bold === bold && !bold) last.text += text;
    else out.push({ text, bold });
  };
  const add = (v) => {
    if (v == null || v === false) return;
    if (Array.isArray(v)) v.forEach(add);
    else if (typeof v === 'object') push(v.text, !!v.bold);
    else push(String(v));
  };
  strings.forEach((s, i) => { push(s); if (i < values.length) add(values[i]); });
  return out;
}
const textOf = (parts) => parts.map((p) => p.text).join('');
/**
 * "a", "a and b", "a, b and c", "a, b, c and d", "a, b, c and 2 more {what}".
 * Four are all named: "and 1 other" would say less than the name.
 */
function names(list, what = 'more', upTo = 4) {
  if (list.length <= upTo) return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${list.slice(0, 3).join(', ')} and ${list.length - 3} ${what}`;
}
/** The entries tied for first place in a list sorted largest first ([label, count] or { count }). */
const countOf = (x) => (Array.isArray(x) ? x[1] : x.count);
const leaders = (list) => list.filter((x) => countOf(x) === countOf(list[0]));

// Internal lookups per profile (id -> shortcut with a Set of keys), kept off
// the returned object so it stays plain data.
const internals = new WeakMap();

/**
 * Read a network. `contacts` are the people in view (after the source chips
 * and "direct only"). `today` (a Date or 'YYYY-MM-DD') fixes the clock for
 * tests. Returns { n, companies, fields, sentences, parts, shortcuts, more,
 * questions, groupings, defaultGrouping, everyone, companyFrom }, where
 * companyFrom is 'company' or 'email' (a file with few companies, read from
 * work email addresses).
 */
export function profileNetwork(contacts, { today } = {}) {
  const list = (contacts || []).filter((c) => c && typeof c === 'object');
  const n = list.length;
  const todayDay = dayOf(today || new Date());

  // One pass over the people: ids, ranks and every facet's counts.
  const rows = new Array(n);
  const filled = { company: 0, title: 0, location: 0, tags: 0, connectedOn: 0, profileUrl: 0, email: 0 };
  const familyCount = new Map();
  const industryCount = new Map();
  const cityCount = new Map();
  const citySpelling = new Map();
  let newest = null; let firm = 0;
  // Many people share a connection date: read each distinct date once.
  const days = new Map();
  const dayFor = (v) => {
    if (!v) return null;
    if (typeof v !== 'string') return dayOf(v);
    let d = days.get(v);
    if (d === undefined) { d = dayOf(v); days.set(v, d); }
    return d;
  };
  for (let i = 0; i < n; i += 1) {
    const c = list[i];
    const kind = classifyContact(c);
    const companyKey = companyKeyOf(c);
    const day = dayFor(c.connectedOn);
    const city = cityOf(c);
    const tags = tagsOf(c);
    const row = { c, id: personNodeId(c), rank: seniority(c), name: String(c.name || '').toLowerCase(), family: kind.family, companyKey, day, city: city.toLowerCase(), industry: industryOf(c), tags };
    rows[i] = row;
    if (companyKey !== NO_COMPANY_KEY) filled.company += 1;
    if (String(c.position || '').trim()) filled.title += 1;
    if (city) filled.location += 1;
    if (tags.length) filled.tags += 1;
    if (day !== null) { filled.connectedOn += 1; if (newest === null || day > newest) newest = day; }
    if (c.profileUrl) filled.profileUrl += 1;
    if (c.email) filled.email += 1;
    if (c.relationship === 'firm') firm += 1;
    familyCount.set(row.family, (familyCount.get(row.family) || 0) + 1);
    industryCount.set(row.industry, (industryCount.get(row.industry) || 0) + 1);
    if (city) {
      cityCount.set(row.city, (cityCount.get(row.city) || 0) + 1);
      let sp = citySpelling.get(row.city);
      if (!sp) { sp = new Map(); citySpelling.set(row.city, sp); }
      sp.set(city, (sp.get(city) || 0) + 1);
    }
  }
  const share = (k) => (n ? filled[k] / n : 0);
  const fields = Object.fromEntries(Object.keys(filled).map((k) => [k, Math.round(share(k) * 1000) / 1000]));
  const sparse = n > 0 && share('company') < 0.5;

  // Companies. A file where most people have no company (an address book)
  // reads one from a work email's domain instead ("stripe.com"), and says so.
  // Only people the file gives no company are read from their email; the
  // companies the file does give are kept. The question engine reads them
  // the same way (a domain's key is its name: "stripe.com" is "stripe").
  let companyGroups = groupByCompany(list).filter((g) => g.key !== NO_COMPANY_KEY);
  let companyFrom = 'company';
  if (sparse) {
    const byKey = new Map(companyGroups.map((g) => [g.key, { ...g, contacts: [...g.contacts] }]));
    const fromMail = new Map();
    for (const r of rows) {
      if (r.companyKey !== NO_COMPANY_KEY) continue;
      const d = companyFromEmail(r.c);
      const key = d ? normalizeCompanyKey(d) : '';
      if (!key) continue;
      r.domain = key;
      let g = byKey.get(key);
      if (!g) { g = { key, label: d, contacts: [], fromEmail: true }; byKey.set(key, g); }
      g.contacts.push(r.c);
      if (g.fromEmail) fromMail.set(key, g);
    }
    if ([...fromMail.values()].some((g) => g.contacts.length >= MIN_PEOPLE)) {
      companyGroups = [...byKey.values()].sort((a, b) => b.contacts.length - a.contacts.length || a.label.localeCompare(b.label));
      companyFrom = 'email';
    }
  }
  const companyOfRow = companyFrom === 'email' ? (r) => (r.companyKey !== NO_COMPANY_KEY ? r.companyKey : r.domain || NO_COMPANY_KEY) : (r) => r.companyKey;
  const companySize = new Map(companyGroups.map((g) => [g.key, g.contacts.length]));

  // Orders a shortcut's people can be listed in. Names compare as plain
  // lower-cased strings: localeCompare is too slow for 30,000 people.
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const order = {
    senior: (a, b) => a.rank - b.rank || byName(a, b),
    recent: (a, b) => (b.day ?? -Infinity) - (a.day ?? -Infinity) || byName(a, b),
    company: (a, b) => (companySize.get(companyOfRow(b)) || 0) - (companySize.get(companyOfRow(a)) || 0) || byName(a, b),
  };
  // Everyone is sorted most senior first once; a shortcut keeps the people
  // of that list who pass its test, so most shortcuts never sort on their
  // own. A person who appears twice in the input is listed once.
  let bySenior = null;
  const senior = () => {
    if (!bySenior) {
      const seen = new Set();
      bySenior = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).sort(order.senior);
    }
    return bySenior;
  };
  const make = (id, type, one, many, test, sort = 'senior') => {
    // The recent and company orders serve one shortcut each: sort its members only.
    const members = senior().filter(test);
    if (sort !== 'senior') members.sort(order[sort]);
    const keys = members.map((r) => r.id);
    const s = { id, type, label: '', short: many, one, many, count: keys.length, keys, sort };
    s.label = labelFor(s, s.count);
    return s;
  };
  const N = senior().length;
  // No chip may light nobody, a handful, or everyone: it would tell the user nothing.
  const fits = (s) => s.count >= MIN_PEOPLE && s.count < N;

  // ---- candidates, each pool largest first
  const tagInfo = tagProfile(list);
  const tagPool = tagInfo.signal
    ? tagInfo.useful.slice(0, 8).map(([tag]) => {
      const words = `tagged “${tagInfo.spelling.get(tag) || tag}”`;
      return make(`tag:${tag}`, 'tag', words, words, (r) => r.tags.includes(tag));
    })
    : [];

  const familyRanked = [...familyCount.entries()]
    .map(([key, count]) => ({ key, count, fam: familyByKey(key) }))
    .filter((f) => f.fam && !f.fam.catchAll && f.count >= MIN_PEOPLE)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const rolePool = familyRanked
    .filter((f) => f.count >= n * 0.05 && f.count <= n * NEARLY_ALL)
    .slice(0, 6)
    .map((f) => make(`role:${f.key}`, 'role', f.fam.one, f.fam.many, (r) => r.family === f.key));

  const companyPool = companyGroups
    .filter((g) => g.contacts.length >= MIN_PEOPLE && g.contacts.length >= n * 0.02)
    .slice(0, MAX_CHIPS)
    .map((g) => {
      const s = make(`company:${g.key}`, 'company', `at ${g.label}`, `at ${g.label}`, (r) => companyOfRow(r) === g.key);
      if (g.fromEmail) s.fromEmail = true;
      return s;
    });

  const sectors = [...industryCount.entries()].filter(([label]) => isSector(label)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const industryPool = sectors
    .filter(([, count]) => count >= MIN_PEOPLE && count >= n * 0.1 && count <= n * 0.6)
    .slice(0, 4)
    .map(([label]) => make(`industry:${label}`, 'industry', `in ${label}`, `in ${label}`, (r) => r.industry === label));

  const spellCity = (key) => {
    let best = key; let top = 0;
    for (const [s, k] of citySpelling.get(key) || []) if (k > top || (k === top && s < best)) { best = s; top = k; }
    return best;
  };
  const cities = [...cityCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const placePool = share('location') >= 0.3
    ? cities.filter(([, count]) => count >= MIN_PEOPLE && count >= n * 0.08).slice(0, 4)
      .map(([key]) => { const w = `in ${spellCity(key)}`; return make(`place:${key}`, 'place', w, w, (r) => r.city === key); })
    : [];

  // Recent: the twelve months up to the earlier of today and the file's
  // newest date, so an old export still shows its own last year.
  const recentPool = [];
  let recentWords = 'in the last 12 months';
  if (share('connectedOn') >= 0.5 && newest !== null) {
    const end = todayDay !== null ? Math.min(todayDay, newest) : newest;
    const start = yearBefore(end);
    if (todayDay !== null && newest < todayDay - 60) recentWords = 'in the 12 months before this export';
    const w = `connected ${recentWords}`;
    const s = make('recent', 'recent', w, w, (r) => r.day !== null && r.day > start && r.day <= end, 'recent');
    if (s.count >= 5) recentPool.push(s);
  }

  const seniorPool = [];
  const hasDecisionTag = tagInfo.counts.some(([t]) => t === 'decision maker' || t === 'decision makers');
  const leadersChip = make('senior', 'senior', 'senior leader', 'senior leaders', (r) => r.rank === 0, 'company');
  if (!hasDecisionTag && leadersChip.count >= n * 0.1 && leadersChip.count <= n * 0.6) seniorPool.push(leadersChip);

  const relationPool = [];
  if (firm > 0 && firm < n) {
    relationPool.push(make('rel:firm', 'relationship', 'through colleagues', 'through colleagues', (r) => r.c.relationship === 'firm'));
    relationPool.push(make('rel:direct', 'relationship', 'direct', 'direct', (r) => r.c.relationship !== 'firm'));
  }

  // ---- choose six, in the order that suits the file
  const pools = {
    tag: tagPool.filter(fits), role: rolePool.filter(fits), company: companyPool.filter(fits), industry: industryPool.filter(fits),
    place: placePool.filter(fits), recent: recentPool.filter(fits), senior: seniorPool.filter(fits), relationship: relationPool.filter(fits),
  };
  for (const k of Object.keys(pools)) pools[k].sort(byCountThenLabel);
  const tagLed = pools.tag.length > 0;
  const plan = tagLed
    ? [['tag', 3], ['company', 2], ['place', 1], ['role', 1], ['industry', 1], ['recent', 1], ['senior', 1], ['relationship', 2]]
    : [['role', 2], ['company', 2], ['industry', 1], ['place', 1], ['recent', 1], ['senior', 1], ['relationship', 2]];
  const shown = [];
  const more = [];
  const used = new Set();
  const sets = new Map();
  const setOf = (s) => { let k = sets.get(s.id); if (!k) { k = new Set(s.keys); sets.set(s.id, k); } return k; };
  // Two shortcuts that light (nearly) the same people repeat each other: "6
  // at Bluebird Labs" and "7 in Software", "50 founders" and "50 senior
  // leaders". The later one gives its place to the next candidate.
  const repeats = (s) => [...shown, ...more].some((x) => {
    const big = Math.max(x.count, s.count);
    // Sizes too far apart can never share that much: no need to count.
    if (Math.min(x.count, s.count) < big * SAME_PEOPLE) return false;
    const [a, b] = x.count <= s.count ? [x, s] : [s, x];
    const inB = setOf(b);
    let both = 0;
    for (const k of a.keys) if (inB.has(k)) both += 1;
    return both >= big * SAME_PEOPLE;
  });
  // "Venture capital" says the same as an investors chip when one shows.
  const redundant = (s) => s.id === 'industry:Venture capital' && [...shown, ...more].some((x) => x.id === 'role:investors');
  const take = (s, into) => {
    if (used.has(s.id)) return false;
    if (redundant(s) || repeats(s)) { used.add(s.id); return false; }
    into.push(s); used.add(s.id);
    return true;
  };
  for (const [type, quota] of plan) {
    let got = 0;
    for (const s of pools[type]) { if (got >= quota || shown.length >= SHOWN) break; if (take(s, shown)) got += 1; }
  }
  // Slots left over go to the rest, one of each kind per round, so a kind
  // with many candidates (tags, companies) never crowds out the others.
  const fill = (into, full) => {
    for (;;) {
      let added = false;
      for (const [type] of plan) {
        if (full()) return;
        for (const s of pools[type]) {
          if (used.has(s.id)) continue;
          if (take(s, into)) { added = true; break; }
        }
      }
      if (!added) return;
    }
  };
  fill(shown, () => shown.length >= SHOWN);
  // "More": one of each remaining kind before a second of any kind.
  fill(more, () => shown.length + more.length >= MAX_CHIPS);

  const everyone = make('everyone', 'everyone', 'person', 'people', () => true);
  everyone.label = `Everyone ${fmt(N)}`;
  everyone.short = 'Everyone';

  // ---- the read-out
  const parts = [];
  const investors = familyCount.get('investors') || 0;
  const C = companyGroups.length;
  const small = n < 30;
  const nounN = (k, one, many) => [B(k), ` ${k === 1 ? one : many}`];

  // The families named in a sentence: never one that is (nearly) everyone,
  // and never one picked out of a tie (value-16).
  const familyWords = () => {
    const named = familyRanked.filter((f) => f.count < n);
    if (!named.length) return null;
    const top = leaders(named);
    const famWords = (f) => nounN(f.count, f.fam.one, f.fam.many);
    if (top.length >= 3) {
      return [B(top[0].count), ` each of ${names(top.map((f) => f.fam.many), 'other roles')}`];
    }
    if (top.length === 2) return [famWords(top[0]), ' and ', famWords(top[1])];
    const [first, second, third] = named;
    if (!second) return famWords(first);
    // Runners-up tied: two are both named, three or more are "several".
    const tied = named.slice(1).filter((f) => f.count === second.count);
    if (tied.length === 2) return [famWords(first), ', ', famWords(tied[0]), ' and ', famWords(tied[1])];
    if (tied.length > 2) return [famWords(first), ' and several groups of ', B(second.count)];
    return [famWords(first), ' and ', famWords(second)];
  };
  const onlyFamily = familyRanked.length && familyRanked[0].count === n ? familyRanked[0].fam : null;

  if (n === 0) {
    // Nothing to say about an empty file.
  } else if (sparse) {
    // Say what is missing, exactly: "None" when the column is empty, "Most" otherwise.
    const noCompany = share('company') === 0;
    const noTitle = share('title') === 0;
    const people = nounN(n, 'person', 'people');
    // Company shortcuts (from email addresses, or the few the file names)
    // do group people by employer: then only the role is said to be missing.
    const byCompany = [...shown, ...more].some((x) => x.type === 'company');
    if (share('title') < 0.5) {
      const what = noCompany && noTitle ? 'None of them has a company or title'
        : noCompany ? 'None of them has a company and most have no title'
          : noTitle ? 'Most have no company and none has a title' : 'Most have no company or title';
      parts.push(say`${people}. ${what} in this file, so they cannot be grouped by ${byCompany ? 'role' : 'employer or role'}.`);
    } else {
      parts.push(byCompany
        ? say`${people}. ${noCompany ? 'None of them has a company' : 'Most have no company'} in this file.`
        : say`${people}. ${noCompany ? 'None of them has a company' : 'Most have no company'} in this file, so they cannot be grouped by employer.`);
      if (onlyFamily) parts.push(say`By title: all of them ${onlyFamily.many}.`);
      else { const fams = familyWords(); if (fams) parts.push(say`By title: ${fams}.`); }
    }
  } else if (investors >= n * 0.6) {
    parts.push(n === 1
      ? say`${nounN(n, 'contact', 'contacts')} at ${companyGroups[0]?.label || 'no company named'}, an investor or allocator.`
      : say`${nounN(n, 'contact', 'contacts')} at ${nounN(C, 'organisation', 'organisations')}, ${investors === n ? 'all' : B(investors)} of them investors or allocators.`);
  } else if (tagLed) {
    parts.push(C === 1
      ? say`${nounN(n, 'contact', 'contacts')}, all at ${companyGroups[0].label}.`
      : say`${nounN(n, 'contact', 'contacts')} at ${nounN(C, 'company', 'companies')}.`);
  } else {
    const where = C === 1 ? say`, ${n === 1 ? '' : 'all '}at ${companyGroups[0].label}` : say` at ${nounN(C, 'company', 'companies')}`;
    const fams = onlyFamily ? null : familyWords();
    parts.push(say`You know ${nounN(n, 'person', 'people')}${where}${onlyFamily ? `, all of them ${onlyFamily.many}` : fams ? [': ', fams] : ''}.`);
  }
  if (n && tagInfo.signal) {
    // Tag names are quoted and never bold: "23 “met 2026”" (R7).
    const q = (t) => `“${tagInfo.spelling.get(t) || t}”`;
    const useful = tagInfo.useful;
    const cut = useful.length > 3 && useful[3][1] === useful[2][1] ? useful[2][1] : null;
    if (cut === null) {
      const top = useful.slice(0, 3).map(([t, k], i) => [i ? ', ' : '', B(k), ` ${q(t)}`]);
      parts.push(say`By tag: ${top}.`);
    } else {
      // A tie at the cut is said as a tie, never cut alphabetically (R8 #7).
      const above = useful.filter(([, k]) => k > cut).map(([t, k]) => [B(k), ` ${q(t)}, `]);
      const tied = useful.filter(([, k]) => k === cut).map(([t]) => q(t));
      parts.push(say`By tag: ${above}${B(cut)} each in ${B(tied.length)} tags: ${names(tied, 'more', 6)}.`);
    }
  }
  // The companies with the most people: only companies a shortcut would
  // show (three people and 2% of the file), ties said as ties.
  const topCompanies = companyGroups.filter((g) => g.contacts.length >= MIN_PEOPLE && g.contacts.length >= n * 0.02)
    .map((g) => ({ label: g.label, count: g.contacts.length, fromEmail: !!g.fromEmail }));
  const companySentence = (list, from) => {
    const top = leaders(list);
    const [a, b, c] = list;
    if (top.length > 1) parts.push(say`${from} at ${names(top.map((x) => x.label), 'others')} (${B(a.count)} each).`);
    else if (!b || (c && c.count === b.count)) parts.push(say`${from} at ${a.label} (${B(a.count)}).`);
    else {
      const joiner = tagLed || investors >= n * 0.6 ? ', then' : ' and';
      parts.push(say`${from} at ${a.label} (${B(a.count)})${joiner} ${b.label} (${B(b.count)}).`);
    }
  };
  if (n && sparse) {
    // A sparse file's first sentence names no company: the few the file
    // gives, then those read from email addresses, each said once a
    // shortcut would show it.
    const named = topCompanies.filter((g) => !g.fromEmail);
    const mailed = topCompanies.filter((g) => g.fromEmail);
    if (named.length) companySentence(named, 'The most');
    if (mailed.length) companySentence(mailed, 'From email addresses: the most');
  } else if (n && C > 1 && topCompanies.length) {
    companySentence(topCompanies, 'The most');
  }
  // The strongest sector, unless it only repeats the investors chip or
  // holds (nearly) everyone.
  const sectorsSaid = sectors.filter(([label]) => !(label === 'Venture capital' && [...shown, ...more].some((x) => x.id === 'role:investors')));
  if (n && !small && !sparse && !tagLed && investors < n * 0.6 && sectorsSaid.length) {
    const top = leaders(sectorsSaid);
    const k = top[0][1];
    if (k >= n * 0.1 && k < n * NEARLY_ALL && top.length <= 2) {
      parts.push(top.length === 2
        ? say`Strongest in ${top[0][0]} and ${top[1][0]} (${B(k)} each).`
        : say`Strongest in ${top[0][0]} (${B(k)}).`);
    }
  }
  if (n && share('location') >= 0.3 && cities.length && cities[0][1] >= MIN_PEOPLE && cities[0][1] >= n * 0.08) {
    const top = leaders(cities);
    const k = top[0][1];
    if (k === n) parts.push(say`All are in ${spellCity(top[0][0])}.`);
    else if (top.length > 1) parts.push(say`The most are in ${names(top.map(([key]) => spellCity(key)), 'more places')} (${B(k)} each).`);
    // "Most are in" only when it is true; otherwise say it is the largest.
    else if (k > n / 2) parts.push(say`Most are in ${spellCity(top[0][0])} (${B(k)}).`);
    else parts.push(say`More are in ${spellCity(top[0][0])} (${B(k)}) than anywhere else.`);
  }
  if (n && !small && recentPool.length && recentPool[0].count < n * NEARLY_ALL) parts.push(say`${B(recentPool[0].count)} connected ${recentWords}.`);

  // ---- three example questions the engine answers by rules, each with
  // people behind it, built only from shortcuts the user can see (shown or
  // under More), each counting exactly that shortcut's people.
  const questions = [];
  const offered = [...shown, ...more];
  const ofType = (type) => offered.filter((s) => s.type === type && s.count > 0);
  const ask = (text, count) => { if (count > 0 && questions.length < 3 && !questions.some((q) => q.text === text)) questions.push({ text, count }); };
  // A company read from an email domain is not a company the question engine
  // knows by name: those files get role and place questions only.
  const companyChips = ofType('company').filter((s) => !s.fromEmail);
  const roleChips = ofType('role');
  const placeChips = ofType('place');
  const atQ = (s) => ask(`Who do I know at ${s.short.slice(3)}?`, s.count);
  const roleQ = (s) => ask(`Which ${familyByKey(s.id.slice('role:'.length)).many} do I know?`, s.count);
  const placeQ = (s) => ask(`Who do I know in ${s.short.slice(3)}?`, s.count);
  // A company, a role, a place; then a second of each, and so on, until
  // there are three.
  for (let i = 0; questions.length < 3 && i < MAX_CHIPS; i += 1) {
    if (companyChips[i]) atQ(companyChips[i]);
    if (roleChips[i]) roleQ(roleChips[i]);
    if (placeChips[i]) placeQ(placeChips[i]);
  }

  const groupings = usefulGroupings(list);
  const profile = {
    n,
    companies: C,
    companyFrom,
    fields,
    sentences: parts.map(textOf),
    parts,
    shortcuts: shown,
    more,
    questions,
    groupings,
    defaultGrouping: defaultGrouping(list, groupings),
    everyone,
  };
  const byId = new Map([...shown, ...more, everyone].map((s) => [s.id, { s, set: setOf(s) }]));
  internals.set(profile, { byId });
  return profile;
}

/** The label of a shortcut for `count` people, singular when it is one: "1 engineer", "12 engineers", "3 at Stripe". */
export function labelFor(shortcut, count) {
  if (!shortcut) return '';
  if (shortcut.type === 'everyone') return `Everyone ${fmt(count)}`;
  const words = count === 1 ? (shortcut.one || shortcut.many || shortcut.short) : (shortcut.many || shortcut.short);
  return `${fmt(count)} ${words}`;
}

/** The parts pressed, each once, at most three; "everyone" and unknown ids are left out. */
function partsOf(inner, ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids || []) {
    if (id === 'everyone' || seen.has(id)) continue;
    seen.add(id);
    const p = inner?.byId.get(id);
    if (p) out.push(p);
    if (out.length >= MAX_COMBINED) break;
  }
  return out;
}

/**
 * Several shortcuts pressed together: the people in all of them (AND), at
 * most three. Returns { label, keys: Set, sort }; the label is the parts
 * joined ("investors · at Stripe"), the keys keep the first shortcut's
 * order. No ids (or only "everyone") gives everyone.
 */
export function combine(profile, ids) {
  const inner = internals.get(profile);
  const parts = partsOf(inner, ids);
  if (!inner || !parts.length) {
    const all = profile?.everyone;
    return { label: 'Everyone', keys: new Set(all ? all.keys : []), sort: 'senior' };
  }
  const [first, ...rest] = parts;
  const keys = rest.length ? new Set(first.s.keys.filter((k) => rest.every((p) => p.set.has(k)))) : new Set(first.s.keys);
  return { label: parts.map((p) => p.s.short).join(' · '), keys, sort: first.s.sort };
}

/** How many people would remain if shortcut `id` were pressed with `activeIds`. */
export function countIfAdded(profile, activeIds, id) {
  const inner = internals.get(profile);
  const add = inner?.byId.get(id);
  if (!add) return 0;
  const active = partsOf(inner, (activeIds || []).filter((x) => x !== id));
  if (!active.length) return add.s.count;
  let count = 0;
  for (const k of add.s.keys) if (active.every((p) => p.set.has(k))) count += 1;
  return count;
}

/**
 * "Narrow to" (ROUND2 R1): with shortcuts `activeIds` pressed, the other
 * shortcuts (the shown ones, then More) that would narrow the list, each
 * with how many it would leave: at least one and fewer than the list,
 * largest first, at most `limit`. Nothing when the list holds one person or
 * three parts are already pressed. Returns [{ id, label, count }], the
 * label in the right number ("1 engineer").
 */
export function narrowings(profile, activeIds, limit = 6) {
  const inner = internals.get(profile);
  const active = partsOf(inner, activeIds);
  if (!inner || !active.length || active.length >= MAX_COMBINED) return [];
  const current = combine(profile, active.map((p) => p.s.id)).keys;
  if (current.size <= 1) return [];
  const pressed = new Set(active.map((p) => p.s.id));
  const out = [];
  [...profile.shortcuts, ...profile.more].forEach((s, i) => {
    if (pressed.has(s.id)) return;
    const { set } = inner.byId.get(s.id);
    // Count over the smaller of the two lists.
    const [few, many] = current.size <= set.size ? [current, set] : [set, current];
    let count = 0;
    for (const k of few) if (many.has(k)) count += 1;
    if (count >= 1 && count < current.size) out.push({ id: s.id, label: labelFor(s, count), count, i });
  });
  return out.sort((a, b) => b.count - a.count || a.i - b.i).slice(0, limit).map(({ id, label, count }) => ({ id, label, count }));
}

/**
 * The shortcut (shown or under More) whose people are exactly `keys` (a
 * Set or array of person ids), or null: a group clicked on the globe that
 * holds the same people as a chip shows that chip as pressed.
 */
export function shortcutFor(profile, keys) {
  const inner = internals.get(profile);
  if (!inner || !keys) return null;
  const want = keys instanceof Set ? keys : new Set(keys);
  for (const s of [...profile.shortcuts, ...profile.more]) {
    if (s.count !== want.size) continue;
    if (s.keys.every((k) => want.has(k))) return s.id;
  }
  return null;
}

/** A field on one line: a line break or a tab inside a company would split a person over two lines. */
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** The people as plain lines to paste: "Name, Title at Company", one per line. */
export function listText(contacts) {
  return (contacts || []).filter(Boolean).map((c) => {
    const name = oneLine(c.name);
    const title = oneLine(c.position);
    const company = oneLine(c.company);
    const what = title && company ? `${title} at ${company}` : title || company;
    return what ? `${name}, ${what}` : name;
  }).join('\n');
}

/** Tags in one cell, "; " between them; a tag that itself holds ";" is quoted so it reads as one tag. */
const tagCell = (tags) => (Array.isArray(tags) ? tags : [])
  .map((t) => String(t ?? '').trim()).filter(Boolean)
  .map((t) => (/[;"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t))
  .join('; ');

const CSV_COLUMNS = [
  ['Name', (c) => c.name],
  ['Company', (c) => c.company],
  ['Title', (c) => c.position],
  ['Email', (c) => c.email],
  ['Location', (c) => c.location],
  ['Tags', (c) => tagCell(c.tags)],
  ['Connected On', (c) => c.connectedOn],
  ['Profile URL', (c) => c.profileUrl],
  ['Through', (c) => (c.relationship === 'firm' ? c.via || 'a colleague' : '')],
];

/**
 * A cell, quoted when needed. A value a spreadsheet would run as a formula
 * (= + - @, also after leading spaces or a tab) gets a leading apostrophe; a
 * plain number such as "-2" is left as it is.
 */
function cell(value) {
  let v = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(v) && !/^[+-]?\d+([.,]\d+)?$/.test(v.trim())) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The people as a CSV with the columns the file has (a column nobody fills is left out). */
export function listCsv(contacts) {
  const list = (contacts || []).filter(Boolean);
  const cols = CSV_COLUMNS.filter(([, get], i) => i === 0 || list.some((c) => String(get(c) ?? '').trim()));
  const lines = [cols.map(([name]) => name).join(',')];
  for (const c of list) lines.push(cols.map(([, get]) => cell(get(c))).join(','));
  return `${lines.join('\n')}\n`;
}
