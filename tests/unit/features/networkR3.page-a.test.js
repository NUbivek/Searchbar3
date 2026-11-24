/** @jest-environment jsdom */
/**
 * Network Map, round 3, first page pass (owner key page-a): the review's page
 * findings (eval/network/review-2026-11-21/findings.json), browser findings
 * B7, B8, B11 and ROUND2 R8 decisions 14 to 16. Each test reproduces one
 * finding on the invented samples (tests/fixtures/network). The globe is
 * mocked so its props can be read and its callbacks called.
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import NetworkPage from '../../../src/pages/network';
import { plainServiceText } from '../../../src/components/network/Connectors';
import { parseLinkedInConnectionsCsv, parseGenericCsv, dedupeKey } from '../../../src/utils/network/parseContacts';
import { profileNetwork } from '../../../src/utils/network/insights';
import { personNodeId } from '../../../src/utils/network/atlas';

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
const listed = () => screen.getByTestId('people-list').querySelectorAll('li[data-person]');
const BANNED = /\b(api|key|keys|token|tokens|free|paid|tier|tiers|quota)\b/i;
const row = (c, reason) => ({ contact: { key: dedupeKey(c), name: c.name, company: c.company, position: c.position }, reasons: [reason] });

/** Serve contacts as the signed-in user's saved network; `answer` replies to any question; `routes` adds others. */
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
        if (url === '/api/network/query') return answer || { question: 'q', total: 0, results: [] };
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

async function askAnything(q = 'q') {
  fireEvent.change(screen.getByLabelText('Ask your network'), { target: { value: q } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Ask$/ })); });
}

/** Upload a sample signed out through the page's own file inputs. */
async function upload(file, input) {
  const f = new File([text(file)], file, { type: 'text/csv' });
  if (typeof f.text !== 'function') f.text = async () => text(file);
  await act(async () => { fireEvent.change(screen.getByTestId(input), { target: { files: [f] } }); });
}

beforeEach(() => {
  mockGraphProps.length = 0;
  useRouter.mockReturnValue({ isReady: true, pathname: '/network', query: {}, replace: jest.fn() });
  Element.prototype.scrollIntoView = jest.fn();
  delete window.matchMedia;
});
afterEach(() => { jest.clearAllMocks(); delete global.fetch; });

