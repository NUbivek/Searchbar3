/**
 * SEC connectors (src/server/founder/sources/sec.js): EDGAR full-text search,
 * Form D notices, insider reports, related-party passages, enforcement
 * releases and company-level cyber-incident reports. No network: the
 * transport is faked with small fixtures cut from real EDGAR answers.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { CATEGORIES } = require('../../../src/server/founder/finding');
const { secPersonConnector, secCompanyConnector, parseFormD, parseOwnership, __resetSecForTests } = require('../../../src/server/founder/sources/sec');

/* ------------------------------------------------------------------ fixtures */

const NIKOLA = 'Nikola Corp  (NKLA)  (CIK 0001731289)';

/** One EDGAR full-text search hit, shaped like efts.sec.gov/LATEST/search-index. */
function hit(adsh, file, { names, form = 'D', root = form, date = '2021-06-17', items = [], xsl = null, fileType = form, period = null } = {}) {
  const ciks = names.map((n) => (n.match(/CIK (\d+)/) || [])[1]).filter(Boolean);
  return { _index: 'edgar_file', _id: `${adsh}:${file}`, _source: { ciks, display_names: names, root_forms: [root], form, file_type: fileType, file_date: date, period_ending: period, items, adsh, xsl } };
}
const searchAnswer = (hits, total = hits.length) => JSON.stringify({ hits: { total: { value: total, relation: 'eq' }, hits } });

function formD({ issuer = 'Nikola Corp', previous = 'VectoIQ Acquisition Corp.', persons = [], sold = '0', firstSale = '2021-06-11', signer = 'Kim Brady' } = {}) {
  const people = persons.map(([first, last, roles]) => `
      <relatedPersonInfo>
        <relatedPersonName><firstName>${first}</firstName><middleName></middleName><lastName>${last}</lastName></relatedPersonName>
        <relatedPersonAddress><street1>4141 E BROADWAY RD</street1><city>PHOENIX</city><stateOrCountry>AZ</stateOrCountry><zipCode>85040</zipCode></relatedPersonAddress>
        <relatedPersonRelationshipList>${roles.map((r) => `<relationship>${r}</relationship>`).join('')}</relatedPersonRelationshipList>
        <relationshipClarification></relationshipClarification>
      </relatedPersonInfo>`).join('');
  return `<?xml version="1.0"?>
<edgarSubmission>
  <primaryIssuer>
    <cik>0001731289</cik><entityName>${issuer}</entityName>
    <issuerAddress><street1>4141 E BROADWAY RD</street1><city>PHOENIX</city><zipCode>85040</zipCode></issuerAddress>
    <issuerPhoneNumber>480-666-1038</issuerPhoneNumber>
    <jurisdictionOfInc>DELAWARE</jurisdictionOfInc>
    <issuerPreviousNameList><previousName>${previous}</previousName></issuerPreviousNameList>
    <entityType>Corporation</entityType>
    <yearOfInc><withinFiveYears>true</withinFiveYears><value>2018</value></yearOfInc>
  </primaryIssuer>
  <relatedPersonsList>${people}</relatedPersonsList>
  <offeringData>
    <industryGroup><industryGroupType>Other</industryGroupType></industryGroup>
    <typeOfFiling><newOrAmendment><isAmendment>false</isAmendment></newOrAmendment><dateOfFirstSale><value>${firstSale}</value></dateOfFirstSale></typeOfFiling>
    <offeringSalesAmounts><totalOfferingAmount>300000000</totalOfferingAmount><totalAmountSold>${sold}</totalAmountSold></offeringSalesAmounts>
    <signatureBlock><signature><issuerName>${issuer}</issuerName><nameOfSigner>${signer}</nameOfSigner><signatureTitle>Chief Financial Officer</signatureTitle></signature></signatureBlock>
  </offeringData>
</edgarSubmission>`;
}

