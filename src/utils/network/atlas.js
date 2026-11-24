/**
 * The Network Map's layout: a branching network, like neurons.
 *
 *   you → group → sub-group → company → person
 *
 * Every node is a cell body with its children gathered around it and a
 * link out to each one. A node's whole cluster (itself, its children and
 * theirs) fits inside a circle of radius `r`; clusters never overlap, so a
 * branch can always be found again in the same place. Positions are
 * computed once, here, with no physics: the same contacts always give the
 * same map, and zooming never moves anything. The renderer only pans and
 * zooms over these coordinates.
 *
 * Every node is { id, type: 'group'|'company'|'person'|'root', dim, key,
 * label, count, placed, last, hint, colorKey, color, ... }:
 *   count   the number shown everywhere (for a tag group: everyone who
 *           carries the tag, wherever they sit on the map)
 *   placed  how many people sit inside this node
 *   last    an "Other …" or "… not known" group: the globe puts it on the
 *           far side and the list shows it last
 */
import { packSiblings } from 'd3-hierarchy';
import { dedupeKey } from './parseContacts';
import {
  bucketsFor, companyKeyFor, tagsOf, OTHER_TAGS, NO_TAG,
} from './grouping';

export const NO_COMPANY_KEY = '__none__';
/** The bubble that holds every company past the largest ones under By company. */
export const OTHER_COMPANIES_KEY = '__other__';
/** How many companies By company shows as their own bubbles. */
export const MAX_COMPANY_HUBS = 16;
/** Inside a group, how many companies get their own bubble before "Other companies". */
export const MAX_INNER_COMPANIES = 8;
export const ROOT_ID = 'root';

// Caches per contact object, with the fields they were read from: a contact
// edited in place (a title fixed, an email added) is read again.
const personIds = new WeakMap();
/** A person's node id, stable across arrangements and filters. */
export function personNodeId(contact) {
  if (!contact || typeof contact !== 'object') return `p:${dedupeKey(contact || {})}`;
  const { profileUrl = '', email = '', name = '', company = '' } = contact;
  const hit = personIds.get(contact);
  if (hit && hit.profileUrl === profileUrl && hit.email === email && hit.name === name && hit.company === company) return hit.id;
  const id = `p:${dedupeKey(contact)}`;
  personIds.set(contact, { profileUrl, email, name, company, id });
  return id;
}

/**
 * Layers of the map for each starting grouping, outermost first. The second
 * layer under an industry or a place is the role family (ROUND2 R2), the
 * same words the read-out and the shortcuts use.
 */
export const LAYERS = {
  role: ['role', 'company'],
  industry: ['industry', 'family', 'company'],
  country: ['country', 'family', 'company'],
  place: ['country', 'family', 'company'],
  // A pipeline or fundraising list: the stage, then the accounts in it.
  tag: ['tag', 'company'],
  company: ['company'],
};
const FAMILY_DIMS = new Set(['role', 'family']);

export const NEUTRAL_COLOR = '#7C8A9E';
/**
 * One colour per role family, the same on every file, in both themes and
 * in the list's dots: "Investors" are always this blue, wherever they sit.
 * The catch-alls are neutral.
 */
export const FAMILY_COLORS = {
  investors: '#3D6A96', founders: '#2E8B6E', engineers: '#2A8C9E', product: '#7A5C9E', data: '#4F6DAF', sales: '#C0565A',
  operations: '#9A6B3C', finance: '#5B7F3F', people: '#8E5E7A', clinicians: '#3F8F8A', academics: '#B8742A', bankers: '#6E8CA8',
  lawyers: '#8A5A4A', consultants: '#A2763E', partners: '#3C7A68', accelerators: '#A0577A', public: '#56709E', press: '#857A3C',
  students: '#4C8C5C', leaders: '#6F7C90', others: NEUTRAL_COLOR, unknown: NEUTRAL_COLOR,
};
/** Kept for older callers: the family colours of the families that share an old group's key. */
export const GROUP_COLORS = { investors: FAMILY_COLORS.investors, founders: FAMILY_COLORS.founders, other: NEUTRAL_COLOR };
export const CLUSTER_COLORS = [
  '#3D6A96', '#2E8B6E', '#B8742A', '#7A5C9E', '#C0565A', '#2A8C9E', '#5B7F3F', '#9A6B3C', '#4F6DAF', '#3F8F8A',
  '#8E5E7A', '#6E8CA8', '#A2763E', '#3C7A68', '#8A5A4A',
];
/** A stable colour for a company, from a hash of its key. */
export function clusterColor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CLUSTER_COLORS[h % CLUSTER_COLORS.length];
}

