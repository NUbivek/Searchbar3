/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addCompanyAlias } = require('../../../src/server/founder/identity');
const R = require('../../../src/server/founder/sources/regulatorsMore');

const {
  parseFtcResults, ftcParties, parseEsma, parseSfc, esmaNames, sfcPersonForms, petitionerForms, isSfcFirm, hkSigns, euSigns,
  ftcCasesConnector, esmaSanctionsConnector, sfcEnforcementConnector, usTaxCourtConnector, ESMA_NOTE, __resetRegulatorsMoreForTests,
} = R;

/* ------------------------------------------------------------------ */
/* Fixtures in the shapes the sources served on 20 Nov 2026            */
/* (shortened; people and companies invented)                          */
/* ------------------------------------------------------------------ */

const ftcField = (name, label, value) => `<div class="field field--name-${name} field--type-string field--label-inline">
            <div class="field__label">${label}</div>
        <div class="field__items">
          <div class="field__item">${value}</div>
      </div>
</div>`;
const ftcCase = ({ path, title, body = '', action = 'Federal', date = '2025-05-04', matter = '2423092', docket = '3:25-cv-03477', status = 'Pending' }) => `<div class="views-row">
<article about="/legal-library/browse/cases-proceedings/${path}" class="node node--type-case node--view-mode-search-result node--88109">
  <div class="node__content"><div class="group">
<div class="field field--name-field-legal-library-record-types field--type-entity-reference field--label-hidden field--count-2">
        <div class="field__items">
              <div class="field__item"><a href="/legal-library/browse/cases-proceedings" hreflang="en">Cases and Proceedings</a></div>
              <div class="field__item"><a href="/legal-library/browse/cases-proceedings/adjudicative-proceedings" hreflang="en">Adjudicative Proceedings</a></div>
          </div>
  </div>
  <h3 class="node-title"><a href="/legal-library/browse/cases-proceedings/${path}" hreflang="en">${title}</a></h3>
${body ? `<div class="field field--name-body field--type-text-with-summary field--label-hidden">
    <div class="field__items">
          <div class="field__item"><p>${body}</p></div>
      </div>
</div>` : ''}
${ftcField('field-case-action-type', 'Type of Action', action)}
<div class="field field--name-field-date field--type-datetime field--label-inline">
            <div class="field__label">Last Updated</div>
        <div class="field__items">
          <div class="field__item"><time datetime="${date}T12:00:00Z">x</time>
</div>
      </div>
</div>
${ftcField('field-matter-number', 'FTC Matter/File Number', matter)}
${ftcField('field-docket-number', 'Docket Number', docket)}
${ftcField('field-case-status', 'Case Status', status)}
      </div></div>
</article>
</div>`;
const ftcStatement = ({ path, title, date = '2020-01-27' }) => `<div class="views-row">
<article about="/legal-library/browse/cases-proceedings/public-statements/${path}" class="node node--type-public-statement-legal node--view-mode-search-result node--52382">
  <div class="node__content"><div class="group">
<div class="field field--name-field-legal-library-record-types field--type-entity-reference field--label-hidden field--count-2">
        <div class="field__items">
              <div class="field__item"><a href="/legal-library/browse/cases-proceedings" hreflang="en">Cases and Proceedings</a></div>
              <div class="field__item"><a href="/legal-library/browse/cases-proceedings/commissioner-statements" hreflang="en">Commissioner Statements</a></div>
          </div>
  </div>
  <h3 class="node-title"><a href="/legal-library/browse/cases-proceedings/public-statements/${path}" hreflang="en">${title}</a></h3>
<div class="field field--name-field-date field--type-datetime field--label-inline">
            <div class="field__label">Date</div>
        <div class="field__items">
          <div class="field__item"><time datetime="${date}T12:00:00Z">x</time>
</div>
      </div>
</div>
      </div></div>
</article>
</div>`;
const ftcPage = (items, total = items.length) => `<html><body><div class="main">
  <div class="view-results-info"><div class="view-summary">Displaying 1 - ${items.length} of ${total}</div></div>
  ${items.join('\n')}
  <div class="view-summary">Displaying 1 - ${items.length} of ${total}</div></div></body></html>`;
const FTC_EMPTY = '<html><body><div class="main"><div class="view-empty"><p>No results found for these filters.</p></div><div class="view-results-info"></div></div></body></html>';

const FTC_PERSON = ftcPage([
  ftcCase({ path: '2423100-brightwell-analytics-ftc-v', title: 'Brightwell Analytics, Inc., and Dana Kowalczyk, FTC v.', body: 'The Federal Trade Commission sued Brightwell Analytics, Inc. and its chief executive Dana Kowalczyk for deceptive data practices. Consumers such as Mary Example of 12 Elm Street complained. A third sentence that is not kept.' }),
  ftcCase({ path: '162-3184-csgo-dana-kowalski-matter', title: 'CSGOLotto, Dana Kowalski, and Thomas Cassell, In the Matter of', action: 'Administrative', docket: '' }),
  ftcStatement({ path: 'statement-commissioner-dana-kowalczyk-regarding-other', title: 'Statement of Commissioner Dana Kowalczyk Regarding FTC v. Other Corp' }),
  ftcStatement({ path: 'statement-regarding-ftc-v-dana-kowalczyk', title: 'Statement of Commissioner Pat Roe Regarding Federal Trade Commission v. Dana Kowalczyk' }),
]);
const FTC_COMPANY = ftcPage([
  ftcCase({ path: '2423101-zentrix-ftc-v', title: 'Zentrix Robotics, Inc., FTC v.', body: 'The FTC sued Zentrix Robotics over subscription billing.' }),
  ftcCase({ path: '952-3235-zentrixon-labs-matter', title: 'Zentrixon Labs Corporation, In the Matter of' }),
]);

