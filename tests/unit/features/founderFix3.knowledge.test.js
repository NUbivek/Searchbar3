/**
 * Round-3 fixes to the knowledge connectors (sources/knowledge.js), from grading real reports:
 *   - the company's own article is read for advisers, shareholders, investors, board members and former
 *     ministers it names, even in sentences that do not name the person (item 20);
 *   - a Wikipedia career record that states exactly one year carries that year as its date (item 25, this file's part).
 * Fixtures are fictional people.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const K = require('../../../src/server/founder/sources/knowledge');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const ok = (url, body, status = 200) => ({ status, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function fakeNetwork(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    for (const [test, body, status] of routes) if (test(url)) return ok(url, typeof body === 'function' ? body(url) : body, status || 200);
    return ok(url, 'not found', 404);
  });
  return calls;
}
afterEach(() => {
  setTransport();
  K.__resetKnowledgeForTests();
});

const page = (title, extract, over = {}) => ({ query: { pages: [{ title, extract, pageprops: { 'wikibase-shortdesc': 'American businessman' }, canonicalurl: `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`, revisions: [{ timestamp: '2026-11-01T10:00:00Z' }], ...over }] } });
const subject = () => createSubject({ name: 'John Roe', company: 'Roe Motors' });

describe('wikipedia: roles the company article gives other people', () => {
  const COMPANY = [
    'Roe Motors is an American truck maker founded in 2014 by John Roe.',
    '',
    '== History ==',
    'In 2015 the company took on co-founding adviser and shareholder Paul Q, who later faced questions over a conflict of interest.',
    'Mary Stone, a former Canadian transport minister, joined the board in 2017.',
    'The company counts investor Hugo Brandt among its backers. Minister of Industry Alan Price praised the plant.',
    'Its board member Lena Fischer resigned in 2019.',
    '',
    '== Personal investors ==',
    'Roe Motors was praised by Kate Wells, the current transport minister.',
  ].join('\n');

  test('advisers, shareholders, investors, board members and former ministers become associate threads', async () => {
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Roe Motors', COMPANY)]]);
    const r = await K.wikipediaConnector.run({ kind: 'company', value: 'Roe Motors', tie: 'primary' }, ctxFor(subject()));
    expect(r.findings).toEqual([]);
    const byName = Object.fromEntries(r.threads.map((t) => [t.value, t]));
    expect(byName['Paul Q']).toEqual(expect.objectContaining({ kind: 'associate', role: 'Co-founding adviser and shareholder', trusted: true }));
    expect(byName['Mary Stone']).toEqual(expect.objectContaining({ kind: 'associate', role: 'Former minister' }));
    expect(byName['Hugo Brandt']).toEqual(expect.objectContaining({ kind: 'associate', role: 'Investor' }));
    expect(byName['Lena Fischer']).toEqual(expect.objectContaining({ kind: 'associate', role: 'Board member' }));
    expect(byName['Paul Q'].why).toMatch(/Roe Motors/);
    // never as relatives; a serving official merely quoted is no associate
    expect(r.threads.filter((t) => t.kind === 'relative')).toEqual([]);
    expect(byName['Kate Wells']).toBeUndefined();
    expect(byName['Alan Price']).toBeUndefined();
  });

  test('an article that never names the person gives no role threads', async () => {
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Roe Motors', COMPANY.replace(/John Roe/g, 'Jim Doe'))]]);
    const r = await K.wikipediaConnector.run({ kind: 'company', value: 'Roe Motors', tie: 'primary' }, ctxFor(subject()));
    expect(r.threads).toEqual([]);
  });

  test('the person is never their own associate', async () => {
    const text = COMPANY.replace('investor Hugo Brandt', 'investor John Roe');
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Roe Motors', text)]]);
    const r = await K.wikipediaConnector.run({ kind: 'company', value: 'Roe Motors', tie: 'primary' }, ctxFor(subject()));
    expect(r.threads.map((t) => t.value)).not.toContain('John Roe');
  });
});

describe('wikipedia: a career record dated by the one year it states', () => {
  const run = async (extract) => {
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('John Roe', extract)]]);
    return K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/John_Roe' }, ctxFor(subject()));
  };
  const career = (r) => r.findings.filter((f) => f.category === 'career' && /career as described/.test(f.title));

  test('one year in the quotation becomes the date', async () => {
    const r = await run(['John Roe is an American businessman.', '', '== Career ==', 'John Roe joined Acme Labs as a research scientist in 2020, working on language models for the company.'].join('\n'));
    expect(career(r)).toHaveLength(1);
    expect(career(r)[0].date).toBe('2020');
  });

  test('several years leave the date empty', async () => {
    const r = await run(['John Roe is an American businessman.', '', '== Career ==', 'John Roe joined Acme Labs as a research scientist in 2020, and in 2023 he founded the company Roe Motors with two partners.'].join('\n'));
    expect(career(r)).toHaveLength(1);
    expect(career(r)[0].date).toBeNull();
  });
});
