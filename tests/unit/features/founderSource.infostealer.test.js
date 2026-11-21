/**
 * @jest-environment node
 *
 * Infostealer exposure of a company's own domain (Hudson Rock's free lookup). Fixtures follow the shape
 * the lookup served on 20 Nov 2026, shortened, with invented domains and captured addresses.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addCompanyAlias } = require('../../../src/server/founder/identity');
const { infostealerExposureConnector: C, parseInfostealer, companyDomainOf, INFOSTEALER_ID } = require('../../../src/server/founder/sources/infostealer');

// A large company's answer: counts, recency, and the detail the source must never read.
const HIT = {
  total: 1240,
  totalStealers: 37385730,
  employees: 12,
  users: 1220,
  third_parties: 8,
  logo: 'https://cdn.example.org/logo.png',
  data: {
    employees_urls: [{ occurrence: 9, type: 'Employee', url: 'https://vpn.nikola-example.com/login?user=jane.roe@nikola-example.com' }],
    clients_urls: [{ occurrence: 800, type: 'User', url: 'https://www.nikola-example.com/account?email=pat.doe@example.org' }],
    all_urls: [{ url: 'https://vpn.nikola-example.com/login?user=jane.roe@nikola-example.com', type: 'Employee', occurrence: 9 }],
  },
  totalUrls: 31,
  stats: { totalEmployees: 1, totalUsers: 1, employees_urls: ['https://vpn.nikola-example.com/login'], clients_urls: ['https://www.nikola-example.com/account'], employees_count: [9], clients_count: [800] },
  is_shopify: false,
  last_employee_compromised: '2026-10-02T09:41:16.000Z',
  last_user_compromised: '2026-11-18T09:32:32.000Z',
  antiviruses: { total: 4, found: 25, not_found: 50, free: 25, list: [{ count: 1, name: 'Some Antivirus' }] },
  employeePasswords: { totalPass: 12, too_weak: { qty: 3, perc: 25 } },
  thirdPartyDomains: [{ occurrence: 4, domain: 'partner-example.com' }],
  stealerFamilies: { total: 1240, RedLine: 900 },
};
// A small company with user logins only and no dates (as the lookup answered for a defunct company's site).
const USERS_ONLY = {
  total: 18, totalStealers: 37385730, employees: 0, users: 18, third_parties: 0, logo: 'x',
  data: { employees_urls: [], clients_urls: [{ occurrence: 14, type: 'User', url: 'https://www.nikola-example.com/me/login' }], all_urls: [] },
  totalUrls: 7, stats: { totalEmployees: 0, totalUsers: 7, employees_urls: [], clients_urls: ['https://www.nikola-example.com/me/login'], employees_count: [], clients_count: [14] }, is_shopify: false,
};
const NONE = {
  total: 0, totalStealers: 37385730, employees: 0, users: 0, third_parties: 0, logo: 'x',
  data: { employees_urls: [], clients_urls: [], all_urls: [] }, totalUrls: 0,
  stats: { totalEmployees: 0, totalUsers: 0, employees_urls: [], clients_urls: [], employees_count: [], clients_count: [] }, is_shopify: false,
};

const reply = (body, status = 200) => ({ status, headers: new Map([['content-type', 'application/json']]), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function fake(answer) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    const value = typeof answer === 'function' ? answer(url) : answer;
    return { url, ...(value && typeof value.text === 'function' ? value : reply(value)) };
  });
  return calls;
}

const subject = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const run = (value, s = subject(), why = '') => C.run({ kind: 'domain', value, why }, { subject: s, deadline: Date.now() + 20000, known: () => ({}) });

beforeEach(() => {
  __resetCacheForTests();
  setTransport(async (url) => { throw new Error(`unexpected request to ${url}`); });
});
afterEach(() => { setTransport(); delete process.env.FOUNDER_SOURCES_ON; delete process.env.FOUNDER_SOURCES_OFF; });

describe('switch', () => {
  test('off unless the owner names it, and FOUNDER_SOURCES_OFF wins', () => {
    expect(C.enabled()).toBe(false);
    process.env.FOUNDER_SOURCES_ON = `podcasts, ${INFOSTEALER_ID}`;
    expect(C.enabled()).toBe(true);
    process.env.FOUNDER_SOURCES_OFF = INFOSTEALER_ID;
    expect(C.enabled()).toBe(false);
    expect(C.unavailableReason).toMatch(/not enabled on this deployment/);
    expect(C.unavailableReason).not.toMatch(/\b(api|endpoint|key|token|free|paid|tier|env)\b/i);
    expect(C.kinds).toEqual(['domain']);
  });
});

describe('parseInfostealer', () => {
  test('keeps counts and days only', () => {
    const p = parseInfostealer(HIT);
    expect(p).toEqual({ total: 1240, employees: 12, users: 1220, thirdParties: 8, databaseSize: 37385730, lastEmployee: '2026-10-02', lastUser: '2026-11-18', datesUnreadable: false });
    expect(JSON.stringify(p)).not.toMatch(/http|@|login|antivirus|partner/i);
  });

  test('a changed or empty answer throws, never reads as no exposure', () => {
    expect(() => parseInfostealer(null)).toThrow();
    expect(() => parseInfostealer([])).toThrow();
    expect(() => parseInfostealer({ ...NONE, total: '0' })).toThrow(/format/);
    expect(() => parseInfostealer({ ...NONE, employees: undefined })).toThrow(/format/);
    expect(() => parseInfostealer({ ...NONE, totalStealers: 0 })).toThrow(/empty/);
    expect(() => parseInfostealer({ ...HIT, total: 0 })).toThrow(/add up/);
  });

  test('an unreadable date is flagged', () => {
    expect(parseInfostealer({ ...HIT, last_user_compromised: 'yesterday' }).datesUnreadable).toBe(true);
    expect(parseInfostealer(USERS_ONLY).datesUnreadable).toBe(false);
  });
});

describe('which domains are looked up', () => {
  test('the company\'s own domain, by its name, or as given or learned', () => {
    const s = subject();
    expect(companyDomainOf({ kind: 'domain', value: 'https://www.nikola.com/about' }, s)).toMatchObject({ domain: 'nikola.com', company: 'Nikola' });
    expect(companyDomainOf({ kind: 'domain', value: 'trynikola.com' }, s)).toMatchObject({ domain: 'trynikola.com' });
    expect(companyDomainOf({ kind: 'domain', value: 'nikola-example.com', why: 'company website given' }, s)).toMatchObject({ domain: 'nikola-example.com', how: expect.stringMatching(/given/) });
    expect(addCompanyAlias(s, { company: 'Nikola', alias: 'nikolamotor.com', origin: 'form-d-1' })).toBe(true);
    expect(companyDomainOf({ kind: 'domain', value: 'nikolamotor.com' }, s)).toMatchObject({ domain: 'nikolamotor.com', company: 'Nikola', how: expect.stringMatching(/learned/) });
  });

  test('never a person, a personal site, an email, a shared domain or an untied domain', () => {
    const s = subject();
    expect(companyDomainOf({ kind: 'domain', value: 'trevormilton.com' }, s).skip).toBe(true);
    expect(companyDomainOf({ kind: 'domain', value: 'tm-site.com', why: 'personal site' }, s).skip).toBe(true);
    expect(companyDomainOf({ kind: 'domain', value: 'trevor@nikola.com' }, s).skip).toBe(true);
    expect(companyDomainOf({ kind: 'domain', value: 'gmail.com', why: 'company website given' }, s).skip).toBe(true);
    expect(companyDomainOf({ kind: 'domain', value: 'github.com' }, s).skip).toBe(true);
    expect(companyDomainOf({ kind: 'company', value: 'nikola.com' }, s).skip).toBe(true);
    const untied = companyDomainOf({ kind: 'domain', value: 'other-example.com', why: 'website linked from a profile' }, s);
    expect(untied.skip).toBe(true);
    expect(untied.note).toMatch(/not tied this domain/);
  });

  test('a one-ordinary-word company needs the domain from a tied record, not its name alone', () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Merge' });
    const byName = companyDomainOf({ kind: 'domain', value: 'merge.com' }, s);
    expect(byName.skip).toBe(true);
    expect(byName.note).toMatch(/ordinary word/);
    expect(companyDomainOf({ kind: 'domain', value: 'merge.dev', why: 'company website' }, s)).toMatchObject({ domain: 'merge.dev', company: 'Merge' });
    expect(companyDomainOf({ kind: 'domain', value: 'merge.dev', why: 'company website given' }, s)).toMatchObject({ domain: 'merge.dev' });
  });
});

describe('run', () => {
  test('one finding about the company, worded as the provider\'s estimate, with no captured detail', async () => {
    const calls = fake(HIT);
    const r = await run('nikola.com');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-domain?domain=nikola.com');
    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    expect(f.match).toBe('company');
    expect(f.category).toBe('exposure');
    expect(f.severity).toBe('medium');
    expect(f.title).toMatch(/^nikola\.com: 12 employee and 1,220 user computers infected by infostealer malware held logins for this domain/);
    expect(f.quote).toMatch(/Hudson Rock estimates/);
    expect(f.quote).toMatch(/2026-10-02/);
    expect(f.quote).toMatch(/2026-11-18/);
    expect(f.date).toBe('2026-11-18');
    expect(f.url).toBe('https://www.hudsonrock.com/free-tools');
    expect(f.data).toMatchObject({ domain: 'nikola.com', organisation: 'Nikola', employees: 12, users: 1220, thirdParties: 8, infectedComputers: 1240 });
    const all = JSON.stringify(f);
    expect(all).not.toMatch(/jane\.roe|pat\.doe|@|\/login|\/account|vpn\.|antivirus|partner-example|RedLine|password/i);
    expect(r.threads).toEqual([]);
  });

  test('users only: low, and says no date was given', async () => {
    fake(USERS_ONLY);
    const r = await run('nikola.com');
    const [f] = r.findings;
    expect(f.severity).toBe('low');
    expect(f.quote).toMatch(/no date/);
    expect(f.data.excludeFromTimeline).toBe(true);
  });

  test('nothing found is a plain note, not a clean record', async () => {
    fake(NONE);
    const r = await run('nikola.com');
    expect(r.findings).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/searched for nikola\.com: no infected computer/);
    expect(r.notes.join(' ')).toMatch(/not proof/);
  });

  test('cached for a day per domain', async () => {
    const calls = fake(HIT);
    await run('nikola.com');
    await run('www.nikola.com');
    expect(calls).toHaveLength(1);
  });

  test('an unreadable date answers in part', async () => {
    fake({ ...HIT, last_employee_compromised: 'soon' });
    const r = await run('nikola.com');
    expect(r.findings).toHaveLength(1);
    expect(r.partial[0]).toMatch(/dates of the latest infections unreadable/);
  });

  test('a failed, refused or changed answer throws', async () => {
    fake(reply('<html>error</html>', 500));
    await expect(run('nikola.com')).rejects.toThrow();
    __resetCacheForTests();
    fake({ message: 'rate limited' });
    await expect(run('nikola.com')).rejects.toThrow(/format/);
    __resetCacheForTests();
    fake({ ...NONE, totalStealers: 0 });
    await expect(run('nikola.com')).rejects.toThrow(/empty/);
  });

  test('a skipped domain makes no request', async () => {
    const r = await run('trevormilton.com');
    expect(r).toEqual({ findings: [], threads: [], notes: [] });
  });
});
