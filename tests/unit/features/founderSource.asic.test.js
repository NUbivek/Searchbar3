/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const {
  asicBannedConnector, parsePersons, parseOrgs, currentFile, givenFirst, auDate, banText, PERSONS_PAGE, ORGS_PAGE, ASIC_ID,
} = require('../../../src/server/founder/sources/asic');

/* ------------------------------------------------------------------ */
/* Fixtures in the shapes data.gov.au served on 20 Nov 2026            */
/* (shortened; every person and company is invented)                   */
/* ------------------------------------------------------------------ */

const PER_HEADER = 'REGISTER_NAME\tBD_PER_NAME\tBD_PER_TYPE\tBD_PER_DOC_NUM\tBD_PER_START_DT\tBD_PER_END_DT\tBD_PER_ADD_LOCAL\tBD_PER_ADD_STATE\tBD_PER_ADD_PCODE\tBD_PER_ADD_COUNTRY\tBD_PER_COMMENTS';
const per = (name, type, doc, start, end, suburb, state, pcode, country, comment) => ['Banned and Disqualified Persons', name, type, doc, start, end, suburb, state, pcode, country, comment].join('\t');
const PER_FILLER = Array.from({ length: 3100 }, (_, i) => per(`FILLERSON${i}, PAT`, 'Disq. Director', `#0${100000000 + i}`, '01/01/2010', '01/01/2013', 'SOMEWHERE', 'VIC', '3000', 'AUSTRALIA', 'No comment made'));
const PERSONS = `﻿${[
  PER_HEADER,
  per('ARBUCKLE, QUENTIN', 'AFS Banned & Disqualified', '#029111222', '05/05/2015', '', 'GLENBROOKVALE', 'NSW', '9871', 'AUSTRALIA', 'No comment made'),
  per('ARBUCKLE, QUENTIN MARLOWE', 'Disq. Director', '#031333444', '25/02/2023', '24/02/2099', 'WOMBARRA HEIGHTS', 'QLD', '9872', 'AUSTRALIA', ' Former director of Vexlor Robotics Pty Ltd. On 3 July 2024  the Tribunal affirmed ASIC\'s decision. <a href="http://www.asic.gov.au/x.pdf">Order</a>'),
  // the company named only in a later sentence about "Mr ...", away from the full name: the shared matcher does not tie it
  per('KELLERMAN, BRYNNE', 'Disq. Director', '#031333555', '25/02/2023', '24/02/2099', 'SOMEWHERE', 'SA', '9873', 'AUSTRALIA', ' On 3 July 2024  the Tribunal affirmed ASIC\'s decision to disqualify Ms Kellerman, a former director of Vexlor Robotics Pty Ltd.'),
  per('ZABRINSKI, OTTILIE', 'Banned Securities', '#004289112', '29/03/1994', '29/03/1999', 'TEMPLESTOWE NORTH', 'VIC', '3107', 'AUSTRALIA', 'No comment made'),
  per('PELLINGTON, DORIAN', 'Credit Banned & Disqualified', '#014859572', '28/03/2001', '', 'NOWHERE', '', '', 'ADDRESS UNKNOWN', 'No comment made'),
  ...PER_FILLER,
].join('\r\n')}\r\n`;

