/**
 * Courts, enforcement and regulator-record connectors, with the network
 * faked. The case that matters most: a namesake's record (same name, or a
 * longer name that contains it, such as "Trevor Milton Lund") must never be
 * graded above 'possible', and personal records must not leak.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const courts = require('../../../src/server/founder/sources/courts');

const {
  courtDocketsConnector, courtRecordsOpenConnector, dojConnector, brokerCheckConnector,
  ukGazetteConnector, ukCaseLawConnector, bodaccConnector, enforcementActionsConnector,
  sameName, person, __resetCourtsForTests,
} = courts;

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/** Route fake responses by a substring of the URL; record every call. */
function fakeNet(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, init });
    const hit = routes.find(([part]) => url.includes(part));
    if (!hit) return respond('not found', 404);
    const body = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
    return body && body.__status ? respond(body.body || '', body.__status) : respond(body);
  });
  return calls;
}

const milton = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const miltonNoCompany = () => createSubject({ name: 'Trevor Milton' });

beforeEach(() => __resetCourtsForTests());
afterEach(() => {
  setTransport();
  delete process.env.COURTLISTENER_API_TOKEN;
});

describe('person names', () => {
  test('a longer name that contains the subject is somebody else', () => {
    const who = person(milton());
    expect(sameName('Trevor Milton Lund', who)).toBe(false);
    expect(sameName('MILTON, TREVOR R.', who)).toBe(true);
    expect(sameName('Trevor R. Milton', who)).toBe(true);
    expect(sameName('Milton', who)).toBe(false);
  });
  test('nicknames and hyphenated surnames match the legal name', () => {
    const who = person(createSubject({ name: 'Sam Bankman-Fried' }));
    expect(sameName('SAMUEL BENJAMIN BANKMAN-FRIED', who)).toBe(true);
    expect(sameName('Samuel Bankman Fried', who)).toBe(true);
    expect(sameName('Samuel Fried', who)).toBe(false);
  });
});

