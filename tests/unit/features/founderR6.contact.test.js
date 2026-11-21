/**
 * @jest-environment node
 *
 * Round 6, the declared contact (src/server/founder/contact.js and its users: sources/sec.js,
 * sources/regulatorsMore.js, sources/presenceMore.js, pages/api/founder/deep.js, server/auth.js debugAccess).
 *
 * The owner decided nobody should have to configure a contact: the signed-in person's name and email from
 * Google sign-in are named to the SEC's website, the FTC case search and crates.io, for the checks that person
 * runs, and to no other host. An operator setting still wins. The contact is never saved, reported or answered;
 * the page is told only where it came from ('account', 'account-sec', 'account-site', 'operator' or 'none').
 * The debug routes follow the same model as the rest of the site: whoever is signed in may use them.
 * People and addresses are invented.
 */
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn(async () => null) }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/llm/providers', () => ({
  chatComplete: jest.fn(async () => ({ text: 'ok', providerLabel: 'Model', model: 'm', ms: 5, skipped: [] })),
  chatJson: jest.fn(async () => null),
  describeChain: jest.fn(async () => ({ order: [], passedOver: [] })),
  llmStatus: jest.fn(() => []),
  PROVIDERS: [],
  providerEnabled: jest.fn(() => false),
  llmConfigured: jest.fn(() => false),
  prepareChain: jest.fn(() => Promise.resolve()),
  reportAnswerQuality: jest.fn(async () => {}),
}));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [] })) }));
// The deep route's sources: one fake that asks www.sec.gov and another host the way a real source does, and
// records what each request carried (in the test, never in a finding), and whether it saw a contact while planning.
jest.mock('../../../src/server/founder/sources', () => {
  const { request } = jest.requireActual('../../../src/server/founder/http');
  const { contactFor, requestOptionsFor, CONTACT_HOSTS } = jest.requireActual('../../../src/server/founder/contact');
  const { makeFinding } = jest.requireActual('../../../src/server/founder/finding');
  const seen = { enabled: [], runs: [] };
  return {
    __seen: seen,
    CONNECTORS: [{
      id: 'fake-contact', label: 'Fake official site', kinds: ['subject', 'company'],
      enabled: () => { const c = contactFor('site'); seen.enabled.push(c ? c.from : 'none'); return Boolean(c); },
      run: async (task, { subject }) => {
        const sec = 'https://www.sec.gov/enforcement-litigation/litigation-releases?populate=Roe';
        await request(sec, { ...requestOptionsFor('sec', CONTACT_HOSTS.sec, sec) });
        await request('https://records.example.net/search?q=Roe', { ...requestOptionsFor('sec', CONTACT_HOSTS.sec, 'https://records.example.net/') });
        seen.runs.push(task.kind);
        return { findings: [makeFinding(subject, { source: 'fake-contact', sourceLabel: 'Fake official site', category: 'regulatory', title: `${task.value}: record`, quote: `${subject.name} named in a record.`, url: 'https://records.example.net/1' })], threads: [] };
      },
    }],
  };
});

const { getServerSession } = require('next-auth/next');
const { setTransport, request } = require('../../../src/server/founder/http');
const contact = require('../../../src/server/founder/contact');
const { withSignedInContact, contactFor, contactSource, cleanContact, requestOptionsFor, CONTACT_HOSTS } = contact;
const { createSubject } = require('../../../src/server/founder/identity');
const { secPersonConnector, declaredSecAgent, __resetSecForTests } = require('../../../src/server/founder/sources/sec');
const { ftcCasesConnector, __resetRegulatorsMoreForTests } = require('../../../src/server/founder/sources/regulatorsMore');
const { cratesIoConnector, __resetPresenceMoreForTests } = require('../../../src/server/founder/sources/presenceMore');
const { __resetJobsForTests, getJob } = require('../../../src/server/founder/jobStore');
const { __resetLearningForTests } = require('../../../src/server/learning');
const sources = require('../../../src/server/founder/sources');
const deep = require('../../../src/pages/api/founder/deep').default;
const { createMockReq, createMockRes } = require('../api/testUtils');
const llmCheck = require('../../../src/pages/api/debug/llm-check').default;
const envCheck = require('../../../src/pages/api/debug/env-check').default;

