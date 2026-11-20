/**
 * @jest-environment node
 *
 * More courts, trade cases and agency orders (courtsMore.js), with the
 * network faked from the shapes the real services returned on 2026-11-20.
 * What matters most: a record is tied to the person only by their full name,
 * a name-only match stays 'possible', a company record is graded 'company',
 * an empty answer is a clean empty result, and a failed answer is an error.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { THREAD_KINDS } = require('../../../src/server/founder/finding');
const more = require('../../../src/server/founder/sources/courtsMore');

const {
  delawareCourtsConnector, federalRegisterActionsConnector, euCourtsConnector, canadaFederalCourtsConnector,
  MORE_COURT_CONNECTORS, __resetCourtsMoreForTests, withoutAddress, euParties, euCase, textNamesCompany, companyCore,
} = more;

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/** Route fake responses by a test on the URL; record every call. */
function fakeNet(route) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    const out = route(url);
    if (out && out.__status) return respond(out.body || '', out.__status);
    return out === undefined ? respond('not found', 404) : respond(out);
  });
  return calls;
}

beforeEach(() => __resetCourtsMoreForTests());
afterEach(() => setTransport());

/* ------------------------------------------------------------------ the contract every source is held to */

describe('contract', () => {
  const BANNED = /\b(api|endpoint|api key|token|free|paid|tier|env)\b/i;
  test.each(MORE_COURT_CONNECTORS.map((c) => [c.id, c]))('%s obeys the source contract', (id, c) => {
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(id).toMatch(/^(delaware-courts|us-agency-orders|eu-courts|canada-federal-courts)$/);
    expect(c.label).not.toMatch(BANNED);
    expect(c.label.length).toBeGreaterThan(3);
    for (const kind of c.kinds) expect(['subject', ...THREAD_KINDS]).toContain(kind);
    // never a stand-alone lookup on a relative or associate
    expect(c.kinds).not.toContain('relative');
    expect(c.kinds).not.toContain('associate');
    expect(c.prior).toBeGreaterThan(0);
    expect(c.prior).toBeLessThanOrEqual(1);
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    for (const kind of c.kinds) {
      const plans = c.plan({ kind, value: kind === 'company' ? 'Theranos' : 'Elizabeth Holmes', depth: 1 }, subject);
      expect(plans.length).toBeGreaterThan(0);
      for (const p of plans) {
        expect(p.template).toMatch(/^[a-z0-9.:_-]+$/i);
        expect(p.template).not.toMatch(/holmes|theranos/i);
        expect(p.why).not.toMatch(BANNED);
      }
    }
  });
  test('ids are unique and every connector is exported by name', () => {
    const ids = MORE_COURT_CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(more).filter((k) => k.endsWith('Connector')).sort()).toEqual(['canadaFederalCourtsConnector', 'delawareCourtsConnector', 'euCourtsConnector', 'federalRegisterActionsConnector']);
  });
});

/* ------------------------------------------------------------------ 1. Delaware */

const deRow = ({ id, caption, date, file, court = 'Court of Chancery', type = 'Civil', officer = 'McCormick,<br/>\nC.', description = 'Memorandum Opinion' }) => `
  <tr>
    <td class="col-md-2 container-fluid">
      <a href="/opinions/download.aspx?id=${id}" class="courtsWrapCell" role="button">
        ${caption}
      </a>
    </td>
    <td class="col-md-1 container-fluid"><span class="courtsWrapCell">${date}</span></td>
    <td class="col-md-2 container-fluid"><span class="courtsWrapCell">${file}</span></td>
    <td class="col-md-1 container-fluid"><span class="courtsWrapCell">${court}</span></td>
    <td class="col-md-1 container-fluid"><span class="courtsWrapCell">${type}</span></td>
    <td class="col-md-1 container-fluid"><span class="courtsWrapCell">${officer}</span></td>
    <td class="col-md-4 container-fluid"><span class="courtsWrapCell">${description}</span></td>
  </tr>`;
const dePage = (rows) => `<!DOCTYPE html><html><body><form id="frmCourtOpinions">
  <table class="table table-responsive table-bordered table-striped courtsBR"><thead><tr>
    <th class="col-md-2" scope="col"><button class="sort-btn" aria-label="Sort by Parties/Caption" type="button"><span>Parties/Caption</span></button></th>
    <th>Date</th><th>File Number</th><th>Court</th><th>Type</th><th>Judicial Officer</th><th class="col-md-4" scope="col">Description</th>
  </tr></thead><tbody>${rows.join('')}</tbody></table></form></body></html>`;
const deEmpty = '<!DOCTYPE html><html><body><form id="frmCourtOpinions"><p>There are no results for this search.</p></form></body></html>';