const ORG_HEADER = 'REGISTER_NAME\tBD_ORG_ACN\tBD_ORG_NAME\tBD_ORG_TYPE\tBD_ORG_URL\tBD_ORG_START_DT\tBD_ORG_END_DT\tBD_ORG_COMMENT';
const org = (acn, name, type, url, start, end, comment) => ['Banned and Disqualified Organisations', acn, name, type, url, start, end, comment].join('\t');
const ORGS = `﻿${[
  ORG_HEADER,
  org('081402379', 'GLIMMERWAY FINANCIAL ADVISERS PTY LTD', 'Australian Financial Services banning', 'Not available', '07/11/2006', '07/11/2008', 'No comment made'),
  org('008876033', 'QUARRELL & DIXBY PTY LTD', 'Credit banning by a State or Territory', 'http://asic.gov.au/online-services/search-asics-registers/additional-searches/register-of-persons-banned/', '10/04/2001', '', 'No comment made'),
  org('011021640', 'NORTHBRIDGE LENDING PTY LTD (Formerly CLIFTWOOD PARTNERS FINANCE PTY LTD)', 'Credit banning by a State or Territory', 'Not available', '21/11/2001', '', 'No comment made'),
  org('052177009', 'FLOW PTY LTD', 'Credit banning', 'Not available', '24/06/2013', 'Permanent banning', 'No comment made'),
  org('123456789', 'VEXLOR ROBOTICS PTY LTD', 'Section 920A banning', 'Not available', '05/10/2022', '04/10/2099', 'Fail to comply with fs law and not trained or competent'),
  org('987654321', 'TIDEMARK FX GROUP PTY LTD', 'Australian Financial Services banning', 'Not available', '17/12/2014', '16/12/2018', 'No comment made'),
].join('\r\n')}\r\n`;

const pkg = (dataset, file, name) => JSON.stringify({
  help: 'https://data.gov.au/data/api/3/action/help_show?name=package_show',
  success: true,
  result: {
    name: dataset,
    license_title: 'Creative Commons Attribution 3.0 Australia',
    resources: [
      { format: 'PDF', name: `${name} - Help File`, last_modified: '2025-03-14T00:45:24.217294', url: `https://data.gov.au/data/dataset/x/resource/a/download/help.pdf` },
      { format: 'CSV', name: `${name} - Current`, last_modified: '2026-11-16T21:04:14.541596', url: `https://data.gov.au/data/dataset/x/resource/b/download/${file}.csv` },
      { format: 'TSV', name: `${name} - Current`, last_modified: '2026-11-16T21:04:17.323094', mimetype: 'text/tab-separated-values', url: `https://data.gov.au/data/dataset/x/resource/c/download/${file}.tsv` },
    ],
  },
});
const ROUTES = {
  'package_show?id=asic-banned-disqualified-per': pkg('asic-banned-disqualified-per', 'bd_per_202611', 'Banned and Disqualified Persons'),
  'package_show?id=asic-banned-disqualified-org': pkg('asic-banned-disqualified-org', 'bd_org_202611', 'Banned and Disqualified Organisations'),
  'bd_per_202611.tsv': PERSONS,
  'bd_org_202611.tsv': ORGS,
};

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

const ENV_ON = process.env.FOUNDER_SOURCES_ON;
const ENV_OFF = process.env.FOUNDER_SOURCES_OFF;
beforeEach(() => {
  __resetCacheForTests(); calls = [];
  process.env.FOUNDER_SOURCES_ON = 'podcast-episodes, asic-banned';
  delete process.env.FOUNDER_SOURCES_OFF;
});
afterEach(() => setTransport());
afterAll(() => {
  if (ENV_ON === undefined) delete process.env.FOUNDER_SOURCES_ON; else process.env.FOUNDER_SOURCES_ON = ENV_ON;
  if (ENV_OFF === undefined) delete process.env.FOUNDER_SOURCES_OFF; else process.env.FOUNDER_SOURCES_OFF = ENV_OFF;
});

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000 });
const subjectTask = (subject) => ({ kind: 'subject', value: subject.name, template: 'asic.banned', depth: 0 });

/* ------------------------------------------------------------------ */

describe('switch', () => {
  test('off unless FOUNDER_SOURCES_ON names it; FOUNDER_SOURCES_OFF wins', () => {
    expect(asicBannedConnector.id).toBe(ASIC_ID);
    expect(asicBannedConnector.unavailableReason).toBe('not enabled on this deployment');
    expect(asicBannedConnector.enabled()).toBe(true);
    delete process.env.FOUNDER_SOURCES_ON;
    expect(asicBannedConnector.enabled()).toBe(false);
    process.env.FOUNDER_SOURCES_ON = 'asic-banned-other';
    expect(asicBannedConnector.enabled()).toBe(false);
    process.env.FOUNDER_SOURCES_ON = 'asic-banned';
    process.env.FOUNDER_SOURCES_OFF = 'asic-banned';
    expect(asicBannedConnector.enabled()).toBe(false);
  });

  test('a lookup while off asks nothing and is reported as not run', async () => {
    delete process.env.FOUNDER_SOURCES_ON;
    serve(ROUTES);
    const subject = createSubject({ name: 'Quentin Arbuckle', company: 'Vexlor Robotics' });
    const out = await asicBannedConnector.run(subjectTask(subject), ctxFor(subject));
    expect(calls).toHaveLength(0);
    expect(out.findings).toEqual([]);
    expect(out.partial.length).toBeGreaterThan(0);
  });
});