/** A shade of a colour: t < 0 mixes towards ink, t > 0 towards white. */
export function shade(hex, t) {
  const n = parseInt(String(hex || NEUTRAL_COLOR).slice(1), 16);
  const to = t < 0 ? [15, 23, 42] : [255, 255, 255];
  const k = Math.min(1, Math.abs(t));
  const mix = (c, target) => Math.round(c + (target - c) * k).toString(16).padStart(2, '0');
  return `#${mix((n >> 16) & 255, to[0])}${mix((n >> 8) & 255, to[1])}${mix(n & 255, to[2])}`;
}

/** World-space sizes. A person is always this radius; everything else follows from packing. */
export const PERSON_R = 4;
const GAP = { person: 1.8, company: 10, group: 26, top: 54 };
/**
 * Drawn radius of a node's own dot, in world units: sized by the people who
 * sit inside it (a tag group's count also holds people placed elsewhere).
 */
const dotFor = (node) => {
  const k = node.placed ?? node.count;
  return node.type === 'company' ? Math.min(3 + Math.sqrt(k) * 1.15, 15) : node.type === 'group' ? Math.min(9 + Math.sqrt(k) * 0.55, 22) : node.type === 'root' ? 10 : PERSON_R;
};
/** Clear space between a node's dot and the first ring of its children: the visible length of its links. */
const REACH = { company: 5, group: 34, root: 60 };

// ------------------------------------------------------------ seniority

/**
 * The chief of a place, not someone who works for one or a rank that only
 * sounds like it: "Vice President" leads a function, "Chief of Staff"
 * supports the chief, "Product Owner" owns a backlog, "Principal Engineer"
 * and "Partner Manager" are not principals or partners of anything.
 */
const NOT_OWNER = '(?<!\\b(?:product|process|business|budget|account|data|service|system|technical|feature|content|platform|program|project|release|risk|control|ip|brand)\\s)';
const RANK0 = new RegExp([
  '\\bco-?founder\\b', '\\bfounder\\b', '\\bceo\\b', '\\bchief executive\\b',
  '\\bchief(?!\\s+of\\s+staff)\\b',
  '(?<!\\bvice[\\s-])(?<!\\bto\\s)(?<!\\bto the\\s)\\bpresident\\b',
  `${NOT_OWNER}\\bowner\\b`,
  '\\bchair(?:man|woman|person)?\\b',
  '\\bmanaging (?:director|partner)\\b', '\\bgeneral partner\\b',
  // A partner as a rank: alone, or of a fund or a firm. Not a job that works
  // with partners, and not the step below partner.
  '(?<!\\b(?:associate|junior|channel|strategic|alliance|alliances|technology|tech|implementation|integration|business|referral|reseller|solutions?|ecosystem|agency|hr|people|talent|learning|finance|data|retail|trusted)\\s)\\bpartner\\b(?!\\s+(?:manager|management|marketing|development|success|sales|enablement|operations|ops|programs?|ecosystem|solutions|engineer\\w*|account|relations|integrations?|network|lead|specialist|director|executive|associate|channel))',
  // "Principal" on its own is an investment rank; "Principal Engineer" is a
  // senior engineer, "Principal Investigator" a researcher.
  '\\bprincipal\\b(?!\\s+[a-z])',
].join('|'), 'i');
const RANK1 = /\b(vp|vice[\s-]president|svp|evp|head|director|lead|gm|general manager|principal|associate partner|chief of staff)\b/i;
const EXCEPT = /\b(assistant|associate) to\b/i;

const ranks = new WeakMap();
/** 0 = runs the place, 1 = leads a function, 2 = everyone else; read from the title. */
export function seniority(contact) {
  if (!contact || typeof contact !== 'object') return 2;
  const position = contact.position || '';
  const hit = ranks.get(contact);
  if (hit && hit.position === position) return hit.r;
  const r = readSeniority(position);
  ranks.set(contact, { position, r });
  return r;
}

