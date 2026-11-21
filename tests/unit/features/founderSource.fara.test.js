/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const zlib = require('zlib');
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addCompanyAlias } = require('../../../src/server/founder/identity');
const {
  faraConnector, unzipSingle, parseShortForms, parseRegistrants, parsePrincipals, registrantNames, isIndividualRegistrant,
  isoDate, csvText, FILES, FARA_PAGE, FARA_NOTE, MIN_ROWS,
} = require('../../../src/server/founder/sources/fara');

/* ------------------------------------------------------------------ */
/* Fixtures in the shape the FARA bulk files had on 20 Nov 2026         */
/* (invented people and companies; quoted CSV, windows-1252, one zip   */
/* entry each)                                                          */
/* ------------------------------------------------------------------ */

const mdy = (daysAgo) => {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
const RECENT = mdy(8);
const q = (cells) => cells.map((c) => `"${c}"`).join(',');

const SF_HEADER = q(['Short Form Termination Date', 'Short Form Date', 'Short Form Last Name', 'Short Form First Name', 'Registration Number', 'Registration Date', 'Registrant Name', 'Address 1', 'Address 2', 'City', 'State', 'Zip']);
const RG_HEADER = q(['Registration Number', 'Registration Date', 'Termination Date', 'Name', 'Business Name', 'Address 1', 'Address 2', 'City', 'State', 'Zip']);
const FP_HEADER = q(['Foreign Principal Termination Date', 'Foreign Principal', 'Foreign Principal Registration Date', 'Country/Location Represented', 'Registration Number', 'Registrant Date', 'Registrant Name', 'Address 1', 'Address 2', 'City', 'State', 'Zip']);

const shortForms = (extra = [], filler = MIN_ROWS.shortForms) => [
  SF_HEADER,
  q(['', RECENT, 'Quill', 'Marta', '9001', '03/02/2019', 'Harbor Lantern Strategies LLC', '12 Secret Lane', 'Apt 4', 'Arlington', 'VA', '22201']),
  q(['06/30/2022', '01/15/2020', 'Pell', 'Dorian', '9003', '01/10/2020', 'Velloria Robotics, Inc.', '77 Hidden Road', '', 'Austin', 'TX', '78701']),
  q(['', '05/05/2021', 'Quill', 'Martin', '9001', '03/02/2019', 'Harbor Lantern Strategies LLC', '1 Other Way', '', 'Reston', 'VA', '20190']),
  q(['', '05/05/2021', 'O\x92Brennan', 'Siobhan', '9001', '03/02/2019', 'Harbor Lantern Strategies LLC', '', '', '', '', '']),
  ...extra,
  ...Array.from({ length: filler }, (_, i) => q(['', '01/01/2015', `Fillerlast${i}`, `Fillerfirst${i}`, String(100 + (i % 50)), '01/01/2010', 'Filler Firm', '', '', '', '', ''])),
].join('\r\n') + '\r\n';

const registrants = (extra = [], filler = MIN_ROWS.registrants) => [
  RG_HEADER,
  q(['9001', '03/02/2019', '', 'Harbor Lantern Strategies LLC', '', '500 Office Park', '', 'Washington', 'DC', '20001']),
  q(['9002', RECENT, '', 'Quill, Marta', '', '12 Secret Lane', '', 'Arlington', 'VA', '22201']),
  q(['9003', '01/10/2020', '06/30/2022', 'Velloria Robotics, Inc.', '', '77 Hidden Road', '', 'Austin', 'TX', '78701']),
  q(['9004', '02/02/2023', '', 'Flow LLC', '', '', '', '', '', '']),
  q(['9005', '04/04/2024', '', 'Bramblecrest Media LLC - DBA Starling Signal LLC', '', '', '', '', '', '']),
  ...extra,
  ...Array.from({ length: filler }, (_, i) => q([String(10000 + i), '01/01/2010', '01/01/2012', `Filler Agency ${i} LLC`, '', '', '', '', '', ''])),
].join('\r\n') + '\r\n';

const principals = (extra = [], filler = MIN_ROWS.principals) => [
  FP_HEADER,
  q(['', 'Ministry of Tourism of Examplestan', RECENT, 'EXAMPLESTAN', '9001', '03/02/2019', 'Harbor Lantern Strategies LLC', 'Palace Road 1', '', 'Exampleville', '', '']),
  q(['12/31/2020', 'Examplestan National Oil Company', '03/02/2019', 'EXAMPLESTAN', '9001', '03/02/2019', 'Harbor Lantern Strategies LLC', '', '', '', '', '']),
  q(['', 'Norland Shipping AS', '01/10/2020', 'NORWAY', '9003', '01/10/2020', 'Velloria Robotics, Inc.', 'Harbour Street 5', '', 'Bergen', '', '']),
  q(['', 'Kestrel Valley Holdings Ltd', '06/01/2024', 'UNITED KINGDOM', '9005', '04/04/2024', 'Bramblecrest Media LLC - DBA Starling Signal LLC', '', '', '', '', '']),
  ...extra,
  ...Array.from({ length: filler }, (_, i) => q(['', `Filler Principal ${i}`, '01/01/2012', 'FILLERLAND', String(100 + (i % 50)), '01/01/2010', 'Filler Firm', '', '', '', '', ''])),
].join('\r\n') + '\r\n';

/** A zip with the given entries, written the way the FARA files are (deflate, sizes in the headers). */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, { method = 8 } = {}] of entries) {
    const data = Buffer.from(text, 'latin1');
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, 'latin1');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
const zipOf = (name, text) => makeZip([[name, text]]);