describe('reading the register', () => {
  test('small helpers', () => {
    expect(givenFirst('ARBUCKLE, QUENTIN MARLOWE')).toBe('QUENTIN MARLOWE ARBUCKLE');
    expect(givenFirst('NOCOMMA NAME')).toBe('NOCOMMA NAME');
    expect(auDate('05/05/2015')).toBe('2015-05-05');
    expect(auDate('Permanent banning')).toBe('');
    expect(banText('Disq. Director')).toBe('Disqualified from managing corporations');
    expect(banText('Something New')).toBe('Something New');
  });

  test('persons: given name first; suburb, postcode and document number never kept; state kept; comment cleaned', () => {
    const index = parsePersons(PERSONS, { asOf: '2026-11-16' });
    expect(index.asOf).toBe('2026-11-16');
    const q = index.rows.find((r) => r.n === 'QUENTIN MARLOWE ARBUCKLE');
    expect(q).toMatchObject({ t: 'person', k: 'Disq. Director', d: '2023-02-25', e: '2099-02-24', s: 'QLD' });
    expect(q.c).toMatch(/Vexlor Robotics/);
    expect(q.c).not.toMatch(/<a|href/);
    expect(index.rows.find((r) => r.n === 'QUENTIN ARBUCKLE').c).toBeUndefined();
    expect(index.rows.find((r) => r.n === 'DORIAN PELLINGTON').s).toBeUndefined();
    const json = JSON.stringify(index);
    expect(json).not.toMatch(/GLENBROOKVALE|WOMBARRA|TEMPLESTOWE|9871|9872|#029111222|#031333444|ADDRESS UNKNOWN/);
  });

  test('organisations: aliases from "Formerly", company number not kept, ASIC link kept', () => {
    const index = parseOrgs(ORGS);
    const nb = index.rows.find((r) => /NORTHBRIDGE/.test(r.n));
    expect(nb.n).toBe('NORTHBRIDGE LENDING PTY LTD');
    expect(nb.a).toEqual(['CLIFTWOOD PARTNERS FINANCE PTY LTD']);
    expect(index.rows.find((r) => /QUARRELL/.test(r.n)).u).toMatch(/^https:\/\/asic\.gov\.au\//);
    expect(index.rows.find((r) => /^FLOW/.test(r.n)).e).toBe('Permanent banning');
    expect(JSON.stringify(index)).not.toMatch(/081402379|008876033/);
  });

  test('a reshaped, cut or empty file is an error, never a short list', () => {
    expect(() => parsePersons(PERSONS.replace('BD_PER_COMMENTS', 'BD_PER_NOTE'))).toThrow(/expected format/);
    expect(() => parsePersons(`${PER_HEADER}\n${per('X, Y', 'Disq. Director', '#1', '', '', '', '', '', '', '')}\n`)).toThrow(/too few/);
    expect(() => parsePersons('')).toThrow(/expected format/);
    expect(() => parseOrgs(`${ORG_HEADER}\n`)).toThrow(/too few/);
    // many rows with a column missing: the format changed
    const broken = [PER_HEADER, ...PER_FILLER.map((l) => l.split('\t').slice(0, 10).join('\t'))].join('\n');
    expect(() => parsePersons(broken)).toThrow(/expected format/);
  });

  test('the catalogue entry: the current TSV file, or an error', () => {
    const file = currentFile(JSON.parse(ROUTES['package_show?id=asic-banned-disqualified-per']), 'x');
    expect(file).toEqual({ url: 'https://data.gov.au/data/dataset/x/resource/c/download/bd_per_202611.tsv', asOf: '2026-11-16' });
    expect(() => currentFile({ success: false }, 'x')).toThrow(/expected format/);
    expect(() => currentFile({ success: true, result: { resources: [{ format: 'TSV', name: 'Current', url: 'https://elsewhere.example/x.tsv' }] } }, 'x')).toThrow(/no current file/);
  });
});

describe('screening a person', () => {
  test('a name-only match stays possible and says verify identity; the record naming the given company is likely at most, never confirmed', async () => {
    serve(ROUTES);
    const subject = createSubject({ name: 'Quentin Arbuckle', company: 'Vexlor Robotics' });
    const out = await asicBannedConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings).toHaveLength(2);
    for (const f of out.findings) {
      expect(f).toMatchObject({ source: 'asic-banned', category: 'regulatory', url: PERSONS_PAGE });
      expect(f.match).not.toBe('confirmed');
    }
    const plain = out.findings.find((f) => /Banned from providing financial services/.test(f.title));
    expect(plain.match).toBe('possible');
    expect(plain.title).toMatch(/verify identity/);
    expect(plain.severity).toBe('high');
    const named = out.findings.find((f) => /Disqualified from managing corporations/.test(f.title));
    expect(named.match).toBe('likely');
    expect(named.quote).toMatch(/State: QLD/);
    // only two downloads (catalogue + file), and the second lookup reads the cache
    expect(calls).toHaveLength(2);
    await asicBannedConnector.run(subjectTask(subject), ctxFor(subject));
    expect(calls).toHaveLength(2);
  });

  test('no suburb, postcode or document number reaches a finding', async () => {
    serve(ROUTES);
    const subject = createSubject({ name: 'Quentin Arbuckle', company: 'Vexlor Robotics' });
    const out = await asicBannedConnector.run(subjectTask(subject), ctxFor(subject));
    expect(JSON.stringify(out)).not.toMatch(/GLENBROOKVALE|WOMBARRA|9871|9872|#029111222|#031333444/);
  });

  test('an ended ban is shown as ended, with medium severity', async () => {
    serve(ROUTES);
    const subject = createSubject({ name: 'Ottilie Zabrinski', company: 'Unrelated Labs' });
    const out = await asicBannedConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].title).toMatch(/^Formerly banned from securities dealing in Australia \(ended 1999-03-29\)/);
    expect(out.findings[0].severity).toBe('medium');
    expect(out.findings[0].match).toBe('possible');
  });

  test('a company named far from the full name does not raise the grade', async () => {
    serve(ROUTES);
    const subject = createSubject({ name: 'Brynne Kellerman', company: 'Vexlor Robotics' });
    const out = await asicBannedConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].title).toMatch(/verify identity/);
  });

  test('part of a name or another given name never matches; a clean screen says what was searched', async () => {
    serve(ROUTES);
    for (const name of ['Quentin Arbuck', 'Marlowe Smith', 'Ottilie Arbuckle']) {
      const subject = createSubject({ name, company: 'Unrelated Labs' });
      const out = await asicBannedConnector.run(subjectTask(subject), ctxFor(subject));
      expect(out.findings).toEqual([]);
      expect(out.notes.join(' ')).toMatch(new RegExp(`searched for ${name} \\(register file of 2026-11-16\\) and found no entry`));
      expect(out.partial).toBeUndefined();
    }
  });

  test('a one-word name is not screened, and says so as partial', async () => {
    serve(ROUTES);
    const subject = createSubject({ name: 'Quentin Arbuckle', company: 'Vexlor Robotics' });
    const out = await asicBannedConnector.run({ kind: 'associate', value: 'Quentin', relation: 'associate' }, ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.partial.length).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test('an associate hit is possible, names who it is about, and says verify identity', async () => {
    serve(ROUTES);
    const subject = createSubject({ name: 'Harriet Vonnegrass', company: 'Tidewell Systems' });
    const out = await asicBannedConnector.run({ kind: 'associate', value: 'Dorian Pellington', relation: 'co-founder' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].title).toMatch(/^Co-founder Dorian Pellington: Banned from engaging in credit activities/);
    expect(out.findings[0].title).toMatch(/verify identity/);
    expect(out.findings[0].match).toBe('possible');
  });
});