const thisYear = new Date().getUTCFullYear();
const DE_ROWS = [
  deRow({ id: '338990', caption: 'Luigi Crispo v. Elon R. Musk, et al.', date: '10/13/2022', file: '2022-0666-KSJM', description: 'Letter to counsel' }),
  deRow({ id: '338960', caption: 'Luigi Crispo v. Elon R. Musk, et al.', date: '10/11/2022', file: 'C.A. No. 2022-0666-KSJM', description: 'Memorandum Opinion' }),
  deRow({ id: '338820', caption: 'Twitter, Inc. v. Elon R. Musk, et al.', date: '10/06/2022', file: 'C.A. No. 2022-0613-KSJM', description: 'Letter Decision Granting Stay' }),
  deRow({ id: '337001', caption: 'John Solak v. Twitter, Inc.', date: '05/02/2022', file: 'C.A. No. 2022-0390-KSJM', description: 'Order' }),
  // a longer name that contains the subject's: somebody else
  deRow({ id: '337002', caption: 'Elon Musk Smith v. Acme Roofing LLC', date: '04/02/2022', file: 'C.A. No. 2022-0200-LWW', court: 'Superior Court' }),
  // family matters are never read
  deRow({ id: '337003', caption: 'In re Guardianship of Elon Musk', date: '03/02/2022', file: 'CN22-01234', court: 'Court of Chancery' }),
  deRow({ id: '337004', caption: 'Maye Musk v. Elon Musk', date: '02/02/2022', file: 'CN22-0999', court: 'Family Court' }),
];

