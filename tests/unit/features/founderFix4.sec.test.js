/**
 * Round-4 grading fixes for src/server/founder/sources/sec.js: CEO tenures
 * read from Form D notices (item 1), one passage per kind of dealing in a
 * company's own prospectus (item 3), and the registrant tie applied to the
 * plain mentions of the person (item 17).
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, matchSubject } = require('../../../src/server/founder/identity');
const { secPersonConnector, secCompanyConnector, __resetSecForTests } = require('../../../src/server/founder/sources/sec');

const ACME = 'Acme Rockets Corp  (ACRK)  (CIK 0000000100)';

function hit(adsh, file, { names, form = 'D', root = form, date = '2021-06-17', items = [], xsl = null, fileType = form } = {}) {
  const ciks = names.map((n) => (n.match(/CIK (\d+)/) || [])[1]).filter(Boolean);
  return { _index: 'edgar_file', _id: `${adsh}:${file}`, _source: { ciks, display_names: names, root_forms: [root], form, file_type: fileType, file_date: date, items, adsh, xsl } };
}
const searchAnswer = (hits) => JSON.stringify({ hits: { total: { value: hits.length, relation: 'eq' }, hits } });
const page = (body) => `<html><body><main>${body}</main></body></html>`;
const formD = (issuer, persons, signer = ['Kim Brady', 'CFO']) => `<?xml version="1.0"?><edgarSubmission><primaryIssuer><entityName>${issuer}</entityName><jurisdictionOfInc>DELAWARE</jurisdictionOfInc><entityType>Corporation</entityType></primaryIssuer>
<relatedPersonsList>${persons.map(([f, l, r, c = '']) => `<relatedPersonInfo><relatedPersonName><firstName>${f}</firstName><lastName>${l}</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>${r}</relationship></relatedPersonRelationshipList><relationshipClarification>${c}</relationshipClarification></relatedPersonInfo>`).join('')}</relatedPersonsList>
<offeringData><signatureBlock><signature><nameOfSigner>${signer[0]}</nameOfSigner><signatureTitle>${signer[1]}</signatureTitle></signature></signatureBlock></offeringData></edgarSubmission>`;

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
const roles = (s) => [...(s.anchors.roles?.values() || [])];

beforeEach(() => { __resetSecForTests(); });
afterEach(() => setTransport());

describe('item 1: a Form D that states the person is CEO of a company tied to them records the tenure', () => {
  const notices = (persons, signer) => [
    [searchUrl, searchAnswer([
      hit('0000000100-17-000002', 'primary_doc.xml', { names: [ACME], date: '2017-05-01', xsl: 'xslFormDX01' }),
      hit('0000000100-14-000001', 'old_doc.xml', { names: [ACME], date: '2014-01-10', xsl: 'xslFormDX01' }),
    ])],
    ['primary_doc.xml', formD('Acme Rockets Corp', persons, signer)],
  ];

  test('signed by the person as CEO: a closed tenure from the first to the last notice, used to grade "<company> CEO" news of that time', async () => {
    const s = newSubject();
    fakeSec(notices([['Jane', 'Roe', 'Executive Officer']], ['Jane Roe', 'Chief Executive Officer']));
    const r = await run(s, 'formd');
    expect(r.findings[0].match).toBe('confirmed');
    expect(roles(s)).toEqual([expect.objectContaining({ role: 'ceo', from: '2014-01-10', to: '2017-05-01' })]);
    expect(matchSubject(s, 'Acme Rockets CEO gives back $5.9M', { date: '2016-03-01' }).level).toBe('none'); // no name: never tied
    expect(matchSubject(s, 'Acme Rockets CEO gives back $5.9M', { date: '2022-03-01' }).level).toBe('none');
  });

  test('the clarification of the person\'s entry may state the title', async () => {
    const s = newSubject();
    fakeSec(notices([['Jane', 'Roe', 'Executive Officer', 'Chief Executive Officer']]));
    await run(s, 'formd');
    expect(roles(s)).toHaveLength(1);
  });

  test('"Executive Officer" alone (a finance chief ticks it too) records no tenure', async () => {
    const s = newSubject();
    fakeSec(notices([['Jane', 'Roe', 'Executive Officer']]));
    const r = await run(s, 'formd');
    expect(r.findings[0].match).toBe('confirmed');
    expect(roles(s)).toHaveLength(0);
  });

  test('an issuer not tied to the person records no tenure, even when it names them as CEO', async () => {
    const s = newSubject();
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000700-17-000002', 'primary_doc.xml', { names: ['Zeta Labs Inc  (CIK 0000000700)'], date: '2017-05-01', xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Zeta Labs Inc', [['Jane', 'Roe', 'Executive Officer', 'CEO']])],
    ]);
    await run(s, 'formd');
    expect(roles(s)).toHaveLength(0);
  });

  test('the company\'s own Form D lookup records it too, but not for a company the person was only an affiliate of', async () => {
    const routes = [
      [searchUrl, searchAnswer([hit('0000000100-18-000003', 'primary_doc.xml', { names: [ACME], date: '2018-02-02', xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Acme Rockets Corp', [['Jane', 'Roe', 'Executive Officer', 'CEO']])],
    ];
    const s = newSubject();
    fakeSec(routes);
    await secCompanyConnector.run({ kind: 'company', value: 'Acme Rockets', template: 'formd', depth: 1 }, ctx(s));
    expect(roles(s)).toEqual([expect.objectContaining({ from: '2018-02-02', to: '2018-02-02' })]);

    const t = newSubject();
    fakeSec(routes);
    await secCompanyConnector.run({ kind: 'company', value: 'Acme Rockets', template: 'formd', depth: 1, tie: 'affiliate' }, ctx(t));
    expect(roles(t)).toHaveLength(0);
  });
});

describe('item 3: one record per kind of dealing in the company\'s own prospectus', () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} describes our rocket engines, launch schedule and customers in general terms only.</p>`).join('');
  const s1 = (family) => page([
    '<p>Jane Roe is our Chief Executive Officer and a director.</p>', filler(8),
    '<p>In 2018 we entered into a lease for our headquarters with a landlord entity controlled by Jane Roe.</p>', filler(8),
    '<p>In 2019 Jane Roe provided us a loan under a promissory note of $2.0 million, which was repaid.</p>', filler(8),
    '<p>In 2020 we purchased from Jane Roe the trademark "Rocket" for $5.9 million.</p>', filler(8),
    family,
  ].join(''));
  const routes = (body) => [
    [searchUrl, searchAnswer([hit('0000000100-19-000020', 'acme-s1.htm', { names: [ACME], form: 'S-1/A', root: 'S-1', date: '2019-08-14' })])],
    ['acme-s1.htm', body],
  ];

  test('the lease, the loan and the trademark are separate records, each with its own title', async () => {
    fakeSec(routes(s1('')));
    const r = await run(newSubject(), 'related');
    const quotes = r.findings.map((f) => f.quote).join(' | ');
    expect(r.findings).toHaveLength(3);
    expect(quotes).toMatch(/lease for our headquarters/);
    expect(quotes).toMatch(/promissory note/);
    expect(quotes).toMatch(/trademark "Rocket"/);
    expect(new Set(r.findings.map((f) => f.id)).size).toBe(3);
    expect(r.findings.every((f) => f.match === 'confirmed' && f.severity !== 'info')).toBe(true);
  });

  test('"other members of his family" is reported when no relative is named, and not when one is named without a role', async () => {
    fakeSec(routes(s1('<p>We have also paid for travel by Jane Roe and other members of her family on our aircraft.</p>')));
    const unnamed = await run(newSubject(), 'related');
    const family = unnamed.findings.find((f) => /other members of her family/.test(f.quote));
    expect(family).toBeDefined();
    expect(family.title).toMatch(/immediate family members/);
    expect(unnamed.threads.some((t) => t.kind === 'relative')).toBe(false);

    fakeSec(routes(s1('<p>We have also paid for travel by Jane Roe, her sister Mary Roe and other members of her family on our aircraft.</p>')));
    const named = await run(newSubject(), 'related');
    expect(named.findings.some((f) => /Mary Roe/.test(f.quote))).toBe(false);
  });

  test('a filing by a company not tied to the person keeps one passage', async () => {
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000900-19-000020', 'other-s1.htm', { names: ['Unrelated Widgets Inc  (CIK 0000000900)'], form: 'S-1', date: '2019-08-14' })])],
      ['other-s1.htm', s1('')],
      ['data.sec.gov/submissions/CIK0000000900.json', JSON.stringify({ name: 'Unrelated Widgets Inc', formerNames: [] })],
    ]);
    const r = await run(newSubject(), 'related');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible');
  });
});

describe('item 17: the registrant tie and the person\'s company in the plain mentions', () => {
  async function tieCik(s) {
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-11-000001', 'primary_doc.xml', { names: [ACME], date: '2011-04-01', xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Acme Rockets Corp', [['Jane', 'Roe', 'Executive Officer']])],
    ]);
    expect((await run(s, 'formd')).findings[0].match).toBe('confirmed');
  }

  test('a filing by the tied registrant under a new name that could not be read is likely, not name-only', async () => {
    const s = newSubject();
    await tieCik(s);
    fakeSec([[searchUrl, searchAnswer([hit('0000000100-19-000010', 'rocketco-s1.htm', { names: ['Rocketco Inc  (CIK 0000000100)'], form: 'S-1', date: '2019-03-01' })])]]);
    const r = await run(s, 'all');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('likely');
    expect(r.findings[0].matchReasons[0]).toMatch(/CIK 100.*not read/);
  });

  test('the company\'s filings that name the person: a registrant tied by CIK is graded by that tie', async () => {
    const s = newSubject();
    await tieCik(s);
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-19-000011', 'rocketco-10k.htm', { names: ['Rocketco Inc  (CIK 0000000100)'], form: '10-K', date: '2019-03-01' })])],
      ['rocketco-10k.htm', page('<p>Jane Roe leads our product team and sits on the board.</p>')],
    ]);
    const r = await secCompanyConnector.run({ kind: 'company', value: 'Zeta Labs', template: 'joint', depth: 1 }, ctx(s));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('confirmed');
    expect(r.findings[0].matchReasons[0]).toMatch(/CIK 100/);
  });

  test('a counterparty\'s filing: the person\'s company written near the name is brought into the quote', async () => {
    const body = page('<p>On March 1 we signed a supply agreement with Acme Rockets for engine parts. The agreement runs for five years and covers deliveries to our plants in Ohio, Texas and Michigan, with prices reset each year by an index of steel and aluminium costs. Jane Roe attended the signing ceremony at our offices.</p>');
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000800-20-000001', 'big-8k.htm', { names: ['Big Motors Co  (CIK 0000000800)'], form: '8-K', date: '2020-03-02', items: ['1.01'] })])],
      ['big-8k.htm', body],
    ]);
    const r = await run(newSubject(), 'all');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].quote).toMatch(/Acme Rockets/);
    expect(r.findings[0].quote).toMatch(/Jane Roe/);
    expect(r.findings[0].match).toBe('confirmed');
  });

  test('a counterparty\'s filing that names the person far from the company stays name-only', async () => {
    const far = page(`<p>We signed a supply agreement with Acme Rockets.</p>${'<p>Our plants in Ohio, Texas and Michigan produce engines for trucks and buses in large numbers each year.</p>'.repeat(12)}<p>Jane Roe attended the signing ceremony.</p>`);
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000800-20-000002', 'big-8k2.htm', { names: ['Big Motors Co  (CIK 0000000800)'], form: '8-K', date: '2020-03-02', items: ['1.01'] })])],
      ['big-8k2.htm', far],
    ]);
    const r = await run(newSubject(), 'all');
    expect(r.findings[0].match).toBe('possible');
  });
});
