/**
 * @jest-environment node
 *
 * Round 4 fixes in the people sources (knowledge.js, presenceMore.js), review of 2026-11-21:
 *   - sources-people-wp-company-injection: a company article's "the company" is never read as the typed company,
 *     and an article about an ordinary-word company ("Mercury") must match a fact already known before its
 *     people become trusted leads;
 *   - sources-people-wd-article-resolve-possible: a Wikidata entry resolved through its Wikipedia article carries
 *     the article sentence that names the company, so its records are 'likely' (never confirmed), and a lead
 *     that gives only the surname still resolves it;
 *   - sources-people-hf-same-handle-likely: a Hugging Face account reached only through the same handle on
 *     another service is 'possible' unless something beyond the name ties it.
 * No network: small fixtures shaped like the real answers, invented people.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, addRoleAnchor } = require('../../../src/server/founder/identity');
const K = require('../../../src/server/founder/sources/knowledge');
const { huggingFaceConnector, __resetPresenceMoreForTests } = require('../../../src/server/founder/sources/presenceMore');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 30000, known: () => ({}) });
const ok = (url, body, status = 200) => ({ status, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function fakeNetwork(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    for (const [test, body, status] of routes) {
      if (test(url)) return ok(url, typeof body === 'function' ? body(url) : body, status || 200);
    }
    return ok(url, '{"error":"not found"}', 404);
  });
  return calls;
}
beforeEach(() => __resetPresenceMoreForTests());
afterEach(() => { setTransport(); K.__resetKnowledgeForTests(); });

const E = 'http://www.wikidata.org/entity/';
const sparqlBody = (rows) => ({ head: { vars: [] }, results: { bindings: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { type: 'literal', value: String(v) }]))) } });
const sparqlOf = (url) => decodeURIComponent(new URL(url).searchParams.get('query') || '');
const isSparql = (needle) => (u) => u.startsWith('https://query.wikidata.org/') && sparqlOf(u).includes(needle);
const cand = (qid, label, desc, extra = {}) => ({ c: `${E}${qid}`, cLabel: label, cDesc: desc, sitelinks: 1, aliases: '', employers: '', orgs: '', schools: '', ...extra });

/* ------------------------------------------------ Wikipedia company article */

describe('Wikipedia company article: "the company" is not the typed company', () => {
  const run = async (subject, company, title, extract) => {
    fakeNetwork([[(u) => u.startsWith('https://en.wikipedia.org/w/api.php'), { query: { pages: [{ title, extract }] } }]]);
    return K.wikipediaConnector.run({ kind: 'company', value: company, tie: 'primary' }, ctxFor(subject));
  };

  test('a namesake who "became the company\'s managing director" does not make co-workers trusted', async () => {
    const subject = createSubject({ name: 'Jane Doe', company: 'Mercury' });
    const r = await run(subject, 'Mercury', 'Mercury (company)', 'Mercury is a record label founded in 1962. Jane Doe became the company\'s managing director, working alongside co-founder Robert Vance.');
    const vance = r.threads.find((t) => t.value === 'Robert Vance');
    expect(vance).toBeTruthy();
    expect(vance.trusted).toBe(false);
  });

  test('the same with a distinctive company name: "the firm" is not read as it either', async () => {
    const subject = createSubject({ name: 'Jane Doe', company: 'Acme Robotics' });
    const r = await run(subject, 'Acme Robotics', 'Acme Robotics', 'Acme Robotics is a maker of toys. Jane Doe became the firm\'s managing director, working alongside co-founder Robert Vance.');
    expect(r.threads.find((t) => t.value === 'Robert Vance')?.trusted).toBe(false);
  });

  test('an ordinary-word company article that names the person and the company still needs a known fact', async () => {
    const subject = createSubject({ name: 'Jane Doe', company: 'Mercury' });
    const extract = 'Mercury is a record label. Mercury was founded in 1962 by Jane Doe and co-founder Robert Vance.';
    const r = await run(subject, 'Mercury', 'Mercury (company)', extract);
    expect(r.threads.find((t) => t.value === 'Robert Vance')?.trusted).toBe(false);
  });

  test('an ordinary-word company article that matches a known fact (a known co-founder, a founding year) is trusted', async () => {
    const withPerson = createSubject({ name: 'Jane Doe', company: 'Mercury' });
    addAnchor(withPerson, 'people', 'Max Lin', 'f-1');
    const r1 = await run(withPerson, 'Mercury', 'Mercury (company)', 'Mercury is a banking company. Mercury was co-founded by Jane Doe with co-founder Robert Vance. Max Lin was its first engineer.');
    expect(r1.threads.find((t) => t.value === 'Robert Vance')?.trusted).toBe(true);
    const withYear = createSubject({ name: 'Jane Doe', company: 'Mercury' });
    addRoleAnchor(withYear, { org: 'Mercury', role: 'founder', from: '2017', origin: 'f-2' });
    const r2 = await run(withYear, 'Mercury', 'Mercury (company)', 'Mercury is a banking company founded in 2017. Mercury was co-founded by Jane Doe with co-founder Robert Vance.');
    expect(r2.threads.find((t) => t.value === 'Robert Vance')?.trusted).toBe(true);
    // a year that is not the founding year is no such fact
    const otherYear = createSubject({ name: 'Jane Doe', company: 'Mercury' });
    addRoleAnchor(otherYear, { org: 'Mercury', role: 'founder', from: '2017', origin: 'f-3' });
    const r3 = await run(otherYear, 'Mercury', 'Mercury (company)', 'Mercury is a record label founded in 1962. In 2017 Mercury hired Jane Doe, who worked with co-founder Robert Vance.');
    expect(r3.threads.find((t) => t.value === 'Robert Vance')?.trusted).toBe(false);
  });

  test('a distinctive company article that pairs the person with the company stays trusted', async () => {
    const subject = createSubject({ name: 'Jane Doe', company: 'Acme Robotics' });
    const r = await run(subject, 'Acme Robotics', 'Acme Robotics', 'Acme Robotics was founded in 2015 by Jane Doe and co-founder Robert Vance.');
    expect(r.threads.find((t) => t.value === 'Robert Vance')?.trusted).toBe(true);
  });
});