const FORM4 = `<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer><issuerCik>0001731289</issuerCik><issuerName>Nikola Corp</issuerName><issuerTradingSymbol>NKLA</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001808962</rptOwnerCik><rptOwnerName>Milton Trevor R.</rptOwnerName></reportingOwnerId>
    <reportingOwnerAddress><rptOwnerStreet1>P.O. BOX 50608</rptOwnerStreet1><rptOwnerCity>PHOENIX</rptOwnerCity><rptOwnerZipCode>85076</rptOwnerZipCode></reportingOwnerAddress>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>Executive Chairman</officerTitle><isTenPercentOwner>1</isTenPercentOwner></reportingOwnerRelationship>
  </reportingOwner>
</ownershipDocument>`;

const page = (body) => `<html><body><main>${body}</main></body></html>`;

/** Routes requests by URL; records every URL and header set. */
function fakeSec(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, headers: init.headers });
    const route = routes.find(([test]) => (typeof test === 'string' ? url.includes(test) : test(url)));
    if (!route) return { status: 404, headers: new Map(), url, text: async () => 'not found' };
    const [, body, status = 200] = route;
    const text = typeof body === 'function' ? body(url) : body;
    return { status, headers: new Map(), url, text: async () => text };
  });
  return calls;
}

const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const ctx = (s = subject) => ({ subject: s, deadline: Date.now() + 20000, known: () => ({}) });
const person = (template) => ({ kind: 'subject', value: subject.name, template, depth: 0 });
const company = (template, value = 'Nikola') => ({ kind: 'company', value, template, depth: 1 });
const searchUrl = (url) => url.startsWith('https://efts.sec.gov/LATEST/search-index');
const param = (url, name) => new URL(url).searchParams.get(name);

beforeEach(() => { __resetSecForTests(); delete process.env.SEC_USER_AGENT; });
afterEach(() => setTransport());

/* ------------------------------------------------------------------ shape */

describe('connector shape and wording', () => {
  test('ids, kinds and plain-English labels', () => {
    expect(secPersonConnector.id).toBe('sec-filings');
    expect(secPersonConnector.kinds).toEqual(['subject']);
    expect(secCompanyConnector.id).toBe('sec-company');
    expect(secCompanyConnector.kinds).toEqual(['company']);
    for (const c of [secPersonConnector, secCompanyConnector]) {
      expect(c.label).not.toMatch(/\b(API|endpoint|free|paid|key|token)\b/i);
      for (const p of c.plan({ kind: c.kinds[0], value: 'x' }, subject)) {
        expect(p.template).toBeTruthy();
        expect(p.why).not.toMatch(/\b(API|endpoint|free|paid|key|token)\b/i);
      }
    }
    expect(secPersonConnector.plan(person('all'), subject).map((p) => p.template).sort()).toEqual(['all', 'enforcement', 'formd', 'insider', 'related']);
    expect(secCompanyConnector.plan(company('formd'), subject).map((p) => p.template).sort()).toEqual(['cyber', 'formd', 'joint']);
  });

  test('parseFormD never reads addresses or phone numbers', () => {
    const doc = parseFormD(formD({ persons: [['Trevor', 'Milton', ['Executive Officer', 'Director']]] }));
    expect(doc.issuerName).toBe('Nikola Corp');
    expect(doc.yearOfInc).toBe('2018');
    expect(doc.persons[0]).toMatchObject({ name: 'Trevor Milton', roles: ['Executive Officer', 'Director'] });
    expect(JSON.stringify(doc)).not.toMatch(/BROADWAY|480-666|85040/);
    expect(parseFormD('<html>blocked</html>')).toBeNull();
  });

  test('parseOwnership reads the relationship and not the owner address', () => {
    const doc = parseOwnership(FORM4);
    expect(doc.issuerName).toBe('Nikola Corp');
    expect(doc.owners[0].roles).toEqual(['director', 'officer (Executive Chairman)', 'owner of more than 10%']);
    expect(JSON.stringify(doc)).not.toMatch(/BOX|85076/);
  });
});

