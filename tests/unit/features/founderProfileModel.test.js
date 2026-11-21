/**
 * @jest-environment jsdom
 *
 * The model-read profile: what a model says about a person's career is kept only when the cited record
 * is tied to them, states it word for word, and the sentence is about them (never a colleague or relative).
 * Also the pattern reader's labelled fields and year spans, the report.profile shape with and without
 * a model, and the Profile card.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(), chatJson: jest.fn(), PROVIDERS: [{ id: 'groq' }], providerEnabled: jest.fn(() => false) }));
// the page parser is not used here, and its browser build does not load in jsdom
jest.mock('cheerio', () => ({ load: jest.fn() }));
jest.mock('next/link', () => function MockLink({ href, children, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next-auth/react', () => ({ useSession: () => ({ status: 'authenticated', data: {} }) }));

const { createSubject } = require('../../../src/server/founder/identity');
const { buildProfile, spanAfter, placeOnly } = require('../../../src/server/founder/profile');
const { verifyProfile, mergeProfile, readProfile, profileRecords, orgKey } = require('../../../src/server/founder/profileModel');
const { buildReport } = require('../../../src/server/founder/report');
const { startState } = require('../../../src/server/founder/deepCheck');
const { default: DeepCheck, yearsOf } = require('../../../src/components/founder/DeepCheck');

const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
let seq = 0;
const rec = (o) => ({ id: `r${(seq += 1)}`, source: 'web-search', sourceLabel: 'Open-web search', category: 'press', severity: 'info', quote: '', match: 'confirmed', url: `https://x.test/${seq}`, ...o });
const empty = { roles: [], education: [], boards: [], founded: [], investments: [], recognition: [], basedIn: [] };
const answer = (over) => ({ ...empty, ...over });

describe('verifyProfile', () => {
  const bio = rec({ source: 'page-reader', category: 'career', data: { kind: 'bio' }, quote: 'Jane Roe is the CEO of Acme. Jane Smith, our CFO, previously worked at Deloitte. Jane Roe was a product manager at Stripe (2015–2018) and earned an MBA in finance from Columbia Business School in 2014. She sits on the board of Girls Who Code and is an angel investor in Ramp. Jane was named to the Forbes 30 Under 30 list in 2019. Jane Roe is based in Brooklyn, New York.' });
  const namesake = rec({ match: 'possible', title: 'Jane Roe, engineer', quote: 'Jane Roe worked at Initech as an engineer from 2010 to 2014.' });
  const records = [bio, namesake];

  test('keeps the facts the cited record states about the person, with years only as stated', () => {
    const out = verifyProfile(subject, records, answer({
      roles: [
        { org: 'Stripe', title: 'product manager', from: 2015, to: 2018, current: false, record: 1, quote: 'Jane Roe was a product manager at Stripe (2015–2018)' },
        { org: 'Acme', title: 'CEO', from: 2012, to: null, current: true, record: 1, quote: 'Jane Roe is the CEO of Acme.' },
      ],
      education: [{ school: 'Columbia Business School', degree: 'MBA', field: 'finance', from: null, to: 2014, record: 1, quote: 'earned an MBA in finance from Columbia Business School in 2014' }],
      boards: [{ org: 'Girls Who Code', role: 'board', record: 1, quote: 'She sits on the board of Girls Who Code' }],
      investments: [{ org: 'Ramp', record: 1, quote: 'is an angel investor in Ramp' }],
      recognition: [{ title: 'Forbes 30 Under 30', year: 2019, record: 1, quote: 'Jane was named to the Forbes 30 Under 30 list in 2019.' }],
      basedIn: [{ text: 'Brooklyn, New York', record: 1, quote: 'Jane Roe is based in Brooklyn, New York.' }],
    }));
    expect(out.roles.map((r) => [r.org, r.title, r.from, r.to, r.current])).toEqual([['Stripe', 'product manager', 2015, 2018, false], ['Acme', 'CEO', null, null, true]]);
    expect(out.education[0]).toMatchObject({ school: 'Columbia Business School', degree: 'MBA', field: 'finance', to: 2014 });
    expect(out.boards[0].org).toBe('Girls Who Code');
    expect(out.investments[0].org).toBe('Ramp');
    expect(out.recognition[0]).toMatchObject({ title: 'Forbes 30 Under 30', year: 2019 });
    expect(out.basedIn).toMatchObject({ text: 'Brooklyn, New York' });
    expect(out.dropped).toBe(0);
    for (const r of out.roles) expect(r.ids).toEqual([bio.id]);
  });

  test('an invented fact, a namesake record, a colleague\'s employer and a wrong record number are dropped', () => {
    const out = verifyProfile(subject, records, answer({
      roles: [
        // invented: the record never says this
        { org: 'Google', title: 'engineer', from: null, to: null, current: false, record: 1, quote: 'Jane Roe worked at Google as an engineer.' },
        // the quote is real but from a name-only record
        { org: 'Initech', title: 'engineer', from: 2010, to: 2014, current: false, record: 2, quote: 'Jane Roe worked at Initech as an engineer' },
        // a colleague's employer
        { org: 'Deloitte', title: 'CFO', from: null, to: null, current: false, record: 1, quote: 'Jane Smith, our CFO, previously worked at Deloitte.' },
        // the organisation is not in the quote
        { org: 'Stripe', title: '', from: null, to: null, current: false, record: 1, quote: 'Jane Roe is the CEO of Acme.' },
        { org: 'Stripe', title: '', from: null, to: null, current: false, record: 9, quote: 'Jane Roe was a product manager at Stripe' },
      ],
      // a year or a degree the quote does not state is not kept
      education: [{ school: 'Columbia Business School', degree: 'PhD', field: '', from: 2010, to: null, record: 1, quote: 'from Columbia Business School' }],
    }));
    expect(out.roles).toEqual([]);
    expect(out.dropped).toBe(5);
    expect(out.kept).toBe(1);
    // the school is kept (the sentence opens on the person) but not a degree or a year the quote does not state
    expect(out.education).toEqual([expect.objectContaining({ school: 'Columbia Business School', degree: null, from: null })]);
  });

  test('a pronoun after a sentence naming two people is not read as the person; family and home are never kept', () => {
    const page = rec({ source: 'page-reader', category: 'career', data: { kind: 'bio' }, quote: 'Jane Roe and Bob Smith co-founded Acme in 2020. He previously worked at Google. Jane Roe lives in Austin with her husband, a partner at Bain.' });
    const out = verifyProfile(subject, [page], answer({
      roles: [
        { org: 'Google', title: '', from: null, to: null, current: false, record: 1, quote: 'He previously worked at Google.' },
        { org: 'Bain', title: 'partner', from: null, to: null, current: false, record: 1, quote: 'her husband, a partner at Bain' },
      ],
      founded: [{ org: 'Acme', year: 2020, record: 1, quote: 'Jane Roe and Bob Smith co-founded Acme in 2020.' }],
      basedIn: [{ text: 'Austin', record: 1, quote: 'Jane Roe lives in Austin with her husband' }],
    }));
    expect(out.roles).toEqual([]);
    expect(out.basedIn).toBeNull();
    expect(out.founded).toEqual([expect.objectContaining({ org: 'Acme', year: 2020 })]);
  });

  const page = (quote) => rec({ source: 'page-reader', category: 'career', data: { kind: 'bio' }, quote });
  const role = (o) => ({ org: '', title: '', from: 0, to: 0, current: false, record: 1, ...o });

  test('a "He" after a sentence that brings in someone else is not the person (review: colleague\'s career)', () => {
    const p = page('Jane Roe founded Acme in 2018. She hired Bob Smith as her first engineer. He previously led engineering at Google from 2012 to 2017.');
    const out = verifyProfile(subject, [p], answer({ roles: [role({ org: 'Google', title: 'led engineering', from: 2012, to: 2017, quote: 'He previously led engineering at Google from 2012 to 2017.' })] }));
    expect(out.roles).toEqual([]);
    // someone hired without a name breaks the carry too
    const q = page('Jane Roe founded Acme in 2018. She hired a former Google engineer to run the platform team. He previously worked at Meta.');
    expect(verifyProfile(subject, [q], answer({ roles: [role({ org: 'Meta', quote: 'He previously worked at Meta.' })] })).roles).toEqual([]);
    // a plain run of "She" sentences still carries
    const r = page('Jane Roe founded Acme in 2018. She previously worked at Stripe (2014–2017).');
    expect(verifyProfile(subject, [r], answer({ roles: [role({ org: 'Stripe', from: 2014, to: 2017, quote: 'She previously worked at Stripe (2014–2017).' })] })).roles).toEqual([expect.objectContaining({ org: 'Stripe', from: 2014, to: 2017 })]);
  });

  test('an employer or school named in a clause about a colleague is not the person\'s (review: verbatim check)', () => {
    const a = page('Jane Roe recruited Bob Smith, a former Google engineer, to run the platform team.');
    expect(verifyProfile(subject, [a], answer({ roles: [role({ org: 'Google', title: 'engineer', quote: 'Jane Roe recruited Bob Smith, a former Google engineer, to run the platform team.' })] })).roles).toEqual([]);
    const b = page("Jane Roe's co-founder Bob Smith studied at Stanford University.");
    expect(verifyProfile(subject, [b], answer({ education: [{ school: 'Stanford University', degree: '', field: '', from: 0, to: 0, record: 1, quote: "Jane Roe's co-founder Bob Smith studied at Stanford University." }] })).education).toEqual([]);
    // the person's own school and a joint role still pass
    const c = page('Jane Roe studied at Stanford University. Jane Roe and Bob Smith worked at Google.');
    const ok = verifyProfile(subject, [c], answer({
      education: [{ school: 'Stanford University', degree: '', field: '', from: 0, to: 0, record: 1, quote: 'Jane Roe studied at Stanford University.' }],
      roles: [role({ org: 'Google', quote: 'Jane Roe and Bob Smith worked at Google.' })],
    }));
    expect(ok.education).toHaveLength(1);
    expect(ok.roles).toHaveLength(1);
  });

  test('a title or degree is never read out of letters inside a longer word (review: stated)', () => {
    const p = page('Jane Roe is director of product at Acme. Jane Roe graduated from the University of Alabama. Jane Roe earned an M.B.A. from Williams College.');
    const out = verifyProfile(subject, [p], answer({
      roles: [role({ org: 'Acme', title: 'CTO', quote: 'Jane Roe is director of product at Acme.' })],
      education: [
        { school: 'University of Alabama', degree: 'MA', field: '', from: 0, to: 0, record: 1, quote: 'Jane Roe graduated from the University of Alabama.' },
        { school: 'Williams College', degree: 'MBA', field: '', from: 0, to: 0, record: 1, quote: 'Jane Roe earned an M.B.A. from Williams College.' },
      ],
    }));
    expect(out.roles[0].title).toBeNull();
    expect(out.education.map((e) => e.degree)).toEqual([null, 'MBA']);
  });

  test('a former role is never shown as current (review: current)', () => {
    const p = page('Jane Roe is a former vice president at Oracle.');
    const out = verifyProfile(subject, [p], answer({ roles: [role({ org: 'Oracle', title: 'vice president', current: true, quote: 'Jane Roe is a former vice president at Oracle.' })] }));
    expect(out.roles).toEqual([expect.objectContaining({ org: 'Oracle', current: false })]);
    expect(mergeProfile(null, { roles: out.roles.map(({ ids, quote, ...r }) => ({ ...r, cites: [1] })) }).headline).toBeNull();
  });

  test('a year is kept only beside the organisation, not from another fact in the quote (review: yearIn)', () => {
    const p = page('Jane Roe, who graduated in 2010, joined Stripe. Jane Roe joined Plaid in 2016. In 2018, Jane Roe founded Acme.');
    const out = verifyProfile(subject, [p], answer({
      roles: [
        role({ org: 'Stripe', from: 2010, quote: 'Jane Roe, who graduated in 2010, joined Stripe.' }),
        role({ org: 'Plaid', from: 2016, quote: 'Jane Roe joined Plaid in 2016.' }),
      ],
      founded: [{ org: 'Acme', year: 2018, record: 1, quote: 'In 2018, Jane Roe founded Acme.' }],
    }));
    expect(out.roles.map((r) => [r.org, r.from])).toEqual([['Stripe', null], ['Plaid', 2016]]);
    expect(out.founded[0].year).toBe(2018);
  });

  test('records for the model: tied only, pages about the person first', () => {
    const press = rec({ title: 'Jane Roe interview', quote: 'Jane Roe talks about building Acme and what comes next.' });
    const picked = profileRecords([press, namesake, bio]);
    expect(picked.map((f) => f.id)).toEqual([bio.id, press.id]);
  });
});

describe('pattern reader: labelled fields and year spans', () => {
  test('Experience, Education and Location fields of a profile page whose title names the person', () => {
    const p = buildProfile(subject, [
      rec({ title: 'Jane Roe - Acme | LinkedIn', category: 'identity', quote: 'Experience: Acme · Stripe · Education: Columbia University (2008–2012) · Location: San Francisco Bay Area · 500+ connections' }),
      rec({ title: 'Founder story', quote: 'Jane Roe previously worked at Credit Suisse (2012–2015).' }),
      rec({ title: 'Bob Other - Initech | LinkedIn', category: 'identity', quote: 'Experience: Initech · Education: Yale University · Location: Boston' }),
    ]);
    expect(p.earlier.map((e) => e.org).sort()).toEqual(['Credit Suisse', 'Stripe']);
    expect(p.earlier.find((e) => e.org === 'Credit Suisse')).toMatchObject({ from: 2012, to: 2015 });
    expect(p.education).toEqual([expect.objectContaining({ school: 'Columbia University', from: 2008, to: 2012 })]);
    expect(p.basedIn).toMatchObject({ text: 'San Francisco Bay Area' });
  });

  test('spans and places', () => {
    expect(spanAfter('worked at Stripe, 2015 - present as a PM', 'Stripe')).toEqual({ from: 2015, to: null, current: true });
    expect(spanAfter('worked at Stripe in 2015 and in 2018', 'Stripe')).toBeNull();
    expect(placeOnly('12 Main Street, Austin')).toBeNull();
    expect(placeOnly('Austin, Texas')).toBe('Austin, Texas');
    expect(orgKey('The Acme Corp.')).toBe(orgKey('Acme'));
  });
});

describe('report.profile', () => {
  function state() {
    const s = startState({ name: 'Jane Roe', company: 'Acme' });
    s.findings = [
      rec({ source: 'page-reader', category: 'career', data: { kind: 'bio' }, title: 'About Jane', quote: 'Jane Roe is the co-founder and CEO of Acme. Previously, Jane Roe worked at Credit Suisse (2012–2015). Jane Roe is a board member at Habitat Labs. Jane Smith, our CFO, previously worked at Deloitte.' }),
      rec({ title: 'Jane Roe, Acme CEO', quote: 'Jane Roe, CEO of Acme, spoke at the event.' }),
      rec({ match: 'possible', title: 'Jane Roe at Initech', quote: 'Jane Roe worked at Initech for ten years.' }),
    ];
    return s;
  }

  test('without a model: the pattern-read shape, every list present', async () => {
    const s = state();
    const report = buildReport(s);
    // round 3: the patterns now read boards and companies founded too (no longer hard-coded empty)
    expect(report.profile).toMatchObject({ headline: 'Co-Founder and CEO, Acme', investments: [], recognition: [] });
    expect(report.profile.boards.map((b) => b.org)).toEqual(['Habitat Labs']);
    expect(report.profile.founded.map((b) => b.org)).toEqual(['Acme']);
    expect(report.profile.roles[0]).toMatchObject({ org: 'Acme', current: true });
    expect(report.profile.roles[1]).toMatchObject({ org: 'Credit Suisse', from: 2012, to: 2015, current: false });
    expect(report.profile.earlier.map((e) => e.org)).toEqual(['Credit Suisse']);
    // no model answers: the profile is unchanged
    const same = await readProfile(report, s, { complete: async () => null });
    expect(same).toBe(report.profile);
    const thrown = await readProfile(report, s, { complete: async () => { throw new Error('down'); } });
    expect(thrown).toBe(report.profile);
  });

  test('with a model: verified items merged first, citations as record numbers, a colleague\'s employer left out', async () => {
    const s = state();
    const report = buildReport(s);
    const complete = jest.fn(async (messages) => {
      const user = messages[1].content;
      expect(user).not.toMatch(/Initech/); // a name-only record is never shown
      // round 3: each record sits inside its own <record> element (a data boundary)
      const n = Number(user.match(/<record n="(\d+)" source="Open-web search; a page about the person"/)[1]);
      return {
        model: 'm',
        data: answer({
          roles: [
            { org: 'Credit Suisse', title: 'analyst', from: 2012, to: 2015, current: false, record: n, quote: 'Jane Roe worked at Credit Suisse (2012–2015).' },
            { org: 'Deloitte', title: 'CFO', from: null, to: null, current: false, record: n, quote: 'Jane Smith, our CFO, previously worked at Deloitte.' },
          ],
          boards: [{ org: 'Habitat Labs', role: 'board member', record: n, quote: 'Jane Roe is a board member at Habitat Labs.' }],
        }),
      };
    });
    const profile = await readProfile(report, s, { complete, deadline: Date.now() + 30000 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1]).toMatchObject({ personal: true, name: 'profile' });
    expect(profile.readBy).toBe('model');
    const bioN = report.sources.find((x) => x.id === s.findings[0].id).n;
    // "analyst" is not in the quote, so the title is not kept; the pattern-read Credit Suisse merges into it
    expect(profile.roles.filter((r) => r.org === 'Credit Suisse')).toEqual([expect.objectContaining({ title: null, from: 2012, to: 2015, cites: [bioN] })]);
    expect(profile.roles.map((r) => r.org)).not.toContain('Deloitte');
    expect(profile.boards).toEqual([{ org: 'Habitat Labs', role: 'board member', cites: [bioN] }]);
    expect(profile.roles[0]).toMatchObject({ org: 'Acme', current: true });
    expect(profile.headline).toBe(report.profile.headline);
  });

  test('mergeProfile sorts roles current first, then latest start, and fills a headline from the current role', () => {
    const merged = mergeProfile(null, {
      roles: [
        { org: 'Old Co', title: 'Engineer', from: 2010, to: 2012, current: false, cites: [3] },
        { org: 'New Co', title: 'Director', from: 2016, to: 2019, current: false, cites: [2] },
        { org: 'Acme', title: 'CEO', from: 2020, to: null, current: true, cites: [1] },
      ],
    });
    expect(merged.roles.map((r) => r.org)).toEqual(['Acme', 'New Co', 'Old Co']);
    expect(merged.headline).toBe('CEO, Acme');
    expect(merged.earlier.map((e) => e.org)).toEqual(['New Co', 'Old Co']);
  });
});

describe('Profile card', () => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  function report(profile) {
    return {
      name: 'Pat Example', company: 'Example Co', brief: 'Pat Example founded Example Co [Source 1].', briefInfo: { mode: 'quoted', reason: 'x' },
      totals: { records: 1, confirmed: 1, likely: 0, company: 0, possible: 0, redFlags: 0, seriousRecords: 0 },
      coverage: { searched: [], lookups: 1, rounds: 1, partlyAnswered: [], notSearched: [], notCovered: [], dropped: { tasks: 0, findings: 0, threads: 0 } },
      redFlags: [], companyMatters: [], possibleNamesake: [], claimChanges: [], relatedParties: [], timeline: [],
      sections: [{ key: 'career', title: 'Career', items: [{ id: 'r1', n: 1, url: 'https://example.test/1', title: 'Record 1', sourceLabel: 'Example', match: 'confirmed' }] }],
      notice: 'Public records only.',
      profile,
    };
  }
  beforeEach(() => { window.sessionStorage.clear(); window.localStorage.clear(); Element.prototype.scrollIntoView = jest.fn(); });
  afterEach(() => { delete global.fetch; });

  test('renders roles, education, boards, founded, investments, recognition and place, each with its citation', async () => {
    global.fetch = jest.fn(async () => ok({ jobId: 'job-p', done: true, report: report({
      headline: 'CEO, Example Co', headlineCites: [1], company: 'Example Co',
      roles: [{ org: 'Example Co', title: 'CEO', from: 2020, to: null, current: true, cites: [1] }, { org: 'Stripe', title: 'Product Manager', from: 2015, to: 2018, current: false, cites: [1] }],
      education: [{ school: 'Columbia Business School', degree: 'MBA', field: 'Finance', from: null, to: 2014, cites: [1] }],
      earlier: [{ org: 'Stripe', role: 'Product Manager', cites: [1] }],
      boards: [{ org: 'Girls Who Code', role: 'board member', cites: [1] }],
      founded: [{ org: 'Example Co', year: 2020, cites: [1] }],
      investments: [{ org: 'Ramp', cites: [1] }],
      recognition: [{ title: 'Forbes 30 Under 30', year: 2019, cites: [1] }],
      basedIn: { text: 'Brooklyn, New York', cites: [1] },
      about: [], links: [{ platform: 'linkedin', url: 'https://linkedin.com/in/pat' }],
    }) }));
    render(<DeepCheck name="Pat Example" company="Example Co" />);
    const heading = await screen.findByRole('heading', { name: 'Profile' });
    const card = within(heading.closest('section'));
    for (const label of ['Experience', 'Founded', 'Boards and advisory', 'Investments', 'Education', 'Recognition', 'Public profiles']) expect(card.getByText(label)).toBeTruthy();
    expect(card.getByText('2020 – present')).toBeTruthy();
    expect(card.getByText('2015 – 2018')).toBeTruthy();
    expect(card.getByText('· MBA, Finance')).toBeTruthy();
    expect(card.getByText('Forbes 30 Under 30')).toBeTruthy();
    expect(card.getByText(/Based in Brooklyn, New York/)).toBeTruthy();
    expect(card.getByText('LinkedIn').getAttribute('href')).toBe('https://linkedin.com/in/pat');
    expect(card.getAllByText('[1]').length).toBeGreaterThanOrEqual(9);
    expect(heading.closest('section').textContent).not.toMatch(/\b(?:API|key|token|free|paid|tier|quota)\b/i);
  });

  test('a report saved before roles were read still renders its headline and earlier roles', async () => {
    global.fetch = jest.fn(async () => ok({ jobId: 'job-old', done: true, report: report({
      headline: 'Founder, Example Co', headlineCites: [1], company: 'Example Co',
      education: [{ school: 'MIT', cites: [1] }], earlier: [{ org: 'Google', role: null, cites: [1] }], about: [], links: [],
    }) }));
    render(<DeepCheck name="Pat Example" company="Example Co" />);
    const heading = await screen.findByRole('heading', { name: 'Profile' });
    const card = within(heading.closest('section'));
    expect(card.getAllByText('Founder, Example Co').length).toBeGreaterThan(0);
    expect(card.getByText('Google')).toBeTruthy();
    expect(card.getByText('MIT')).toBeTruthy();
  });

  test('yearsOf', () => {
    expect(yearsOf({ from: 2015, to: 2017 })).toBe('2015 – 2017');
    expect(yearsOf({ from: 2015, current: true })).toBe('2015 – present');
    expect(yearsOf({})).toBe('');
  });
});