function readSeniority(position) {
  const t = String(position || '').toLowerCase();
  if (!t) return 2;
  if (RANK0.test(t) && !EXCEPT.test(t)) return 0;
  if (RANK1.test(t)) return 1;
  return 2;
}

// ------------------------------------------------------------ companies

/** Spacing of the people in a company's burst (a sunflower spiral). */
const BURST = 6.4;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** The contact's company key (one key for every spelling), or NO_COMPANY_KEY, also for "Self-employed" and the like. */
export const companyKeyOf = (contact) => companyKeyFor(contact) || NO_COMPANY_KEY;

/**
 * The spelling most of these people use for their company ("McKinsey &
 * Company" over "McKinsey"), ties broken alphabetically. The same answer as
 * grouping's companyLabelFor, counted per distinct cell first: on a large
 * file most people share a spelling, so the tidying runs once per spelling.
 */
function labelOf(contacts) {
  const raw = new Map();
  for (const c of contacts) {
    const v = c.company;
    raw.set(v, (raw.get(v) || 0) + 1);
  }
  const tidy = new Map();
  for (const [v, k] of raw) {
    const name = String(v || '').trim().replace(/\s+/g, ' ');
    if (name) tidy.set(name, (tidy.get(name) || 0) + k);
  }
  let best = ''; let n = 0;
  for (const [name, k] of tidy) if (k > n || (k === n && name < best)) { best = name; n = k; }
  return best;
}

/**
 * Group contacts by company. Returns [{ key, label, contacts }]: the named
 * companies largest first, then "No company listed" (people with no
 * company, or a placeholder such as "Self-employed") last. The label is the
 * spelling most of the company's people use.
 */
export function groupByCompany(contacts) {
  const groups = new Map();
  for (const c of contacts || []) {
    const key = companyKeyOf(c);
    let g = groups.get(key);
    if (!g) { g = { key, contacts: [] }; groups.set(key, g); }
    g.contacts.push(c);
  }
  const none = groups.get(NO_COMPANY_KEY);
  groups.delete(NO_COMPANY_KEY);
  const list = [...groups.values()].map((g) => ({ key: g.key, label: labelOf(g.contacts) || g.key, contacts: g.contacts }));
  list.sort((a, b) => b.contacts.length - a.contacts.length || a.label.localeCompare(b.label));
  if (none) list.push({ key: NO_COMPANY_KEY, label: 'No company listed', contacts: none.contacts, last: true });
  return list;
}

