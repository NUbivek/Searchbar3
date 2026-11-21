/**
 * Breach and leak-site exposure connectors: company-level only. Fixtures are
 * cut from real responses (RansomLook, Have I Been Pwned, the California,
 * Washington and Oregon registers, the UK ICO), with a few neighbours added
 * to prove that the sources' substring matches are thrown away.
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, addCompanyAlias } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const {
  leakSiteConnector, breachCatalogueConnector, breachRegistersConnector, exposureConnectors,
  companyKey, matchOrgName, ownNameIn, registrableDomain, dataFieldLabels, REGISTERS_COVERAGE,
} = require('../../../src/server/founder/sources/exposure');

/** Fake network: the first pattern that matches the URL answers. Returns the list of calls made. */
function network(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const hit = routes.find(([pattern]) => pattern.test(url));
    const reply = hit ? (typeof hit[1] === 'function' ? hit[1](url, init) : hit[1]) : { status: 404, body: 'not found' };
    return { status: reply.status || 200, headers: new Map(), url, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) };
  });
  return calls;
}

const ctxFor = (name, company) => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}) });
// Round 3: "Uber" is one ordinary word, so a name-only match is the company's only once its legal name is known
const uberCtx = () => { const ctx = ctxFor('Travis Kalanick', 'Uber'); addCompanyAlias(ctx.subject, { company: 'Uber', alias: 'Uber Technologies, Inc.', origin: 'sec-filings-1' }); return ctx; };
const companyTask = (value) => ({ kind: 'company', value, depth: 1, template: null, params: null });
const domainTask = (value) => ({ kind: 'domain', value, depth: 1, template: null, params: null });

/** The loop treats two records of one category on the same page (query string and fragment aside) as duplicates. */
const pageOf = (url) => String(url).replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
const pagesAreDistinct = (findings) => new Set(findings.map((f) => pageOf(f.url))).size === findings.length;

beforeEach(() => __resetCacheForTests());
afterEach(() => setTransport());

/* ------------------------------------------------------------------ */

describe('company-name matching', () => {
  const grade = (company, record) => matchOrgName(companyKey(company), record);

  test('normalises names: legal forms, punctuation, generic words', () => {
    expect(companyKey('Uber Technologies, Inc.')).toMatchObject({ full: ['uber', 'technologies'], core: ['uber'], specific: true });
    expect(companyKey('The Trade Desk, L.L.C.')).toMatchObject({ full: ['trade', 'desk'], specific: true });
    expect(companyKey('Stripe').specific).toBe(true);
    expect(companyKey('Apple').specific).toBe(true);
    expect(companyKey('FTX').specific).toBe(true);
    expect(companyKey('Block, Inc. (formerly Square)')).toMatchObject({ name: 'Block, Inc.', full: ['block'], specific: true });
  });

  test('too short or generic names are not specific', () => {
    expect(companyKey('AI')).toMatchObject({ full: ['ai'], core: [], specific: false });
    expect(companyKey('The Company')).toMatchObject({ full: [], specific: false });
    expect(companyKey('Global Holdings Ltd').specific).toBe(false);
    expect(companyKey('X Corp').specific).toBe(false);
  });

  test.each([
    ['Uber', 'Uber Technologies, Inc.', 'exact'],
    ['Uber', 'Cole Huber, LLP', null],
    ['Uber', 'The Shubert Organization, Inc.', null],
    ['Uber', "St. Hubert's Church", null],
    ['Uber', 'daubertchemical', null],
    ['Uber', 'studioubertazzi.it', null],
    ['Uber Technologies, Inc.', 'Uber', 'exact'],
    ['Apple', 'Apple Inc.', 'exact'],
    ['Apple', 'Apple Valley Unified School District', null],
    ['Apple', 'Apple American Group LLC', null],
    ['Target', 'Target Corporation', 'exact'],
    ['Target', 'TJG, Inc. d/b/a Target Marketing', null],
    ['Square', 'The Madison Square Garden Company', null],
    ['Block', 'Holstrom, Block & Parke APLC', null],
    ['Block', 'Block, Inc.', 'exact'],
    ['Oracle', 'Fidelity Investments (on behalf of Oracle Corporation)', 'exact'],
    ['Stripe', 'Stripe, Inc.', 'exact'],
    ['Stripe', 'Classic Stripes Pvt Ltd', null],
    ['Stripe', 'stripe.com', 'exact'],
    ['Stripe', 'pinstripe.com', null],
    ['Stripe', 'stripe-payments.io', null],
    ['Stripe', 'https://www.stripe.com/pricing', 'exact'],
    ['Uber Technologies, Inc.', 'uber.com', 'exact'],
    ['T-Mobile', 't-mobile.com', 'exact'],
    ['WeWork', 'We Work Inc.', 'exact'],
    ['Meta', 'Meta Platforms, Inc.', 'exact'],
    ['Meta', 'Metabase', null],
    ['Capita', 'Capita plc and Capita Pension Solutions Ltd', 'leading'],
    ['Capita', 'Gain Capital UK Limited', null],
    ['Nikola', 'Nikolaus & Hohenadel', null],
    ['Nikola', 'Nikola Corporation', 'exact'],
    ['MGM Resorts', 'Statement on MGM Resorts International: Setting the record straight', 'contains'],
    ['MGM Resorts', 'mgmresorts.com', 'exact'],
    ['Change Healthcare', 'Change Healthcare - Optum - UnitedHealth', 'exact'],
    ['T-Mobile', 'T-Mobile USA/Experian', 'exact'],
    ['WeWork', 'WeWork Companies Inc.', 'exact'],
    ['FTX', 'FTX Trading Ltd', 'padded'],
    ['Adobe', 'Adobe Systems Incorporated', 'padded'],
    ['Revolve', 'Revolve Group, Inc.', 'padded'],
    ['Apple', 'Apple America Group LLC', 'padded'],
    ['Summit', 'Summit Financial Group', 'padded'],
    ['Slack', 'Slack Technologies, Inc.', 'exact'],
    ['Uber Technologies', 'Uber Technologies, Inc.', 'exact'],
    ['Mistral AI', 'Mistral AI SAS', 'exact'],
    ['Mistral AI', 'Mistral', 'exact'],
    ['Mistral AI', 'Mistral Energy Ltd', null],
  ])('%s vs "%s" -> %s', (company, record, expected) => {
    expect(grade(company, record)).toBe(expected);
  });

  test('generic names never match loosely', () => {
    expect(grade('AI', 'Scale AI')).toBeNull();
    expect(grade('AI', 'Mistral AI SAS')).toBeNull();
    expect(grade('AI', 'ai.type')).toBeNull();
    expect(grade('AI', 'ai.com')).toBeNull();
    expect(grade('X Corp', 'x.com')).toBeNull();
    expect(grade('AI', 'AI Inc.')).toBe('exact');
    expect(grade('The Company', 'The Company Store')).toBeNull();
    expect(grade('The Company', 'The Walt Disney Company')).toBeNull();
  });

  test('only the part of an entry that is the company itself is ever shown', () => {
    const own = (company, record) => ownNameIn(companyKey(company), record);
    expect(own('Change Healthcare', 'Change HealthCare - OPTUM Group - United HealthCare Group<Updated>')).toBe('Change HealthCare');
    expect(own('Uber', 'Uber Technologies')).toBe('Uber Technologies');
    expect(own('MGM Resorts', 'MGM Resorts - 6TB of guest passports, pay or we publish')).toBe('MGM Resorts');
    expect(own('MGM Resorts', 'Statement on MGM Resorts International: Setting the record straight')).toBe('');
    expect(own('MGM Resorts', 'Why MGM Resorts lied to its customers')).toBe('');
    expect(own('Stripe', 'stripe.com')).toBe('');
  });

  test('registrable domains', () => {
    expect(registrableDomain('https://www.Theranos.com/about')).toBe('theranos.com');
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('mistral.ai')).toBe('mistral.ai');
    expect(registrableDomain('Theranos, Inc.')).toBe('');
    expect(registrableDomain('jane@example.com')).toBe('');
  });

  test('column names become data-class labels, never data', () => {
    expect(dataFieldLabels(['firstname', 'email_address', 'phone', 'dob', 'userid', 'lastname'])).toEqual(['Names', 'Email addresses', 'Phone numbers', 'Dates of birth', 'Usernames or IDs']);
    expect(dataFieldLabels(['zzz', 'email'])).toEqual(['Email addresses', '1 other field']);
    expect(dataFieldLabels(['passport_no', 'password', 'religion', 'hiv_status'])).toEqual(['Government ID numbers', 'Passwords', '2 other fields']);
  });

  test('the three connectors have distinct ids and only take companies or domains', () => {
    expect(exposureConnectors.map((c) => c.id)).toEqual(['leak-sites', 'breach-catalogue', 'breach-registers']);
    for (const c of exposureConnectors) {
      expect(c.kinds.every((k) => k === 'company' || k === 'domain')).toBe(true);
      expect(c.label).not.toMatch(/\b(API|endpoint|free|paid|key|token)\b/i);
    }
  });
});