const JANE = { name: 'Jane Roe', email: 'jane.roe@example.org' };
const JOHN = { name: 'John Doe', email: 'john.doe@example.com' };
const ADDRESS = /jane\.roe|john\.doe|Jane Roe|John Doe/;

const SETTINGS = ['SEC_USER_AGENT', 'FOUNDER_HTTP_CONTACT', 'FOUNDER_ALLOWED_EMAILS', 'FOUNDER_SOURCES_OFF', 'NODE_ENV', 'VERCEL_ENV'];
const saved = Object.fromEntries(SETTINGS.map((k) => [k, process.env[k]]));
const restore = () => { for (const k of SETTINGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

/** A fake network that records the User-Agent of every request and answers each from `answer(url)`. */
let calls = [];
function network(answer = () => ({ status: 200, body: '' })) {
  calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, host: new URL(url).hostname, agent: String(init?.headers?.['User-Agent'] || '') });
    const r = answer(url) || { status: 404, body: 'not found' };
    const headers = new Map(Object.entries(r.headers || {}));
    return { status: r.status, headers, url, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  });
}
const agentsTo = (host) => calls.filter((c) => c.host === host).map((c) => c.agent);
const agentsNotTo = (...hosts) => calls.filter((c) => !hosts.includes(c.host)).map((c) => c.agent);

beforeEach(() => {
  for (const k of ['SEC_USER_AGENT', 'FOUNDER_HTTP_CONTACT', 'FOUNDER_ALLOWED_EMAILS', 'FOUNDER_SOURCES_OFF', 'VERCEL_ENV']) delete process.env[k];
  process.env.NODE_ENV = 'test';
  __resetSecForTests();
  __resetRegulatorsMoreForTests();
  __resetPresenceMoreForTests();
});
afterEach(() => { setTransport(); restore(); getServerSession.mockResolvedValue(null); });

/* ------------------------------------------------------------------ the contact itself */