describe('court-dockets (CourtListener, token)', () => {
  const dockets = {
    count: 4,
    results: [
      { caseName: 'United States v. Milton', docketNumber: '1:21-cr-00478', court: 'District Court, S.D. New York', court_id: 'nysd', dateFiled: '2021-07-29', docket_absolute_url: '/docket/60096221/united-states-v-milton/', party: ['Trevor Milton', 'USA'], suitNature: '', cause: '18:1348 Securities Fraud' },
      { caseName: 'Smith v. Nikola Corporation', docketNumber: '2:20-cv-01797', court: 'District Court, D. Arizona', court_id: 'azd', dateFiled: '2020-09-15', docket_absolute_url: '/docket/18456789/smith-v-nikola-corporation/', party: ['John Smith', 'Nikola Corporation', 'Trevor R. Milton'], suitNature: '850 Securities/Commodities', cause: '15:78m(a) Securities Exchange Act' },
      { caseName: 'In re Trevor Milton Lund', docketNumber: '2:19-bk-01234', court: 'Bankruptcy Court, D. Utah', court_id: 'utb', dateFiled: '2019-02-01', docket_absolute_url: '/docket/111/in-re-trevor-milton-lund/', party: ['Trevor Milton Lund'], chapter: '7' },
      { caseName: 'Trevor Milton v. Acme Roofing LLC', docketNumber: '3:18-cv-00001', court: 'District Court, D. Oregon', court_id: 'ord', dateFiled: '2018-01-02', docket_absolute_url: '/docket/222/milton-v-acme-roofing/', party: ['Trevor Milton', 'Acme Roofing LLC'], suitNature: '190 Contract: Other' },
    ],
  };

  test('is switched off without the token, and plans three lookups for a person with a company', () => {
    expect(courtDocketsConnector.enabled()).toBe(false);
    expect(courtRecordsOpenConnector.enabled()).toBe(true);
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    expect(courtDocketsConnector.enabled()).toBe(true);
    expect(courtRecordsOpenConnector.enabled()).toBe(false);
    expect(courtDocketsConnector.unavailableReason).toBe('US federal court dockets are not enabled on this deployment.');
    const plans = courtDocketsConnector.plan({ kind: 'subject', value: 'Trevor Milton' }, milton());
    expect(plans.map((p) => p.template)).toEqual(['dockets.party', 'opinions.name', 'dockets.name-company']);
  });

  test('maps dockets: company party confirms, criminal is high, namesakes stay possible or are dropped', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    const calls = fakeNet([['courtlistener.com/api/rest/v4/search/', dockets]]);
    const out = await courtDocketsConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'dockets.party' }, ctxFor(milton()));
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBe('Token test-token');
    expect(decodeURIComponent(calls[0].url).replace(/\+/g, ' ')).toContain('party:"Trevor Milton"');
    const byCase = Object.fromEntries(out.findings.map((f) => [f.title.split(' (')[0], f]));
    expect(Object.keys(byCase)).not.toContain('In re Trevor Milton Lund');
    const criminal = byCase['United States v. Milton'];
    expect(criminal.severity).toBe('high');
    expect(criminal.match).toBe('possible');
    expect(criminal.category).toBe('litigation');
    expect(criminal.title).toBe('United States v. Milton (District Court, S.D. New York, filed 2021-07-29, docket 1:21-cr-00478)');
    expect(criminal.data).toEqual(expect.objectContaining({ caseNumber: '1:21-cr-00478', court: 'District Court, S.D. New York' }));
    expect(criminal.url).toBe('https://www.courtlistener.com/docket/60096221/united-states-v-milton/');
    expect(criminal.date).toBe('2021-07-29');
    const civil = byCase['Smith v. Nikola Corporation'];
    expect(civil.match).toBe('confirmed');
    expect(civil.severity).toBe('medium');
    // R3: only the person and their known companies are named; other parties are counted.
    expect(civil.quote).toContain('Parties include: Nikola Corporation; Trevor R. Milton; and 1 other party.');
    expect(civil.quote).not.toContain('John Smith');
    expect(byCase['Trevor Milton v. Acme Roofing LLC'].match).toBe('possible');
  });

  test('a company lookup grades as company and runs one request', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    const calls = fakeNet([['courtlistener.com', { count: 1, results: [{ caseName: 'Lion Electric v. Nikola Corp.', docketNumber: '1:22-cv-1', court: 'District Court, D. Delaware', court_id: 'ded', dateFiled: '2022-03-01', docket_absolute_url: '/docket/9/lion-v-nikola/', party: ['Lion Electric', 'Nikola Corp.'] }] }]]);
    const out = await courtDocketsConnector.run({ kind: 'company', value: 'Nikola Corporation', template: 'dockets.company' }, ctxFor(milton()));
    expect(calls).toHaveLength(1);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
  });

  test('the source failing rejects', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    fakeNet([['courtlistener.com', { __status: 500 }]]);
    await expect(courtDocketsConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'dockets.party' }, ctxFor(milton()))).rejects.toThrow();
  });
});

describe('court-records-open (Internet Archive)', () => {
  test('person: a longer name is dropped, a bare-name case stays possible', async () => {
    fakeNet([['archive.org/advancedsearch.php', { response: { numFound: 3, docs: [
      { identifier: 'gov.uscourts.utb.1', title: 'In re: Trevor Milton Lund', court: 'utb' },
      { identifier: 'gov.uscourts.ord.2', title: 'Trevor Milton v. Acme Roofing LLC', court: 'ord', source_url: 'https://www.courtlistener.com/docket/222/1/milton-v-acme-roofing/' },
    ] } }]]);
    const out = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton()));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].url).toBe('https://www.courtlistener.com/docket/222/milton-v-acme-roofing/');
    expect(out.findings[0].title).toContain('US District Court, District of Oregon');
  });

  test('company: a case with the company as a party is a company record', async () => {
    fakeNet([['archive.org', { response: { numFound: 2, docs: [
      { identifier: 'gov.uscourts.azd.1382219', title: 'Milton v. Nikola Corporation', court: 'azd' },
      { identifier: 'gov.uscourts.nyed.5', title: 'Nikola Kasanin v. Jones', court: 'nyed' },
    ] } }]]);
    const out = await courtRecordsOpenConnector.run({ kind: 'company', value: 'Nikola Corporation' }, ctxFor(milton()));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('likely'); // the company given against exactly the surname
    expect(out.findings[0].url).toBe('https://archive.org/details/gov.uscourts.azd.1382219');
  });
});

