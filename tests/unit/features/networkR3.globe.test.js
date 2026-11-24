/** @jest-environment jsdom */
/**
 * Round 3, the globe (NetworkGraph.js): review findings globe-1 to globe-16,
 * globe-m2, browser findings B12 and B14, and ROUND2 R4 to R7 and R8 #13.
 *
 * The real component is rendered in jsdom on a stub canvas that records what
 * it is asked to draw. Animation frames and the clock are driven by hand, so
 * the tests see exactly the frames a browser would run.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import NetworkGraph, {
  placeClusters, wrapOntoGlobe, hitTest, turnToLit, isLast, THEMES,
} from '../../../src/components/network/NetworkGraph';
import { buildAtlas, OTHER_COMPANIES_KEY } from '../../../src/utils/network/atlas';
import { parseLinkedInConnectionsCsv, parseGenericCsv } from '../../../src/utils/network/parseContacts';

const ROOT = path.join(__dirname, '../../..');
const load = (name) => {
  const text = fs.readFileSync(path.join(ROOT, 'tests/fixtures/network', name), 'utf8');
  const li = parseLinkedInConnectionsCsv(text);
  return li.contacts && li.contacts.length ? li.contacts : parseGenericCsv(text).contacts;
};
const SAMPLES = ['vc-investor-linkedin.csv', 'founder-operator-linkedin.csv', 'healthcare-academic.csv', 'sales-crm.csv', 'lp-fundraising-list.csv', 'small-network-linkedin.csv'];
const W = 900; const H = 620;

// ------------------------------------------------------------ a browser by hand

let clock = 1000;
let frames = [];
let ran = 0;
let calmMotion = false;
let ctxLog = null;

/** A 2D context that does nothing but count calls and keep the text it was asked to write. */
function stubContext() {
  const log = { calls: 0, fill: 0, beginPath: 0, arc: 0, text: [], strokeStyles: [] };
  const ctx = {
    font: '10px sans', globalAlpha: 1, letterSpacing: '0px', lineDashOffset: 0,
    measureText(t) { const m = /([\d.]+)px/.exec(this.font); return { width: String(t).length * (m ? Number(m[1]) : 10) * 0.56 }; },
    createRadialGradient() { log.calls += 1; return { addColorStop() {} }; },
    fillText(t) { log.calls += 1; log.text.push(String(t)); },
    fill() { log.calls += 1; log.fill += 1; },
    beginPath() { log.calls += 1; log.beginPath += 1; },
    arc() { log.calls += 1; log.arc += 1; },
  };
  for (const k of ['setTransform', 'clearRect', 'moveTo', 'lineTo', 'stroke', 'quadraticCurveTo', 'arcTo', 'closePath', 'setLineDash', 'fillRect', 'strokeText']) {
    ctx[k] = () => { log.calls += 1; };
  }
  let stroke = '';
  Object.defineProperty(ctx, 'strokeStyle', { get: () => stroke, set: (v) => { stroke = v; log.strokeStyles.push(v); } });
  ctx.log = log;
  return ctx;
}

beforeAll(() => {
  // jsdom has no PointerEvent: a MouseEvent with a pointer id does the job.
  if (typeof window.PointerEvent !== 'function') {
    window.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
    };
  }
});

