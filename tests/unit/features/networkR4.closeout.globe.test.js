/** @jest-environment jsdom */
/**
 * Network Map, close-out round: ROUND2 R9, the three things seen in the
 * browser after the fix round, checked on the real component in jsdom with
 * a stub canvas that records what it is asked to draw (the same harness as
 * networkR3.globe.test.js).
 *
 *   1. When a selection ends, the camera leaves where the selection turned it.
 *   2. At the opening view every first-layer group is labelled, the named
 *      ones at full strength.
 *   3. A scattered lit dot at the whole-globe view has a core of about 4 px.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, act } from '@testing-library/react';
import NetworkGraph, { THEMES, isLast } from '../../../src/components/network/NetworkGraph';
import { buildAtlas, personNodeId } from '../../../src/utils/network/atlas';
import { parseLinkedInConnectionsCsv, parseGenericCsv } from '../../../src/utils/network/parseContacts';
import { companyKeyFor } from '../../../src/utils/network/grouping';

const ROOT = path.join(__dirname, '../../..');
const load = (name) => {
  const text = fs.readFileSync(path.join(ROOT, 'tests/fixtures/network', name), 'utf8');
  const li = parseLinkedInConnectionsCsv(text);
  return li.contacts && li.contacts.length ? li.contacts : parseGenericCsv(text).contacts;
};
const W = 1100; const H = 680;

let clock = 1000;
let frames = [];

/** A 2D context that records text (with its alpha) and every filled path's arc radii and colour. */
function stubContext() {
  const log = { text: [], fills: [] };
  let radii = [];
  let fillStyle = '';
  const ctx = {
    font: '10px sans', globalAlpha: 1, letterSpacing: '0px', lineDashOffset: 0,
    measureText(t) { const m = /([\d.]+)px/.exec(this.font); return { width: String(t).length * (m ? Number(m[1]) : 10) * 0.56 }; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillText(t) { log.text.push({ t: String(t), alpha: this.globalAlpha }); },
    beginPath() { radii = []; },
    arc(x, y, r) { radii.push(r); },
    fill() { log.fills.push({ style: fillStyle, radii: radii.slice() }); },
  };
  for (const k of ['setTransform', 'clearRect', 'moveTo', 'lineTo', 'stroke', 'quadraticCurveTo', 'arcTo', 'closePath', 'setLineDash', 'fillRect', 'strokeText']) ctx[k] = () => {};
  Object.defineProperty(ctx, 'fillStyle', { get: () => fillStyle, set: (v) => { fillStyle = v; } });
  ctx.log = log;
  return ctx;
}

beforeEach(() => {
  clock = 1000; frames = [];
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  window.cancelAnimationFrame = () => {};
  global.requestAnimationFrame = window.requestAnimationFrame;
  global.cancelAnimationFrame = window.cancelAnimationFrame;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  HTMLCanvasElement.prototype.getContext = function getContext() {
    if (!this.stub) this.stub = stubContext();
    return this.stub;
  };
  delete window.IntersectionObserver;
});
afterEach(() => { jest.restoreAllMocks(); });

function flush(max = 600) {
  act(() => {
    let n = 0;
    while (frames.length && n < max) {
      const batch = frames; frames = [];
      clock += 16;
      for (const cb of batch) { cb(clock); n += 1; }
    }
  });
}

function mount(atlas, props = {}) {
  const handlers = { onNodeClick: jest.fn(), onViewNode: jest.fn(), onBackgroundClick: jest.fn() };
  const el = (p) => <NetworkGraph atlas={atlas} width={W} height={H} intro={false} viewId="root" {...handlers} {...p} />;
  const out = render(el(props));
  flush();
  const canvas = out.container.querySelector('canvas');
  return {
    canvas,
    log: () => canvas.stub.log,
    reset: () => { canvas.stub.log.text = []; canvas.stub.log.fills = []; },
    update(p) { canvas.stub.log.text = []; canvas.stub.log.fills = []; out.rerender(el({ ...props, ...p })); flush(); },
    hubs: () => new Map((canvas.mapTargets || []).filter((t) => t.kind === 'hub' && t.node.depth === 1).map((t) => [t.node.id, [t.x, t.y]])),
  };
}
const moved = (a, b) => { let d = 0; for (const [id, p] of a) { const q = b.get(id); if (q) d += Math.hypot(p[0] - q[0], p[1] - q[1]); } return d; };
const peopleAt = (contacts, key) => new Set(contacts.filter((c) => companyKeyFor(c) === key || companyKeyFor(c).startsWith(`${key} `)).map(personNodeId));

describe('R9 #1: the camera returns when a selection ends', () => {
  test('VC By role: light the Sequoia people, then clear: the globe is back at home', () => {
    const contacts = load('vc-investor-linkedin.csv');
    const atlas = buildAtlas(contacts, { groupBy: 'role' });
    const g = mount(atlas);
    const home = g.hubs();
    const lit = peopleAt(contacts, 'sequoia');
    expect(lit.size).toBeGreaterThan(2);
    g.update({ highlightIds: lit });
    const turned = g.hubs();
    expect(moved(home, turned)).toBeGreaterThan(50);
    g.update({ highlightIds: new Set(), selectedId: null });
    expect(moved(home, g.hubs())).toBeLessThan(5);
  });

  test('after the user turns the globe by hand, clearing leaves it where they put it', () => {
    const contacts = load('vc-investor-linkedin.csv');
    const atlas = buildAtlas(contacts, { groupBy: 'role' });
    const g = mount(atlas);
    g.update({ highlightIds: peopleAt(contacts, 'sequoia') });
    // A drag: pointer down, move, up.
    const { canvas } = g;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H });
    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 300, clientY: 300, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 380, clientY: 320, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: 380, clientY: 320, bubbles: true }));
    });
    flush();
    const dragged = g.hubs();
    g.update({ highlightIds: new Set() });
    expect(moved(dragged, g.hubs())).toBeLessThan(5);
  });
});

