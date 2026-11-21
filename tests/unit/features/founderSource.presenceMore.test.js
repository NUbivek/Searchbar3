/**
 * @jest-environment node
 *
 * More of the person's public footprint (presenceMore.js): Hugging Face
 * profiles, Open Library books (through the Wikidata author id), crates.io.
 * Identity grading (a name alone stays possible with "verify identity"; no
 * source sets 'confirmed'), privacy, failures and the contact switch. No
 * network: fixtures follow the shapes these services answered with on
 * 2026-11-20, shortened, with invented people.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const {
  huggingFaceConnector, openLibraryBooksConnector, cratesIoConnector,
  parseWikidataAuthors, parseWorks, __resetPresenceMoreForTests,
} = require('../../../src/server/founder/sources/presenceMore');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const task = (kind, value, extra = {}) => ({ kind, value, template: null, params: null, depth: 1, relation: null, ...extra });
const newSubject = () => createSubject({ name: 'Trevor Milton', company: 'Nikola Corporation' });

function network(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    for (const [pattern, reply] of routes) {
      if (!url.includes(pattern)) continue;
      const r = typeof reply === 'function' ? reply(url) : reply;
      const custom = r && typeof r.status === 'number';
      const body = custom ? r.body : r;
      return { status: custom ? r.status : 200, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    }
    return { status: 404, headers: new Map(), url, text: async () => '{"error":"not found"}' };
  });
  return calls;
}

const savedContact = process.env.FOUNDER_HTTP_CONTACT;
beforeEach(() => { __resetPresenceMoreForTests(); delete process.env.FOUNDER_HTTP_CONTACT; });
afterEach(() => setTransport());
afterAll(() => { if (savedContact === undefined) delete process.env.FOUNDER_HTTP_CONTACT; else process.env.FOUNDER_HTTP_CONTACT = savedContact; });

const noConfirmed = (out) => out.findings.forEach((f) => expect(f.match).not.toBe('confirmed'));

/* -------------------------------------------------------------- fixtures */

const hfSearch = (...users) => ({ datasets: [], models: [], orgs: [], q: 'x', spaces: [], users, papers: [], collections: [] });
const hfUser = (user, fullname) => ({ _id: `id-${user}`, avatarUrl: `/avatars/${user}.svg`, user, fullname });
const hfOverview = (user, fullname, extra = {}) => ({
  _id: `id-${user}`, avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/secret.jpeg', isPro: false, fullname,
  numModels: 3, numDatasets: 1, numSpaces: 2, numKernels: 0, numBuckets: 0, numDiscussions: 0, numPapers: 1, numUpvotes: 0, numLikes: 4,
  numFollowers: 77, numFollowing: 5, numFollowingOrgs: 0, orgs: [], user, type: 'user', isFollowing: false, hardwareItems: [],
  createdAt: '2024-03-02T09:14:23.000Z', ...extra,
});

