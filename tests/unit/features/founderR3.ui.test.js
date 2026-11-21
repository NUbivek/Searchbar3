/** @jest-environment jsdom */
/**
 * The deep report page: honest summary chips, the résumé and company cards, safe links, and picking a check
 * up again (reload, closed tab, sign-in, run again) without starting another.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

jest.mock('next/link', () => function MockLink({ href, children, ...props }) { return <a href={typeof href === 'string' ? href : '#'} {...props}>{children}</a>; });
jest.mock('next-auth/react', () => ({ useSession: () => ({ status: 'authenticated', data: {} }) }));

// eslint-disable-next-line import/first
import DeepCheck, { limitMessage } from '../../../src/components/founder/DeepCheck';
// eslint-disable-next-line import/first
import { redFlagChip, summaryChips, screenCounts, compareReports } from '../../../src/components/founder/summary';
// eslint-disable-next-line import/first
import { briefHtml } from '../../../src/components/founder/briefHtml';
// eslint-disable-next-line import/first
import { patiently, savedJob, rememberJob, detailsBody } from '../../../src/components/founder/jobs';
// eslint-disable-next-line import/first
import { reportAsText } from '../../../src/components/founder/reportText';
// eslint-disable-next-line import/first
import { filterRecords, NO_FILTER } from '../../../src/components/founder/RecordList';

const FORBIDDEN = /\b(?:API|key|token|free|paid|tier|quota)\b/i;
const rec = (n, extra = {}) => ({ id: `r${n}`, n, url: `https://example.test/${n}`, title: `Record ${n}`, sourceLabel: 'Example source', match: 'confirmed', ...extra });
const screen1 = (id, group, status, extra = {}) => ({ id, label: `${id} screen`, status, lookups: 2, records: 0, nameOnly: 0, cites: [], ...extra });
const CLEAN_SCREENS = [
  { group: 'Sanctions and watchlists', items: [screen1('sanctions-lists', 'S', 'clear'), screen1('wanted-lists', 'S', 'clear')] },
  { group: 'Courts and prosecutors', items: [screen1('doj-press-releases', 'C', 'clear'), screen1('court-dockets', 'C', 'off')] },
  { group: 'Company registers', items: [screen1('uk-companies-house', 'R', 'failed')] },
];

function report(over = {}) {
  return {
    name: 'Pat Example',
    company: 'Example Co',
    generatedAt: '2026-11-18T14:05:00.000Z',
    brief: 'Pat Example founded Example Co [Source 1].',
    briefInfo: { mode: 'records', reason: 'no model' },
    totals: { records: 3, confirmed: 2, likely: 0, company: 1, possible: 0, redFlags: 0, companyMatters: 0, seriousRecords: 0 },
    coverage: { searched: [{ id: 'web', label: 'Web', records: 3, lookups: 4, failed: 0 }], lookups: 4, rounds: 2, partlyAnswered: [], notSearched: [], notCovered: ['Sealed records'], dropped: { tasks: 0, findings: 0, threads: 0 } },
    screens: CLEAN_SCREENS,
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
const notFound = () => fail(404, { error: 'not found' });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.scrollTo = jest.fn();
});
afterEach(() => { delete global.fetch; });

// ------------------------------------------------------------------ summary chips
describe('summary chips are honest', () => {
  test('"0 red flags" is green only when every court, regulator and watchlist screen answered in full', () => {
    expect(redFlagChip(report()).tone).toBe('chip chip-good'); // a failed register is not a flag screen
    const silent = report({ screens: [{ group: 'Sanctions and watchlists', items: [screen1('sanctions-lists', 'S', 'failed'), screen1('wanted-lists', 'S', 'not-run'), screen1('mdb', 'S', 'clear')] }, CLEAN_SCREENS[1]] });
    const chip = redFlagChip(silent);
    expect(chip.tone).toBe('chip chip-warn');
    expect(chip.text).toBe('0 red flags · 2 screens did not answer');
    // answered only in part is not "in full"
    const part = report({ screens: [{ group: 'Courts and prosecutors', items: [screen1('doj', 'C', 'records', { incomplete: true, records: 1 })] }] });
    expect(redFlagChip(part).tone).toBe('chip chip-warn');
    expect(redFlagChip(report({ screens: [{ group: 'Regulators and filings', items: [screen1('sec', 'R', 'partial')] }] })).text).toMatch(/1 screen did not answer/);
  });

  test('a saved report without screens, none run, or a company nothing ties them to: never green', () => {
    expect(redFlagChip(report({ screens: undefined })).tone).toBe('chip chip-warn');
    expect(redFlagChip(report({ screens: [CLEAN_SCREENS[2]] })).tone).toBe('chip chip-warn');
    const unconfirmed = report({ totals: { ...report().totals, companyUnconfirmed: true }, identityNote: 'No record found ties Pat Example to Example Co.' });
    expect(redFlagChip(unconfirmed).tone).toBe('chip');
    expect(redFlagChip(report({ totals: { ...report().totals, redFlags: 2 } }))).toMatchObject({ tone: 'chip chip-bad', text: '2 red flags' });
  });

  test('screens answered out of asked; not-enabled screens are not counted as asked', () => {
    expect(screenCounts(CLEAN_SCREENS)).toMatchObject({ asked: 4, answered: 3, flagAsked: 3, flagUnanswered: 0 });
    const chips = summaryChips(report({ totals: { ...report().totals, companyMatters: 1, possible: 4 } }));
    expect(chips.map((c) => c.text)).toEqual(['0 red flags', '1 company matter', '2 records tied to the person', '4 name match only', '3 of 4 screens answered']);
    expect(chips.find((c) => c.key === 'screens').tone).toBe('chip chip-warn');
    expect(chips.find((c) => c.key === 'tied').tone).toBe('chip'); // a count of records is not a verdict
  });

  test('the page shows the summary first: name, headline, chips, identity note and the three buttons', async () => {
    const r = report({
      identityNote: 'No record found ties Pat Example to Example Co. Confirm their identity directly.',
      totals: { ...report().totals, companyUnconfirmed: true },
      profile: { headline: 'CEO, Example Co', headlineCites: [1], basedIn: { text: 'Berlin', cites: [1] }, roles: [], education: [], readBy: 'model' },
      screens: [{ group: 'Sanctions and watchlists', items: [screen1('sanctions-lists', 'S', 'failed')] }],
    });
    mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-s', done: true, report: r }) : notFound()));
    render(<DeepCheck name="Pat Example" company="Example Co" />);
    const summary = await screen.findByRole('region', { name: 'Summary' });
    const s = within(summary);
    expect(s.getByRole('heading', { name: /Pat Example/ })).toBeTruthy();
    expect(s.getByText(/CEO, Example Co · based in Berlin/)).toBeTruthy();
    const chip = s.getByText('0 red flags · 1 screen did not answer');
    expect(chip.className).toBe('chip chip-warn');
    expect(s.getByTestId('identity-note').textContent).toMatch(/No record found ties/);
    for (const label of [/Print or save as PDF/, /Copy as text/, /Run again/]) expect(s.getByRole('button', { name: label })).toBeTruthy();
    expect(s.getByText(/Report from/)).toBeTruthy();
    // the Red flags section uses the same honest tone
    const flags = screen.getByRole('heading', { name: 'Red flags' }).closest('section');
    expect(flags.querySelector('.chip').className).toBe('chip chip-warn');
    expect(summary.textContent).not.toMatch(FORBIDDEN);
    // order: summary, brief, red flags, profile, screens, records, coverage
    const order = ['Summary', 'Brief'].map((n) => screen.getByRole('region', { name: n }));
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    const at = (t) => headings.findIndex((h) => h === t || h.startsWith(t));
    expect(at('Brief')).toBeLessThan(at('Red flags'));
    expect(at('Red flags')).toBeLessThan(at('Profile'));
    expect(at('Profile')).toBeLessThan(at('Public-record screens'));
    expect(at('Public-record screens')).toBeLessThan(at('Career'));
    expect(at('Career')).toBeLessThan(at('What was searched'));
  });

  test('Copy as text writes a plain memo with the caveats', async () => {
    const r = report({ screens: [{ group: 'Courts and prosecutors', items: [screen1('doj', 'C', 'failed', { label: 'DOJ press releases' })] }], coverage: { ...report().coverage, notSearched: [{ label: 'Courts', reason: 'timed out' }] } });
    const text = reportAsText(r);
    expect(text).toMatch(/^Founder check: Pat Example \(Example Co\)/);
    expect(text).toMatch(/0 red flags · 1 screen did not answer/);
    expect(text).toMatch(/did not answer in full: DOJ press releases/);
    expect(text).toMatch(/Courts: timed out/);
    expect(text).toMatch(/\[1\] Record 1 · Example source · https:\/\/example\.test\/1/);
    expect(text).not.toMatch(/<|\]\(/);
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-c', done: true, report: r }) : notFound()));
    render(<DeepCheck name="Pat Example" company="Example Co" />);
    fireEvent.click(await screen.findByRole('button', { name: /Copy as text/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeTruthy();
  });

  test('printing opens every section and lists every record', async () => {
    const many = Array.from({ length: 30 }, (_, i) => rec(i + 1));
    mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-p', done: true, report: report({ sections: [{ key: 'career', title: 'Career', items: many }] }) }) : notFound()));
    window.print = jest.fn();
    const { container } = render(<DeepCheck name="Pat Example" company="Example Co" />);
    await screen.findByRole('region', { name: 'Summary' });
    expect(container.querySelector('#deep-source-30')).toBeNull();
    let during = null;
    window.print.mockImplementation(() => { during = { all: Boolean(container.querySelector('#deep-source-30')), hidden: container.querySelectorAll('[data-block] > [hidden]').length }; });
    fireEvent.click(screen.getByRole('button', { name: /Print or save as PDF/ }));
    expect(window.print).toHaveBeenCalled();
    expect(during).toEqual({ all: true, hidden: 0 });
  });
});

// ------------------------------------------------------------------ résumé and company
describe('profile as a résumé', () => {
  const profile = {
    headline: 'Co-Founder and CEO, Ramp', headlineCites: [1], company: 'Ramp',
    roles: [
      { org: 'Paribus', title: 'Co-Founder', from: 2014, to: 2016, current: false, cites: [2] },
      { org: 'Ramp', title: 'Co-Founder and CEO', from: 2019, to: null, current: true, cites: [1] },
      { org: 'Credit Suisse', title: 'Analyst', from: 2012, to: 2014, current: false, cites: [3] },
    ],
    education: [{ school: 'Harvard University', degree: 'AB', field: 'Economics', from: null, to: 2011, cites: [4] }],
    founded: [{ org: 'Paribus', year: 2014, with: ['Karim Atiyeh'], outcome: 'acquired by Capital One', cites: [2] }],
    boards: [{ org: 'Acme Trust', role: 'board member', from: 2021, to: null, cites: [5] }],
    investments: [{ text: 'Angel investor in Example Labs', org: 'Example Labs', cites: [6] }],
    recognition: [{ text: 'Forbes 30 Under 30', title: 'Forbes 30 Under 30', year: 2016, cites: [7] }],
    leads: [{ text: 'FINRA registration at Credit Suisse', why: 'Matched by name only; ask whether this is them.', cites: [9] }],
    basedIn: { text: 'New York', cites: [1] }, about: [], links: [{ platform: 'linkedin', url: 'https://linkedin.com/in/eric' }, { platform: 'x', url: 'https://x.com/eric2', also: true }],
    readBy: 'patterns',
  };
  const companyFacts = {
    legalNames: [{ name: 'Ramp Business Corporation', cites: [8] }], domains: [{ domain: 'ramp.com', cites: [8] }], founded: { year: 2019, cites: [8] },
    funding: [{ round: 'Series D', amount: '$300M', date: '2023-08', lead: 'Thrive Capital', investors: ['Founders Fund'], cites: [10] }],
    investors: [{ name: 'Founders Fund', cites: [10] }], standing: [{ text: 'Active', cites: [8] }],
  };

  async function show(p, facts = null) {
    mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-r', done: true, report: report({ company: 'Ramp', profile: p, companyFacts: facts }) }) : notFound()));
    render(<DeepCheck name="Eric Glyman" company="Ramp" />);
    return within((await screen.findByRole('heading', { name: 'Profile' })).closest('section'));
  }

  test('roles with years, current first; education with degree, field and year; founded, boards, investments, recognition', async () => {
    const card = await show(profile);
    const items = card.getByText('Experience').closest('div').querySelectorAll('li');
    expect([...items].map((li) => li.textContent.split('·')[0].trim())).toEqual(['Ramp', 'Paribus', 'Credit Suisse']);
    expect(card.getByText('2019 – present')).toBeTruthy();
    expect(card.getByText('2014 – 2016')).toBeTruthy();
    expect(card.getByText('· AB, Economics')).toBeTruthy();
    expect(card.getByText('until 2011')).toBeTruthy();
    expect(card.getByText('· with Karim Atiyeh · acquired by Capital One')).toBeTruthy();
    expect(card.getByText('· board member')).toBeTruthy();
    expect(card.getByText('Example Labs')).toBeTruthy();
    expect(card.getByText('Forbes 30 Under 30')).toBeTruthy();
    expect(card.getByText('LinkedIn').closest('a').getAttribute('href')).toBe('https://linkedin.com/in/eric');
    expect(card.getByText('X (also found)')).toBeTruthy();
  });

  test('leads sit apart as things to confirm, never in the résumé lines', async () => {
    const card = await show(profile);
    const leads = card.getByTestId('profile-leads');
    expect(within(leads).getByRole('heading', { name: 'To confirm with the person' })).toBeTruthy();
    expect(within(leads).getByText('FINRA registration at Credit Suisse')).toBeTruthy();
    expect(within(leads).getByText('[9]')).toBeTruthy();
    // not inside the résumé list
    expect(card.getByText('Experience').closest('dl').textContent).not.toMatch(/FINRA/);
  });

  test('one quiet line when the profile was read by text patterns only, none when a model read it', async () => {
    let card = await show(profile);
    expect(card.getByTestId('profile-patterns-note').textContent).toMatch(/Read by text patterns only; some earlier roles, degrees or board seats may be missing/);
    document.body.innerHTML = '';
    card = await show({ ...profile, readBy: 'model' });
    expect(card.queryByTestId('profile-patterns-note')).toBeNull();
  });

  test('company: legal names, founded, funding rounds, investors and standing, each cited', async () => {
    await show(profile, companyFacts);
    const card = within(screen.getByRole('heading', { name: 'Company: Ramp' }).closest('section'));
    expect(card.getByText('Ramp Business Corporation')).toBeTruthy();
    expect(card.getByText('Series D, $300M')).toBeTruthy();
    expect(card.getByText('· led by Thrive Capital')).toBeTruthy();
    expect(card.getByText('2019')).toBeTruthy();
    expect(card.getByText('Active')).toBeTruthy();
    expect(card.getAllByText('[10]').length).toBe(2);
    expect(card.getByText('Ramp Business Corporation').closest('section').textContent).not.toMatch(FORBIDDEN);
  });
});

// ------------------------------------------------------------------ safe links
describe('links', () => {
  test('only http(s) links, always with noopener noreferrer nofollow; anything else is plain text', async () => {
    const r = report({
      sections: [{ key: 'career', title: 'Career', items: [rec(1, { url: 'javascript:alert(1)', title: 'Bad link record' }), rec(2, { alsoIn: [{ id: 'x', source: 's', sourceLabel: 'Other copy', url: 'data:text/html,hi' }] })] }],
      profile: { headline: 'CEO', roles: [], education: [], links: [{ platform: 'github', url: 'javascript:void(0)' }], readBy: 'model' },
    });
    mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-l', done: true, report: r }) : notFound()));
    const { container } = render(<DeepCheck name="Pat Example" company="Example Co" />);
    await screen.findByText('Bad link record');
    expect(screen.getByText('Bad link record').closest('a')).toBeNull();
    expect(screen.getByText('Other copy').closest('a')).toBeNull();
    expect(screen.getByText('GitHub').closest('a')).toBeNull();
    const outside = [...container.querySelectorAll('a')].filter((a) => !a.getAttribute('href').startsWith('#') && !a.getAttribute('href').startsWith('/'));
    expect(outside.length).toBeGreaterThan(0);
    for (const a of outside) {
      expect(a.getAttribute('href')).toMatch(/^https?:\/\//);
      expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    }
    expect(container.querySelector('img')).toBeNull();
  });

  test('a brief keeps its own citations and drops outside links and images', () => {
    const html = briefHtml('Sued [Source 3]. [Full file](https://evil.test/x) ![t](https://evil.test/p.png) <img src="https://evil.test/q.png"> <a href="https://evil.test/y">click</a>', { anchor: 'deep-source' });
    const box = document.createElement('div');
    box.innerHTML = html;
    expect(box.querySelector('img')).toBeNull();
    const links = [...box.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#deep-source-3']);
    expect(box.textContent).toMatch(/Full file/);
    expect(box.textContent).toMatch(/click/);
    expect(html).not.toMatch(/evil\.test/);
    const quick = document.createElement('div');
    quick.innerHTML = briefHtml('Founded Acme [Source 2].', { anchor: 'source', label: 'Q' });
    expect(quick.querySelector('a').textContent).toBe('[Q2]');
    expect(quick.querySelector('a').getAttribute('href')).toBe('#source-2');
  });
});

// ------------------------------------------------------------------ records
describe('records', () => {
  test('filters by tie, severity, source and words', () => {
    const items = [rec(1, { severity: 'high', title: 'Lawsuit filed', sourceLabel: 'Courts' }), rec(2, { match: 'company', title: 'Funding round' }), rec(3, { match: 'likely', severity: 'low', sourceLabel: 'Courts' })];
    expect(filterRecords(items, NO_FILTER)).toHaveLength(3);
    expect(filterRecords(items, { ...NO_FILTER, ties: ['company'] }).map((f) => f.n)).toEqual([2]);
    expect(filterRecords(items, { ...NO_FILTER, severities: ['none'] }).map((f) => f.n)).toEqual([2]);
    expect(filterRecords(items, { ...NO_FILTER, source: 'Courts', severities: ['high'] }).map((f) => f.n)).toEqual([1]);
    expect(filterRecords(items, { ...NO_FILTER, text: 'lawsuit FILED' }).map((f) => f.n)).toEqual([1]);
  });

  test('the filter bar narrows every section; the name-only block stays collapsed with the word-only count', async () => {
    const r = report({
      sections: [
        { key: 'career', title: 'Career', items: [rec(1, { title: 'Joined Ramp' }), rec(2, { title: 'Lawsuit filed', severity: 'high' }), rec(5, { match: 'possible', title: 'Another Pat' })] },
        { key: 'press', title: 'Press', items: [rec(3, { title: 'Interview', match: 'likely' })] },
      ],
      company: 'Ramp',
      wordOnly: { count: 7, items: [{ title: 'Boat ramp story', url: 'https://news.test/a', sourceLabel: 'News', reason: 'matches only the word "Ramp"' }], omitted: 6 },
    });
    mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: 'job-f', done: true, report: r }) : notFound()));
    render(<DeepCheck name="Pat Example" company="Ramp" />);
    const search = await screen.findByRole('searchbox', { name: 'Search the records' });
    fireEvent.change(search, { target: { value: 'lawsuit' } });
    expect(screen.getByText('Showing 1 of 3 records.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Press' })).toBeNull();
    fireEvent.click(screen.getByText('Clear filters'));
    expect(screen.getByRole('heading', { name: 'Press' })).toBeTruthy();
    const nameOnly = screen.getByRole('heading', { name: 'Name matches only' }).closest('section');
    expect(within(nameOnly).getByRole('button', { name: 'Name matches only' }).getAttribute('aria-expanded')).toBe('false');
    expect(within(nameOnly).getByTestId('word-only-count').textContent).toMatch(/7 more records were left out because they matched only the ordinary word “Ramp”/);
  });
});

// ------------------------------------------------------------------ picking a check up again
describe('a check survives a reload, a closed tab and a sign-in', () => {
  const running = (jobId, tasksRun = 3) => ({ jobId, progress: { phase: 'collect', step: 0, tasksRun, queued: 5, findings: 2 } });

  test('a check kept in this browser is read back, not started again', async () => {
    rememberJob('Pat Example', 'Example Co', 'job-kept');
    mockFetch(async (url, body) => {
      if (url === '/api/founder/deep?jobId=job-kept') return ok({ jobId: 'job-kept', done: true, report: report() });
      if (body?.action === 'start') throw new Error('must not start');
      return notFound();
    });
    render(<DeepCheck name="Pat Example" company="Example Co" />);
    expect(await screen.findByRole('region', { name: 'Summary' })).toBeTruthy();
    expect(calls.some((c) => c.body?.action === 'start')).toBe(false);
  });

  test('another tab: the account\'s latest check of the person is continued, and its id kept on every step', async () => {
    mockFetch(async (url, body) => {
      if (url === '/api/founder/deep?name=Pat+Example&company=Example+Co') return ok(running('job-latest'));
      if (body?.action === 'step') return ok({ jobId: 'job-latest', done: true, report: report() });
      return notFound();
    });
    render(<DeepCheck name="Pat Example" company="Example Co" />);
    expect(await screen.findByRole('region', { name: 'Summary' })).toBeTruthy();
    expect(calls.some((c) => c.body?.action === 'start')).toBe(false);
    expect(calls.find((c) => c.body?.action === 'step').body.jobId).toBe('job-latest');
    expect(savedJob('Pat Example', 'Example Co')).toBe('job-latest');
    expect(JSON.parse(window.localStorage.getItem('deep-check:pat example|example co')).jobId).toBe('job-latest');
  });

  test('a link to a check (Recent checks, the Network Map) opens that check first', async () => {
    mockFetch(async (url) => (url === '/api/founder/deep?jobId=job-linked' ? ok({ jobId: 'job-linked', done: true, report: report() }) : notFound()));
    render(<DeepCheck name="Pat Example" company="Example Co" jobId="job-linked" />);
    expect(await screen.findByRole('region', { name: 'Summary' })).toBeTruthy();
    expect(calls[0].url).toBe('/api/founder/deep?jobId=job-linked');
    expect(calls.some((c) => c.body?.action === 'start')).toBe(false);
  });

  test('a new check sends the optional details', async () => {
    mockFetch(async (url, body) => (body?.action === 'start' ? ok({ jobId: 'job-new', done: true, report: report() }) : notFound()));
    const details = { website: ' ramp.com ', profileUrl: 'linkedin.com/in/eric', place: 'New York', otherCompanies: 'Paribus, Credit Suisse', school: '', otherNames: '' };
    render(<DeepCheck name="Pat Example" company="Example Co" details={details} />);
    await screen.findByRole('region', { name: 'Summary' });
    expect(calls.find((c) => c.body?.action === 'start').body).toEqual({
      action: 'start', name: 'Pat Example', company: 'Example Co', website: 'ramp.com', profileUrl: 'linkedin.com/in/eric', place: 'New York', otherCompanies: ['Paribus', 'Credit Suisse'],
    });
    expect(detailsBody({ otherNames: ['A B', ''], school: ' MIT ' })).toEqual({ school: 'MIT', otherNames: ['A B'] });
  });

  test('a network drop during a step is waited out, not shown as a failure', async () => {
    let steps = 0;
    mockFetch(async (url, body) => {
      if (body?.action === 'start') return ok(running('job-drop'));
      if (body?.action === 'step') {
        steps += 1;
        if (steps === 1) throw new TypeError('Failed to fetch');
        return ok({ jobId: 'job-drop', done: true, report: report() });
      }
      return notFound();
    });
    render(<DeepCheck name="Pat Drop" />);
    expect(await screen.findByRole('region', { name: 'Summary' }, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('patiently waits for the browser to come back online', async () => {
    jest.useFakeTimers();
    try {
      const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      let n = 0;
      const fn = jest.fn(async () => { n += 1; if (n === 1) throw new TypeError('offline'); return 'ok'; });
      const p = patiently(fn);
      await jest.advanceTimersByTimeAsync(600000);
      expect(fn).toHaveBeenCalledTimes(1); // still offline: no new try, and no giving up
      online.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
      await jest.advanceTimersByTimeAsync(10);
      await expect(p).resolves.toBe('ok');
      online.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  test('the progress bar never moves backwards, and only the newest line is announced', async () => {
    let steps = 0;
    let first;
    let last;
    const gate1 = new Promise((r) => { first = r; });
    const gate2 = new Promise((r) => { last = r; });
    mockFetch(async (url, body) => {
      if (body?.action === 'start') return ok({ jobId: 'job-bar', progress: { phase: 'collect', step: 0, tasksRun: 8, queued: 2, findings: 4 } });
      if (body?.action === 'step') {
        steps += 1;
        if (steps === 1) { await gate1; return ok({ jobId: 'job-bar', progress: { phase: 'collect', step: 1, tasksRun: 10, queued: 40, findings: 6 } }); }
        await gate2;
        return ok({ jobId: 'job-bar', done: true, report: report() });
      }
      return notFound();
    });
    render(<DeepCheck name="Pat Bar" />);
    const bar = await screen.findByRole('progressbar', { name: 'Deep check progress' });
    await waitFor(() => expect(bar.getAttribute('aria-valuenow')).toBe('80'));
    await act(async () => { first(); });
    await waitFor(() => expect(screen.getByText('round 2')).toBeTruthy());
    expect(bar.getAttribute('aria-valuenow')).toBe('80'); // 10 of 50 would be 20
    expect(bar.getAttribute('aria-valuetext')).toBe('10 lookups done, 40 queued, round 2');
    const live = document.querySelectorAll('[aria-live="polite"]');
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe('Round 2: 10 lookups, 6 records.');
    await act(async () => { last(); });
  });

  test('the hourly limit says when to come back and offers no Try again', async () => {
    expect(limitMessage(25 * 60, Date.parse('2026-11-20T15:15:00'))).toMatch(/You can start another check at 3:40/);
    mockFetch(async (url, body) => (body?.action === 'start' ? fail(429, { error: 'You have started many checks in the last hour. Try again later.', retryAfter: 1500 }) : notFound()));
    render(<DeepCheck name="Pat Limit" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/You can start another check at/);
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toMatch(FORBIDDEN);
  });

  test('a name that cannot be checked says what to do, with no Try again', async () => {
    mockFetch(async (url) => (url.includes('?name=') ? fail(400, { error: 'Enter the full name (first and last name).' }) : notFound()));
    render(<DeepCheck name="Madonna" />);
    expect((await screen.findByRole('alert')).textContent).toBe('Enter the full name (first and last name).');
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(calls.some((c) => c.body?.action === 'start')).toBe(false);
  });

  test('Run again keeps the old report on screen until the new one is ready, then marks what is new', async () => {
    const first = report();
    const second = report({ generatedAt: '2026-11-20T10:00:00.000Z', sections: [{ key: 'career', title: 'Career', items: [rec(1), rec(2), rec(4, { title: 'Brand new record' })] }] });
    let release;
    const gate = new Promise((r) => { release = r; });
    mockFetch(async (url, body) => {
      if (url.includes('?name=')) return ok({ jobId: 'job-old', done: true, report: first });
      if (body?.action === 'start') { await gate; return ok({ jobId: 'job-again', done: true, report: second }); }
      return notFound();
    });
    render(<DeepCheck name="Pat Example" company="Example Co" />);
    fireEvent.click(await screen.findByRole('button', { name: /Run again/ }));
    expect(await screen.findByText('Running the check again')).toBeTruthy();
    expect(screen.getByText('Record 3')).toBeTruthy(); // the old report is still there
    await act(async () => { release(); });
    await screen.findByText('Brand new record');
    const fresh = screen.getByText('Brand new record').closest('li');
    expect(within(fresh).getByText('new')).toBeTruthy();
    expect(within(screen.getByText('Record 1').closest('li')).queryByText('new')).toBeNull();
    expect(screen.getByTestId('rerun-changes').textContent).toMatch(/1 new record, marked new; 1 no longer found/);
    expect(compareReports(first, second).gone.map((f) => f.n)).toEqual([3]);
  });

  test('a limit reached on Run again is shown above the report, which stays', async () => {
    mockFetch(async (url, body) => {
      if (url.includes('?name=')) return ok({ jobId: 'job-old', done: true, report: report() });
      if (body?.action === 'start') return fail(429, { error: 'Too many' });
      return notFound();
    });
    render(<DeepCheck name="Pat Example" company="Example Co" />);
    fireEvent.click(await screen.findByRole('button', { name: /Run again/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/most checks allowed in an hour/);
    expect(screen.getByRole('region', { name: 'Summary' })).toBeTruthy();
  });

  test('a contact\'s company is used only after the user says it is them', async () => {
    mockFetch(async (url, body) => {
      if (body?.action === 'start' && !body.confirmedCompany && body.useNetworkCompany !== false) return ok({ needsConfirm: { company: 'Acme', question: 'Is this the Pat Example at Acme in your network?' } });
      if (body?.action === 'start') return ok({ jobId: 'job-seed', done: true, report: report(), assumed: body.confirmedCompany ? { company: 'Acme' } : undefined });
      return notFound();
    });
    render(<DeepCheck name="Pat Example" />);
    expect(await screen.findByText('Is this the Pat Example at Acme in your network?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, use Acme' }));
    await screen.findByRole('region', { name: 'Summary' });
    expect(calls.filter((c) => c.body?.action === 'start').pop().body.confirmedCompany).toBe('Acme');
    expect(screen.getByText(/this check used Acme/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run it without Acme' })).toBeTruthy();
  });
});

// ------------------------------------------------------------------ saved real reports still render
describe('saved reports from earlier runs', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '../../../eval/founder/runs/r9');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  test.each(files.length ? files : ['(none)'])('%s renders without a green zero and without unsafe links', async (file) => {
    if (file === '(none)') return;
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    mockFetch(async (url) => (url.includes('?name=') ? ok({ jobId: `job-${file}`, done: true, report: r }) : notFound()));
    const { container } = render(<DeepCheck name={r.name} company={r.company || ''} />);
    await screen.findByRole('region', { name: 'Summary' });
    const chip = redFlagChip(r);
    if (chip.tone === 'chip chip-good') expect(screenCounts(r.screens).flagUnanswered).toBe(0);
    for (const a of container.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href.startsWith('#') && !href.startsWith('/')) expect(href).toMatch(/^https?:\/\//);
    }
    expect(container.querySelector('img')).toBeNull();
  });
});
