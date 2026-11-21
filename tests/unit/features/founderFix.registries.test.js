/**
 * Fixes to the company register connectors found in review:
 *   - a registered name that only STARTS with a known company, plus an officer
 *     who merely shares the subject's name, is not a tie;
 *   - officer names printed with a leading title ("Dr") still match;
 *   - US state and GLEIF records tied by a legal name alone are the company
 *     only when one entity carries that name;
 *   - a state register that fails is reported as it failed, and a slow one
 *     is asked twice.
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const {
  ukCompaniesConnector, usStateRegistriesConnector, leiConnector, sameName, parseOfficerSearch,
} = require('../../../src/server/founder/sources/registries');

/** Fake network: the first pattern that matches answers; a function reply may throw. */
function network(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, headers: init.headers });
    const hit = routes.find(([pattern]) => pattern.test(url));
    const reply = hit ? (typeof hit[1] === 'function' ? hit[1](url, init, calls) : hit[1]) : { status: 404, body: 'not found' };
    return { status: reply.status || 200, headers: new Map(Object.entries(reply.headers || {})), url, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) };
  });
  return calls;
}

const ctxFor = (name, company) => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}) });
const subjectTask = (name, template = null) => ({ kind: 'subject', value: name, depth: 0, template, params: null });
const companyTask = (value) => ({ kind: 'company', value, depth: 1, template: null, params: null });

afterEach(() => setTransport());
beforeEach(() => __resetCacheForTests());

/* ------------------------------------------------------------------ UK fixtures */

const searchPage = (cls, items) => `<html><body><div id="search-container"><ul class="results-list">${items.map(([href, name]) => `<li class="${cls}"><h3><a class="govuk-link" href="${href}">${name}</a></h3></li>`).join('')}</ul></div></body></html>`;
const appointmentsPage = (name, items) => `<html><body><h1 id="officer-name">${name}</h1><h2 id="personal-appointments">Total number of appointments ${items.length}</h2>
  <div class="appointments-list">${items.map((a, i) => `<div>
    <h2 id="company-name-${i + 1}"><a href="/company/${a.number}">${a.company} (${a.number})</a></h2>
    <dd id="company-status-value-${i + 1}">${a.status}</dd><dd id="appointment-type-value${i + 1}">${a.role}</dd><dd id="appointed-value${i + 1}">${a.appointed}</dd></div>`).join('')}</div></body></html>`;
const officersPage = (name, officers) => `<html><body><h1 class="heading-xlarge">${name}</h1><p id="company-number">Company number <strong>X</strong></p>
  <h2 id="company-appointments">${officers.length} officers</h2><div class="appointments-list">${officers.map((o, i) => `<div>
    <span id="officer-name-${i + 1}"><a href="/officers/X${i + 1}/appointments">${o.name}</a></span>
    <dd id="officer-role-${i + 1}">${o.role}</dd><dd id="officer-appointed-on-${i + 1}">${o.appointed}</dd>
    <dd id="officer-date-of-birth-${i + 1}">March 1970</dd></div>`).join('')}</div></body></html>`;
const companyPage = (name, number) => `<html><body><div class="company-header"><h1>${name}</h1></div><p id="company-number">Company number <strong>${number}</strong></p>
  <dd id="company-status">Active</dd><dd id="company-creation-date">1 May 2015</dd></body></html>`;

/* ------------------------------------------------------------------ prefix names */

