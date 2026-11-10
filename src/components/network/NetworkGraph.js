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
import { PERSON_R, ROOT_ID } from '../../utils/network/atlas';

export const SOURCE_COLORS = { linkedin: '#0077B5', x: '#0F172A', csv: '#64748B', attio: '#B8742A' };

/** The map is a globe in a night sky. */
const BG = '#0B1220';
const INK = '#F1F5F9';
const MUTED = '#94A3B8';
const GRID = '148,163,184';
const HIGHLIGHT = '#F59E0B';
const SELECTED = '#FB7185';
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
/** The network covers a cap of the globe this far from its pole (radians). */
const SPAN = 0.46 * Math.PI;
/** The globe's layers, as a fraction of its radius: you are the core, people are the surface. */
const SHELL = { root: 0, group: 0.5, subgroup: 0.7, company: 0.86, person: 1 };
const shellOf = (node) => (node.type === 'group' ? (node.depth === 1 ? SHELL.group : SHELL.subgroup) : SHELL[node.type]);
const MAX_PITCH = 1.35;
const OPENING_MS = 2600;

function withAlpha(hex, alpha) {
  const n = parseInt(String(hex || '#7C8A9E').slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const liteCache = new Map();
/** A colour lifted towards white so it reads on the dark canvas. */
function lite(hex) {
  let out = liteCache.get(hex);
  if (!out) {
    const n = parseInt(String(hex || '#7C8A9E').slice(1), 16);
    const mix = (c) => Math.round(c + (255 - c) * 0.36).toString(16).padStart(2, '0');
    out = `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
    liteCache.set(hex, out);
  }
  return out;
}
/** 0 = a company is a single dot; 1 = it is open and shows one dot per person. */
const openness = (k) => clamp((PERSON_R * k - 2.5) / 1.5, 0, 1);
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

/**
 * Wrap the atlas into a unit globe. The middle of the map is the pole and
 * distance from it becomes angle from the pole; how deep a node sits is set
 * by its level (see SHELL). Returns the place of every node
 * ([x, y, z, shrink, shell]) and the scale that turns map units into radians.
 */
function wrapOntoGlobe(atlas) {
  const { box } = atlas;
  const reach = Math.hypot(box.rx, box.ry) || 1;
  const kappa = SPAN / reach;
  const at = (x, y) => {
    const dx = x - box.x; const dy = y - box.y;
    const polar = Math.hypot(dx, dy) * kappa;
    const around = Math.atan2(dy, dx);
    // Circles of latitude get shorter away from the pole; clusters shrink to match.
    const shrink = polar > 1e-6 ? Math.sqrt(Math.sin(polar) / polar) : 1;
    return [Math.sin(polar) * Math.cos(around), Math.sin(polar) * Math.sin(around), Math.cos(polar), shrink];
  };
  const place = new Map();
  for (const node of atlas.nodes) place.set(node, [...at(node.x, node.y), shellOf(node)]);
  return { place, at, kappa };
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export default function NetworkGraph({
  atlas, width, height = 620, insetBottom = 0, highlightIds, selectedId, focus, onNodeClick, onViewNode, onBackgroundClick, children,
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
  const [hoverNode, setHoverNode] = useState(null);
  const [grabbing, setGrabbing] = useState(false);

  const globe = useMemo(() => (atlas ? wrapOntoGlobe(atlas) : null), [atlas]);
  // Latest props for the draw loop, which lives outside React's render.
  const live = useRef({});
  live.current = { atlas, globe, width, height, insetBottom, highlightIds, selectedId, onNodeClick, onViewNode, onBackgroundClick };

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

  // The branch from "you" down to the selected node, which carries a pulse.
  const trail = useMemo(() => {
    const set = new Set();
    for (let n = atlas?.byId.get(selectedId); n; n = n.parent) set.add(n.id);
    return set;
  }, [atlas, selectedId]);
  live.current.trail = trail;

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
    const m = c.s * mag * g.kappa * u[3] * (0.42 + 0.58 * Math.max(0, z));
    if (u[4] === 1) return { sx, sy, z, m, sr: node.r * m, hx: sx, hy: sy, hz: z };
    const [hx, hy, hz] = pr(u[0], u[1], u[2], u[4]);
    return { sx, sy, z, m, sr: node.r * m, hx, hy, hz };
  };

  /** The camera that turns a box of the flat plan to face the viewer and fills the stage with it. */
  const cameraFor = useCallback((box, capPersonPx = MAX_FIT_PERSON_PX) => {
    const g = live.current.globe;
    const st = stage();
    const u = g.at(box.x, box.y);
    const perUnit = FRONT * g.kappa * u[3];
    const fit = Math.min((st.w - 56) / (2 * box.rx), (st.hh - 28) / (2 * box.ry), capPersonPx / PERSON_R);
    return { yaw: Math.atan2(-u[0], u[2]), pitch: clamp(Math.atan2(u[1], Math.hypot(u[0], u[2])), -MAX_PITCH, MAX_PITCH), s: Math.max(st.home, fit / perUnit) };
  }, []);
  const homeCamera = () => ({ yaw: 0, pitch: 0, s: stage().home });

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

    // At rest and far out, the globe drifts a little so it never looks like a picture.
    let c = cam.current;
    const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!calm && !moving && !gesture.current && !inside.current && c.s <= st.home * 1.3) {
      c = { ...c, yaw: c.yaw + 0.09 * Math.sin(now / 2900), pitch: c.pitch + 0.045 * Math.sin(now / 3700) };
      moving = true;
    }

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
    const hot = hover.current;
    const labels = [];
    const tr = live.current.trail;

    // Stars: a far shell that turns with the globe, for depth.
    const shell = 0.75 * Math.max(w, h);
    for (const [x, y, z, size, glow] of STARS) {
      const x1 = x * Math.cos(c.yaw * 0.35) + z * Math.sin(c.yaw * 0.35); const z1 = -x * Math.sin(c.yaw * 0.35) + z * Math.cos(c.yaw * 0.35);
      const y2 = y * Math.cos(c.pitch * 0.35) - z1 * Math.sin(c.pitch * 0.35);
      if (y * Math.sin(c.pitch * 0.35) + z1 * Math.cos(c.pitch * 0.35) < 0) continue;
      ctx.beginPath(); ctx.arc(cx + x1 * shell, cy + y2 * shell, size, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(203,213,225,${glow})`; ctx.fill();
    }

    // The globe itself: a soft atmosphere, a faintly lit body and its outline.
    const R = c.s * OUTLINE;
    if (R < 6 * Math.max(w, h)) {
      const air = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.22);
      air.addColorStop(0, 'rgba(96,140,200,0)'); air.addColorStop(0.42, 'rgba(96,140,200,0.16)'); air.addColorStop(1, 'rgba(96,140,200,0)');
      ctx.fillStyle = air; ctx.beginPath(); ctx.arc(cx, cy, R * 1.22, 0, 2 * Math.PI); ctx.fill();
      const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
      body.addColorStop(0, 'rgba(46,70,112,0.55)'); body.addColorStop(0.7, 'rgba(20,32,56,0.5)'); body.addColorStop(1, 'rgba(11,18,32,0.75)');
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = `rgba(${GRID},0.45)`; ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(24,38,64,0.5)'; ctx.fillRect(0, 0, w, h);
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
          ctx.strokeStyle = `rgba(${GRID},${pass === 1 ? 0.17 : 0.05})`;
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
      const fade = behind > steps / 2 ? 0.25 : 1;
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
    const onScreen = (q) => !(q.sx + q.sr < -30 || q.sx - q.sr > w + 30 || q.sy + q.sr < -30 || q.sy - q.sr > h + 30);

    const paint = (node, q) => {
      if (!onScreen(q)) return;
      const { sx, sy, sr, m, hx, hy } = q;
      const dim = hasLit && !litC.has(node.id);
      const isHot = hot === node;
      const isSel = sel === node.id;
      const col = lite(node.color);
      // Things fade as they turn away, and nearly vanish on the far side.
      const depth = q.hz >= 0 ? clamp(0.4 + q.hz * 2.4, 0.4, 1) : 0.16;
      const far = q.z < 0;

      if (node.type === 'group') {
        if (sr < 1.5) return;
        const collapsed = sr < 11;
        const R0 = collapsed ? Math.max(2, sr * 0.7) : clamp(node.dot * m, 4, 16);
        const kids = collapsed ? [] : node.children.map((child) => [child, S(child)]);
        ctx.globalAlpha = (dim ? 0.3 : 1) * depth;
        if (!collapsed) {
          // No outline around a cluster: a glow that fades out from its cell body.
          const glow = ctx.createRadialGradient(hx, hy, 0, sx, sy, sr);
          glow.addColorStop(0, withAlpha(col, isHot ? 0.3 : node.depth === 1 ? 0.16 : 0.2));
          glow.addColorStop(0.55, withAlpha(col, isHot ? 0.1 : 0.05));
          glow.addColorStop(1, withAlpha(col, 0));
          ctx.fillStyle = glow;
          ctx.beginPath(); ctx.arc(sx, sy, sr, 0, 2 * Math.PI); ctx.fill();
          if (isHot) { ctx.setLineDash([2, 6]); ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(col, 0.5); ctx.stroke(); ctx.setLineDash([]); }
          for (const [child, cq] of kids) {
            const faded = hasLit && !litC.has(child.id);
            if (child.type === 'group') arc(node, child, lite(child.color), faded ? 0.1 : 0.55, 1.6, tr.has(child.id));
            else if (child.dot * cq.m > 0.7 && cq.z > -0.1) arc(node, child, lite(child.color), faded ? 0.06 : Math.min(0.55, 0.2 + 0.03 * child.count), child.count >= 10 ? 1.2 : 0.8, tr.has(child.id), 8);
          }
          ctx.globalAlpha = 1;
          for (const [child, cq] of kids) paint(child, cq);
          ctx.globalAlpha = (dim ? 0.3 : 1) * depth;
        }
        // Cell body: a point of light with a halo, not a disc.
        const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, R0 * 2.4);
        halo.addColorStop(0, withAlpha(col, isHot ? 0.95 : 0.8)); halo.addColorStop(0.35, withAlpha(col, 0.35)); halo.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(hx, hy, R0 * 2.4, 0, 2 * Math.PI); ctx.fill();
        ctx.beginPath(); ctx.arc(hx, hy, R0 * 0.5, 0, 2 * Math.PI);
        ctx.fillStyle = '#FFFFFF'; ctx.fill();
        ctx.globalAlpha = 1;
        if (!collapsed && !far && (sr >= 30 || isHot)) {
          // Sits on the top edge like a legend; sticks to the top of the canvas once you are inside the cluster.
          const stickY = 18 + (node.depth - 1) * 27;
          labels.push({
            kind: 'pill', sticky: true, text: node.label, count: node.count, x: clamp(sx, 110, Math.max(110, w - 110)), y: Math.max(sy - sr, stickY),
            size: node.depth === 1 ? 13 : 11.5, weight: node.depth === 1 ? 700 : 600, color: node.color, dim: dim || q.z < 0.25,
            priority: (isHot ? 100 : 92) - node.depth * 4 + Math.min(3, node.count / 1000),
          });
        }
        return;
      }

      if (node.type === 'company') {
        const R0 = clamp(node.dot * m, 1.2, 11);
        if (R0 < 1.25 && sr < 2) return;
        if (far) {
          ctx.globalAlpha = depth;
          ctx.beginPath(); ctx.arc(hx, hy, R0, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill();
          ctx.globalAlpha = 1;
          return;
        }
        // The burst: a ray from the core to every person. Drawn at every zoom,
        // so from far away a company reads as a spark sized by its headcount.
        const personPx = PERSON_R * m;
        const people = sr >= 3 ? node.children.map((child) => [child, S(child)]) : [];
        if (people.length) {
          ctx.beginPath();
          for (const [, pq] of people) { ctx.moveTo(hx, hy); ctx.lineTo(pq.sx, pq.sy); }
          ctx.lineWidth = personPx > 6 ? 1 : 0.7;
          ctx.strokeStyle = withAlpha(col, (dim ? 0.06 : isHot || isSel ? 0.6 : hasLit ? 0.14 : 0.34) * depth); ctx.stroke();
          if (personPx >= 0.5) for (const [child, pq] of people) paint(child, pq);
        }
        ctx.globalAlpha = (dim ? 0.22 : 1) * depth;
        const core = ctx.createRadialGradient(hx, hy, 0, hx, hy, R0 * 2);
        core.addColorStop(0, withAlpha(col, 1)); core.addColorStop(0.45, withAlpha(col, isHot || isSel ? 0.7 : 0.4)); core.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = core; ctx.beginPath(); ctx.arc(hx, hy, R0 * 2, 0, 2 * Math.PI); ctx.fill();
        if (R0 > 2) { ctx.beginPath(); ctx.arc(hx, hy, Math.max(1, R0 * 0.38), 0, 2 * Math.PI); ctx.fillStyle = '#FFFFFF'; ctx.fill(); }
        if ((isSel || (hasLit && !dim && open < 0.5)) && R0 > 1.5) {
          ctx.beginPath(); ctx.arc(hx, hy, R0 + 5, 0, 2 * Math.PI);
          ctx.lineWidth = 2; ctx.strokeStyle = isSel ? SELECTED : HIGHLIGHT; ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const named = node.key !== '__none__' || isHot || isSel;
        const text = node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label;
        if (!named || q.z < 0.2) return;
        if (isHot || isSel || (open >= 0.5 && sr >= 46)) {
          labels.push({ kind: 'pill', text, count: node.count, x: hx, y: hy - R0 - 14, size: 11, weight: 600, color: INK, dim, priority: (isHot || isSel ? 99 : 60) + Math.min(9, node.count / 20) });
        } else if (R0 >= 2 && (sr >= 11 || node.count >= 8)) {
          labels.push({ kind: 'plain', text, tail: node.count > 1 ? node.count.toLocaleString('en-US') : '', x: hx, y: hy + R0 + 9, size: node.count >= 10 ? 11 : 10, weight: node.count >= 10 ? 600 : 500, color: INK, dim, priority: 20 + Math.min(30, node.count) });
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
      ctx.globalAlpha = (hasLit && !isLit && !isSel ? 0.16 : 1) * depth * (node.rank === 0 || grown > 0 ? 1 : 0.85);
      ctx.beginPath(); ctx.arc(sx, sy, pr0, 0, 2 * Math.PI);
      if (node.contact?.relationship === 'firm') {
        // Firm-wide CRM contact (a colleague's): hollow dot.
        ctx.fillStyle = BG; ctx.fill();
        ctx.lineWidth = Math.max(0.8, pr0 * 0.28); ctx.strokeStyle = col; ctx.stroke();
      } else {
        ctx.fillStyle = grown < 1 && node.rank === 0 && !isHot ? '#FFFFFF' : col;
        ctx.fill();
        if (grown < 1 && sr > 1.5) { ctx.beginPath(); ctx.arc(sx, sy, pr0 * 2.2, 0, 2 * Math.PI); ctx.fillStyle = withAlpha(col, 0.16 * (1 - grown)); ctx.fill(); }
      }
      if (isLit || isSel) {
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(sx, sy, pr0 + 3, 0, 2 * Math.PI);
        ctx.lineWidth = 2; ctx.strokeStyle = isSel ? SELECTED : HIGHLIGHT; ctx.stroke();
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
      if (child.type === 'group') arc(a.root, child, lite(child.color), faded ? 0.12 : 0.7, 2.2, tr.has(child.id), 6);
      else if (child.dot * cq.m > 0.7) arc(a.root, child, lite(child.color), faded ? 0.06 : Math.min(0.5, 0.14 + 0.03 * child.count), child.count >= 10 ? 1.2 : 0.8, tr.has(child.id), 4);
    }
    for (const [child, cq] of tops) paint(child, cq);
    const mr = clamp(a.root.dot * me.m, 6, 13);
    // Dive into a cluster and the core is straight behind it: let it fade so it does not sit on top.
    const coreAlpha = clamp(2.2 - c.s / st.home, 0, 1);
    ctx.globalAlpha = coreAlpha;
    const sun = ctx.createRadialGradient(me.hx, me.hy, 0, me.hx, me.hy, mr * 3.2);
    sun.addColorStop(0, 'rgba(255,255,255,0.95)'); sun.addColorStop(0.3, 'rgba(226,232,240,0.4)'); sun.addColorStop(1, 'rgba(226,232,240,0)');
    ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(me.hx, me.hy, mr * 3.2, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.arc(me.hx, me.hy, mr * 0.6, 0, 2 * Math.PI); ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.globalAlpha = 1;
    if (coreAlpha > 0.6) labels.push({ kind: 'plain', text: 'You', x: me.hx, y: me.hy + mr + 12, size: 12, weight: 700, color: INK, priority: 95 });

    // Labels last, flat on the glass, most important first; a label that would cover another is skipped.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const taken = [];
    const free = (x0, y0, x1, y1) => !taken.some((t) => x0 < t[2] && x1 > t[0] && y0 < t[3] && y1 > t[1]);
    labels.sort((p, q) => (q.priority || 0) - (p.priority || 0));
    for (const l of labels) {
      ctx.font = `${l.weight || 600} ${l.size}px ${FONT}`;
      if (l.kind === 'initials') {
        ctx.globalAlpha = l.dim ? 0.3 : 1;
        ctx.font = `600 ${l.size}px ${FONT}`;
        ctx.fillStyle = BG;
        ctx.fillText(l.text, l.x, l.y + 0.5);
        ctx.globalAlpha = 1;
        continue;
      }
      if (l.kind === 'pill') {
        const name = l.text.length > 34 ? `${l.text.slice(0, 33)}…` : l.text;
        const count = l.count != null ? l.count.toLocaleString('en-US') : '';
        const nameW = ctx.measureText(name).width;
        ctx.font = `500 ${l.size - 1}px ${FONT}`;
        const countW = count ? ctx.measureText(count).width + 7 : 0;
        const bw = nameW + countW + 18;
        const bh = l.size + 11;
        // Keep clear of the zoom buttons in the top-left corner.
        const bx = l.sticky ? clamp(l.x - bw / 2, l.y < 160 ? 52 : 4, Math.max(52, w - bw - 4)) : l.x - bw / 2;
        const by = l.y - bh / 2;
        if (l.priority < 99 && !free(bx - 3, by - 2, bx + bw + 3, by + bh + 2)) continue;
        taken.push([bx, by, bx + bw, by + bh]);
        ctx.globalAlpha = l.dim ? 0.45 : 1;
        roundRect(ctx, bx, by, bw, bh, bh / 2);
        const tone = l.color === INK ? INK : lite(l.color);
        ctx.fillStyle = 'rgba(11,18,32,0.9)';
        ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = withAlpha(tone, l.color === INK ? 0.35 : 0.65); ctx.stroke();
        ctx.textAlign = 'left';
        ctx.font = `${l.weight} ${l.size}px ${FONT}`;
        ctx.fillStyle = tone;
        ctx.fillText(name, bx + 9, l.y + 0.5);
        if (count) {
          ctx.font = `500 ${l.size - 1}px ${FONT}`;
          ctx.fillStyle = MUTED;
          ctx.fillText(count, bx + 9 + nameW + 7, l.y + 0.5);
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
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(11,18,32,0.92)';
      ctx.globalAlpha = l.dim ? 0.35 : 1;
      if (tail) {
        // Name in ink, headcount in grey, as one centred line.
        ctx.textAlign = 'left';
        const x0 = l.x - tw / 2;
        ctx.strokeText(text + tail, x0, l.y);
        ctx.fillStyle = l.color; ctx.fillText(text, x0, l.y);
        ctx.fillStyle = MUTED; ctx.fillText(tail, x0 + ctx.measureText(text).width, l.y);
        ctx.textAlign = 'center';
      } else {
        ctx.strokeText(text, l.x, l.y);
        ctx.fillStyle = l.color;
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
    if ((moving || tr.size) && !frame.current) frame.current = requestAnimationFrame(draw);
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
    flyTo(target.id === ROOT_ID ? homeCamera() : cameraFor(target.box), ms, target.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo, cameraFor]);

  // New data or a new canvas size: face the focused cluster (or the whole globe) at once.
  // An explicit navigation (focus.nonce changes): turn and fly there.
  // The very first time, the globe swings in from the side and settles.
  useEffect(() => {
    if (!atlas || !width) return;
    const size = `${width}x${height}x${insetBottom}`;
    const fresh = lastAtlas.current !== atlas || lastSize.current !== size;
    lastAtlas.current = atlas;
    lastSize.current = size;
    hover.current = null;
    const node = atlas.byId.get(focus?.id) || atlas.root;
    if (!opened.current) {
      opened.current = true;
      const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!calm) {
        cam.current = { yaw: -2.6, pitch: 0.6, s: stage().home * 0.5 };
        fitNode(node, OPENING_MS);
        return;
      }
    }
    fitNode(node, fresh ? 0 : 750);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atlas, width, height, insetBottom, focus?.id, focus?.nonce]);

  // A search or an answer lit people up: turn to them and bring them all into view.
  useEffect(() => {
    if (!atlas || !width || !highlightIds || !highlightIds.size) { redraw(); return; }
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    highlightIds.forEach((id) => {
      const n = atlas.byId.get(id);
      if (!n) return;
      x0 = Math.min(x0, n.x - n.r); x1 = Math.max(x1, n.x + n.r); y0 = Math.min(y0, n.y - n.r); y1 = Math.max(y1, n.y + n.r);
    });
    if (!Number.isFinite(x0)) { redraw(); return; }
    flyTo(cameraFor({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, rx: (x1 - x0) / 2 + 40, ry: (y1 - y0) / 2 + 40 }, 9), 750);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIds]);

  useEffect(() => { redraw(); }, [selectedId, redraw]);
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
        backgroundColor: BG,
        backgroundImage: 'radial-gradient(ellipse at 50% 42%, #18253F 0%, #0F192D 45%, #0B1220 100%)',
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
