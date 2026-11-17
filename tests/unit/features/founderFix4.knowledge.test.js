/**
 * Round-4 fixes to the knowledge connectors (sources/knowledge.js), from grading real reports:
 *   - item 1: a Wikidata entry tied to the subject records their CEO tenures (and a sole founder's role) with
 *     addRoleAnchor, so a later "<Company> CEO ..." record dated inside the tenure grades 'likely';
 *   - item 4 (this file's part): a recorded conviction registers an event anchor, and the counterparties a
 *     confirmed article names (investors, acquirers, parties to a deal) become 'encyclopedia' anchors;
 *   - item 8 (this file's part): the company's French article is read for shareholders and advisers;
 *   - item 16 (this file's part): a Wikipedia passage is dated by the first year of its first sentence, and a
 *     Wikidata role that starts before the company was founded is flagged, not dated.
 * Fixtures are fictional people.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const identity = require('../../../src/server/founder/identity');
const { setTransport } = require('../../../src/server/founder/http');
const K = require('../../../src/server/founder/sources/knowledge');

const { createSubject, matchSubject } = identity;
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

/* ------------------------------------------------------------------ */
/* Wikidata: tenures, founding-date slips, conviction events           */
/* ------------------------------------------------------------------ */

const E = 'http://www.wikidata.org/entity/';
const ST = 'http://www.wikidata.org/entity/statement/';
const sparqlBody = (rows) => ({ head: { vars: [] }, results: { bindings: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { type: 'literal', value: String(v) }]))) } });
const sparqlOf = (url) => decodeURIComponent(new URL(url).searchParams.get('query') || '');

const CANDIDATES = [{ c: `${E}Q100`, cLabel: 'Jane Roe', cDesc: 'American businesswoman, founder of Acme Robotics', sitelinks: 3, aliases: '', employers: 'Globex', orgs: 'Acme Robotics', schools: '' }];
const PROFILE = [
  // chief executive from 2013-05, two years before the company was founded (2015)
  { kind: 'chief executive officer', st: `${ST}Q300-ceo`, val: `${E}Q300`, valLabel: 'Acme Robotics', start: '2013-05-01T00:00:00Z', end: '2020-09-24T00:00:00Z', inception: '2015-01-01T00:00:00Z' },
  // sole founder of Acme Robotics
  { kind: 'founded by', st: `${ST}Q300-fnd`, val: `${E}Q300`, valLabel: 'Acme Robotics', inception: '2015-01-01T00:00:00Z' },
  // one of two founders of Globex: no founder tenure
  { kind: 'founded by', st: `${ST}Q301-fnd`, val: `${E}Q301`, valLabel: 'Globex', inception: '2005-03-01T00:00:00Z', otherFounder: `${E}Q999` },
  // position held: chief executive officer of Initech
  { kind: 'position held', st: `${ST}Q100-pos`, val: `${E}Q484876`, valLabel: 'chief executive officer', ofLabel: 'Initech', start: '2021-02-01T00:00:00Z' },
  { kind: 'convicted of', st: `${ST}Q100-cnv`, val: `${E}Q28813`, valLabel: 'wire fraud', pit: '2022-11-18T00:00:00Z' },
];
const wikidataRoutes = (candidates = CANDIDATES, profile = PROFILE) => [
  [(u) => u.startsWith('https://www.wikidata.org/w/api.php'), { query: { search: [{ title: 'Q100' }] } }],
  [(u) => u.startsWith('https://query.wikidata.org/') && sparqlOf(u).includes('?aliases'), sparqlBody(candidates)],
  [(u) => u.startsWith('https://query.wikidata.org/') && sparqlOf(u).includes("'educated at'"), sparqlBody(profile)],
];

