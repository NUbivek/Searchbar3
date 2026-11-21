/**
 * Round 3 (audit 2026-11-20) fixes in courts.js and courtsMore.js, with the network faked:
 * private matters on dockets, "In re X Securities Litigation" captions, one-word companies in
 * headlines, the criminal label, honest partial results, every known name of the company
 * (design decision 1), middle names in searches, the Form ADV firm record, the Delaware archive,
 * the French company number, the parallel SEC case and the CourtListener fallback.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, addCompanyAlias, addRoleAnchor } = require('../../../src/server/founder/identity');
const courts = require('../../../src/server/founder/sources/courts');
const more = require('../../../src/server/founder/sources/courtsMore');

const {
  courtDocketsConnector, courtRecordsOpenConnector, dojConnector, brokerCheckConnector, ukGazetteConnector,
  bodaccConnector, enforcementActionsConnector, caseParties, partyIsCompany, isCriminalCase, PRIVATE_MATTER,
  companyNames, partyIsKnownCompany, __resetCourtsForTests,
} = courts;
const { delawareCourtsConnector, federalRegisterActionsConnector, __resetCourtsMoreForTests } = more;

const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ctxFor = (subject, findings = []) => ({ subject, deadline: Date.now() + 30000, known: () => ({}), findings: () => findings });
/** Route by a function of the URL; undefined is a 404; { __status } any status. Records decoded URLs. */
function fakeNet(route) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(decodeURIComponent(url));
    const out = route(url, decodeURIComponent(url));
    if (out && out.__status) return respond(out.body || '', out.__status);
    return out === undefined ? respond('not found', 404) : respond(out);
  });
  return calls;
}
const milton = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const holmes = () => createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
/** Ramp, typed as one ordinary word, with its legal name learned from a record tied to the person. */
const ramp = () => {
  const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
  addCompanyAlias(s, { company: 'Ramp', alias: 'Ramp Business Corporation', origin: 'form-d-1' });
  return s;
};
const thisYear = new Date().getUTCFullYear();

beforeEach(() => { __resetCourtsForTests(); __resetCourtsMoreForTests(); });
afterEach(() => {
  setTransport();
  delete process.env.COURTLISTENER_API_TOKEN;
});

/* ------------------------------------------------------------------ privacy-court-nature-of-suit */

describe('private matters on dockets', () => {
  test('one shared list covers disability benefits, prisoners and malpractice', () => {
    expect(PRIVATE_MATTER.test('Milton v. Commissioner of Social Security')).toBe(true);
    expect(PRIVATE_MATTER.test('Nature of suit: 863 Social Security: DIWC/DIWW')).toBe(true);
    expect(PRIVATE_MATTER.test('a medical malpractice claim')).toBe(true);
    expect(more.PRIVATE_MATTER).toBe(PRIVATE_MATTER);
    expect(PRIVATE_MATTER.test('Nikola Corporation v. Milton')).toBe(false);
  });

  test('CourtListener: benefits, prisoner and minor-caption dockets are dropped; parties are only the person and their companies', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    const base = { court: 'District Court, D. Arizona', court_id: 'azd', dateFiled: '2020-01-01' };
    fakeNet(() => ({ count: 4, results: [
      { ...base, caseName: 'Milton v. Commissioner of Social Security', docketNumber: '2:20-cv-1', docket_absolute_url: '/docket/1/a/', party: ['Trevor Milton', 'Commissioner of Social Security'], suitNature: '863 Social Security: DIWC/DIWW' },
      { ...base, caseName: 'Milton v. Warden', docketNumber: '2:20-cv-2', docket_absolute_url: '/docket/2/b/', party: ['Trevor Milton', 'Warden'], suitNature: '530 Habeas Corpus (General)' },
      { ...base, caseName: 'J.M., a minor, by her next friend v. Trevor Milton', docketNumber: '2:20-cv-3', docket_absolute_url: '/docket/3/c/', party: ['Trevor Milton'], suitNature: '360 P.I.: Other' },
      { ...base, caseName: 'Doe v. Nikola Corporation', docketNumber: '2:20-cv-4', docket_absolute_url: '/docket/4/d/', party: ['Jane Doe', 'Richard Roe', 'Nikola Corporation', 'Trevor Milton'], suitNature: '850 Securities/Commodities' },
    ] }));
    const out = await courtDocketsConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'dockets.party' }, ctxFor(milton()));
    expect(out.findings.map((f) => f.title.split(' (')[0])).toEqual(['Doe v. Nikola Corporation']);
    expect(out.findings[0].quote).toContain('Parties include: Nikola Corporation; Trevor Milton; and 2 other parties.');
    expect(out.findings[0].quote).not.toMatch(/Jane Doe|Richard Roe/);
    expect(out.notes.join(' ')).toMatch(/never reported/);
  });

  test('a malpractice suit against the company itself is kept on the company path', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    fakeNet(() => ({ count: 1, results: [{ caseName: 'Doe v. Theranos, Inc.', docketNumber: '5:16-cv-1', court: 'District Court, N.D. California', court_id: 'cand', dateFiled: '2016-01-01', docket_absolute_url: '/docket/5/e/', party: ['Jane Doe', 'Theranos, Inc.'], suitNature: '362 Personal Inj. Med. Malpractice' }] }));
    const out = await courtDocketsConnector.run({ kind: 'company', value: 'Theranos', template: 'dockets.company' }, ctxFor(holmes()));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
  });

  test('archive titles with a minor or a benefits claim are dropped', async () => {
    fakeNet(() => ({ response: { numFound: 2, docs: [
      { identifier: 'gov.uscourts.azd.1', title: 'Trevor Milton v. Commissioner of Social Security', court: 'azd' },
      { identifier: 'gov.uscourts.azd.2', title: 'A.B., a minor, by and through her mother v. Trevor Milton', court: 'azd' },
    ] } }));
    const out = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton()));
    expect(out.findings).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ courts-inre-captions */

