/**
 * @jest-environment node
 *
 * DataCite theses and NSF awards (academicMore.js), with the network faked
 * from the shapes the real services returned in November 2026 (shortened, the
 * people invented). What matters most: a namesake is never pinned on the
 * person (a name alone stays 'possible' and asks to verify identity, nothing
 * is ever 'confirmed'), e-mail addresses, phone numbers and street addresses
 * never reach a record, and a failed or changed service is a failure, never
 * "no record".
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const {
  dataciteThesesConnector, nsfAwardsConnector, ACADEMIC_MORE_CONNECTORS, degreeOf, __resetAcademicMoreForTests,
} = require('../../../src/server/founder/sources/academicMore');

const ctxFor = (subject, extra = {}) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), ...extra });
const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function fakeNet(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, init });
    const hit = routes.find(([part]) => (typeof part === 'function' ? part(url) : url.includes(part)));
    if (!hit) return respond('not found', 404);
    const body = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
    return body && body.__status ? respond(body.body || '', body.__status) : respond(body);
  });
  return calls;
}

beforeEach(() => { __resetCacheForTests(); __resetAcademicMoreForTests({ unpaced: true }); });
afterEach(() => setTransport());

const BANNED = /\b(api|endpoint|key|token|free|paid|tier|quota|env)\b/i;
const PRIVATE = /@|\b\d{5}(?:-?\d{4})?\b|phone|Street|Suite|\(\d{3}\)/i;

describe('the sources as a set', () => {
  test('two connectors that obey the contract, and take no relative or associate', () => {
    expect(ACADEMIC_MORE_CONNECTORS.map((c) => c.id)).toEqual(['datacite-theses', 'nsf-awards']);
    for (const c of ACADEMIC_MORE_CONNECTORS) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.label).not.toMatch(BANNED);
      expect(c.kinds.every((k) => ['subject', 'company'].includes(k))).toBe(true);
      expect(c.prior).toBeGreaterThan(0);
      expect(c.prior).toBeLessThanOrEqual(1);
      expect(typeof c.run).toBe('function');
    }
  });

  test('the kind of degree is read from the record, never assumed', () => {
    expect(degreeOf('Thesis').kind).toBe('Thesis');
    expect(degreeOf('Doctoral Thesis').degree).toBe('Doctorate');
    expect(degreeOf('PhD thesis').kind).toBe('Doctoral thesis');
    expect(degreeOf('Master thesis').degree).toBe("Master's");
    expect(degreeOf('Bachelor Thesis').degree).toBe("Bachelor's");
  });
});

/* ------------------------------------------------------------------ DataCite */

