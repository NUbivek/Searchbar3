/**
 * Round-2 grading fixes for src/server/founder/sources/sec.js: affiliate
 * companies, related-party dealings, relatives in the company's own filings,
 * press releases and cited complaints, and passage-less duplicates.
 */
// The SEC's website answers only a declared contact; these tests read filing documents, so one is declared.
process.env.SEC_USER_AGENT = 'Test Runner test@example.com';
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { secPersonConnector, secCompanyConnector, parsePressList, __resetSecForTests } = require('../../../src/server/founder/sources/sec');

const ACME = 'Acme Rockets Corp  (ACRK)  (CIK 0000000100)';
const LOOKALIKE = 'Option Ltd  (CIK 0000000200)';

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
const param = (url, name) => new URL(url).searchParams.get(name);

const subject = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
const ctx = (s = subject) => ({ subject: s, deadline: Date.now() + 20000, known: () => ({}) });
const person = (template) => ({ kind: 'subject', value: subject.name, template, depth: 0 });

beforeEach(() => { __resetSecForTests(); });
afterEach(() => setTransport());

describe('item 2(d): affiliate companies', () => {
  test('plan skips cyber incidents for an affiliate; a primary company keeps them', () => {
    const templates = (tie) => secCompanyConnector.plan({ kind: 'company', value: 'Option', tie }, subject).map((p) => p.template);
    expect(templates('affiliate')).toEqual(['formd', 'joint']);
    expect(templates('primary')).toEqual(['formd', 'joint', 'cyber', 'events']);
    expect(templates(undefined)).toEqual(['formd', 'joint', 'cyber', 'events']);
  });

  test('cyber for an affiliate task asks nothing and returns nothing', async () => {
    const calls = fakeSec([[() => true, searchAnswer([])]]);
    const r = await secCompanyConnector.run({ kind: 'company', value: 'Option', template: 'cyber', tie: 'affiliate' }, ctx());
    expect(r.findings).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('formd for an affiliate keeps no company-level notice, only a note; a notice that names the person is kept', async () => {
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000200-21-000001', 'primary_doc.xml', { names: [LOOKALIKE], date: '2021-01-01', xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Option Ltd', [['John', 'Smith', 'Executive Officer']])],
    ]);
    const affiliate = await secCompanyConnector.run({ kind: 'company', value: 'Option', template: 'formd', tie: 'affiliate' }, ctx());
    expect(affiliate.findings).toEqual([]);
    expect(affiliate.threads).toEqual([]);
    expect(affiliate.notes.join(' ')).toMatch(/No Form D notice filed by a company named Option lists the person/);
    expect(affiliate.notes.join(' ')).not.toMatch(/Jane Roe/);

    // The same notice for a primary company stays a company-level record (unchanged behaviour).
    const primary = await secCompanyConnector.run({ kind: 'company', value: 'Option', template: 'formd' }, ctx());
    expect(primary.findings.map((f) => f.match)).toEqual(['company']);

    fakeSec([
      [searchUrl, searchAnswer([hit('0000000200-21-000001', 'primary_doc.xml', { names: [LOOKALIKE], date: '2021-01-01', xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Option Ltd', [['Jane', 'Roe', 'Director']])],
    ]);
    const named = await secCompanyConnector.run({ kind: 'company', value: 'Option', template: 'formd', tie: 'affiliate' }, ctx());
    expect(named.findings).toHaveLength(1);
    expect(named.findings[0].title).toBe('Form D filed by Option Ltd names Jane Roe as Director');
  });
});

describe('item 6: related-party dealings', () => {
  const S1 = 'acme-s1.htm';
  const PROXY = 'acme-def14a.htm';
  const s1Text = page(`<p>Jane Roe is our founder and Chief Executive Officer. Ms. Roe is married to John Roe.</p>
    <p>${'General description of the business and its risks. '.repeat(40)}</p>
    <p>Certain Relationships and Related Party Transactions. In 2018 we entered into a lease for our headquarters with an entity controlled by Jane Roe, and we paid rent of $4.2 million under this lease in 2019. We also made a loan of $7 million to Jane Roe evidenced by a promissory note.</p>`);

  test('dealings search is sent; a lease and loan passage beats a marriage passage and is graded medium', async () => {
    const calls = fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-19-000010', S1, { names: [ACME], form: 'S-1', date: '2019-08-14' })])],
      [S1, s1Text],
    ]);
    const r = await secPersonConnector.run(person('related'), ctx());
    const queries = calls.filter(searchUrl).map((u) => param(u, 'q'));
    expect(queries.some((q) => /^"Jane Roe" "related party transactions" OR lease OR landlord OR loan OR "promissory note" OR trademark OR "purchased from"$/.test(q))).toBe(true);
    expect(queries.every((q) => !/[()]/.test(q))).toBe(true); // EDGAR's search takes no brackets
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.quote).toMatch(/lease for our headquarters/);
    expect(f.quote).not.toMatch(/married/);
    expect(f.title).toMatch(/in a passage about dealings with the company \(lease\)/);
    expect(f.severity).toBe('medium');
    expect(f.match).toBe('confirmed');
  });

  test('three documents are read, and the main proxy of a known company is always among them', async () => {
    const others = ['Alpha Fund LP', 'Beta Partners LP', 'Gamma Capital LP'].map((n, i) => hit(`000000030${i}-20-000001`, `other${i}.htm`, { names: [`${n}  (CIK 000000030${i})`], form: '10-K', date: `2020-0${i + 1}-01` }));
    const calls = fakeSec([
      [searchUrl, searchAnswer([
        hit('0000000100-19-000010', S1, { names: [ACME], form: 'S-1', date: '2019-08-14' }),
        hit('0000000100-20-000020', 'acme-10k.htm', { names: [ACME], form: '10-K', date: '2020-03-01' }),
        hit('0000000100-21-000030', PROXY, { names: [ACME], form: 'DEF 14A', date: '2021-04-01' }),
        ...others,
      ])],
      [() => true, page('<p>Unrelated text.</p>')],
    ]);
    await secPersonConnector.run(person('related'), ctx());
    const opened = calls.filter((u) => !searchUrl(u));
    expect(opened.length).toBeGreaterThanOrEqual(3);
    expect(opened.length).toBeLessThanOrEqual(5);
    expect(opened.some((u) => u.endsWith(S1))).toBe(true);
  });
});

