/**
 * Domain history connector: registration dates and web-archive captures for
 * a company's domain (certificate logs are deliberately not searched). The network is faked with
 * fixtures cut from real answers (nikolamotor.com, 14 Nov 2026).
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { domainHistoryConnector, companyDomainFromUrl } = require('../../../src/server/founder/sources/domains');

const SPARKLINE = {
  years: {
    2016: [0, 0, 0, 0, 1, 4, 2, 1, 3, 1, 1, 0],
    2017: [3, 3, 0, 1, 0, 7, 0, 2, 3, 6, 4, 3],
    2020: [2, 3, 3, 8, 6, 20, 14, 20, 147, 75, 60, 169],
  },
  first_ts: '20160510055509',
  last_ts: '20201104100429',
  status: { 2016: '444433232324' },
};
const NO_CAPTURES = { years: {}, first_ts: null, last_ts: null, status: {}, message: '<div class="error-text">The Wayback Machine has not archived that URL.</div>' };

// A registration record as a registrar that does not redact would return it: the contact block holds a person's details.
const RDAP = {
  objectClassName: 'domain',
  ldhName: 'NIKOLAMOTOR.COM',
  status: ['client transfer prohibited', 'client update prohibited'],
  entities: [
    { objectClassName: 'entity', handle: '69', roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Tucows Domains Inc.']]] },
    {
      objectClassName: 'entity', roles: ['registrant'],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Jordan Q. Registrant'], ['adr', {}, 'text', ['', '', '4141 E Broadway Road', 'Phoenix', 'AZ', '85040', 'US']],
        ['tel', { type: 'voice' }, 'uri', 'tel:+1.4805550142'], ['email', {}, 'text', 'jordan.registrant@example.org']]],
    },
  ],
  events: [
    { eventAction: 'registration', eventDate: '2014-12-21T08:28:35Z' },
    { eventAction: 'expiration', eventDate: '2027-12-21T08:28:35Z' },
    { eventAction: 'last changed', eventDate: '2019-05-02T00:17:00Z' },
    { eventAction: 'last update of RDAP database', eventDate: '2026-11-14T21:34:35Z' },
  ],
  nameservers: [{ objectClassName: 'nameserver', ldhName: 'NS1.EXAMPLE-DNS.COM' }, { objectClassName: 'nameserver', ldhName: 'NS2.EXAMPLE-DNS.COM' }],
};
const CERTIFICATES = [
  { id: 3, issuer_name: "C=US, O=Let's Encrypt, CN=R3", common_name: 'nikolamotor.com', name_value: 'nikolamotor.com\ninternal-build.nikolamotor.com', not_before: '2021-03-01T10:00:00', not_after: '2021-05-30T10:00:00' },
  { id: 1, issuer_name: 'C=US, O=DigiCert Inc', common_name: 'nikolamotor.com', name_value: 'nikolamotor.com', not_before: '2016-02-11T00:00:00', not_after: '2017-02-11T00:00:00' },
];

const reply = (body, status = 200) => ({ status, headers: new Map(), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/** Fake network: one answer per host, each a value or a function of the URL. Records every request. */
function fakeNetwork({ archive = SPARKLINE, cdx = [['timestamp', 'original', 'statuscode']], rdap = RDAP, certificates = reply('<html>502 Bad Gateway</html>', 502) } = {}) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, init });
    const answer = url.includes('/__wb/sparkline') ? archive : url.includes('/cdx/search/cdx') ? cdx : url.startsWith('https://rdap.org/') ? rdap : url.startsWith('https://crt.sh/') ? certificates : reply('not found', 404);
    const value = typeof answer === 'function' ? answer(url) : answer;
    return { url, ...(value && typeof value.text === 'function' ? value : reply(value)) };
  });
  return calls;
}

const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const run = (value, extra = {}) => domainHistoryConnector.run({ kind: 'domain', value, ...extra }, { subject, deadline: Date.now() + 20000, known: () => ({}) });

beforeEach(() => setTransport(async (url) => { throw new Error(`unexpected request to ${url}`); }));
afterEach(() => { setTransport(); delete process.env.FOUNDER_SOURCES_OFF; });

describe('companyDomainFromUrl', () => {
  test('reduces a web address to the registrable domain', () => {
    expect(companyDomainFromUrl('https://www.Theranos.com/about?x=1')).toBe('theranos.com');
    expect(companyDomainFromUrl('nikolamotor.com')).toBe('nikolamotor.com');
    expect(companyDomainFromUrl('http://blog.stripe.com/')).toBe('stripe.com');
    expect(companyDomainFromUrl('careers.acme.co.uk')).toBe('acme.co.uk');
    expect(companyDomainFromUrl('mistral.ai.')).toBe('mistral.ai');
  });

  test('refuses addresses that are not a company\'s own site', () => {
    expect(companyDomainFromUrl('https://www.linkedin.com/company/nikola')).toBeNull();
    expect(companyDomainFromUrl('acme.github.io')).toBeNull();
    expect(companyDomainFromUrl('https://sites.google.com/view/acme')).toBeNull();
    expect(companyDomainFromUrl('someone@acme.com')).toBeNull(); // an email address
    expect(companyDomainFromUrl('192.168.0.1')).toBeNull();
    expect(companyDomainFromUrl('localhost')).toBeNull();
    expect(companyDomainFromUrl('co.uk')).toBeNull();
    expect(companyDomainFromUrl('not a domain')).toBeNull();
    expect(companyDomainFromUrl('')).toBeNull();
    expect(companyDomainFromUrl(null)).toBeNull();
  });
});