/* ------------------------------------------------------------------ person: Form D */

describe('secPersonConnector formd', () => {
  test('a Form D naming the person with a known company is confirmed, with roles, trusted threads and no address', async () => {
    const calls = fakeSec([
      [(u) => searchUrl(u) && param(u, 'forms') === 'D', searchAnswer([
        hit('0001731289-21-000078', 'primary_doc.xml', { names: [NIKOLA], date: '2021-06-17', xsl: 'xslFormDX01', items: ['06B'] }),
        hit('0001470747-09-000001', 'primary_doc.xml', { names: ['Lexon Industries Inc.  (CIK 0001470747)'], date: '2009-08-27', xsl: 'xslFormDX01' }),
      ])],
      ['/1731289/000173128921000078/primary_doc.xml', formD({ persons: [['Trevor', 'Milton', ['Executive Officer', 'Director']], ['Mark', 'Russell', ['Executive Officer']], ['Steve', 'Girsky', ['Director']]] })],
      ['/1470747/000147074709000001/primary_doc.xml', formD({ issuer: 'Lexon Industries Inc.', previous: 'None', persons: [['Trevor', 'Milton', ['Executive Officer']], ['Jane', 'Doe', ['Director']]] })],
    ]);
    const r = await secPersonConnector.run(person('formd'), ctx());
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(r.findings).toHaveLength(2);
    const [nikola, lexon] = r.findings;
    expect(nikola.title).toBe('Form D filed by Nikola Corp names Trevor Milton as Executive Officer and Director');
    expect(nikola.match).toBe('confirmed');
    expect(nikola.category).toBe('corporate');
    expect(Object.keys(CATEGORIES)).toContain(nikola.category);
    expect(nikola.date).toBe('2021-06-17');
    expect(nikola.url).toBe('https://www.sec.gov/Archives/edgar/data/1731289/000173128921000078/xslFormDX01/primary_doc.xml');
    expect(nikola.quote).toMatch(/year of incorporation: 2018/);
    expect(nikola.quote).toMatch(/date of first sale: 2021-06-11/);
    expect(nikola.quote).not.toMatch(/BROADWAY|480-666|85040/i);
    // A namesake's notice stays a name-only match
    expect(lexon.match).toBe('possible');
    const thread = (kind, value) => r.threads.find((t) => t.kind === kind && t.value === value);
    expect(thread('company', 'Nikola Corp').trusted).toBe(true);
    expect(thread('company', 'Lexon Industries Inc.').trusted).toBe(false);
    expect(thread('associate', 'Mark Russell').trusted).toBe(true);
    expect(thread('associate', 'Jane Doe').trusted).toBe(false);
  });

  test('nothing found returns no findings; a search failure rejects', async () => {
    fakeSec([[searchUrl, searchAnswer([])]]);
    const empty = await secPersonConnector.run(person('formd'), ctx());
    expect(empty.findings).toEqual([]);
    fakeSec([[searchUrl, 'Service Unavailable', 500]]);
    await expect(secPersonConnector.run(person('formd'), ctx())).rejects.toThrow();
    fakeSec([[searchUrl, '{"unexpected":true}']]);
    await expect(secPersonConnector.run(person('all'), ctx())).rejects.toThrow(/unexpected/);
  });
});

/* ------------------------------------------------------------------ person: all filings */