describe('the list keeps what the user chose', () => {
  test('page-1: a globe move under a selection keeps the sort and the pages shown', async () => {
    await openSample('vc-investor-linkedin.csv');
    fireEvent.click(chip('role:investors'));
    fireEvent.click(screen.getByRole('radio', { name: 'A to Z' }));
    fireEvent.click(screen.getByRole('button', { name: /^Show 50 more/ }));
    expect(listed().length).toBe(100);
    const group = lastGraph().atlas.nodes.find((n) => n.type === 'group');
    act(() => { lastGraph().onViewNode(group.id); });
    expect(listed().length).toBe(100);
    expect(screen.getByRole('radio', { name: 'A to Z' }).getAttribute('aria-checked')).toBe('true');
  });

  test('page-12: a shortcut with its own order (senior leaders) can be put back in that order', async () => {
    const contacts = load('vc-investor-linkedin.csv');
    const expected = profileNetwork(load('vc-investor-linkedin.csv'));
    const s = [...expected.shortcuts, ...expected.more].find((x) => x.sort === 'company');
    expect(s).toBeTruthy();
    await open(contacts);
    const more = screen.queryByRole('button', { name: /^More/ });
    if (more) fireEvent.click(more);
    fireEvent.click(chip(s.id));
    const own = screen.getByRole('radio', { name: 'Default' });
    expect(own.getAttribute('aria-checked')).toBe('true');
    const firstOwn = listed()[0].getAttribute('data-person');
    fireEvent.click(screen.getByRole('radio', { name: 'A to Z' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Default' }));
    expect(listed()[0].getAttribute('data-person')).toBe(firstOwn);
    expect(firstOwn).toBe(s.keys[0]);
  });

  test('page-17: "Most recent" is offered only when the listed people have connection dates', async () => {
    await openSample('sales-crm.csv');
    expect(screen.queryByRole('radio', { name: 'Most recent' })).toBeNull();
  });

  test('page-17: and is offered on a LinkedIn export', async () => {
    await openSample('small-network-linkedin.csv');
    expect(screen.getByRole('radio', { name: 'Most recent' })).toBeTruthy();
  });

  test('page-9: Find folds accents', async () => {
    const contacts = load('small-network-linkedin.csv');
    contacts[0].name = 'José Núñez';
    await open(contacts);
    fireEvent.change(screen.getByLabelText('Find a person or company'), { target: { value: 'jose' } });
    expect(panelTitle()).toBe('Find “jose” · 1');
    fireEvent.change(screen.getByLabelText('Find a person or company'), { target: { value: 'NUNEZ' } });
    expect(panelTitle()).toBe('Find “NUNEZ” · 1');
  });

  test('page-11: the count sits outside the part of the title that can be cut off', async () => {
    await openSample('vc-investor-linkedin.csv');
    fireEvent.click(chip('role:investors'));
    const count = screen.getByTestId('panel-count');
    expect(count.textContent).toMatch(/112/);
    expect(count.closest('.truncate')).toBeNull();
  });
});

describe('sources and filters', () => {
  test('page-3: Remove all and a fresh upload show every source again', async () => {
    useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
    serve([]);
    render(<NetworkPage />);
    await upload('small-network-linkedin.csv', 'linkedin-file');
    await upload('sales-crm.csv', 'generic-file');
    const group = await screen.findByRole('group', { name: 'Which contacts the map shows' });
    fireEvent.click(within(group).getByRole('checkbox', { name: /LinkedIn/ }));
    window.confirm = jest.fn(() => true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Remove all/ })); });
    await upload('small-network-linkedin.csv', 'linkedin-file');
    await screen.findByTestId('readout');
    expect(screen.getByTestId('readout').textContent).toMatch(/22/);
    expect(screen.queryByText('No contacts match these filters.')).toBeNull();
  });

  test('value-20: with every source hidden the card says why, and shows no "Everyone 0"', async () => {
    const linkedin = load('small-network-linkedin.csv');
    const csv = load('sales-crm.csv').map((c) => ({ ...c, source: 'csv' }));
    await open([...linkedin, ...csv]);
    const group = screen.getByRole('group', { name: 'Which contacts the map shows' });
    fireEvent.click(within(group).getByRole('checkbox', { name: /LinkedIn/ }));
    fireEvent.click(within(group).getByRole('checkbox', { name: /CSV/ }));
    expect(screen.getByText('All sources are hidden. Turn one back on to see your network.')).toBeTruthy();
    expect(screen.queryByText('Everyone 0')).toBeNull();
  });

  test('page-15: people hidden by "direct only" are not blamed on the source filters', async () => {
    const own = load('small-network-linkedin.csv');
    const firm = load('sales-crm.csv').slice(0, 3).map((c) => ({ ...c, source: 'attio', relationship: 'firm', via: 'Sam' }));
    await open([...own, ...firm], { answer: { question: 'q', understood: [], total: 2, results: [row(own[0], 'Match'), row(firm[0], 'Match')] } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'My direct connections only' }));
    await askAnything();
    expect(screen.getByText(/1 more match is hidden by “My direct connections only”\./)).toBeTruthy();
    expect(screen.queryByText(/source filters/)).toBeNull();
  });

  test('page-m3: only real matches count as hidden, each person once', async () => {
    const linkedin = load('small-network-linkedin.csv');
    const csv = load('sales-crm.csv').map((c) => ({ ...c, source: 'csv' }));
    await open([...linkedin, ...csv], {
      answer: {
        question: 'q', understood: [], total: 2,
        results: [row(linkedin[0], 'Match'), row(csv[0], 'Match')],
        possiblyRelated: { results: [row(csv[1], 'Similar'), row(csv[0], 'Similar')], total: 2 },
      },
    });
    const group = screen.getByRole('group', { name: 'Which contacts the map shows' });
    fireEvent.click(within(group).getByRole('checkbox', { name: /CSV/ }));
    await askAnything();
    expect(screen.getByText('1 more match is hidden by the source filters above.')).toBeTruthy();
  });
});

