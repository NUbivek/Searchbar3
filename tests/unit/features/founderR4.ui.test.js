/** @jest-environment jsdom */
/**
 * Round 4 (ui): the deep report never reads cleaner than the check was. Serious records held "if this is
 * the right person" keep the red-flag chip amber and reach the copied text; a filter is not printed silently;
 * a dropout is not shown as a graduate; typed details a reopened check did not use are said; a newly started
 * check reports its id; and a report saved before today's fields renders.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

jest.mock('next-auth/react', () => ({ useSession: () => ({ status: 'authenticated', data: {} }) }));

// eslint-disable-next-line import/first
import DeepCheck from '../../../src/components/founder/DeepCheck';
// eslint-disable-next-line import/first
import { ProfileCard } from '../../../src/components/founder/Resume';
// eslint-disable-next-line import/first
import { redFlagChip, summaryChips } from '../../../src/components/founder/summary';
// eslint-disable-next-line import/first
import { reportAsText } from '../../../src/components/founder/reportText';
// eslint-disable-next-line import/first
import { rememberJob } from '../../../src/components/founder/jobs';

const rec = (n, extra = {}) => ({ id: `r${n}`, n, url: `https://example.test/${n}`, title: `Record ${n}`, sourceLabel: 'Example source', match: 'confirmed', ...extra });
const CLEAN = [{ group: 'Sanctions and watchlists', items: [{ id: 'ofac', label: 'OFAC', status: 'clear' }] }, { group: 'Courts', items: [{ id: 'cl', label: 'Court listener', status: 'clear' }] }];
function report(over = {}) {
  return {
    name: 'Pat Example',
    company: 'Example Co',
    generatedAt: '2026-11-18T14:05:00.000Z',
    brief: null,
    briefInfo: null,
    totals: { records: 3, confirmed: 2, likely: 0, company: 1, possible: 0, redFlags: 0, companyMatters: 0, seriousRecords: 0 },
    coverage: { searched: [{ id: 'web', label: 'Web', records: 3, lookups: 4, failed: 0 }], lookups: 4, rounds: 2, partlyAnswered: [], notSearched: [], notCovered: ['Sealed records'], dropped: { tasks: 0, findings: 0, threads: 0 } },
    screens: CLEAN,
    redFlags: [],
    companyMatters: [],
    possibleNamesake: [],
    claimChanges: [],
    relatedParties: [],
    timeline: [],
    sections: [{ key: 'career', title: 'Career', items: [rec(1, { title: 'SEC filing names Pat' }), rec(2), rec(3, { match: 'company' })] }],
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

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.scrollTo = jest.fn();
});
afterEach(() => { delete global.fetch; });

// ------------------------------------------------------------ if this is the right person
const IFRIGHT = report({
  company: null,
  assumedCompany: 'Nikola',
  totals: { records: 5, confirmed: 2, likely: 0, possible: 0, redFlags: 0, ifRightPerson: 2, companyMatters: 0 },
  ifRightPerson: [rec(7, { title: 'SEC charges founder', severity: 'high' }), rec(8, { title: 'Fraud conviction', severity: 'high' })],
});

test('"0 red flags" is never green while serious records wait under "if this is the right person"', () => {
  const chip = redFlagChip(IFRIGHT);
  expect(chip.tone).toBe('chip chip-warn');
  expect(chip.text).toBe('0 red flags · 2 serious if right person');
  // the count comes from the list when an older report has no total for it
  expect(redFlagChip({ ...IFRIGHT, totals: { redFlags: 0 } }).text).toMatch(/2 serious if right person/);
  expect(summaryChips(IFRIGHT)[0].tone).toBe('chip chip-warn');
});

test('the copied text lists the records held "if this is the right person"', () => {
  const text = reportAsText(IFRIGHT);
  expect(text).toMatch(/IF THIS IS THE RIGHT PERSON/);
  expect(text).toMatch(/\[7\] SEC charges founder/);
  expect(text).not.toMatch(/RED FLAGS\nNone tied to this person in the sources that answered\. That is not proof/);
});

test('the Red flags card points to the "if this is the right person" block when it is empty', async () => {
  mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-s', done: true, report: IFRIGHT }) : fail(404)));
  render(<DeepCheck name="Pat Example" />);
  await screen.findByRole('region', { name: 'Summary' });
  expect(screen.getByText(/2 serious matters are listed below under .If this is the right person./)).toBeTruthy();
});

// ------------------------------------------------------------ résumé
test('an education entry left without a degree says so, and an accelerator batch is shown', () => {
  const profile = {
    education: [{ school: 'Utah Valley University', note: 'left without a degree', cites: [1] }],
    founded: [{ org: 'Paribus', year: 2015, program: 'Y Combinator S15', with: [], cites: [2] }],
  };
  render(<ProfileCard profile={profile} />);
  expect(screen.getByText(/left without a degree/)).toBeTruthy();
  expect(screen.getByText(/Y Combinator S15/)).toBeTruthy();
  const text = reportAsText(report({ profile }));
  expect(text).toMatch(/Utah Valley University, left without a degree/);
  expect(text).toMatch(/Founded Paribus \(2015\), Y Combinator S15/);
});

// ------------------------------------------------------------ printing with a filter
test('printing ignores the record filter, so a printed memo holds every record', async () => {
  mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-p', done: true, report: report() }) : fail(404)));
  window.print = jest.fn();
  render(<DeepCheck name="Pat Example" company="Example Co" />);
  await screen.findByRole('region', { name: 'Summary' });
  const search = screen.getByRole('searchbox');
  fireEvent.change(search, { target: { value: 'SEC' } });
  await waitFor(() => expect(screen.queryByText('Record 2')).toBeNull());
  act(() => { window.dispatchEvent(new Event('beforeprint')); });
  expect(screen.getByText('Record 2')).toBeTruthy();
  act(() => { window.dispatchEvent(new Event('afterprint')); });
  await waitFor(() => expect(screen.queryByText('Record 2')).toBeNull());
});

// ------------------------------------------------------------ reopened check and typed details
test('a reopened check says when details typed now were not used, and offers to run with them', async () => {
  mockFetch(async (url, body) => {
    if (body?.action === 'start') return ok({ jobId: 'job-2', done: true, report: report({ generatedAt: '2026-11-21T10:00:00Z' }) });
    if (url.includes('?name=')) return ok({ jobId: 'job-1', done: true, report: report() });
    return fail(404);
  });
  render(<DeepCheck name="Pat Example" company="Example Co" details={{ school: 'Stanford' }} />);
  const notice = await screen.findByTestId('details-unused');
  expect(notice.textContent).toMatch(/details you added (were not|may not have been) used/);
  fireEvent.click(screen.getByRole('button', { name: /Run again with them/ }));
  await waitFor(() => expect(calls.find((c) => c.body?.action === 'start')?.body.school).toBe('Stanford'));
  await waitFor(() => expect(screen.queryByTestId('details-unused')).toBeNull());
});

test('a check started with the details does not claim they were unused when it is reopened', async () => {
  mockFetch(async (url, body) => {
    if (body?.action === 'start') return ok({ jobId: 'job-3', done: true, report: report() });
    if (url.includes('jobId=job-3')) return ok({ jobId: 'job-3', done: true, report: report() });
    return fail(404);
  });
  const first = render(<DeepCheck name="Pat Example" company="Example Co" details={{ school: 'Stanford' }} />);
  await screen.findByRole('region', { name: 'Summary' });
  expect(calls.find((c) => c.body?.action === 'start').body.school).toBe('Stanford');
  first.unmount();
  render(<DeepCheck name="Pat Example" company="Example Co" details={{ school: 'Stanford' }} />);
  await screen.findByRole('region', { name: 'Summary' });
  expect(calls.filter((c) => c.body?.action === 'start')).toHaveLength(1);
  expect(screen.queryByTestId('details-unused')).toBeNull();
});

// ------------------------------------------------------------ the address follows a new check
test('a fresh run tells the page its new check id; the reopened one in the address is not read again', async () => {
  rememberJob('Pat Example', 'Example Co', 'job-a');
  mockFetch(async (url, body) => {
    if (body?.action === 'start') return ok({ jobId: 'job-b', done: true, report: report({ generatedAt: '2026-11-21T10:00:00Z' }) });
    if (url.includes('jobId=job-a')) return ok({ jobId: 'job-a', done: true, report: report() });
    if (url.includes('jobId=job-b')) return ok({ jobId: 'job-b', done: true, report: report({ generatedAt: '2026-11-21T10:00:00Z' }) });
    return fail(404);
  });
  const onJob = jest.fn();
  const { rerender } = render(<DeepCheck name="Pat Example" company="Example Co" jobId="job-a" onJob={onJob} />);
  await screen.findByRole('region', { name: 'Summary' });
  fireEvent.click(screen.getByRole('button', { name: /Run again/ }));
  await waitFor(() => expect(onJob).toHaveBeenCalledWith('job-b'));
  await screen.findByTestId('rerun-changes');
  // the page puts job-b in the address: the report on screen stays, and nothing is read or started again
  const before = calls.length;
  rerender(<DeepCheck name="Pat Example" company="Example Co" jobId="job-b" onJob={onJob} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(calls.length).toBe(before);
  expect(screen.getByTestId('rerun-changes')).toBeTruthy();
});

// ------------------------------------------------------------ old saved reports
test('a report saved before today, missing newer fields, renders without crashing', async () => {
  const old = { name: 'Pat Example', company: 'Example Co', generatedAt: '2026-11-01T10:00:00Z', redFlags: [], sections: [{ key: 'career', title: 'Career', items: [rec(1)] }] };
  mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-o', done: true, report: old }) : fail(404)));
  render(<DeepCheck name="Pat Example" company="Example Co" />);
  await screen.findByRole('region', { name: 'Summary' });
  expect(screen.getByText('Record 1')).toBeTruthy();
  // an old report that does not list what answered is never read as "nothing answered" or as clean
  expect(screen.queryByText(/No source answered/)).toBeNull();
  expect(screen.getAllByText(/does not list which sources answered/).length).toBeGreaterThan(0);
  expect(reportAsText(old)).toMatch(/Founder check: Pat Example/);
  // a section without items, and screens without items, do not crash either
  expect(() => reportAsText({ ...old, screens: [{ group: 'Courts' }], sections: [{ key: 'x', title: 'X' }] })).not.toThrow();
});
