/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const D = require('../../../src/server/founder/sources/debarment');

const {
  parseEbrd, parseFrb, parseNcua, parseFincen, personNameForms, firmNameForms, splitInstitutions, fincenParties, screenRows,
  mdbDebarmentConnector, usBankRegulatorsConnector, fincenActionsConnector, EBRD_PAGE, MDB_NOTE, OCC_NOTE,
} = D;

/* ------------------------------------------------------------------ */
/* Fixtures in the shapes the sources served on 20 Nov 2026            */
/* ------------------------------------------------------------------ */

// The EBRD file: first and last fields quoted, the rest written ", value"; one name spills over a comma.
const EBRD_HEADER = 'Name Of Entity, Name (special charcters), Notice type, Nationality, Reason for debarment, Grounds, Jurisdiction of judgement, Start date, End date, Notice effective at EBRD, Address';
const ebrdFiller = Array.from({ length: 60 }, (_, i) => `"Filler Construction ${i} LLC", , Firm, Kenya, Fraudulent Practice, Cross-debarment from World Bank Group, , 01-01-2024, 31-12-2027, 01-02-2024,"1 Road ${i} Nairobi Kenya"`);
const EBRD = [
  EBRD_HEADER,
  '"Ademhan, Abdulhamit", , Individual, Turkiye, Fraudulent Practice, Cross-debarment from Asian Development Bank, , 06-08-2021, Ongoing (debarment with conditional release), 22-09-2025,"Secret Street 9 Ankara Turkiye"',
  '"Agustín Olivares Garrigós", , Individual, Spain, Collusive Practice   Corrupt Practice, Cross-debarment from Inter-American Development Bank Group, , 23-12-2020, 22-12-2029, 28-04-2021,"Calle Falsa 1 Madrid"',
  '"EGIS WATER AND MARITIME\n(but only for its business operations in the Water and Sanitation Sector)", , Firm, France, Corrupt Practice   Fraudulent Practice, Cross-debarment from Inter-American Development Bank Group, , 05-09-2024, 02-01-2027, 11-10-2024,"15 avenue du centre 78280 Guyancourt France"',
  '"MetaFlow Inc.", (formerly known as CompuAids Inc. (doing business as (dba) Groupe Systemes, also dba Enterprise Systems and Solutions)), Firm, Canada, Affiliate of Debarred Entity, Cross-debarment from World Bank Group, , 31-03-2014, Ongoing (debarment with conditional release), 16-04-2026,"201-290 Picton Avenue, Ottawa, Ontario, Canada"',
  ...ebrdFiller,
].join('\n') + '\n';

// The Federal Reserve files start with a byte order mark.
const FRB_RECENT = '﻿' + JSON.stringify({ eaitems: [
  { id: '48994', edt: '2026-11-16', tdt: '1950-01-01', type: 'Cease and Desist Order, Civil Money Penalty', person: 'Rush F. Harding III', porg: 'First Security Bancorp, Searcy, Arkansas', url: '/newsevents/pressreleases/enforcement20261119a.htm', urlname: 'Press Release' },
  { id: '48881', edt: '2026-11-09', tdt: '1950-01-01', type: 'Prohibition from Banking', person: 'Katilyn M. Robinson', porg: 'United Community Bank, Greenville, South Carolina', url: 'https://www.federalreserve.gov/newsevents/pressreleases/enforcement20261112a.htm', urlname: 'Press Release' },
  { id: '47000', edt: '2024-06-14', tdt: '1950-01-01', type: 'Cease and Desist Order', bkorg: 'Evolve Bancorp, Inc., West Memphis, Arkansas and Evolve Bank &amp; Trust, West Memphis, Arkansas', url: '/newsevents/pressreleases/enforcement20240614a.htm', urlname: 'Press Release' },
  // The recent file must carry a fair number of recent actions to be accepted (round 3: watchlists-frb-recent-empty)
  ...Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, edt: new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 10), tdt: '1950-01-01', type: 'Written Agreement', bkorg: `Recent Filler Bank ${i}, Town, Ohio`, url: `/recent${i}.htm` })),
  { updateDate: '2026-11-19' },
] });
const FRB_OLD = '﻿' + JSON.stringify({ eaitems: [
  { id: 2518, edt: '2005-06-28', tdt: '1950-01-01', person: 'Matthew T. Stromgren', porg: 'J.P. Morgan Chase & Co., New York, NY', type: 'Cease and Desist Order', url: '/boarddocs/press/enforcement/2005/20050628/default.htm', urlname: 'Press Release' },
  { id: 2400, edt: '2020-10-21', tdt: '1950-01-01', person: "Ng Chong Hwa, also known as 'Roger Ng'", porg: 'Goldman Sachs Group, Inc., New York, New York', type: 'Prohibition from Banking', url: '/newsevents/pressreleases/enforcement20201022a.htm' },
  { id: 2300, edt: '2012-01-05', tdt: '1950-01-01', person: 'Albert C. Kelly, Jr', porg: 'SpiritBank, Bristow, Oklahoma', type: 'Prohibition from Banking', url: '/newsevents/pressreleases/enforcement20120105a.htm' },
  ...Array.from({ length: 520 }, (_, i) => ({ id: i, edt: '2010-01-01', tdt: '2012-01-01', bkorg: `Filler Bank ${i}, Town, Ohio`, type: 'Written Agreement', url: `/x${i}.htm` })),
] });

