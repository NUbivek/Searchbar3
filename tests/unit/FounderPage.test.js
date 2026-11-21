/** @jest-environment jsdom */
/**
 * Founder Check page: the quick brief (sources first, then the brief; several people asked about; only
 * the person's own profiles; no third-party icons), the optional details, the deep check gating and the fold
 * once a deep report is on the page.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';

jest.mock('next/head', () => function Head({ children }) { return <>{children}</>; });
jest.mock('next/link', () => function Link({ children, href, ...props }) {
  const to = typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query)}`;
  return <a href={to} {...props}>{children}</a>;
});
jest.mock('next/router', () => ({ useRouter: jest.fn() }));
jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));
jest.mock('../../src/components/account/AccountMenu', () => function AccountMenu() { return <div>account</div>; });
jest.mock('../../src/components/network/NetworkHelpers', () => function NetworkHelpers() { return null; });
const deepProps = [];
jest.mock('../../src/components/founder/DeepCheck', () => ({
  __esModule: true,
  displayModel: (m) => String(m || ''),
  default: function DeepCheckStub(props) {
    deepProps.push(props);
    return (
      <div data-testid="deep" data-name={props.name} data-company={props.company} data-job={props.jobId || ''}>
        <button type="button" onClick={() => props.onReport?.({ name: props.name })}>finish deep</button>
      </div>
    );
  },
}));

// eslint-disable-next-line import/first
import FounderPage, { nameProblem } from '../../src/pages/founder';

const { useRouter } = require('next/router');
const { useSession } = require('next-auth/react');

const SOURCES = [
  { n: 1, url: 'https://acme.test/team', title: 'Acme team page', sourceName: 'acme.test', date: '2025-01-01' },
  { n: 2, url: 'https://news.test/a', title: 'Pat joins Acme', sourceName: 'News' },
];
const QUICK = {
  name: 'Pat Example', company: 'Acme', generatedAt: '2026-11-20T10:00:00Z', sources: SOURCES,
  timeline: [], pastCompanies: [{ company: 'Acme', role: 'CEO', status: 'current', quote: 'Pat Example is CEO of Acme.', sourceIndex: 0 }, { company: 'Other Corp', quote: 'A Pat Example at Other Corp.', sourceIndex: 1, possibleDifferentPerson: true }],
  education: [], litigation: [], press: [], mentions: [], litigationDisclaimer: 'Mentions only.', warnings: [], unavailableSources: [],
  profiles: [{ platform: 'LinkedIn', role: 'CEO', company: 'Acme', url: 'https://linkedin.com/in/pat', sourceIndex: 0 }, { platform: 'LinkedIn', role: 'Analyst', company: 'Other Corp', url: 'https://linkedin.com/in/pat2', sourceIndex: 0 }],
  namesakePages: [{ title: 'A different Pat Example', url: 'https://else.test/p' }],
  brief: null, briefInfo: { mode: 'pending', reason: 'The brief is being written.' },
};

let calls;
function mockFetch(handler) {
  calls = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: opts.method || 'GET', body });
    const out = await handler(String(url), body);
    return { ok: out.status ? out.status < 400 : true, status: out.status || 200, json: async () => out.body || out };
  });
}

function route(query) {
  const push = jest.fn();
  useRouter.mockReturnValue({ isReady: true, pathname: '/founder', asPath: '/founder', query, push, replace: jest.fn() });
  return push;
}

beforeEach(() => {
  deepProps.length = 0;
  window.sessionStorage.clear();
  window.localStorage.clear();
  useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
});
afterEach(() => { jest.clearAllMocks(); delete global.fetch; });

test('nameProblem: a full name, or one word with a company, or a name written without spaces', () => {
  expect(nameProblem('Pat Example')).toBe('');
  expect(nameProblem('Madonna')).toMatch(/full name/);
  expect(nameProblem('Madonna', 'Live Nation')).toBe('');
  expect(nameProblem('王小明')).toBe('');
  expect(nameProblem('J R')).toMatch(/initials/);
});

test('sources first, then the brief; citations are Q-numbered; no third-party icons; only the person\'s own profiles', async () => {
  route({ name: 'Pat Example', company: 'Acme' });
  let release;
  const gate = new Promise((r) => { release = r; });
  mockFetch(async (url, body) => {
    if (url === '/api/founder' && body.brief === '0') return QUICK;
    if (url === '/api/founder' && body.brief === 'only') { await gate; return { name: 'Pat Example', company: 'Acme', brief: 'Pat Example runs Acme [Source 1].', briefInfo: { mode: 'quoted', reason: 'no model' }, fromCache: true }; }
    return { status: 404, body: {} };
  });
  const { container } = render(<FounderPage />);
  // the sources and facts show while the brief is written
  expect(await screen.findByText('Acme team page')).toBeTruthy();
  expect(screen.getByText(/Writing the brief from the sources below/)).toBeTruthy();
  await act(async () => { release(); });
  const brief = await screen.findByText(/runs Acme/);
  const cite = brief.closest('.founder-brief').querySelector('a');
  expect(cite.textContent).toBe('[Q1]');
  expect(cite.getAttribute('href')).toBe('#source-1');
  // both calls are POSTs: the name never goes into an address
  expect(calls.filter((c) => c.url.startsWith('/api/founder')).every((c) => c.method === 'POST' && !c.url.includes('Pat'))).toBe(true);
  // no icon is fetched from another site
  expect([...container.querySelectorAll('img')].filter((i) => /google|favicon/.test(i.getAttribute('src') || ''))).toHaveLength(0);
  expect(screen.getAllByText('[Q1]').length).toBeGreaterThan(0);
  // outside links are safe
  expect(screen.getByText('Acme team page').closest('a').getAttribute('rel')).toBe('noopener noreferrer nofollow');
  // the profile at another company is left out, and said so
  const profiles = screen.getByRole('heading', { name: 'Public profiles' }).closest('section');
  expect(within(profiles).getByText('CEO at Acme')).toBeTruthy();
  expect(within(profiles).queryByText('Analyst at Other Corp')).toBeNull();
  expect(within(profiles).getByText(/1 profile at another company is left out/)).toBeTruthy();
  // an item from another person's page sits apart
  const roles = screen.getByRole('heading', { name: 'Companies and roles' }).closest('section');
  expect(within(roles).getByText('May be someone else')).toBeTruthy();
  // pages about namesakes are listed apart, collapsed
  expect(screen.getByText(/Pages about other people with this name \(1\)/)).toBeTruthy();
  // with a company, the deep check starts at once
  expect(screen.getByTestId('deep').getAttribute('data-company')).toBe('Acme');
});

test('several people with the name: the page asks which one, and holds the deep check until then', async () => {
  const push = route({ name: 'Pat Example' });
  mockFetch(async (url, body) => {
    if (body?.brief === '0') {
      return {
        ...QUICK, company: null, profiles: QUICK.profiles, brief: null, briefInfo: { mode: 'choose', reason: 'Several people' },
        people: [
          { company: 'Acme', role: 'CEO', sources: 4, source: { n: 1, title: 'Acme team page', url: 'https://acme.test/team' } },
          { company: 'Beta Bank', role: 'Analyst', sources: 3, source: { n: 2, title: 'Beta Bank staff', url: 'javascript:alert(1)' } },
        ],
      };
    }
    return { status: 404, body: {} };
  });
  render(<FounderPage />);
  const chooser = await screen.findByRole('region', { name: 'Which person' });
  expect(within(chooser).getByText('Several people named Pat Example')).toBeTruthy();
  expect(within(chooser).getByText('Beta Bank staff').closest('a')).toBeNull(); // not an http link
  expect(screen.queryByTestId('deep')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Public profiles' })).toBeNull();
  // no brief call is made for an unchosen person
  expect(calls.some((c) => c.body?.brief === 'only')).toBe(false);
  fireEvent.click(within(chooser).getAllByRole('button', { name: 'This one' })[0]);
  expect(push).toHaveBeenCalledWith({ pathname: '/founder', query: { name: 'Pat Example', company: 'Acme' } }, undefined, { shallow: true });
  fireEvent.click(within(chooser).getByRole('button', { name: 'Run the deep check on the name alone' }));
  expect(screen.getByTestId('deep').getAttribute('data-name')).toBe('Pat Example');
});

test('once a deep report is on the page, the quick brief folds to one line that can be reopened', async () => {
  route({ name: 'Pat Example', company: 'Acme' });
  mockFetch(async (url, body) => (body?.brief === '0' ? { ...QUICK, brief: 'Runs Acme [Source 1].', briefInfo: { mode: 'quoted' } } : { status: 404, body: {} }));
  render(<FounderPage />);
  await screen.findByText('Acme team page');
  fireEvent.click(screen.getByText('finish deep'));
  const fold = await screen.findByTestId('quick-folded');
  expect(fold.tagName).toBe('DETAILS');
  expect(fold.open).toBe(false);
  expect(within(fold).getByText('First look: quick brief')).toBeTruthy();
  expect(within(fold).getByText(/not identity-checked/)).toBeTruthy();
});

test('a name that cannot be checked: the hint shows, nothing is run', async () => {
  route({ name: 'Madonna' });
  mockFetch(async () => ({}));
  render(<FounderPage />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/For someone known by one name only, add their company/);
  expect(screen.queryByTestId('deep')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalledWith('/api/founder', expect.anything());
});

test('more details are optional, behind a control, and reach the deep check', async () => {
  route({ name: 'Pat Example', company: 'Acme' });
  mockFetch(async (url, body) => (body?.brief === '0' ? { ...QUICK, briefInfo: null } : { status: 404, body: {} }));
  render(<FounderPage />);
  await screen.findByText('Acme team page');
  const more = screen.getByRole('button', { name: /More details/ });
  expect(more.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(more);
  fireEvent.change(screen.getByLabelText('Company website'), { target: { value: 'acme.test' } });
  fireEvent.change(screen.getByLabelText('Earlier companies'), { target: { value: 'Beta, Gamma' } });
  fireEvent.click(screen.getByRole('button', { name: /Run check/ }));
  await waitFor(() => expect(deepProps[deepProps.length - 1].details).toEqual({ website: 'acme.test', otherCompanies: ['Beta', 'Gamma'] }));
  expect(deepProps[deepProps.length - 1].runKey).toBe(1);
});

test('recent checks reopen a check by its id', async () => {
  useSession.mockReturnValue({ data: { user: {} }, status: 'authenticated' });
  route({});
  mockFetch(async (url) => (url === '/api/founder/deep?list=1'
    ? { jobs: [{ id: 'job-1', name: 'Pat Example', company: 'Acme', state: 'done', when: '2026-11-19T10:00:00Z', redFlags: 0 }] }
    : { status: 404, body: {} }));
  render(<FounderPage />);
  const link = await screen.findByText('Pat Example');
  expect(link.getAttribute('href')).toBe('/founder?name=Pat+Example&company=Acme&job=job-1');
  // a zero is not shown as a clean (green) result
  expect(screen.getByText('0 red flags').className).toBe('chip');
});

test('a link with a check id passes it to the deep check', async () => {
  route({ name: 'Pat Example', company: 'Acme', job: 'job-9' });
  mockFetch(async (url, body) => (body?.brief === '0' ? { ...QUICK, briefInfo: null } : { status: 404, body: {} }));
  render(<FounderPage />);
  expect((await screen.findByTestId('deep')).getAttribute('data-job')).toBe('job-9');
});

test('an AI quick brief says it is AI-written and keeps no outside link or image', async () => {
  route({ name: 'Pat Example', company: 'Acme' });
  mockFetch(async (url, body) => (body?.brief === '0'
    ? { ...QUICK, brief: 'Runs Acme [Source 1]. <img src="https://evil.test/p.png"> [file](https://evil.test/x)', briefInfo: { mode: 'ai', model: 'm', provider: 'G' } }
    : { status: 404, body: {} }));
  const { container } = render(<FounderPage />);
  expect(await screen.findByText(/AI-written; check it against the cited records/)).toBeTruthy();
  const brief = container.querySelector('.founder-brief');
  expect(brief.querySelector('img')).toBeNull();
  for (const a of brief.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^#source-\d+$/);
});