describe('doj-press-releases', () => {
  const release = (over) => ({ title: 'Nikola Founder Trevor Milton Sentenced to Four Years for Securities Fraud', date: '1703116800', url: 'https://www.justice.gov/usao-sdny/pr/nikola-founder-trevor-milton-sentenced', teaser: 'Trevor Milton, 41, of Phoenix, Arizona, the founder of Nikola Corporation, was sentenced today to four years in prison.', body: '', number: '23-411', component: [{ name: 'USAO - New York, Southern' }], ...over });

  test('a release naming the person with the company is confirmed and high; age and home town are dropped', async () => {
    const calls = fakeNet([['justice.gov/api/v1/press_releases.json', { metadata: { resultset: { count: 1 } }, results: [release()] }]]);
    const out = await dojConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'title.name' }, ctxFor(milton()));
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0].url)).toContain('parameters[title]=Trevor Milton');
    const f = out.findings[0];
    expect(f).toEqual(expect.objectContaining({ category: 'regulatory', severity: 'high', match: 'confirmed', date: '2023-12-21' }));
    expect(f.quote).not.toMatch(/41|Phoenix/);
    expect(f.quote).toContain('Trevor Milton');
  });

  test('a release about "Trevor Milton Lund" is not the subject', async () => {
    fakeNet([['justice.gov', { metadata: { resultset: { count: 1 } }, results: [release({ title: 'Utah Man Pleads Guilty to Bank Fraud', teaser: 'Trevor Milton Lund pleaded guilty today to bank fraud charges in federal court.', url: 'https://www.justice.gov/usao-ut/pr/utah-man' })] }]]);
    const out = await dojConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'title.name' }, ctxFor(miltonNoCompany()));
    expect(out.findings).toHaveLength(0);
  });

  test('name only stays possible', async () => {
    fakeNet([['justice.gov', { metadata: { resultset: { count: 1 } }, results: [release({ title: 'Trevor Milton Charged With Wire Fraud', teaser: 'Trevor Milton was charged today with wire fraud in a scheme involving a roofing business.', url: 'https://www.justice.gov/usao-or/pr/x' })] }]]);
    const out = await dojConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'title.name' }, ctxFor(miltonNoCompany()));
    expect(out.findings[0].match).toBe('possible');
  });

  test('associate: only releases naming the associate together with the subject or the company', async () => {
    fakeNet([['justice.gov', { metadata: { resultset: { count: 2 } }, results: [
      release({ title: 'Mark Russell Indicted', teaser: 'Mark Russell was indicted for tax evasion unrelated to any company.', url: 'https://www.justice.gov/a' }),
      release({ title: 'Nikola Executives Charged', teaser: 'Mark Russell, a former president of Nikola Corporation, was charged alongside Trevor Milton.', url: 'https://www.justice.gov/b' }),
    ] }]]);
    const out = await dojConnector.run({ kind: 'associate', value: 'Mark Russell', template: 'title.associate' }, ctxFor(milton()));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].title).toMatch(/^Associate Mark Russell: /);
    expect(out.findings[0].url).toBe('https://www.justice.gov/b');
  });

  test('an unfiltered answer is never read as a match', async () => {
    fakeNet([['justice.gov', { metadata: { resultset: { count: 250000 } }, results: [release()] }]]);
    const out = await dojConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'title.name' }, ctxFor(milton()));
    expect(out.findings).toHaveLength(0);
    expect(out.notes.join(' ')).toMatch(/could not be narrowed/);
  });
});