describe('item 6(d): relatives in the company\'s own filings', () => {
  const proxy = page(`<p>Jane Roe, our founder, serves as Executive Chair.</p>
    <p>${'Board matters and governance. '.repeat(20)}</p>
    <p>The Performance Awards recognised specific employees of Legacy Acme, including Ms. Roe’s relatives, Tom Roe and Ann Roe, and our Chief Legal Officer.</p>`);

  test('relatives named with a role are reported from a surname search limited to the company', async () => {
    const calls = fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-21-000030', 'acme-def14a.htm', { names: [ACME], form: 'DEF 14A', date: '2021-04-01' })])],
      ['acme-def14a.htm', proxy],
    ]);
    const r = await secPersonConnector.run(person('family'), ctx());
    const search = calls.find(searchUrl);
    expect(param(search, 'q')).toBe('"Roe" brother OR sister OR spouse OR "immediate family" OR relatives');
    expect(param(search, 'entityName')).toBe('Acme Rockets');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ category: 'related', match: 'confirmed' });
    expect(r.findings[0].quote).toMatch(/Tom Roe and Ann Roe/);
    const relatives = r.threads.filter((t) => t.kind === 'relative').map((t) => [t.value, t.relation, t.trusted]);
    expect(relatives).toEqual([['Tom Roe', 'relative', true], ['Ann Roe', 'relative', true]]);
  });

  test('a filing that does not name the person in full, or calls someone else "Ms. Roe", gives nothing', async () => {
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-21-000030', 'acme-def14a.htm', { names: [ACME], form: 'DEF 14A', date: '2021-04-01' })])],
      ['acme-def14a.htm', page('<p>Ms. Roe’s relatives, Tom Roe and Ann Roe, are employees of the Company.</p>')],
    ]);
    expect((await secPersonConnector.run(person('family'), ctx())).findings).toEqual([]);

    fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-21-000030', 'acme-def14a.htm', { names: [ACME], form: 'DEF 14A', date: '2021-04-01' })])],
      ['acme-def14a.htm', page(`<p>Jane Roe, our founder, serves as Executive Chair.</p><p>Mary Roe is our Vice President of Sales. Ms. Roe’s relatives, Tom Roe and Ann Roe, are employees of the Company.</p>`)],
    ]);
    expect((await secPersonConnector.run(person('family'), ctx())).findings).toEqual([]);
  });

  test('relatives with no part in the business are not reported', async () => {
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000100-21-000030', 'acme-def14a.htm', { names: [ACME], form: 'DEF 14A', date: '2021-04-01' })])],
      ['acme-def14a.htm', page('<p>Jane Roe, our founder, serves as Executive Chair. Ms. Roe’s relatives, Tom Roe and Ann Roe, attended the ceremony.</p>')],
    ]);
    expect((await secPersonConnector.run(person('family'), ctx())).findings).toEqual([]);
  });
});

