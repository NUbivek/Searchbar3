/**
 * @jest-environment node
 *
 * The person's public footprint beyond GitHub and scholarly records
 * (presence.js): Semantic Scholar, Stack Overflow, npm, Bluesky, Mastodon and
 * Medium/Substack feeds. Identity grading (a name alone stays possible, no
 * source sets 'confirmed' by hand), company records, empty answers, failures
 * and robots.txt. No network: fixtures follow the shapes these services
 * answered with on 2026-11-20.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const {
  semanticScholarConnector, stackOverflowConnector, npmPackagesConnector, blueskyConnector, mastodonConnector, writingFeedsConnector,
  __resetPresenceForTests, statedName, mastodonAddress, feedFor, parseFeed,
} = require('../../../src/server/founder/sources/presence');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const task = (kind, value, extra = {}) => ({ kind, value, template: null, params: null, depth: 1, relation: null, ...extra });
const newSubject = () => createSubject({ name: 'Patrick Collison', company: 'Stripe' });

/** Fake network: the first route whose pattern is in the URL answers; { status, body } sets the status. */
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
    return { status: 404, headers: new Map(), url, text: async () => 'Not Found' };
  });
  return calls;
}

beforeEach(() => __resetPresenceForTests());
afterEach(() => setTransport());

/* -------------------------------------------------------------- fixtures */

const seUser = (id, name, extra = {}) => ({
  badge_counts: { bronze: 1, silver: 0, gold: 0 }, account_id: id + 100, is_employee: false, last_access_date: 1616011245,
  reputation: 11, creation_date: 1361065364, user_type: 'registered', user_id: id, location: 'Somewhere, CA',
  link: `https://stackoverflow.com/users/${id}/${name.toLowerCase().replace(/\s+/g, '-')}`, profile_image: 'https://www.gravatar.com/avatar/x', display_name: name, ...extra,
});
const seList = (...items) => ({ items, has_more: false, quota_max: 300, quota_remaining: 294 });

const bskyActor = (handle, displayName, description = '', extra = {}) => ({
  did: `did:plc:${handle.replace(/[^a-z0-9]/g, '').slice(0, 20)}`, handle, displayName, avatar: 'https://cdn.bsky.app/img/avatar/plain/x', associated: { chat: { allowIncoming: 'all' } },
  labels: [], createdAt: '2023-04-30T01:31:13.351Z', description, indexedAt: '2026-11-19T23:49:16.346Z', ...extra,
});
const bskyPost = (did, handle, rkey, text, createdAt = '2026-11-06T18:08:29.879Z', reason) => ({
  post: {
    uri: `at://${did}/app.bsky.feed.post/${rkey}`, cid: 'bafyrei', author: { did, handle, displayName: 'Patrick Collison' },
    record: { $type: 'app.bsky.feed.post', createdAt, langs: ['en'], text }, likeCount: 12, repostCount: 3, replyCount: 1,
  },
  ...(reason ? { reason } : {}),
});

const npmObject = (name, maintainers, repo, monthly, date = '2025-01-01T00:00:00.000Z') => ({
  downloads: { monthly, weekly: Math.round(monthly / 4) }, dependents: '10', updated: date, searchScore: 50,
  package: {
    name, version: '1.0.0', description: `${name} does things`, sanitized_name: name,
    publisher: { email: 'private@example.com', username: maintainers[0] },
    maintainers: maintainers.map((u) => ({ email: `${u}@example.com`, username: u })), license: 'MIT', date,
    links: { homepage: `https://github.com/${repo}/${name}#readme`, repository: `git+https://github.com/${repo}/${name}.git`, npm: `https://www.npmjs.com/package/${name}` },
  },
});

const s2Author = (authorId, name, extra = {}) => ({
  authorId, externalIds: {}, url: `https://www.semanticscholar.org/author/${authorId}`, name, affiliations: [], homepage: null,
  paperCount: 2, citationCount: 3, hIndex: 1, papers: [{ paperId: 'p1', title: 'On payments', year: 2019, venue: '' }], ...extra,
});

const mediumFeed = `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0"><channel>
<title><![CDATA[Stories by Patrick Collison on Medium]]></title><link>https://medium.com/@patrickc?source=rss</link>
<item><title><![CDATA[Why Stripe settled the lawsuit]]></title><link>https://medium.com/@patrickc/why-stripe-settled-0126fa5c6ce8?source=rss-268314bb7e7e------2</link>
<dc:creator><![CDATA[Patrick Collison]]></dc:creator><pubDate>Thu, 12 Dec 2024 17:11:33 GMT</pubDate>
<content:encoded><![CDATA[<p>We settled the lawsuit with the vendor. Email me at pc@example.com.</p>]]></content:encoded></item>
<item><title><![CDATA[Fast]]></title><link>https://medium.com/@patrickc/fast-1</link><dc:creator><![CDATA[Patrick Collison]]></dc:creator><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate><description><![CDATA[Notes on speed.]]></description></item>
</channel></rss>`;