describe('finra-brokercheck', () => {
  const hit = { ind_source_id: '6204362', ind_firstname: 'SAMUEL', ind_middlename: 'BENJAMIN', ind_lastname: 'BANKMAN-FRIED', ind_other_names: [], ind_bc_scope: 'InActive', ind_ia_scope: 'NotInScope', ind_bc_disclosure_fl: 'Y' };
  const namesake = { ind_source_id: '999', ind_firstname: 'SAMUEL', ind_middlename: '', ind_lastname: 'FRIED', ind_bc_scope: 'Active', ind_ia_scope: 'NotInScope' };
  const detail = (over = {}) => ({ hits: { hits: [{ _source: { content: JSON.stringify({
    basicInformation: { firstName: 'SAMUEL', middleName: 'BENJAMIN', lastName: 'BANKMAN-FRIED', otherNames: [], ...over.basic },
    currentEmployments: [],
    previousEmployments: [{ firmName: 'JANE STREET CAPITAL, LLC', registrationBeginDate: '7/15/2014', registrationEndDate: '10/2/2017' }],
    disclosures: over.disclosures || [{ eventDate: '12/13/2022', disclosureType: 'Civil', disclosureResolution: 'Pending', disclosureDetail: { 'Initiated By': 'UNITED STATES SECURITIES AND EXCHANGE COMMISSION', Allegations: 'Bankman-Fried engaged in a scheme to defraud equity investors in FTX Trading Ltd.' } }],
  }) } }] } });

  const routes = (d) => [
    ['brokercheck.finra.org/search/individual/6204362', d],
    ['brokercheck.finra.org/search/individual?', { hits: { total: 2, hits: [{ _source: hit }, { _source: namesake }] } }],
    ['adviserinfo.sec.gov/search/individual?', { hits: { total: 0, hits: [] } }],
  ];

  // The register lists him as SAMUEL BENJAMIN BANKMAN-FRIED, a diminutive away from the name typed (Sam): with the
  // company in the record it is held at likely (round 4, sources-official-sec-nickname-prefix), never confirmed.
  test('a disclosure is medium; under the formal first name it is never confirmed', async () => {
    const calls = fakeNet(routes(detail()));
    const out = await brokerCheckConnector.run({ kind: 'subject', value: 'Sam Bankman-Fried' }, ctxFor(createSubject({ name: 'Sam Bankman-Fried', company: 'FTX' })));
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toEqual(expect.objectContaining({ category: 'regulatory', severity: 'medium', url: 'https://brokercheck.finra.org/individual/summary/6204362', date: '2022-12-13' }));
    // Never confirmed under the formal first name; how far below is the shared grader's call (the allegation names
    // FTX beside the surname only), and the firms are trusted threads only when the record is tied.
    expect(['likely', 'possible']).toContain(f.match);
    expect(f.quote).toContain('Jane Street Capital, LLC (2014-07-15 to 2017-10-02)');
    expect(f.data).toEqual(expect.objectContaining({ crd: '6204362', disclosures: 1, bar: false }));
    if (f.match === 'likely') expect(out.threads).toEqual([expect.objectContaining({ kind: 'company', value: 'Jane Street Capital, LLC', trusted: true })]);
  });

  test('name only stays possible and gives no threads; a bar is high', async () => {
    fakeNet(routes(detail({ basic: { sanctions: { permanentBar: 'Y', sanctionDetails: [{ category: 'BAR', regulator: 'SEC' }] } }, disclosures: [{ eventDate: '6/16/2009', disclosureType: 'Regulatory', disclosureDetail: { 'Initiated By': 'SEC', Allegations: 'Fraud.' } }] })));
    const out = await brokerCheckConnector.run({ kind: 'subject', value: 'Sam Bankman-Fried' }, ctxFor(createSubject({ name: 'Sam Bankman-Fried' })));
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].severity).toBe('high');
    expect(out.threads).toHaveLength(0);
  });

  test('a known firm on the record: never confirmed when listed under the formal first name', async () => {
    fakeNet(routes(detail({ disclosures: [] })));
    const subject = createSubject({ name: 'Sam Bankman-Fried' });
    addAnchor(subject, 'companies', 'Jane Street', 'found');
    const out = await brokerCheckConnector.run({ kind: 'subject', value: 'Sam Bankman-Fried' }, ctxFor(subject));
    expect(['likely', 'possible']).toContain(out.findings[0].match);
    expect(out.findings[0].severity).toBe('info');
  });

  test('the search failing rejects', async () => {
    fakeNet([['brokercheck.finra.org', { __status: 500 }]]);
    await expect(brokerCheckConnector.run({ kind: 'subject', value: 'Sam Bankman-Fried' }, ctxFor(createSubject({ name: 'Sam Bankman-Fried' })))).rejects.toThrow();
  });
});

