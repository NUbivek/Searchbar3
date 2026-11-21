/** @jest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

jest.mock('next/link', () => function MockLink({ href, children, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next-auth/react', () => ({ useSession: () => ({ status: 'authenticated', data: {} }) }));

// eslint-disable-next-line import/first
import DeepCheck, { displayModel, relatedNote, step } from '../../../src/components/founder/DeepCheck';

const rec = (n, extra = {}) => ({ id: `r${n}`, n, url: `https://example.test/${n}`, title: `Record ${n}`, sourceLabel: 'Example source', match: 'confirmed', ...extra });

function report(over = {}) {
  return {
    name: 'Pat Example',
    company: 'Example Co',
    brief: 'Pat Example founded Example Co [Source 1].',
    briefInfo: { mode: 'ai', model: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter', confidence: { level: 'High', reason: 'Two sources agree' } },
    totals: { records: 3, confirmed: 2, likely: 0, company: 1, possible: 0, redFlags: 1, seriousRecords: 1 },
    coverage: {
      searched: [{ id: 'web', label: 'Web', records: 3, lookups: 4, failed: 0 }],
      lookups: 4,
      rounds: 2,
      partlyAnswered: [],
      notSearched: [{ label: 'Courts', reason: 'timed out' }, { label: 'Patents', reason: 'off', off: true }],
      notCovered: ['Sealed records'],
      dropped: { tasks: 0, findings: 0, threads: 0 },
    },
    redFlags: [rec(2, { severity: 'high', title: 'A lawsuit' })],
    companyMatters: [],
    possibleNamesake: [rec(9, { match: 'possible', severity: 'high', title: 'Same-name matter' })],
    claimChanges: [],
    relatedParties: [
      { name: 'Alex Partner', kind: 'associate', relation: 'co-founder', screened: true, records: [] },
      { name: 'Sam Kin', kind: 'relative', screened: false, records: [] },
    ],
    timeline: [{ n: 1, date: '2019', title: 'Founded Example Co' }],
    sections: [{ key: 'company', title: 'Companies', items: Array.from({ length: 20 }, (_, i) => rec(i + 1)) }],
    notice: 'Public records only.',
    ...over,
  };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, error = 'nope') => ({ ok: false, status, json: async () => ({ error }) });

let calls;
function mockFetch(handler) {
  calls = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method || 'GET', body });
    // the lookup of the account's latest check of this person finds none unless a test says otherwise
    if (!body && String(url).includes('/api/founder/deep?name=')) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    return handler(url, body, calls.length);
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  delete global.fetch;
});

describe('displayModel', () => {
  it('drops the vendor path and the :free suffix', () => {
    expect(displayModel('meta-llama/llama-3.3-70b-instruct:free')).toBe('llama-3.3-70b-instruct');
    expect(displayModel('gpt-x')).toBe('gpt-x');
    expect(displayModel(null)).toBe('');
  });
});

describe('relatedNote', () => {
  it('does not call anyone screened when no watchlist lookup state is known', () => {
    const note = relatedNote([{ name: 'A' }], 'Pat');
    expect(note).toMatch(/not proof of a clean record/);
    expect(note).not.toMatch(/Screened against/);
  });

  it('counts only the parties whose watchlist lookup ran', () => {
    expect(relatedNote([{ screened: true }, { screened: false }, {}], 'Pat')).toMatch(/searched together with Pat: 1 of 3\./);
  });
});

describe('DeepCheck component', () => {
  it('shows progress while collecting, then the report sections', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    mockFetch(async (url, body) => {
      if (body?.action === 'start') return ok({ jobId: 'job-progress', done: false, progress: { phase: 'collect', step: 1, tasksRun: 5, queued: 5, findings: 7, threads: { company: 2 }, log: [{ step: 1, text: 'Searched the web' }] } });
      await gate;
      return ok({ jobId: 'job-progress', done: true, progress: { phase: 'report' }, report: report() });
    });
    render(<DeepCheck name="Pat Example" company="Example Co" />);

    expect(await screen.findByText('round 2')).toBeTruthy();
    expect(screen.getByText('5 lookups · 7 records')).toBeTruthy();
    expect(screen.getByText('2 companies')).toBeTruthy();
    expect(screen.getByText('Searched the web')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');

    release();
    expect(await screen.findByRole('heading', { name: /Pat Example/ })).toBeTruthy();
    for (const title of ['Red flags', 'Possible namesakes to rule out', 'Related parties', 'Timeline from dated records', 'Companies', 'What was searched']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    expect(screen.queryByRole('heading', { name: 'About their companies' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Claims that changed over time' })).toBeNull();
    expect(screen.getByText('1 red flag')).toBeTruthy();
    expect(screen.getByText('Did not answer')).toBeTruthy();
    expect(screen.getByText('Not enabled on this deployment')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Deep check finished: 3 records, 1 red flag.');
    // the start request carried the query
    expect(calls.find((c) => c.body?.action === 'start').body).toEqual({ action: 'start', name: 'Pat Example', company: 'Example Co' });
  });

  it('shows the short model name, with the provider on hover, and the confidence', async () => {
    mockFetch(async () => ok({ jobId: 'job-model', done: true, report: report() }));
    render(<DeepCheck name="Pat Model" company="Example Co" />);
    const chip = await screen.findByText('llama-3.3-70b-instruct');
    expect(chip.getAttribute('title')).toBe('via openrouter');
    expect(screen.queryByText(/meta-llama\//)).toBeNull();
    expect(screen.getByText('High confidence').className).toContain('chip-good');
  });

  it('says the brief was assembled from the records when no model wrote it', async () => {
    mockFetch(async () => ok({ jobId: 'job-records', done: true, report: report({ briefInfo: { mode: 'records', reason: 'no model answered' } }) }));
    render(<DeepCheck name="Pat Records" />);
    expect((await screen.findByText('Assembled from the records')).getAttribute('title')).toBe('no model answered');
  });

  it('marks related parties not screened only when screening state is known', async () => {
    mockFetch(async () => ok({ jobId: 'job-related', done: true, report: report() }));
    render(<DeepCheck name="Pat Related" company="Example Co" />);
    await screen.findByText('Alex Partner');
    expect(screen.getByText(/Screened against watchlists and searched together with Pat Example: 1 of 2\./)).toBeTruthy();
    const kin = screen.getByText('Sam Kin').closest('li');
    expect(within(kin).getByText('not screened in this run')).toBeTruthy();
    const partner = screen.getByText('Alex Partner').closest('li');
    expect(within(partner).queryByText('not screened in this run')).toBeNull();
  });

  it('omits the not-screened chip when no party carries a screening state', async () => {
    const parties = [{ name: 'Alex Partner', kind: 'associate', records: [] }];
    mockFetch(async () => ok({ jobId: 'job-related2', done: true, report: report({ relatedParties: parties }) }));
    render(<DeepCheck name="Pat Related Two" />);
    await screen.findByText('Alex Partner');
    expect(screen.queryByText('not screened in this run')).toBeNull();
    expect(screen.getByText(/not proof of a clean record/)).toBeTruthy();
  });

  it('turns [Source n] into a citation that opens a card, then reveals its record past the first few', async () => {
    mockFetch(async () => ok({ jobId: 'job-cite', done: true, report: report({ brief: 'Late detail [Source 18].' }) }));
    const { container } = render(<DeepCheck name="Pat Cite" />);
    await screen.findByText('Late detail', { exact: false });
    const link = container.querySelector('.founder-brief a[href="#deep-source-18"]');
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('[18]');
    expect(container.querySelector('#deep-source-18')).toBeNull(); // only the first 15 of 20 show

    fireEvent.click(link);
    const card = await screen.findByRole('dialog');
    expect(within(card).getByText('Record 18')).toBeTruthy();
    expect(within(card).getByText('same person')).toBeTruthy();
    expect(within(card).getByText(/Open source/).closest('a').getAttribute('href')).toBe('https://example.test/18');
    fireEvent.click(within(card).getByText('Show in report'));
    await waitFor(() => expect(container.querySelector('#deep-source-18')).toBeTruthy());
    const target = container.querySelector('#deep-source-18');
    await waitFor(() => expect(target.closest('[data-block]').querySelector('[hidden]')).toBeNull());
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    // and a way back to where the citation was
    fireEvent.click(screen.getByText('Back to where you were'));
    expect(screen.queryByText('Back to where you were')).toBeNull();
    // the record keeps a single anchor: copies under red flags or namesakes carry none
    expect(container.querySelectorAll('[id="deep-source-2"]').length).toBe(1);
    expect(container.querySelectorAll('[id="deep-source-9"]').length).toBe(1);
    expect(container.querySelector('#deep-source-9').closest('[data-block]').querySelector('h2').textContent).toBe('Companies');
  });

  it('Escape closes the citation card', async () => {
    mockFetch(async () => ok({ jobId: 'job-esc', done: true, report: report({ brief: 'Detail [Source 1].' }) }));
    const { container } = render(<DeepCheck name="Pat Escape" />);
    await screen.findByText('Detail', { exact: false });
    fireEvent.click(container.querySelector('.founder-brief a[href="#deep-source-1"]'));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('retries a step after a 503 and carries on', async () => {
    let steps = 0;
    mockFetch(async (url, body) => {
      if (body?.action === 'start') return ok({ jobId: 'job-503', done: false, progress: { phase: 'collect', tasksRun: 0, queued: 1, findings: 0 } });
      steps += 1;
      if (steps === 1) return fail(503, 'busy');
      return ok({ jobId: 'job-503', done: true, report: report() });
    });
    render(<DeepCheck name="Pat Retry" />);
    expect(await screen.findByRole('heading', { name: /Pat Example/ }, { timeout: 4000 })).toBeTruthy();
    expect(steps).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('on a 409 reads where the job stands instead of failing', async () => {
    mockFetch(async (url, body) => {
      if (body?.action === 'start') return ok({ jobId: 'job-409', done: false, progress: { phase: 'collect', tasksRun: 0, queued: 1, findings: 0 } });
      if (body?.action === 'step') return fail(409, 'busy elsewhere');
      if (String(url).includes('jobId=job-409')) return ok({ jobId: 'job-409', done: true, report: report() });
      return fail(404);
    });
    render(<DeepCheck name="Pat Conflict" />);
    expect(await screen.findByRole('heading', { name: /Pat Example/ })).toBeTruthy();
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/founder/deep?jobId=job-409')).toBe(true);
  });

  it('does not retry a client error, and does not offer a try again that cannot work', async () => {
    mockFetch(async (url, body) => {
      if (body?.action === 'start') return ok({ jobId: 'job-400', done: false, progress: { phase: 'collect', tasksRun: 0, queued: 1, findings: 0 } });
      return fail(400, 'Bad request');
    });
    render(<DeepCheck name="Pat Bad" />);
    expect((await screen.findByRole('alert')).textContent).toBe('Bad request');
    expect(calls.filter((c) => c.body?.action === 'step')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(screen.getByText(/Change the details in the form above/)).toBeTruthy();
  });

  it('asks to sign in on a 401', async () => {
    mockFetch(async () => fail(401, 'Sign in'));
    render(<DeepCheck name="Pat Signin" />);
    // the sign-in page sends the visitor back to this same check
    expect((await screen.findByText('Sign in to run it')).getAttribute('href')).toBe(`/signin?callbackUrl=${encodeURIComponent('/')}`);
  });

  it('keeps trying a step through server errors for about two minutes, then gives up', async () => {
    await expect((async () => {
      mockFetch(async () => fail(500, 'down'));
      jest.useFakeTimers();
      try {
        const p = step('job-500');
        const caught = p.catch((e) => e);
        await jest.advanceTimersByTimeAsync(60000);
        expect(calls.length).toBeGreaterThan(5); // still trying after a minute
        await jest.advanceTimersByTimeAsync(200000);
        throw await caught;
      } finally {
        jest.useRealTimers();
      }
    })()).rejects.toMatchObject({ status: 500, message: 'down' });
    const n = calls.length;
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(20);
  });
});
