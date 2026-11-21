/**
 * Round 3 ends (sources owner): SEC needs left by phase 2.
 *   needs-phase2 #54  a Form D finding carries the issuer's state of incorporation as data.jurisdiction
 *   needs-phase2 #24  the SEC filer number on a Wikidata entry tied to the person is looked up as an exact filer,
 *                     graded 'likely'
 *   alias             under another name only the enforcement lookups run
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

describe('Form D: the issuer\'s jurisdiction as a field', () => {
  test('the person\'s Form D finding carries data.jurisdiction', async () => {
    declare();
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    fakeSec([
      [searchUrl, searchAnswer([hit('0001731289-21-000078', 'primary_doc.xml', { names: [NIKOLA], xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Nikola Corp', [['Trevor', 'Milton', 'Executive Officer']])],
    ]);
    const r = await runPerson(s, 'formd');
    expect(r.findings[0].data.jurisdiction).toBe('DELAWARE');
    expect(r.findings[0].data.issuer).toBe('Nikola Corp');
  });

  test('the company\'s Form D finding carries data.jurisdiction', async () => {
    declare();
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    fakeSec([
      [searchUrl, searchAnswer([hit('0001731289-21-000078', 'primary_doc.xml', { names: [NIKOLA], xsl: 'xslFormDX01' })])],
      ['primary_doc.xml', formD('Nikola Corp', [['Trevor', 'Milton', 'Executive Officer']])],
    ]);
    const r = await runCompany(s, 'Nikola', 'formd');
    const withDoc = r.findings.filter((f) => f.data && f.data.form);
    expect(withDoc.length).toBeGreaterThan(0);
    expect(withDoc[0].data.jurisdiction).toBe('DELAWARE');
  });
});

describe('a filer number from the person\'s Wikidata entry', () => {
  const wikiFinding = (match = 'likely', cik = '0001808962') => ({ id: 'wikidata-1', source: 'wikidata', category: 'identity', match, data: { secCik: cik } });
  const ctxWith = (s, findings) => ({ ...ctx(s), findings: () => findings });

  test('is searched as an exact filer even when the name lookup finds nobody, and graded likely', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const calls = fakeSec([
      [(u) => searchUrl(u) && param(u, 'keysTyped'), JSON.stringify({ hits: { hits: [] } })],
      [(u) => searchUrl(u) && param(u, 'ciks'), searchAnswer([
        hit('0001140361-22-000001', 'sc13d.htm', { names: ['Milton Trevor R.  (CIK 0001808962)', NIKOLA], form: 'SC 13D', date: '2022-01-05' }),
      ])],
    ]);
    const r = await secPersonConnector.run({ kind: 'subject', value: s.name, template: 'insider', depth: 0 }, ctxWith(s, [wikiFinding()]));
    expect(param(calls.find((c) => param(c.url, 'ciks')).url, 'ciks')).toBe('0001808962');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('likely');
    expect(r.findings[0].matchReasons.join(' ')).toMatch(/Wikidata/);
  });

  test('a name-only Wikidata entry, or another source, gives no filer number', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const calls = fakeSec([[(u) => searchUrl(u) && param(u, 'keysTyped'), JSON.stringify({ hits: { hits: [] } })]]);
    const r = await secPersonConnector.run({ kind: 'subject', value: s.name, template: 'insider', depth: 0 },
      ctxWith(s, [wikiFinding('possible'), { ...wikiFinding(), source: 'web-search' }, { ...wikiFinding(), data: { secCik: '12' } }]));
    expect(r.findings).toEqual([]);
    expect(calls.filter((c) => param(c.url, 'ciks'))).toEqual([]);
  });
});

describe('another name of the person', () => {
  test('plans only the enforcement lookups, and runs nothing else under it', async () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Nikola', otherNames: ['Trevor Smith'] });
    const plans = secPersonConnector.plan({ kind: 'alias', value: 'Trevor Smith' }, s).map((p) => p.template);
    expect(plans.sort()).toEqual(['enforcement', 'press']);
    const calls = fakeSec([]);
    const r = await secPersonConnector.run({ kind: 'alias', value: 'Trevor Smith', template: 'formd', depth: 1 }, ctx(s));
    expect(r.findings).toEqual([]);
    expect(calls).toEqual([]);
  });
});
