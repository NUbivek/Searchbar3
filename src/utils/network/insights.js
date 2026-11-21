/**
 * What an uploaded network holds, in plain words, and the shortcuts built
 * from it. Everything here is read from the file: no fixed preset list, no
 * model, nothing leaves the browser. Pure functions, no React.
 *
 *   profileNetwork(contacts, { today })  the read-out, the shortcuts, three
 *                                        example questions and the
 *                                        arrangements that split the file
 *   combine(profile, ids)                several shortcuts pressed together
 *                                        (AND), as one selection
 *   countIfAdded(profile, active, id)    how many would remain if `id` were
 *                                        pressed too
 *   listText(contacts) / listCsv(...)    the listed people, to copy or save
 *
 * A Shortcut is { id, type, label, short, count, keys: string[], sort }:
 * `label` is the chip ("22 at Stripe"), `short` the same without the count
 * ("at Stripe", for a combined title), `keys` the person ids (personNodeId)
 * already in the shortcut's own order, `sort` 'senior' | 'recent' | 'company'.
 */
import { classifyContact, familyByKey } from './roles';
import { industryOf, isSector, tagProfile, tagsOf, cityOf, usefulGroupings, defaultGrouping } from './grouping';
import { groupByCompany, companyKeyOf, personNodeId, seniority, NO_COMPANY_KEY } from './atlas';
import { companyMatch } from './parseContacts';

const SHOWN = 6;
const MAX_CHIPS = 12;
const MAX_COMBINED = 3;
const DAY = 86400000;

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const people = (n) => `${fmt(n)} ${n === 1 ? 'person' : 'people'}`;
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

// Internal lookups per profile (id -> shortcut with a Set of keys), kept off
// the returned object so it stays plain data.
const internals = new WeakMap();

