/**
 * @jest-environment node
 *
 * US government record sources (government.js), with the network faked from
 * the shapes the real services returned (USAspending, LDA.gov, CFPB complaint
 * database, Federal Register, openFDA, NIH RePORTER). What matters most: a
 * same-name company or a namesake is never pinned on the person, a structured
 * name match alone stays 'possible', and a failed service is a failure, never
 * a clean result.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const gov = require('../../../src/server/founder/sources/government');

const {
  usFederalAwardsConnector, usLobbyingConnector, cfpbComplaintsConnector,
  federalRegisterConnector, fdaRecallsConnector, nihGrantsConnector,
  GOVERNMENT_CONNECTORS, namesCompanyInText, __resetGovernmentForTests,
} = gov;

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/** Route fake responses by a substring of the URL (and, for POSTs, of the body); record every call. */
function fakeNet(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, init, body: init && init.body ? String(init.body) : '' });
    const hit = routes.find(([part]) => (typeof part === 'function' ? part(url, init) : url.includes(part)));
    if (!hit) return respond('not found', 404);
    const body = typeof hit[1] === 'function' ? hit[1](url, init) : hit[1];
    return body && body.__status ? respond(body.body || '', body.__status) : respond(body);
  });
  return calls;
}
const postTo = (part, bodyPart = '') => (url, init) => url.includes(part) && String(init?.body || '').includes(bodyPart);

beforeEach(() => __resetGovernmentForTests({ unpaced: true }));
afterEach(() => setTransport());

const BANNED = /\b(api|endpoint|key|token|free|paid|tier|quota|env)\b/i;

describe('the sources as a set', () => {
  test('six connectors with unique ids and plain-English labels', () => {
    expect(GOVERNMENT_CONNECTORS).toHaveLength(6);
    const ids = GOVERNMENT_CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(6);
    for (const c of GOVERNMENT_CONNECTORS) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.label).not.toMatch(BANNED);
      expect(c.kinds.every((k) => ['subject', 'alias', 'company'].includes(k))).toBe(true);
      expect(c.prior).toBeGreaterThan(0);
      expect(typeof c.run).toBe('function');
    }
    expect(usLobbyingConnector.maxParallel).toBe(1);
  });

  test('a company name is read as a name, never as a word or part of a longer name', () => {
    expect(namesCompanyInText('Nikola Corporation; Analysis of Proposed Consent Order', 'Nikola')).toBe(true);
    expect(namesCompanyInText('the Nikola Corporation filed', 'Nikola Corporation')).toBe(true);
    // one-word names need their legal form
    expect(namesCompanyInText('Comments on Nikola trucks', 'Nikola')).toBe(false);
    expect(namesCompanyInText('Nikola Motor Works, Inc. petition', 'Nikola')).toBe(false);
    expect(namesCompanyInText('Block Grant program for states', 'Block')).toBe(false);
    expect(namesCompanyInText('Block, Inc. agrees to pay', 'Block')).toBe(true);
    expect(namesCompanyInText('a mistral ai paper', 'Mistral AI')).toBe(false);
    expect(namesCompanyInText('Mistral AI announced', 'Mistral AI')).toBe(true);
  });
});

/* ------------------------------------------------------------------ USAspending */

