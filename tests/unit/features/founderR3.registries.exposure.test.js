/**
 * Round 3 (audit of 2026-11-20) for exposure.js. Breach and leak-site records stay company level, and a listing
 * that matches only an ordinary word is never the company's: "Bolt" (bolt.cd, a file-sharing site) is not Ryan
 * Breslow's Bolt, "Meta Financial Group" is not Meta, and the direwolf listing of "Merge" says when merge.dev
 * itself was looked up and named nowhere (Shensi Ding / Merge, graded report r8).
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, addCompanyAlias } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { leakSiteConnector, breachCatalogueConnector, breachRegistersConnector } = require('../../../src/server/founder/sources/exposure');

function network(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, method: init.method });
    const hit = routes.find(([pattern]) => pattern.test(url));
    const reply = hit ? (typeof hit[1] === 'function' ? hit[1](url, init) : hit[1]) : { status: 404, body: 'not found' };
    return { status: reply.status || 200, headers: new Map(), url, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) };
  });
  return calls;
}
const ctxFor = (name, company) => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}) });
const companyTask = (value) => ({ kind: 'company', value, depth: 1, template: null, params: null });

beforeEach(() => __resetCacheForTests());
afterEach(() => { setTransport(); delete process.env.FOUNDER_SOURCES_OFF; });

const flags = { IsVerified: true, IsFabricated: false, IsSensitive: false, IsRetired: false, IsSpamList: false, IsMalware: false, IsSubscriptionFree: false, IsStealerLog: false };
const CATALOGUE = [
  { Name: 'Bolt', Title: 'Bolt', Domain: 'bolt.cd', BreachDate: '2017-03-01', AddedDate: '2017-04-01T00:00:00Z', PwnCount: 995274, Description: 'In March 2017, the file sharing website Bolt suffered a data breach that exposed nearly a million accounts.', DataClasses: ['Email addresses', 'Passwords'], ...flags },
  { Name: 'MetaFinancial', Title: 'Meta Financial Group', Domain: 'metafinancial.example', BreachDate: '2019-05-01', AddedDate: '2019-06-01T00:00:00Z', PwnCount: 1200, Description: 'In May 2019, Meta Financial Group suffered a data breach.', DataClasses: ['Email addresses'], ...flags },
  { Name: 'Theranos', Title: 'Theranos', Domain: '', BreachDate: '2016-01-01', AddedDate: '2016-02-01T00:00:00Z', PwnCount: 5000, Description: 'In 2016, the blood testing company Theranos exposed records of staff.', DataClasses: ['Email addresses'], ...flags },
];

describe('known breaches: one ordinary word is not the company', () => {
  test('"Bolt" (bolt.cd) is a possible namesake, low, kept off the timeline, when the company\'s own website is not known', async () => {
    network([[/haveibeenpwned/, { body: CATALOGUE }]]);
    const { findings } = await breachCatalogueConnector.run(companyTask('Bolt'), ctxFor('Ryan Breslow', 'Bolt'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ match: 'possible', severity: 'low', matchFixed: true });
    expect(findings[0].matchReasons[1]).toMatch(/"Bolt" is an ordinary word/);
    expect(findings[0].data).toMatchObject({ excludeFromTimeline: true, companyNamesake: true });
  });

  test('with bolt.com known, the bolt.cd entry is dropped; with the entry on bolt.com it is the company\'s', async () => {
    network([[/haveibeenpwned/, { body: [...CATALOGUE, { ...CATALOGUE[0], Name: 'BoltCom', Domain: 'bolt.com', BreachDate: '2024-02-02' }] }]]);
    const ctx = ctxFor('Ryan Breslow', 'Bolt');
    addAnchor(ctx.subject, 'domains', 'bolt.com', 'web-1');
    const { findings } = await breachCatalogueConnector.run(companyTask('Bolt'), ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ match: 'company', severity: 'medium' });
    expect(findings[0].data.domain).toBe('bolt.com');
  });

  test('a general word added ("Meta Financial Group") is possible; a coined name ("Theranos") is the company', async () => {
    network([[/haveibeenpwned/, { body: CATALOGUE }]]);
    const meta = await breachCatalogueConnector.run(companyTask('Meta'), ctxFor('Mark Zuckerberg', 'Meta'));
    expect(meta.findings.map((f) => f.match)).toEqual(['possible']);
    const theranos = await breachCatalogueConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(theranos.findings.map((f) => f.match)).toEqual(['company']);
  });
});

const EMPTY = { posts: [], leaks: [] };
const DIREWOLF = { posts: [{ post_title: 'Merge', discovered: '2026-08-11 10:00:00.000000', group_name: 'direwolf' }], leaks: [] };

describe('leak-site listings: the company\'s own website is looked up', () => {
  test('Merge / merge.dev: the name-only listing is possible and says no listing names merge.dev', async () => {
    const calls = network([
      [/q=merge\.dev$/, { body: EMPTY }],
      [/q=Merge$/, { body: DIREWOLF }],
    ]);
    const ctx = ctxFor('Shensi Ding', 'Merge');
    addAnchor(ctx.subject, 'domains', 'merge.dev', 'web-1');
    const { findings } = await leakSiteConnector.run(companyTask('Merge'), ctx);
    expect(calls.map((c) => decodeURIComponent(c.url.split('q=')[1]))).toEqual(['Merge', 'merge.dev']);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ match: 'possible', severity: 'low' });
    expect(findings[0].quote).toMatch(/No listing names merge\.dev\.$/);
    expect(findings[0].data).toMatchObject({ ownDomainChecked: 'No listing names merge.dev.', excludeFromTimeline: true });
  });

  test('a listing that names the company\'s own website is the company\'s', async () => {
    network([
      [/q=merge\.dev$/, { body: { posts: [{ post_title: 'merge.dev', discovered: '2026-08-12 10:00:00.000000', group_name: 'direwolf' }], leaks: [] } }],
      [/q=Merge$/, { body: DIREWOLF }],
    ]);
    const ctx = ctxFor('Shensi Ding', 'Merge');
    addAnchor(ctx.subject, 'domains', 'merge.dev', 'web-1');
    const { findings } = await leakSiteConnector.run(companyTask('Merge'), ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ match: 'company', severity: 'medium' });
    expect(findings[0].data.nameMatch).toBe('domain');
    expect(findings[0].quote).not.toMatch(/No listing names/);
  });

  test('a legal name learned for the company makes a listing under that name the company\'s', async () => {
    network([[/q=Merge$/, { body: { posts: [{ post_title: 'Merge API, Inc.', discovered: '2026-08-11 10:00:00.000000', group_name: 'direwolf' }], leaks: [] } }]]);
    const ctx = ctxFor('Shensi Ding', 'Merge');
    addCompanyAlias(ctx.subject, { company: 'Merge', alias: 'Merge API, Inc.', origin: 'web-2' });
    const { findings } = await leakSiteConnector.run(companyTask('Merge'), ctx);
    expect(findings[0]).toMatchObject({ match: 'company' });
  });
});

test('every exposure source can be switched off without a deploy', () => {
  for (const c of [leakSiteConnector, breachCatalogueConnector, breachRegistersConnector]) {
    expect(c.enabled()).toBe(true);
    process.env.FOUNDER_SOURCES_OFF = `x,${c.id}`;
    expect(c.enabled()).toBe(false);
    expect(c.unavailableReason).toMatch(/not enabled on this deployment/);
    delete process.env.FOUNDER_SOURCES_OFF;
  }
});
