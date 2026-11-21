/**
 * Round 4 (review of 2026-11-21) for the company-level sources: breach and leak-site records matched only on a
 * company's bare brand ("Harvey" for Harvey AI), a learned legal name inside a longer one, a leak-site listing on
 * another website, a domain compared with another company's founding year, a home state read from another company,
 * and a patent family whose look-alike assignee came from the name search alone.
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, addCompanyAlias } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const {
  breachCatalogueConnector, companyKey, bareBrandOnly, distinctiveMatch, legalNameMatch, companyOwnDomains,
} = require('../../../src/server/founder/sources/exposure');
const { gradeOrganisation, targetOf: registersTarget } = require('../../../src/server/founder/sources/breachRegistersMore');
const { ransomfeedConnector } = require('../../../src/server/founder/sources/leakSitesMore');
const { foundingYearFor } = require('../../../src/server/founder/sources/domains');
const { homeJurisdiction } = require('../../../src/server/founder/sources/registries');
const { patentsConnector } = require('../../../src/server/founder/sources/ip');
const { isOrdinaryWordCompany } = require('../../../src/server/founder/names');

function network(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    const hit = routes.find(([pattern]) => pattern.test(url));
    const reply = hit ? (typeof hit[1] === 'function' ? hit[1](url) : hit[1]) : { status: 404, body: 'not found' };
    return { status: reply.status || 200, headers: new Map(), url, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) };
  });
  return calls;
}
const ctxOf = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });
const companyTask = (value) => ({ kind: 'company', value, depth: 1, template: null, params: null });

beforeEach(() => __resetCacheForTests());
afterEach(() => setTransport());

/* ------------------------------------------------------------------ bare brand */

const flags = { IsVerified: true, IsFabricated: false, IsSensitive: false, IsRetired: false, IsSpamList: false, IsMalware: false, IsSubscriptionFree: false, IsStealerLog: false };
const hibp = (Name, Title, Domain, extra = {}) => ({ Name, Title, Domain, BreachDate: '2019-05-01', AddedDate: '2019-06-01T00:00:00Z', PwnCount: 120000, Description: `In May 2019, ${Title} was breached and many accounts were exposed to the public.`, DataClasses: ['Email addresses'], ...flags, ...extra });

