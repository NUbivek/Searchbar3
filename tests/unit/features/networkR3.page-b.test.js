/** @jest-environment jsdom */
/**
 * Round 3, the page (second pass): review findings page-2, page-7, page-13,
 * page-22, value-18, value-19, globe-m1, globe-m3, the page side of page-m1
 * and ask-3, and browser findings B2, B3, B4 (page side), B13. ROUND2 R1, R3,
 * R5 to R7 and R8 #9 and #10 as they show on the page. All people are
 * invented (tests/fixtures/network). The globe is mocked here so its props
 * can be read; networkR3.page-b.globe.test.js renders the real one.
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { parseLinkedInConnectionsCsv, parseGenericCsv, dedupeKey } from '../../../src/utils/network/parseContacts';
import { profileNetwork } from '../../../src/utils/network/insights';
import { personNodeId } from '../../../src/utils/network/atlas';
import { FAMILIES } from '../../../src/utils/network/roles';

jest.mock('next/head', () => function Head({ children }) { return <>{children}</>; });
jest.mock('next/link', () => function Link({ children, href, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next/router', () => ({ useRouter: jest.fn() }));
jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));
jest.mock('../../../src/components/account/AccountMenu', () => function AccountMenu() { return null; });
const mockGraphProps = [];
jest.mock('../../../src/components/network/NetworkGraph', () => ({
  __esModule: true,
  default: function NetworkGraphMock(props) {
    mockGraphProps.push(props);
    return <div data-testid="graph">{props.children}</div>;
  },
  SOURCE_COLORS: { linkedin: '#0077B5', x: '#000000', csv: '#6B7280', attio: '#5B5BD6' },
}));

// The Attio form is shown only when the deployment turns it on: on here, so
// its words are checked too. Read when the page module loads.
process.env.NEXT_PUBLIC_ATTIO_ENABLED = 'true';
const NetworkPage = require('../../../src/pages/network').default;

const { useRouter } = require('next/router');
const { useSession } = require('next-auth/react');

const DIR = path.resolve(__dirname, '../../fixtures/network');
const text = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');
const load = (file) => {
  const r = file.includes('linkedin') ? parseLinkedInConnectionsCsv(text(file)) : parseGenericCsv(text(file));
  return (r.contacts || r).map((c) => ({ ...c }));
};
const lastGraph = () => mockGraphProps[mockGraphProps.length - 1];
const panelTitle = () => screen.getByTestId('panel-title').textContent.replace(/\s+/g, ' ').trim();
const chip = (id) => document.querySelector(`[data-shortcut="${id}"]`);
const listed = () => document.querySelectorAll('aside[aria-label="People"] li[data-person]');
const BANNED = /\b(api|key|keys|token|tokens|free|paid|tier|tiers|quota)\b/i;
const BANNED_LENS = /\b(Raise|Source|Diligence)\b/;
const row = (c, reason) => ({ contact: { key: dedupeKey(c), name: c.name, company: c.company, position: c.position }, reasons: [reason] });

function serve(contacts, { answer, routes = {} } = {}) {
  const seen = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const custom = routes[String(url)];
    if (custom) return { ok: custom.status ? custom.status < 400 : true, status: custom.status || 200, json: async () => custom.body };
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (url === '/api/network/contacts' && opts.method === 'DELETE') return { stats: { total: 0 } };
        if (url === '/api/network/contacts') return { contacts, stats: { total: contacts.length, bySource: {}, lastImportAt: null, lastImportBySource: {} } };
        if (url === '/api/founder/history') return { checks: [], running: [] };
        if (url === '/api/network/query') return typeof answer === 'function' ? answer(JSON.parse(opts.body)) : answer || { question: 'q', total: 0, results: [], keys: [] };
        return {};
      },
    };
  });
  return seen;
}

async function open(contacts, opts) {
  const seen = serve(contacts, opts);
  useSession.mockReturnValue({ data: { user: { name: 'Test User' } }, status: 'authenticated' });
  render(<NetworkPage />);
  await screen.findByTestId('readout');
  return seen;
}
const openSample = (file, opts) => open(load(file), opts);
const queries = (seen) => seen.filter((c) => c.url === '/api/network/query');

async function askAnything(q = 'q') {
  fireEvent.change(screen.getByLabelText('Ask your network'), { target: { value: q } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Ask$/ })); });
}

beforeEach(() => {
  mockGraphProps.length = 0;
  useRouter.mockReturnValue({ isReady: true, pathname: '/network', query: {}, replace: jest.fn() });
  Element.prototype.scrollIntoView = jest.fn();
});
afterEach(() => { jest.clearAllMocks(); delete global.fetch; });

// ------------------------------------------------------------ shortcuts (R1, B2)

describe('shortcuts switch; nothing greys out (B2, value-18, value-19, page-13, page-22)', () => {
  test('after pressing a chip every other chip keeps its own label, stays in the Tab order and is one click away', async () => {
    const expected = profileNetwork(load('vc-investor-linkedin.csv'));
    await openSample('vc-investor-linkedin.csv');
    fireEvent.click(chip('role:investors'));
    for (const s of expected.shortcuts) {
      const b = chip(s.id);
      // value-19: no number changes silently; value-18 and page-13: nothing disabled, nothing out of the Tab order.
      expect(b.textContent).toBe(s.label);
      expect(b.disabled).toBe(false);
      expect(b.hasAttribute('aria-disabled')).toBe(false);
      expect(b.getAttribute('tabindex')).not.toBe('-1');
    }
    // page-22: going from investors to Stripe is one click, not "0 at Stripe".
    fireEvent.click(chip('company:stripe'));
    expect(panelTitle()).toBe('at Stripe · 22');
    // Narrowing has its own row, named, in the list (the card never asks the user to work out AND).
    expect(screen.getByRole('group', { name: 'Narrow to' })).toBeTruthy();
  });

  test('three parts at most: with three, "Narrow to" is gone rather than greyed', async () => {
    await openSample('healthcare-academic.csv');
    fireEvent.click(chip('role:clinicians'));
    for (let i = 0; i < 2; i += 1) {
      const btn = within(screen.getByRole('group', { name: 'Narrow to' })).getAllByRole('button')[0];
      fireEvent.click(btn);
    }
    expect(within(screen.getByLabelText('This list is')).getAllByRole('button')).toHaveLength(3);
    expect(screen.queryByRole('group', { name: 'Narrow to' })).toBeNull();
    expect(document.querySelector('[data-shortcut][disabled]')).toBeNull();
  });
});

describe('a selection made elsewhere that equals a shortcut shows it pressed (B13, R3)', () => {
  test('LP list, By tag: clicking the "cold" group presses the "cold" chip and lists everyone tagged cold', async () => {
    const expected = profileNetwork(load('lp-fundraising-list.csv'));
    await openSample('lp-fundraising-list.csv');
    expect(lastGraph().atlas.groupBy).toBe('tag');
    const cold = lastGraph().atlas.root.children.find((n) => n.key === 'cold');
    const s = expected.shortcuts.find((x) => x.id === 'tag:cold');
    act(() => { lastGraph().onNodeClick(cold); });
    expect(chip('tag:cold').getAttribute('aria-pressed')).toBe('true');
    expect(panelTitle()).toBe(`${s.short} · ${s.count}`);
    expect(new Set(lastGraph().highlightIds)).toEqual(new Set(s.keys));
    // Pressing the chip shown pressed goes back to everyone.
    fireEvent.click(chip('tag:cold'));
    expect(lastGraph().highlightIds.size).toBe(0);
  });

  test('VC, By role: the "Investors" group is the investors chip', async () => {
    await openSample('vc-investor-linkedin.csv');
    const inv = lastGraph().atlas.root.children.find((n) => n.key === 'investors');
    expect(inv.label).toBe('Investors');
    act(() => { lastGraph().onNodeClick(inv); });
    expect(chip('role:investors').getAttribute('aria-pressed')).toBe('true');
    expect(panelTitle()).toBe('investors · 112');
    // A list that equals a shortcut can be narrowed like one.
    expect(screen.getByRole('group', { name: 'Narrow to' })).toBeTruthy();
  });

  test('sales CRM, By tag: a person under two tags is in both tag groups, so a group selects 107, not the 89 placed there (R3)', async () => {
    await openSample('sales-crm.csv');
    const prospect = lastGraph().atlas.root.children.find((n) => n.key === 'prospect');
    expect(prospect.placed).toBeLessThan(107);
    act(() => { lastGraph().onNodeClick(prospect); });
    expect(lastGraph().highlightIds.size).toBe(107);
    expect(listed().length).toBe(50);
    expect(screen.getByRole('button', { name: /^Show 50 more of 107$/ })).toBeTruthy();
  });
});

// ------------------------------------------------------------ clearing (R5, globe-m1, globe-m3)

describe('a background click and Escape clear the selection (globe-m1, R5)', () => {
  test('whatever made the selection: a globe click, a chip, Find or an answer', async () => {
    const vc = load('vc-investor-linkedin.csv');
    await open(vc, { answer: { question: 'q', understood: [], total: 1, keys: [dedupeKey(vc[0])], results: [row(vc[0], 'Match')] } });
    const atlas = lastGraph().atlas;
    const company = atlas.nodes.find((n) => n.type === 'company' && n.key === 'stripe');
    const makers = [
      () => act(() => { lastGraph().onNodeClick(company); }),
      () => fireEvent.click(chip('role:investors')),
      () => fireEvent.change(screen.getByLabelText('Find a person or company'), { target: { value: 'stripe' } }),
      () => askAnything('q'),
    ];
    for (const make of makers) {
      await make();
      expect(lastGraph().highlightIds.size).toBeGreaterThan(0);
      act(() => { lastGraph().onBackgroundClick(); });
      expect(lastGraph().highlightIds.size).toBe(0);
      expect(panelTitle()).toBe('Everyone · 544');
      expect(screen.getByLabelText('Find a person or company').value).toBe('');
    }
  });

  test('Escape in the people list clears it too', async () => {
    await openSample('vc-investor-linkedin.csv');
    fireEvent.click(chip('role:investors'));
    fireEvent.keyDown(screen.getByLabelText('Find a person or company'), { key: 'Escape' });
    expect(lastGraph().highlightIds.size).toBe(0);
    expect(chip('role:investors').getAttribute('aria-pressed')).toBe('false');
  });

  test('globe-m3: a globe selection only ever lights people in view, and the badge and list agree', async () => {
    const linkedin = load('small-network-linkedin.csv');
    const csv = load('sales-crm.csv').map((c) => ({ ...c, source: 'csv' }));
    await open([...linkedin, ...csv]);
    const group = lastGraph().atlas.root.children[0];
    act(() => { lastGraph().onNodeClick(group); });
    fireEvent.click(within(screen.getByRole('group', { name: 'Which contacts the map shows' })).getByRole('checkbox', { name: /CSV/ }));
    const inView = new Set(lastGraph().atlas.nodes.filter((n) => n.type === 'person').map((n) => n.id));
    for (const id of lastGraph().highlightIds) expect(inView.has(id)).toBe(true);
    expect(screen.getByTestId('panel-count').textContent).toBe(`· ${lastGraph().highlightIds.size || inView.size}`);
  });
});

// ------------------------------------------------------------ answers (page-2, page-7, R8 #9)

describe('an answer lights, counts, lists, copies and downloads everyone it found', () => {
  function capture() {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const blobs = [];
    URL.createObjectURL = jest.fn((b) => { blobs.push(b); return 'blob:x'; });
    URL.revokeObjectURL = jest.fn();
    HTMLAnchorElement.prototype.click = jest.fn();
    return { writeText, blobs };
  }
  const readBlob = (blob) => new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsText(blob); });

  test('page-2: "Which investors do I know? 112" lights 112, says 112, lists 112 a page at a time, copies and downloads 112', async () => {
    const vc = load('vc-investor-linkedin.csv');
    const expected = profileNetwork(load('vc-investor-linkedin.csv'));
    const investors = expected.shortcuts.find((s) => s.id === 'role:investors');
    const byId = new Map(vc.map((c) => [personNodeId(c), c]));
    const people = investors.keys.map((id) => byId.get(id));
    const answer = {
      question: 'Which investors do I know?', understood: ['investors'], total: 112,
      keys: people.map((c) => dedupeKey(c)),
      // The engine sends reasons for the first hundred only.
      results: people.slice(0, 100).map((c) => row(c, 'Investor by title')),
    };
    const seen = await open(vc, { answer });
    const { writeText, blobs } = capture();
    await act(async () => { fireEvent.click(within(screen.getByLabelText('Example questions')).getByText('Which investors do I know?')); });
    expect(queries(seen)[0].body.fromPage).toBe(true);
    expect(lastGraph().highlightIds.size).toBe(112);
    expect(panelTitle()).toBe('investors · 112');
    // The same people as the shortcut: its chip shows pressed.
    expect(chip('role:investors').getAttribute('aria-pressed')).toBe('true');
    expect(listed().length).toBe(50);
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more of 112' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show 12 more of 112' }));
    expect(listed().length).toBe(112);
    expect(screen.queryByText(/Top 100 of/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
    expect(writeText.mock.calls[0][0].split('\n')).toHaveLength(112);
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    const csv = await readBlob(blobs[0]);
    expect(csv.trim().split('\n')).toHaveLength(113);
    // It pages through 112 people in jsdom: about 5 s alone on a busy machine,
    // so the 5 s default timed it out inside the full suite.
  }, 20000);

  test('page-7: intro paths count everyone listed and lit, direct and through investors', async () => {
    const vc = load('vc-investor-linkedin.csv');
    const direct = vc.filter((c) => /^stripe$/i.test(c.company)).slice(0, 2);
    const via = vc.filter((c) => /^goldman sachs$/i.test(c.company)).slice(0, 3);
    const answer = {
      question: 'Intro paths to Stripe', intent: 'intro-path', understood: ['At Stripe'], total: 2, keys: direct.map(dedupeKey),
      results: direct.map((c) => row(c, 'Works at Stripe')),
      intro: {
        target: 'Stripe', direct: direct.map((c) => row(c, 'Works at Stripe')), directTotal: 2, keys: direct.map(dedupeKey), possiblyRelated: [],
        viaInvestors: [{ investor: 'Goldman Sachs', evidence: 'led a round', total: 3, contacts: via.map((c) => row(c, 'At Goldman Sachs')) }],
        investorsChecked: ['Goldman Sachs'],
      },
    };
    await open(vc, { answer });
    const { writeText } = capture();
    fireEvent.click(chip('company:stripe'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Intro paths to Stripe/ })); });
    expect(panelTitle()).toBe('Intro paths to Stripe · 5');
    expect(lastGraph().highlightIds.size).toBe(5);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
    expect(writeText.mock.calls[0][0].split('\n')).toHaveLength(5);
    expect(screen.getByText(/Direct: people at Stripe/).textContent).toMatch(/2$/);
  });

  test('the answer\'s notes are shown, "Not used" and the ask for a company or field among them', async () => {
    const vc = load('vc-investor-linkedin.csv');
    await open(vc, {
      answer: {
        question: 'diligence experts please', understood: [], total: 0, keys: [], results: [],
        notes: ['Not used: “please”.', 'That would list most of your network. Name a company or a field to narrow it, e.g. “experts in fintech” or “who knows about Stripe”.'],
      },
    });
    await askAnything('diligence experts please');
    expect(screen.getByText('Not used: “please”.')).toBeTruthy();
    expect(screen.getByText(/Name a company or a field/)).toBeTruthy();
  });
});

// ------------------------------------------------------------ what is sent (page-m1, ask-3, R8 #10)

describe('what the page sends with a question (page-m1, ask-3)', () => {
  test('signed in with a source turned off: the source filters and "direct only" go with the question, with the browser\'s date', async () => {
    const linkedin = load('small-network-linkedin.csv');
    const csv = load('sales-crm.csv').map((c) => ({ ...c, source: 'csv' }));
    const seen = await open([...linkedin, ...csv]);
    fireEvent.click(within(screen.getByRole('group', { name: 'Which contacts the map shows' })).getByRole('checkbox', { name: /CSV/ }));
    await askAnything('who is in Boston');
    const body = queries(seen)[0].body;
    expect(body.filters).toEqual({ directOnly: false, sources: ['linkedin'] });
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.contacts).toBeUndefined();
    expect(body.fromPage).toBeUndefined();
  });

  test('signed out: only the people in view are sent, never an email', async () => {
    useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
    const seen = serve([]);
    render(<NetworkPage />);
    const f = new File([text('small-network-linkedin.csv')], 'Connections.csv', { type: 'text/csv' });
    if (typeof f.text !== 'function') f.text = async () => text('small-network-linkedin.csv');
    await act(async () => { fireEvent.change(screen.getByTestId('linkedin-file'), { target: { files: [f] } }); });
    const g = new File([text('sales-crm.csv')], 'crm.csv', { type: 'text/csv' });
    if (typeof g.text !== 'function') g.text = async () => text('sales-crm.csv');
    await act(async () => { fireEvent.change(screen.getByTestId('generic-file'), { target: { files: [g] } }); });
    fireEvent.click(within(screen.getByRole('group', { name: 'Which contacts the map shows' })).getByRole('checkbox', { name: /CSV/ }));
    await askAnything('who is in Boston');
    const body = queries(seen)[0].body;
    expect(body.contacts).toHaveLength(22);
    expect(body.contacts.every((c) => c.source === 'linkedin' && !('email' in c))).toBe(true);
  });

  test('ask-3: "Intro paths" sends the company as data and no question; examples and report links are marked as built by the page', async () => {
    useRouter.mockReturnValue({ isReady: true, pathname: '/network', query: { ask: 'Who do I know at Stripe?' }, replace: jest.fn() });
    const seen = await openSample('vc-investor-linkedin.csv');
    await waitFor(() => expect(queries(seen)).toHaveLength(1));
    expect(queries(seen)[0].body).toMatchObject({ question: 'Who do I know at Stripe?', fromPage: true });
    fireEvent.click(chip('company:stripe'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Intro paths to Stripe/ })); });
    const intro = queries(seen)[1].body;
    expect(intro.target).toBe('Stripe');
    expect(intro.question).toBeUndefined();
    const example = within(screen.getByLabelText('Example questions')).getAllByRole('button')[0];
    await act(async () => { fireEvent.click(example); });
    expect(queries(seen)[2].body).toMatchObject({ fromPage: true });
    // A question typed by the user is not marked.
    await askAnything('anyone who knows about payments');
    expect(queries(seen)[3].body.fromPage).toBeUndefined();
  });

  test('a refused question shows the route\'s plain words', async () => {
    await openSample('small-network-linkedin.csv', {
      routes: { '/api/network/query': { status: 400, body: { error: 'There are no contacts to search yet. Add your contacts first.' } } },
    });
    await askAnything('who');
    expect(screen.getByRole('alert').textContent).toBe('There are no contacts to search yet. Add your contacts first.');
  });
});

// ------------------------------------------------------------ words (B3, R7, value-9)

describe('plain words on the page', () => {
  test('B3: row tags are the short family tags, never "… person"', async () => {
    await openSample('founder-operator-linkedin.csv');
    const tags = new Set(FAMILIES.map((f) => f.tag).filter(Boolean));
    const chips = [...listed()].map((li) => li.querySelector('.chip')).filter(Boolean).map((c) => c.textContent);
    expect(chips.length).toBeGreaterThan(10);
    chips.forEach((t) => expect(tags.has(t)).toBe(true));
    expect(chips.some((t) => /person|people| or accounting| or marketing/.test(t))).toBe(false);
  });

  test('R7, B10: in the read-out only counts are bold; "met 2026" stays plain', async () => {
    const expected = profileNetwork(load('lp-fundraising-list.csv'));
    await openSample('lp-fundraising-list.csv');
    const readout = screen.getByTestId('readout');
    const bold = [...readout.querySelectorAll('strong')].map((b) => b.textContent);
    expect(bold).toEqual(expected.parts.flat().filter((p) => p.bold).map((p) => p.text));
    expect(bold).not.toContain('2026');
    expect(readout.textContent).toContain('“met 2026”');
  });

  test('value-9: a company read from email addresses ("at stripe.com") offers no company profile or intro paths', async () => {
    const people = Array.from({ length: 12 }, (_, i) => ({
      name: `Person ${i}`, company: '', position: i % 2 ? 'Engineer' : 'Designer',
      email: `p${i}@${i < 6 ? 'stripe.com' : i < 10 ? 'ramp.com' : 'gmail.com'}`, source: 'csv', tags: [],
    }));
    const profile = profileNetwork(people.map((c) => ({ ...c })));
    expect(profile.companyFrom).toBe('email');
    await open(people);
    const s = [...profile.shortcuts, ...profile.more].find((x) => x.type === 'company');
    expect(s.short).toBe('at stripe.com');
    fireEvent.click(chip(s.id));
    expect(panelTitle()).toBe('at stripe.com · 6');
    expect(screen.queryByText('Company profile')).toBeNull();
    expect(screen.queryByRole('button', { name: /Intro paths/ })).toBeNull();
  });

  test('page-24: no banned word with an answer, its notes, an Attio error and the Attio form on screen', async () => {
    const vc = load('vc-investor-linkedin.csv');
    await open(vc, {
      answer: { question: 'q', understood: ['At Stripe'], total: 1, keys: [dedupeKey(vc[0])], results: [row(vc[0], 'Works at Stripe')], notes: ['Not used: “q”.'] },
      routes: { '/api/network/attio': { status: 401, body: { error: 'Attio rejected the API token (401): missing scope' } } },
    });
    await askAnything('q');
    fireEvent.click(screen.getByRole('button', { name: 'Add or replace' }));
    fireEvent.click(screen.getByRole('button', { name: /Connect Attio|Re-import from Attio/ }));
    fireEvent.change(screen.getByLabelText('Attio access code'), { target: { value: 'abc' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Import from Attio' })); });
    expect(screen.getByRole('alert')).toBeTruthy();
    const t = document.body.textContent;
    expect(t).not.toMatch(BANNED);
    expect(t).not.toMatch(BANNED_LENS);
    const attrs = [...document.querySelectorAll('[placeholder],[title],[aria-label]')].map((el) => `${el.getAttribute('placeholder') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`).join(' ');
    expect(attrs).not.toMatch(BANNED);
  });
});

describe('a file nothing splits (value-9, insights handover)', () => {
  test('names only: one sentence, no "Arrange by", the globe shows people ungrouped, Find still works', async () => {
    const people = Array.from({ length: 15 }, (_, i) => ({ name: `Name Only ${i}`, company: '', position: '', source: 'csv', tags: [] }));
    const profile = profileNetwork(people.map((c) => ({ ...c })));
    expect(profile.defaultGrouping).toBeNull();
    await open(people);
    expect(lastGraph().atlas.groupBy).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Arrange by' })).toBeNull();
    expect(screen.getByTestId('readout').textContent).toBe(profile.sentences.join(' '));
    fireEvent.change(screen.getByLabelText('Find a person or company'), { target: { value: 'only 1' } });
    expect(panelTitle()).toMatch(/^Find “only 1” · \d+$/);
  });
});