describe('uk-gazette', () => {
  const notice = (over) => ({ id: 'https://www.thegazette.co.uk/id/notice/2608653', 'f:notice-code': '2441', title: 'SWISS ROCK LIMITED', published: '2016-09-08T14:39:59', category: { '@term': 'Resolutions for Winding-up' }, content: '<div><p>SWISS ROCK LIMITED (Company Number 08871074 ) Previous Name of Company: Swiss Rock plc Registered office: 26-28 Bedford Row, London WC1R 4HE Principal trading…</p></div>', ...over });
  const personal = notice({ id: 'https://www.thegazette.co.uk/id/notice/2298878', 'f:notice-code': '2511', title: 'Dominic Chappell', content: '<p>Dominic Chappell, born 1 January 1967, of 1 Home Street, Sometown, bankruptcy order</p>' });

  test('company notices: address cut, personal notices never read', async () => {
    fakeNet([['thegazette.co.uk/insolvency/notice/data.json', { 'f:total': 2, entry: [notice(), personal] }]]);
    const out = await ukGazetteConnector.run({ kind: 'company', value: 'Swiss Rock Limited' }, ctxFor(createSubject({ name: 'Dominic Chappell', company: 'Swiss Rock' })));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toEqual(expect.objectContaining({ match: 'company', severity: 'medium', url: 'https://www.thegazette.co.uk/notice/2608653', date: '2016-09-08' }));
    expect(f.quote).toContain('Company Number 08871074');
    expect(f.quote).not.toMatch(/Bedford Row|WC1R/);
    expect(JSON.stringify(out)).not.toMatch(/Home Street|born/);
  });

  test('a person is searched only with a known company, and then confirmed', async () => {
    let calls = fakeNet([['thegazette.co.uk', { 'f:total': 0 }]]);
    const none = await ukGazetteConnector.run({ kind: 'subject', value: 'Dominic Chappell' }, ctxFor(createSubject({ name: 'Dominic Chappell' })));
    expect(calls).toHaveLength(0);
    expect(none.findings).toHaveLength(0);
    calls = fakeNet([['thegazette.co.uk', { 'f:total': 2, entry: [notice(), personal] }]]);
    const out = await ukGazetteConnector.run({ kind: 'subject', value: 'Dominic Chappell' }, ctxFor(createSubject({ name: 'Dominic Chappell', company: 'Swiss Rock' })));
    expect(decodeURIComponent(calls[0].url)).toContain('text="Dominic Chappell" "Swiss Rock"');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('confirmed');
  });
});

