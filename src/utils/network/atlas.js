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
 */
import { packSiblings } from 'd3-hierarchy';
import { normalizeCompanyKey, dedupeKey } from './parseContacts';
import { bucketsFor, OTHER_INDUSTRY, UNKNOWN_COUNTRY } from './grouping';

export const NO_COMPANY_KEY = '__none__';
export const ROOT_ID = 'root';
export const personNodeId = (contact) => `p:${dedupeKey(contact)}`;

/** Layers of the map for each starting grouping, outermost first. */
export const LAYERS = {
  role: ['role', 'industry', 'company'],
  industry: ['industry', 'role', 'company'],
  country: ['country', 'industry', 'company'],
  company: ['company'],
};

/** Role groups keep one colour everywhere on the site. */
export const GROUP_COLORS = { investors: '#3D6A96', founders: '#2E8B6E', operators: '#2A8C9E', experts: '#B8742A', other: '#7C8A9E' };
export const NEUTRAL_COLOR = '#7C8A9E';
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
/** Drawn radius of a node's own dot, in world units. */
const dotFor = (node) => (node.type === 'company' ? Math.min(3 + Math.sqrt(node.count) * 1.15, 15) : node.type === 'group' ? Math.min(9 + Math.sqrt(node.count) * 0.55, 22) : node.type === 'root' ? 10 : PERSON_R);
/** Clear space between a node's dot and the first ring of its children: the visible length of its links. */
const REACH = { company: 5, group: 34, root: 60 };
/** Role groups sit round a ring in the flat plan: investors at the top, then clockwise. */
const COMPASS = { investors: [0, -1], founders: [0.95, -0.31], operators: [0.59, 0.81], other: [-0.59, 0.81], experts: [-0.95, -0.31] };

/** 0 = runs the place, 1 = leads a function, 2 = everyone else; read from the title. */
export function seniority(contact) {
  const t = String(contact?.position || '').toLowerCase();
  if (/\b(founder|co-?founder|ceo|chief|president|owner|chair|chairman|chairwoman|managing (director|partner)|general partner|partner|principal)\b/.test(t) && !/\b(assistant|associate) to\b/.test(t)) return 0;
  if (/\b(vp|vice president|svp|evp|head|director|lead|gm|general manager)\b/.test(t)) return 1;
  return 2;
}

/** Spacing of the people in a company's burst (a sunflower spiral). */
const BURST = 6.4;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Group contacts by normalised company. Returns [{ key, label, contacts }] largest first. */
export function groupByCompany(contacts) {
  const groups = new Map();
  for (const c of contacts || []) {
    const key = normalizeCompanyKey(c.company) || NO_COMPANY_KEY;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: key === NO_COMPANY_KEY ? 'No company listed' : c.company, contacts: [], labels: new Map() };
      groups.set(key, g);
    }
    g.contacts.push(c);
    if (key !== NO_COMPANY_KEY) g.labels.set(c.company, (g.labels.get(c.company) || 0) + 1);
  }
  const list = [...groups.values()].map((g) => {
    // Display the most common spelling ("Stripe" over "Stripe, Inc.")
    let label = g.label;
    let best = 0;
    for (const [name, n] of g.labels) if (n > best) { best = n; label = name; }
    return { key: g.key, label, contacts: g.contacts };
  });
  list.sort((a, b) => b.contacts.length - a.contacts.length || a.label.localeCompare(b.label));
  return list;
}

function companyNodes(contacts, parent) {
  return groupByCompany(contacts).map((g) => {
    const node = {
      id: `${parent.id === ROOT_ID ? 'g' : parent.id}/c:${g.key}`, type: 'company', key: g.key, label: g.label,
      count: g.contacts.length, contacts: g.contacts, parent, depth: parent.depth + 1,
    };
    // Most senior first: they sit closest to the company's core in its burst.
    node.children = g.contacts
      .map((c) => ({ id: personNodeId(c), type: 'person', label: c.name, contact: c, rank: seniority(c), count: 1, parent: node, depth: node.depth + 1, children: [] }))
      .sort((a, b) => a.rank - b.rank || String(a.label || '').localeCompare(String(b.label || '')));
    return node;
  });
}