/* ------------------------------------------------------------------ */

const MGM_POST = {
  post_title: 'Statement on MGM Resorts International: Setting the record straight',
  discovered: '2023-09-14 22:18:15.880069',
  description: 'MGM Resorts International is an American global hospitality and entertainment company.',
  link: '/ddcdd476-fbd9-4809-baea-414d820c9d4b',
  magnet: 'magnet:?xt=urn:btih:0123456789abcdef',
  screen: 'screenshots/alphv/Statement on MGM Resorts International: Setting the record straight.png',
  source: 'PCFET0NUWVBFIGh0bWw+',
  misp_uuid: 'a658d5a2-48d6-5cab-bb33-237b1f991c84',
  group_name: 'alphv',
};
const MGM_LEAK = { name: 'mgmresorts.com', records: '10,683,178', size: '2 G', columns: ['firstname', 'email_address', 'phone', 'dob', 'userid', 'lastname'], indexed: '2020-03-13', key: '2306' };
const EMPTY_SEARCH = { groups: [], markets: [], posts: [], leaks: [], notes: [] };

describe('leak-sites (RansomLook)', () => {
  test('maps a leak-site post and the breached-database entry, and drops everything attacker-written', async () => {
    const calls = network([
      [/api\/search\?q=MGM%20Resorts$/, {
        body: {
          ...EMPTY_SEARCH,
          posts: [
            MGM_POST,
            { ...MGM_POST, post_title: 'MGM Grand Mortgage', group_name: 'play', link: 'http://playxyzabcdefgh.onion/topic.php?id=1' },
            { ...MGM_POST, post_title: 'MGM Resorts - 6TB of guest passports, pay or we publish', group_name: 'scattered', discovered: '2023-09-20 08:00:00.000000' },
          ],
        },
      }],
      [/api\/search\?q=mgmresorts$/, { body: { ...EMPTY_SEARCH, leaks: [MGM_LEAK, { ...MGM_LEAK, name: 'notmgmresorts.com', key: '9' }] } }],
    ]);
    const result = await leakSiteConnector.run(companyTask('MGM Resorts'), ctxFor('Bill Hornbuckle', 'MGM Resorts'));

    expect(calls.map((c) => c.url)).toEqual(['https://www.ransomlook.io/api/search?q=MGM%20Resorts', 'https://www.ransomlook.io/api/search?q=mgmresorts']);
    expect(result.findings).toHaveLength(3);
    const post = result.findings.find((f) => /alphv/.test(f.title));
    const second = result.findings.find((f) => /scattered/.test(f.title));
    const leak = result.findings[2];
    expect(post).toMatchObject({
      source: 'leak-sites',
      category: 'exposure',
      title: 'MGM Resorts listed by alphv on a ransomware leak site (claimed, unverified)',
      url: 'https://www.ransomlook.io/group/alphv#:~:text=MGM%20Resorts',
      date: '2023-09-14',
      severity: 'medium',
      match: 'company',
    });
    expect(post.sourceLabel).toMatch(/RansomLook/);
    expect(post.sourceLabel).toMatch(/CC BY 4\.0/);
    expect(post.quote).toBe('Victim listed: MGM Resorts. Group: alphv. First seen: 2023-09-14.');
    // the post is a headline that contains the name: the company's own name is shown instead of the headline
    expect(post.data).toMatchObject({ organisation: 'MGM Resorts', group: 'alphv', firstSeen: '2023-09-14', listings: 1, nameMatch: 'contains' });
    // a post titled with the company and a threat: only the company's name is shown
    expect(second).toMatchObject({ title: 'MGM Resorts listed by scattered on a ransomware leak site (claimed, unverified)', date: '2023-09-20' });
    expect(second.quote).toBe('Victim listed: MGM Resorts. Group: scattered. First seen: 2023-09-20.');

    expect(leak).toMatchObject({
      category: 'exposure',
      title: 'mgmresorts.com appears in a catalogue of breached databases: 10,683,178 records (unverified listing)',
      url: 'https://www.ransomlook.io/leaks#:~:text=mgmresorts.com',
      date: '2020-03-13',
      severity: 'medium',
      match: 'company',
    });
    expect(leak.quote).toBe('Records: 10,683,178. Data fields: Names, Email addresses, Phone numbers, Dates of birth, Usernames or IDs. Indexed: 2020-03-13.');

    // nothing written by the attacker, no screenshot, no magnet, no onion or leak-site link
    const everything = JSON.stringify(result);
    for (const banned of ['American global hospitality', 'Setting the record straight', 'ddcdd476', 'screenshots', 'magnet', '.onion', 'PCFET0', 'misp', 'MGM Grand', 'passports', 'pay or we publish', '6TB']) expect(everything).not.toContain(banned);
    expect(result.threads).toEqual([]);
    expect(pagesAreDistinct(result.findings)).toBe(true);
    for (const f of result.findings) expect(f.url).toMatch(/^https:\/\/www\.ransomlook\.io\/(group\/|leaks)/);
  });

  test("the index's substring matches are dropped", async () => {
    network([[/api\/search\?q=Nikola$/, { body: { ...EMPTY_SEARCH, posts: [{ post_title: 'Nikolaus & Hohenadel', discovered: '2024-05-06 22:41:33.788214', description: 'x', link: '/companies/n-hlaw.com/', group_name: 'bianlian' }] } }]]);
    expect((await leakSiteConnector.run(companyTask('Nikola'), ctxFor('Trevor Milton', 'Nikola'))).findings).toEqual([]);

    network([[/api\/search\?q=Uber$/, {
      body: {
        ...EMPTY_SEARCH,
        posts: [
          { post_title: 'Huber', discovered: '2025-01-02 10:00:00.000000', group_name: 'akira' },
          { post_title: 'daubertchemical', discovered: '2025-02-02 10:00:00.000000', group_name: 'play' },
          { post_title: 'studioubertazzi.it', discovered: '2025-03-02 10:00:00.000000', group_name: 'qilin' },
          { post_title: 'Uber Technologies', discovered: '2022-09-16 03:00:00.000000', group_name: 'lapsus' },
        ],
      },
    }]]);
    const { findings } = await leakSiteConnector.run(companyTask('Uber'), uberCtx());
    expect(findings.map((f) => f.title)).toEqual(['Uber Technologies listed by lapsus on a ransomware leak site (claimed, unverified)']);
    expect(findings[0].url).toBe('https://www.ransomlook.io/group/lapsus#:~:text=Uber%20Technologies');
    expect(findings[0].matchReasons).toEqual(["the organisation's name matches Uber"]);
  });

  test('several posts by one group become one finding dated at first sight', async () => {
    network([[/api\/search/, {
      body: {
        ...EMPTY_SEARCH,
        posts: [
          { post_title: 'Change Healthcare - Optum - UnitedHealth', discovered: '2024-02-28 18:25:59.478825', group_name: 'alphv' },
          { post_title: 'Change Healthcare - Optum - UnitedHealth', discovered: '2024-03-03 09:00:00.000000', group_name: 'alphv' },
          { post_title: 'Change HealthCare - OPTUM Group - United HealthCare Group', discovered: '2024-04-08 09:00:00.000000', group_name: 'ransomhub' },
          { post_title: 'Change HealthCare - OPTUM Group - United HealthCare Group<Updated>', discovered: '2024-04-15 09:00:00.000000', group_name: 'ransomhub' },
          { post_title: 'Change Healthcare', discovered: '2024-04-16 09:00:00.000000', group_name: 'ransomhub' },
        ],
      },
    }]]);
    const { findings } = await leakSiteConnector.run(companyTask('Change Healthcare'), ctxFor('Neil de Crescenzo', 'Change Healthcare'));
    expect(findings).toHaveLength(2);
    const alphv = findings.find((f) => /alphv/.test(f.title));
    expect(alphv.date).toBe('2024-02-28');
    expect(alphv.quote).toMatch(/First seen: 2024-02-28\. Listed on 2 dates, most recently 2024-03-03\./);
    // name variants listed by the same group are one finding: the plainest name, the earliest date
    const ransomhub = findings.find((f) => /ransomhub/.test(f.title));
    expect(ransomhub).toMatchObject({
      title: 'Change Healthcare listed by ransomhub on a ransomware leak site (claimed, unverified)',
      url: 'https://www.ransomlook.io/group/ransomhub#:~:text=Change%20Healthcare',
      date: '2024-04-08',
    });
    expect(ransomhub.data).toMatchObject({ firstSeen: '2024-04-08', lastSeen: '2024-04-16', listings: 3 });
    expect(JSON.stringify(findings)).not.toMatch(/Optum|OPTUM|UnitedHealth|Updated/);
    expect(pagesAreDistinct(findings)).toBe(true);
  });

  test('a domain is matched exactly, in one request', async () => {
    const calls = network([[/api\/search\?q=toyokiki-thailand\.com$/, {
      body: {
        ...EMPTY_SEARCH,
        posts: [
          { post_title: 'toyokiki-thailand.com', discovered: '2026-11-14 17:31:08.599011', description: 'Established in 2013', link: '/blog/post/toyokiki-thailandcom/', group_name: 'safepay' },
          { post_title: 'nottoyokiki-thailand.com', discovered: '2026-11-13 17:31:08.599011', group_name: 'safepay' },
        ],
        leaks: [{ ...MGM_LEAK, name: 'toyokiki-thailand.com', key: '77' }, { ...MGM_LEAK, name: 'othertoyokiki-thailand.com', key: '78' }],
      },
    }]]);
    const { findings } = await leakSiteConnector.run(domainTask('https://www.toyokiki-thailand.com/contact'), ctxFor('Jane Roe', 'Toyokiki'));
    expect(calls).toHaveLength(1);
    expect(findings.map((f) => f.title)).toEqual([
      'toyokiki-thailand.com listed by safepay on a ransomware leak site (claimed, unverified)',
      'toyokiki-thailand.com appears in a catalogue of breached databases: 10,683,178 records (unverified listing)',
    ]);
    expect(findings[0].matchReasons).toEqual(['exact match on the domain toyokiki-thailand.com']);
    expect(findings[0].url).toBe('https://www.ransomlook.io/group/safepay#:~:text=toyokiki%2Dthailand.com');
    expect(findings[1].url).toBe('https://www.ransomlook.io/leaks#:~:text=toyokiki%2Dthailand.com');
    expect(findings.every((f) => f.match === 'company')).toBe(true);
  });

  test("the link uses the group's name exactly as the index writes it", async () => {
    network([[/api\/search/, {
      body: {
        ...EMPTY_SEARCH,
        posts: [
          { post_title: 'Acme Rockets Inc', discovered: '2025-02-04 01:02:03.000000', group_name: 'eraleign (apt73)' },
          { post_title: 'Acme Rockets', discovered: '2025-03-04 01:02:03.000000', group_name: 'inc ransom' },
          { post_title: 'Acme Rockets', discovered: '2025-04-04 01:02:03.000000', group_name: '<script>x</script>/../y' },
        ],
      },
    }]]);
    const { findings } = await leakSiteConnector.run(companyTask('Acme Rockets'), ctxFor('Jane Roe', 'Acme Rockets'));
    expect(findings.map((f) => [f.title, f.url])).toEqual([
      ['Acme Rockets listed by scriptxscript..y on a ransomware leak site (claimed, unverified)', 'https://www.ransomlook.io/recent#:~:text=Acme%20Rockets'],
      ['Acme Rockets listed by inc ransom on a ransomware leak site (claimed, unverified)', 'https://www.ransomlook.io/group/inc%20ransom#:~:text=Acme%20Rockets'],
      ['Acme Rockets Inc listed by eraleign (apt73) on a ransomware leak site (claimed, unverified)', 'https://www.ransomlook.io/group/eraleign%20(apt73)#:~:text=Acme%20Rockets%20Inc'],
    ]);
  });

  test('a post that only mentions the domain inside a headline shows the domain, not the headline', async () => {
    network([[/api\/search/, { body: { ...EMPTY_SEARCH, posts: [{ post_title: 'acme-rockets.com - full dump of staff passports', discovered: '2025-05-05 05:05:05.000000', group_name: 'qilin' }] } }]]);
    const { findings } = await leakSiteConnector.run(domainTask('acme-rockets.com'), ctxFor('Jane Roe', 'Acme Rockets'));
    expect(findings.map((f) => f.title)).toEqual(['acme-rockets.com listed by qilin on a ransomware leak site (claimed, unverified)']);
    expect(JSON.stringify(findings)).not.toMatch(/passports|full dump/);
  });

  test('several breached-database entries share one page, so they are one finding', async () => {
    network([[/api\/search/, {
      body: {
        ...EMPTY_SEARCH,
        leaks: [
          { name: 'nestle.com', records: '21,548', columns: ['email', 'password'], indexed: '2019-02-01', key: '901' },
          { name: 'nestle.com', records: '3,104', columns: ['email', 'religion'], indexed: '2021-07-09', key: '2977' },
          { name: 'nestle.com', records: '3,104', columns: ['email', 'religion'], indexed: '2021-07-09', key: '2977' },
          { name: 'nestle-waters.com', records: '55', columns: ['email'], indexed: '2022-01-01', key: '3001' },
        ],
      },
    }]]);
    const { findings } = await leakSiteConnector.run(companyTask('Nestle'), ctxFor('Jane Roe', 'Nestle'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: 'nestle.com has 2 entries in a catalogue of breached databases (unverified listings)',
      url: 'https://www.ransomlook.io/leaks#:~:text=nestle.com',
      date: '2021-07-09',
      match: 'company',
      matchReasons: ['the domain nestle.com matches the name Nestle'],
    });
    expect(findings[0].quote).toBe('nestle.com. Records: 3,104. Data fields: Email addresses, 1 other field. Indexed: 2021-07-09. nestle.com. Records: 21,548. Data fields: Email addresses, Passwords. Indexed: 2019-02-01.');
    expect(findings[0].data.entries).toHaveLength(2);
    expect(JSON.stringify(findings)).not.toMatch(/religion|waters/);
  });

  test('never searches a person, a generic name or a shared mail domain', async () => {
    const calls = network([[/./, { body: EMPTY_SEARCH }]]);
    const ctx = ctxFor('Elizabeth Holmes', 'Theranos');
    expect(await leakSiteConnector.run(companyTask('Elizabeth Holmes'), ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect(await leakSiteConnector.run({ kind: 'subject', value: 'Elizabeth Holmes' }, ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect(await leakSiteConnector.run({ kind: 'associate', value: 'Ramesh Balwani' }, ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect(await leakSiteConnector.run(domainTask('gmail.com'), ctx)).toEqual({ findings: [], threads: [], notes: [] });
    // the person's own site is about a person, not a company
    expect(await leakSiteConnector.run(domainTask('https://www.elizabethholmes.com/'), ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect(await leakSiteConnector.run(domainTask('elizabeth-holmes.org'), ctx)).toEqual({ findings: [], threads: [], notes: [] });
    const generic = await leakSiteConnector.run(companyTask('AI'), ctx);
    expect(generic.findings).toEqual([]);
    expect(generic.notes[0]).toMatch(/too short or too general/);
    expect((await leakSiteConnector.run(companyTask('The Company'), ctx)).notes[0]).toMatch(/too short or too general/);
    expect(calls).toHaveLength(0);
  });

  test('rejects when the index is down or answers with something else', async () => {
    network([[/./, { status: 500, body: 'oops' }]]);
    await expect(leakSiteConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow(/HTTP 500/);
    network([[/./, { body: [] }]]);
    await expect(leakSiteConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow(/unexpected response/);
    network([[/./, { body: '<html>maintenance</html>' }]]);
    await expect(leakSiteConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow(/not JSON/);
  });

  test('a failure of the second, joined-up search does not lose the first', async () => {
    network([
      [/q=MGM%20Resorts$/, { body: { ...EMPTY_SEARCH, posts: [MGM_POST] } }],
      [/q=mgmresorts$/, { status: 500, body: 'oops' }],
    ]);
    expect((await leakSiteConnector.run(companyTask('MGM Resorts'), ctxFor('Bill Hornbuckle', 'MGM Resorts'))).findings).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */

const flags = { IsVerified: true, IsFabricated: false, IsSensitive: false, IsRetired: false, IsSpamList: false, IsMalware: false, IsSubscriptionFree: false, IsStealerLog: false };
const CATALOGUE = [
  {
    Name: 'Adobe', Title: 'Adobe', Domain: 'adobe.com', BreachDate: '2013-10-04', AddedDate: '2013-12-04T00:00:00Z', ModifiedDate: '2022-05-15T23:52:49Z', PwnCount: 152445165,
    Description: 'In October 2013, 153 million Adobe accounts were breached with each containing an internal ID, username, email, <em>encrypted</em> password and a password hint in plain text. The password cryptography was poorly done and many were quickly resolved back to plain text. The unencrypted hints also <a href="http://www.troyhunt.com/2013/11/adobe-credentials-and-serious.html" target="_blank" rel="noopener">disclosed much about the passwords</a> adding further to the risk that hundreds of millions of Adobe customers already faced.',
    LogoPath: 'https://logos.haveibeenpwned.com/Adobe.png', DataClasses: ['Email addresses', 'Password hints', 'Passwords', 'Usernames'], ...flags,
  },
  {
    Name: '000webhost', Title: '000webhost', Domain: '000webhost.com', BreachDate: '2015-03-01', AddedDate: '2015-10-26T23:35:45Z', PwnCount: 14936670,
    Description: 'In approximately March 2015, the free web hosting provider <a href="http://www.troyhunt.com/2015/10/breaches-traders-plain-text-passwords.html" target="_blank" rel="noopener">000webhost suffered a major data breach</a> that exposed almost 15 million customer records.',
    DataClasses: ['Email addresses', 'IP addresses', 'Names', 'Passwords'], ...flags,
  },
  // not breaches of a company: must never be reported even though the title matches
  { Name: 'AdobeComboList', Title: 'Adobe', Domain: '', BreachDate: '2019-01-07', AddedDate: '2019-01-16T21:46:07Z', PwnCount: 1, Description: 'A spam list.', DataClasses: ['Email addresses'], ...flags, IsSpamList: true },
  { Name: 'AdobeStealer', Title: 'Adobe', Domain: 'adobe.com', BreachDate: '2024-01-07', AddedDate: '2024-01-16T21:46:07Z', PwnCount: 1, Description: 'Stealer logs.', DataClasses: ['Email addresses'], ...flags, IsStealerLog: true },
  // a neighbour that only contains the word
  { Name: 'AdobeStockFans', Title: 'Adobe Stock Fans Forum', Domain: 'adobestockfans.example', BreachDate: '2020-02-02', AddedDate: '2020-03-01T00:00:00Z', PwnCount: 5000, Description: 'A fan forum.', DataClasses: ['Email addresses'], ...flags },
  {
    Name: 'AdultFriendFinder', Title: 'Adult FriendFinder (2015)', Domain: 'adultfriendfinder.com', BreachDate: '2015-05-21', AddedDate: '2015-05-22T06:03:44Z', PwnCount: 3867997,
    Description: 'In May 2015, the adult hookup site Adult FriendFinder was hacked and nearly 4 million records dumped publicly.', DataClasses: ['Dates of birth', 'Email addresses', 'Sexual orientations', 'Usernames'], ...flags, IsSensitive: true,
  },
  {
    Name: 'MindCo', Title: 'MindCo', Domain: 'mindco.example', BreachDate: '2022-03-03', AddedDate: '2022-04-01T00:00:00Z', PwnCount: 90210,
    Description: 'In March 2022, the mental health startup MindCo exposed therapy notes of its users. The data included names.', DataClasses: ['Email addresses', 'Health insurance information', 'Names'], ...flags,
  },
  { Name: 'Unverified1', Title: 'Acme Rockets', Domain: '', BreachDate: '2021-06-01', AddedDate: '2021-07-01T00:00:00Z', PwnCount: 1200, Description: 'In June 2021, Acme Rockets was allegedly breached.', DataClasses: ['Email addresses'], ...flags, IsVerified: false },
];

describe('breach-catalogue (Have I Been Pwned)', () => {
  test('maps a catalogue entry matched by company name', async () => {
    network([[/haveibeenpwned\.com\/api\/v3\/breaches$/, { body: CATALOGUE }]]);
    const { findings, threads } = await breachCatalogueConnector.run(companyTask('Adobe Inc.'), ctxFor('Shantanu Narayen', 'Adobe'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: 'breach-catalogue',
      category: 'exposure',
      title: 'Adobe data breach, 4 October 2013: 152,445,165 accounts',
      url: 'https://haveibeenpwned.com/Breach/Adobe',
      date: '2013-10-04',
      severity: 'medium',
      match: 'company',
      matchReasons: ["the organisation's name matches Adobe Inc."],
    });
    expect(findings[0].sourceLabel).toMatch(/Have I Been Pwned/);
    expect(findings[0].sourceLabel).toMatch(/CC BY 4\.0/);
    expect(findings[0].quote).toBe('Website: adobe.com. Compromised data: Email addresses, Password hints, Passwords, Usernames. Verified breach. In October 2013, 153 million Adobe accounts were breached with each containing an internal ID, username, email, encrypted password and a password hint in plain text.');
    expect(findings[0].quote).not.toMatch(/<|href/);
    expect(findings[0].data).toMatchObject({ domain: 'adobe.com', accounts: 152445165, verified: true, dataClasses: ['Email addresses', 'Password hints', 'Passwords', 'Usernames'] });
    expect(threads).toEqual([]);
  });

  test('matches a domain task by exact registrable domain only', async () => {
    network([[/haveibeenpwned/, { body: CATALOGUE }]]);
    const ctx = ctxFor('Shantanu Narayen', 'Adobe');
    const hit = await breachCatalogueConnector.run(domainTask('https://www.adobe.com/products'), ctx);
    expect(hit.findings.map((f) => f.url)).toEqual(['https://haveibeenpwned.com/Breach/Adobe']);
    expect(hit.findings[0].matchReasons).toEqual(['exact match on the domain adobe.com']);
    expect((await breachCatalogueConnector.run(domainTask('notadobe.com'), ctx)).findings).toEqual([]);
    expect((await breachCatalogueConnector.run(domainTask('gmail.com'), ctx)).findings).toEqual([]);
  });

  test("a same-named entry on another website is dropped once the company's own website is known", async () => {
    network([[/haveibeenpwned/, { body: [
      { Name: 'Bolt', Title: 'Bolt', Domain: 'bolt.cd', BreachDate: '2017-03-01', AddedDate: '2018-01-01T00:00:00Z', PwnCount: 995274, Description: 'In March 2017, the file sharing website Bolt suffered a data breach.', DataClasses: ['Email addresses'], ...flags },
    ] }]]);
    const ctx = ctxFor('Ryan Breslow', 'Bolt');
    expect((await breachCatalogueConnector.run(companyTask('Bolt'), ctx)).findings).toHaveLength(1); // website unknown: reported
    addAnchor(ctx.subject, 'domains', 'bolt.com', 'given');
    expect((await breachCatalogueConnector.run(companyTask('Bolt'), ctx)).findings).toEqual([]);
    addAnchor(ctx.subject, 'domains', 'bolt.cd', 'given');
    expect((await breachCatalogueConnector.run(companyTask('Bolt'), ctx)).findings).toHaveLength(1);
  });

  test('downloads the catalogue once and serves later lookups from the cache', async () => {
    const calls = network([[/haveibeenpwned/, { body: CATALOGUE }]]);
    const ctx = ctxFor('Jane Roe', 'Acme Rockets');
    await breachCatalogueConnector.run(companyTask('Adobe'), ctx);
    const second = await breachCatalogueConnector.run(companyTask('Acme Rockets'), ctx);
    expect(calls).toHaveLength(1);
    expect(second.findings[0].title).toBe('Acme Rockets data breach, 1 June 2021: 1,200 accounts');
    expect(second.findings[0].quote).toMatch(/^Compromised data: Email addresses\. Unverified breach\./); // no website on file for this entry
  });

  test('a title with a year matches, and a protected data class is generalised', async () => {
    network([[/haveibeenpwned/, { body: CATALOGUE }]]);
    const { findings } = await breachCatalogueConnector.run(companyTask('Adult FriendFinder'), ctxFor('Andrew Conru', 'Adult FriendFinder'));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Adult FriendFinder (2015) data breach, 21 May 2015: 3,867,997 accounts');
    expect(findings[0].quote).toContain('Sensitive personal details');
    expect(JSON.stringify(findings[0])).not.toMatch(/Sexual orientations/);
  });

  test('a description about a protected matter is left out, the breach itself is kept', async () => {
    network([[/haveibeenpwned/, { body: CATALOGUE }]]);
    const { findings } = await breachCatalogueConnector.run(companyTask('MindCo'), ctxFor('Jane Roe', 'MindCo'));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('MindCo data breach, 3 March 2022: 90,210 accounts');
    expect(findings[0].quote).toBe('Website: mindco.example. Compromised data: Email addresses, Sensitive personal details, Names. Verified breach.');
    expect(JSON.stringify(findings[0])).not.toMatch(/mental|therapy|Health insurance/);
  });

  test('the personal site of the subject is never looked up', async () => {
    const calls = network([[/haveibeenpwned/, { body: CATALOGUE }]]);
    const ctx = ctxFor('Shantanu Narayen', 'Adobe');
    expect(await breachCatalogueConnector.run(domainTask('shantanunarayen.com'), ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect(calls).toHaveLength(0);
  });

  test('never reports a neighbour, a generic name or a person', async () => {
    const calls = network([[/haveibeenpwned/, { body: CATALOGUE }]]);
    const ctx = ctxFor('Elizabeth Holmes', 'Theranos');
    expect((await breachCatalogueConnector.run(companyTask('Stock'), ctx)).findings).toEqual([]);
    expect((await breachCatalogueConnector.run(companyTask('Theranos'), ctx)).findings).toEqual([]);
    expect((await breachCatalogueConnector.run(companyTask('AI'), ctx)).findings).toEqual([]);
    const callsBefore = calls.length;
    expect((await breachCatalogueConnector.run(companyTask('Elizabeth Holmes'), ctx)).findings).toEqual([]);
    expect((await breachCatalogueConnector.run(companyTask('The Company'), ctx)).notes[0]).toMatch(/too short or too general/);
    expect(calls.length).toBe(callsBefore);
  });

  test('rejects when the catalogue cannot be downloaded', async () => {
    network([[/./, { status: 500, body: 'oops' }]]);
    await expect(breachCatalogueConnector.run(companyTask('Adobe'), ctxFor('Shantanu Narayen', 'Adobe'))).rejects.toThrow(/HTTP 500/);
    // a failed download is remembered for a few minutes; a later attempt (here: a new server instance) asks again
    require('../../../src/server/founder/cache').__resetCacheForTests();
    network([[/./, { body: { error: 'nope' } }]]);
    await expect(breachCatalogueConnector.run(companyTask('Adobe'), ctxFor('Shantanu Narayen', 'Adobe'))).rejects.toThrow(/unexpected response/);
  });
});

/* ------------------------------------------------------------------ */

const caRow = (id, org, dates, reported) => `
          <tr class="odd">
                  <td class="views-field views-field-field-sb24-org-name" >
            <a href="https://oag.ca.gov/ecrime/databreach/reports/sb24-${id}">${org}</a>          </td>
                  <td class="views-field views-field-field-sb24-breach-date" >
            ${dates.map((d) => `<span  property="dc:date" datatype="xsd:dateTime" content="2016-10-13T00:00:00-07:00" class="date-display-single">${d}</span>`).join(', ')}          </td>
                  <td class="views-field views-field-created active" >
            ${reported}          </td>
              </tr>`;
const caPage = (rows) => `<html><body><form action="/privacy/databreach/list" method="get" id="views-exposed-form-sb24-view-page-2"><input name="field_sb24_org_name_value" /></form>
<table class="views-table cols-3 table table-hover table-striped" >
        <thead>
      <tr>
                  <th class="views-field views-field-field-sb24-org-name" >
            <a href="/privacy/databreach/list?field_sb24_org_name_value=Uber&amp;order=field_sb24_org_name&amp;sort=asc" title="sort by Organization Name" class="active">Organization Name</a>          </th>
                  <th class="views-field views-field-field-sb24-breach-date" >
            Date(s) of Breach          </th>
                  <th class="views-field views-field-created active" >Reported Date</th>
              </tr>
    </thead>
    <tbody>${rows.join('')}
      </tbody>
</table></body></html>`;
const CA_UBER = caPage([
  caRow('632751', 'Uber Technologies, Inc.', ['10/07/2026'], '11/10/2026'),
  caRow('620613', 'The Shubert Organization, Inc.', ['01/19/2026'], '03/20/2026'),
  caRow('613883', 'Cole Huber, LLP', ['12/26/2024'], '11/05/2025'),
  caRow('112414', 'Uber Technologies, Inc.', ['10/13/2016', '11/15/2016'], '11/21/2017'),
]);
const CA_NONE = caPage([]);

const WA_UBER = [
  { name: "St. Hubert's Church", id: '10318', datesubmitted: '2020-09-18T00:00:00.000', databreachcause: 'Theft or Mistake', washingtoniansaffected: '657', industrytype: 'Non-Profit/Charity', datestart: '2020-08-20T00:00:00.000', dateaware: '2020-08-20T00:00:00.000' },
  { name: 'Uber Technologies, Inc.', id: '9752', datesubmitted: '2017-11-21T00:00:00.000', databreachcause: 'Cyberattack', cyberattacktype: 'Unclear/unknown', washingtoniansaffected: '10888', industrytype: 'Business', businesstype: 'Transportation', datestart: '2016-10-13T00:00:00.000', dateaware: '2016-11-15T00:00:00.000', daystoidentifybreach: '33', dayselapsedbeforenotification: '371' },
  { name: 'Uber Technologies', id: '9627', datesubmitted: '2016-06-16T00:00:00.000', databreachcause: 'Unauthorized Access', washingtoniansaffected: '1355', industrytype: 'Business', businesstype: 'Transportation', datestart: '2014-05-13T00:00:00.000', dateaware: '2014-09-17T00:00:00.000' },
];

const orRow = (org, reported, from, to, affected) => `
            <tr>
                <td>
                    ${org}
                </td>
                <td>${reported}</td>
                <td>


${from}                             - ${to}                </td>
                <td>
${to}<br />
                </td>
                <td>
${reported}<br />
                </td>
                <td>
                    ${affected}
                </td>
            </tr>`;
const orPage = (rows) => `

<table id="grid" class="webgrid-table">
    <thead>
        <tr>
            <th scope="col">
                Organization
            </th>
            <th scope="col">
                Reported Date
            </th>
            <th scope="col">
                Dates of Breach
            </th>
            <th scope="col">
                Dates of Discovery
            </th>
            <th scope="col">
                Date Notice Sent
            </th>
            <th scope="col">
                Number Affected
            </th>
        </tr>
    </thead>
    <tbody>${rows.join('')}
    </tbody>
</table>
<script type='text/javascript'>$(document).ready(function () { var table = $('#grid').dataTable({}); });</script>`;
const OR_UBER = orPage([
  orRow('Uber Technologies, Inc.', '11/22/2017', '10/13/2016', '11/15/2016', '5437'),
  orRow('J.M. Huber Corporation', '3/2/2023', '1/5/2023', '1/5/2023', '812'),
]);
const OR_NONE = orPage([]);

const ICO_CAPITA = {
  results: [
    { filterItemMetaData: '15 October 2025, Monetary penalties', title: 'Capita plc and Capita Pension Solutions Ltd', createdDateTime: '2025-10-15T06:59:51.15Z', id: 81453, url: '/action-weve-taken/enforcement/2025/10/capita-plc/', description: 'The Information Commissioner’s Office has fined Capita plc and Capita Pension Solutions Ltd a combined £14m following a cyber attack in April 2023 which saw hackers gain access to over 6m people’s data. ' },
    { filterItemMetaData: '10 March 2023, Reprimands, Online technology and telecoms', title: 'Gain Capital UK Limited', createdDateTime: '2024-08-22T12:46:45Z', id: 17265, url: '/action-weve-taken/enforcement/2023/03/gain-capital-uk-limited/', description: 'Gain Capital UK have been issued a Reprimand in respect of Articles 32 (2) and 32 (1) (b).' },
  ],
  pagination: { totalResults: 2, perPage: 25, totalPages: 1 },
};
const ICO_NONE = { results: [], pagination: { totalResults: 0 } };

const registers = ({ ca = { body: CA_NONE }, wa = { body: [] }, or = { body: OR_NONE }, ico = { body: ICO_NONE } } = {}) => network([
  [/^https:\/\/oag\.ca\.gov\/privacy\/databreach\/list\?/, ca],
  [/^https:\/\/data\.wa\.gov\/resource\/sb4j-ca4h\.json\?/, wa],
  [/^https:\/\/justice\.oregon\.gov\/consumer\/DataBreach\/Home\/SearchBreaches$/, or],
  [/^https:\/\/ico\.org\.uk\/api\/search$/, ico],
]);

describe('breach-registers (state attorneys general and the UK ICO)', () => {
  test('asks the four registers in parallel with the right requests', async () => {
    const calls = registers({ ca: { body: CA_UBER }, wa: { body: WA_UBER }, or: { body: OR_UBER } });
    await breachRegistersConnector.run(companyTask('Uber Technologies, Inc.'), ctxFor('Travis Kalanick', 'Uber'));
    expect(calls).toHaveLength(4);
    const byHost = Object.fromEntries(calls.map((c) => [new URL(c.url).hostname, c]));
    expect(byHost['oag.ca.gov'].url).toBe('https://oag.ca.gov/privacy/databreach/list?field_sb24_org_name_value=Uber');
    expect(decodeURIComponent(byHost['data.wa.gov'].url)).toContain("$where=upper(name) like '%UBER%'");
    expect(byHost['justice.oregon.gov']).toMatchObject({ method: 'POST', body: 'organization=Uber&start=&end=' });
    expect(byHost['justice.oregon.gov'].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(byHost['ico.org.uk'].method).toBe('POST');
    expect(JSON.parse(byHost['ico.org.uk'].body)).toEqual({ filters: [], pageNumber: 1, order: 'newest', term: 'Uber', rootPageId: 17222 });
  });

  test('one finding per notice, newest first, without the look-alike organisations', async () => {
    registers({ ca: { body: CA_UBER }, wa: { body: WA_UBER }, or: { body: OR_UBER } });
    const { findings, notes, threads } = await breachRegistersConnector.run(companyTask('Uber'), uberCtx());
    expect(findings.map((f) => f.title)).toEqual([
      'Uber Technologies, Inc.: data breach notice filed with the California Attorney General, reported 10 November 2026',
      'Uber Technologies, Inc.: data breach notice filed with the Oregon Department of Justice, reported 22 November 2017 (5,437 people affected)',
      'Uber Technologies, Inc.: data breach notice filed with the California Attorney General, reported 21 November 2017',
      'Uber Technologies, Inc.: data breach notice filed with the Washington Attorney General, reported 21 November 2017 (10,888 Washington residents affected)',
      'Uber Technologies: data breach notice filed with the Washington Attorney General, reported 16 June 2016 (1,355 Washington residents affected)',
    ]);
    expect(JSON.stringify(findings)).not.toMatch(/Huber|Shubert|Hubert/);
    for (const f of findings) expect(f).toMatchObject({ source: 'breach-registers', category: 'exposure', severity: 'medium', match: 'company' });
    expect(notes).toEqual([REGISTERS_COVERAGE]);
    expect(REGISTERS_COVERAGE).toMatch(/federal register of health-data breaches \(HHS\) is not searched/);
    expect(threads).toEqual([]);
    expect(pagesAreDistinct(findings)).toBe(true);

    const california = findings[2];
    expect(california).toMatchObject({ url: 'https://oag.ca.gov/ecrime/databreach/reports/sb24-112414', date: '2017-11-21' });
    expect(california.quote).toBe('Organization Name: Uber Technologies, Inc. Date(s) of Breach: 10/13/2016, 11/15/2016. Reported Date: 11/21/2017.');
    expect(california.sourceLabel).toMatch(/California Attorney General/);
    expect(california.data).toMatchObject({ register: 'California Attorney General', reported: '2017-11-21', breachDates: '10/13/2016, 11/15/2016' });

    const washington = findings[3];
    expect(washington).toMatchObject({ url: 'https://data.wa.gov/resource/sb4j-ca4h/9752.json', date: '2017-11-21' });
    expect(washington.quote).toBe('Name: Uber Technologies, Inc. Date submitted: 2017-11-21. Breach dates: 2016-10-13. Cause: Cyberattack (Unclear/unknown). Washingtonians affected: 10,888. Days to identify the breach: 33. Days elapsed before notification: 371.');
    expect(washington.data).toMatchObject({ affected: '10,888', cause: 'Cyberattack' });

    const oregon = findings[1];
    expect(oregon).toMatchObject({ url: 'https://justice.oregon.gov/consumer/databreach/', date: '2017-11-22' });
    expect(oregon.quote).toBe('Organization: Uber Technologies, Inc. Reported Date: 11/22/2017. Dates of Breach: 10/13/2016 - 11/15/2016. Dates of Discovery: 11/15/2016. Number Affected: 5,437.');
  });

  test('ICO enforcement: keeps the action against the company, drops the look-alike', async () => {
    registers({ ico: { body: ICO_CAPITA } });
    const { findings } = await breachRegistersConnector.run(companyTask('Capita'), ctxFor('Adolfo Hernandez', 'Capita'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: "Capita plc and Capita Pension Solutions Ltd: UK Information Commissioner's Office enforcement action (Monetary penalties), 15 October 2025",
      url: 'https://ico.org.uk/action-weve-taken/enforcement/2025/10/capita-plc/',
      date: '2025-10-15',
      category: 'exposure',
      severity: 'medium',
      match: 'company',
      matchReasons: ['the entry begins with the name Capita'],
    });
    expect(findings[0].quote).toMatch(/^The Information Commissioner’s Office has fined Capita plc/);
    expect(findings[0].sourceLabel).toMatch(/Open Government Licence/);
  });

  test('Oregon has one page for every notice, so several notices are one finding', async () => {
    registers({
      or: {
        body: orPage([
          orRow('Uber Technologies, Inc.', '11/22/2017', '10/13/2016', '11/15/2016', '5437'),
          orRow('J.M. Huber Corporation', '3/2/2023', '1/5/2023', '1/5/2023', '812'),
          orRow('Uber Technologies', '2/27/2015', '5/13/2014', '5/13/2014', '0'),
        ]),
      },
    });
    const { findings } = await breachRegistersConnector.run(companyTask('Uber'), uberCtx());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: 'Uber Technologies, Inc.: 2 data breach notices filed with the Oregon Department of Justice, most recently reported 22 November 2017',
      url: 'https://justice.oregon.gov/consumer/databreach/',
      date: '2017-11-22',
      severity: 'medium',
      match: 'company',
    });
    expect(findings[0].quote).toBe('Organization: Uber Technologies, Inc. Reported Date: 11/22/2017. Dates of Breach: 10/13/2016 - 11/15/2016. Dates of Discovery: 11/15/2016. Number Affected: 5,437. Organization: Uber Technologies. Reported Date: 2/27/2015. Dates of Breach: 5/13/2014. Dates of Discovery: 5/13/2014.');
    expect(findings[0].data.notices).toEqual([
      { organisation: 'Uber Technologies, Inc.', reported: '2017-11-22', breachDates: '10/13/2016 - 11/15/2016', affected: '5,437' },
      { organisation: 'Uber Technologies', reported: '2015-02-27', breachDates: '5/13/2014', affected: null },
    ]);
    expect(JSON.stringify(findings)).not.toMatch(/Huber/);
  });

  test('says so when a register had more entries than it read', async () => {
    const many = Array.from({ length: 50 }, (_, i) => caRow(String(700000 + i), i === 7 ? 'One Finance, Inc.' : `Someone ${i} Health Plan`, ['01/02/2025'], '02/03/2025'));
    registers({
      ca: { body: caPage(many) },
      ico: { body: { results: [], pagination: { totalResults: 60, perPage: 25, totalPages: 3 } } },
    });
    const { findings, notes } = await breachRegistersConnector.run(companyTask('One Finance'), ctxFor('Brian Hamilton', 'One Finance'));
    expect(findings.map((f) => f.url)).toEqual(['https://oag.ca.gov/ecrime/databreach/reports/sb24-700007']);
    expect(notes).toEqual([
      REGISTERS_COVERAGE,
      'The California Attorney General\'s breach list has more than 50 entries containing "One Finance"; only the 50 most recent were read.',
      'The UK Information Commissioner\'s Office list has more than one page of results for "One Finance"; only the most recent 0 were read.',
    ]);
  });

  test('an ICO summary about a protected matter is left out, the action is kept', async () => {
    registers({
      ico: {
        body: {
          results: [{ filterItemMetaData: '2 May 2024, Reprimands, Health', title: 'Acme Clinics Ltd', createdDateTime: '2024-05-02T09:00:00Z', id: 1, url: '/action-weve-taken/enforcement/2024/05/acme-clinics-ltd/', description: 'Acme Clinics disclosed the HIV status of 37 patients by email.' }],
          pagination: { totalResults: 1, perPage: 25, totalPages: 1 },
        },
      },
    });
    const { findings } = await breachRegistersConnector.run(companyTask('Acme Clinics'), ctxFor('Jane Roe', 'Acme Clinics'));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("Acme Clinics Ltd: UK Information Commissioner's Office enforcement action (Reprimands), 2 May 2024");
    expect(findings[0].quote).toBe('Organisation: Acme Clinics Ltd. Action: 2 May 2024, Reprimands, Health.');
    expect(JSON.stringify(findings)).not.toMatch(/HIV|patients/);
  });

  test('one register down: the others still report, and the gap is said out loud', async () => {
    registers({ ca: { body: CA_UBER }, wa: { body: WA_UBER }, or: { status: 500, body: 'oops' } });
    const { findings, notes } = await breachRegistersConnector.run(companyTask('Uber'), ctxFor('Travis Kalanick', 'Uber'));
    expect(findings).toHaveLength(4);
    expect(notes).toEqual([REGISTERS_COVERAGE, 'Regulator breach registers: the Oregon Department of Justice could not be read for Uber, so that register was not searched.']);
  });

  test('an unexpected page counts as a failure of that register', async () => {
    registers({ ca: { body: '<html>Access denied</html>' }, wa: { body: { error: true } }, or: { body: '<p>Server error</p>' }, ico: { body: ICO_NONE } });
    const { findings, notes } = await breachRegistersConnector.run(companyTask('Uber'), ctxFor('Travis Kalanick', 'Uber'));
    expect(findings).toEqual([]);
    expect(notes[1]).toMatch(/the California Attorney General, the Washington Attorney General, the Oregon Department of Justice could not be read for Uber, so those registers were not searched/);
  });

  test('rejects when every register is down', async () => {
    network([[/./, { status: 500, body: 'oops' }]]);
    await expect(breachRegistersConnector.run(companyTask('Uber'), ctxFor('Travis Kalanick', 'Uber'))).rejects.toThrow(/None of the regulator breach registers could be read/);
  });

  test('never searches a person, a domain or a generic name', async () => {
    const calls = registers();
    const ctx = ctxFor('Elizabeth Holmes', 'Theranos');
    expect(await breachRegistersConnector.run(companyTask('Elizabeth Holmes'), ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect(await breachRegistersConnector.run({ kind: 'relative', value: 'Christian Holmes' }, ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect(await breachRegistersConnector.run(domainTask('theranos.com'), ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect((await breachRegistersConnector.run(companyTask('AI'), ctx)).notes[0]).toMatch(/too short or too general/);
    expect(calls).toHaveLength(0);
    // a company with nothing on file: four answers, no findings, and the standing statement of what was searched
    expect(await breachRegistersConnector.run(companyTask('Theranos'), ctx)).toEqual({ findings: [], threads: [], notes: [REGISTERS_COVERAGE] });
    expect(calls).toHaveLength(4);
  });
});
