/**
 * Round 4, the deep check loop (deepCheck.js): an anchor of any kind (a school, a person, a handle, a domain, a
 * role, a legal name of the company) that came from a likely record never confirms another record, and an anchor
 * a source registers while it runs carries the grade of the record it came from.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState, stepDeepCheck, LIMITS } = require('../../../src/server/founder/deepCheck');
const { makeFinding, makeThread } = require('../../../src/server/founder/finding');
const { addCompanyAlias } = require('../../../src/server/founder/identity');
const { companyKeys } = require('../../../src/server/founderCheck');
const { __resetLearningForTests } = require('../../../src/server/learning');

const url = (s) => `https://example.com/${encodeURIComponent(String(s).toLowerCase().replace(/\s+/g, '-'))}`;
const finding = (subject, over) => makeFinding(subject, { source: 'fake', sourceLabel: 'Fake', category: 'press', url: url(over.title), ...over });

async function runToEnd(state, connectors, { limits = LIMITS, steps = 30 } = {}) {
  for (let i = 0; i < steps && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors, limits, deadline: Date.now() + 5000 });
}

beforeEach(() => __resetLearningForTests());

describe('a likely record never confirms other records, whatever kind of anchor it gave', () => {
  test('a school read from a likely record does not let a large employer confirm a namesake', async () => {
    const sources = [
      {
        id: 'profile', label: 'Profile', kinds: ['subject'],
        run: async (task, { subject }) => {
          // Google is a very large employer: naming it beside the name is one fact, so this record is likely
          const f = finding(subject, { title: 'Jane Roe of Google', quote: 'Jane Roe, an engineer at Google, studied at Stanford University.', category: 'career' });
          return { findings: [f], threads: [makeThread('school', 'Stanford University', 'school (profile)', { trusted: f.match !== 'possible' })] };
        },
      },
      {
        id: 'news', label: 'News', kinds: ['school'],
        run: async (task, { subject }) => ({ findings: [finding(subject, {
          title: 'Jane Roe charged with fraud', quote: 'Jane Roe, a Stanford University graduate who worked at Google, was charged with fraud.', category: 'litigation', severity: 'high',
        })] }),
      },
    ];
    const state = startState({ name: 'Jane Roe', company: 'Google' });
    await runToEnd(state, sources);
    expect(state.findings.find((f) => f.title === 'Jane Roe of Google').match).toBe('likely');
    const school = state.anchors.schools.find((a) => a.value === 'Stanford University');
    expect(school.origin).toMatch(/^weak:/);
    const charged = state.findings.find((f) => /charged/.test(f.title));
    expect(charged.match).toBe('likely'); // was 'confirmed' through Google and the likely record's school
  });

  test('the same school typed by the user still confirms (a strong anchor is unchanged)', async () => {
    const sources = [{
      id: 'news', label: 'News', kinds: ['subject'],
      run: async (task, { subject }) => ({ findings: [finding(subject, {
        title: 'Jane Roe profile', quote: 'Jane Roe, a Stanford University graduate who worked at Google, spoke at the event.', category: 'career',
      })] }),
    }];
    const state = startState({ name: 'Jane Roe', company: 'Google', school: 'Stanford University' });
    await runToEnd(state, sources);
    expect(state.findings.find((f) => f.title === 'Jane Roe profile').match).toBe('confirmed');
  });

  test('a legal name of the company learned from a likely record does not confirm a record naming it', async () => {
    const sources = [{
      id: 'news', label: 'News', kinds: ['subject'],
      run: async (task, { subject }) => ({ findings: [finding(subject, {
        title: 'Director charged', quote: 'Jane Roe, director of Ramp Business Corp, was charged.', category: 'litigation', severity: 'high',
      })] }),
    }];
    const state = startState({ name: 'Jane Roe', company: 'Ramp' });
    const of = companyKeys('Ramp')[0];
    state.anchors.aliases = [{ value: 'Ramp Business Corp', of, origin: 'weak:x1' }];
    await runToEnd(state, sources);
    const charged = state.findings.find((f) => f.title === 'Director charged');
    expect(charged.match).not.toBe('confirmed');
    expect(state.anchors.aliases.find((a) => a.value === 'Ramp Business Corp').origin).toBe('weak:x1');
  });

  test('the same legal name from a confirmed record still confirms', async () => {
    const sources = [{
      id: 'news', label: 'News', kinds: ['subject'],
      run: async (task, { subject }) => ({ findings: [finding(subject, {
        title: 'Director appointed', quote: 'Jane Roe, director of Ramp Business Corp, was appointed.', category: 'career',
      })] }),
    }];
    const state = startState({ name: 'Jane Roe', company: 'Ramp' });
    state.anchors.aliases = [{ value: 'Ramp Business Corp', of: companyKeys('Ramp')[0], origin: 'given' }];
    await runToEnd(state, sources);
    expect(state.findings.find((f) => f.title === 'Director appointed').match).toBe('confirmed');
  });
});

describe('an anchor a source registers while it runs carries its record\'s grade', () => {
  test('a legal name registered under a likely record\'s bare id becomes weak:<id>, and does not confirm', async () => {
    let likelyId = null;
    const sources = [
      {
        id: 'graph', label: 'Graph', kinds: ['subject'],
        run: async (task, { subject }) => {
          // a name only, beside another of the person's companies: possible or likely, never confirmed
          const f = finding(subject, { title: 'Jane Roe entry', quote: 'Jane Roe is listed in the register.', category: 'career' });
          likelyId = f.id;
          addCompanyAlias(subject, { company: 'Ramp', alias: 'Ramp Business Corp', origin: f.id });
          return { findings: [f] };
        },
      },
      {
        id: 'later', label: 'Later', kinds: ['company'],
        run: async (task, { subject }) => ({ findings: [finding(subject, {
          title: 'Ramp Business Corp director sued', quote: 'Jane Roe, director of Ramp Business Corp, was sued.', category: 'litigation', severity: 'high',
        })] }),
      },
    ];
    const state = startState({ name: 'Jane Roe', company: 'Ramp' });
    await runToEnd(state, sources);
    const alias = state.anchors.aliases.find((a) => a.value === 'Ramp Business Corp');
    expect(alias.origin).toBe(`weak:${likelyId}`);
    expect(state.findings.find((f) => /sued/.test(f.title)).match).not.toBe('confirmed');
  });

  test('the same name registered under a confirmed record\'s id becomes found:<id>', async () => {
    let id = null;
    const sources = [{
      id: 'graph', label: 'Graph', kinds: ['subject'],
      run: async (task, { subject }) => {
        const f = finding(subject, { title: 'Jane Roe of Ramp', quote: 'Jane Roe, CEO of Ramp, the company registered as Ramp Business Corp.', category: 'career' });
        id = f.id;
        addCompanyAlias(subject, { company: 'Ramp', alias: 'Ramp Business Corp', origin: f.id });
        return { findings: [f] };
      },
    }];
    const state = startState({ name: 'Jane Roe', company: 'Ramp' });
    await runToEnd(state, sources);
    expect(state.findings.find((f) => f.id === id).match).toBe('confirmed');
    expect(state.anchors.aliases.find((a) => a.value === 'Ramp Business Corp').origin).toBe(`found:${id}`);
  });
});
