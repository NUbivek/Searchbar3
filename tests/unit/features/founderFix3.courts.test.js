/**
 * Round-3 grading fixes in courts.js: a Gazette trading name must be the
 * company's whole name ("T/A Flow Creative" is not Flow), and criminal
 * dockets titled by surname alone are found in the district that charged
 * the subject, graded possible.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { ukGazetteConnector, courtRecordsOpenConnector, districtCodes, __resetCourtsForTests } = require('../../../src/server/founder/sources/courts');

const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ctxFor = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });

beforeEach(() => __resetCourtsForTests());
afterEach(() => setTransport());

describe('UK Gazette trading names', () => {
  const notice = (id, title, content) => ({ id: `https://www.thegazette.co.uk/id/notice/${id}`, 'f:notice-code': '2441', title, published: '2020-03-01T10:00:00', category: { '@term': 'Winding-up Orders' }, content: `<div><p>${content}</p></div>` });
  const gazette = (entries) => setTransport(async () => respond({ 'f:total': entries.length, entry: entries }));

  test('a longer trading name that starts with the company name is another business', async () => {
    gazette([
      notice(1, 'STUDIO 404 LIMITED', 'STUDIO 404 LIMITED (Company Number 1234567) Trading Name: T/A Flow Creative …'),
      notice(2, 'OTHER STUDIO LIMITED', 'OTHER STUDIO LIMITED Trading Name: Flow Creative Ltd Nature of Business: design'),
    ]);
    const out = await ukGazetteConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'Flow' })));
    expect(out.findings).toHaveLength(0);
  });

  test('the whole name is still found, before a comma, a legal form or the next field', async () => {
    gazette([
      notice(3, 'BHS LIMITED', 'BHS LIMITED Trading Name: BHS, British Home Stores Previous Name of Company: …'),
      notice(4, 'ACME HOLDINGS LIMITED', 'ACME HOLDINGS LIMITED Trading Name: T/A Flow …'),
      notice(5, 'ZED TRADING LIMITED', 'ZED TRADING LIMITED Previous Name of Company: Flow Ltd'),
    ]);
    const bhs = await ukGazetteConnector.run({ kind: 'company', value: 'British Home Stores' }, ctxFor(createSubject({ name: 'Dominic Chappell', company: 'British Home Stores' })));
    expect(bhs.findings.map((f) => f.data.noticeCode)).toHaveLength(1);
    expect(bhs.findings[0].title).toContain('BHS LIMITED');
    const flow = await ukGazetteConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'Flow' })));
    expect(flow.findings.map((f) => f.title).sort()).toEqual([expect.stringContaining('ACME HOLDINGS LIMITED'), expect.stringContaining('ZED TRADING LIMITED')]);
  });
});

describe('districtCodes', () => {
  test('reads district names, citations and office names', () => {
    expect(districtCodes('the U.S. Attorney for the Southern District of New York')).toEqual(['nysd']);
    expect(districtCodes('filed in S.D.N.Y. and later D.N.J.')).toEqual(['nysd', 'njd']);
    expect(districtCodes('N.D. Cal. and D. Mass.')).toEqual(['cand', 'mad']);
    expect(districtCodes('USAO - New York, Southern')).toEqual(['nysd']);
    expect(districtCodes('the District of Columbia; the Eastern District of Pennsylvania')).toEqual(['dcd', 'paed']);
    expect(districtCodes('Trevor D. Milton, Ph.D. Holder')).toEqual([]);
  });
});

describe('court-records-open: criminal dockets in the charging district', () => {
  const milton = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });
  const charge = {
    source: 'doj-press-releases', match: 'confirmed', date: '2021-07-29', severity: 'high',
    title: 'Former Nikola Corporation CEO Trevor Milton Charged in Securities Fraud Scheme',
    quote: 'Damian Williams, the United States Attorney for the Southern District of New York, announced the unsealing of an indictment charging Trevor Milton.',
  };
  const doc = (identifier, title, publicdate, court = identifier.split('.')[2]) => ({ identifier, title, court, publicdate });
  let urls;
  const archive = (surnameDocs) => {
    urls = [];
    setTransport(async (url) => {
      urls.push(decodeURIComponent(url));
      const docs = /court:/.test(decodeURIComponent(url)) ? surnameDocs : [];
      return respond({ response: { numFound: docs.length, docs } });
    });
  };

  test('a surname-only docket in the district and year of the charges is possible, never more', async () => {
    archive([
      doc('gov.uscourts.nysd.564175', 'United States v. Milton', '2021-07-30T09:01:04Z'),
      doc('gov.uscourts.nysd.400001', 'United States v. Milton', '2015-02-01T09:01:04Z'), // years before the charges
      doc('gov.uscourts.nysd.564176', 'United States v. Milton Chisum', '2021-08-01T09:01:04Z'), // Milton is the first name
      doc('gov.uscourts.nysd.564177', 'Milton v. United States', '2021-08-01T09:01:04Z'),
    ]);
    const out = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton(), [charge]));
    expect(urls.some((u) => /court:nysd/.test(u) && /United States v\. Milton/.test(u) && /USA v\. Milton/.test(u))).toBe(true);
    expect(out.findings).toHaveLength(1);
    const [f] = out.findings;
    expect(f.match).toBe('possible');
    expect(f.severity).toBe('high');
    expect(f.matchReasons[0]).toMatch(/criminal case in the district and year of the charges against Trevor Milton/);
    expect(f.data.court).toBe('US District Court, Southern District of New York');
  });

  test('without a confirmed charging record no surname search is made', async () => {
    archive([doc('gov.uscourts.nysd.564175', 'United States v. Milton', '2021-07-30T09:01:04Z')]);
    const possibleOnly = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton(), [{ ...charge, match: 'possible' }]));
    expect(possibleOnly.findings).toHaveLength(0);
    expect(urls).toHaveLength(1);
    const none = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, { subject: milton(), deadline: Date.now() + 20000, known: () => ({}) });
    expect(none.findings).toHaveLength(0);
  });

  test('a docket in another district is left out', async () => {
    archive([doc('gov.uscourts.azd.1', 'United States v. Milton', '2021-07-30T09:01:04Z', 'azd')]);
    const out = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton(), [charge]));
    expect(out.findings).toHaveLength(0);
  });
});
