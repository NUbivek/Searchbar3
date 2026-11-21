/**
 * Round-3 grading fixes for src/server/founder/sources/sec.js: filers tied by
 * SEC registrant number (CIK), severity read from the person's own sentences,
 * look-alike Form D issuers, and relatives' roles read from their own clause.
 */
// The SEC's website answers only a declared contact; these tests read filing documents, so one is declared.
process.env.SEC_USER_AGENT = 'Test Runner test@example.com';
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { secPersonConnector, secCompanyConnector, __resetSecForTests } = require('../../../src/server/founder/sources/sec');

const ACME = 'Acme Rockets Corp  (ACRK)  (CIK 0000000100)';

function hit(adsh, file, { names, form = 'D', root = form, date = '2021-06-17', items = [], xsl = null, fileType = form } = {}) {
  const ciks = names.map((n) => (n.match(/CIK (\d+)/) || [])[1]).filter(Boolean);
  return { _index: 'edgar_file', _id: `${adsh}:${file}`, _source: { ciks, display_names: names, root_forms: [root], form, file_type: fileType, file_date: date, items, adsh, xsl } };
}
const searchAnswer = (hits) => JSON.stringify({ hits: { total: { value: hits.length, relation: 'eq' }, hits } });
const page = (body) => `<html><body><main>${body}</main></body></html>`;
const formD = (issuer, persons) => `<?xml version="1.0"?><edgarSubmission><primaryIssuer><entityName>${issuer}</entityName><jurisdictionOfInc>DELAWARE</jurisdictionOfInc><entityType>Corporation</entityType></primaryIssuer>
<relatedPersonsList>${persons.map(([f, l, r]) => `<relatedPersonInfo><relatedPersonName><firstName>${f}</firstName><lastName>${l}</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>${r}</relationship></relatedPersonRelationshipList></relatedPersonInfo>`).join('')}</relatedPersonsList>
<offeringData><signatureBlock><signature><nameOfSigner>Kim Brady</nameOfSigner><signatureTitle>CFO</signatureTitle></signature></signatureBlock></offeringData></edgarSubmission>`;

function fakeSec(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    const route = routes.find(([test]) => (typeof test === 'string' ? url.includes(test) : test(url)));
    if (!route) return { status: 404, headers: new Map(), url, text: async () => 'not found' };
    const [, body, status = 200] = route;
    return { status, headers: new Map(), url, text: async () => (typeof body === 'function' ? body(url) : body) };
  });
  return calls;
}
const searchUrl = (url) => url.startsWith('https://efts.sec.gov/LATEST/search-index');

const newSubject = () => createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
const ctx = (s) => ({ subject: s, deadline: Date.now() + 20000, known: () => ({}) });
const run = (s, template) => secPersonConnector.run({ kind: 'subject', value: s.name, template, depth: 0 }, ctx(s));

beforeEach(() => { __resetSecForTests(); });
afterEach(() => setTransport());

