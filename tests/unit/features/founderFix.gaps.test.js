/**
 * @jest-environment node
 *
 * Fixes to the second reader (gaps.js): relatives cannot come in as
 * associates, a tie must be stated, private searches are dropped, and an
 * untrusted thread does not block a proposal from a tied record.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/llm/providers', () => ({ chatJson: jest.fn(), chatComplete: jest.fn(), llmConfigured: () => true, PROVIDERS: [], providerEnabled: () => true }));

const { startState } = require('../../../src/server/founder/deepCheck');
const { makeFinding } = require('../../../src/server/founder/finding');
const { restoreSubject } = require('../../../src/server/founder/identity');
const { verifyGaps, recordsForReview } = require('../../../src/server/founder/gaps');
const { __resetLearningForTests } = require('../../../src/server/learning');

function holmes(extra = []) {
  const state = startState({ name: 'Elizabeth Holmes', company: 'Theranos' });
  state.threads['company|theranos'] = { kind: 'company', value: 'Theranos', trusted: true, pulled: true, depth: 1, support: 1 };
  const subject = restoreSubject(state);
  const records = [
    { title: 'Elizabeth Holmes, founder of Theranos', quote: 'Elizabeth Holmes founded Theranos in 2003 at age nineteen. She grew up with her mother Noel Holmes and her brother Christian Holmes.' },
    { title: 'Theranos founder Elizabeth Holmes charged', quote: 'Prosecutors charged Elizabeth Holmes of Theranos together with her co-defendant Sunny Balwani, the former Theranos president.' },
    { title: 'Elizabeth Holmes of Theranos at a gala', quote: 'Elizabeth Holmes of Theranos attended a gala in Palo Alto where Tim Draper also spoke about medicine and design.' },
    { title: 'Elizabeth Holmes of Theranos studied at Stanford University', quote: 'Elizabeth Holmes of Theranos studied chemical engineering at Stanford University before leaving to found the company.' },
    ...extra,
  ];
  // tied to the person by hand, so these tests do not depend on how identity.js grades a record
  state.findings = records.map((r, i) => makeFinding(subject, { source: 'fake', sourceLabel: 'Fake News', category: 'press', url: `https://example.com/${i}`, match: 'confirmed', ...r })).filter(Boolean);
  return state;
}
const at = (records, start) => records.findIndex((f) => f.title.startsWith(start)) + 1;

beforeEach(() => { __resetLearningForTests(); jest.clearAllMocks(); });

describe('the second reader cannot pull relatives in as associates', () => {
  test('a mother and brother labelled business or legal are dropped', () => {
    const state = holmes();
    const records = recordsForReview(state);
    const r = at(records, 'Elizabeth Holmes, founder');
    expect(r).toBeGreaterThan(0);
    const out = verifyGaps(state, records, {
      companies: [], schools: [], searches: [],
      people: [{ name: 'Noel Holmes', record: r, tie: 'business', detail: 'mother' }, { name: 'Christian Holmes', record: r, tie: 'legal', detail: 'brother' }],
    });
    expect(out.threads).toEqual([]);
    expect(out.dropped).toBe(2);
  });

  test('a business or legal tie must be stated in a sentence naming the person', () => {
    const state = holmes();
    const records = recordsForReview(state);
    expect(records).toHaveLength(4);
    const out = verifyGaps(state, records, {
      companies: [], schools: [], searches: [],
      people: [
        { name: 'Sunny Balwani', record: at(records, 'Theranos founder Elizabeth Holmes charged'), tie: 'legal', detail: 'co-defendant' },
        { name: 'Tim Draper', record: at(records, 'Elizabeth Holmes of Theranos at a gala'), tie: 'business', detail: 'investor' }, // the record states no tie
      ],
    });
    expect(out.threads.map((t) => `${t.kind}:${t.value}`)).toEqual(['associate:Sunny Balwani']);
    expect(out.dropped).toBe(1);
  });
});

describe('searches about private life are dropped', () => {
  test('birth, nationality and family searches', () => {
    const state = holmes();
    const records = recordsForReview(state);
    const out = verifyGaps(state, records, {
      companies: [], schools: [], people: [],
      searches: ['"Elizabeth Holmes" nationality', '"Elizabeth Holmes" born', '"Elizabeth Holmes" mother Noel', '"Elizabeth Holmes" Theranos lawsuit outcome'],
    });
    expect(out.searches).toEqual(['"Elizabeth Holmes" Theranos lawsuit outcome']);
    expect(out.dropped).toBe(3);
  });
});

describe('an untrusted thread does not block a proposal from a tied record', () => {
  test('a school first seen untrusted is proposed again and kept; a trusted one is still dropped', () => {
    const state = holmes();
    state.threads['school|stanford university'] = { kind: 'school', value: 'Stanford University', trusted: false, pulled: false, depth: 1, support: 1 };
    const records = recordsForReview(state);
    const r = at(records, 'Elizabeth Holmes of Theranos studied');
    const proposal = { companies: [{ name: 'Theranos', record: r, role: 'founder' }], schools: [{ name: 'Stanford University', record: r }], people: [], searches: [] };
    const out = verifyGaps(state, records, proposal);
    expect(out.threads.map((t) => `${t.kind}:${t.value}:${t.trusted}`)).toEqual(['school:Stanford University:true']);
    expect(out.dropped).toBe(1); // Theranos is already followed as trusted
  });
});