describe('delaware-courts', () => {
  const route = (url) => (url.includes('courts.delaware.gov') ? (url.includes(`from=01/01/${thisYear - 1}&`) ? dePage(DE_ROWS) : deEmpty) : undefined);

  test('searches each of the last five years with the given name and surname, one request per year', async () => {
    const calls = fakeNet(route);
    await delawareCourtsConnector.run({ kind: 'subject', value: 'Elon Musk', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Elon Musk' })));
    expect(calls).toHaveLength(5);
    expect(calls[0]).toContain('ss=Elon%20Musk');
    expect(calls[0]).toContain(`from=01/01/${thisYear}&to=12/31/${thisYear}`);
    expect(calls[4]).toContain(`from=01/01/${thisYear - 4}&`);
  });

  test('a case naming the person and their company is graded by the record, never by hand', async () => {
    fakeNet(route);
    const { findings } = await delawareCourtsConnector.run({ kind: 'subject', value: 'Elon Musk', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Elon Musk', company: 'Twitter' })));
    const twitter = findings.find((f) => /^Twitter, Inc\. v\. Elon R\. Musk/.test(f.title));
    expect(twitter).toBeDefined();
    expect(['confirmed', 'likely']).toContain(twitter.match);
    expect(twitter.matchFixed).toBeUndefined();
    expect(twitter.category).toBe('litigation');
    expect(twitter.url).toBe('https://courts.delaware.gov/opinions/download.aspx?id=338820');
    expect(twitter.title).toContain('Delaware Court of Chancery');
    expect(twitter.severity).toBe('medium');
  });

  test('a case naming the person only stays possible; the two decisions in one case become one record', async () => {
    fakeNet(route);
    const { findings, notes } = await delawareCourtsConnector.run({ kind: 'subject', value: 'Elon Musk', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Elon Musk' })));
    const crispo = findings.filter((f) => /Crispo/.test(f.title));
    expect(crispo).toHaveLength(1);
    expect(crispo[0].match).toBe('possible');
    expect(crispo[0].date).toBe('2022-10-13');
    expect(crispo[0].quote).toMatch(/2 published decisions/);
    // the longer name, the guardianship and the Family Court case are not reported
    expect(findings.some((f) => /Smith|Guardianship|Maye/.test(f.title))).toBe(false);
    expect(findings.every((f) => f.match !== 'confirmed')).toBe(true);
    expect(notes.join(' ')).toMatch(/Delaware decisions searched/);
  });

  test('a company search reports cases the company is a party to as company records', async () => {
    const calls = fakeNet(route);
    const { findings } = await delawareCourtsConnector.run({ kind: 'company', value: 'Twitter, Inc.', template: 'captions.company' }, ctxFor(createSubject({ name: 'Jack Dorsey', company: 'Twitter' })));
    expect(calls[0]).toMatch(/ss=Twitter$/);
    const solak = findings.find((f) => /Solak/.test(f.title));
    expect(solak.match).toBe('company');
    expect(solak.matchReasons[0]).toMatch(/Twitter, Inc\. is a party/);
  });

  test('an empty answer is an empty result, not an error', async () => {
    fakeNet((url) => (url.includes('courts.delaware.gov') ? deEmpty : undefined));
    const out = await delawareCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Jane Roe' })));
    expect(out.findings).toEqual([]);
  });

  test('a failed answer is an error, and a partly failed search says which years were missed', async () => {
    fakeNet((url) => (url.includes('courts.delaware.gov') ? { __status: 500 } : undefined));
    await expect(delawareCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Jane Roe' })))).rejects.toThrow(/HTTP 500/);
    fakeNet((url) => (url.includes(`from=01/01/${thisYear}&`) ? { __status: 500 } : deEmpty));
    const out = await delawareCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Jane Roe' })));
    expect(out.notes.join(' ')).toContain(`did not answer for ${thisYear}`);
  });

  test('a page that is not a result page is an error, never a clean result', async () => {
    fakeNet((url) => (url.includes('courts.delaware.gov') ? '<html><body>Service unavailable</body></html>' : undefined));
    await expect(delawareCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Jane Roe' })))).rejects.toThrow(/unexpected/);
  });

  test('only the company given or found first gets the slow company search', () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    expect(delawareCourtsConnector.plan({ kind: 'company', value: 'Other Co', depth: 3 }, subject)).toEqual([]);
    expect(delawareCourtsConnector.plan({ kind: 'company', value: 'Acme Robotics', depth: 3 }, subject)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ 2. Federal Register */

const agency = (slug, name) => ({ raw_name: name.toUpperCase(), name, id: 1, url: `https://www.federalregister.gov/agencies/${slug}`, json_url: '', parent_id: null, slug });
const THIES = {
  description: 'Documents matching \'"Jeffrey Thies"\'',
  count: 1,
  total_pages: 1,
  results: [{
    title: 'Jeffrey Thies: Final Debarment Order',
    abstract: 'The Food and Drug Administration (FDA or the Agency) is issuing an order under the Federal Food, Drug, and Cosmetic Act (FD&C Act) debarring Jeffrey Thies for a period of 10 years from importing or offering for import any drug into the United States. FDA bases this order on a finding that Mr. Thies was convicted of two felony counts under Federal law for trafficking in counterfeit goods and aiding and abetting.',
    html_url: 'https://www.federalregister.gov/documents/2026/09/25/2026-19655/jeffrey-thies-final-debarment-order',
    publication_date: '2026-09-25',
    excerpts: 'debarring <span class="match">Jeffrey Thies</span> for a period of 10 years from importing or offering for import any drug into the United States.',
    document_number: '2026-19655',
    type: 'Notice',
    agencies: [agency('health-and-human-services-department', 'Health and Human Services Department'), agency('food-and-drug-administration', 'Food and Drug Administration')],
  }, {
    title: 'In the Matter of: Jeffrey Thies Morgan, 8802 South Feliz Drive, Tempe, AZ 85284; Order Denying Export Privileges',
    abstract: '',
    html_url: 'https://www.federalregister.gov/documents/2025/12/17/2025-99999/in-the-matter-of-order-denying-export-privileges',
    publication_date: '2025-12-17',
    excerpts: 'In the Matter of: <span class="match">Jeffrey Thies</span> Morgan, an individual convicted of export violations.',
    document_number: '2025-99999',
    type: 'Notice',
    agencies: [agency('commerce-department', 'Commerce Department'), agency('industry-and-security-bureau', 'Industry and Security Bureau')],
  }, {
    title: 'Advisory Committee; Notice of Meeting',
    abstract: 'Jeffrey Thies will present to the committee.',
    html_url: 'https://www.federalregister.gov/documents/2024/01/01/2024-00001/advisory-committee-notice-of-meeting',
    publication_date: '2024-01-01',
    excerpts: '',
    document_number: '2024-00001',
    type: 'Notice',
    agencies: [agency('food-and-drug-administration', 'Food and Drug Administration')],
  }],
};
const ITC_APPLE = {
  description: 'Documents matching \'"Apple"\' and from International Trade Commission',
  count: 2,
  total_pages: 1,
  results: [{
    title: 'Notice of Receipt of Complaint; Solicitation of Comments Relating to the Public Interest',
    abstract: 'Notice is hereby given that the U.S. International Trade Commission has received a complaint entitled Certain Streaming Devices and Components Thereof, DN 3950; the Commission is soliciting comments on any public interest issues raised by the complaint.',
    html_url: 'https://www.federalregister.gov/documents/2026/11/13/2026-23178/notice-of-receipt-of-complaint-solicitation-of-comments-relating-to-the-public-interest',
    publication_date: '2026-11-13',
    excerpts: 'filed on behalf of Truesight Communications, LLC on November 9, 2026. The complaint alleges violations of <span class="match">section 337</span> of the Tariff Act of 1930 (19 U.S.C. 1337) in the importation into the United States of certain streaming devices and components thereof. The complaint names as a respondent: <span class="match">Apple. Inc</span>. of Cupertino, CA; ASUSTek Computer Inc. of Taiwan',
    document_number: '2026-23178',
    type: 'Notice',
    agencies: [agency('international-trade-commission', 'International Trade Commission')],
  }, {
    title: 'Certain Apple Juice Concentrate From China; Scheduling of a Review',
    abstract: 'The Commission scheduled a review of apple juice concentrate imports.',
    html_url: 'https://www.federalregister.gov/documents/2010/01/01/2010-00001/certain-apple-juice',
    publication_date: '2010-01-01',
    excerpts: 'imports of <span class="match">apple</span> juice concentrate',
    document_number: '2010-00001',
    type: 'Notice',
    agencies: [agency('international-trade-commission', 'International Trade Commission')],
  }],
};

describe('us-agency-orders (Federal Register)', () => {
  test('an order naming the person is graded by the record: name only stays possible; a longer name and a meeting notice are left out', async () => {
    const calls = fakeNet((url) => (url.includes('federalregister.gov/api/v1/documents.json') ? THIES : undefined));
    const { findings } = await federalRegisterActionsConnector.run({ kind: 'subject', value: 'Jeffrey Thies', template: 'orders.name' }, ctxFor(createSubject({ name: 'Jeffrey Thies' })));
    expect(decodeURIComponent(calls[0])).toContain('conditions[term]="Jeffrey Thies"');
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f.match).toBe('possible');
    expect(f.matchFixed).toBeUndefined();
    expect(f.severity).toBe('high');
    expect(f.category).toBe('regulatory');
    expect(f.title).toBe('Jeffrey Thies: Final Debarment Order (Food and Drug Administration, Federal Register 2026-09-25)');
  });

  test('a person with a company named in the order is raised by the grade, not by hand', async () => {
    const withCompany = JSON.parse(JSON.stringify(THIES));
    withCompany.results[0].abstract += ' Mr. Thies was the chief executive of Northwind Pharma LLC.';
    fakeNet((url) => (url.includes('federalregister.gov') ? withCompany : undefined));
    const { findings } = await federalRegisterActionsConnector.run({ kind: 'subject', value: 'Jeffrey Thies', template: 'orders.name' }, ctxFor(createSubject({ name: 'Jeffrey Thies', company: 'Northwind Pharma' })));
    expect(['confirmed', 'likely']).toContain(findings[0].match);
    expect(findings[0].matchFixed).toBeUndefined();
  });

  test('home addresses printed in export-ban titles are cut', () => {
    expect(withoutAddress('In the Matter of: Arthur Ching-Fu Gau, 8802 South Feliz Drive, Tempe, AZ 85284; Order Denying Export Privilege'))
      .toBe('In the Matter of: Arthur Ching-Fu Gau; Order Denying Export Privilege');
    expect(withoutAddress('until March 13, 2035, Richard Roe, with a last known address of 26 Elm Drive, Rolling Hills, CA 90274, and when acting for him'))
      .toBe('until March 13, 2035, Richard Roe, and when acting for him');
  });

  test('a Trade Commission import case naming the company is a company record; apple juice is not Apple Inc.', async () => {
    const calls = fakeNet((url) => (url.includes('federalregister.gov') ? ITC_APPLE : undefined));
    const { findings } = await federalRegisterActionsConnector.run({ kind: 'company', value: 'Apple Inc.', template: 'trade-cases.company' }, ctxFor(createSubject({ name: 'Tim Cook', company: 'Apple' })));
    expect(decodeURIComponent(calls[0])).toContain('conditions[agencies][]=international-trade-commission');
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toBe('company');
    expect(findings[0].category).toBe('litigation');
    expect(findings[0].quote).toMatch(/named as respondent/);
    expect(findings[0].data.role).toBe('respondent');
  });

  test('an empty answer is an empty result', async () => {
    fakeNet((url) => (url.includes('federalregister.gov') ? { description: 'Documents matching \'"Jane Roe"\'', count: 0 } : undefined));
    const out = await federalRegisterActionsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'orders.name' }, ctxFor(createSubject({ name: 'Jane Roe' })));
    expect(out.findings).toEqual([]);
  });

  test('a failed or malformed answer is an error', async () => {
    fakeNet((url) => (url.includes('federalregister.gov') ? { __status: 503 } : undefined));
    await expect(federalRegisterActionsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'orders.name' }, ctxFor(createSubject({ name: 'Jane Roe' })))).rejects.toThrow(/503/);
    fakeNet((url) => (url.includes('federalregister.gov') ? { error: 'oops' } : undefined));
    await expect(federalRegisterActionsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'orders.name' }, ctxFor(createSubject({ name: 'Jane Roe' })))).rejects.toThrow(/unexpected/);
  });

  test('a one-word company name needs a legal form beside it', () => {
    expect(textNamesCompany('names as a respondent: Apple. Inc. of Cupertino', 'Apple Inc.')).toBe(true);
    expect(textNamesCompany('imports of apple juice concentrate', 'Apple Inc.')).toBe(false);
    expect(textNamesCompany('Block grants to the states', 'Block')).toBe(false);
    expect(textNamesCompany('a complaint against Northwind Pharma about pricing', 'Northwind Pharma LLC')).toBe(true);
    expect(companyCore('The Boring Company')).toBe('Boring');
  });
});

/* ------------------------------------------------------------------ 3. EU */

const binding = (celex, date, title) => ({
  celex: { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#string', value: celex },
  date: { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#date', value: date },
  title: { type: 'literal', 'xml:lang': 'en', value: title },
});
const sparql = (bindings) => ({ head: { link: [], vars: ['celex', 'date', 'title'] }, results: { distinct: false, ordered: true, bindings } });
const COSTEJA = sparql([
  binding('62012CJ0131', '2014-05-13', 'Judgment of the Court (Grand Chamber), 13 May 2014.#Google Spain SL and Google Inc. v Agencia Española de Protección de Datos (AEPD) and Mario Costeja González.#Request for a preliminary ruling from the Audiencia Nacional.#Personal data — Protection of individuals with regard to the processing of such data.#Case C-131/12.'),
  binding('62012CC0131', '2013-06-25', 'Opinion of Advocate General Jääskinen delivered on 25 June 2013.#Google Spain SL and Google Inc. v Agencia Española de Protección de Datos (AEPD) and Mario Costeja González.#Request for a preliminary ruling from the Audiencia Nacional.#Case C-131/12.'),
  binding('62012CN0131', '2012-03-09', 'Case C-131/12: Reference for a preliminary ruling from the Audiencia Nacional (Spain) lodged on 9 March 2012 — Google Spain, S.L., Google Inc. v Agencia Española de Protección de Datos, Mario Costeja González'),
  // an asylum case is never read, whoever it names
  binding('62020CJ0999', '2021-01-01', 'Judgment of the Court.#Mario González v Staatssecretaris van Justitie en Veiligheid.#Asylum policy — International protection.#Case C-999/20.'),
]);
const INTEL = sparql([
  binding('62023TJ1129', '2025-12-10', 'Judgment of the General Court (Second Chamber) of 10 December 2025.#Intel Corporation Inc. v European Commission.#Competition – Abuse of dominant position – Microprocessors market – Fine.#Case T-1129/23.'),
  binding('62023TA1129', '2025-12-10', 'Case T-1129/23: Judgment of the General Court of 10 December 2025 – Intel Corporation v Commission (Competition – Abuse of dominant position – Microprocessors market)'),
  binding('52023AT37990', '2023-09-22', 'Summary of Commission Decision of 22 September 2023 relating to a proceeding under Article 102 of the Treaty on the Functioning of the European Union and Article 54 of the EEA Agreement (Case AT.37990 - INTEL) (notified under document C(2023) 6198)'),
  binding('62019CJ0001', '2020-01-01', 'Judgment of the Court.#Intelligent Systems GmbH v Hauptzollamt.#Customs.#Case C-1/19.'),
]);

describe('eu-courts', () => {
  test('a case naming the person by full name is possible on its own; the documents of one case become one record; an asylum case is left out', async () => {
    const calls = fakeNet((url) => (url.includes('publications.europa.eu/webapi/rdf/sparql') ? COSTEJA : undefined));
    const { findings } = await euCourtsConnector.run({ kind: 'subject', value: 'Mario González', template: 'cases.name' }, ctxFor(createSubject({ name: 'Mario González' })));
    expect(decodeURIComponent(calls[0])).toContain('"Mario" AND "González"');
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f.match).toBe('possible');
    expect(f.url).toBe('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62012CJ0131');
    expect(f.title).toBe('Google Spain SL and Google Inc. v Agencia Española de Protección de Datos and Mario Costeja González (Court of Justice of the EU, case C-131/12)');
    expect(f.data.documents).toBe(3);
  });

  test('a person case that also names their company is graded up by the record, not by hand', async () => {
    fakeNet(() => COSTEJA);
    const { findings } = await euCourtsConnector.run({ kind: 'subject', value: 'Mario González', template: 'cases.name' }, ctxFor(createSubject({ name: 'Mario González', company: 'Google Spain' })));
    expect(['confirmed', 'likely']).toContain(findings[0].match);
    expect(findings[0].matchFixed).toBeUndefined();
  });

  test('a company search returns court cases and competition decisions as company records, not namesake companies', async () => {
    fakeNet(() => INTEL);
    const { findings } = await euCourtsConnector.run({ kind: 'company', value: 'Intel Corporation', template: 'cases.company' }, ctxFor(createSubject({ name: 'Pat Gelsinger', company: 'Intel' })));
    // The court case names "Intel Corporation" with its legal form; the Commission decision names only "Intel",
    // a one-word name, so it stays possible.
    const court = findings.find((f) => f.category === 'litigation');
    expect(court.match).toBe('company');
    expect(court.title).toBe('Intel Corporation Inc. v European Commission (General Court of the EU, case T-1129/23)');
    expect(court.severity).toBe('medium');
    const decision = findings.find((f) => f.category === 'regulatory');
    expect(decision.match).toBe('possible');
    expect(decision.data.caseNumber).toBe('AT.37990');
    expect(findings.some((f) => /Intelligent Systems/.test(f.title))).toBe(false);
  });

  test('parties and case numbers are read from the titles', () => {
    expect(euParties('Case T-1129/23: Judgment of the General Court of 10 December 2025 – Intel Corporation v Commission (Competition – Abuse of dominant position)')).toBe('Intel Corporation v Commission');
    expect(euParties('Case C-143/26 P: Appeal brought on 26 February 2026 by Intel Corporation Inc. against the judgment of the General Court')).toBe('Intel Corporation Inc.');
    expect(euParties('Summary of Commission Decision of 13 May 2009 relating to a proceeding under Article 82 of the EC Treaty (Case COMP/C-3/37.990 — Intel)')).toBe('Intel');
    expect(euCase('62022CJ0240', '').caseNumber).toBe('C-240/22');
    expect(euCase('52009XC0922(02)', '(Case COMP/C-3/37.990 — Intel)').caseNumber).toBe('COMP/C-3/37.990');
  });

  test('an empty answer is an empty result; a failed or malformed answer is an error', async () => {
    fakeNet(() => sparql([]));
    expect((await euCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'cases.name' }, ctxFor(createSubject({ name: 'Jane Roe' })))).findings).toEqual([]);
    fakeNet(() => ({ __status: 500 }));
    await expect(euCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'cases.name' }, ctxFor(createSubject({ name: 'Jane Roe' })))).rejects.toThrow(/500/);
    fakeNet(() => ({ head: {} }));
    await expect(euCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'cases.name' }, ctxFor(createSubject({ name: 'Jane Roe' })))).rejects.toThrow(/unexpected/);
  });
});