describe('item 5: a filer tied to the person by its SEC registrant number', () => {
  test('after a confirmed Form D, a filing by the same CIK under a new name is the person\'s; another CIK stays name-only', async () => {
    const s = newSubject();
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-11-000001', 'primary_doc.xml', { names: [ACME], date: '2011-04-01', xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Acme Rockets Corp', [['Jane', 'Roe', 'Executive Officer']])],
    ]);
    const formd = await run(s, 'formd');
    expect(formd.findings[0].match).toBe('confirmed');

    fakeSec([
      [searchUrl, searchAnswer([
        hit('0000000100-19-000010', 'rocketco-10k.htm', { names: ['Rocketco Inc  (CIK 0000000100)'], form: '10-K', date: '2019-03-01' }),
        hit('0000000900-19-000010', 'other-10k.htm', { names: ['Unrelated Widgets Inc  (CIK 0000000900)'], form: '10-K', date: '2019-03-01' }),
      ])],
      ['rocketco-10k.htm', page('<p>Jane Roe leads our product team and sits on the board.</p>')],
      ['other-10k.htm', page('<p>Jane Roe leads our product team and sits on the board.</p>')],
    ]);
    const all = await run(s, 'all');
    const rocketco = all.findings.find((f) => /Rocketco/.test(f.title));
    const other = all.findings.find((f) => /Unrelated Widgets/.test(f.title));
    // A registry tie raises a read passage to 'likely', never to a hand-set 'confirmed' (round 3, rule 2).
    expect(rocketco.match).toBe('likely');
    expect(rocketco.matchReasons.join(' ')).toMatch(/CIK 100/);
    expect(other.match).toBe('possible');
  });

  test('a prospectus by a registrant that formerly filed under a known company\'s name is confirmed, and its names become trusted companies', async () => {
    const s = newSubject();
    const lease = page('<p>Jane Roe is our Chief Executive Officer.</p><p>In 2019 we entered into a lease for our headquarters with an entity controlled by Jane Roe.</p>');
    const calls = fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-19-000020', 'rocket-s1a.htm', { names: ['The Rocket Company  (CIK 0000000100)'], form: 'S-1/A', root: 'S-1', date: '2019-08-14' })])],
      ['rocket-s1a.htm', lease],
      ['data.sec.gov/submissions/CIK0000000100.json', JSON.stringify({ name: 'The Rocket Company', formerNames: [{ name: 'Acme Rockets Corp', from: '2011-01-01', to: '2019-01-09' }] })],
    ]);
    const r = await run(s, 'related');
    expect(calls.some((u) => u.includes('data.sec.gov/submissions/CIK0000000100.json'))).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('likely'); // round 3: never 'confirmed' by hand
    expect(r.findings[0].matchReasons[0]).toMatch(/The Rocket Company \(SEC CIK 100\), which also filed as Acme Rockets Corp/);
    const company = (v) => r.threads.find((t) => t.kind === 'company' && t.value === v);
    expect(company('The Rocket Company')).toMatchObject({ trusted: true });
    expect(company('Acme Rockets Corp')).toMatchObject({ trusted: true });
  });

  test('a registrant whose EDGAR names are not the person\'s companies stays a name-only match', async () => {
    const s = newSubject();
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000300-19-000020', 'other-s1.htm', { names: ['The Rocket Company  (CIK 0000000300)'], form: 'S-1', date: '2019-08-14' })])],
      ['other-s1.htm', page('<p>Jane Roe is our Chief Executive Officer.</p><p>In 2019 we entered into a lease for our headquarters with an entity controlled by Jane Roe.</p>')],
      ['data.sec.gov/submissions/CIK0000000300.json', JSON.stringify({ name: 'The Rocket Company', formerNames: [{ name: 'Rocket Parts Supply LLC' }] })],
    ]);
    const r = await run(s, 'related');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible');
    expect(r.threads.some((t) => t.kind === 'company' && t.trusted)).toBe(false);
  });

  test('"our Co-Founder and Chief Executive Officer, <name>" in the filer\'s own main document ties the filer', async () => {
    const s = newSubject();
    const search = searchAnswer([hit('0000000500-20-000001', 'zeta-10k.htm', { names: ['Zeta Labs Inc  (CIK 0000000500)'], form: '10-K', date: '2020-03-01' })]);
    fakeSec([[searchUrl, search], ['zeta-10k.htm', page('<p>Our Co-Founder and Chief Executive Officer, Jane Roe, previously founded Acme Rockets.</p>')]]);
    const founder = await run(s, 'all');
    expect(founder.threads.find((t) => t.kind === 'company' && t.value === 'Zeta Labs Inc')).toMatchObject({ trusted: true });

    fakeSec([[searchUrl, search], ['zeta-10k.htm', page('<p>Our customers include a firm whose adviser, Jane Roe, previously founded Acme Rockets.</p>')]]);
    const mention = await run(newSubject(), 'all');
    expect(mention.threads.some((t) => t.value === 'Zeta Labs Inc' && t.trusted)).toBe(false);
  });
});

describe('item 9: severity of an exhibit or 8-K passage is read from the person\'s own sentences', () => {
  const deck = (body) => [
    [searchUrl, searchAnswer([hit('0000000100-20-000050', 'deck-ex99.htm', { names: [ACME], form: '8-K', fileType: 'EX-99.1', date: '2020-03-03', items: ['7.01', '9.01'] })])],
    ['deck-ex99.htm', page(body)],
  ];

  test('another executive\'s bankruptcy in a merger deck is not a red flag against the person', async () => {
    fakeSec(deck('<p>Jane Roe is the founder and Chief Executive Officer of Acme Rockets.</p><p>John Smith previously led General Widgets through its bankruptcy restructuring.</p>'));
    const r = await run(newSubject(), 'all');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].quote).toMatch(/bankruptcy/);
    expect(r.findings[0].severity).toBe('info');
  });

  test('the same word in a sentence about the person still counts', async () => {
    fakeSec(deck('<p>Jane Roe, the founder of Acme Rockets, previously led General Widgets through its bankruptcy restructuring.</p>'));
    const r = await run(newSubject(), 'all');
    expect(r.findings[0].severity).toBe('medium');
  });
});