describe('"In re X Securities Litigation" captions', () => {
  test('the company is the party, with the descriptor stripped', () => {
    expect(caseParties('In re Nikola Corporation Securities Litigation').sides).toEqual(['Nikola Corporation']);
    expect(caseParties('In re Nikola Corporation Derivative Litigation').sides).toEqual(['Nikola Corporation']);
    expect(caseParties('In Re Tesla Motors, Inc. Stockholder Litigation').sides).toEqual(['Tesla Motors, Inc.']);
    expect(caseParties("In re Theranos, Inc. Shareholders' Litigation").sides).toEqual(['Theranos, Inc.']);
    expect(partyIsCompany(caseParties('In re Nikola Corporation Securities Litigation').sides[0], 'Nikola')).toBe(true);
    // Only after "In re": a real party named "... Litigation Trust" stays whole.
    expect(caseParties('Acme Litigation Trust v. Roe').sides[0]).toBe('Acme Litigation Trust');
  });

  test('the archive keeps the class action as a company record', async () => {
    fakeNet(() => ({ response: { numFound: 1, docs: [{ identifier: 'gov.uscourts.azd.9', title: 'In re Nikola Corporation Securities Litigation', court: 'azd' }] } }));
    const out = await courtRecordsOpenConnector.run({ kind: 'company', value: 'Nikola' }, ctxFor(milton()));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
  });
});

/* ------------------------------------------------------------------ courts-doj-oneword-company */

