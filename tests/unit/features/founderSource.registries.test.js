/**
 * Company register connectors: UK Companies House, the French open register,
 * five US state registers, GLEIF and the Y Combinator directory. Fixtures are
 * cut from real pages and answers saved on 2026-11-14 (Mensch / Mistral AI,
 * Collison / Stripe, Holmes / Theranos), with namesakes and look-alike
 * companies added to prove they are held at "possible" or dropped.
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const {
  ukCompaniesConnector, frCompaniesConnector, usStateRegistriesConnector, leiConnector, ycDirectoryConnector, registryConnectors,
  legalNorm, nameTie, sameName, withoutLegalForm, parseAppointments, parseCompanyOfficers, parseDisqualification,
} = require('../../../src/server/founder/sources/registries');

/** Fake network: the first pattern that matches the URL answers. Returns the list of calls made. */
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

const ctxFor = (name, company) => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}) });
const subjectTask = (name, template = null) => ({ kind: 'subject', value: name, depth: 0, template, params: null });
const companyTask = (value) => ({ kind: 'company', value, depth: 1, template: null, params: null });
const pageOf = (url) => String(url).replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').toLowerCase();
const PRIVATE = /July 1992|1992-07|Born|Old Jewry|EC2R|Date of birth|Nationality|Clenston|28 November 1966|French\b(?! company)/;

afterEach(() => setTransport());
beforeEach(() => __resetCacheForTests());

/* ------------------------------------------------------------------ UK fixtures */

const searchPage = (items) => `<html><body><div id="search-container"><ul id="results" class="results-list">${items}</ul></div>
<script type="text/template"><li class="type-officer"><h3><a href="{{url}}" class="govuk-link">{{{title}}}</a></h3></li></script></body></html>`;

const OFFICER_SEARCH = searchPage(`
  <li class="type-officer"><h3><a class="govuk-link" href="/officers/vTDLhF6_12U3rQNCqckiNDCmPkw/appointments">Arthur Hubert Jean MENSCH</a></h3>
    <p class="meta crumbtrail">Total number of appointments 1 - Born July 1992</p><p>11 Old Jewry, London, United Kingdom, EC2R 8DU</p></li>
  <li class="type-officer"><h3><a class="govuk-link" href="/officers/NAMESAKE1/appointments">Arthur MENSCH</a></h3>
    <p class="meta crumbtrail">Total number of appointments 2 - Born July 1992</p><p>1 High Street, Leeds</p></li>
  <li class="type-officer"><h3><a class="govuk-link" href="/officers/OTHER/appointments">Arthur MENSCHIKOV</a></h3>
    <p class="meta crumbtrail">Total number of appointments 1 - Born July 1992</p></li>
  <li class="type-officer"><h3><a class="govuk-link" href="/officers/CORP/appointments">MENSCH HOLDINGS LIMITED</a></h3></li>`);

const appointment = (n, { company, number, status, role, appointed, resigned }) => `
  <div class="appointment-${n}">
    <h2 class="heading-medium" id="company-name-${n}"><a href="/company/${number}">${company} (${number})</a></h2>
    <dl><dt>Company status</dt><dd class="data" id="company-status-value-${n}"> ${status} </dd></dl>
    <dl><dt id="correspondence-address-field-${n}">Correspondence address</dt><dd class="data" id="correspondence-address-value-${n}">11 Old Jewry, London, United Kingdom, EC2R 8DU</dd></dl>
    <dl><dt id="appointment-type-field-${n}">Role</dt><dd id="appointment-type-value${n}" class="data"> ${role} </dd></dl>
    <dl><dt>Appointed on</dt><dd id="appointed-value${n}" class="data"> ${appointed} </dd></dl>
    ${resigned ? `<dl><dt>Resigned on</dt><dd id="resigned-value${n}" class="data"> ${resigned} </dd></dl>` : ''}
    <dl><dt id="nationality-field${n}">Nationality</dt><dd id="nationality-value${n}" class="data"> French </dd></dl>
  </div>`;

const appointmentsPage = (name, items) => `<html><body><h1 class="heading-xlarge" id="officer-name">${name}</h1>
  <h2 id="personal-appointments">Total number of appointments ${items.length}</h2>
  <dl><dt>Date of birth</dt><dd class="data" id="officer-date-of-birth-value">July 1992</dd></dl>
  <div class="appointments-list">${items.map((a, i) => appointment(i + 1, a)).join('')}</div></body></html>`;

const MENSCH_APPOINTMENTS = appointmentsPage('Arthur Hubert Jean MENSCH', [
  { company: 'MISTRAL AI UK LTD', number: '14894136', status: 'Active', role: 'Director', appointed: '25 May 2023' },
]);
const NAMESAKE_APPOINTMENTS = appointmentsPage('Arthur MENSCH', [
  { company: 'MISTRAL AIRCRAFT LIMITED', number: '07574333', status: 'Dissolved', role: 'Director', appointed: '22 March 2011', resigned: '1 May 2013' },
  { company: 'LEEDS BAKERY LTD', number: '01234567', status: 'Active', role: 'Secretary', appointed: '2 June 2015' },
]);

