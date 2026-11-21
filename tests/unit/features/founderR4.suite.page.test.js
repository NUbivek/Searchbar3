/** @jest-environment jsdom */
/**
 * Round 4 (review 2026-11-21), asked for by the quickbrief engineer: while several people share the name and none
 * is chosen, the quick brief's sections are not shown; a name-only item is shown apart as "may be someone else";
 * court records under the name but not tied to the person are listed; a profile flagged as possibly another
 * person is never listed as theirs.
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


test('while choosing, only the sources and the chooser are shown', async () => {
  route({ name: 'Pat Example' });
  mockFetch(async () => QUICK({ company: '', people: [{ company: 'Acme', count: 2 }, { company: 'Other Co', count: 1 }], timeline: [{ year: '2020', text: 'Pat Example joined Acme', quote: 'Pat Example joined Acme', sourceIndex: 1 }] }));
  render(<FounderPage />);
  await screen.findByText(/Quick brief sources/);
  expect(screen.queryByText('Career timeline')).toBeNull();
  expect(screen.queryByText(/Litigation and regulatory mentions/)).toBeNull();
});

test('a name-only item is shown apart, and court records under the name are listed', async () => {
  route({ name: 'Pat Example', company: 'Acme' });
  mockFetch(async () => QUICK({
    press: [{ title: 'Pat Example speaks', text: 'Pat Example speaks at a conference', quote: 'Pat Example speaks', sourceIndex: 1, nameOnly: true }],
    namesakeCourtRecords: { count: 2, records: [{ title: 'Example v. Smith', url: 'https://court.test/1' }, { title: 'State v. Example', url: 'https://court.test/2' }] },
    profiles: [{ platform: 'GitHub', company: 'Acme', role: 'Engineer', sourceIndex: 1, possibleDifferentPerson: true }],
  }));
  render(<FounderPage />);
  await screen.findByText(/Quick brief sources/);
  expect(screen.getByText('May be someone else')).toBeTruthy();
  expect(screen.getByTestId('namesake-court').textContent).toMatch(/2 court records name someone with this name/);
  expect(screen.getByText('Example v. Smith')).toBeTruthy();
  expect(screen.queryByText('Public profiles')).toBeNull();
  expect(screen.getByText(/No litigation or regulatory mention tied to this person/)).toBeTruthy();
});