describe('uk-case-law', () => {
  const feed = (entries) => `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:tna="https://caselaw.nationalarchives.gov.uk"><title>x</title>${entries.map((e) => `<entry><title>${e.title}</title><link href="${e.url}" rel="alternate"/><published>${e.date}T00:00:00+00:00</published><author><name>${e.court}</name></author><summary type="html"/><link href="${e.url}/data.xml" rel="alternate" type="application/akn+xml"/><tna:identifier slug="x" type="ukncn">${e.cite}</tna:identifier></entry>`).join('')}</feed>`;
  const lynchUs = { title: 'Michael Lynch v Government of the United States of America', url: 'https://caselaw.nationalarchives.gov.uk/ewhc/admin/2023/876', date: '2023-04-21', court: "High Court (King's Bench Division)", cite: '[2023] EWHC 876 (Admin)' };
  const acl = { title: 'ACL Netherlands B.V. (as successor to Autonomy Corporation Limited) &amp; Ors v Michael Richard Lynch &amp; Anor', url: 'https://caselaw.nationalarchives.gov.uk/ewhc/ch/2025/1171', date: '2025-05-14', court: 'High Court (Business and Property Courts)', cite: '[2025] EWHC 1171 (Ch)' };
  const family = { title: 'Michael Lynch v Sarah Lynch', url: 'https://caselaw.nationalarchives.gov.uk/ewfc/2024/1', date: '2024-01-01', court: 'Family Court', cite: '[2024] EWFC 1' };
  const other = { title: 'Lynch v Jones', url: 'https://caselaw.nationalarchives.gov.uk/ewhc/qb/2020/2', date: '2020-01-01', court: 'High Court', cite: '[2020] EWHC 2 (QB)' };

  test('person: with the company confirmed, name only possible, family courts left out', async () => {
    fakeNet([['caselaw.nationalarchives.gov.uk/atom.xml', (url) => (decodeURIComponent(url).includes('"Autonomy"') ? feed([lynchUs]) : feed([lynchUs, acl, family, other]))]]);
    const out = await ukCaseLawConnector.run({ kind: 'subject', value: 'Michael Lynch' }, ctxFor(createSubject({ name: 'Michael Lynch', company: 'Autonomy' })));
    const byUrl = Object.fromEntries(out.findings.map((f) => [f.url, f]));
    expect(byUrl[lynchUs.url].match).toBe('confirmed');
    expect(byUrl[lynchUs.url].data).toEqual({ caseNumber: '[2023] EWHC 876 (Admin)', court: "High Court (King's Bench Division)" });
    expect(byUrl[acl.url].match).toBe('confirmed'); // "Autonomy Corporation" is in the case title
    expect(byUrl[family.url]).toBeUndefined();
    expect(byUrl[other.url]).toBeUndefined();
    expect(out.notes.join(' ')).toMatch(/family, immigration or employment/);
  });

  test('company: a judgment with the company as a party', async () => {
    fakeNet([['caselaw.nationalarchives.gov.uk', feed([acl, other])]]);
    const out = await ukCaseLawConnector.run({ kind: 'company', value: 'Autonomy Corporation' }, ctxFor(createSubject({ name: 'Sushovan Hussain', company: 'Autonomy' })));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
    expect(out.findings[0].date).toBe('2025-05-14');
  });

  test('a non-feed answer rejects', async () => {
    fakeNet([['caselaw.nationalarchives.gov.uk', '<html>maintenance</html>']]);
    await expect(ukCaseLawConnector.run({ kind: 'company', value: 'Autonomy' }, ctxFor(createSubject({ name: 'Michael Lynch' })))).rejects.toThrow();
  });
});