describe('domainHistoryConnector', () => {
  test('describes itself in plain words and only works on domains', () => {
    expect(domainHistoryConnector.id).toBe('domain-history');
    expect(domainHistoryConnector.kinds).toEqual(['domain']);
    expect(domainHistoryConnector.label).not.toMatch(/\b(api|endpoint|free|paid|key|token)\b/i);
    expect(domainHistoryConnector.enabled()).toBe(true);
  });

  test('states registration and archive dates in one company-level finding', async () => {
    const calls = fakeNetwork();
    const { findings, threads, notes } = await run('https://www.nikolamotor.com/');
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f.title).toBe('nikolamotor.com: registered 2014-12-21; first archived 2016-05-10; last archived 2020-11-04; 572 captures');
    expect(f).toMatchObject({ source: 'domain-history', category: 'corporate', match: 'company', severity: 'info', date: '2014-12-21', url: 'https://web.archive.org/web/*/nikolamotor.com' });
    expect(f.quote).toContain('Registration record: registered 2014-12-21; last changed 2019-05-02; expires 2027-12-21.');
    expect(f.quote).toContain('Web archive: first capture 2016-05-10; last capture 2020-11-04; 572 captures of the home page');
    expect(f.quote).toContain('Captures per year: 2016: 13, 2017: 32, 2020: 527.');
    expect(f.quote).not.toContain('removed]'); // nothing in it reads as a phone number or an address
    expect(f.data).toMatchObject({ domain: 'nikolamotor.com', registered: '2014-12-21', lastChanged: '2019-05-02', expires: '2027-12-21', firstCapture: '2016-05-10', lastCapture: '2020-11-04', captures: 572, capturesByYear: { 2016: 13, 2017: 32, 2020: 527 } });
    expect(threads).toEqual([]);
    expect(notes).toEqual([]);
    // one request each: archive summary, registration record
    expect(calls.map((c) => new URL(c.url).hostname).sort()).toEqual(['rdap.org', 'web.archive.org']);
    expect(calls.find((c) => c.url.startsWith('https://rdap.org/')).url).toBe('https://rdap.org/domain/nikolamotor.com');
  });

  test('never passes on the registrant, their address, phone or email', async () => {
    fakeNetwork({ certificates: CERTIFICATES });
    const out = JSON.stringify(await run('nikolamotor.com'));
    for (const secret of ['Jordan', 'Registrant', 'Broadway', 'Phoenix', '85040', '4805550142', 'example.org', 'Tucows', 'vcard']) expect(out).not.toContain(secret);
  });

  test('never asks the certificate log search, whose robots.txt turns automated readers away', async () => {
    const calls = fakeNetwork({ certificates: CERTIFICATES });
    const { findings: [f] } = await run('nikolamotor.com');
    expect(calls.some((c) => c.url.includes('crt.sh'))).toBe(false);
    expect(f.quote).not.toMatch(/certificate/i);
    expect(f.data).not.toHaveProperty('earliestCertificate');
  });

  test('can be switched off', () => {
    expect(domainHistoryConnector.enabled()).toBe(true);
    process.env.FOUNDER_SOURCES_OFF = 'trademarks, domain-history';
    expect(domainHistoryConnector.enabled()).toBe(false);
    expect(domainHistoryConnector.unavailableReason).toMatch(/not enabled|switched off/i);
  });

  test('a registry with no public lookup: the archive dates stand alone', async () => {
    fakeNetwork({ rdap: reply('{"errorCode":404}', 404) });
    const { findings: [f], notes } = await run('acme.io');
    expect(f.title).toBe('acme.io: first archived 2016-05-10; last archived 2020-11-04; 572 captures');
    expect(f.date).toBe('2016-05-10');
    expect(f.quote).toContain('Registration record: none published for this domain');
    expect(f.data.registered).toBeNull();
    expect(notes).toEqual([]);
  });

  test('registered but never archived: says so and links the registration record', async () => {
    fakeNetwork({ archive: NO_CAPTURES });
    const { findings: [f] } = await run('nikolamotor.com');
    expect(f.title).toBe('nikolamotor.com: registered 2014-12-21; no archived copies found');
    expect(f.url).toBe('https://rdap.org/domain/nikolamotor.com');
    expect(f.quote).toContain('Web archive: no captures of the home page.');
    expect(f.quote).not.toContain('error-text');
  });

  test('nothing known about the domain: no finding, one note', async () => {
    fakeNetwork({ archive: NO_CAPTURES, rdap: reply('', 404) });
    const { findings, notes } = await run('this-domain-does-not-exist-zzqx9.com');
    expect(findings).toEqual([]);
    expect(notes).toEqual(['No registration record or archived copies were found for this-domain-does-not-exist-zzqx9.com.']);
  });

  test('flags the registration date against a founding year only when one is given', async () => {
    fakeNetwork();
    const plain = (await run('nikolamotor.com')).findings[0];
    expect(plain.title).not.toMatch(/founding/);

    fakeNetwork();
    const before = (await run('nikolamotor.com', { params: { foundedYear: 2020 } })).findings[0];
    expect(before.title).toBe('nikolamotor.com: registered 2014-12-21; first archived 2016-05-10; last archived 2020-11-04; 572 captures (registered 6 years before the stated 2020 founding)');
    expect(before.severity).toBe('info'); // a domain older than the company is normal: domains are bought

    fakeNetwork();
    const after = (await run('nikolamotor.com', { params: { foundedYear: 2009 } })).findings[0];
    expect(after.title).toContain('(registered 5 years after the stated 2009 founding)');
    expect(after.severity).toBe('low');

    fakeNetwork();
    const close = (await run('nikolamotor.com', { params: { foundedYear: 2015 } })).findings[0];
    expect(close.title).not.toMatch(/founding/); // within a year: nothing to flag
  });

  test('flags a lapsed, suspended or parked domain', async () => {
    fakeNetwork({
      rdap: {
        ...RDAP,
        status: ['client hold'],
        events: [{ eventAction: 'registration', eventDate: '2014-12-21T08:28:35Z' }, { eventAction: 'expiration', eventDate: '2021-12-21T08:28:35Z' }],
        nameservers: [{ ldhName: 'NS1.SEDOPARKING.COM' }],
      },
    });
    const { findings: [f] } = await run('nikolamotor.com');
    expect(f.title).toContain('(registration lapsed 2021-12-21; registration on hold or pending deletion; pointed at a domain-parking service)');
    expect(f.data.flags).toEqual(['registration lapsed 2021-12-21', 'registration on hold or pending deletion', 'pointed at a domain-parking service']);
    expect(f.severity).toBe('low');
    // "client delete prohibited" is a lock, not a pending deletion
    fakeNetwork({ rdap: { ...RDAP, status: ['client delete prohibited', 'client transfer prohibited'] } });
    const locked = (await run('nikolamotor.com')).findings[0];
    expect(locked.severity).toBe('info');
    expect(locked.data.flags).toEqual([]);
  });

  test('falls back to the first capture from the archive index when the summary is unavailable', async () => {
    const calls = fakeNetwork({ archive: reply('oops', 500), cdx: [['timestamp', 'original', 'statuscode'], ['20160510055509', 'http://nikolamotor.com:80/', '200']] });
    const { findings: [f] } = await run('nikolamotor.com');
    expect(f.title).toBe('nikolamotor.com: registered 2014-12-21; first archived 2016-05-10');
    expect(f.data).toMatchObject({ firstCapture: '2016-05-10', lastCapture: null, captures: null });
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  test('one source down: the other is reported with a note', async () => {
    fakeNetwork({ archive: reply('oops', 500), cdx: reply('oops', 500) });
    const first = await run('nikolamotor.com');
    expect(first.findings[0].title).toBe('nikolamotor.com: registered 2014-12-21');
    expect(first.notes).toEqual(['The web archive did not answer for nikolamotor.com; only the registration record is shown.']);

    fakeNetwork({ rdap: reply('oops', 500) });
    const second = await run('nikolamotor.com');
    expect(second.findings[0].title).toBe('nikolamotor.com: first archived 2016-05-10; last archived 2020-11-04; 572 captures');
    expect(second.notes).toEqual(['The registration record for nikolamotor.com could not be read; the dates come from the web archive.']);
  });

  test('rejects when both the archive and the registry fail', async () => {
    fakeNetwork({ archive: reply('oops', 500), cdx: reply('oops', 500), rdap: reply('oops', 500) });
    await expect(run('nikolamotor.com')).rejects.toThrow(/HTTP 500/);
    fakeNetwork({ archive: reply('<html>not json</html>'), cdx: reply('<html>not json</html>'), rdap: reply('<html>not json</html>') });
    await expect(run('nikolamotor.com')).rejects.toThrow();
  });

  test('does nothing for a value that is not a company domain', async () => {
    const calls = fakeNetwork();
    expect(await run('https://www.linkedin.com/in/trevor-milton')).toEqual({ findings: [], threads: [], notes: [] });
    expect(await domainHistoryConnector.run({ kind: 'company', value: 'nikolamotor.com' }, { subject, deadline: Date.now() + 5000 })).toEqual({ findings: [], threads: [], notes: [] });
    expect(calls).toHaveLength(0);
  });
});