describe('the contact', () => {
  test('no sign-in and no setting: no contact', () => {
    expect(contactFor('sec')).toBeNull();
    expect(contactFor('site')).toBeNull();
    expect(contactSource()).toBe('none');
    expect(declaredSecAgent()).toBe('');
  });

  test('the signed-in person is the contact in scope, and only there', async () => {
    await withSignedInContact(JANE, async () => {
      await Promise.resolve();
      expect(contactFor('sec')).toEqual({ agent: 'diligence-research Jane Roe jane.roe@example.org', from: 'account' });
      expect(contactFor('site')).toEqual({ agent: 'Jane Roe jane.roe@example.org', from: 'account' });
      expect(contactSource()).toBe('account');
    });
    expect(contactFor('site')).toBeNull();
  });

  test('an operator setting wins: SEC_USER_AGENT as written, else an email in FOUNDER_HTTP_CONTACT', async () => {
    await withSignedInContact(JANE, async () => {
      process.env.SEC_USER_AGENT = 'Example Research ops@example.net';
      expect(contactFor('sec')).toEqual({ agent: 'Example Research ops@example.net', from: 'operator' });
      expect(contactFor('site')).toMatchObject({ from: 'account' });
      expect(contactSource()).toBe('account-site'); // the FTC and crates.io would still be given Jane's contact, the SEC not
      process.env.FOUNDER_HTTP_CONTACT = 'ops@example.net';
      expect(contactFor('site')).toEqual({ agent: 'ops@example.net', from: 'operator' });
      expect(contactSource()).toBe('operator');
      delete process.env.SEC_USER_AGENT;
      expect(contactFor('sec')).toEqual({ agent: 'diligence-research ops@example.net', from: 'operator' });
      // a URL in FOUNDER_HTTP_CONTACT is not an address the SEC can write to: the signed-in person is named to it
      process.env.FOUNDER_HTTP_CONTACT = 'https://example.net/contact';
      expect(contactFor('sec')).toMatchObject({ from: 'account' });
      expect(contactFor('site')).toEqual({ agent: 'https://example.net/contact', from: 'operator' });
      expect(contactSource()).toBe('account-sec'); // only the SEC is given Jane's contact
    });
  });

  test('the local test account, a malformed address or a missing one gives no contact', () => {
    for (const bad of [
      { name: 'Local test user', email: 'local-test-user@localhost' },
      { name: 'Jane Roe', email: 'jane.roe@example' },
      { name: 'Jane Roe', email: 'jane roe@example.org' },
      { name: 'Jane Roe', email: 'Jane Roe <jane.roe@example.org>' },
      { name: 'Jane Roe', email: 'jane.roe@example.org\r\nX-Other: 1' },
      { name: 'Jane Roe', email: 'jane@roe@example.org' },
      { name: 'Jane Roe', email: 'jane.roe@intranet.local' },
      { name: 'Jane Roe', email: '' },
      { name: 'Jane Roe' },
      null,
    ]) {
      expect(cleanContact(bad)).toBeNull();
      withSignedInContact(bad, () => expect(contactFor('site')).toBeNull());
    }
  });

  test('a name is cleaned: no brackets, controls or "@", at most 80 characters; a bad name leaves the address', () => {
    expect(cleanContact({ name: 'Jane (CEO) <Roe>\u0007', email: 'Jane.Roe@Example.org' })).toEqual({ name: 'Jane CEO Roe', email: 'jane.roe@example.org' });
    expect(cleanContact({ name: 'evil@example.net', email: 'jane.roe@example.org' })).toEqual({ name: '', email: 'jane.roe@example.org' });
    expect(cleanContact({ name: 'J'.repeat(200), email: 'jane.roe@example.org' }).name).toHaveLength(80);
    withSignedInContact({ name: 'x@y.z', email: 'jane.roe@example.org' }, () => expect(contactFor('site').agent).toBe('jane.roe@example.org'));
  });

  test('two checks at the same time, by different people, never see each other\'s contact', async () => {
    network(() => ({ status: 200, body: 'ok' }));
    const run = (person, waits) => withSignedInContact(person, async () => {
      const seen = [];
      for (const ms of waits) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, ms));
        seen.push(contactFor('site').agent);
        const url = `https://www.sec.gov/x?who=${person.name.split(' ')[0]}`;
        // eslint-disable-next-line no-await-in-loop
        await request(url, requestOptionsFor('sec', CONTACT_HOSTS.sec, url));
      }
      return seen;
    });
    const [jane, john] = await Promise.all([run(JANE, [5, 1, 7, 2]), run(JOHN, [1, 6, 1, 4])]);
    expect(jane.every((a) => a === 'Jane Roe jane.roe@example.org')).toBe(true);
    expect(john.every((a) => a === 'John Doe john.doe@example.com')).toBe(true);
    for (const c of calls) {
      if (c.url.includes('who=Jane')) { expect(c.agent).toMatch(/jane\.roe/); expect(c.agent).not.toMatch(/john/i); }
      if (c.url.includes('who=John')) { expect(c.agent).toMatch(/john\.doe/); expect(c.agent).not.toMatch(/jane/i); }
    }
    expect(calls).toHaveLength(8);
  });
});

/* ------------------------------------------------------------------ the SEC */

