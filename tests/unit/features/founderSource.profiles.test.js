/**
 * Public developer and maker profiles (GitHub, Hacker News, Keybase linked
 * accounts): mapping to findings, identity grading, threads and their
 * `trusted` flag, the privacy rules and the failure paths. No network:
 * fixtures are cut from real responses.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const {
  githubConnector, hackerNewsConnector, linkedAccountsConnector, __resetProfilesForTests,
} = require('../../../src/server/founder/sources/profiles');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const subjectTask = (subject) => ({ kind: 'subject', value: subject.name, template: null, params: null, depth: 0, relation: null });
const handleTask = (handle, why = '') => ({ kind: 'handle', value: handle, template: null, params: null, depth: 1, relation: null, why });
const companyTask = (company) => ({ kind: 'company', value: company, template: null, params: null, depth: 1, relation: null });

/** Fake network: the first route whose pattern is in the URL answers. A reply { status: <number>, body } sets the status. */
function network(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push(url);
    calls.headers = init.headers;
    for (const [pattern, reply] of routes) {
      if (!url.includes(pattern)) continue;
      const r = typeof reply === 'function' ? reply(url) : reply;
      const custom = r && typeof r.status === 'number';
      const body = custom ? r.body : r;
      return { status: custom ? r.status : 200, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    }
    return { status: 404, headers: new Map(), url, text: async () => '{"message":"Not Found"}' };
  });
  return calls;
}

beforeEach(() => __resetProfilesForTests());
afterEach(() => setTransport());

/* ------------------------------------------------------------- fixtures */

const ghSearch = (...logins) => ({ total_count: logins.length, incomplete_results: false, items: logins.map((login, i) => ({ login, id: 6983 + i, type: 'User', html_url: `https://github.com/${login}`, score: 1 })) });
const ghPc = {
  login: 'pc', id: 6983, type: 'User', name: 'Patrick Collison', company: 'Stripe', blog: 'http://patrickcollison.com',
  location: 'San Francisco', email: 'patrick.private@example.com', hireable: null, bio: 'I type things at Stripe.', twitter_username: null,
  public_repos: 34, public_gists: 5, followers: 2038, following: 6, created_at: '2008-04-12T18:36:59Z', updated_at: '2026-10-10T13:17:49Z',
};
const ghNamesake = {
  login: 'Collisonpatrick', id: 125029066, type: 'User', name: 'Patrick Collison', company: null, blog: '', location: 'Lagos', email: null, bio: null,
  twitter_username: null, public_repos: 1, followers: 0, created_at: '2023-02-10T09:00:00Z', updated_at: '2023-02-11T09:00:00Z',
};
const githubRoutes = [
  ['api.github.com/search/users', ghSearch('pc', 'Collisonpatrick')],
  ['api.github.com/users/pc', ghPc],
  ['api.github.com/users/Collisonpatrick', ghNamesake],
];

const hnHit = (id, title, url, points, comments, created, text = null) => ({ objectID: String(id), title, url, points, num_comments: comments, created_at: created, story_text: text, author: 'someone', _tags: ['story'] });
const hnMilton = {
  nbHits: 60,
  hits: [
    hnHit(27996321, 'Grand jury indicts Trevor Milton, Nikola founder, on three counts of fraud', 'https://www.cnbc.com/2021/07/29/us-prosecutors-charge-trevor-milton-founder-of-electric-carmaker-nikola-with-three-counts-of-fraud.html', 544, 502, '2021-07-29T13:31:48Z'),
    hnHit(27996999, 'Grand jury indicts Trevor Milton, Nikola founder', 'https://www.cnbc.com/2021/07/29/us-prosecutors-charge-trevor-milton-founder-of-electric-carmaker-nikola-with-three-counts-of-fraud.html', 12, 1, '2021-07-29T15:00:00Z'),
    hnHit(47425176, 'Trevor Milton is raising funds for a new jet he claims will transform flying', 'https://www.wsj.com/business/trevor-milton-pardon-trump-3163e19c', 143, 197, '2026-03-18T12:52:47Z'),
    hnHit(27996786, 'Nikola founder Trevor Milton indicted in US for misleading investors', 'https://www.reuters.com/business/autos-transportation/us-says-nikola-founder-milton-indicted-misleading-investors-2021-07-29/', 63, 1, '2021-07-29T14:13:00Z'),
    hnHit(24540362, 'Nikola CEO Trevor Milton Resigns', 'https://finance.yahoo.com/news/nikola-board-directors-announces-leadership-054000480.html', 50, 25, '2020-09-21T06:15:23Z'),
    hnHit(30000001, 'The electric truck that rolled downhill', 'https://example.com/blog/trevor-milton-and-the-truck', 40, 9, '2021-01-05T10:00:00Z'),
    hnHit(30000002, 'Ask HN: What happened to hydrogen trucks?', null, 22, 30, '2022-02-02T10:00:00Z', 'I followed this space for years.<p>After Trevor Milton left, the Nikola roadmap changed completely. Has anyone here worked on the Badger?'),
    hnHit(30000003, 'Milton Keynes gets a new data centre', 'https://example.com/milton-keynes', 300, 80, '2023-03-03T10:00:00Z'),
  ],
};

