/**
 * Round 2 fixes for the company registers (plan item 2(b), 2(c)): a same-named
 * company with no officer tie gives no record for an affiliate lookup, nor for
 * a one-word company name; the records kept are held at "possible" and kept
 * off the timeline; the negative title never repeats the person's name.
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { ukCompaniesConnector, frCompaniesConnector } = require('../../../src/server/founder/sources/registries');

function network(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    const hit = routes.find(([pattern]) => pattern.test(url));
    const reply = hit ? hit[1] : { status: 404, body: 'not found' };
    return { status: reply.status || 200, headers: new Map(), url, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) };
  });
  return calls;
}

const ctxFor = (name, company) => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}) });
const companyTask = (value, tie) => ({ kind: 'company', value, depth: 1, template: null, params: null, ...(tie ? { tie } : {}) });

afterEach(() => setTransport());
beforeEach(() => __resetCacheForTests());

/* ------------------------------------------------------------------ UK */

const ukSearch = (rows) => `<html><body><div id="search-container"><ul class="results-list">${rows.map(([number, name]) => `
  <li class="type-company"><h3><a class="govuk-link" href="/company/${number}" title="View company"> ${name} </a></h3>
    <p class="meta crumbtrail"> ${number} - Incorporated on 1 January 2015 </p></li>`).join('')}</ul></div></body></html>`;
const ukOfficers = (name, officers) => `<html><body><h1 class="heading-xlarge">${name}</h1>
  <h2 class="heading-medium" id="company-appointments">${officers.length} officers</h2>
  <div class="appointments-list">${officers.map((o, i) => `
  <div class="appointment-${i + 1}">
    <h2 class="heading-medium"><span id="officer-name-${i + 1}"><a class="govuk-link" href="/officers/X${i}/appointments">${o}</a></span></h2>
    <dl><dt>Role <span id="officer-status-tag-${i + 1}" class="status-tag">Active</span></dt><dd id="officer-role-${i + 1}" class="data"> Director </dd></dl>
    <dl><dt>Appointed on</dt><dd id="officer-appointed-on-${i + 1}" class="data"> 1 January 2015 </dd></dl>
    <dl><dt>Date of birth</dt><dd class="data">July 1970</dd></dl>
  </div>`).join('')}</div></body></html>`;
const ukCompanyPage = (name, number) => `<html><body><h1 class="heading-xlarge">${name}</h1><p id="company-number">Company number <strong>${number}</strong></p>
  <dd class="text data" id="company-status"> Active </dd><dd class="data" id="company-creation-date">1 January 2015</dd></body></html>`;