describe('item 12: look-alike Form D issuers for a company', () => {
  const company = (value) => ({ kind: 'company', value, template: 'formd', depth: 1 });
  const notice = (issuer, cik, persons) => [
    [searchUrl, searchAnswer([hit(`${cik}-21-000001`, 'primary_doc.xml', { names: [`${issuer}  (CIK ${cik})`], date: '2021-01-01', xsl: 'xslFormDX01' })])],
    ['primary_doc.xml', formD(issuer, persons)],
  ];

  test('an issuer that adds words to the company name is kept only when its notice lists the person', async () => {
    fakeSec(notice('Flow Holdings, Inc.', '0000000700', [['Amy', 'Stone', 'Director'], ['Bo', 'Lane', 'Director']]));
    const s = newSubject();
    expect((await secCompanyConnector.run(company('Flow'), ctx(s))).findings).toEqual([]);

    fakeSec(notice('Flow Holdings, Inc.', '0000000700', [['Jane', 'Roe', 'Director'], ['Bo', 'Lane', 'Director']]));
    const named = await secCompanyConnector.run(company('Flow'), ctx(s));
    expect(named.findings.map((f) => f.title)).toEqual(['Form D filed by Flow Holdings, Inc. names Jane Roe as Director']);
  });

  test('a notice listing three or more people, none the person or a known associate, is dropped; a shorter one stays a company record', async () => {
    const s = newSubject();
    // A distinctive name: "Flow" is an ordinary word, whose bare-word notices never count as the company's (round 3).
    fakeSec(notice('Floqast Inc', '0000000710', [['Amy', 'Stone', 'Director'], ['Bo', 'Lane', 'Director'], ['Cy', 'Hart', 'Executive Officer']]));
    expect((await secCompanyConnector.run(company('Floqast'), ctx(s))).findings).toEqual([]);

    fakeSec(notice('Floqast Inc', '0000000710', [['Amy', 'Stone', 'Director'], ['Bo', 'Lane', 'Director']]));
    expect((await secCompanyConnector.run(company('Floqast'), ctx(s))).findings.map((f) => f.match)).toEqual(['company']);
  });
});

describe('item 18: relatives in the company\'s own disclosures', () => {
  const family = (body) => [
    [searchUrl, searchAnswer([hit('0000000100-21-000030', 'acme-def14a.htm', { names: [ACME], form: 'DEF 14A', date: '2021-04-01' })])],
    ['acme-def14a.htm', page(body)],
  ];

  test('a role before the relatives is theirs; a title after another person\'s name is not', async () => {
    fakeSec(family(`<p>Jane Roe, our founder, serves as Executive Chair.</p><p>${'Board matters and governance. '.repeat(20)}</p>
      <p>The awards went to employees of Legacy Acme, including Ms. Roe’s relatives, Tom Roe and Ann Roe, and Jim B. Doe, our Chief Legal Officer.</p>`));
    const r = await run(newSubject(), 'family');
    expect(r.findings).toHaveLength(1);
    const roles = r.findings[0].data.relatives.map((x) => [x.name, x.role]);
    expect(roles).toEqual([['Tom Roe', 'employees of Legacy Acme'], ['Ann Roe', 'employees of Legacy Acme']]);
  });

  test('the role phrase after the relative is kept whole, and stops before the next person', async () => {
    fakeSec(family(`<p>Jane Roe, our founder, serves as Executive Chair.</p><p>${'Board matters and governance. '.repeat(20)}</p>
      <p>Tom Roe, the brother of Jane Roe, serves as our Vice President of Sales, and Jim B. Doe serves as our Chief Legal Officer.</p>`));
    const r = await run(newSubject(), 'family');
    expect(r.findings[0].data.relatives).toEqual([{ name: 'Tom Roe', relation: 'brother', role: 'serves as our Vice President of Sales' }]);
  });

  test('relatives listed beside another person\'s title, with no role of their own, are not reported', async () => {
    fakeSec(family(`<p>Jane Roe, our founder, serves as Executive Chair.</p><p>${'Board matters and governance. '.repeat(20)}</p>
      <p>Ms. Roe’s relatives, Tom Roe and Ann Roe, and Jim B. Doe, our Chief Legal Officer, attended the meeting.</p>`));
    expect((await run(newSubject(), 'family')).findings).toEqual([]);
  });

  test('a known company\'s prospectus gives a separate passage about a relative it employs, apart from the dealings passage', async () => {
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-19-000010', 'acme-s1.htm', { names: [ACME], form: 'S-1', date: '2019-08-14' })])],
      ['acme-s1.htm', page(`<p>In 2018 we entered into a lease for our headquarters with an entity controlled by Jane Roe, and we paid rent of $4.2 million under this lease.</p>
        <p>${'General description of the business and its risks. '.repeat(40)}</p>
        <p>Tom Roe, the brother of Jane Roe, is employed as our Director of Logistics and received compensation of $180,000 in 2018.</p>`)],
    ]);
    const r = await run(newSubject(), 'related');
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0].title).toMatch(/dealings with the company \(lease\)/);
    expect(r.findings[1].title).toMatch(/passage about a relative \(brother\)/);
    expect(r.findings[1].quote).toMatch(/Director of Logistics/);
    expect(r.findings[1].match).toBe('confirmed');
    expect(r.threads.find((t) => t.kind === 'relative' && t.value === 'Tom Roe')).toMatchObject({ relation: 'brother', trusted: true });
  });
});
