/**
 * The deep check loop, run with fake sources: threads are pulled round by
 * round, only trusted threads are followed, records are re-graded as more
 * becomes known, limits are reported (never silent), and outcomes are
 * recorded for learning.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState, stepDeepCheck, LIMITS } = require('../../../src/server/founder/deepCheck');
const { makeFinding, makeThread } = require('../../../src/server/founder/finding');
const { loadStats, __resetLearningForTests } = require('../../../src/server/learning');

const finding = (subject, over) => makeFinding(subject, { source: 'fake', sourceLabel: 'Fake', category: 'press', url: `https://example.com/${encodeURIComponent(String(over.title).toLowerCase().replace(/\s+/g, '-'))}`, ...over });

function fakeSources(calls) {
  return [
    {
      id: 'profiles', label: 'Profiles', kinds: ['subject'], prior: 0.7,
      run: async (task, { subject }) => {
        calls.push(`profiles:${task.value}`);
        const f = finding(subject, { title: 'Trevor Milton, founder of Nikola', quote: 'Trevor Milton founded Nikola after dHybrid Systems.', category: 'career' });
        return { findings: [f], threads: [makeThread('company', 'dHybrid Systems', 'founder (past; Wikidata)', { trusted: f.match !== 'possible' }), makeThread('company', 'Milton Bakery', 'a namesake', { trusted: false })] };
      },
    },
    {
      id: 'news', label: 'News', kinds: ['subject', 'company', 'associate'], prior: 0.5,
      plan: (thread) => (thread.kind === 'subject' ? [{ template: 'q.litigation' }, { template: 'q.fraud' }] : [{ template: 'q.joint' }]),
      run: async (task, { subject }) => {
        calls.push(`news:${task.kind}:${task.value}:${task.template}`);
        if (task.kind === 'company' && task.value === 'dHybrid Systems') {
          const f = finding(subject, { title: 'Trevor Milton sued over dHybrid Systems sale', quote: 'Swift sued Trevor Milton and dHybrid Systems; co-founder Mark Russell was not named.', category: 'litigation', severity: 'high' });
          return { findings: [f], threads: [makeThread('associate', 'Mark Russell', 'named with the subject', { trusted: true })] };
        }
        if (task.kind === 'subject' && task.template === 'q.fraud') {
          return { findings: [finding(subject, { title: 'Trevor Milton convicted of fraud', quote: 'Trevor Milton was convicted.', category: 'regulatory', severity: 'high' })] };
        }
        return { findings: [] };
      },
    },
    { id: 'broken', label: 'Broken source', kinds: ['subject'], run: async () => { throw new Error('HTTP 503'); } },
    { id: 'needs-key', label: 'Needs a key', kinds: ['subject'], enabled: () => false, unavailableReason: 'Not enabled on this deployment.', run: async () => ({ findings: [] }) },
  ];
}

async function runToEnd(state, connectors, limits) {
  let progress;
  for (let i = 0; i < 30 && state.phase === 'collect'; i += 1) ({ progress } = await stepDeepCheck(state, { connectors, limits, deadline: Date.now() + 5000 }));
  return progress;
}

beforeEach(() => __resetLearningForTests());

test('pulls trusted threads round by round and stops when nothing is new', async () => {
  const calls = [];
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  const progress = await runToEnd(state, fakeSources(calls));
  expect(state.phase).toBe('report');
  // round 1: the person and the given company; round 2: the earlier company found in round 1; round 3: the associate found in round 2
  expect(calls).toEqual(expect.arrayContaining([
    'profiles:Trevor Milton', 'news:subject:Trevor Milton:q.litigation', 'news:subject:Trevor Milton:q.fraud',
    'news:company:Nikola:q.joint', 'news:company:dHybrid Systems:q.joint', 'news:associate:Mark Russell:q.joint',
  ]));
  // the namesake's company was recorded but never pulled and never became an anchor
  expect(calls.some((c) => c.includes('Milton Bakery'))).toBe(false);
  expect(state.threads['company|milton bakery']).toMatchObject({ trusted: false, pulled: false });
  expect(state.anchors.companies.map((a) => a.value)).toEqual(expect.arrayContaining(['Nikola', 'dHybrid Systems']));
  expect(state.anchors.people.map((a) => a.value)).toEqual(['Mark Russell']);
  // a record that named only the person is upgraded once the earlier company is known
  const sued = state.findings.find((f) => /sued over dHybrid/.test(f.title));
  expect(sued.match).toBe('confirmed');
  expect(state.findings.find((f) => /convicted/.test(f.title)).match).toBe('possible'); // name only: stays a possible namesake
  expect(progress.findings).toBe(3);
  expect(progress.byCategory).toEqual({ career: 1, litigation: 1, regulatory: 1 });
  // a failing source is reported, a disabled one is listed as not searched
  expect(progress.sources.find((s) => s.id === 'broken')).toMatchObject({ errors: 1, lastError: 'could not be reached' });
  expect(progress.sources.find((s) => s.id === 'needs-key')).toMatchObject({ runs: 0, lastError: 'Not enabled on this deployment.' });
  expect(state.log.some((l) => /Round 1: \d+ lookups, 2 new records, 1 new threads? to pull \(1 company\)/.test(l.text))).toBe(true);
});

test('never repeats a lookup and never duplicates a record', async () => {
  const calls = [];
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  await runToEnd(state, fakeSources(calls));
  expect(new Set(calls).size).toBe(calls.length);
  expect(new Set(state.findings.map((f) => f.id)).size).toBe(state.findings.length);
});

test('with no company, the check follows the company most sources name, and says so', async () => {
  const sources = [{
    id: 'a', label: 'A', kinds: ['subject'], plan: () => [{ template: '1' }, { template: '2' }, { template: '3' }],
    run: async (task, { subject }) => ({
      findings: [finding(subject, { title: `Jane Roe profile ${task.template}`, quote: 'Jane Roe leads Acme Robotics.', url: `https://site${task.template}.test/jane-roe` })],
      threads: [makeThread('company', task.template === '3' ? 'Roe Dental' : 'Acme Robotics', 'named in a profile', { trusted: false })],
    }),
  }, { id: 'b', label: 'B', kinds: ['company'], run: async (task, { subject }) => ({ findings: [finding(subject, { title: `Jane Roe and ${task.value} raise a round`, quote: `Jane Roe of ${task.value}.` })] }) }];
  const state = startState({ name: 'Jane Roe' });
  await runToEnd(state, sources);
  expect(state.identity.status).toBe('inferred');
  expect(state.identity.note).toMatch(/Acme Robotics/);
  expect(state.anchors.companies.map((a) => a.value)).toEqual(['Acme Robotics']);
  // an inferred company is not proof: records naming it are at most likely, never confirmed
  expect(state.findings.filter((f) => f.match === 'confirmed')).toHaveLength(0);
  expect(state.findings.filter((f) => f.match === 'likely').length).toBeGreaterThanOrEqual(3);
  expect(state.threads['company|roe dental'].pulled).toBe(false);
});

test('the lookup budget is enforced and what was dropped is reported', async () => {
  const sources = [{ id: 'many', label: 'Many', kinds: ['subject'], plan: () => Array.from({ length: 12 }, (_, i) => ({ template: `t${i}` })), run: async () => ({ findings: [] }) }];
  const state = startState({ name: 'Jane Roe', company: 'Acme' });
  await runToEnd(state, sources, { ...LIMITS, maxTasks: 5, concurrency: 2 });
  expect(state.tasksRun).toBe(5);
  expect(state.dropped.tasks).toBe(7);
  expect(state.log[state.log.length - 1].text).toMatch(/7 lookups not run \(the lookup budget/);
});

test('outcomes are recorded so later checks try what worked first', async () => {
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  await runToEnd(state, fakeSources([]));
  const stats = await loadStats('query');
  expect(stats.get('profiles')).toMatchObject({ tries: 1, wins: 1 });
  expect(stats.get('news:q.litigation')).toMatchObject({ tries: 1, wins: 0 });
  expect(stats.get('news:q.fraud').wins).toBeCloseTo(0.4); // found something, but only by name
  expect((await loadStats('source')).get('broken')).toMatchObject({ tries: 1, wins: 0 });
});

test('a lookup cut short by the step deadline is run again next step, not counted as a failed source', async () => {
  let attempts = 0;
  const slow = {
    id: 'slow', label: 'Slow source', kinds: ['subject'], prior: 0.6,
    run: async (task, { subject, deadline }) => {
      attempts += 1;
      if (attempts === 1) { const e = new Error('Out of time before the request could start'); e.deadlineSeen = deadline; throw e; }
      return { findings: [finding(subject, { title: 'Trevor Milton, founder of Nikola', quote: 'Trevor Milton founded Nikola.', category: 'career' })] };
    },
  };
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  await stepDeepCheck(state, { connectors: [slow], deadline: Date.now() + 3200 }); // shorter than the lookup's own allowance: the step deadline is what cut it
  expect(state.phase).toBe('collect');
  expect(state.queue).toHaveLength(1);
  expect(state.sources.slow.errors).toBe(0);
  expect((await loadStats('query')).get('slow')).toBeUndefined();
  await runToEnd(state, [slow]);
  expect(attempts).toBe(2);
  expect(state.findings).toHaveLength(1);
});

test('a lookup that fails on its own is a failure, and is not retried', async () => {
  let attempts = 0;
  const broken = { id: 'b', label: 'B', kinds: ['subject'], timeoutMs: 500, run: async () => { attempts += 1; throw new Error('HTTP 500'); } };
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  await runToEnd(state, [broken]);
  expect(attempts).toBe(1);
  expect(state.sources.b.errors).toBe(1);
});

test('headline fragments are not followed as companies, and one company under several names is followed once', async () => {
  const calls = [];
  const source = {
    id: 'news', label: 'News', kinds: ['subject', 'company'], prior: 0.6,
    run: async (task, { subject }) => {
      calls.push(`${task.kind}:${task.value}`);
      if (task.kind !== 'subject') return { findings: [] };
      const f = finding(subject, { title: 'Ousted Theranos chief Elizabeth Holmes charged', quote: 'Elizabeth Holmes founded Theranos.', category: 'press' });
      const t = (value) => makeThread('company', value, 'from a headline', { trusted: true });
      return { findings: [f], threads: [t('Ousted Theranos'), t('Why Theranos'), t('SEC Charges Theranos'), t('U.S'), t('Theranos Inc'), t('Theranos, Inc.'), t('Conversation With Theranos'), t('Disgraced'), t('Ousted'), makeThread('company', 'RealTime Cures, Inc.', 'earlier name of Theranos Inc', { trusted: true })] };
    },
  };
  const state = startState({ name: 'Elizabeth Holmes', company: 'Theranos' });
  await runToEnd(state, [source]);
  const companies = Object.values(state.threads).filter((x) => x.kind === 'company').map((x) => x.value);
  expect(companies.sort()).toEqual(['RealTime Cures, Inc.', 'Theranos']);
  expect(calls.filter((c) => c.startsWith('company:')).sort()).toEqual(['company:RealTime Cures, Inc.', 'company:Theranos']);
  // the other spellings count as support for the company they name
  expect(state.threads['company|theranos'].support).toBe(3);
});

test('pages that differ only by their query or anchor are different records; tracking parameters are ignored', async () => {
  const source = {
    id: 'forum', label: 'Forum', kinds: ['subject'], prior: 0.6,
    run: async (task, { subject }) => {
      const f = (title, url) => makeFinding(subject, { source: 'forum', sourceLabel: 'Forum', category: 'press', title, quote: 'Trevor Milton of Nikola.', url });
      return { findings: [
        f('Trevor Milton thread one', 'https://news.ycombinator.com/item?id=1'),
        f('Trevor Milton thread two', 'https://news.ycombinator.com/item?id=2'),
        f('Trevor Milton section a', 'https://en.wikipedia.org/wiki/Trevor_Milton#Fraud'),
        f('Trevor Milton section b', 'https://en.wikipedia.org/wiki/Trevor_Milton#Pardon'),
        f('Trevor Milton story', 'https://news.test/story?utm_source=x'),
        f('Trevor Milton story - News Site', 'https://www.news.test/story/?utm_medium=y&fbclid=z'), // the same page, shared with tracking
        f('Trevor Milton: a second record on the same register page', 'https://news.test/story'),
      ] };
    },
  };
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  await runToEnd(state, [source]);
  expect(state.findings.map((x) => x.title)).toEqual(['Trevor Milton thread one', 'Trevor Milton thread two', 'Trevor Milton section a', 'Trevor Milton section b', 'Trevor Milton story', 'Trevor Milton: a second record on the same register page']);
});

test('one person under several spellings, or named both as relative and associate, is followed once', async () => {
  const calls = [];
  const source = {
    id: 'screen', label: 'Screen', kinds: ['subject', 'associate', 'relative'], prior: 0.6,
    run: async (task, { subject }) => {
      calls.push(`${task.kind}:${task.value}`);
      if (task.kind !== 'subject') return { findings: [] };
      const f = finding(subject, { title: 'Elizabeth Holmes of Theranos', quote: 'Elizabeth Holmes founded Theranos.', category: 'press' });
      const t = (kind, value, extra = {}) => makeThread(kind, value, 'named in a record', { trusted: true, ...extra });
      return { findings: [f], threads: [
        t('relative', 'Christian Holmes IV', { relation: 'father' }), t('relative', 'Christian Holmes', { relation: 'father' }), t('associate', 'Christian R. Holmes'),
        t('associate', 'Donald L. Lucas'), t('associate', 'Donald Lucas'), t('company', 'Boyfriend Ramesh'), t('company', 'Convicted Theranos'),
      ] };
    },
  };
  const state = startState({ name: 'Elizabeth Holmes', company: 'Theranos' });
  await runToEnd(state, [source]);
  expect(calls.filter((c) => !c.startsWith('subject')).sort()).toEqual(['associate:Donald L. Lucas', 'relative:Christian Holmes IV']);
  expect(Object.values(state.threads).filter((x) => x.kind === 'company').map((x) => x.value)).toEqual(['Theranos']);
});

test('a company the person only sits on the board of, invested in or worked at is not checked in its own right', async () => {
  const calls = [];
  const sources = [
    {
      id: 'profiles', label: 'Profiles', kinds: ['subject'], prior: 0.7,
      run: async (task, { subject }) => {
        const f = finding(subject, { title: 'Patrick Collison of Stripe', quote: 'Patrick Collison co-founded Stripe and sits on the board of Meta Platforms.', category: 'career' });
        return { findings: [f], threads: [
          makeThread('company', 'Meta Platforms', 'board member (Wikidata)', { trusted: true }),
          makeThread('company', 'Auctomatic', 'co-founder (past; Wikidata)', { trusted: true }),
          makeThread('company', 'Arc Institute', 'named with the person', { trusted: true }),
        ] };
      },
    },
    { id: 'court-dockets', label: 'Courts', kinds: ['company'], prior: 0.7, run: async (task) => { calls.push(`courts:${task.value}`); return { findings: [] }; } },
    { id: 'sec-company', label: 'SEC', kinds: ['company'], prior: 0.5, run: async (task) => { calls.push(`sec:${task.value}`); return { findings: [] }; } },
    { id: 'web-search', label: 'Web', kinds: ['subject', 'company'], prior: 0.5, plan: () => [{ template: 'q.any', params: { query: 'x' } }], run: async (task) => { calls.push(`web:${task.kind}:${task.value}:${task.template}:${task.params.query}`); return { findings: [] }; } },
  ];
  const state = startState({ name: 'Patrick Collison', company: 'Stripe' });
  await runToEnd(state, sources);
  // founded or given: the company itself is checked
  expect(calls).toEqual(expect.arrayContaining(['courts:Stripe', 'courts:Auctomatic', 'web:company:Stripe:q.any:x']));
  // a board seat or a bare mention: only what ties the two together
  expect(calls).not.toContain('courts:Meta Platforms');
  expect(calls).not.toContain('courts:Arc Institute');
  expect(calls).toEqual(expect.arrayContaining([
    'sec:Meta Platforms',
    'web:company:Meta Platforms:q.joint-role:"Patrick Collison" "Meta Platforms"',
    'web:company:Meta Platforms:q.joint-adverse:"Patrick Collison" "Meta Platforms" lawsuit OR sued OR fraud OR investigation OR dispute OR fired OR bankruptcy',
  ]));
  expect(calls.filter((c) => c.startsWith('web:company:Meta Platforms'))).toHaveLength(2);
  expect(state.threads['company|meta platforms'].tie).toBe('affiliate');
  expect(state.threads['company|auctomatic'].tie).toBe('primary');
});

test('a company first seen as an affiliation is checked in full once a record shows the person founded it', async () => {
  const calls = [];
  const sources = [
    {
      id: 'profiles', label: 'Profiles', kinds: ['subject', 'company'], prior: 0.7,
      run: async (task, { subject }) => {
        calls.push(`profiles:${task.kind}:${task.value}`);
        const f = finding(subject, { title: 'Trevor Milton of Nikola', quote: 'Trevor Milton founded Nikola.', category: 'career' });
        if (task.kind === 'subject') return { findings: [f], threads: [makeThread('company', 'dHybrid Systems', 'named with the person', { trusted: true })] };
        return { findings: [] };
      },
    },
    {
      id: 'web-search', label: 'Web', kinds: ['company'], prior: 0.5, plan: () => [{ template: 'q.any', params: { query: 'x' } }],
      run: async (task) => (task.value === 'dHybrid Systems' && task.template === 'q.joint-role' ? { findings: [], threads: [makeThread('company', 'dHybrid Systems', 'founder (Wikidata)', { trusted: true })] } : { findings: [] }),
    },
  ];
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  await runToEnd(state, sources);
  expect(state.threads['company|dhybrid'].tie).toBe('primary');
  expect(calls).toContain('profiles:company:dHybrid Systems');
});

test('a source that must be paced runs one lookup at a time, and its waiting lookups are not failures', async () => {
  let running = 0;
  let peak = 0;
  const paced = {
    id: 'archive', label: 'Archive', kinds: ['subject'], prior: 0.6, maxParallel: 1,
    plan: () => [{ template: 'a' }, { template: 'b' }, { template: 'c' }],
    run: async () => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 30)); running -= 1; return { findings: [] }; },
  };
  const fast = { id: 'fast', label: 'Fast', kinds: ['subject'], prior: 0.5, plan: () => [{ template: 'x' }, { template: 'y' }], run: async () => ({ findings: [] }) };
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  await runToEnd(state, [paced, fast]);
  expect(peak).toBe(1);
  expect(state.sources.archive).toMatchObject({ runs: 3, errors: 0 });
  expect(state.sources.fast.runs).toBe(2);
});