describe('answers', () => {
  test('B7: the answer title says what the list is', async () => {
    const vc = load('vc-investor-linkedin.csv');
    // The count is everyone the answer found (its uncapped keys, R8 #9), not only the rows sent with reasons.
    const keys = vc.slice(0, 27).map((c) => dedupeKey(c));
    await open(vc, { answer: { question: 'Who do I know in Austin?', understood: ['In Austin'], total: 27, keys, results: [row(vc[0], 'In Austin')] } });
    await askAnything('Who do I know in Austin?');
    expect(panelTitle()).toBe('In Austin · 27');
  });

  test('B7: with nothing read, the question itself in quotes', async () => {
    const vc = load('vc-investor-linkedin.csv');
    await open(vc, { answer: { question: 'who matters', understood: [], total: 1, results: [row(vc[0], 'Match')] } });
    await askAnything('who matters');
    expect(panelTitle()).toBe('“who matters” · 1');
  });

  test('page-5: a row under "Through its investors" marks the bare person on the globe; one open row at a time', async () => {
    const vc = load('vc-investor-linkedin.csv');
    const p = vc[3];
    const answer = {
      question: 'Intro paths to Stripe', intent: 'intro-path', understood: [], total: 1, results: [],
      intro: {
        target: 'Stripe', direct: [row(p, 'Works at Stripe')], possiblyRelated: [row(p, 'Similar')],
        viaInvestors: [{ investor: 'Goldman Sachs', evidence: 'led a round', total: 1, contacts: [row(vc[5], 'At Goldman Sachs')] }],
      },
    };
    await open(vc, { answer });
    await askAnything('Intro paths to Stripe');
    const via = document.querySelector(`[data-person="${personNodeId(vc[5])}"]`);
    fireEvent.click(within(via).getAllByRole('button')[0]);
    expect(lastGraph().selectedId).toBe(personNodeId(vc[5]));
    expect(lastGraph().atlas.byId.has(lastGraph().selectedId)).toBe(true);
    // The same person under Direct and Possibly related: opening one opens only that row.
    const both = document.querySelectorAll(`[data-person="${personNodeId(p)}"]`);
    expect(both.length).toBe(2);
    fireEvent.click(within(both[1]).getAllByRole('button')[0]);
    expect(screen.getAllByTestId('row-details').length).toBe(1);
    expect(both[1].querySelector('[data-testid="row-details"]')).toBeTruthy();
    expect(lastGraph().selectedId).toBe(personNodeId(p));
  });

  test('page-16 and data-12: the download is named after the list, starts with a byte-order mark, and a failure says so', async () => {
    const vc = load('vc-investor-linkedin.csv');
    await open(vc, { answer: { question: 'Intro paths to Stripe', understood: [], total: 1, results: [row(vc[0], 'Match')] } });
    let blob = null;
    const names = [];
    URL.createObjectURL = jest.fn((b) => { blob = b; return 'blob:x'; });
    URL.revokeObjectURL = jest.fn();
    HTMLAnchorElement.prototype.click = jest.fn(function click() { names.push(this.download); });
    fireEvent.click(chip('role:investors'));
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(names.pop()).toBe('network-investors.csv');
    const bytes = new Uint8Array(await new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsArrayBuffer(blob); }));
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    await askAnything('Intro paths to Stripe');
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(names.pop()).toBe('network-intro-paths-to-stripe.csv');
    delete URL.createObjectURL;
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(screen.getByTestId('copy-status').textContent).toBe('Could not download');
    expect(screen.getByRole('button', { name: 'Could not download' })).toBeTruthy();
  });
});

