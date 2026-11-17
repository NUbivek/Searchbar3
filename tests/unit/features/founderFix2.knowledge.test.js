/**
 * Round-2 fixes to the knowledge connectors (sources/knowledge.js), from grading real reports:
 *   - education is never quoted from a "Personal life" section, and an initial ("Robert F. Kennedy") does not end a sentence;
 *   - sentences of a paragraph that a matter record did not quote are still read for career; a serious matter in the
 *     opening paragraph gets its own record; service and funding-amount sentences reach the career record;
 *     "He founded ..." after a sentence naming the person yields the company thread;
 *   - the company's own article is read for co-founders (primary companies only, and only when it names the person);
 *   - a LittleSis ownership tie is a shareholding, not a primary role.
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
const runArticle = async (extract, subject = createSubject({ name: 'John Roe', company: 'Roe Motors' })) => {
  fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('John Roe', extract)]]);
  return K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/John_Roe' }, ctxFor(subject));
};

describe('wikipedia: education is not quoted from personal life', () => {
  test('a "Personal life" section is never the education source; the lead is used instead', async () => {
    const r = await runArticle([
      'John Roe is an American businessman and the founder of Roe Motors. He attended Brigham Young University but dropped out.',
      '',
      '== Career ==',
      'In 2014, Roe founded Roe Motors and became its chief executive.',
      '',
      '== Personal life ==',
      'Roe attended a fundraiser for the campaign of Robert F. Kennedy Jr. at his school in 2023, and gave to the campaign.',
    ].join('\n'));
    const edu = r.findings.find((f) => f.category === 'education');
    expect(edu).toBeDefined();
    expect(edu.title).not.toMatch(/Personal life/);
    expect(edu.quote).not.toMatch(/Kennedy|fundraiser|campaign/);
    expect(edu.quote).toContain('dropped out');
    expect(JSON.stringify(r.findings)).not.toMatch(/Kennedy|fundraiser/);
  });

  test('a single capital initial does not cut a sentence in two', async () => {
    const r = await runArticle([
      'John Roe is an American businessman and the founder of Roe Motors.',
      '',
      '== Career ==',
      'In 2014, Roe founded Roe Motors with investor Mary T. Smith and became its chief executive. The company launched its first truck in 2016.',
    ].join('\n'));
    const career = r.findings.find((f) => f.category === 'career');
    expect(career.quote).toContain('In 2014, Roe founded Roe Motors with investor Mary T. Smith and became its chief executive.');
  });
});

describe('wikipedia: what matter records leave behind still reaches a record', () => {
  test('a career sentence in a paragraph that also reports a matter is still quoted for career', async () => {
    const r = await runArticle([
      'John Roe is an American businessman and the founder of Roe Motors.',
      '',
      '== Career ==',
      'In 2008, Roe founded Roe Security and Alarm, a home security company. In 2012, the company was sued by a former customer over its contracts.',
    ].join('\n'));
    const matter = r.findings.find((f) => /sued/.test(f.quote));
    expect(matter.quote).not.toMatch(/Roe Security and Alarm, a home security/);
    const career = r.findings.find((f) => f.category === 'career');
    expect(career).toBeDefined();
    expect(career.quote).toContain('In 2008, Roe founded Roe Security and Alarm');
    expect(career.quote).not.toMatch(/sued/);
  });

  test('a serious matter in the opening paragraph beyond the summary gets its own record', async () => {
    const r = await runArticle([
      'John Roe is an American businessman. He founded Roe Motors in 2014. He served as its chief executive until 2020. He also chaired its board. In 2023, an arbitration panel ordered Roe to pay the company $160 million after a lawsuit over his statements to investors.',
      '',
      '== Career ==',
      'In 2014, Roe founded Roe Motors.',
    ].join('\n'));
    const identity = r.findings.find((f) => f.category === 'identity');
    expect(identity.quote).not.toMatch(/arbitration/);
    const matter = r.findings.find((f) => f.category !== 'identity' && /arbitration panel/.test(f.quote));
    expect(matter).toBeDefined();
    expect(['medium', 'high']).toContain(matter.severity);
    expect(matter.title).toMatch(/summary/);
  });

  test('military service under early life and a funding amount under career reach career records', async () => {
    const r = await runArticle([
      'John Roe is an American businessman and the founder of Roe Motors.',
      '',
      '== Early life and education ==',
      'Roe served five years in the Israeli Navy, reaching the rank of officer. He studied at Baruch College.',
      '',
      '== Career ==',
      'In 2014, Roe founded Roe Motors. In 2022, Roe Motors raised $350 million in a round led by a large fund.',
    ].join('\n'));
    const careers = r.findings.filter((f) => f.category === 'career');
    expect(careers.some((f) => /\$350 million/.test(f.quote))).toBe(true);
    const service = careers.find((f) => /Israeli Navy/.test(f.quote));
    expect(service).toBeDefined();
    expect(new Set(careers.map((f) => f.url)).size).toBe(careers.length);
  });

  test('"He founded ..." right after a sentence naming the person gives the company thread', async () => {
    const r = await runArticle([
      'John Roe is an American businessman and the founder of Roe Motors.',
      '',
      '== Career ==',
      'In 2008, Roe left college. He founded Brightline Analytics in 2010, a data company.',
    ].join('\n'));
    expect(r.threads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'company', value: expect.stringMatching(/^Brightline Analytics/) })]));
  });
});

describe('wikipedia: the company article', () => {
  const COMPANY = [
    'Roe Motors is an American truck maker founded in 2014.',
    '',
    '== History ==',
    'Roe Motors was co-founded by John Roe with co-founder Ann Lake. In 2016, John Roe co-founded the company with Ann Lake and Peter Vance.',
  ].join('\n');

  test('plans only for a primary (or untagged) company, not for an affiliate', () => {
    expect(K.wikipediaConnector.plan({ kind: 'company', value: 'Roe Motors' })).toHaveLength(1);
    expect(K.wikipediaConnector.plan({ kind: 'company', value: 'Roe Motors', tie: 'primary' })).toHaveLength(1);
    expect(K.wikipediaConnector.plan({ kind: 'company', value: 'Alpha Apps', tie: 'affiliate' })).toEqual([]);
  });

  test('co-founders named with the person become associate threads; no records are quoted', async () => {
    const calls = fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Roe Motors', COMPANY)]]);
    const subject = createSubject({ name: 'John Roe', company: 'Roe Motors' });
    const r = await K.wikipediaConnector.run({ kind: 'company', value: 'Roe Motors', tie: 'primary' }, ctxFor(subject));
    expect(calls).toHaveLength(1);
    expect(r.findings).toEqual([]);
    expect(r.threads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'associate', value: 'Ann Lake', trusted: true })]));
  });

  test('an article that never names the person, a different company, or an affiliate task gives nothing', async () => {
    const subject = createSubject({ name: 'John Roe', company: 'Roe Motors' });
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Roe Motors', COMPANY.replace(/John Roe/g, 'Jim Doe'))]]);
    expect((await K.wikipediaConnector.run({ kind: 'company', value: 'Roe Motors' }, ctxFor(subject))).threads).toEqual([]);
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Roe Motorsport Club', COMPANY)]]);
    expect((await K.wikipediaConnector.run({ kind: 'company', value: 'Roe Motors' }, ctxFor(subject))).threads).toEqual([]);
    const calls = fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Roe Motors', COMPANY)]]);
    expect((await K.wikipediaConnector.run({ kind: 'company', value: 'Roe Motors', tie: 'affiliate' }, ctxFor(subject))).threads).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('the source being down rejects', async () => {
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), 'oops', 500]]);
    const subject = createSubject({ name: 'John Roe', company: 'Roe Motors' });
    await expect(K.wikipediaConnector.run({ kind: 'company', value: 'Roe Motors' }, ctxFor(subject))).rejects.toThrow();
  });
});

describe('littlesis: an ownership tie is a shareholding', () => {
  const link = (kind, id, name) => `https://littlesis.org/${kind}/${id}-${name.replace(/ /g, '_')}`;
  const entity = (id, kind, name, attrs = {}) => ({ type: 'entities', id, attributes: { id, name, blurb: '', summary: '', primary_ext: kind === 'person' ? 'Person' : 'Org', types: [], aliases: [name], ...attrs }, links: { self: link(kind === 'person' ? 'person' : 'org', id, name) } });
  const rel = (id, category, [k1, id1, n1], [k2, id2, n2], attrs = {}) => ({
    type: 'relationships', id,
    attributes: { id, entity1_id: id1, entity2_id: id2, category_id: category, description1: null, description2: null, start_date: null, end_date: null, is_current: null, description: `${n1}  and  ${n2}`, category_attributes: null, ...attrs },
    self: `https://littlesis.org/relationships/${id}`, entity: link(k1, id1, n1), related: link(k2, id2, n2),
  });
  const JOHN = ['person', 11, 'John Roe'];

  test('the thread reads "shareholder", which is not a primary tie', async () => {
    fakeNetwork([
      [(u) => u.includes('/api/entities/search?q=John%20Roe'), { data: [entity(11, 'person', 'John Roe', { blurb: 'Founder and CEO, Roe Motors' })] }],
      [(u) => u.endsWith('/api/entities/11/relationships'), { data: [
        rel(1, 1, JOHN, ['org', 50, 'Roe Motors'], { description1: 'Chief Executive Officer', description: 'John Roe  had a position (Chief Executive Officer) at  Roe Motors' }),
        rel(2, 10, JOHN, ['org', 51, 'Alpha Apps'], { description: 'John Roe  is/was an owner of  Alpha Apps' }),
      ] }],
    ]);
    const subject = createSubject({ name: 'John Roe', company: 'Roe Motors' });
    const r = await K.littleSisConnector.run({ kind: 'subject', value: 'John Roe' }, ctxFor(subject));
    const t = r.threads.find((x) => x.kind === 'company' && x.value === 'Alpha Apps');
    expect(t.why).toBe('shareholder (LittleSis)');
    expect(t.why).not.toMatch(/\bowner\b/);
    expect(r.findings.map((f) => f.title)).toEqual(expect.arrayContaining(['John Roe: shareholder of Alpha Apps']));
  });
});