// ESMA: a Solr answer; the firm name is an anchor (or plain text), empty for people and withheld names
const esmaDoc = (o) => ({ id: `sn${Math.random().toString(36).slice(2, 8)}`, sn_sanctionLegalFrameworkName: 'MiFID', sn_date: '2013-08-27T00:00:00Z', sn_ncaCodeFullName: 'Czech National Bank (CNB)', sn_countryName: 'CZECHIA', sn_natureFullName: 'Administrative sanction and measure', ...o });
const ESMA_DOCS = [
  esmaDoc({ sn_entityName: "<a href='details?core=esma_registers_upreg&docId=ae2978'>Brightwell Analytics GmbH</a>", sn_date: '2021-03-04T00:00:00Z', sn_ncaCodeFullName: 'Federal Financial Supervisory Authority (BaFin)', sn_countryName: 'GERMANY', sn_entityLEI: '529900ABCDEFGHIJ1234' }),
  esmaDoc({ sn_entityName: 'Volta (Volta Capital LTD / VC Markets LTD)', sn_ncaCodeFullName: 'Cyprus Securities and Exchange Commission (CySEC)', sn_countryName: 'CYPRUS' }),
  esmaDoc({ sn_entityName: "<a href='details?core=esma_registers_upreg&docId=ae1111'>Quellmark Asset Partners S.A.</a>", sn_entityLEI: '635400MAMSZNLASIXI36' }),
  esmaDoc({ sn_entityName: null }),
  esmaDoc({ sn_entityName: '' }),
  ...Array.from({ length: 600 }, (_, i) => esmaDoc({ sn_entityName: `<a href='details?core=esma_registers_upreg&docId=f${i}'>Filler Securities ${i} a.s.</a>` })),
];
const esmaBody = (docs, numFound = docs.length) => JSON.stringify({ responseHeader: { status: 0 }, response: { numFound, start: 0, docs } });
const ESMA = esmaBody(ESMA_DOCS);

// SFC: every release with its named targets; masked targets are written {X}
const recent = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 19);
const sfcItem = (ref, title, targets, date = '2014-10-09T18:33:45.608') => ({ newsRefNo: ref, lang: 'EN', title, newsExtLink: null, newsType: 'EF', issueDate: date, creationTime: null, modificationTime: date, targetCeList: targets.map((t) => (typeof t === 'string' ? { ceName: t, lang: 'EN', masked: false } : t)) });
const SFC_ITEMS = [
  sfcItem('14PR901', 'Market Misconduct Tribunal bans Harbour Peak Capital and Wilfred Tanaka from trading securities in Hong Kong \r\n', ['TANAKA Wilfred', 'LAM Mei Ling', 'HARBOUR PEAK CAPITAL, LLC']),
  sfcItem('16PR902', 'SFC reprimands and fines Brightwell Analytics Limited $2 million', ['Brightwell Analytics Limited', 'CHEUNG Ka Wai Dennis']),
  sfcItem('19PR903', 'SFC bans Cheung Ka Wai for life', ['CHEUNG Ka Wai, Dennis']),
  sfcItem('20PR904', 'SFC obtains freezing order', [{ ceName: '{X} {X}', lang: 'EN', masked: true }]),
  sfcItem('26PR195', 'SFC bans Filler Person for life for serious misconduct', ['KIM Chung Wan'], recent),
  ...Array.from({ length: 1600 }, (_, i) => sfcItem(`10PR${i}`, `SFC reprimands Filler Broker ${i} Limited`, [`Filler Broker ${i} Limited`], '2010-01-01T10:00:00.000')),
];
const sfcBody = (items, total = items.length) => JSON.stringify({ items, total });
const SFC = sfcBody(SFC_ITEMS);

