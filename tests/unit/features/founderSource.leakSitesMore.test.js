/**
 * More leak-site indexes (RansomFeed, the ransomwatch archive): company-level only.
 * Fixtures follow the real response shapes (checked live on 2026-11-20), shortened,
 * with invented companies and people.
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport, HOST_GAP_MS } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, addCompanyAlias } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const {
  ransomfeedConnector, ransomwatchArchiveConnector, leakSitesMoreConnectors, compactArchive,
} = require('../../../src/server/founder/sources/leakSitesMore');

/** Fake network: the first pattern that matches the URL answers. Returns the list of calls made. */
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
const domainTask = (value) => ({ kind: 'domain', value, depth: 1, template: null, params: null });

// Attacker-written and personal fields: none of these may ever reach a finding.
const SECRET = {
  description: 'SECRET-DESCRIPTION we have 2TB of their files, pay or we publish',
  victim_notes: 'SECRET-NOTES contact jane.roe@example.com',
  dataset_pub: 'http://abcdefghijklmnop.onion/SECRET-DATASET',
  hash: 'SECRET-HASH-0123456789abcdef',
  city: 'SECRET-CITY Springfield',
  region: 'SECRET-REGION',
  fortibleed_leak: 'no',
};
/** One RansomFeed row, as the index writes it. */
const feedRow = (over) => ({ id: '10813', date: '2023-09-14 20:39:00', victim: 'Statement on Brightwater Analytics: Setting the record straight', gang: 'alphv', website: 'www.brightwateranalytics.com', country: 'USA', work_sector: 'Technologies', ...SECRET, ...over });
const noSecrets = (findings) => {
  const text = JSON.stringify(findings);
  expect(text).not.toMatch(/SECRET|onion|pay or we publish|jane\.roe/i);
};

beforeEach(() => __resetCacheForTests());
afterEach(() => setTransport());

describe('the connectors', () => {
  test('distinct ids, company and domain only, plain labels, paced host', () => {
    expect(leakSitesMoreConnectors.map((c) => c.id)).toEqual(['leak-sites-ransomfeed', 'leak-sites-archive']);
    for (const c of leakSitesMoreConnectors) {
      expect(c.kinds).toEqual(['company', 'domain']);
      expect(c.label).not.toMatch(/\b(api|endpoint|key|token|free|paid|tier|env)\b/i);
      expect(c.unavailableReason).not.toMatch(/\b(api|endpoint|key|token|free|paid|tier|env)\b/i);
      expect(typeof c.enabled()).toBe('boolean');
    }
    expect(HOST_GAP_MS['api.ransomfeed.it']).toBeGreaterThanOrEqual(2000);
  });

  test('switched off by FOUNDER_SOURCES_OFF', () => {
    const before = process.env.FOUNDER_SOURCES_OFF;
    process.env.FOUNDER_SOURCES_OFF = 'leak-sites-archive';
    expect(ransomwatchArchiveConnector.enabled()).toBe(false);
    expect(ransomfeedConnector.enabled()).toBe(true);
    if (before === undefined) delete process.env.FOUNDER_SOURCES_OFF; else process.env.FOUNDER_SOURCES_OFF = before;
  });
});

/* ------------------------------------------------------------------ */

