/**
 * The Network Map canvas: your network on a globe you can spin.
 *
 * The layout comes from utils/network/atlas.js (a fixed, flat plan of
 * clusters). Here that plan is wrapped into a globe with layers: "you" are
 * the core, groups sit on an inner shell, sub-groups on the middle shell,
 * companies on the outer shell and people on the surface. Branches burst
 * outward through the layers. The camera only turns the globe and moves
 * closer; nothing in it ever moves.
 *
 *   far      the whole globe: groups, sub-groups and arcs between them
 *   closer   companies appear as named dots on branches
 *   close    a company opens: one dot per person
 *   closest  people show initials, then names, then titles
 *
 * Drag to spin (it keeps turning when you let go), scroll or pinch to dive
 * in, click anything to turn it towards you and fly down to it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HiOutlineArrowsPointingOut, HiOutlineMinus, HiOutlinePlus } from 'react-icons/hi2';
import { PERSON_R, ROOT_ID, shade } from '../../utils/network/atlas';

/** Stands for "the theme's text colour" wherever a label is not tinted by a node. */
const INK = 'ink';
const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';
/** Space kept clear at the top (sticky group labels) when framing a cluster. */
const INSET_TOP = 34;
/** Flying to a company never goes closer than this person radius, in pixels. */
const MAX_FIT_PERSON_PX = 13;
const MAX_PERSON_PX = 34;
/** Camera distance in globe radii: sets how strong the perspective is. */
const CAM = 3;
/** Magnification of the point facing the viewer, and of the globe's outline. */
const FRONT = CAM / (CAM - 1);
const OUTLINE = CAM / Math.sqrt(CAM * CAM - 1);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Share of the globe's surface the clusters may cover; the rest is breathing room between them. */
const COVER = 0.62;
/** The globe's layers, as a fraction of its radius: you are the core, people are the surface. */
const SHELL = { root: 0, group: 0.5, subgroup: 0.7, company: 0.86, person: 1 };
const shellOf = (node) => (node.type === 'group' ? (node.depth === 1 ? SHELL.group : SHELL.subgroup) : SHELL[node.type]);
const MAX_PITCH = 1.5;
/** The swing-in, kept only for the very first globe of a page load. */
const OPENING_MS = 2600;
/** Any other change of data (an upload, a filter, a new arrangement) settles this fast. */
const SETTLE_MS = 600;
/** Turning to a selection. */
const TURN_MS = 650;
/** One pulse of the lit dots after a selection, so a press is always seen. */
const PULSE_MS = 1100;
/** Lit people spread over more than this share of the globe's surface: show the whole globe. */
const WIDE_SHARE = 1 / 3;
/** Smallest angular gap (radians) kept between two top-level clusters. */
const MIN_GAP = 0.015;
// The swing-in happens at most once per page load, so coming back to the tab
// or a remount after an upload does not replay it.
let swungThisLoad = false;