describe('the SEC', () => {
  const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
  const ctx = () => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
  const EMPTY_LIST = '<div class="view-empty"><p class="no-results-text">No results found.</p></div>';
  const emptySearch = JSON.stringify({ hits: { total: { value: 0, relation: 'eq' }, hits: [] } });
  const answer = (url) => (url.includes('efts.sec.gov') ? { status: 200, body: emptySearch } : url.includes('www.sec.gov') ? { status: 200, body: EMPTY_LIST } : { status: 200, body: 'ok' });

  test('signed in, the User-Agent to www.sec.gov carries the person; other hosts in the same check do not', async () => {
    network(answer);
    await withSignedInContact(JANE, async () => {
      expect(declaredSecAgent()).toBe('diligence-research Jane Roe jane.roe@example.org');
      await secPersonConnector.run({ kind: 'subject', value: subject.name, template: 'enforcement', depth: 0 }, ctx());
      await secPersonConnector.run({ kind: 'subject', value: subject.name, template: 'all', depth: 0 }, ctx());
      await request('https://records.example.net/a');
    });
    expect(agentsTo('www.sec.gov').length).toBeGreaterThan(0);
    for (const a of agentsTo('www.sec.gov')) expect(a).toBe('diligence-research Jane Roe jane.roe@example.org');
    expect(agentsTo('efts.sec.gov').length).toBeGreaterThan(0);
    for (const a of agentsNotTo('www.sec.gov')) expect(a).not.toMatch(ADDRESS);
  });

  test('without a contact www.sec.gov is not asked and the lookup is reported as not answered', async () => {
    network(answer);
    await expect(secPersonConnector.run({ kind: 'subject', value: subject.name, template: 'enforcement', depth: 0 }, ctx())).rejects.toThrow(/declare a contact/);
    expect(agentsTo('www.sec.gov')).toEqual([]);
  });

  test('an operator setting wins, and then no account address is sent anywhere', async () => {
    process.env.SEC_USER_AGENT = 'Example Research ops@example.net';
    process.env.FOUNDER_HTTP_CONTACT = 'ops@example.net';
    network(answer);
    await withSignedInContact(JANE, async () => {
      await secPersonConnector.run({ kind: 'subject', value: subject.name, template: 'enforcement', depth: 0 }, ctx());
      await secPersonConnector.run({ kind: 'subject', value: subject.name, template: 'all', depth: 0 }, ctx());
    });
    for (const a of agentsTo('www.sec.gov')) expect(a).toBe('Example Research ops@example.net');
    for (const c of calls) expect(c.agent).not.toMatch(ADDRESS);
  });

  test('a redirect from www.sec.gov to another host is not followed with the person\'s contact', async () => {
    network((url) => (url.includes('www.sec.gov') ? { status: 302, headers: { location: 'https://elsewhere.example.net/page' }, body: '' } : { status: 200, body: 'ok' }));
    await withSignedInContact(JANE, async () => {
      const url = 'https://www.sec.gov/Archives/x.htm';
      await expect(request(url, requestOptionsFor('sec', CONTACT_HOSTS.sec, url))).rejects.toMatchObject({ code: 'refused' });
    });
    expect(calls.map((c) => c.host)).toEqual(['www.sec.gov']);
  });
});

/* ------------------------------------------------------------------ the FTC and crates.io */

