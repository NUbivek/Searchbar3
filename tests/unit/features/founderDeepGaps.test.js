/**
 * @jest-environment node
 *
 * The second reader: a model proposes threads the first pass missed, and
 * nothing it proposes is followed unless the record it cites bears it out.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/llm/providers', () => ({ chatJson: jest.fn(), chatComplete: jest.fn(), llmConfigured: () => true, PROVIDERS: [], providerEnabled: () => true }));

const { startState, stepDeepCheck, GAP_TEMPLATE } = require('../../../src/server/founder/deepCheck');
const { makeFinding, makeThread } = require('../../../src/server/founder/finding');
const { restoreSubject } = require('../../../src/server/founder/identity');
const { verifyGaps, findGaps, recordsForReview, GAP_SCHEMA } = require('../../../src/server/founder/gaps');
const { __resetLearningForTests } = require('../../../src/server/learning');

function stateWith(records) {
  const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
  state.threads['company|nikola'] = { kind: 'company', value: 'Nikola', trusted: true, pulled: true, depth: 1, support: 1 };
  const subject = restoreSubject(state);
  state.findings = records.map((r, i) => makeFinding(subject, { source: 'fake', sourceLabel: 'Fake News', category: 'press', url: `https://example.com/${i}`, ...r })).filter(Boolean);
  return state;
}

const RECORDS = [
  { title: 'Trevor Milton, founder of Nikola, profile', quote: 'Before Nikola, Trevor Milton ran dHybrid Systems and an alarm company called St. George Security. He studied at Utah Valley University before dropping out.' },
  { title: 'Trevor Milton and Nikola sued by investors', quote: 'The complaint names Trevor Milton and former Nikola chief executive Mark Russell. His brother, Travis Milton, the director of hydrogen production at Nikola, was not charged.' },
  { title: 'Nikola founder Trevor Milton at home', quote: 'Trevor Milton lives with his wife, Chelsey Bergmann, on a ranch in Utah. His cousin Wendell Jones also attended.' },
  { title: 'A different Trevor Milton opens a bakery', quote: 'Trevor Milton, a baker in Leeds, opened Milton Bakery with partner Sam Carter.' },
];

beforeEach(() => { __resetLearningForTests(); jest.clearAllMocks(); });

describe('verifyGaps', () => {
  test('keeps what the cited record states, as trusted threads', () => {
    const state = stateWith(RECORDS);
    const records = recordsForReview(state);
    expect(records.map((f) => f.title)).not.toContain('A different Trevor Milton opens a bakery'); // name-only: a possible namesake, not reviewed
    const n = (title) => records.findIndex((f) => f.title.startsWith(title)) + 1;
    const out = verifyGaps(state, records, {
      companies: [{ name: 'dHybrid Systems', record: n('Trevor Milton, founder'), role: 'ran it' }, { name: 'St. George Security', record: n('Trevor Milton, founder'), role: 'ran it' }],
      schools: [{ name: 'Utah Valley University', record: n('Trevor Milton, founder') }],
      people: [
        { name: 'Mark Russell', record: n('Trevor Milton and Nikola sued'), tie: 'legal', detail: 'named in the complaint' },
        { name: 'Travis Milton', record: n('Trevor Milton and Nikola sued'), tie: 'family', detail: 'His brother, the director of hydrogen production' },
      ],
      searches: ['"Trevor Milton" dHybrid Systems lawsuit outcome', '"Trevor Milton" Utah Valley University degree'],
    });
    expect(out.threads.map((t) => `${t.kind}:${t.value}`)).toEqual(['company:dHybrid Systems', 'company:St. George Security', 'school:Utah Valley University', 'associate:Mark Russell', 'relative:Travis Milton']);
    expect(out.threads.every((t) => t.trusted)).toBe(true);
    expect(out.threads.find((t) => t.kind === 'relative')).toEqual(expect.objectContaining({ relation: 'brother', role: expect.stringMatching(/^director of hydrogen production at Nikola/) }));
    expect(out.searches).toHaveLength(2);
    expect(out.dropped).toBe(0);
  });

  test('drops anything invented, already followed, about a namesake, or private', () => {
    const state = stateWith(RECORDS);
    const records = recordsForReview(state);
    const n = (title) => records.findIndex((f) => f.title.startsWith(title)) + 1;
    const out = verifyGaps(state, records, {
      companies: [
        { name: 'Tesla', record: n('Trevor Milton, founder'), role: 'worked there' }, // not in the record
        { name: 'Nikola', record: n('Trevor Milton, founder'), role: 'founder' }, // already followed
        { name: 'dHybrid Systems', record: 99, role: 'ran it' }, // no such record
        { name: 'Trevor Milton', record: n('Trevor Milton, founder'), role: 'self' }, // the subject himself
      ],
      schools: [{ name: 'Harvard University', record: n('Trevor Milton, founder') }],
      people: [
        { name: 'Chelsey Bergmann', record: n('Nikola founder Trevor Milton at home'), tie: 'family', detail: 'his wife' }, // family with no public role
        { name: 'Wendell Jones', record: n('Nikola founder Trevor Milton at home'), tie: 'family', detail: 'his cousin' }, // same
        { name: 'Elon Musk', record: n('Trevor Milton and Nikola sued'), tie: 'business', detail: 'rival' }, // not in the record
        { name: 'Nikola Corporation', record: n('Trevor Milton and Nikola sued'), tie: 'business', detail: 'company, not a person' },
      ],
      searches: [
        'Mark Russell lawsuit', // a search about someone else alone
        '"Trevor Milton" site:spokeo.com', // a people-search site
        '"Trevor Milton" children school', // minors
        'x',
      ],
    });
    expect(out.threads).toEqual([]);
    expect(out.searches).toEqual([]);
    expect(out.dropped).toBe(13);
  });

  test('tolerates a malformed reply', () => {
    const state = stateWith(RECORDS);
    expect(verifyGaps(state, recordsForReview(state), null)).toEqual({ threads: [], searches: [], dropped: 0 });
    expect(verifyGaps(state, recordsForReview(state), { companies: 'none', people: [null, 3], searches: [null] }).threads).toEqual([]);
  });
});

describe('findGaps', () => {
  test('sends only records tied to the person, marks the text as personal, and verifies the reply', async () => {
    const state = stateWith(RECORDS);
    const complete = jest.fn(async (messages) => {
      const record = Number(messages[1].content.match(/\[(\d+)\] \(Fake News\) Trevor Milton, founder/)[1]);
      return { model: 'm1', data: { companies: [{ name: 'dHybrid Systems', record, role: 'ran it' }, { name: 'Made Up Inc', record, role: 'x' }], schools: [], people: [], searches: [] } };
    });
    const out = await findGaps(state, { complete, deadline: Date.now() + 5000 });
    const [messages, options] = complete.mock.calls[0];
    expect(messages[1].content).toMatch(/Already followed:\ncompany: Nikola/);
    expect(messages[1].content).not.toMatch(/bakery/i);
    expect(options).toEqual(expect.objectContaining({ personal: true, schema: GAP_SCHEMA }));
    // every field required and no extras: the strictest structured-output mode accepts the schema
    expect(GAP_SCHEMA.additionalProperties).toBe(false);
    expect(out.threads.map((t) => t.value)).toEqual(['dHybrid Systems']);
    expect(out.dropped).toBe(1);
    expect(out.model).toBe('m1');
  });

  test('too few records, no model, or a failing model: nothing proposed', async () => {
    const few = stateWith(RECORDS.slice(0, 1));
    const complete = jest.fn(async () => null);
    expect((await findGaps(few, { complete })).threads).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
    const state = stateWith(RECORDS);
    expect((await findGaps(state, { complete })).threads).toEqual([]);
    expect((await findGaps(state, { complete: jest.fn(async () => { throw new Error('boom'); }) })).searches).toEqual([]);
  });
});

describe('the loop restarts on what the second reader finds', () => {
  const sources = (calls) => [
    {
      id: 'profiles', label: 'Profiles', kinds: ['subject', 'company'], prior: 0.7,
      run: async (task, { subject }) => {
        calls.push(`profiles:${task.kind}:${task.value}`);
        if (task.kind === 'subject') return { findings: [makeFinding(subject, { source: 'profiles', sourceLabel: 'Profiles', category: 'career', url: 'https://example.com/p', title: 'Trevor Milton, founder of Nikola', quote: 'Before Nikola, Trevor Milton ran dHybrid Systems.' })] };
        if (task.value === 'dHybrid Systems') return { findings: [makeFinding(subject, { source: 'profiles', sourceLabel: 'Profiles', category: 'litigation', url: 'https://example.com/d', title: 'Trevor Milton sued over dHybrid Systems', quote: 'Swift sued Trevor Milton over dHybrid Systems.' })] };
        return { findings: [] };
      },
    },
    {
      id: 'web-search', label: 'Open-web search', kinds: ['subject'], prior: 0.5,
      plan: () => [{ template: 'q.profile', params: { query: '"Trevor Milton" Nikola' } }],
      run: async (task) => { calls.push(`web:${task.template}:${task.params.query}`); return { findings: [] }; },
    },
  ];

  test('new threads and searches are run, the loop is bounded, and the log says what happened', async () => {
    const calls = [];
    const state = startState({ name: 'Trevor Milton', company: 'Nikola' });
    const review = jest.fn()
      .mockResolvedValueOnce({ threads: [makeThread('company', 'dHybrid Systems', 'ran it; named in a record', { trusted: true })], searches: ['"Trevor Milton" dHybrid Systems sale', '"Trevor Milton" Swift lawsuit outcome'] })
      .mockResolvedValue({ threads: [], searches: [] });
    for (let i = 0; i < 30 && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors: sources(calls), review, deadline: Date.now() + 5000 });
    expect(state.phase).toBe('report');
    expect(calls).toEqual(expect.arrayContaining([
      'profiles:company:dHybrid Systems',
      `web:${GAP_TEMPLATE}:"Trevor Milton" dHybrid Systems sale`,
      `web:${GAP_TEMPLATE}:"Trevor Milton" Swift lawsuit outcome`,
    ]));
    expect(state.findings.map((f) => f.title)).toContain('Trevor Milton sued over dHybrid Systems');
    expect(review).toHaveBeenCalledTimes(2); // once productive, once dry: then the check ends
    expect(state.reviews).toBe(2);
    const log = state.log.map((l) => l.text).join('\n');
    expect(log).toMatch(/second reading of the records found 1 more thread and 2 more searches/);
    expect(log).toMatch(/second reading of the records found nothing more to follow/);
  });

  test('a reader that fails or is absent leaves the loop as it was', async () => {
    const calls = [];
    const failing = startState({ name: 'Trevor Milton', company: 'Nikola' });
    const review = jest.fn(async () => { throw new Error('model down'); });
    for (let i = 0; i < 30 && failing.phase === 'collect'; i += 1) await stepDeepCheck(failing, { connectors: sources(calls), review, deadline: Date.now() + 5000 });
    expect(failing.phase).toBe('report');
    expect(review).toHaveBeenCalledTimes(1);

    const plain = startState({ name: 'Trevor Milton', company: 'Nikola' });
    for (let i = 0; i < 30 && plain.phase === 'collect'; i += 1) await stepDeepCheck(plain, { connectors: sources([]), deadline: Date.now() + 5000 });
    expect(plain.phase).toBe('report');
    expect(plain.reviews).toBe(0);
  });
});