function withAlpha(hex, alpha) {
  const n = parseInt(String(hex || THEMES.light.neutral).slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const liteCache = new Map();
/** A colour lifted towards white so it reads on a dark canvas. */
function lift(hex) {
  let out = liteCache.get(hex);
  if (!out) {
    const n = parseInt(String(hex || THEMES.light.neutral).slice(1), 16);
    const mix = (c) => Math.round(c + (255 - c) * 0.36).toString(16).padStart(2, '0');
    out = `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
    liteCache.set(hex, out);
  }
  return out;
}
/** 0 = a company is a single dot; 1 = it is open and shows one dot per person. */
const openness = (k) => clamp((PERSON_R * k - 2.5) / 1.5, 0, 1);
/**
 * Light is the default. Dark is complete and used when the page passes
 * theme="dark" (for the site-wide night mode). Everything the canvas
 * paints takes its colours from here.
 */
export const THEMES = {
  light: {
    bg: '#F8FAFC', backdrop: 'radial-gradient(ellipse at 50% 42%, #FFFFFF 0%, #F6F8FB 55%, #EEF2F7 100%)',
    ink: '#0F172A', muted: '#64748B', grid: '71,85,105', gridStrength: 1,
    tone: (hex) => hex || '#7C8A9E', neutral: '#7C8A9E', spark: null, senior: '#0F172A', onNode: '#FFFFFF',
    pill: '#FFFFFF', halo: 'rgba(255,255,255,0.95)', me: '15,23,42',
    // Solid panel behind a label, tinted with its layer's colour.
    panel: (hex) => shade(hex, 0.86), panelEdge: 0.55,
    air: '61,106,150', airStrength: 0.1, body: ['rgba(255,255,255,0.5)', 'rgba(226,232,240,0.16)', 'rgba(148,163,184,0.1)'], stars: false,
    glow: 0.7,
    // A lit (selected) person, and the one clicked.
    lit: '#F59E0B', selected: '#FB7185', starInk: '203,213,225',
    // Where a contact came from; the page uses these for its source chips.
    sources: { linkedin: '#0077B5', x: '#0F172A', csv: '#64748B', attio: '#B8742A' },
  },
  dark: {
    bg: '#0B1220', backdrop: 'radial-gradient(ellipse at 50% 42%, #18253F 0%, #0F192D 45%, #0B1220 100%)',
    ink: '#F1F5F9', muted: '#94A3B8', grid: '148,163,184', gridStrength: 1,
    tone: lift, spark: '#FFFFFF', senior: '#FFFFFF', onNode: '#0B1220',
    pill: '#0F1A2E', halo: 'rgba(11,18,32,0.92)', me: '255,255,255',
    panel: (hex) => shade(hex, -0.74), panelEdge: 0.7,
    air: '96,140,200', airStrength: 0.16, body: ['rgba(46,70,112,0.22)', 'rgba(20,32,56,0.12)', 'rgba(11,18,32,0.18)'], stars: true,
    glow: 1,
    lit: '#FBBF24', selected: '#FB7185', starInk: '203,213,225', neutral: '#7C8A9E',
    sources: { linkedin: '#0077B5', x: '#0F172A', csv: '#64748B', attio: '#B8742A' },
  },
};

/** Source colours for the page's chips (they mean the same thing in both themes). */
export const SOURCE_COLORS = THEMES.light.sources;

const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 2 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return s.length > 2 ? `${s}…` : '';
}

/** A person's name in the space available: "Olivia Tanaka", else "Olivia T.", else a cut first name. */
function shortName(ctx, name, maxWidth) {
  if (ctx.measureText(name).width <= maxWidth) return name;
  const parts = String(name).split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    const brief = `${parts[0]} ${parts[parts.length - 1][0]}.`;
    if (ctx.measureText(brief).width <= maxWidth) return brief;
  }
  return truncate(ctx, parts[0] || name, maxWidth);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}


/** Seeded points for the star field (the same sky every time). */
const STARS = (() => {
  let seed = 20261109;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: 170 }, () => {
    const z = rnd() * 2 - 1; const a = rnd() * Math.PI * 2; const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), r * Math.sin(a), z, 0.5 + rnd() * 0.9, 0.2 + rnd() * 0.5];
  });
})();

const apart = (p, q) => Math.acos(clamp(p[0] * q[0] + p[1] * q[1] + p[2] * q[2], -1, 1));

const spotCache = new Map();
/** Evenly spread candidate centres: straight at the viewer first, then a golden spiral. */
function spotsFor(count) {
  let spots = spotCache.get(count);
  if (!spots) {
    spots = [[0, 0, 1]];
    for (let i = 0; i < count; i += 1) {
      const y = 1 - (2 * (i + 0.5)) / count; const r = Math.sqrt(1 - y * y);
      spots.push([r * Math.cos(i * GOLDEN), y, r * Math.sin(i * GOLDEN)]);
    }
    spotCache.set(count, spots);
  }
  return spots;
}

/**
 * Greedy placement at a given scale: each cluster (largest first) goes to the
 * spot with the most room left. The room at a spot does not depend on the
 * size of the cluster being placed, so it is kept per spot and updated once
 * per placed cluster. No spot has more room than the best one, so a new
 * cluster can only change spots within (best room + its own reach): the rest
 * are ruled out with a dot product and cost no trigonometry.
 */
function greedy(radii, spots, kappa) {
  const room = new Float64Array(spots.length).fill(Infinity);
  const centres = [];
  let most = Infinity;
  for (let t = 0; t < radii.length; t += 1) {
    let best = 0;
    if (t) {
      // The largest cluster faces the viewer (spot 0); the rest go where there is most room.
      most = -Infinity;
      for (let i = 0; i < spots.length; i += 1) if (room[i] > most) { most = room[i]; best = i; }
    }
    const c = spots[best];
    centres.push(c);
    const reach = radii[t] * kappa;
    const near = most + reach >= Math.PI ? -2 : Math.cos(most + reach);
    for (let i = 0; i < spots.length; i += 1) {
      const p = spots[i];
      const dot = p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
      if (dot <= near) continue;
      const r = Math.acos(clamp(dot, -1, 1)) - reach;
      if (r < room[i]) room[i] = r;
    }
  }
  return centres;
}

/**
 * The largest scale (up to `cap`) at which no two placed clusters come closer
 * than MIN_GAP. Only pairs near enough to matter at `cap` are measured.
 */
function fittingScale(radii, centres, cap) {
  let k = cap;
  const r0 = radii[0];
  for (let i = 0; i < centres.length; i += 1) {
    const a = centres[i];
    const span = k * (radii[i] + r0) + MIN_GAP;
    const near = span >= Math.PI ? -2 : Math.cos(span);
    for (let j = i + 1; j < centres.length; j += 1) {
      const b = centres[j];
      const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      if (dot <= near) continue;
      k = Math.min(k, (Math.acos(clamp(dot, -1, 1)) - MIN_GAP) / Math.max(1e-9, radii[i] + radii[j]));
    }
  }
  return k;
}

/**
 * Where the top-level clusters sit on the unit globe. `radii` are their sizes
 * in map units, largest first. Returns { centres, kappa }: one unit vector per
 * cluster (the first faces the viewer) and the scale from map units to
 * radians, chosen so the patches cover no more than COVER of the globe and
 * none overlap. Two greedy passes and one pairwise check, so it stays fast
 * however many clusters there are (By company can have hundreds).
 */
export function placeClusters(radii) {
  if (!radii.length) return { centres: [], kappa: 1 };
  // Start with the largest cluster spanning a good part of a hemisphere, then
  // shrink everything until the patches cover no more than COVER of the globe.
  let kappa = 0.95 / (radii[0] || 1);
  const covered = (k) => radii.reduce((sum, r) => sum + (1 - Math.cos(Math.min(Math.PI, r * k))) / 2, 0);
  while (covered(kappa) > COVER) kappa *= 0.96;
  if (radii.length === 1) return { centres: [[0, 0, 1]], kappa };
  // Enough candidate spots that every cluster has several to choose from.
  const spots = spotsFor(Math.max(700, radii.length * 6));
  let centres = greedy(radii, spots, kappa);
  const fit = fittingScale(radii, centres, kappa);
  if (fit < kappa) {
    // Too crowded at this scale: shrink to what fits and place once more at
    // the new scale (the spacing then suits it), then make sure it still fits.
    kappa = Math.max(1e-6, fit * 0.98);
    centres = greedy(radii, spots, kappa);
    kappa = Math.max(1e-6, fittingScale(radii, centres, kappa));
  }
  return { centres, kappa };
}

/**
 * How spread out a set of points on the unit globe is. Returns the direction
 * of their middle (`dir`, null when they balance out all round), the angle
 * from it that holds nine in ten of them (one stray person does not decide
 * the view), and `share`: the part of the globe's surface inside that angle.
 */
export function spreadOf(points) {
  if (!points || !points.length) return { dir: null, angle: 0, share: 0 };
  let x = 0; let y = 0; let z = 0;
  for (const p of points) { x += p[0]; y += p[1]; z += p[2]; }
  const len = Math.hypot(x, y, z);
  if (len < 1e-6 * points.length) return { dir: null, angle: Math.PI, share: 1 };
  const dir = [x / len, y / len, z / len];
  const angles = points.map((p) => apart(p, dir)).sort((p, q) => p - q);
  const angle = angles[Math.max(0, Math.ceil(0.9 * angles.length) - 1)];
  return { dir, angle, share: (1 - Math.cos(angle)) / 2 };
}

/**
 * How strongly everything outside a selection is dimmed, as the opacity left
 * to it. No selection: nothing is dimmed (all 1). The larger the share of the
 * network that is lit, the further the rest steps back, so a big selection
 * still stands out from what is left.
 */
export function dimLevels(litCount, total) {
  if (!litCount) return { person: 1, company: 1, group: 1, ray: 1 };
  const share = clamp(litCount / Math.max(1, total || litCount), 0, 1);
  return {
    person: 0.14 - 0.08 * share,
    company: 0.2 - 0.1 * share,
    group: 0.28 - 0.12 * share,
    ray: 0.06 - 0.03 * share,
  };
}

/**
 * Wrap the atlas into a unit globe, all the way round. Every top-level
 * cluster gets its own patch of the sphere (largest first, each placed as
 * far from the others as possible), and everything inside it is laid on
 * the sphere around that point, so the far side of the globe is as full as
 * the near side. How deep a node sits is set by its level (see SHELL).
 * Returns the place of every node ([x, y, z, shrink, shell]) and the scale
 * that turns map units into radians.
 */
export function wrapOntoGlobe(atlas) {
  const tops = [...atlas.root.children].sort((p, q) => q.r - p.r);
  const { centres, kappa } = placeClusters(tops.map((t) => t.r));
  const centre = new Map(tops.map((t, i) => [t, centres[i]]));

  const place = new Map();
  place.set(atlas.root, [0, 0, 1, 1, 0]);
  for (const top of tops) {
    const c = centre.get(top) || [0, 0, 1];
    // Two directions along the surface at the cluster's centre.
    let e1 = [c[2], 0, -c[0]];
    const n1 = Math.hypot(e1[0], e1[2]);
    e1 = n1 < 1e-6 ? [1, 0, 0] : [e1[0] / n1, 0, e1[2] / n1];
    const e2 = [c[1] * e1[2] - c[2] * e1[1], c[2] * e1[0] - c[0] * e1[2], c[0] * e1[1] - c[1] * e1[0]];
    const lay = (node) => {
      const dx = node.x - top.x; const dy = node.y - top.y;
      const away = Math.hypot(dx, dy) * kappa;
      const dir = Math.atan2(dy, dx);
      const ca = Math.cos(away); const sa = Math.sin(away); const cd = Math.cos(dir); const sd = Math.sin(dir);
      // Circles around the centre get shorter with distance; things shrink to match.
      const shrink = away > 1e-6 ? Math.sqrt(Math.abs(sa) / away) : 1;
      place.set(node, [
        c[0] * ca + (e1[0] * cd + e2[0] * sd) * sa, c[1] * ca + (e1[1] * cd + e2[1] * sd) * sa, c[2] * ca + (e1[2] * cd + e2[2] * sd) * sa,
        shrink, shellOf(node),
      ]);
      node.children.forEach(lay);
    };
    lay(top);
  }
  return { place, kappa };
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export default function NetworkGraph({
  atlas, width, height = 620, insetBottom = 0, theme = 'light', highlightIds, selectedId, focus, viewId, onNodeClick, onViewNode, onBackgroundClick, children,
  intro = true,
}) {
  const canvasRef = useRef(null);
  const tipRef = useRef(null);
  // The camera: how far the globe is turned, and its radius in pixels.
  const cam = useRef({ yaw: 0, pitch: 0, s: 200 });
  const anim = useRef(null);
  const spin = useRef(null);
  const frame = useRef(0);
  const lastFrame = useRef(0);
  const hover = useRef(null);
  const inside = useRef(false);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const settled = useRef(null);
  const lastAtlas = useRef(null);
  const lastSize = useRef('');
  const opened = useRef(false);
  // When the lit dots last started their one pulse (0: no pulse).
  const pulse = useRef(0);
  const [hoverNode, setHoverNode] = useState(null);
  const [grabbing, setGrabbing] = useState(false);

  const globe = useMemo(() => (atlas ? wrapOntoGlobe(atlas) : null), [atlas]);
  // Latest props for the draw loop, which lives outside React's render.
  const live = useRef({});
  live.current = { atlas, globe, width, height, insetBottom, theme, highlightIds, selectedId, onNodeClick, onViewNode, onBackgroundClick };

  // Containers that hold a highlighted person, so they stay bright too.
  const litContainers = useMemo(() => {
    const set = new Set();
    if (!atlas || !highlightIds || !highlightIds.size) return set;
    highlightIds.forEach((id) => {
      for (let n = atlas.byId.get(id); n; n = n.parent) set.add(n.id);
    });
    return set;
  }, [atlas, highlightIds]);
  live.current.litContainers = litContainers;

  // How many of the lit people are on this globe (the corner count), and how
  // strongly everyone else steps back.
  const litCount = useMemo(() => {
    if (!atlas || !highlightIds || !highlightIds.size) return 0;
    let n = 0;
    highlightIds.forEach((id) => { if (atlas.byId.has(id)) n += 1; });
    return n;
  }, [atlas, highlightIds]);
  live.current.dims = dimLevels(litCount, atlas?.peopleCount);

  // The branch from "you" down to the selected node, which carries a pulse.
  const trail = useMemo(() => {
    const set = new Set();
    for (let n = atlas?.byId.get(selectedId); n; n = n.parent) set.add(n.id);
    return set;
  }, [atlas, selectedId]);
  live.current.trail = trail;

  // What is in focus: the cluster you are in, everything inside it and the
  // way back to you. Everything else steps back so one thing reads at a time.
  const inFocus = useMemo(() => {
    const view = atlas?.byId.get(viewId);
    if (!view || view.id === ROOT_ID) return null;
    const set = new Set();
    for (let n = view; n; n = n.parent) set.add(n.id);
    const down = (n) => { if (n.type !== 'person') { set.add(n.id); n.children.forEach(down); } };
    down(view);
    return set;
  }, [atlas, viewId]);
  live.current.inFocus = inFocus;

  // ---------------------------------------------------------------- camera

  /** The part of the canvas the globe is centred in, and the radius that shows all of it. */
  const stage = () => {
    const { width: w, height: h, insetBottom: b } = live.current;
    const hh = h - INSET_TOP - b;
    return { w, h, hh, cx: w / 2, cy: INSET_TOP + hh / 2, home: (0.46 * Math.min(w - 40, hh)) / OUTLINE };
  };
  const maxS = () => MAX_PERSON_PX / (PERSON_R * FRONT * (live.current.globe?.kappa || 1));

  /** A function that puts a point of the unit globe on the canvas: [x, y, depth, magnification]. */
  const projector = (c) => {
    const { cx, cy } = stage();
    const cyw = Math.cos(c.yaw); const syw = Math.sin(c.yaw); const cp = Math.cos(c.pitch); const sp = Math.sin(c.pitch);
    return (ux, uy, uz, alt = 1) => {
      const x1 = (ux * cyw + uz * syw) * alt; const z1 = (-ux * syw + uz * cyw) * alt; const y1 = uy * alt;
      const y2 = y1 * cp - z1 * sp; const z2 = y1 * sp + z1 * cp;
      const mag = CAM / (CAM - z2);
      return [cx + c.s * x1 * mag, cy + c.s * y2 * mag, z2, mag];
    };
  };

  /** Where a node is on the canvas right now: centre, depth, pixels per map unit, and its cluster's radius. */
  const seen = (node, pr, c) => {
    const g = live.current.globe;
    const u = g.place.get(node);
    // Its cluster is measured where it meets the surface; the node itself sits on its own layer.
    const [sx, sy, z, mag] = pr(u[0], u[1], u[2]);
    // Things turn edge-on at the rim and face you again on the far side.
    const m = c.s * mag * g.kappa * u[3] * (0.42 + 0.58 * Math.abs(z));
    if (u[4] === 1) return { sx, sy, z, m, sr: node.r * m, hx: sx, hy: sy, hz: z };
    const [hx, hy, hz] = pr(u[0], u[1], u[2], u[4]);
    return { sx, sy, z, m, sr: node.r * m, hx, hy, hz };
  };

  /** The camera that turns a direction of the globe to face the viewer, at radius `s`. */
  const facing = (u, radius) => ({ yaw: Math.atan2(-u[0], u[2]), pitch: clamp(Math.atan2(u[1], Math.hypot(u[0], u[2])), -MAX_PITCH, MAX_PITCH), s: radius });
  /** The camera that turns a cluster to face the viewer and fills the stage with it. */
  const cameraFor = useCallback((node, capPersonPx = MAX_FIT_PERSON_PX) => {
    const g = live.current.globe;
    const st = stage();
    const u = g.place.get(node);
    const fit = Math.min(Math.min(st.w - 56, st.hh - 28) / (2 * node.r * 0.94), capPersonPx / PERSON_R);
    // Always come in far enough to open the layer inside what you flew to.
    const least = node.type === 'group' && node.depth === 1 ? 1.75 : 2.4;
    return facing(u, Math.max(st.home * least, fit / (FRONT * g.kappa * u[3])));
  }, []);
  // Home: the whole globe, tipped a little so its layers can be seen through it.
  const homeCamera = () => ({ yaw: 0.3, pitch: 0.22, s: stage().home });

  /** The deepest cluster the viewer is "inside": it sits under the middle of the stage and fills most of it. */
  const reportView = useCallback(() => {
    const { atlas: a, onViewNode: cb } = live.current;
    if (!a || !cb) return;
    const st = stage();
    const c = cam.current;
    const pr = projector(c);
    const need = 0.62 * Math.min(st.w, st.hh);
    let node = a.root;
    for (;;) {
      const next = node.children.find((child) => {
        if (child.type === 'person') return false;
        const q = seen(child, pr, c);
        return q.z > 0 && Math.hypot(q.sx - st.cx, q.sy - st.cy) <= q.sr && 2 * q.sr >= need;
      });
      if (!next) break;
      node = next;
    }
    cb(node.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settleSoon = useCallback(() => {
    clearTimeout(settled.current);
    settled.current = setTimeout(reportView, 160);
  }, [reportView]);

  // ---------------------------------------------------------------- draw

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    const { atlas: a, globe: g, width: w, height: h, highlightIds: lit, selectedId: sel, litContainers: litC } = live.current;
    if (!canvas || !a || !g || !w) return;
    const T = THEMES[live.current.theme] || THEMES.light;
    const BG = T.bg; const MUTED = T.muted; const GRID = T.grid; const lite = T.tone;
    const HIGHLIGHT = T.lit; const SELECTED = T.selected;
    const D = live.current.dims || dimLevels(0, 0);
    const paintOf = (color) => (color === INK ? T.ink : lite(color));
    const now = performance.now();
    const dt = Math.min(64, now - (lastFrame.current || now));
    lastFrame.current = now;
    const st = stage();
    let moving = false;

    if (anim.current) {
      const { from, to, start, ms } = anim.current;
      const t = clamp((now - start) / ms, 0, 1);
      const e = ease(t);
      cam.current = {
        yaw: from.yaw + (to.yaw - from.yaw) * e, pitch: from.pitch + (to.pitch - from.pitch) * e,
        s: Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * e),
      };
      if (t >= 1) {
        const { arrive } = anim.current;
        anim.current = null;
        if (arrive && live.current.onViewNode) live.current.onViewNode(arrive); else reportView();
      } else moving = true;
    } else if (spin.current && !gesture.current) {
      // Momentum: the globe keeps turning after you let go, and slows down.
      const sp = spin.current;
      cam.current = { ...cam.current, yaw: cam.current.yaw + sp.yaw * dt, pitch: clamp(cam.current.pitch + sp.pitch * dt, -MAX_PITCH, MAX_PITCH) };
      const drag = Math.exp(-dt / 380);
      sp.yaw *= drag; sp.pitch *= drag;
      if (Math.abs(sp.yaw) + Math.abs(sp.pitch) < 0.00002) { spin.current = null; settleSoon(); } else moving = true;
    }

    const c = cam.current;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pr = projector(c);
    const S = (node) => seen(node, pr, c);
    const { cx, cy } = st;
    const kFront = c.s * FRONT * g.kappa;
    const open = openness(kFront);
    const hasLit = Boolean(lit && lit.size);
    // Lit people already drawn as people (close up); the rest get a lit dot afterwards.
    const drawnLit = new Set();
    const pt = hasLit && pulse.current ? (now - pulse.current) / PULSE_MS : 1;
    const pulsing = pt < 1;
    const hot = hover.current;
    const labels = [];
    const tr = live.current.trail;

    // Stars: a far shell that turns with the globe, for depth.
    const shell = 0.75 * Math.max(w, h);
    for (const [x, y, z, size, glow] of T.stars ? STARS : []) {
      const x1 = x * Math.cos(c.yaw * 0.35) + z * Math.sin(c.yaw * 0.35); const z1 = -x * Math.sin(c.yaw * 0.35) + z * Math.cos(c.yaw * 0.35);
      const y2 = y * Math.cos(c.pitch * 0.35) - z1 * Math.sin(c.pitch * 0.35);
      if (y * Math.sin(c.pitch * 0.35) + z1 * Math.cos(c.pitch * 0.35) < 0) continue;
      ctx.beginPath(); ctx.arc(cx + x1 * shell, cy + y2 * shell, size, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(${T.starInk},${glow})`; ctx.fill();
    }

    // The globe itself: a soft atmosphere, a faintly lit body and its outline.
    // The globe itself is glass: a thin atmosphere, the faintest shading and
    // an outline, so every layer and the far side show through.
    const R = c.s * OUTLINE;
    if (R < 6 * Math.max(w, h)) {
      const air = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.2);
      air.addColorStop(0, `rgba(${T.air},0)`); air.addColorStop(0.42, `rgba(${T.air},${T.airStrength})`); air.addColorStop(1, `rgba(${T.air},0)`);
      ctx.fillStyle = air; ctx.beginPath(); ctx.arc(cx, cy, R * 1.2, 0, 2 * Math.PI); ctx.fill();
      const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
      body.addColorStop(0, T.body[0]); body.addColorStop(0.7, T.body[1]); body.addColorStop(1, T.body[2]);
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = `rgba(${GRID},0.4)`; ctx.stroke();
    }

    // Graticule: lines of latitude and longitude around the network's pole.
    // It gets finer as you dive in, so the surface always reads as a surface.
    {
      const cyw = Math.cos(c.yaw); const syw = Math.sin(c.yaw); const cpp = Math.cos(c.pitch); const spp = Math.sin(c.pitch);
      // The point of the globe facing the viewer, in globe coordinates.
      const fx = -cpp * syw; const fy = spp; const fz = cpp * cyw;
      const polar0 = Math.acos(clamp(fz, -1, 1)); const around0 = Math.atan2(fy, fx);
      const win = Math.min(Math.PI, (0.75 * Math.max(w, h)) / (c.s * FRONT) + 0.04);
      let step = Math.PI / 9;
      while (c.s * FRONT * step > 240 && step > 1e-4) step /= 2;
      const whole = win >= Math.PI / 2;
      const sinP = Math.max(0.15, Math.sin(polar0));
      let stepA = Math.PI / 9;
      while (c.s * FRONT * sinP * stepA > 240 && stepA > 1e-4) stepA /= 2;
      const aw = whole ? Math.PI : Math.min(Math.PI, win / sinP);
      const pLo = whole ? 0.0001 : Math.max(0.0001, polar0 - win); const pHi = whole ? Math.PI - 0.0001 : Math.min(Math.PI - 0.0001, polar0 + win);
      const stroke = (points) => {
        for (let pass = 0; pass < 2; pass += 1) {
          ctx.beginPath();
          let pen = false;
          for (const [x, y, z] of points) {
            if ((pass === 1) === (z >= 0)) { if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y); pen = true; } else pen = false;
          }
          ctx.strokeStyle = `rgba(${GRID},${pass === 1 ? 0.17 : 0.08})`;
          ctx.stroke();
        }
      };
      ctx.lineWidth = 0.8;
      for (let p = Math.ceil(pLo / step) * step; p <= pHi; p += step) {
        const pts = [];
        for (let i = 0; i <= 64; i += 1) { const av = around0 - aw + (2 * aw * i) / 64; pts.push(pr(Math.sin(p) * Math.cos(av), Math.sin(p) * Math.sin(av), Math.cos(p))); }
        stroke(pts);
      }
      for (let av = Math.ceil((around0 - aw) / stepA) * stepA; av < around0 + aw - 1e-9; av += stepA) {
        const pts = [];
        for (let i = 0; i <= 32; i += 1) { const p = pLo + ((pHi - pLo) * i) / 32; pts.push(pr(Math.sin(p) * Math.cos(av), Math.sin(p) * Math.sin(av), Math.cos(p))); }
        stroke(pts);
      }
    }

    // A branch between two cell bodies: an arc that lifts off the surface,
    // like a flight path. Branches on the way to the selected node pulse.
    const arc = (from, to, color, alpha, lw, pulse, steps = 18) => {
      const u1 = g.place.get(to);
      const u0 = from === a.root ? [u1[0], u1[1], u1[2], 1, 0] : g.place.get(from);
      const angle = Math.acos(clamp(u0[0] * u1[0] + u0[1] * u1[1] + u0[2] * u1[2], -1, 1));
      const lift = Math.min(0.12, angle * 0.25);
      let behind = 0;
      ctx.beginPath();
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const x = u0[0] + (u1[0] - u0[0]) * t; const y = u0[1] + (u1[1] - u0[1]) * t; const z = u0[2] + (u1[2] - u0[2]) * t;
        const n = Math.hypot(x, y, z) || 1;
        // Out through the layers, bowing a little on the way.
        const q = pr(x / n, y / n, z / n, (u0[4] + (u1[4] - u0[4]) * t) * (1 + lift * Math.sin(Math.PI * t)));
        if (q[2] < 0) behind += 1;
        if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
      }
      const fade = behind > steps / 2 ? 0.45 : 1;
      ctx.lineWidth = lw; ctx.strokeStyle = withAlpha(color, alpha * fade); ctx.stroke();
      if (pulse) {
        ctx.setLineDash([4, 10]); ctx.lineDashOffset = -now / 36;
        ctx.lineWidth = lw + 1.5; ctx.strokeStyle = withAlpha(color, 0.95); ctx.stroke();
        ctx.setLineDash([]);
      }
    };
    const twig = (x0, y0, x1, y1, color, alpha, lw, pulse) => {
      ctx.beginPath(); ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo((x0 + x1) / 2 - (y1 - y0) * 0.12, (y0 + y1) / 2 + (x1 - x0) * 0.12, x1, y1);
      ctx.lineWidth = lw; ctx.strokeStyle = withAlpha(color, alpha); ctx.stroke();
      if (pulse) {
        ctx.setLineDash([4, 10]); ctx.lineDashOffset = -now / 36;
        ctx.lineWidth = lw + 1.5; ctx.strokeStyle = withAlpha(color, 0.95); ctx.stroke();
        ctx.setLineDash([]);
      }
    };
    // One layer at a time: groups first, sub-groups as you move in, then companies.
    const zoom = c.s / st.home;
    const showSub = clamp((zoom - 1.2) / 0.4, 0, 1);
    const showCompanies = clamp((zoom - 1.75) / 0.45, 0, 1);
    const reveal = (level) => (level <= 1 ? 1 : level === 2 ? showSub : showCompanies);
    const focusSet = live.current.inFocus;
    const onScreen = (q) => !(q.sx + q.sr < -30 || q.sx - q.sr > w + 30 || q.sy + q.sr < -30 || q.sy - q.sr > h + 30);

    const paint = (node, q) => {
      if (!onScreen(q)) return;
      const { sx, sy, sr, m, hx, hy } = q;
      const dim = hasLit && !litC.has(node.id);
      const isHot = hot === node;
      const isSel = sel === node.id;
      const col = lite(node.color);
      // Things fade as they turn away, and nearly vanish on the far side.
      // Near side at full strength, far side clearly there but quieter; and
      // layers deeper than the one you are at stay ghosted until you come closer.
      const shown = reveal(node.type === 'person' ? node.parent.depth : node.depth);
      const aside = focusSet && !focusSet.has(node.type === 'person' ? node.parent.id : node.id);
      const depth = (q.hz >= 0 ? clamp(0.55 + q.hz * 2, 0.55, 1) : clamp(0.55 + q.hz * 0.15, 0.4, 0.55)) * (0.36 + 0.64 * shown) * (aside ? 0.22 : 1);
      const far = q.z < 0;

      if (node.type === 'group') {
        if (sr < 1.5) return;
        const collapsed = sr < 11;
        const R0 = collapsed ? Math.max(2, sr * 0.7) : clamp(node.dot * m, 4, 16);
        const kids = collapsed ? [] : node.children.map((child) => [child, S(child)]);
        ctx.globalAlpha = (dim ? D.group : 1) * depth;
        if (!collapsed) {
          // No outline around a cluster: a glow that fades out from its cell body.
          const glow = ctx.createRadialGradient(hx, hy, 0, sx, sy, sr);
          glow.addColorStop(0, withAlpha(col, isHot ? 0.2 : node.depth === 1 ? 0.08 : 0.1));
          glow.addColorStop(0.55, withAlpha(col, isHot ? 0.07 : 0.025));
          glow.addColorStop(1, withAlpha(col, 0));
          ctx.fillStyle = glow;
          ctx.beginPath(); ctx.arc(sx, sy, sr, 0, 2 * Math.PI); ctx.fill();
          if (isHot) { ctx.setLineDash([2, 6]); ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(col, 0.5); ctx.stroke(); ctx.setLineDash([]); }
          for (const [child, cq] of kids) {
            const faded = hasLit && !litC.has(child.id);
            if (child.type === 'group') arc(node, child, lite(child.color), (faded ? D.ray * 1.6 : 0.55) * (0.25 + 0.75 * reveal(child.depth)), 1.6, tr.has(child.id));
            else if (child.dot * cq.m > 0.7) arc(node, child, lite(child.color), (faded ? D.ray : Math.min(0.55, 0.2 + 0.03 * child.count)) * (0.25 + 0.75 * reveal(child.depth)), child.count >= 10 ? 1.2 : 0.8, tr.has(child.id), 8);
          }
          ctx.globalAlpha = 1;
          for (const [child, cq] of kids) paint(child, cq);
          ctx.globalAlpha = (dim ? D.group : 1) * depth;
        }
        // Cell body: a point of light with a halo, not a disc.
        const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, R0 * 2.4);
        halo.addColorStop(0, withAlpha(col, isHot ? 0.95 : 0.8)); halo.addColorStop(0.35, withAlpha(col, 0.35)); halo.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(hx, hy, R0 * 2.4, 0, 2 * Math.PI); ctx.fill();
        ctx.beginPath(); ctx.arc(hx, hy, R0 * (T.spark ? 0.5 : 0.62), 0, 2 * Math.PI);
        ctx.fillStyle = T.spark || col; ctx.fill();
        ctx.globalAlpha = 1;
        if (!collapsed && (sr >= 30 || isHot) && (node.depth === 1 || (!far && shown > 0.5 && !aside))) {
          // Sits on the top edge like a legend; sticks to the top of the canvas once you are inside the cluster.
          const stickY = 18 + (node.depth - 1) * 27;
          labels.push({
            kind: 'pill', style: node.depth === 1 ? 'banner' : 'tag', sticky: !far, text: node.label, count: node.count,
            x: clamp(sx, 110, Math.max(110, w - 110)), y: far ? sy - sr : Math.max(sy - sr, stickY),
            size: node.depth === 1 ? 12.5 : 11.5, weight: node.depth === 1 ? 700 : 600, color: node.color, dim: dim || far || aside,
            priority: (isHot ? 100 : 92) - node.depth * 4 - (far ? 6 : 0) + Math.min(3, node.count / 1000),
          });
        }
        return;
      }

      if (node.type === 'company') {
        const R0 = clamp(node.dot * m, 1.2, 11);
        if (R0 < 1.25 && sr < 2) return;
        // The burst: a ray from the core to every person. Drawn at every zoom,
        // so from far away a company reads as a spark sized by its headcount.
        const personPx = PERSON_R * m;
        const people = sr >= 3 ? node.children.map((child) => [child, S(child)]) : [];
        if (people.length) {
          ctx.beginPath();
          for (const [, pq] of people) { ctx.moveTo(hx, hy); ctx.lineTo(pq.sx, pq.sy); }
          ctx.lineWidth = personPx > 6 ? 1 : 0.7;
          ctx.strokeStyle = withAlpha(col, (dim ? D.ray : isHot || isSel ? 0.6 : hasLit ? 0.14 : 0.34) * depth); ctx.stroke();
          if (personPx >= 0.5 && !far && shown > 0.3) for (const [child, pq] of people) paint(child, pq);
        }
        ctx.globalAlpha = (dim ? D.company : 1) * depth;
        const core = ctx.createRadialGradient(hx, hy, 0, hx, hy, R0 * 2);
        core.addColorStop(0, withAlpha(col, 1)); core.addColorStop(0.45, withAlpha(col, isHot || isSel ? 0.7 : 0.4)); core.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = core; ctx.beginPath(); ctx.arc(hx, hy, R0 * 2, 0, 2 * Math.PI); ctx.fill();
        if (R0 > 2) { ctx.beginPath(); ctx.arc(hx, hy, Math.max(1, R0 * 0.38), 0, 2 * Math.PI); ctx.fillStyle = T.spark || col; ctx.fill(); }
        if ((isSel || (hasLit && !dim && open < 0.5)) && R0 > 1.5) {
          ctx.beginPath(); ctx.arc(hx, hy, R0 + 5, 0, 2 * Math.PI);
          ctx.lineWidth = 2; ctx.strokeStyle = isSel ? SELECTED : HIGHLIGHT; ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const named = node.key !== '__none__' || isHot || isSel;
        const text = node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label;
        if (!named || q.z < 0.2 || ((shown < 0.5 || aside) && !isHot && !isSel)) return;
        if (isHot || isSel || (open >= 0.5 && sr >= 46)) {
          labels.push({ kind: 'pill', style: 'plate', text, count: node.count, x: hx, y: hy - R0 - 14, size: 11, weight: 600, color: node.color, dim, priority: (isHot || isSel ? 99 : 60) + Math.min(9, node.count / 20) });
        } else if (R0 >= 2 && (sr >= 11 || node.count >= 8)) {
          labels.push({ kind: 'pill', style: 'plate', text, count: node.count > 1 ? node.count : null, x: hx, y: hy + R0 + 12, size: node.count >= 10 ? 11 : 10, weight: node.count >= 10 ? 600 : 500, color: node.color, dim, priority: 20 + Math.min(30, node.count) });
        }
        return;
      }

      // person
      if (far) return;
      const isLit = hasLit && lit.has(node.id);
      // Far away a person is the lit tip of a ray (senior people a little
      // brighter and bigger); only up close does it grow into an avatar.
      const grown = clamp((sr - 5) / 4, 0, 1);
      const tip = (node.rank === 0 ? 0.62 : node.rank === 1 ? 0.5 : 0.4) + (0.86 - 0.4) * grown;
      const pr0 = Math.max(0.6, sr * (isHot || isLit || isSel ? 1.05 : Math.min(0.86, tip)));
      if (isSel || isHot) { const pq = S(node.parent); twig(pq.hx, pq.hy, sx, sy, col, 0.8, 1.2, isSel); }
      if (isLit) drawnLit.add(node.id);
      ctx.globalAlpha = (hasLit && !isLit && !isSel ? D.person : 1) * depth * (node.rank === 0 || grown > 0 ? 1 : 0.85);
      ctx.beginPath(); ctx.arc(sx, sy, pr0, 0, 2 * Math.PI);
      if (node.contact?.relationship === 'firm') {
        // Firm-wide CRM contact (a colleague's): hollow dot.
        ctx.fillStyle = BG; ctx.fill();
        ctx.lineWidth = Math.max(0.8, pr0 * 0.28); ctx.strokeStyle = col; ctx.stroke();
      } else {
        ctx.fillStyle = grown < 1 && node.rank === 0 && !isHot ? T.senior : col;
        ctx.fill();
        if (grown < 1 && sr > 1.5) { ctx.beginPath(); ctx.arc(sx, sy, pr0 * 2.2, 0, 2 * Math.PI); ctx.fillStyle = withAlpha(col, 0.16 * (1 - grown)); ctx.fill(); }
      }
      if (isLit || isSel) {
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(sx, sy, pr0 + 3, 0, 2 * Math.PI);
        ctx.lineWidth = 2; ctx.strokeStyle = isSel ? SELECTED : HIGHLIGHT; ctx.stroke();
        if (isLit && pulsing) {
          ctx.beginPath(); ctx.arc(sx, sy, pr0 + 3 + 14 * ease(pt), 0, 2 * Math.PI);
          ctx.lineWidth = 1.6; ctx.strokeStyle = withAlpha(HIGHLIGHT, 0.85 * (1 - pt)); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      if (isHot || isSel) {
        labels.push({ kind: 'pill', text: node.label, x: sx, y: sy + pr0 + 13, size: 11, weight: 600, color: INK, priority: 100 });
      } else if (isLit && sr > 2) {
        labels.push({ kind: 'plain', text: node.label, x: sx, y: sy + pr0 + 9, size: 10.5, weight: 600, color: INK, priority: 70 });
      } else if (sr >= 19 && !(hasLit && !isLit)) {
        // Full names only once neighbouring dots are far enough apart to hold them.
        labels.push({ kind: 'plain', text: node.label, sub: sr >= 27 ? node.contact?.position : null, x: sx, y: sy + pr0 + 9, size: 10, weight: 500, color: INK, room: 9.8 * m - 4, priority: 10 });
      }
      // Initials inside the dot, like an avatar, as soon as they are legible.
      if (sr >= 8.5 && node.contact?.relationship !== 'firm') {
        labels.push({ kind: 'initials', text: initials(node.label), x: sx, y: sy, size: clamp(pr0 * 0.82, 7, 15), dim: hasLit && !isLit && !isSel });
      }
    };

    // Layers inside the globe: one faint shell for each level of the network.
    if (R < 2.5 * Math.max(w, h)) {
      ctx.lineWidth = 0.7;
      for (const [rho, strength] of [[SHELL.group, 0.16], [SHELL.subgroup, 0.12], [SHELL.company, 0.09]]) {
        ctx.strokeStyle = `rgba(${GRID},${strength})`;
        for (let ring = 0; ring < 3; ring += 1) {
          ctx.beginPath();
          for (let i = 0; i <= 60; i += 1) {
            const t = (i / 60) * Math.PI * 2;
            // Three great circles at right angles sketch each shell.
            const q = ring === 0 ? pr(Math.cos(t), 0, Math.sin(t), rho) : ring === 1 ? pr(0, Math.cos(t), Math.sin(t), rho) : pr(Math.cos(t), Math.sin(t), 0, rho);
            if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
          }
          ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(cx, cy, c.s * rho * (CAM / Math.sqrt(CAM * CAM - rho * rho)), 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(${GRID},${strength * 1.3})`; ctx.stroke();
      }
    }

    // "You" are the core of the globe, with a branch out to every top-level cluster.
    const me = S(a.root);
    const tops = a.root.children.map((child) => [child, S(child)]);
    for (const [child, cq] of tops) {
      const faded = hasLit && !litC.has(child.id);
      if (child.type === 'group') arc(a.root, child, lite(child.color), faded ? D.ray * 2 : 0.7, 2.2, tr.has(child.id), 6);
      else if (child.dot * cq.m > 0.7) arc(a.root, child, lite(child.color), faded ? D.ray : Math.min(0.5, 0.14 + 0.03 * child.count), child.count >= 10 ? 1.2 : 0.8, tr.has(child.id), 4);
    }
    // Far side first, so the near side is drawn over it.
    tops.sort((p, q) => p[1].hz - q[1].hz);
    for (const [child, cq] of tops) paint(child, cq);

    // Every lit person not already drawn up close gets a lit dot where they
    // sit, so a selection shows at any zoom, near side and far side. Just
    // after a selection the dots pulse once.
    if (hasLit) {
      lit.forEach((id) => {
        if (drawnLit.has(id)) return;
        const node = a.byId.get(id);
        const u = node && g.place.get(node);
        if (!u) return;
        const [x, y, z] = pr(u[0], u[1], u[2]);
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) return;
        const front = z >= 0;
        ctx.globalAlpha = front ? 1 : 0.35;
        ctx.beginPath(); ctx.arc(x, y, front ? 5 : 3.5, 0, 2 * Math.PI);
        ctx.fillStyle = withAlpha(HIGHLIGHT, 0.22); ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, front ? 2.4 : 1.8, 0, 2 * Math.PI);
        ctx.fillStyle = HIGHLIGHT; ctx.fill();
        if (pulsing && front) {
          ctx.beginPath(); ctx.arc(x, y, 3 + 14 * ease(pt), 0, 2 * Math.PI);
          ctx.lineWidth = 1.6; ctx.strokeStyle = withAlpha(HIGHLIGHT, 0.85 * (1 - pt)); ctx.stroke();
        }
      });
      ctx.globalAlpha = 1;
    }

    const mr = clamp(a.root.dot * me.m, 6, 13);
    // Dive into a cluster and the core is straight behind it: let it fade so it does not sit on top.
    const coreAlpha = clamp(2.2 - c.s / st.home, 0, 1);
    ctx.globalAlpha = coreAlpha;
    const sun = ctx.createRadialGradient(me.hx, me.hy, 0, me.hx, me.hy, mr * 3.2);
    sun.addColorStop(0, `rgba(${T.me},0.95)`); sun.addColorStop(0.3, `rgba(${T.me},0.28)`); sun.addColorStop(1, `rgba(${T.me},0)`);
    ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(me.hx, me.hy, mr * 3.2, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.arc(me.hx, me.hy, mr * 0.6, 0, 2 * Math.PI); ctx.fillStyle = `rgb(${T.me})`; ctx.fill();
    ctx.globalAlpha = 1;
    if (coreAlpha > 0.6) labels.push({ kind: 'plain', text: 'You', x: me.hx, y: me.hy + mr + 12, size: 12, weight: 700, color: INK, priority: 95 });

    // Labels last, flat on the glass, most important first; a label that would cover another is skipped.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const taken = [];
    let plates = 0;
    const free = (x0, y0, x1, y1) => !taken.some((t) => x0 < t[2] && x1 > t[0] && y0 < t[3] && y1 > t[1]);
    labels.sort((p, q) => (q.priority || 0) - (p.priority || 0));
    for (const l of labels) {
      ctx.font = `${l.weight || 600} ${l.size}px ${FONT}`;
      if (l.kind === 'initials') {
        ctx.globalAlpha = l.dim ? 0.3 : 1;
        ctx.font = `600 ${l.size}px ${FONT}`;
        ctx.fillStyle = T.onNode;
        ctx.fillText(l.text, l.x, l.y + 0.5);
        ctx.globalAlpha = 1;
        continue;
      }
      if (l.kind === 'pill') {
        // One box per layer, so the level is clear before the words are read:
        //   banner  group       solid capsule in the group's colour, capitals
        //   tag     sub-group   squared card with a colour bar down its left edge
        //   plate   company     small plate with a colour underline
        //   pill    a person or anything hovered: outlined capsule
        const style = l.style || 'pill';
        const tone = paintOf(l.color);
        const raw = l.text.length > 34 ? `${l.text.slice(0, 33)}…` : l.text;
        const name = style === 'banner' ? raw.toUpperCase() : raw;
        const nameFont = style === 'banner' ? `700 ${l.size - 1.5}px ${FONT}` : `${style === 'tag' ? 700 : l.weight} ${l.size}px ${FONT}`;
        const count = l.count != null ? l.count.toLocaleString('en-US') : '';
        ctx.font = nameFont;
        if (style === 'banner') ctx.letterSpacing = '0.7px';
        const nameW = ctx.measureText(name).width;
        ctx.letterSpacing = '0px';
        ctx.font = `500 ${l.size - 1}px ${FONT}`;
        const countW = count ? ctx.measureText(count).width + 7 : 0;
        const lead = style === 'tag' ? 13 : style === 'banner' ? 11 : 9;
        const bw = nameW + countW + lead + (style === 'banner' ? 11 : 9);
        const bh = l.size + (style === 'banner' ? 12 : l.size < 10.5 ? 8 : 11);
        // Keep clear of the zoom buttons in the top-left corner.
        const bx = l.sticky ? clamp(l.x - bw / 2, l.y < 160 ? 52 : 4, Math.max(52, w - bw - 4)) : l.x - bw / 2;
        const by = l.y - bh / 2;
        if (l.priority < 99 && !free(bx - 3, by - 2, bx + bw + 3, by + bh + 2)) continue;
        if (style === 'plate' && l.priority < 99) { if (plates >= 14) continue; plates += 1; }
        taken.push([bx, by, bx + bw, by + bh]);
        ctx.globalAlpha = l.dim ? 0.5 : 1;
        if (style === 'banner') {
          roundRect(ctx, bx, by, bw, bh, bh / 2);
          ctx.fillStyle = tone; ctx.fill();
        } else if (style === 'tag') {
          roundRect(ctx, bx, by, bw, bh, 4);
          ctx.fillStyle = T.panel(l.color); ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(tone, T.panelEdge); ctx.stroke();
          roundRect(ctx, bx + 3, by + 3, 3, bh - 6, 1.5);
          ctx.fillStyle = tone; ctx.fill();
        } else if (style === 'plate') {
          roundRect(ctx, bx, by, bw, bh, 3);
          ctx.fillStyle = T.pill; ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(tone, 0.28); ctx.stroke();
          ctx.fillStyle = tone; ctx.fillRect(bx + 4, by + bh - 2.5, bw - 8, 2);
        } else {
          roundRect(ctx, bx, by, bw, bh, bh / 2);
          ctx.fillStyle = T.pill; ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(tone, l.color === INK ? 0.35 : 0.65); ctx.stroke();
        }
        ctx.textAlign = 'left';
        ctx.font = nameFont;
        if (style === 'banner') ctx.letterSpacing = '0.7px';
        ctx.fillStyle = style === 'banner' ? T.onNode : style === 'pill' ? tone : T.ink;
        ctx.fillText(name, bx + lead, l.y + 0.5);
        ctx.letterSpacing = '0px';
        if (count) {
          ctx.font = `500 ${l.size - 1}px ${FONT}`;
          ctx.fillStyle = style === 'banner' ? T.onNode : MUTED;
          ctx.globalAlpha *= style === 'banner' ? 0.78 : 1;
          ctx.fillText(count, bx + lead + nameW + 7, l.y + 0.5);
        }
        ctx.textAlign = 'center';
        ctx.globalAlpha = 1;
        continue;
      }
      // plain text with a white outline (people, "You")
      const text = l.room ? shortName(ctx, l.text, Math.max(l.room, 44)) : l.text;
      if (!text) continue;
      const tail = l.tail ? `  ${l.tail}` : '';
      const tw = ctx.measureText(text + tail).width;
      const th = l.size + (l.sub ? l.size : 0) + 2;
      if (!free(l.x - tw / 2 - 2, l.y - l.size / 2, l.x + tw / 2 + 2, l.y - l.size / 2 + th)) continue;
      taken.push([l.x - tw / 2, l.y - l.size / 2, l.x + tw / 2, l.y - l.size / 2 + th]);
      // A solid backing so the words read over rays and grid lines.
      ctx.globalAlpha = l.dim ? 0.35 : 1;
      roundRect(ctx, l.x - tw / 2 - 4, l.y - l.size / 2 - 2.5, tw + 8, th + 3, 3);
      ctx.fillStyle = T.pill; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3; ctx.strokeStyle = T.halo;
      ctx.globalAlpha = l.dim ? 0.35 : 1;
      if (tail) {
        // Name in ink, headcount in grey, as one centred line.
        ctx.textAlign = 'left';
        const x0 = l.x - tw / 2;
        ctx.strokeText(text + tail, x0, l.y);
        ctx.fillStyle = paintOf(l.color); ctx.fillText(text, x0, l.y);
        ctx.fillStyle = MUTED; ctx.fillText(tail, x0 + ctx.measureText(text).width, l.y);
        ctx.textAlign = 'center';
      } else {
        ctx.strokeText(text, l.x, l.y);
        ctx.fillStyle = paintOf(l.color);
        ctx.fillText(text, l.x, l.y);
      }
      ctx.globalAlpha = 1;
      if (l.sub) {
        ctx.font = `400 ${l.size - 1.5}px ${FONT}`;
        const sub = truncate(ctx, String(l.sub), Math.max(l.room || 0, 90));
        if (sub) {
          ctx.strokeText(sub, l.x, l.y + l.size + 1);
          ctx.fillStyle = MUTED;
          ctx.fillText(sub, l.x, l.y + l.size + 1);
        }
      }
    }

    // Keep going while anything is in motion (a flight, momentum, the idle drift, a pulse).
    if ((moving || tr.size || pulsing) && !frame.current) frame.current = requestAnimationFrame(draw);
  }, [reportView, settleSoon]);

  const redraw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  // `arrive` is the node an explicit navigation is heading for: the page is
  // told you are there, rather than working it out from what fills the canvas.
  const flyTo = useCallback((target, ms = 750, arrive = null) => {
    const from = { ...cam.current };
    const to = { yaw: from.yaw + wrapAngle(target.yaw - from.yaw), pitch: target.pitch, s: clamp(target.s, 1, maxS()) };
    spin.current = null;
    if (!ms) { anim.current = null; cam.current = to; redraw(); if (!arrive) settleSoon(); return; }
    anim.current = { from, to, start: performance.now(), ms, arrive };
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redraw, settleSoon]);

  const zoomBy = useCallback((factor, px, py, ms) => {
    const st = stage();
    const c = anim.current ? anim.current.to : cam.current;
    const s = clamp(c.s * factor, st.home * 0.6, maxS());
    const f = s / c.s;
    let { yaw, pitch } = c;
    if (px != null) {
      // Turn a little so the point under the cursor stays under it.
      yaw -= ((px - st.cx) * (f - 1)) / (s * FRONT);
      pitch = clamp(pitch + ((py - st.cy) * (f - 1)) / (s * FRONT), -MAX_PITCH, MAX_PITCH);
    }
    const next = { yaw, pitch, s };
    if (ms) flyTo(next, ms); else { anim.current = null; spin.current = null; cam.current = next; redraw(); settleSoon(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo, redraw, settleSoon]);

  const fitNode = useCallback((node, ms) => {
    if (!node || !live.current.globe) return;
    const target = node.type === 'person' ? node.parent : node;
    flyTo(target.id === ROOT_ID ? homeCamera() : cameraFor(target), ms, target.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo, cameraFor]);

  // New data or a new canvas size: face the focused cluster (or the whole globe) at once.
  // An explicit navigation (focus.nonce changes): turn and fly there.
  // Only the very first globe of a page load swings in from the side (and not
  // when the page says this is fresh data, `intro={false}`, as after an
  // upload): everything else settles within SETTLE_MS, so the value is on
  // screen at once rather than after a show.
  useEffect(() => {
    if (!atlas || !width) return;
    const size = `${width}x${height}x${insetBottom}`;
    // A new canvas size is applied at once; new data (a filter, a preset) is flown to.
    const fresh = lastSize.current !== size;
    lastAtlas.current = atlas;
    lastSize.current = size;
    hover.current = null;
    const node = atlas.byId.get(focus?.id) || atlas.root;
    if (!opened.current) {
      opened.current = true;
      const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (intro && !swungThisLoad && !calm) {
        swungThisLoad = true;
        cam.current = { yaw: -2.6, pitch: 0.6, s: stage().home * 0.5 };
        fitNode(node, OPENING_MS);
        return;
      }
      // Any first view without the swing starts in place, already framed.
      swungThisLoad = true;
      fitNode(node, 0);
      return;
    }
    fitNode(node, fresh ? 0 : SETTLE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atlas, width, height, insetBottom, focus?.id, focus?.nonce]);

  // A selection lit people up: turn to them and bring them all into view.
  // Only the camera moves; the globe's layout is never rebuilt for a selection.
  // When they are spread over more than about a third of the globe, show the
  // whole globe instead (turned towards their middle), and pulse the lit dots
  // once either way so a press is always seen.
  useEffect(() => {
    if (!atlas || !width || !globe || !highlightIds || !highlightIds.size) { pulse.current = 0; redraw(); return; }
    const lit = [];
    highlightIds.forEach((id) => { const u = globe.place.get(atlas.byId.get(id)); if (u) lit.push(u); });
    if (!lit.length) { pulse.current = 0; redraw(); return; }
    pulse.current = performance.now();
    const st = stage();
    const { dir, angle, share } = spreadOf(lit);
    if (!dir) { flyTo(homeCamera(), TURN_MS); return; }
    if (share > WIDE_SHARE) { flyTo(facing(dir, st.home), TURN_MS); return; }
    // Come in as close as still shows them all.
    const room = 0.42 * Math.min(st.w, st.hh);
    flyTo(facing(dir, clamp(room / (FRONT * Math.max(0.02, Math.sin(angle) + 0.03)), st.home, 9 / (PERSON_R * FRONT * globe.kappa))), TURN_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIds]);

  useEffect(() => { redraw(); }, [selectedId, theme, inFocus, redraw]);
  // The frame handle must be cleared too: React re-runs effects in development,
  // and a cancelled but still-set handle would block every later redraw.
  useEffect(() => () => { cancelAnimationFrame(frame.current); frame.current = 0; clearTimeout(settled.current); }, []);

  // ---------------------------------------------------------------- input

  /** The deepest drawn thing under a canvas point (front of the globe only). */
  const pick = (px, py) => {
    const a = live.current.atlas;
    if (!a || !live.current.globe) return null;
    const c = cam.current;
    const pr = projector(c);
    const open = openness(c.s * FRONT * live.current.globe.kappa);
    const hit = (child, slack) => {
      const q = seen(child, pr, c);
      return q.z > 0 && Math.hypot(q.sx - px, q.sy - py) <= Math.max(q.sr, slack) ? q : null;
    };
    let node = a.root;
    let found = null;
    for (;;) {
      if (node.type === 'company') {
        if (open < 0.35) break;
        const person = node.children.find((child) => hit(child, 5));
        if (person) found = person;
        break;
      }
      let q = null;
      const next = node.children.find((child) => { q = hit(child, 4); return q; });
      if (!next) break;
      found = next;
      if (next.type === 'group' && q.sr < 11) break;
      node = next;
    }
    return found;
  };

  const local = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const setHover = (node, px, py) => {
    if (hover.current !== node) {
      hover.current = node;
      setHoverNode(node);
      redraw();
    }
    const tip = tipRef.current;
    if (tip && node) {
      const { width: w } = live.current;
      tip.style.left = `${clamp(px + 14, 8, Math.max(8, w - 260))}px`;
      tip.style.top = `${py + 16}px`;
    }
  };

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    const [px, py] = local(e);
    canvasRef.current.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, [px, py]);
    anim.current = null;
    spin.current = null;
    inside.current = true;
    if (pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()];
      gesture.current = { pinch: Math.hypot(p[0] - q[0], p[1] - q[1]), moved: true };
    } else {
      gesture.current = { x: px, y: py, moved: false, at: performance.now(), vy: 0, vp: 0 };
    }
  };

  const onPointerMove = (e) => {
    const [px, py] = local(e);
    inside.current = true;
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) { setHover(pick(px, py), px, py); return; }
    const prev = pointers.current.get(e.pointerId);
    pointers.current.set(e.pointerId, [px, py]);
    if (pointers.current.size === 2 && g.pinch) {
      const [p, q] = [...pointers.current.values()];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d > 0) { zoomBy(d / g.pinch, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2); g.pinch = d; }
      return;
    }
    if (!g.moved && Math.hypot(px - g.x, py - g.y) < 4) return;
    if (!g.moved) { g.moved = true; setGrabbing(true); setHover(null); }
    // Grab the surface: it turns by exactly as far as the pointer moved.
    const c = cam.current;
    const dyaw = (px - prev[0]) / (c.s * FRONT); const dpitch = -(py - prev[1]) / (c.s * FRONT);
    cam.current = { ...c, yaw: c.yaw + dyaw, pitch: clamp(c.pitch + dpitch, -MAX_PITCH, MAX_PITCH) };
    const t = performance.now();
    const span = Math.max(8, t - g.at);
    g.vy = dyaw / span; g.vp = dpitch / span; g.at = t;
    redraw();
  };

  const onPointerUp = (e) => {
    const g = gesture.current;
    const had = pointers.current.delete(e.pointerId);
    if (!had || !g) return;
    if (pointers.current.size) return;
    gesture.current = null;
    setGrabbing(false);
    if (g.moved) {
      // Let go while moving and the globe keeps turning.
      if (!g.pinch && performance.now() - g.at < 80 && Math.abs(g.vy) + Math.abs(g.vp) > 0.00004) { spin.current = { yaw: g.vy, pitch: g.vp }; redraw(); } else settleSoon();
      return;
    }
    const [px, py] = local(e);
    const node = pick(px, py);
    const { onNodeClick: click, onBackgroundClick: bg } = live.current;
    if (node) click?.(node); else bg?.();
  };

  // Wheel must be a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.012 : 0.0022)), e.clientX - rect.left, e.clientY - rect.top);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [zoomBy, width]);

  if (!width || !atlas) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 text-sm text-muted" style={{ height }} aria-busy="true" aria-live="polite">
        <div className="relative h-24 w-40">
          <div className="skeleton absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full" />
          <div className="skeleton absolute left-2 top-2 h-6 w-6 rounded-full" />
          <div className="skeleton absolute right-3 top-5 h-7 w-7 rounded-full" />
          <div className="skeleton absolute bottom-2 left-8 h-5 w-5 rounded-full" />
          <div className="skeleton absolute bottom-4 right-8 h-6 w-6 rounded-full" />
        </div>
        Drawing your network…
      </div>
    );
  }

  const tip = hoverNode && (hoverNode.type === 'person'
    ? { title: hoverNode.label, lines: [hoverNode.contact?.position, hoverNode.contact?.company].filter(Boolean) }
    : { title: hoverNode.label, lines: [`${hoverNode.count.toLocaleString('en-US')} ${hoverNode.count === 1 ? 'person' : 'people'}`, hoverNode.type === 'group' ? hoverNode.hint : null].filter(Boolean) });
  const tool = 'glass flex h-8 w-8 items-center justify-center rounded-lg text-ink shadow-card hover:bg-white';

  return (
    <div
      className="relative select-none"
      style={{
        height,
        backgroundColor: (THEMES[theme] || THEMES.light).bg,
        backgroundImage: (THEMES[theme] || THEMES.light).backdrop,
      }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Map of ${atlas.peopleCount.toLocaleString('en-US')} people in ${atlas.companyCount.toLocaleString('en-US')} companies. Use the navigator below the map to move through it.`}
        style={{ width, height, display: 'block', touchAction: 'none', cursor: grabbing ? 'grabbing' : hoverNode ? 'pointer' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => { inside.current = false; if (!gesture.current) setHover(null); redraw(); }}
        onDoubleClick={(e) => { const [px, py] = local(e); if (!pick(px, py)) zoomBy(1.8, px, py, 300); }}
      />
      <div className="absolute left-3 top-3 flex flex-col gap-1.5">
        <button type="button" className={tool} onClick={() => zoomBy(1.6, undefined, undefined, 250)} aria-label="Zoom in" title="Zoom in"><HiOutlinePlus style={{ width: 15, height: 15 }} /></button>
        <button type="button" className={tool} onClick={() => zoomBy(1 / 1.6, undefined, undefined, 250)} aria-label="Zoom out" title="Zoom out"><HiOutlineMinus style={{ width: 15, height: 15 }} /></button>
        <button type="button" className={tool} onClick={() => fitNode(atlas.byId.get(ROOT_ID), 650)} aria-label="Fit to view" title="Fit to view"><HiOutlineArrowsPointingOut style={{ width: 15, height: 15 }} /></button>
        {children}
      </div>
      {litCount > 0 && (
        <div className="pointer-events-none absolute right-3 top-3 rounded-full border border-line bg-white px-2.5 py-0.5 text-xs font-semibold text-ink shadow-card" aria-live="polite">
          {`${litCount.toLocaleString('en-US')} lit`}
        </div>
      )}
      <div className="pointer-events-none absolute left-3 flex items-center gap-3 text-xs text-muted" style={{ bottom: insetBottom + 8 }} aria-hidden="true">
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-500 ring-2 ring-slate-300" />group</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-slate-500" />company, with a ray to each person</span>
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-900" />{theme === 'dark' ? 'bright' : 'dark'} tip = leader</span>
      </div>
      <div
        ref={tipRef}
        className={`glass pointer-events-none absolute z-10 max-w-[240px] rounded-lg border border-line px-2.5 py-1.5 text-xs shadow-card ${tip ? '' : 'hidden'}`}
        role="tooltip"
      >
        {tip && (
          <>
            <div className="font-semibold text-ink">{tip.title}</div>
            {tip.lines.map((line) => <div key={line} className="text-muted">{line}</div>)}
          </>
        )}
      </div>
    </div>
  );
}