const SF_ZIP = zipOf('FARA_All_ShortForms.csv', shortForms());
const RG_ZIP = zipOf('FARA_All_Registrants.csv', registrants());
const FP_ZIP = zipOf('FARA_All_ForeignPrincipals.csv', principals());
const ALL = { [FILES.shortForms]: SF_ZIP, [FILES.registrants]: RG_ZIP, [FILES.principals]: FP_ZIP };

/* ------------------------------------------------------------------ */
/* Fake network                                                        */
/* ------------------------------------------------------------------ */

let calls = [];
function serve(routes) {
  setTransport(async (url) => {
    calls.push(url);
    const r = routes[url];
    const headers = { get: (h) => (/content-type/i.test(h) ? 'application/zip' : null) };
    if (!r) return { status: 404, headers, url, text: async () => 'not found' };
    if (r.status) return { status: r.status, headers, url, text: async () => 'error' };
    return { status: 200, headers, url, arrayBuffer: async () => r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength) };
  });
}

beforeEach(() => { __resetCacheForTests(); calls = []; });
afterEach(() => setTransport());

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => false });
const personTask = (subject) => ({ kind: 'subject', value: subject.name, template: 'fara.person', depth: 0 });
const companyTask = (value) => ({ kind: 'company', value, template: 'fara.company', depth: 1 });
const RED_FLAG_WORDS = /\b(fraud|illegal|violation|charged|convicted|sanction|debar|banned|red flag|wrongdoing(?! *;)|suspicious)\b/i;

/* ------------------------------------------------------------------ */
/* Unzipping and reading                                               */
/* ------------------------------------------------------------------ */