describe('item 14: press releases and cited complaints', () => {
  const PRESS_LIST = `<table class="views-table"><tbody>
<tr class="pr-list-page-row"><td><time datetime="2021-12-21T07:00:00Z">Dec. 21, 2021</time></td><td class="views-field views-field-field-display-title"><a href="/newsroom/press-releases/2021-267" hreflang="en">Acme Rockets Corporation to Pay $125 Million to Resolve Fraud Charges</a></td><td headers="x" class="views-field views-field-field-release-number">2021-267 </td></tr>
<tr class="pr-list-page-row"><td><time datetime="2021-07-29T11:00:00Z">July 29, 2021</time></td><td class="views-field views-field-field-display-title"><a href="/newsroom/press-releases/2021-141" hreflang="en">SEC Charges Founder of Acme Rockets Corp. With Fraud</a></td><td headers="x" class="views-field views-field-field-release-number">2021-141 </td></tr>
<tr class="pr-list-page-row"><td><time datetime="2020-01-01T11:00:00Z">Jan. 1, 2020</time></td><td class="views-field views-field-field-display-title"><a href="/newsroom/press-releases/2020-1" hreflang="en">Acme Rockets Joins Industry Roundtable</a></td><td headers="x" class="views-field views-field-field-release-number">2020-1 </td></tr>
</tbody></table>`;
  const EMPTY = '<table class="views-table"><tbody><tr class="odd"><td colspan="3" class="views-empty"><p>No results.</p></td></tr></tbody></table>';

  test('parsePressList reads title, link, date and number; an odd page throws', () => {
    const rows = parsePressList(PRESS_LIST);
    expect(rows[1]).toEqual({ url: 'https://www.sec.gov/newsroom/press-releases/2021-141', title: 'SEC Charges Founder of Acme Rockets Corp. With Fraud', number: '2021-141', date: '2021-07-29T11:00:00Z' });
    expect(parsePressList(EMPTY)).toEqual([]);
    expect(() => parsePressList('<html>blocked</html>')).toThrow();
  });

  test('a charging release found by company is kept when its text names the person; one that does not is dropped', async () => {
    const calls = fakeSec([
      ['press-releases?combine=Jane', EMPTY],
      ['press-releases?combine=Acme', PRESS_LIST],
      ['press-releases/2021-267', page('<p>For Immediate Release 2021-267</p><p>Acme Rockets Corporation agreed to pay $125 million to resolve charges that it defrauded investors.</p><p>Last Reviewed or Updated</p>')],
      ['press-releases/2021-141', page('<p>For Immediate Release 2021-141</p><p>The Securities and Exchange Commission today announced charges against Jane Q. Roe, the founder and former CEO of Acme Rockets Corporation, for repeatedly disseminating false and misleading information.</p><p>Last Reviewed or Updated</p>')],
    ]);
    const r = await secPersonConnector.run(person('press'), ctx());
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f).toMatchObject({ category: 'regulatory', match: 'confirmed', url: 'https://www.sec.gov/newsroom/press-releases/2021-141' });
    expect(f.title).toBe('SEC press release 2021-141: SEC Charges Founder of Acme Rockets Corp. With Fraud (names Jane Roe)');
    expect(['medium', 'high']).toContain(f.severity);
    expect(f.date).toMatch(/^2021-07-29/);
    expect(f.quote).toMatch(/Jane Q\. Roe/);
  });

  test('both lists down rejects', async () => {
    fakeSec([[() => true, 'down', 500]]);
    await expect(secPersonConnector.run(person('press'), ctx())).rejects.toThrow();
  });

  test('a litigation release that cites the complaint adds the complaint, dated when filed, severity high', async () => {
    const LIST = `<table class="views-table"><tbody>
<tr><td><time datetime="2025-09-11T20:09:12Z">Sept. 11, 2025</time></td>
<td><div class='release-view__respondents'><a href='/enforcement-litigation/litigation-releases/lr-26397'>Jane Q. Roe</a></div>
<div class="view-table_subfield view-table_subfield_release_number"><span class="view-table_subfield_label">Release No.</span> <span class="view-table_subfield_value">LR-26397</span></div></td></tr>
</tbody></table><div>Displaying 1 to 1 of 1 items</div>`;
    fakeSec([
      ['litigation-releases?populate=Roe', LIST],
      ['administrative-proceedings?populate=Roe', '<div class="view-empty"><p class="no-results-text">No results found.</p></div>'],
      ['litigation-releases/lr-26397', page('<p>Litigation Release No. 26397 / September 11, 2025</p><p>Securities and Exchange Commission v. Jane Q. Roe , No. 1:21-cv-06445 (S.D.N.Y. filed July 29, 2021)</p><p>SEC Announces Dismissal of Civil Enforcement Action Against Former Acme Rockets CEO Jane Q. Roe. The Commission filed a joint stipulation to dismiss its action.</p>')],
    ]);
    const r = await secPersonConnector.run(person('enforcement'), ctx());
    expect(r.findings).toHaveLength(2);
    const complaint = r.findings.find((f) => /^SEC complaint/.test(f.title));
    expect(complaint).toMatchObject({ category: 'regulatory', severity: 'high', match: 'confirmed', title: 'SEC complaint filed in S.D.N.Y.: SEC v. Jane Q. Roe, No. 1:21-cv-06445' });
    expect(complaint.date).toBe('2021-07-29');
    expect(complaint.quote).toBe('Securities and Exchange Commission v. Jane Q. Roe, No. 1:21-cv-06445 (S.D.N.Y. filed July 29, 2021)');
    expect(complaint.data).toMatchObject({ caseNumber: '1:21-cv-06445', court: 'S.D.N.Y.', citedIn: 'LR-26397' });
  });

  test('a cited complaint against someone else (only the release names the person) is not added', async () => {
    const LIST = `<table class="views-table"><tbody>
<tr><td><time datetime="2024-01-01T00:00:00Z">Jan. 1, 2024</time></td>
<td><div class='release-view__respondents'><a href='/enforcement-litigation/litigation-releases/lr-30000'>Jane Roe; Widget Co.</a></div></td></tr>
</tbody></table><div>Displaying 1 to 1 of 1 items</div>`;
    fakeSec([
      ['litigation-releases?populate=Roe', LIST],
      ['administrative-proceedings?populate=Roe', '<div class="view-empty"></div>'],
      ['litigation-releases/lr-30000', page('<p>Litigation Release No. 30000 / January 1, 2024</p><p>Securities and Exchange Commission v. Widget Co., No. 24-cv-1 (D. Del. filed Dec. 1, 2023)</p><p>The complaint names Jane Roe as a relief defendant.</p>')],
    ]);
    const r = await secPersonConnector.run(person('enforcement'), ctx());
    expect(r.findings.some((f) => /^SEC complaint/.test(f.title))).toBe(false);
  });
});