// One OCC search answer (the Wells Fargo dockets, as served for "John Stumpf")
const occRow = (o) => ({
  Amount: 0, BankName: 'Wells Fargo Bank, National Association', CharterNumber: 1, CityName: 'Sioux Falls', CompanyName: '', DocketNumber: 'AA-EC-2019-83', DocumentNumber: '2020-004', HasPdf: true,
  EnforcementInstIAPType: 'Individual', EnforcementTypeCode: 'PROH', EnforcementTypeDescription: 'Prohibition/Removal Orders', FirstName: 'John', LastName: 'Stumpf', StateAbbreviation: 'SD', StateName: 'SOUTH DAKOTA',
  SubjectMatterAssociations: 'Breach of Fiduciary Duty|Sales Practices', CompleteDate: '2020-01-22T00:00:00-05:00', TerminationDate: null, ...o,
});
const OCC_STUMPF = [
  occRow({}),
  occRow({ EnforcementTypeDescription: 'Civil Money Penalty (CMP)', Amount: 17500000 }),
  occRow({ DocketNumber: 'AA-EC-2019-82', DocumentNumber: 'N20-001', FirstName: 'Carrie', LastName: 'Tolstedt', EnforcementTypeDescription: 'Notice of Charges' }),
];
const OCC_BANK = [
  occRow({ EnforcementInstIAPType: 'Institution', FirstName: ' ', LastName: ' ', BankName: 'Blue Ridge Bank, National Association', DocketNumber: 'AA-ENF-2023-68', DocumentNumber: '2024-004', EnforcementTypeDescription: 'Cease-and-Desist Order (C&D) or Personal Cease-and-Desist Order (PC&D)', CompleteDate: '2024-01-24T00:00:00-05:00' }),
];

const NCUA_HEADER = '"Docket Number","Year","First Name","Last Name","Institution","Relationship","City","State","URL"';
const NCUA = [
  NCUA_HEADER,
  '"26-0041-WR","2026","Aneicia","Ford","Boeing Employees Credit Union","Former employee","Tukwila","WA","https://ncua.gov/news/enforcement-actions/administrative-orders/2026/administrative-order-matter-aneicia-ford"',
  '"26-0040-SR","2026","Billy Ray ","Thomas","Neches Federal Credit Union","Former employee","Port Neches","TX","https://ncua.gov/news/enforcement-actions/administrative-orders/2026/administrative-order-matter-billy-ray-thomas"',
  '" 24-0038-SR","2025","Tuskegee Federal Credit Union","N/A","Tuskegee Federal Credit Union","Tuskegee Federal Credit Union","Tuskegee","AL","https://ncua.gov/news/enforcement-actions/administrative-orders/2025/administrative-order-matter-tuskegee-federal-credit-union"',
  ...Array.from({ length: 110 }, (_, i) => `"20-${i}-WR","2020","Filler${i}","Person${i}","Some Credit Union","Former employee","Town","OH","https://ncua.gov/x${i}"`),
].join('\n') + '\n';

