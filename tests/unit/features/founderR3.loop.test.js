/**
 * Round 3, the deep check loop (deepCheck.js): anchor strength (a likely record never confirms others or
 * itself; the second reader's suggestions never raise a record alone), screens that always run and are
 * never shown as clean when they did not run, a poisoned source, a second reader that did not answer, an
 * inferred or assumed company, earlier ventures, legal names, and the new start inputs.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const {
  startState, stepDeepCheck, LIMITS, validateCheckInput, validatePersonName, validateProfileUrl, validateWebsite, statesVenture, isScreenTask,
} = require('../../../src/server/founder/deepCheck');
const { makeFinding, makeThread } = require('../../../src/server/founder/finding');
const { createSubject } = require('../../../src/server/founder/identity');
const { recordStats, __resetLearningForTests } = require('../../../src/server/learning');

const url = (s) => `https://example.com/${encodeURIComponent(String(s).toLowerCase().replace(/\s+/g, '-'))}`;
const finding = (subject, over) => makeFinding(subject, { source: 'fake', sourceLabel: 'Fake', category: 'press', url: url(over.title), ...over });
const quiet = (id, kinds = ['subject', 'company', 'associate', 'relative'], calls = null) => ({
  id, label: id, kinds, prior: 0.5,
  run: async (task) => { if (calls) calls.push(`${id}:${task.kind}:${task.value}`); return { findings: [] }; },
});

async function runToEnd(state, connectors, { limits = LIMITS, review = null, steps = 40 } = {}) {
  let progress;
  for (let i = 0; i < steps && state.phase === 'collect'; i += 1) ({ progress } = await stepDeepCheck(state, { connectors, limits, review, deadline: Date.now() + 5000 }));
  return progress;
}

beforeEach(() => __resetLearningForTests());

describe('anchor strength', () => {
  test('a company read from a likely record never confirms other records, nor the record it came from', async () => {
    const sources = [
      {
        id: 'profile', label: 'Profile', kinds: ['subject'],
        run: async (task, { subject }) => {
          const f = finding(subject, { title: 'Ada Quill of Acme Corp', quote: 'Ada Quill, CEO of Acme Corp, studied at Stanford University.', category: 'career' });
          return { findings: [f], threads: [makeThread('school', 'Stanford University', 'school (profile)', { trusted: f.match !== 'possible' })] };
        },
      },
      {
        id: 'alumni', label: 'Alumni', kinds: ['school'],
        run: async (task, { subject }) => {
          // a namesake: tied only by the school, so likely
          const f = finding(subject, { title: 'Alumni news', quote: 'Ada Quill, a Stanford University graduate, founded Zeta Bank.', category: 'career' });
          return { findings: [f], threads: [makeThread('company', 'Zeta Bank', 'founder (profile)', { trusted: f.match !== 'possible' })] };
        },
      },
      {
        id: 'news', label: 'News', kinds: ['company'],
        run: async (task, { subject }) => (task.value === 'Zeta Bank'
          ? { findings: [finding(subject, { title: 'Zeta Bank founder Ada Quill sentenced for fraud', quote: 'Zeta Bank founder Ada Quill was sentenced for fraud.', category: 'litigation', severity: 'high' })] }
          : { findings: [] }),
      },
    ];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources);
    const alumni = state.findings.find((f) => f.title === 'Alumni news');
    const sentenced = state.findings.find((f) => /sentenced/.test(f.title));
    expect(alumni.match).toBe('likely'); // never lifted by the company it produced itself
    expect(sentenced.match).toBe('likely'); // a likely record's company makes records likely at most
    const zeta = state.anchors.companies.find((a) => a.value === 'Zeta Bank');
    expect(zeta.origin).toMatch(/^weak:/);
    expect(state.anchors.companies.find((a) => a.value === 'Acme Corp').origin).toBe('given');
  });

  test('an anchor the second reader proposed never raises a record on its own', async () => {
    const sources = [{
      id: 'press', label: 'Press', kinds: ['subject'],
      run: async (task, { subject }) => ({ findings: [
        finding(subject, { title: 'Ada Quill of Acme Corp', quote: 'Ada Quill leads Acme Corp.' }),
        finding(subject, { title: 'Stanford event', quote: 'Ada Quill spoke at Stanford University about fraud.' }),
        finding(subject, { title: 'Another page', quote: 'Ada Quill was in the news.' }),
      ] }),
    }];
    const review = async () => ({ threads: [makeThread('school', 'Stanford University', 'school the records suggest', { trusted: true })], searches: [] });
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources, { review, limits: { ...LIMITS, maxReviews: 1 } });
    expect(state.findings.find((f) => f.title === 'Stanford event').match).toBe('possible');
    expect(state.threads['school|stanford university']).toMatchObject({ trusted: true, suggested: true });
    // The reader's school is kept apart as a 'related' anchor (identity.js, needs-phase2 entry 1), never as one of their schools.
    expect((state.anchors.schools || []).find((a) => a.value === 'Stanford University')).toBeUndefined();
    expect(state.anchors.related.find((a) => a.value === 'Stanford University')).toMatchObject({ as: 'schools', origin: 'reader' });
  });

  test('a likely grade that rests only on an encyclopedia link does not make its threads trusted', async () => {
    const calls = [];
    const sources = [
      {
        id: 'press', label: 'Press', kinds: ['subject'],
        run: async (task, { subject }) => {
          const f = finding(subject, { title: 'Ada Quill and Peter Thiel', quote: 'Ada Quill and Peter Thiel founded Zeta Labs together.' });
          return { findings: [f], threads: [makeThread('company', 'Zeta Labs', 'founder (profile)', { trusted: f.match !== 'possible' })] };
        },
      },
      quiet('registry', ['company'], calls),
    ];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    state.anchors.related = [{ value: 'Peter Thiel', as: 'people', origin: 'encyclopedia' }];
    await runToEnd(state, sources);
    expect(state.findings[0].match).toBe('likely');
    expect(Object.values(state.threads).find((t) => t.value === 'Zeta Labs')?.trusted).toBe(false);
    expect(calls).not.toContain('registry:company:Zeta Labs');
  });
});

describe('screens', () => {
  test('a related party whose watchlist screen failed or waited out is not recorded as screened', async () => {
    const sources = [
      {
        id: 'press', label: 'Press', kinds: ['subject'],
        run: async (task, { subject }) => {
          const f = finding(subject, { title: 'Ada Quill of Acme Corp', quote: 'Ada Quill of Acme Corp works with Mark Russell and Lena Ortiz.' });
          return { findings: [f], threads: [makeThread('associate', 'Mark Russell', 'co-founder', { trusted: true }), makeThread('associate', 'Lena Ortiz', 'co-founder', { trusted: true })] };
        },
      },
      {
        id: 'sanctions-lists', label: 'Sanctions', kinds: ['subject', 'company', 'associate'],
        run: async (task) => {
          if (task.value === 'Mark Russell') throw new Error('HTTP 500');
          if (task.value === 'Lena Ortiz') { const e = new Error('Search allowance used up'); e.code = 'SEARCH_RESTING'; e.retryAt = Date.now() + 60 * 60 * 1000; throw e; }
          return { findings: [] };
        },
      },
    ];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources);
    expect(state.done.filter((k) => k.startsWith('sanctions-lists|associate'))).toEqual([]);
    expect(state.screened['mark russell']).toMatchObject({ ok: [], missed: ['sanctions-lists'] });
    expect(state.screened['lena ortiz']).toMatchObject({ ok: [], missed: ['sanctions-lists'] });
    expect(state.screened['ada quill']).toMatchObject({ ok: ['sanctions-lists'], missed: [] });
    expect(state.sources['sanctions-lists'].waitedOut).toBe(1);
  });

  test('a watchlist that answered only in part has not screened the person', async () => {
    const sources = [{ id: 'sanctions-lists', label: 'Sanctions', kinds: ['subject'], run: async () => ({ findings: [], partial: ['UK list'] }) }];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources);
    expect(state.screened['ada quill']).toMatchObject({ ok: [], missed: ['sanctions-lists'] });
    expect(state.done).toEqual([]);
  });

  test('screens dropped at a stop are recorded per source as not run, never left looking clean or missing', async () => {
    const sources = [quiet('sanctions-lists'), quiet('court-dockets', ['subject', 'company']), quiet('us-exclusions', ['subject', 'company'])];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources, { limits: { ...LIMITS, maxTasks: 1 } });
    // 6 screen lookups, a budget of 1 and a reserve of 1 more: the rest are not run, and each source says so
    let notRun = 0;
    for (const id of ['sanctions-lists', 'court-dockets', 'us-exclusions']) {
      const s = state.sources[id];
      expect(s).toBeDefined();
      notRun += s.notRun || 0;
      if (s.notRun) expect(s.partial.some((p) => /^not run: /.test(p))).toBe(true);
    }
    expect(notRun).toBe(4);
    expect(state.tasksRun).toBe(2);
    expect(state.dropped.tasks).toBe(4);
  });

  test('screens run first whatever learning says, are kept out of query learning, and are never dropped by a dry stop', async () => {
    // Learning has seen sanctions lookups lose sixty times
    await recordStats('query', Array.from({ length: 60 }, () => ({ key: 'sanctions-lists', win: 0, ms: 10 })));
    const calls = [];
    const web = {
      id: 'web-search', label: 'Web', kinds: ['subject', 'company', 'associate'],
      plan: () => Array.from({ length: 6 }, (_, i) => ({ template: `q.${i}`, prior: 0.9 })),
      run: async (task) => { calls.push(`web:${task.kind}:${task.value}:${task.template}`); return { findings: [] }; },
    };
    const sources = [web, quiet('sanctions-lists', undefined, calls), quiet('court-dockets', ['subject', 'company'], calls)];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources, { limits: { ...LIMITS, maxTasks: 6, concurrency: 1 } });
    for (const c of ['sanctions-lists:subject:Ada Quill', 'sanctions-lists:company:Acme Corp', 'court-dockets:subject:Ada Quill', 'court-dockets:company:Acme Corp']) expect(calls).toContain(c);
    // run before any web lookup
    expect(calls.findIndex((c) => c.startsWith('web:'))).toBeGreaterThanOrEqual(4);
    expect(state.sources['sanctions-lists'].notRun || 0).toBe(0);
  });

  test('isScreenTask covers the person, their companies and related parties on watchlists, not affiliates or searches', () => {
    expect(isScreenTask({ connector: 'sanctions-lists', kind: 'subject' })).toBe(true);
    expect(isScreenTask({ connector: 'court-dockets', kind: 'company', tie: 'primary' })).toBe(true);
    expect(isScreenTask({ connector: 'court-dockets', kind: 'company', tie: 'affiliate' })).toBe(false);
    expect(isScreenTask({ connector: 'court-dockets', kind: 'company', tie: 'affiliate', venture: true })).toBe(true);
    expect(isScreenTask({ connector: 'sanctions-lists', kind: 'relative' })).toBe(true);
    expect(isScreenTask({ connector: 'web-search', kind: 'subject' })).toBe(false);
  });
});

describe('robustness', () => {
  test('a source whose plan() or enabled() throws is reported as not planned; the check carries on', async () => {
    const calls = [];
    const sources = [
      { id: 'poison', label: 'Poison', kinds: ['subject', 'company'], plan: () => { throw new TypeError('x is undefined'); }, run: async () => ({ findings: [] }) },
      { id: 'poison2', label: 'Poison 2', kinds: ['subject'], enabled: () => { throw new Error('bad config'); }, run: async () => ({ findings: [] }) },
      quiet('fine', ['subject', 'company'], calls),
    ];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await expect(runToEnd(state, sources)).resolves.toBeDefined();
    expect(state.phase).toBe('report');
    expect(calls).toEqual(expect.arrayContaining(['fine:subject:Ada Quill', 'fine:company:Acme Corp']));
    expect(state.sources.poison).toMatchObject({ runs: 0, lastError: 'could not be planned' });
    expect(state.sources.poison.notRun).toBeGreaterThan(0);
    expect(state.sources.poison2).toMatchObject({ runs: 0, lastError: 'could not be planned' });
  });

  test('a second reader that throws is reported as not answering, and nothing queued is dropped for it', async () => {
    const calls = [];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await stepDeepCheck(state, { connectors: [quiet('fine', ['subject', 'company'], calls)], deadline: Date.now() + 5000 });
    state.phase = 'collect';
    state.needsReview = true;
    state.queue.push({ connector: 'fine', kind: 'company', value: 'Beta Labs', depth: 1, template: null, params: null, prior: 0.5, why: 'x', relation: null, tie: 'primary' });
    await stepDeepCheck(state, { connectors: [quiet('fine', ['subject', 'company'], calls)], review: async () => { throw new Error('model timed out'); }, deadline: Date.now() + 5000 });
    expect(state.log.some((l) => /did not answer in time/.test(l.text))).toBe(true);
    expect(state.log.some((l) => /found nothing more/.test(l.text))).toBe(false);
    expect(calls).toContain('fine:company:Beta Labs');
  });

  test('a second reader that says it did not answer is retried once, not read as "nothing more"', async () => {
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await stepDeepCheck(state, { connectors: [quiet('fine', ['subject', 'company'])], deadline: Date.now() + 5000 });
    Object.assign(state, { phase: 'collect', needsReview: true, queue: [], reviews: 0 });
    let asked = 0;
    const review = async () => { asked += 1; return { threads: [], searches: [], failed: true }; };
    await runToEnd(state, [quiet('fine', ['subject', 'company'])], { review, limits: { ...LIMITS, maxReviews: 2 } });
    expect(asked).toBe(2);
    expect(state.phase).toBe('report');
    expect(state.log.some((l) => /found nothing more/.test(l.text))).toBe(false);
  });

  test('a lookup refused before any request went out is not run, not a failure of the source', async () => {
    const sources = [{ id: 'page-reader', label: 'Pages', kinds: ['subject'], run: async () => { const e = new Error('a private address'); e.code = 'blocked'; throw e; } }];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources);
    expect(state.sources['page-reader']).toMatchObject({ errors: 0, notRun: 1 });
    expect(state.done).toEqual([]);
  });
});

describe('identity without a company typed', () => {
  const twoSites = (company, extra = []) => [
    {
      id: 'news', label: 'News', kinds: ['subject'],
      plan: () => [{ template: 'a' }, { template: 'b' }],
      run: async (task, { subject }) => {
        const host = task.template === 'a' ? 'https://one.test' : 'https://two.test';
        const f = finding(subject, { title: `Ada Quill profile ${task.template}`, quote: `Ada Quill runs ${company}.`, url: `${host}/p` });
        return { findings: [f], threads: [makeThread('company', company, 'named with the person')] };
      },
    },
    ...extra,
  ];

  test('records tied only through an inferred company are marked as resting on it', async () => {
    const charged = { id: 'doj', label: 'DOJ', kinds: ['company'], run: async (task, { subject }) => ({ findings: [finding(subject, { title: 'Acme Corp CEO Ada Quill charged with fraud', quote: 'Ada Quill, CEO of Acme Corp, was charged.', category: 'litigation', severity: 'high' })] }) };
    const state = startState({ name: 'Ada Quill' });
    await runToEnd(state, twoSites('Acme Corp', [charged]));
    expect(state.identity).toMatchObject({ status: 'inferred', company: 'Acme Corp' });
    const f = state.findings.find((x) => /charged/.test(x.title));
    expect(f.match).toBe('likely');
    expect(f.assumedTie).toBe(true);
  });

  test('a very common name is never pinned to the best-covered namesake', async () => {
    const state = startState({ name: 'John Smith' });
    await runToEnd(state, twoSites('Acme Corp'));
    expect(state.identity.status).not.toBe('inferred');
    expect(state.anchors.companies).toEqual([]);
  });

  test('a company assumed from the network makes records likely at most, and is said to be assumed', async () => {
    const src = { id: 'press', label: 'Press', kinds: ['subject'], run: async (task, { subject }) => ({ findings: [finding(subject, { title: 'Ada Quill of Acme Corp sued', quote: 'Ada Quill, CEO of Acme Corp, was sued.' })] }) };
    const state = startState({ name: 'Ada Quill', assumedCompany: 'Acme Corp' });
    expect(state.company).toBe('');
    expect(state.identity).toMatchObject({ status: 'assumed', company: 'Acme Corp' });
    expect(state.anchors.companies).toEqual([{ value: 'Acme Corp', origin: 'network' }]);
    await runToEnd(state, [src]);
    expect(state.findings[0]).toMatchObject({ match: 'likely', assumedTie: true });
  });
});

describe('earlier ventures and legal names', () => {
  test('an earlier company the person founded, read from a tied record, gets its own court and watchlist screens', async () => {
    const calls = [];
    const sources = [
      {
        id: 'press', label: 'Press', kinds: ['subject'],
        run: async (task, { subject }) => {
          const f = finding(subject, { title: 'Ada Quill of Acme Corp', quote: 'Ada Quill, CEO of Acme Corp, previously co-founded Zeta Labs.' });
          return { findings: [f], threads: [makeThread('company', 'Zeta Labs', 'co-founder (past)', { trusted: f.match !== 'possible' })] };
        },
      },
      quiet('court-dockets', ['company'], calls),
      quiet('sanctions-lists', ['company'], calls),
    ];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources);
    expect(Object.values(state.threads).find((t) => t.value === 'Zeta Labs')).toMatchObject({ tie: 'affiliate', venture: true });
    expect(calls).toEqual(expect.arrayContaining(['court-dockets:company:Zeta Labs', 'sanctions-lists:company:Zeta Labs']));
  });

  test('statesVenture reads the role the person held, not someone else\'s or a later clause', () => {
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    expect(statesVenture(s, 'He previously co-founded Paribus. Eric Glyman co-founded Paribus in 2014.', 'Paribus')).toBe(true);
    expect(statesVenture(s, 'Eric Glyman, co-founder and CEO of Paribus, said.', 'Paribus')).toBe(true);
    expect(statesVenture(s, 'Eric Glyman recently joined Erik Torenberg (Co-founder of Village Global) on stage.', 'Village Global')).toBe(false);
    expect(statesVenture(s, 'Eric Glyman co-founded Ramp and sits on the board of Meta Platforms.', 'Meta Platforms')).toBe(false);
    const d = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    expect(statesVenture(d, 'Shensi Ding and Gil Feig founded Merge in 2020.', 'Merge')).toBe(true);
  });

  test('a legal name from a filing naming the person is learned and the registers are asked again under it, once', async () => {
    const calls = [];
    const sources = [
      {
        id: 'sec-filings', label: 'SEC filings', kinds: ['subject'],
        run: async (task, { subject }) => ({ findings: [makeFinding(subject, {
          source: 'sec-filings', sourceLabel: 'SEC Form D notices', category: 'corporate', url: 'https://www.sec.gov/x/1',
          title: 'Form D filed by Ramp Business Corp names Eric Glyman as Executive Officer and Director',
          data: { form: 'D', issuer: 'Ramp Business Corp', roles: ['Executive Officer'] },
        })] }),
      },
      quiet('trademarks', ['company'], calls),
      quiet('us-lobbying', ['subject', 'company'], calls),
      quiet('court-dockets', ['subject', 'company'], calls),
    ];
    const state = startState({ name: 'Eric Glyman', company: 'Ramp' });
    await runToEnd(state, sources);
    expect(state.anchors.aliases).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'Ramp Business Corp', of: 'ramp' })]));
    expect(calls).toEqual(expect.arrayContaining(['trademarks:company:Ramp', 'trademarks:company:Ramp Business Corp', 'us-lobbying:company:Ramp Business Corp']));
    // courts are not in the legal-name list; each legal name is followed once
    expect(calls).not.toContain('court-dockets:company:Ramp Business Corp');
    expect(calls.filter((c) => c === 'trademarks:company:Ramp Business Corp')).toHaveLength(1);
    expect(Object.keys(state.legalNames)).toEqual(['ramp business']);
    // the filing that gave the name is tied to the person (likely at least: it lists them as an officer)
    expect(['likely', 'confirmed']).toContain(state.findings.find((f) => f.source === 'sec-filings').match);
  });

  test('a record about another company sharing the word never becomes a legal name', async () => {
    const calls = [];
    const sources = [
      {
        id: 'sec-filings', label: 'SEC filings', kinds: ['subject'],
        run: async (task, { subject }) => ({ findings: [makeFinding(subject, {
          source: 'sec-filings', sourceLabel: 'SEC', category: 'corporate', url: 'https://www.sec.gov/x/2',
          title: 'Form D filed by Ramp Network Ltd', quote: 'Issuer: Ramp Network Ltd.', data: { form: 'D', issuer: 'Ramp Network Ltd' },
        })] }),
      },
      quiet('trademarks', ['company'], calls),
    ];
    const state = startState({ name: 'Eric Glyman', company: 'Ramp' });
    await runToEnd(state, sources);
    expect(calls).not.toContain('trademarks:company:Ramp Network Ltd');
    expect(state.anchors.aliases || []).toEqual([]);
  });
});

describe('start inputs', () => {
  test('names in any script, one-word names with a company, and plain reasons for the rest', () => {
    expect(validatePersonName('José Núñez-García')).toMatchObject({ ok: true, name: 'José Núñez-García' });
    expect(validatePersonName('张一鸣')).toMatchObject({ ok: true, name: '张一鸣' });
    expect(validatePersonName('Владимир Потанин')).toMatchObject({ ok: true });
    expect(validatePersonName('Malcolm X')).toMatchObject({ ok: true });
    expect(validatePersonName('Sukarno')).toMatchObject({ ok: false });
    expect(validatePersonName('Sukarno', { company: 'Acme' })).toMatchObject({ ok: true, mononym: true });
    expect(validatePersonName('J S').error).toMatch(/initials/);
    expect(validatePersonName('jo@x.com y').error).toMatch(/email/);
    expect(validatePersonName('Jane Roe site:example.com').ok).toBe(false);
    expect(validatePersonName('Jane Roe -fraud').ok).toBe(false);
    expect(validatePersonName('Jane 2 Roe').error).toMatch(/digits/);
    expect(validatePersonName('x'.repeat(130) + ' y').error).toMatch(/too long/);
    // bidi overrides and zero-width characters are removed, not kept in the name
    expect(validatePersonName('Jane​ Roe‮')).toMatchObject({ ok: true, name: 'Jane Roe' });
  });

  test('optional inputs are checked and cleaned; none of them is required', () => {
    expect(validateCheckInput({ name: 'Eric Glyman', company: 'Ramp' })).toMatchObject({ ok: true, value: { name: 'Eric Glyman', company: 'Ramp', otherCompanies: [], otherNames: [] } });
    const v = validateCheckInput({
      name: 'Eric Glyman', company: 'Ramp site:ramp.com', website: 'https://www.ramp.com/about', profileUrl: 'https://www.linkedin.com/in/eglyman/',
      place: 'New York', otherCompanies: ['Paribus', ''], school: 'Harvard University', otherNames: ['Glymann'],
    });
    expect(v).toMatchObject({ ok: true, value: { company: 'Ramp', website: 'ramp.com', profile: { platform: 'linkedin', handle: 'eglyman' }, place: 'New York', otherCompanies: ['Paribus'], school: 'Harvard University', otherNames: ['Eric Glymann'] } });
    expect(validateCheckInput({ name: 'Eric Glyman', place: '12 Elm Street' })).toMatchObject({ ok: false, field: 'place' });
    expect(validateWebsite('linkedin.com/in/x')).toMatchObject({ ok: false });
    expect(validateWebsite('http://127.0.0.1')).toMatchObject({ ok: false });
    expect(validateProfileUrl('https://github.com/eglyman')).toMatchObject({ ok: true, value: { platform: 'github', handle: 'eglyman' } });
    expect(validateProfileUrl('https://www.linkedin.com/company/ramp')).toMatchObject({ ok: false });
  });

  test('given inputs become given anchors and threads; LinkedIn is never queued to be opened', async () => {
    const calls = [];
    const v = validateCheckInput({ name: 'Eric Glyman', company: 'Ramp', website: 'ramp.com', profileUrl: 'https://linkedin.com/in/eric-glyman-81972a435', otherCompanies: ['Paribus'], school: 'Harvard University', otherNames: ['Eric R. Glyman'] }).value;
    const state = startState(v);
    expect(state.anchors.handles).toEqual([{ value: 'eric-glyman-81972a435', origin: 'given' }]);
    expect(state.anchors.domains).toEqual([{ value: 'ramp.com', origin: 'given' }]);
    expect(state.anchors.schools).toEqual([{ value: 'Harvard University', origin: 'given' }]);
    expect(state.anchors.companies.map((a) => [a.value, a.origin])).toEqual([['Ramp', 'given'], ['Paribus', 'given']]);
    expect(state.otherNames).toEqual(['Eric R. Glyman']);
    const any = { id: 'any', label: 'Any', kinds: ['subject', 'company', 'school', 'handle', 'domain', 'url'], run: async (task) => { calls.push(`${task.kind}:${task.value}`); return { findings: [] }; } };
    // an earlier company given is looked at as an affiliate: what ties the two together (filings, registers)
    const sec = { id: 'sec-company', label: 'SEC', kinds: ['company'], run: async (task) => { calls.push(`company:${task.value}`); return { findings: [] }; } };
    await runToEnd(state, [any, sec]);
    expect(calls).toEqual(expect.arrayContaining(['company:Paribus', 'school:Harvard University', 'domain:ramp.com']));
    expect(calls.some((c) => /linkedin|^handle:/.test(c))).toBe(false);
    // a record naming the person and the handle is tied by the handle given
    const subject = createSubject({ name: 'Eric Glyman' });
    expect(subject.hasName('Eric Glyman')).toBe(true);
  });

  test('a handle that is only the name run together ties nothing', () => {
    // "eglyman" (first initial and surname) is a form any Eric or Emily Glyman may use
    const state = startState({ name: 'Eric Glyman', company: 'Ramp', profile: { platform: 'linkedin', handle: 'eglyman' } });
    expect(state.anchors.handles).toEqual([]);
  });
});