describe('datacite-theses', () => {
  const thesis = (doi, { given, family, name, publisher, year = 2021, title = 'Fleet routing for hydrogen trucks', type = 'Thesis', orcid = '', supervisors = [], affiliation = [] }) => ({
    id: doi, type: 'dois',
    attributes: {
      doi, titles: [{ title }],
      creators: [{ givenName: given, familyName: family, name: name || `${family}, ${given}`, affiliation, nameIdentifiers: orcid ? [{ nameIdentifier: `https://orcid.org/${orcid}`, nameIdentifierScheme: 'ORCID', schemeUri: 'https://orcid.org' }] : [] }],
      contributors: supervisors.map((s) => ({ name: s, contributorType: 'Supervisor', nameIdentifiers: [], affiliation: [] })),
      publisher, publicationYear: year,
      types: { schemaOrg: 'Thesis', resourceTypeGeneral: 'Dissertation', citeproc: 'thesis', bibtex: 'phdthesis', ris: 'THES', resourceType: type },
      url: `https://repository.example.ac.uk/articles/thesis/${doi.split('/')[1]}`,
    },
    relationships: {},
  });
  const page = (data, total = data.length) => ({ data, meta: { total, totalPages: 1, page: 1 }, links: {} });

  test('the search asks DataCite for dissertations by first and last name, with only the fields kept', async () => {
    const calls = fakeNet([['api.datacite.org/dois', page([])]]);
    const r = await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Q. Vance' }, ctxFor(createSubject({ name: 'Dana Q. Vance' })));
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('query')).toBe('types.resourceTypeGeneral:Dissertation AND ((creators.familyName:"Vance" AND creators.givenName:"Dana") OR creators.name:"Vance, Dana")');
    expect(u.searchParams.get('fields[dois]')).not.toMatch(/descriptions|subjects/);
    expect(u.searchParams.get('page[size]')).toBe('25');
    expect(r.findings).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/hold no thesis by an author named Dana Q\. Vance.*neither confirms nor contradicts/);
    expect(r.partial).toBeUndefined();
  });

  test('a thesis at a school already known for the person is likely, with school, degree and year in data', async () => {
    fakeNet([['api.datacite.org/dois', page([
      thesis('10.99999/warw.1001', { given: 'Dana Q.', family: 'Vance', publisher: 'University of Warwick', year: 2019, type: 'Doctoral thesis', supervisors: ['Ola Brandt'] }),
    ])]]);
    const subject = createSubject({ name: 'Dana Vance', company: 'Hydra Freight' });
    addAnchor(subject, 'schools', 'University of Warwick', 'test');
    const r = await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject));
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.match).toBe('likely');
    expect(f.matchReasons[0]).toMatch(/granted by University of Warwick, already known/);
    expect(f.category).toBe('education');
    expect(f.title).toBe('Doctoral thesis: Fleet routing for hydrogen trucks (University of Warwick, 2019)');
    expect(f.url).toBe('https://doi.org/10.99999/warw.1001');
    expect(f.quote).toMatch(/Supervised by Ola Brandt/);
    expect(f.data).toEqual(expect.objectContaining({ registry: 'DataCite', school: 'University of Warwick', degree: 'Doctorate', year: '2019', kind: 'Doctoral thesis' }));
    expect(r.threads).toEqual([expect.objectContaining({ kind: 'school', value: 'University of Warwick', trusted: true })]);
  });

  test('a namesake stays possible, asks to verify identity, and opens no thread; other first names are dropped', async () => {
    fakeNet([['api.datacite.org/dois', page([
      thesis('10.99999/linc.2002', { given: 'Dana', family: 'Vance', publisher: 'University of Lincoln', year: 2025 }),
      // DataCite matches the given name anywhere in the field: "Lewis Dana" is someone else
      thesis('10.99999/linc.2003', { given: 'Lewis Dana', family: 'Vance', publisher: 'University of Lincoln' }),
      thesis('10.99999/warw.2004', { given: 'Danae', family: 'Vance', publisher: 'University of Warwick' }),
    ])]]);
    const r = await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(createSubject({ name: 'Dana Vance', company: 'Hydra Freight' })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible');
    expect(r.findings[0].matchFixed).toBe(true);
    expect(r.findings[0].matchReasons[0]).toMatch(/verify identity/);
    expect(r.threads).toEqual([]);
  });

  test('when theses under the name come from two schools, a school tie alone is held at possible', async () => {
    fakeNet([['api.datacite.org/dois', page([
      thesis('10.99999/warw.3001', { given: 'Dana', family: 'Vance', publisher: 'University of Warwick', year: 2019 }),
      thesis('10.99999/linc.3002', { given: 'Dana', family: 'Vance', publisher: 'University of Lincoln', year: 2011 }),
    ])]]);
    const subject = createSubject({ name: 'Dana Vance' });
    addAnchor(subject, 'schools', 'University of Warwick', 'test');
    const r = await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject));
    expect(r.findings).toHaveLength(2);
    expect(r.findings.every((f) => f.match === 'possible')).toBe(true);
    expect(r.findings.find((f) => /Warwick/.test(f.title)).matchReasons[0]).toMatch(/2 people .* may share that school: verify identity/);
    expect(r.notes.join(' ')).toMatch(/2 different schools/);
  });

  test('an ORCID an earlier tied record gave the person is a second fact', async () => {
    fakeNet([['api.datacite.org/dois', page([
      thesis('10.99999/eth.4001', { given: 'Dana', family: 'Vance', publisher: 'ETH Zurich', orcid: '0000-0002-1825-0097' }),
      thesis('10.99999/linc.4002', { given: 'Dana', family: 'Vance', publisher: 'University of Lincoln' }),
    ])]]);
    const earlier = [{ source: 'academic-record', match: 'likely', data: { orcid: '0000-0002-1825-0097' } }];
    const r = await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(createSubject({ name: 'Dana Vance' }), { findings: () => earlier }));
    const eth = r.findings.find((f) => /ETH Zurich/.test(f.title));
    expect(eth.match).toBe('likely');
    expect(eth.matchReasons[0]).toMatch(/ORCID 0000-0002-1825-0097/);
    expect(r.findings.find((f) => /Lincoln/.test(f.title)).match).toBe('possible');
    for (const f of r.findings) expect(f.match).not.toBe('confirmed');
  });

  test('a thesis title on a health matter is left out; the degree record stays', async () => {
    fakeNet([['api.datacite.org/dois', page([
      thesis('10.99999/warw.5001', { given: 'Dana', family: 'Vance', publisher: 'University of Warwick', title: 'Living with depression after a cancer diagnosis' }),
    ])]]);
    const r = await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(createSubject({ name: 'Dana Vance' })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].title).toBe('Thesis (University of Warwick, 2021)');
    expect(JSON.stringify(r.findings)).not.toMatch(/depression|cancer/i);
  });

  test('more theses than one page: partial, with a note', async () => {
    fakeNet([['api.datacite.org/dois', page([thesis('10.99999/x.6001', { given: 'Dana', family: 'Vance', publisher: 'University of Lincoln' })], 240)]]);
    const r = await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(createSubject({ name: 'Dana Vance' })));
    expect(r.partial).toEqual(['University theses (DataCite, first 1 of 240 read)']);
    expect(r.notes.join(' ')).toMatch(/lists 240 theses/);
  });

  test('a failed, changed or non-JSON answer is thrown, never "no thesis"', async () => {
    const subject = createSubject({ name: 'Dana Vance' });
    fakeNet([['api.datacite.org/dois', { __status: 500, body: 'error' }]]);
    await expect(dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject))).rejects.toThrow(/HTTP 500/);
    __resetCacheForTests();
    fakeNet([['api.datacite.org/dois', { errors: [{ status: '400', title: 'bad query' }] }]]);
    await expect(dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject))).rejects.toThrow(/unexpected answer/);
    __resetCacheForTests();
    fakeNet([['api.datacite.org/dois', page([{ id: '10.1/x', type: 'dois' }, { id: '10.1/y', type: 'dois' }])]]);
    await expect(dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject))).rejects.toThrow(/expected form/);
    __resetCacheForTests();
    fakeNet([['api.datacite.org/dois', '<html>maintenance</html>']]);
    await expect(dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject))).rejects.toThrow(/not JSON/);
  });

  test('one search per name a day', async () => {
    const calls = fakeNet([['api.datacite.org/dois', page([])]]);
    const subject = createSubject({ name: 'Dana Vance' });
    await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject));
    await dataciteThesesConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject));
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ NSF */