/* ------------------------------------------------------------- helpers */

describe('statedName', () => {
  test('full name, another person, and a name that cannot be told', () => {
    const subject = newSubject();
    expect(statedName(subject, 'Patrick Collison')).toBe('same');
    expect(statedName(subject, 'Patrick Monahan')).toBe('other');
    expect(statedName(subject, 'Pat Collison')).toBe('unknown');
    expect(statedName(subject, 'pc')).toBe('unknown');
  });

  test('Mastodon addresses and writing feeds are read only from their own forms', () => {
    expect(mastodonAddress('@Gargron@mastodon.social', 'handle')).toEqual({ user: 'Gargron', host: 'mastodon.social' });
    expect(mastodonAddress('https://mastodon.social/@Gargron', 'url')).toEqual({ user: 'Gargron', host: 'mastodon.social' });
    expect(mastodonAddress('https://medium.com/@ev', 'url')).toBeNull();
    expect(mastodonAddress('gargron', 'handle')).toBeNull();
    expect(feedFor('https://medium.com/@ev')).toEqual({ platform: 'Medium', page: 'https://medium.com/@ev', feed: 'https://medium.com/feed/@ev' });
    expect(feedFor('https://noahpinion.substack.com')).toMatchObject({ platform: 'Substack', feed: 'https://noahpinion.substack.com/feed' });
    expect(feedFor('https://example.com/blog')).toBeNull();
    expect(parseFeed('<html>nope</html>')).toBeNull();
  });
});

/* ------------------------------------------------------- Stack Overflow */

