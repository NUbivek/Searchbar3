/**
 * Round 3 (audit of 2026-11-20) for the company registers in registries.js.
 * Realistic material comes from the graded reports: Eric Glyman, filed by Companies House as "Eric Robert
 * GLYMAN", is a director of RAMP BUSINESS UK LTD and was one of RAMP PLATFORM UK LTD; Ramp's legal name is
 * Ramp Business Corp (Form D). Trevor Milton / Nikola for the US state registers. People in the owner and
 * charge fixtures are invented.
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, addCompanyAlias } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const R = require('../../../src/server/founder/sources/registries');

const {
  ukCompaniesConnector, usStateRegistriesConnector, leiConnector, ycDirectoryConnector,
  knownCompanyFor, retieHeldRecords, searchHasMorePages, parsePscPage, parseChargesPage, parseInsolvencyPage, parseCompanyPage, homeJurisdiction, usStateCode,
} = R;

function network(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, headers: init.headers });
    const hit = routes.find(([pattern]) => pattern.test(url));
    const reply = hit ? (typeof hit[1] === 'function' ? hit[1](url, init) : hit[1]) : { status: 404, body: 'not found' };
    return { status: reply.status || 200, headers: new Map(Object.entries(reply.headers || {})), url, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) };
  });
  return calls;
}
const glyman = () => createSubject({ name: 'Eric Glyman', company: 'Ramp' });
const ctxOf = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });
const subjectTask = (name) => ({ kind: 'subject', value: name, depth: 0, template: 'uk.officers', params: null });
const companyTask = (value) => ({ kind: 'company', value, depth: 1, template: null, params: null });

afterEach(() => setTransport());
beforeEach(() => __resetCacheForTests());

/* ------------------------------------------------------------------ fixtures */

const officerSearch = (rows, { next = false } = {}) => `<html><body><div id="search-container"><ul class="results-list">
  ${rows.map(([href, name]) => `<li class="type-officer"><h3><a class="govuk-link" href="${href}">${name}</a></h3><p class="meta crumbtrail">Born March 1990</p></li>`).join('')}
  </ul></div>
  <nav class="govuk-pagination"><ul class="govuk-pagination__list"><li><a class="govuk-link govuk-pagination__link" href="/search/officers?q=x&amp;page=1" aria-label="Page 1">1</a></li></ul>
  ${next ? '<div class="govuk-pagination__next"><a class="govuk-link govuk-pagination__link" id="next-page" href="/search/officers?q=x&amp;page=2" rel="next">Next</a></div>' : ''}</nav></body></html>`;
const appointmentsPage = (name, items) => `<html><body><h1 id="officer-name">${name}</h1><h2 id="personal-appointments">Total number of appointments ${items.length}</h2>
  <dl><dt>Date of birth</dt><dd id="officer-date-of-birth-value">March 1990</dd></dl>
  <div class="appointments-list">${items.map((a, i) => `<div>
    <h2 id="company-name-${i + 1}"><a href="/company/${a.number}">${a.company} (${a.number})</a></h2>
    <dd id="company-status-value-${i + 1}">Active</dd><dd id="appointment-type-value${i + 1}">Director</dd>
    <dd id="appointed-value${i + 1}">14 March 2024</dd>${a.resigned ? `<dd id="resigned-value${i + 1}">${a.resigned}</dd>` : ''}</div>`).join('')}</div></body></html>`;
const GLYMAN_APPOINTMENTS = appointmentsPage('Eric Robert GLYMAN', [
  { company: 'RAMP BUSINESS UK LTD', number: '15561756' },
  { company: 'RAMP PLATFORM UK LTD', number: '15561942', resigned: '14 July 2026' },
]);
const glymanOfficers = () => network([
  [/\/search\/officers/, { body: officerSearch([['/officers/GLY1/appointments', 'Eric Robert GLYMAN']]) }],
  [/\/officers\/GLY1\/appointments$/, { body: GLYMAN_APPOINTMENTS }],
]);
const byCompany = (findings, name) => findings.find((f) => f.data?.company === name);

/* ------------------------------------------------------------------ known names of the company */

