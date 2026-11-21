/**
 * Round 3 fixes for src/server/founder/sources/sec.js (audit 2026-11-20, by-owner/sec.json):
 *   sec-default-ua-refused      no request to www.sec.gov without a declared contact; such lookups are not clean
 *   sec-unread-confirmed        an unread filing is never confirmed
 *   sec-hand-confirmed /
 *   identity-sec-confirmed-by-hand   no hand-set 'confirmed'
 *   sec-lease-redflag           a lease in a 10-K is a dealing of the person's only with a related-party marker
 *   sec-formd-surname-skip      the surname pass runs even when the phrase found a notice
 *   sec-silent-unread           every template says how many filings were not read
 *   sec-proxy-legal-proceedings the bio's legal-proceedings paragraph is sought, boilerplate denial is info
 *   sec-8k-events               8-K items 1.03/3.01/4.01/4.02 and late-filing notices of the company
 *   sec-sali-admin              administrative orders are read for their sanctions
 *   sec-13d-ownership           Schedules 13D/13G and Form 144 of the person's filer number
 *   sec-first-page-only         a second search over the weightier forms past 100 documents
 *   design decision 1           the issuer's legal name is learned and searched
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { secPersonConnector, secCompanyConnector, __resetSecForTests, declaredSecAgent, NOTE_UNDECLARED } = require('../../../src/server/founder/sources/sec');

const NIKOLA = 'Nikola Corp  (NKLA)  (CIK 0001731289)';
const ACME = 'Acme Rockets Corp  (CIK 0000000100)';

function hit(adsh, file, { names, form = 'D', root = form, date = '2021-06-17', items = [], xsl = null, fileType = form } = {}) {
  const ciks = names.map((n) => (n.match(/CIK (\d+)/) || [])[1]).filter(Boolean);
  return { _index: 'edgar_file', _id: `${adsh}:${file}`, _source: { ciks, display_names: names, root_forms: [root], form, file_type: fileType, file_date: date, items, adsh, xsl } };
}
const searchAnswer = (hits, total = hits.length) => JSON.stringify({ hits: { total: { value: total, relation: 'eq' }, hits } });
const page = (body) => `<html><body><main>${body}</main></body></html>`;
const formD = (issuer, persons, signer = ['Kim Brady', 'CFO']) => `<?xml version="1.0"?><edgarSubmission><primaryIssuer><entityName>${issuer}</entityName><jurisdictionOfInc>DELAWARE</jurisdictionOfInc><entityType>Corporation</entityType></primaryIssuer>
<relatedPersonsList>${persons.map(([f, l, r, m = '']) => `<relatedPersonInfo><relatedPersonName><firstName>${f}</firstName><middleName>${m}</middleName><lastName>${l}</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>${r}</relationship></relatedPersonRelationshipList><relationshipClarification></relationshipClarification></relatedPersonInfo>`).join('')}</relatedPersonsList>
<offeringData><signatureBlock><signature><nameOfSigner>${signer[0]}</nameOfSigner><signatureTitle>${signer[1]}</signatureTitle></signature></signatureBlock></offeringData></edgarSubmission>`;

function fakeSec(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, headers: init?.headers || {} });
    const route = routes.find(([test]) => (typeof test === 'string' ? url.includes(test) : test(url)));
    if (!route) return { status: 404, headers: new Map(), url, text: async () => 'not found' };
    const [, body, status = 200] = route;
    return { status, headers: new Map(), url, text: async () => (typeof body === 'function' ? body(url) : body) };
  });
  return calls;
}
const searchUrl = (url) => url.startsWith('https://efts.sec.gov/LATEST/search-index');
const param = (url, name) => new URL(url).searchParams.get(name);
const ctx = (s) => ({ subject: s, deadline: Date.now() + 20000, known: () => ({}) });
const runPerson = (s, template) => secPersonConnector.run({ kind: 'subject', value: s.name, template, depth: 0 }, ctx(s));
const runCompany = (s, value, template, tie) => secCompanyConnector.run({ kind: 'company', value, template, depth: 1, ...(tie ? { tie } : {}) }, ctx(s));
const declare = () => { process.env.SEC_USER_AGENT = 'Test Runner test@example.com'; };
const undeclare = () => { delete process.env.SEC_USER_AGENT; delete process.env.FOUNDER_HTTP_CONTACT; };
const wwwCalls = (calls) => calls.filter((c) => c.url.startsWith('https://www.sec.gov/'));
// No source may set 'confirmed' by hand (rule 2): a confirmed record must come from makeFinding's own grading.
const noHandConfirmed = (r) => expect(r.findings.filter((f) => f.match === 'confirmed' && f.matchFixed)).toEqual([]);

beforeEach(() => { __resetSecForTests(); undeclare(); });
afterEach(() => { setTransport(); undeclare(); });

describe('sec-default-ua-refused: www.sec.gov needs a declared contact', () => {
  test('the declared contact comes from SEC_USER_AGENT, else an email in FOUNDER_HTTP_CONTACT', () => {
    expect(declaredSecAgent()).toBe('');
    process.env.FOUNDER_HTTP_CONTACT = 'https://example.org/about';
    expect(declaredSecAgent()).toBe(''); // a web page is no contact the SEC accepts
    process.env.FOUNDER_HTTP_CONTACT = 'ops@example.org';
    expect(declaredSecAgent()).toBe('diligence-research ops@example.org');
    process.env.SEC_USER_AGENT = 'Example Research research@example.org';
    expect(declaredSecAgent()).toBe('Example Research research@example.org');
  });

  test('without one, Form D notices are not opened, are not confirmed, and the lookup says why', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const calls = fakeSec([
      [searchUrl, searchAnswer([hit('0001731289-21-000078', 'primary_doc.xml', { names: [NIKOLA], xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Nikola Corp', [['Trevor', 'Milton', 'Executive Officer']])],
    ]);
    const r = await runPerson(s, 'formd');
    expect(wwwCalls(calls)).toEqual([]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('likely');
    expect(r.findings[0].data.unread).toBe(true);
    expect(r.notes).toContain(NOTE_UNDECLARED);
    expect(r.notes.join(' ')).toMatch(/1 Form D notice was found in the SEC index but not read/);
    expect(r.partial.length).toBe(1);
    // The investor-facing note uses none of the forbidden words.
    expect(NOTE_UNDECLARED).not.toMatch(/\b(API|key|token|free|paid|tier|quota|user.agent|header|403)\b/i);
  });

  test('without one, the enforcement and press lookups fail (not clean) and send nothing', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const calls = fakeSec([]);
    await expect(runPerson(s, 'enforcement')).rejects.toMatchObject({ code: 'not-declared', note: NOTE_UNDECLARED });
    await expect(runPerson(s, 'press')).rejects.toMatchObject({ code: 'not-declared' });
    expect(calls).toEqual([]);
  });

  test('with one, documents are read and the contact is sent', async () => {
    declare();
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const calls = fakeSec([
      [searchUrl, searchAnswer([hit('0001731289-21-000078', 'primary_doc.xml', { names: [NIKOLA], xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Nikola Corp', [['Trevor', 'Milton', 'Executive Officer']])],
    ]);
    const r = await runPerson(s, 'formd');
    expect(wwwCalls(calls)).toHaveLength(1);
    expect(wwwCalls(calls)[0].headers['User-Agent']).toBe('Test Runner test@example.com');
    expect(r.findings[0].match).toBe('confirmed');
    expect(r.findings[0].matchFixed).toBeUndefined();
    expect(r.notes).toEqual([]);
  });

  test('a refusal by www.sec.gov is reported, and the enforcement lookup is not clean', async () => {
    declare();
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    fakeSec([[(u) => u.startsWith('https://www.sec.gov/'), 'Your Request Originates from an Undeclared Automated Tool', 403]]);
    await expect(runPerson(s, 'enforcement')).rejects.toMatchObject({ status: 403 });
  });
});

describe('sec-unread-confirmed / sec-hand-confirmed: no confirmed grade from text no one read, none by hand', () => {
  test('an unread 10-K by the known company is likely, never confirmed, and says it was not read', async () => {
    const s = createSubject({ name: 'John Smith', company: 'Acme Rockets' });
    fakeSec([[searchUrl, searchAnswer([hit('0000000100-22-000001', 'acme10k.htm', { names: [ACME], form: '10-K', date: '2022-03-01' })])]]);
    const r = await runPerson(s, 'all');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('likely');
    expect(r.findings[0].matchReasons.join(' ')).toMatch(/not read/);
    expect(r.findings[0].data.unread).toBe(true);
    expect(r.notes.join(' ')).toMatch(/not read/);
  });

  test('the joint company lookup does the same', async () => {
    const s = createSubject({ name: 'John Smith', company: 'Acme Rockets' });
    fakeSec([[searchUrl, searchAnswer([hit('0000000100-22-000001', 'acme10k.htm', { names: [ACME], form: '10-K', date: '2022-03-01' })])]]);
    const r = await runCompany(s, 'Acme Rockets', 'joint');
    expect(r.findings.map((f) => f.match)).toEqual(['likely']);
    noHandConfirmed(r);
  });

  test('a read passage by a CIK-tied registrant is raised to likely, not confirmed', async () => {
    declare();
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    // First a Form D that ties registrant 100 to her, then a filing by the same registrant under a new name.
    fakeSec([
      [(u) => searchUrl(u) && param(u, 'forms') === 'D', searchAnswer([hit('0000000100-20-000001', 'primary_doc.xml', { names: [ACME], xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Acme Rockets Corp', [['Jane', 'Roe', 'Executive Officer']])],
      [searchUrl, searchAnswer([hit('0000000100-23-000009', 'rc10k.htm', { names: ['Rocketco Inc  (CIK 0000000100)'], form: '10-K', date: '2023-03-01' })])],
      ['rc10k.htm', page('<p>Jane Roe attended the annual planning meeting in Denver.</p>')],
    ]);
    await runPerson(s, 'formd');
    const r = await runPerson(s, 'all');
    expect(r.findings[0].match).toBe('likely');
    noHandConfirmed(r);
  });

  test('a passage that holds only a longer name stays possible even by a known filer', async () => {
    declare();
    const s = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000300-15-000001', 'ex10.htm', { names: ['Theranos Inc  (CIK 0000000300)'], form: '10-K', date: '2015-03-01' })])],
      ['ex10.htm', page('<p>The trust for Erin Elizabeth Holmes holds the shares of Theranos Inc.</p>')],
    ]);
    const r = await runPerson(s, 'all');
    expect(r.findings.every((f) => f.match === 'possible')).toBe(true);
  });
});

describe('sec-lease-redflag: a lease is the person\'s dealing only with a related-party marker', () => {
  const tenK = (text) => [
    [searchUrl, searchAnswer([hit('0000000100-22-000002', 'acme10k.htm', { names: [ACME], form: '10-K', date: '2022-03-01' })])],
    ['acme10k.htm', page(text)],
  ];

  test('"We lease our headquarters" beside the CEO\'s bio is a low mention, not a medium dealing', async () => {
    declare();
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    fakeSec(tenK('<p>We lease our headquarters in Denver under a lease that expires in 2027.</p><p>Jane Roe has served as our Chief Executive Officer of Acme Rockets since 2015. Our officers are reimbursed for business expenses and payments of travel costs.</p>'));
    const r = await runPerson(s, 'related');
    expect(r.findings.length).toBeGreaterThan(0);
    for (const f of r.findings) {
      expect(f.severity).not.toBe('medium');
      expect(f.title).not.toMatch(/dealings with the company/);
    }
  });

  test('a lease from an entity controlled by the person is a medium dealing', async () => {
    declare();
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    fakeSec(tenK('<p>Jane Roe, our Chief Executive Officer of Acme Rockets, controls Roe Land LLC. We lease our Denver plant from Roe Land LLC, an entity controlled by Jane Roe, for $40,000 a month.</p>'));
    const r = await runPerson(s, 'related');
    expect(r.findings.some((f) => f.severity === 'medium' && /dealings with the company \(lease/.test(f.title))).toBe(true);
  });

  test('a passage of the company\'s own filing that calls her "Ms. Roe" is graded with the name the filing gives in full', async () => {
    declare();
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    const filler = ' Our rockets are assembled in Colorado for launch customers.'.repeat(12);
    fakeSec(tenK(`<p>Jane Roe is our founder and Chief Executive Officer of Acme Rockets.</p><p>${filler}</p><p>Related Party Transactions. We lease our Denver plant from Roe Land LLC, an entity controlled by Ms. Roe, for $40,000 a month.</p>`));
    const r = await runPerson(s, 'related');
    const lease = r.findings.find((f) => /lease/.test(f.title));
    expect(lease.match).not.toBe('possible');
    expect(lease.severity).toBe('medium');
  });
});

describe('sec-formd-surname-skip: the surname pass runs even when the phrase found a notice', () => {
  test('a notice listing "Trevor R. Milton" is found beside a phrase hit', async () => {
    declare();
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const calls = fakeSec([
      [(u) => searchUrl(u) && param(u, 'q') === '"Trevor Milton"', searchAnswer([hit('0000000400-09-000001', 'lexon.xml', { names: ['Lexon Industries Inc  (CIK 0000000400)'], date: '2009-05-01', xsl: 'xslFormDX01' })])],
      [(u) => searchUrl(u) && param(u, 'q') === '"Milton"', searchAnswer([
        hit('0000000400-09-000001', 'lexon.xml', { names: ['Lexon Industries Inc  (CIK 0000000400)'], date: '2009-05-01', xsl: 'xslFormDX01' }),
        hit('0001731289-19-000010', 'nikola.xml', { names: [NIKOLA], date: '2019-05-01', xsl: 'xslFormDX01' }),
        hit('0000000500-19-000010', 'other.xml', { names: ['Milton Farms LLC  (CIK 0000000500)'], date: '2019-04-01', xsl: 'xslFormDX01' }),
      ])],
      ['lexon.xml', formD('Lexon Industries Inc', [['Trevor', 'Milton', 'Director']])],
      ['nikola.xml', formD('Nikola Corp', [['Trevor', 'Milton', 'Executive Officer', 'R.']])],
      ['other.xml', formD('Milton Farms LLC', [['Ann', 'Milton', 'Executive Officer']])],
    ]);
    const r = await runPerson(s, 'formd');
    expect(calls.filter((c) => searchUrl(c.url)).map((c) => param(c.url, 'q'))).toEqual(['"Trevor Milton"', '"Milton"']);
    const issuers = r.findings.map((f) => f.data.issuer).sort();
    expect(issuers).toEqual(['Lexon Industries Inc', 'Nikola Corp']); // Ann Milton's notice is not his
    expect(r.findings.find((f) => f.data.issuer === 'Nikola Corp').match).toBe('confirmed');
  });
});

describe('sec-silent-unread: filings past the read limit are counted in a note and marked', () => {
  test('mentions: filings not read are marked unread and named in a note', async () => {
    declare();
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const docs = [1, 2, 3, 4, 5].map((i) => hit(`000000060${i}-20-000001`, `doc${i}.htm`, { names: [`Filer ${i} Holdings Inc  (CIK 000000060${i})`], form: '10-K', date: `2020-0${i}-01` }));
    fakeSec([[searchUrl, searchAnswer(docs)], [/doc\d\.htm/.test.bind(/doc\d\.htm/), page('<p>Trevor Milton was a director.</p>')]]);
    const r = await runPerson(s, 'all');
    const unread = r.findings.filter((f) => f.data.unread);
    expect(unread.length).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toMatch(new RegExp(`${unread.length} SEC filings? that name the person (was|were) found in the SEC index but not read`));
  });
});

describe('sec-proxy-legal-proceedings: the bio\'s legal-proceedings paragraph', () => {
  test('the passage about legal proceedings is chosen, and a disclosure of a bankruptcy is graded from it', async () => {
    declare();
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    const filler = ' This paragraph is about the company and its products.'.repeat(20);
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000700-22-000001', 'proxy.htm', { names: ['Widget Holdings Corp  (CIK 0000000700)'], form: 'DEF 14A', date: '2022-04-01' })])],
      ['proxy.htm', page(`<p>Jane Roe has served as a director since 2019.</p><p>${filler}</p><p>Involvement in Certain Legal Proceedings. In 2018 Jane Roe was chief executive officer of Gamma Corp when it filed a petition under Chapter 11 of the Bankruptcy Code.</p>`)],
    ]);
    const r = await runPerson(s, 'all');
    expect(r.findings[0].quote).toMatch(/Legal Proceedings/);
  });

  test('the boilerplate denial next to the name is info, not a red flag', async () => {
    declare();
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000700-22-000001', 'proxy.htm', { names: ['Widget Holdings Corp  (CIK 0000000700)'], form: 'DEF 14A', date: '2022-04-01' })])],
      ['proxy.htm', page('<p>Involvement in Certain Legal Proceedings. Jane Roe has not been involved in any legal proceedings, bankruptcy or criminal conviction during the past ten years.</p>')],
    ]);
    const r = await runPerson(s, 'all');
    expect(r.findings[0].severity).toBe('info');
  });
});

describe('sec-8k-events: the company\'s own notices of trouble', () => {
  test('Item 4.02 and a late 10-K are company records; other 8-Ks are left out', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const calls = fakeSec([[searchUrl, searchAnswer([
      hit('0001731289-21-000001', 'nkla-402.htm', { names: [NIKOLA], form: '8-K', date: '2021-05-10', items: ['4.02', '9.01'] }),
      hit('0001731289-21-000002', 'nkla-nt.htm', { names: [NIKOLA], form: 'NT 10-K', date: '2021-03-01' }),
      hit('0001731289-21-000003', 'nkla-502.htm', { names: [NIKOLA], form: '8-K', date: '2020-09-21', items: ['5.02'] }),
    ])]]);
    const r = await runCompany(s, 'Nikola', 'events');
    expect(param(calls[0].url, 'forms')).toMatch(/NT 10-K/);
    expect(param(calls[0].url, 'forms')).not.toMatch(/\/A/);
    expect(r.findings.map((f) => [f.match, f.severity])).toEqual([['company', 'medium'], ['company', 'low']]);
    expect(r.findings[0].title).toMatch(/Item 4\.02/);
    expect(r.findings[1].title).toMatch(/annual report would be filed late/);
  });

  test('an affiliate company is not looked up, and a bare ordinary word is never the company', async () => {
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    fakeSec([[searchUrl, searchAnswer([hit('0000000900-21-000001', 'r.htm', { names: ['Ramp Inc  (CIK 0000000900)'], form: '8-K', date: '2021-05-10', items: ['1.03'] })])]]);
    expect((await runCompany(s, 'Ramp', 'events', 'affiliate')).findings).toEqual([]);
    expect((await runCompany(s, 'Ramp', 'events')).findings).toEqual([]);
  });
});

describe('sec-sali-admin: administrative orders are read for what they impose', () => {
  test('the top order is read and its sanctions recorded', async () => {
    declare();
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    const list = (rows) => `<table class="views-table"><tbody>${rows}</tbody></table>`;
    const row = '<tr><td class="release-view__respondents"><a href="/enforcement-litigation/administrative-proceedings/34-99999">Jane Roe</a></td><td><span class="subfield_release_number"><span class="subfield_value">34-99999</span></span></td><td><time datetime="2022-01-05T12:00:00Z">Jan. 5, 2022</time></td></tr>';
    fakeSec([
      [(u) => u.includes('/litigation-releases?'), list('')],
      [(u) => u.includes('/administrative-proceedings?'), list(row)],
      ['/administrative-proceedings/34-99999', page('<p>The Commission deems it appropriate that Jane Roe be barred from association with any broker or dealer, and orders her to cease-and-desist and to pay a civil money penalty.</p>')],
    ]);
    const r = await runPerson(s, 'enforcement');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].data.sanctions).toEqual(expect.arrayContaining(['cease-and-desist order', 'civil penalty']));
    expect(r.findings[0].quote).toMatch(/barred/);
  });
});

describe('sec-13d-ownership: stakes reported by the person\'s filer number', () => {
  test('the search asks for 13D, 13G and 144 too, and a 13D is labelled', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const calls = fakeSec([
      [(u) => searchUrl(u) && param(u, 'keysTyped'), JSON.stringify({ hits: { hits: [{ _id: '1808962', _source: { entity: 'Milton Trevor R.' } }] } })],
      [(u) => searchUrl(u) && param(u, 'ciks'), searchAnswer([
        hit('0001140361-22-000001', 'sc13d.htm', { names: ['Milton Trevor R.  (CIK 0001808962)', NIKOLA], form: 'SC 13D', date: '2022-01-05' }),
      ])],
    ]);
    const r = await runPerson(s, 'insider');
    const forms = param(calls.find((c) => param(c.url, 'ciks')).url, 'forms');
    for (const f of ['SC 13D', 'SCHEDULE 13D', 'SC 13G', 'SCHEDULE 13G', '144']) expect(forms.split(',')).toContain(f);
    expect(forms).not.toMatch(/\/A/); // an amendment name in the list makes the search answer nothing
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].quote).toMatch(/Schedule 13D \(a stake of more than 5%/);
    expect(r.findings[0].match).not.toBe('confirmed'); // no report was read
  });
});

describe('design decision 1: the issuer\'s legal name is learned and searched', () => {
  test('a Form D naming the person as officer of "Ramp Business Corporation" teaches Ramp\'s legal name', async () => {
    declare();
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    fakeSec([
      [(u) => searchUrl(u) && param(u, 'q') === '"Eric Glyman"', searchAnswer([hit('0001800000-21-000001', 'primary_doc.xml', { names: ['Ramp Business Corp  (CIK 0001800000)'], xsl: 'xslFormDX01' })])],
      [searchUrl, searchAnswer([])],
      ['primary_doc.xml', formD('Ramp Business Corp', [['Eric', 'Glyman', 'Executive Officer']])],
    ]);
    const r = await runPerson(s, 'formd');
    expect(r.findings[0].match).not.toBe('possible');
    expect([...s.anchors.aliases.values()].map((a) => a.value)).toContain('Ramp Business Corp');

    // The company lookup now searches by the legal name, first.
    const calls = fakeSec([[searchUrl, searchAnswer([])]]);
    await runCompany(s, 'Ramp', 'formd');
    expect(calls.map((c) => param(c.url, 'entityName'))).toEqual(['Ramp Business Corp', 'Ramp']);
  });

  test('a notice found only by the bare word "Ramp" is not the company\'s unless it names the person', async () => {
    declare();
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000900-21-000001', 'primary_doc.xml', { names: ['Ramp Inc  (CIK 0000000900)'], xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Ramp Inc', [['Amy', 'Stone', 'Director']])],
    ]);
    expect((await runCompany(s, 'Ramp', 'formd')).findings).toEqual([]);
  });
});

describe('sec-first-page-only: past 100 documents, the weightier forms are searched apart', () => {
  test('a second search limited to annual reports, proxies and 13Ds', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const calls = fakeSec([
      [(u) => searchUrl(u) && !param(u, 'forms'), searchAnswer([hit('0000000800-20-000001', 's4.htm', { names: ['Spac Corp  (CIK 0000000800)'], form: 'S-4', date: '2020-03-01' })], 155)],
      [(u) => searchUrl(u) && param(u, 'forms'), searchAnswer([hit('0001731289-21-000005', 'nkla10k.htm', { names: [NIKOLA], form: '10-K', date: '2021-02-25' })])],
    ]);
    const r = await runPerson(s, 'all');
    expect(calls.filter((c) => searchUrl(c.url))).toHaveLength(2);
    expect(r.findings.some((f) => /Nikola/.test(f.title))).toBe(true);
  });
});
