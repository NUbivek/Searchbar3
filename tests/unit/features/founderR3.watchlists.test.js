/** @jest-environment node */
// Round 3 audit fixes for the watchlist sources (sanctions.js, debarment.js, government.js).
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addAnchor, addCompanyAlias } = require('../../../src/server/founder/identity');
const S = require('../../../src/server/founder/sources/sanctions');
const D = require('../../../src/server/founder/sources/debarment');
const G = require('../../../src/server/founder/sources/government');

/* ------------------------------------------------------------------ */
/* Fake network                                                        */
/* ------------------------------------------------------------------ */

let calls = [];
function serve(routes) {
  setTransport(async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? await routes[key](url, init) : { status: 404, body: 'not found' };
    const headers = { get: () => null };
    if (typeof r === 'string') return { status: 200, headers, url, text: async () => r };
    return { status: r.status || 200, headers, url, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  });
}
beforeEach(() => { __resetCacheForTests(); G.__resetGovernmentForTests({ unpaced: true }); calls = []; });
afterEach(() => { setTransport(); jest.restoreAllMocks(); });

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* ---- sanctions list fixtures ---- */

const CSL_HEADER = '_id,source,entity_number,type,programs,name,title,addresses,federal_register_notice,start_date,end_date,standard_order,license_requirement,license_policy,call_sign,vessel_type,gross_tonnage,gross_registered_tonnage,vessel_flag,vessel_owner,remarks,source_list_url,alt_names,citizenships,dates_of_birth,nationalities,places_of_birth,source_information_url,ids';
const cslRow = (o) => CSL_HEADER.split(',').map((k) => `"${String(o[k] ?? '').replace(/"/g, '""')}"`).join(',');
const SDN = 'Specially Designated Nationals (SDN) - Treasury Department';
const CSL = [
  CSL_HEADER,
  cslRow({ _id: '1', source: SDN, entity_number: '501', type: 'Entity', programs: 'RUSSIA-EO14024', name: 'FLOW LLC' }),
  cslRow({ _id: '2', source: SDN, entity_number: '502', type: 'Entity', programs: 'RUSSIA-EO14024', name: 'FLOW HEALTH TECHNOLOGIES LLC' }),
  cslRow({ _id: '3', source: SDN, entity_number: '503', type: 'Individual', programs: 'CYBER2', name: 'BANKMAN-FRIED, Samuel Benjamin' }),
  cslRow({ _id: '4', source: SDN, entity_number: '504', type: 'Individual', programs: 'SDNTK', name: 'Juan Carlos GARCIA LOPEZ' }),
  cslRow({ _id: '5', source: SDN, entity_number: '505', type: 'Individual', programs: 'IRAN', name: 'Muhammad ALI REZAEI' }),
].join('\r\n') + '\r\n';
const UN = '<?xml version="1.0"?><CONSOLIDATED_LIST dateGenerated="2026-11-14T00:00:05Z"><INDIVIDUALS><INDIVIDUAL><FIRST_NAME>ERIC</FIRST_NAME><SECOND_NAME>BADEGE</SECOND_NAME><UN_LIST_TYPE>DRC</UN_LIST_TYPE><REFERENCE_NUMBER>CDi.001</REFERENCE_NUMBER><LISTED_ON>2012-12-31</LISTED_ON></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>';
const UK = `<?xml version="1.0"?><Designations><DateGenerated>12/11/2026</DateGenerated>
<Designation><UniqueID>RUS0001</UniqueID><RegimeName>Russia</RegimeName><IndividualEntityShip>Individual</IndividualEntityShip><DateDesignated>15/03/2022</DateDesignated>
<UKStatementofReasons>Former president of Rusal. Together with her husband Kim Su Gwang, her father-in-law Kim Yon runs the scheme.</UKStatementofReasons>
<Names><Name><Name1>Oleg</Name1><Name6>DERIPASKA</Name6><NameType>Primary Name</NameType></Name></Names></Designation>
</Designations>`;
const CA = '<?xml version="1.0"?><data-set><record><EntityOrShip-EntiteOuNavire>Rosoboronexport JSC</EntityOrShip-EntiteOuNavire><DateOfListing-DateDinscription>2022-03-03</DateOfListing-DateDinscription></record></data-set>';
const EU = '﻿Entity_LogicalId;Entity_EU_ReferenceNumber;Entity_SubjectType;Entity_SubjectType_ClassificationCode;Entity_Regulation_Programme;Entity_Regulation_PublicationDate;Entity_Regulation_PublicationUrl;NameAlias_WholeName;NameAlias_Function\n"14";"EU.8.1";"E";"enterprise";"UKR";"2022-01-01";"";"VTB Bank";""\n';
const LISTS = {
  'data.trade.gov': () => CSL,
  'scsanctions.un.org': () => UN,
  'sanctionslist.fcdo.gov.uk': () => UK,
  'international.gc.ca': () => CA,
  'webgate.ec.europa.eu': () => EU,
};

