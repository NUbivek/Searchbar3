/**
 * Round-4 grading fix in courts.js: an archived criminal docket that names the
 * subject in full, in the district of a confirmed charge record and copied to
 * the archive within a week after it, is likely theirs (never confirmed) and
 * carries the case number read from the charge record. A surname-only docket
 * stays possible and gets no case number.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { courtRecordsOpenConnector, dojConnector, caseNumberIn, __resetCourtsForTests } = require('../../../src/server/founder/sources/courts');

const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ctxFor = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });

beforeEach(() => __resetCourtsForTests());
afterEach(() => setTransport());

describe('caseNumberIn', () => {
  test('reads one case number in its common forms', () => {
    expect(caseNumberIn('United States v. Milton, No. 1:21-cr-00478 (S.D.N.Y.)')).toBe('21-cr-478');
    expect(caseNumberIn('The case is 21-cr-478.')).toBe('21-cr-478');
    expect(caseNumberIn('The case is United States v. Milton, 21 Cr. 478.')).toBe('21-cr-478');
  });
  test('gives nothing when there is none or several', () => {
    expect(caseNumberIn('Release number 23-411')).toBe('');
    expect(caseNumberIn('cases 21-cr-478 and 22-cr-100')).toBe('');
  });
});

describe('court-records-open: a full-name docket tied to a confirmed charge', () => {
  const milton = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });
  const charge = {
    source: 'doj-press-releases', match: 'confirmed', date: '2021-07-29', severity: 'high',
    title: 'Former Nikola Corporation CEO Trevor Milton Charged in Securities Fraud Scheme',
    quote: 'Damian Williams, the United States Attorney for the Southern District of New York, announced the unsealing of an indictment (21 Cr. 478) charging Trevor Milton.',
  };
  const doc = (identifier, title, publicdate, extra = {}) => ({ identifier, title, court: identifier.split('.')[2], publicdate, ...extra });
  const archive = (nameDocs, surnameDocs = []) => setTransport(async (url) => {
    const docs = /court:/.test(decodeURIComponent(url)) ? surnameDocs : nameDocs;
    return respond({ response: { numFound: docs.length, docs } });
  });
  const run = (findings) => courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton(), findings));

  test('in the charging district within a week after the charge: likely, with the case number', async () => {
    archive([doc('gov.uscourts.nysd.9', 'United States v. Trevor Milton', '2021-07-30T09:01:04Z', { source_url: 'https://www.courtlistener.com/docket/60094811/10/united-states-v-milton/' })]);
    const out = await run([charge]);
    expect(out.findings).toHaveLength(1);
    const [f] = out.findings;
    expect(f.match).toBe('likely');
    expect(f.matchReasons[0]).toBe(`filed in the US District Court, Southern District of New York within 1 day of the charge in "${charge.title}"`);
    expect(f.data.caseNumber).toBe('21-cr-478');
    expect(f.title).toContain('federal court docket 21-cr-478');
    expect(f.url).toBe('https://www.courtlistener.com/docket/60094811/united-states-v-milton/');
  });

  test('outside the week, in another district or without a confirmed charge: not raised, no case number', async () => {
    const cases = [
      [[doc('gov.uscourts.nysd.9', 'United States v. Trevor Milton', '2021-09-30T09:01:04Z')], [charge]],
      [[doc('gov.uscourts.nysd.9', 'United States v. Trevor Milton', '2021-07-20T09:01:04Z')], [charge]], // before the charge
      [[doc('gov.uscourts.azd.9', 'United States v. Trevor Milton', '2021-07-30T09:01:04Z')], [charge]],
      [[doc('gov.uscourts.nysd.9', 'United States v. Trevor Milton', '2021-07-30T09:01:04Z')], [{ ...charge, match: 'possible' }]],
    ];
    for (const [docs, findings] of cases) {
      archive(docs);
      const out = await run(findings);
      for (const f of out.findings) {
        expect(f.matchReasons.join(' ')).not.toMatch(/of the charge in/);
        expect(f.data.caseNumber).toBeNull();
      }
    }
  });

  test('a surname-only docket stays possible and gets no case number', async () => {
    archive([], [doc('gov.uscourts.nysd.564175', 'United States v. Milton', '2021-07-30T09:01:04Z')]);
    const out = await run([charge]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].data.caseNumber).toBeNull();
  });

  test('a longer name is not the subject', async () => {
    archive([doc('gov.uscourts.nysd.9', 'United States v. Trevor Milton Lund', '2021-07-30T09:01:04Z')]);
    const out = await run([charge]);
    expect(out.findings.every((f) => f.match !== 'likely' && f.match !== 'confirmed')).toBe(true);
  });
});

test('a Justice Department release keeps the one case number it gives', async () => {
  setTransport(async () => respond({ metadata: { resultset: { count: 1 } }, results: [{
    title: 'Nikola Founder Trevor Milton Sentenced to Four Years for Securities Fraud', date: '1703116800',
    url: 'https://www.justice.gov/usao-sdny/pr/x', teaser: 'Trevor Milton, the founder of Nikola Corporation, was sentenced today.',
    body: 'The case is United States v. Milton, 21 Cr. 478.', number: '23-411', component: [{ name: 'USAO - New York, Southern' }],
  }] }));
  const out = await dojConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'title.name' }, ctxFor(createSubject({ name: 'Trevor Milton', company: 'Nikola' })));
  expect(out.findings[0].data.caseNumber).toBe('21-cr-478');
});
