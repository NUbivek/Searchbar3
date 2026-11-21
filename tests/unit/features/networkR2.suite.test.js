/** @jest-environment jsdom */
/**
 * Network Map, round 2, the pieces that join the owners' work (spec
 * eval/network/design-2026-11-21/SPEC.md sections 5, 6 and 9): an answer says
 * how the question was read (tags, industries and dates included), an answer
 * never counts people the source chips hide, and the page and its panels use
 * token classes only (no hex colours, no `dark:` variants, no arbitrary text
 * sizes; the globe's THEMES are checked in networkR2.globe.test.js). All
 * people are invented (tests/fixtures/network). The engine's own phrases
 * (understoodOf) are tested in networkR2.ask; the engine is not imported
 * here because it needs a Node environment.
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import NetworkPage from '../../../src/pages/network';
import { parseLinkedInConnectionsCsv, parseGenericCsv, dedupeKey } from '../../../src/utils/network/parseContacts';

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
  SOURCE_COLORS: {},
}));

const { useRouter } = require('next/router');
const { useSession } = require('next-auth/react');

const ROOT = path.resolve(__dirname, '../../..');
const DIR = path.join(ROOT, 'tests/fixtures/network');
const text = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');
const load = (file) => {
  const r = file.includes('linkedin') ? parseLinkedInConnectionsCsv(text(file)) : parseGenericCsv(text(file));
  return (r.contacts || r).map((c) => ({ ...c }));
};
const lastGraph = () => mockGraphProps[mockGraphProps.length - 1];
const panelTitle = () => screen.getByTestId('panel-title').textContent.replace(/\s+/g, ' ').trim();
const row = (c, reason) => ({ contact: { key: dedupeKey(c), name: c.name, company: c.company, position: c.position }, reasons: [reason] });

function serve(contacts, answer) {
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url === '/api/network/contacts') return { contacts, stats: { total: contacts.length, bySource: {}, lastImportBySource: {} } };
      if (url === '/api/founder/history') return { checks: [], running: [] };
      if (url === '/api/network/query') return answer;
      return {};
    },
  }));
}

async function open(contacts, answer) {
  serve(contacts, answer);
  useSession.mockReturnValue({ data: { user: { name: 'Test User' } }, status: 'authenticated' });
  render(<NetworkPage />);
  await screen.findByTestId('readout');
}

async function askAnything() {
  fireEvent.change(screen.getByLabelText('Ask your network'), { target: { value: 'anything' } });
  fireEvent.click(screen.getByRole('button', { name: /^Ask$/ }));
  await waitFor(() => expect(panelTitle()).toMatch(/^Answer/));
}

beforeEach(() => {
  mockGraphProps.length = 0;
  useRouter.mockReturnValue({ isReady: true, pathname: '/network', query: {}, replace: jest.fn() });
  Element.prototype.scrollIntoView = jest.fn();
});
afterEach(() => { jest.clearAllMocks(); delete global.fetch; });

describe('an answer says how the question was read', () => {
  test('a tag and place question shows the engine\'s own phrases, not Company/Role/Keyword', async () => {
    const crm = load('sales-crm.csv');
    const ny = crm.filter((c) => /new york/i.test(c.location || '')).slice(0, 2);
    const filters = { companies: [], roles: [], keywords: [], locations: ['New York'], tags: ['prospect'], industries: [], connected: null };
    await open(crm, { question: 'prospects in New York', filters, understood: ['Tagged “prospect”', 'In New York'], total: 2, results: ny.map((c) => row(c, 'Tagged prospect')) });
    await askAnything();
    const panel = screen.getByLabelText('Your question was read as');
    expect(within(panel).getByText('Tagged “prospect”')).toBeTruthy();
    expect(within(panel).getByText('In New York')).toBeTruthy();
    expect(panel.textContent).not.toMatch(/Company:|Role:|Keyword:/);
  });

  test('an older reply without `understood` is still explained from its filters, dates and industries included', async () => {
    const vc = load('vc-investor-linkedin.csv');
    const filters = { companies: [], roles: [], keywords: [], locations: [], tags: [], industries: ['Fintech'], connected: { label: 'in 2024' } };
    await open(vc, { question: 'fintech people I connected with in 2024', filters, total: 1, results: [row(vc[0], 'In Fintech')] });
    await askAnything();
    const panel = screen.getByLabelText('Your question was read as');
    expect(within(panel).getByText('In Fintech')).toBeTruthy();
    expect(within(panel).getByText('Connected in 2024')).toBeTruthy();
  });

  test('the old lens chip is gone: a lens question never shows its preset name', async () => {
    const vc = load('vc-investor-linkedin.csv');
    const filters = { companies: [], roles: [], keywords: [], locations: [], lens: 'raise' };
    await open(vc, { question: 'who can help me raise', filters, understood: [], total: 1, results: [row(vc[0], 'Investor')] });
    await askAnything();
    expect(document.body.textContent).not.toMatch(/Raise capital|Source deals|\bDiligence\b/);
  });
});

describe('an answer counts only the people in view', () => {
  test('signed in, people the source chips hide are left out of the answer, with a note', async () => {
    const linkedin = load('small-network-linkedin.csv');
    const csv = load('sales-crm.csv').map((c) => ({ ...c, source: 'csv' }));
    const shown = linkedin[0];
    const hidden = csv[0];
    await open([...linkedin, ...csv], { question: 'q', filters: { companies: [], roles: [], keywords: [], locations: [] }, total: 2, results: [row(shown, 'Match'), row(hidden, 'Match')] });
    // Turn the CSV source off, then ask: the server still searched everyone.
    const group = screen.getByRole('group', { name: 'Which contacts the map shows' });
    fireEvent.click(within(group).getByRole('checkbox', { name: /CSV/ }));
    await askAnything();
    expect(panelTitle()).toBe('Answer · 1');
    expect(screen.getByText('1 more match is hidden by the source filters above.')).toBeTruthy();
    expect(lastGraph().highlightIds.size).toBe(1);
  });

  test('with every source shown the answer is untouched', async () => {
    const vc = load('vc-investor-linkedin.csv');
    await open(vc, { question: 'q', filters: { companies: [], roles: [], keywords: [], locations: [] }, total: 40, results: vc.slice(0, 2).map((c) => row(c, 'Match')) });
    await askAnything();
    expect(panelTitle()).toBe('Answer · 40');
    expect(screen.queryByText(/hidden by the source filters/)).toBeNull();
  });
});

describe('token classes only', () => {
  // The globe keeps its hex colours inside THEMES (checked in its own test);
  // SOURCE_COLORS is the one shared palette the page reads from it.
  const FILES = [
    'src/pages/network.js',
    'src/components/network/AtAGlance.js',
    'src/components/network/Connectors.js',
    'src/components/network/NetworkHelpers.js',
    'src/components/network/PeoplePanel.js',
    'src/components/network/Shortcuts.js',
    'src/components/network/SourceStrip.js',
    'src/components/network/checks.js',
  ];
  test.each(FILES)('%s has no hex colours, no dark: variants and no arbitrary text sizes', (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b(?![\w-])/);
    expect(src).not.toMatch(/\bdark:/);
    expect(src).not.toMatch(/\btext-\[/);
  });
});