describe('wikidata: role tenures for the grader', () => {
  test('the profile lookup asks for founding dates and other founders', async () => {
    const calls = fakeNetwork(wikidataRoutes());
    await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'profile' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Acme Robotics' })));
    const q = sparqlOf(calls.find((u) => sparqlOf(u).includes("'educated at'")));
    expect(q).toMatch(/\?inception/);
    expect(q).toMatch(/wdt:P571/);
    expect(q).toMatch(/\?otherFounder/);
  });

  test('a confirmed entry records CEO tenures (from no earlier than the founding) and a sole founder', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    fakeNetwork(wikidataRoutes());
    await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'profile' }, ctxFor(subject));
    const roles = [...subject.anchors.roles.values()];
    expect(roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ org: 'Acme Robotics', role: 'ceo', from: '2015', to: '2020-09-24' }),
      expect.objectContaining({ org: 'Initech', role: 'ceo', from: '2021-02' }),
      expect.objectContaining({ org: 'Acme Robotics', role: 'founder', from: '2015' }),
    ]));
    expect(roles.some((r) => r.org === 'Globex')).toBe(false);
    expect(roles.every((r) => r.origin && r.origin.startsWith('wikidata-'))).toBe(true);
    // "<Company> CEO" with no name, dated inside the tenure: likely; after it: nothing
    expect(matchSubject(subject, 'Acme Robotics CEO gives back $5.9M from trademark deal', { date: '2019-07-01' }).level).toBe('none'); // no name: never tied
    expect(matchSubject(subject, 'Acme Robotics CEO gives back $5.9M from trademark deal', { date: '2023-07-01' }).level).toBe('none');
  });

  test('tenuresOf: a founder role only when the subject is the one founder', () => {
    const rows = PROFILE;
    const acme = { name: 'Acme Robotics', rows: rows.filter((r) => r.val === `${E}Q300`) };
    const globex = { name: 'Globex', rows: rows.filter((r) => r.val === `${E}Q301`) };
    expect(K.tenuresOf(acme, rows, 'Q100', '2015')).toEqual(expect.arrayContaining([{ org: 'Acme Robotics', role: 'founder', from: '2015', to: '' }]));
    expect(K.tenuresOf(globex, rows, 'Q100', '2005-03').filter((t) => t.role === 'founder')).toEqual([]);
  });

  test('an entry matched by name only records no tenure and no event', async () => {
    const subject = createSubject({ name: 'Jane Roe' });
    fakeNetwork(wikidataRoutes());
    await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'profile' }, ctxFor(subject));
    expect(subject.anchors.roles.size).toBe(0);
    expect(subject.anchors.events.size).toBe(0);
  });

  test('a role starting before the company was founded is flagged and kept off the timeline', async () => {
    fakeNetwork(wikidataRoutes());
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'profile' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Acme Robotics' })));
    const acme = r.findings.find((f) => f.category === 'career' && /at Acme Robotics/.test(f.title));
    expect(acme.date).toBeNull();
    expect(acme.data.dateConflict).toMatch(/2013-05 is earlier than the founding of Acme Robotics \(2015\)/);
    const globex = r.findings.find((f) => f.category === 'career' && /at Globex/.test(f.title));
    expect(globex.data?.dateConflict).toBeUndefined();
  });

  test('a recorded conviction registers an event anchor with its date', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    fakeNetwork(wikidataRoutes());
    await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'profile' }, ctxFor(subject));
    expect([...subject.anchors.events.values()]).toEqual([expect.objectContaining({ event: 'conviction', date: '2022-11-18' })]);
    // a later report of the conviction naming her in full is likely; one before it is not raised
    expect(matchSubject(subject, 'Jane Roe was convicted of fraud', { date: '2023-02-01' }).level).toBe('likely');
  });
});

/* ------------------------------------------------------------------ */
/* Wikipedia: passage dates and counterparties                         */
/* ------------------------------------------------------------------ */

const page = (title, extract, over = {}) => ({ query: { pages: [{ title, extract, pageprops: { 'wikibase-shortdesc': 'American businesswoman' }, canonicalurl: `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`, revisions: [{ timestamp: '2026-11-01T10:00:00Z' }], ...over }] } });

describe('wikipedia: a passage is dated by its first sentence', () => {
  test('passageYear takes the first year of the first sentence', () => {
    expect(K.passageYear('Roe resigned as chair in 2020 after a short-seller report. She was indicted in 2021. She was sentenced in 2023 and pardoned in 2025.')).toBe('2020');
    expect(K.passageYear('Roe was the subject of a short-seller report. She was indicted in 2021.')).toBe('2021');
    expect(K.passageYear('Roe was the subject of a report. She was indicted in 2021 and sentenced in 2023.')).toBeNull();
  });

  test('the legal record of the article carries that year', async () => {
    const extract = [
      'Jane Roe is an American businesswoman who founded Acme Robotics.',
      '',
      '== Legal issues ==',
      'In September 2020 Roe resigned from Acme Robotics after fraud allegations. She was indicted on fraud charges in 2021. She was sentenced to four years in prison in 2024.',
    ].join('\n');
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Jane Roe', extract)]]);
    const r = await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Acme Robotics' })));
    const legal = r.findings.find((f) => f.category === 'litigation');
    expect(legal.date).toMatch(/^2020/);
  });
});