describe('the FTC and crates.io', () => {
  const FTC_EMPTY = '<html><body><div class="main"><div class="view-empty"><p>No results found for these filters.</p></div><div class="view-results-info"></div></div></body></html>';

  test('both are on with an account contact and off without any', async () => {
    expect(ftcCasesConnector.enabled()).toBe(false);
    expect(cratesIoConnector.enabled()).toBe(false);
    await withSignedInContact(JANE, async () => {
      expect(ftcCasesConnector.enabled()).toBe(true);
      expect(cratesIoConnector.enabled()).toBe(true);
      process.env.FOUNDER_SOURCES_OFF = 'ftc-cases';
      expect(ftcCasesConnector.enabled()).toBe(false);
    });
    withSignedInContact({ name: 'Local test user', email: 'local-test-user@localhost' }, () => {
      expect(ftcCasesConnector.enabled()).toBe(false);
      expect(cratesIoConnector.enabled()).toBe(false);
    });
  });

  test('the FTC search carries the person to www.ftc.gov only', async () => {
    network((url) => (url.includes('www.ftc.gov') ? { status: 200, body: FTC_EMPTY } : { status: 200, body: 'ok' }));
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    await withSignedInContact(JANE, async () => {
      const out = await ftcCasesConnector.run({ kind: 'subject', value: subject.name, template: 'ftc.person', why: 'test', depth: 0 }, { subject, deadline: Date.now() + 20000, findings: () => [] });
      expect(JSON.stringify(out)).not.toMatch(/jane\.roe/);
      await request('https://records.example.net/b');
    });
    expect(agentsTo('www.ftc.gov')).toEqual(['diligence-research/1.0 (automated public-records lookup; +Jane Roe jane.roe@example.org)']);
    for (const a of agentsNotTo('www.ftc.gov')) expect(a).not.toMatch(ADDRESS);
  });

  test('crates.io carries the person to crates.io only; with the operator\'s contact no account address is sent', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const answer = (url) => (url.includes('/users/janeroe') ? { status: 200, body: { user: { id: 7, login: 'janeroe', name: 'Jane Roe' } } }
      : url.includes('/crates?user_id=7') ? { status: 200, body: { crates: [{ name: 'roe-sim', description: 'A simulator', downloads: 10, updated_at: '2025-01-02T00:00:00Z' }], meta: { total: 1 } } }
        : { status: 200, body: 'ok' });
    const task = { kind: 'handle', value: 'janeroe', platform: 'github', template: null, depth: 1 };
    const ctx = { subject, deadline: Date.now() + 20000, known: () => ({}) };
    network(answer);
    await withSignedInContact(JANE, async () => {
      const out = await cratesIoConnector.run(task, ctx);
      expect(out.findings).toHaveLength(1);
      expect(JSON.stringify(out)).not.toMatch(/jane\.roe@/);
      await request('https://records.example.net/c');
    });
    expect(agentsTo('crates.io')).toHaveLength(2);
    for (const a of agentsTo('crates.io')) expect(a).toBe('diligence-research/1.0 (automated public-records lookup; +Jane Roe jane.roe@example.org)');
    for (const a of agentsNotTo('crates.io')) expect(a).not.toMatch(ADDRESS);

    process.env.FOUNDER_HTTP_CONTACT = 'ops@example.net';
    network(answer);
    await withSignedInContact(JANE, () => cratesIoConnector.run(task, ctx));
    for (const c of calls) { expect(c.agent).not.toMatch(ADDRESS); expect(c.agent).toMatch(/ops@example\.net/); }
  });
});

/* ------------------------------------------------------------------ names fetch can carry */

