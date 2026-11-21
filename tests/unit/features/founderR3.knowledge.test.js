/**
 * Round 3 fixes in knowledge.js (Wikidata, Wikipedia, LittleSis, US nonprofit filings): namesakes whose
 * organisation only begins with the company's word, the company-linked Wikidata search, the properties that were
 * never read, the LittleSis summary, cache and coverage notes, and the structured fields the profile reads.
 * Fixtures are small cuts shaped like the real responses (fictional people).
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addCompanyAlias } = require('../../../src/server/founder/identity');
const K = require('../../../src/server/founder/sources/knowledge');
const { knownCompanyOf, namesakeOrgs } = require('../../../src/server/founder/sources/scholar');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 30000, known: () => ({}) });
const ok = (url, body, status = 200) => ({ status, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
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
afterEach(() => { setTransport(); K.__resetKnowledgeForTests(); });

const E = 'http://www.wikidata.org/entity/';
const ST = 'http://www.wikidata.org/entity/statement/';
const sparqlBody = (rows) => ({ head: { vars: [] }, results: { bindings: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { type: 'literal', value: String(v) }]))) } });
const sparqlOf = (url) => decodeURIComponent(new URL(url).searchParams.get('query') || '');
const isSparql = (needle) => (u) => u.startsWith('https://query.wikidata.org/') && sparqlOf(u).includes(needle);
const cand = (qid, label, desc, extra = {}) => ({ c: `${E}${qid}`, cLabel: label, cDesc: desc, sitelinks: 1, aliases: '', employers: '', orgs: '', schools: '', ...extra });

/* ------------------------------------------------ organisation labels */

describe('a company word at the start of a longer organisation name is not the company', () => {
  test('knownCompanyOf compares names, not prefixes', () => {
    const mercury = createSubject({ name: 'John Smith', company: 'Mercury' });
    expect(knownCompanyOf(mercury, 'Mercury Records')).toBeNull();
    expect(knownCompanyOf(mercury, 'Mercury Insurance Group')).toBeNull();
    expect(knownCompanyOf(mercury, 'Mercury Public Affairs')).toBeNull();
    expect(knownCompanyOf(mercury, 'Mercury, Inc.')).not.toBeNull();
    const nikola = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    expect(knownCompanyOf(nikola, 'Nikola Corporation')).not.toBeNull();
    expect(knownCompanyOf(nikola, 'Nikola Motor Company')).not.toBeNull();
    expect(knownCompanyOf(nikola, 'Nikola Tesla Institute')).toBeNull();
    expect(namesakeOrgs(nikola, ['Nikola Tesla Institute', 'Nikola Corporation', 'University of Utah'])).toEqual(['Nikola Tesla Institute']);
  });

  test('a learned legal name counts as the company; a bare prefix still does not', () => {
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    expect(knownCompanyOf(s, 'Ramp Business Corporation')).toBeNull();
    addCompanyAlias(s, { company: 'Ramp', alias: 'Ramp Business Corporation', origin: 'form-d-1' });
    expect(knownCompanyOf(s, 'Ramp Business Corporation')).not.toBeNull();
    expect(knownCompanyOf(s, 'Ramp Network')).toBeNull();
  });

  test('Wikidata: a record executive at Mercury Records is not picked for Mercury', () => {
    const subject = createSubject({ name: 'John Smith', company: 'Mercury' });
    const out = K.chooseCandidate(subject, [
      { qid: 'Q1', label: 'John Smith', description: 'American record executive', aliases: [], employers: ['Mercury Records'], orgs: [], schools: [], sitelinks: 5 },
      { qid: 'Q2', label: 'John Smith', description: 'British footballer', aliases: [], employers: [], orgs: [], schools: [], sitelinks: 3 },
    ]);
    expect(out.status).toBe('unclear');
  });

  test('Wikidata: an entry tied by its exact company name is still picked', () => {
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const out = K.chooseCandidate(subject, [
      { qid: 'Q1', label: 'Trevor Milton', description: 'American businessman', aliases: [], employers: [], orgs: ['Nikola Corporation'], schools: [], sitelinks: 5 },
      { qid: 'Q2', label: 'Trevor Milton', description: 'Canadian swimmer', aliases: [], employers: [], orgs: ['Nikola Tesla Institute'], schools: [], sitelinks: 3 },
    ]);
    expect(out).toMatchObject({ status: 'resolved', by: 'context', entity: { qid: 'Q1' } });
  });
});

/* ------------------------------------------------ Wikidata search */

