/**
 * Round 4, the deep check loop (deepCheck.js): a screen that timed out on a cold start is asked once more, typed
 * earlier companies get their own screens (unless they are a very large employer), presence lookups are capped
 * and run last, and the second reader's statedRole is no longer stored.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState, stepDeepCheck, LIMITS, PRESENCE_SOURCES } = require('../../../src/server/founder/deepCheck');
const { makeFinding, makeThread } = require('../../../src/server/founder/finding');
const { __resetLearningForTests } = require('../../../src/server/learning');

const url = (s) => `https://example.com/${encodeURIComponent(String(s).toLowerCase().replace(/\s+/g, '-'))}`;
const finding = (subject, over) => makeFinding(subject, { source: 'fake', sourceLabel: 'Fake', category: 'press', url: url(over.title), ...over });
const quiet = (id, kinds, calls) => ({ id, label: `${id} label`, kinds, run: async (task) => { calls.push(`${id}:${task.kind}:${task.value}`); return { findings: [] }; } });

async function runToEnd(state, connectors, { limits = LIMITS, review = null, steps = 40 } = {}) {
  for (let i = 0; i < steps && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors, limits, review, deadline: Date.now() + 5000 });
}

beforeEach(() => __resetLearningForTests());

describe('a screen that timed out is asked once more', () => {
  const press = { id: 'press', label: 'Press', kinds: ['subject'], run: async (task, { subject }) => ({ findings: [finding(subject, { title: 'Ada Quill of Acme Corp', quote: 'Ada Quill, CEO of Acme Corp.' })] }) };

  test('a sanctions screen that timed out on its first load and answers on the second is a full answer', async () => {
    let calls = 0;
    const sanctions = {
      id: 'sanctions-lists', label: 'Sanctions', kinds: ['subject'], timeoutMs: 1000,
      run: async () => { calls += 1; if (calls === 1) throw new Error('Timed out after 16s'); return { findings: [] }; },
    };
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, [press, sanctions]);
    expect(calls).toBe(2);
    expect(state.sources['sanctions-lists'].errors).toBe(0);
    expect(state.screened['ada quill']).toMatchObject({ ok: ['sanctions-lists'], missed: [] });
  });

  test('a second failure is final and reported as failed, never as clean', async () => {
    let calls = 0;
    const sanctions = { id: 'sanctions-lists', label: 'Sanctions', kinds: ['subject'], timeoutMs: 1000, run: async () => { calls += 1; throw new Error('HTTP 503 from the list host'); } };
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, [press, sanctions]);
    expect(calls).toBe(2);
    expect(state.sources['sanctions-lists'].errors).toBe(1);
    expect(state.screened['ada quill']).toMatchObject({ ok: [], missed: ['sanctions-lists'] });
  });

  test('a lookup that is not a screen is not asked again', async () => {
    let calls = 0;
    const other = { id: 'news-archive', label: 'News', kinds: ['subject'], timeoutMs: 1000, run: async () => { calls += 1; throw new Error('Timed out after 16s'); } };
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, [press, other]);
    expect(calls).toBe(1);
    expect(state.sources['news-archive'].errors).toBe(1);
  });
});

describe('earlier companies the user typed', () => {
  test('are screened by courts, enforcement and watchlists; a very large former employer is not', async () => {
    const calls = [];
    const sources = [
      quiet('court-dockets', ['subject', 'company'], calls),
      quiet('doj-press-releases', ['subject', 'company'], calls),
      quiet('sanctions-lists', ['subject', 'company'], calls),
      quiet('uk-companies-house', ['subject', 'company'], calls),
    ];
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp', otherCompanies: ['Zeta Labs', 'Google'] });
    await runToEnd(state, sources);
    for (const id of ['court-dockets', 'doj-press-releases', 'sanctions-lists', 'uk-companies-house']) expect(calls).toContain(`${id}:company:Zeta Labs`);
    expect(calls).toContain('uk-companies-house:company:Google');
    expect(calls).not.toContain('court-dockets:company:Google');
    const thread = (v) => Object.values(state.threads).find((t) => t.kind === 'company' && t.value === v);
    expect(thread('Zeta Labs')).toMatchObject({ tie: 'affiliate', venture: true });
    expect(thread('Google').venture).toBeUndefined();
  });
});

describe('presence lookups', () => {
  test('are capped per check, run after the other sources, and the rest are reported as not run', async () => {
    const calls = [];
    const pages = Array.from({ length: 14 }, (_, i) => `https://blog${i}.example.org/ada-quill`);
    const order = [];
    const sources = [
      {
        id: 'press', label: 'Press', kinds: ['subject'],
        run: async (task, { subject }) => ({
          findings: [finding(subject, { title: 'Ada Quill of Acme Corp', quote: 'Ada Quill, CEO of Acme Corp.' })],
          threads: pages.map((p) => makeThread('url', p, 'profile page', { trusted: true })),
        }),
      },
      { id: 'reader', label: 'Reader', kinds: ['url'], run: async (task) => { order.push('reader'); calls.push(task.value); return { findings: [] }; } },
      { id: 'huggingface', label: 'Hugging Face public profiles', kinds: ['subject', 'url'], run: async () => { order.push('huggingface'); return { findings: [] }; } },
    ];
    expect(PRESENCE_SOURCES.has('huggingface')).toBe(true);
    const state = startState({ name: 'Ada Quill', company: 'Acme Corp' });
    await runToEnd(state, sources);
    const asked = order.filter((x) => x === 'huggingface').length;
    expect(asked).toBeLessThanOrEqual(5);
    expect(asked).toBeGreaterThan(0);
    // within the round that pulled the pages, the page reader went first
    const firstPresence = order.indexOf('huggingface', order.indexOf('reader'));
    expect(order.slice(firstPresence).includes('reader')).toBe(false);
    const stat = state.sources.huggingface;
    expect(stat.label).toBe('Hugging Face public profiles');
    expect(stat.notRun).toBeGreaterThan(0);
  });
});
