/**
 * Round-2 grading fixes in courts.js: company names are compared after
 * removing legal forms only, a one-word company needs a legal form on the
 * case side, and a case between the company the person runs and exactly
 * their surname is graded likely.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { sameCompany, partyIsCompany, courtRecordsOpenConnector, courtDocketsConnector, ukCaseLawConnector, __resetCourtsForTests } = require('../../../src/server/founder/sources/courts');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const respond = (body) => ({ status: 200, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function fakeNet(routes) {
  setTransport(async (url) => {
    const hit = routes.find(([part]) => url.includes(part));
    return hit ? respond(hit[1]) : { status: 404, headers: new Map(), url, text: async () => 'not found' };
  });
}
const iaDocs = (titles) => ({ response: { numFound: titles.length, docs: titles.map((t, i) => ({ identifier: `gov.uscourts.azd.${i + 1}`, title: t, court: 'azd' })) } });

beforeEach(() => __resetCourtsForTests());
afterEach(() => { setTransport(); delete process.env.COURTLISTENER_API_TOKEN; });

describe('sameCompany keeps descriptors', () => {
  test('a company with a descriptor matches only names that carry it', () => {
    expect(sameCompany('Mistral AI, Inc.', 'Mistral AI')).toBe(true);
    expect(sameCompany('MISTRAL AI SAS', 'Mistral AI')).toBe(true);
    expect(sameCompany('Mistral, Inc.', 'Mistral AI')).toBe(false);
    expect(sameCompany('Mistral', 'Mistral AI')).toBe(false);
    expect(sameCompany('Nikola Corporation', 'Nikola')).toBe(true);
  });

  test('a one-word company on a case side needs a legal form', () => {
    expect(partyIsCompany('Flow', 'Flow')).toBe(false);
    expect(partyIsCompany('We', 'We Co.')).toBe(false);
    expect(partyIsCompany('Flow, Inc.', 'Flow')).toBe(true);
    expect(partyIsCompany('Nikola Corp.', 'Nikola')).toBe(true);
    expect(partyIsCompany('Mistral AI', 'Mistral AI')).toBe(true);
  });
});

describe('court-records-open (company)', () => {
  test('dockets of other companies with the same core word, and people named after it, are left out', async () => {
    fakeNet([['archive.org', iaDocs(['Mistral, Inc. v. Skydax, LLC.', 'DeMoss v. Mistral, Inc.', 'PICARD v. Mistral (SPC)', 'Mistral AI, Inc. v. Acme LLC'])]]);
    const out = await courtRecordsOpenConnector.run({ kind: 'company', value: 'Mistral AI' }, ctxFor(createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' })));
    expect(out.findings.map((f) => f.quote)).toEqual(['Mistral AI, Inc. v. Acme LLC']);
  });

  test('a person whose surname is the one-word company name is not the company', async () => {
    fakeNet([['archive.org', iaDocs(['Flow v. Payne', 'Paymentwall, Inc. v. We', 'Flow, Inc. v. Smith'])]]);
    const flow = await courtRecordsOpenConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'Flow' })));
    expect(flow.findings.map((f) => f.quote)).toEqual(['Flow, Inc. v. Smith']);
    __resetCourtsForTests();
    const we = await courtRecordsOpenConnector.run({ kind: 'company', value: 'We Co.' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'We Co.' })));
    expect(we.findings).toHaveLength(0);
  });

  test('the given company against exactly the surname is likely, never confirmed', async () => {
    fakeNet([['archive.org', iaDocs(['Nikola Corporation v. Milton', 'Nikola Corporation v. Smith'])]]);
    const out = await courtRecordsOpenConnector.run({ kind: 'company', value: 'Nikola Corporation' }, ctxFor(createSubject({ name: 'Trevor Milton', company: 'Nikola' })));
    const byQuote = Object.fromEntries(out.findings.map((f) => [f.quote, f]));
    expect(byQuote['Nikola Corporation v. Milton'].match).toBe('likely');
    expect(byQuote['Nikola Corporation v. Milton'].matchReasons[0]).toMatch(/between Nikola Corporation and Milton; Trevor Milton founded or runs Nikola Corporation/);
    expect(byQuote['Nikola Corporation v. Smith'].match).toBe('company');
  });

  test('a company they are only an affiliate of, or one never given, stays a company record', async () => {
    fakeNet([['archive.org', iaDocs(['Alfred Inc. v. Neumann'])]]);
    const affiliate = await courtRecordsOpenConnector.run({ kind: 'company', value: 'Alfred Inc.', tie: 'affiliate' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'Alfred' })));
    expect(affiliate.findings[0].match).toBe('company');
    const notGiven = await courtRecordsOpenConnector.run({ kind: 'company', value: 'Alfred Inc.' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'WeWork' })));
    expect(notGiven.findings[0].match).toBe('company');
  });
});

describe('court-dockets and case law (company)', () => {
  test('a CourtListener docket whose only match is a bare one-word party is left out', async () => {
    process.env.COURTLISTENER_API_TOKEN = 'test-token';
    fakeNet([['courtlistener.com', { count: 2, results: [
      { caseName: 'Flow v. Keaton', docketNumber: '1:20-cv-1', court_id: 'txsd', dateFiled: '2020-01-01', docket_absolute_url: '/docket/1/flow-v-keaton/', party: ['Flow', 'Keaton'] },
      { caseName: 'Flow, Inc. v. Keaton', docketNumber: '1:20-cv-2', court_id: 'txsd', dateFiled: '2020-01-01', docket_absolute_url: '/docket/2/flow-inc-v-keaton/', party: ['Flow, Inc.', 'Keaton'] },
    ] }]]);
    const out = await courtDocketsConnector.run({ kind: 'company', value: 'Flow', template: 'dockets.company' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'Flow' })));
    expect(out.findings.map((f) => f.url)).toEqual(['https://www.courtlistener.com/docket/2/flow-inc-v-keaton/']);
  });

  test('a UK judgment against a person named after the company is left out', async () => {
    const entry = (title, n) => `<entry><title>${title}</title><link href="https://caselaw.nationalarchives.gov.uk/ewhc/ch/2024/${n}" rel="alternate"/><published>2024-01-0${n}T00:00:00+00:00</published><author><name>High Court</name></author><summary type="html"/><tna:identifier slug="x" type="ukncn">[2024] EWHC ${n} (Ch)</tna:identifier></entry>`;
    fakeNet([['caselaw.nationalarchives.gov.uk', `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:tna="https://caselaw.nationalarchives.gov.uk"><title>x</title>${entry('Flow v Payne', 1)}${entry('Flow Ltd v Payne', 2)}</feed>`]]);
    const out = await ukCaseLawConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'Adam Neumann', company: 'Flow' })));
    expect(out.findings.map((f) => f.title).join(' | ')).not.toMatch(/Flow v Payne/);
    expect(out.findings).toHaveLength(1);
  });
});
