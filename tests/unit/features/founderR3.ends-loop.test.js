/**
 * Round 3, loose ends of the deep check loop (deepCheck.js), from the lists phases 1 and 2 left:
 * the second reader's suggestions stay suggestions, a source's own "confirmed" is held to likely, a source that
 * asks for a declared contact says so, watchlist lookups are listed one by one, headline-only answers do not
 * teach the learner, place and register countries reach the sources, and a company's newly learned names
 * and domains are searched again.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState, stepDeepCheck, LIMITS, plainFailure } = require('../../../src/server/founder/deepCheck');
const { makeFinding, makeThread } = require('../../../src/server/founder/finding');
const { addCompanyAlias } = require('../../../src/server/founder/identity');
const { loadStats, __resetLearningForTests } = require('../../../src/server/learning');

const url = (s) => `https://example.com/${encodeURIComponent(String(s).toLowerCase().replace(/\s+/g, '-'))}`;
const finding = (subject, over) => makeFinding(subject, { source: 'fake', sourceLabel: 'Fake', category: 'press', url: url(over.title), ...over });
const quiet = (id, kinds, calls = null) => ({
  id, label: id, kinds, prior: 0.5,
  run: async (task) => { if (calls) calls.push(`${id}:${task.kind}:${task.value}${task.asAlias ? `:as ${task.asAlias}` : ''}`); return { findings: [] }; },
});
async function runToEnd(state, connectors, { limits = LIMITS, review = null, steps = 40 } = {}) {
  for (let i = 0; i < steps && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors, limits, review, deadline: Date.now() + 5000 });
}
const press = {
  id: 'press', label: 'Press', kinds: ['subject'],
  run: async (task, { subject }) => ({ findings: [finding(subject, { title: 'Ada Quill of Acme Corp', quote: 'Ada Quill, CEO of Acme Corp, spoke today.' })] }),
};

beforeEach(() => __resetLearningForTests());

describe('the second reader\'s suggestions (needs-phase2 fix:gaps)', () => {
  const suggestion = () => makeThread('company', 'Zeta Labs', 'co-founder of Zeta Labs (suggested by the second reading)', { trusted: true, suggested: true, origin: 'reader:f-1', statedRole: 'co-founder' });

  test('a suggested company is kept as a suggestion: its own origin, looked at only with the person', async () => {
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, [press], { review: async () => ({ threads: [suggestion()], searches: [] }), limits: { ...LIMITS, maxReviews: 1 } });
    const zeta = Object.values(state.threads).find((t) => t.value === 'Zeta Labs');
    expect(zeta).toMatchObject({ suggested: true, tie: 'affiliate', origin: 'reader:f-1' });
    // Round 4: the reader's statedRole was read from anywhere in the passage and nothing showed it; it is not kept.
    expect(zeta.statedRole).toBeUndefined();
    // a reader's clue is kept apart from the person's companies (identity.js 'related'), under its own origin
    expect((state.anchors.companies || []).some((a) => a.value === 'Zeta Labs')).toBe(false);
    expect(state.anchors.related.find((a) => a.value === 'Zeta Labs').origin).toBe('reader:f-1');
  });

  test('a record that states the tie later ends the suggestion and makes the anchor a found one', async () => {
    const later = {
      id: 'sec-company', label: 'SEC company', kinds: ['company'],
      run: async (task, { subject }) => {
        if (task.value !== 'Zeta Labs') return { findings: [] };
        const f = finding(subject, { title: 'Ada Quill of Acme Corp founded Zeta Labs', quote: 'Ada Quill, CEO of Acme Corp, co-founded Zeta Labs in 2015.', category: 'corporate' });
        return { findings: [f], threads: [makeThread('company', 'Zeta Labs', 'co-founder (filing)', { trusted: true })] };
      },
    };
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, [press, later], { review: async () => ({ threads: [suggestion()], searches: [] }), limits: { ...LIMITS, maxReviews: 1 } });
    const zeta = Object.values(state.threads).find((t) => t.value === 'Zeta Labs');
    expect(zeta.suggested).toBeUndefined();
    expect(zeta.tie).toBe('primary');
    expect(state.anchors.companies.find((a) => a.value === 'Zeta Labs').origin).toMatch(/^found:/);
  });
});

describe('a grade a source set by hand (needs-phase2 fix:sec)', () => {
  test('"confirmed" set by a source is held to likely unless the record confirms on its own', async () => {
    const src = {
      id: 'registry', label: 'Registry', kinds: ['subject'],
      run: async (task, { subject }) => ({ findings: [
        finding(subject, { title: 'Ada Quill listed', quote: 'Ada Quill appears in the list.', match: 'confirmed', matchReasons: ['the register says so'] }),
        finding(subject, { title: 'Ada Quill of Acme Corp, director', quote: 'Ada Quill, CEO of Acme Corp, is a director.', match: 'confirmed', matchReasons: ['the register says so'] }),
      ] }),
    };
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, [src]);
    expect(state.findings.find((f) => f.title === 'Ada Quill listed').match).toBe('likely');
    expect(state.findings.find((f) => /director/.test(f.title)).match).toBe('confirmed');
  });
});

describe('a source that asks for a declared contact (needs-phase2 fix:sec)', () => {
  test('its plain note reaches the log once, and the reason says what it asks for', async () => {
    const note = 'The SEC\'s website asks automated readers to declare a contact before it answers.';
    const src = {
      id: 'sec-enforcement', label: 'SEC enforcement', kinds: ['subject', 'company'],
      run: async () => { const e = new Error('did not answer'); e.code = 'not-declared'; e.status = 403; e.note = note; throw e; },
    };
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, [src]);
    expect(state.log.filter((l) => l.text === note)).toHaveLength(1);
    expect(state.sources['sec-enforcement'].lastError).toBe('asks for a declared contact before it answers');
    expect(plainFailure('did not answer', { code: 'not-declared' })).toBe('asks for a declared contact before it answers');
    expect(plainFailure('timed out after 9s')).toBe('did not respond in time');
  });
});

describe('watchlist lookups listed one by one (needs-phase2 fix:report)', () => {
  test('a watchlist lookup that answered in full is in screenedOk; one that failed is in screenFailed', async () => {
    const sources = [
      quiet('sanctions-lists', ['subject']),
      { id: 'us-exclusions', label: 'Exclusions', kinds: ['subject'], run: async () => { throw new Error('HTTP 500'); } },
      { id: 'wanted-lists', label: 'Wanted', kinds: ['subject'], run: async () => ({ findings: [], partial: ['one list'] }) },
      quiet('court-dockets', ['subject']),
    ];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources);
    expect(state.screenedOk).toEqual([expect.stringMatching(/^sanctions-lists\|subject\|ada quill\|/)]);
    expect(state.screenFailed).toEqual(expect.arrayContaining([expect.stringMatching(/^us-exclusions\|subject\|/), expect.stringMatching(/^wanted-lists\|subject\|/)]));
    expect(state.screenFailed.some((k) => k.startsWith('court-dockets'))).toBe(false);
  });
});

describe('headline-only answers (needs-phase2 fix:web)', () => {
  test('a lookup answered with noLearn does not count against its query pattern', async () => {
    const src = { id: 'web-search', label: 'Web', kinds: ['subject'], plan: () => [{ template: 'q.news' }], run: async () => ({ findings: [], noLearn: true, partial: ['headlines only'] }) };
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, [src]);
    const stats = await loadStats('query');
    const has = stats instanceof Map ? stats.has('web-search:q.news') : Boolean(stats && stats['web-search:q.news']);
    expect(has).toBe(false);
  });
});

describe('where the person is (needs-phase2 fix:web)', () => {
  test('the place typed and a tied register\'s country reach the sources', async () => {
    const seen = [];
    const sources = [
      {
        id: 'uk-companies-house', label: 'Companies House', kinds: ['subject'],
        run: async (task, { subject }) => ({ findings: [finding(subject, { source: 'uk-companies-house', category: 'corporate', title: 'Ada Quill, director of Acme Corp', quote: 'Ada Quill, CEO of Acme Corp, director.', data: { country: 'NO', registerNumber: '123' } })] }),
      },
      {
        id: 'web-search', label: 'Web', kinds: ['company'],
        run: async (task, { subject }) => { seen.push({ place: subject.place, countries: subject.countries }); return { findings: [] }; },
      },
    ];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp', place: 'Paris, France' });
    await stepDeepCheck(state, { connectors: sources, deadline: Date.now() + 5000 });
    await runToEnd(state, sources);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].place).toBe('Paris, France');
    expect(state.countries).toEqual(['NO']);
  });
});

describe('a company\'s newly learned names (design decision 1)', () => {
  test('a legal name a source registers is searched again by the registers, and the courts are asked again', async () => {
    const calls = [];
    const reader = {
      id: 'page-reader', label: 'Pages', kinds: ['company'],
      run: async (task, { subject }) => {
        if (task.value === 'Acme Corp' && !task.asAlias) addCompanyAlias(subject, { company: 'Acme Corp', alias: 'Acme Widgets Inc', origin: 'found:page-1' });
        return { findings: [] };
      },
    };
    const sources = [press, reader, quiet('court-dockets', ['company'], calls), quiet('trademarks', ['company'], calls), quiet('breach-registers', ['company'], calls)];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources);
    expect(calls).toEqual(expect.arrayContaining([
      'court-dockets:company:Acme Corp',
      'court-dockets:company:Acme Corp:as Acme Widgets Inc',
      'trademarks:company:Acme Widgets Inc',
      'breach-registers:company:Acme Widgets Inc',
    ]));
    // once each
    expect(calls.filter((c) => c === 'court-dockets:company:Acme Corp:as Acme Widgets Inc')).toHaveLength(1);
    expect(Object.keys(state.legalNames || {})).toContain('acme widgets');
  });

  test('a domain learned for the company is followed by the domain sources, with the founding year when known', async () => {
    const calls = [];
    const reader = {
      id: 'page-reader', label: 'Pages', kinds: ['company'],
      run: async (task, { subject }) => { addCompanyAlias(subject, { company: 'Acme Corp', alias: 'acmewidgets.com', origin: 'found:page-1' }); return { findings: [] }; },
    };
    const domains = { id: 'breach-catalogue', label: 'Breaches', kinds: ['domain'], run: async (task) => { calls.push(`${task.kind}:${task.value}`); return { findings: [] }; } };
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, [press, reader, domains]);
    expect(calls).toContain('domain:acmewidgets.com');
    expect(state.anchors.domains.some((d) => d.value === 'acmewidgets.com')).toBe(true);
  });
});

describe('another name found in a record (needs-phase2 fix:knowledge)', () => {
  test('a record found only under a name read from a record is likely at most', async () => {
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    state.threads['alias|ada smith'] = { kind: 'alias', value: 'Ada Smith', why: 'née Smith (in a record about them)', depth: 1, trusted: true, support: 1, pulled: true };
    state.queue.push({ connector: 'sanctions-lists', kind: 'alias', value: 'Ada Smith', depth: 1, template: null, params: null, prior: 0.5, why: 'x', relation: null });
    const src = {
      id: 'sanctions-lists', label: 'Sanctions', kinds: ['alias'],
      run: async (task, { subject }) => ({ findings: task.kind === 'alias' ? [finding(subject, { title: 'Ada Quill of Acme Corp listed', quote: 'Ada Quill, CEO of Acme Corp, listed.', category: 'sanctions' })] : [] }),
    };
    await runToEnd(state, [src]);
    const f = state.findings.find((x) => /listed/.test(x.title));
    expect(f.match).not.toBe('confirmed');
  });
});