describe('screening a company', () => {
  test('a multi-word company name matches its whole name, and a former name', async () => {
    serve(ROUTES);
    const subject = createSubject({ name: 'Quentin Arbuckle', company: 'Vexlor Robotics' });
    const out = await asicBannedConnector.run({ kind: 'company', value: 'Vexlor Robotics' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'company', url: ORGS_PAGE, severity: 'high' });
    expect(out.findings[0].title).toBe('Banned in Australia: VEXLOR ROBOTICS PTY LTD');
    const former = await asicBannedConnector.run({ kind: 'company', value: 'Cliftwood Partners Finance' }, ctxFor(subject));
    expect(former.findings).toHaveLength(1);
    expect(former.findings[0].quote).toMatch(/Also listed as: CLIFTWOOD PARTNERS FINANCE PTY LTD/);
  });

  test('a one ordinary word company is a name match only; part of a name never matches', async () => {
    serve(ROUTES);
    const subject = createSubject({ name: 'Quentin Arbuckle', company: 'Flow' });
    const out = await asicBannedConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].title).toMatch(/verify identity/);
    expect(out.findings[0].matchReasons.join(' ')).toMatch(/ordinary word/);
    const none = await asicBannedConnector.run({ kind: 'company', value: 'Tidemark' }, ctxFor(subject));
    expect(none.findings).toEqual([]);
    expect(none.notes.join(' ')).toMatch(/searched for Tidemark .*found no entry/);
  });

  test('a company the check learned a legal name for is searched under every known name', async () => {
    serve(ROUTES);
    const { addCompanyAlias } = require('../../../src/server/founder/identity');
    const subject = createSubject({ name: 'Quentin Arbuckle', company: 'Glimmerway' });
    addCompanyAlias(subject, { company: 'Glimmerway', alias: 'Glimmerway Financial Advisers Pty Ltd', origin: 'test-register' });
    const out = await asicBannedConnector.run({ kind: 'company', value: 'Glimmerway' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
    expect(out.findings[0].title).toMatch(/^Formerly banned in Australia \(ended 2008-11-07\)/);
  });
});

