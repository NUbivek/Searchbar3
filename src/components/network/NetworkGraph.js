/**
 * Force-directed network graph (2D canvas) for the Network Map page.
 *
 * This is react-force-graph's ForceGraph2D, built the same way that package
 * builds it (react-kapsule around force-graph, both installed with
 * react-force-graph). Importing the react-force-graph entry point itself
 * also loads its VR/AR/3D components, which need A-Frame globals and fail in
 * the browser ("AFRAME is not defined"), so only the 2D pieces are loaded,
 * client-side, on first render.
 *
 * Visual language: "You" sits at the centre; every company is a coloured
 * cluster (one hue per company, sized by how many people you know there)
 * with its people as small dots of the same hue around it.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { HiOutlineArrowsPointingOut } from 'react-icons/hi2';

const METHOD_NAMES = [
  'emitParticle', 'd3Force', 'd3ReheatSimulation', 'stopAnimation', 'pauseAnimation', 'resumeAnimation',
  'centerAt', 'zoom', 'zoomToFit', 'getGraphBbox', 'screen2GraphCoords', 'graph2ScreenCoords',
];

/** Person labels are drawn on zoom only for graphs smaller than this; above it only highlighted/selected people are labelled. */
export const LABEL_ALL_PEOPLE_BELOW = 300;

let forceGraphPromise = null;
function loadForceGraph2D() {
  if (!forceGraphPromise) {
    // d3-force ships with force-graph; only forceCollide is needed here.
    forceGraphPromise = Promise.all([import('react-kapsule'), import('force-graph'), import('d3-force')])
      .then(([kapsule, forceGraph, d3Force]) => {
        const fromKapsule = kapsule.default || kapsule;
        const ForceGraph2D = fromKapsule(forceGraph.default || forceGraph, { methodNames: METHOD_NAMES });
        ForceGraph2D.displayName = 'ForceGraph2D';
        ForceGraph2D.forceCollide = d3Force.forceCollide;
        return ForceGraph2D;
      })
      .catch((error) => {
        forceGraphPromise = null;
        throw error;
      });
  }
  return forceGraphPromise;
}

// Design tokens (DESIGN.md): brand indigo for "you", amber for highlights, rose for the selection.
export const SOURCE_COLORS = { linkedin: '#0077B5', x: '#0F172A', csv: '#64748B' };
/** One hue per company cluster, picked by a stable hash of the company key. */
export const CLUSTER_COLORS = [
  '#6366F1', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#06B6D4', '#3B82F6', '#F43F5E', '#84CC16', '#A855F7',
  '#14B8A6', '#F97316', '#0EA5E9', '#D946EF', '#22C55E',
];
const ME_COLOR = '#4F46E5';
const ME_COLOR_2 = '#8B5CF6';
const HIGHLIGHT = '#F59E0B';
const SELECTED = '#E11D48';
const LABEL = '#0F172A';
const LABEL_MUTED = '#475569';
/** Role hubs ("Investors & LPs", ...) and, in role view, their companies and people. */
export const GROUP_COLORS = { investors: '#4F46E5', founders: '#059669', experts: '#D97706', other: '#64748B' };

