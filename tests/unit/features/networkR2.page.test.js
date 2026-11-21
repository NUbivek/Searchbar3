/** @jest-environment jsdom */
/**
 * Network Map, round 2, the page (spec eval/network/design-2026-11-21/SPEC.md
 * sections 1, 2, 5, 6, 7 and 9): the read-out, the shortcuts built from the
 * file, the one selection that drives the globe and the people panel, the
 * answer in the panel, "Arrange by", "Remove all" and the banned words. All
 * people are invented (tests/fixtures/network). The globe is mocked so its
 * props can be read.
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import NetworkPage from '../../../src/pages/network';
import { parseLinkedInConnectionsCsv, parseGenericCsv, dedupeKey } from '../../../src/utils/network/parseContacts';
import { profileNetwork, combine, countIfAdded } from '../../../src/utils/network/insights';
import { personNodeId } from '../../../src/utils/network/atlas';

jest.mock('next/head', () => function Head({ children }) { return <>{children}</>; });
jest.mock('next/link', () => function Link({ children, href, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next/router', () => ({ useRouter: jest.fn() }));
jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));
jest.mock('../../../src/components/account/AccountMenu', () => function AccountMenu() { return null; });
// Every render of the globe is recorded, so a test can read what it was given.
const mockGraphProps = [];
jest.mock('../../../src/components/network/NetworkGraph', () => ({
  __esModule: true,
  default: function NetworkGraphMock(props) {
    mockGraphProps.push(props);
    return <div data-testid="graph" data-lit={props.highlightIds ? props.highlightIds.size : 0}>{props.children}</div>;
  },
  SOURCE_COLORS: { linkedin: '#0077B5', x: '#000000', csv: '#6B7280', attio: '#5B5BD6' },
}));

const { useRouter } = require('next/router');
const { useSession } = require('next-auth/react');

const DIR = path.resolve(__dirname, '../../fixtures/network');
const FILES = ['vc-investor-linkedin.csv', 'founder-operator-linkedin.csv', 'sales-crm.csv', 'healthcare-academic.csv', 'lp-fundraising-list.csv', 'small-network-linkedin.csv'];
const text = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');
/** A fresh copy of a sample's contacts (the classifier caches per object). */
const load = (file) => {
  const r = file.includes('linkedin') ? parseLinkedInConnectionsCsv(text(file)) : parseGenericCsv(text(file));
  return (r.contacts || r).map((c) => ({ ...c }));
};
const lastGraph = () => mockGraphProps[mockGraphProps.length - 1];
const panelTitle = () => screen.getByTestId('panel-title').textContent.replace(/\s+/g, ' ').trim();
const chip = (id) => document.querySelector(`[data-shortcut="${id}"]`);
const listed = () => screen.getByTestId('people-list').querySelectorAll('li[data-person]');
const BANNED = /\b(api|key|keys|token|tokens|free|paid|tier|tiers|quota)\b/i;
const BANNED_LENS = /\b(Raise|Source|Diligence)\b/;