beforeEach(() => {
  clock = 1000; frames = []; ran = 0; calmMotion = false;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  window.cancelAnimationFrame = () => {};
  global.requestAnimationFrame = window.requestAnimationFrame;
  global.cancelAnimationFrame = window.cancelAnimationFrame;
  window.matchMedia = (q) => ({ matches: calmMotion && /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
  HTMLCanvasElement.prototype.getContext = function getContext() {
    if (!this.stub) this.stub = stubContext();
    ctxLog = this.stub.log;
    return this.stub;
  };
  delete window.IntersectionObserver;
});
afterEach(() => { jest.restoreAllMocks(); });

/** Run queued animation frames, 16 ms apart, until none is queued (or `max`). */
function flush(max = 400) {
  let n = 0;
  act(() => {
    while (frames.length && n < max) {
      const batch = frames; frames = [];
      clock += 16;
      for (const cb of batch) { cb(clock); n += 1; }
    }
  });
  ran += n;
  return n;
}

function mount(atlas, props = {}) {
  const handlers = { onNodeClick: jest.fn(), onViewNode: jest.fn(), onBackgroundClick: jest.fn() };
  const el = (p) => <NetworkGraph atlas={atlas} width={W} height={H} intro={false} {...handlers} {...p} />;
  const out = render(el(props));
  flush();
  const canvas = out.container.querySelector('canvas');
  return {
    ...out, canvas, handlers,
    update(p) { out.rerender(el({ ...props, ...p })); flush(); },
    targets: () => canvas.mapTargets || [],
    click(x, y) {
      fireEvent.pointerDown(canvas, { clientX: x, clientY: y, pointerId: 1, button: 0 });
      fireEvent.pointerUp(canvas, { clientX: x, clientY: y, pointerId: 1, button: 0 });
      flush();
    },
  };
}

const centreOf = (box) => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
const allPeople = (node) => (node.type === 'person' ? [node.id] : node.children.flatMap(allPeople));

// ------------------------------------------------------------ placement

describe('placement: the named clusters face you, "Other …" goes round the back (globe-1, globe-16, R4)', () => {
  test('two clusters: the second is no longer straight behind the first', () => {
    const { centres } = placeClusters([40, 30.8]);
    expect(centres[0]).toEqual([0, 0, 1]);
    expect(centres[1][2]).toBeGreaterThan(0);
  });

  test('a cluster marked for the back goes to the far side however large it is', () => {
    const { centres } = placeClusters([22, 19, 12, 80], { back: [false, false, false, true] });
    expect(centres[0]).toEqual([0, 0, 1]);
    expect(centres[1][2]).toBeGreaterThan(0);
    expect(centres[2][2]).toBeGreaterThan(0);
    expect(centres[3][2]).toBeLessThan(0);
  });

  test.each(SAMPLES)('By company on %s: largest named company faces you, the first named ones are in front, Other companies behind', (name) => {
    const atlas = buildAtlas(load(name), { groupBy: 'company' });
    const g = wrapOntoGlobe(atlas);
    const named = atlas.root.children.filter((n) => !isLast(n)).sort((p, q) => q.count - p.count);
    const z = (n) => g.place.get(n)[2];
    expect(g.place.get(named[0])).toEqual(expect.arrayContaining([0, 0, 1]));
    expect(g.rank.get(named[0])).toBe(0);
    // The first named companies (up to five) all sit on the side facing you.
    named.slice(0, 5).forEach((n) => expect(z(n)).toBeGreaterThan(0));
    const other = atlas.root.children.find((n) => n.key === OTHER_COMPANIES_KEY);
    if (other) expect(z(other)).toBeLessThan(0);
  });

  test('a file under forty people sits entirely on the side facing you (R7)', () => {
    for (const by of ['company', 'role']) {
      let atlas;
      try { atlas = buildAtlas(load('small-network-linkedin.csv'), { groupBy: by }); } catch (e) { continue; } // role waits on grouping.js
      const g = wrapOntoGlobe(atlas);
      atlas.root.children.filter((n) => !isLast(n)).forEach((n) => expect(g.place.get(n)[2]).toBeGreaterThan(0));
    }
  });
});

// ------------------------------------------------------------ hit-testing

describe('hitTest (R5): a label or hub always wins, a point inside a cluster is background', () => {
  const group = { id: 'g/a', type: 'group' }; const other = { id: 'g/b', type: 'group' }; const person = { id: 'p:1', type: 'person' };
  const targets = [
    { kind: 'hub', node: group, x: 100, y: 100, r: 10, z: 0.5 },
    { kind: 'hub', node: other, x: 104, y: 100, r: 10, z: -0.5 },
    { kind: 'person', node: person, x: 112, y: 100, r: 5, z: 0.4 },
    { kind: 'label', node: other, box: [90, 60, 160, 80] },
  ];
  test('label beats everything under it', () => expect(hitTest(targets, 120, 70)).toBe(other));
  test('a hub facing you beats one on the far side, and beats a person', () => {
    expect(hitTest(targets, 104, 100)).toBe(group);
    expect(hitTest(targets, 109, 100)).toBe(group);
  });
  test('a person when no hub is under the pointer', () => expect(hitTest(targets, 116, 100)).toBe(person));
  test('nothing under the pointer is a background click', () => {
    expect(hitTest(targets, 300, 300)).toBeNull();
    expect(hitTest([], 1, 1)).toBeNull();
  });
});

/** Every top-layer label must select its node, with and without another selection lit. */
function checkLabels(atlas, litNode) {
  const g = mount(atlas, { theme: 'light' });
  const tops = new Set(atlas.root.children);
  const labelled = () => g.targets().filter((t) => t.kind === 'label' && tops.has(t.node));
  const home = () => { fireEvent.click(g.getByLabelText('Fit to view')); flush(); };
  const first = labelled();
  expect(first.length).toBeGreaterThanOrEqual(Math.min(4, tops.size));
  for (const { node } of first) {
    // Each click flies into its node, so go back out and aim at where the label is now.
    home();
    const t = labelled().find((x) => x.node === node);
    g.handlers.onNodeClick.mockClear();
    const [x, y] = centreOf(t.box);
    g.click(x, y);
    expect(g.handlers.onNodeClick).toHaveBeenCalledTimes(1);
    expect(g.handlers.onNodeClick.mock.calls[0][0]).toBe(t.node);
    // Each click opens the node: the page hears where the user went (R5, R6, globe-3).
    expect(g.handlers.onViewNode).toHaveBeenLastCalledWith(t.node.id);
  }
  // Now with another selection lit (its labels dimmed): every label still selects its own node.
  g.update({ highlightIds: new Set(allPeople(litNode)) });
  home();
  const dimmed = labelled().filter((t) => t.node !== litNode).map((t) => t.node);
  expect(dimmed.length).toBeGreaterThan(0);
  for (const node of dimmed) {
    home();
    const t = labelled().find((x) => x.node === node);
    if (!t) continue; // hidden behind another label at this angle: the hub still takes the click
    g.handlers.onNodeClick.mockClear();
    const [x, y] = centreOf(t.box);
    g.click(x, y);
    expect(g.handlers.onNodeClick.mock.calls[0]?.[0]).toBe(t.node);
  }
  return g;
}

describe('clicks on the real globe (R5, B12)', () => {
  beforeEach(() => { calmMotion = true; });

  test('LP list By tag: every tag label selects its tag, also while "cold" is lit; just above a label is never "cold"', () => {
    const atlas = buildAtlas(load('lp-fundraising-list.csv'), { groupBy: 'tag' });
    const cold = atlas.root.children.find((n) => n.label === 'cold');
    expect(cold).toBeDefined();
    const g = checkLabels(atlas, cold);
    // B12: a click a few pixels above another label (inside the big cluster's glow) does not select "cold".
    const committed = g.targets().find((t) => t.kind === 'label' && t.node.label === 'committed');
    if (committed) {
      g.handlers.onNodeClick.mockClear();
      g.click(centreOf(committed.box)[0], committed.box[1] - 4);
      const hit = g.handlers.onNodeClick.mock.calls[0]?.[0];
      expect(hit === undefined || hit.label !== 'cold').toBe(true);
    }
    // A click on empty glass is a background click, whatever cluster the pointer is inside.
    g.handlers.onBackgroundClick.mockClear();
    const hub = g.targets().find((t) => t.kind === 'hub' && t.node === cold);
    let spot = null;
    for (let d = 20; d < 200 && !spot; d += 6) {
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        if (!hitTest(g.targets(), hub.x + dx, hub.y + dy)) { spot = [hub.x + dx, hub.y + dy]; break; }
      }
    }
    g.click(spot[0], spot[1]);
    expect(g.handlers.onBackgroundClick).toHaveBeenCalledTimes(1);
  });

  test('VC network By role: every family label selects its family, also with another lit', () => {
    const atlas = buildAtlas(load('vc-investor-linkedin.csv'), { groupBy: 'role' });
    const largest = [...atlas.root.children].sort((p, q) => q.count - p.count)[0];
    checkLabels(atlas, largest);
  });

  test('a drag is never a click', () => {
    const atlas = buildAtlas(load('lp-fundraising-list.csv'), { groupBy: 'tag' });
    const g = mount(atlas);
    const t = g.targets().find((x) => x.kind === 'label');
    const [x, y] = centreOf(t.box);
    fireEvent.pointerDown(g.canvas, { clientX: x, clientY: y, pointerId: 1, button: 0 });
    fireEvent.pointerMove(g.canvas, { clientX: x + 40, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(g.canvas, { clientX: x + 40, clientY: y, pointerId: 1, button: 0 });
    flush();
    expect(g.handlers.onNodeClick).not.toHaveBeenCalled();
    expect(g.handlers.onBackgroundClick).not.toHaveBeenCalled();
  });

  test('Escape on the focused map clears the selection', () => {
    const g = mount(buildAtlas(load('lp-fundraising-list.csv'), { groupBy: 'tag' }));
    fireEvent.keyDown(g.canvas, { key: 'Escape' });
    expect(g.handlers.onBackgroundClick).toHaveBeenCalledTimes(1);
  });
});

describe('By company: top companies are named at the whole-globe view (R4)', () => {
  beforeEach(() => { calmMotion = true; });
  test.each(['vc-investor-linkedin.csv', 'founder-operator-linkedin.csv', 'healthcare-academic.csv'])('%s: the largest eight carry a label with their count', (name) => {
    const atlas = buildAtlas(load(name), { groupBy: 'company' });
    const g = mount(atlas);
    const labelled = new Set(g.targets().filter((t) => t.kind === 'label').map((t) => t.node));
    const named = atlas.root.children.filter((n) => !isLast(n)).sort((p, q) => q.count - p.count).slice(0, 8);
    named.forEach((n) => expect(labelled.has(n)).toBe(true));
    // The count is on the label: "Stripe 22".
    expect(ctxLog.text).toEqual(expect.arrayContaining([named[0].count.toLocaleString('en-US')]));
  });
});

// ------------------------------------------------------------ camera

describe('the camera follows the user, not the selection (R6, globe-3, globe-4, globe-7, globe-9, globe-10)', () => {
  test('a selection turns the camera but never tells the page it went somewhere', () => {
    const atlas = buildAtlas(load('lp-fundraising-list.csv'), { groupBy: 'tag' });
    const g = mount(atlas);
    g.handlers.onViewNode.mockClear();
    g.update({ highlightIds: new Set(allPeople(atlas.root.children[1])) });
    flush();
    expect(g.handlers.onViewNode).not.toHaveBeenCalled();
  });

  test('the same people in a new Set: no new flight, no new pulse (globe-7)', () => {
    const atlas = buildAtlas(load('lp-fundraising-list.csv'), { groupBy: 'tag' });
    const ids = allPeople(atlas.root.children[0]);
    const g = mount(atlas, { highlightIds: new Set(ids) });
    flush();
    const before = ran;
    g.update({ highlightIds: new Set(ids) });
    expect(ran - before).toBeLessThanOrEqual(1);
  });

  test('a new arrangement with the same people lit turns to them again (globe-4)', () => {
    calmMotion = true;
    const contacts = load('vc-investor-linkedin.csv');
    const byCompany = buildAtlas(contacts, { groupBy: 'company' });
    // People at one small company: under By company they sit inside "Other companies", round the back.
    const other = byCompany.root.children.find((n) => n.key === OTHER_COMPANIES_KEY);
    const small = other.children[0];
    const lit = new Set(allPeople(small));
    const byTitle = buildAtlas(contacts, { groupBy: 'industry' });
    const g = mount(byTitle, { highlightIds: lit, focus: { id: 'root', nonce: 0 } });
    // The page sends focus home as it rearranges; the lit people are the same ones.
    g.update({ atlas: byCompany, highlightIds: lit, focus: { id: 'root', nonce: 1 } });
    const hub = g.targets().find((t) => t.kind === 'hub' && t.node === other);
    expect(hub).toBeDefined();
    expect(hub.z).toBeGreaterThan(0);
  });

  test('one person: turn to them without pulling back out of a closer view (globe-9)', () => {
    const t = turnToLit([[0, 0, 1]], { w: 900, hh: 580, home: 250 }, 0.002, 9000);
    expect(t.s).toBe(9000);
  });

  test('the frame holds every lit person, not nine in ten (globe-10)', () => {
    const unit = (x, y, z) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
    const pts = [...Array.from({ length: 91 }, () => [0, 0, 1]), ...Array.from({ length: 9 }, () => unit(1, 0, 1))];
    const st = { w: 900, hh: 580, home: 250 };
    const { dir, s } = turnToLit(pts, st, 0.001);
    // A point at angle a from the middle lands s * sin(a) * mag from the centre: inside the stage.
    const worst = Math.max(...pts.map((p) => Math.acos(Math.min(1, p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2]))));
    expect(s * Math.sin(worst) * (3 / (3 - Math.cos(worst)))).toBeLessThanOrEqual(580 / 2);
    // Framing only the nine in ten (all at one point) would have come in about 30 times closer.
    expect(s).toBeLessThan(0.42 * 580 / (1.5 * 0.03) / 10);
  });

  test('a click on a group flies into it and opens it (globe-3)', () => {
    calmMotion = true;
    const atlas = buildAtlas(load('lp-fundraising-list.csv'), { groupBy: 'tag' });
    const g = mount(atlas);
    const t = g.targets().find((x) => x.kind === 'label');
    g.click(...centreOf(t.box));
    expect(g.handlers.onViewNode).toHaveBeenLastCalledWith(t.node.id);
    // Inside the opened group its own layer (companies) is now clickable.
    const inner = g.targets().filter((x) => x.node.parent === t.node);
    expect(inner.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------ the draw loop

describe('the draw loop (R8 #13, globe-5, globe-6, globe-8, globe-11, globe-14)', () => {
  test('the loop stops when the canvas is off screen or the tab is hidden, even with a selection', () => {
    let seen = null;
    window.IntersectionObserver = class { constructor(cb) { seen = cb; } observe() {} disconnect() {} };
    const atlas = buildAtlas(load('lp-fundraising-list.csv'), { groupBy: 'tag' });
    const person = allPeople(atlas.root)[0];
    const g = mount(atlas);
    g.update({ selectedId: person, highlightIds: new Set([person]) });
    // On screen, the dashes on the selected branch keep the loop going.
    expect(flush(50)).toBe(50);
    act(() => seen([{ isIntersecting: false }]));
    flush(5);
    expect(frames.length).toBe(0);
    act(() => seen([{ isIntersecting: true }]));
    expect(frames.length).toBe(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    flush(5);
    expect(frames.length).toBe(0);
    delete document.hidden;
  });

  test('reduced motion: no pulse, no flight, no endless dashes', () => {
    calmMotion = true;
    const atlas = buildAtlas(load('lp-fundraising-list.csv'), { groupBy: 'tag' });
    const person = allPeople(atlas.root)[0];
    const g = mount(atlas);
    const before = ran;
    g.update({ selectedId: person, highlightIds: new Set(allPeople(atlas.root.children[0])) });
    expect(ran - before).toBeLessThanOrEqual(2);
    expect(frames.length).toBe(0);
  });

  test('5,000 lit people cost a handful of path fills, not thousands', () => {
    calmMotion = true;
    const contacts = Array.from({ length: 6000 }, (_, i) => ({ id: `x${i}`, name: `Person ${i}`, company: `Company ${i % 40}`, position: 'Engineer', source: 'csv' }));
    const atlas = buildAtlas(contacts, { groupBy: 'company' });
    const people = allPeople(atlas.root).slice(0, 5000);
    const fillsInOneFrame = (g, theme) => { const f0 = ctxLog.fill; const c0 = ctxLog.calls; g.update({ theme }); return [ctxLog.fill - f0, ctxLog.calls - c0]; };
    const a = mount(atlas, { highlightIds: new Set(people) });
    const [litFills, litCalls] = fillsInOneFrame(a, 'dark');
    a.unmount();
    const b = mount(atlas, { highlightIds: new Set() });
    const [baseFills, baseCalls] = fillsInOneFrame(b, 'dark');
    expect(litFills - baseFills).toBeLessThan(40);
    // About four calls per lit dot (move and arc, halo and core), where it was about eight.
    expect(litCalls - baseCalls).toBeLessThan(5000 * 4.5);
  });

  test('lit ids that are not on the globe dim nothing and brighten nothing (globe-14)', () => {
    const atlas = buildAtlas(load('lp-fundraising-list.csv'), { groupBy: 'tag' });
    const g = mount(atlas);
    ctxLog.strokeStyles.length = 0;
    g.update({ highlightIds: new Set(['p:nobody']) });
    act(() => { g.update({ theme: 'dark' }); });
    const alphas = ctxLog.strokeStyles.map((s) => /rgba\([^)]*,([\d.]+)\)$/.exec(s)).filter(Boolean).map((m) => Number(m[1]));
    expect(Math.max(...alphas)).toBeLessThanOrEqual(1);
    expect(g.container.textContent).not.toMatch(/lit/);
  });
});

// ------------------------------------------------------------ small things

describe('small things (globe-12, globe-15, globe-m2, B14, R7 wheel)', () => {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  test('the light theme lit colour stands out at least 3 to 1 from the canvas (globe-12)', () => {
    const ratio = (lum(THEMES.light.bg) + 0.05) / (lum(THEMES.light.lit) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  test('no label is placed under the "N lit" count (globe-15)', () => {
    calmMotion = true;
    const atlas = buildAtlas(load('vc-investor-linkedin.csv'), { groupBy: 'company' });
    const g = mount(atlas);
    g.update({ highlightIds: new Set(allPeople(atlas.root.children[0])) });
    const badge = [W - 12 - 70, 12, W - 12, 34];
    const placed = g.targets().filter((x) => x.kind === 'label');
    expect(placed.length).toBeGreaterThan(0);
    for (const t of placed) {
      const [x0, y0, x1, y1] = t.box;
      expect(x0 < badge[2] && x1 > badge[0] && y0 < badge[3] && y1 > badge[1]).toBe(false);
    }
  });

  test('the map\'s description points to the people list, not a navigator that is gone (globe-m2)', () => {
    const g = mount(buildAtlas(load('small-network-linkedin.csv'), { groupBy: 'company' }));
    const label = g.canvas.getAttribute('aria-label');
    expect(label).not.toMatch(/navigator/i);
    expect(label).toMatch(/people list/);
  });

  test('small file, Find "blue": "You" never sits on the lit people (B14)', () => {
    calmMotion = true;
    const atlas = buildAtlas(load('small-network-linkedin.csv'), { groupBy: 'company' });
    const blue = atlas.root.children.find((n) => /bluebird/i.test(n.label));
    const g = mount(atlas);
    expect(ctxLog.text).toContain('You');
    g.update({ highlightIds: new Set(allPeople(blue)) });
    ctxLog.text.length = 0;
    act(() => { g.update({ theme: 'dark' }); });
    expect(ctxLog.text).not.toContain('You');
  });

  test('wheel: a page scroll passing over the globe keeps scrolling the page; a rested pointer, focus or Ctrl zooms', () => {
    const g = mount(buildAtlas(load('small-network-linkedin.csv'), { groupBy: 'company' }));
    const wheel = (init = {}) => {
      const e = new WheelEvent('wheel', { deltaY: 40, clientX: 300, clientY: 300, bubbles: true, cancelable: true, ...init });
      g.canvas.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // Scrolling into the globe: not taken.
    expect(wheel()).toBe(false);
    clock += 100; expect(wheel()).toBe(false);
    // Pinch (Ctrl) always zooms.
    expect(wheel({ ctrlKey: true })).toBe(true);
    // The pointer comes to rest on the globe and the page scroll has stopped: taken.
    fireEvent.pointerMove(g.canvas, { clientX: 300, clientY: 300, pointerId: 2 });
    clock += 350;
    expect(wheel()).toBe(true);
    // Focus on the map: taken at once.
    fireEvent.pointerLeave(g.canvas);
    g.canvas.focus();
    expect(wheel()).toBe(true);
  });
});