/* ---- bank regulator fixtures ---- */

const frbItem = (o) => ({ id: o.id, edt: o.edt || daysAgo(30), tdt: '1950-01-01', type: o.type || 'Prohibition from Banking', url: `/x${o.id}.htm`, ...o });
const FRB_RECENT = (extra = []) => JSON.stringify({ eaitems: [
  frbItem({ id: 'a', person: 'John R. Smith', porg: 'Wells Fargo Bank, Sioux Falls, South Dakota' }),
  frbItem({ id: 'b', person: 'Katilyn M. Robinson', porg: 'United Community Bank, Greenville, South Carolina' }),
  ...extra,
  ...Array.from({ length: 20 }, (_, i) => frbItem({ id: `r${i}`, bkorg: `Recent Filler Bank ${i}, Town, Ohio`, type: 'Written Agreement', edt: daysAgo(i + 2) })),
] });
const FRB_OLD = JSON.stringify({ eaitems: Array.from({ length: 520 }, (_, i) => ({ id: i, edt: '2010-01-01', tdt: '2012-01-01', bkorg: `Filler Bank ${i}, Town, Ohio`, type: 'Written Agreement', url: `/o${i}.htm` })) });

const EBRD_HEADER = 'Name Of Entity, Name (special charcters), Notice type, Nationality, Reason for debarment, Grounds, Jurisdiction of judgement, Start date, End date, Notice effective at EBRD, Address';
const EBRD = [
  EBRD_HEADER,
  '"Olivares Garrigós, Agustín", , Individual, Spain, Collusive Practice, Cross-debarment from Inter-American Development Bank Group, , 23-12-2014, 22-12-2019, 28-04-2015,"Calle 1"',
  '"Abdulhamit Ademhan", , Individual, Turkiye, Fraudulent Practice, Cross-debarment from Asian Development Bank, , 06-08-2021, Ongoing (debarment with conditional release), 22-09-2025,"Street 9"',
  ...Array.from({ length: 60 }, (_, i) => `"Filler Construction ${i} LLC", , Firm, Kenya, Fraudulent Practice, Cross-debarment from World Bank Group, , 01-01-2024, 31-12-2030, 01-02-2024,"Road ${i}"`),
].join('\n') + '\n';

/* ------------------------------------------------------------------ */
/* watchlists-namesake-confirmed-by-employer                           */
/* ------------------------------------------------------------------ */

