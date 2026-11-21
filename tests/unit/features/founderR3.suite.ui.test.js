/** @jest-environment jsdom */
/**
 * Final pass (suite): the deep report page shows the report fields added in round 3, labels an AI brief as
 * unchecked in its sense, and asks about a network contact's company before using it.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next/link', () => function MockLink({ href, children, ...props }) { return <a href={typeof href === 'string' ? href : '#'} {...props}>{children}</a>; });
jest.mock('next-auth/react', () => ({ useSession: () => ({ status: 'authenticated', data: {} }) }));

// eslint-disable-next-line import/first
import DeepCheck from '../../../src/components/founder/DeepCheck';

const FORBIDDEN = /\b(?:API|key|token|free|paid|tier|quota)\b/i;
const rec = (n, extra = {}) => ({ id: `r${n}`, n, url: `https://example.test/${n}`, title: `Record ${n}`, sourceLabel: 'Example source', match: 'confirmed', ...extra });

function report(over = {}) {
  return {
    name: 'Pat Example',
    company: 'Example Co',
    generatedAt: '2026-11-18T14:05:00.000Z',
    brief: '## BOTTOM LINE\nPat Example founded Example Co [Source 1].',
    briefInfo: { mode: 'records', reason: 'no model' },
    totals: { records: 3, confirmed: 2, likely: 0, company: 1, possible: 0, redFlags: 0, companyMatters: 0, seriousRecords: 0 },
    coverage: { searched: [{ id: 'web', label: 'Web', records: 3, lookups: 4, failed: 0 }], lookups: 4, rounds: 2, partlyAnswered: [], notSearched: [], notCovered: ['Sealed records'], dropped: { tasks: 0, findings: 0, threads: 0 } },
    screens: [],
    redFlags: [],
    companyMatters: [],
    possibleNamesake: [],
    claimChanges: [],
    relatedParties: [],
    timeline: [],
    sections: [{ key: 'career', title: 'Career', items: [rec(1), rec(2), rec(3, { match: 'company' })] }],
    notice: 'Public records only.',
    ...over,
  };
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body = {}) => ({ ok: false, status, json: async () => body });
let calls;
function mockFetch(handler) {
  calls = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: opts.method || 'GET', body });
    return handler(String(url), body, calls.length);
  });
}
const showing = async (r) => {
  mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-s', done: true, report: r }) : fail(404, { error: 'not found' })));
  render(<DeepCheck name="Pat Example" company="Example Co" />);
  await screen.findByRole('region', { name: 'Summary' });
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.scrollTo = jest.fn();
});
afterEach(() => { delete global.fetch; });

test('a check with no company asks the server to put a network contact to the user first', async () => {
  mockFetch(async (url, body) => (body?.action === 'start' ? ok({ jobId: 'job-n', done: true, report: report({ company: null }) }) : fail(404, { error: 'not found' })));
  render(<DeepCheck name="Pat Example" />);
  await screen.findByRole('region', { name: 'Summary' });
  expect(calls.find((c) => c.body?.action === 'start').body.askNetwork).toBe(true);
});

test('a check with a company typed does not ask about the network', async () => {
  mockFetch(async (url, body) => (body?.action === 'start' ? ok({ jobId: 'job-c', done: true, report: report() }) : fail(404, { error: 'not found' })));
  render(<DeepCheck name="Pat Example" company="Example Co" />);
  await screen.findByRole('region', { name: 'Summary' });
  expect(calls.find((c) => c.body?.action === 'start').body.askNetwork).toBeUndefined();
});

test('an AI brief says it is AI-written and which sections came from the records', async () => {
  await showing(report({ briefInfo: { mode: 'ai', model: 'm', provider: 'G', filledFromRecords: ['RELATED PARTIES', 'COMPANY'] } }));
  const brief = screen.getByRole('region', { name: 'Brief' });
  expect(within(brief).getByText(/AI-written; check it against the cited records/)).toBeTruthy();
  expect(within(brief).getByText(/Related parties, Company/i)).toBeTruthy();
  expect(brief.textContent).not.toMatch(FORBIDDEN);
});

test('the brief keeps no outside link and no image', async () => {
  await showing(report({ brief: 'Pat [Source 1] <a href="https://evil.test/x">dossier</a> <img src="https://evil.test/p.png"> [more](https://evil.test/y)' }));
  const brief = screen.getByRole('region', { name: 'Brief' });
  expect(brief.querySelector('img')).toBeNull();
  for (const a of brief.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^#deep-source-\d+$/);
});

test('matters that hold only if this is the right person, and their own posts, are shown apart', async () => {
  await showing(report({
    ifRightPerson: [rec(5, { title: 'Charged with fraud at Acme', severity: 'high', assumedTie: true })],
    ownStatements: [rec(6, { title: 'Their post about leaving Acme' })],
  }));
  const right = screen.getByRole('heading', { name: /If this is the right person/ }).closest('section');
  expect(right.textContent).toMatch(/Charged with fraud at Acme/);
  const own = screen.getByRole('heading', { name: /Their own posts/ }).closest('section');
  expect(own.textContent).toMatch(/Their post about leaving Acme/);
});

test('a company the check assumed is shown in the header as assumed', async () => {
  await showing(report({ company: null, assumedCompany: 'Acme' }));
  const summary = screen.getByRole('region', { name: 'Summary' });
  expect(within(summary).getByRole('heading', { name: /Pat Example/ }).textContent).toMatch(/Acme \(assumed\)/);
});

test('legal names and suggested threads are listed', async () => {
  await showing(report({
    legalNames: [{ name: 'Example Holdings, Inc.', of: 'example co' }],
    threads: [{ kind: 'company', value: 'Side Corp', why: 'named in a bio', suggested: true, label: 'suggested by the second reader' }],
  }));
  expect(screen.getAllByText(/Example Holdings, Inc\./).length).toBeGreaterThan(0);
  expect(screen.getByText(/Side Corp/).closest('li').textContent).toMatch(/suggested by the second reader/);
});

test('records say when their text was not read, when a claim was later confirmed, and what was checked on the own domain', async () => {
  await showing(report({
    sections: [{ key: 'career', title: 'Career', items: [
      rec(1, { textNotRead: true }),
      rec(2, { claimNote: 'claimed, later confirmed by notice', confirmedBy: 3 }),
      rec(3, { data: { ownDomainChecked: 'No listing names example.test.' } }),
    ] }],
  }));
  const career = screen.getByRole('heading', { name: /Career/ }).closest('section');
  expect(within(career).getByText('text not read')).toBeTruthy();
  expect(career.textContent).toMatch(/claimed, later confirmed by notice/i);
  expect(career.querySelector('a[href="#deep-source-3"]')).toBeTruthy();
  expect(career.textContent).toMatch(/No listing names example\.test\./);
});

test('a red flag\'s outcome gives the person\'s part', async () => {
  await showing(report({ redFlags: [rec(4, { title: 'Indicted', severity: 'high', outcome: { text: 'Convicted', role: 'defendant', date: '2022', n: 4 } })] }));
  const flags = screen.getByRole('heading', { name: 'Red flags' }).closest('section');
  expect(flags.textContent).toMatch(/Convicted[^]*defendant/);
});

test('coverage shows the search note and keeps lookups not run apart from sources that did not answer', async () => {
  await showing(report({
    coverage: {
      ...report().coverage,
      searchNote: '2 of 9 open-web questions were answered from news headlines only.',
      notSearched: [{ label: 'Court dockets', reason: 'No answer.' }, { label: 'Patents', reason: 'Not run before the check ended.', notRun: true }],
    },
  }));
  const cov = screen.getByRole('heading', { name: /What was searched/ }).closest('section');
  expect(cov.textContent).toMatch(/answered from news headlines only/);
  expect(within(cov).getByText(/Not run before the check ended/i, { selector: 'p' })).toBeTruthy();
  expect(within(cov).getByText('Did not answer')).toBeTruthy();
  const didNot = within(cov).getByText('Did not answer').parentElement;
  expect(didNot.textContent).not.toMatch(/Patents/);
});

test('the network section links to asking the network about their company', async () => {
  await showing(report({ network: { available: true, checked: 4, self: null, sameNameContacts: [], groups: [], references: [], counts: { people: 0 }, notes: [], companiesChecked: ['Example Co'], investorsChecked: [] } }));
  const link = screen.getByText('Ask your network about Example Co').closest('a');
  expect(link.getAttribute('href')).toBe('/network?ask=Who+do+I+know+at+Example+Co%3F');
});