function companyNodes(contacts, parent, groups = groupByCompany(contacts)) {
  return groups.map((g) => {
    const node = {
      id: `${parent.id === ROOT_ID ? 'g' : parent.id}/c:${g.key}`, type: 'company', dim: 'company', key: g.key, label: g.label,
      count: g.contacts.length, placed: g.contacts.length, last: g.key === NO_COMPANY_KEY, hint: '', colorKey: g.key,
      contacts: g.contacts, parent, depth: parent.depth + 1,
    };
    // Most senior first: they sit closest to the company's core in its burst.
    node.children = g.contacts
      .map((c) => ({ id: personNodeId(c), type: 'person', dim: null, key: null, label: c.name, contact: c, rank: seniority(c), count: 1, placed: 1, last: false, colorKey: null, parent: node, depth: node.depth + 1, children: [] }))
      .sort((a, b) => a.rank - b.rank || String(a.label || '').localeCompare(String(b.label || '')));
    return node;
  });
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

/** The company most of these people are at, with its count, or null when none has two. */
function topCompany(contacts) {
  const byKey = new Map();
  for (const c of contacts) {
    const k = companyKeyOf(c);
    if (k === NO_COMPANY_KEY) continue;
    const g = byKey.get(k);
    if (g) g.push(c); else byKey.set(k, [c]);
  }
  let best = null; let n = 0; let ties = 0;
  for (const g of byKey.values()) {
    if (g.length > n) { best = g; n = g.length; ties = 1; } else if (g.length === n) ties += 1;
  }
  // A tie at the top names no company: either name would be a guess.
  if (!best || n < 2 || ties > 1) return null;
  return { label: labelOf(best), n };
}

/** "{n} people · most at {company} ({k})": a line built from the people in the group. */
function hintFor(contacts, extra = []) {
  const parts = [plural(contacts.length, 'person', 'people'), ...extra];
  const top = topCompany(contacts);
  if (top) parts.push(`most at ${top.label} (${fmt(top.n)})`);
  return parts.join(' · ');
}

// ------------------------------------------------------------ building the tree

function groupNode(parent, dim, b) {
  const placed = b.contacts.length;
  const family = FAMILY_DIMS.has(dim);
  return {
    id: `${parent.id === ROOT_ID ? 'g' : parent.id}/${dim}:${b.key}`, type: 'group', dim, key: b.key, label: b.label,
    hint: b.hint || '', lens: b.lens || null, count: placed, placed, last: !!b.last, colorKey: b.key,
    // The family key of a role-family group ("Other roles" is none).
    family: family && !b.buckets ? b.key : null, contacts: b.contacts, parent, depth: parent.depth + 1,
  };
}

/** Companies under `parent`, the largest `cap` with their own bubble and the rest in one "Other companies". */
function companyLayer(contacts, parent, cap) {
  const groups = groupByCompany(contacts);
  const named = groups.filter((g) => g.key !== NO_COMPANY_KEY);
  const none = groups.filter((g) => g.key === NO_COMPANY_KEY);
  if (named.length <= cap + 1) return companyNodes(contacts, parent, groups);
  // The largest companies get their own bubbles and the rest share one, so
  // the globe places a handful of clusters, not hundreds. People with no
  // company never take one of the places: they come after, on their own.
  const kept = named.slice(0, cap);
  const tail = named.slice(cap);
  const tailContacts = tail.flatMap((g) => g.contacts);
  const other = groupNode(parent, 'company', { key: OTHER_COMPANIES_KEY, label: 'Other companies', contacts: tailContacts, last: true });
  other.hint = `${plural(tailContacts.length, 'person', 'people')} at ${plural(tail.length, 'smaller company', 'smaller companies')}`;
  other.children = companyNodes(tailContacts, other, tail);
  return [...companyNodes(contacts, parent, kept), other, ...companyNodes(contacts, parent, none)];
}

function childNodes(contacts, dims, parent) {
  const [dim, ...rest] = dims;
  if (!dim || dim === 'company') return companyLayer(contacts, parent, parent.id === ROOT_ID ? MAX_COMPANY_HUBS : MAX_INNER_COMPANIES);
  const buckets = bucketsFor(contacts, dim);
  // A layer that would not split anything is skipped, the first one too: a
  // fundraising list does not open as one "Investors" bubble.
  if (buckets.length <= 1) return childNodes(contacts, rest, parent);
  return buckets.map((b) => bucketNode(parent, dim, b, rest));
}

function bucketNode(parent, dim, b, rest) {
  const node = groupNode(parent, dim, b);
  // "Other roles", "Industry not known": the grouping's own line says what
  // is in it. A tag group's line is rewritten once its full count is known.
  node.hint = b.last && b.hint ? `${plural(b.contacts.length, 'person', 'people')} · ${b.hint}` : hintFor(b.contacts);
  // A group that folds several ("Other roles" holds the smaller families)
  // opens onto them, each then split as a group of its own would be.
  if (b.buckets && b.buckets.length > 1) {
    node.children = b.buckets.map((inner) => bucketNode(node, dim, inner, rest));
  } else {
    node.children = childNodes(b.contacts, rest, node);
  }
  return node;
}

/** Pack `node`'s children around (0, 0) and size `node` to enclose them. Coordinates stay relative to the parent. */
function layout(node) {
  node.dot = dotFor(node);
  if (node.type === 'person') { node.r = PERSON_R; return; }
  node.children.forEach((c) => layout(c));
  const gap = node.type === 'company' ? GAP.person
    : node.id === ROOT_ID ? GAP.top
    : node.children[0]?.type === 'company' ? GAP.company : GAP.group;

  if (node.type === 'company') {
    // A burst: people spiral out from the company's core, each on its own ray.
    const core = node.dot + REACH.company + PERSON_R;
    node.children.forEach((person, i) => {
      const d = core + BURST * Math.sqrt(i + 0.5);
      // Each company starts its spiral at its own angle so no two bursts look alike.
      const a = i * GOLDEN + (node.count % 7) * 0.9;
      person.x = Math.cos(a) * d;
      person.y = Math.sin(a) * d;
    });
    node.r = core + BURST * Math.sqrt(node.children.length + 0.5) + PERSON_R + gap / 2;
    return;
  }

  // The node's own dot holds the middle; its children are packed around
  // it, largest first, so the big clusters sit closest to the cell body.
  const circles = [
    { r: node.dot + REACH[node.type] },
    ...[...node.children]
      .sort((p, q) => q.r - p.r || String(p.label || '').localeCompare(String(q.label || '')))
      .map((c) => ({ r: c.r + gap / 2, node: c })),
  ];
  packSiblings(circles);
  const [core, ...kids] = circles;
  let reach = core.r;
  for (const c of kids) {
    c.node.x = c.x - core.x;
    c.node.y = c.y - core.y;
    reach = Math.max(reach, Math.hypot(c.node.x, c.node.y) + c.r);
  }
  node.r = reach + gap / 2;
}

/**
 * Named groups first, largest first; then the "Other …" and "not known"
 * groups, "Other …" before "not known" / "No company listed".
 */
function orderChildren(node) {
  if ((node.type !== 'group' && node.type !== 'root') || !node.children.length) return;
  const rankOf = (n) => (!n.last ? 0 : n.key === OTHER_COMPANIES_KEY || /^other/i.test(n.label) ? 1 : 2);
  node.children = node.children
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rankOf(a.n) - rankOf(b.n) || (rankOf(a.n) === 0 ? b.n.count - a.n.count : 0) || a.i - b.i)
    .map(({ n }) => n);
  node.children.forEach(orderChildren);
}

