/**
 * Fixes to the deep check loop (deepCheck.js) found in review: identity inference from one page seen
 * twice, re-grading on the text a record was graded on, depth of re-seen threads, learning credit,
 * namesake organisations, plain failure reasons, and lookups waiting for a resting host.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState, stepDeepCheck, plainFailure, LIMITS } = require('../../../src/server/founder/deepCheck');
const { makeFinding, makeThread } = require('../../../src/server/founder/finding');
const { loadStats, __resetLearningForTests } = require('../../../src/server/learning');

const finding = (subject, over) => makeFinding(subject, { source: 'fake', sourceLabel: 'Fake', category: 'press', url: `https://example.com/${encodeURIComponent(String(over.title).toLowerCase().replace(/\s+/g, '-'))}`, ...over });

async function runToEnd(state, connectors) {
  for (let i = 0; i < 30 && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors, deadline: Date.now() + 5000 });
}

beforeEach(() => __resetLearningForTests());

test('a failed source is described in plain words, never by its technical message', async () => {
  expect(plainFailure('timed out after 20s')).toBe('did not respond in time');
  expect(plainFailure('Rate limited (429)')).toBe('was busy and turned the request away');
  expect(plainFailure('Response was not JSON')).toBe('returned something that could not be read');
  expect(plainFailure('GDELT: <html>Some remote text</html>')).toBe('could not be reached');
  const broken = { id: 'b', label: 'B', kinds: ['subject'], run: async () => { throw new Error('GDELT: please slow down <b>remote</b>'); } };
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  await runToEnd(state, [broken]);
  expect(state.sources.b.lastError).toBe('could not be reached');
});

test('one namesake page returned by two query patterns does not become the person\'s identity', async () => {
  const web = {
    id: 'web-search', label: 'Web', kinds: ['subject', 'company'], plan: (t) => (t.kind === 'subject' ? [{ template: 'q.a' }, { template: 'q.b' }] : [{ template: 'q.c' }]),
    run: async (task, { subject }) => (task.kind !== 'subject' ? { findings: [] } : {
      findings: [finding(subject, { title: 'John Smith of Acme Plumbing sued', quote: 'John Smith, owner of Acme Plumbing, was sued.', category: 'litigation', url: 'https://news.test/smith' })],
      threads: [makeThread('company', 'Acme Plumbing', 'named in an article', { trusted: false })],
    }),
  };
  const state = startState({ name: 'John Smith' });
  await runToEnd(state, [web]);
  expect(state.identity.status).not.toBe('inferred');
  expect(state.threads['company|acme plumbing']).toMatchObject({ trusted: false, pulled: false });
  expect(state.threads['company|acme plumbing'].evidence).toHaveLength(1);
  expect(state.findings[0].match).toBe('possible');
});

test('an inferred identity needs two places, and never confirms a record', async () => {
  const mk = (id, host) => ({
    id, label: id, kinds: ['subject', 'company'],
    run: async (task, { subject }) => (task.kind !== 'subject' ? { findings: [finding(subject, { title: `Jane Roe and Acme Robotics ${id}`, quote: 'Jane Roe of Acme Robotics.', url: `https://${host}/round` })] } : {
      findings: [finding(subject, { title: `Jane Roe profile ${id}`, quote: 'Jane Roe leads Acme Robotics.', url: `https://${host}/jane` })],
      threads: [makeThread('company', 'Acme Robotics', 'named in a profile', { trusted: false })],
    }),
  });
  const state = startState({ name: 'Jane Roe' });
  await runToEnd(state, [mk('a', 'one.test'), mk('b', 'two.test')]);
  expect(state.identity.status).toBe('inferred');
  expect(state.anchors.companies).toEqual([{ value: 'Acme Robotics', origin: 'inferred' }]);
  expect(state.findings.length).toBeGreaterThanOrEqual(3);
  expect(state.findings.every((f) => f.match !== 'confirmed')).toBe(true);
  expect(state.findings.filter((f) => f.match === 'likely').length).toBeGreaterThanOrEqual(3);
});

test('a re-grade reads the text the record was graded on, and never touches a grade the source set', async () => {
  const src = {
    id: 'ip', label: 'Patents', kinds: ['subject'], prior: 0.7,
    plan: () => [{ template: 'a' }, { template: 'b' }],
    run: async (task, { subject }) => {
      if (task.template === 'a') {
        return { findings: [
          makeFinding(subject, { source: 'ip', category: 'ip', title: 'Patent: robotic gripper', quote: 'Inventor: Jane Roe', matchText: 'Jane Roe. Assignee: Zeta Robotics', url: 'https://patents.test/1' }),
          makeFinding(subject, { source: 'ip', category: 'corporate', title: 'UK company with the same name: ZETA ROBOTICS LTD (Jane Roe is not among its officers)', url: 'https://reg.test/z', match: 'possible' }),
        ] };
      }
      const f = finding(subject, { title: 'Jane Roe founded Zeta Robotics', quote: 'Jane Roe founded Zeta Robotics.', category: 'career', url: 'https://profile.test/jr' });
      return { findings: [f], threads: [makeThread('company', 'Zeta Robotics', 'founder (Wikidata)', { trusted: true })] };
    },
  };
  const state = startState({ name: 'Jane Roe', company: 'Other Co' });
  await stepDeepCheck(state, { connectors: [src], deadline: Date.now() + 5000 });
  expect(state.findings.find((f) => f.url === 'https://patents.test/1').match).toBe('confirmed');
  expect(state.findings.find((f) => f.url === 'https://reg.test/z').match).toBe('possible');
});

test('a thread first seen deep is pulled at the shallower depth once a record ties it to the person', async () => {
  const calls = [];
  const src = {
    id: 'p', label: 'P', kinds: ['subject', 'company'],
    run: async (task, { subject }) => {
      calls.push(`${task.kind}:${task.value}`);
      if (task.kind !== 'subject') return { findings: [] };
      return { findings: [finding(subject, { title: 'Jane Roe founded Gamma Works', quote: '', category: 'career' })], threads: [makeThread('company', 'Gamma Works', 'founder (Wikidata)', { trusted: true })] };
    },
  };
  const state = startState({ name: 'Jane Roe', company: 'Acme' });
  state.threads['company|gamma works'] = { kind: 'company', value: 'Gamma Works', why: '', depth: 3, trusted: false, support: 1, pulled: false, tie: 'affiliate' };
  await runToEnd(state, [src]);
  expect(state.threads['company|gamma works']).toMatchObject({ depth: 1, trusted: true, pulled: true });
  expect(calls).toContain('company:Gamma Works');
});

test('a trusted thread too deep to pull is counted as dropped', async () => {
  const src = {
    id: 'p', label: 'P', kinds: ['subject'],
    run: async (task, { subject }) => ({ findings: [finding(subject, { title: 'Jane Roe of Acme', quote: '', category: 'career' })], threads: [makeThread('company', 'Deepwater Plumbing', 'founder (Wikidata)', { trusted: true })] }),
  };
  const state = startState({ name: 'Jane Roe', company: 'Acme' });
  state.threads['company|deepwater plumbing'] = { kind: 'company', value: 'Deepwater Plumbing', why: '', depth: 3, trusted: false, support: 1, pulled: false };
  // the subject task is depth 0, so the new sighting is depth 1: the thread becomes pullable
  await runToEnd(state, [src]);
  expect(state.threads['company|deepwater plumbing'].pulled).toBe(true);
  const s2 = startState({ name: 'Jane Roe', company: 'Acme' });
  const deep = { id: 'q', label: 'Q', kinds: ['subject', 'company'], run: async (task, { subject }) => (task.value === 'Acme' ? { findings: [], threads: [makeThread('company', 'Thirdway Plumbing', 'founder (Wikidata)', { trusted: true })] } : { findings: [] }) };
  s2.queue.push({ connector: 'q', kind: 'company', value: 'Acme', depth: 2, template: 'x', params: null, prior: 0.5, why: '', relation: null });
  s2.tasksRun = 1; // skip the opening plan
  await stepDeepCheck(s2, { connectors: [deep], deadline: Date.now() + 5000 });
  expect(s2.threads['company|thirdway plumbing']).toMatchObject({ depth: 3, trusted: true, pulled: false });
  expect(s2.dropped.threads).toBe(1);
});

test('a failed lookup lowers the source, not the query pattern; a duplicate earns partial credit', async () => {
  const sources = [
    { id: 'down', label: 'Down', kinds: ['subject'], timeoutMs: 500, run: async () => { throw new Error('HTTP 503'); } },
    { id: 'first', label: 'First', kinds: ['subject'], prior: 0.9, run: async (task, { subject }) => ({ findings: [finding(subject, { title: 'Jane Roe, founder of Acme Robotics', quote: 'Jane Roe founded Acme Robotics.', url: 'https://same.test/a' })] }) },
    { id: 'second', label: 'Second', kinds: ['subject'], prior: 0.1, run: async (task, { subject }) => { await new Promise((r) => setTimeout(r, 20)); return { findings: [finding(subject, { title: 'Jane Roe, founder of Acme Robotics', quote: 'Jane Roe founded Acme Robotics.', url: 'https://same.test/a' })] }; } },
  ];
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, sources);
  const q = await loadStats('query');
  expect(q.get('down')).toBeUndefined();
  expect((await loadStats('source')).get('down')).toMatchObject({ tries: 1, wins: 0 });
  expect(q.get('first').wins).toBe(1);
  expect(q.get('second').wins).toBeCloseTo(0.5);
});

test('a trusted longer organisation does not turn a shorter namesake organisation into an anchor', async () => {
  const src = {
    id: 'p', label: 'P', kinds: ['subject'], plan: () => [{ template: 'a' }, { template: 'b' }],
    run: async (task, { subject }) => (task.template === 'a'
      ? { findings: [], threads: [makeThread('company', 'Meta', 'a namesake', { trusted: false })] }
      : { findings: [], threads: [makeThread('company', 'Meta Materials', 'founder (Wikidata)', { trusted: true })] }),
  };
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await stepDeepCheck(state, { connectors: [src], deadline: Date.now() + 5000, limits: { ...LIMITS, concurrency: 1 } });
  const anchors = state.anchors.companies.map((a) => a.value);
  expect(anchors).not.toContain('Meta');
  expect(anchors).toContain('Meta Materials');
  expect(state.threads['company|meta']).toMatchObject({ trusted: false });
});

describe('a lookup whose host is resting', () => {
  test('is put back to run after the rest, not counted as an error, and an empty step is not a dry one', async () => {
    let attempts = 0;
    const paced = {
      id: 'arch', label: 'Archive', kinds: ['subject'], timeoutMs: 1000,
      run: async () => { attempts += 1; if (attempts === 1) throw new Error('web.archive.org refused the connection; it is being left alone for a minute'); return { findings: [] }; },
    };
    const state = startState({ name: 'Jane Roe', company: 'Acme' });
    await stepDeepCheck(state, { connectors: [paced], deadline: Date.now() + 5000 });
    expect(state.sources.arch.errors).toBe(0);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].notBefore).toBeGreaterThan(Date.now() + 15000);
    expect(state.queue[0].rests).toBe(1);
    // the next step finds nothing it may run yet: it does not count as a round or a dry step
    const step = state.step;
    await stepDeepCheck(state, { connectors: [paced], deadline: Date.now() + 5000 });
    expect(state.step).toBe(step);
    expect(state.drySteps).toBe(0);
    expect(state.phase).toBe('collect');
    expect(attempts).toBe(1);
    // once the rest is over it runs
    state.queue[0].notBefore = Date.now() - 1;
    await runToEnd(state, [paced]);
    expect(attempts).toBe(2);
    expect(state.sources.arch.errors).toBe(0);
  });

  test('waits within the step when the rest ends well before the deadline', async () => {
    let attempts = 0;
    const paced = {
      id: 'arch', label: 'Archive', kinds: ['subject'], timeoutMs: 1000,
      run: async () => { attempts += 1; if (attempts === 1) throw new Error('Out of time before the request could start'); return { findings: [] }; },
    };
    const state = startState({ name: 'Jane Roe', company: 'Acme' });
    await stepDeepCheck(state, { connectors: [paced], limits: { ...LIMITS, restMs: 300 }, deadline: Date.now() + 8000 });
    expect(attempts).toBe(2);
    expect(state.queue).toHaveLength(0);
    expect(state.sources.arch.errors).toBe(0);
  });

  test('gives up after four rests and reports a plain reason', async () => {
    const paced = { id: 'arch', label: 'Archive', kinds: ['subject'], timeoutMs: 1000, run: async () => { throw new Error('Out of time before the request could start'); } };
    const state = startState({ name: 'Jane Roe', company: 'Acme' });
    for (let i = 0; i < 6 && state.phase === 'collect'; i += 1) {
      for (const t of state.queue) if (t.notBefore) t.notBefore = Date.now() - 1;
      await stepDeepCheck(state, { connectors: [paced], deadline: Date.now() + 5000 });
    }
    expect(state.sources.arch).toMatchObject({ errors: 1, lastError: 'did not respond in time' });
  });
});