/* ------------------------------------------------------------------ 4. Canada */

const caItem = ({ href, title, citation, date, snippet = '' }) => `
    <li class="odd list-item-expanded">
<div class="number"><span class="digits">1.</span></div>
<div class="metadata"><div class="info"><div class="subinfo">
  <h3>
    <span class="title"><a target="_parent" href="${href}">${title}</a></span>
    - <span class="citation">${citation}</span>
    - <span class="publicationDate">${date}</span>
  </h3>
  <div class="subMetadata"><span>Federal Court Decisions</span></div>
  <div class="subject"></div>
  <p class="snippet" >${snippet}</p>
</div>
<div class="documents"><a target="_blank" href="${href.replace('/item/', '/').replace(/index\.do.*$/, '1/document.do')}" title="Download the PDF version" class="matomo_download"></a></div>
</div></div>
</li>`;
const caPage = (items) => `<!DOCTYPE html><html><body><div id="decisia-advanced-search-result-controls"></div>
    <h2>${items.length} result(s)</h2>
    <div id="decisia-results"><div class="documentList"><ul class="collectionItemList list-expanded">${items.join('')}</ul></div></div></body></html>`;
const OLEARY = caPage([
  caItem({ href: '/fc-cf/decisions/en/item/521624/index.do?q=%22Kevin+O%27Leary%22', title: 'O&#8217;Leary v. Ragone', citation: '2022 FC 749', date: '2022-05-20', snippet: '<b>KEVIN O&#8217;LEARY</b> AND LINDA O&#8217;LEARY Plaintiffs/ Defendants by Counterclaim and &nbsp;&nbsp;[...]&nbsp;&nbsp;<b>KEVIN O&#8217;LEARY</b> AND LINDA O&#8217;LEARY V ROSA RAGONE, ANTONIO RAGONE AND PAULA BRITO v RICHARD RUH AND IRV EDWARDS' }),
  // the same surname, another first name: somebody else
  caItem({ href: '/fc-cf/decisions/en/item/100001/index.do', title: 'O&#8217;Leary v. Canada (Attorney General)', citation: '2019 FC 1', date: '2019-01-02', snippet: '<b>SEAN O&#8217;LEARY</b> Applicant and ATTORNEY GENERAL OF CANADA' }),
  // immigration cases are never read
  caItem({ href: '/fc-cf/decisions/en/item/100002/index.do', title: 'O&#8217;Leary v. Canada (Citizenship and Immigration)', citation: '2018 FC 2', date: '2018-01-02', snippet: '<b>KEVIN O&#8217;LEARY</b> Applicant and THE MINISTER OF CITIZENSHIP AND IMMIGRATION' }),
]);
const BOMBARDIER = caPage([
  caItem({ href: '/fc-cf/decisions/en/item/486297/index.do', title: 'Bombardier Recreational Products Inc. v. Arctic Cat, Inc.', citation: '2020 FC 946', date: '2020-10-02' }),
  caItem({ href: '/fca-caf/decisions/en/item/482840/index.do', title: 'Arctic Cat, Inc. v. Bombardier Recreational Products Inc.', citation: '2020 FCA 116', date: '2020-06-30' }),
  caItem({ href: '/fc-cf/decisions/en/item/364012/index.do', title: 'Bombardier Inc. v. Canada (Attorney General)', citation: '2018 FC 1', date: '2018-01-01' }),
]);

