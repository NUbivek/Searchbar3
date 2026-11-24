/**
 * The globe (NetworkGraph.js), the parts that can be tested without a browser:
 * cluster placement speed and fit, the spread measure that decides between
 * "turn to the lit people" and "show the whole globe", the dimming levels,
 * and that every colour lives inside THEMES.
 */
import fs from 'fs';
import path from 'path';
import {
  placeClusters, wrapOntoGlobe, spreadOf, dimLevels, THEMES, SOURCE_COLORS,
} from '../../../src/components/network/NetworkGraph';
import { buildAtlas } from '../../../src/utils/network/atlas';
import { parseLinkedInConnectionsCsv } from '../../../src/utils/network/parseContacts';

const ROOT = path.join(__dirname, '../../..');
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'tests/fixtures/network', name), 'utf8');
const apart = (p, q) => Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));

/** A seeded set of cluster radii, largest first, like a By company first layer. */
function radiiOf(count, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return Array.from({ length: count }, () => 4 + 40 * rnd() ** 3).sort((p, q) => q - p);
}

/** A bare atlas with `count` top clusters and nothing under them (what wrapOntoGlobe reads). */
function flatAtlas(count) {
  const children = radiiOf(count).map((r, i) => ({
    id: `c:${i}`, type: 'company', depth: 1, r, x: i * 10, y: 0, children: [],
  }));
  return { root: { id: 'root', type: 'root', r: 1, x: 0, y: 0, children } };
}

describe('globe placement', () => {
  test('300 top clusters are placed in under 300 ms (it was quadratic: tens of seconds)', () => {
    const atlas = flatAtlas(300);
    const t0 = Date.now();
    const { place, kappa } = wrapOntoGlobe(atlas);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(300);
    expect(kappa).toBeGreaterThan(0);
    expect(place.size).toBe(301);
  });

  test('no two clusters overlap, the largest faces the viewer, coverage stays within bounds', () => {
    for (const count of [1, 2, 5, 16, 80, 300]) {
      const radii = radiiOf(count, count);
      const { centres, kappa } = placeClusters(radii);
      expect(centres).toHaveLength(count);
      expect(centres[0]).toEqual([0, 0, 1]);
      for (let i = 0; i < count; i += 1) {
        for (let j = i + 1; j < count; j += 1) {
          expect(apart(centres[i], centres[j]) - (radii[i] + radii[j]) * kappa).toBeGreaterThanOrEqual(0.015 - 1e-9);
        }
      }
      const covered = radii.reduce((sum, r) => sum + (1 - Math.cos(Math.min(Math.PI, r * kappa))) / 2, 0);
      expect(covered).toBeLessThanOrEqual(0.62 + 1e-9);
    }
  });

  test('placement is the same every time (same file, same globe)', () => {
    const radii = radiiOf(40);
    expect(placeClusters(radii)).toEqual(placeClusters(radii));
  });

  test('By company on the 544-person sample is laid out in well under a second', () => {
    const contacts = parseLinkedInConnectionsCsv(fixture('vc-investor-linkedin.csv')).contacts;
    const atlas = buildAtlas(contacts, { groupBy: 'company' });
    const t0 = Date.now();
    const { place } = wrapOntoGlobe(atlas);
    expect(Date.now() - t0).toBeLessThan(300);
    // Every node gets a place on the unit globe.
    atlas.nodes.forEach((n) => {
      const u = place.get(n);
      expect(u).toBeDefined();
      expect(Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1, 6);
    });
  });

  test('a selection does not touch the layout: wrapping is pure on the atlas', () => {
    const contacts = parseLinkedInConnectionsCsv(fixture('small-network-linkedin.csv')).contacts;
    const atlas = buildAtlas(contacts);
    const a = wrapOntoGlobe(atlas);
    const b = wrapOntoGlobe(atlas);
    expect(b.kappa).toBe(a.kappa);
    atlas.nodes.forEach((n) => expect(b.place.get(n)).toEqual(a.place.get(n)));
  });
});

describe('spread of the lit people', () => {
  const unit = (x, y, z) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };

  test('a tight bunch: small share, faces their middle', () => {
    const pts = [unit(0.05, 0, 1), unit(-0.05, 0, 1), unit(0, 0.05, 1), unit(0, -0.05, 1)];
    const { dir, share } = spreadOf(pts);
    expect(dir[2]).toBeCloseTo(1, 6);
    expect(share).toBeLessThan(0.01);
  });

  test('people all round the globe: share above a third, or no middle at all', () => {
    const ring = Array.from({ length: 24 }, (_, i) => unit(Math.cos(i), Math.sin(i), 0.1));
    expect(spreadOf(ring).share).toBeGreaterThan(1 / 3);
    const balanced = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const out = spreadOf(balanced);
    expect(out.dir).toBeNull();
    expect(out.share).toBe(1);
  });

  test('one stray person does not decide the view', () => {
    const bunch = Array.from({ length: 19 }, (_, i) => unit(0.02 * Math.cos(i), 0.02 * Math.sin(i), 1));
    const { share } = spreadOf([...bunch, [0, 0, -1]]);
    expect(share).toBeLessThan(0.05);
  });

  test('nothing lit: no direction, nothing spread', () => {
    expect(spreadOf([])).toEqual({ dir: null, angle: 0, share: 0 });
  });
});

describe('dimming of everyone outside a selection', () => {
  test('no selection dims nothing', () => {
    expect(dimLevels(0, 500)).toEqual({ person: 1, company: 1, group: 1, ray: 1 });
  });

  test('a selection dims the rest clearly, and more strongly the larger it is', () => {
    const small = dimLevels(5, 500);
    const large = dimLevels(400, 500);
    for (const k of ['person', 'company', 'group', 'ray']) {
      expect(small[k]).toBeLessThan(0.3);
      expect(large[k]).toBeLessThan(small[k]);
      expect(large[k]).toBeGreaterThan(0);
    }
  });
});

describe('colours', () => {
  test('every hex colour in the globe sits inside THEMES', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/components/network/NetworkGraph.js'), 'utf8');
    const start = src.indexOf('export const THEMES = {');
    const end = src.indexOf('\n};', start);
    const outside = src.slice(0, start) + src.slice(end);
    expect(outside.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(outside).not.toMatch(/\bdark:/);
    expect(outside).not.toMatch(/text-\[/);
  });

  test('both themes carry the lit and selected colours; source colours still exported', () => {
    for (const t of [THEMES.light, THEMES.dark]) {
      expect(t.lit).toMatch(/^#/);
      expect(t.selected).toMatch(/^#/);
      expect(t.starInk).toBeTruthy();
    }
    expect(SOURCE_COLORS.linkedin).toBeTruthy();
    expect(SOURCE_COLORS.csv).toBeTruthy();
  });
});