describe('leak-sites-ransomfeed', () => {
  test('maps a post of a distinctive two-word company and drops every attacker-written field', async () => {
    const calls = network([
      [/\/search\/brightwateranalytics$/, { body: [feedRow({})] }],
      [/\/search\/brightwater$/, {
        body: [
          feedRow({}), // the same post found again
          feedRow({ id: '20001', date: '2024-02-01 10:00:00', victim: 'Brightwater Analytics - 400GB, pay or we publish', gang: 'lockbit3', website: 'None' }),
          // the search also reads the description: a row only mentioning the company is not its listing
          feedRow({ id: '20002', victim: 'Kestrel Pharma Services', gang: 'play', website: 'kestrelpharma.example', description: 'a supplier of Brightwater Analytics' }),
          feedRow({ id: '20003', victim: 'Brightwater Marina Club', gang: 'akira', website: 'bwmarina.example' }),
        ],
      }],
    ]);
    const result = await ransomfeedConnector.run(companyTask('Brightwater Analytics'), ctxFor('Jane Roe', 'Brightwater Analytics'));

    expect(calls.map((c) => c.url)).toEqual(['https://api.ransomfeed.it/search/brightwateranalytics', 'https://api.ransomfeed.it/search/brightwater']);
    expect(result.findings).toHaveLength(2);
    const alphv = result.findings.find((f) => /alphv/.test(f.title));
    const lockbit = result.findings.find((f) => /lockbit3/.test(f.title));
    expect(alphv).toMatchObject({
      source: 'leak-sites-ransomfeed', category: 'exposure', match: 'company', severity: 'medium', date: '2023-09-14',
      title: 'Brightwater Analytics listed by alphv on a ransomware leak site (claimed, unverified)',
      url: 'https://ransomfeed.it/index.php?page=post_details&id_post=10813',
    });
    expect(alphv.quote).toMatch(/Website: brightwateranalytics\.com\./);
    expect(alphv.data).toMatchObject({ organisation: 'Brightwater Analytics', group: 'alphv', domain: 'brightwateranalytics.com', country: 'USA', status: 'claimed, unverified', posts: ['10813'] });
    // only the company's own name from the attacker's headline is shown
    expect(lockbit.title).toBe('Brightwater Analytics listed by lockbit3 on a ransomware leak site (claimed, unverified)');
    expect(lockbit.data.domain).toBeNull();
    noSecrets(result.findings);
    for (const f of result.findings) {
      expect(['company', 'possible']).toContain(f.match);
      expect(f.data).not.toHaveProperty('city');
      expect(f.data).not.toHaveProperty('region');
      expect(f.data).not.toHaveProperty('description');
    }
  });

  test('a namesake row that only shares letters is thrown away, and an empty search says what was searched', async () => {
    network([[/\/search\/nikola$/, { body: [feedRow({ id: '15216', victim: 'Nikolaus & Hohenadel', gang: 'bianlian', website: 'n-hlaw.com', work_sector: 'Attorney' })] }]]);
    const result = await ransomfeedConnector.run(companyTask('Nikola'), ctxFor('Trevor Milton', 'Nikola'));
    expect(result.findings).toEqual([]);
    expect(result.partial).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/searched for Nikola .*"nikola".*no post names it.*not proof/);
    expect(result.notes.join(' ')).not.toMatch(/\b(could not|did not|failed|unavailable)\b/);
  });

  test('a one-word ordinary company name is a possible namesake until its own website or legal name ties it', async () => {
    const rows = [
      feedRow({ id: '30001', victim: 'Ledger Inc.', gang: 'qilin', website: 'ledger-books.example', date: '2025-03-01 00:00:00' }),
      feedRow({ id: '30002', victim: 'Ledger Systems', gang: 'medusa', website: 'None', date: '2025-04-01 00:00:00' }),
    ];
    network([[/\/search\/ledger$/, { body: rows }], [/\/search\/ledger\.dev$/, { body: [feedRow({ id: '30003', victim: 'ledger.dev', gang: 'incransom', website: 'ledger.dev' })] }]]);

    const plain = await ransomfeedConnector.run(companyTask('Ledger'), ctxFor('Jane Roe', 'Ledger'));
    expect(plain.findings.length).toBe(2);
    for (const f of plain.findings) {
      expect(f.match).toBe('possible');
      expect(f.severity).toBe('low');
      expect(f.matchReasons.join(' ')).toMatch(/check it is the same company/);
      expect(f.data).toMatchObject({ companyNamesake: true, excludeFromTimeline: true });
    }

    // a legal name the check learned ties that entry
    const learned = ctxFor('Jane Roe', 'Ledger');
    addCompanyAlias(learned.subject, { company: 'Ledger', alias: 'Ledger Systems, Inc.', origin: 'sec-filings-1' });
    const byLegal = await ransomfeedConnector.run(companyTask('Ledger'), learned);
    expect(byLegal.findings.find((f) => /medusa/.test(f.title)).match).toBe('company');
    expect(byLegal.findings.find((f) => /qilin/.test(f.title)).match).toBe('possible');

    // the company's own website ties its listing; a namesake row then says the website was searched
    const withSite = ctxFor('Jane Roe', 'Ledger');
    addAnchor(withSite.subject, 'domains', 'ledger.dev', 'given');
    const bySite = await ransomfeedConnector.run(companyTask('Ledger'), withSite);
    const own = bySite.findings.find((f) => /incransom/.test(f.title));
    expect(own).toMatchObject({ match: 'company' });
    expect(own.data.nameMatch).toBe('domain');
    expect(bySite.findings.find((f) => /qilin/.test(f.title)).match).toBe('possible');
  });

  test('never grades a record about the person', async () => {
    network([[/\/search\/theranos$/, { body: [feedRow({ id: '40001', victim: 'Theranos Inc.', gang: 'akira', website: 'theranos.com' })] }]]);
    const result = await ransomfeedConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].match).toBe('company');
    expect(result.findings.some((f) => f.match === 'confirmed' || f.match === 'likely')).toBe(false);
  });

  test('a domain task searches the domain and keeps only that website', async () => {
    const calls = network([[/\/search\/brightwateranalytics\.com$/, {
      body: [feedRow({}), feedRow({ id: '50001', victim: 'Other Co', website: 'brightwateranalytics.com.evil.example', gang: 'play' })],
    }]]);
    const result = await ransomfeedConnector.run(domainTask('https://www.brightwateranalytics.com/about'), ctxFor('Jane Roe', 'Brightwater Analytics'));
    expect(calls.map((c) => c.url)).toEqual(['https://api.ransomfeed.it/search/brightwateranalytics.com']);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ match: 'company', title: 'brightwateranalytics.com listed by alphv on a ransomware leak site (claimed, unverified)' });
  });

  test('never searches a person, a shared mail domain, or a name too general to match', async () => {
    const calls = network([]);
    const ctx = ctxFor('Trevor Milton', 'Nikola');
    expect(await ransomfeedConnector.run(companyTask('Trevor Milton'), ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect(await ransomfeedConnector.run(domainTask('gmail.com'), ctx)).toEqual({ findings: [], threads: [], notes: [] });
    expect(await ransomfeedConnector.run({ kind: 'associate', value: 'Jane Roe' }, ctx)).toEqual({ findings: [], threads: [], notes: [] });
    const general = await ransomfeedConnector.run(companyTask('Global Holdings Ltd'), ctx);
    expect(general.findings).toEqual([]);
    expect(general.notes[0]).toMatch(/too short or too general/);
    expect(calls).toHaveLength(0);
  });

  test('a capped search says only the most recent posts were read', async () => {
    const many = Array.from({ length: 100 }, (_, i) => feedRow({ id: String(60000 + i), victim: `Unrelated Firm ${i}` }));
    network([[/\/search\/nikola$/, { body: many }]]);
    const result = await ransomfeedConnector.run(companyTask('Nikola'), ctxFor('Trevor Milton', 'Nikola'));
    expect(result.notes.join(' ')).toMatch(/more than 100 posts containing "nikola"; only the 100 most recent were read/);
  });

  test('throws when the index is down, answers something else, or changed its format', async () => {
    const ctx = () => ctxFor('Elizabeth Holmes', 'Theranos');
    network([[/ransomfeed/, { status: 500, body: 'oops' }]]);
    await expect(ransomfeedConnector.run(companyTask('Theranos'), ctx())).rejects.toThrow(/HTTP 500/);
    network([[/ransomfeed/, { body: { error: 'maintenance' } }]]);
    await expect(ransomfeedConnector.run(companyTask('Theranos'), ctx())).rejects.toThrow(/unexpected response/);
    network([[/ransomfeed/, { body: [{ name: 'Theranos', group: 'akira' }] }]]);
    await expect(ransomfeedConnector.run(companyTask('Theranos'), ctx())).rejects.toThrow(/changed its format/);
    network([[/ransomfeed/, { body: '<html>maintenance</html>' }]]);
    await expect(ransomfeedConnector.run(companyTask('Theranos'), ctx())).rejects.toThrow(/not JSON/);
  });

  test('a later search that does not answer makes the lookup partial, with a note', async () => {
    network([
      [/\/search\/brightwateranalytics$/, { body: [] }],
      [/\/search\/brightwater$/, { status: 502, body: 'bad gateway' }],
    ]);
    const result = await ransomfeedConnector.run(companyTask('Brightwater Analytics'), ctxFor('Jane Roe', 'Brightwater Analytics'));
    expect(result.findings).toEqual([]);
    expect(result.partial).toEqual(['RansomFeed search for "brightwater"']);
    expect(result.notes.join(' ')).toMatch(/search for "brightwater" could not be completed/);
  });
});