describe('one-word companies in DOJ and CFTC headlines', () => {
  const rel = (title, body, n) => ({ title, url: `https://www.justice.gov/rel/${n}`, date: '1528934400', teaser: '', body });
  test('a headline naming Theranos is kept when the release names the person, or the company with its legal form', async () => {
    fakeNet(() => ({ metadata: { resultset: { count: 3 } }, results: [
      rel('Theranos Founder and Former Chief Operating Officer Charged In Alleged Wire Fraud Schemes', '<p>Elizabeth Holmes and Ramesh Balwani were charged with wire fraud.</p>', 1),
      rel('U.S. Government Seeks Information From Victims Of Theranos Frauds', '<p>Theranos, Inc. was a company in Palo Alto. Victims may contact the office.</p>', 2),
      rel('Theranos Lecture Series Announced', '<p>A lecture about startups.</p>', 3),
    ] }));
    const out = await dojConnector.run({ kind: 'company', value: 'Theranos', template: 'title.company' }, ctxFor(holmes()));
    const byUrl = Object.fromEntries(out.findings.map((f) => [f.url.split('/').pop(), f]));
    expect(Object.keys(byUrl).sort()).toEqual(['1', '2']);
    expect(byUrl['1'].match).not.toBe('company');
    expect(byUrl['2'].match).toBe('company');
  });

  test('CFTC: "Judgment Against FTX" is kept as possible (no legal form to tell it apart)', async () => {
    const cftc = '<table><tbody><tr><td><time datetime="2024-08-08T00:00:00Z">x</time></td><td><a href="/PressRoom/PressReleases/8938-24">Federal Court Enters Judgment Against FTX and Alameda</a></td></tr></tbody></table>';
    fakeNet((url) => (url.includes('cftc.gov') ? cftc : url.includes('consumerfinance.gov') ? '<p>There are no results based on your filter selections.</p>' : undefined));
    const out = await enforcementActionsConnector.run({ kind: 'company', value: 'FTX' }, ctxFor(createSubject({ name: 'Sam Bankman-Fried', company: 'FTX' })));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
  });

  test('"Block Grant Fraud" is still not Block', async () => {
    fakeNet(() => ({ metadata: { resultset: { count: 1 } }, results: [rel('Block Grant Fraud Scheme Leads to Charges', '<p>A man stole block grant funds.</p>', 4)] }));
    const out = await dojConnector.run({ kind: 'company', value: 'Block', template: 'title.company' }, ctxFor(createSubject({ name: 'Jack Dorsey', company: 'Block' })));
    expect(out.findings).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ courts-criminal-label */

describe('the criminal label', () => {
  test('only a government as the whole first side is a prosecution', () => {
    expect(isCriminalCase('State Farm Fire and Casualty Company v. Trevor Milton')).toBe(false);
    expect(isCriminalCase("People's United Bank v. Trevor Milton")).toBe(false);
    expect(isCriminalCase('United States Commodity Futures Trading Commission v. Trevor Milton')).toBe(false);
    expect(isCriminalCase('SEC v. Milton')).toBe(false);
    expect(isCriminalCase('United States v. Milton')).toBe(true);
    expect(isCriminalCase('U.S. v. Milton')).toBe(true);
    expect(isCriminalCase('People v. Holmes')).toBe(true);
    expect(isCriminalCase('People of the State of California v. Holmes')).toBe(true);
    expect(isCriminalCase('State v. Holmes')).toBe(true);
    expect(isCriminalCase('State of Delaware v. Holmes')).toBe(true);
    expect(isCriminalCase('Commonwealth of Pennsylvania v. Holmes')).toBe(true);
  });

  test('an insurer\'s suit in the archive is medium, not high', async () => {
    fakeNet(() => ({ response: { numFound: 1, docs: [{ identifier: 'gov.uscourts.azd.7', title: 'State Farm Fire and Casualty Company v. Trevor Milton', court: 'azd' }] } }));
    const out = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton()));
    expect(out.findings[0].severity).toBe('medium');
  });
});

/* ------------------------------------------------------------------ courts-iapd-silent-fail and BrokerCheck truncation */

describe('BrokerCheck', () => {
  const hit = (id, first, last, firm) => ({ _source: { ind_source_id: id, ind_firstname: first, ind_lastname: last, ind_bc_scope: 'Active', ind_ia_scope: 'NotInScope', ind_current_employments: firm ? [{ firm_name: firm }] : [] } });
  test('a failed SEC adviser search is partial, never "no registration"', async () => {
    fakeNet((url) => (url.includes('api.brokercheck.finra.org/search/individual?') ? { hits: { hits: [] } } : url.includes('adviserinfo') ? { __status: 500 } : undefined));
    const out = await brokerCheckConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton()));
    expect(out.partial).toEqual(['SEC adviser records (did not answer)']);
    expect(out.notes.join(' ')).not.toMatch(/No broker or investment adviser registration/);
  });

  test('more than two namesakes: the ones at a known company are read first, and the rest is partial', async () => {
    const hits = [hit('1', 'Trevor', 'Milton', 'Acme Securities'), hit('2', 'Trevor', 'Milton', 'Beta Brokers'), hit('3', 'Trevor', 'Milton', 'Nikola Corporation'), hit('4', 'Trevor', 'Milton', '')];
    const calls = fakeNet((url) => (/search\/individual\?/.test(url) ? { hits: { hits: url.includes('finra') ? hits : [] } } : { hits: { hits: [] } }));
    const out = await brokerCheckConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton()));
    expect(out.partial).toEqual(['Broker and adviser registrations (2 of 4 people with the name read)']);
    expect(calls.some((u) => /search\/individual\/3\b/.test(u))).toBe(true);
  });
});