const fincenRow = (date, href, title, no, type) => `<tr data-live-order-binding=source:1 data-date=${date} data-institutions=x><td headers=view-title-table-column class="views-field views-field-title"><a href=${href} target=_blank>${title}</a></td><td headers=view-field-date-release-table-column class="views-field views-field-field-date-release is-active"><time datetime=${date}T12:00:00Z>x</time></td><td headers=view-field-matter-no-table-column class="views-field views-field-field-matter-no">${no}</td><td headers=view-field-tags-financial-institution-table-column class="views-field views-field-field-tags-financial-institution">${type}</td></tr>`;
const FINCEN = `<html><body><table><tbody>${[
  fincenRow('2026-10-13', '/system/files/2026-10/BoA-Consent-Order-Execution-Final.pdf', 'In the Matter of Bank of America, N.A.', '2026-03', 'Depository Institutions'),
  fincenRow('2020-10-19', '/system/files/enforcement_action/2023-04-05/HarmonHelix_Assessment_and_SoF_508_101920.pdf', 'In the Matter of Larry Dean Harmon d/b/a Helix', '2020-2', 'Money Services Businesses'),
  fincenRow('2025-12-09', '/system/files/2025-12/PaxfulConsentOrder.pdf', 'Paxful, Inc. and Paxful USA, Inc.', '2025-04', 'Money Services Businesses'),
  ...Array.from({ length: 60 }, (_, i) => fincenRow('2001-01-01', `/f${i}.pdf`, `In the Matter of Filler Casino ${i}`, `2001-${i}`, 'Casinos')),
].join('')}</tbody></table></body></html>`;

/* ------------------------------------------------------------------ */
/* Fake network                                                        */
/* ------------------------------------------------------------------ */

let calls = [];
function serve(routes) {
  setTransport(async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key] : { status: 404, body: 'not found' };
    const headers = { get: () => null };
    if (typeof r === 'string') return { status: 200, headers, url, text: async () => r };
    return { status: r.status || 200, headers, url, text: async () => r.body };
  });
}
const ALL_LISTS = {
  'ebrd.com/bin/ebrd_dxp/csvdownloader': EBRD,
  'supervisionreg/files/ea-cms-recent.json': FRB_RECENT,
  'supervisionreg/files/ea-old.json': FRB_OLD,
  'administrative-orders.csv': NCUA,
  'fincen.gov/news/enforcement-actions': FINCEN,
};

beforeEach(() => { __resetCacheForTests(); calls = []; });
afterEach(() => setTransport());

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000 });
const subjectTask = (subject, template) => ({ kind: 'subject', value: subject.name, template, depth: 0 });

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

