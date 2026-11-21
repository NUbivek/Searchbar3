/** @jest-environment jsdom */
/**
 * Round 4 (ui): the Founder Check page never sends one person's optional details with another person's
 * check, keeps the details through the "which person" chooser, keeps only profiles at the typed company
 * (whole words, not a substring), says when a saved check has red-flag-level records "if this is the right
 * person", and puts a newly started check's id in the address.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

jest.mock('next/head', () => function Head({ children }) { return <>{children}</>; });
jest.mock('next/link', () => function Link({ children, href, ...props }) {
  const to = typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query)}`;
  return <a href={to} {...props}>{children}</a>;
});
jest.mock('next/router', () => ({ useRouter: jest.fn() }));
jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));
jest.mock('../../../src/components/account/AccountMenu', () => function AccountMenu() { return <div>account</div>; });
jest.mock('../../../src/components/network/NetworkHelpers', () => function NetworkHelpers() { return null; });
const deepProps = [];
jest.mock('../../../src/components/founder/DeepCheck', () => ({
  __esModule: true,
  displayModel: (m) => String(m || ''),
  default: function DeepCheckStub(props) {
    deepProps.push(props);
    return (
      <div data-testid="deep" data-name={props.name} data-company={props.company} data-job={props.jobId || ''}>
        <button type="button" onClick={() => props.onJob?.('job-new')}>started</button>
      </div>
    );
  },
}));

// eslint-disable-next-line import/first
import FounderPage from '../../../src/pages/founder';

const { useRouter } = require('next/router');
const { useSession } = require('next-auth/react');

const QUICK = (over = {}) => ({
  name: 'Pat Example', company: 'Acme', generatedAt: '2026-11-20T10:00:00Z', sources: [{ n: 1, url: 'https://acme.test/team', title: 'Acme team', sourceName: 'acme.test' }],
  timeline: [], pastCompanies: [], education: [], litigation: [], press: [], mentions: [], litigationDisclaimer: 'Mentions only.', warnings: [], unavailableSources: [],
  profiles: [], namesakePages: [], brief: null, briefInfo: null, ...over,
});

function mockFetch(handler) {
  global.fetch = jest.fn(async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    const out = await handler(String(url), body);
    return { ok: out.status ? out.status < 400 : true, status: out.status || 200, json: async () => out.body || out };
  });
}
let router;
function route(query) {
  router = { isReady: true, pathname: '/founder', asPath: '/founder', query, push: jest.fn(), replace: jest.fn() };
  useRouter.mockReturnValue(router);
  return router;
}

beforeEach(() => {
  deepProps.length = 0;
  window.sessionStorage.clear();
  window.localStorage.clear();
  useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
});
afterEach(() => { jest.clearAllMocks(); delete global.fetch; });

test('details typed for one person are not sent with the next person checked', async () => {
  route({ name: 'Alice Anders', company: 'Acme' });
  mockFetch(async () => QUICK({ name: 'Alice Anders' }));
  const { rerender } = render(<FounderPage />);
  await screen.findByTestId('deep');
  fireEvent.click(screen.getByRole('button', { name: /More details/ }));
  fireEvent.change(screen.getByLabelText('Profile address'), { target: { value: 'linkedin.com/in/alice-anders' } });
  fireEvent.click(screen.getByRole('button', { name: /Run check/ })); // same query: run again with the details
  await waitFor(() => expect(deepProps[deepProps.length - 1].details).toEqual({ profileUrl: 'linkedin.com/in/alice-anders' }));
  fireEvent.click(screen.getByRole('button', { name: /More details/ })); // collapse: the values are out of sight

  // Now Bob: typed in the form and submitted, then the address changes.
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Bob Brown' } });
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Zeta' } });
  fireEvent.click(screen.getByRole('button', { name: /Run check/ }));
  expect(router.push).toHaveBeenCalled();
  route({ name: 'Bob Brown', company: 'Zeta' });
  rerender(<FounderPage />);
  await waitFor(() => expect(deepProps[deepProps.length - 1].name).toBe('Bob Brown'));
  expect(deepProps[deepProps.length - 1].details).toBeNull();
  expect(screen.getByLabelText('Profile address').value).toBe('');
});

test('the More details control says how many details are filled in', async () => {
  route({ name: 'Alice Anders', company: 'Acme' });
  mockFetch(async () => QUICK({ name: 'Alice Anders' }));
  render(<FounderPage />);
  await screen.findByTestId('deep');
  fireEvent.click(screen.getByRole('button', { name: /More details/ }));
  fireEvent.change(screen.getByLabelText('School'), { target: { value: 'Stanford' } });
  fireEvent.change(screen.getByLabelText('City or country'), { target: { value: 'Berlin' } });
  expect(screen.getByRole('button', { name: /More details/ }).textContent).toMatch(/2 added/);
});

test('details typed for a common name survive picking the person in the chooser', async () => {
  route({ name: 'John Smith' });
  mockFetch(async () => QUICK({ name: 'John Smith', company: '', people: [{ company: 'Acme', role: 'CEO', sources: 2 }, { company: 'Zeta', sources: 1 }] }));
  const { rerender } = render(<FounderPage />);
  await screen.findByText('Several people named John Smith');
  fireEvent.click(screen.getByRole('button', { name: /More details/ }));
  fireEvent.change(screen.getByLabelText('School'), { target: { value: 'Stanford' } });
  fireEvent.click(screen.getByRole('button', { name: /Run check/ })); // same query again: keeps the details
  fireEvent.click((await screen.findAllByRole('button', { name: 'This one' }))[0]);
  route({ name: 'John Smith', company: 'Acme' });
  rerender(<FounderPage />);
  await waitFor(() => expect(deepProps[deepProps.length - 1].company).toBe('Acme'));
  expect(deepProps[deepProps.length - 1].details).toEqual({ school: 'Stanford' });
});

test('a profile at a company whose name merely contains the typed one is left out', async () => {
  route({ name: 'Eric Glyman', company: 'Ramp' });
  mockFetch(async () => QUICK({
    name: 'Eric Glyman', company: 'Ramp',
    profiles: [
      { platform: 'LinkedIn', role: 'CEO', company: 'Ramp', sourceIndex: 0 },
      { platform: 'LinkedIn', role: 'Partner', company: 'Rampart Capital', sourceIndex: 0 },
      { platform: 'X', role: 'Founder', company: 'Ramp Inc.', sourceIndex: 0 },
    ],
  }));
  render(<FounderPage />);
  await screen.findByText('Public profiles');
  expect(screen.queryByText(/Partner at Rampart Capital/)).toBeNull();
  expect(screen.getByText('CEO at Ramp')).toBeTruthy();
  expect(screen.getByText('Founder at Ramp Inc.')).toBeTruthy();
  expect(screen.getByText(/1 profile at another company is left out/)).toBeTruthy();
});

test('recent checks mark serious records held "if this is the right person", never a plain zero', async () => {
  useSession.mockReturnValue({ data: { user: {} }, status: 'authenticated' });
  route({});
  mockFetch(async (url) => (url === '/api/founder/deep?list=1'
    ? { jobs: [{ id: 'job-1', name: 'Trevor Milton', company: '', state: 'done', when: '2026-11-19T10:00:00Z', redFlags: 0, ifRightPerson: 3 }] }
    : { status: 404, body: {} }));
  render(<FounderPage />);
  const chip = await screen.findByText(/3 serious if right person/);
  expect(chip.className).toBe('chip chip-warn');
});

test('a newly started check puts its id in the address, so a reload opens it and not the older one', async () => {
  route({ name: 'Pat Example', company: 'Acme', job: 'job-old' });
  mockFetch(async () => QUICK());
  render(<FounderPage />);
  fireEvent.click(await screen.findByText('started'));
  expect(router.replace).toHaveBeenCalledWith(
    { pathname: '/founder', query: { name: 'Pat Example', company: 'Acme', job: 'job-new' } },
    undefined,
    { shallow: true },
  );
});