/**
 * Read a network. `contacts` are the people in view (after the source chips
 * and "direct only"). `today` (a Date or 'YYYY-MM-DD') fixes the clock for
 * tests. Returns { n, companies, fields, sentences, shortcuts, more,
 * questions, groupings, defaultGrouping, everyone }.
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
  const companyGroups = groupByCompany(list).filter((g) => g.key !== NO_COMPANY_KEY);
  const companySize = new Map(companyGroups.map((g) => [g.key, g.contacts.length]));

  // Orders a shortcut's people can be listed in. Names compare as plain
  // lower-cased strings: localeCompare is too slow for 30,000 people.
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const order = {
    senior: (a, b) => a.rank - b.rank || byName(a, b),
    recent: (a, b) => (b.day ?? -Infinity) - (a.day ?? -Infinity) || byName(a, b),
    company: (a, b) => (companySize.get(b.companyKey) || 0) - (companySize.get(a.companyKey) || 0) || byName(a, b),
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
  const make = (id, type, short, test, sort = 'senior') => {
    // The recent and company orders serve one shortcut each: sort its members only.
    const members = senior().filter(test);
    if (sort !== 'senior') members.sort(order[sort]);
    const keys = members.map((r) => r.id);
    const count = keys.length;
    return { id, type, label: `${fmt(count)} ${short}`, short, count, keys, sort };
  };
  // No chip may light nobody or everyone: it would tell the user nothing.
  const fits = (s) => s.count > 0 && s.count < n;

  // ---- candidates, each pool largest first
  const tagInfo = tagProfile(list);
  const tagPool = tagInfo.signal
    ? tagInfo.useful.slice(0, 6).map(([tag]) => {
      const spelled = tagInfo.spelling.get(tag) || tag;
      return make(`tag:${tag}`, 'tag', `tagged “${spelled}”`, (r) => r.tags.includes(tag));
    })
    : [];

  const familyRanked = [...familyCount.entries()]
    .map(([key, count]) => ({ key, count, fam: familyByKey(key) }))
    .filter((f) => f.fam && !f.fam.catchAll && f.count >= 3)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const rolePool = familyRanked
    .filter((f) => f.count >= n * 0.05 && f.count <= n * 0.9)
    .slice(0, 4)
    .map((f) => make(`role:${f.key}`, 'role', f.count === 1 ? f.fam.one : f.fam.many, (r) => r.family === f.key));

  const companyPool = companyGroups
    .filter((g) => g.contacts.length >= 3 && g.contacts.length >= n * 0.02)
    .slice(0, 4)
    .map((g) => make(`company:${g.key}`, 'company', `at ${g.label}`, (r) => r.companyKey === g.key));

  const sectors = [...industryCount.entries()].filter(([label]) => isSector(label)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const industryPool = sectors
    .filter(([, count]) => count >= n * 0.1 && count <= n * 0.6)
    .slice(0, 3)
    .map(([label]) => make(`industry:${label}`, 'industry', `in ${label}`, (r) => r.industry === label));

  const spellCity = (key) => {
    let best = key; let top = 0;
    for (const [s, k] of citySpelling.get(key) || []) if (k > top || (k === top && s < best)) { best = s; top = k; }
    return best;
  };
  const cities = [...cityCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const placePool = share('location') >= 0.3
    ? cities.filter(([, count]) => count >= 3 && count >= n * 0.08).slice(0, 3)
      .map(([key]) => make(`place:${key}`, 'place', `in ${spellCity(key)}`, (r) => r.city === key))
    : [];

  // Recent: the twelve months up to the earlier of today and the file's
  // newest date, so an old export still shows its own last year.
  const recentPool = [];
  let recentWords = 'in the last 12 months';
  if (share('connectedOn') >= 0.5 && newest !== null) {
    const end = todayDay !== null ? Math.min(todayDay, newest) : newest;
    const start = yearBefore(end);
    if (todayDay !== null && newest < todayDay - 60) recentWords = 'in the 12 months before this export';
    const s = make('recent', 'recent', `connected ${recentWords}`, (r) => r.day !== null && r.day > start && r.day <= end, 'recent');
    if (s.count >= 5) recentPool.push(s);
  }

  const seniorPool = [];
  const hasDecisionTag = tagInfo.counts.some(([t]) => t === 'decision maker' || t === 'decision makers');
  const leaders = make('senior', 'senior', 'senior leaders', (r) => r.rank === 0, 'company');
  if (!hasDecisionTag && leaders.count >= n * 0.1 && leaders.count <= n * 0.6) seniorPool.push(leaders);

  const relationPool = [];
  if (firm > 0 && firm < n) {
    relationPool.push(make('rel:firm', 'relationship', 'through colleagues', (r) => r.c.relationship === 'firm'));
    relationPool.push(make('rel:direct', 'relationship', 'direct', (r) => r.c.relationship !== 'firm'));
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
  const used = new Set();
  // "Venture capital" says the same as an investors chip when one shows.
  const redundant = (s) => s.id === 'industry:Venture capital' && shown.some((x) => x.id === 'role:investors');
  const take = (s) => {
    if (shown.length >= SHOWN || used.has(s.id) || redundant(s)) return false;
    shown.push(s); used.add(s.id);
    return true;
  };
  for (const [type, quota] of plan) {
    let got = 0;
    for (const s of pools[type]) { if (got >= quota) break; if (take(s)) got += 1; }
  }
  // Slots left over go to the rest, in the same order.
  for (const [type] of plan) pools[type].forEach(take);
  const more = [];
  for (const [type] of plan) {
    for (const s of pools[type]) {
      if (used.has(s.id) || redundant(s) || shown.length + more.length >= MAX_CHIPS) continue;
      more.push(s);
      used.add(s.id);
    }
  }

  const everyone = make('everyone', 'everyone', '', () => true);
  everyone.label = `Everyone ${fmt(n)}`;
  everyone.short = 'Everyone';

  // ---- the read-out
  const sentences = [];
  const investors = familyCount.get('investors') || 0;
  const C = companyGroups.length;
  const topCompanies = companyGroups.filter((g) => g.contacts.length >= 2).slice(0, 2);
  const sparse = n > 0 && share('company') < 0.5;
  const small = n < 30;
  if (n === 0) {
    // Nothing to say about an empty file.
  } else if (sparse) {
    sentences.push(share('title') < 0.5
      ? `${people(n)}. Most have no company or title in this file, so they cannot be grouped by employer or role.`
      : `${people(n)}. Most have no company in this file, so they cannot be grouped by employer.`);
    if (share('title') >= 0.5) {
      const fams = familyRanked.slice(0, 2).map((f) => `${fmt(f.count)} ${f.count === 1 ? f.fam.one : f.fam.many}`);
      if (fams.length) sentences.push(`By title: ${fams.join(' and ')}.`);
    }
  } else if (investors >= n * 0.6) {
    sentences.push(`${fmt(n)} ${n === 1 ? 'contact' : 'contacts'} at ${fmt(C)} ${C === 1 ? 'organisation' : 'organisations'}, ${investors === n ? 'all' : fmt(investors)} of them investors or allocators.`);
  } else if (tagLed) {
    sentences.push(`${fmt(n)} ${n === 1 ? 'contact' : 'contacts'} at ${fmt(C)} ${C === 1 ? 'company' : 'companies'}.`);
  } else {
    const fams = familyRanked.slice(0, 2).map((f) => `${fmt(f.count)} ${f.count === 1 ? f.fam.one : f.fam.many}`);
    sentences.push(`You know ${people(n)} at ${fmt(C)} ${C === 1 ? 'company' : 'companies'}${fams.length ? `: ${fams.join(' and ')}` : ''}.`);
  }
  if (n && tagInfo.signal) {
    const top = tagInfo.useful.slice(0, 3).map(([t, k]) => `${fmt(k)} ${tagInfo.spelling.get(t) || t}`);
    sentences.push(`By tag: ${top.join(', ')}.`);
  }
  if (n && !sparse && topCompanies.length) {
    const [a, b] = topCompanies;
    const joiner = tagLed || investors >= n * 0.6 ? ', then' : ' and';
    sentences.push(b ? `The most at ${a.label} (${fmt(a.contacts.length)})${joiner} ${b.label} (${fmt(b.contacts.length)}).` : `The most at ${a.label} (${fmt(a.contacts.length)}).`);
  }
  // The strongest sector, unless it only repeats the investors chip.
  const strongest = sectors.find(([label]) => !(label === 'Venture capital' && shown.some((x) => x.id === 'role:investors')));
  if (n && !small && !sparse && !tagLed && investors < n * 0.6 && strongest && strongest[1] >= n * 0.1) {
    sentences.push(`Strongest in ${strongest[0]} (${fmt(strongest[1])}).`);
  }
  if (n && share('location') >= 0.3 && cities.length && cities[0][1] >= 3 && cities[0][1] >= n * 0.08) {
    const [key, k] = cities[0];
    // "Most are in" only when it is true; otherwise say it is the largest.
    sentences.push(k > n / 2 ? `Most are in ${spellCity(key)} (${fmt(k)}).` : `More are in ${spellCity(key)} (${fmt(k)}) than anywhere else.`);
  }
  if (n && !small && recentPool.length) sentences.push(`${fmt(recentPool[0].count)} connected ${recentWords}.`);

  // ---- three example questions the engine answers by rules, each with people behind it
  const questions = [];
  // Matched once per distinct company, not once per person: the same count,
  // at a fraction of the cost on a large file.
  let perCompany = null;
  const atCompany = (key) => {
    if (!perCompany) {
      perCompany = new Map();
      for (const r of rows) if (r.companyKey !== NO_COMPANY_KEY) perCompany.set(r.companyKey, (perCompany.get(r.companyKey) || 0) + 1);
    }
    let total = 0;
    for (const [k, count] of perCompany) {
      const m = companyMatch(k, key);
      if (m === 'exact' || m === 'contains' || m === 'within') total += count;
    }
    return total;
  };
  const companyChips = pools.company;
  const ask = (text, count) => { if (count > 0 && !questions.some((q) => q.text === text)) questions.push({ text, count }); };
  if (companyChips[0]) ask(`Who do I know at ${companyChips[0].short.slice(3)}?`, atCompany(companyChips[0].id.slice('company:'.length)));
  const roleChip = shown.find((s) => s.type === 'role') || pools.role[0];
  if (roleChip) ask(`Which ${familyByKey(roleChip.id.slice('role:'.length)).many} do I know?`, roleChip.count);
  const placeChip = shown.find((s) => s.type === 'place') || pools.place[0];
  if (placeChip) ask(`Who do I know in ${placeChip.short.slice(3)}?`, placeChip.count);
  else if (companyChips[1]) ask(`Who do I know at ${companyChips[1].short.slice(3)}?`, atCompany(companyChips[1].id.slice('company:'.length)));
  // Three examples when the file has them: the second company fills a gap.
  if (questions.length < 3 && companyChips[1]) ask(`Who do I know at ${companyChips[1].short.slice(3)}?`, atCompany(companyChips[1].id.slice('company:'.length)));

  const groupings = usefulGroupings(list);
  const profile = {
    n, companies: C, fields, sentences, shortcuts: shown, more, questions, groupings, defaultGrouping: defaultGrouping(list, groupings), everyone,
  };
  const byId = new Map([...shown, ...more, everyone].map((s) => [s.id, { s, set: new Set(s.keys) }]));
  internals.set(profile, { byId });
  return profile;
}

/**
 * Several shortcuts pressed together: the people in all of them (AND), at
 * most three. Returns { label, keys: Set, sort }; the label is the parts
 * joined ("investors · at Stripe"), the keys keep the first shortcut's
 * order. No ids (or only "everyone") gives everyone.
 */
