/**
 * Force-directed network graph (2D canvas) for the Network Map page.
 *
 * This is react-force-graph's ForceGraph2D, built the same way that package
 * builds it (react-kapsule around force-graph, both installed with
 * react-force-graph). Importing the react-force-graph entry point itself
 * also loads its VR/AR/3D components, which need A-Frame globals and fail in
 * the browser ("AFRAME is not defined"), so only the 2D pieces are loaded,
 * client-side, on first render.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';

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

export const SOURCE_COLORS = { linkedin: '#0077B5', x: '#000000', csv: '#6B7280' };
const ME_COLOR = '#2563EB';
const COMPANY_COLOR = '#93C5FD';
const HIGHLIGHT = '#F59E0B';

export default function NetworkGraph({
  graphData, width, height = 560, highlightIds, selectedId, onNodeClick, onBackgroundClick,
}) {
  const [ForceGraph2D, setForceGraph2D] = useState(null);
  const [loadError, setLoadError] = useState('');
  const fgRef = useRef(null);
  const fittedFor = useRef(null);
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
    const nodes = graphData.nodes.map((n) => {
      const p = prev.get(n.id);
      if (p && Number.isFinite(p.x)) {
        kept += 1;
        const pin = n.type === 'company' && pinCompanies ? { fx: p.x, fy: p.y, pinned: true } : {};
        return { ...n, x: p.x, y: p.y, vx: 0, vy: 0, ...pin };
      }
      // New people start next to their (already placed) company node.
      const company = n.type === 'person' ? prev.get(`c:${n.companyKey}`) : null;
      if (company && Number.isFinite(company.x)) {
        const total = ringSize.get(n.companyKey) || 1;
        const i = ringIndex.get(n.companyKey) || 0;
        ringIndex.set(n.companyKey, i + 1);
        const angle = (2 * Math.PI * i) / total;
        const radius = 12 + Math.sqrt(total) * 4;
        return { ...n, x: company.x + Math.cos(angle) * radius, y: company.y + Math.sin(angle) * radius, vx: 0, vy: 0 };
      }
      return { ...n };
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

  // Spread nodes out a little more than the defaults; refit when data changes.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    try {
      const n = data.nodes.length;
      fg.d3Force('charge')?.strength(n > 600 ? -18 : n > 150 ? -30 : -40);
      fg.d3Force('link')?.distance((link) => (link.kind === 'me' ? 70 : 22));
      if (ForceGraph2D?.forceCollide && !fg.d3Force('collide')) {
        // Keeps circles from stacking when a company's people are shown.
        fg.d3Force('collide', ForceGraph2D.forceCollide((node) => (node.r || 3) + 1.5).iterations(1));
      }
      fg.d3ReheatSimulation();
    } catch {
      // forces not ready yet
    }
  }, [data, ForceGraph2D]);

  if (loadError) {
    return <div className="flex items-center justify-center text-sm text-red-600" style={{ height }}>Could not load the graph: {loadError}</div>;
  }
  if (!ForceGraph2D || !width) {
    return (
      <div className="flex items-center justify-center text-sm text-gray-500" style={{ height }}>
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500 mr-3" /> Loading graph…
      </div>
    );
  }

  const hasHighlight = highlightIds && highlightIds.size > 0;

  const drawNode = (node, ctx, scale) => {
    const r = node.r || 3;
    const lit = hasHighlight && highlightIds.has(node.id);
    const dim = hasHighlight && !lit && node.type !== 'me';
    ctx.globalAlpha = dim ? 0.25 : 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = node.type === 'me' ? ME_COLOR : node.type === 'company' ? COMPANY_COLOR : (SOURCE_COLORS[node.source] || SOURCE_COLORS.csv);
    ctx.fill();
    if (node.type === 'company') {
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = '#3B82F6';
      ctx.stroke();
    }
    if (lit || node.id === selectedId) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 2.5 / scale + 1, 0, 2 * Math.PI);
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = node.id === selectedId ? '#DC2626' : HIGHLIGHT;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  // Labels are drawn after all nodes so they are never hidden under circles.
  // People are only labelled on zoom in small graphs; in large ones a label
  // per person would cover the canvas, so only highlighted/selected people
  // get one (the tooltip still names everyone).
  const labelPeopleOnZoom = data.nodes.length < LABEL_ALL_PEOPLE_BELOW;
  const drawLabels = (ctx, scale) => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const node of data.nodes) {
      if (!Number.isFinite(node.x)) continue;
      const lit = hasHighlight && highlightIds.has(node.id);
      const show = node.type === 'me'
        || (node.type === 'company' && (node.labelled || scale > 3 || lit))
        || (node.type === 'person' && (node.id === selectedId || lit || (labelPeopleOnZoom && scale > 2.5)));
      if (!show) continue;
      if (hasHighlight && !lit && node.type !== 'me' && node.id !== selectedId) ctx.globalAlpha = 0.35;
      const r = node.r || 3;
      const fontSize = 10 / scale;
      ctx.font = `${node.type === 'me' || node.id === selectedId ? 'bold ' : ''}${fontSize}px sans-serif`;
      const raw = node.type === 'company' ? `${node.label} (${node.count})` : node.label;
      const label = raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
      const w = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(node.x - w / 2 - 1 / scale, node.y + r + 1 / scale, w + 2 / scale, fontSize + 1 / scale);
      ctx.fillStyle = '#1F2937';
      ctx.fillText(label, node.x, node.y + r + 1.5 / scale);
      ctx.globalAlpha = 1;
    }
  };

  const paintArea = (node, color, ctx) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, (node.r || 3) + 1, 0, 2 * Math.PI);
    ctx.fill();
  };

  return (
    <div className="relative">
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={width}
        height={height}
        backgroundColor="#FFFFFF"
        nodeId="id"
        nodeLabel={(n) => n.tooltip || n.label}
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={paintArea}
        onRenderFramePost={drawLabels}
        linkColor={(l) => (hasHighlight && highlightIds.has(typeof l.target === 'object' ? l.target.id : l.target) ? '#F59E0B' : '#E5E7EB')}
        linkWidth={(l) => (l.kind === 'me' ? 0.6 : 0.4)}
        cooldownTicks={150}
        onEngineStop={() => {
          // Release company pins now that the new cluster has settled.
          for (const node of data.nodes) {
            if (node.pinned) { delete node.fx; delete node.fy; node.pinned = false; }
          }
          if (fittedFor.current !== data && fgRef.current) {
            const first = fittedFor.current === null;
            fittedFor.current = data;
            if (first || !data.mostlyKept) fgRef.current.zoomToFit(400, 40);
          }
        }}
        onNodeClick={(node) => onNodeClick && onNodeClick(node)}
        onBackgroundClick={() => onBackgroundClick && onBackgroundClick()}
        enableNodeDrag={data.nodes.length < 1500}
      />
      <button
        type="button"
        onClick={() => fgRef.current && fgRef.current.zoomToFit(400, 40)}
        className="absolute top-2 right-2 text-xs bg-white/90 border border-gray-200 text-gray-700 hover:bg-gray-50 px-2 py-1 rounded"
      >
        Fit to view
      </button>
    </div>
  );
}