describe('Wikidata search beyond the first page of namesakes', () => {
  test('people the graph ties to the company are added to the name search; 20 are read, and the note says how many exist', async () => {
    const calls = fakeNetwork([
      [(u) => u.includes('action=query&list=search'), { query: { searchinfo: { totalhits: 1330 }, search: [{ title: 'Q200' }] } }],
      [(u) => u.includes('action=wbsearchentities'), { search: [{ id: 'Q300', label: 'Acme Robotics' }, { id: 'Q301', label: 'Acme Robotics Records' }] }],
      [isSparql('VALUES ?org'), sparqlBody([{ c: `${E}Q100`, l: 'Jane Roe' }, { c: `${E}Q101`, l: 'Janet Roe' }])],
      [isSparql('?aliases'), (u) => sparqlBody([
        cand('Q100', 'Jane Roe', 'American engineer', { orgs: 'Acme Robotics' }),
        cand('Q200', 'Jane Roe', 'British painter'),
      ].filter((c) => sparqlOf(u).includes(`wd:${c.c.slice(E.length)} `) || sparqlOf(u).includes(`wd:${c.c.slice(E.length)} }`)))],
      [isSparql("'educated at'"), sparqlBody([])],
    ]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'profile' }, ctxFor(subject));
    expect(calls[0]).toContain('srlimit=20');
    // only the company itself was used to find linked people, not "Acme Robotics Records"
    expect(sparqlOf(calls.find(isSparql('VALUES ?org')))).toContain('wd:Q300 }');
    const identity = r.findings.find((f) => f.category === 'identity');
    expect(identity).toMatchObject({ url: 'https://www.wikidata.org/wiki/Q100', match: 'confirmed' });
  });

  test('a note about namesakes says that more people exist than were read', async () => {
    fakeNetwork([
      [(u) => u.includes('action=query&list=search'), { query: { searchinfo: { totalhits: 1330 }, search: [{ title: 'Q200' }, { title: 'Q201' }] } }],
      [isSparql('?aliases'), sparqlBody([cand('Q200', 'John Smith', 'British painter'), cand('Q201', 'John Smith', 'Welsh poet')])],
    ]);
    const subject = createSubject({ name: 'John Smith', company: 'Initech' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'John Smith', template: 'profile' }, ctxFor(subject));
    expect(r.findings).toEqual([]);
    expect(r.notes[0]).toMatch(/Wikidata lists 1330 people under this name; the first 2 and those tied to the company were read/);
  });

  test('the only person with the name is used when their article pairs them with the company', async () => {
    fakeNetwork([
      [(u) => u.includes('action=query&list=search'), { query: { search: [{ title: 'Q100' }] } }],
      [isSparql('?aliases'), sparqlBody([cand('Q100', 'Jane Roe', 'American entrepreneur', { article: 'https://en.wikipedia.org/wiki/Jane_Roe' })])],
      [(u) => u.startsWith('https://en.wikipedia.org/w/api.php'), { query: { pages: [{ title: 'Jane Roe', extract: 'Jane Roe is an American entrepreneur. She founded Acme Robotics in 2015 and is its chief executive.\n\n== Personal life ==\nRoe lives in Ohio.' }] } }],
      [isSparql("'educated at'"), sparqlBody([])],
    ]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'profile' }, ctxFor(subject));
    expect(r.findings.find((f) => f.category === 'identity')).toBeTruthy();
    expect(r.notes).toEqual([]);
  });

  test('the only person with the name stays unused when nothing pairs them with the company', async () => {
    fakeNetwork([
      [(u) => u.includes('action=query&list=search'), { query: { search: [{ title: 'Q100' }] } }],
      [isSparql('?aliases'), sparqlBody([cand('Q100', 'Jane Roe', 'American entrepreneur', { article: 'https://en.wikipedia.org/wiki/Jane_Roe' })])],
      [(u) => u.startsWith('https://en.wikipedia.org/w/api.php'), { query: { pages: [{ title: 'Jane Roe', extract: 'Jane Roe is an American entrepreneur and author.' }] } }],
    ]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'profile' }, ctxFor(subject));
    expect(r.findings).toEqual([]);
    expect(r.notes[0]).toMatch(/None was used/);
  });
});

/* ------------------------------------------------ Wikidata profile */