const wdRow = (qid, ol, desc, orgs = '') => ({
  p: { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` }, ol: { type: 'literal', value: ol },
  ...(desc ? { desc: { 'xml:lang': 'en', type: 'literal', value: desc } } : {}), orgs: { type: 'literal', value: orgs },
});
const wd = (...rows) => ({ head: { vars: ['p', 'ol', 'desc', 'orgs'] }, results: { bindings: rows } });
const olWork = (title, date, key, subjects = []) => ({
  ...(date ? { first_publish_date: date } : {}), title, key: `/works/${key}`, covers: [1], subjects, type: { key: '/type/work' },
  authors: [{ type: { key: '/type/author_role' }, author: { key: '/authors/OL1A' } }], description: { type: '/type/text', value: 'Long blurb' },
  created: { type: '/type/datetime', value: '2009-10-24T05:55:18.367086' },
});
const olWorks = (entries, size = entries.length) => ({ links: { self: '/authors/OL1A/works.json', author: '/authors/OL1A' }, size, entries });

/* ------------------------------------------------------------ Hugging Face */

describe('Hugging Face', () => {
  test('a name-search hit is possible with "verify identity"; one whose organisation is the person\'s company is likely; avatars and followers are not kept', async () => {
    const subject = newSubject();
    const calls = network([
      ['/api/quicksearch', hfSearch(hfUser('tmilton', 'Trevor Milton'), hfUser('tm-ml', 'Trevor Milton'), hfUser('other-t', 'Trevor Jones'))],
      ['/api/users/tmilton/overview', hfOverview('tmilton', 'Trevor Milton', { orgs: [{ avatarUrl: '/a.png', fullname: 'Nikola Corporation', name: 'nikola-corp' }], details: 'Builds trucks. Call me at 555-123-4567' })],
      ['/api/users/tm-ml/overview', hfOverview('tm-ml', 'Trevor Milton')],
    ]);
    const out = await huggingFaceConnector.run(task('subject', subject.name), ctxFor(subject));
    expect(calls.some((u) => u.includes('other-t'))).toBe(false);
    expect(out.findings).toHaveLength(2);
    const [likely, possible] = out.findings;
    expect(likely.match).toBe('likely');
    expect(likely.matchReasons.join(' ')).toMatch(/Nikola Corporation/);
    expect(likely.quote).toMatch(/Organisations: Nikola Corporation \(nikola-corp\)/);
    expect(possible.match).toBe('possible');
    expect(possible.title).toMatch(/verify identity/);
    const all = JSON.stringify(out);
    expect(all).not.toMatch(/555-123-4567|avatars|secret\.jpeg|77/);
    noConfirmed(out);
  });

  test('no account with the name is said plainly; a broken answer is an error', async () => {
    const subject = newSubject();
    network([['/api/quicksearch', hfSearch(hfUser('x', 'Someone Else'))]]);
    const out = await huggingFaceConnector.run(task('subject', subject.name), ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/no account states the name Trevor Milton/);
    network([['/api/quicksearch', { results: [] }]]);
    await expect(huggingFaceConnector.run(task('subject', subject.name), ctxFor(subject))).rejects.toThrow(/without a list of accounts/);
  });

  test('an overview that fails is reported as partial; when all fail the lookup fails', async () => {
    const subject = newSubject();
    network([
      ['/api/quicksearch', hfSearch(hfUser('a1', 'Trevor Milton'), hfUser('a2', 'Trevor Milton'))],
      ['/api/users/a1/overview', hfOverview('a1', 'Trevor Milton')],
      ['/api/users/a2/overview', { status: 500, body: 'oops' }],
    ]);
    const out = await huggingFaceConnector.run(task('subject', subject.name), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.partial[0]).toMatch(/a2/);
    network([
      ['/api/quicksearch', hfSearch(hfUser('a2', 'Trevor Milton'))],
      ['/api/users/a2/overview', { status: 500, body: 'oops' }],
    ]);
    await expect(huggingFaceConnector.run(task('subject', subject.name), ctxFor(subject))).rejects.toThrow();
  });

  test('a handle tied to the person: kept as likely only when the account states the full name', async () => {
    const subject = newSubject();
    network([
      ['/api/users/tmilton/overview', hfOverview('tmilton', 'Trevor Milton')],
      ['/api/users/tjones/overview', hfOverview('tjones', 'Tara Jones')],
    ]);
    // The same handle on another service and the name only: 'possible' (review 2026-11-21, a handle like this is
    // just the name). With the company among its organisations it is 'likely', and the handle is a reason.
    const sameHandle = await huggingFaceConnector.run(task('handle', 'tmilton', { platform: 'github', why: 'github handle' }), ctxFor(subject));
    expect(sameHandle.findings[0].match).toBe('possible');
    network([['/api/users/tmilton/overview', hfOverview('tmilton', 'Trevor Milton', { orgs: [{ fullname: 'Nikola Corporation', name: 'nikola-corp' }] })]]);
    const tied = await huggingFaceConnector.run(task('handle', 'tmilton', { platform: 'github', why: 'github handle' }), ctxFor(subject));
    expect(tied.findings[0].match).toBe('likely');
    expect(tied.findings[0].matchReasons.join(' ')).toMatch(/same handle, tmilton, as a GitHub account/);
    network([
      ['/api/users/tmilton/overview', hfOverview('tmilton', 'Trevor Milton')],
      ['/api/users/tjones/overview', hfOverview('tjones', 'Tara Jones')],
    ]);
    const other = await huggingFaceConnector.run(task('handle', 'tjones', { platform: 'huggingface' }), ctxFor(subject));
    expect(other.findings).toEqual([]);
    expect(other.notes[0]).toMatch(/left out/);
    const url = await huggingFaceConnector.run(task('url', 'https://huggingface.co/tmilton'), ctxFor(subject));
    expect(url.findings[0].match).toBe('likely');
    expect((await huggingFaceConnector.run(task('url', 'https://huggingface.co/models'), ctxFor(subject))).findings).toEqual([]);
    const missing = await huggingFaceConnector.run(task('handle', 'nobody-here', { platform: 'github' }), ctxFor(subject));
    expect(missing.notes[0]).toMatch(/no account nobody-here/);
  });
});

/* ------------------------------------------------------------ Open Library */

describe('Open Library', () => {
  test('reads the Wikidata answer and the works list; birth dates are never read', () => {
    const people = parseWikidataAuthors(wd(wdRow('Q1', 'OL123A', 'American businessman', 'Nikola Corporation | Upstart LLC'), wdRow('Q2', 'bad-id', 'x')));
    expect(people).toEqual([{ qid: 'Q1', olid: 'OL123A', description: 'American businessman', orgs: ['Nikola Corporation', 'Upstart LLC'] }]);
    expect(() => parseWikidataAuthors({ head: {} })).toThrow();
    const { works, total } = parseWorks(olWorks([olWork('Old Book', 'August 12, 1962', 'OL1W'), olWork('New Book', '2019', 'OL2W', ['Trucks', 'Hydrogen'])], 61));
    expect(works.map((w) => w.title)).toEqual(['New Book', 'Old Book']);
    expect(works[0]).toMatchObject({ year: 2019, subjects: ['Trucks', 'Hydrogen'] });
    expect(total).toBe(61);
    expect(() => parseWorks({ docs: [] })).toThrow(/list of works/);
  });

  test('books through a Wikidata entry that names the company are likely; a name-only entry is possible', async () => {
    const subject = newSubject();
    const calls = network([
      ['query.wikidata.org', wd(wdRow('Q10', 'OL10A', 'American entrepreneur', 'Nikola Corporation'), wdRow('Q11', 'OL11A', 'British poet'))],
      ['/authors/OL10A/works.json', olWorks([olWork('Hydrogen Highway', '2020', 'OL5W')])],
      ['/authors/OL11A/works.json', olWorks([olWork('Verses', '1990', 'OL6W')])],
    ]);
    const out = await openLibraryBooksConnector.run(task('subject', subject.name), ctxFor(subject));
    expect(calls.every((u) => !/openlibrary\.org\/(search|api)/.test(u))).toBe(true);
    const byUrl = Object.fromEntries(out.findings.map((f) => [f.url, f]));
    expect(byUrl['https://openlibrary.org/authors/OL10A'].match).toBe('likely');
    expect(byUrl['https://openlibrary.org/authors/OL11A'].match).toBe('possible');
    expect(byUrl['https://openlibrary.org/authors/OL11A'].title).toMatch(/verify identity/);
    noConfirmed(out);
  });

  test('no Wikidata author id is said plainly; a failed works list with nothing else is an error', async () => {
    const subject = newSubject();
    network([['query.wikidata.org', wd()]]);
    const none = await openLibraryBooksConnector.run(task('subject', subject.name), ctxFor(subject));
    expect(none.findings).toEqual([]);
    expect(none.notes[0]).toMatch(/no Wikidata entry named Trevor Milton gives an Open Library author id/);
    network([['query.wikidata.org', wd(wdRow('Q10', 'OL10A', ''))], ['/authors/OL10A/works.json', { status: 503, body: '' }]]);
    await expect(openLibraryBooksConnector.run(task('subject', subject.name), ctxFor(subject))).rejects.toThrow();
  });

  test('an author link tied to the person: the author record must state the full name', async () => {
    const subject = newSubject();
    network([
      ['/authors/OL20A.json', { key: '/authors/OL20A', name: 'Trevor Milton', birth_date: '1 January 1900', type: { key: '/type/author' } }],
      ['/authors/OL20A/works.json', olWorks([olWork('Hydrogen Highway', '2020', 'OL5W')])],
      ['/authors/OL21A.json', { key: '/authors/OL21A', name: 'Quentin Blake', type: { key: '/type/author' } }],
    ]);
    const out = await openLibraryBooksConnector.run(task('url', 'https://openlibrary.org/authors/OL20A/Trevor_Milton'), ctxFor(subject));
    expect(out.findings[0].match).toBe('likely');
    expect(JSON.stringify(out)).not.toMatch(/1900/);
    const other = await openLibraryBooksConnector.run(task('url', 'https://openlibrary.org/authors/OL21A'), ctxFor(subject));
    expect(other.findings).toEqual([]);
    expect(other.notes[0]).toMatch(/left out/);
  });
});

/* --------------------------------------------------------------- crates.io */

describe('crates.io', () => {
  test('is off without a declared contact, on with one', () => {
    expect(cratesIoConnector.enabled()).toBe(false);
    process.env.FOUNDER_HTTP_CONTACT = 'https://example.org/contact';
    expect(cratesIoConnector.enabled()).toBe(true);
    expect(cratesIoConnector.unavailableReason).not.toMatch(/\b(api|key|token|free|paid|tier|env)\b/i);
  });

  test('a GitHub login tied to the person, with the full name: likely; another name is left out; other platforms are not asked', async () => {
    process.env.FOUNDER_HTTP_CONTACT = 'https://example.org/contact';
    const subject = newSubject();
    const calls = network([
      ['/users/tmilton', { user: { avatar: 'https://avatars.githubusercontent.com/u/1', id: 42, login: 'tmilton', name: 'Trevor Milton', url: 'https://github.com/tmilton' } }],
      ['/crates?user_id=42', { crates: [
        { name: 'hydro-sim', description: 'Simulates fuel cells', downloads: 1200, created_at: '2021-01-02T00:00:00Z', updated_at: '2024-05-06T00:00:00Z' },
        { name: 'truckctl', description: null, downloads: 30, created_at: '2020-01-02T00:00:00Z', updated_at: '2022-01-01T00:00:00Z' },
      ], meta: { total: 2, next_page: null, prev_page: null } }],
      ['/users/tjones', { user: { id: 43, login: 'tjones', name: 'Tara Jones', url: 'https://github.com/tjones' } }],
    ]);
    const out = await cratesIoConnector.run(task('handle', 'tmilton', { platform: 'github' }), ctxFor(subject));
    expect(out.findings[0]).toMatchObject({ match: 'likely', url: 'https://crates.io/users/tmilton', date: '2024-05-06' });
    expect(out.findings[0].title).toMatch(/2 Rust crates.*hydro-sim/);
    expect(JSON.stringify(out)).not.toMatch(/avatars/);
    const other = await cratesIoConnector.run(task('handle', 'tjones', { platform: 'github' }), ctxFor(subject));
    expect(other.findings).toEqual([]);
    expect(other.notes[0]).toMatch(/left out/);
    const before = calls.length;
    expect((await cratesIoConnector.run(task('handle', 'tmilton', { platform: 'x' }), ctxFor(subject))).findings).toEqual([]);
    expect(calls.length).toBe(before);
  });

  test('no account is said plainly; a changed answer is an error', async () => {
    process.env.FOUNDER_HTTP_CONTACT = 'https://example.org/contact';
    const subject = newSubject();
    network([['/users/ghost', { status: 404, body: { errors: [{ detail: 'Not Found' }] } }], ['/users/weird', { account: {} }]]);
    const none = await cratesIoConnector.run(task('handle', 'ghost', { platform: 'github' }), ctxFor(subject));
    expect(none.notes[0]).toMatch(/no account for the GitHub login ghost/);
    await expect(cratesIoConnector.run(task('handle', 'weird', { platform: 'github' }), ctxFor(subject))).rejects.toThrow(/account record/);
  });
});

describe('pacing', () => {
  test('Open Library requests are spaced a second apart', async () => {
    __resetPresenceMoreForTests({ paced: true });
    const subject = newSubject();
    const times = [];
    setTransport(async (url) => {
      times.push(Date.now());
      const body = url.includes('wikidata') ? wd(wdRow('Q1', 'OL1A', ''), wdRow('Q2', 'OL2A', '')) : olWorks([olWork('A Book', '2001', 'OL9W')]);
      return { status: 200, headers: new Map(), url, text: async () => JSON.stringify(body) };
    });
    await openLibraryBooksConnector.run(task('subject', subject.name), ctxFor(subject));
    expect(times).toHaveLength(3);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(950);
  });
});