const officerBlock = (n, { name, role, status = 'Active', appointed, resigned, person = true }) => `
  <div class="appointment-${n}">
    <h2 class="heading-medium"><span id="officer-name-${n}"><a class="govuk-link" href="/officers/X${n}/appointments">${name}</a></span></h2>
    <dl><dt id="officer-address-field-${n}">Correspondence address</dt><dd class="data" id="officer-address-value-${n}">11 Old Jewry, London, England, EC2R 8DU</dd></dl>
    <dl><dt>Role <span id="officer-status-tag-${n}" class="status-tag">${status}</span></dt><dd id="officer-role-${n}" class="data"> ${role} </dd></dl>
    <dl><dt>Appointed on</dt><dd id="officer-appointed-on-${n}" class="data"> ${appointed} </dd></dl>
    ${resigned ? `<dl><dt>Resigned on</dt><dd id="officer-resigned-on-${n}" class="data"> ${resigned} </dd></dl>` : ''}
    ${person ? `<dl><dt>Date of birth</dt><dd id="officer-date-of-birth-${n}" class="data">July 1992</dd></dl><dl><dt>Nationality</dt><dd class="data">French</dd></dl>` : ''}
  </div>`;
const officersPage = (name, summary, officers) => `<html><body><h1 class="heading-xlarge">${name}</h1><p id="company-number">Company number <strong>X</strong></p>
  <h2 class="heading-medium" id="company-appointments"><span class="govuk-visually-hidden">Officers:</span> ${summary}</h2>
  <div class="appointments-list">${officers.map((o, i) => officerBlock(i + 1, o)).join('')}</div></body></html>`;

const MISTRAL_UK_OFFICERS = officersPage('MISTRAL AI UK LTD', '3 officers / 1 resignation', [
  { name: 'PRAMEX INTERNATIONAL LTD', role: 'Secretary', appointed: '10 July 2023', person: false },
  { name: 'MENSCH, Arthur Hubert Jean', role: 'Director', appointed: '25 May 2023' },
  { name: 'LAMPLE, Guillaume', role: 'Director', appointed: '25 May 2023' },
  { name: 'LACROIX, Timothée Pierre Jean', role: 'Director', status: 'Resigned', appointed: '25 May 2023', resigned: '1 March 2024' },
]);
const LOOKALIKE_OFFICERS = officersPage('MISTRAL AI LIMITED', '1 officer', [
  { name: 'JONES, Peter', role: 'Director', appointed: '1 January 2020' },
]);

const COMPANY_PAGE = (name, number, status, created, { dissolved, previous } = {}) => `<html><body>
  <div class="company-header"><h1 class="heading-xlarge">${name}</h1></div>
  <p id="company-number">Company number <strong>${number}</strong></p>
  <dl><dt>Registered office address</dt><dd class="text data">11 Old Jewry, London, EC2R 8DU</dd></dl>
  <dd class="text data" id="company-status"> ${status} </dd>
  <span class="text data" id="company-type-value"> Private limited Company </span>
  <dd class="data" id="company-creation-date">${created}</dd>
  ${dissolved ? `<dd class="data" id="cessation-date">${dissolved}</dd>` : ''}
  ${previous ? `<table><tr><td id="previous-name-1"> ${previous} </td><td id="previous-date-1"> 23 Apr 2012 - 01 Jan 2013 </td></tr></table>` : ''}
</body></html>`;

const COMPANY_SEARCH = `<html><body><div id="search-container"><ul class="results-list">
  <li class="type-company"><h3><a class="govuk-link" href="/company/14894136" title="View company"> MISTRAL AI UK LTD </a></h3>
    <p class="meta crumbtrail"> 14894136 - Incorporated on 25 May 2023 </p><p>11 Old Jewry, London, EC2R 8DU</p></li>
  <li class="type-company"><h3><a class="govuk-link" href="/company/99999999" title="View company"> MISTRAL AI LIMITED </a></h3>
    <p class="meta crumbtrail"> 99999999 - Incorporated on 1 January 2020 </p></li>
  <li class="type-company"><h3><a class="govuk-link" href="/company/07574333" title="View company"> MISTRAL AIRCRAFT LIMITED </a></h3>
    <p class="meta crumbtrail"> 07574333 - Incorporated on 22 March 2011 - Dissolved on 10 February 2015 </p></li>
</ul></div></body></html>`;

const DISQUALIFIED_SEARCH = `<html><body><div id="search-container"><ul class="results-list">
  <li class="type-disqualification"><h3><a class="govuk-link" href="/disqualified-officers/natural/zWpApuP3xLJGPI9aue_QQSJUF8g">Dominic Joseph Andrew CHAPPELL</a></h3>
    <p class="meta crumbtrail">Born on 28 November 1966 - Disqualified</p></li>
  <li class="type-disqualification"><h3><a class="govuk-link" href="/disqualified-officers/natural/OTHER">Dominic BACCI</a></h3></li>
</ul></div></body></html>`;
const DISQUALIFIED_PAGE = `<html><body><main><header class="text"><h1 class="heading-xlarge">Dominic Joseph Andrew CHAPPELL</h1></header>
<div class="disqualifications">
  <div class="grid-row"><dl><dt>Date of birth</dt><dd class="data">28 November 1966</dd></dl><dl><dt>Nationality</dt><dd class="data">Other</dd></dl></div>
  <div class="disqualification">
    <h3 class="heading-medium"> Court order (14 October 2019) </h3>
    <dl><dt>Address provided by the disqualifying authority</dt><dd class="data">Clenston Manor, Winterborne, Dorset</dd></dl>
    <dl><dt>Start date</dt><dd class="data">4 November 2019</dd></dl>
    <dl><dt>End date</dt><dd class="data">3 November 2029</dd></dl>
    <dl><dt>Case Reference</dt><dd class="data">CR-2019-003533</dd></dl>
    <dl><dt>Court</dt><dd class="data">Business And Property Court, Insolvency And Companies List</dd></dl>
    <dl class="text"><dt>Disqualified for conduct while acting for</dt><dd class="data"><ul><li>BHS LIMITED</li><li>RETAIL ACQUISITIONS LIMITED</li></ul></dd></dl>
    <dl class="text"><dt>Reason</dt><dd class="data">Company Directors Disqualification Act 1986 (Section 8): Disqualification after investigation of company</dd></dl>
  </div>
</div></main></body></html>`;

