/** @jest-environment jsdom */
/**
 * Round 3, the page with the real globe (page-24): the Network Map page is
 * rendered with the real NetworkGraph on a stub canvas, so a click on the
 * globe reaches the page through the component itself, as it does in a
 * browser. Covers ROUND2 R5 and R6 and browser findings B1 (page side), B4,
 * B12 and B13 end to end, and globe-m1. Animation frames and the clock are
 * driven by hand. All people are invented (tests/fixtures/network).
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import NetworkPage from '../../../src/pages/network';
import { hitTest } from '../../../src/components/network/NetworkGraph';
import { parseLinkedInConnectionsCsv, parseGenericCsv } from '../../../src/utils/network/parseContacts';

jest.mock('next/head', () => function Head({ children }) { return <>{children}</>; });
jest.mock('next/link', () => function Link({ children, href, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next/router', () => ({ useRouter: jest.fn() }));
jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));
jest.mock('../../../src/components/account/AccountMenu', () => function AccountMenu() { return null; });

const { useRouter } = require('next/router');
const { useSession } = require('next-auth/react');

const DIR = path.resolve(__dirname, '../../fixtures/network');
const text = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');
const load = (file) => {
  const r = file.includes('linkedin') ? parseLinkedInConnectionsCsv(text(file)) : parseGenericCsv(text(file));
  return (r.contacts || r).map((c) => ({ ...c }));
};
const panelTitle = () => screen.getByTestId('panel-title').textContent.replace(/\s+/g, ' ').trim();
const chip = (id) => document.querySelector(`[data-shortcut="${id}"]`);
const breadcrumb = () => within(screen.getByRole('navigation', { name: 'Where you are on the map' })).getAllByRole('button')
  .map((b) => b.textContent.replace(/\s+/g, ' ').trim());
const litBadge = () => [...document.querySelectorAll('[aria-live="polite"]')].map((e) => e.textContent).find((t) => /lit$/.test(t)) || '';

// ------------------------------------------------------------ a browser by hand

let clock = 1000;
let frames = [];

/** A 2D context that draws nothing. */
function stubContext() {
  const ctx = {
    font: '10px sans', globalAlpha: 1, letterSpacing: '0px', lineDashOffset: 0,
    measureText(t) { const m = /([\d.]+)px/.exec(this.font); return { width: String(t).length * (m ? Number(m[1]) : 10) * 0.56 }; },
    createRadialGradient() { return { addColorStop() {} }; },
  };
  for (const k of ['fillText', 'fill', 'beginPath', 'arc', 'setTransform', 'clearRect', 'moveTo', 'lineTo', 'stroke', 'quadraticCurveTo', 'arcTo', 'closePath', 'setLineDash', 'fillRect', 'strokeText']) {
    ctx[k] = () => {};
  }
  return ctx;
}

/** Run queued animation frames, 16 ms apart, until none is queued. */
function flush(max = 600) {
  let n = 0;
  act(() => {
    while (frames.length && n < max) {
      const batch = frames; frames = [];
      clock += 16;
      for (const cb of batch) { cb(clock); n += 1; }
    }
  });
  return n;
}

const canvas = () => document.querySelector('canvas');
const targets = () => canvas().mapTargets || [];
const centreOf = (box) => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
function click(x, y) {
  fireEvent.pointerDown(canvas(), { clientX: x, clientY: y, pointerId: 1, button: 0 });
  fireEvent.pointerUp(canvas(), { clientX: x, clientY: y, pointerId: 1, button: 0 });
  flush();
}
/** The label drawn for a top-layer node, found by its key. */
function labelOf(key) {
  const t = targets().find((x) => x.kind === 'label' && x.node.depth === 1 && x.node.key === key);
  expect(t).toBeTruthy();
  return t;
}
/** A point on the canvas where nothing can be clicked. */
function emptyPoint() {
  for (let y = 10; y < 600; y += 20) for (let x = 10; x < 880; x += 20) if (!hitTest(targets(), x, y)) return [x, y];
  throw new Error('no empty point');
}
/** Back to the whole globe, as the user would with "Fit to view". */
function home() { fireEvent.click(screen.getByLabelText('Fit to view')); flush(); }

beforeAll(() => {
  if (typeof window.PointerEvent !== 'function') {
    window.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
    };
  }
  // The page sizes the globe from its box: give the box a desktop width.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 900; } });
});

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
  Element.prototype.scrollIntoView = jest.fn();
  useRouter.mockReturnValue({ isReady: true, pathname: '/network', query: {}, replace: jest.fn() });
});
afterEach(() => { jest.restoreAllMocks(); delete global.fetch; });