describe('canada-federal-courts', () => {
  test('the full name in the decision heading ties a surname-titled case to the person; name only stays possible', async () => {
    const calls = fakeNet((url) => (url.includes('decisions.fct-cf.gc.ca') ? OLEARY : undefined));
    const { findings } = await canadaFederalCourtsConnector.run({ kind: 'subject', value: "Kevin O'Leary", template: 'parties.name' }, ctxFor(createSubject({ name: "Kevin O'Leary" })));
    expect(calls[0]).toContain('cont=%22Kevin%20O\'Leary%22');
    expect(calls[0]).toContain('col=53&col=54');
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toBe('possible');
    expect(findings[0].title).toBe("O'Leary v. Ragone (Federal Court of Canada, 2022 FC 749)");
    expect(findings[0].url).toBe('https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/521624/index.do');
  });

  test('a company search reports both courts’ cases with the company as a party, as company records', async () => {
    fakeNet((url) => (url.includes('decisions.fct-cf.gc.ca') ? BOMBARDIER : undefined));
    const { findings } = await canadaFederalCourtsConnector.run({ kind: 'company', value: 'Bombardier Recreational Products Inc.', template: 'parties.company' }, ctxFor(createSubject({ name: 'José Boisjoli', company: 'Bombardier Recreational Products' })));
    expect(findings.map((f) => f.match)).toEqual(['company', 'company']);
    expect(findings.map((f) => f.title)).toContain('Arctic Cat, Inc. v. Bombardier Recreational Products Inc. (Federal Court of Appeal, 2020 FCA 116)');
  });

  test('an empty answer is an empty result; a failed answer or a page with no result count is an error', async () => {
    fakeNet(() => caPage([]));
    expect((await canadaFederalCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'parties.name' }, ctxFor(createSubject({ name: 'Jane Roe' })))).findings).toEqual([]);
    fakeNet(() => ({ __status: 502 }));
    await expect(canadaFederalCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'parties.name' }, ctxFor(createSubject({ name: 'Jane Roe' })))).rejects.toThrow(/502/);
    fakeNet(() => '<html><body>Maintenance</body></html>');
    await expect(canadaFederalCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'parties.name' }, ctxFor(createSubject({ name: 'Jane Roe' })))).rejects.toThrow(/unexpected/);
  });
});