describe('a company is matched by every name the check knows it by', () => {
  test('without Ramp\'s legal name, RAMP BUSINESS UK LTD is held at possible; with it, the appointment ties and its sibling on the same officer record is likely', async () => {
    glymanOfficers();
    const before = await ukCompaniesConnector.run(subjectTask('Eric Glyman'), ctxOf(glyman()));
    expect(byCompany(before.findings, 'RAMP BUSINESS UK LTD')).toMatchObject({ match: 'possible', matchFixed: true });
    expect(byCompany(before.findings, 'RAMP PLATFORM UK LTD')).toMatchObject({ match: 'possible', matchFixed: true });

    const subject = glyman();
    expect(addCompanyAlias(subject, { company: 'Ramp', alias: 'Ramp Business Corp', origin: 'sec-filings-1' })).toBe(true);
    glymanOfficers();
    const after = await ukCompaniesConnector.run(subjectTask('Eric Glyman'), ctxOf(subject));
    const business = byCompany(after.findings, 'RAMP BUSINESS UK LTD');
    expect(['confirmed', 'likely']).toContain(business.match);
    expect(business.matchFixed).toBeFalsy();
    const platform = byCompany(after.findings, 'RAMP PLATFORM UK LTD');
    expect(platform).toMatchObject({ match: 'likely', matchFixed: true });
    expect(platform.matchReasons[0]).toMatch(/same Companies House officer record as the appointment at RAMP BUSINESS UK LTD/);
    expect(after.threads.find((t) => t.value === 'RAMP PLATFORM UK').trusted).toBe(true);
  });

  test('held records found before the legal name was known are lifted to likely, never confirmed, when it is learned', async () => {
    glymanOfficers();
    const subject = glyman();
    const { findings } = await ukCompaniesConnector.run(subjectTask('Eric Glyman'), ctxOf(subject));
    expect(retieHeldRecords(subject, findings)).toBe(0);
    addCompanyAlias(subject, { company: 'Ramp', alias: 'Ramp Business Corp', origin: 'sec-filings-1' });
    expect(retieHeldRecords(subject, findings)).toBe(2);
    expect(byCompany(findings, 'RAMP BUSINESS UK LTD')).toMatchObject({ match: 'likely', matchFixed: true });
    expect(byCompany(findings, 'RAMP BUSINESS UK LTD').matchReasons[0]).toMatch(/Ramp Business Corp, a legal name of Ramp/);
    expect(byCompany(findings, 'RAMP PLATFORM UK LTD').match).toBe('likely');
  });

  test('a coined one-word name ties its group arm without a legal name; an ordinary word or a new brand does not', () => {
    const airwallex = createSubject({ name: 'Jack Zhang', company: 'Airwallex' });
    expect(knownCompanyFor(airwallex, 'AIRWALLEX GLOBAL LIMITED')).toMatchObject({ company: 'Airwallex', tie: 'group' });
    expect(knownCompanyFor(airwallex, 'AIRWALLEX (UK) LIMITED')).toMatchObject({ company: 'Airwallex' });
    expect(knownCompanyFor(airwallex, 'AIRWALLEX HAIR SALON LTD')).toBeNull();
    expect(knownCompanyFor(glyman(), 'RAMP UK LTD')).toBeNull(); // "Ramp" is an ordinary word
    expect(knownCompanyFor(glyman(), 'RAMP BUSINESS UK LTD')).toBeNull();
    const nikola = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    expect(knownCompanyFor(nikola, 'NIKOLA LABS INC')).toBeNull(); // a new brand, not an arm
  });

  test('a UK company tied through the person\'s own seat teaches the check its legal name', async () => {
    const subject = createSubject({ name: 'Jack Zhang', company: 'Airwallex' });
    network([
      [/\/search\/companies/, { body: `<html><body><div id="search-container"><ul class="results-list"><li class="type-company"><h3><a href="/company/11111111">AIRWALLEX (UK) LIMITED</a></h3><p class="meta crumbtrail">11111111 - Incorporated on 1 May 2018</p></li></ul></div></body></html>` }],
      [/\/company\/11111111\/officers$/, { body: `<html><body><h1 class="heading-xlarge">AIRWALLEX (UK) LIMITED</h1><p id="company-number">Company number <strong>11111111</strong></p><h2 id="company-appointments">1 officer</h2><div class="appointments-list"><span id="officer-name-1"><a href="/officers/Z/appointments">ZHANG, Jack</a></span><dd id="officer-role-1">Director</dd><dd id="officer-appointed-on-1">1 May 2018</dd><dd id="officer-date-of-birth-1">May 1985</dd></div></body></html>` }],
      [/\/company\/11111111$/, { body: '<html><body><div class="company-header"><h1>AIRWALLEX (UK) LIMITED</h1></div><p id="company-number">Company number <strong>11111111</strong></p><dd id="company-status">Active</dd></body></html>' }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Airwallex'), ctxOf(subject));
    expect(out.findings.find((f) => f.url.endsWith('/company/11111111')).match).toBe('company');
    expect([...subject.anchors.aliases.values()].map((a) => a.value)).toContain('AIRWALLEX (UK) LIMITED');
  });
});

/* ------------------------------------------------------------------ honest partial reads */

describe('Companies House: what was not read is said', () => {
  test('a further page of officer results is read; beyond three pages the search is reported as partial', async () => {
    const calls = network([
      [/page=2/, { body: officerSearch([['/officers/GLY1/appointments', 'Eric Robert GLYMAN']], { next: true }) }],
      [/page=3/, { body: officerSearch([], { next: true }) }],
      [/\/search\/officers/, { body: officerSearch([['/officers/N1/appointments', 'Eric GLYMANN']], { next: true }) }],
      [/\/officers\/GLY1\/appointments$/, { body: GLYMAN_APPOINTMENTS }],
    ]);
    const out = await ukCompaniesConnector.run(subjectTask('Eric Glyman'), ctxOf(glyman()));
    expect(calls.filter((c) => /search\/officers/.test(c.url))).toHaveLength(3);
    expect(out.findings.length).toBe(2); // the person's record was on page 2
    expect(out.partial).toEqual(['Companies House officer search (first pages only)']);
    expect(out.notes.join(' ')).toMatch(/more than 3 pages of officer results/);
  });

  test('a last page with only numbered links is not taken for more pages', () => {
    expect(searchHasMorePages(officerSearch([]))).toBe(false);
    expect(searchHasMorePages(officerSearch([], { next: true }))).toBe(true);
  });

  test('an officer record that cannot be opened is a partial result, not "no appointments"', async () => {
    network([
      [/\/search\/officers/, { body: officerSearch([['/officers/GLY1/appointments', 'Eric Robert GLYMAN'], ['/officers/GLY2/appointments', 'Eric GLYMAN']]) }],
      [/\/officers\/GLY1\/appointments$/, { body: GLYMAN_APPOINTMENTS }],
      [/\/officers\/GLY2\/appointments$/, { status: 500, body: 'error' }],
    ]);
    const out = await ukCompaniesConnector.run(subjectTask('Eric Glyman'), ctxOf(glyman()));
    expect(out.partial).toEqual(['Companies House officer records']);
    expect(out.notes).toContain('1 Companies House officer record under the name Eric Glyman could not be opened, so its appointments are not listed.');
  });

  test('a company whose officer list cannot be opened is named as not checked', async () => {
    network([
      [/\/search\/companies/, { body: `<html><body><div id="search-container"><ul class="results-list">
        <li class="type-company"><h3><a href="/company/11111111">ORBITEX ROBOTICS LTD</a></h3></li>
        <li class="type-company"><h3><a href="/company/22222222">ORBITEX ROBOTICS UK LTD</a></h3></li></ul></div></body></html>` }],
      [/\/company\/11111111\/officers$/, { status: 500, body: 'error' }],
      [/\/company\/22222222\/officers$/, { body: '<html><body><h1 class="heading-xlarge">ORBITEX ROBOTICS UK LTD</h1><p id="company-number">Company number <strong>22222222</strong></p><div class="appointments-list"></div></body></html>' }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Orbitex Robotics'), ctxOf(createSubject({ name: 'Jane Roe', company: 'Orbitex Robotics' })));
    expect(out.partial).toEqual(['Companies House: ORBITEX ROBOTICS LTD']);
    expect(out.notes[0]).toMatch(/officer list of ORBITEX ROBOTICS LTD \(11111111\) could not be opened/);
  });
});

/* ------------------------------------------------------------------ owners, charges, insolvency, overdue filings */

const OVERVIEW = `<html><body><div class="company-header"><h1 class="heading-xlarge">RAMP BUSINESS UK LTD</h1></div><p id="company-number">Company number <strong>15561756</strong></p>
  <a id="charges-tab" href="/company/15561756/charges">Charges</a><a id="insolvency-tab" href="/company/15561756/insolvency">Insolvency</a>
  <dl><dt>Registered office address</dt><dd><span id="roa-address">Suite 1, 50 Broadway, London, SW1H 0DB</span></dd></dl>
  <dd class="text data" id="company-status">Liquidation</dd><span id="company-type-value">Private limited Company</span><dd id="company-creation-date">14 March 2024</dd>
  <div class="column-half"><h2 class="heading-medium"><strong>Accounts</strong></h2><p>Next accounts made up to <strong>31 December 2025</strong> due by <strong>30 September 2026</strong> <span class="status-tag">OVERDUE</span></p><p>Last accounts made up to <strong>31 December 2024</strong></p></div>
  <div class="column-half"><h2 class="heading-medium"><strong>Confirmation statement</strong></h2><p>Next statement date <strong>13 March 2027</strong> due by <strong>27 March 2027</strong></p></div>
</body></html>`;
const PSC = `<html><body><p id="company-number">Company number <strong>15561756</strong></p><p id="company-pscs">2 active persons with significant control</p><div class="appointments-list">
  <div class="appointment-1"><h2><span id="psc-name-1"><span><b>Ramp Business Corporation</b></span></span><span id="psc-status-tag-1">Active</span></h2>
    <dl><dt id="psc-address-field-1">Correspondence address</dt><dd id="psc-address-value-1">28 W 23rd St, Fl 2, New York, 10010</dd></dl>
    <dl><dt>Notified on</dt><dd id="psc-notified-on-1">14 March 2024</dd></dl>
    <dl><dt>Nature of control</dt><dd><ul><li id="psc-nature-of-control-1-1">Ownership of shares – 75% or more</li></ul></dd></dl></div>
  <div class="appointment-2"><h2><span id="psc-name-2">Mr Pat Example Owner</span><span id="psc-status-tag-2">Active</span></h2>
    <dl><dt>Date of birth</dt><dd id="psc-dob-2">March 1971</dd></dl><dl><dt>Nationality</dt><dd id="psc-nationality-2">British</dd></dl>
    <dl><dt>Country of residence</dt><dd id="psc-country-2">England</dd></dl>
    <dl><dt>Notified on</dt><dd id="psc-notified-on-2">1 June 2024</dd></dl>
    <dl><dt>Nature of control</dt><dd><ul><li id="psc-nature-of-control-2-1">Right to appoint and remove directors</li></ul></dd></dl></div>
</div></body></html>`;
const CHARGES = `<html><body><p id="company-number">Company number <strong>15561756</strong></p><dl><dt id="company-mortgages">1 charge registered</dt><dd id="company-mortgages-breakdown">1 outstanding, 0 satisfied, 0 part satisfied</dd></dl>
  <div class="mortgage-1"><h2>Charge code 1556 1756 0001</h2><dl><dt>Persons entitled</dt><dd><ul id="mortgage-persons-entitled-1"><li>Silicon Valley Bank</li></ul></dd></dl></div></body></html>`;
const INSOLVENCY = `<html><body><div class="govuk-tabs__panel"><h2>Case number 1</h2><dl><dt>Creditors voluntary liquidation</dt><dd>Commencement of winding up 2 October 2026</dd>
  <dt>Practitioner</dt><dd>Sam Liquidator, 1 Insolvency Row, London</dd></dl></div></body></html>`;

describe('Companies House: owners, charges, insolvency and overdue filings of a tied company', () => {
  test('parsers read names, control, counts and kinds of case; birth, nationality and addresses are never read', () => {
    const psc = parsePscPage(PSC);
    expect(psc.owners).toEqual([
      { name: 'Ramp Business Corporation', kind: 'company', control: ['Ownership of shares – 75% or more'], notified: '14 March 2024', ceased: null },
      { name: 'Pat Example Owner', kind: 'person', control: ['Right to appoint and remove directors'], notified: '1 June 2024', ceased: null },
    ]);
    expect(JSON.stringify(psc)).not.toMatch(/1971|British|England|23rd St/);
    expect(parseChargesPage(CHARGES)).toMatchObject({ total: 1, outstanding: 1, satisfied: 0, holders: ['Silicon Valley Bank'] });
    expect(parseInsolvencyPage(INSOLVENCY)).toEqual({ cases: 1, types: ['creditors voluntary liquidation'] });
    expect(JSON.stringify(parseInsolvencyPage(INSOLVENCY))).not.toMatch(/Liquidator|Insolvency Row/);
    expect(parseCompanyPage(OVERVIEW)).toMatchObject({ accountsOverdue: true, confirmationOverdue: false, lastAccounts: '31 December 2024', tabs: { charges: true, insolvency: true } });
  });

  test('the record of a tied company carries them, raises severity, and adds owners as threads', async () => {
    const subject = glyman();
    addCompanyAlias(subject, { company: 'Ramp', alias: 'Ramp Business Corp', origin: 'sec-filings-1' });
    network([
      [/\/search\/companies/, { body: `<html><body><div id="search-container"><ul class="results-list"><li class="type-company"><h3><a href="/company/15561756">RAMP BUSINESS UK LTD</a></h3><p class="meta crumbtrail">15561756 - Incorporated on 14 March 2024</p></li></ul></div></body></html>` }],
      [/\/company\/15561756\/officers$/, { body: `<html><body><h1 class="heading-xlarge">RAMP BUSINESS UK LTD</h1><p id="company-number">Company number <strong>15561756</strong></p><h2 id="company-appointments">1 officer</h2><div class="appointments-list"><span id="officer-name-1"><a href="/officers/GLY1/appointments">GLYMAN, Eric Robert</a></span><dd id="officer-role-1">Director</dd><dd id="officer-appointed-on-1">14 March 2024</dd><dd id="officer-date-of-birth-1">March 1990</dd></div></body></html>` }],
      [/persons-with-significant-control$/, { body: PSC }],
      [/\/charges$/, { body: CHARGES }],
      [/\/insolvency$/, { body: INSOLVENCY }],
      [/\/company\/15561756$/, { body: OVERVIEW }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Ramp Business Corp'), ctxOf(subject));
    const record = out.findings.find((f) => f.url.endsWith('/company/15561756'));
    expect(record).toMatchObject({ match: 'company', severity: 'medium' });
    expect(record.title).toMatch(/ACCOUNTS OVERDUE, 1 INSOLVENCY CASE/);
    expect(record.quote).toMatch(/Persons with significant control: Ramp Business Corporation \(Ownership of shares – 75% or more\), notified 14 March 2024/);
    expect(record.quote).toMatch(/Charges: 1 charge registered: 1 outstanding, 0 satisfied, 0 part satisfied; held by Silicon Valley Bank/);
    expect(record.quote).toMatch(/Insolvency: 1 case \(creditors voluntary liquidation\)/);
    expect(record.data).toMatchObject({ accountsOverdue: true, insolvencyCases: 1, charges: { outstanding: 1 } });
    expect(JSON.stringify(out)).not.toMatch(/1971|British|23rd St|50 Broadway|Insolvency Row/);
    expect(out.threads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'associate', value: 'Pat Example Owner', trusted: true })]));
    // the owner is already a known name of Ramp, so no company thread for it
    expect(out.threads.some((t) => t.kind === 'company' && /Ramp Business Corporation/.test(t.value))).toBe(false);
  });
});

/* ------------------------------------------------------------------ US state registers */

const stateRoutes = (co, ct, tx) => [
  [/data\.colorado\.gov/, { body: co }],
  [/data\.ct\.gov/, { body: ct }],
  [/data\.texas\.gov/, { body: tx }],
  [/data\.(ny|oregon)\.gov/, { body: [] }],
];
const NIKOLA_CO = [{ ':id': 'row-co', entityid: '20191', entityname: 'NIKOLA Corporation, Delinquent January 1, 2024', entitystatus: 'Delinquent', entitytype: 'DPC', entityformdate: '2019-02-01T00:00:00.000', jurisdictonofformation: 'CO' }];
const NIKOLA_CT = [{ ':id': 'row-ct', accountnumber: '1300', name: 'NIKOLA CORPORATION', status: 'Active', business_type: 'Stock', citizenship: 'Foreign', date_registration: '2020-07-01T00:00:00.000', formation_place: 'DE' }];
const NIKOLA_TX = [{ ':id': 'row-tx', taxpayer_number: '3200', taxpayer_name: 'NIKOLA CORPORATION', sos_status_code: 'A', sos_charter_date: '2020-06-01T00:00:00.000' }];

describe('US state registers: the place of formation decides', () => {
  test('with the home state known from a tied LEI record, only the registration of an entity formed there ties', async () => {
    network(stateRoutes(NIKOLA_CO, NIKOLA_CT, NIKOLA_TX));
    const lei = { source: 'lei-register', match: 'company', data: { jurisdiction: 'US-DE' } };
    const out = await usStateRegistriesConnector.run(companyTask('Nikola Corporation'), ctxOf(createSubject({ name: 'Trevor Milton', company: 'Nikola' }), [lei]));
    const by = (code) => out.findings.find((f) => f.data.state === code);
    expect(by('CT')).toMatchObject({ match: 'company' });
    expect(by('CT').matchReasons[0]).toMatch(/formed in Delaware, the company's home state according to the LEI register/);
    expect(by('CO')).toMatchObject({ match: 'possible', severity: 'info', matchFixed: true });
    expect(by('CO').matchReasons[0]).toMatch(/formed in Colorado, while the company is formed in Delaware/);
    expect(by('TX')).toMatchObject({ match: 'possible' });
  });

  test('without the home state, a domestic namesake never ties, and nothing ties when places of formation differ', async () => {
    network(stateRoutes(NIKOLA_CO, [], []));
    const alone = await usStateRegistriesConnector.run(companyTask('Nikola Corporation'), ctxOf(createSubject({ name: 'Trevor Milton', company: 'Nikola' })));
    expect(alone.findings).toEqual([expect.objectContaining({ match: 'possible', severity: 'info' })]); // was "company" with DELINQUENT
    network(stateRoutes(NIKOLA_CO, NIKOLA_CT, NIKOLA_TX));
    const mixed = await usStateRegistriesConnector.run(companyTask('Nikola Corporation'), ctxOf(createSubject({ name: 'Trevor Milton', company: 'Nikola' })));
    expect(mixed.findings.every((f) => f.match === 'possible')).toBe(true);
  });

  test('the home state is read from a Form D of a known name of the company', () => {
    const subject = glyman();
    addCompanyAlias(subject, { company: 'Ramp', alias: 'Ramp Business Corp', origin: 'f' });
    const formD = { source: 'sec-filings', match: 'confirmed', quote: 'Issuer: Ramp Business Corp (Corporation, DELAWARE); year of incorporation: more than five years before the filing' };
    expect(homeJurisdiction(ctxOf(subject, [formD]))).toEqual({ code: 'DE', from: 'an SEC filing' });
    expect(homeJurisdiction(ctxOf(glyman(), [{ ...formD, quote: 'Issuer: Rampart Holdings LLC (Limited Liability Company, NEVADA)' }]))).toBeNull();
    expect(usStateCode('Delaware')).toBe('DE');
    expect(usStateCode('FRANCE')).toBeNull();
  });

  test('says which states were and were not searched', async () => {
    network(stateRoutes([], [], []));
    const out = await usStateRegistriesConnector.run(companyTask('Nikola Corporation'), ctxOf(createSubject({ name: 'Trevor Milton', company: 'Nikola' })));
    expect(out.notes[0]).toMatch(/^US state registers searched for Nikola: Colorado, New York, Connecticut, Oregon and Texas\. Not searched: Delaware/);
    expect(out.notes[0]).not.toMatch(/\b(api|key|token|free|paid|tier|quota)\b/i);
  });
});

/* ------------------------------------------------------------------ GLEIF */

const leiRecord = (id, name, jurisdiction) => ({
  type: 'lei-records', id,
  attributes: { lei: id, entity: { legalName: { name }, otherNames: [], jurisdiction, status: 'ACTIVE', expiration: {}, creationDate: '2010-01-01T00:00:00Z' }, registration: { status: 'ISSUED' } },
  relationships: {},
});

describe('LEI register', () => {
  test('reads a page of 100 and does not tie when the register holds more than was read', async () => {
    const calls = network([[/api\.gleif\.org/, { body: { data: [leiRecord('5493001KJTIIGC8Y1R12', 'Flow Corporation', 'US-DE')], meta: { pagination: { total: 554 } } } }]]);
    const out = await leiConnector.run(companyTask('Flow Corporation'), ctxOf(createSubject({ name: 'Jane Roe', company: 'Flow' })));
    expect(calls[0].url).toMatch(/page%5Bsize%5D=100/);
    expect(out.findings).toEqual([expect.objectContaining({ match: 'possible', matchFixed: true })]);
    expect(out.partial).toEqual(['LEI register (first page of results only)']);
    expect(out.notes[0]).toMatch(/holds 554 entities/);
  });

  test('one ordinary word is not tied on its name, even when only one entity carries it', async () => {
    network([[/api\.gleif\.org/, { body: { data: [leiRecord('5493001KJTIIGC8Y1R12', 'MERGE, INC.', 'US-NV')], meta: { pagination: { total: 1 } } } }]]);
    const out = await leiConnector.run(companyTask('Merge'), ctxOf(createSubject({ name: 'Shensi Ding', company: 'Merge' })));
    expect(out.findings[0]).toMatchObject({ match: 'possible', severity: 'info' });
    expect(out.findings[0].matchReasons[0]).toMatch(/ordinary word/);
  });
});

/* ------------------------------------------------------------------ Y Combinator */

const ycPage = (company) => `<html><body><div data-page="${JSON.stringify({ props: { company } }).replace(/"/g, '&quot;')}"></div></body></html>`;

describe('Y Combinator directory', () => {
  test('a company that only once used the name, or a namesake of an earlier employer, is a note, not a record', async () => {
    network([
      [/yc-oss\.github\.io/, { body: [{ name: 'Versine', slug: 'versine', former_names: ['Merge'], website: 'https://versine.com', batch: 'Fall 2026', status: 'Active' }, { name: 'Expanse', slug: 'expanse', former_names: [], website: 'https://expanse.sh', batch: 'Spring 2026', status: 'Active' }] }],
      [/companies\/versine/, { body: ycPage({ name: 'Versine', slug: 'versine', batch_name: 'Fall 2026', year_founded: 2026, founders: [{ full_name: 'Harshith Latchupatula', title: 'Founder' }] }) }],
      [/companies\/expanse/, { body: ycPage({ name: 'Expanse', slug: 'expanse', batch_name: 'Spring 2026', year_founded: 2025, founders: [{ full_name: 'Ismaeel Bashir', title: 'Founder/CEO' }] }) }],
    ]);
    const subject = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const merge = await ycDirectoryConnector.run(companyTask('Merge'), ctxOf(subject));
    expect(merge.findings).toEqual([]);
    expect(merge.notes.join(' ')).toMatch(/lists Versine \(once called Merge\); nothing ties it to Shensi Ding/);
    const expanse = await ycDirectoryConnector.run(companyTask('Expanse'), ctxOf(subject));
    expect(expanse.findings).toEqual([]);
  });

  test('the directory\'s website for a company the person is a listed founder of becomes a known domain of it', async () => {
    network([
      [/yc-oss\.github\.io/, { body: [{ name: 'Paribus', slug: 'paribus', former_names: [], website: 'https://paribus.co', batch: 'Summer 2015', status: 'Acquired' }] }],
      [/companies\/paribus/, { body: ycPage({ name: 'Paribus', slug: 'paribus', batch_name: 'Summer 2015', year_founded: 2015, website: 'https://paribus.co', founders: [{ full_name: 'Eric Glyman', title: 'Founder' }] }) }],
    ]);
    const subject = createSubject({ name: 'Eric Glyman', company: 'Paribus' });
    await ycDirectoryConnector.run(companyTask('Paribus'), ctxOf(subject));
    expect([...subject.anchors.aliases.values()]).toEqual([expect.objectContaining({ value: 'paribus.co' })]);
  });
});