describe('a namesake at a former employer is never confirmed', () => {
  test('Federal Reserve: John R. Smith prohibited at Wells Fargo stays possible for a John Smith who once worked there', async () => {
    serve({ 'ea-cms-recent.json': () => FRB_RECENT(), 'ea-old.json': () => FRB_OLD });
    const subject = createSubject({ name: 'John Smith', company: 'Acme Robotics' });
    // Learned from a résumé record, not typed by the user
    addAnchor(subject, 'companies', 'Wells Fargo', 'resume-finding-1');
    const out = await D.usBankRegulatorsConnector.run({ kind: 'subject', value: 'John Smith', template: 'bank.frb' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].matchFixed).toBe(true);
    expect(out.threads).toEqual([]);
  });

  test('sanctions list: a role naming a company learned from other records gives no grade', async () => {
    serve(LISTS);
    const subject = createSubject({ name: 'Oleg Deripaska', company: 'Acme Robotics' });
    addAnchor(subject, 'companies', 'Rusal', 'press-finding-2');
    const out = await S.sanctionsListsConnector.run({ kind: 'subject', value: 'Oleg Deripaska', template: 'list.uk' }, ctxFor(subject));
    expect(out.findings[0].match).toBe('possible');
  });

  test('the company the check was started with, beside the same name, still grades the record', async () => {
    serve(LISTS);
    const subject = createSubject({ name: 'Oleg Deripaska', company: 'Rusal' });
    const out = await S.sanctionsListsConnector.run({ kind: 'subject', value: 'Oleg Deripaska', template: 'list.uk' }, ctxFor(subject));
    expect(out.findings[0].match).toBe('confirmed');
  });

  test('a very large employer typed as the company gives likely at most', () => {
    const subject = createSubject({ name: 'John Stumpf', company: 'Wells Fargo' });
    const f = S.gradeListedPerson(subject, { source: 'us-bank-regulators', sourceLabel: 'x', category: 'regulatory', title: 'OCC order: John Stumpf', quote: 'Individual: John Stumpf', url: 'https://www.occ.gov/x.pdf' }, { tier: 1, context: 'Wells Fargo Bank, National Association' });
    expect(f.match).toBe('likely');
  });
});

/* ------------------------------------------------------------------ */
/* watchlists-oneword-company-sanctions and design decision 1          */
/* ------------------------------------------------------------------ */

