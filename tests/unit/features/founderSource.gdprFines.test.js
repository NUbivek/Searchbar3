/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addCompanyAlias } = require('../../../src/server/founder/identity');
const G = require('../../../src/server/founder/sources/gdprFines');

const { gdprFinesConnector, parseTracker, partiesOf, isPrivateParty, ATTRIBUTION, LICENCE, COVERAGE_NOTE, MIN_CASES } = G;

/* ------------------------------------------------------------------ */
/* Fixture in the shape enforcementtracker.com served on 20 Nov 2026   */
/* (invented companies; filler cases to reach the size of the list)    */
/* ------------------------------------------------------------------ */

const flag = (c) => `/flags/flag_${c.toLowerCase()}.png`;
const row = (e, o) => ({ e, c: 'THE NETHERLANDS', C: 'The Netherlands', F: flag('the%20netherlands'), a: 'Dutch Supervisory Authority for Data Protection (AP)', d: '2024-07-22', f: 50000, p: 'Filler', s: 'Industry and Commerce', r: 'Art. 5 GDPR', t: 'Insufficient legal basis for data processing', ...o });
const CASES = [
  row(1, { p: 'Zentrovia Health B.V.', f: 2500000, d: '2025-03-14', s: 'Health Care', r: 'Art. 32 GDPR', t: 'Insufficient technical and organisational measures to ensure information security' }),
  row(2, { p: 'Zentrovia Health B.V.\nKlarwerk GmbH', f: 40000, d: '2021', c: 'GERMANY', C: 'Germany', a: 'Data Protection Authority of Berlin' }),
  row(3, { p: 'Ridewell Technologies Inc., Ridewell B.V.', f: 290000000, d: '2024-07-22', s: 'Employment', r: 'Art. 44 GDPR', t: 'Non-compliance with general data processing principles' }),
  row(4, { p: 'Ridewell B.V.', f: 600000, d: '2022-01-10' }),
  // an ordinary-word company name, shared by unrelated firms
  row(5, { p: 'Merge S.L.', f: 3000, d: '2023-05-02', c: 'SPAIN', C: 'Spain', a: 'Spanish Data Protection Authority (aepd)' }),
  row(6, { p: 'Merge Financial Group Ltd', f: 9000, d: '2022-05-02' }),
  // a legal form cut off by a line break
  row(7, { p: 'FACTOR ZENTROVIA,\r\nS.A.', f: 70000, d: 'Unknown' }),
  // fines against private individuals: never read, never stored
  row(8, { p: 'Private individual', s: 'Individuals and Private Associations', f: 300 }),
  row(9, { p: 'Physician', s: 'Health Care', f: 1500 }),
  row(10, { p: 'Zentrovia Health shop owner', s: 'Industry and Commerce', f: 200 }),
  row(11, { p: 'Unknown', f: null, d: 'Unknown', s: 'Not assigned' }),
  ...Array.from({ length: MIN_CASES }, (_, i) => row(1000 + i, { p: `Filler Company ${i} S.A.` })),
];
const page = (cases) => `<!doctype html><html><head><title>Enforcement Tracker</title></head><body><div id="app"></div>
<script type="application/json" id="et-cases" data-purpose="filter-bootstrap">${JSON.stringify(cases)}</script>
<script src="/js/app.js"></script></body></html>`;
const PAGE = page(CASES);

/* ------------------------------------------------------------------ */
/* Fake network                                                        */
/* ------------------------------------------------------------------ */

let calls = [];
function serve(body, status = 200) {
  setTransport(async (url, init) => {
    calls.push({ url, init });
    return { status, headers: { get: () => null }, url, text: async () => body };
  });
}

beforeEach(() => { __resetCacheForTests(); calls = []; });
afterEach(() => setTransport());

const ctxFor = (name, company) => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000 });
const companyTask = (value) => ({ kind: 'company', value, template: 'gdpr.fines', depth: 0 });

/* ------------------------------------------------------------------ */