/* ------------------------------------------------------------------ sec-adv-firm */

describe('Form ADV firm record', () => {
  const firmHits = { hits: { hits: [{ _source: { firm_source_id: '304525', firm_name: 'MILTON CAPITAL', firm_other_names: ['MILTON CAPITAL', 'MILTON CAPITAL MANAGEMENT LLC'], firm_ia_scope: 'ACTIVE', firm_ia_disclosure_fl: 'Y', firm_ia_full_sec_number: '802-1', firm_ia_address_details: '{"officeAddress":{"street1":"1 Main St"}}' } }] } };
  test('is planned only for a fund or adviser tied to the person, never one found by name alone', () => {
    const s = createSubject({ name: 'Trevor Milton', company: 'Milton Capital' });
    expect(brokerCheckConnector.plan({ kind: 'company', value: 'Milton Capital' }, s).map((p) => p.template)).toEqual(['adviser.firm']);
    addAnchor(s, 'companies', 'Other Capital', 'found');
    expect(brokerCheckConnector.plan({ kind: 'company', value: 'Other Capital' }, s)).toEqual([]);
    expect(brokerCheckConnector.plan({ kind: 'company', value: 'Nikola' }, milton())).toEqual([]);
    expect(brokerCheckConnector.plan({ kind: 'subject', value: 'Trevor Milton' }, s).map((p) => p.template)).toEqual(['registrations.name']);
  });
  test('reports the firm\'s registration and disclosure flag as a company record, without the office address', async () => {
    const calls = fakeNet((url) => (url.includes('/search/firm?') ? firmHits : undefined));
    const out = await brokerCheckConnector.run({ kind: 'company', value: 'Milton Capital', template: 'adviser.firm' }, ctxFor(createSubject({ name: 'Trevor Milton', company: 'Milton Capital' })));
    expect(calls[0]).toContain('api.adviserinfo.sec.gov/search/firm');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toEqual(expect.objectContaining({ match: 'company', severity: 'medium', url: 'https://adviserinfo.sec.gov/firm/summary/304525' }));
    expect(JSON.stringify(out.findings[0])).not.toMatch(/Main St/);
  });
});

/* ------------------------------------------------------------------ courts-truncation-not-partial */

describe('truncated lists are partial', () => {
  test('DOJ pages on while time allows, then says how many were read', async () => {
    const calls = fakeNet((url) => {
      const page = Number((url.match(/[?&]page=(\d+)/) || [])[1] || 0);
      return { metadata: { resultset: { count: 120 } }, results: Array.from({ length: 25 }, (_, i) => ({ title: `Other Release ${page}-${i}`, url: `https://www.justice.gov/r/${page}-${i}`, date: '1600000000', teaser: '', body: '' })) };
    });
    const out = await dojConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'title.name' }, ctxFor(milton()));
    expect(calls.filter((u) => u.includes('justice.gov'))).toHaveLength(3);
    expect(out.partial).toEqual(['Justice Department releases for "Trevor Milton" (75 of 120 read)']);
  });

  test('CourtListener: more dockets than read is partial', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    fakeNet(() => ({ count: 400, results: [] }));
    const out = await courtDocketsConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'dockets.party' }, ctxFor(milton()));
    expect(out.partial).toEqual(['US federal court dockets (0 of about 400 read)']);
  });

  test('archive person search: more titles than read is partial', async () => {
    fakeNet(() => ({ response: { numFound: 250, docs: [] } }));
    const out = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton()));
    expect(out.partial).toEqual(['US federal case titles (0 of 250 read)']);
  });

  test('a failed charging-district search is partial', async () => {
    const charge = { source: 'doj-press-releases', match: 'confirmed', date: '2021-07-29', title: 'Trevor Milton Charged', quote: 'the Southern District of New York' };
    fakeNet((url, d) => (/court:/.test(d) ? { __status: 500 } : { response: { numFound: 0, docs: [] } }));
    const out = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton(), [charge]));
    expect(out.partial).toContain('US federal dockets in the charging district (did not answer)');
  });

  test('Gazette: more notices than read is partial', async () => {
    fakeNet(() => ({ 'f:total': 75, entry: [] }));
    const out = await ukGazetteConnector.run({ kind: 'company', value: 'Nikola Corporation' }, ctxFor(milton()));
    expect(out.partial).toEqual(['UK Gazette notices for Nikola Corporation (0 of 75 read)']);
  });
});

