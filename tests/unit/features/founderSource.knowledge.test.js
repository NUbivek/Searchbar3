/**
 * Knowledge-graph identity, public roles, and publicly documented family and
 * related-party ties: Wikidata, Wikipedia, LittleSis, US nonprofit filings.
 * Fixtures are small cuts shaped like the real responses (fictional people).
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const K = require('../../../src/server/founder/sources/knowledge');

const YEAR = new Date().getUTCFullYear();
const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const ok = (url, body, status = 200) => ({ status, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/** A fake network: `routes` is [[test(url) -> bool, body | (url) => body, status?]]. Records every URL asked for. */
function fakeNetwork(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    for (const [test, body, status] of routes) {
      if (test(url)) return ok(url, typeof body === 'function' ? body(url) : body, status || 200);
    }
    return ok(url, 'not found', 404);
  });
  return calls;
}

afterEach(() => {
  setTransport();
  K.__resetKnowledgeForTests();
});

/* ------------------------------------------------------------------ */
/* Wikidata                                                            */
/* ------------------------------------------------------------------ */

const E = 'http://www.wikidata.org/entity/';
const ST = 'http://www.wikidata.org/entity/statement/';
const sparqlBody = (rows) => ({ head: { vars: [] }, results: { bindings: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { type: 'literal', value: String(v) }]))) } });
const sparqlOf = (url) => decodeURIComponent(new URL(url).searchParams.get('query') || '');

const CANDIDATES = [
  { c: `${E}Q100`, cLabel: 'Jane Roe', cDesc: 'American engineer, founder of Acme Robotics', sitelinks: 3, birthYear: 1980, article: 'https://en.wikipedia.org/wiki/Jane_Roe', aliases: '', employers: 'Globex', orgs: 'Acme Robotics', schools: 'Stanford University' },
  { c: `${E}Q200`, cLabel: 'Jane Roe', cDesc: 'British painter (born 1950)', sitelinks: 1, birthYear: 1950, aliases: '', employers: '', orgs: '', schools: 'Royal College of Art' },
];
const PROFILE = [
  { kind: 'educated at', st: `${ST}Q100-aaa`, val: `${E}Q10`, valLabel: 'Stanford University', degreeLabel: 'Bachelor of Science', start: '2001-01-01T00:00:00Z', end: '2005-01-01T00:00:00Z' },
  { kind: 'founded by', st: `${ST}Q300-bbb`, val: `${E}Q300`, valLabel: 'Acme Robotics', start: '2015-01-01T00:00:00Z' },
  { kind: 'employer', st: `${ST}Q100-ccc`, val: `${E}Q301`, valLabel: 'Globex', start: '2005-01-01T00:00:00Z', end: '2014-01-01T00:00:00Z' },
  { kind: 'position held', st: `${ST}Q100-ddd`, val: `${E}Q400`, valLabel: 'Mayor of Springfield', jurLabel: 'Springfield', start: '2010-01-01T00:00:00Z', end: '2012-01-01T00:00:00Z' },
  { kind: 'X username', st: `${ST}Q100-eee`, val: 'janeroe', valLabel: 'janeroe' },
];
const RELATIVES = [
  { rel: `${E}Q500`, relLabel: 'John Roe', relDesc: 'American businessman', prop: 'father', birthYear: 1950, sitelinks: 2, occupations: 'businessperson' },
  { rel: `${E}Q501`, relLabel: 'Kid Roe', relDesc: 'child actor', prop: 'child', birthYear: YEAR - 3, sitelinks: 1, occupations: 'actor' },
  { rel: `${E}Q502`, relLabel: 'Sam Roe', relDesc: '', prop: 'spouse', birthYear: 1981, sitelinks: 0, occupations: '' },
  { rel: `${E}Q503`, relLabel: 'Adult Roe', relDesc: 'investor', prop: 'child', sitelinks: 0, occupations: 'investor' },
  { rel: `${E}Q504`, relLabel: 'Mary Roe', relDesc: 'American politician', prop: 'sibling', birthYear: 1985, sitelinks: 1, occupations: 'politician' },
  { rel: `${E}Q505`, relLabel: 'Ann Teacher', relDesc: 'American professor', prop: 'mother', birthYear: 1952, sitelinks: 1, occupations: 'university teacher' },
];
const ROLES = [
  { who: `${E}Q100`, role: 'founded by', st: `${ST}Q300-bbb`, org: `${E}Q300`, orgLabel: 'Acme Robotics', start: '2015-01-01T00:00:00Z' },
  { who: `${E}Q500`, role: 'board member', st: `${ST}Q300-fff`, org: `${E}Q300`, orgLabel: 'Acme Robotics', start: '2016-01-01T00:00:00Z' },
  { who: `${E}Q505`, role: 'employer', st: `${ST}Q505-hhh`, org: `${E}Q700`, orgLabel: 'State University' },
  { who: `${E}Q504`, role: 'position held', st: `${ST}Q504-ggg`, org: `${E}Q600`, orgLabel: 'Member of the Springfield City Council', jurLabel: 'Springfield', start: '2018-01-01T00:00:00Z' },
];