/** Serve one sample as the signed-in user's saved contacts; `answer` is the reply to any question. */
function serve(contacts, { answer } = {}) {
  const seen = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
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

async function openSample(file, opts) {
  const contacts = load(file);
  const seen = serve(contacts, opts);
  useSession.mockReturnValue({ data: { user: { name: 'Test User' } }, status: 'authenticated' });
  render(<NetworkPage />);
  await screen.findByTestId('readout');
  return { contacts, seen, expected: profileNetwork(load(file)) };
}

beforeEach(() => {
  mockGraphProps.length = 0;
  useRouter.mockReturnValue({ isReady: true, pathname: '/network', query: {}, replace: jest.fn() });
  Element.prototype.scrollIntoView = jest.fn();
});
afterEach(() => { jest.clearAllMocks(); delete global.fetch; });

describe('the first screen is built from the file', () => {
  test('VC file: the read-out, Everyone first, the chips with their counts, More and the examples', async () => {
    const { expected } = await openSample('vc-investor-linkedin.csv');
    const readout = screen.getByTestId('readout');
    expect(readout.textContent).toBe(expected.sentences.join(' '));
    // Numbers stated by the data owner's tests (classifier fixes included).
    expect(readout.textContent).toMatch(/^You know 544 people at 254 companies: 112 investors and 97 engineers\./);
    expect(readout.textContent).toContain('The most at Stripe (22) and Google (19).');
    // Numbers are bold; the paragraph has no buttons.
    expect([...readout.querySelectorAll('strong')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['544', '254', '112', '22', '19']));
    expect(readout.querySelector('button')).toBeNull();

    const group = screen.getByRole('group', { name: 'Shortcuts' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons[0].textContent).toBe('Everyone 544');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons.slice(1, 7).map((b) => b.textContent)).toEqual(expected.shortcuts.map((s) => s.label));
    expect(buttons.slice(1, 3).map((b) => b.textContent)).toEqual(['112 investors', '97 engineers']);
    expect(chip('company:stripe').textContent).toBe('22 at Stripe');
    // More opens the rest, twelve chips in all.
    const more = within(group).getByRole('button', { name: /^More/ });
    fireEvent.click(more);
    expected.more.forEach((s) => expect(chip(s.id).textContent).toBe(s.label));
    expect(expected.shortcuts.length + expected.more.length).toBeLessThanOrEqual(12);

    // The ask box: a fixed placeholder and three examples from the file, each with its count.
    expect(screen.getByLabelText('Ask your network').getAttribute('placeholder')).toBe(`Ask about your network, e.g. ${expected.questions[0].text}`);
    const examples = screen.getByLabelText('Example questions');
    expected.questions.forEach((q) => expect(within(examples).getByText(q.text)).toBeTruthy());
    expect(within(examples).getByText('Who do I know at Stripe?').closest('button').textContent).toBe('Who do I know at Stripe? 22');

    // Section 1: one source line, no presets bar, no lens gauges, no Layers steps, no Zoom to.
    expect(screen.getByText(/contacts from/).textContent).toMatch(/544\s*contacts from LinkedIn/);
    ['Largest company', 'Whole network', 'Zoom to', 'Layers', 'Presets', 'Highlighted matches', 'Filter these people'].forEach((t) => expect(screen.queryByText(t)).toBeNull());
    expect(screen.queryByLabelText('Filter by seniority')).toBeNull();
  });

  test('sales CRM: leads with its three tags, no investors, opens By tag', async () => {
    const { expected } = await openSample('sales-crm.csv');
    const group = screen.getByRole('group', { name: 'Shortcuts' });
    const labels = within(group).getAllByRole('button').map((b) => b.textContent);
    expect(labels.slice(1, 4)).toEqual(['107 tagged “prospect”', '73 tagged “customer”', '69 tagged “partner”']);
    expect(labels).toContain('18 at Marlowe Department Stores');
    expect(labels.some((l) => /investor/.test(l))).toBe(false);
    expect(screen.getByTestId('readout').textContent).toBe(expected.sentences.join(' '));
    expect(screen.getByRole('radio', { name: 'Tag' }).getAttribute('aria-checked')).toBe('true');
    expect(lastGraph().atlas.groupBy).toBe('tag');
  });

  test('LP list: only the arrangements that split it, opening on tags, not one bubble', async () => {
    await openSample('lp-fundraising-list.csv');
    const radios = within(screen.getByRole('radiogroup', { name: 'Arrange by' })).getAllByRole('radio').map((r) => r.textContent);
    expect(radios).toEqual(['Company', 'Industry', 'Place', 'Tag']);
    expect(screen.getByRole('radio', { name: 'Tag' }).getAttribute('aria-checked')).toBe('true');
    expect(lastGraph().atlas.root.children.length).toBeGreaterThan(1);
    // The groups in view are rows in the panel (nothing selected), clicking one flies there.
    const rows = screen.getByLabelText('Groups in view');
    const first = within(rows).getAllByRole('button')[0];
    const before = lastGraph().focus.nonce;
    fireEvent.click(first);
    expect(lastGraph().focus.nonce).toBe(before + 1);
    expect(lastGraph().focus.id).toMatch(/^g\/tag:/);
    // By role is hidden, not greyed out; choosing another rebuilds the globe.
    fireEvent.click(screen.getByRole('radio', { name: 'Company' }));
    expect(lastGraph().atlas.groupBy).toBe('company');
  });

  test('small file: no sector or recency sentence', async () => {
    const { expected } = await openSample('small-network-linkedin.csv');
    const t = screen.getByTestId('readout').textContent;
    expect(t).toBe(expected.sentences.join(' '));
    expect(t).not.toMatch(/Strongest in|connected in/);
  });
});

describe('one selection drives the globe and the panel', () => {
  test.each(FILES)('%s: every shortcut lists exactly its count and lights exactly those people', async (file) => {
    const { expected } = await openSample(file);
    const atlas = lastGraph().atlas;
    const more = screen.queryByRole('button', { name: /^More/ });
    if (more) fireEvent.click(more);
    for (const s of [...expected.shortcuts, ...expected.more]) {
      expect(s.count).toBeGreaterThan(0);
      expect(s.count).toBeLessThan(expected.n);
      fireEvent.click(chip(s.id));
      expect(chip(s.id).getAttribute('aria-pressed')).toBe('true');
      expect(panelTitle()).toBe(`${s.short} · ${s.count.toLocaleString('en-US')}`);
      expect(listed().length).toBe(Math.min(50, s.count));
      const lit = lastGraph().highlightIds;
      expect(lit.size).toBe(s.count);
      expect([...lit]).toEqual(s.keys);
      // A selection never rebuilds the globe's layout.
      expect(lastGraph().atlas).toBe(atlas);
      fireEvent.click(chip(s.id));
      expect(chip(s.id).getAttribute('aria-pressed')).toBe('false');
      expect(lastGraph().highlightIds.size).toBe(0);
    }
  });

  test('a company shortcut lights the whole company under By role, and lists it', async () => {
    const { contacts } = await openSample('vc-investor-linkedin.csv');
    expect(lastGraph().atlas.groupBy).toBe('role');
    fireEvent.click(chip('company:stripe'));
    const stripe = new Set(contacts.filter((c) => /^stripe$/i.test(c.company)).map(personNodeId));
    expect(stripe.size).toBe(22);
    expect(new Set(lastGraph().highlightIds)).toEqual(stripe);
    expect(listed().length).toBe(22);
    // A company selected by its shortcut offers intro paths in the panel (spec section 6).
    expect(screen.getByRole('button', { name: /Intro paths to Stripe/ })).toBeTruthy();
  });

  test('two shortcuts combine (AND); other chips show what would remain; keys and atlas stay stable', async () => {
    const { expected } = await openSample('vc-investor-linkedin.csv');
    const atlas = lastGraph().atlas;
    fireEvent.click(chip('role:investors'));
    const litOne = lastGraph().highlightIds;
    // Every other chip shows its own intersection; one that would leave nobody is disabled.
    for (const s of [...expected.shortcuts, ...expected.more].filter((x) => x.id !== 'role:investors' && chip(x.id))) {
      const k = countIfAdded(expected, ['role:investors'], s.id);
      expect(chip(s.id).textContent).toBe(`${k.toLocaleString('en-US')} ${s.short}`);
      expect(chip(s.id).disabled).toBe(k === 0);
    }
    // No investor in this sample works at Stripe: the chip says 0 and cannot be pressed.
    expect(chip('company:stripe').textContent).toBe('0 at Stripe');
    expect(chip('company:stripe').disabled).toBe(true);
    // A chip with people in common (More included) narrows the list to them.
    fireEvent.click(screen.getByRole('button', { name: /^More/ }));
    const other = [...expected.shortcuts, ...expected.more].find((x) => x.id !== 'role:investors' && countIfAdded(expected, ['role:investors'], x.id) > 0);
    expect(other).toBeTruthy();
    const both = countIfAdded(expected, ['role:investors'], other.id);
    fireEvent.click(chip(other.id));
    const sel = combine(expected, ['role:investors', other.id]);
    expect(sel.keys.size).toBe(both);
    expect(panelTitle()).toBe(`investors · ${other.short} · ${both}`);
    expect([...lastGraph().highlightIds]).toEqual([...sel.keys]);
    expect(listed().length).toBe(both);
    expect(lastGraph().atlas).toBe(atlas);
    // The lit Set keeps its identity across renders that do not change the selection.
    const litTwo = lastGraph().highlightIds;
    expect(litTwo).not.toBe(litOne);
    fireEvent.click(screen.getByRole('radio', { name: 'Most senior' }));
    expect(lastGraph().highlightIds).toBe(litTwo);
    // Everyone clears it.
    fireEvent.click(screen.getByRole('button', { name: 'Everyone 544' }));
    expect(lastGraph().highlightIds.size).toBe(0);
    expect(panelTitle()).toBe('Everyone · 544');
  });

  test('Find in the panel is a selection from two characters', async () => {
    await openSample('vc-investor-linkedin.csv');
    const find = screen.getByLabelText('Find a person or company');
    fireEvent.change(find, { target: { value: 's' } });
    expect(lastGraph().highlightIds.size).toBe(0);
    fireEvent.change(find, { target: { value: 'stripe' } });
    expect(lastGraph().highlightIds.size).toBeGreaterThanOrEqual(22);
    expect(panelTitle()).toMatch(/^Find “stripe” · \d+$/);
    // A shortcut replaces it.
    fireEvent.click(chip('role:investors'));
    expect(find.value).toBe('');
    expect(panelTitle()).toBe('investors · 112');
  });

  test('a company clicked on the globe selects the whole company, with its profile and intro paths', async () => {
    await openSample('vc-investor-linkedin.csv');
    const atlas = lastGraph().atlas;
    const slice = atlas.nodes.find((n) => n.type === 'company' && n.key === 'stripe' && n.count < 22);
    expect(slice).toBeTruthy();
    act(() => { lastGraph().onNodeClick(slice); });
    expect(lastGraph().highlightIds.size).toBe(22);
    expect(panelTitle()).toBe('at Stripe · 22');
    expect(screen.getAllByText('Company profile')[0].getAttribute('href')).toBe('/company/Stripe');
    expect(screen.getByText(/Intro paths to Stripe/)).toBeTruthy();
    expect(lastGraph().atlas).toBe(atlas);
  });

  test('a row opens in place with why the person is listed and what to do next', async () => {
    await openSample('vc-investor-linkedin.csv');
    fireEvent.click(chip('company:stripe'));
    const row = listed()[0];
    fireEvent.click(within(row).getAllByRole('button')[0]);
    const details = within(row).getByTestId('row-details');
    expect(details.textContent).toMatch(/Connected/);
    expect(within(details).getByText('Founder check')).toBeTruthy();
    expect(within(details).getByText('Company profile')).toBeTruthy();
    // The list is still there: opening a row does not replace the panel.
    expect(listed().length).toBe(22);
  });
});

describe('what to do with the list', () => {
  test('Copy and Download CSV take every listed person, in the browser', async () => {
    const { expected } = await openSample('vc-investor-linkedin.csv');
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let blob = null;
    URL.createObjectURL = jest.fn((b) => { blob = b; return 'blob:x'; });
    URL.revokeObjectURL = jest.fn();
    HTMLAnchorElement.prototype.click = jest.fn();
    fireEvent.click(chip('role:investors'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
    const lines = writeText.mock.calls[0][0].split('\n');
    // All 112, not only the first page of 50.
    expect(lines).toHaveLength(112);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    const csv = await new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsText(blob); });
    expect(csv.trim().split('\n')).toHaveLength(113);
    expect(csv.split('\n')[0]).toMatch(/^Name,Company,Title/);
    // Nothing left the browser: no request carried the list.
    expect(global.fetch.mock.calls.every(([url]) => !/export|download/.test(String(url)))).toBe(true);
    expect(expected.shortcuts[0].count).toBe(112);
  });

  test('a person clicked on the globe opens in the panel', async () => {
    await openSample('vc-investor-linkedin.csv');
    const person = lastGraph().atlas.nodes.find((n) => n.type === 'person');
    act(() => { lastGraph().onNodeClick(person); });
    expect(panelTitle()).toBe(`${person.label} · 1`);
    expect(lastGraph().selectedId).toBe(person.id);
    expect(screen.getByTestId('row-details')).toBeTruthy();
  });
});

describe('answers, removal and wording', () => {
  test('an answer shows in the panel and lights its people', async () => {
    const contacts = load('vc-investor-linkedin.csv');
    const two = contacts.filter((c) => /^stripe$/i.test(c.company)).slice(0, 2);
    const answer = {
      question: 'Who do I know at Stripe?', total: 2,
      results: two.map((c) => ({ contact: { key: dedupeKey(c), name: c.name, company: c.company, position: c.position }, reasons: ['Works at Stripe'], role: 'operator', roleLabel: 'Operator' })),
      possiblyRelated: { results: [], total: 0 },
    };
    const { seen } = await openSample('vc-investor-linkedin.csv', { answer });
    fireEvent.click(chip('role:investors'));
    fireEvent.click(screen.getByText('Who do I know at Stripe?'));
    await waitFor(() => expect(panelTitle()).toBe('Answer · 2'));
    expect(seen.find((c) => c.url === '/api/network/query').body.question).toBe('Who do I know at Stripe?');
    // It replaces the shortcut.
    expect(chip('role:investors').getAttribute('aria-pressed')).toBe('false');
    expect(new Set(lastGraph().highlightIds)).toEqual(new Set(two.map(personNodeId)));
    expect(screen.getAllByText('Works at Stripe').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Clear the selection' }));
    expect(lastGraph().highlightIds.size).toBe(0);
  });

  test('Remove all deletes and shows no error', async () => {
    const { seen } = await openSample('small-network-linkedin.csv');
    window.confirm = jest.fn(() => true);
    fireEvent.click(screen.getByRole('button', { name: /Remove all/ }));
    await screen.findByText('All of your network data was removed.');
    expect(seen.some((c) => c.url === '/api/network/contacts' && c.method === 'DELETE')).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('No contacts yet')).toBeTruthy();
  });

  test.each(FILES)('%s: the page never shows banned words, with every chip and More open', async (file) => {
    await openSample(file);
    const more = screen.queryByRole('button', { name: /^More/ });
    if (more) fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: 'Add or replace' }));
    const t = document.body.textContent;
    expect(t).not.toMatch(BANNED);
    expect(t).not.toMatch(BANNED_LENS);
    // Placeholders and titles count too.
    const attrs = [...document.querySelectorAll('[placeholder],[title],[aria-label]')].map((el) => `${el.getAttribute('placeholder') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`).join(' ');
    expect(attrs).not.toMatch(BANNED);
    expect(attrs).not.toMatch(BANNED_LENS);
  });

  test('signed out: an upload is read in the tab, the globe settles at once and the read-out comes into view', async () => {
    useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
    serve([]);
    render(<NetworkPage />);
    const file = new File([text('small-network-linkedin.csv')], 'Connections.csv', { type: 'text/csv' });
    if (typeof file.text !== 'function') file.text = async () => text('small-network-linkedin.csv');
    await act(async () => { fireEvent.change(screen.getByTestId('linkedin-file'), { target: { files: [file] } }); });
    await screen.findByTestId('readout');
    expect(screen.getByText(/Loaded 22 LinkedIn contacts into this tab/)).toBeTruthy();
    expect(lastGraph().intro).toBe(false);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(screen.getByText(/kept in this tab only/)).toBeTruthy();
  });
});