/**
 * Build the atlas for `contacts` grouped by `groupBy` ('role' | 'industry' |
 * 'country' | 'tag' | 'company'; null shows the people by company, with no
 * group layer). Returns { root, nodes, byId, groupBy, compass: false, box,
 * companyIndex, tagIndex, groupIndex, peopleCount, companyCount }:
 *   companyIndex  company key -> the ids of every node for it (one company
 *                 can sit in several groups; a company selection lights all)
 *   tagIndex      tag -> the person ids of everyone who carries it
 *   groupIndex    group node id -> the person ids a click on it selects
 *                 (for a tag group: everyone with the tag)
 * Every node has { id, type, dim, key, label, count, placed, last, hint,
 * colorKey, depth, parent, children, x, y, r, color } with x/y/r in one
 * shared world space.
 */
export function buildAtlas(contacts, { groupBy = 'role' } = {}) {
  const list = contacts || [];
  const dims = groupBy == null ? LAYERS.company : (LAYERS[groupBy] || LAYERS.role);
  const root = {
    id: ROOT_ID, type: 'root', dim: null, key: null, label: 'All', count: list.length, placed: list.length, last: false, hint: '', colorKey: null,
    contacts: list, parent: null, depth: 0, x: 0, y: 0,
  };
  root.children = list.length ? childNodes(list, dims, root) : [];

  // Everyone who carries each tag, in the order of the file.
  // Everyone who carries each tag, in the order of the file, each person once.
  const tagIndex = new Map();
  const tagPeople = new Map();
  const tagSeen = new Map();
  for (const c of list) {
    const tags = tagsOf(c);
    if (!tags.length) continue;
    const id = personNodeId(c);
    for (const t of tags) {
      let seen = tagSeen.get(t);
      if (!seen) { seen = new Set(); tagSeen.set(t, seen); tagIndex.set(t, []); tagPeople.set(t, []); }
      if (seen.has(id)) continue;
      seen.add(id);
      tagIndex.get(t).push(id);
      tagPeople.get(t).push(c);
    }
  }
  // A tag group counts everyone with the tag (ROUND2 R3): the number on its
  // label is the number on the tag's shortcut, and a click selects them all.
  // "Other tags" counts everyone with one of the tags it holds.
  const groupIndex = new Map();
  const tagGroup = (node) => {
    if (node.dim !== 'tag' || node.type !== 'group' || node.key === NO_TAG) return;
    const tags = node.key === OTHER_TAGS ? node.children.filter((k) => k.dim === 'tag').map((k) => k.key) : [node.key];
    const ids = new Set();
    const people = [];
    for (const t of tags) {
      const carriers = tagPeople.get(t) || [];
      (tagIndex.get(t) || []).forEach((id, i) => { if (!ids.has(id)) { ids.add(id); people.push(carriers[i]); } });
    }
    if (!ids.size) return;
    node.count = ids.size;
    groupIndex.set(node.id, [...ids]);
    const elsewhere = node.count - node.placed;
    node.hint = hintFor(people, elsewhere > 0 ? [`${fmt(elsewhere)} of them sit under another tag on the map`] : []);
    if (node.key === OTHER_TAGS) node.hint = `${node.hint} · smaller tags`;
  };
  const visitTags = (node) => { tagGroup(node); if (node.type === 'group') node.children.forEach(visitTags); };
  root.children.forEach(visitTags);

  orderChildren(root);
  layout(root);
  root.x = 0; root.y = 0;

  const nodes = [];
  const byId = new Map();
  const companies = new Set();
  const companyIndex = new Map();
  const walk = (node, color) => {
    nodes.push(node);
    byId.set(node.id, node);
    if (node.type === 'company') {
      if (node.key !== NO_COMPANY_KEY) companies.add(node.key);
      if (!companyIndex.has(node.key)) companyIndex.set(node.key, []);
      companyIndex.get(node.key).push(node.id);
    }
    if (node.type === 'group' && !groupIndex.has(node.id)) groupIndex.set(node.id, node.contacts.map(personNodeId));
    const shadeOrder = node.id !== ROOT_ID
      ? node.children.filter((k) => k.type === 'group' && !k.family).sort((p, q) => q.count - p.count || String(p.label).localeCompare(String(q.label)))
      : [];
    node.children.forEach((child, i) => {
      child.x += node.x;
      child.y += node.y;
      let c = color;
      if (child.type === 'group' && child.family) {
        // A role family has its own colour wherever it sits.
        c = FAMILY_COLORS[child.family] || NEUTRAL_COLOR;
      } else if (node.id === ROOT_ID) {
        // The outermost layer sets the hue: a company by its name, a group by
        // its place in the list; "Other …" and "not known" are neutral.
        c = child.last ? NEUTRAL_COLOR : child.type === 'company' ? clusterColor(child.key) : CLUSTER_COLORS[i % CLUSTER_COLORS.length];
      } else if (child.type === 'group') {
        // Each sub-group gets its own shade of the parent's hue (largest darkest).
        const rank = shadeOrder.indexOf(child);
        c = shade(color, shadeOrder.length > 1 ? -0.32 + (0.8 * rank) / (shadeOrder.length - 1) : 0);
      }
      // Companies inside "Other companies" keep their own colours.
      if (node.key === OTHER_COMPANIES_KEY && child.type === 'company') c = clusterColor(child.key);
      child.color = c;
      walk(child, c);
    });
  };
  walk(root, NEUTRAL_COLOR);

  // Bounding box of each cluster (its own dot and its children's circles):
  // what the camera frames when it flies to that node.
  for (const node of nodes) {
    if (node.type === 'person') continue;
    const pad = node.dot + 6;
    let x0 = node.x - pad; let x1 = node.x + pad; let y0 = node.y - pad; let y1 = node.y + pad;
    for (const c of node.children) {
      x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r); y0 = Math.min(y0, c.y - c.r); y1 = Math.max(y1, c.y + c.r);
    }
    node.box = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2 };
  }
  const { box } = root;

  return {
    root, nodes, byId, groupBy, compass: false, box, companyIndex, tagIndex, groupIndex, peopleCount: list.length, companyCount: companies.size,
  };
}

/** The chain of nodes from the root down to `node` (inclusive). */
export function pathTo(node) {
  const out = [];
  for (let n = node; n; n = n.parent) out.unshift(n);
  return out;
}