describe('reading the tracker', () => {
  test('the embedded list becomes a compact index without private individuals', () => {
    const index = parseTracker(PAGE);
    expect(index.cases).toBe(CASES.length);
    const r = index.rows.find((x) => x.e === 3);
    expect(r).toMatchObject({ k: 'The Netherlands', a: 'Dutch Supervisory Authority for Data Protection (AP)', d: '2024-07-22', f: 290000000, r: 'Art. 44 GDPR' });
    expect(index.rows.find((x) => x.e === 11).d).toBe('');
    expect(index.rows.find((x) => x.e === 11).f).toBeUndefined();
    for (const e of [8, 9, 10]) expect(index.rows.find((x) => x.e === e)).toBeUndefined();
    expect(JSON.stringify(index)).not.toMatch(/Private individual|Physician|flags\//);
  });

  test('a missing block, an unreadable block, a short list or a changed shape is an error, never an empty list', () => {
    expect(() => parseTracker('<html><body>Maintenance</body></html>')).toThrow(/changed format/);
    expect(() => parseTracker('<script type="application/json" id="et-cases">[{"e":1,</script>')).toThrow(/could not be read/);
    expect(() => parseTracker(page(CASES.slice(0, 20)))).toThrow(/too few/);
    expect(() => parseTracker(page(CASES.map((c) => ({ id: c.e, name: c.p }))))).toThrow(/expected format/);
  });

  test('parties are split on new lines and commas, and a legal form stays with its name', () => {
    expect(partiesOf('Ridewell Technologies Inc., Ridewell B.V.')).toEqual(['Ridewell Technologies Inc., Ridewell B.V.', 'Ridewell Technologies Inc.', 'Ridewell B.V.']);
    expect(partiesOf('FACTOR ZENTROVIA,\r\nS.A.')).toEqual(['FACTOR ZENTROVIA, S.A.']);
    expect(partiesOf('KLARWERK ESPAÑA, S.A.U.')).toEqual(['KLARWERK ESPAÑA, S.A.U.']);
    expect(partiesOf('Zentrovia Health B.V.\nKlarwerk GmbH')).toEqual(['Zentrovia Health B.V. Klarwerk GmbH', 'Zentrovia Health B.V.', 'Klarwerk GmbH']);
  });

  test('private individuals are told apart from businesses', () => {
    expect(isPrivateParty('Private individual')).toBe(true);
    expect(isPrivateParty('Former mayor of a community')).toBe(true);
    expect(isPrivateParty('Police officer')).toBe(true);
    expect(isPrivateParty('Kebab restaurant', 'Individuals and Private Associations')).toBe(true);
    expect(isPrivateParty('BNP Personal Finance S.A.')).toBe(false);
    expect(isPrivateParty('Attorney')).toBe(true);
    expect(isPrivateParty('Ackermann Attorneys S.L.')).toBe(false);
    expect(isPrivateParty('Private person (YouTube-Channel)')).toBe(true);
    expect(isPrivateParty('Zentrovia Health B.V.')).toBe(false);
  });
});

describe('screening a company', () => {
  test('a distinctive company name: its fines are the company\'s, newest first, with attribution and the case link', async () => {
    serve(PAGE);
    const r = await gdprFinesConnector.run(companyTask('Zentrovia Health'), ctxFor('Jana Testova', 'Zentrovia Health'));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://www.enforcementtracker.com/');
    const top = r.findings[0];
    expect(top).toMatchObject({ source: 'gdpr-fines', match: 'company', severity: 'high', url: 'https://www.enforcementtracker.com/ETid-1', date: '2025-03-14', category: 'regulatory' });
    expect(top.title).toMatch(/Zentrovia Health B\.V\.: fined EUR 2,500,000 by the Dutch Supervisory Authority/);
    expect(top.quote).toMatch(/Articles breached: Art\. 32 GDPR/);
    expect(top.quote).toContain(ATTRIBUTION);
    expect(top.data).toMatchObject({ caseId: 'ETid-1', fineEur: 2500000, attribution: ATTRIBUTION, licence: LICENCE, country: 'The Netherlands' });
    expect(gdprFinesConnector.label).toContain(ATTRIBUTION);
    const joint = r.findings.find((f) => f.data.caseId === 'ETid-2');
    expect(joint.severity).toBe('medium');
    expect(joint.quote).toMatch(/Fined: Zentrovia Health B\.V\.; Klarwerk GmbH/);
    // the shop owner (a private person) was dropped from the list and never matched
    expect(r.findings.map((f) => f.data.caseId)).not.toContain('ETid-10');
    for (const f of r.findings) expect(['company', 'possible']).toContain(f.match);
    expect(r.notes).toContain(COVERAGE_NOTE);
    expect(r.partial).toBeUndefined();
  });

  test('no match says what was searched, and the list is read once a day', async () => {
    serve(PAGE);
    const ctx = ctxFor('Trevor Milton', 'Nikola');
    const r = await gdprFinesConnector.run(companyTask('Nikola'), ctx);
    expect(r.findings).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/searched the CMS Enforcement Tracker for Nikola and found no fine against it \(list as of \d{4}-\d{2}-\d{2}\)/);
    await gdprFinesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(calls).toHaveLength(1);
  });

  test('an ordinary-word company name is a name match to verify, never the company', async () => {
    serve(PAGE);
    const r = await gdprFinesConnector.run(companyTask('Merge'), ctxFor('Jana Testova', 'Merge'));
    const exact = r.findings.find((f) => f.data.caseId === 'ETid-5');
    expect(exact.match).toBe('possible');
    expect(exact.title).toMatch(/name match only, verify it is the same company/);
    expect(exact.data.excludeFromTimeline).toBe(true);
    const padded = r.findings.find((f) => f.data.caseId === 'ETid-6');
    expect(padded.match).toBe('possible');
    expect(r.notes.join(' ')).toMatch(/nothing in them shows it is this company/);
  });

  test('every known name: a learned legal name ties the case that carries it whole; the bare brand stays possible', async () => {
    serve(PAGE);
    const ctx = ctxFor('Jana Testova', 'Uber');
    // Ridewell is not an ordinary word; use "Uber" (an ordinary word to the matcher) with its legal name learned
    const cases = CASES.map((c) => ({ ...c, p: c.p.replace(/Ridewell/g, 'Uber') }));
    serve(page(cases));
    addCompanyAlias(ctx.subject, { company: 'Uber', alias: 'Uber Technologies, Inc.', origin: 'sec-filings-1' });
    const r = await gdprFinesConnector.run(companyTask('Uber'), ctx);
    const big = r.findings.find((f) => f.data.caseId === 'ETid-3');
    expect(big).toMatchObject({ match: 'company', severity: 'high' });
    expect(big.data.fined).toBe('Uber Technologies Inc.');
    expect(big.title).not.toMatch(/verify/);
    const bare = r.findings.find((f) => f.data.caseId === 'ETid-4');
    expect(bare.match).toBe('possible');
  });

  test('never above company; never a person; the person\'s own name is never screened', async () => {
    serve(PAGE);
    expect(gdprFinesConnector.kinds).toEqual(['company']);
    const own = await gdprFinesConnector.run(companyTask('Elizabeth Holmes'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(own.findings).toEqual([]);
    expect(own.notes[0]).toMatch(/person's own name/);
    const person = await gdprFinesConnector.run({ kind: 'subject', value: 'Elizabeth Holmes' }, ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(person.findings).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('a name too short to screen is partial, not a clean result', async () => {
    serve(PAGE);
    const r = await gdprFinesConnector.run(companyTask('AI'), ctxFor('Jana Testova', 'AI'));
    expect(r.findings).toEqual([]);
    expect(r.partial).toHaveLength(1);
    expect(r.notes[0]).toMatch(/too short or too general/);
  });

  test('a page that fails or changed is a failed lookup, never "no match"', async () => {
    serve('server error', 500);
    await expect(gdprFinesConnector.run(companyTask('Zentrovia Health'), ctxFor('Jana Testova', 'Zentrovia Health'))).rejects.toThrow();
    __resetCacheForTests();
    serve('<html><body>New design</body></html>');
    await expect(gdprFinesConnector.run(companyTask('Zentrovia Health'), ctxFor('Jana Testova', 'Zentrovia Health'))).rejects.toThrow(/changed format/);
  });

  test('plan and contract fields', () => {
    const plans = gdprFinesConnector.plan({ kind: 'company', value: 'Theranos' });
    expect(plans).toEqual([expect.objectContaining({ template: 'gdpr.fines' })]);
    expect(gdprFinesConnector.label).not.toMatch(/\b(api|endpoint|api key|token|free|paid|tier|env)\b/i);
    expect(gdprFinesConnector.enabled()).toBe(true);
  });
});