async function openSample(file) {
  const contacts = load(file);
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url === '/api/network/contacts') return { contacts, stats: { total: contacts.length, bySource: {}, lastImportAt: null, lastImportBySource: {} } };
      if (url === '/api/founder/history') return { checks: [], running: [] };
      return {};
    },
  }));
  useSession.mockReturnValue({ data: { user: { name: 'Test User' } }, status: 'authenticated' });
  render(<NetworkPage />);
  await screen.findByTestId('readout');
  flush();
  expect(canvas()).toBeTruthy();
  return contacts;
}

describe('a click on the real globe reaches the page (page-24, R5, B12, B13)', () => {
  test('LP list By tag: a click on the "cold" label selects everyone tagged cold, opens it and presses its chip', async () => {
    await openSample('lp-fundraising-list.csv');
    expect(breadcrumb()).toEqual(['All 114']);
    const [x, y] = centreOf(labelOf('cold').box);
    click(x, y);
    expect(panelTitle()).toBe('tagged “cold” · 23');
    expect(chip('tag:cold').getAttribute('aria-pressed')).toBe('true');
    expect(litBadge()).toBe('23 lit');
    // R5, R6: the click opened the group, and the breadcrumb names it.
    expect(breadcrumb()).toEqual(['All', 'cold 23']);

    // With "cold" lit and the other labels dimmed, a click on "committed" still selects it.
    home();
    const [cx, cy] = centreOf(labelOf('committed').box);
    click(cx, cy);
    expect(panelTitle()).toBe('tagged “committed” · 20');
    expect(chip('tag:committed').getAttribute('aria-pressed')).toBe('true');
    expect(chip('tag:cold').getAttribute('aria-pressed')).toBe('false');
  });

  test('globe-m1: a background click clears the selection, and so does Escape on the map', async () => {
    await openSample('lp-fundraising-list.csv');
    const [x, y] = centreOf(labelOf('cold').box);
    click(x, y);
    expect(litBadge()).toBe('23 lit');
    home();
    const [bx, by] = emptyPoint();
    click(bx, by);
    expect(panelTitle()).toBe('Everyone · 114');
    expect(litBadge()).toBe('');
    expect(chip('tag:cold').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(chip('tag:cold'));
    flush();
    expect(litBadge()).toBe('23 lit');
    fireEvent.keyDown(canvas(), { key: 'Escape' });
    flush();
    expect(panelTitle()).toBe('Everyone · 114');
    expect(litBadge()).toBe('');
  });

  test('B1: on the healthcare file the globe\'s groups are its own roles; a click on "Clinicians" is the clinicians chip', async () => {
    await openSample('healthcare-academic.csv');
    const tops = targets().filter((t) => t.kind === 'label' && t.node.depth === 1).map((t) => t.node.label);
    expect(tops).toEqual(expect.arrayContaining(['Clinicians', 'Researchers & academics']));
    expect(tops.join(' ')).not.toMatch(/Founders & executives|Operators & talent|Investors & LPs|Experts & advisors/);
    const [x, y] = centreOf(labelOf('clinicians').box);
    click(x, y);
    expect(panelTitle()).toBe('clinicians · 100');
    expect(chip('role:clinicians').getAttribute('aria-pressed')).toBe('true');
    expect(breadcrumb()).toEqual(['All', 'Clinicians 100']);
  });
});

describe('the breadcrumb follows the user, not the camera (R6, B4)', () => {
  test('pressing shortcuts turns the globe to the lit people but leaves the breadcrumb at All', async () => {
    await openSample('vc-investor-linkedin.csv');
    expect(breadcrumb()).toEqual(['All 544']);
    for (const id of ['role:investors', 'company:stripe', 'role:engineers']) {
      fireEvent.click(chip(id));
      flush();
      expect(breadcrumb()).toEqual(['All 544']);
    }
    expect(litBadge()).toMatch(/lit$/);
  });

  test('a person row opened in the list does not move the breadcrumb either', async () => {
    await openSample('vc-investor-linkedin.csv');
    fireEvent.click(chip('company:stripe'));
    flush();
    const row = document.querySelector('aside[aria-label="People"] li[data-person]');
    fireEvent.click(within(row).getAllByRole('button')[0]);
    flush();
    expect(breadcrumb()).toEqual(['All 544']);
  });
});