// Tax Court: cases and opinions
const TAX_CASES = JSON.stringify({ results: [
  { entityName: 'PublicCaseSearchResult', caseCaption: 'Dana Kowalczyk & Morgan Kowalczyk, Petitioners', docketNumber: '17858-21', docketNumberWithSuffix: '17858-21S', petitionerNames: ['Dana Kowalczyk', 'Morgan Kowalczyk'], petitionerStateNames: ['Georgia', 'Georgia'], receivedAt: '2021-08-10T03:59:08.828Z' },
  { entityName: 'PublicCaseSearchResult', caseCaption: 'Dana & Lee Kowalczyk, Petitioner', docketNumber: '22153-19', docketNumberWithSuffix: '22153-19', petitionerNames: ['Dana & Lee Kowalczyk'], petitionerStateNames: ['Ohio'], receivedAt: '2019-06-16T04:00:00.000Z' },
  { entityName: 'PublicCaseSearchResult', caseCaption: 'Estate of Dana Kowalczyk, Deceased, Petitioner', docketNumber: '10348-96', docketNumberWithSuffix: '10348-96', petitionerNames: ['Estate of Dana Kowalczyk, Deceased'], petitionerStateNames: ['Missouri'], receivedAt: '1996-05-24T04:00:00.000Z' },
  { entityName: 'PublicCaseSearchResult', caseCaption: 'Dana Kowalczyk-Brown, Petitioner', docketNumber: '10159-89', docketNumberWithSuffix: '10159-89', petitionerNames: ['Dana Kowalczyk-Brown'], petitionerStateNames: ['Florida'], receivedAt: '1989-05-15T04:00:00.000Z' },
] });
const TAX_OPINIONS = JSON.stringify({ results: [
  { entityName: 'PublicDocumentSearchResult', caseCaption: 'Dana Kowalczyk & Morgan Kowalczyk, Petitioners', docketEntryId: '47416ed8-e9f5-4f54-92fc-c1954d24f9f8', docketNumber: '17858-21', docketNumberWithSuffix: '17858-21S', documentTitle: 'Memorandum Opinion Judge Jones T.C. Memo. 2023-134', documentType: 'Memorandum Opinion', eventCode: 'MOP', filingDate: '2023-11-12T19:35:15.046Z', isStricken: false, judge: 'Jones', numberOfPages: 38 },
  { entityName: 'PublicDocumentSearchResult', caseCaption: 'Sunil S. Other & Laurie Other, Petitioners', docketEntryId: 'aaaa', docketNumber: '24344-17', docketNumberWithSuffix: '24344-17', documentTitle: 'T.C. Opinion Judge Jones 165 T.C. No. 10.', documentType: 'T.C. Opinion', eventCode: 'TCOP', filingDate: '2025-11-12T19:35:15.046Z', judge: 'Jones' },
] });
const TAX_COMPANY = JSON.stringify({ results: [
  { entityName: 'PublicCaseSearchResult', caseCaption: 'Zentrix Robotics, Inc. & Subsidiaries, Petitioner', docketNumber: '5501-22', docketNumberWithSuffix: '5501-22', petitionerNames: ['Zentrix Robotics, Inc. & Subsidiaries'], petitionerStateNames: ['Delaware'], receivedAt: '2022-03-01T05:00:00.000Z' },
  { entityName: 'PublicCaseSearchResult', caseCaption: 'Dennis D. Zentrix, Petitioner', docketNumber: '8193-14', docketNumberWithSuffix: '8193-14', petitionerNames: ['Dennis D. Zentrix'], petitionerStateNames: ['California'], receivedAt: '2014-04-11T04:00:00.000Z' },
] });

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
    const value = typeof r === 'function' ? r(url, init) : r;
    if (typeof value === 'string') return { status: 200, headers, url, text: async () => value };
    return { status: value.status || 200, headers, url, text: async () => value.body };
  });
}

const ENV = { ...process.env };
beforeEach(() => {
  __resetCacheForTests();
  __resetRegulatorsMoreForTests({ unpaced: true });
  calls = [];
  process.env = { ...ENV };
  delete process.env.FOUNDER_SOURCES_ON;
  delete process.env.FOUNDER_SOURCES_OFF;
  delete process.env.FOUNDER_HTTP_CONTACT;
});
afterEach(() => { setTransport(); process.env = { ...ENV }; });

const ctxFor = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, findings: () => findings });
const task = (kind, value, template, why = 'test') => ({ kind, value, template, why, depth: 0 });
const noConfirmed = (out) => out.findings.forEach((f) => expect(f.match).not.toBe('confirmed'));

/* ------------------------------------------------------------------ */
/* Switches and plans                                                  */
/* ------------------------------------------------------------------ */