describe('UK Companies House: a same-named company with no officer tie', () => {
  test('an affiliate lookup gives no record, only a note that does not name the person', async () => {
    network([
      [/\/search\/companies/, { body: ukSearch([['11111111', 'ORBITEX PARTNERS GROUP LIMITED']]) }],
      [/\/company\/11111111\/officers$/, { body: ukOfficers('ORBITEX PARTNERS GROUP LIMITED', ['JONES, Peter']) }],
      [/\/company\/11111111$/, { body: ukCompanyPage('ORBITEX PARTNERS GROUP LIMITED', '11111111') }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Orbitex Partners Group', 'affiliate'), ctxFor('Jane Roe', 'Acme Robotics'));
    expect(out.findings).toEqual([]);
    expect(out.threads).toEqual([]);
    expect(out.notes).toEqual(['No UK company named Orbitex Partners Group lists the person as an officer.']);
    expect(out.notes.join(' ')).not.toMatch(/Jane Roe/);
  });

  test('an affiliate company whose officers include the person is still reported', async () => {
    network([
      [/\/search\/companies/, { body: ukSearch([['22222222', 'ORBITEX LIMITED']]) }],
      [/\/company\/22222222\/officers$/, { body: ukOfficers('ORBITEX LIMITED', ['ROE, Jane']) }],
      [/\/company\/22222222$/, { body: ukCompanyPage('ORBITEX LIMITED', '22222222') }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Orbitex', 'affiliate'), ctxFor('Jane Roe', 'Acme Robotics'));
    expect(out.findings.find((f) => f.match === 'company')).toBeTruthy();
    expect(out.notes).toEqual([]);
  });

  test('a primary company with a one-word name and no officer tie: no record, a note', async () => {
    network([
      [/\/search\/companies/, { body: ukSearch([['33333333', 'ORBITEX LTD']]) }],
      [/\/company\/33333333\/officers$/, { body: ukOfficers('ORBITEX LTD', ['JONES, Peter']) }],
      [/\/company\/33333333$/, { body: ukCompanyPage('ORBITEX LTD', '33333333') }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Orbitex'), ctxFor('Jane Roe', 'Orbitex'));
    expect(out.findings).toEqual([]);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toMatch(/^UK companies named Orbitex were found, but no listed officer matches the person/);
  });

  test('a missing tie on the task counts as primary; a two-word name is kept, possible for good, off the timeline, without the person\'s name in the title', async () => {
    network([
      [/\/search\/companies/, { body: ukSearch([['44444444', 'ORBITEX ROBOTICS LIMITED']]) }],
      [/\/company\/44444444\/officers$/, { body: ukOfficers('ORBITEX ROBOTICS LIMITED', ['JONES, Peter']) }],
      [/\/company\/44444444$/, { body: ukCompanyPage('ORBITEX ROBOTICS LIMITED', '44444444') }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Orbitex Robotics'), ctxFor('Jane Roe', 'Orbitex Robotics'));
    expect(out.findings).toHaveLength(1);
    const [f] = out.findings;
    expect(f).toMatchObject({ match: 'possible', matchFixed: true, excludeFromTimeline: true });
    expect(f.title).toMatch(/\(no listed officer matches the person\)$/);
    expect(f.title).not.toMatch(/Jane Roe/);
    expect(f.matchReasons.join(' ')).not.toMatch(/Jane Roe/);
    expect(out.notes).toEqual([]);
  });

  test('a one-word name given with its legal form is kept when the register has exactly that name', async () => {
    network([
      [/\/search\/companies/, { body: ukSearch([['55555555', 'ORBITEX CORP']]) }],
      [/\/company\/55555555\/officers$/, { body: ukOfficers('ORBITEX CORP', ['JONES, Peter']) }],
      [/\/company\/55555555$/, { body: ukCompanyPage('ORBITEX CORP', '55555555') }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Orbitex Corporation'), ctxFor('Jane Roe', 'Orbitex Corporation'));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'possible', excludeFromTimeline: true });
  });
});

/* ------------------------------------------------------------------ France */

const frResult = (name, siren, dirigeants) => ({
  siren, nom_complet: name, nom_raison_sociale: name, sigle: null, nature_juridique: '5710', etat_administratif: 'A', date_creation: '2006-03-01',
  date_fermeture: null, statut_diffusion: 'O', dirigeants,
});
const stranger = [{ nom: 'DURAND', prenoms: 'MARIE', qualite: 'Président', type_dirigeant: 'personne physique' }];

describe('French register: a same-named company with no officer tie', () => {
  test('an affiliate lookup gives no record, only a note', async () => {
    network([[/recherche-entreprises/, { body: { results: [frResult('ORBITEX PARTNERS', '111111111', stranger)] } }]]);
    const out = await frCompaniesConnector.run(companyTask('Orbitex Partners', 'affiliate'), ctxFor('Jane Roe', 'Acme Robotics'));
    expect(out.findings).toEqual([]);
    expect(out.notes).toEqual(['No French company named Orbitex Partners lists the person as an officer.']);
  });

  test('a primary one-word name given with a legal form does not keep a register entry without it', async () => {
    network([[/recherche-entreprises/, { body: { results: [frResult('ORBITEX', '222222222', stranger), frResult('ORBITEX', '333333333', stranger)] } }]]);
    const out = await frCompaniesConnector.run(companyTask('Orbitex Corporation'), ctxFor('Jane Roe', 'Orbitex Corporation'));
    expect(out.findings).toEqual([]);
    expect(out.notes).toHaveLength(1);
  });

  test('a two-word primary name is kept, possible, off the timeline, with the neutral title', async () => {
    network([[/recherche-entreprises/, { body: { results: [frResult('ORBITEX ROBOTICS', '444444444', stranger)] } }]]);
    const out = await frCompaniesConnector.run(companyTask('Orbitex Robotics'), ctxFor('Jane Roe', 'Orbitex Robotics'));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'possible', matchFixed: true, excludeFromTimeline: true });
    expect(out.findings[0].title).toMatch(/\(no listed officer matches the person\)$/);
    expect(JSON.stringify(out.findings[0])).not.toMatch(/Jane Roe/);
  });

  test('a company that lists the person is reported for an affiliate', async () => {
    network([[/recherche-entreprises/, { body: { results: [frResult('ORBITEX', '555555555', [{ nom: 'ROE', prenoms: 'JANE', qualite: 'Président', type_dirigeant: 'personne physique' }])] } }]]);
    const out = await frCompaniesConnector.run(companyTask('Orbitex', 'affiliate'), ctxFor('Jane Roe', 'Acme Robotics'));
    expect(out.findings.find((f) => f.match === 'company')).toBeTruthy();
    expect(out.notes).toEqual([]);
  });
});