describe('reading the lists', () => {
  test('EBRD: names that spill over a comma, bracketed aliases and scope notes; no addresses or nationality of a person', () => {
    const index = parseEbrd(EBRD);
    const meta = index.rows.find((r) => r.n === 'MetaFlow Inc.');
    expect(meta.t).toBe('entity');
    expect(meta.g).toBe('Cross-debarment from World Bank Group');
    expect(meta.a).toEqual(expect.arrayContaining(['CompuAids Inc.']));
    const egis = index.rows.find((r) => /EGIS/.test(r.n));
    expect(egis.n).toBe('EGIS WATER AND MARITIME');
    expect(egis.q).toMatch(/Water and Sanitation/);
    const person = index.rows.find((r) => r.n === 'Ademhan, Abdulhamit');
    expect(person).toMatchObject({ t: 'person', d: '2021-08-06', f: '2025-09-22' });
    expect(person.k).toBeUndefined();
    expect(JSON.stringify(index)).not.toMatch(/Secret Street|Picton|Guyancourt/);
  });

  test('EBRD: a cut-off or reshaped file is an error, never a short list', () => {
    expect(() => parseEbrd(EBRD.slice(0, 500))).toThrow();
    expect(() => parseEbrd('Name,Other\n"x","y"\n')).toThrow(/expected format/);
  });

  test('Federal Reserve: byte order mark, suffixes, aliases and joint institution names', () => {
    const index = parseFrb(FRB_RECENT, FRB_OLD);
    expect(index.asOf).toBe('2026-11-19');
    expect(index.rows.find((r) => /Kelly/.test(r.n)).n).toBe('Albert C. Kelly');
    expect(index.rows.find((r) => /Ng Chong/.test(r.n)).a).toEqual(['Roger Ng']);
    expect(index.rows.find((r) => /Harding/.test(r.n)).u).toBe('https://www.federalreserve.gov/newsevents/pressreleases/enforcement20261119a.htm');
    expect(splitInstitutions('Evolve Bancorp, Inc., West Memphis, Arkansas and Evolve Bank &amp; Trust, West Memphis, Arkansas')).toEqual(expect.arrayContaining(['Evolve Bancorp', 'Evolve Bank & Trust']));
    expect(() => parseFrb(FRB_RECENT, '{"eaitems":[]}')).toThrow();
    expect(() => parseFrb('<html>', FRB_OLD)).toThrow();
  });

  test('NCUA: people and credit unions told apart; a person\'s town is not kept', () => {
    const index = parseNcua(NCUA);
    expect(index.rows.find((r) => r.n === 'Billy Ray Thomas')).toMatchObject({ t: 'person', o: 'Neches Federal Credit Union', r: 'Former employee' });
    expect(index.rows.find((r) => r.n === 'Billy Ray Thomas').s).toBeUndefined();
    expect(index.rows.find((r) => /Tuskegee/.test(r.n))).toMatchObject({ t: 'entity', s: 'AL', i: '24-0038-SR' });
    expect(JSON.stringify(index.rows.filter((r) => r.t === 'person'))).not.toMatch(/Tukwila|Port Neches/);
  });

  test('FinCEN: parties read from the action title', () => {
    expect(fincenParties('In the Matter of Larry Dean Harmon d/b/a Helix')).toEqual(expect.arrayContaining(['Larry Dean Harmon', 'Helix']));
    expect(fincenParties('Paxful, Inc. and Paxful USA, Inc.')).toEqual(expect.arrayContaining(['Paxful, Inc.', 'Paxful USA, Inc.']));
    const index = parseFincen(FINCEN);
    expect(index.rows[1]).toMatchObject({ d: '2020-10-19', i: '2020-2', u: expect.stringMatching(/^https:\/\/www\.fincen\.gov\/system\/files\//) });
    expect(() => parseFincen('<html>maintenance</html>')).toThrow();
  });

  test('names: strict matching, in order, never on part of a name', () => {
    expect(personNameForms("Ng Chong Hwa, also known as 'Roger Ng'")).toEqual({ name: 'Ng Chong Hwa', aliases: ['Roger Ng'] });
    expect(firmNameForms('Sunaula Khimti Pvt. Construction Ltd.\n(also known as M/s Sunaula Khimti)').aliases).toEqual(['M/s Sunaula Khimti']);
    const index = parseFrb(FRB_RECENT, FRB_OLD);
    expect(screenRows(index, ['Albert Kelly'], 'person')).toHaveLength(1);
    expect(screenRows(index, ['Roger Ng'], 'person')).toHaveLength(1);
    expect(screenRows(index, ['Kelly Albert'], 'person')).toHaveLength(0);
    expect(screenRows(index, ['Matthew Stromgren Smith'], 'person')).toHaveLength(0);
    expect(screenRows(index, ['Stromgren'], 'person')).toHaveLength(0);
    expect(screenRows(index, ['Evolve Bank & Trust'], 'company')).toHaveLength(1);
    expect(screenRows(index, ['Evolve'], 'company')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* The sources                                                         */
/* ------------------------------------------------------------------ */

describe('development bank debarments', () => {
  test('a hit on the person, named by full name, is graded by makeFinding; the list is downloaded once', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Abdulhamit Ademhan', company: 'Ademhan Makine' });
    const out = await mdbDebarmentConnector.run(subjectTask(subject, 'debar.mdb'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toMatchObject({ source: 'mdb-debarment', category: 'sanctions', severity: 'high', url: EBRD_PAGE, date: '2021-08-06' });
    expect(f.title).toMatch(/Debarred by the Asian Development Bank: Ademhan, Abdulhamit/);
    // The record names no company the check was started with: possible, and held there so a later anchor
    // (say a former employer) cannot raise a namesake's debarment (round 3)
    expect(f.match).toBe('possible');
    expect(f.matchFixed).toBe(true);
    expect(out.notes).toContain(MDB_NOTE);
    // POSTs the page's own download form
    expect(calls[0].init.method).toBe('POST');
    expect(String(calls[0].init.body)).toMatch(/cardType=iecard/);
    await mdbDebarmentConnector.run(subjectTask(subject, 'debar.mdb'), ctxFor(subject));
    expect(calls).toHaveLength(1);
  });

  test('a name-only match stays possible and says verify identity', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Agustín Olivares Garrigós', company: 'Unrelated Robotics' });
    const out = await mdbDebarmentConnector.run(subjectTask(subject, 'debar.mdb'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].title).toMatch(/verify identity/);
  });

  test('a company hit is a company record; a one-word name is held as possible', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Jane Roe', company: 'MetaFlow Inc.' });
    const out = await mdbDebarmentConnector.run({ kind: 'company', value: 'CompuAids Inc.', template: 'debar.mdb' }, ctxFor(subject));
    // "CompuAids" is one word once the legal form is removed
    expect(out.findings[0].match).toBe('possible');
    const two = await mdbDebarmentConnector.run({ kind: 'company', value: 'Egis Water and Maritime SA', template: 'debar.mdb' }, ctxFor(subject));
    expect(two.findings).toHaveLength(1);
    expect(two.findings[0]).toMatchObject({ match: 'company', matchFixed: true });
    expect(two.findings[0].quote).toMatch(/Scope: but only for its business operations/);
  });

  test('an associate on the list stays possible', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const out = await mdbDebarmentConnector.run({ kind: 'associate', value: 'Abdulhamit Ademhan', template: 'debar.mdb', relation: 'co-founder' }, ctxFor(subject));
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].title).toMatch(/^Co-founder Abdulhamit Ademhan: /);
  });

  test('no match is a clean answer with a note; a failed download is an error', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const out = await mdbDebarmentConnector.run(subjectTask(subject, 'debar.mdb'), ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^Development bank debarment list: no match for Jane Roe \(list as of \d{4}-\d{2}-\d{2}\)$/)]));
    __resetCacheForTests();
    serve({ 'ebrd.com': { status: 500, body: 'error' } });
    await expect(mdbDebarmentConnector.run(subjectTask(subject, 'debar.mdb'), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
  });
});

describe('US bank regulators', () => {
  test('plans one lookup per regulator for the person, one for all three for an associate', () => {
    expect(usBankRegulatorsConnector.plan({ kind: 'subject' }).map((p) => p.template)).toEqual(['bank.frb', 'bank.occ', 'bank.ncua']);
    expect(usBankRegulatorsConnector.plan({ kind: 'relative' }).map((p) => p.template)).toEqual(['bank.all']);
  });

  test('Federal Reserve: the person at a bank already tied to them is graded up by makeFinding, and the bank becomes a thread', async () => {
    serve(ALL_LISTS);
    // The listed name is the typed one (tier 1) beside the company the check was started with
    const subject = createSubject({ name: 'Rush F. Harding', company: 'First Security Bancorp' });
    const out = await usBankRegulatorsConnector.run(subjectTask(subject, 'bank.frb'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toMatchObject({ source: 'us-bank-regulators', category: 'regulatory', severity: 'high', date: '2026-11-16' });
    expect(f.match).toBe('confirmed');
    expect(f.matchFixed).toBeUndefined();
    expect(out.threads).toEqual([expect.objectContaining({ kind: 'company', value: 'First Security Bancorp', trusted: true })]);
    // Typed without the middle initial the list adds (tier 2): likely at most, and no trusted thread (round 3)
    const shorter = createSubject({ name: 'Rush Harding', company: 'First Security Bancorp' });
    const out2 = await usBankRegulatorsConnector.run(subjectTask(shorter, 'bank.frb'), ctxFor(shorter));
    expect(out2.findings[0].match).toBe('likely');
    expect(out2.threads).toEqual([]);
  });

  test('Federal Reserve: a namesake with nothing else in common stays possible', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Katilyn Robinson', company: 'Robinson Analytics' });
    const out = await usBankRegulatorsConnector.run(subjectTask(subject, 'bank.frb'), ctxFor(subject));
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].title).toMatch(/verify identity/);
    expect(out.threads).toEqual([]);
  });

  test('Federal Reserve: a company named in a joint listing', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Jane Roe', company: 'Evolve Bank & Trust' });
    const out = await usBankRegulatorsConnector.run({ kind: 'company', value: 'Evolve Bank & Trust', template: 'bank.frb' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
  });

  test('OCC: one finding per person and docket, linked to the order itself; other people on the docket are dropped', async () => {
    serve({ 'apps.occ.gov/EASearch/api/WebSearch/Actions': JSON.stringify(OCC_STUMPF) });
    const subject = createSubject({ name: 'John Stumpf', company: 'Wells Fargo' });
    const out = await usBankRegulatorsConnector.run(subjectTask(subject, 'bank.occ'), ctxFor(subject));
    expect(calls[0].url).toMatch(/q=John%20Stumpf/);
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.url).toBe('https://www.occ.gov/static/enforcement-actions/ea2020-004.pdf');
    expect(f.quote).toMatch(/Civil Money Penalty \(CMP\) \$17,500,000/);
    expect(['confirmed', 'likely']).toContain(f.match);
    expect(f.severity).toBe('high');
    expect(out.notes).toContain(OCC_NOTE);
  });

  test('OCC: a company search keeps institutions only', async () => {
    serve({ 'apps.occ.gov/EASearch/api/WebSearch/Actions': JSON.stringify([...OCC_STUMPF, ...OCC_BANK]) });
    const subject = createSubject({ name: 'Jane Roe', company: 'Blue Ridge Bank' });
    const out = await usBankRegulatorsConnector.run({ kind: 'company', value: 'Blue Ridge Bank, N.A.', template: 'bank.occ' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'company', date: '2024-01-24' });
  });

  test('OCC: an empty answer is a clean screen; an error answer is an error', async () => {
    serve({ 'apps.occ.gov/EASearch/api/WebSearch/Actions': '[]' });
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const out = await usBankRegulatorsConnector.run(subjectTask(subject, 'bank.occ'), ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes).toContain('OCC enforcement actions: no match for Elizabeth Holmes');
    serve({ 'apps.occ.gov': { status: 502, body: 'bad gateway' } });
    await expect(usBankRegulatorsConnector.run(subjectTask(subject, 'bank.occ'), ctxFor(subject))).rejects.toThrow();
    serve({ 'apps.occ.gov': '<html>maintenance</html>' });
    await expect(usBankRegulatorsConnector.run(subjectTask(subject, 'bank.occ'), ctxFor(subject))).rejects.toThrow(/did not return a result/);
  });

  test('NCUA: a former employee found by full name only, and never on a first name alone', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Aneicia Ford', company: 'Boeing Employees Credit Union' });
    const out = await usBankRegulatorsConnector.run(subjectTask(subject, 'bank.ncua'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('confirmed');
    expect(out.findings[0].url).toMatch(/administrative-order-matter-aneicia-ford$/);
    const other = createSubject({ name: 'Aneicia Smith', company: 'Acme' });
    expect((await usBankRegulatorsConnector.run(subjectTask(other, 'bank.ncua'), ctxFor(other))).findings).toEqual([]);
  });

  test('all three for a relative: a failed list is reported as not screened (partial), not as clean', async () => {
    serve({ ...ALL_LISTS, 'administrative-orders.csv': { status: 503, body: 'down' }, 'apps.occ.gov': '[]' });
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const out = await usBankRegulatorsConnector.run({ kind: 'relative', value: 'Katilyn Robinson', relation: 'sister', template: 'bank.all' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.partial).toEqual(['NCUA administrative orders']);
    expect(out.notes.join(' ')).toMatch(/NCUA administrative orders: could not be read/);
  });

  test('every list failing is an error', async () => {
    serve({});
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    await expect(usBankRegulatorsConnector.run({ kind: 'associate', value: 'John Doe', template: 'bank.all' }, ctxFor(subject))).rejects.toThrow();
  });
});

describe('FinCEN enforcement actions', () => {
  test('a person named in an action title', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Larry Harmon', company: 'Helix' });
    const out = await fincenActionsConnector.run(subjectTask(subject, 'fincen.actions'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ source: 'fincen-actions', category: 'regulatory', date: '2020-10-19' });
    // "Larry Dean Harmon" adds a middle name to the searched one: likely at most, held there (round 3)
    expect(out.findings[0].match).toBe('likely');
    expect(out.findings[0].matchFixed).toBe(true);
  });

  test('a namesake stays possible; a company is matched on its whole name', async () => {
    serve(ALL_LISTS);
    const namesake = createSubject({ name: 'Larry Harmon', company: 'Harmon Plumbing' });
    expect((await fincenActionsConnector.run(subjectTask(namesake, 'fincen.actions'), ctxFor(namesake))).findings[0].match).toBe('possible');
    const out = await fincenActionsConnector.run({ kind: 'company', value: 'Paxful USA Inc', template: 'fincen.actions' }, ctxFor(namesake));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
    expect((await fincenActionsConnector.run({ kind: 'company', value: 'America Bank', template: 'fincen.actions' }, ctxFor(namesake))).findings).toEqual([]);
  });

  test('no match is reported; a page without the list is an error', async () => {
    serve(ALL_LISTS);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    expect((await fincenActionsConnector.run(subjectTask(subject, 'fincen.actions'), ctxFor(subject))).notes).toEqual([expect.stringMatching(/^FinCEN enforcement actions: no match for Jane Roe \(list as of \d{4}-\d{2}-\d{2}\)$/)]);
    __resetCacheForTests();
    serve({ 'fincen.gov': '<html>Please try again later</html>' });
    await expect(fincenActionsConnector.run(subjectTask(subject, 'fincen.actions'), ctxFor(subject))).rejects.toThrow(/did not list/);
  });

  test('a single-word name is not screened', async () => {
    const subject = createSubject({ name: 'Cher', company: '' });
    const out = await fincenActionsConnector.run({ kind: 'associate', value: 'Cher', template: 'fincen.actions' }, ctxFor(subject));
    expect(out.notes[0]).toMatch(/too short a name/);
    // not screened is not "no match": the report must list it as partial
    expect(out.partial).toEqual(['Cher: name too short to screen']);
  });

  test('a company name too short to screen is partial on every list, with no request made', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'HP Inc.' });
    serve(ALL_LISTS);
    for (const [c, template] of [[usBankRegulatorsConnector, 'bank.frb'], [fincenActionsConnector, 'fincen.actions'], [mdbDebarmentConnector, undefined]]) {
      const out = await c.run({ kind: 'company', value: 'HP Inc.', template }, ctxFor(subject));
      expect(out.findings).toEqual([]);
      expect(out.partial).toEqual(['HP Inc.: name too short to screen']);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('contract', () => {
  test.each([mdbDebarmentConnector, usBankRegulatorsConnector, fincenActionsConnector].map((c) => [c.id, c]))('%s: id, plain-English label, kinds, plans', (id, c) => {
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(c.label).not.toMatch(/\b(api|endpoint|key|token|free|paid|tier|quota|env)\b/i);
    for (const kind of c.kinds) {
      for (const p of c.plan({ kind, value: 'x' })) {
        expect(p.template).toMatch(/^[a-z0-9.:_-]+$/i);
        expect(p.prior).toBeGreaterThan(0);
      }
    }
  });
});
