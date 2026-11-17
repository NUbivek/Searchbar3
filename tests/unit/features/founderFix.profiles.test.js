/**
 * Fixes in sources/profiles.js: an unnamed account reached by a handle from
 * another service is not tied to the subject on a company mention alone, an
 * account stating the subject's family name with another given name is left
 * out, and e-mail addresses in a bio never reach the stored grading text.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const {
  githubConnector, hackerNewsConnector, linkedAccountsConnector, __resetProfilesForTests,
} = require('../../../src/server/founder/sources/profiles');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const handleTask = (handle, why = '', extra = {}) => ({ kind: 'handle', value: handle, template: null, params: null, depth: 1, relation: null, why, ...extra });

function network(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) return { status: 200, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    }
    return { status: 404, headers: new Map(), url, text: async () => '{"message":"Not Found"}' };
  });
  return calls;
}

beforeEach(() => __resetProfilesForTests());
afterEach(() => setTransport());

const gh = (over) => ({
  login: 'patrickc', type: 'User', name: null, company: '@stripe', blog: 'https://someone.example', bio: 'Engineer @stripe', twitter_username: 'someone_else',
  public_repos: 3, followers: 1, created_at: '2015-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
});

describe('an unnamed account reached by a handle from another service', () => {
  test('an X handle looked up on GitHub: a company mention alone stays possible and nothing is followed', async () => {
    network([['users/patrickc', gh()]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    for (const task of [
      handleTask('patrickc', 'x handle listed on Wikidata', { platform: 'x' }),
      handleTask('patrickc', 'X handle linked from a profile tied to the person'),
      handleTask('patrickc', 'x handle linked from their GitHub profile'),
      handleTask('patrickc'), // service not known
    ]) {
      const { findings, threads } = await githubConnector.run(task, ctxFor(subject));
      expect(findings.map((f) => f.match)).toEqual(['possible']);
      expect(findings[0].matchReasons[0]).toMatch(/may belong to someone else/);
      expect(threads).toEqual([]);
    }
  });

  test('the same account reached through a GitHub handle is likely', async () => {
    network([['users/patrickc', gh()]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const byWhy = await githubConnector.run(handleTask('patrickc', 'github handle listed on Wikidata'), ctxFor(subject));
    expect(byWhy.findings[0].match).toBe('likely');
    const byPlatform = await githubConnector.run(handleTask('patrickc', '', { platform: 'github' }), ctxFor(subject));
    expect(byPlatform.findings[0].match).toBe('likely');
    expect(byPlatform.threads.length).toBeGreaterThan(0);
  });

  test('from another service, a link back to a known website or handle of the subject still ties it', async () => {
    network([['users/patrickc', gh({ blog: 'https://patrickcollison.com' })]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    addAnchor(subject, 'domains', 'patrickcollison.com');
    const { findings } = await githubConnector.run(handleTask('patrickc', 'x handle'), ctxFor(subject));
    expect(findings[0].match).toBe('likely');
    expect(findings[0].matchReasons).toEqual(['reached through the handle patrickc', 'names patrickcollison.com']);
  });

  test('Hacker News: an X handle that names only the company stays possible', async () => {
    network([['v0/user/patrickc.json', { about: "I'm an engineer at Stripe. https://mine.example", created: 1171868090, id: 'patrickc', karma: 3 }]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const cross = await hackerNewsConnector.run(handleTask('patrickc', 'x handle'), ctxFor(subject));
    expect(cross.findings[0].match).toBe('possible');
    expect(cross.threads).toEqual([]);
    const same = await hackerNewsConnector.run(handleTask('patrickc', 'hacker news handle proven on Keybase by the same account holder'), ctxFor(subject));
    expect(same.findings[0].match).toBe('likely');
  });

  test('Keybase: without knowing the service, a company in the bio alone stays possible', async () => {
    const kb = { status: { code: 0, name: 'OK' }, them: [{ basics: { username: 'pcx', ctime: 1395281756 }, profile: { full_name: '', bio: 'Stripe' }, proofs_summary: { all: [{ proof_type: 'twitter', nametag: 'patrickc', state: 1, service_url: 'https://twitter.com/patrickc' }] } }] };
    network([['lookup.json', kb]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const unknown = await linkedAccountsConnector.run(handleTask('patrickc'), ctxFor(subject));
    expect(unknown.findings.map((f) => f.match)).toEqual(['possible']);
    expect(unknown.threads).toEqual([]);
    const known = await linkedAccountsConnector.run(handleTask('patrickc', 'x handle'), ctxFor(subject));
    expect(known.findings.map((f) => f.match)).toEqual(['likely']);
  });
});

describe('an account under the same family name and another given name', () => {
  test('John Collison reached through the handle "collison" is not the subject', async () => {
    network([['users/collison', gh({ login: 'collison', name: 'John Collison', company: '@stripe', bio: null, blog: 'https://johncollison.example' })]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const result = await githubConnector.run(handleTask('collison', 'github handle'), ctxFor(subject));
    expect(result.findings).toEqual([]);
    expect(result.threads).toEqual([]);
    expect(result.notes).toEqual(['The GitHub account "collison" states a different name and was left out.']);
  });

  test('a short form, an initial, a middle-name-first or a reversed name is not ruled out', async () => {
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    for (const name of ['Pat Collison', 'P Collison', 'J. Patrick Collison', 'Collison Patrick']) {
      __resetProfilesForTests();
      network([['users/pc', gh({ login: 'pc', name })]]);
      const { findings } = await githubConnector.run(handleTask('pc', 'github handle'), ctxFor(subject));
      expect(findings).toHaveLength(1);
    }
    const bill = createSubject({ name: 'William Gates' });
    __resetProfilesForTests();
    network([['users/bg', gh({ login: 'bg', name: 'Bill Gates', company: null, bio: null })]]);
    expect((await githubConnector.run(handleTask('bg', 'github handle'), ctxFor(bill))).findings).toHaveLength(1);
  });

  test('Keybase: a sibling under the same family name is left out', async () => {
    const kb = { status: { code: 0, name: 'OK' }, them: [{ basics: { username: 'jc', ctime: 1395281756 }, profile: { full_name: 'John Collison', bio: 'Stripe' }, proofs_summary: { all: [{ proof_type: 'github', nametag: 'jc', state: 1, service_url: 'https://github.com/jc' }] } }] };
    network([['lookup.json', kb]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const result = await linkedAccountsConnector.run(handleTask('jc', 'github handle'), ctxFor(subject));
    expect(result.findings).toEqual([]);
    expect(result.notes).toHaveLength(1);
  });
});

describe('privacy', () => {
  test('an e-mail address in a bio is not kept in the text the grade is read from', async () => {
    network([['users/pc', gh({ login: 'pc', name: 'Patrick Collison', company: 'Stripe', bio: 'Write to patrick.other@example.com', blog: '' })]]);
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const result = await githubConnector.run(handleTask('pc', 'github handle'), ctxFor(subject));
    expect(result.findings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/patrick\.other@/);
  });
});