function childNodes(contacts, dims, parent) {
  const [dim, ...rest] = dims;
  if (!dim || dim === 'company') return companyNodes(contacts, parent);
  const buckets = bucketsFor(contacts, dim);
  // A layer that would not split anything is skipped (never the first one).
  if (buckets.length <= 1 && parent.id !== ROOT_ID) return childNodes(contacts, rest, parent);
  return buckets.map((b) => {
    const node = {
      id: `${parent.id === ROOT_ID ? 'g' : parent.id}/${dim}:${b.key}`, type: 'group', dim, key: b.key, label: b.label,
      hint: b.hint, lens: b.lens, count: b.contacts.length, contacts: b.contacts, parent, depth: parent.depth + 1,
    };
    node.children = childNodes(b.contacts, rest, node);
    return node;
  });
}

/** Pack `node`'s children around (0, 0) and size `node` to enclose them. Coordinates stay relative to the parent. */
function layout(node, compass) {
  node.dot = dotFor(node);
  if (node.type === 'person') { node.r = PERSON_R; return; }
  node.children.forEach((c) => layout(c, false));
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

  if (compass) {
    // Each group at distance t + r along its direction; t is the smallest
    // value that keeps every pair `gap` apart.
    const kids = node.children.filter((c) => COMPASS[c.key]);
    const clear = (t) => kids.every((a, i) => kids.slice(i + 1).every((b) => {
      const [ax, ay] = COMPASS[a.key]; const [bx, by] = COMPASS[b.key];
      const dx = ax * (t + a.r) - bx * (t + b.r); const dy = ay * (t + a.r) - by * (t + b.r);
      return Math.hypot(dx, dy) >= a.r + b.r + gap;
    }));
    let lo = REACH.root + node.dot; let hi = lo;
    while (!clear(hi)) hi *= 2;
    for (let i = 0; i < 30 && hi - lo > 0.5; i += 1) { const mid = (lo + hi) / 2; if (clear(mid)) hi = mid; else lo = mid; }
    let reach = 0;
    for (const k of kids) {
      k.x = COMPASS[k.key][0] * (hi + k.r);
      k.y = COMPASS[k.key][1] * (hi + k.r);
      reach = Math.max(reach, hi + 2 * k.r);
    }
    node.r = reach + gap / 2;
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
 * Build the atlas for `contacts` grouped by `groupBy` ('role' | 'industry' |
 * 'country' | 'company'). Returns { root, nodes, byId, groupBy, compass,
 * peopleCount, companyCount }. Every node has { id, type, label, count, depth,
 * parent, children, x, y, r, color } with x/y/r in one shared world space.
 */
export function buildAtlas(contacts, { groupBy = 'role' } = {}) {
  const list = contacts || [];
  const dims = LAYERS[groupBy] || LAYERS.role;
  const root = { id: ROOT_ID, type: 'root', label: 'All', count: list.length, contacts: list, parent: null, depth: 0, x: 0, y: 0 };
  root.children = list.length ? childNodes(list, dims, root) : [];
  const compass = dims[0] === 'role' && root.children.length > 1 && root.children.every((c) => COMPASS[c.key]);
  layout(root, compass);
  root.x = 0; root.y = 0;

  const nodes = [];
  const byId = new Map();
  const companies = new Set();
  const walk = (node, color) => {
    nodes.push(node);
    byId.set(node.id, node);
    if (node.type === 'company') companies.add(node.key);
    node.children.forEach((child, i) => {
      child.x += node.x;
      child.y += node.y;
      // The outermost layer sets the hue. Each sub-group inside it gets its
      // own shade of that hue (largest darkest), and everything below a
      // sub-group inherits its shade.
      let c = color;
      if (node.id !== ROOT_ID && child.type === 'group') {
        const order = [...node.children].sort((p, q) => q.count - p.count || String(p.label).localeCompare(String(q.label)));
        const rank = order.indexOf(child);
        c = shade(color, order.length > 1 ? -0.32 + (0.8 * rank) / (order.length - 1) : 0);
      }
      if (node.id === ROOT_ID) {
        c = child.type === 'company' ? clusterColor(child.key)
          : GROUP_COLORS[child.key] || (child.key === OTHER_INDUSTRY || child.key === UNKNOWN_COUNTRY ? NEUTRAL_COLOR : CLUSTER_COLORS[i % CLUSTER_COLORS.length]);
      }
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

  return { root, nodes, byId, groupBy, compass, box, peopleCount: list.length, companyCount: companies.size };
}

/** The chain of nodes from the root down to `node` (inclusive). */
export function pathTo(node) {
  const out = [];
  for (let n = node; n; n = n.parent) out.unshift(n);
  return out;
}