describe('screen readers and keyboards', () => {
  test('page-6: the panel announces a search, an answer and a new selection', async () => {
    const vc = load('vc-investor-linkedin.csv');
    await open(vc, { answer: { question: 'q', understood: ['At Stripe'], total: 2, results: [row(vc[0], 'Match'), row(vc[1], 'Match')] } });
    const status = screen.getByTestId('panel-status');
    expect(status.getAttribute('role')).toBe('status');
    fireEvent.click(chip('role:investors'));
    expect(status.textContent).toBe('investors: 112 people');
    await askAnything();
    expect(status.textContent).toBe('At Stripe: 2 people');
  });

  test('page-10: Clear leaves focus in the panel, on Find', async () => {
    await openSample('vc-investor-linkedin.csv');
    fireEvent.click(chip('role:investors'));
    const clear = screen.getByRole('button', { name: 'Clear the selection' });
    clear.focus();
    fireEvent.click(clear);
    expect(document.activeElement).toBe(screen.getByLabelText('Find a person or company'));
  });

  test('page-18: a firm contact is named for screen readers', async () => {
    const own = load('small-network-linkedin.csv');
    const firm = load('sales-crm.csv').slice(0, 1).map((c) => ({ ...c, source: 'attio', relationship: 'firm', via: 'Sam Reyes' }));
    await open([...own, ...firm]);
    fireEvent.change(screen.getByLabelText('Find a person or company'), { target: { value: firm[0].name } });
    const r = listed()[0];
    expect(r.querySelector('.sr-only').textContent).toMatch(/Firm contact, through Sam Reyes/);
  });

  test('page-19: each radio group is one Tab stop and the arrow keys move in it', async () => {
    await openSample('lp-fundraising-list.csv');
    for (const name of ['Sort people', 'Arrange by']) {
      const g = screen.getByRole('radiogroup', { name });
      const radios = within(g).getAllByRole('radio');
      expect(radios.filter((r) => r.tabIndex === 0).length).toBe(1);
    }
    const sort = screen.getByRole('radiogroup', { name: 'Sort people' });
    const checked = within(sort).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true');
    fireEvent.keyDown(checked, { key: 'ArrowRight' });
    const now = within(sort).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true');
    expect(now).not.toBe(checked);
    expect(document.activeElement).toBe(now);
  });

  test('page-21: Copy says what happened in a status region', async () => {
    await openSample('small-network-linkedin.csv');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: jest.fn(async () => {}) }, configurable: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
    expect(screen.getByTestId('copy-status').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('copy-status').textContent).toBe('Copied');
  });

  test('page-m2: the breadcrumb marks where you are', async () => {
    await openSample('vc-investor-linkedin.csv');
    const nav = screen.getByRole('navigation', { name: 'Where you are on the map' });
    const crumbs = within(nav).getAllByRole('button');
    expect(crumbs[crumbs.length - 1].getAttribute('aria-current')).toBe('location');
  });

  test('page-20: scrolling respects reduced motion', async () => {
    window.matchMedia = jest.fn((q) => ({ matches: /reduce/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    const vc = load('vc-investor-linkedin.csv');
    await open(vc, { answer: { question: 'q', understood: [], total: 1, results: [row(vc[0], 'Match')] } });
    await askAnything();
    const calls = Element.prototype.scrollIntoView.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    calls.forEach(([o]) => expect(o.behavior).toBe('auto'));
  });

  test('page-14: small controls get a phone-sized target', async () => {
    await openSample('small-network-linkedin.csv');
    const targets = [
      ...within(screen.getByRole('radiogroup', { name: 'Sort people' })).getAllByRole('radio'),
      screen.getByRole('button', { name: 'Copy' }),
      screen.getByRole('button', { name: 'Download CSV' }),
      ...within(screen.getByRole('group', { name: 'Shortcuts' })).getAllByRole('button'),
      ...within(screen.getByLabelText('Example questions')).getAllByRole('button'),
      listed()[0].querySelector('a[aria-label^="Profile of"]'),
    ];
    targets.forEach((el) => expect(el.className).toMatch(/\bmin-h-9\b/));
  });
});

describe('phone layout and plain words', () => {
  test('B8: on a phone the group rows fold to one line and the list has most of the screen', async () => {
    await openSample('lp-fundraising-list.csv');
    const toggle = screen.getByRole('button', { name: /groups here/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const rows = screen.getByLabelText('Groups in view');
    expect(rows.className).toMatch(/\bhidden\b/);
    expect(rows.className).toMatch(/\blg:block\b/);
    fireEvent.click(toggle);
    expect(rows.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByLabelText('People').closest('.network-panel')).toBeTruthy();
    const css = fs.readFileSync(path.resolve(__dirname, '../../../src/styles/globals.css'), 'utf8');
    expect(css).toMatch(/\.network-panel\s*\{[^}]*height:\s*(6\d|7\d|8\d)vh/);
  });

  test('B11: an opened row says why in plain words, never the classifier\'s inner words', async () => {
    await openSample('lp-fundraising-list.csv');
    fireEvent.change(screen.getByLabelText('Find a person or company'), { target: { value: 'Zuri Calloway' } });
    const r = listed()[0];
    fireEvent.click(within(r).getAllByRole('button')[0]);
    const d = within(r).getByTestId('row-details').textContent;
    expect(d).not.toMatch(/Title and company:|Title: "|Company: /);
    expect(d).toMatch(/Tagged “passed”/);
    expect(d).toMatch(/Counted as an? [a-z]/);
  });

  test('page-23: the empty state promises only what is true', async () => {
    serve([]);
    useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
    render(<NetworkPage />);
    expect(await screen.findByText(/Your contacts are never shared and never sent to a model\./)).toBeTruthy();
    expect(screen.queryByText(/Everything stays private/)).toBeNull();
  });

  test('page-8: X and Attio messages are put in plain words', async () => {
    const attio = [
      'Paste an Attio API access token.',
      'Attio rejected this token.',
      'This token cannot read people records. Create a token with the "record permission: read-write" or "read" scope for People and Companies.',
      'The token cannot read workspace members, so every contact was saved as firm-wide. Create a token with the "user management: read" scope to mark your own connections as direct.',
      'Attio API error 500',
    ];
    attio.forEach((t) => {
      const out = plainServiceText('attio', t);
      expect(out).not.toMatch(BANNED);
      expect(out).toMatch(/Attio/);
    });
    expect(plainServiceText('attio', 'Attio rejected this token.')).toMatch(/access code/);
    expect(plainServiceText('x', 'Twitter API rate limit exceeded')).not.toMatch(BANNED);
    expect(plainServiceText('x', 'X does not share who you follow with this app yet. You can still upload your X following list as a JSON file in the X API format, or add the people to a CSV.')).not.toMatch(BANNED);
    // Plain text is left as it is.
    expect(plainServiceText('x', 'X returned an empty following list.')).toBe('X returned an empty following list.');
  });

  test('page-8: an X import that fails never shows a banned word on the page', async () => {
    await openSample('small-network-linkedin.csv', {
      routes: {
        '/api/auth/twitter/token': { body: { authenticated: true, profile: { username: 'me' } } },
        '/api/network/twitter': { body: { followingAvailable: false, note: 'X does not share who you follow with this app yet. You can still upload your X following list as a JSON file in the X API format, or add the people to a CSV.' } },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add or replace' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Import follows' })); });
    await waitFor(() => expect(document.body.textContent).toMatch(/does not share who you follow/));
    expect(document.body.textContent).not.toMatch(BANNED);
  });
});