function wikidataRoutes({ candidates = CANDIDATES, search = ['Q100', 'Q200'] } = {}) {
  return [
    [(u) => u.startsWith('https://www.wikidata.org/w/api.php'), { query: { search: search.map((title) => ({ title })) } }],
    [(u) => u.startsWith('https://query.wikidata.org/') && sparqlOf(u).includes('?aliases'), sparqlBody(candidates)],
    [(u) => u.startsWith('https://query.wikidata.org/') && sparqlOf(u).includes("'educated at'"), sparqlBody(PROFILE)],
    [(u) => u.startsWith('https://query.wikidata.org/') && sparqlOf(u).includes("'unmarried partner'"), sparqlBody(RELATIVES)],
    [(u) => u.startsWith('https://query.wikidata.org/') && sparqlOf(u).includes('VALUES ?who'), sparqlBody(ROLES)],
  ];
}

describe('wikidataConnector', () => {
  test('plans a profile and a family lookup for the subject only', () => {
    expect(K.wikidataConnector.plan({ kind: 'subject', value: 'Jane Roe' }).map((p) => p.template)).toEqual(['profile', 'family']);
    expect(K.wikidataConnector.plan({ kind: 'company', value: 'Acme' })).toEqual([]);
  });

  test('profile: education, career, public office and the Wikipedia thread, from the entity that matches the company', async () => {
    const calls = fakeNetwork(wikidataRoutes());
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'profile' }, ctxFor(subject));
    // R3: plus one search for the company's own item (people tied to it are added to the candidates)
    expect(calls).toHaveLength(4);
    expect(calls[1]).toContain('action=wbsearchentities');
    const identity = r.findings.find((f) => f.category === 'identity');
    expect(identity).toMatchObject({ match: 'confirmed', url: 'https://www.wikidata.org/wiki/Q100', source: 'wikidata' });
    expect(identity.title).toBe('Jane Roe: American engineer, founder of Acme Robotics');

    const school = r.findings.find((f) => f.category === 'education');
    expect(school.title).toBe('Jane Roe: educated at Stanford University, Bachelor of Science (2001 to 2005)');
    expect(school.url).toBe('https://www.wikidata.org/entity/statement/Q100-aaa');
    expect(school.date).toBe('2005');

    const career = r.findings.filter((f) => f.category === 'career').map((f) => f.title);
    expect(career).toEqual(expect.arrayContaining(['Jane Roe at Acme Robotics: founder (from 2015)', 'Jane Roe at Globex: employed (2005 to 2014)']));

    const pep = r.findings.find((f) => f.category === 'sanctions');
    expect(pep).toMatchObject({ title: 'Politically exposed person: Mayor of Springfield (2010 to 2012)', severity: 'low', match: 'confirmed', date: '2010' });
    expect(pep.quote).toContain('Jane Roe: position held Mayor of Springfield');

    expect(r.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe', trusted: true }),
      expect.objectContaining({ kind: 'company', value: 'Acme Robotics', trusted: true }),
      expect.objectContaining({ kind: 'school', value: 'Stanford University', trusted: true }),
      expect.objectContaining({ kind: 'handle', value: 'janeroe', trusted: true }),
    ]));
  });

  test('family: only adult relatives in a public role, with overlaps; birth years never leave the connector', async () => {
    const calls = fakeNetwork(wikidataRoutes());
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'family' }, ctxFor(subject));
    expect(calls).toHaveLength(5); // search, the company's item, candidates, relatives, roles

    const related = r.findings.filter((f) => f.category === 'related');
    const father = related.find((f) => f.title.startsWith('Father:'));
    expect(father.title).toBe('Father: John Roe, board member of Acme Robotics; businessperson');
    expect(father).toMatchObject({ url: 'https://www.wikidata.org/wiki/Q500', match: 'confirmed' });
    expect(father.quote).toContain('Jane Roe: father John Roe');

    const overlap = related.find((f) => f.title.startsWith('Related-party overlap'));
    expect(overlap).toMatchObject({ title: 'Related-party overlap: John Roe (father) and Jane Roe are both tied to Acme Robotics', severity: 'low' });

    expect(related.some((f) => f.title.startsWith('Sibling: Mary Roe'))).toBe(true);
    const familyPep = r.findings.find((f) => f.category === 'sanctions');
    expect(familyPep.title).toBe('Politically exposed person in the family: sibling Mary Roe, Member of the Springfield City Council (from 2018)');

    const text = JSON.stringify(r);
    for (const hidden of ['Kid Roe', 'Sam Roe', 'Adult Roe', 'Ann Teacher', '1950', '1981', '1985', String(YEAR - 3)]) expect(text).not.toContain(hidden);

    expect(r.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'relative', value: 'John Roe', relation: 'father', trusted: true }),
      expect.objectContaining({ kind: 'relative', value: 'Mary Roe', relation: 'sibling', trusted: true }),
    ]));
  });

  test('namesakes: no candidate tied to the company -> a note and no findings', async () => {
    const calls = fakeNetwork(wikidataRoutes());
    const subject = createSubject({ name: 'Jane Roe', company: 'Initech' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    expect(r.findings).toEqual([]);
    expect(r.threads).toEqual([]);
    expect(r.notes[0]).toMatch(/Wikidata lists 2 people named Jane Roe .*Initech.*None was used/);
    expect(calls).toHaveLength(3); // R3: search, the company's item, candidates
  });

  test('namesakes: two candidates equally tied to the company -> none is picked', () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const base = { label: 'Jane Roe', aliases: [], employers: [], schools: [], sitelinks: 1, birthYear: null, deathYear: null };
    const out = K.chooseCandidate(subject, [
      { ...base, qid: 'Q1', description: 'engineer at Acme Robotics', orgs: ['Acme Robotics'] },
      { ...base, qid: 'Q2', description: 'sales lead at Acme Robotics', orgs: ['Acme Robotics'] },
    ]);
    expect(out.status).toBe('unclear');
    expect(out.note).toMatch(/could not be told apart/);
  });

  test('name only (no company given): records stay possible and family ties are not read', async () => {
    const calls = fakeNetwork(wikidataRoutes({ candidates: [CANDIDATES[0]], search: ['Q100'] }));
    const subject = createSubject({ name: 'Jane Roe' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((f) => f.match === 'possible')).toBe(true);
    expect(r.threads.every((t) => t.trusted === false)).toBe(true);
    expect(r.findings.some((f) => f.category === 'related')).toBe(false);
    expect(calls.some((u) => sparqlOf(u).includes("'unmarried partner'"))).toBe(false);
    expect(r.notes[0]).toMatch(/possible matches only/);
  });

  test('the source failing makes run() reject', async () => {
    fakeNetwork([[(u) => u.startsWith('https://www.wikidata.org/'), 'oops', 500]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    await expect(K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Wikipedia                                                           */
/* ------------------------------------------------------------------ */

const ARTICLE = [
  'Jane Roe (born 1980) is an American engineer and the founder of Acme Robotics. She previously worked at Globex as a director of engineering.',
  '',
  '== Early life ==',
  'Roe grew up in Ohio. She graduated from Stanford University with a degree in mechanical engineering in 2005.',
  '',
  '== Career ==',
  'In 2015, Roe founded Acme Robotics with her co-founder John Smith. The company raised $40 million in 2019.',
  '',
  '== Legal issues ==',
  'In 2021, the Securities and Exchange Commission charged Roe with securities fraud over statements made to investors. Roe denied the claims.',
  '',
  'In 2022, a former employee filed a lawsuit against Roe over unpaid wages at the company. The case was settled in 2023.',
  '',
  '== Personal life ==',
  'Roe grew up in Ohio. Her father, John Roe, is the chairman of Roe Industries. Roe married Sam Roe in 2010 and they live in Palo Alto.',
  '',
  '== References ==',
].join('\n');

const wpPage = (over = {}) => ({ query: { pages: [{ title: 'Jane Roe', extract: ARTICLE, pageprops: { 'wikibase-shortdesc': 'American engineer (born 1980)', wikibase_item: 'Q100' }, canonicalurl: 'https://en.wikipedia.org/wiki/Jane_Roe', revisions: [{ timestamp: '2026-11-01T10:00:00Z' }], ...over }] } });

describe('wikipediaConnector', () => {
  test('acts only on Wikipedia article links', async () => {
    const calls = fakeNetwork([]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    expect(K.wikipediaConnector.plan({ kind: 'url', value: 'https://example.com/jane' })).toEqual([]);
    expect(K.wikipediaConnector.plan({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe' })).toHaveLength(1);
    expect(await K.wikipediaConnector.run({ kind: 'url', value: 'https://example.com/jane' }, ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
    expect(await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Category:People' }, ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
    expect(calls).toEqual([]);
  });

  test('summary, one finding per legal paragraph (verbatim, own address), education and career; private life not quoted', async () => {
    const calls = fakeNetwork([[(u) => u.startsWith('https://en.wikipedia.org/w/api.php'), wpPage()]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe' }, ctxFor(subject));
    expect(calls).toHaveLength(1);

    const identity = r.findings.find((f) => f.category === 'identity');
    expect(identity).toMatchObject({ title: 'Jane Roe: American engineer (Wikipedia article)', match: 'confirmed', url: 'https://en.wikipedia.org/wiki/Jane_Roe', date: null });
    expect(identity.data.revisedAt).toBe('2026-11-01T10:00:00Z');
    expect(identity.quote).not.toMatch(/1980/);

    const legal = r.findings.filter((f) => f.category === 'litigation');
    expect(legal).toHaveLength(2);
    expect(legal[0].severity).toBe('high');
    expect(legal[0].quote).toBe('In 2021, the Securities and Exchange Commission charged Roe with securities fraud over statements made to investors.');
    expect(legal[0].date).toBe('2021'); // the year the paragraph gives, not the article's last edit
    expect(legal[1].date).toBe('2022'); // the year the passage opens with (the lawsuit), not the latest year it names
    expect(legal[1].severity).toBe('medium');
    expect(ARTICLE).toContain(legal[1].quote);
    expect(legal[0].url).toBe('https://en.wikipedia.org/wiki/Jane_Roe%23Legal_issues');
    expect(legal[1].url).not.toBe(legal[0].url);
    expect(legal[1].url.startsWith('https://en.wikipedia.org/wiki/Jane_Roe%23Legal_issues%3A~%3Atext%3D')).toBe(true);

    expect(r.findings.find((f) => f.category === 'education').quote).toContain('She graduated from Stanford University');
    expect(r.findings.find((f) => f.category === 'career').quote).toContain('In 2015, Roe founded Acme Robotics');
    const text = JSON.stringify(r.findings);
    expect(text).not.toMatch(/married|Palo Alto/);

    expect(r.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'company', value: 'Acme Robotics', trusted: true }),
      expect.objectContaining({ kind: 'relative', value: 'John Roe', trusted: true }),
    ]));
    expect(r.threads.some((t) => t.value === 'Sam Roe')).toBe(false);
  });

  test('namesake article (nothing ties it to the company): findings stay possible, threads are not followed', async () => {
    const extract = 'Jane Roe is a British painter known for coastal landscapes. Her work was shown at the Tate in 1999.\n\n== Career ==\nRoe joined the Royal Academy in 2001 and became a director of its school.';
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), wpPage({ title: 'Jane Roe (painter)', extract, pageprops: { 'wikibase-shortdesc': 'British painter' } })]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe_(painter)' }, ctxFor(subject));
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((f) => f.match === 'possible')).toBe(true);
    expect(r.threads.every((t) => t.trusted === false)).toBe(true);
  });

  test('an article about someone else, or a disambiguation page, is not used', async () => {
    fakeNetwork([[(u) => u.includes('titles=John%20Smith'), wpPage({ title: 'John Smith' })], [(u) => u.includes('titles=Jane%20Roe'), wpPage({ pageprops: { disambiguation: '' } })]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    expect((await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/John_Smith' }, ctxFor(subject))).findings).toEqual([]);
    const dis = await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe' }, ctxFor(subject));
    expect(dis.findings).toEqual([]);
    expect(dis.notes[0]).toMatch(/list of different people/);
  });

  test('the source failing makes run() reject', async () => {
    fakeNetwork([[() => true, 'down', 503]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    await expect(K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe' }, ctxFor(subject))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* LittleSis                                                           */
/* ------------------------------------------------------------------ */

const lsEntity = (id, kind, name, attrs = {}) => ({ type: 'entities', id, attributes: { id, name, blurb: '', summary: '', primary_ext: kind === 'person' ? 'Person' : 'Org', types: kind === 'person' ? ['Person'] : ['Organization'], aliases: [name], ...attrs }, links: { self: `https://littlesis.org/entities/${id}-${name.replace(/ /g, '_')}` } });
const link = (kind, id, name) => `https://littlesis.org/${kind}/${id}-${name.replace(/ /g, '_')}`;
const lsRel = (id, category, [k1, id1, n1], [k2, id2, n2], attrs = {}) => ({
  type: 'relationships', id,
  attributes: { id, entity1_id: id1, entity2_id: id2, category_id: category, description1: null, description2: null, start_date: null, end_date: null, is_current: null, description: `${n1}  and  ${n2}`, category_attributes: null, ...attrs },
  self: `https://littlesis.org/relationships/${id}`, entity: link(k1, id1, n1), related: link(k2, id2, n2),
});
const JANE = ['person', 11, 'Jane Roe'];
const LS_RELS = [
  lsRel(1001, 1, JANE, ['org', 50, 'Acme Robotics'], { description1: 'Chief Executive Officer', start_date: '2015-00-00', is_current: true, description: 'Jane Roe  had a position (Chief Executive Officer) at  Acme Robotics', category_attributes: { is_board: false } }),
  lsRel(1002, 2, JANE, ['org', 51, 'Stanford University'], { description: 'Jane Roe  is/was a student of  Stanford University' }),
  lsRel(1003, 5, JANE, ['org', 52, 'Friends of Senator Doe'], { amount: 5000, description: 'Jane Roe  gave money to  Friends of Senator Doe' }),
  lsRel(1004, 8, ['person', 60, 'Party Friend'], JANE, { description: 'Party Friend  and  Jane Roe  have/had a social relationship' }),
  lsRel(1005, 4, ['person', 70, 'John Roe'], JANE, { description1: 'father', description2: 'daughter', start_date: '1980-00-00', description: 'John Roe  and  Jane Roe  are in a family' }),
  lsRel(1006, 4, JANE, ['person', 71, 'Kid Roe'], { description1: 'mother', description2: 'son', description: 'Jane Roe  and  Kid Roe  are in a family' }),
  lsRel(1007, 4, JANE, ['person', 72, 'Sam Roe'], { description1: 'wife', description2: 'husband', description: 'Jane Roe  and  Sam Roe  are in a family' }),
  lsRel(1008, 9, JANE, ['person', 73, 'John Smith'], { description1: 'business partner', description2: 'business partner', description: 'Jane Roe  and  John Smith  have/had a professional relationship' }),
];
const LS_FAMILY = [
  lsEntity(70, 'person', 'John Roe', { blurb: 'Chairman of Roe Industries', types: ['Person', 'Business Person'], start_date: '1950-00-00' }),
  lsEntity(71, 'person', 'Kid Roe', { blurb: 'Child actor and founder of a lemonade stand', start_date: `${YEAR - 10}-00-00` }),
  lsEntity(72, 'person', 'Sam Roe', { blurb: '', start_date: '1981-00-00' }),
];
const lsData = (data) => ({ meta: { currentPage: 1, pageCount: 1 }, data });

function littleSisRoutes() {
  return [
    [(u) => u.includes('/api/entities/search?q=Jane%20Roe'), lsData([lsEntity(11, 'person', 'Jane Roe', { blurb: 'Founder and CEO, Acme Robotics', types: ['Person', 'Business Person'] }), lsEntity(12, 'person', 'Jane Roe', { blurb: 'Painter' }), lsEntity(13, 'org', 'Jane Roe Gallery')])],
    [(u) => u.endsWith('/api/entities/11/relationships'), lsData(LS_RELS)],
    [(u) => u.endsWith('/api/entities/12/relationships'), lsData([])],
    [(u) => u.includes('/api/entities/11/connections?category_id=4'), lsData(LS_FAMILY)],
    [(u) => u.includes('/api/entities/search?q=Acme%20Robotics'), lsData([lsEntity(50, 'org', 'Acme Robotics')])],
    [(u) => u.endsWith('/api/entities/50/relationships'), lsData([LS_RELS[0], lsRel(1009, 1, ['person', 80, 'John Doe'], ['org', 50, 'Acme Robotics'], { description1: 'Director', description: 'John Doe  had a position (Director) at  Acme Robotics' })])],
  ];
}

describe('littleSisConnector', () => {
  test('subject: roles, education and a family tie in a public role; donations, social ties, minors and role-less spouses dropped', async () => {
    const calls = fakeNetwork(littleSisRoutes());
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.littleSisConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    expect(calls.length).toBeLessThanOrEqual(4);

    const ceo = r.findings.find((f) => f.category === 'career');
    expect(ceo).toMatchObject({ title: 'Jane Roe: Chief Executive Officer at Acme Robotics (from 2015)', match: 'confirmed', url: 'https://littlesis.org/relationships/1001', date: '2015', source: 'littlesis' });
    expect(ceo.quote).toContain('had a position (Chief Executive Officer) at');
    expect(r.findings.find((f) => f.category === 'education').title).toBe('Jane Roe: student at Stanford University');

    const father = r.findings.find((f) => f.category === 'related');
    expect(father).toMatchObject({ title: 'Father: John Roe, Chairman of Roe Industries', url: 'https://littlesis.org/entities/70-John_Roe', match: 'confirmed', date: null });
    expect(r.findings.filter((f) => f.category === 'related')).toHaveLength(1);

    const text = JSON.stringify(r);
    for (const hidden of ['Senator Doe', 'Party Friend', 'Kid Roe', 'Sam Roe', '1950', '1980', '1981', 'Painter']) expect(text).not.toContain(hidden);

    expect(r.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'company', value: 'Acme Robotics', trusted: true }),
      expect.objectContaining({ kind: 'school', value: 'Stanford University', trusted: true }),
      expect.objectContaining({ kind: 'associate', value: 'John Smith', trusted: true }),
      expect.objectContaining({ kind: 'relative', value: 'John Roe', relation: 'father', trusted: true }),
    ]));
  });

  test('namesakes: entries not tied to the company -> a note and no findings', async () => {
    fakeNetwork(littleSisRoutes());
    const subject = createSubject({ name: 'Jane Roe', company: 'Initech' });
    const r = await K.littleSisConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    expect(r.findings).toEqual([]);
    expect(r.notes[0]).toMatch(/LittleSis lists 2 people named Jane Roe .*Initech.*None was used/);
  });

  test('company: the subject\'s roles read from the company entry; other people are not reported', async () => {
    const calls = fakeNetwork(littleSisRoutes());
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.littleSisConnector.run({ kind: 'company', value: 'Acme Robotics' }, ctxFor(subject));
    expect(calls).toHaveLength(2);
    expect(r.findings).toHaveLength(1);
    // R3: a structural tie (the company's own entry lists the full name) is 'likely', set by hand, never more
    expect(r.findings[0]).toMatchObject({ title: 'Jane Roe: Chief Executive Officer at Acme Robotics (from 2015)', match: 'likely' });
  });

  test('the source failing makes run() reject', async () => {
    fakeNetwork([[() => true, '<html>error</html>', 500]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    await expect(K.littleSisConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* US nonprofit filings                                                */
/* ------------------------------------------------------------------ */

const filingXml = (officers, { form = '990PF', period = '2023-12-31', family = 'true' } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<Return xmlns="http://www.irs.gov/efile"><ReturnHeader><TaxPeriodEndDt>${period}</TaxPeriodEndDt><ReturnTypeCd>${form}</ReturnTypeCd>
<Filer><USAddress><AddressLine1Txt>1 Private Lane</AddressLine1Txt></USAddress></Filer></ReturnHeader>
<ReturnData><IRS990PF><FamilyOrBusinessRlnInd>${family}</FamilyOrBusinessRlnInd><OfficerDirTrstKeyEmplInfoGrp>
${officers.map(([n, t]) => `<OfficerDirTrstKeyEmplGrp><PersonNm>${n}</PersonNm><USAddress><AddressLine1Txt>1 Private Lane</AddressLine1Txt></USAddress><TitleTxt>${t}</TitleTxt><CompensationAmt>0</CompensationAmt></OfficerDirTrstKeyEmplGrp>`).join('')}
</OfficerDirTrstKeyEmplInfoGrp></IRS990PF></ReturnData></Return>`;

const ORG = (ein, name, objectId) => [
  [(u) => u.endsWith(`/api/v2/organizations/${ein}.json`), { organization: { ein, name, address: '1 Private Lane', latest_object_id: objectId } }],
];
function nonprofitRoutes(orgs = [{ ein: 111, name: 'Roe Family Foundation' }, { ein: 222, name: 'Jane Roe Foundation' }, { ein: 333, name: 'Roeback Charity Foundation' }]) {
  return [
    [(u) => u.includes('/api/v2/search.json'), { total_results: orgs.length, organizations: orgs }],
    ...ORG(111, 'Roe Family Foundation', '202401111'),
    ...ORG(222, 'Jane Roe Foundation', '202403333'),
    ...ORG(222, 'Acme Robotics Foundation', '202403333'),
    [(u) => u.endsWith('/202401111_public.xml'), filingXml([['JANE ROE', 'PRESIDENT'], ['PETER ROE', 'TREASURER'], ['ALICE SMITH', 'DIRECTOR']])],
    [(u) => u.endsWith('/202403333_public.xml'), filingXml([['JANE ROE', 'TRUSTEE']], { form: '990', family: 'false' })],
  ];
}

describe('nonprofitFilingsConnector', () => {
  test('subject: foundations named after the person or family, read through the organisation search and the filings only', async () => {
    const calls = fakeNetwork(nonprofitRoutes());
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.nonprofitFilingsConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    // the people search page is never asked for (the site asks automated visitors not to use it)
    expect(calls.some((u) => u.includes('name_search'))).toBe(false);
    expect(calls[0]).toContain('/api/v2/search.json?q=%22roe%22%20foundation');
    expect(calls.length).toBeLessThanOrEqual(5);
    // the person's own foundation is read first; Roeback is not the surname
    expect(calls.some((u) => u.includes('/organizations/333.json'))).toBe(false);

    const family = r.findings.find((f) => f.category === 'related');
    expect(family).toMatchObject({ title: 'Family foundation: Jane Roe listed as president of Roe Family Foundation (2023 filing)', severity: 'low', match: 'possible', url: 'https://projects.propublica.org/nonprofits/organizations/111', date: '2023' });
    expect(family.quote).toContain('lists JANE ROE, PRESIDENT');

    const own = r.findings.find((f) => f.category === 'career');
    expect(own).toMatchObject({ title: 'Jane Roe: trustee of Jane Roe Foundation, a US nonprofit (2023 filing)', severity: 'info' });
    expect(own.data.orgSharesSurname).toBe(true);

    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/Peter Roe \(Treasurer\) shares a surname with the subject: unconfirmed/);
    expect(r.threads.some((t) => t.kind === 'relative')).toBe(false);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/Private Lane/);
  });

  test('subject: a foundation whose filing does not list the person -> nothing', async () => {
    fakeNetwork([
      [(u) => u.includes('/api/v2/search.json'), { total_results: 1, organizations: [{ ein: 444, name: 'Roe County Foundation' }] }],
      ...ORG(444, 'Roe County Foundation', '202404444'),
      [(u) => u.endsWith('/202404444_public.xml'), filingXml([['PETER ROE', 'DIRECTOR']])],
    ]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    expect(await K.nonprofitFilingsConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
  });

  test('company: the company\'s own foundation, kept only when the subject is an officer', async () => {
    const calls = fakeNetwork([
      [(u) => u.includes('/api/v2/search.json'), { total_results: 1, organizations: [{ ein: 222, name: 'Acme Robotics Foundation' }] }],
      ...nonprofitRoutes([]),
    ]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.nonprofitFilingsConnector.run({ kind: 'company', value: 'Acme Robotics' }, ctxFor(subject));
    expect(calls).toHaveLength(3);
    expect(r.findings).toHaveLength(1);
    // R3: the company's own foundation is a structural tie: 'likely', never more
    expect(r.findings[0]).toMatchObject({ match: 'likely', url: 'https://projects.propublica.org/nonprofits/organizations/222' });
    expect(JSON.stringify(r)).not.toContain('Private Lane');
  });

  test('company: no organisation found (the search answers 404) -> nothing', async () => {
    fakeNetwork([]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    expect(await K.nonprofitFilingsConnector.run({ kind: 'company', value: 'Acme Robotics' }, ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
  });

  test('the source failing makes run() reject', async () => {
    fakeNetwork([[() => true, 'error', 500]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    await expect(K.nonprofitFilingsConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject))).rejects.toThrow();
  });
});