describe('reading the files', () => {
  test('text: windows-1252 punctuation kept, UTF-8 read as UTF-8', () => {
    expect(csvText(makeZip([['a.csv', 'O\x92Brennan \x93Co\x94\n']]))).toBe('O’Brennan “Co”\n');
    expect(csvText(makeZip([['a.csv', Buffer.from('José\n', 'utf8').toString('latin1')]]))).toBe('José\n');
  });

  test('the one CSV of a zip comes out whole; deflate and stored both read', () => {
    expect(Buffer.from(unzipSingle(zipOf('a.csv', 'x,y\n1,2\n'))).toString()).toBe('x,y\n1,2\n');
    expect(Buffer.from(unzipSingle(makeZip([['a.csv', 'stored\n', { method: 0 }]]))).toString()).toBe('stored\n');
  });

  test('a cut-off, damaged, multi-file or non-zip download is an error', () => {
    const good = zipOf('a.csv', 'x,y\n1,2\n'.repeat(50));
    expect(() => unzipSingle(good.slice(0, good.length - 30))).toThrow(/zip|incomplete/);
    expect(() => unzipSingle(new TextEncoder().encode('<html>Service unavailable</html>'))).toThrow(/not a complete zip/);
    expect(() => unzipSingle(makeZip([['a.csv', 'x\n'], ['b.csv', 'y\n']]))).toThrow(/single file/);
    expect(() => unzipSingle(zipOf('a.xlsx', 'x\n'))).toThrow(/CSV/);
    const damaged = Buffer.from(good);
    damaged[40] ^= 0xff;
    expect(() => unzipSingle(new Uint8Array(damaged))).toThrow();
  });

  test('short forms: names, registration and dates kept; the address columns never read', () => {
    const index = parseShortForms(shortForms());
    const marta = index.rows.find((r) => r[1] === 'Quill' && r[0] === 'Marta');
    expect(marta).toEqual(['Marta', 'Quill', 9001, isoDate(RECENT), '']);
    expect(index.rows.find((r) => r[1] === 'Pell')).toEqual(['Dorian', 'Pell', 9003, '2020-01-15', '2022-06-30']);
    expect(JSON.stringify(index)).not.toMatch(/Secret Lane|Hidden Road|22201|Arlington/);
  });

  test('registrants and foreign principals: no address kept; a principal keeps its country', () => {
    const rg = parseRegistrants(registrants());
    expect(rg.rows.find((r) => r[0] === 9003)).toEqual([9003, 'Velloria Robotics, Inc.', '', '2020-01-10', '2022-06-30']);
    const fp = parsePrincipals(principals());
    expect(fp.rows.find((r) => r[1] === 'Norland Shipping AS')).toEqual([9003, 'Norland Shipping AS', 'NORWAY', '2020-01-10', '']);
    expect(JSON.stringify([rg, fp])).not.toMatch(/Office Park|Palace Road|Harbour Street|Bergen|20001/);
  });

  test('a changed format, a short file or a file with nothing from the last year is an error, never an empty list', () => {
    expect(() => parseShortForms(shortForms().replace('Short Form Last Name', 'Surname'))).toThrow(/expected format/);
    expect(() => parseRegistrants(registrants([], 10))).toThrow(/too few entries/);
    const old = principals().split(RECENT).join('01/01/2014');
    expect(() => parsePrincipals(old)).toThrow(/out of date/);
    expect(() => parseRegistrants('')).toThrow(/empty/);
  });

  test('registrant names: doing-business-as names split; individuals told apart from firms', () => {
    expect(registrantNames('Bramblecrest Media LLC - DBA Starling Signal LLC')).toEqual(['Bramblecrest Media LLC', 'Starling Signal LLC']);
    expect(isIndividualRegistrant('Quill, Marta')).toBe(true);
    expect(isIndividualRegistrant('Akin, Gump, Strauss, Hauer & Feld, LLP')).toBe(false);
    expect(isIndividualRegistrant('Velloria Robotics, Inc.')).toBe(false);
    expect(isIndividualRegistrant('Examplestan Tourism Board, Washington')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The person                                                          */
/* ------------------------------------------------------------------ */

describe('a person', () => {
  test('a short-form filer and an individual registrant found by full name stay possible, say verify identity, and list the principals', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Marta Quill', company: 'Ostrander Labs' });
    const out = await faraConnector.run(personTask(subject), ctxFor(subject));
    expect(out.findings).toHaveLength(2);
    for (const f of out.findings) {
      expect(f.match).toBe('possible');
      expect(f.title).toMatch(/verify identity/);
      expect(f.severity).toBe('info');
      expect(f.url).toBe(FARA_PAGE);
      expect(f.title).not.toMatch(RED_FLAG_WORDS);
      expect(JSON.stringify(f)).not.toMatch(/Secret Lane|22201|Arlington|Palace Road/);
    }
    const sf = out.findings.find((f) => f.data.filing === 'short-form');
    expect(sf.title).toMatch(/short-form registration as an individual working for Harbor Lantern Strategies LLC/);
    expect(sf.quote).toMatch(/Ministry of Tourism of Examplestan \(Examplestan\)/);
    expect(sf.quote).toMatch(/Examplestan National Oil Company \(Examplestan\), ended 2020-12-31/);
    expect(sf.data.foreignPrincipals[0]).toEqual({ name: 'Ministry of Tourism of Examplestan', country: 'EXAMPLESTAN', ended: null });
    const own = out.findings.find((f) => f.data.filing === 'registrant');
    expect(own.title).toMatch(/Registered under FARA in their own name \(registration 9002\)/);
    expect(out.notes).toContain(FARA_NOTE);
    expect(out.partial).toBeUndefined();
  });

  test('never on part of a name: another first name or a longer surname is not a match', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Mart Quill' });
    const out = await faraConnector.run(personTask(subject), ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/no filing names Mart Quill \(files as of \d{4}-\d{2}-\d{2}\)/);
    // The principals file is not needed when nothing matched
    expect(calls).not.toContain(FILES.principals);
  });

  test('likely, never confirmed, when the registrant is the company the person is tied to', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Dorian Pell', company: 'Velloria Robotics' });
    const out = await faraConnector.run(personTask(subject), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    const [f] = out.findings;
    expect(f.match).toBe('likely');
    expect(f.title).not.toMatch(/verify identity/);
    expect(f.title).toMatch(/\(ended 2022-06-30\)/);
    expect(f.quote).toMatch(/Norland Shipping AS \(Norway\)/);
    expect(f.matchFixed).toBe(true);
  });

  test('a namesake at another registrant stays possible even when the person has a company', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Martin Quill', company: 'Velloria Robotics' });
    const out = await faraConnector.run(personTask(subject), ctxFor(subject));
    expect(out.findings.map((f) => f.match)).toEqual(['possible']);
  });

  test('names written in windows-1252 are read correctly', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Siobhan O’Brennan' });
    const N = require('../../../src/server/founder/names');
    const idx = parseShortForms(require('../../../src/server/founder/http').decodeBody(new Uint8Array(unzipSingle(SF_ZIP)), 'text/csv'));
    const out = await faraConnector.run(personTask(subject), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].quote).toMatch(/Siobhan O’Brennan/);
  });

  test('a single-word name is not searched, and says so', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Quill' });
    const out = await faraConnector.run(personTask(subject), ctxFor(subject));
    expect(out.partial).toHaveLength(1);
    expect(out.notes[0]).toMatch(/too short/);
    expect(calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The company                                                         */
/* ------------------------------------------------------------------ */

describe('a company', () => {
  test('a registrant is a company record, with its foreign principals', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Dorian Pell', company: 'Velloria Robotics' });
    const out = await faraConnector.run(companyTask('Velloria Robotics'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    const [f] = out.findings;
    expect(f.match).toBe('company');
    expect(f.category).toBe('corporate');
    expect(f.severity).toBe('info');
    expect(f.title).toMatch(/Registered under FARA as an agent of foreign principals \(ended 2022-06-30\): Velloria Robotics, Inc\./);
    expect(f.quote).toMatch(/Foreign principals: Norland Shipping AS \(Norway\)/);
  });

  test('a company listed as a foreign principal, with the registrant that represents it', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Ada Norland', company: 'Norland Shipping' });
    const out = await faraConnector.run(companyTask('Norland Shipping'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].title).toMatch(/Listed as a foreign principal in a FARA registration \(represented by Velloria Robotics, Inc\.\): Norland Shipping AS/);
    expect(out.findings[0].quote).toMatch(/Country or place represented: Norway/);
    expect(out.findings[0].match).toBe('company');
  });

  test('every known name of the company is searched, a doing-business-as name included', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Ada Norland', company: 'Starling' });
    addCompanyAlias(subject, { company: 'Starling', alias: 'Starling Signal LLC', origin: 'test' });
    const out = await faraConnector.run(companyTask('Starling'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
    expect(out.findings[0].quote).toMatch(/Kestrel Valley Holdings Ltd \(United Kingdom\)/);
  });

  test('a one-word company name is held as possible and asks to verify', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Ada Norland', company: 'Flow' });
    const out = await faraConnector.run(companyTask('Flow'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].title).toMatch(/verify it is the same company/);
  });

  test('part of a name is not the company', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Ada Norland', company: 'Harbor Lantern' });
    const out = await faraConnector.run(companyTask('Harbor Lantern'), ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/no registrant or foreign principal is named Harbor Lantern \(files as of/);
  });

  test('the foreign principals file failing leaves the screen partial, not clean', async () => {
    serve({ ...ALL, [FILES.principals]: { status: 404 } });
    const subject = createSubject({ name: 'Ada Norland', company: 'Velloria Robotics' });
    const out = await faraConnector.run(companyTask('Velloria Robotics'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.partial).toEqual(['FARA foreign principals file']);
    expect(out.notes.join(' ')).toMatch(/could not be read/);
  });
});

/* ------------------------------------------------------------------ */
/* Failures, caching, contract                                         */
/* ------------------------------------------------------------------ */

describe('the source', () => {
  test('a file that fails to download, or arrives as something else, fails the lookup', async () => {
    serve({ ...ALL, [FILES.shortForms]: { status: 503 } });
    const subject = createSubject({ name: 'Marta Quill' });
    await expect(faraConnector.run(personTask(subject), ctxFor(subject))).rejects.toThrow();
    __resetCacheForTests();
    serve({ ...ALL, [FILES.registrants]: new TextEncoder().encode('<html>maintenance</html>') });
    await expect(faraConnector.run(companyTask('Velloria Robotics'), ctxFor(subject))).rejects.toThrow(/not a complete zip/);
  });

  test('a file reshaped upstream fails the lookup', async () => {
    serve({ ...ALL, [FILES.shortForms]: zipOf('FARA_All_ShortForms.csv', shortForms().replace('Short Form First Name', 'Given')) });
    const subject = createSubject({ name: 'Marta Quill' });
    await expect(faraConnector.run(personTask(subject), ctxFor(subject))).rejects.toThrow(/expected format/);
  });

  test('each file is downloaded once a day, not per lookup', async () => {
    serve(ALL);
    const subject = createSubject({ name: 'Marta Quill' });
    await faraConnector.run(personTask(subject), ctxFor(subject));
    await faraConnector.run(personTask(subject), ctxFor(subject));
    await faraConnector.run(companyTask('Velloria Robotics'), ctxFor(subject));
    expect(calls.sort()).toEqual([FILES.principals, FILES.registrants, FILES.shortForms].sort());
  });

  test('the cached indexes stay well under the stored size limit', () => {
    // The real files (Nov 2026) held about 44,800, 7,100 and 17,800 rows; the fixtures are scaled up to that
    const sizes = [
      JSON.stringify(parseShortForms(shortForms([], 45000))).length,
      JSON.stringify(parseRegistrants(registrants([], 7200))).length,
      JSON.stringify(parsePrincipals(principals([], 18000))).length,
    ];
    for (const s of sizes) expect(s).toBeLessThan(4 * 1024 * 1024);
  });

  test('contract: id, label, kinds, plans', () => {
    expect(faraConnector.id).toMatch(/^[a-z0-9-]+$/);
    expect(faraConnector.label).not.toMatch(/\b(api|endpoint|api key|token|free|paid|tier|env)\b/i);
    expect(faraConnector.kinds).toEqual(['subject', 'company']);
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    for (const kind of faraConnector.kinds) {
      const plans = faraConnector.plan({ kind, value: kind === 'company' ? 'Theranos' : 'Elizabeth Holmes' }, subject);
      expect(plans).toHaveLength(1);
      expect(plans[0].template).toMatch(/^[a-z0-9.:_-]+$/i);
      expect(plans[0].template).not.toMatch(/holmes|theranos/i);
    }
  });
});
