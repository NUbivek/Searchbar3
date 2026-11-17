/**
 * Round 4 fixes to the deep check loop (deepCheck.js): records are graded at their own date (role tenures),
 * a record found again by a joint query names that person, partial answers and failure kinds are kept for the
 * coverage section, and duplicate copies of one page merge (across sections, source families, Wikipedia
 * copies, forum copies, tracking parameters, profile editions and archive summaries).
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { startState, stepDeepCheck, failureClass } = require('../../../src/server/founder/deepCheck');
const { makeFinding } = require('../../../src/server/founder/finding');
const { __resetLearningForTests } = require('../../../src/server/learning');

const base = { source: 'fake', sourceLabel: 'Fake', category: 'press' };

async function runToEnd(state, connectors) {
  for (let i = 0; i < 30 && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors, deadline: Date.now() + 5000 });
}
const src = (id, make, kinds = ['subject']) => ({ id, label: id, kinds, run: async (task, { subject }) => (task.kind === 'subject' ? { findings: make(subject).filter(Boolean) } : { findings: [] }) });

beforeEach(() => __resetLearningForTests());

describe('grading at the record date', () => {
  test('a record dated inside a CEO tenure is re-graded with its date; one dated after is not', async () => {
    const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
    state.anchors.roles = [{ value: 'Widgetco', org: 'Widgetco', role: 'ceo', from: '2015-01-01', to: '2019-12-31', origin: 'found' }];
    await runToEnd(state, [src('fake', (subject) => [
      makeFinding(subject, { ...base, url: 'https://news.test/a', title: 'Jane Roe, Widgetco CEO, speaks at a conference', date: '2017-05-01' }),
      makeFinding(subject, { ...base, url: 'https://news.test/b', title: 'Jane Roe, Widgetco CEO, speaks at a dinner', date: '2023-05-01' }),
    ])]);
    expect(state.findings.find((f) => f.url === 'https://news.test/a').match).toBe('likely');
    expect(state.findings.find((f) => f.url === 'https://news.test/b').match).toBe('possible');
  });
});

describe('joint queries', () => {
  test('a page already kept, found again by a lookup about an associate, lists that person', async () => {
    const page = { ...base, url: 'https://news.test/joint', title: 'Jane Roe and John Poe of Acme Robotics' };
    const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
    const conn = {
      id: 'fake', label: 'Fake', kinds: ['subject', 'associate'],
      run: async (task, { subject }) => (task.kind === 'subject'
        ? { findings: [makeFinding(subject, page)], threads: [{ kind: 'associate', value: 'John Poe', why: 'co-founder', trusted: true }] }
        : { findings: [makeFinding(subject, page)] }),
    };
    await runToEnd(state, [conn]);
    const kept = state.findings.filter((f) => f.url === page.url);
    expect(kept).toHaveLength(1);
    expect(kept[0].data.persons).toEqual(['John Poe']);
  });
});

describe('honest coverage', () => {
  test('parts of a source that did not answer are kept on its stats and in the progress', async () => {
    const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
    const conn = { id: 'us-states', label: 'States', kinds: ['subject'], run: async () => ({ findings: [], partial: ['Colorado', 'Texas', 'Colorado'] }) };
    await runToEnd(state, [conn]);
    expect(state.sources['us-states'].partial).toEqual(['Colorado', 'Texas']);
  });

  test('a failure is classed without echoing the message', async () => {
    expect(failureClass(new Error('HTTP 503 from host: <html>oops</html>'))).toBe('HTTP 503');
    expect(failureClass(new Error('timed out after 20s'))).toBe('timeout');
    expect(failureClass(new Error('getaddrinfo ENOTFOUND example.test'))).toBe('DNS');
    expect(failureClass(new Error('unable to verify the first certificate'))).toBe('TLS');
    expect(failureClass(new Error('Wayback: suspected abusive bot traffic'))).toBe('blocked by host');
    expect(failureClass(Object.assign(new Error('Forbidden'), { status: 403 }))).toBe('blocked by host (HTTP 403)');
    const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
    await runToEnd(state, [{ id: 'news', label: 'News', kinds: ['subject'], run: async () => { throw new Error('HTTP 502 bad gateway'); } }]);
    expect(state.sources.news.lastErrorClass).toBe('HTTP 502');
    expect(state.sources.news.lastError).toBe('could not be reached');
  });
});

describe('duplicate records merge', () => {
  test('one page filed under two sections by two sources is one record', async () => {
    const page = { url: 'https://news.test/story', title: 'Jane Roe of Acme Robotics raises money' };
    const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
    await runToEnd(state, [
      src('fake', (s) => [makeFinding(s, { ...base, ...page })]),
      src('other', (s) => [makeFinding(s, { ...base, source: 'other', category: 'career', ...page })]),
    ]);
    expect(state.findings.filter((f) => f.url === page.url)).toHaveLength(1);
  });

  test('a web copy of an article the Wikipedia source holds is dropped, whichever came first; the article sections stay', async () => {
    for (const order of [0, 1]) {
      const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
      const wiki = src('wikipedia', (s) => [
        makeFinding(s, { source: 'wikipedia', category: 'identity', title: 'Jane Roe: founder of Acme Robotics (Wikipedia article)', url: 'https://en.wikipedia.org/wiki/Jane_Roe' }),
        makeFinding(s, { source: 'wikipedia', category: 'career', title: 'Jane Roe: career as described on Wikipedia', quote: 'Jane Roe founded Acme Robotics.', url: 'https://en.wikipedia.org/wiki/Jane_Roe#Career' }),
      ]);
      const webCopy = src('web-search', (s) => [makeFinding(s, { source: 'web-search', category: 'press', title: 'Jane Roe - Wikipedia', quote: 'References: Jane Roe of Acme Robotics sued', url: 'https://en.m.wikipedia.org/wiki/Jane_Roe' })]);
      const conns = order ? [webCopy, wiki] : [wiki, webCopy];
      // run each source in turn so the order is fixed
      await stepDeepCheck(state, { connectors: [conns[0]], deadline: Date.now() + 5000 });
      state.phase = 'collect';
      state.queue = [{ connector: conns[1].id, kind: 'subject', value: 'Jane Roe', depth: 0, prior: 0.5, why: '' }];
      await stepDeepCheck(state, { connectors: [conns[1]], deadline: Date.now() + 5000 });
      expect(state.findings.map((f) => f.source).sort()).toEqual(['wikipedia', 'wikipedia']);
    }
  });

  test('the same long passage from two sources of one family is one record', async () => {
    const passage = 'Jane Roe serves as chief executive officer and a director of Acme Robotics and has since its founding.';
    const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
    await runToEnd(state, [
      src('sec-filings', (s) => [makeFinding(s, { source: 'sec-filings', category: 'career', title: 'Form S-1', quote: passage, url: 'https://sec.test/1' })]),
      src('sec-company', (s) => [makeFinding(s, { source: 'sec-company', category: 'career', title: 'Form 10-K', quote: passage, url: 'https://sec.test/2' })]),
    ]);
    expect(state.findings.filter((f) => f.url.startsWith('https://sec.test/'))).toHaveLength(1);
  });

  test('a forum copy of a story, a tracking parameter and a profile country edition do not make new records', async () => {
    const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
    await runToEnd(state, [src('fake', (s) => [
      makeFinding(s, { ...base, url: 'https://news.test/s', title: 'Jane Roe of Acme Robotics raises money' }),
      makeFinding(s, { ...base, source: 'forum', url: 'https://news.test/s?taid=abc', title: 'Hacker News (120 points, 40 comments): Jane Roe of Acme Robotics raises money' }),
      makeFinding(s, { ...base, category: 'identity', url: 'https://www.linkedin.com/in/jane-roe', title: 'Jane Roe - Acme Robotics' }),
      makeFinding(s, { ...base, category: 'identity', url: 'https://fr.linkedin.com/in/jane-roe', title: 'Jane Roe - Acme Robotics' }),
    ])]);
    expect(state.findings).toHaveLength(2);
  });

  test('two summaries of one archived page are one record, lifted by the stronger read; snapshots stay apart', async () => {
    const arch = { source: 'archive', sourceLabel: 'Archive', category: 'archive' };
    const state = startState({ name: 'Jane Roe', company: 'Acme Robotics' });
    await runToEnd(state, [src('archive', (s) => [
      makeFinding(s, { ...arch, url: 'https://web.archive.org/web/*/janeroe.test', title: 'janeroe.test archived 3 times in 2019', matchText: 'Jane Roe' }),
      makeFinding(s, { ...arch, url: 'https://web.archive.org/web/*/janeroe.test', title: 'janeroe.test archived 4 times in 2019', matchText: 'Jane Roe, Acme Robotics' }),
      makeFinding(s, { ...arch, url: 'https://web.archive.org/web/2019/janeroe.test', title: 'janeroe.test as of 2019: Jane Roe', matchText: 'Jane Roe' }),
      makeFinding(s, { ...arch, url: 'https://web.archive.org/web/2019/janeroe.test', title: 'janeroe.test as of 2019: Jane Roe, CEO', matchText: 'Jane Roe' }),
    ])]);
    const summaries = state.findings.filter((f) => f.url.includes('/web/*/'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].match).toBe('confirmed');
    expect(state.findings.filter((f) => f.url.includes('/web/2019/'))).toHaveLength(2);
  });
});