describe('a name that only starts with a known company is not a tie on a namesake officer', () => {
  const SALON = [/\/search\/companies\?q=Flow/, { body: `<div id="search-container"><ul class="results-list"><li class="type-company"><h3><a href="/company/11112222"> FLOW HAIR SALON LIMITED </a></h3><p class="meta"> 11112222 - Incorporated on 1 May 2015 </p></li></ul></div>` }];
  const SALON_OFFICERS = officersPage('FLOW HAIR SALON LIMITED', [
    { name: 'SMITH, John', role: 'Director', appointed: '1 May 2015' },
    { name: 'BROWN, Mary', role: 'Director', appointed: '1 May 2015' },
  ]);

  test('the person: a namesake director of FLOW HAIR SALON LIMITED is held at possible, and its thread is not followed', async () => {
    network([
      [/\/search\/officers\?q=John%20Smith/, { body: searchPage('type-officer', [['/officers/JS1/appointments', 'John SMITH']]) }],
      [/\/officers\/JS1\/appointments$/, { body: appointmentsPage('John SMITH', [{ company: 'FLOW HAIR SALON LIMITED', number: '11112222', status: 'Active', role: 'Director', appointed: '1 May 2015' }]) }],
    ]);
    const out = await ukCompaniesConnector.run(subjectTask('John Smith', 'uk.officers'), ctxFor('John Smith', 'Flow'));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'possible', matchFixed: true });
    expect(out.threads).toEqual([expect.objectContaining({ kind: 'company', value: 'FLOW HAIR SALON', trusted: false })]);
  });

  test('the company: an officer who only shares the name gives a possible record, no seat and no threads', async () => {
    network([
      SALON,
      [/\/company\/11112222\/officers$/, { body: SALON_OFFICERS }],
      [/\/company\/11112222$/, { body: companyPage('FLOW HAIR SALON LIMITED', '11112222') }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Flow'), ctxFor('John Smith', 'Flow'));
    expect(out.findings).toHaveLength(1);
    const [record] = out.findings;
    expect(record).toMatchObject({ match: 'possible', url: expect.stringMatching(/\/company\/11112222$/) });
    expect(record.title).toMatch(/^UK company whose name begins with Flow: FLOW HAIR SALON LIMITED/);
    expect(record.matchReasons[0]).toMatch(/may be another person's company/);
    expect(out.threads).toEqual([]);
  });

  test('the company: a known associate on its board ties it, so the seat and threads follow', async () => {
    network([
      SALON,
      [/\/company\/11112222\/officers$/, { body: SALON_OFFICERS }],
      [/\/company\/11112222$/, { body: companyPage('FLOW HAIR SALON LIMITED', '11112222') }],
    ]);
    const ctx = ctxFor('John Smith', 'Flow');
    addAnchor(ctx.subject, 'people', 'Mary Brown', 'given');
    const out = await ukCompaniesConnector.run(companyTask('Flow'), ctx);
    const record = out.findings.find((f) => /\/company\/11112222$/.test(f.url));
    expect(record).toMatchObject({ match: 'company' });
    expect(record.matchReasons[0]).toMatch(/Mary Brown, a known associate/);
    expect(out.findings.find((f) => /^John Smith: director of FLOW HAIR SALON LIMITED/.test(f.title))).toMatchObject({ match: 'confirmed' });
    expect(out.threads.find((t) => t.kind === 'associate')).toMatchObject({ value: 'Mary Brown', trusted: true });
  });
});

/* ------------------------------------------------------------------ titles */

describe('officer names with a leading title', () => {
  test('"Dr Patrick Malcolm COLLISON" is Patrick Collison, and the search opens his record', async () => {
    const rows = parseOfficerSearch(searchPage('type-officer', [['/officers/mssKFdpszyaemDjchmRVzktBzcA/appointments', 'Dr Patrick Malcolm COLLISON']]));
    expect(rows).toHaveLength(1);
    const calls = network([
      [/\/search\/officers\?q=Patrick%20Collison/, { body: searchPage('type-officer', [
        ['/officers/mssKFdpszyaemDjchmRVzktBzcA/appointments', 'Dr Patrick Malcolm COLLISON'],
        ['/officers/AM1/appointments', 'Dr Arthur Hubert Jean MENSCH'],
      ]) }],
      [/\/officers\/mssKFdpszyaemDjchmRVzktBzcA\/appointments$/, { body: appointmentsPage('Dr Patrick Malcolm COLLISON', [{ company: 'STRIPE PAYMENTS UK LTD', number: '08480524', status: 'Active', role: 'Director', appointed: '9 April 2013' }]) }],
    ]);
    const out = await ukCompaniesConnector.run(subjectTask('Patrick Collison', 'uk.officers'), ctxFor('Patrick Collison', 'Stripe'));
    expect(calls.map((c) => c.url).filter((u) => /appointments$/.test(u))).toHaveLength(1);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].title).toMatch(/^Patrick Collison: director of STRIPE PAYMENTS UK LTD/);
  });

  test('a title after the comma, and a co-director thread without the title', async () => {
    network([
      [/\/search\/companies\?q=Mistral/, { body: `<div id="search-container"><ul class="results-list"><li class="type-company"><h3><a href="/company/22223333"> MISTRAL AI LIMITED </a></h3><p class="meta"> 22223333 - Incorporated on 1 May 2015 </p></li></ul></div>` }],
      [/\/company\/22223333\/officers$/, { body: officersPage('MISTRAL AI LIMITED', [
        { name: 'MENSCH, Dr Arthur Hubert Jean', role: 'Director', appointed: '1 May 2015' },
        { name: 'Dr Guillaume LAMPLE', role: 'Director', appointed: '1 May 2015' },
      ]) }],
      [/\/company\/22223333$/, { body: companyPage('MISTRAL AI LIMITED', '22223333') }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Mistral AI'), ctxFor('Arthur Mensch', 'Mistral AI'));
    expect(out.findings.find((f) => /\/company\/22223333$/.test(f.url))).toMatchObject({ match: 'company' });
    expect(out.threads.filter((t) => t.kind === 'associate').map((t) => t.value)).toEqual(['Guillaume Lample']);
  });

  test('sameName itself is unchanged: the title is dropped before it is called', () => {
    expect(sameName(['dr', 'patrick', 'collison'], ['patrick', 'collison'])).toBe(false);
  });
});

/* ------------------------------------------------------------------ US state registers */

const empty = [/./, { body: [] }];

describe('US state registers: a legal name alone', () => {
  test('two exact-name entities in different states: both possible, info, status kept in the title', async () => {
    network([
      [/data\.colorado\.gov/, { body: [{ ':id': 'row-co', entityid: '2018', entityname: 'Orbitex LLC, Delinquent June 1, 2020', entitystatus: 'Delinquent', entitytype: 'DLLC', entityformdate: '2018-01-01T00:00:00.000', jurisdictonofformation: 'CO' }] }],
      [/data\.ny\.gov/, { body: [{ ':id': 'row-ny', dos_id: '9', current_entity_name: 'ORBITEX, INC.', initial_dos_filing_date: '2003-01-01T00:00:00.000', entity_type: 'DOMESTIC BUSINESS CORPORATION', jurisdiction: 'New York' }] }],
      empty,
    ]);
    const out = await usStateRegistriesConnector.run(companyTask('Orbitex'), ctxFor('Patrick Collison', 'Orbitex'));
    expect(out.findings).toHaveLength(2);
    for (const f of out.findings) {
      expect(f).toMatchObject({ match: 'possible', severity: 'info' });
      expect(f.matchReasons[0]).toMatch(/may be another business/);
    }
    expect(out.findings.find((f) => f.data.state === 'CO').title).toMatch(/DELINQUENT/);
  });

  // Changed in round 3: a bare ordinary word ("Stripe") is never shown as the company from a name-only register;
  // the same-named businesses are counted in one line instead.
  test('one ordinary word: same-named businesses are counted in a note, not shown', async () => {
    network([
      [/data\.colorado\.gov/, { body: [{ ':id': 'row-co', entityid: '2018', entityname: 'Stripe LLC', entitystatus: 'Good Standing', entitytype: 'DLLC', entityformdate: '2018-01-01T00:00:00.000', jurisdictonofformation: 'CO' }] }],
      [/data\.ny\.gov/, { body: [{ ':id': 'row-ny', dos_id: '9', current_entity_name: 'STRIPE, INC.', initial_dos_filing_date: '2003-01-01T00:00:00.000', entity_type: 'DOMESTIC BUSINESS CORPORATION', jurisdiction: 'New York' }] }],
      empty,
    ]);
    const out = await usStateRegistriesConnector.run(companyTask('Stripe'), ctxFor('Patrick Collison', 'Stripe'));
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/State registers list 2 businesses named Stripe \(Colorado 1, New York 1\)/);
  });

  test('a single exact-name entity across the states is the company, its status graded', async () => {
    network([
      [/data\.colorado\.gov/, { body: [{ ':id': 'row-co', entityid: '2015', entityname: 'Theranos, Inc., Delinquent June 1, 2017', entitystatus: 'Delinquent', entitytype: 'FPC', entityformdate: '2015-03-02T00:00:00.000', jurisdictonofformation: 'DE' }] }],
      empty,
    ]);
    const out = await usStateRegistriesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(out.findings).toEqual([expect.objectContaining({ match: 'company', severity: 'low' })]);
  });

  test('a slow register is asked once more; a failure that is not slowness is named as such', async () => {
    let coTries = 0;
    let txTries = 0;
    const timeout = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    network([
      [/data\.colorado\.gov/, () => { coTries += 1; if (coTries === 1) timeout(); return { body: [] }; }],
      [/data\.texas\.gov/, () => { txTries += 1; timeout(); }],
      [/data\.ny\.gov/, { status: 400, body: 'bad query' }],
      empty,
    ]);
    const out = await usStateRegistriesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(coTries).toBe(2);
    expect(txTries).toBe(2);
    expect(out.notes).toContain('The Texas business register did not answer in time.');
    expect(out.notes).toContain('The New York business register could not be read (HTTP 400).');
    // Colorado answered at its second try: no note says it failed (the coverage line names every state searched)
    expect(out.notes.filter((n) => !/^US state registers searched/.test(n)).join(' ')).not.toMatch(/Colorado/);
    expect(usStateRegistriesConnector.timeoutMs).toBeGreaterThanOrEqual(15000);
  });
});

/* ------------------------------------------------------------------ GLEIF */

const leiRecord = (id, name, jurisdiction) => ({
  type: 'lei-records', id,
  attributes: { lei: id, entity: { legalName: { name }, otherNames: [], jurisdiction, status: 'ACTIVE', expiration: {}, creationDate: '2010-01-01T00:00:00Z' }, registration: { status: 'ISSUED' } },
  relationships: { 'direct-parent': { links: { 'lei-record': `https://api.gleif.org/api/v1/lei-records/${id}/direct-parent` } } },
});

describe('LEI register: several entities share the legal name', () => {
  test('none is graded the company and no parents are read', async () => {
    const calls = network([
      [/lei-records\?filter/, { body: { data: [leiRecord('549300BELGIUMSTRIPE1', 'STRIPE', 'BE'), leiRecord('549300USSTRIPE000001', 'Stripe, Inc.', 'US-DE')] } }],
      [/direct-parent$/, { body: { data: leiRecord('549300PARENT00000001', 'SOME HOLDING', 'BE') } }],
    ]);
    const out = await leiConnector.run(companyTask('Stripe'), ctxFor('Patrick Collison', 'Stripe'));
    expect(calls).toHaveLength(1);
    expect(out.findings).toHaveLength(2);
    for (const f of out.findings) expect(f).toMatchObject({ match: 'possible', severity: 'info' });
    expect(out.findings[0].matchReasons[0]).toMatch(/same legal name as Stripe in Belgium; 2 registered entities share it/);
    expect(out.findings[0].quote).not.toMatch(/parent/i);
    expect(out.threads).toEqual([]);
  });
});