const MILTON = [cand('Q100', 'Trevor Milton', 'American businessman', { orgs: 'Nikola Corporation', aliases: 'Trevor R. Milton' })];
const MILTON_PROFILE = [
  { kind: 'founded by', st: `${ST}Q300-a`, val: `${E}Q300`, valLabel: 'Nikola Motor Company', start: '2014-01-01T00:00:00Z', valSite: 'https://www.nikolamotor.com/' },
  { kind: 'educated at', st: `${ST}Q100-b`, val: `${E}Q10`, valLabel: 'Utah State University', degreeLabel: 'Bachelor of Science', majorLabel: 'business', start: '2000-01-01T00:00:00Z', end: '2002-01-01T00:00:00Z' },
  { kind: 'convicted of', st: `${ST}Q100-c`, val: `${E}Q20`, valLabel: 'securities fraud', pit: '2022-10-14T00:00:00Z' },
  { kind: 'significant event', st: `${ST}Q100-d`, val: `${E}Q30`, valLabel: 'presidential pardon', pit: '2025-03-27T00:00:00Z' },
  { kind: 'award received', st: `${ST}Q100-e`, val: `${E}Q40`, valLabel: 'Utah Entrepreneur of the Year', pit: '2018-01-01T00:00:00Z' },
  { kind: 'member of', st: `${ST}Q100-f`, val: `${E}Q50`, valLabel: 'Utah Technology Council' },
  { kind: 'ORCID iD', st: `${ST}Q100-g`, val: '0000-0002-1825-0097' },
  { kind: 'SEC CIK', st: `${ST}Q100-h`, val: '1731289' },
  { kind: 'birth name', st: `${ST}Q100-i`, val: 'Trevor Robert Jones' },
];

describe('Wikidata properties that were never read, and the structured fields', () => {
  function miltonRoutes() {
    return [
      [(u) => u.includes('action=query&list=search'), { query: { search: [{ title: 'Q100' }] } }],
      [isSparql('?aliases'), sparqlBody(MILTON)],
      [isSparql("'educated at'"), sparqlBody(MILTON_PROFILE)],
    ];
  }

  test('awards, memberships, ORCID iD, SEC filer id and other names; a conviction shows its pardon', async () => {
    fakeNetwork(miltonRoutes());
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'profile' }, ctxFor(subject));
    const identity = r.findings.find((f) => f.category === 'identity');
    expect(identity.data).toMatchObject({ orcid: '0000-0002-1825-0097', secCik: '0001731289', otherNames: ['Trevor Robert Jones'] });
    const conviction = r.findings.find((f) => f.category === 'litigation');
    expect(conviction.title).toBe('Trevor Milton: convicted of securities fraud (2022-10-14); pardoned (2025-03-27)');
    expect(conviction.data.pardon).toEqual({ text: 'pardoned', year: 2025 });
    expect(r.findings.find((f) => f.data?.awards)?.data.awards).toEqual([{ text: 'Utah Entrepreneur of the Year', year: 2018 }]);
    expect(r.findings.find((f) => f.data?.memberships)?.data.memberships).toEqual([{ org: 'Utah Technology Council', from: null, to: null }]);
    expect(r.threads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'url', value: 'https://orcid.org/0000-0002-1825-0097', trusted: true })]));
  });

  test('structured fields: education with degree, field and years; founded; the legal name and domain are learned', async () => {
    fakeNetwork(miltonRoutes());
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'profile' }, ctxFor(subject));
    expect(r.findings.find((f) => f.category === 'education').data.education).toEqual([{ school: 'Utah State University', degree: 'Bachelor of Science', field: 'business', from: 2000, to: 2002 }]);
    expect(r.findings.find((f) => f.data?.founded).data.founded).toEqual([{ org: 'Nikola Motor Company', year: 2014 }]);
    const aliases = [...subject.anchors.aliases.values()].map((a) => a.value);
    expect(aliases).toEqual(expect.arrayContaining(['Nikola Motor Company', 'nikolamotor.com']));
  });

  test('an entry resolved by name only gives no SEC filer id, no other names and an untrusted ORCID link', async () => {
    fakeNetwork(miltonRoutes());
    const subject = createSubject({ name: 'Trevor Milton' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'profile' }, ctxFor(subject));
    const identity = r.findings.find((f) => f.category === 'identity');
    expect(identity.match).toBe('possible');
    expect(identity.data.secCik).toBeUndefined();
    expect(identity.data.otherNames).toBeUndefined();
    expect(r.threads.find((t) => t.value.includes('orcid.org'))?.trusted).toBe(false);
  });

  test('a namesake employer that only begins with the company word does not confirm a record', async () => {
    fakeNetwork([
      [(u) => u.includes('action=query&list=search'), { query: { search: [{ title: 'Q100' }] } }],
      [isSparql('?aliases'), sparqlBody([cand('Q100', 'John Smith', 'American engineer', { employers: 'Mercury Records', schools: 'Stanford University' })])],
      [isSparql("'educated at'"), sparqlBody([{ kind: 'employer', st: `${ST}Q100-a`, val: `${E}Q9`, valLabel: 'Mercury Records' }])],
    ]);
    const subject = createSubject({ name: 'John Smith', company: 'Mercury' });
    const { addAnchor } = require('../../../src/server/founder/identity');
    addAnchor(subject, 'schools', 'Stanford University');
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'John Smith', template: 'profile' }, ctxFor(subject));
    for (const f of r.findings) expect(f.match).not.toBe('confirmed');
  });
});