describe('item 16: a filing with no passage is dropped when its issuer already has one with a quote', () => {
  test('all: two filings by one issuer, one read: only the read one is kept; another issuer\'s unread filing stays', async () => {
    fakeSec([
      [searchUrl, searchAnswer([
        hit('0000000100-20-000001', 'acme-10k.htm', { names: [ACME], form: '10-K', date: '2020-03-01' }),
        hit('0000000100-19-000002', 'acme-8k.htm', { names: [ACME], form: '8-K', date: '2019-05-01', items: ['8.01'] }),
        hit('0000000100-18-000003', 'acme-10q.pdf', { names: [ACME], form: '10-Q', date: '2018-05-01' }),
        hit('0000000400-18-000001', 'other.pdf', { names: ['Delta Holdings Corp  (CIK 0000000400)'], form: '10-Q', date: '2018-01-01' }),
      ])],
      ['acme-10k.htm', page('<p>Jane Roe is our founder and Chief Executive Officer of Acme Rockets.</p>')],
      ['acme-8k.htm', page('<p>Jane Roe is our founder and Chief Executive Officer of Acme Rockets.</p>')],
    ]);
    const r = await secPersonConnector.run(person('all'), ctx());
    const acme = r.findings.filter((f) => /Acme/.test(f.title));
    expect(acme.length).toBeGreaterThanOrEqual(1);
    expect(acme.every((f) => /founder/.test(f.quote))).toBe(true); // the unreadable 10-Q is dropped
    expect(r.findings.some((f) => /Delta Holdings/.test(f.title))).toBe(true);
  });
});