describe('fr-bodacc', () => {
  const gleif = { data: [{ attributes: { entity: { legalName: { name: 'YNSECT' }, registeredAs: '534948617', legalAddress: { country: 'FR' } } } }] };
  const records = { total_count: 2, results: [
    { id: 'A202502383204', publicationavis: 'A', parution: '20250238', dateparution: '2025-12-11', numeroannonce: 3204, familleavis_lib: 'Procédures collectives', typeavis_lib: 'Avis initial', commercant: 'YNSECT', registre: ['534948617', '534 948 617'], tribunal: "Greffe du Tribunal de Commerce d'Evry", pdf_parution_subfolder: 1, ispdf_unitaire: 'oui',
      jugement: JSON.stringify({ nature: 'Jugement de conversion en liquidation judiciaire', date: '2025-12-01', complementJugement: 'désignant liquidateur Me X 1 Rue des Mazières 91000 Evry' }),
      listepersonnes: JSON.stringify({ personne: { typePersonne: 'pm', denomination: 'YNSECT' } }) },
    { id: 'A2', publicationavis: 'A', parution: '20250100', dateparution: '2025-01-01', numeroannonce: 1, familleavis_lib: 'Procédures collectives', commercant: 'DUPONT JEAN', registre: ['534948617'], ispdf_unitaire: 'oui', pdf_parution_subfolder: 1,
      listepersonnes: JSON.stringify({ personne: { typePersonne: 'pp', nom: 'Dupont' } }) },
  ] };

  test('insolvency notices for the French company, by SIREN, with a per-notice address and no addresses quoted', async () => {
    const calls = fakeNet([['api.gleif.org', gleif], ['bodacc-datadila.opendatasoft.com', records]]);
    const out = await bodaccConnector.run({ kind: 'company', value: 'Ynsect' }, ctxFor(createSubject({ name: 'Antoine Hubert', company: 'Ynsect' })));
    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls[1].url)).toContain('registre:"534948617"');
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toEqual(expect.objectContaining({ match: 'company', severity: 'medium', category: 'corporate', date: '2025-12-11' }));
    expect(f.url).toBe('https://www.bodacc.fr/telechargements/COMMERCIALES/PDF/A/2025/20250238/1/BODACC_A_PDF_Unitaire_20250238_03204.pdf');
    expect(f.quote).toContain('liquidation judiciaire');
    expect(f.quote).not.toMatch(/Mazières|91000/);
  });

  test('a company not in the French register is not searched', async () => {
    const calls = fakeNet([['api.gleif.org', { data: [] }], ['recherche-entreprises.api.gouv.fr', { results: [] }]]);
    const out = await bodaccConnector.run({ kind: 'company', value: 'Nikola' }, ctxFor(milton()));
    // R3: the French company register is asked after the LEI register; the bulletin itself is never asked.
    expect(calls.some((c) => c.url.includes('recherche-entreprises'))).toBe(true);
    expect(calls.every((c) => !c.url.includes('bodacc'))).toBe(true);
    expect(out.partial).toBeUndefined();
    expect(out.findings).toHaveLength(0);
  });
});

describe('us-enforcement-actions', () => {
  const cftc = (rows) => `<table><tbody>${rows.map(([d, href, t]) => `<tr><td><time datetime="${d}">x</time></td><td><a href="${href}">${t}</a> , 1</td></tr>`).join('')}</tbody></table>`;
  test('person: titles naming them; the company in the title confirms', async () => {
    fakeNet([['cftc.gov/PressRoom/PressReleases', cftc([
      ['2022-12-21T17:45:38Z', '/PressRoom/PressReleases/8644-22', 'CFTC Charges Alameda CEO and Alameda and FTX Co-Founder with Fraud in Action Against Sam Bankman-Fried and his Companies'],
      ['2023-01-01T00:00:00Z', '/PressRoom/PressReleases/1-23', 'CFTC Releases Annual Enforcement Results'],
    ])]]);
    const out = await enforcementActionsConnector.run({ kind: 'subject', value: 'Sam Bankman-Fried' }, ctxFor(createSubject({ name: 'Sam Bankman-Fried', company: 'FTX' })));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toEqual(expect.objectContaining({ match: 'confirmed', severity: 'medium', date: '2022-12-21', url: 'https://www.cftc.gov/PressRoom/PressReleases/8644-22' }));
  });

  test('company: CFPB actions with the company in the title only', async () => {
    const cfpb = '<article class="o-post-preview"><time datetime="2025-01-16T00:00:00">x</time><h3><a href="/enforcement/actions/block-inc/">Block, Inc.</a></h3><div class="o-post-preview__description">On January 16, 2025, the Bureau issued an order against Block, Inc.</div></article><article class="o-post-preview"><h3><a href="/enforcement/actions/equifax/">Equifax, Inc.</a></h3></article>';
    fakeNet([['cftc.gov', '<div class="view-empty">No results found</div>'], ['consumerfinance.gov', cfpb]]);
    const out = await enforcementActionsConnector.run({ kind: 'company', value: 'Block, Inc.' }, ctxFor(createSubject({ name: 'Jack Dorsey', company: 'Block' })));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toEqual(expect.objectContaining({ match: 'company', severity: 'medium', url: 'https://www.consumerfinance.gov/enforcement/actions/block-inc/' }));
  });
});