describe('nsf-awards', () => {
  // The real answer always carries these private fields, whatever is asked for.
  const award = (id, { first, middle = '', last, awardee, program = 'SBIR Phase I', type = 'Standard Grant', start = '07/15/2025', end = '06/30/2026', amount = '274999', title = 'Solid-state hydrogen storage for regional trucks', piId = '269000001', coPIs = [] }) => ({
    abstractText: 'This Small Business Innovation Research Phase I project ... the PI can be reached at the address below.',
    activeAwd: 'true', agency: 'NSF', awardee: String(awardee).toUpperCase(),
    awardeeAddress: '1200 Example Street Suite 4', awardeeCity: 'PHOENIX', awardeeCountryCode: 'US', awardeeName: awardee,
    awardeePhone: '6025550100', awardeeStateCode: 'AZ', awardeeZipCode: '850041234',
    coPDPI: coPIs.map((n) => `${n} ${n.split(' ')[0].toLowerCase()}@example.edu`),
    date: start, dirAbbr: 'TIP', divAbbr: 'TI', estimatedTotalAmt: amount, expDate: end, fundProgramName: program,
    fundsObligated: [`FY 2025 = $${amount}`], fundsObligatedAmt: amount, id,
    pdPIName: [first, middle, last].filter(Boolean).join(' '), perfAddress: '1200 Example Street Suite 4', perfZipCode: '850041234',
    pi: [`${[first, middle, last].filter(Boolean).join(' ')} ${first.toLowerCase()}@hydrafreight.example`],
    piEmail: `${first.toLowerCase()}@hydrafreight.example`, piFirstName: first, piId, piLastName: last, ...(middle ? { piMiddeInitial: middle } : {}),
    poEmail: 'officer@nsf.gov', poName: 'Program Officer Name', poPhone: '7032920000',
    startDate: start, title, transType: type,
  });
  const page = (award = [], totalCount = award.length) => ({ response: { award, metadata: { offset: 0, rpp: 25, totalCount } } });

  test('the person as principal investigator of an award to their company: likely, with institution, role and dates in data; nothing private kept', async () => {
    const calls = fakeNet([['api.nsf.gov/services/v1/awards.json', page([
      award('2500001', { first: 'Dana', middle: 'Q', last: 'Vance', awardee: 'Hydra Freight Inc', coPIs: ['Ola Brandt'] }),
    ])]]);
    const subject = createSubject({ name: 'Dana Vance', company: 'Hydra Freight' });
    const r = await nsfAwardsConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject));
    expect(new URL(calls[0].url).searchParams.get('pdPIName')).toBe('Dana Vance');
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.match).toBe('likely');
    expect(f.matchFixed).toBe(true);
    expect(f.matchReasons[0]).toMatch(/award went to Hydra Freight/);
    expect(f.url).toBe('https://www.nsf.gov/awardsearch/showAward?AWD_ID=2500001');
    expect(f.quote).toBe('Dana Q Vance, principal investigator, NSF award 2500001 to Hydra Freight Inc (AZ), SBIR Phase I, Standard Grant, 2025-07-15 to 2026-06-30, $274,999: Solid-state hydrogen storage for regional trucks. Co-investigators: Ola Brandt.');
    expect(f.data).toEqual(expect.objectContaining({ awardId: '2500001', institution: 'Hydra Freight Inc', role: 'Principal investigator', program: 'SBIR Phase I', amount: 274999, start: '2025-07-15', end: '2026-06-30', smallBusiness: true }));
    expect(JSON.stringify(r)).not.toMatch(PRIVATE);
    expect(JSON.stringify(r)).not.toMatch(/abstract|reached at/i);
    expect(r.threads).toEqual([expect.objectContaining({ kind: 'company', value: 'Hydra Freight Inc', trusted: true })]);
  });

  test('a namesake (a fellowship elsewhere) stays possible, asks to verify identity, and opens no thread', async () => {
    fakeNet([['api.nsf.gov/services/v1/awards.json', page([
      award('9500001', { first: 'Dana', middle: 'E', last: 'Vance', awardee: 'WA Fellowships', program: 'POP & COMMUNITY ECOL PROG', type: 'Fellowship Award', start: '10/01/1995', end: '03/31/1998', amount: '80000', title: 'Postdoctoral Research Fellowship in Biosciences', piId: '000208511' }),
      // a longer name that contains the person's is someone else
      award('2400002', { first: 'Dana', last: 'Vance Fay', awardee: 'University of Wyoming', piId: '269000002' }),
    ])]]);
    const r = await nsfAwardsConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(createSubject({ name: 'Dana Vance', company: 'Hydra Freight' })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible');
    expect(r.findings[0].matchReasons[0]).toMatch(/matched by name only.*verify identity/);
    expect(r.threads).toEqual([]);
  });

  test('a school tie alone is held at possible when two investigators share the name', async () => {
    fakeNet([['api.nsf.gov/services/v1/awards.json', page([
      award('2400010', { first: 'Dana', last: 'Vance', awardee: 'Cornell University', program: 'IUSE', piId: '1' }),
      award('2400011', { first: 'Dana', last: 'Vance', awardee: 'Boise State University', program: 'IUSE', piId: '2' }),
    ])]]);
    const subject = createSubject({ name: 'Dana Vance' });
    addAnchor(subject, 'schools', 'Cornell University', 'test');
    const r = await nsfAwardsConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject));
    expect(r.findings.every((f) => f.match === 'possible')).toBe(true);
    expect(r.findings.find((f) => /Cornell/.test(f.quote)).matchReasons[0]).toMatch(/2 people .* verify identity/);
    expect(r.notes.join(' ')).toMatch(/2 different investigators/);
  });

  test('the formal first name is searched too, at most two searches', async () => {
    const calls = fakeNet([['api.nsf.gov/services/v1/awards.json', page([])]]);
    const r = await nsfAwardsConnector.run({ kind: 'subject', value: 'Sam Vance' }, ctxFor(createSubject({ name: 'Sam Vance' })));
    expect(calls.map((c) => new URL(c.url).searchParams.get('pdPIName'))).toEqual(['Sam Vance', 'Samuel Vance']);
    expect(r.findings).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/holds no award with a principal investigator named Sam Vance/);
  });

  test('more awards than one page: partial, with a note', async () => {
    fakeNet([['api.nsf.gov/services/v1/awards.json', page([award('2400020', { first: 'Dana', last: 'Vance', awardee: 'Cornell University' })], 198)]]);
    const r = await nsfAwardsConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(createSubject({ name: 'Dana Vance' })));
    expect(r.partial).toEqual(['NSF awards (first 1 of 198 read)']);
    expect(r.notes.join(' ')).toMatch(/lists 198 awards/);
  });

  test('company: the exact awardee only, as a company record; the person as its investigator is likely', async () => {
    const calls = fakeNet([['api.nsf.gov/services/v1/awards.json', page([
      award('2500001', { first: 'Dana', last: 'Vance', awardee: 'Hydra Freight Inc' }),
      award('2500002', { first: 'Ola', last: 'Brandt', awardee: 'Hydra Freight Systems LLC' }),
    ])]]);
    const r = await nsfAwardsConnector.run({ kind: 'company', value: 'Hydra Freight' }, ctxFor(createSubject({ name: 'Dana Vance', company: 'Hydra Freight' })));
    expect(new URL(calls[0].url).searchParams.get('awardeeName')).toBe('Hydra Freight');
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.match).toBe('likely');
    expect(f.title).toBe('1 NSF award to Hydra Freight Inc, 2025');
    expect(f.quote).toMatch(/^Hydra Freight Inc \(AZ\): 1 NSF award, \$274,999 obligated, 2025\. Principal investigators: Dana Vance\./);
    expect(f.quote).not.toMatch(/Systems/);
    expect(JSON.stringify(r)).not.toMatch(PRIVATE);

    __resetCacheForTests();
    fakeNet([['api.nsf.gov/services/v1/awards.json', page([award('2500002', { first: 'Ola', last: 'Brandt', awardee: 'Hydra Freight Inc' })])]]);
    const other = await nsfAwardsConnector.run({ kind: 'company', value: 'Hydra Freight' }, ctxFor(createSubject({ name: 'Dana Vance', company: 'Hydra Freight' })));
    expect(other.findings[0].match).toBe('company');

    __resetCacheForTests();
    fakeNet([['api.nsf.gov/services/v1/awards.json', page([])]]);
    const none = await nsfAwardsConnector.run({ kind: 'company', value: 'Hydra Freight' }, ctxFor(createSubject({ name: 'Dana Vance', company: 'Hydra Freight' })));
    expect(none.findings).toEqual([]);
    expect(none.notes.join(' ')).toMatch(/holds no award to an organisation named Hydra Freight/);
  });

  test('a failed or changed answer is thrown, never "no award"', async () => {
    const subject = createSubject({ name: 'Dana Vance', company: 'Hydra Freight' });
    fakeNet([['api.nsf.gov/services/v1/awards.json', { __status: 500, body: 'error' }]]);
    await expect(nsfAwardsConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject))).rejects.toThrow(/HTTP 500/);
    __resetCacheForTests();
    fakeNet([['api.nsf.gov/services/v1/awards.json', { response: { serviceNotification: [{ notificationType: 'ERROR', notificationMessage: 'Invalid parameter' }] } }]]);
    await expect(nsfAwardsConnector.run({ kind: 'company', value: 'Hydra Freight' }, ctxFor(subject))).rejects.toThrow(/unexpected answer \(Invalid parameter\)/);
    __resetCacheForTests();
    fakeNet([['api.nsf.gov/services/v1/awards.json', page([{ title: 'x' }, { title: 'y' }])]]);
    await expect(nsfAwardsConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject))).rejects.toThrow(/expected form/);
  });

  test('one name form failing leaves the lookup partial, with a note', async () => {
    fakeNet([
      [(url) => url.includes('pdPIName=Samuel'), { __status: 500, body: 'error' }],
      ['api.nsf.gov/services/v1/awards.json', page([])],
    ]);
    const r = await nsfAwardsConnector.run({ kind: 'subject', value: 'Sam Vance' }, ctxFor(createSubject({ name: 'Sam Vance' })));
    expect(r.partial).toEqual(['NSF awards (one name form not searched)']);
    expect(r.notes.join(' ')).toMatch(/not for Samuel Vance/);
  });

  test('requests wait their turn at the NSF host', async () => {
    __resetAcademicMoreForTests({ unpaced: false });
    fakeNet([['api.nsf.gov/services/v1/awards.json', page([])]]);
    const subject = createSubject({ name: 'Dana Vance' });
    await nsfAwardsConnector.run({ kind: 'subject', value: 'Dana Vance' }, ctxFor(subject));
    // The search loads under the cache's own deadline (round 4): the request waits its turn instead of giving up,
    // while a caller whose own time runs out first is told it ran out of time.
    await expect(nsfAwardsConnector.run({ kind: 'company', value: 'Hydra Freight' }, { ...ctxFor(subject), deadline: Date.now() + 300 })).rejects.toThrow(/Out of time/);
    const started = Date.now();
    await nsfAwardsConnector.run({ kind: 'company', value: 'Hydra Freight' }, { ...ctxFor(subject), deadline: Date.now() + 5000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });
});

/* ------------------------------------------------------------------ live (FOUNDER_LIVE=1 only) */

const live = process.env.FOUNDER_LIVE === '1' ? describe : describe.skip;
live('live services (public test subjects)', () => {
  beforeEach(() => setTransport());
  test('DataCite and NSF answer for Elizabeth Holmes / Theranos', async () => {
    __resetAcademicMoreForTests({ unpaced: false });
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const ctx = { subject, deadline: Date.now() + 40000, known: () => ({}) };
    const d = await dataciteThesesConnector.run({ kind: 'subject', value: subject.name }, ctx);
    const n = await nsfAwardsConnector.run({ kind: 'subject', value: subject.name }, ctx);
    const c = await nsfAwardsConnector.run({ kind: 'company', value: 'Theranos' }, ctx);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ d, n, c }, null, 1));
    for (const f of [...d.findings, ...n.findings]) expect(f.match).toBe('possible');
    expect(JSON.stringify(n)).not.toMatch(/@/);
  }, 60000);
});