/* ------------------------------------------------------------------ review fixes: partial and unscreened lookups */

describe('a lookup that was cut short or not run is partial, never a clean result', () => {
  test('Delaware: years that do not answer are partial, not "no match"', async () => {
    fakeNet((url) => (url.includes(`from=01/01/${thisYear}&`) ? deEmpty : { __status: 500 }));
    const r = await delawareCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Jane Roe' })));
    expect(r.findings).toEqual([]);
    expect(r.partial).toEqual([`Delaware decisions ${[1, 2, 3, 4].map((i) => thisYear - i).join(', ')} (no answer)`]);
  });

  test('Delaware: years not reached before the deadline are partial', async () => {
    fakeNet(() => deEmpty);
    const ctx = ctxFor(createSubject({ name: 'Jane Roe' }));
    let n = 0;
    const realNow = Date.now;
    const start = realNow();
    ctx.deadline = start + 20000;
    // the clock jumps past the deadline after two years are searched
    Date.now = () => (n++ < 4 ? start : start + 19000);
    try {
      const r = await delawareCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'captions.recent' }, ctx);
      expect(r.partial).toHaveLength(1);
      expect(r.partial[0]).toMatch(/not reached in time/);
    } finally {
      Date.now = realNow;
    }
  });

  test('Delaware: a year that fills the search\'s 100 rows is partial', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(1000 + i), caption: `Smith v. Jones ${i}`, date: `01/0${(i % 9) + 1}/${thisYear}`, file: `C.A. No. ${thisYear}-0${100 + i}` }));
    fakeNet((url) => (url.includes(`from=01/01/${thisYear}&`) ? dePage(rows.map(deRow)) : deEmpty));
    const r = await delawareCourtsConnector.run({ kind: 'subject', value: 'Jane Roe', template: 'captions.recent' }, ctxFor(createSubject({ name: 'Jane Roe' })));
    expect(r.partial).toEqual([`Delaware decisions ${thisYear} (first 100 read)`]);
  });

  test('a one-word person name is not searched, and says so as partial', async () => {
    const subject = createSubject({ name: 'Cher' });
    const calls = fakeNet(() => deEmpty);
    for (const [c, template] of [[delawareCourtsConnector, 'captions.recent'], [federalRegisterActionsConnector, 'orders.name'], [euCourtsConnector, 'cases.name'], [canadaFederalCourtsConnector, 'parties.name']]) {
      const r = await c.run({ kind: 'subject', value: 'Cher', template }, ctxFor(subject));
      expect(r.findings).toEqual([]);
      expect(r.partial).toHaveLength(1);
      expect(r.partial[0]).toMatch(/no full name to search/);
    }
    expect(calls).toHaveLength(0);
  });

  test('Canada: more decisions than were read is partial', async () => {
    fakeNet(() => OLEARY.replace(/\d[\d,]*\s+result\(s\)/, '2,000 result(s)'));
    const r = await canadaFederalCourtsConnector.run({ kind: 'subject', value: 'John Smith', template: 'parties.name' }, ctxFor(createSubject({ name: 'John Smith' })));
    expect(r.findings).toEqual([]);
    expect(r.partial[0]).toMatch(/^Canadian federal cases \(newest \d+ of 2000 decisions read\)$/);
  });

  test('EU: a search that fills its 60 rows is partial', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => binding(`6202${i % 10}TJ0${100 + i}`, '2020-01-01', `Judgment of the General Court – Acme v Commission ${i}`));
    fakeNet(() => sparql(rows));
    const r = await euCourtsConnector.run({ kind: 'subject', value: 'John Smith', template: 'cases.name' }, ctxFor(createSubject({ name: 'John Smith' })));
    expect(r.partial).toEqual(['EU cases (newest 60 documents read)']);
  });

  test('Federal Register: more documents than were read is partial', async () => {
    fakeNet(() => ({ count: 300, results: [] }));
    const r = await federalRegisterActionsConnector.run({ kind: 'company', value: 'Acme Robotics', template: 'orders.company' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Acme Robotics' })));
    expect(r.partial).toEqual(['US agency orders (0 of 300 documents read)']);
  });
});

describe('EU competition decisions and one-word company names', () => {
  test('a decision about a same-name company is possible for a one-word company, never the company\'s own', async () => {
    fakeNet(() => sparql([binding('32004D0001', '2004-07-16', 'Commission Decision relating to a proceeding under Article 102 (Case COMP/38.784 - Orange)')]));
    const { findings } = await euCourtsConnector.run({ kind: 'company', value: 'Orange', template: 'cases.company' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Orange' })));
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toBe('possible');
    expect(findings[0].matchReasons.join(' ')).toMatch(/one-word name/);
  });

  test('a two-word company named in a decision is the company', async () => {
    fakeNet(() => sparql([binding('32004D0002', '2004-07-16', 'Commission Decision relating to a proceeding under Article 102 (Case COMP/38.785 - Acme Robotics)')]));
    const { findings } = await euCourtsConnector.run({ kind: 'company', value: 'Acme Robotics', template: 'cases.company' }, ctxFor(createSubject({ name: 'Jane Roe', company: 'Acme Robotics' })));
    expect(findings.map((f) => f.match)).toEqual(['company']);
  });
});
