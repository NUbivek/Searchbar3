/** @jest-environment jsdom */
/**
 * Round 4 (review 2026-11-21), asked for by the loop engineer: when a start replaces a check of this person that
 * was still running with other details, the page says so in plain words and forgets the earlier check's saved id;
 * coverage lists which earlier companies the user gave were screened.
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


test('a start that replaced a running check says so and forgets the earlier saved check', async () => {
  window.localStorage.setItem('deep-check:pat example|example co', JSON.stringify({ jobId: 'job-old', at: Date.now() }));
  mockFetch(async (url, body) => {
    if (body?.action === 'start') return ok({ jobId: 'job-new', replaced: 'job-old', done: true, report: report() });
    return fail(404, { error: 'not found' });
  });
  render(<DeepCheck name="Pat Example" company="Example Co" />);
  await screen.findByRole('region', { name: 'Summary' });
  const note = screen.getByTestId('check-replaced').textContent;
  expect(note).toMatch(/already running with other details/);
  expect(note).not.toMatch(FORBIDDEN);
  expect(JSON.stringify(window.localStorage)).not.toMatch(/job-old/);
});

test('coverage says which earlier companies given were screened', async () => {
  const r = report();
  r.coverage = { ...r.coverage, givenCompanies: [{ name: 'Oldco Labs', screened: true }, { name: 'Google', screened: false }] };
  await showing(r);
  const box = screen.getByTestId('given-companies').textContent;
  expect(box).toMatch(/Oldco Labs: screened/);
  expect(box).toMatch(/Google: checked only for ties to the person/);
});