describe('us-federal-awards (USAspending)', () => {
  const recipients = { count: 4, results: [
    { recipient_name: 'BIOTHERANOSTICS INC', recipient_level: null, uei: null, duns: null },
    { recipient_name: 'THERANOS, INC.', recipient_level: null, uei: null, duns: null },
    { recipient_name: 'NEUROTHERANOSTICS INC', recipient_level: null, uei: null, duns: null },
    { recipient_name: 'MOLECULAR THERANOSTICS LLC', recipient_level: null, uei: null, duns: null },
  ] };
  const counts = { results: { contracts: 2, direct_payments: 0, grants: 0, idvs: 0, loans: 1, other: 0 }, spending_level: 'awards' };
  const contracts = { spending_level: 'awards', limit: 50, results: [
    { internal_id: 350504891, 'Award ID': 'W91WFU13P0010', 'Recipient Name': 'THERANOS, INC.', 'Award Amount': 8245.06, 'Awarding Agency': 'Department of Defense', 'Start Date': '2013-09-30', Description: 'RATIFICATION OF UNAUTHROIZED COMMITMENT / UC-NUMBER/ S-13-U-001', 'Place of Performance State Code': 'CA', recipient_id: 'b87455ff-c9c3-6a9e-7b6e-0cf55cb07ca0-C', generated_internal_id: 'CONT_AWD_W91WFU13P0010_9700_-NONE-_-NONE-' },
    { internal_id: 349290606, 'Award ID': 'W911QY12P0323', 'Recipient Name': 'THERANOS, INC.', 'Award Amount': 360.0, 'Awarding Agency': 'Department of Defense', 'Start Date': '2012-04-23', Description: 'FIELD STABLE LAB SET - LAB REPORT', 'Place of Performance State Code': 'CA', recipient_id: 'b87455ff-c9c3-6a9e-7b6e-0cf55cb07ca0-C', generated_internal_id: 'CONT_AWD_W911QY12P0323_9700_-NONE-_-NONE-' },
    { internal_id: 349153480, 'Award ID': 'W81XWH17C0222', 'Recipient Name': 'NEUROTHERANOSTICS INC', 'Award Amount': 146079.2, 'Awarding Agency': 'Department of Defense', 'Start Date': '2017-09-25', Description: 'SBIR PHASE I', 'Place of Performance State Code': 'MI', recipient_id: '17fc46a1-3549-b423-0272-2c5dcc076087-C', generated_internal_id: 'CONT_AWD_W81XWH17C0222_9700_-NONE-_-NONE-' },
  ] };
  const loans = { spending_level: 'awards', limit: 50, results: [
    { internal_id: 256456034, 'Award ID': '9040047001', 'Recipient Name': "TACKER'S THERANOS SHACK INC", 'Loan Value': 67280.0, 'Awarding Agency': 'Small Business Administration', 'Issued Date': '2020-04-09', Description: 'TO AID SMALL BUSINESSES IN MAINTAINING WORK FORCE DURING COVID-19 PANDEMIC.', 'Recipient State Code': null, recipient_id: '41aafbba-R', generated_internal_id: 'ASST_NON_9040047001_073' },
  ] };

  test('reports the exact company only, with agency, state and years; a one-word name stays possible', async () => {
    const calls = fakeNet([
      [postTo('autocomplete/recipient'), recipients],
      [postTo('spending_by_award_count'), counts],
      [postTo('spending_by_award/', '"A"'), contracts],
      [postTo('spending_by_award/', '"07"'), loans],
    ]);
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const r = await usFederalAwardsConnector.run({ kind: 'company', value: 'Theranos' }, ctxFor(subject));
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    // "Theranos" is one word once the legal form is set aside: any firm of that name could be the recipient
    expect(f.match).toBe('possible');
    expect(f.matchReasons.join(' ')).toMatch(/one-word name/);
    expect(f.title).toBe('2 federal contracts to THERANOS, INC., 2012–2013');
    expect(f.quote).toMatch(/Department of Defense/);
    expect(f.quote).toMatch(/\(CA\)/);
    expect(f.quote).toMatch(/\$8,605 in all/);
    expect(f.quote).not.toMatch(/NEUROTHERANOSTICS|146,079/);
    expect(f.url).toBe('https://www.usaspending.gov/recipient/b87455ff-c9c3-6a9e-7b6e-0cf55cb07ca0-C/latest');
    // the count search is limited to the exact registered names
    const countCall = calls.find((c) => c.url.includes('spending_by_award_count'));
    expect(JSON.parse(countCall.body).filters.recipient_search_text).toEqual(['THERANOS, INC.']);
  });

  test('no recipient under the exact name: an empty answer with a note, not an error', async () => {
    fakeNet([[postTo('autocomplete/recipient'), { count: 1, results: [{ recipient_name: 'BIOTHERANOSTICS INC' }] }]]);
    const r = await usFederalAwardsConnector.run({ kind: 'company', value: 'Theranos' }, ctxFor(createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' })));
    expect(r.findings).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/exact name Theranos/);
  });

  test('a service failure is thrown, never reported as no awards', async () => {
    fakeNet([[postTo('autocomplete/recipient'), { __status: 500, body: 'oops' }]]);
    await expect(usFederalAwardsConnector.run({ kind: 'company', value: 'Theranos' }, ctxFor(createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' })))).rejects.toThrow(/HTTP 500/);
  });

  test('one award group that does not answer is reported as partial', async () => {
    fakeNet([
      [postTo('autocomplete/recipient'), recipients],
      [postTo('spending_by_award_count'), counts],
      [postTo('spending_by_award/', '"A"'), contracts],
      [postTo('spending_by_award/', '"07"'), { __status: 503, body: 'busy' }],
    ]);
    const r = await usFederalAwardsConnector.run({ kind: 'company', value: 'Theranos' }, ctxFor(createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' })));
    expect(r.findings).toHaveLength(1);
    expect(r.partial).toEqual(['federal loans (SBA and PPP loans included)']);
  });
});

/* ------------------------------------------------------------------ LDA.gov */

const lobbyist = (first, middle, last, position = 'N/A') => ({ lobbyist: { id: 1, prefix: null, first_name: first, nickname: null, middle_name: middle, last_name: last, suffix: null }, covered_position: position, new: false });
const filing = ({ uuid, type = 'Q2', year, posted, registrant, client, clientState = 'AZ', income = null, expenses = null, issues = ['Transportation'], lobbyists = [], termination = null }) => ({
  url: `https://lda.gov/api/v1/filings/${uuid}/`,
  filing_uuid: uuid,
  filing_type: type,
  filing_year: year,
  filing_document_url: `https://lda.gov/filings/public/filing/${uuid}/print/`,
  income, expenses,
  posted_by_name: 'Pat Filer',
  dt_posted: posted,
  termination_date: termination,
  registrant_address_1: '12705 Laurel Grove Way',
  registrant: { id: 1, name: registrant, address_1: '2053 Salem Church Rd', city: 'Stephens City', state: 'VA', zip: '22655', contact_name: 'PAT FILER', contact_telephone: '+1 202-480-7008' },
  client: { id: 2, name: client, general_description: 'Zero-emissions transportation', state: clientState, country: 'US' },
  lobbying_activities: issues.map((i) => ({ general_issue_code: 'TRA', general_issue_code_display: i, description: 'Issues related to zero emission vehicles', lobbyists })),
  conviction_disclosures: [],
  foreign_entities: [],
  affiliated_organizations: [],
});

describe('us-lobbying (LDA.gov)', () => {
  const clientPage = { count: 3, next: null, previous: null, results: [
    filing({ uuid: 'a1', type: '1T', year: 2025, posted: '2025-04-16T10:00:00-04:00', registrant: 'ALPEX INTERNATIONAL, LLC', client: 'NIKOLA CORPORATION', income: '20000.00', lobbyists: [lobbyist('LEE', 'R.', 'GODOWN', 'Chief of Staff - Rep. Loretta Sanchez')], termination: '2025-02-19' }),
    filing({ uuid: 'a2', type: 'Q2', year: 2023, posted: '2023-07-20T10:00:00-04:00', registrant: 'NIKOLA CORPORATION', client: 'NIKOLA CORPORATION', expenses: '220000.00', issues: ['Transportation', 'Taxation/Internal Revenue Code'], lobbyists: [lobbyist('TREVOR', 'R.', 'MILTON')] }),
    filing({ uuid: 'a3', type: 'Q1', year: 2021, posted: '2021-04-20T10:00:00-04:00', registrant: 'K STREET LLC', client: 'NIKOLA MOTOR WORKS', income: '10000.00', lobbyists: [lobbyist('JANE', null, 'ROE')] }),
  ] };

  test('company: the exact client only, as a company record, without addresses or phone numbers', async () => {
    const calls = fakeNet([['lda.gov/api/v1/filings/', clientPage]]);
    const subject = createSubject({ name: 'Jane Doe', company: 'Nikola' });
    const r = await usLobbyingConnector.run({ kind: 'company', value: 'Nikola' }, ctxFor(subject));
    expect(calls[0].url).toContain('client_name=Nikola');
    expect(calls[0].url).toContain('ordering=-dt_posted');
    expect(r.findings).toHaveLength(2);
    const hired = r.findings.find((f) => /ALPEX/.test(f.title));
    expect(hired.match).toBe('possible'); // "Nikola" is a one-word name
    expect(hired.title).toBe('ALPEX INTERNATIONAL, LLC lobbied for NIKOLA CORPORATION, 2025');
    expect(hired.quote).toMatch(/NIKOLA CORPORATION \(AZ\), client of ALPEX INTERNATIONAL, LLC/);
    expect(hired.quote).toMatch(/\$20,000 reported paid/);
    expect(hired.quote).toMatch(/Registration ended 2025-02-19/);
    expect(hired.url).toBe('https://lda.gov/filings/public/filing/a1/print/');
    const all = JSON.stringify(r.findings);
    expect(all).not.toMatch(/Laurel Grove|Salem Church|202-480|22655|MOTOR WORKS/);
    expect(r.notes.join(' ')).toMatch(/Senate Office of Public Records cannot vouch/);
  });

  test('company: a filing that lists the person as a lobbyist is graded on the record (company named: confirmed)', async () => {
    fakeNet([['lda.gov/api/v1/filings/', clientPage]]);
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const r = await usLobbyingConnector.run({ kind: 'company', value: 'Nikola' }, ctxFor(subject));
    const own = r.findings.find((f) => /lobbied the federal government/.test(f.title));
    expect(own.match).toBe('confirmed');
    expect(own.matchFixed).toBeUndefined();
  });

  const lobbyistPage = { count: 232, next: 'https://lda.gov/api/v1/filings/?page=2', previous: null, results: [
    filing({ uuid: 'b1', year: 2026, posted: '2026-10-20T10:00:00-04:00', registrant: 'ALPEX INTERNATIONAL, LLC', client: 'ONWARD MEDICAL, INC.', clientState: 'MA', issues: ['Veterans'], lobbyists: [lobbyist('LEE', 'R.', 'GODOWN', 'Chief of Staff - Rep. Loretta Sanchez')] }),
    filing({ uuid: 'b2', year: 2025, posted: '2025-04-16T10:00:00-04:00', registrant: 'ALPEX INTERNATIONAL, LLC', client: 'NIKOLA CORPORATION', lobbyists: [lobbyist('LEE', 'R.', 'GODOWN')] }),
    filing({ uuid: 'b3', year: 1999, posted: '1999-08-01T10:00:00-04:00', registrant: 'BIOTECHNOLOGY INNOVATION ORGANIZATION', client: 'BIOTECHNOLOGY INNOVATION ORGANIZATION', lobbyists: [lobbyist('RICHARD', null, 'GODOWN'), lobbyist('LEE', null, 'GODOWNSKI')] }),
  ] };

  test('person: a namesake lobbyist stays possible; other people with the surname are dropped', async () => {
    const calls = fakeNet([['lda.gov/api/v1/filings/', lobbyistPage]]);
    const subject = createSubject({ name: 'Lee Godown' });
    const r = await usLobbyingConnector.run({ kind: 'subject', value: 'Lee Godown' }, ctxFor(subject));
    expect(calls[0].url).toContain('lobbyist_name=Lee+Godown');
    expect(r.findings).toHaveLength(2);
    for (const f of r.findings) expect(f.match).toBe('possible');
    expect(r.findings[0].title).toBe('Lee R. Godown listed as a federal lobbyist for ONWARD MEDICAL, INC., 2026');
    expect(r.findings[0].quote).toMatch(/Former government position listed: Chief of Staff - Rep\. Loretta Sanchez/);
    expect(JSON.stringify(r.findings)).not.toMatch(/Richard|BIOTECHNOLOGY/i);
    // a name-only record opens no trusted threads
    expect(r.threads).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/232 filings/);
  });

  test('person: tied by the company the person is known for, never set by hand', async () => {
    fakeNet([['lda.gov/api/v1/filings/', lobbyistPage]]);
    const subject = createSubject({ name: 'Lee Godown', company: 'Nikola' });
    const r = await usLobbyingConnector.run({ kind: 'subject', value: 'Lee Godown' }, ctxFor(subject));
    const tied = r.findings.find((f) => /NIKOLA/.test(f.title));
    expect(tied.match).toBe('confirmed');
    expect(tied.matchFixed).toBeUndefined();
    expect(r.findings.find((f) => /ONWARD/.test(f.title)).match).toBe('possible');
    expect(r.threads.map((t) => t.value)).toEqual(expect.arrayContaining(['NIKOLA CORPORATION', 'ALPEX INTERNATIONAL, LLC']));
    expect(r.threads.every((t) => t.trusted)).toBe(true);
  });

  test('an empty answer is empty; a refusal is an error', async () => {
    fakeNet([['lda.gov/api/v1/filings/', { count: 0, next: null, previous: null, results: [] }]]);
    const r = await usLobbyingConnector.run({ kind: 'subject', value: 'Jane Doe' }, ctxFor(createSubject({ name: 'Jane Doe' })));
    expect(r.findings).toEqual([]);
    fakeNet([['lda.gov/api/v1/filings/', { __status: 429, body: '{"detail":"Request was throttled."}' }]]);
    await expect(usLobbyingConnector.run({ kind: 'subject', value: 'Jane Doe' }, ctxFor(createSubject({ name: 'Jane Doe' })))).rejects.toThrow(/429/);
  });

  test('LDA.gov is asked no faster than its published pace, and a turn past the deadline is not started', async () => {
    __resetGovernmentForTests({ unpaced: false });
    fakeNet([['lda.gov/api/v1/filings/', { count: 0, results: [] }]]);
    const subject = createSubject({ name: 'Jane Doe' });
    await usLobbyingConnector.run({ kind: 'subject', value: 'Jane Doe' }, ctxFor(subject));
    // the next turn is about four seconds away: with less time left it is refused, not queued
    await expect(usLobbyingConnector.run({ kind: 'subject', value: 'Jane Doe' }, { ...ctxFor(subject), deadline: Date.now() + 3000 })).rejects.toThrow(/Out of time/);
  });
});

/* ------------------------------------------------------------------ CFPB complaints */

describe('cfpb-complaints', () => {
  const agg = (name, buckets) => ({ doc_count: 0, [name]: { doc_count_error_upper_bound: 0, sum_other_doc_count: 0, buckets } });
  const lookup = { took: 5, hits: { total: { value: 74231, relation: 'eq' }, hits: [] }, aggregations: {
    company: { meta: {}, doc_count: 74231, company: { buckets: [{ key: 'Block, Inc.', doc_count: 73721 }, { key: 'Javitch, Block & Rathbone LLC', doc_count: 327 }, { key: 'BlockFi Inc', doc_count: 182 }] } },
  } };
  const detail = {
    hits: { total: { value: 73721, relation: 'eq' }, hits: [{ _source: { company: 'Block, Inc.', date_received: '2026-11-18T13:58:15.000Z', zip_code: '94110', state: 'CA', complaint_what_happened: 'my story', issue: 'Fraud or scam' } }] },
    aggregations: {
      product: agg('product', [{ key: 'Money transfer, virtual currency, or money service', doc_count: 58422 }, { key: 'Checking or savings account', doc_count: 9445 }]),
      issue: agg('issue', [{ key: 'Other transaction problem', doc_count: 34210 }, { key: 'Fraud or scam', doc_count: 7882 }]),
      company_response: agg('company_response', [{ key: 'Closed with explanation', doc_count: 73346 }, { key: 'Closed with monetary relief', doc_count: 129 }]),
      timely: agg('timely', [{ key: 'Yes', doc_count: 72730 }, { key: 'No', doc_count: 991 }]),
    },
    _meta: { license: 'CC0' },
  };

  test('counts and top issues for the exact company, never a consumer\'s story or location', async () => {
    const calls = fakeNet([
      [(u) => u.includes('search_term=Block'), lookup],
      [(u) => u.includes('company=Block%2C+Inc.'), detail],
    ]);
    const r = await cfpbComplaintsConnector.run({ kind: 'company', value: 'Block' }, ctxFor(createSubject({ name: 'Jack Dorsey', company: 'Block' })));
    expect(calls).toHaveLength(2); // the law firm and BlockFi are not looked up
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.match).toBe('possible'); // "Block" is a one-word name
    expect(f.title).toBe('73,721 consumer complaints about Block, Inc. in the CFPB database');
    expect(f.quote).toMatch(/Fraud or scam \(7,882\)/);
    expect(f.quote).toMatch(/closed with monetary relief 129/);
    expect(f.quote).toMatch(/Not answered in time: 991/);
    expect(f.date).toBe('2026-11-18');
    expect(JSON.stringify(f)).not.toMatch(/94110|my story/);
  });

  test('no company of that name: empty', async () => {
    fakeNet([[(u) => u.includes('search_term='), { hits: { total: { value: 0 } }, aggregations: { company: { company: { buckets: [] } } } }]]);
    const r = await cfpbComplaintsConnector.run({ kind: 'company', value: 'Theranos' }, ctxFor(createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' })));
    expect(r.findings).toEqual([]);
  });

  test('a failure is an error, and an unexpected page is not read as no complaints', async () => {
    fakeNet([[(u) => u.includes('search_term='), { __status: 502, body: 'bad gateway' }]]);
    await expect(cfpbComplaintsConnector.run({ kind: 'company', value: 'Block' }, ctxFor(createSubject({ name: 'Jack Dorsey', company: 'Block' })))).rejects.toThrow(/HTTP 502/);
    fakeNet([[(u) => u.includes('search_term='), '<!DOCTYPE html><html>maintenance</html>']]);
    await expect(cfpbComplaintsConnector.run({ kind: 'company', value: 'Block' }, ctxFor(createSubject({ name: 'Jack Dorsey', company: 'Block' })))).rejects.toThrow(/not JSON/);
  });
});

/* ------------------------------------------------------------------ Federal Register */

describe('federal-register', () => {
  const doc = (n, title, excerpts, { type = 'Notice', agency = 'Federal Trade Commission', date = '2024-05-06' } = {}) => ({
    title, type, abstract: null, html_url: `https://www.federalregister.gov/documents/2024/05/06/${n}/x`, publication_date: date,
    agencies: [{ raw_name: agency.toUpperCase(), name: agency, id: 1, slug: 'x' }], document_number: n, excerpts,
  });

  test('person: a record naming the person with their company is graded confirmed by the grader; a namesake stays possible', async () => {
    fakeNet([['federalregister.gov/api/v1/documents.json', { count: 3, total_pages: 1, results: [
      doc('2023-1', 'Trevor Milton; Order Denying Export Privileges', 'The <span class="match">Trevor Milton</span>, former chief executive of Nikola Corporation, was convicted of securities fraud.', { agency: 'Industry and Security Bureau' }),
      doc('2023-2', 'Petition for Exemption', 'A petition filed by <span class="match">Trevor Milton</span> of Austin for an exemption from hours-of-service rules.', { agency: 'Federal Motor Carrier Safety Administration' }),
      doc('2023-3', 'Notice of Settlement', 'A claim by Trevor Milton Lund was settled.', { agency: 'Environmental Protection Agency' }),
    ] }]]);
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const r = await federalRegisterConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(subject));
    expect(r.findings).toHaveLength(2);
    const order = r.findings.find((f) => /Denying/.test(f.title));
    expect(order.match).toBe('confirmed');
    expect(order.matchFixed).toBeUndefined();
    expect(order.severity).toBe('high');
    expect(order.quote).toMatch(/^Notice, Industry and Security Bureau, published 2024-05-06:/);
    expect(order.quote).not.toMatch(/<span/);
    const petition = r.findings.find((f) => /Petition/.test(f.title));
    expect(petition.match).toBe('possible');
    expect(JSON.stringify(r.findings)).not.toMatch(/Lund/);
  });

  test('a rule that discusses a case as background is not a red flag', async () => {
    fakeNet([['federalregister.gov/api/v1/documents.json', { count: 1, results: [
      doc('2023-24774', 'Investment of Customer Funds by Futures Commission Merchants', 'Samuel Bankman-Fried was convicted of fraud.', { type: 'Proposed Rule', agency: 'Commodity Futures Trading Commission' }),
    ] }]]);
    const subject = createSubject({ name: 'Sam Bankman-Fried', company: 'FTX' });
    const r = await federalRegisterConnector.run({ kind: 'subject', value: 'Sam Bankman-Fried' }, ctxFor(subject));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible');
    expect(r.findings[0].severity).toBe('low');
  });

  test('company: only documents naming the company as a name, marked as about the company', async () => {
    const calls = fakeNet([['federalregister.gov/api/v1/documents.json', { count: 3, results: [
      doc('2022-1', 'Nikola Corporation; Analysis of Proposed Consent Order To Aid Public Comment', 'The consent agreement settles alleged violations by <span class="match">Nikola</span> Corporation.'),
      doc('2022-2', 'Nikola Motor Works, Inc.; Grant of Petition', 'Nikola Motor Works petitioned.'),
      doc('2022-3', 'Hydrogen Fuel Cell Rule', 'Comments mentioned Nikola trucks.', { type: 'Rule' }),
    ] }]]);
    const r = await federalRegisterConnector.run({ kind: 'company', value: 'Nikola' }, ctxFor(createSubject({ name: 'Trevor Milton', company: 'Nikola' })));
    expect(decodeURIComponent(calls[0].url)).toContain('conditions[term]="Nikola"');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible'); // "Nikola" is a one-word name
    expect(r.findings[0].severity).toBe('medium');
    expect(r.findings[0].quote).toMatch(/Federal Trade Commission, published 2024-05-06/);
  });

  test('empty answer, and a failure surfacing as an error', async () => {
    fakeNet([['federalregister.gov/api/v1/documents.json', { description: "Documents matching '\"Trevor Milton\"'", count: 0 }]]);
    const r = await federalRegisterConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(createSubject({ name: 'Trevor Milton' })));
    expect(r.findings).toEqual([]);
    fakeNet([['federalregister.gov/api/v1/documents.json', { __status: 500, body: 'error' }]]);
    await expect(federalRegisterConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(createSubject({ name: 'Trevor Milton' })))).rejects.toThrow(/HTTP 500/);
  });
});

/* ------------------------------------------------------------------ openFDA */

describe('fda-recalls (openFDA)', () => {
  const recall = (firm, cls, date, reason, state = 'IL') => ({
    status: 'Terminated', city: 'Abbott Park', state, country: 'United States', classification: cls, product_type: 'Devices', event_id: '1',
    recalling_firm: firm, address_1: '100 Abbott Park Rd', postal_code: '60064-3500', recall_number: 'Z-1-2025', reason_for_recall: reason,
    product_description: 'Analyzer', report_date: date, recall_initiation_date: date,
  });
  const notFound = { __status: 404, body: '{"error":{"code":"NOT_FOUND","message":"No matches found!"}}' };

  test('the exact firm only; Class I raises the severity; no street address', async () => {
    fakeNet([
      ['/device/enforcement.json', { meta: { results: { skip: 0, limit: 100, total: 3 } }, results: [
        recall('Abbott Laboratories', 'Class II', '20250101', 'Software error may cause incorrect results.'),
        recall('Abbott Laboratories Inc.', 'Class I', '20240310', 'Leaking connector.'),
        recall('Abbott Vascular Inc', 'Class II', '20241220', 'Inflation device may leak.', 'CA'),
      ] }],
      ['/drug/enforcement.json', notFound],
      ['/food/enforcement.json', notFound],
    ]);
    const r = await fdaRecallsConnector.run({ kind: 'company', value: 'Abbott Laboratories' }, ctxFor(createSubject({ name: 'Robert Ford', company: 'Abbott Laboratories' })));
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.match).toBe('company');
    expect(f.title).toBe('2 medical device recalls by Abbott Laboratories, 2024–2025');
    expect(f.severity).toBe('medium');
    expect(f.quote).toMatch(/\(IL\), FDA medical device enforcement reports 2024–2025/);
    expect(f.quote).toMatch(/1 Class I/);
    expect(f.date).toBe('2025-01-01');
    expect(JSON.stringify(f)).not.toMatch(/Abbott Park Rd|60064|Vascular/);
    expect(r.partial).toBeUndefined();
  });

  test('openFDA\'s "no matches" answer is an empty result; other failures are not', async () => {
    fakeNet([['enforcement.json', notFound]]);
    const r = await fdaRecallsConnector.run({ kind: 'company', value: 'Theranos' }, ctxFor(createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' })));
    expect(r.findings).toEqual([]);
    expect(r.partial).toBeUndefined();
    fakeNet([['enforcement.json', { __status: 500, body: 'error' }]]);
    await expect(fdaRecallsConnector.run({ kind: 'company', value: 'Theranos' }, ctxFor(createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' })))).rejects.toThrow(/openFDA did not answer/);
    fakeNet([['/drug/', notFound], ['/device/', notFound], ['/food/', { __status: 500, body: 'error' }]]);
    const some = await fdaRecallsConnector.run({ kind: 'company', value: 'Theranos' }, ctxFor(createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' })));
    expect(some.partial).toEqual(['food recalls']);
  });
});

/* ------------------------------------------------------------------ NIH RePORTER */

describe('nih-grants (NIH RePORTER)', () => {
  const project = (appl, num, core, fy, title, org, pis, ic = 'NCI', amount = 528259) => ({
    appl_id: appl, fiscal_year: fy, project_num: num, core_project_num: core, project_title: title,
    organization: { org_name: org, org_city: 'BEACHWOOD', org_state: 'OH', org_zipcode: '441221765', org_country: 'UNITED STATES' },
    award_amount: amount,
    principal_investigators: pis.map((full) => ({ profile_id: 1, full_name: full, first_name: full.split(' ')[0], last_name: full.split(' ').pop(), is_contact_pi: true, title: 'SCIENTIST' })),
    agency_ic_admin: { code: 'CA', abbreviation: ic, name: 'National Cancer Institute' },
    project_start_date: `${fy}-09-01T00:00:00`, project_end_date: `${fy + 5}-08-31T00:00:00`,
    project_detail_url: `https://reporter.nih.gov/project-details/${appl}`,
  });
  const page = (results) => ({ meta: { total: results.length, offset: 0, limit: 100 }, results });

  test('person: graded by the grantee they are known for; health topics left out of the quote', async () => {
    const calls = fakeNet([['api.reporter.nih.gov/v2/projects/search', page([
      project(11226020, '1R01CA297667-01A1', 'R01CA297667', 2026, 'Development of next-generation targeted MRI contrast agents', 'MOLECULAR THERANOSTICS, LLC', ['Ryan Christopher Hall']),
      project(10760236, '1R43CA281488-01A1', 'R43CA281488', 2023, 'Development of peptide drug conjugates for cancer therapy', 'MOLECULAR THERANOSTICS, LLC', ['Ryan Christopher Hall']),
      project(9999, '1R01XX000001-01', 'R01XX000001', 2020, 'Bridge materials', 'STATE UNIVERSITY', ['Ryan Hall Peters']),
    ])]]);
    const subject = createSubject({ name: 'Ryan Hall', company: 'Molecular Theranostics' });
    const r = await nihGrantsConnector.run({ kind: 'subject', value: 'Ryan Hall' }, ctxFor(subject));
    expect(JSON.parse(calls[0].body).criteria.pi_names).toEqual([{ any_name: 'Ryan Hall' }]);
    expect(r.findings).toHaveLength(2);
    for (const f of r.findings) {
      expect(f.match).toBe('confirmed');
      expect(f.matchFixed).toBeUndefined();
    }
    expect(r.findings[0].quote).toMatch(/^Ryan Christopher Hall, principal investigator at MOLECULAR THERANOSTICS, LLC \(OH\), NIH NCI, fiscal years 2026/);
    const sensitive = r.findings.find((f) => /R43CA281488/.test(f.title));
    // A grant's research subject is not a person's health: since round 3 the guardrails keep it (needs-phase1)
    expect(sensitive.title).toBe('NIH grant R43CA281488: Development of peptide drug conjugates for cancer therapy');
    expect(JSON.stringify(r.findings)).not.toMatch(/441221765|Peters/i);
    expect(r.threads).toEqual([expect.objectContaining({ kind: 'company', value: 'MOLECULAR THERANOSTICS, LLC', trusted: true })]);
  });

  test('person: a namesake investigator stays possible and opens no thread', async () => {
    fakeNet([['api.reporter.nih.gov/v2/projects/search', page([
      project(1, '1R01AA000001-01', 'R01AA000001', 2019, 'Bridge materials', 'STATE UNIVERSITY', ['Ryan Hall'], 'NIBIB'),
    ])]]);
    const r = await nihGrantsConnector.run({ kind: 'subject', value: 'Ryan Hall' }, ctxFor(createSubject({ name: 'Ryan Hall', company: 'Acme Robotics' })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible');
    expect(r.threads).toEqual([]);
  });

  test('company: the exact grantee only, as a company record', async () => {
    fakeNet([['api.reporter.nih.gov/v2/projects/search', page([
      project(11226020, '1R01CA297667-01A1', 'R01CA297667', 2026, 'Development of next-generation targeted MRI contrast agents', 'MOLECULAR THERANOSTICS, LLC', ['Ryan Christopher Hall']),
      project(5, '1R43XX-01', 'R43XX', 2018, 'Probes', 'THERANOSTICS HEALTH', ['Jane Roe']),
    ])]]);
    const r = await nihGrantsConnector.run({ kind: 'company', value: 'Molecular Theranostics' }, ctxFor(createSubject({ name: 'Jane Doe', company: 'Molecular Theranostics' })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('company');
    expect(r.findings[0].title).toBe('1 NIH research grant to MOLECULAR THERANOSTICS, LLC, 2026');
    expect(r.findings[0].quote).toMatch(/\(OH\): 1 NIH grant, \$528,259 awarded 2026/);
    expect(r.findings[0].quote).not.toMatch(/THERANOSTICS HEALTH/);
  });

  test('empty answer, and a failure surfacing as an error', async () => {
    fakeNet([['api.reporter.nih.gov/v2/projects/search', page([])]]);
    expect((await nihGrantsConnector.run({ kind: 'subject', value: 'Jane Doe' }, ctxFor(createSubject({ name: 'Jane Doe' })))).findings).toEqual([]);
    fakeNet([['api.reporter.nih.gov/v2/projects/search', { __status: 500, body: 'error' }]]);
    await expect(nihGrantsConnector.run({ kind: 'company', value: 'Acme' }, ctxFor(createSubject({ name: 'Jane Doe', company: 'Acme' })))).rejects.toThrow(/HTTP 500/);
  });
});

/* ------------------------------------------------------------------ review fixes */

describe('one-word company names are never pinned on the subject\'s company', () => {
  test('USAspending: a same-name "FLOW LLC" contract for a one-word company is possible, not the company', async () => {
    fakeNet([
      [postTo('autocomplete/recipient'), { count: 1, results: [{ recipient_name: 'FLOW LLC' }] }],
      [postTo('spending_by_award_count'), { results: { contracts: 1, grants: 0, loans: 0, direct_payments: 0 } }],
      [postTo('spending_by_award/', '"A"'), { results: [{ 'Recipient Name': 'FLOW LLC', 'Award Amount': 12000, 'Awarding Agency': 'Department of Defense', 'Start Date': '2015-03-01', Description: 'JANITORIAL SERVICES', 'Place of Performance State Code': 'TX', recipient_id: 'r-1' }] }],
    ]);
    const r = await usFederalAwardsConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'Flow' })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible');
    expect(r.findings[0].matchReasons.join(' ')).toMatch(/one-word name/);
  });

  test('a two-word name is still the company', () => {
    expect(gov.companyGrade('Molecular Theranostics', 'x').match).toBe('company');
    expect(gov.companyGrade('Flow, Inc.', 'x').match).toBe('possible');
    expect(gov.companyGrade('Abbott Laboratories Inc.', 'x').match).toBe('company');
  });

  test('openFDA, CFPB and NIH: a one-word firm name stays possible', async () => {
    const notFound = { __status: 404, body: '{"error":{"code":"NOT_FOUND"}}' };
    fakeNet([
      ['/device/enforcement.json', { meta: { results: { total: 1 } }, results: [{ recalling_firm: 'Flow, Inc.', classification: 'Class II', status: 'Ongoing', report_date: '20240101', reason_for_recall: 'Label error.', state: 'OH' }] }],
      ['enforcement.json', notFound],
    ]);
    const fda = await fdaRecallsConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'Flow' })));
    expect(fda.findings.map((f) => f.match)).toEqual(['possible']);
    fakeNet([['api.reporter.nih.gov', { meta: { total: 1 }, results: [{ appl_id: 1, fiscal_year: 2020, project_num: 'R43X', core_project_num: 'R43X', project_title: 'Pumps', organization: { org_name: 'FLOW LLC', org_state: 'TX' }, award_amount: 1000, principal_investigators: [{ full_name: 'Jane Roe' }], agency_ic_admin: { abbreviation: 'NIBIB' } }] }]]);
    const nih = await nihGrantsConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'Flow' })));
    expect(nih.findings.map((f) => f.match)).toEqual(['possible']);
  });
});

describe('federal-register: addresses, excluded agencies, cut-short searches', () => {
  const frDoc = (title, excerpts, agencies) => ({ title, type: 'Notice', abstract: null, html_url: `https://www.federalregister.gov/documents/2024/05/06/${encodeURIComponent(title).slice(0, 20)}/x`, publication_date: '2024-05-06', agencies, document_number: '1', excerpts });

  test('an export-denial order that prints the person\'s home address keeps the name and drops the address', async () => {
    fakeNet([['federalregister.gov/api/v1/documents.json', { count: 1, results: [
      frDoc('Jane Roe, 4 Via Linda, Tempe, AZ 85284; Order Denying Export Privileges', 'Order denying <span class="match">Jane Roe</span>, 4 Via Linda, Tempe, AZ 85284, export privileges.', [{ name: 'Industry and Security Bureau', slug: 'industry-and-security-bureau' }]),
    ] }]]);
    const r = await federalRegisterConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(createSubject({ name: 'Jane Roe' })));
    expect(r.findings).toHaveLength(1);
    const all = JSON.stringify(r.findings);
    expect(all).not.toMatch(/Via Linda|Tempe|85284/);
    expect(r.findings[0].title).toMatch(/^Jane Roe; Order Denying Export Privileges/);
  });

  test('immigration and controlled-substance agencies, and family or immigration matters, are never read', async () => {
    fakeNet([['federalregister.gov/api/v1/documents.json', { count: 3, results: [
      frDoc('Jane Roe; Decision and Order', 'Jane Roe, M.D., registration revoked.', [{ name: 'Drug Enforcement Administration', slug: 'drug-enforcement-administration' }]),
      frDoc('Notice of Removal Order', 'Jane Roe was subject to a removal order.', [{ name: 'Justice Department', slug: 'justice-department' }]),
      frDoc('Jane Roe; Order Denying Export Privileges', 'Order denying Jane Roe export privileges.', [{ name: 'Industry and Security Bureau', slug: 'industry-and-security-bureau' }]),
    ] }]]);
    const r = await federalRegisterConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(createSubject({ name: 'Jane Roe' })));
    expect(r.findings.map((f) => f.title)).toEqual(['Jane Roe; Order Denying Export Privileges']);
  });

  test('a search that holds more documents than were read is partial, never clean', async () => {
    fakeNet([['federalregister.gov/api/v1/documents.json', { count: 900, results: [] }]]);
    const r = await federalRegisterConnector.run({ kind: 'company', value: 'Acme Robotics' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Acme Robotics' })));
    expect(r.findings).toEqual([]);
    expect(r.partial).toEqual(['Federal Register (0 of 900 documents read)']);
  });
});

describe('cut-short lobbying and grant searches are partial', () => {
  test('LDA.gov with more filings than were read', async () => {
    fakeNet([['lda.gov/api/v1/filings/', { count: 232, results: [] }]]);
    const r = await usLobbyingConnector.run({ kind: 'company', value: 'Acme Robotics' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Acme Robotics' })));
    expect(r.partial).toEqual(['lobbying filings (latest 0 of 232 read)']);
  });
  test('NIH RePORTER with more grants than were read', async () => {
    fakeNet([['api.reporter.nih.gov', { meta: { total: 500 }, results: [] }]]);
    const r = await nihGrantsConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(createSubject({ name: 'Jane Roe' })));
    expect(r.partial).toEqual(['NIH grants (latest 0 of 500 read)']);
  });
});