/* ------------------------------------------------ LittleSis */

const lsEntity = (id, kind, name, attrs = {}) => ({ type: 'entities', id, attributes: { id, name, blurb: '', summary: '', primary_ext: kind === 'person' ? 'Person' : 'Org', types: kind === 'person' ? ['Person'] : ['Organization'], aliases: [name], ...attrs }, links: { self: `https://littlesis.org/entities/${id}-${name.replace(/ /g, '_')}` } });
const link = (kind, id, name) => `https://littlesis.org/${kind}/${id}-${name.replace(/ /g, '_')}`;
const lsRel = (id, category, [k1, id1, n1], [k2, id2, n2], attrs = {}) => ({
  type: 'relationships', id,
  attributes: { id, entity1_id: id1, entity2_id: id2, category_id: category, description1: null, description2: null, start_date: null, end_date: null, is_current: null, description: `${n1}  and  ${n2}`, category_attributes: null, ...attrs },
  self: `https://littlesis.org/relationships/${id}`, entity: link(k1, id1, n1), related: link(k2, id2, n2),
});
const lsData = (data) => ({ meta: { currentPage: 1, pageCount: 1 }, data });

describe('LittleSis', () => {
  test('company: an entry that only begins with the company word is not read, and there is no first-result fallback', async () => {
    const calls = fakeNetwork([
      [(u) => u.includes('/api/entities/search?q=Mercury'), lsData([lsEntity(50, 'org', 'Mercury Public Affairs')])],
      [(u) => u.endsWith('/api/entities/50/relationships'), lsData([lsRel(1, 1, ['person', 9, 'John Smith'], ['org', 50, 'Mercury Public Affairs'], { description1: 'Partner', description: 'John Smith  had a position (Partner) at  Mercury Public Affairs' })])],
    ]);
    const subject = createSubject({ name: 'John Smith', company: 'Mercury' });
    const r = await K.littleSisConnector.run({ kind: 'company', value: 'Mercury' }, ctxFor(subject));
    expect(r.findings).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('company: the company\'s own entry gives a "likely" record with the role as a structured field', async () => {
    fakeNetwork([
      [(u) => u.includes('/api/entities/search?q=Mercury'), lsData([lsEntity(51, 'org', 'Mercury Public Affairs'), lsEntity(50, 'org', 'Mercury', { aliases: ['Mercury Technologies, Inc.'] })])],
      [(u) => u.endsWith('/api/entities/50/relationships'), lsData([lsRel(1, 1, ['person', 9, 'John Smith'], ['org', 50, 'Mercury'], { description1: 'CEO', start_date: '2017-00-00', description: 'John Smith  had a position (CEO) at  Mercury' })])],
    ]);
    const subject = createSubject({ name: 'John Smith', company: 'Mercury' });
    const r = await K.littleSisConnector.run({ kind: 'company', value: 'Mercury' }, ctxFor(subject));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ match: 'likely', matchFixed: true });
    expect(r.findings[0].data.employers).toEqual([{ org: 'Mercury', title: 'CEO', from: 2017, to: null }]);
  });

  function subjectRoutes(summary = '') {
    return [
      [(u) => u.includes('/api/entities/search?q=Jane%20Roe'), lsData([
        lsEntity(11, 'person', 'Jane Roe', { blurb: 'Founder and CEO, Acme Robotics', types: ['Person', 'Business Person'], summary }),
        lsEntity(12, 'person', 'Jane Roe', { blurb: 'Painter' }),
        lsEntity(13, 'person', 'Jane Roe', { blurb: 'Poet' }),
      ])],
      [(u) => u.endsWith('/api/entities/11/relationships'), lsData([lsRel(1001, 1, ['person', 11, 'Jane Roe'], ['org', 50, 'Acme Robotics'], { description1: 'CEO', description: 'Jane Roe  had a position (CEO) at  Acme Robotics' })])],
      [(u) => /\/api\/entities\/1[23]\/relationships$/.test(u), lsData([])],
    ];
  }

  test('the curated summary reaches the report: its matter sentences as records, private sentences left out', async () => {
    fakeNetwork(subjectRoutes('Jane Roe founded Acme Robotics in 2015. She was born on 3 March 1984 in Lyon. In 2021 the SEC charged Roe with massive fraud. She has two children.'));
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.littleSisConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    const matter = r.findings.find((f) => f.category === 'litigation');
    expect(matter).toBeTruthy();
    expect(matter.quote).toMatch(/SEC charged Roe with massive fraud/);
    expect(matter.url).toMatch(/^https:\/\/littlesis\.org\/entities\/11-Jane_Roe#:~:text=/);
    const dump = JSON.stringify(r);
    expect(dump).not.toMatch(/1984|Lyon|two children/);
    expect(r.findings.find((f) => f.category === 'identity').quote).toMatch(/founded Acme Robotics in 2015/);
  });

  test('a decided first entry: the second is not read; answers are kept so a re-run asks for nothing again', async () => {
    const calls = fakeNetwork(subjectRoutes());
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    await K.littleSisConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    expect(calls.some((u) => u.endsWith('/api/entities/12/relationships'))).toBe(false);
    const before = calls.length;
    await K.littleSisConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    expect(calls).toHaveLength(before);
    expect(K.littleSisConnector.timeoutMs).toBeGreaterThanOrEqual(45000);
  });

  test('the note says which entries were read when not all were', async () => {
    fakeNetwork(subjectRoutes());
    const subject = createSubject({ name: 'Jane Roe', company: 'Initech' });
    const r = await K.littleSisConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    expect(r.notes[0]).toMatch(/LittleSis lists 3 people named Jane Roe \(the 2 entries that fit best on their own descriptions were read: .*\), but neither mentions Initech, and nor do the descriptions of the others/);
    expect(r.notes[0]).not.toMatch(/nothing in those entries/);
  });
});

/* ------------------------------------------------ US nonprofit filings */

describe('US nonprofit filings: the company\'s own foundation', () => {
  test('a foundation that only contains the company word is not the company\'s', () => {
    const subject = createSubject({ name: 'John Smith', company: 'Mercury' });
    expect(K.companyFoundation(subject, 'Mercury', 'Mercury Foundation')).toBe(true);
    expect(K.companyFoundation(subject, 'Mercury', 'Mercury Foundation, Inc.')).toBe(true);
    expect(K.companyFoundation(subject, 'Mercury', 'Freddie Mercury Foundation')).toBe(false);
    expect(K.companyFoundation(subject, 'Mercury', 'Mercury Marine Employees Foundation')).toBe(false);
  });

  test('company task: a namesake foundation is never read', async () => {
    const calls = fakeNetwork([[(u) => u.includes('/api/v2/search.json'), { organizations: [{ ein: 9, name: 'Mercury Marine Employees Foundation' }] }]]);
    const subject = createSubject({ name: 'John Smith', company: 'Mercury' });
    const r = await K.nonprofitFilingsConnector.run({ kind: 'company', value: 'Mercury' }, ctxFor(subject));
    expect(r).toEqual({ findings: [], threads: [], notes: [] });
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------ Wikipedia company article */

describe('Wikipedia company article: trusted only on a sentence that pairs the person with the company', () => {
  const page = (extract) => ({ query: { pages: [{ title: 'Acme Robotics', extract }] } });
  const run = async (extract) => {
    fakeNetwork([[(u) => u.startsWith('https://en.wikipedia.org/w/api.php'), page(extract)]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    return K.wikipediaConnector.run({ kind: 'company', value: 'Acme Robotics', tie: 'primary' }, ctxFor(subject));
  };

  test('a sentence naming the person without the company: their associates are not trusted', async () => {
    const r = await run('Acme Robotics is a maker of toys. Jane Roe, a painter, exhibited with co-founder John Doe in 1990.');
    expect(r.threads.length).toBeGreaterThan(0);
    expect(r.threads.every((t) => t.trusted === false)).toBe(true);
  });

  test('a sentence pairing the person with the company: trusted', async () => {
    const r = await run('Acme Robotics was founded in 2015 by Jane Roe and co-founder John Doe.');
    expect(r.threads.find((t) => t.value === 'John Doe')?.trusted).toBe(true);
  });
});