describe('R9 #2: every first-layer group is labelled at the opening view', () => {
  test.each([
    ['vc-investor-linkedin.csv', 'role'], ['healthcare-academic.csv', 'role'], ['lp-fundraising-list.csv', 'tag'], ['sales-crm.csv', 'tag'],
  ])('%s by %s', (file, groupBy) => {
    const atlas = buildAtlas(load(file), { groupBy });
    const g = mount(atlas, { theme: 'light' });
    const drawn = g.log().text;
    for (const top of atlas.root.children) {
      const name = top.label.length > 34 ? top.label.slice(0, 33) : top.label;
      const hit = drawn.filter((x) => x.t.toUpperCase().startsWith(name.toUpperCase().slice(0, 20)));
      expect([top.label, hit.length > 0]).toEqual([top.label, true]);
      if (!isLast(top)) expect([top.label, Math.max(...hit.map((x) => x.alpha))]).toEqual([top.label, 1]);
    }
  });
});

describe('R9 #3: a scattered lit dot at the whole-globe view is large enough to count', () => {
  test.each(['light', 'dark'])('VC By role, the Stripe people lit (%s)', (theme) => {
    const contacts = load('vc-investor-linkedin.csv');
    const atlas = buildAtlas(contacts, { groupBy: 'role' });
    const g = mount(atlas, { theme });
    const lit = peopleAt(contacts, 'stripe');
    expect(lit.size).toBeGreaterThan(5);
    g.update({ highlightIds: lit });
    const cores = g.log().fills.filter((f) => f.style === THEMES[theme].lit && f.radii.length);
    expect(cores.length).toBeGreaterThan(0);
    const near = Math.max(...cores.map((f) => Math.min(...f.radii)));
    expect(near).toBeGreaterThanOrEqual(3.9);
  });
});