const kbPc = {
  status: { code: 0, name: 'OK' },
  them: [{
    id: '39dd2afa533f1249edc8695370665000',
    basics: { username: 'pc', ctime: 1395281756 },
    profile: { full_name: 'Patrick Collison', location: 'San Francisco', bio: 'Stripe' },
    proofs_summary: {
      all: [
        { proof_type: 'twitter', nametag: 'patrickc', state: 1, service_url: 'https://twitter.com/patrickc' },
        { proof_type: 'github', nametag: 'pc', state: 1, service_url: 'https://github.com/pc' },
        { proof_type: 'dns', nametag: 'patrickcollison.com', state: 1, service_url: 'http://patrickcollison.com' },
        { proof_type: 'generic_web_site', nametag: 'patrickcollison.com', state: 1, service_url: 'https://patrickcollison.com' },
        { proof_type: 'reddit', nametag: 'oldaccount', state: 2, service_url: 'https://reddit.com/user/oldaccount' },
      ],
    },
  }],
};

/* ---------------------------------------------------------------- GitHub */

describe('GitHub public profiles', () => {
  test('finds the person by name and reads the profile: age, stated company, public work', async () => {
    const calls = network(githubRoutes);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const { findings, threads, notes } = await githubConnector.run(subjectTask(subject), ctxFor(subject));

    expect(githubConnector.id).toBe('github');
    expect(githubConnector.label).toBe('GitHub public profiles');
    expect(githubConnector.kinds).toEqual(['subject', 'handle']);
    // R3: the tied account's public organisations and repositories are read too
    expect(calls).toHaveLength(5);
    expect(calls.slice(3).map((u) => new URL(u).pathname)).toEqual(['/users/pc/orgs', '/users/pc/repos']);
    expect(decodeURIComponent(calls[0])).toContain('q=fullname:"Patrick Collison" type:user');
    expect(calls.headers.Accept).toBe('application/vnd.github+json');

    expect(findings).toHaveLength(2);
    const [own, namesake] = findings;
    expect(own).toMatchObject({
      source: 'github', sourceLabel: 'GitHub public profiles', category: 'identity', severity: 'info',
      title: 'GitHub profile pc (self-described: name "Patrick Collison", company "Stripe"): account created 2008-04-12, 34 public repositories, 2,038 followers',
      quote: 'Patrick Collison | Company: Stripe | Bio: I type things at Stripe. | Blog: http://patrickcollison.com | City: San Francisco',
      // R3: found by the name, a self-described profile is 'likely' at most
      url: 'https://github.com/pc', date: '2008-04-12', match: 'likely', matchFixed: true,
    });
    expect(own.matchReasons).toEqual(['names Stripe', 'self-described on the GitHub profile']);
    expect(own.data).toEqual({
      login: 'pc', name: 'Patrick Collison', company: 'Stripe', blog: 'http://patrickcollison.com', x: null,
      bio: 'I type things at Stripe.', city: 'San Francisco',
      publicRepos: 34, followers: 2038, createdAt: '2008-04-12T18:36:59Z', updatedAt: '2026-10-10T13:17:49Z',
    });

    // The second account states the same name and nothing else: it may be a namesake or an impostor.
    expect(namesake.url).toBe('https://github.com/Collisonpatrick');
    expect(namesake.match).toBe('possible');
    expect(namesake.title).toContain('self-described: name "Patrick Collison"');

    // Only the profile tied to the subject leads anywhere.
    expect(threads.map((t) => [t.kind, t.value, t.trusted])).toEqual([['handle', 'pc', true], ['domain', 'patrickcollison.com', true]]);
    expect(notes).toEqual([]);
  });

  // R3: the profile may show the city (basedIn); nothing finer than the city, and never the e-mail address.
  test('privacy: the e-mail address is never output, and of the location only the city', async () => {
    network([
      ['search/users', ghSearch('pc')],
      ['users/pc', { ...ghPc, location: 'San Francisco, 1 Market Street', bio: 'I type things at Stripe. Write to patrick.other@example.com', blog: 'patrick.blog@example.com' }],
    ]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const result = await githubConnector.run(subjectTask(subject), ctxFor(subject));
    const dump = JSON.stringify(result);
    expect(result.findings).toHaveLength(1);
    expect(dump).not.toMatch(/example\.com/);
    expect(dump).not.toMatch(/Market Street/);
    expect(result.findings[0].data.city).toBe('San Francisco');
    expect(result.findings[0].quote).toContain('[email removed]');
    expect(result.findings[0].data.blog).toBe('');
    expect(result.threads.map((t) => t.kind)).toEqual(['handle']);
  });

  test('a profile that states only the name stays possible and is not followed', async () => {
    network([['search/users', ghSearch('Collisonpatrick')], ['users/Collisonpatrick', ghNamesake]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const { findings, threads } = await githubConnector.run(subjectTask(subject), ctxFor(subject));
    expect(findings.map((f) => f.match)).toEqual(['possible']);
    expect(findings[0].matchReasons).toEqual(['matched by name only']);
    expect(threads).toEqual([]);
  });

  test('a known website of the subject on the profile makes it likely', async () => {
    network([['search/users', ghSearch('pc')], ['users/pc', { ...ghPc, company: null, bio: null }]]);
    const subject = createSubject({ name: 'Patrick Collison' });
    addAnchor(subject, 'domains', 'patrickcollison.com');
    const { findings, threads } = await githubConnector.run(subjectTask(subject), ctxFor(subject));
    expect(findings[0].match).toBe('likely');
    expect(threads.map((t) => [t.kind, t.value, t.trusted])).toEqual([['handle', 'pc', true], ['domain', 'patrickcollison.com', true]]);
  });

  test('a school on the profile does not tell namesakes apart; a known co-founder does', async () => {
    network([
      ['search/users', ghSearch('pc', 'Collisonpatrick')],
      ['users/pc', { ...ghPc, company: null, bio: 'MIT dropout. Building with John Collison.', blog: '' }],
      ['users/Collisonpatrick', { ...ghNamesake, bio: 'MIT class of 2021' }],
    ]);
    const subject = createSubject({ name: 'Patrick Collison' });
    addAnchor(subject, 'schools', 'MIT');
    addAnchor(subject, 'people', 'John Collison');
    const { findings, threads } = await githubConnector.run(subjectTask(subject), ctxFor(subject));
    expect(findings.map((f) => [f.data.login, f.match, f.matchFixed])).toEqual([['pc', 'likely', undefined], ['Collisonpatrick', 'possible', true]]);
    expect(findings[1].matchReasons).toEqual(['names MIT, but 2 accounts carry this name and a school alone does not tell them apart']);
    expect(threads.map((t) => t.value)).toEqual(['pc']);
  });

  test('an account under another name, and an organisation, are dropped', async () => {
    network([
      ['search/users', ghSearch('pcollins', 'collison-inc')],
      ['users/pcollins', { ...ghPc, login: 'pcollins', name: 'Patrick Collins' }],
      ['users/collison-inc', { ...ghPc, login: 'collison-inc', type: 'Organization' }],
    ]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    expect(await githubConnector.run(subjectTask(subject), ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
  });

  test('reads at most three profiles, and nothing at all when nobody has the name', async () => {
    const calls = network([
      ['search/users', ghSearch('a1', 'a2', 'a3', 'a4', 'a5')],
      ['api.github.com/users/', (url) => ({ ...ghNamesake, login: url.split('/').pop() })],
    ]);
    const subject = createSubject({ name: 'Patrick Collison' });
    const { findings } = await githubConnector.run(subjectTask(subject), ctxFor(subject));
    expect(calls.filter((u) => u.includes('/users/a'))).toHaveLength(3);
    expect(findings).toHaveLength(3);

    const none = network([['search/users', ghSearch()]]);
    expect((await githubConnector.run(subjectTask(subject), ctxFor(subject))).findings).toEqual([]);
    expect(none).toHaveLength(1);
  });

  test('a used-up allowance is a note, not a failure', async () => {
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const calls = network([['search/users', { status: 403, body: '{"message":"API rate limit exceeded for 203.0.113.9."}' }]]);
    const refused = await githubConnector.run(subjectTask(subject), ctxFor(subject));
    expect(refused.findings).toEqual([]);
    expect(refused.notes).toHaveLength(1);
    expect(refused.notes[0]).toMatch(/hourly allowance/);
    expect(refused.notes[0]).not.toMatch(/\b(API|endpoint|free|paid|key|token)\b|203\.0\.113/i);
    expect(calls).toHaveLength(1); // not retried

    network([['search/users', ghSearch('pc', 'Collisonpatrick')], ['users/pc', ghPc], ['users/Collisonpatrick', { status: 429, body: '{}' }]]);
    const partial = await githubConnector.run(subjectTask(subject), ctxFor(subject));
    expect(partial.findings.map((f) => f.url)).toEqual(['https://github.com/pc']);
    expect(partial.notes).toEqual(refused.notes);

    network([['users/pc', { status: 403, body: '{}' }]]);
    __resetProfilesForTests();
    const byHandle = await githubConnector.run(handleTask('pc'), ctxFor(subject));
    expect(byHandle).toEqual({ findings: [], threads: [], notes: refused.notes });
  });

  test('the source failing is an error', async () => {
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    network([['search/users', { status: 500, body: 'x' }]]);
    await expect(githubConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
    network([['search/users', { message: 'unexpected' }]]);
    await expect(githubConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/without a list of accounts/);
    network([['search/users', ghSearch('pc')], ['users/pc', { status: 502, body: 'x' }]]);
    await expect(githubConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/HTTP 502/);
    network([['users/pc', { status: 500, body: 'x' }]]);
    await expect(githubConnector.run(handleTask('pc'), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
  });

  test('a handle: that account is read directly', async () => {
    const calls = network([['users/pc', { ...ghPc, twitter_username: 'patrickc' }]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const { findings, threads } = await githubConnector.run(handleTask('@pc'), ctxFor(subject));
    // R3: then its public organisations and repositories
    expect([...calls]).toEqual(['https://api.github.com/users/pc', 'https://api.github.com/users/pc/orgs?per_page=30', 'https://api.github.com/users/pc/repos?sort=pushed&per_page=10&type=owner']);
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toBe('confirmed');
    expect(findings[0].data.x).toBe('patrickc');
    // the handle being looked up is not offered again; what the profile links to is
    expect(threads.map((t) => [t.kind, t.value, t.trusted])).toEqual([['handle', 'patrickc', true], ['domain', 'patrickcollison.com', true]]);
  });

  test('a handle whose account states another name is left out; one that states no name stays possible', async () => {
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    network([['users/patrickc', { ...ghPc, login: 'patrickc', name: 'Patrick Coffey', company: null, bio: null, blog: 'https://coffey.dev' }]]);
    const other = await githubConnector.run(handleTask('patrickc'), ctxFor(subject));
    expect(other.findings).toEqual([]);
    expect(other.threads).toEqual([]);
    expect(other.notes).toEqual(['The GitHub account "patrickc" states a different name and was left out.']);

    network([['users/pcx', { ...ghPc, login: 'pcx', name: null, company: null, bio: null, blog: 'https://someone.dev' }]]);
    const unnamed = await githubConnector.run(handleTask('pcx'), ctxFor(subject));
    expect(unnamed.findings[0].match).toBe('possible');
    expect(unnamed.findings[0].matchReasons[0]).toMatch(/reached through the handle pcx only/);
    expect(unnamed.findings[0].title).toContain('self-described: no name or company stated');
    expect(unnamed.threads).toEqual([]);

    network([['users/pcy', { ...ghPc, login: 'pcy', name: null, company: '@stripe', bio: null, blog: '' }]]);
    const placed = await githubConnector.run(handleTask('pcy', 'github handle'), ctxFor(subject));
    expect(placed.findings[0].match).toBe('likely');
    expect(placed.findings[0].matchReasons).toEqual(['reached through the handle pcy', 'names Stripe']);
  });

  test('a handle nobody holds, an organisation and an impossible handle give nothing', async () => {
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const calls = network([['users/stripe', { ...ghPc, login: 'stripe', type: 'Organization', name: 'Stripe' }]]);
    expect(await githubConnector.run(handleTask('nobody-here'), ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
    expect(await githubConnector.run(handleTask('stripe'), ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
    expect(await githubConnector.run(handleTask('not a handle!'), ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
    expect(calls).toHaveLength(2);
  });

  test('a profile already read is not requested again', async () => {
    const calls = network(githubRoutes);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    await githubConnector.run(subjectTask(subject), ctxFor(subject));
    const again = await githubConnector.run(handleTask('PC'), ctxFor(subject));
    expect(calls.filter((u) => /\/users\/pc$/i.test(new URL(u).pathname))).toHaveLength(1);
    expect(again.findings[0].url).toBe('https://github.com/pc');
  });
});

/* ----------------------------------------------------------- Hacker News */

describe('Hacker News', () => {
  test('stories about the person: points, dates, severity from the headline, graded by what they name', async () => {
    const calls = network([['hn.algolia.com/api/v1/search', hnMilton]]);
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const { findings, notes } = await hackerNewsConnector.run(subjectTask(subject), ctxFor(subject));

    expect(hackerNewsConnector.id).toBe('hacker-news');
    expect(hackerNewsConnector.kinds).toEqual(['subject', 'company', 'handle']);
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0])).toContain('query="Trevor Milton"&tags=story');

    // the duplicate submission and the Milton Keynes story are gone
    expect(findings).toHaveLength(6);
    // tied to the person first, then by how much the headline matters, then by points
    const [indicted, charged, resigned, ask, jet, truck] = findings;
    expect(charged).toMatchObject({ severity: 'high', match: 'confirmed', title: 'Hacker News (63 points, 1 comments): Nikola founder Trevor Milton indicted in US for misleading investors' });
    expect(indicted).toMatchObject({
      source: 'hacker-news', sourceLabel: 'Hacker News', category: 'press', severity: 'high', match: 'confirmed', date: '2021-07-29',
      title: 'Hacker News (544 points, 502 comments): Grand jury indicts Trevor Milton, Nikola founder, on three counts of fraud',
      url: 'https://www.cnbc.com/2021/07/29/us-prosecutors-charge-trevor-milton-founder-of-electric-carmaker-nikola-with-three-counts-of-fraud.html',
    });
    // makeFinding now also stores the matter's outcome (data.outcome, identity2)
    expect(indicted.data).toMatchObject({ points: 544, comments: 502, discussionUrl: 'https://news.ycombinator.com/item?id=27996321' });
    expect(resigned).toMatchObject({ severity: 'low', match: 'confirmed', date: '2020-09-21' });

    // a text post: the record is the discussion itself, quoted around the name
    expect(ask.url).toBe('https://news.ycombinator.com/item?id=30000002');
    expect(ask.match).toBe('confirmed');
    expect(ask.quote).toContain('After Trevor Milton left, the Nikola roadmap changed completely.');
    expect(ask.quote).not.toMatch(/<p>/);

    // names the person but not a known company: may be about a namesake
    expect(jet).toMatchObject({ match: 'possible', severity: 'info' });
    // the headline does not name the person, the article's address does
    expect(truck.title).toBe('Hacker News (40 points, 9 comments): The electric truck that rolled downhill');
    expect(truck.match).toBe('possible');
    expect(notes).toEqual([]);
  });

  test('threads come only from stories tied to the person', async () => {
    network([['hn.algolia.com/api/v1/search', {
      hits: [
        hnHit(1, 'Trevor Milton, founder of Nikola, co-founded dHybrid Systems with Mark Russell', 'https://example.com/a', 90, 10, '2020-09-21T00:00:00Z'),
        hnHit(2, 'Trevor Milton co-founded Bakery Labs with Jane Roe', 'https://example.com/b', 80, 10, '2019-01-01T00:00:00Z'),
      ],
    }]]);
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const { findings, threads } = await hackerNewsConnector.run(subjectTask(subject), ctxFor(subject));
    expect(findings.map((f) => f.match)).toEqual(['confirmed', 'possible']);
    const trusted = threads.filter((t) => t.trusted).map((t) => `${t.kind}:${t.value}`);
    expect(trusted).toContain('associate:Mark Russell');
    expect(threads.filter((t) => t.value === 'Jane Roe').every((t) => t.trusted === false)).toBe(true);
  });

  test('stories about the company are marked as company records, and namesakes of its name are dropped', async () => {
    const calls = network([['hn.algolia.com/api/v1/search', {
      hits: [
        hnHit(11, 'Nikola: How to Parlay an Ocean of Lies into a Partnership with GM', 'https://hindenburgresearch.com/nikola/', 900, 400, '2020-09-10T00:00:00Z'),
        hnHit(12, 'Nikola Tesla’s notebooks, digitised', 'https://example.com/tesla', 700, 90, '2019-05-05T00:00:00Z'),
        hnHit(13, 'Nikola founder Trevor Milton found guilty of fraud', 'https://www.cnbc.com/2022/10/14/nikola-founder-guilty.html', 75, 100, '2022-10-15T05:17:49Z'),
        hnHit(14, 'Nikola raises $250M', 'https://example.com/raise', 2, 0, '2019-01-01T00:00:00Z'),
        hnHit(15, 'Nikola files for bankruptcy', 'https://example.com/ch11', 310, 150, '2025-02-19T00:00:00Z'),
      ],
    }]]);
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const { findings } = await hackerNewsConnector.run(companyTask('Nikola'), ctxFor(subject));
    expect(decodeURIComponent(calls[0])).toContain('query="Nikola"');
    expect(findings.map((f) => [f.url, f.match, f.severity])).toEqual([
      ['https://www.cnbc.com/2022/10/14/nikola-founder-guilty.html', 'confirmed', 'high'],
      ['https://example.com/ch11', 'company', 'medium'],
      ['https://hindenburgresearch.com/nikola/', 'company', 'info'],
    ]);
    expect(findings[1].matchReasons).toEqual(['about Nikola, a company of the subject']);
  });

  test('a handle: the account, its age and what it says about itself', async () => {
    const calls = network([['hacker-news.firebaseio.com/v0/user/pc.json', { about: 'http:&#x2F;&#x2F;patrickcollison.com<p>I&#x27;m one of Stripe&#x27;s cofounders.', created: 1171868090, id: 'pc', karma: 17202, submitted: [1, 2, 3] }]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const { findings, threads } = await hackerNewsConnector.run(handleTask('pc', 'hacker news handle proven on Keybase by the same account holder'), ctxFor(subject));
    expect(calls).toHaveLength(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: 'identity', severity: 'info', date: '2007-02-19', url: 'https://news.ycombinator.com/user?id=pc',
      title: 'Hacker News account pc (self-described): created 2007-02-19, karma 17,202',
      quote: "http://patrickcollison.com I'm one of Stripe's cofounders.",
      match: 'likely',
    });
    expect(findings[0].matchReasons).toEqual(['reached through the handle pc', 'names Stripe']);
    expect(findings[0].data).toEqual({ handle: 'pc', karma: 17202, createdAt: '2007-02-19' });
    expect(threads.map((t) => [t.kind, t.value, t.trusted])).toEqual([['domain', 'patrickcollison.com', true]]);
  });

  test('an account that says nothing about the person stays possible; a handle nobody holds gives nothing', async () => {
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    network([['v0/user/pc.json', { about: 'I like trains. https://trains.example', created: 1171868090, id: 'pc', karma: 12 }]]);
    const { findings, threads } = await hackerNewsConnector.run(handleTask('pc'), ctxFor(subject));
    expect(findings[0].match).toBe('possible');
    expect(threads).toEqual([]);

    network([['v0/user/', 'null']]);
    expect(await hackerNewsConnector.run(handleTask('nobody'), ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
  });

  test('the source failing is an error', async () => {
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    network([['hn.algolia.com', { status: 500, body: '<title>500 Internal Server Error</title>' }], ['firebaseio.com', { status: 500, body: 'x' }]]);
    await expect(hackerNewsConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
    await expect(hackerNewsConnector.run(companyTask('Nikola'), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
    await expect(hackerNewsConnector.run(handleTask('pc'), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
  });
});

/* -------------------------------------------------------- linked accounts */

describe('linked accounts (Keybase identity proofs)', () => {
  test('lists the accounts and websites the holder of a handle has proven, and follows them when tied to the subject', async () => {
    const calls = network([['keybase.io/_/api/1.0/user/lookup.json', kbPc]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const { findings, threads, notes } = await linkedAccountsConnector.run(handleTask('pc', 'github handle'), ctxFor(subject));

    expect(linkedAccountsConnector.id).toBe('linked-accounts');
    expect(linkedAccountsConnector.kinds).toEqual(['handle']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('github=pc');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: 'linked-accounts', category: 'identity', severity: 'info', match: 'confirmed', date: '2014-03-20', url: 'https://keybase.io/pc',
      title: 'Keybase account pc (self-described: name "Patrick Collison", bio "Stripe"): proven control of X patrickc, GitHub pc, website patrickcollison.com',
    });
    expect(findings[0].data.links).toEqual([
      { service: 'X', name: 'patrickc', url: 'https://twitter.com/patrickc' },
      { service: 'GitHub', name: 'pc', url: 'https://github.com/pc' },
      { service: 'website', name: 'patrickcollison.com', url: 'http://patrickcollison.com' },
    ]);
    expect(JSON.stringify(findings)).not.toMatch(/San Francisco|oldaccount/); // no location; a proof that no longer verifies is not listed
    expect(threads.map((t) => [t.kind, t.value, t.trusted])).toEqual([['handle', 'patrickc', true], ['domain', 'patrickcollison.com', true]]);
    expect(notes).toEqual([]);
  });

  test('without a hint of which service the handle is from, each is tried', async () => {
    const calls = network([['lookup.json', (url) => (url.includes('twitter=') ? kbPc : { status: { code: 0, name: 'OK' }, them: [] })]]);
    const subject = createSubject({ name: 'Patrick Collison' });
    const { findings, threads } = await linkedAccountsConnector.run(handleTask('patrickc'), ctxFor(subject));
    expect(calls.map((u) => u.match(/\?(\w+)=/)[1]).sort()).toEqual(['github', 'hackernews', 'twitter']);
    // name only, no known company or website: possible, and nothing is followed
    expect(findings.map((f) => f.match)).toEqual(['possible']);
    expect(threads).toEqual([]);
  });

  test('an account under another name is left out with a note; no account gives nothing', async () => {
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    network([['lookup.json', kbPc]]);
    const other = await linkedAccountsConnector.run(handleTask('pc', 'github handle'), ctxFor(subject));
    expect(other.findings).toEqual([]);
    expect(other.threads).toEqual([]);
    expect(other.notes).toEqual(['The Keybase account linked to the handle "pc" states a different name and was left out.']);

    network([['lookup.json', { status: { code: 0, name: 'OK' }, them: [] }]]);
    expect(await linkedAccountsConnector.run(handleTask('pc', 'x handle'), ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
  });

  test('the source failing or refusing is an error', async () => {
    const subject = createSubject({ name: 'Patrick Collison' });
    network([['lookup.json', { status: 500, body: 'x' }]]);
    await expect(linkedAccountsConnector.run(handleTask('pc'), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
    network([['lookup.json', { status: { code: 100, name: 'INPUT_ERROR' } }]]);
    await expect(linkedAccountsConnector.run(handleTask('pc', 'github handle'), ctxFor(subject))).rejects.toThrow(/INPUT_ERROR/);
  });
});
