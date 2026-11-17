/**
 * Round 3 fix for the company registers (plan item 21): a registered name that
 * adds to a known company's name only words for a country arm, a holding or a
 * legal form ("MISTRAL AI UK LTD" for "Mistral AI") ties an appointment like
 * the company itself, when the known name has two words of its own. Other
 * look-alikes stay held at "possible".
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { ukCompaniesConnector } = require('../../../src/server/founder/sources/registries');

function network(routes) {
  setTransport(async (url) => {
    const hit = routes.find(([pattern]) => pattern.test(url));
    const reply = hit ? hit[1] : { status: 404, body: 'not found' };
    return { status: reply.status || 200, headers: new Map(), url, text: async () => reply.body };
  });
}

const ctxFor = (name, company) => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}) });
const subjectTask = (name) => ({ kind: 'subject', value: name, depth: 0, template: 'uk.officers', params: null });
const companyTask = (value) => ({ kind: 'company', value, depth: 1, template: null, params: null });

afterEach(() => setTransport());
beforeEach(() => __resetCacheForTests());

const officerSearch = (name) => `<html><body><div id="search-container"><ul class="results-list">
  <li class="type-officer"><h3><a class="govuk-link" href="/officers/P1/appointments">${name}</a></h3></li></ul></div></body></html>`;
const appointmentsPage = (name, items) => `<html><body><h1 id="officer-name">${name}</h1><h2 id="personal-appointments">Total number of appointments ${items.length}</h2>
  <div class="appointments-list">${items.map((a, i) => `<div>
    <h2 id="company-name-${i + 1}"><a href="/company/${a.number}">${a.company} (${a.number})</a></h2>
    <dd id="company-status-value-${i + 1}">Active</dd><dd id="appointment-type-value${i + 1}">Director</dd><dd id="appointed-value${i + 1}">25 May 2023</dd></div>`).join('')}</div></body></html>`;

async function appointmentsFor(name, company, companies) {
  network([
    [/\/search\/officers/, { body: officerSearch(name) }],
    [/\/officers\/P1\/appointments$/, { body: appointmentsPage(name, companies.map((c, i) => ({ company: c, number: String(10000000 + i) }))) }],
  ]);
  const out = await ukCompaniesConnector.run(subjectTask('Jane Roe'), ctxFor('Jane Roe', company));
  return Object.fromEntries(companies.map((c) => [c, out.findings.find((f) => f.title.includes(` of ${c} `))]));
}

describe('UK officer appointments at a known company\'s country arm', () => {
  test('a country, holding or employee-vehicle word added to a two-word known name ties the record', async () => {
    const got = await appointmentsFor('Jane ROE', 'Orbitex Robotics', ['ORBITEX ROBOTICS UK LTD', 'ORBITEX ROBOTICS FRANCE SAS', 'ORBITEX ROBOTICS EMPLOYEES SPV LIMITED', 'ORBITEX ROBOTICS HOLDINGS INC']);
    for (const f of Object.values(got)) {
      expect(f.match).not.toBe('possible');
      expect(f.matchFixed).toBeFalsy();
    }
  });

  test('any other added word, or a one-word known name, stays held at possible', async () => {
    const got = await appointmentsFor('Jane ROE', 'Orbitex Robotics', ['ORBITEX ROBOTICS CLEANING UK LTD', 'ORBITEX ROBOTICSWARE LTD']);
    expect(got['ORBITEX ROBOTICS CLEANING UK LTD']).toMatchObject({ match: 'possible', matchFixed: true });
    expect(got['ORBITEX ROBOTICSWARE LTD']).toMatchObject({ match: 'possible' });

    const oneWord = await appointmentsFor('Jane ROE', 'Flow', ['FLOW UK LTD']);
    expect(oneWord['FLOW UK LTD']).toMatchObject({ match: 'possible', matchFixed: true });
  });
});

describe('UK company lookup: the known company\'s country arm', () => {
  const companySearch = `<html><body><div id="search-container"><ul class="results-list">
    <li class="type-company"><h3><a class="govuk-link" href="/company/14894136"> ORBITEX ROBOTICS UK LTD </a></h3><p class="meta crumbtrail"> 14894136 - Incorporated on 25 May 2023 </p></li></ul></div></body></html>`;
  const officers = `<html><body><h1 class="heading-xlarge">ORBITEX ROBOTICS UK LTD</h1><h2 id="company-appointments">1 officer</h2><div class="appointments-list"><div>
    <span id="officer-name-1"><a href="/officers/X1/appointments">ROE, Jane Alice</a></span>
    <dd id="officer-role-1">Director</dd><dd id="officer-appointed-on-1">25 May 2023</dd></div></div></body></html>`;
  const page = `<html><body><div class="company-header"><h1>ORBITEX ROBOTICS UK LTD</h1></div><p id="company-number">Company number <strong>14894136</strong></p>
    <dd id="company-status">Active</dd><dd id="company-creation-date">25 May 2023</dd></body></html>`;

  test('the subject\'s own seat ties it without a known associate on the board', async () => {
    network([
      [/\/search\/companies/, { body: companySearch }],
      [/\/company\/14894136\/officers$/, { body: officers }],
      [/\/company\/14894136$/, { body: page }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Orbitex Robotics'), ctxFor('Jane Roe', 'Orbitex Robotics'));
    const record = out.findings.find((f) => f.url.endsWith('/company/14894136'));
    expect(record).toMatchObject({ match: 'company' });
    expect(record.title).toMatch(/^UK company record: ORBITEX ROBOTICS UK LTD/);
    expect(out.findings.find((f) => /^Jane Roe: director of ORBITEX ROBOTICS UK LTD/.test(f.title)).match).not.toBe('possible');
  });

  test('a company that is not a known one of the subject still needs a known associate', async () => {
    network([
      [/\/search\/companies/, { body: companySearch }],
      [/\/company\/14894136\/officers$/, { body: officers }],
      [/\/company\/14894136$/, { body: page }],
    ]);
    const out = await ukCompaniesConnector.run(companyTask('Orbitex Robotics'), ctxFor('Jane Roe', 'Acme Labs'));
    const record = out.findings.find((f) => f.url.endsWith('/company/14894136'));
    expect(record).toMatchObject({ match: 'possible' });
  });
});