describe('secPersonConnector all', () => {
  test('grades the passage: company next to the name is confirmed, name only is possible, absent name is dropped', async () => {
    const calls = fakeSec([
      [searchUrl, searchAnswer([
        hit('0001104659-20-106691', 'tm2030359d3_ex99-1.htm', { names: [NIKOLA], form: '8-K', fileType: 'EX-99.1', date: '2020-09-21', items: ['5.02', '9.01'] }),
        hit('0000000001-19-000001', 'acme10k.htm', { names: ['Acme Widgets Inc  (CIK 0000000001)'], form: '10-K', date: '2019-03-01' }),
        hit('0000000002-18-000002', 'other10k.htm', { names: ['Other Holdings Corp  (CIK 0000000002)'], form: '10-K', date: '2018-03-01' }),
      ], 155)],
      ['tm2030359d3_ex99-1.htm', page('<p>Trevor Milton Steps Down as Executive Chairman of Nikola Corporation.</p><p>PHOENIX, September 20, 2020 - Nikola Corporation today announced that Trevor Milton, its founder, has resigned as Executive Chairman and as a member of the board of directors.</p>')],
      ['acme10k.htm', page('<p>Our sales team includes Trevor Milton, who manages our regional accounts in the Midwest.</p>')],
      ['other10k.htm', page('<p>This annual report does not name anyone you are looking for.</p>')],
    ]);
    const r = await secPersonConnector.run(person('all'), ctx());
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(r.findings).toHaveLength(2);
    const nikola = r.findings.find((f) => /Nikola/.test(f.title));
    expect(nikola.title).toMatch(/^8-K \(exhibit 99\.1\) filed by Nikola Corp mentions Trevor Milton/);
    expect(nikola.match).toBe('confirmed');
    expect(nikola.quote).toMatch(/Trevor Milton/);
    expect(nikola.date).toBe('2020-09-21');
    expect(nikola.url).toBe('https://www.sec.gov/Archives/edgar/data/1731289/000110465920106691/tm2030359d3_ex99-1.htm');
    const acme = r.findings.find((f) => /Acme/.test(f.title));
    expect(acme.match).toBe('possible');
    expect(r.findings.some((f) => /Other Holdings/.test(f.title))).toBe(false);
    expect(r.threads.find((t) => t.kind === 'company' && t.value === 'Nikola Corp')).toMatchObject({ trusted: true });
    expect(r.threads.some((t) => t.value === 'Acme Widgets Inc' && t.trusted)).toBe(false);
    expect(r.notes.join(' ')).toMatch(/155 documents/);
  });
});

/* ------------------------------------------------------------------ person: insider */

