/**
 * Round 4 fixes for src/server/founder/sources/sec.js (review 2026-11-21, by-owner/sources-official.json):
 *   sources-official-sec-nickname-prefix     a longer first name (Paula for Paul, Erica for Eric) is another person;
 *                                            a real diminutive (Samuel for Sam) is held below confirmed
 *   sources-official-sec-half-failed-no-partial  half an enforcement or event lookup failing marks it partial
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { secPersonConnector, secCompanyConnector, __resetSecForTests } = require('../../../src/server/founder/sources/sec');

const page = (body) => `<html><body><main>${body}</main></body></html>`;
const searchUrl = (url) => url.startsWith('https://efts.sec.gov/LATEST/search-index');
const searchAnswer = (hits, total = hits.length) => JSON.stringify({ hits: { total: { value: total, relation: 'eq' }, hits } });
function hit(adsh, file, { names, form = 'D', date = '2021-06-17' } = {}) {
  const ciks = names.map((n) => (n.match(/CIK (\d+)/) || [])[1]).filter(Boolean);
  return { _index: 'edgar_file', _id: `${adsh}:${file}`, _source: { ciks, display_names: names, root_forms: [form], form, file_type: form, file_date: date, items: [], adsh, xsl: 'xslFormDX01' } };
}
const formD = (issuer, persons, signer = ['Kim Brady', 'CFO']) => `<?xml version="1.0"?><edgarSubmission><primaryIssuer><entityName>${issuer}</entityName><jurisdictionOfInc>DELAWARE</jurisdictionOfInc><entityType>Corporation</entityType></primaryIssuer>
<relatedPersonsList>${persons.map(([f, l, r, c = '']) => `<relatedPersonInfo><relatedPersonName><firstName>${f}</firstName><middleName></middleName><lastName>${l}</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>${r}</relationship></relatedPersonRelationshipList><relationshipClarification>${c}</relationshipClarification></relatedPersonInfo>`).join('')}</relatedPersonsList>
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
const ctx = (s) => ({ subject: s, deadline: Date.now() + 20000, known: () => ({}) });
const runPerson = (s, template) => secPersonConnector.run({ kind: 'subject', value: s.name, template, depth: 0 }, ctx(s));
const runCompany = (s, value, template) => secCompanyConnector.run({ kind: 'company', value, template, depth: 1 }, ctx(s));
const EMPTY_PRESS = '<table class="views-table"><tbody><tr class="odd"><td colspan="3" class="views-empty"><p>No results.</p></td></tr></tbody></table>';
const pressList = (rows) => `<table class="views-table"><tbody>${rows.map(([n, title]) => `<tr><td><time datetime="2023-03-01T11:00:00Z">Mar. 1, 2023</time></td><td class="views-field"><a href="/newsroom/press-releases/${n}">${title}</a></td><td class="views-field views-field-field-release-number">${n} </td></tr>`).join('')}</tbody></table>`;
const releaseList = (rows) => `<table class="views-table"><tbody>${rows.map(([n, who]) => `<tr><td><time datetime="2024-01-01T00:00:00Z">Jan. 1, 2024</time></td><td><div class='release-view__respondents'><a href='/enforcement-litigation/litigation-releases/${n}'>${who}</a></div></td></tr>`).join('')}</tbody></table><div>Displaying 1 to ${rows.length} of ${rows.length} items</div>`;
const EMPTY_RELEASES = '<div class="view-empty"><p class="no-results-text">No results found.</p></div>';

beforeEach(() => { __resetSecForTests(); process.env.SEC_USER_AGENT = 'Test Runner test@example.com'; });
afterEach(() => { setTransport(); delete process.env.SEC_USER_AGENT; });

describe('sources-official-sec-nickname-prefix: a longer first name is another person', () => {
  test.each([['Paul', 'Paula'], ['Eric', 'Erica'], ['Dan', 'Daniela']])('press: a release about %s\'s relative %s is not theirs', async (given, other) => {
    const s = createSubject({ name: `${given} Lowell`, company: 'Lowell Robotics' });
    fakeSec([
      [(u) => u.includes(`combine=${given}`), pressList([['2023-41', `SEC Charges ${other} Lowell, CEO of Lowell Robotics`]])],
      [(u) => u.includes('combine=Lowell'), pressList([['2023-41', `SEC Charges ${other} Lowell, CEO of Lowell Robotics`]])],
      ['press-releases/2023-41', page(`<p>For Immediate Release 2023-41</p><p>The Commission today charged ${other} Lowell, the CEO of Lowell Robotics Inc., with fraud.</p><p>Last Reviewed or Updated</p>`)],
    ]);
    const r = await runPerson(s, 'press');
    expect(r.findings.filter((f) => f.match !== 'possible')).toEqual([]);
  });

  test('formd: a notice listing Paula Lowell as CEO is not tied to Paul Lowell, and no CEO role is learned', async () => {
    const s = createSubject({ name: 'Paul Lowell', company: 'Lowell Robotics' });
    // The full-text search matches a phrase: "Paul Lowell" finds nothing, the surname and the company find the notice.
    fakeSec([
      [(u) => searchUrl(u) && /Paul Lowell/.test(new URL(u).searchParams.get('q') || ''), searchAnswer([])],
      [searchUrl, searchAnswer([hit('0000000777-21-000001', 'primary_doc.xml', { names: ['Lowell Robotics Inc  (CIK 0000000777)'] })])],
      ['primary_doc.xml', formD('Lowell Robotics Inc', [['Paula', 'Lowell', 'Executive Officer', 'Chief Executive Officer']], ['Paula Lowell', 'CEO'])],
    ]);
    const r = await runPerson(s, 'formd');
    expect(r.findings.filter((f) => f.match === 'confirmed' || f.match === 'likely')).toEqual([]);
    expect([...(s.anchors.roles?.values?.() || [])]).toEqual([]);
    const c = await runCompany(s, 'Lowell Robotics', 'formd');
    expect(c.findings.filter((f) => f.match === 'confirmed' || f.match === 'likely')).toEqual([]);
    expect(c.findings.every((f) => !/names Paul Lowell/.test(f.title))).toBe(true);
    expect([...(s.anchors.roles?.values?.() || [])]).toEqual([]);
  });

  test('formd: a real diminutive (Samuel for Sam) on a known company\'s notice is held at likely, no role learned', async () => {
    const s = createSubject({ name: 'Sam Lowell', company: 'Lowell Robotics' });
    fakeSec([
      [searchUrl, searchAnswer([hit('0000000777-21-000001', 'primary_doc.xml', { names: ['Lowell Robotics Inc  (CIK 0000000777)'] })])],
      ['primary_doc.xml', formD('Lowell Robotics Inc', [['Samuel', 'Lowell', 'Executive Officer', 'Chief Executive Officer']], ['Samuel Lowell', 'CEO'])],
    ]);
    const r = await runPerson(s, 'formd');
    const f = r.findings.find((x) => /Samuel Lowell/.test(x.title));
    expect(f).toBeTruthy();
    expect(f.match).toBe('likely');
    expect([...(s.anchors.roles?.values?.() || [])]).toEqual([]);
  });

  test('enforcement: a complaint against Paula Lowell is not added for Paul Lowell; a diminutive stays possible', async () => {
    const s = createSubject({ name: 'Paul Lowell', company: 'Lowell Robotics' });
    fakeSec([
      ['litigation-releases?populate=Lowell', releaseList([['lr-1', 'Paula Lowell']])],
      ['administrative-proceedings?populate=Lowell', EMPTY_RELEASES],
      ['litigation-releases/lr-1', page('<p>Litigation Release No. 1 / January 1, 2024</p><p>Securities and Exchange Commission v. Paula Lowell, No. 1:23-cv-00001 (S.D.N.Y. filed Dec. 1, 2023)</p><p>The SEC charged Paula Lowell, CEO of Lowell Robotics, with fraud.</p>')],
    ]);
    expect((await runPerson(s, 'enforcement')).findings).toEqual([]);

    __resetSecForTests();
    const sam = createSubject({ name: 'Sam Lowell', company: 'Lowell Robotics' });
    fakeSec([
      ['litigation-releases?populate=Lowell', releaseList([['lr-2', 'Samuel Lowell']])],
      ['administrative-proceedings?populate=Lowell', EMPTY_RELEASES],
      ['litigation-releases/lr-2', page('<p>Litigation Release No. 2 / January 1, 2024</p><p>Securities and Exchange Commission v. Samuel Lowell, No. 1:23-cv-00002 (S.D.N.Y. filed Dec. 1, 2023)</p><p>The SEC charged Samuel Lowell, CEO of Lowell Robotics, with fraud.</p>')],
    ]);
    const r = await runPerson(sam, 'enforcement');
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((f) => f.match === 'possible')).toBe(true);
  });
});

describe('sources-official-sec-half-failed-no-partial', () => {
  test('administrative proceedings failing while litigation releases answer marks the lookup partial', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    fakeSec([
      ['litigation-releases?populate=Roe', EMPTY_RELEASES],
      ['administrative-proceedings?populate=Roe', 'down', 500],
    ]);
    const r = await runPerson(s, 'enforcement');
    expect(r.findings).toEqual([]);
    expect(r.partial).toEqual(['SEC administrative proceedings (did not answer)']);
  });

  test('litigation releases failing marks the lookup partial too', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    fakeSec([
      ['litigation-releases?populate=Roe', 'down', 500],
      ['administrative-proceedings?populate=Roe', EMPTY_RELEASES],
    ]);
    const r = await runPerson(s, 'enforcement');
    expect(r.partial).toEqual(['SEC litigation releases (did not answer)']);
  });

  test('company events: a failed trading-suspension search marks the lookup partial', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    fakeSec([
      [searchUrl, searchAnswer([])],
      [(u) => u.includes('trading-suspensions'), 'down', 500],
    ]);
    const r = await runCompany(s, 'Acme Rockets', 'events');
    expect(r.partial || []).toContain('SEC trading suspensions (did not answer)');
  });
});