describe('stack-overflow', () => {
  test('a profile naming their company is graded by the record itself; a namesake stays possible; another name is dropped', async () => {
    const subject = newSubject();
    const calls = network([['api.stackexchange.com/2.3/users?inname=', seList(
      seUser(1, 'Patrick Collison', { reputation: 6400, about_me: '<p>Co-founder and CEO of Stripe. Reach me at pc@example.com</p>', website_url: 'https://patrickcollison.com' }),
      seUser(2, 'Patrick Collison', { reputation: 1 }),
      seUser(3, 'Patrick Monahan', { reputation: 900 }),
    )]]);
    const out = await stackOverflowConnector.run(task('subject', 'Patrick Collison'), ctxFor(subject));
    expect(calls[0]).toContain('filter=');
    expect(out.findings).toHaveLength(2);
    const [tied, namesake] = out.findings;
    // R3: a self-described account found by the name is 'likely' at most, and the cap is kept on a re-grade
    expect(tied.match).toBe('likely');
    expect(tied.matchFixed).toBe(true);
    expect(tied.matchReasons.join(' ')).toMatch(/self-described/);
    expect(tied.quote).not.toMatch(/example\.com|Somewhere/);
    expect(tied.title).toMatch(/self-described/);
    expect(namesake.match).toBe('possible');
    expect(out.findings.some((f) => /Monahan/.test(f.title))).toBe(false);
    expect(out.threads).toEqual([expect.objectContaining({ kind: 'domain', value: 'patrickcollison.com', trusted: true })]);
  });

  test('an empty answer is no finding and no claim of a clean record', async () => {
    network([['api.stackexchange.com', seList()]]);
    const out = await stackOverflowConnector.run(task('subject', 'Patrick Collison'), ctxFor(newSubject()));
    expect(out).toEqual({ findings: [], threads: [], notes: [] });
  });

  test('a refused lookup surfaces as an error', async () => {
    network([['api.stackexchange.com', { status: 400, body: { error_id: 502, error_message: 'too many requests from this IP', error_name: 'throttle_violation' } }]]);
    await expect(stackOverflowConnector.run(task('subject', 'Patrick Collison'), ctxFor(newSubject()))).rejects.toThrow(/HTTP 400/);
  });

  test('the exact account a tied record links to is likely; other links are ignored without a request', async () => {
    const calls = network([['api.stackexchange.com/2.3/users/77', seList(seUser(77, 'Patrick Collison'))]]);
    const out = await stackOverflowConnector.run(task('url', 'https://stackoverflow.com/users/77/patrick-collison'), ctxFor(newSubject()));
    expect(out.findings[0].match).toBe('likely');
    const none = await stackOverflowConnector.run(task('url', 'https://example.com/users/77'), ctxFor(newSubject()));
    expect(none.findings).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------- Semantic Scholar */

describe('semantic-scholar', () => {
  test('only full-name records are kept, ranked; an initial alone is not the person', async () => {
    const subject = newSubject();
    network([['api.semanticscholar.org/graph/v1/author/search', { total: 3, offset: 0, data: [
      s2Author('2241153205', 'P. Collison', { citationCount: 24259 }),
      s2Author('33015059', 'P. Collison', { externalIds: { DBLP: ['Patrick Collison'] }, affiliations: ['Stripe'], citationCount: 121, paperCount: 5 }),
      s2Author('2408767146', 'Patrick Collison'),
    ] }]]);
    const out = await semanticScholarConnector.run(task('subject', 'Patrick Collison'), ctxFor(subject));
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0].match).toBe('likely'); // R3: the record's own affiliation names the company; self-described, so 'likely' at most
    expect(out.findings[0].title).toMatch(/121 citations/);
    expect(out.findings[1].match).toBe('possible');
    expect(out.findings.some((f) => /24,259/.test(f.title))).toBe(false);
  });

  test('a school alone does not lift one of several namesakes', async () => {
    const subject = newSubject();
    addAnchor(subject, 'schools', 'MIT');
    network([['api.semanticscholar.org', { total: 2, data: [s2Author('1', 'Patrick Collison', { affiliations: ['MIT'] }), s2Author('2', 'Patrick Collison')] }]]);
    const out = await semanticScholarConnector.run(task('subject', 'Patrick Collison'), ctxFor(subject));
    expect(out.findings.every((f) => f.match === 'possible')).toBe(true);
    expect(out.findings[0].matchFixed).toBe(true);
  });

  test('a busy service is an error, not a clean result', async () => {
    network([['api.semanticscholar.org', { status: 429, body: { message: 'Too Many Requests.', code: '429' } }]]);
    await expect(semanticScholarConnector.run(task('subject', 'Patrick Collison'), ctxFor(newSubject()))).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------- npm */

describe('npm-packages', () => {
  test("a GitHub handle's npm account is tied when its packages live under that GitHub account", async () => {
    const subject = newSubject();
    const calls = network([['registry.npmjs.org/-/v1/search', { objects: [
      npmObject('stripe-tool', ['pc', 'other'], 'pc', 5000),
      npmObject('helper', ['pc'], 'pc', 50000, '2026-02-01T00:00:00.000Z'),
      npmObject('lookalike', ['pcx'], 'pcx', 999999),
    ], total: 3 }]]);
    const out = await npmPackagesConnector.run(task('handle', 'pc', { platform: 'github' }), ctxFor(subject));
    expect(calls[0]).toContain('maintainer%3Apc');
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.match).toBe('likely');
    expect(f.title).toMatch(/maintains 2 packages/);
    expect(f.title).toMatch(/most used: helper, stripe-tool/);
    expect(JSON.stringify(f)).not.toMatch(/example\.com/);
  });

  test('the same handle on npm with nothing tying it to the person is left out', async () => {
    network([['registry.npmjs.org', { objects: [npmObject('thing', ['pc'], 'someoneelse', 10)], total: 1 }]]);
    const out = await npmPackagesConnector.run(task('handle', 'pc', { platform: 'x' }), ctxFor(newSubject()));
    expect(out.findings).toEqual([]);
  });
});

/* ---------------------------------------------------------------- Bluesky */

describe('bluesky', () => {
  test('found by name: possible only, even when the bio claims the company; other names dropped', async () => {
    network([['app.bsky.actor.searchActors', { actors: [
      bskyActor('pattymo.com', 'Patrick Monahan', 'cannot stress enough that I am not the Train guy.'),
      bskyActor('pcollison.bsky.social', 'Patrick Collison', 'CEO of Stripe'),
    ] }]]);
    const out = await blueskyConnector.run(task('subject', 'Patrick Collison'), ctxFor(newSubject()));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.threads).toEqual([]);
  });

  test('the exact profile a tied record links to is likely, with its own posts that name the company', async () => {
    const subject = newSubject();
    const did = 'did:plc:oky5czdrnfjpqslsw2a5iclo';
    const profile = { ...bskyActor('patrickcollison.com', 'Patrick Collison', 'Stripe.'), did, followersCount: 50000, postsCount: 300 };
    const calls = network([
      ['app.bsky.actor.getProfile', profile],
      ['app.bsky.feed.getAuthorFeed', { feed: [
        bskyPost(did, 'patrickcollison.com', '3mznxzxtqns2k', 'Stripe processed a record volume this year.'),
        bskyPost(did, 'patrickcollison.com', '3mznxzxtqns2l', 'good fall colors'),
        bskyPost('did:plc:someoneelse', 'other.bsky.social', '3mznxzxtqns2m', 'Stripe is sued, reposted', undefined, { $type: 'app.bsky.feed.defs#reasonRepost' }),
      ] }],
    ]);
    const out = await blueskyConnector.run(task('url', 'https://bsky.app/profile/patrickcollison.com'), ctxFor(subject));
    expect(calls[0]).toContain('actor=patrickcollison.com');
    const [account, post, ...rest] = out.findings;
    expect(['likely', 'confirmed']).toContain(account.match);
    expect(post.category).toBe('press');
    expect(post.match).toBe('likely');
    expect(post.url).toBe('https://bsky.app/profile/patrickcollison.com/post/3mznxzxtqns2k');
    expect(rest).toEqual([]);
    expect(out.threads).toEqual([expect.objectContaining({ kind: 'domain', value: 'patrickcollison.com', trusted: true })]);
  });

  test("a company's own account (handle is its known website) is a company record", async () => {
    const subject = newSubject();
    addAnchor(subject, 'domains', 'stripe.com');
    network([['app.bsky.actor.searchActors', { actors: [bskyActor('stripe.com', 'Stripe', 'Financial infrastructure for the internet.'), bskyActor('stripefan.bsky.social', 'Stripe fan')] }]]);
    const out = await blueskyConnector.run(task('company', 'Stripe, Inc.'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
    expect(out.findings[0].url).toBe('https://bsky.app/profile/stripe.com');
  });

  test("a one-word company name that is also a person's name never pins a stranger's account as the company's", async () => {
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    network([['app.bsky.actor.searchActors', { actors: [
      bskyActor('nikola.dev', 'Nikola Petrov', 'I write Rust.'),
      bskyActor('nikola.com', 'Nikola'), // no known website: a one-word name alone does not tell
    ] }]]);
    const out = await blueskyConnector.run(task('company', 'Nikola'), ctxFor(subject));
    expect(out.findings).toEqual([]);
  });

  test('a company of several words needs its exact name on the handle and the display name', async () => {
    const subject = createSubject({ name: 'Jane Doe', company: 'Acme Robotics, Inc.' });
    network([['app.bsky.actor.searchActors', { actors: [
      bskyActor('acmerobotics.com', 'Acme Robotics Inc.'),
      bskyActor('acmerobotics.dev', 'Acme Robotics fan club'),
    ] }]]);
    const out = await blueskyConnector.run(task('company', 'Acme Robotics, Inc.'), ctxFor(subject));
    expect(out.findings.map((f) => f.url)).toEqual(['https://bsky.app/profile/acmerobotics.com']);
    expect(out.findings[0].match).toBe('company');
  });

  test('a handle nobody holds is no finding; a server error is an error', async () => {
    network([['app.bsky.actor.getProfile', { status: 400, body: { error: 'InvalidRequest', message: 'Profile not found' } }]]);
    const none = await blueskyConnector.run(task('handle', 'pcollison', { platform: 'github' }), ctxFor(newSubject()));
    expect(none.findings).toEqual([]);
    network([['app.bsky.actor.getProfile', { status: 502, body: 'Bad Gateway' }]]);
    await expect(blueskyConnector.run(task('handle', 'pcollison', { platform: 'github' }), ctxFor(newSubject()))).rejects.toThrow(/HTTP 502/);
  });
});

/* --------------------------------------------------------------- Mastodon */

describe('mastodon', () => {
  const account = {
    id: '1', username: 'pc', acct: 'pc', display_name: 'Patrick Collison', created_at: '2016-03-16T00:00:00.000Z',
    note: '<p>Building Stripe.</p>', url: 'https://mastodon.social/@pc', followers_count: 1200, statuses_count: 80,
    fields: [
      { name: 'Site', value: '<a href="https://patrickcollison.com" rel="nofollow noopener me"><span class="invisible">https://</span><span>patrickcollison.com</span></a>', verified_at: '2024-07-06T01:06:10.801+00:00' },
      { name: 'Unchecked', value: '<a href="https://unchecked.example">unchecked.example</a>', verified_at: null },
    ],
  };

  test('reads a profile when robots.txt allows it, follows only the links the server checked', async () => {
    network([['mastodon.social/robots.txt', 'User-agent: *\nDisallow: /media_proxy/\n'], ['mastodon.social/api/v1/accounts/lookup', account]]);
    const out = await mastodonConnector.run(task('handle', '@pc@mastodon.social'), ctxFor(newSubject()));
    expect(out.findings).toHaveLength(1);
    expect(['likely', 'confirmed']).toContain(out.findings[0].match);
    expect(out.threads.map((t) => t.value)).toEqual(['patrickcollison.com']);
    expect(out.findings[0].title).toMatch(/^Mastodon account @pc on mastodon\.social /); // not mistaken for an e-mail address and removed
  });

  test('a server whose robots.txt forbids it is not read, and says so', async () => {
    const calls = network([['example.social/robots.txt', 'User-agent: *\nDisallow: /api/\n']]);
    const out = await mastodonConnector.run(task('url', 'https://example.social/@pc'), ctxFor(newSubject()));
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/does not allow/);
    expect(calls.some((u) => u.includes('/api/v1/'))).toBe(false);
  });

  test("an account stating someone else's name is left out", async () => {
    network([['robots.txt', { status: 404, body: '' }], ['accounts/lookup', { ...account, display_name: 'Eugen Rochko' }]]);
    const out = await mastodonConnector.run(task('handle', 'pc@mastodon.social'), ctxFor(newSubject()));
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/different name/);
  });
});

/* ------------------------------------------------------------ writing feeds */

describe('writing-feeds', () => {
  test("a Medium page's posts become the person's own writing, with contact details removed", async () => {
    network([['medium.com/robots.txt', 'User-Agent: *\nDisallow: /m/\n'], ['medium.com/feed/@patrickc', mediumFeed]]);
    const out = await writingFeedsConnector.run(task('url', 'https://medium.com/@patrickc', { platform: 'medium' }), ctxFor(newSubject()));
    expect(out.findings).toHaveLength(2);
    const [first] = out.findings;
    expect(first.match).toBe('likely');
    expect(first.severity).toBe('medium');
    expect(first.url).toBe('https://medium.com/@patrickc/why-stripe-settled-0126fa5c6ce8');
    expect(first.quote).not.toMatch(/example\.com/);
    expect(first.title).toMatch(/Medium post by Patrick Collison/);
  });

  test('a robots.txt that cannot be read is a retryable failure, not a "does not allow" note, and is asked again', async () => {
    const calls = network([['medium.com/robots.txt', { status: 503, body: 'Service Unavailable' }]]);
    const run = () => writingFeedsConnector.run(task('url', 'https://medium.com/@patrickc'), ctxFor(newSubject()));
    const error = await run().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/^HTTP 503 \(reading the robots\.txt of medium\.com\)/);
    expect(calls.some((u) => u.includes('/feed/'))).toBe(false);
    // Not remembered: once robots.txt answers, the feed is read.
    network([['medium.com/robots.txt', 'User-Agent: *\nDisallow: /m/\n'], ['medium.com/feed/@patrickc', mediumFeed]]);
    const out = await run();
    expect(out.findings).toHaveLength(2);
    expect(out.notes).toEqual([]);
  });

  test('a lookup started too close to the deadline keeps the "Out of time" message so it is run again', async () => {
    network([['robots.txt', 'User-agent: *\nAllow: /\n']]);
    const ctx = { ...ctxFor(newSubject()), deadline: Date.now() + 100 };
    const error = await mastodonConnector.run(task('handle', '@pc@mastodon.social'), ctx).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^Out of time/);
    expect(error.retryable).toBe(true);
  });

  test("a page written by someone else is left out", async () => {
    network([['robots.txt', { status: 404, body: '' }], ['/feed', mediumFeed.replace(/Patrick Collison/g, 'Ev Williams')]]);
    const out = await writingFeedsConnector.run(task('url', 'https://medium.com/@ev'), ctxFor(newSubject()));
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/not the person/);
  });

  test('a page that does not answer with a feed is an error', async () => {
    network([['robots.txt', { status: 404, body: '' }], ['substack.com/feed', '<html>Just a moment</html>']]);
    await expect(writingFeedsConnector.run(task('url', 'https://someone.substack.com'), ctxFor(newSubject()))).rejects.toThrow(/did not answer with a feed/);
  });
});

/* ------------------------------------------------------------- contract */

test('every connector obeys the source contract', () => {
  const BANNED = /\b(api|endpoint|api key|token|free|paid|tier|env)\b/i;
  const all = [semanticScholarConnector, stackOverflowConnector, npmPackagesConnector, blueskyConnector, mastodonConnector, writingFeedsConnector];
  expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  for (const c of all) {
    expect(c.id).toMatch(/^[a-z0-9-]+$/);
    expect(c.label).not.toMatch(BANNED);
    expect(c.kinds).not.toContain('relative');
    expect(c.kinds).not.toContain('associate');
  }
});