describe('secPersonConnector insider', () => {
  test('reads the reporting relationship and the holding vehicle', async () => {
    const calls = fakeSec([
      [(u) => searchUrl(u) && param(u, 'keysTyped'), JSON.stringify({ hits: { hits: [{ _id: '1808962', _source: { entity: 'Milton Trevor R.' } }, { _id: '1000001', _source: { entity: 'Milton Trevor Holdings LLC' } }] } })],
      [(u) => searchUrl(u) && param(u, 'ciks'), searchAnswer([
        hit('0001140361-22-030790', 'form4.xml', { names: ['Milton Trevor R.  (CIK 0001808962)', NIKOLA, 'M&M Residual, LLC  (CIK 0001811111)'], form: '4', date: '2022-08-24', xsl: 'xslF345X03' }),
        hit('0001140361-20-013000', 'form3.xml', { names: ['Milton Trevor R.  (CIK 0001808962)', NIKOLA], form: '3', date: '2020-06-05', xsl: 'xslF345X02' }),
      ])],
      ['form4.xml', FORM4],
      ['form3.xml', FORM4],
    ]);
    const r = await secPersonConnector.run(person('insider'), ctx());
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(param(calls[1].url, 'ciks')).toBe('0001808962');
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.title).toBe('Insider reports: Trevor Milton filed as director, officer (Executive Chairman) and owner of more than 10% of Nikola Corp (NKLA)');
    expect(f.match).toBe('confirmed');
    expect(f.date).toBe('2022-08-24');
    expect(f.url).toBe('https://www.sec.gov/Archives/edgar/data/1808962/000114036122030790/xslF345X03/form4.xml');
    expect(f.quote).toMatch(/between 2020-06-05 and 2022-08-24/);
    expect(f.quote).not.toMatch(/BOX|85076/);
    expect(r.threads.find((t) => t.value === 'Nikola Corp').trusted).toBe(true);
    expect(r.threads.find((t) => t.value === 'M&M Residual, LLC')).toBeTruthy();
  });

  test('no filer by that name: one request, no findings', async () => {
    const calls = fakeSec([[searchUrl, JSON.stringify({ hits: { hits: [{ _id: '1', _source: { entity: 'Milton Bradley Co' } }] } })]]);
    const r = await secPersonConnector.run(person('insider'), ctx());
    expect(r.findings).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ person: related parties */

describe('secPersonConnector related', () => {
  test('a related-party passage becomes a related finding with a relative thread', async () => {
    const calls = fakeSec([
      [searchUrl, searchAnswer([
        hit('0001047469-20-004147', 'a2241967zs-1.htm', { names: [NIKOLA], form: 'S-1', date: '2020-07-17' }),
      ])],
      ['a2241967zs-1.htm', page('<h2>Certain Relationships and Related Party Transactions</h2><p>Trevor Milton is our founder and Executive Chairman. Tanner Milton, the brother of Trevor Milton, serves as our Vice President of Hydrogen Production, and received total compensation of $250,000 in 2019.</p>')],
    ]);
    const r = await secPersonConnector.run(person('related'), ctx());
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.category).toBe('related');
    expect(f.title).toMatch(/^S-1 filed by Nikola Corp names Trevor Milton in a passage about a relative \(brother\)/);
    expect(f.match).toBe('confirmed');
    expect(f.quote).toMatch(/Tanner Milton/);
    const relative = r.threads.find((t) => t.kind === 'relative');
    expect(relative).toMatchObject({ value: 'Tanner Milton', trusted: true });
  });

  test('a spouse with a business role in the filing becomes a relative thread', async () => {
    const neumann = createSubject({ name: 'Adam Neumann', company: 'WeWork' });
    fakeSec([
      [searchUrl, searchAnswer([hit('0001119307-19-000010', 'we-s1a.htm', { names: ['We Co.  (CIK 0001119307)'], form: 'S-1/A', root: 'S-1', date: '2019-09-13' })])],
      ['we-s1a.htm', page('<p>Adam Neumann Co-Founder and Chief Executive Officer. Adam is married to Rebekah Neumann and is an executive officer. Rebekah Neumann is one of our co-founders and serves as our Chief Brand and Impact Officer.</p>')],
    ]);
    const r = await secPersonConnector.run({ kind: 'subject', value: neumann.name, template: 'related' }, ctx(neumann));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].title).toMatch(/passage about a relative \(married to\)/);
    expect(r.threads.find((t) => t.kind === 'relative')).toMatchObject({ value: 'Rebekah Neumann', relation: 'spouse' });
  });

  test('a filing whose terms are nowhere near the name is not reported', async () => {
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000003-20-000003', 'proxy.htm', { names: ['Some Bank Corp  (CIK 0000000003)'], form: 'DEF 14A', date: '2020-04-01' })])],
      ['proxy.htm', page(`<p>Trevor Milton spoke at our investor day.</p><p>${'Filler text about the business. '.repeat(80)}</p><p>Our policy on related party transactions applies to every family member of a director.</p>`)],
    ]);
    const r = await secPersonConnector.run(person('related'), ctx());
    expect(r.findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ person: enforcement */

const LIT_LIST = `<table class="views-table"><tbody>
<tr class="pr-list-page-row"><td><time datetime="2025-09-11T20:09:12Z" class="datetime">Sept. 11, 2025</time></td>
<td><div class='release-view__respondents'><a href='/enforcement-litigation/litigation-releases/lr-26397'>Trevor R. Milton</a></div>
<div class="view-table_subfield view-table_subfield_release_number"><span class="view-table_subfield_label">Release No.</span> <span class="view-table_subfield_value">LR-26397</span></div></td></tr>
<tr class="pr-list-page-row"><td><time datetime="2019-01-01T10:00:00Z" class="datetime">Jan. 1, 2019</time></td>
<td><div class='release-view__respondents'><a href='/enforcement-litigation/litigation-releases/lr-20000'>Gregory Milton</a></div>
<div class="view-table_subfield view-table_subfield_release_number"><span class="view-table_subfield_label">Release No.</span> <span class="view-table_subfield_value">LR-20000</span></div></td></tr>
</tbody></table><div>Displaying 1 to 2 of 2 items</div>`;
const EMPTY_LIST = '<div class="view-empty"><p class="no-results-text">No results found.</p></div>';

describe('secPersonConnector enforcement', () => {
  test('a litigation release naming the person is a regulatory finding; other people with the surname are skipped', async () => {
    const calls = fakeSec([
      ['litigation-releases?populate=Milton', LIT_LIST],
      ['administrative-proceedings?populate=Milton', EMPTY_LIST],
      ['litigation-releases/lr-26397', page('<h1>Trevor R. Milton</h1><p>Litigation Release No. 26397 / September 11, 2025</p><p>Securities and Exchange Commission v. Trevor R. Milton. The SEC charged Trevor R. Milton, founder and former CEO of Nikola Corporation, with defrauding investors by making false and misleading statements.</p>')],
    ]);
    const r = await secPersonConnector.run(person('enforcement'), ctx());
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.category).toBe('regulatory');
    expect(['medium', 'high']).toContain(f.severity);
    expect(f.title).toMatch(/^SEC litigation release LR-26397: Trevor R\. Milton/);
    expect(f.match).toBe('confirmed');
    expect(f.url).toBe('https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26397');
    expect(f.date).toMatch(/^2025-09-11/);
  });

  test('both lists down rejects', async () => {
    fakeSec([[() => true, 'down', 500]]);
    await expect(secPersonConnector.run(person('enforcement'), ctx())).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ company connector */

describe('secCompanyConnector', () => {
  test('formd: company-level notice uses match company; associates only from a notice that names the person', async () => {
    const calls = fakeSec([
      [searchUrl, searchAnswer([
        hit('0001731289-21-000078', 'primary_doc.xml', { names: [NIKOLA], date: '2021-06-17', xsl: 'xslFormDX01' }),
        hit('0001731289-20-000010', 'primary_doc.xml', { names: [NIKOLA], date: '2020-05-01', xsl: 'xslFormDX01' }),
      ])],
      ['000173128921000078/primary_doc.xml', formD({ persons: [['Mark', 'Russell', ['Executive Officer']], ['Kim', 'Brady', ['Executive Officer']]], sold: '0' })],
      ['000173128920000010/primary_doc.xml', formD({ persons: [['Trevor', 'Milton', ['Executive Officer', 'Director']], ['Mark', 'Russell', ['Executive Officer']]], firstSale: '2020-04-20' })],
    ]);
    const r = await secCompanyConnector.run(company('formd'), ctx());
    expect(param(calls[0].url, 'entityName')).toBe('Nikola');
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(r.findings).toHaveLength(2);
    const [latest, named] = r.findings;
    expect(latest.match).toBe('company');
    expect(latest.title).toBe('Form D filed by Nikola Corp: private fundraise ($0 sold, first sale 2021-06-11)');
    expect(named.title).toBe('Form D filed by Nikola Corp names Trevor Milton as Executive Officer and Director');
    expect(named.match).toBe('confirmed');
    const associates = r.threads.filter((t) => t.kind === 'associate').map((t) => t.value);
    expect(associates).toEqual(['Mark Russell']); // Kim Brady is only on the notice that does not name the person
  });

  test('cyber: an 8-K Item 1.05 report is a company-level exposure finding', async () => {
    fakeSec([
      [searchUrl, searchAnswer([hit('0001731289-24-000050', 'nkla-8k.htm', { names: [NIKOLA], form: '8-K', date: '2024-02-01', items: ['1.05'] })])],
      ['nkla-8k.htm', page('<p>Item 1.05 Material Cybersecurity Incidents. On January 28, 2024, the Company detected unauthorized access to certain of its information technology systems.</p>')],
    ]);
    const r = await secCompanyConnector.run(company('cyber'), ctx());
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ category: 'exposure', match: 'company', severity: 'medium', date: '2024-02-01', title: '8-K Item 1.05: Nikola Corp reported a material cybersecurity incident' });
    expect(r.findings[0].quote).toMatch(/unauthorized access/);
  });

  test('cyber: a different company that only contains the name, or several look-alikes, are not reported', async () => {
    fakeSec([[searchUrl, searchAnswer([hit('0000000010-24-000001', 'x8k.htm', { names: ['Nikola Tesla Fund LP  (CIK 0000000010)'], form: '8-K', date: '2024-02-01', items: ['1.05'] })])]]);
    expect((await secCompanyConnector.run(company('cyber'), ctx())).findings).toEqual([]);
    fakeSec([[searchUrl, searchAnswer([
      hit('0000000009-24-000001', 'a8k.htm', { names: ['Nikola Labs Inc.  (CIK 0000000009)'], form: '8-K', date: '2024-02-01', items: ['1.05'] }),
      hit('0000000011-24-000001', 'b8k.htm', { names: ['Nikola Technologies Ltd  (CIK 0000000011)'], form: '8-K', date: '2024-03-01', items: ['1.05'] }),
    ])]]);
    expect((await secCompanyConnector.run(company('cyber'), ctx())).findings).toEqual([]);
  });

  test('cyber: the exact company beats a look-alike filer', async () => {
    fakeSec([
      [searchUrl, searchAnswer([
        hit('0000000009-24-000001', 'a8k.htm', { names: ['Nikola Labs Inc.  (CIK 0000000009)'], form: '8-K', date: '2024-03-01', items: ['1.05'] }),
        hit('0001731289-24-000050', 'nkla-8k.htm', { names: [NIKOLA], form: '8-K', date: '2024-02-01', items: ['1.05'] }),
      ])],
      [() => true, page('<p>Item 1.05 Material Cybersecurity Incidents. The Company detected a ransomware attack.</p>')],
    ]);
    const r = await secCompanyConnector.run(company('cyber'), ctx());
    expect(r.findings.map((f) => f.title)).toEqual(['8-K Item 1.05: Nikola Corp reported a material cybersecurity incident']);
  });

  test('joint: the company\'s own filing naming the person is confirmed', async () => {
    fakeSec([
      [(u) => searchUrl(u) && param(u, 'entityName'), searchAnswer([hit('0001539497-24-000899', 'def14a.htm', { names: [NIKOLA], form: 'DEF 14A', date: '2024-04-24' })])],
      [searchUrl, searchAnswer([])],
      ['def14a.htm', page('<p>M&amp;M Residual, LLC, an entity controlled by our former founder and former executive chair, Trevor Milton, delivered a nomination notice to the Company.</p>')],
    ]);
    const r = await secCompanyConnector.run(company('joint'), ctx());
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ match: 'confirmed', category: 'corporate', date: '2024-04-24' });
    expect(r.findings[0].title).toBe('DEF 14A filed by Nikola Corp mentions Trevor Milton');
  });

  test('declared contact from SEC_USER_AGENT is sent; a failing search rejects', async () => {
    process.env.SEC_USER_AGENT = 'Example Research ops@example.com';
    const calls = fakeSec([[searchUrl, 'oops', 503]]);
    await expect(secCompanyConnector.run(company('formd'), ctx())).rejects.toThrow();
    expect(calls[0].headers['User-Agent']).toBe('Example Research ops@example.com');
  });
});