// Real fetch (undici) refuses a header value with a character above U+00FF. This network checks every request's
// headers the way fetch does, so a name that would break the request fails here too.
function strictNetwork(answer) {
  calls = [];
  setTransport(async (url, init) => {
    const headers = new Headers(init?.headers || {}); // throws the way fetch does
    calls.push({ url, host: new URL(url).hostname, agent: headers.get('User-Agent') || '' });
    const r = answer(url) || { status: 404, body: 'not found' };
    return { status: r.status, headers: new Map(Object.entries(r.headers || {})), url, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  });
}

describe('names outside plain Latin letters', () => {
  const LAN = { name: 'Đặng Thị Lan', email: 'lan.dang@example.org' };
  const MING = { name: '李明', email: 'li.ming@example.org' };
  const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
  const EMPTY_LIST = '<div class="view-empty"><p class="no-results-text">No results found.</p></div>';
  const emptySearch = JSON.stringify({ hits: { total: { value: 0, relation: 'eq' }, hits: [] } });
  const FTC_EMPTY = '<html><body><div class="main"><div class="view-empty"><p>No results found for these filters.</p></div><div class="view-results-info"></div></div></body></html>';
  const answer = (url) => (url.includes('efts.sec.gov') ? { status: 200, body: emptySearch }
    : url.includes('www.sec.gov') ? { status: 200, body: EMPTY_LIST }
      : url.includes('www.ftc.gov') ? { status: 200, body: FTC_EMPTY }
        : url.includes('/users/') ? { status: 404, body: 'not found' } : { status: 200, body: 'ok' });

  test('accents are taken off, other scripts left out; the address alone is used when nothing is left', () => {
    expect(cleanContact(LAN)).toEqual({ name: 'Dang Thi Lan', email: 'lan.dang@example.org' });
    expect(cleanContact(MING)).toEqual({ name: '', email: 'li.ming@example.org' });
    expect(cleanContact({ name: 'José Müller-Łukasz', email: 'jose@example.org' }).name).toBe('Jose Muller-Lukasz');
    expect(cleanContact({ name: 'Ann 李', email: 'ann@example.org' }).name).toBe('Ann');
    withSignedInContact(MING, () => expect(contactFor('site').agent).toBe('li.ming@example.org'));
  });

  for (const person of [LAN, MING]) {
    test(`${person.email}: the SEC, FTC and crates.io requests are all sent, each with a header fetch accepts`, async () => {
      strictNetwork(answer);
      await withSignedInContact(person, async () => {
        await secPersonConnector.run({ kind: 'subject', value: subject.name, template: 'enforcement', depth: 0 }, { subject, deadline: Date.now() + 20000, known: () => ({}) });
        await ftcCasesConnector.run({ kind: 'subject', value: subject.name, template: 'ftc.person', why: 'test', depth: 0 }, { subject, deadline: Date.now() + 20000, findings: () => [] });
        await cratesIoConnector.run({ kind: 'handle', value: 'janeroe', platform: 'github', template: null, depth: 1 }, { subject, deadline: Date.now() + 20000, known: () => ({}) });
      });
      for (const host of ['www.sec.gov', 'www.ftc.gov', 'crates.io']) {
        expect(agentsTo(host).length).toBeGreaterThan(0);
        for (const a of agentsTo(host)) { expect(a).toContain(person.email); expect(a).toMatch(/^[\x20-\x7e]+$/); }
      }
    });
  }
});

/* ------------------------------------------------------------------ the deep check route */

describe('the deep check route', () => {
  const auth = require('../../../src/server/auth');
  beforeEach(() => {
    __resetJobsForTests();
    __resetLearningForTests?.();
    sources.__seen.enabled.length = 0;
    sources.__seen.runs.length = 0;
  });

  function call(method, { body, query } = {}) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200, headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, body: payload }); },
      };
      deep({ method, body, query: query || {}, headers: { 'x-forwarded-for': '203.0.113.9' }, socket: {} }, res);
    });
  }
  const signIn = (person, id = 'google:jane') => getServerSession.mockResolvedValue({ user: { id, ...person } });

  test('signed in: the check names the person to www.sec.gov only, on the start and on every later step, and the answers say "account" only', async () => {
    expect(typeof auth.getUserContact).toBe('function');
    signIn(JANE);
    network(() => ({ status: 200, body: 'ok' }));
    const answers = [];
    let r = await call('POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme Robotics' } });
    answers.push(r.body);
    expect(r.status).toBe(200);
    expect(r.body.contact).toBe('account');
    const { jobId } = r.body;
    for (let i = 0; i < 12 && !r.body.done; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      r = await call('POST', { body: { action: 'step', jobId } });
      answers.push(r.body);
      expect(r.body.contact).toBe('account');
    }
    expect(r.body.done).toBe(true);
    const read = await call('GET', { query: { jobId } });
    answers.push(read.body);
    expect(read.body.contact).toBe('account');

    // planning happened inside the request: every enabled() call saw the person's contact
    expect(sources.__seen.enabled.length).toBeGreaterThan(0);
    expect(new Set(sources.__seen.enabled)).toEqual(new Set(['account']));
    expect(sources.__seen.runs.length).toBeGreaterThan(0);
    expect(agentsTo('www.sec.gov').length).toBeGreaterThan(1); // the start's step and later steps alike
    expect(agentsTo('records.example.net').length).toBeGreaterThan(1);
    for (const a of agentsTo('www.sec.gov')) expect(a).toBe('diligence-research Jane Roe jane.roe@example.org');
    for (const a of agentsNotTo('www.sec.gov')) expect(a).not.toMatch(ADDRESS);

    // never in an answer, the report or the saved check
    for (const body of answers) expect(JSON.stringify(body)).not.toMatch(/jane\.roe/);
    const job = await getJob(jobId, { owner: 'google:jane' });
    expect(job).toBeTruthy();
    expect(JSON.stringify(job)).not.toMatch(/jane\.roe|example\.org/);
  });

  test('an operator setting: answers say "operator", and no account address is sent', async () => {
    process.env.SEC_USER_AGENT = 'Example Research ops@example.net';
    process.env.FOUNDER_HTTP_CONTACT = 'ops@example.net';
    signIn(JANE);
    network(() => ({ status: 200, body: 'ok' }));
    const r = await call('POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme Robotics' } });
    expect(r.body.contact).toBe('operator');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.agent).not.toMatch(ADDRESS);
  });

  test('the local test account is no contact: the sources that need one stay off, and answers say "none"', async () => {
    signIn({ name: 'Local test user', email: 'local-test-user@localhost' }, 'google:local');
    network(() => ({ status: 200, body: 'ok' }));
    const r = await call('POST', { body: { action: 'start', name: 'Jane Roe', company: 'Acme Robotics' } });
    expect(r.body.contact).toBe('none');
    expect(sources.__seen.runs).toEqual([]);
    expect(calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ debug routes */

describe('debug routes in production follow the site\'s model', () => {
  const callDebug = async (handler, query = {}) => {
    const res = createMockRes();
    await handler(createMockReq({ method: 'GET', query, headers: { 'x-forwarded-for': '203.0.113.20' } }), res);
    return res;
  };
  beforeEach(() => { process.env.NODE_ENV = 'production'; delete process.env.VERCEL_ENV; });

  test('signed in with no allow-list: allowed', async () => {
    getServerSession.mockResolvedValue({ user: { id: 'google:r6-allowed', ...JANE } });
    expect((await callDebug(envCheck)).statusCode).toBe(200);
    expect((await callDebug(llmCheck)).statusCode).toBe(200);
  });

  test('signed out: 401 with a sign-in prompt, not 404', async () => {
    for (const h of [envCheck, llmCheck]) {
      const res = await callDebug(h);
      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ signIn: true });
    }
  });

  test('an allow-list, when set, still applies', async () => {
    process.env.FOUNDER_ALLOWED_EMAILS = 'owner@example.net';
    getServerSession.mockResolvedValue({ user: { id: 'google:r6-outside', ...JANE } });
    expect((await callDebug(envCheck)).statusCode).toBe(403);
  });

  test('the hourly limits still hold: per account, and one shared allowance for model runs', async () => {
    getServerSession.mockResolvedValue({ user: { id: `google:r6-limit-${Math.random()}`, ...JANE } });
    const own = [];
    for (let i = 0; i < 11; i += 1) own.push((await callDebug(llmCheck, { run: 'chat' })).statusCode); // eslint-disable-line no-await-in-loop
    expect(own.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(own[10]).toBe(429);
    const shared = [];
    for (let a = 0; a < 5; a += 1) {
      getServerSession.mockResolvedValue({ user: { id: `google:r6-shared-${a}-${Math.random()}`, name: `Person ${a}`, email: `p${a}@example.org` } });
      for (let i = 0; i < 10; i += 1) shared.push((await callDebug(llmCheck, { run: 'chat' })).statusCode); // eslint-disable-line no-await-in-loop
    }
    // ten runs of the first account already count against the shared hour of 40
    expect(shared.filter((c) => c === 200).length).toBe(30);
    expect(shared.slice(30).every((c) => c === 429)).toBe(true);
  });
});