export function clusterColor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CLUSTER_COLORS[h % CLUSTER_COLORS.length];
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function NetworkGraph({
  graphData, width, height = 600, highlightIds, selectedId, hoverId, onNodeClick, onNodeHover, onBackgroundClick,
}) {
  const [ForceGraph2D, setForceGraph2D] = useState(null);
  const [loadError, setLoadError] = useState('');
  const fgRef = useRef(null);
  const fittedFor = useRef(null);
  const userMoved = useRef(false);
  const fitting = useRef(false);
  const positions = useRef(new Map());

  // Keep positions of nodes that survive an update (e.g. expanding one
  // company) so the layout does not restart; d3 mutates these objects.
  const data = useMemo(() => {
    const prev = positions.current;
    let kept = 0;
    // People per company, to seed newly shown people on a ring around it.
    const ringSize = new Map();
    for (const n of graphData.nodes) {
      if (n.type === 'person' && !prev.has(n.id)) ringSize.set(n.companyKey, (ringSize.get(n.companyKey) || 0) + 1);
    }
    // While a newly expanded cluster settles, every company that already has
    // a position stays pinned so the rest of the map does not reflow; the
    // pins are released when the simulation stops (see onEngineStop).
    const pinCompanies = ringSize.size > 0;
    const ringIndex = new Map();
    const companyCount = graphData.nodes.filter((n) => n.type === 'company').length;
    let companyRank = 0;
    const nodes = graphData.nodes.map((n) => {
      const color = n.type === 'group' ? (GROUP_COLORS[n.key] || GROUP_COLORS.other)
        : n.type === 'company' ? (n.hub ? GROUP_COLORS[n.hub] || GROUP_COLORS.other : clusterColor(n.key))
        : n.type === 'person' ? (n.hub ? GROUP_COLORS[n.hub] || GROUP_COLORS.other : clusterColor(n.companyKey)) : ME_COLOR;
      const p = prev.get(n.id);
      if (n.type === 'group') return { ...n, color, x: n.fx, y: n.fy };
      if (p && Number.isFinite(p.x)) {
        kept += 1;
        const pin = n.type === 'company' && pinCompanies ? { fx: p.x, fy: p.y, pinned: true } : {};
        return { ...n, color, x: p.x, y: p.y, vx: 0, vy: 0, ...pin };
      }
      // Companies start on a ring around "you" (largest first, evenly
      // spread) so the first frames already look like a map, not a blob.
      if (n.type === 'company') {
        const angle = (2 * Math.PI * companyRank) / Math.max(1, companyCount) - Math.PI / 2;
        companyRank += 1;
        const hub = n.hub ? graphData.nodes.find((x) => x.type === 'group' && x.key === n.hub) : null;
        if (hub) return { ...n, color, x: hub.fx + Math.cos(angle * 7) * 120, y: hub.fy + Math.sin(angle * 7) * 120 };
        const radius = 160 + Math.sqrt(companyCount) * 14;
        return { ...n, color, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      }
      // New people start next to their (already placed) company node.
      const company = n.type === 'person' ? prev.get(`c:${n.companyKey}`) : null;
      if (company && Number.isFinite(company.x)) {
        const total = ringSize.get(n.companyKey) || 1;
        const i = ringIndex.get(n.companyKey) || 0;
        ringIndex.set(n.companyKey, i + 1);
        const angle = (2 * Math.PI * i) / total;
        const radius = 12 + Math.sqrt(total) * 4;
        return { ...n, color, x: company.x + Math.cos(angle) * radius, y: company.y + Math.sin(angle) * radius, vx: 0, vy: 0 };
      }
      return { ...n, color };
    });
    const links = graphData.links.map((l) => ({
      ...l,
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
    }));
    return { nodes, links, mostlyKept: nodes.length > 0 && kept / nodes.length > 0.5 };
  }, [graphData]);

  useEffect(() => {
    positions.current = new Map(data.nodes.map((n) => [n.id, n]));
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    loadForceGraph2D()
      .then((Component) => { if (!cancelled) setForceGraph2D(() => Component); })
      .catch((error) => { if (!cancelled) setLoadError(error.message || 'Could not load the graph'); });
    return () => { cancelled = true; };
  }, []);

  // Spread clusters apart; keep each company's people tight around it.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    userMoved.current = false;
    try {
      const n = data.nodes.length;
      // Big clusters push hard (room for their people); one-person companies barely at all.
      fg.d3Force('charge')?.strength((node) => (node.type === 'company' ? -(30 + 28 * Math.sqrt(node.count || 1)) * (n > 600 ? 0.8 : 1) : node.type === 'group' ? -2500 : node.type === 'me' ? -500 : -5));
      fg.d3Force('link')
        ?.distance((link) => (link.kind === 'me' ? (link.target?.type === 'group' ? 320 + Math.sqrt(link.target?.count || 1) * 6 : 90 + Math.sqrt(link.target?.count || 1) * 24) : link.kind === 'group' ? 120 + Math.sqrt(link.target?.count || 1) * 26 : 14))
        .strength((link) => (link.kind === 'me' ? (link.target?.type === 'group' ? 0.6 : 0.3) : link.kind === 'group' ? 0.25 : 0.9));
      if (ForceGraph2D?.forceCollide && !fg.d3Force('collide')) {
        fg.d3Force('collide', ForceGraph2D.forceCollide((node) => (node.r || 3) + (node.type === 'company' ? 16 : node.type === 'group' ? 40 : 1.5)).iterations(2));
      }
      fg.d3ReheatSimulation();
    } catch {
      // forces not ready yet
    }
  }, [data, ForceGraph2D]);

  // When a search or answer highlights people, bring them into view.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !highlightIds || highlightIds.size === 0) return;
    const lit = data.nodes.filter((n) => highlightIds.has(n.id) && Number.isFinite(n.x) && Number.isFinite(n.y));
    if (!lit.length) return;
    const xs = lit.map((n) => n.x);
    const ys = lit.map((n) => n.y);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const zoom = Math.max(0.4, Math.min(3, 0.8 * Math.min(width / (maxX - minX + 120), height / (maxY - minY + 120))));
    fitting.current = true;
    try {
      fg.centerAt((minX + maxX) / 2, (minY + maxY) / 2, 500);
      fg.zoom(zoom, 500);
    } catch {
      // graph not ready yet
    }
    setTimeout(() => { fitting.current = false; }, 700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIds]);

  if (loadError) {
    return <div className="flex items-center justify-center px-4 text-center text-sm text-rose-600" style={{ height }}>Could not load the graph: {loadError}</div>;
  }
  if (!ForceGraph2D || !width) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 text-sm text-muted" style={{ height }} aria-busy="true" aria-live="polite">
        <div className="relative h-24 w-40">
          <div className="skeleton absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full" />
          <div className="skeleton absolute left-2 top-2 h-4 w-4 rounded-full" />
          <div className="skeleton absolute right-3 top-5 h-5 w-5 rounded-full" />
          <div className="skeleton absolute bottom-2 left-8 h-3 w-3 rounded-full" />
          <div className="skeleton absolute bottom-4 right-8 h-4 w-4 rounded-full" />
        </div>
        Drawing your network…
      </div>
    );
  }

  const hasHighlight = highlightIds && highlightIds.size > 0;
  const isLit = (id) => hasHighlight && highlightIds.has(id);
  const isDim = (node) => hasHighlight && !isLit(node.id) && node.type !== 'me' && node.id !== selectedId;

  const drawNode = (node, ctx, scale) => {
    // The first frames can run before the simulation has placed every node.
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    const r = node.r || 3;
    const lit = isLit(node.id);
    const hot = node.id === selectedId || node.id === hoverId;
    ctx.globalAlpha = isDim(node) ? 0.18 : 1;
    if (node.type === 'me') {
      const grad = ctx.createRadialGradient(node.x - r / 3, node.y - r / 3, r / 4, node.x, node.y, r);
      grad.addColorStop(0, ME_COLOR_2);
      grad.addColorStop(1, ME_COLOR);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 6 / scale, 0, 2 * Math.PI);
      ctx.fillStyle = withAlpha(ME_COLOR, 0.15);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    } else if (node.type === 'group') {
      // Hub: wide soft halo, white disc with a coloured ring.
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 14, 0, 2 * Math.PI);
      ctx.fillStyle = withAlpha(node.color, hot || lit ? 0.22 : 0.1);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 3 / scale + 1;
      ctx.strokeStyle = node.color;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * 0.45, 0, 2 * Math.PI);
      ctx.fillStyle = node.color;
      ctx.fill();
    } else if (node.type === 'company') {
      // Soft halo, then the disc with a white rim.
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + Math.max(3, r * 0.45), 0, 2 * Math.PI);
      ctx.fillStyle = withAlpha(node.color, hot || lit ? 0.35 : 0.16);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(node.x, node.y, hot || lit ? r * 1.6 : r, 0, 2 * Math.PI);
      ctx.fillStyle = hot || lit ? node.color : withAlpha(node.color, 0.75);
      ctx.fill();
    }
    if (lit || node.id === selectedId) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 3 / scale + 1.5, 0, 2 * Math.PI);
      ctx.lineWidth = 2.5 / scale;
      ctx.strokeStyle = node.id === selectedId ? SELECTED : HIGHLIGHT;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  // Labels are drawn after all nodes so they are never hidden under circles.
  // People are only labelled on zoom in small graphs; in large ones a label
  // per person would cover the canvas, so only highlighted/selected/hovered
  // people get one (the tooltip still names everyone).
  const labelPeopleOnZoom = data.nodes.length < LABEL_ALL_PEOPLE_BELOW;
  const drawLabels = (ctx, scale) => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const node of data.nodes) {
      if (!Number.isFinite(node.x)) continue;
      const lit = isLit(node.id);
      const hot = node.id === selectedId || node.id === hoverId;
      const show = node.type === 'me' || node.type === 'group'
        || (node.type === 'company' && ((node.labelled && (node.count >= 5 || scale > 1.4)) || scale > 2.2 || lit || hot))
        || (node.type === 'person' && (hot || lit || (labelPeopleOnZoom && scale > 2.5)));
      if (!show) continue;
      ctx.globalAlpha = isDim(node) ? 0.25 : 1;
      const r = node.r || 3;
      const big = node.type === 'me' || node.type === 'group' || hot || (node.type === 'company' && node.count >= 10);
      const fontSize = (node.type === 'person' ? 9 : node.type === 'group' ? 13 : big ? 11 : 10) / scale;
      ctx.font = `${big ? '600 ' : '500 '}${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
      const raw = node.type === 'company' || node.type === 'group' ? `${node.label}  ${node.count}` : node.label;
      const label = raw.length > 38 ? `${raw.slice(0, 37)}…` : raw;
      const w = ctx.measureText(label).width;
      const padX = 5 / scale;
      const padY = 3 / scale;
      const y = node.y + r + 5 / scale + fontSize / 2 + padY;
      const bx = node.x - w / 2 - padX;
      const by = y - fontSize / 2 - padY;
      const bw = w + padX * 2;
      const bh = fontSize + padY * 2;
      const radius = 4 / scale;
      ctx.beginPath();
      ctx.moveTo(bx + radius, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + bh, radius);
      ctx.arcTo(bx + bw, by + bh, bx, by + bh, radius);
      ctx.arcTo(bx, by + bh, bx, by, radius);
      ctx.arcTo(bx, by, bx + bw, by, radius);
      ctx.closePath();
      ctx.fillStyle = hot || lit ? '#FFFFFF' : 'rgba(255,255,255,0.86)';
      ctx.fill();
      if (hot || lit) {
        ctx.lineWidth = 1 / scale;
        ctx.strokeStyle = withAlpha(node.color || ME_COLOR, 0.6);
        ctx.stroke();
      }
      ctx.fillStyle = node.type === 'person' && !hot ? LABEL_MUTED : LABEL;
      ctx.fillText(label, node.x, y);
      ctx.globalAlpha = 1;
    }
  };

  const paintArea = (node, color, ctx) => {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, (node.r || 3) + 2, 0, 2 * Math.PI);
    ctx.fill();
  };

  const linkColor = (l) => {
    const target = typeof l.target === 'object' ? l.target : null;
    const targetId = target ? target.id : l.target;
    if (hasHighlight && highlightIds.has(targetId)) return withAlpha(HIGHLIGHT, 0.9);
    if (hasHighlight) return 'rgba(148,163,184,0.08)';
    if (l.kind === 'me') return withAlpha(target?.color || ME_COLOR, target?.type === 'group' ? 0.5 : Math.min(0.35, 0.06 + 0.03 * (target?.count || 1)));
    if (l.kind === 'group') return withAlpha(target?.color || '#94A3B8', Math.min(0.4, 0.08 + 0.03 * (target?.count || 1)));
    return withAlpha(target?.color || '#94A3B8', 0.35);
  };

  return (
    <div className="relative" style={{ background: 'radial-gradient(ellipse at center, #FFFFFF 0%, #F8FAFF 55%, #F1F4FB 100%)' }}>
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={width}
        height={height}
        backgroundColor="rgba(0,0,0,0)"
        nodeId="id"
        nodeLabel={(n) => n.tooltip || n.label}
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={paintArea}
        onRenderFramePost={drawLabels}
        linkColor={linkColor}
        linkWidth={(l) => (l.kind === 'me' ? (typeof l.target === 'object' && l.target.type === 'group' ? 2.5 : 1.2) : l.kind === 'group' ? 1 : 0.7)}
        warmupTicks={80}
        cooldownTicks={200}
        onEngineStop={() => {
          // Release company pins now that the new cluster has settled.
          for (const node of data.nodes) {
            if (node.pinned) { delete node.fx; delete node.fy; node.pinned = false; }
          }
          // Fit the finished layout unless the user has already panned,
          // zoomed or dragged; a later reheat (expanding a company) refits
          // only when most of the map is new.
          if (fgRef.current && !userMoved.current) {
            fittedFor.current = data;
            fitting.current = true;
            fgRef.current.zoomToFit(500, 48);
            setTimeout(() => { fitting.current = false; }, 700);
          }
        }}
        onZoom={() => { if (!fitting.current) userMoved.current = true; }}
        onNodeDragEnd={() => { userMoved.current = true; }}
        onNodeClick={(node) => onNodeClick && onNodeClick(node)}
        onNodeHover={(node) => onNodeHover && onNodeHover(node)}
        onBackgroundClick={() => onBackgroundClick && onBackgroundClick()}
        enableNodeDrag={data.nodes.length < 1500}
      />
      <button
        type="button"
        onClick={() => fgRef.current && fgRef.current.zoomToFit(500, 48)}
        className="glass absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink shadow-card"
      >
        <HiOutlineArrowsPointingOut style={{ width: 13, height: 13 }} /> Fit to view
      </button>
    </div>
  );
}