describe('failures', () => {
  test('a catalogue that does not answer is an error, never "no match"', async () => {
    serve({ ...ROUTES, 'package_show?id=asic-banned-disqualified-per': { status: 500, body: 'down' } });
    const subject = createSubject({ name: 'Quentin Arbuckle', company: 'Vexlor Robotics' });
    await expect(asicBannedConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow();
  });

  test('an emptied or reshaped file is an error', async () => {
    serve({ ...ROUTES, 'bd_per_202611.tsv': `${PER_HEADER}\n` });
    const subject = createSubject({ name: 'Quentin Arbuckle', company: 'Vexlor Robotics' });
    await expect(asicBannedConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/too few/);
    __resetCacheForTests();
    serve({ ...ROUTES, 'bd_org_202611.tsv': '<html>maintenance</html>' });
    await expect(asicBannedConnector.run({ kind: 'company', value: 'Vexlor Robotics' }, ctxFor(subject))).rejects.toThrow(/expected format/);
  });

  test('the contract the registry test holds every source to', () => {
    const c = asicBannedConnector;
    expect(c.id).toMatch(/^[a-z0-9-]+$/);
    expect(c.label).not.toMatch(/\b(api|endpoint|api key|token|free|paid|tier|env)\b/i);
    expect(c.unavailableReason).not.toMatch(/\b(api|endpoint|api key|token|free|paid|tier|env)\b/i);
    expect(c.unavailableReason.length).toBeGreaterThan(10);
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    for (const p of c.plan({ kind: 'subject', value: 'Elizabeth Holmes' }, subject)) expect(p.template).not.toMatch(/holmes|theranos/i);
  });
});