/* ------------------------------------------------------------------ design decision 1: every known name of the company */

describe('every known name of the company', () => {
  test('companyNames gives the typed name and learned legal names', () => {
    expect(companyNames(ramp(), 'Ramp')).toEqual({ names: ['Ramp', 'Ramp Business Corporation'], domains: [], legal: ['Ramp Business Corporation'] });
    expect(companyNames(milton(), 'Nikola').names).toEqual(['Nikola']);
  });

  test('a one-word ordinary company with a known legal name is matched by that name only', () => {
    expect(partyIsKnownCompany('Ramp Business Corporation', 'Ramp', ramp())).toBe(true);
    expect(partyIsKnownCompany('Ramp, Inc.', 'Ramp', ramp())).toBe(false);
    // Without a learned legal name the old rule stands.
    expect(partyIsKnownCompany('Ramp, Inc.', 'Ramp', createSubject({ name: 'Eric Glyman', company: 'Ramp' }))).toBe(true);
  });

  test('CourtListener searches the company under every name', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    const calls = fakeNet(() => ({ count: 2, results: [
      { caseName: 'Doe v. Ramp Business Corporation', docketNumber: '1:23-cv-1', court: 'District Court, S.D. New York', court_id: 'nysd', dateFiled: '2023-01-01', docket_absolute_url: '/docket/1/x/', party: ['Jane Doe', 'Ramp Business Corporation'] },
      { caseName: 'Roe v. Ramp, Inc.', docketNumber: '1:23-cv-2', court: 'District Court, D. Oregon', court_id: 'ord', dateFiled: '2023-01-01', docket_absolute_url: '/docket/2/y/', party: ['Richard Roe', 'Ramp, Inc.'] },
    ] }));
    const out = await courtDocketsConnector.run({ kind: 'company', value: 'Ramp', template: 'dockets.company' }, ctxFor(ramp()));
    expect(calls[0].replace(/\+/g, ' ')).toContain('party:("Ramp" OR "Ramp Business Corporation")');
    expect(out.findings.map((f) => f.title.split(' (')[0])).toEqual(['Doe v. Ramp Business Corporation']);
  });

  test('Delaware searches each quoted company name', async () => {
    const calls = fakeNet(() => '<p>There are no results for this search.</p>');
    await delawareCourtsConnector.run({ kind: 'company', value: 'Ramp', template: 'captions.company' }, ctxFor(ramp()));
    expect(calls.some((u) => u.endsWith('ss="Ramp Business"'))).toBe(true);
    expect(calls.some((u) => u.endsWith('ss="Ramp"'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ courts-quoted-fullname-misses-middle */

describe('records filed with a middle name are found', () => {
  test('Federal Register: each name as a phrase with words allowed between', async () => {
    const calls = fakeNet(() => ({ count: 1, results: [{ title: 'In the Matter of: Arthur Ching-Fu Gau, 8802 South Feliz Drive, Tempe, AZ 85284; Order Denying Export Privileges', abstract: '', html_url: 'https://www.federalregister.gov/d/1', publication_date: '2019-01-01', agencies: [{ slug: 'industry-and-security-bureau', name: 'Industry and Security Bureau' }] }] }));
    const out = await federalRegisterActionsConnector.run({ kind: 'subject', value: 'Arthur Gau', template: 'orders.name' }, ctxFor(createSubject({ name: 'Arthur Gau' })));
    expect(calls[0]).toContain('"Arthur Gau"~3');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].title).not.toMatch(/Feliz|85284/);
  });

  test('archive: given name AND surname, so "Elizabeth A Holmes" is found; "Mary Elizabeth Holmes" is not her', async () => {
    const calls = fakeNet(() => ({ response: { numFound: 2, docs: [
      { identifier: 'gov.uscourts.cand.1', title: 'Doe v. Elizabeth A Holmes', court: 'cand' },
      { identifier: 'gov.uscourts.cand.2', title: 'Roe v. Mary Elizabeth Holmes', court: 'cand' },
    ] } }));
    const out = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Elizabeth Holmes' }, ctxFor(holmes()));
    expect(calls[0]).toContain('title:("Elizabeth" AND "Holmes")');
    expect(out.findings.map((f) => f.title.split(' (')[0])).toEqual(['Doe v. Elizabeth A Holmes']);
  });

  test('CourtListener: the party search allows a middle name', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    const calls = fakeNet(() => ({ count: 0, results: [] }));
    await courtDocketsConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'dockets.party' }, ctxFor(milton()));
    expect(calls[0].replace(/\+/g, ' ')).toContain('party:"Trevor Milton"~3');
  });
});

/* ------------------------------------------------------------------ courts-delaware-or-substring and courts-delaware-12y */

describe('Delaware', () => {
  const page100 = `<table><thead><tr><th>Parties/Caption</th></tr></thead><tbody>${Array.from({ length: 100 }, (_, i) => `<tr><td><a href="/opinions/download.aspx?id=${9000 + i}">Richardson v. Zurich ${i}</a></td><td>01/02/${thisYear}</td><td>C.A. No. ${thisYear}-0${100 + i}</td><td>Court of Chancery</td><td>Civil</td><td>X</td><td>Opinion</td></tr>`).join('')}</tbody></table>`;
  test('a year capped by namesakes is searched again under the quoted full name, and stays partial', async () => {
    const calls = fakeNet((url, d) => (d.includes(`from=01/01/${thisYear}&`) && d.endsWith('ss="Tornetta"') ? page100 : '<p>no results</p>'));
    const out = await delawareCourtsConnector.run({ kind: 'subject', value: 'Richard Tornetta', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Richard Tornetta' })));
    expect(calls.some((u) => u.includes(`from=01/01/${thisYear}&`) && u.endsWith('ss="Richard Tornetta"'))).toBe(true);
    expect(out.partial).toEqual([`Delaware decisions ${thisYear} (first 100 read)`]);
  });

  test('years before the regular span are planned only when dated records show activity then, and every lookup says what it left out', async () => {
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    expect(delawareCourtsConnector.plan({ kind: 'subject', value: 'Jane Roe' }, s).map((p) => p.template)).not.toContain('captions.archive');
    addRoleAnchor(s, { org: 'Acme Robotics', role: 'ceo', from: '2008-03-01', origin: 'given' });
    expect(delawareCourtsConnector.plan({ kind: 'subject', value: 'Jane Roe' }, s).map((p) => p.template)).toContain('captions.archive');
    const calls = fakeNet(() => '<p>no results</p>');
    const out = await delawareCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'captions.archive' }, ctxFor(s));
    expect(calls[0]).toContain(`from=01/01/${thisYear - 12}&`);
    expect(calls[calls.length - 1]).toContain('from=01/01/2007&');
    expect(out.notes.join(' ')).toMatch(/from 2000 to 2006 were not searched/);
  });
});

/* ------------------------------------------------------------------ courts-bodacc-gleif */

describe('French company number for the bulletin', () => {
  const bodacc = { total_count: 0, results: [] };
  test('the French company register gives it when the LEI register has none', async () => {
    const calls = fakeNet((url) => (url.includes('api.gleif.org') ? { data: [] }
      : url.includes('recherche-entreprises') ? { results: [{ siren: '952418325', nom_raison_sociale: 'MISTRAL AI', nom_complet: 'MISTRAL AI', nature_juridique: '5710' }, { siren: '123456789', nom_raison_sociale: 'MISTRAL AIR', nature_juridique: '5499' }] }
        : url.includes('bodacc') ? bodacc : undefined));
    const out = await bodaccConnector.run({ kind: 'company', value: 'Mistral AI' }, ctxFor(createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' })));
    const asked = calls.find((u) => u.includes('bodacc'));
    expect(asked).toContain('registre:"952418325"');
    expect(asked).not.toContain('123456789');
    expect(out.notes.join(' ')).toMatch(/SIREN 952418325/);
  });

  test('a SIREN on a tied register record is used without asking any register', async () => {
    const tied = { source: 'fr-companies', match: 'company', title: 'French company record: MISTRAL AI', data: { company: 'MISTRAL AI', siren: '952418325' } };
    const s = createSubject({ name: 'Arthur Mensch', company: 'Mistral' });
    const calls = fakeNet((url) => (url.includes('bodacc') ? bodacc : undefined));
    await bodaccConnector.run({ kind: 'company', value: 'Mistral' }, ctxFor(s, [tied]));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('registre:"952418325"');
  });

  test('registers that do not answer make the lookup partial, not a clean "not French"', async () => {
    fakeNet(() => ({ __status: 500 }));
    const out = await bodaccConnector.run({ kind: 'company', value: 'Ynsect' }, ctxFor(createSubject({ name: 'Antoine Hubert', company: 'Ynsect' })));
    expect(out.partial).toEqual(['French bulletin (company number not found: a register did not answer)']);
  });
});

/* ------------------------------------------------------------------ courts-sec-cftc-dockets */

describe('the parallel SEC case in the charging district', () => {
  test('is reported as possible, medium, civil enforcement', async () => {
    const charge = { source: 'doj-press-releases', match: 'confirmed', date: '2021-07-29', title: 'Former Nikola Corporation CEO Trevor Milton Charged', quote: 'the United States Attorney for the Southern District of New York' };
    const calls = fakeNet((url, d) => ({ response: /court:/.test(d)
      ? { numFound: 1, docs: [{ identifier: 'gov.uscourts.nysd.564121', title: 'U.S. Securities and Exchange Commission v. Milton', court: 'nysd', publicdate: '2021-07-30T00:00:00Z' }] }
      : { numFound: 0, docs: [] } }));
    const out = await courtRecordsOpenConnector.run({ kind: 'subject', value: 'Trevor Milton' }, ctxFor(milton(), [charge]));
    expect(calls.some((u) => /Securities and Exchange Commission v\. Milton/.test(u))).toBe(true);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toEqual(expect.objectContaining({ match: 'possible', severity: 'medium' }));
    expect(out.findings[0].matchReasons[0]).toMatch(/civil enforcement/);
  });
});

/* ------------------------------------------------------------------ courts-cl-fallback */

describe('CourtListener busy', () => {
  test('a 429 falls back to the archive case titles, marked partial', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    const calls = fakeNet((url) => (url.includes('courtlistener.com/api') ? { __status: 429 } : url.includes('archive.org') ? { response: { numFound: 1, docs: [{ identifier: 'gov.uscourts.ord.2', title: 'Trevor Milton v. Acme Roofing LLC', court: 'ord' }] } } : undefined));
    const out = await courtDocketsConnector.run({ kind: 'subject', value: 'Trevor Milton', template: 'dockets.party' }, ctxFor(milton()));
    expect(calls.some((u) => u.includes('archive.org'))).toBe(true);
    expect(out.findings).toHaveLength(1);
    expect(out.partial).toContain('US federal court dockets (case titles only: the fuller docket search was busy)');
  });
});

/* ------------------------------------------------------------------ courts-cfpb-weak-check */

describe('CFPB', () => {
  test('a page without result cards or the empty-result wording is a failure, reported as partial', async () => {
    fakeNet((url) => (url.includes('cftc.gov') ? '<div class="view-empty">No results found</div>' : url.includes('consumerfinance.gov') ? '<html><body>Enforcement actions are temporarily unavailable</body></html>' : undefined));
    const out = await enforcementActionsConnector.run({ kind: 'company', value: 'Block, Inc.' }, ctxFor(createSubject({ name: 'Jack Dorsey', company: 'Block' })));
    expect(out.partial).toEqual(['CFPB enforcement actions (did not answer)']);
  });

  test('the person path asks the CFPB too', async () => {
    const cfpb = '<article class="o-post-preview"><time datetime="2023-01-01T00:00:00">x</time><h3><a href="/enforcement/actions/acme-and-jane-roe/">Acme Lending LLC and Jane Roe</a></h3><div class="o-post-preview__description">The Bureau filed a complaint.</div></article>';
    fakeNet((url) => (url.includes('cftc.gov') ? '<div class="view-empty">No results found</div>' : url.includes('consumerfinance.gov') ? cfpb : undefined));
    const out = await enforcementActionsConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(createSubject({ name: 'Jane Roe' })));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
  });
});