/* ------------------------------------------------------------------ helpers */

describe('name helpers', () => {
  test('legal names are reduced to what identifies the company', () => {
    expect(legalNorm('Theranos, Inc.')).toBe('theranos');
    expect(legalNorm('STRIPE PAYMENTS UK LTD')).toBe('stripe payments uk');
    expect(withoutLegalForm('Nikola Corporation')).toBe('Nikola');
  });
  test('a registered name ties to a known company only when it is the name or starts with all of it', () => {
    expect(nameTie('Mistral AI', 'MISTRAL AI')).toBe('exact');
    expect(nameTie('Mistral AI', 'MISTRAL AI UK LTD')).toBe('prefix');
    expect(nameTie('Mistral AI', 'MISTRAL AIRCRAFT LIMITED')).toBeNull();
  });
  test('first name and surname must agree; middle names may be added', () => {
    expect(sameName(['arthur', 'hubert', 'jean', 'mensch'], ['arthur', 'mensch'])).toBe(true);
    expect(sameName(['arthur', 'menschikov'], ['arthur', 'mensch'])).toBe(false);
    expect(sameName(['adam', 'neumann'], ['arthur', 'neumann'])).toBe(false);
  });
});

/* ------------------------------------------------------------------ UK */

describe('ukCompaniesConnector: the person', () => {
  test('keeps same-named officers, grades appointments by company, and never copies birth dates or addresses', async () => {
    const calls = network([
      [/\/search\/officers\?q=Arthur%20Mensch/, { body: OFFICER_SEARCH }],
      [/\/officers\/vTDLhF6_12U3rQNCqckiNDCmPkw\/appointments$/, { body: MENSCH_APPOINTMENTS }],
      [/\/officers\/NAMESAKE1\/appointments$/, { body: NAMESAKE_APPOINTMENTS }],
    ]);
    const ctx = ctxFor('Arthur Mensch', 'Mistral AI');
    const out = await ukCompaniesConnector.run(subjectTask('Arthur Mensch', 'uk.officers'), ctx);

    // the search, then only the two officers whose names are the subject's (not MENSCHIKOV, not the company)
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => /OTHER|CORP|\{\{/.test(c.url))).toBe(false);

    const mistral = out.findings.find((f) => /MISTRAL AI UK LTD/.test(f.title));
    // the registered name is the known company's UK arm (only a country word added): tied like the company itself
    expect(mistral).toMatchObject({
      source: 'uk-companies-house', category: 'corporate', match: 'confirmed', severity: 'info', date: '2023-05-25',
      url: 'https://find-and-update.company-information.service.gov.uk/company/14894136/officers',
    });
    expect(mistral.title).toMatch(/^Arthur Mensch: director of MISTRAL AI UK LTD \(UK company, active\), appointed 25 May 2023/);
    expect(mistral.data.appointments[0]).toEqual({ role: 'Director', appointed: '2023-05-25', resigned: null });

    // a dissolved company that only resembles the known one: held at possible for good, said plainly
    const aircraft = out.findings.find((f) => /MISTRAL AIRCRAFT/.test(f.title));
    expect(aircraft).toMatchObject({ match: 'possible', severity: 'low', matchFixed: true });
    expect(aircraft.title).toMatch(/DISSOLVED/);
    expect(aircraft.title).toMatch(/resigned 1 May 2013/);

    const bakery = out.findings.find((f) => /LEEDS BAKERY/.test(f.title));
    expect(bakery).toMatchObject({ match: 'possible', severity: 'info' });

    // threads: only the known company's UK arm is trusted
    expect(out.threads.find((t) => t.value === 'MISTRAL AI UK')).toMatchObject({ kind: 'company', trusted: true });
    expect(out.threads.find((t) => /AIRCRAFT/.test(t.value))).toMatchObject({ trusted: false });

    expect(new Set(out.findings.map((f) => pageOf(f.url))).size).toBe(out.findings.length);
    expect(JSON.stringify(out)).not.toMatch(PRIVATE);
  });

  test('a disqualification is high severity and regulatory, held at possible on the name alone, and drops birth and address', async () => {
    network([
      [/\/search\/disqualified-officers\?q=/, { body: DISQUALIFIED_SEARCH }],
      [/\/disqualified-officers\/natural\/zWpApuP3xLJGPI9aue_QQSJUF8g$/, { body: DISQUALIFIED_PAGE }],
    ]);
    const out = await ukCompaniesConnector.run(subjectTask('Dominic Chappell', 'uk.disqualified'), ctxFor('Dominic Chappell', 'Acme Robotics'));
    expect(out.findings).toHaveLength(1);
    const [f] = out.findings;
    expect(f).toMatchObject({ category: 'regulatory', severity: 'high', match: 'possible', date: '2019-11-04' });
    expect(f.title).toMatch(/^Dominic Chappell: disqualified from acting as a UK company director from 4 November 2019 to 3 November 2029/);
    expect(f.quote).toMatch(/CR-2019-003533/);
    expect(f.quote).toMatch(/BHS LIMITED/);
    expect(out.threads.every((t) => t.trusted === false)).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(PRIVATE);
  });

  test('the parsers read names, roles and dates but not birth, nationality or address fields', () => {
    const a = parseAppointments(MENSCH_APPOINTMENTS);
    expect(JSON.stringify(a)).not.toMatch(PRIVATE);
    const o = parseCompanyOfficers(MISTRAL_UK_OFFICERS);
    expect(o.officers.map((x) => x.person)).toEqual([false, true, true, true]);
    expect(JSON.stringify(o)).not.toMatch(PRIVATE);
    expect(JSON.stringify(parseDisqualification(DISQUALIFIED_PAGE))).not.toMatch(PRIVATE);
  });

  test('no officer of that name: empty, one request', async () => {
    const calls = network([[/\/search\/officers/, { body: searchPage('') }]]);
    const out = await ukCompaniesConnector.run(subjectTask('Arthur Mensch', 'uk.officers'), ctxFor('Arthur Mensch', 'Mistral AI'));
    expect(out.findings).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('register down: run rejects', async () => {
    network([[/company-information/, { status: 503, body: 'down' }]]);
    await expect(ukCompaniesConnector.run(subjectTask('Arthur Mensch', 'uk.officers'), ctxFor('Arthur Mensch', 'Mistral AI'))).rejects.toThrow();
    await expect(ukCompaniesConnector.run(subjectTask('Arthur Mensch'), ctxFor('Arthur Mensch', 'Mistral AI'))).rejects.toThrow();
  });
});

describe('ukCompaniesConnector: a company', () => {
  test('company record, the subject\'s seat, co-director threads; a same-named company without them stays possible', async () => {
    const calls = network([
      [/\/search\/companies\?q=Mistral%20AI/, { body: COMPANY_SEARCH }],
      [/\/company\/14894136\/officers$/, { body: MISTRAL_UK_OFFICERS }],
      [/\/company\/99999999\/officers$/, { body: LOOKALIKE_OFFICERS }],
      [/\/company\/14894136$/, { body: COMPANY_PAGE('MISTRAL AI UK LTD', '14894136', 'Active', '25 May 2023') }],
    ]);
    // MISTRAL AI UK LTD only starts with the wanted name: a known co-founder on its board is what ties it
    const ctx = ctxFor('Arthur Mensch', 'Mistral AI');
    addAnchor(ctx.subject, 'people', 'Guillaume Lample', 'given');
    const out = await ukCompaniesConnector.run(companyTask('Mistral AI'), ctx);
    // search, two officer lists, two overviews and the tied company's owners page (round 3 reads owners too)
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls.some((c) => /07574333/.test(c.url))).toBe(false); // Mistral Aircraft is not a candidate

    const record = out.findings.find((f) => f.url.endsWith('/company/14894136'));
    expect(record).toMatchObject({ match: 'company', category: 'corporate', severity: 'info', date: '2023-05-25' });
    expect(record.title).toBe('UK company record: MISTRAL AI UK LTD, active, incorporated 25 May 2023');
    expect(record.data.officers.map((o) => o.name)).toContain('Guillaume Lample');

    const seat = out.findings.find((f) => /^Arthur Mensch: director of MISTRAL AI UK LTD/.test(f.title));
    expect(seat).toMatchObject({ match: 'confirmed', url: expect.stringMatching(/\/company\/14894136\/officers$/) });

    const lookalike = out.findings.find((f) => f.url.endsWith('/company/99999999'));
    expect(lookalike).toMatchObject({ match: 'possible' });
    expect(lookalike.title).toMatch(/same name as Mistral AI.*\(no listed officer matches the person\)/);

    const associates = out.threads.filter((t) => t.kind === 'associate');
    expect(associates.map((t) => t.value).sort()).toEqual(['Guillaume Lample', 'Timothée Lacroix']);
    expect(associates.every((t) => t.trusted)).toBe(true);
    expect(associates.some((t) => /Pramex|Jones/i.test(t.value))).toBe(false);
    expect(out.threads.find((t) => t.kind === 'company')).toMatchObject({ value: 'MISTRAL AI UK', trusted: true });
    expect(JSON.stringify(out)).not.toMatch(PRIVATE);
  });

  test('a dissolved company is said plainly in the title', async () => {
    network([
      [/\/search\/companies/, { body: `<div id="search-container"><ul class="results-list"><li class="type-company"><h3><a class="govuk-link" href="/company/07574333"> MISTRAL AIRCRAFT LIMITED </a></h3><p class="meta crumbtrail"> 07574333 - Incorporated on 22 March 2011 - Dissolved on 10 February 2015 </p></li></ul></div>` }],
      [/\/company\/07574333\/officers$/, { body: officersPage('MISTRAL AIRCRAFT LIMITED', '1 officer', [{ name: 'MENSCH, Arthur', role: 'Director', appointed: '22 March 2011' }]) }],
      [/\/company\/07574333$/, { body: COMPANY_PAGE('MISTRAL AIRCRAFT LIMITED', '07574333', 'Dissolved', '22 March 2011', { dissolved: '10 February 2015', previous: 'MISTRAL AVIATION LIMITED' }) }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Mistral Aircraft'), ctxFor('Arthur Mensch', 'Mistral Aircraft'));
    const record = out.findings.find((f) => f.match === 'company');
    expect(record.title).toBe('UK company record: MISTRAL AIRCRAFT LIMITED, DISSOLVED on 10 February 2015, incorporated 22 March 2011');
    expect(record.severity).toBe('low');
    expect(record.quote).toMatch(/Previous company names: MISTRAL AVIATION LIMITED/);
    const seat = out.findings.find((f) => /^Arthur Mensch: director/.test(f.title));
    expect(seat).toMatchObject({ match: 'confirmed', severity: 'low' });
  });
});

/* ------------------------------------------------------------------ France */

const frResult = (over) => ({
  siren: '952418325', nom_complet: 'MISTRAL AI', nom_raison_sociale: 'MISTRAL AI', sigle: null, nature_juridique: '5710',
  etat_administratif: 'A', date_creation: '2023-04-28', date_fermeture: null, statut_diffusion: 'O', categorie_entreprise: 'PME',
  siege: { adresse: '15 RUE DES HALLES 75001 PARIS' },
  dirigeants: [
    { nom: 'LACROIX', prenoms: 'TIMOTHÉE PIERRE JEAN', annee_de_naissance: '1991', date_de_naissance: '1991-07', qualite: 'Directeur Général', nationalite: 'Française', type_dirigeant: 'personne physique' },
    { nom: 'LAMPLE', prenoms: 'GUILLAUME', annee_de_naissance: '1990', date_de_naissance: '1990-10', qualite: 'Directeur Général', nationalite: 'Française', type_dirigeant: 'personne physique' },
    { nom: 'MENSCH', prenoms: 'ARTHUR HUBERT JEAN', annee_de_naissance: '1992', date_de_naissance: '1992-07', qualite: 'Président de SAS', nationalite: 'Française', type_dirigeant: 'personne physique' },
    { siren: '123456789', denomination: 'KPMG SA', qualite: 'Commissaire aux comptes titulaire', type_dirigeant: 'personne morale' },
  ],
  ...over,
});

describe('frCompaniesConnector', () => {
  test('the person: companies they run, graded by company; shared officers tie a second company; sole traders skipped', async () => {
    const calls = network([[/recherche-entreprises\.api\.gouv\.fr\/search\?nom_personne=Mensch&prenoms_personne=Arthur&type_personne=dirigeant/, { body: {
      total_results: 40,
      results: [
        frResult(),
        frResult({ siren: '111222333', nom_complet: 'LA PLATEFORME HOLDING', nom_raison_sociale: 'LA PLATEFORME HOLDING', date_creation: '2024-02-01',
          dirigeants: [{ nom: 'MENSCH', prenoms: 'ARTHUR', qualite: 'Président', type_dirigeant: 'personne physique', date_de_naissance: '1992-07' }, { nom: 'LAMPLE', prenoms: 'GUILLAUME', qualite: 'Directeur Général', type_dirigeant: 'personne physique' }] }),
        frResult({ siren: '444555666', nom_complet: 'BOULANGERIE MENSCH', nom_raison_sociale: 'BOULANGERIE MENSCH', etat_administratif: 'C', date_creation: '2001-01-01', date_fermeture: '2010-06-30',
          dirigeants: [{ nom: 'MENSCH', prenoms: 'ARTHUR', qualite: 'Gérant', type_dirigeant: 'personne physique' }] }),
        frResult({ siren: '777888999', nom_complet: 'ARTHUR MENSCH', nom_raison_sociale: null, nature_juridique: '1000' }),
      ],
    } }]]);
    const out = await frCompaniesConnector.run(subjectTask('Arthur Mensch'), ctxFor('Arthur Mensch', 'Mistral AI'));
    expect(calls).toHaveLength(1);
    expect(out.findings).toHaveLength(3);

    const mistral = out.findings[0];
    expect(mistral).toMatchObject({ source: 'fr-companies', category: 'corporate', match: 'confirmed', date: '2023-04-28', severity: 'info', url: 'https://annuaire-entreprises.data.gouv.fr/dirigeants/952418325' });
    expect(mistral.title).toBe('Arthur Mensch: president of MISTRAL AI (French company, active), company created 28 April 2023');
    expect(mistral.quote).not.toMatch(/KPMG/); // the auditor is not an officer

    const holding = out.findings.find((f) => /PLATEFORME/.test(f.title));
    expect(holding.match).not.toBe('possible');
    expect(holding.quote).toMatch(/Shares officers with MISTRAL AI: Guillaume Lample/);

    const bakery = out.findings.find((f) => /BOULANGERIE/.test(f.title));
    expect(bakery).toMatchObject({ match: 'possible', severity: 'low' });
    expect(bakery.title).toMatch(/CEASED on 30 June 2010/);

    expect(out.threads.find((t) => t.value === 'MISTRAL AI')).toMatchObject({ trusted: true });
    expect(out.threads.find((t) => t.value === 'BOULANGERIE MENSCH')).toMatchObject({ trusted: false });
    expect(out.notes[0]).toMatch(/40 companies/);
    expect(JSON.stringify(out)).not.toMatch(/1992-07|1991-07|Française|RUE DES HALLES|777888999/);
  });

  test('a company: creation date, status, officers, the seat and co-director threads (capped, no auditors)', async () => {
    network([[/\/search\?q=Mistral\+AI/, { body: { total_results: 2, results: [
      frResult(),
      frResult({ siren: '999000111', nom_complet: 'MISTRAL AI CONSEIL', nom_raison_sociale: 'MISTRAL AI CONSEIL', dirigeants: [] }),
    ] } }]]);
    const out = await frCompaniesConnector.run(companyTask('Mistral AI'), ctxFor('Arthur Mensch', 'Mistral AI'));
    const record = out.findings.find((f) => f.match === 'company');
    expect(record).toMatchObject({ url: 'https://annuaire-entreprises.data.gouv.fr/entreprise/952418325', date: '2023-04-28' });
    expect(record.title).toBe('French company record: MISTRAL AI, active, created 28 April 2023');
    expect(out.findings.find((f) => f.match === 'confirmed')).toBeTruthy();
    expect(out.findings.some((f) => /CONSEIL/.test(f.title))).toBe(false); // not the same name
    const associates = out.threads.filter((t) => t.kind === 'associate');
    expect(associates.map((t) => t.value).sort()).toEqual(['Guillaume Lample', 'Timothée Lacroix']);
    expect(associates.every((t) => t.trusted)).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/1992-07|Française/);
  });

  test('a same-named company without the subject among its officers stays possible and gives no threads', async () => {
    network([[/\/search\?q=/, { body: { results: [frResult({ dirigeants: [{ nom: 'DURAND', prenoms: 'MARIE', qualite: 'Président', type_dirigeant: 'personne physique' }] })] } }]]);
    const out = await frCompaniesConnector.run(companyTask('Mistral AI'), ctxFor('Arthur Mensch', 'Mistral AI'));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.threads).toEqual([]);
  });

  test('register down: run rejects', async () => {
    network([[/recherche-entreprises/, { status: 500, body: 'error' }]]);
    await expect(frCompaniesConnector.run(subjectTask('Arthur Mensch'), ctxFor('Arthur Mensch', 'Mistral AI'))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ US states */

describe('usStateRegistriesConnector', () => {
  test('exact legal names only, gone status said plainly, look-alikes in a note, a silent state noted', async () => {
    const calls = network([
      [/data\.colorado\.gov/, { body: [
        { ':id': 'row-co-1', entityid: '20151234567', entityname: 'Theranos, Inc., Delinquent June 1, 2017', entitystatus: 'Delinquent', entitytype: 'FPC', entityformdate: '2015-03-02T00:00:00.000', jurisdictonofformation: 'DE', agentprincipaladdress1: '1 Secret St' },
      ] }],
      [/data\.ny\.gov/, { body: [{ ':id': 'row-ny-1', dos_id: '1', current_entity_name: 'THERANOS CORP', initial_dos_filing_date: '0001-01-01T00:00:00.000', jurisdiction: 'NEW YORK', entity_type: 'DOMESTIC BUSINESS CORPORATION' }] }],
      [/data\.ct\.gov/, { status: 500, body: 'error' }],
      [/data\.oregon\.gov/, { body: [{ ':id': 'row-or-1', registry_number: '555', business_name: 'THERANOS HEALTH LLC', entity_type: 'DOMESTIC LIMITED LIABILITY COMPANY', registry_date: '2019-01-01T00:00:00.000', jurisdiction: 'OREGON' }] }],
      [/data\.texas\.gov/, { body: [{ ':id': 'row-tx-1', taxpayer_number: '32012345678', taxpayer_name: 'THERANOS INC', sos_charter_date: '2014-05-06T00:00:00.000', sos_status_code: 'A', right_to_transact_business_code: 'A' }] }],
    ]);
    const out = await usStateRegistriesConnector.run(companyTask('Theranos, Inc.'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(calls).toHaveLength(5);
    // entity columns only: registered agents and their addresses are never asked for
    expect(calls.every((c) => !/agent|address/i.test(decodeURIComponent(c.url)))).toBe(true);
    expect(out.findings).toHaveLength(3);
    // a placeholder date is no date
    expect(out.findings.find((f) => f.data.state === 'NY')).toMatchObject({ date: null, title: 'New York business register: THERANOS CORP, active' });

    const co = out.findings.find((f) => f.data.state === 'CO');
    // three states list the exact name and none lists officers: any may be another business, so none is the company
    expect(co).toMatchObject({ source: 'us-state-registries', category: 'corporate', match: 'possible', severity: 'info', date: '2015-03-02', url: 'https://data.colorado.gov/resource/4ykn-tg5h/row-co-1.json' });
    expect(co.title).toBe('Colorado business register shows Theranos, Inc. as DELINQUENT since 1 June 2017; formed 2 March 2015, home jurisdiction DE');

    const tx = out.findings.find((f) => f.data.state === 'TX');
    expect(tx.title).toBe('Texas business register: THERANOS INC, active, chartered 6 May 2014');
    expect(tx.severity).toBe('info');

    expect(out.findings.some((f) => /HEALTH/.test(f.title))).toBe(false);
    expect(out.notes.join(' ')).toMatch(/Connecticut business register could not be read \(HTTP 500\)/); // an error is not slowness
    expect(out.notes.join(' ')).toMatch(/Oregon: THERANOS HEALTH LLC/);
    expect(JSON.stringify(out)).not.toMatch(/Secret St/);
  });

  test('name reservations are skipped and an unexplained status code is shown as the register gives it', async () => {
    network([
      [/data\.ct\.gov/, { body: [
        { ':id': 'row-ct-1', accountnumber: '1', name: 'NIKOLA CORPORATION', status: 'Expired Reservation', date_registration: '0001-01-01T00:00:00.000' },
        { ':id': 'row-ct-2', accountnumber: '2', name: 'NIKOLA CORPORATION', status: 'Active', citizenship: 'Foreign', business_type: 'Stock', date_registration: '2022-05-24T00:00:00.000', formation_place: 'DE' },
      ] }],
      [/data\.texas\.gov/, { body: [{ ':id': 'row-tx-2', taxpayer_number: '3', taxpayer_name: 'NIKOLA CORPORATION', sos_charter_date: '2022-01-13T00:00:00.000', sos_status_code: 'Y' }] }],
      [/./, { body: [] }],
    ]);
    const out = await usStateRegistriesConnector.run(companyTask('Nikola Corporation'), ctxFor('Trevor Milton', 'Nikola'));
    expect(out.findings.map((f) => f.title)).toEqual([
      'Connecticut business register: NIKOLA CORPORATION, active, registered 24 May 2022, home jurisdiction DE',
      'Texas business register: NIKOLA CORPORATION, Secretary of State status code Y, chartered 13 January 2022',
    ]);
  });

  test('only company tasks; every state down: run rejects', async () => {
    expect(await usStateRegistriesConnector.run(subjectTask('Elizabeth Holmes'), ctxFor('Elizabeth Holmes', 'Theranos'))).toEqual({ findings: [], threads: [], notes: [] });
    network([[/./, { status: 500, body: 'error' }]]);
    await expect(usStateRegistriesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ GLEIF */

const leiRecord = (id, name, over = {}) => ({
  type: 'lei-records', id,
  attributes: {
    lei: id,
    entity: { legalName: { name }, otherNames: [], legalAddress: { addressLines: ['21 RUE TANDOU'], city: 'Paris', country: 'FR' }, jurisdiction: 'FR', registeredAs: '952418325', status: 'ACTIVE', expiration: { date: null, reason: null }, creationDate: '2023-04-27T22:00:00Z', ...over },
    registration: { status: 'ISSUED', initialRegistrationDate: '2023-06-01T00:00:00Z' },
  },
  relationships: {
    'direct-parent': { links: { 'lei-record': `https://api.gleif.org/api/v1/lei-records/${id}/direct-parent` } },
    'ultimate-parent': { links: { 'reporting-exception': `https://api.gleif.org/api/v1/lei-records/${id}/ultimate-parent-reporting-exception` } },
  },
});

describe('leiConnector', () => {
  test('exact legal name only, the parent read once and not followed, no address', async () => {
    const calls = network([
      [/lei-records\?filter/, { body: { data: [leiRecord('894500Q9JNDV9YXSOL64', 'MISTRAL AI'), leiRecord('984500AAAAAAAAAAAA01', 'MISTRAL AI UK LTD')] } }],
      [/direct-parent$/, { body: { data: leiRecord('549300PARENT00000001', 'MISTRAL HOLDING SAS') } }],
    ]);
    const out = await leiConnector.run(companyTask('Mistral AI'), ctxFor('Arthur Mensch', 'Mistral AI'));
    expect(calls).toHaveLength(2);
    expect(out.findings).toHaveLength(1);
    const [f] = out.findings;
    expect(f).toMatchObject({ source: 'lei-register', category: 'corporate', match: 'company', severity: 'info', date: '2023-04-28', url: 'https://www.gleif.org/lei/894500Q9JNDV9YXSOL64' });
    expect(f.title).toBe('Legal entity register: MISTRAL AI (France), active, created 28 April 2023');
    expect(f.quote).toMatch(/Direct parent: MISTRAL HOLDING SAS/);
    expect(out.threads).toEqual([expect.objectContaining({ kind: 'company', value: 'MISTRAL HOLDING', trusted: false })]);
    expect(JSON.stringify(out)).not.toMatch(/TANDOU/);
  });

  test('an inactive entity is said plainly', async () => {
    network([[/lei-records\?filter/, { body: { data: [{ ...leiRecord('254900AAAAAAAAAAAA02', 'THERANOS, INC.', { status: 'INACTIVE', jurisdiction: 'US-DE', expiration: { date: '2018-09-05T00:00:00Z', reason: 'DISSOLVED' } }), relationships: {} }] } }]]);
    const out = await leiConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(out.findings[0].title).toMatch(/^Legal entity register shows THERANOS, INC\. \(United States \(US-DE\)\) as INACTIVE \(dissolved, 5 September 2018\)/);
    expect(out.findings[0].severity).toBe('low');
  });

  test('register down: run rejects', async () => {
    network([[/gleif/, { status: 500, body: 'error' }]]);
    await expect(leiConnector.run(companyTask('Mistral AI'), ctxFor('Arthur Mensch', 'Mistral AI'))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ Y Combinator */

const YC_LIST = [
  { id: 1, name: 'Stripe', slug: 'stripe', former_names: ['/dev/payments'], website: 'http://stripe.com', batch: 'Summer 2009', status: 'Active', long_description: 'x'.repeat(50) },
  { id: 2, name: 'Stripe Labs', slug: 'stripe-labs', former_names: [], website: 'https://stripelabs.io', batch: 'Winter 2021', status: 'Inactive' },
  { id: 3, name: 'Luciq (formerly Instabug)', slug: 'instabug', former_names: [], website: 'https://luciq.ai', batch: 'Winter 2016', status: 'Active' },
];
const ycPage = (company) => `<html><body><div id="ycdc" data-page="${JSON.stringify({ component: 'Company', props: { company } }).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div></body></html>`;
const STRIPE = {
  name: 'Stripe', slug: 'stripe', batch_name: 'Summer 2009', ycdc_status: 'Active', year_founded: 2009, team_size: 7000, website: 'http://stripe.com', one_liner: 'Economic infrastructure for the internet.',
  founders: [
    { full_name: 'Patrick Collison', title: 'CEO', is_active: true, has_email: true, founder_bio: 'Grew up in Ireland', linkedin_url: 'https://www.linkedin.com/in/patrickcollison', twitter_url: 'https://twitter.com/patrickc' },
    { full_name: 'John Collison', title: 'President', is_active: true, linkedin_url: null, twitter_url: 'https://twitter.com/collision' },
  ],
};

describe('ycDirectoryConnector', () => {
  test('a company: batch, status, founders; the subject on the founder list confirms them and opens co-founder threads', async () => {
    const calls = network([
      [/yc-oss\.github\.io\/api\/companies\/all\.json/, { body: YC_LIST }],
      [/ycombinator\.com\/companies\/stripe$/, { body: ycPage(STRIPE) }],
    ]);
    const out = await ycDirectoryConnector.run(companyTask('Stripe'), ctxFor('Patrick Collison', 'Stripe'));
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.Range).toMatch(/^bytes=0-/);

    const record = out.findings.find((f) => f.category === 'corporate');
    expect(record).toMatchObject({ source: 'yc-directory', match: 'company', severity: 'info', date: '2009', url: 'https://www.ycombinator.com/companies/stripe' });
    expect(record.title).toBe('Y Combinator directory: Stripe, Summer 2009 batch, founded 2009, status active');
    expect(record.quote).toMatch(/Founders: Patrick Collison \(CEO\); John Collison \(President\)/);

    const seat = out.findings.find((f) => f.category === 'career');
    expect(seat).toMatchObject({ match: 'confirmed' });
    expect(seat.title).toBe("Patrick Collison: on Y Combinator's founder list for Stripe (CEO), Summer 2009 batch");

    expect(out.threads.find((t) => t.kind === 'associate')).toMatchObject({ value: 'John Collison', trusted: true });
    expect(out.threads.find((t) => t.kind === 'handle')).toMatchObject({ value: 'patrickc', trusted: true });
    expect(JSON.stringify(out)).not.toMatch(/Ireland|has_email/);

    // a second run reads the cached index: only the company page is fetched
    const again = network([[/ycombinator\.com\/companies\/stripe$/, { body: ycPage(STRIPE) }]]);
    await ycDirectoryConnector.run(companyTask('Stripe'), ctxFor('Patrick Collison', 'Stripe'));
    expect(again.map((c) => c.url)).toEqual(['https://www.ycombinator.com/companies/stripe']);
  });

  test('the person: only the founder-list record, for the company given', async () => {
    network([
      [/all\.json/, { body: YC_LIST }],
      [/companies\/stripe$/, { body: ycPage(STRIPE) }],
    ]);
    const out = await ycDirectoryConnector.run(subjectTask('Patrick Collison'), ctxFor('Patrick Collison', 'Stripe'));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ category: 'career', match: 'confirmed' });
  });

  test('a same-named company where the subject is not a founder: possible, no threads', async () => {
    network([
      [/all\.json/, { body: YC_LIST }],
      [/companies\/stripe$/, { body: ycPage(STRIPE) }],
    ]);
    const out = await ycDirectoryConnector.run(companyTask('Stripe'), ctxFor('Jane Roe', 'Stripe'));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'possible' });
    expect(out.findings[0].title).toMatch(/its founder list does not include Jane Roe/);
    expect(out.threads).toEqual([]);
  });

  test('an inactive company is said plainly; a company not in the directory costs one request', async () => {
    network([
      [/all\.json/, { body: YC_LIST }],
      [/companies\/stripe-labs$/, { body: ycPage({ name: 'Stripe Labs', slug: 'stripe-labs', batch_name: 'Winter 2021', ycdc_status: 'Inactive', year_founded: 2020, founders: [{ full_name: 'Jane Roe', title: 'CEO' }] }) }],
    ]);
    const out = await ycDirectoryConnector.run(companyTask('Stripe Labs'), ctxFor('Jane Roe', 'Stripe Labs'));
    expect(out.findings.find((f) => f.category === 'corporate').title).toBe('Y Combinator directory shows Stripe Labs as INACTIVE (Winter 2021 batch, founded 2020)');
    const calls = network([]);
    expect((await ycDirectoryConnector.run(companyTask('Nonexistent Robotics'), ctxFor('Jane Roe', 'Nonexistent Robotics'))).findings).toEqual([]);
    expect(calls).toHaveLength(0); // the index is cached
  });

  test('list and page both down: run rejects', async () => {
    network([[/./, { status: 500, body: 'error' }]]);
    await expect(ycDirectoryConnector.run(companyTask('Stripe'), ctxFor('Patrick Collison', 'Stripe'))).rejects.toThrow();
  });
});

describe('the set', () => {
  test('ids, kinds and labels follow the contract', () => {
    expect(registryConnectors.map((c) => [c.id, c.kinds])).toEqual([
      ['uk-companies-house', ['subject', 'company']],
      ['fr-companies', ['subject', 'company']],
      ['us-state-registries', ['company']],
      ['lei-register', ['company']],
      ['yc-directory', ['company', 'subject']],
    ]);
    for (const c of registryConnectors) {
      expect(c.enabled()).toBe(true);
      expect(c.label).not.toMatch(/\b(API|endpoint|free|paid|key|token)\b/i);
    }
  });
});