/* ------------------------------------------------------------------ */

const filler = Array.from({ length: 10500 }, (_, i) => ({ post_title: `Filler Holding Number ${i}`, group_name: 'lockbit2', discovered: '2021-05-01 00:00:00.000000' }));
const archive = (extra) => [
  ...filler,
  { post_title: 'Brightwater Analytics', group_name: 'conti', discovered: '2021-08-03 00:00:00.000000' },
  { post_title: 'Brightwater Analytics (brightwateranalytics.com)', group_name: 'conti', discovered: '2021-09-10 12:00:00.000000' },
  { post_title: 'Leaks Company Brightwater Analytics inc. - all files, pay now', group_name: 'ragnarlocker', discovered: '2020-06-10 00:00:00.000000' },
  { post_title: 'Zuber Gardner CPAs', group_name: 'everest', discovered: '2022-01-01 00:00:00.000000' },
  { post_title: 'Gruber Tool &amp; Die (grubertool.com)', group_name: 'play', discovered: '2023-01-01 00:00:00.000000' },
  { post_title: 'NF Stroth &amp; Associates', group_name: 'play', discovered: '2025-06-16 20:30:52.596196' },
  ...(extra || []),
];

describe('leak-sites-archive (ransomwatch)', () => {
  test('matches the frozen archive, one finding per group, and downloads it once', async () => {
    const calls = network([[/raw\.githubusercontent\.com\/joshhighet\/ransomwatch\/main\/posts\.json$/, { body: archive() }]]);
    const ctx = ctxFor('Jane Roe', 'Brightwater Analytics');
    const result = await ransomwatchArchiveConnector.run(companyTask('Brightwater Analytics'), ctx);

    expect(result.findings).toHaveLength(2);
    const conti = result.findings.find((f) => /conti/.test(f.title));
    expect(conti).toMatchObject({
      source: 'leak-sites-archive', category: 'exposure', match: 'company', severity: 'medium', date: '2021-08-03',
      title: 'Brightwater Analytics listed by conti on a ransomware leak site, archived (claimed, unverified)',
      url: 'https://raw.githubusercontent.com/joshhighet/ransomwatch/main/posts.json',
    });
    expect(conti.data).toMatchObject({ firstSeen: '2021-08-03', lastSeen: '2021-09-10', listings: 2, archiveEnds: '2025-06-16', status: 'claimed, unverified' });
    expect(conti.quote).toMatch(/archive that stops in 2025-06/);
    const ragnar = result.findings.find((f) => /ragnarlocker/.test(f.title));
    expect(ragnar.title).not.toMatch(/pay now|all files/);
    expect(result.notes.join(' ')).toMatch(/stops on 2025-06-16 and is no longer updated/);

    await ransomwatchArchiveConnector.run(companyTask('Brightwater Analytics'), ctx);
    expect(calls).toHaveLength(1);
  });

  test('substring neighbours are re-checked against the name, and a clean search is not called a clean record', async () => {
    network([[/posts\.json$/, { body: archive() }]]);
    const result = await ransomwatchArchiveConnector.run(companyTask('Uber'), ctxFor('Travis Roe', 'Uber'));
    expect(result.findings).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/searched for Uber; no archived post names it.*frozen archive, not a current screen/);
    expect(result.notes.join(' ')).not.toMatch(/\b(could not|did not|failed|unavailable)\b/);
  });

  test('a domain task matches the domain written in a title, entities decoded', async () => {
    network([[/posts\.json$/, { body: archive() }]]);
    const result = await ransomwatchArchiveConnector.run(domainTask('grubertool.com'), ctxFor('Jane Roe', 'Gruber Tool'));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ match: 'company', title: 'grubertool.com listed by play on a ransomware leak site, archived (claimed, unverified)' });
    expect(compactArchive(archive()).some(([t]) => t === 'Gruber Tool & Die (grubertool.com)')).toBe(true);
  });

  test('throws when the archive is missing, not a list, or far shorter than it should be', async () => {
    const ctx = () => ctxFor('Jane Roe', 'Brightwater Analytics');
    network([[/posts\.json$/, { status: 404, body: 'Not Found' }]]);
    await expect(ransomwatchArchiveConnector.run(companyTask('Brightwater Analytics'), ctx())).rejects.toThrow(/HTTP 404/);
    __resetCacheForTests();
    network([[/posts\.json$/, { body: { posts: [] } }]]);
    await expect(ransomwatchArchiveConnector.run(companyTask('Brightwater Analytics'), ctx())).rejects.toThrow(/unexpected response/);
    __resetCacheForTests();
    network([[/posts\.json$/, { body: [] }]]);
    await expect(ransomwatchArchiveConnector.run(companyTask('Brightwater Analytics'), ctx())).rejects.toThrow(/format may have changed/);
    __resetCacheForTests();
    network([[/posts\.json$/, { body: filler.map((p) => ({ title: p.post_title, group: p.group_name })) }]]);
    await expect(ransomwatchArchiveConnector.run(companyTask('Brightwater Analytics'), ctx())).rejects.toThrow(/format may have changed/);
  });

  test('the cached index is small and holds only title, group and day', () => {
    const index = compactArchive(archive());
    expect(index[0]).toEqual(['Filler Holding Number 0', 'lockbit2', '2021-05-01']);
    // the real archive (16,072 posts) as this index is well under the 6 MB stored-cache limit
    expect(JSON.stringify(index).length / index.length * 16072).toBeLessThan(6 * 1024 * 1024);
  });
});