/* ------------------------------------------------ Wikidata entry resolved through its article */

describe('Wikidata: an entry resolved through its Wikipedia article', () => {
  const routes = (extract, rows = []) => [
    [(u) => u.includes('action=query&list=search'), { query: { search: [{ title: 'Q100' }] } }],
    [isSparql('?aliases'), sparqlBody([cand('Q100', 'Jane Quenneville', 'American engineer', { article: 'https://en.wikipedia.org/wiki/Jane_Quenneville' })])],
    [(u) => u.startsWith('https://en.wikipedia.org/w/api.php'), { query: { pages: [{ title: 'Jane Quenneville', extract }] } }],
    [isSparql("'educated at'"), sparqlBody(rows)],
  ];
  const STANFORD = [{ kind: 'educated at', val: `${E}Q41506`, valLabel: 'Stanford University', st: 'http://www.wikidata.org/entity/statement/Q100-1' }];

  test('its records are graded with the article sentence: likely, with the reason, never confirmed', async () => {
    fakeNetwork(routes('Jane Quenneville is an American engineer. She co-founded Acme Robotics in 2015.', STANFORD));
    const subject = createSubject({ name: 'Jane Quenneville', company: 'Acme Robotics' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Quenneville', template: 'profile' }, ctxFor(subject));
    const identity = r.findings.find((f) => f.category === 'identity');
    expect(identity.match).toBe('likely');
    expect(identity.matchReasons.join(' ')).toMatch(/Wikipedia article names the company/);
    const school = r.findings.find((f) => f.category === 'education');
    expect(school.match).toBe('likely');
    expect(r.threads.find((t) => t.kind === 'school' && t.value === 'Stanford University')?.trusted).toBe(true);
    r.findings.forEach((f) => expect(f.match).not.toBe('confirmed'));
  });

  test('a lead that gives only the surname still resolves the entry', async () => {
    fakeNetwork(routes('Jane Quenneville is an American engineer.\n\n== Career ==\nQuenneville is the co-founder and chief executive of Acme Robotics.'));
    const subject = createSubject({ name: 'Jane Quenneville', company: 'Acme Robotics' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Quenneville', template: 'profile' }, ctxFor(subject));
    expect(r.notes.join(' ')).not.toMatch(/None was used/);
    expect(r.findings.find((f) => f.category === 'identity')?.match).toBe('likely');
  });

  test('a relative\'s possessive surname does not resolve the entry', async () => {
    fakeNetwork(routes('Jane Quenneville is an American painter.\n\n== Career ==\nQuenneville\'s brother co-founded Acme Robotics.'));
    const subject = createSubject({ name: 'Jane Quenneville', company: 'Acme Robotics' });
    const r = await K.wikidataConnector.run({ kind: 'subject', value: 'Jane Quenneville', template: 'profile' }, ctxFor(subject));
    expect(r.findings).toEqual([]);
    expect(r.notes[0]).toMatch(/None was used/);
  });
});

/* ------------------------------------------------ Hugging Face: the same handle elsewhere */

describe('Hugging Face: an account reached through the same handle on another service', () => {
  const overview = (user, fullname, extra = {}) => ({ _id: `id-${user}`, fullname, user, type: 'user', orgs: [], numModels: 1, numDatasets: 0, numSpaces: 0, numPapers: 0, createdAt: '2024-03-02T09:14:23.000Z', ...extra });
  const runHandle = (subject, user, o, platform) => {
    fakeNetwork([[(u) => u.includes(`/api/users/${user}/overview`), o]]);
    return huggingFaceConnector.run({ kind: 'handle', value: user, platform, why: `${platform} handle` }, ctxFor(subject));
  };

  test('the same handle and the name only: possible, name match only', async () => {
    const subject = createSubject({ name: 'Jane Doe', company: 'Acme Robotics' });
    const r = await runHandle(subject, 'janedoe', overview('janedoe', 'Jane Doe'), 'x');
    expect(r.findings[0].match).toBe('possible');
    expect(r.findings[0].title).toMatch(/verify identity/);
  });

  test('the same handle with the known company in its organisations: likely', async () => {
    const subject = createSubject({ name: 'Jane Doe', company: 'Acme Robotics' });
    const r = await runHandle(subject, 'janedoe', overview('janedoe', 'Jane Doe', { orgs: [{ name: 'acme-robotics', fullname: 'Acme Robotics' }] }), 'x');
    expect(r.findings[0].match).toBe('likely');
  });

  test('the same handle with a link to a known domain in its bio: likely', async () => {
    const subject = createSubject({ name: 'Jane Doe', company: 'Acme Robotics' });
    addAnchor(subject, 'domains', 'janedoe-lab.io', 'f-1');
    const r = await runHandle(subject, 'janedoe', overview('janedoe', 'Jane Doe', { details: 'Notes at janedoe-lab.io' }), 'github');
    expect(r.findings[0].match).toBe('likely');
  });

  test('the exact Hugging Face handle stays likely', async () => {
    const subject = createSubject({ name: 'Jane Doe', company: 'Acme Robotics' });
    const r = await runHandle(subject, 'janedoe', overview('janedoe', 'Jane Doe'), 'huggingface');
    expect(r.findings[0].match).toBe('likely');
  });
});