describe('one-word company names and learned legal names', () => {
  test('"Flow Inc." against FLOW LLC on the US list is possible, never the company', async () => {
    serve(LISTS);
    const subject = createSubject({ name: 'Jane Roe', company: 'Flow' });
    const out = await S.sanctionsListsConnector.run({ kind: 'company', value: 'Flow Inc.', template: 'list.all' }, ctxFor(subject));
    expect(out.findings.map((f) => [f.data.listKey, f.match])).toEqual([['us-csl', 'possible']]);
  });

  test('a learned legal name is screened too, and a hit through it is the company', async () => {
    serve(LISTS);
    const subject = createSubject({ name: 'Jane Roe', company: 'Flow' });
    expect(addCompanyAlias(subject, { company: 'Flow', alias: 'Flow Health Technologies, Inc.', origin: 'form-d-1' })).toBe(true);
    expect(S.companyNames(subject, 'Flow')).toEqual(['Flow', 'Flow Health Technologies, Inc.']);
    const out = await S.sanctionsListsConnector.run({ kind: 'company', value: 'Flow', template: 'list.all' }, ctxFor(subject));
    const byMatch = Object.fromEntries(out.findings.map((f) => [f.match, f.title]));
    expect(byMatch.company).toMatch(/FLOW HEALTH TECHNOLOGIES LLC/);
    expect(byMatch.possible).toMatch(/FLOW LLC/);
  });

  test('SAM.gov: a one-word company is possible; its learned legal name is searched as well', async () => {
    const sam = (rows) => ({ body: { page: { totalElements: rows.length }, _embedded: { results: rows } } });
    const row = (id, title) => ({ _id: id, title, classification: { code: 'Firm' }, excludingAgency: 'GSA', exclusionType: 'Ineligible', activationDate: '2024-01-01', terminationDate: null });
    serve({ 'sam.gov': (url) => (/q=flow%20health/.test(url) ? sam([row('h', 'FLOW HEALTH TECHNOLOGIES INC')]) : sam([row('f', 'FLOW LLC')])) });
    const subject = createSubject({ name: 'Jane Roe', company: 'Flow' });
    addCompanyAlias(subject, { company: 'Flow', alias: 'Flow Health Technologies, Inc.', origin: 'form-d-1' });
    const out = await S.exclusionsConnector.run({ kind: 'company', value: 'Flow', template: 'excl.sam' }, ctxFor(subject));
    expect(calls.map((c) => c.url).filter((u) => /sam\.gov/.test(u))).toHaveLength(2);
    expect(out.findings.map((f) => [f.url, f.match]).sort()).toEqual([
      ['https://sam.gov/exclusion/f/view', 'possible'],
      ['https://sam.gov/exclusion/h/view', 'company'],
    ]);
  });

  test('government: a learned legal name is searched and its record is the company; the bare word stays possible', async () => {
    const bodies = [];
    serve({
      'autocomplete/recipient': (url, init) => {
        const text = JSON.parse(init.body).search_text;
        bodies.push(text);
        return { body: { results: /Health/i.test(text) ? [{ recipient_name: 'FLOW HEALTH TECHNOLOGIES INC' }] : [{ recipient_name: 'FLOW INC' }] } };
      },
      'spending_by_award_count': () => ({ body: { results: { contracts: 2 } } }),
      'spending_by_award/': () => ({ body: { results: [
        { 'Recipient Name': 'FLOW HEALTH TECHNOLOGIES INC', 'Award Amount': 1000, 'Awarding Agency': 'Department of Defense', 'Start Date': '2024-02-01', Description: 'Software', recipient_id: 'r1' },
        { 'Recipient Name': 'FLOW INC', 'Award Amount': 50, 'Awarding Agency': 'Department of Energy', 'Start Date': '2023-02-01', Description: 'Pumps', recipient_id: 'r2' },
      ] } }),
    });
    const subject = createSubject({ name: 'Jane Roe', company: 'Flow' });
    addCompanyAlias(subject, { company: 'Flow', alias: 'Flow Health Technologies, Inc.', origin: 'form-d-1' });
    const out = await G.usFederalAwardsConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(subject));
    expect(bodies).toEqual(['Flow', 'Flow Health Technologies, Inc.']);
    const grades = out.findings.map((f) => [f.title.replace(/,.*/, ''), f.match]).sort();
    expect(grades).toEqual([['1 federal contract to FLOW HEALTH TECHNOLOGIES INC', 'company'], ['1 federal contract to FLOW INC', 'possible']]);
  });

  test('government: the Federal Register is searched under each known name', async () => {
    const terms = [];
    serve({ 'federalregister.gov': (url) => {
      terms.push(decodeURIComponent(new URL(url).searchParams.get('conditions[term]')));
      return { body: { count: 1, results: [{ title: 'Order against Flow Health Technologies, Inc.', type: 'Notice', abstract: 'Flow Health Technologies, Inc. agreed to a settlement.', html_url: 'https://www.federalregister.gov/d/1', publication_date: '2025-01-01', agencies: [{ name: 'Federal Trade Commission', slug: 'federal-trade-commission' }], document_number: '1' }] } };
    } });
    const subject = createSubject({ name: 'Jane Roe', company: 'Flow' });
    addCompanyAlias(subject, { company: 'Flow', alias: 'Flow Health Technologies, Inc.', origin: 'form-d-1' });
    const out = await G.federalRegisterConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(subject));
    expect(terms).toEqual(['"Flow"', '"Flow Health Technologies, Inc."']);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
  });
});

/* ------------------------------------------------------------------ */
/* watchlists-unscreenable-reported-clean                              */
/* ------------------------------------------------------------------ */