describe('a match on the bare brand only is judged on the brand', () => {
  test('helpers: "Harvey" for Harvey AI is bare-brand only and not distinctive; "Harvey AI, Inc." is the full name', () => {
    const key = companyKey('Harvey AI');
    expect(bareBrandOnly(key, 'Harvey')).toBe(true);
    expect(bareBrandOnly(key, 'harvey.com')).toBe(true);
    expect(bareBrandOnly(key, 'Harvey AI, Inc.')).toBe(false);
    expect(distinctiveMatch(key, 'Harvey')).toBe(false);
    expect(distinctiveMatch(key, 'Harvey AI, Inc.')).toBe(true);
    // a coined brand stays distinctive on its own
    expect(distinctiveMatch(companyKey('Theranos Labs'), 'Theranos')).toBe(true);
  });

  test('Have I Been Pwned: "Harvey" (a furniture shop) is a possible namesake of Harvey AI; "Harvey AI" itself is the company', async () => {
    network([[/haveibeenpwned\.com\/api\/v3\/breaches$/, { body: [hibp('Harveys', 'Harvey', 'harveys-furniture.example'), hibp('HarveyAI', 'Harvey AI', 'harvey-legal.example')] }]]);
    const { findings } = await breachCatalogueConnector.run(companyTask('Harvey AI'), ctxOf(createSubject({ name: 'Winston Weinberg', company: 'Harvey AI' })));
    const bare = findings.find((f) => f.data.organisation === 'Harvey');
    const whole = findings.find((f) => f.data.organisation === 'Harvey AI');
    expect(bare).toMatchObject({ match: 'possible', severity: 'low' });
    expect(bare.data.excludeFromTimeline).toBe(true);
    expect(whole).toMatchObject({ match: 'company' });
  });

  test('breach registers: "Harvey" and "Mistral, Inc." are possible for Harvey AI and Mistral AI; the full names tie', () => {
    const harvey = registersTarget(companyTask('Harvey AI'), ctxOf(createSubject({ name: 'Winston Weinberg', company: 'Harvey AI' })));
    expect(gradeOrganisation(harvey, 'Harvey')).toMatchObject({ match: 'possible' });
    expect(gradeOrganisation(harvey, 'Harvey AI, Inc.')).toMatchObject({ match: 'company' });
    // a bare brand is judged as the brand: Mistral, Inc. ties Mistral AI only if "Mistral" is not an ordinary word
    const mistral = registersTarget(companyTask('Mistral AI'), ctxOf(createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' })));
    expect(gradeOrganisation(mistral, 'Mistral, Inc.').match).toBe(isOrdinaryWordCompany('Mistral') ? 'possible' : 'company');
    expect(gradeOrganisation(mistral, 'Mistral AI SAS')).toMatchObject({ match: 'company' });
    const scale = registersTarget(companyTask('Scale AI'), ctxOf(createSubject({ name: 'Alexandr Wang', company: 'Scale AI' })));
    expect(gradeOrganisation(scale, 'Scale')).toMatchObject({ match: 'possible' });
  });

  test('RansomFeed: a listing of "Harvey" is a possible namesake of Harvey AI', async () => {
    network([[/api\.ransomfeed\.it\/search\//, { body: [{ id: '1', date: '2024-01-01 10:00:00', victim: 'Harvey', gang: 'akira', website: '', country: 'USA', work_sector: 'Retail' }] }]]);
    const { findings } = await ransomfeedConnector.run(companyTask('Harvey AI'), ctxOf(createSubject({ name: 'Winston Weinberg', company: 'Harvey AI' })));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ match: 'possible' });
  });
});

/* ------------------------------------------------------------------ learned legal names */

describe('a learned legal name ties only when it is the entry\'s name', () => {
  const boltCtx = () => {
    const subject = createSubject({ name: 'Ryan Breslow', company: 'Bolt' });
    addCompanyAlias(subject, { company: 'Bolt', alias: 'Bolt Financial, Inc.', origin: 'sec-filings-1' });
    return ctxOf(subject);
  };

  test('helper: exact, partial or nothing', () => {
    expect(legalNameMatch('Bolt Financial, Inc.', 'BOLT FINANCIAL INC')).toBe('exact');
    expect(legalNameMatch('Bolt Financial, Inc.', 'Lightning Bolt Financial Advisors LLC')).toBe('partial');
    expect(legalNameMatch('Bolt Financial, Inc.', 'Bolt')).toBeNull(); // the bare brand is not the legal name
  });

  test('breach registers: "Lightning Bolt Financial Advisors LLC" is possible, "Bolt Financial, Inc." is the company', () => {
    const target = registersTarget(companyTask('Bolt'), boltCtx());
    expect(gradeOrganisation(target, 'Lightning Bolt Financial Advisors LLC')).toMatchObject({ match: 'possible' });
    expect(gradeOrganisation(target, 'Bolt Financial, Inc.')).toMatchObject({ grade: 'legal', match: 'company' });
  });

  test('Have I Been Pwned and RansomFeed: the legal name inside a longer name is possible', async () => {
    network([[/haveibeenpwned\.com\/api\/v3\/breaches$/, { body: [hibp('LBFA', 'Lightning Bolt Financial Advisors', '')] }]]);
    const hibpOut = await breachCatalogueConnector.run(companyTask('Bolt'), boltCtx());
    expect(hibpOut.findings).toHaveLength(1);
    expect(hibpOut.findings[0].match).toBe('possible');

    network([[/api\.ransomfeed\.it\/search\//, { body: [{ id: '2', date: '2024-01-01 10:00:00', victim: 'Lightning Bolt Financial Advisors LLC', gang: 'akira', website: '', country: 'USA', work_sector: 'Finance' }] }]]);
    const feed = await ransomfeedConnector.run(companyTask('Bolt'), boltCtx());
    expect(feed.findings.every((f) => f.match === 'possible')).toBe(true);
  });
});

/* ------------------------------------------------------------------ another website */

describe('RansomFeed: a listing on another website than the company\'s own', () => {
  const row = (victim, website, id) => ({ id, date: '2024-02-01 10:00:00', victim, gang: 'akira', website, country: 'Serbia', work_sector: 'Hospitality' });

  test('an exact distinctive name on a stranger\'s website is possible; on the company\'s own website it is the company', async () => {
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    addAnchor(subject, 'domains', 'nikolamotor.com', 'company-site');
    expect(companyOwnDomains(companyKey('Nikola'), ctxOf(subject))).toContain('nikolamotor.com');
    network([[/api\.ransomfeed\.it\/search\//, { body: [row('Nikola', 'nikola-hotel.rs', '3')] }]]);
    const other = await ransomfeedConnector.run(companyTask('Nikola'), ctxOf(subject));
    expect(other.findings).toHaveLength(1);
    expect(other.findings[0]).toMatchObject({ match: 'possible', matchFixed: true });
    expect(other.findings[0].matchReasons.join(' ')).toMatch(/nikola-hotel\.rs, not the company's own/);

    network([[/api\.ransomfeed\.it\/search\//, { body: [row('Nikola Corporation', 'www.nikolamotor.com', '4')] }]]);
    const own = await ransomfeedConnector.run(companyTask('Nikola'), ctxOf(subject));
    expect(own.findings[0]).toMatchObject({ match: 'company' });
  });

  test('a domain learned for the company counts as its own whatever its label', async () => {
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    addCompanyAlias(subject, { company: 'Nikola', alias: 'nikola.com', origin: 'sec-filings-1' });
    network([[/api\.ransomfeed\.it\/search\//, { body: [row('Nikola', 'nikola-hotel.rs', '5')] }]]);
    const out = await ransomfeedConnector.run(companyTask('Nikola'), ctxOf(subject));
    expect(out.findings[0]).toMatchObject({ match: 'possible' });
  });

  test('the person\'s own site is never taken for the company\'s', () => {
    const subject = createSubject({ name: 'Nikola Tesla', company: 'Nikola' });
    addAnchor(subject, 'domains', 'nikolatesla.com', 'profile');
    expect(companyOwnDomains(companyKey('Nikola'), ctxOf(subject))).not.toContain('nikolatesla.com');
  });
});

/* ------------------------------------------------------------------ domain founding year */

describe('domain history: the founding year is the given company\'s only', () => {
  test('the subject\'s founding year is not compared with a domain passed without one (an earlier company\'s domain)', () => {
    const subject = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    subject.foundedYear = 2019;
    expect(foundingYearFor('paribus.co', { kind: 'domain', value: 'paribus.co', params: null }, ctxOf(subject))).toBeNull();
    expect(foundingYearFor('ramp.com', { kind: 'domain', value: 'ramp.com', params: { foundedYear: 2019 } }, ctxOf(subject))).toEqual({ year: 2019, from: 'given' });
  });
});

/* ------------------------------------------------------------------ home state */

describe('US state registers: the home state is read from records of this company only', () => {
  const lei = (name, jurisdiction) => ({ source: 'lei-register', match: 'company', quote: `${name} — LEI 5493001KJTIIGC8Y1R12 — Jurisdiction: ${jurisdiction}`, data: { lei: '5493001KJTIIGC8Y1R12', jurisdiction } });

  test('an LEI record of another of the person\'s companies does not set the home state', () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    addAnchor(subject, 'companies', 'Acme Widgets', 'wikipedia-1');
    expect(homeJurisdiction(ctxOf(subject, [lei('Acme Widgets Inc', 'US-NV')]), 'Theranos')).toBeNull();
    expect(homeJurisdiction(ctxOf(subject, [lei('Acme Widgets Inc', 'US-NV'), lei('Theranos, Inc.', 'US-DE')]), 'Theranos')).toEqual({ code: 'DE', from: 'the LEI register' });
    expect(homeJurisdiction(ctxOf(subject, [lei('Acme Widgets Inc', 'US-NV')]), 'Acme Widgets')).toEqual({ code: 'NV', from: 'the LEI register' });
  });

  test('an SEC record with a state but no issuer does not set it', () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const sec = { source: 'sec-filings', match: 'confirmed', quote: 'A filing', data: { stateOfIncorporation: 'NV' } };
    expect(homeJurisdiction(ctxOf(subject, [sec]), 'Theranos')).toBeNull();
    expect(homeJurisdiction(ctxOf(subject, [{ ...sec, data: { stateOfIncorporation: 'DE', issuer: 'Theranos, Inc.' } }]), 'Theranos')).toEqual({ code: 'DE', from: 'an SEC filing' });
  });
});

/* ------------------------------------------------------------------ patents */

describe('patents: a look-alike assignee from the name search alone', () => {
  const gp = (number, title, priority, inventor, assignee) => ({ id: `patent/${number}/en`, patent: { title, priority_date: priority, filing_date: priority, grant_date: null, inventor, assignee, publication_number: number } });
  const gpAnswer = (results) => ({ results: { total_num_results: results.length, cluster: [results.length ? { result: results } : {}], summary: { inventor: [] } } });
  const patentNetwork = (byName, byCompany) => setTransport(async (url) => {
    const inner = new URL(url).searchParams.get('url') || '';
    const answer = inner.includes('assignee=') ? byCompany : byName;
    return { url, status: 200, headers: new Map(), text: async () => JSON.stringify(answer) };
  });
  beforeEach(() => { process.env.FOUNDER_GOOGLE_PATENTS = 'on'; });
  afterEach(() => { delete process.env.FOUNDER_GOOGLE_PATENTS; });

  test('John Smith / Flow: "Flow Hair Salon Inc" found by name only is possible, held, and the summary is not tied by it', async () => {
    patentNetwork(gpAnswer([gp('US1A', 'Hair dryer stand', '2015-01-01', '<b>John Smith</b>', '<b>Flow</b> Hair Salon Inc')]), gpAnswer([]));
    const { findings, threads } = await patentsConnector.run({ kind: 'subject', value: 'John Smith' }, ctxOf(createSubject({ name: 'John Smith', company: 'Flow' })));
    const family = findings.find((f) => f.data?.publicationNumber === 'US1A');
    expect(family).toMatchObject({ match: 'possible', matchFixed: true });
    expect(family.data.excludeFromTimeline).toBe(true);
    expect(findings[0].match).toBe('possible'); // the summary
    expect(threads.every((t) => t.trusted === false)).toBe(true);
  });

  test('"Flowserve Corp" found by name only is possible too; an unrelated assignee stays for the identity check', async () => {
    patentNetwork(gpAnswer([gp('US2A', 'Valve seal', '2016-01-01', '<b>John Smith</b>', '<b>Flow</b>serve Corp'), gp('US3A', 'Bread oven', '2017-01-01', '<b>John Smith</b>', 'Acme Ovens Inc')]), gpAnswer([]));
    const { findings } = await patentsConnector.run({ kind: 'subject', value: 'John Smith' }, ctxOf(createSubject({ name: 'John Smith', company: 'Flow' })));
    expect(findings.find((f) => f.data?.publicationNumber === 'US2A')).toMatchObject({ match: 'possible', matchFixed: true });
    const oven = findings.find((f) => f.data?.publicationNumber === 'US3A');
    expect(oven.match).toBe('possible');
    expect(oven.matchFixed).toBeFalsy();
  });
});