describe('switches and plans', () => {
  test('FTC needs a declared contact; SFC and Tax Court stay off until the owner names them; ESMA is on', () => {
    expect(ftcCasesConnector.enabled()).toBe(false);
    process.env.FOUNDER_HTTP_CONTACT = 'https://example.org/contact';
    expect(ftcCasesConnector.enabled()).toBe(true);
    process.env.FOUNDER_SOURCES_OFF = 'ftc-cases';
    expect(ftcCasesConnector.enabled()).toBe(false);
    expect(sfcEnforcementConnector.enabled()).toBe(false);
    expect(usTaxCourtConnector.enabled()).toBe(false);
    process.env.FOUNDER_SOURCES_ON = 'sfc-hk-enforcement,us-tax-court';
    expect(sfcEnforcementConnector.enabled()).toBe(true);
    expect(usTaxCourtConnector.enabled()).toBe(true);
    expect(esmaSanctionsConnector.enabled()).toBe(true);
    for (const c of [ftcCasesConnector, esmaSanctionsConnector, sfcEnforcementConnector, usTaxCourtConnector]) {
      expect(c.kinds).not.toContain('relative');
      expect(c.kinds).not.toContain('associate');
      expect(c.unavailableReason).not.toMatch(/\b(api|endpoint|token|free|paid|tier|env)\b/i);
    }
  });

  test('Hong Kong and EU sources are planned only with a tie; the given company and the person get a late check', () => {
    const plain = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    expect(sfcEnforcementConnector.plan({ kind: 'subject', value: plain.name }, plain)[0].template).toBe('sfc.person.if-placed');
    expect(sfcEnforcementConnector.plan({ kind: 'company', value: 'Other Venture' }, plain)).toEqual([]);
    expect(sfcEnforcementConnector.plan({ kind: 'company', value: 'Harbour Peak (Hong Kong) Limited' }, plain)[0].template).toBe('sfc.company');
    expect(esmaSanctionsConnector.plan({ kind: 'company', value: 'Brightwell Analytics', why: 'the company given' }, plain)[0].template).toBe('esma.if-placed');
    expect(esmaSanctionsConnector.plan({ kind: 'company', value: 'Other Venture' }, plain)).toEqual([]);
    expect(esmaSanctionsConnector.plan({ kind: 'company', value: 'Brightwell Analytics GmbH' }, plain)[0].template).toBe('esma.company');
    expect(hkSigns({ kind: 'subject', value: plain.name }, createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics (HK) Limited' }))).not.toHaveLength(0);
    expect(euSigns({ kind: 'company', value: 'Acme', why: 'a French company where the person was a director' }, plain)).not.toHaveLength(0);
    for (const c of [ftcCasesConnector, esmaSanctionsConnector, sfcEnforcementConnector, usTaxCourtConnector]) {
      for (const kind of c.kinds) {
        for (const p of c.plan({ kind, value: kind === 'subject' ? plain.name : 'Brightwell Analytics GmbH' }, plain)) {
          expect(p.template).toMatch(/^[a-z0-9.:_-]+$/i);
          expect(p.template).not.toMatch(/kowalczyk|brightwell/i);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* FTC                                                                 */
/* ------------------------------------------------------------------ */

describe('FTC cases and proceedings', () => {
  test('reads cases and statements; the empty page is "no results"; any other page is an error', () => {
    const page = parseFtcResults(FTC_PERSON);
    expect(page.total).toBe(4);
    expect(page.items[0]).toMatchObject({ kind: 'case', title: 'Brightwell Analytics, Inc., and Dana Kowalczyk, FTC v.', matter: '2423092', docket: '3:25-cv-03477', status: 'Pending', action: 'Federal', date: '2025-05-04' });
    expect(page.items[0].url).toBe('https://www.ftc.gov/legal-library/browse/cases-proceedings/2423100-brightwell-analytics-ftc-v');
    expect(page.items[2]).toMatchObject({ kind: 'statement', types: ['Commissioner Statements'] });
    expect(parseFtcResults(FTC_EMPTY)).toEqual({ total: 0, shown: 0, items: [] });
    expect(() => parseFtcResults('<html><h1>Page Not Found</h1></html>')).toThrow(/expected format/);
    expect(() => parseFtcResults('<div class="view-summary">Displaying 1 - 2 of 2</div><p>new layout</p>')).toThrow();
    // a result with another class order (a promoted page) is still counted, and how many the page shows is read from its count line
    expect(parseFtcResults(ftcPage([ftcCase({ path: 'a', title: 'A Co, FTC v.' }).replace('node--type-case node--view-mode', 'node--type-case node--promoted node--view-mode')], 30)).items).toHaveLength(1);
  });

  test('a person: the full name in the case title; likely only with the given company; author statements and other names left out', async () => {
    serve({ 'cases-proceedings?search=': FTC_PERSON });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    const out = await ftcCasesConnector.run(task('subject', subject.name, 'ftc.person'), ctxFor(subject));
    expect(calls[0].url).toBe('https://www.ftc.gov/legal-library/browse/cases-proceedings?search=Dana%20Kowalczyk');
    expect(out.findings.map((f) => f.title)).toEqual([
      'FTC case: Brightwell Analytics, Inc., and Dana Kowalczyk, FTC v.',
      'FTC commissioner statements: Statement of Commissioner Pat Roe Regarding Federal Trade Commission v. Dana Kowalczyk: name match only, verify identity',
    ]);
    const [caseFinding, statement] = out.findings;
    expect(caseFinding).toMatchObject({ match: 'likely', matchFixed: true, category: 'regulatory', severity: 'medium', date: '2025-05-04' });
    expect(statement).toMatchObject({ match: 'possible', severity: 'low' });
    noConfirmed(out);
    // the quote keeps two sentences of the summary, cleaned; a consumer's street is never kept
    expect(caseFinding.quote).toMatch(/deceptive data practices/);
    expect(caseFinding.quote).not.toMatch(/Elm Street|third sentence/);
    expect(out.notes[0]).toMatch(/searched for "Dana Kowalczyk"; 2 cases or statements name the person/);
  });

  test('a namesake with no company in the record stays possible; nothing found is said plainly', async () => {
    serve({ 'cases-proceedings?search=': FTC_PERSON });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Unrelated Ventures' });
    const out = await ftcCasesConnector.run(task('subject', subject.name, 'ftc.person'), ctxFor(subject));
    expect(out.findings.every((f) => f.match === 'possible' && /verify identity/.test(f.title))).toBe(true);
    serve({ 'cases-proceedings?search=': FTC_EMPTY });
    const none = await ftcCasesConnector.run(task('subject', subject.name, 'ftc.person'), ctxFor(subject));
    expect(none.findings).toEqual([]);
    expect(none.notes[0]).toMatch(/no case or statement names Dana Kowalczyk in its title/);
    expect(none.partial).toBeUndefined();
  });

  test('more results than the first page holds: partial', async () => {
    serve({ 'cases-proceedings?search=': ftcPage([ftcCase({ path: 'x', title: 'Someone Else, FTC v.' })], 57) });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    const out = await ftcCasesConnector.run(task('subject', subject.name, 'ftc.person'), ctxFor(subject));
    expect(out.partial).toEqual(['first 1 of 57 results']);
  });

  test('a company: its name in the case title as a company, under every known name; a longer name is another company', async () => {
    serve({ 'cases-proceedings?search=': FTC_COMPANY });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Zentrix Robotics' });
    const out = await ftcCasesConnector.run(task('company', 'Zentrix Robotics', 'ftc.company'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'company', title: 'FTC case: Zentrix Robotics, Inc., FTC v.' });
    // a learned legal name is searched too
    calls = [];
    addCompanyAlias(subject, { company: 'Zentrix Robotics', alias: 'Zentrix Robotics Holdings Inc', origin: 'test' });
    await ftcCasesConnector.run(task('company', 'Zentrix Robotics', 'ftc.company'), ctxFor(subject));
    expect(calls.map((c) => decodeURIComponent(c.url.split('search=')[1]))).toEqual(['Zentrix Robotics', 'Zentrix Robotics Holdings Inc']);
  });

  test('the parties of a case title; a comma before a legal form stays in the name', () => {
    expect(ftcParties('Brightwell Analytics, Inc., and Dana Kowalczyk, FTC v.')).toEqual(['Brightwell Analytics, Inc.', 'Dana Kowalczyk']);
    expect(ftcParties('Akorn, Inc., In the Matter of')).toEqual(['Akorn, Inc.']);
    expect(ftcParties('Statement of Commissioner Pat Roe In the Matter of Ramp, Inc.')).toEqual(['Ramp, Inc.']);
    expect(ftcParties('Concurring Statement in Federal Trade Commission; and State of New York v. Vyera Pharmaceuticals, LLC; Phoenixus AG; Martin Shkreli; and Kevin Mulleady'))
      .toEqual(['Vyera Pharmaceuticals, LLC', 'Phoenixus AG', 'Martin Shkreli', 'Kevin Mulleady']);
  });

  test('a company named with one ordinary word: the shared matcher decides, and a bare party of that name stays possible', async () => {
    serve({ 'cases-proceedings?search=': ftcPage([
      ftcCase({ path: 'ramp-ftc-v', title: 'Ramp, FTC v.' }),
      ftcStatement({ path: 'statement-ramp-inc', title: 'Statement of Commissioner Pat Roe In the Matter of Ramp, Inc.' }),
      ftcCase({ path: 'ramp-up-matter', title: 'Ramp Up Fitness Corporation, In the Matter of' }),
    ]) });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Ramp' });
    const out = await ftcCasesConnector.run(task('company', 'Ramp', 'ftc.company'), ctxFor(subject));
    expect(out.findings.map((f) => [f.match, f.title])).toEqual([
      ['possible', 'FTC case: Ramp, FTC v.'],
      ['company', 'FTC commissioner statements: Statement of Commissioner Pat Roe In the Matter of Ramp, Inc.'],
    ]);
    expect(out.findings[0].matchReasons[0]).toMatch(/one-word name many unrelated companies share/);
    expect(out.notes[0]).toMatch(/2 cases or statements name the company/);
  });

  test('a failed search is an error, never "no match"', async () => {
    serve({ 'cases-proceedings?search=': { status: 404, body: 'Page Not Found' } });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    await expect(ftcCasesConnector.run(task('subject', subject.name, 'ftc.person'), ctxFor(subject))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* ESMA                                                                */
/* ------------------------------------------------------------------ */

describe('ESMA register of national sanctions', () => {
  test('reads firm names out of their links, other names out of brackets; never asks for decision text', () => {
    expect(esmaNames('Volta (Volta Capital LTD / VC Markets LTD)')).toEqual({ name: 'Volta', aliases: ['Volta Capital LTD', 'VC Markets LTD'] });
    expect(esmaNames('GBE-Capital (www.gbe-capital.com)')).toEqual({ name: 'GBE-Capital', aliases: [] });
    const index = parseEsma(ESMA);
    const row = index.rows.find((r) => /Brightwell/.test(r.n));
    expect(row).toMatchObject({ n: 'Brightwell Analytics GmbH', l: '529900ABCDEFGHIJ1234', d: '2021-03-04', c: 'GERMANY', u: 'https://registers.esma.europa.eu/publication/details?core=esma_registers_upreg&docId=ae2978' });
    expect(index.rows.some((r) => !r.n)).toBe(false);
    expect(R.ESMA_URL).not.toMatch(/sn_text/);
  });

  test('a short, partial or reshaped register is an error', () => {
    expect(() => parseEsma(esmaBody(ESMA_DOCS.slice(0, 100)))).toThrow(/too few/);
    expect(() => parseEsma(esmaBody(ESMA_DOCS, ESMA_DOCS.length + 50))).toThrow(/only part/);
    expect(() => parseEsma('<html>maintenance</html>')).toThrow(/expected format/);
    expect(() => parseEsma(JSON.stringify({ items: [] }))).toThrow(/expected format/);
  });

  test('not asked without a European tie: a note says so, nothing is downloaded, and it is never a clean screen', async () => {
    serve({ 'esma_registers_sanctions/select': ESMA });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    const out = await esmaSanctionsConnector.run(task('company', 'Brightwell Analytics', 'esma.if-placed', 'the company given'), ctxFor(subject));
    expect(calls).toHaveLength(0);
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/was not asked about Brightwell Analytics: nothing found so far ties Brightwell Analytics to the EU or EEA/);
    expect(out.partial).toEqual(['not asked: no tie to the EU or EEA found']);
  });

  test('asked when a tied LEI record places the company in Europe; the LEI ties the entry; the list is read once', async () => {
    serve({ 'esma_registers_sanctions/select': ESMA });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    const lei = { source: 'lei-register', match: 'company', title: 'Brightwell Analytics GmbH (LEI register)', quote: 'Brightwell Analytics GmbH', url: 'https://search.gleif.org/x', data: { lei: '529900ABCDEFGHIJ1234', jurisdiction: 'DE' } };
    const out = await esmaSanctionsConnector.run(task('company', 'Brightwell Analytics', 'esma.if-placed', 'the company given'), ctxFor(subject, [lei]));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'company', category: 'regulatory', date: '2021-03-04' });
    expect(out.findings[0].title).toBe('Federal Financial Supervisory Authority (BaFin) sanction (MiFID): Brightwell Analytics GmbH');
    expect(out.notes).toContain(ESMA_NOTE);
    expect(out.notes.join(' ')).toMatch(/LEI register gives its jurisdiction as DE/);
    await esmaSanctionsConnector.run(task('company', 'Brightwell Analytics GmbH', 'esma.company'), ctxFor(subject));
    expect(calls).toHaveLength(1);
  });

  test('a one-word name stays possible; a name of two words is the company; a near name is not matched', async () => {
    serve({ 'esma_registers_sanctions/select': ESMA });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Volta' });
    const one = await esmaSanctionsConnector.run(task('company', 'Volta Capital Ltd', 'esma.company', 'a Cypriot company where the person was a director'), ctxFor(subject));
    expect(one.findings).toHaveLength(1);
    expect(one.findings[0]).toMatchObject({ match: 'company' });
    expect(one.findings[0].quote).toMatch(/Also named: Volta Capital LTD/);
    const bare = await esmaSanctionsConnector.run(task('company', 'Volta', 'esma.company', 'a German company'), ctxFor(subject));
    expect(bare.findings[0]).toMatchObject({ match: 'possible' });
    expect(bare.findings[0].matchReasons[0]).toMatch(/one-word name/);
    const none = await esmaSanctionsConnector.run(task('company', 'Quellmark Asset GmbH', 'esma.company'), ctxFor(subject));
    expect(none.findings).toEqual([]);
    expect(none.notes.join(' ')).toMatch(/no firm named Quellmark Asset GmbH in the register \(list as of \d{4}-\d{2}-\d{2}\)/);
  });

  test('a failed download is an error', async () => {
    serve({ 'esma_registers_sanctions/select': { status: 500, body: 'error' } });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics GmbH' });
    await expect(esmaSanctionsConnector.run(task('company', 'Brightwell Analytics GmbH', 'esma.company'), ctxFor(subject))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* SFC                                                                 */
/* ------------------------------------------------------------------ */

describe('Hong Kong SFC enforcement news', () => {
  beforeEach(() => { process.env.FOUNDER_SOURCES_ON = 'sfc-hk-enforcement'; });

  test('reads targets, skips masked ones, tells firms from people; surname-first names are turned round', () => {
    const index = parseSfc(SFC);
    const tiger = index.rows.find((r) => r.r === '14PR901');
    expect(tiger).toMatchObject({ p: ['TANAKA Wilfred', 'LAM Mei Ling'], f: ['HARBOUR PEAK CAPITAL, LLC'], d: '2014-10-09' });
    expect(tiger.t).toBe('Market Misconduct Tribunal bans Harbour Peak Capital and Wilfred Tanaka from trading securities in Hong Kong');
    expect(index.rows.find((r) => r.r === '20PR904')).toBeUndefined();
    expect(isSfcFirm('Brightwell Analytics Limited')).toBe(true);
    expect(isSfcFirm('CHEUNG Ka Wai Dennis')).toBe(false);
    expect(isSfcFirm('Binance')).toBe(true);
    expect(sfcPersonForms('HWANG Sung Kook Bill')).toEqual(expect.arrayContaining(['Sung Kook Bill HWANG', 'Bill HWANG', 'Sung Kook HWANG']));
    expect(sfcPersonForms('CHOW Pak Wah, Oliver')).toEqual(expect.arrayContaining(['Pak Wah CHOW', 'Oliver CHOW']));
  });

  test('a short, partial, stale or reshaped list is an error', () => {
    expect(() => parseSfc(sfcBody(SFC_ITEMS.slice(0, 200)))).toThrow(/too few/);
    expect(() => parseSfc(sfcBody(SFC_ITEMS, SFC_ITEMS.length + 1))).toThrow(/only part/);
    expect(() => parseSfc(sfcBody(SFC_ITEMS.filter((x) => x.newsRefNo !== '26PR195')))).toThrow(/no recent/);
    expect(() => parseSfc('{"results":[]}')).toThrow(/expected format/);
  });

  test('not asked without a Hong Kong tie', async () => {
    serve({ 'edistributionWeb/api/news/search': SFC });
    const subject = createSubject({ name: 'Wilfred Tanaka', company: 'Unrelated Ventures' });
    const out = await sfcEnforcementConnector.run(task('subject', subject.name, 'sfc.person.if-placed'), ctxFor(subject));
    expect(calls).toHaveLength(0);
    expect(out.partial).toEqual(['not asked: no tie to Hong Kong found']);
    expect(out.notes[0]).toMatch(/nothing found so far ties Wilfred Tanaka to Hong Kong/);
  });

  test('a person found by name only is possible; other people the release names are not quoted', async () => {
    serve({ 'edistributionWeb/api/news/search': SFC });
    const subject = createSubject({ name: 'Wilfred Tanaka', company: 'Unrelated Ventures' });
    const hk = { source: 'web-search', match: 'likely', title: 'Wilfred Tanaka, fund manager in Hong Kong', quote: '', url: 'https://example.org/a' };
    const out = await sfcEnforcementConnector.run(task('subject', subject.name, 'sfc.person.if-placed'), ctxFor(subject, [hk]));
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ lang: 'EN', category: 'enforcement', pageNo: 0 });
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toMatchObject({ match: 'possible', severity: 'high', url: 'https://apps.sfc.hk/edistributionWeb/gateway/EN/news-and-announcements/news/doc?refNo=14PR901' });
    expect(f.title).toMatch(/name match only, verify identity$/);
    expect(f.quote).toMatch(/1 other individual named \(not listed here\)/);
    expect(JSON.stringify(f)).not.toMatch(/LAM Mei Ling/);
    expect(out.notes[0]).toMatch(/asked because a record tied to the person mentions Hong Kong/);
  });

  test('likely when the same release names the company the check was started with; an English name counts', async () => {
    serve({ 'edistributionWeb/api/news/search': SFC });
    const subject = createSubject({ name: 'Dennis Cheung', company: 'Brightwell Analytics' });
    const hk = { source: 'lei-register', match: 'company', title: 'Brightwell Analytics Limited', quote: '', url: 'https://search.gleif.org/x', data: { lei: '254900ABCDEFGHIJ0001', jurisdiction: 'HK' } };
    const out = await sfcEnforcementConnector.run(task('subject', subject.name, 'sfc.person.if-placed'), ctxFor(subject, [hk]));
    expect(out.notes[0]).toMatch(/LEI register gives its jurisdiction as Hong Kong/);
    const byRef = Object.fromEntries(out.findings.map((f) => [f.data.reference, f]));
    expect(byRef['16PR902']).toMatchObject({ match: 'likely' });
    expect(byRef['19PR903']).toMatchObject({ match: 'possible' });
    noConfirmed(out);
  });

  test('a company target: two words of its own is the company', async () => {
    serve({ 'edistributionWeb/api/news/search': SFC });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    const out = await sfcEnforcementConnector.run(task('company', 'Brightwell Analytics', 'sfc.company', 'a Hong Kong company'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'company', title: 'Hong Kong SFC: SFC reprimands and fines Brightwell Analytics Limited $2 million' });
    expect(out.findings[0].quote).not.toMatch(/CHEUNG/);
  });

  test('a failed download is an error', async () => {
    serve({ 'edistributionWeb/api/news/search': { status: 500, body: '' } });
    const subject = createSubject({ name: 'Wilfred Tanaka', company: 'Harbour Peak (Hong Kong) Limited' });
    await expect(sfcEnforcementConnector.run(task('subject', subject.name, 'sfc.person'), ctxFor(subject))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Tax Court                                                           */
/* ------------------------------------------------------------------ */

describe('US Tax Court', () => {
  beforeEach(() => { process.env.FOUNDER_SOURCES_ON = 'us-tax-court'; });

  test('petitioner names: a joint name is split, estates are skipped', () => {
    expect(petitionerForms('Sunil & Mita Patel')).toEqual(['Sunil Patel', 'Mita Patel']);
    expect(petitionerForms('Estate of Dana Kowalczyk, Deceased')).toEqual([]);
    expect(petitionerForms('Dana Kowalczyk')).toEqual(['Dana Kowalczyk']);
  });

  test('cases: the person as petitioner, possible, a spouse never named; estates left out; a longer surname is only a variant', async () => {
    serve({ 'public-api-green.dawson.ustaxcourt.gov/public-api/search?petitionerName=': TAX_CASES });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    const out = await usTaxCourtConnector.run(task('subject', subject.name, 'taxcourt.cases'), ctxFor(subject));
    expect(calls[0].url).toBe('https://public-api-green.dawson.ustaxcourt.gov/public-api/search?petitionerName=Dana%20Kowalczyk');
    expect(out.findings.map((f) => f.data.docket)).toEqual(['17858-21S', '22153-19', '10159-89']);
    expect(out.findings[2].matchReasons[0]).toMatch(/only a variant of the name/);
    for (const f of out.findings.slice(0, 2)) {
      expect(f).toMatchObject({ match: 'possible', category: 'litigation', severity: 'low' });
      expect(f.title).toMatch(/: Dana Kowalczyk, petitioner: name match only, verify identity$/);
    }
    expect(out.findings[0].url).toBe('https://dawson.ustaxcourt.gov/case-detail/17858-21');
    expect(out.findings[0].quote).toMatch(/1 other petitioner on the same case \(not named here\)/);
    const text = JSON.stringify(out.findings);
    expect(text).not.toMatch(/Morgan|Lee Kowalczyk|Estate/);
  });

  test('opinions: matched on the caption, the spouse dropped', async () => {
    serve({ '/opinion-search?keyword=': TAX_OPINIONS });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    const out = await usTaxCourtConnector.run(task('subject', subject.name, 'taxcourt.opinions'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'possible', severity: 'medium', date: '2023-11-12' });
    expect(out.findings[0].quote).toMatch(/Memorandum Opinion Judge Jones T\.C\. Memo\. 2023-134/);
    expect(JSON.stringify(out.findings)).not.toMatch(/Morgan/);
  });

  test('the blue host is asked when the green one is down; a reshaped answer is an error', async () => {
    serve({
      'public-api-green': { status: 500, body: 'this api is disabled due to a deployment' },
      'public-api-blue.dawson.ustaxcourt.gov/public-api/search': TAX_CASES,
    });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Brightwell Analytics' });
    const out = await usTaxCourtConnector.run(task('subject', subject.name, 'taxcourt.cases'), ctxFor(subject));
    expect(out.findings).toHaveLength(3);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['public-api-green.dawson.ustaxcourt.gov', 'public-api-blue.dawson.ustaxcourt.gov']);
    serve({ 'public-api-green': '{"cases":[]}' });
    await expect(usTaxCourtConnector.run(task('subject', subject.name, 'taxcourt.cases'), ctxFor(subject))).rejects.toThrow(/expected format/);
    serve({ 'public-api': { status: 500, body: 'down' } });
    await expect(usTaxCourtConnector.run(task('subject', subject.name, 'taxcourt.cases'), ctxFor(subject))).rejects.toThrow();
  });

  test('a company as petitioner ("& Subsidiaries"); a person sharing its first word is not it; nothing found is said plainly', async () => {
    serve({ '/search?petitionerName=': TAX_COMPANY });
    const subject = createSubject({ name: 'Dana Kowalczyk', company: 'Zentrix Robotics' });
    const out = await usTaxCourtConnector.run(task('company', 'Zentrix Robotics', 'taxcourt.cases'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'company', title: 'US Tax Court case 5501-22: Zentrix Robotics, Inc., petitioner' });
    serve({ '/search?petitionerName=': '{"results":[]}' });
    const none = await usTaxCourtConnector.run(task('subject', subject.name, 'taxcourt.cases'), ctxFor(subject));
    expect(none.findings).toEqual([]);
    expect(none.notes[0]).toMatch(/searched for "Dana Kowalczyk"; no case with Dana Kowalczyk as petitioner/);
  });
});

/* ------------------------------------------------------------------ */
/* The registry's contract, applied to these four before they are listed */
/* ------------------------------------------------------------------ */

describe('registry contract', () => {
  const { THREAD_KINDS } = require('../../../src/server/founder/finding');
  const KINDS = ['subject', ...THREAD_KINDS];
  const BANNED = /\b(api|endpoint|api key|token|free|paid|tier|env)\b/i;
  test.each(R.REGULATORS_MORE_CONNECTORS.map((c) => [c.id, c]))('%s obeys the contract', (id, c) => {
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(c.label.length).toBeGreaterThan(3);
    expect(c.label).not.toMatch(BANNED);
    for (const kind of c.kinds) expect(KINDS).toContain(kind);
    expect(c.prior).toBeGreaterThan(0);
    expect(c.prior).toBeLessThanOrEqual(1);
    expect(typeof c.enabled()).toBe('boolean');
    expect(String(c.unavailableReason).length).toBeGreaterThan(10);
    expect(c.unavailableReason).not.toMatch(BANNED);
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const samples = { subject: 'Elizabeth Holmes', company: 'Theranos' };
    for (const kind of c.kinds) {
      for (const p of c.plan({ kind, value: samples[kind], why: 'test' }, subject) || []) {
        expect(p.template).toMatch(/^[a-z0-9.:_-]+$/i);
        expect(p.template).not.toMatch(/holmes|balwani|theranos/i);
        expect(p.prior).toBeGreaterThan(0);
        expect(p.prior).toBeLessThanOrEqual(1);
      }
    }
  });
});