describe('a name that cannot be screened is never a clean screen', () => {
  test('a name typed in Cyrillic is screened in Latin letters', async () => {
    expect(S.transliterate('Олег Дерипаска')).toEqual(['Oleg Deripaska']);
    expect(S.transliterate('Юрий Гагарин')).toEqual(['Iurii Gagarin', 'Yuriy Gagarin']);
    expect(S.transliterate('Γιάννης Παπαδόπουλος')).toEqual(['Giannis Papadopoulos']);
    expect(S.transliterate('Jane Roe')).toEqual([]);
    serve(LISTS);
    const subject = createSubject({ name: 'Олег Дерипаска' });
    const out = await S.sanctionsListsConnector.run({ kind: 'subject', value: 'Олег Дерипаска', template: 'list.uk' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].title).toMatch(/DERIPASKA/);
  });

  test('every too-short path returns partial', async () => {
    serve({});
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const task = { kind: 'associate', value: 'Putin', template: 'list.all' };
    for (const [connector, t] of [[S.sanctionsListsConnector, task], [S.exclusionsConnector, { ...task, template: 'excl.sam' }]]) {
      const out = await connector.run(t, ctxFor(subject));
      expect(out.findings).toEqual([]);
      expect(out.partial).toEqual(['Putin: name could not be screened']);
    }
    const single = createSubject({ name: 'Madonna' });
    expect((await S.wantedConnector.run({ kind: 'subject', value: 'Madonna', template: 'wanted.fbi' }, ctxFor(single))).partial).toHaveLength(1);
    expect((await S.offshoreLeaksConnector.run({ kind: 'subject', value: 'Madonna' }, ctxFor(single))).partial).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* watchlists-alllists-partial-missing                                 */
/* ------------------------------------------------------------------ */

test('an all-lists screen with four lists that failed is partial', async () => {
  const down = () => ({ status: 404, body: 'gone' });
  serve({ 'data.trade.gov': () => CSL, 'scsanctions.un.org': down, 'sanctionslist.fcdo.gov.uk': down, 'international.gc.ca': down, 'webgate.ec.europa.eu': down });
  const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
  const out = await S.sanctionsListsConnector.run({ kind: 'relative', value: 'Eric Badege', relation: 'brother', template: 'list.all' }, ctxFor(subject));
  expect(out.partial).toEqual([
    'UN Security Council sanctions list: not read', 'EU consolidated sanctions list: not read',
    'UK Sanctions List: not read', 'Canada sanctions list: not read',
  ]);
});

/* ------------------------------------------------------------------ */
/* watchlists-truncated-searches-clean                                 */
/* ------------------------------------------------------------------ */

describe('a cut result is partial', () => {
  test('SAM.gov reads up to three pages, then reports the rest as not read', async () => {
    const pageOf = (url) => Number(new URL(url).searchParams.get('page'));
    serve({ 'sam.gov': (url) => ({ body: { page: { totalElements: 400 }, _embedded: { results: Array.from({ length: 50 }, (_, i) => ({ _id: `p${pageOf(url)}-${i}`, title: `OTHER PERSON ${pageOf(url)} ${i}`, classification: { code: 'Individual' } })) } } }) });
    const subject = createSubject({ name: 'John Smith', company: 'Acme' });
    const out = await S.exclusionsConnector.run({ kind: 'subject', value: 'John Smith', template: 'excl.sam' }, ctxFor(subject));
    expect(calls.map((c) => pageOf(c.url))).toEqual([0, 1, 2]);
    expect(out.partial).toEqual(['SAM.gov exclusion list: 150 of 400 records read']);
  });
});

/* ------------------------------------------------------------------ */
/* watchlists-false-negatives-names                                    */
/* ------------------------------------------------------------------ */

describe('name variants', () => {
  test('middle names, suffixes, nicknames, other spellings and an extra surname are found as tier 3 or better', () => {
    expect(S.matchPersonName(S.personVariants('Trevor Roy Milton'), 'MILTON, Trevor')).toBe(1);
    expect(S.matchPersonName(S.personVariants('Albert Kelly Jr.'), 'KELLY, Albert')).toBe(1);
    expect(S.matchPersonName(['Sam Bankman-Fried'], 'BANKMAN-FRIED, Samuel Benjamin')).toBe(3);
    expect(S.matchPersonName(['Juan Garcia'], 'Juan Carlos Garcia Lopez')).toBe(3);
    expect(S.matchPersonName(['Juan Garcia'], 'GARCIA LOPEZ, Juan Carlos')).toBe(3);
    expect(S.matchPersonName(['Mohammed Ali'], 'Muhammad ALI')).toBe(3);
    // Still never a match
    expect(S.matchPersonName(['Elizabeth Holmes'], 'Rachael Elizabeth Holmes')).toBe(0);
    expect(S.matchPersonName(['Adam Neumann'], 'ADAMS NEUMANN-SMITH')).toBe(0);
    expect(S.matchPersonName(['John Smith'], 'John Smith J')).toBe(0);
  });

  test('a variant hit is titled as such and stays possible even beside the given company', async () => {
    serve(LISTS);
    const subject = createSubject({ name: 'Sam Bankman-Fried', company: 'FTX' });
    const out = await S.sanctionsListsConnector.run({ kind: 'subject', value: 'Sam Bankman-Fried', template: 'list.us-csl' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].title).toMatch(/^Name variant match on the US Consolidated Screening List: BANKMAN-FRIED, Samuel Benjamin/);
    expect(out.findings[0].match).toBe('possible');
  });

  test('the debarment lists find variants too', async () => {
    serve({ 'ebrd.com': () => EBRD });
    const subject = createSubject({ name: 'Agustin Olivares', company: 'Acme' });
    const out = await D.mdbDebarmentConnector.run({ kind: 'subject', value: 'Agustin Olivares', template: 'debar.mdb' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
  });
});

/* ------------------------------------------------------------------ */
/* watchlists-stale-unbounded                                          */
/* ------------------------------------------------------------------ */

test('an older list copy standing in for a failed download is partial and dated', async () => {
  serve(LISTS);
  const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
  const task = { kind: 'subject', value: 'Jane Roe', template: 'list.un' };
  const first = await S.sanctionsListsConnector.run(task, ctxFor(subject));
  expect(first.partial).toBeUndefined();
  const realNow = Date.now();
  const copyDay = new Date(realNow).toISOString().slice(0, 10);
  // Two days later the UN host is down
  jest.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 86400000);
  serve({ ...LISTS, 'scsanctions.un.org': () => ({ status: 404, body: 'gone' }) });
  const later = await S.sanctionsListsConnector.run(task, { subject, deadline: realNow + 2 * 86400000 + 20000 });
  expect(later.notes).toEqual(expect.arrayContaining([`UN Security Council sanctions list: no match for Jane Roe (list as of ${copyDay})`]));
  expect(later.partial).toEqual([`UN Security Council sanctions list: list as of ${copyDay}`]);
});

/* ------------------------------------------------------------------ */
/* watchlists-5xx-not-retried                                          */
/* ------------------------------------------------------------------ */

test('one 500 on the EBRD download is tried again', async () => {
  let n = 0;
  serve({ 'ebrd.com': () => { n += 1; return n === 1 ? { status: 500, body: 'error page' } : EBRD; } });
  const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
  const out = await D.mdbDebarmentConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'debar.mdb' }, ctxFor(subject));
  expect(n).toBe(2);
  expect(out.notes.join(' ')).toMatch(/no match for Jane Roe/);
});

/* ------------------------------------------------------------------ */
/* watchlists-mdb-e2e-ok-expired-wording                               */
/* ------------------------------------------------------------------ */

test('an ended development bank debarment says so and is medium', async () => {
  serve({ 'ebrd.com': () => EBRD });
  const subject = createSubject({ name: 'Agustín Olivares Garrigós', company: 'Acme' });
  const out = await D.mdbDebarmentConnector.run({ kind: 'subject', value: subject.name, template: 'debar.mdb' }, ctxFor(subject));
  expect(out.findings[0].title).toMatch(/^Formerly debarred by the Inter-American Development Bank Group \(ended 2019-12-22\)/);
  expect(out.findings[0].severity).toBe('medium');
  const current = await D.mdbDebarmentConnector.run({ kind: 'subject', value: 'Abdulhamit Ademhan', template: 'debar.mdb' }, ctxFor(createSubject({ name: 'Abdulhamit Ademhan' })));
  expect(current.findings[0].title).toMatch(/^Debarred by the Asian Development Bank/);
  expect(current.findings[0].severity).toBe('high');
});

/* ------------------------------------------------------------------ */
/* watchlists-associates-not-on-exclusions                             */
/* ------------------------------------------------------------------ */

test('associates and relatives are screened on SAM.gov and the HHS OIG list', async () => {
  expect(S.exclusionsConnector.kinds).toEqual(expect.arrayContaining(['associate', 'relative']));
  expect(S.exclusionsConnector.plan({ kind: 'associate' }).map((p) => p.template)).toEqual(['excl.sam', 'excl.leie']);
  serve({ 'sam.gov': () => ({ body: { page: { totalElements: 1 }, _embedded: { results: [{ _id: 'z', title: 'ERIC BADEGE', classification: { code: 'Individual' }, excludingAgency: 'HHS', activationDate: '2020-01-01' }] } } }) });
  const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
  const out = await S.exclusionsConnector.run({ kind: 'associate', value: 'Eric Badege', relation: 'co-founder', template: 'excl.sam' }, ctxFor(subject));
  expect(out.findings).toHaveLength(1);
  expect(out.findings[0].match).toBe('possible');
  expect(out.findings[0].title).toMatch(/^Co-founder Eric Badege: name match on the SAM.gov exclusion list/);
});

/* ------------------------------------------------------------------ */
/* watchlists-frb-recent-empty                                         */
/* ------------------------------------------------------------------ */

test('an empty or out-of-date Federal Reserve recent file is refused', () => {
  expect(() => D.parseFrb('{"eaitems":[]}', FRB_OLD)).toThrow(/recent actions file had too few entries/);
  const oldOnly = JSON.stringify({ eaitems: Array.from({ length: 30 }, (_, i) => frbItem({ id: `q${i}`, person: `Person ${i} Name`, edt: '2019-01-01' })) });
  expect(() => D.parseFrb(oldOnly, FRB_OLD)).toThrow(/recent actions file had too few entries/);
  expect(D.parseFrb(FRB_RECENT(), FRB_OLD).rows.length).toBeGreaterThan(500);
});

/* ------------------------------------------------------------------ */
/* watchlists-sam-inactive-hidden                                      */
/* ------------------------------------------------------------------ */

test('SAM.gov returns ended exclusions and labels them', async () => {
  serve({ 'sam.gov': () => ({ body: { page: { totalElements: 1 }, _embedded: { results: [{ _id: 'e1', title: 'ELIZABETH HOLMES', classification: { code: 'Individual' }, excludingAgency: 'OPM', exclusionType: 'Prohibition/Restriction', activationDate: '2016-01-01', terminationDate: '2019-05-01' }] } } }) });
  const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Acme' });
  const out = await S.exclusionsConnector.run({ kind: 'subject', value: 'Elizabeth Holmes', template: 'excl.sam' }, ctxFor(subject));
  expect(calls[0].url).not.toMatch(/is_active/);
  expect(out.findings[0].title).toMatch(/\(exclusion ended 2019-05-01\)/);
  expect(out.findings[0].quote).toMatch(/Exclusion ended 2019-05-01/);
  expect(out.findings[0].severity).toBe('medium');
});

/* ------------------------------------------------------------------ */
/* watchlists-family-in-reasons                                        */
/* ------------------------------------------------------------------ */

test('family ties in a list\'s reason text are dropped; corporate "parent" and "sister company" stay', () => {
  expect(S.reasonText('Former president of Rusal. Together with her husband Kim Su Gwang, her father-in-law Kim Yon runs the scheme.')).toBe('Former president of Rusal.');
  expect(S.reasonText('Brother of the minister. Director of a shipping firm.')).toBe('Director of a shipping firm.');
  expect(S.reasonText('Sister company of Rosoboronexport. Owned by its parent company.')).toBe('Sister company of Rosoboronexport. Owned by its parent company.');
  expect(S.reasonText('Son Hyok is a trade official.')).toBe('Son Hyok is a trade official.');
  expect(S.parseUk(UK).rows[0].r).toBe('Former president of Rusal.');
  expect(today()).toMatch(/^\d{4}/);
});