export function combine(profile, ids) {
  const inner = internals.get(profile);
  const parts = (ids || []).filter((id) => id !== 'everyone').map((id) => inner?.byId.get(id)).filter(Boolean).slice(0, MAX_COMBINED);
  if (!inner || !parts.length) {
    const all = profile?.everyone;
    return { label: 'Everyone', keys: new Set(all ? all.keys : []), sort: 'senior' };
  }
  const [first, ...rest] = parts;
  const keys = new Set(first.s.keys.filter((k) => rest.every((p) => p.set.has(k))));
  return { label: parts.map((p) => p.s.short).join(' · '), keys, sort: first.s.sort };
}

/** How many people would remain if shortcut `id` were pressed with `activeIds`. */
export function countIfAdded(profile, activeIds, id) {
  const inner = internals.get(profile);
  const add = inner?.byId.get(id);
  if (!add) return 0;
  const active = (activeIds || []).filter((x) => x !== id && x !== 'everyone').map((x) => inner.byId.get(x)).filter(Boolean);
  if (!active.length) return add.s.count;
  let count = 0;
  for (const k of add.s.keys) if (active.every((p) => p.set.has(k))) count += 1;
  return count;
}

/** The people as plain lines to paste: "Name, Title at Company", one per line. */
export function listText(contacts) {
  return (contacts || []).filter(Boolean).map((c) => {
    const title = String(c.position || '').trim();
    const company = String(c.company || '').trim();
    const what = title && company ? `${title} at ${company}` : title || company;
    return what ? `${String(c.name || '').trim()}, ${what}` : String(c.name || '').trim();
  }).join('\n');
}

const CSV_COLUMNS = [
  ['Name', (c) => c.name],
  ['Company', (c) => c.company],
  ['Title', (c) => c.position],
  ['Email', (c) => c.email],
  ['Location', (c) => c.location],
  ['Tags', (c) => (Array.isArray(c.tags) ? c.tags.join('; ') : '')],
  ['Connected On', (c) => c.connectedOn],
  ['Profile URL', (c) => c.profileUrl],
  ['Through', (c) => (c.relationship === 'firm' ? c.via || 'a colleague' : '')],
];

/** A cell, quoted when needed. A leading = + - @ is escaped so a spreadsheet does not run it as a formula. */
function cell(value) {
  let v = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The people as a CSV with the columns the file has (a column nobody fills is left out). */
export function listCsv(contacts) {
  const list = (contacts || []).filter(Boolean);
  const cols = CSV_COLUMNS.filter(([name, get], i) => i === 0 || list.some((c) => String(get(c) ?? '').trim()));
  const lines = [cols.map(([name]) => name).join(',')];
  for (const c of list) lines.push(cols.map(([, get]) => cell(get(c))).join(','));
  return `${lines.join('\n')}\n`;
}
