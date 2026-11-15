/**
 * Round 2 fixes to the deep check loop (deepCheck.js) from grading real reports: tasks carry the company's
 * tie, job titles / addresses / tiny words are not organisations, a bare "owner" is not a primary tie, and
 * one passage found on several pages of a source is one record.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState, stepDeepCheck, tieOf } = require('../../../src/server/founder/deepCheck');
const { makeFinding, makeThread } = require('../../../src/server/founder/finding');
const { __resetLearningForTests } = require('../../../src/server/learning');

const finding = (subject, over) => makeFinding(subject, { source: 'fake', sourceLabel: 'Fake', category: 'press', url: `https://example.com/${encodeURIComponent(String(over.title).toLowerCase().replace(/\s+/g, '-'))}`, ...over });

async function runToEnd(state, connectors) {
  for (let i = 0; i < 30 && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors, deadline: Date.now() + 5000 });
}

beforeEach(() => __resetLearningForTests());

test('every task planned for a company thread carries its tie', async () => {
  const seen = [];
  const reg = { id: 'uk-companies-house', label: 'UK', kinds: ['company'], run: async (task) => { seen.push(task); return { findings: [] }; } };
  const web = {
    id: 'web-search', label: 'Web', kinds: ['subject', 'company'],
    run: async (task, { subject }) => {
      seen.push(task);
      if (task.kind !== 'subject') return { findings: [] };
      return {
        findings: [finding(subject, { title: 'Jane Roe of Acme Robotics', quote: 'Jane Roe, CEO of Acme Robotics, joined the board of Globex Industries.' })],
        threads: [makeThread('company', 'Globex Industries', 'board member', { trusted: true })],
      };
    },
  };
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, [web, reg]);
  const companyTasks = seen.filter((t) => t.kind === 'company');
  expect(companyTasks.filter((t) => t.value === 'Acme Robotics').every((t) => t.tie === 'primary')).toBe(true);
  const affiliate = companyTasks.filter((t) => t.value === 'Globex Industries');
  expect(affiliate.length).toBeGreaterThan(0);
  expect(affiliate.every((t) => t.tie === 'affiliate')).toBe(true);
  expect(seen.filter((t) => t.kind === 'subject').every((t) => t.tie === null)).toBe(true);
});

test('job titles, addresses and tiny or common words are never recorded as organisations', async () => {
  const junk = ['Co-Founder', 'Solutions Architect Lead', 'Senior Vice President', 'https://www.acme-robotics.com/team', 'www.globex.io', 'globex.com', 'We Co.', 'The Co', 'XY Inc'];
  const web = {
    id: 'web-search', label: 'Web', kinds: ['subject', 'company'],
    run: async (task, { subject }) => (task.kind !== 'subject' ? { findings: [] } : {
      findings: [finding(subject, { title: 'Jane Roe of Acme Robotics', quote: 'Jane Roe of Acme Robotics.' })],
      threads: [...junk.map((v) => makeThread('company', v, 'worked there', { trusted: true })), makeThread('company', 'Initech Partners', 'co-founded', { trusted: true })],
    }),
  };
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, [web]);
  const values = Object.values(state.threads).filter((t) => t.kind === 'company').map((t) => t.value);
  for (const v of junk) expect(values).not.toContain(v);
  expect(values).toContain('Initech Partners');
  expect(state.anchors.companies.map((a) => a.value)).not.toContain('Co-Founder');
});

test('the company the user gave is followed even when its key is short', async () => {
  const seen = [];
  const reg = { id: 'uk-companies-house', label: 'UK', kinds: ['company'], run: async (task) => { seen.push(task.value); return { findings: [] }; } };
  const state = startState({ name: 'Jane Roe', company: '3M Co' });
  await runToEnd(state, [reg]);
  expect(seen).toContain('3M Co');
});

test('a bare owner or owns is an affiliate tie; owning outright or owning and running it is primary', () => {
  expect(tieOf({ why: 'owner of (LittleSis)' })).toBe('affiliate');
  expect(tieOf({ why: 'owns a stake in the company' })).toBe('affiliate');
  expect(tieOf({ why: 'shareholder (LittleSis)' })).toBe('affiliate');
  expect(tieOf({ why: 'sole owner of the business' })).toBe('primary');
  expect(tieOf({ why: 'owner and CEO' })).toBe('primary');
  expect(tieOf({ why: 'owns and runs the shop' })).toBe('primary');
  expect(tieOf({ why: '10% owner (Form 4)' })).toBe('primary');
  expect(tieOf({ why: 'founded it' })).toBe('primary');
});

test('the same passage on several pages of one source is one record listing the other pages', async () => {
  const passage = 'Jane Roe of Acme Robotics said the product would change how every warehouse in the country is run.';
  const web = {
    id: 'web-search', label: 'Web', kinds: ['subject'],
    run: async (task, { subject }) => ({
      findings: [
        finding(subject, { title: 'Filing one', quote: passage, url: 'https://filings.test/1' }),
        finding(subject, { title: 'Filing two', quote: `${passage.toUpperCase()}  `, url: 'https://filings.test/2' }),
        finding(subject, { title: 'Filing three', quote: passage.replace(/,|\./g, ''), url: 'https://filings.test/3' }),
        finding(subject, { title: 'Other source', quote: passage, url: 'https://other.test/1', source: 'other' }),
        finding(subject, { title: 'Short one', quote: 'Jane Roe, Director', url: 'https://filings.test/4' }),
        finding(subject, { title: 'Short two', quote: 'Jane Roe, Director', url: 'https://filings.test/5' }),
      ],
    }),
  };
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, [web]);
  const titles = state.findings.map((f) => f.title);
  expect(titles).toEqual(expect.arrayContaining(['Filing one', 'Other source', 'Short one', 'Short two']));
  expect(titles).not.toContain('Filing two');
  expect(titles).not.toContain('Filing three');
  const kept = state.findings.find((f) => f.title === 'Filing one');
  expect(kept.data.alsoIn).toEqual(['https://filings.test/2', 'https://filings.test/3']);
});

test('archive snapshots with the same text are not merged', async () => {
  const passage = 'Jane Roe is the chief executive of Acme Robotics and leads its engineering and research teams.';
  const arch = {
    id: 'archive', label: 'Archive', kinds: ['subject'],
    run: async (task, { subject }) => ({
      findings: [
        finding(subject, { title: 'Snapshot 2019', quote: passage, url: 'https://web.archive.test/2019/acme', category: 'archive', source: 'archive' }),
        finding(subject, { title: 'Snapshot 2021', quote: passage, url: 'https://web.archive.test/2021/acme', category: 'archive', source: 'archive' }),
      ],
    }),
  };
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, [arch]);
  expect(state.findings.map((f) => f.title)).toEqual(expect.arrayContaining(['Snapshot 2019', 'Snapshot 2021']));
});

test('a company promoted from affiliate to primary is looked up again in full', async () => {
  const seen = [];
  const reg = { id: 'uk-companies-house', label: 'UK', kinds: ['company'], run: async (task) => { seen.push(`${task.value}:${task.tie}`); return { findings: [] }; } };
  const web = {
    id: 'web-search', label: 'Web', kinds: ['subject', 'company'],
    run: async (task, { subject }) => {
      if (task.kind === 'subject') {
        return {
          findings: [finding(subject, { title: 'Jane Roe of Acme Robotics', quote: 'Jane Roe of Acme Robotics advised Globex Industries.' })],
          threads: [makeThread('company', 'Globex Industries', 'adviser', { trusted: true })],
        };
      }
      if (task.value === 'Globex Industries' && task.tie === 'affiliate') {
        return {
          findings: [finding(subject, { title: 'Jane Roe co-founded Globex Industries', quote: 'Jane Roe of Acme Robotics co-founded Globex Industries.', url: 'https://news.test/globex' })],
          threads: [makeThread('company', 'Globex Industries', 'co-founded it', { trusted: true })],
        };
      }
      return { findings: [] };
    },
  };
  const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
  await runToEnd(state, [web, reg]);
  expect(seen).toEqual(expect.arrayContaining(['Globex Industries:affiliate', 'Globex Industries:primary']));
});