describe('wikipedia: counterparties become encyclopedia anchors', () => {
  const extract = [
    'Jane Roe is an American businesswoman who founded Acme Robotics.',
    '',
    '== Career ==',
    'In 2017 Acme Robotics raised $300 million in a round led by Nimbus Capital. Roe later sold part of her stake to Orbital Group.',
    'In 2019 she reached a settlement with Masayoshi Tanaka over the deal. The Securities and Exchange Commission sued Roe in 2022.',
  ].join('\n');

  const related = (subject) => [...subject.anchors.related.values()];

  test('investors, buyers and parties to a settlement, never regulators or the subject; likely at most', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Jane Roe', extract)]]);
    await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe' }, ctxFor(subject));
    const byName = Object.fromEntries(related(subject).map((a) => [a.value, a]));
    expect(byName['Nimbus Capital']).toEqual(expect.objectContaining({ as: 'companies' }));
    expect(byName['Orbital Group']).toEqual(expect.objectContaining({ as: 'companies' }));
    expect(byName['Masayoshi Tanaka']).toEqual(expect.objectContaining({ as: 'people' }));
    expect(Object.keys(byName).some((v) => /Securities|Commission|Roe|Acme/.test(v))).toBe(false);
    expect(related(subject).every((a) => /^encyclopedia:wikipedia-/.test(a.origin))).toBe(true);
    // never the subject's own companies
    expect([...subject.anchors.companies.values()].map((a) => a.value)).toEqual(['Acme Robotics']);
    expect(matchSubject(subject, 'Jane Roe and Nimbus Capital near a settlement').level).toBe('likely');
    expect(matchSubject(subject, 'Nimbus Capital raises a new fund').level).toBe('none');
  });

  test('an article not tied to the subject by a known company adds none', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Zeta Labs' });
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page('Jane Roe', extract)]]);
    await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe' }, ctxFor(subject));
    expect(related(subject)).toEqual([]);
  });

  test('counterpartiesFromText ignores the subject\'s own surname', () => {
    const subject = createSubject({ name: 'Jane Roe' });
    expect(K.counterpartiesFromText(subject, 'The company was later acquired by Roe and her partners in 2020.')).toEqual([]);
    // a place describing the person who invested is no counterparty
    expect(K.counterpartiesFromText(subject, 'Roe used a $15 million investment from Brooklyn real estate developer Joel Stone to start it.')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Wikipedia: the company's French article                             */
/* ------------------------------------------------------------------ */

describe('wikipedia: roles stated in the company\'s French article', () => {
  const EN = 'Roe Robotique is a French robot maker founded in 2023 by Thierry Roe and Paul Martin.';
  const FR = [
    'Roe Robotique est une entreprise française fondée en 2023 par Thierry Roe et Paul Martin.',
    '',
    '== Actionnariat ==',
    "Parmi ses soutiens figure Luc Q, ancien secrétaire d'État au numérique, actionnaire et conseiller de Roe Robotique depuis 2023.",
    'Anne Duval, administratrice de Roe Robotique, a quitté le conseil en 2024.',
    "Marc Petit, ministre de l'Industrie, a salué l'entreprise.",
  ].join('\n');
  const routes = (fr = FR) => [
    [(u) => u.startsWith('https://en.wikipedia.org/w/api.php'), page('Roe Robotique', EN)],
    [(u) => u.startsWith('https://fr.wikipedia.org/w/api.php'), page('Roe Robotique', fr)],
  ];

  test('shareholders, advisers and board members, in English', async () => {
    const calls = fakeNetwork(routes());
    const r = await K.wikipediaConnector.run({ kind: 'company', value: 'Roe Robotique', tie: 'primary' }, ctxFor(createSubject({ name: 'Thierry Roe', company: 'Roe Robotique' })));
    expect(calls.some((u) => u.startsWith('https://fr.wikipedia.org/'))).toBe(true);
    const byName = Object.fromEntries(r.threads.map((t) => [t.value, t]));
    expect(byName['Luc Q']).toEqual(expect.objectContaining({ kind: 'associate', role: 'Shareholder and adviser', trusted: true }));
    expect(byName['Anne Duval']).toEqual(expect.objectContaining({ kind: 'associate', role: 'Board member' }));
    expect(byName['Marc Petit']).toBeUndefined();
    expect(r.threads.filter((t) => t.kind === 'relative')).toEqual([]);
  });

  test('a French article that never names the person gives nothing', async () => {
    fakeNetwork(routes(FR.replace(/Thierry Roe/g, 'Jim Doe')));
    const r = await K.wikipediaConnector.run({ kind: 'company', value: 'Roe Robotique', tie: 'primary' }, ctxFor(createSubject({ name: 'Thierry Roe', company: 'Roe Robotique' })));
    expect(r.threads.map((t) => t.value)).not.toContain('Luc Q');
  });

  test('a subject with nothing French reads only the English article', async () => {
    const calls = fakeNetwork(routes());
    await K.wikipediaConnector.run({ kind: 'company', value: 'Acme Robotics', tie: 'primary' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Acme Robotics' })));
    expect(calls.some((u) => u.startsWith('https://fr.wikipedia.org/'))).toBe(false);
  });

  test('the French article failing does not fail the lookup', async () => {
    fakeNetwork([[(u) => u.startsWith('https://en.wikipedia.org/w/api.php'), page('Roe Robotique', EN)], [(u) => u.startsWith('https://fr.wikipedia.org/'), 'down', 503]]);
    await expect(K.wikipediaConnector.run({ kind: 'company', value: 'Roe Robotique', tie: 'primary' }, ctxFor(createSubject({ name: 'Thierry Roe', company: 'Roe Robotique' })))).resolves.toEqual(expect.objectContaining({ findings: [] }));
  });
});
