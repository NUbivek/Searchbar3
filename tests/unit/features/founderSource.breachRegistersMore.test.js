/**
 * Breach notices filed with the Delaware, Vermont, Maryland and Indiana Attorneys General: company level only.
 * Fixtures follow the real response shapes (checked 2026-11-20), shortened, with invented organisations
 * beside the public test companies (Theranos, Nikola, Uber).
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addCompanyAlias } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const {
  delawareBreachNoticesConnector, vermontBreachNoticesConnector, marylandBreachNoticesConnector, indianaBreachNoticesConnector,
  breachRegistersMoreConnectors, dataClassLabels, vermontArchiveTitle, parseVermontArchivePage, parseIndianaReport, pdfItems,
  gradeOrganisation, targetOf, __setVermontArchiveForTests,
} = require('../../../src/server/founder/sources/breachRegistersMore');

/* ------------------------------------------------------------------ fake network */

/** The first pattern that matches the URL answers; a Buffer body is served as bytes. Returns the calls made. */
function network(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, headers: init.headers });
    const hit = routes.find(([pattern]) => pattern.test(url));
    const reply = hit ? (typeof hit[1] === 'function' ? hit[1](url, init) : hit[1]) : { status: 404, body: 'not found' };
    const status = reply.status || 200;
    if (Buffer.isBuffer(reply.body)) {
      const b = reply.body;
      return { status, headers: new Map([['content-type', 'application/pdf']]), url, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    }
    return { status, headers: new Map(), url, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) };
  });
  return calls;
}

const ctxFor = (name, company) => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}) });
const uberCtx = () => { const ctx = ctxFor('Travis Kalanick', 'Uber'); addCompanyAlias(ctx.subject, { company: 'Uber', alias: 'Uber Technologies, Inc.', origin: 'sec-filings-1' }); return ctx; };
const companyTask = (value) => ({ kind: 'company', value, depth: 1, template: null, params: null });
const BANNED_KEYS = /^(dob|dateOfBirth|birth|phone|email|address|street|ssn|spouse|children|age)$/i;
const keysOf = (v, out = []) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };

beforeEach(() => { __resetCacheForTests(); __setVermontArchiveForTests({ maxPages: 80, gapMs: 0 }); });
afterEach(() => setTransport());

/* ------------------------------------------------------------------ fixtures */

const filler = (n, make) => Array.from({ length: n }, (_, i) => make(i));

/** Delaware open-data rows (company_name may carry trailing spaces; one row has the 1971 placeholder date). */
const DE_ROWS = [
  { company_name: 'Theranos, Inc.  ', date_of_breach: '2026-06-19T00:00:00.000', date_of_notice: '2026-07-30T00:00:00.000', de_residents_affected: '41', total_affected: '12000', information_breached: 'SSN, MedTreatment, HealthID', sample_of_notice: { url: 'https://attorneygeneral.delaware.gov/wp-content/uploads/sites/50/2026/07/Notification-DE-Theranos.pdf' } },
  { company_name: 'Uber Technologies, Inc.  ', date_of_breach: '2026-10-07T00:00:00.000', date_of_notice: '2026-11-10T00:00:00.000', de_residents_affected: '2520', information_breached: 'DriverLicense', sample_of_notice: { url: 'https://attorneygeneral.delaware.gov/wp-content/uploads/sites/50/2026/11/Notification-DE-Uber.pdf' } },
  { company_name: 'Uber Freight Brokers of Delmarva', date_of_notice: '2025-02-01T00:00:00.000', de_residents_affected: '3', information_breached: 'Account number' },
  { company_name: 'Huber Plumbing Supply LLC', date_of_notice: '2025-03-01T00:00:00.000', de_residents_affected: '2', information_breached: 'Social Security number' },
  { company_name: 'Wise Acre Bakery', date_of_notice: '1971-01-01T00:00:00.000', de_residents_affected: '1', information_breached: 'Username or email address, in combination with password or security question and answer to access online account', sample_of_notice: { url: 'https://example.com/notice.pdf' } },
  ...filler(120, (i) => ({ company_name: `Harborview Filler Company ${i} LLC`, date_of_notice: '2024-05-01T00:00:00.000', de_residents_affected: '1', information_breached: 'SSN' })),
];

const vtRow = (date, org, type, n, cats) => `<tr>\n<td class="text-align-center" style="width: 169px;">${date}</td>\n<td class="text-align-center">${org}</td>\n<td class="text-align-center">${type}</td>\n<td class="text-align-center">${n}</td>\n<td style="width: 131px;"><p>${cats}</p></td>\n</tr>`;
const vtArchiveItem = (slug, title) => `<div class="views-row"><article about="/document/${slug}">\n<h2 class="margin-0">\n<a href="/document/${slug}" rel="bookmark">\n<span>${title}</span>\n</a>\n</h2></article></div>`;
const vtPage = ({ table = true, items = [], last = 1 } = {}) => `<html><body>
${table ? `<table border="1"><thead><tr><th scope="col">Date Reported to AGO</th><th scope="col">Reporting Organization Name&nbsp;</th><th scope="col">Reporting Organization Type</th><th scope="col">Number of VT Residents Affected</th><th scope="col">Categories of Data Breached</th></tr></thead><tbody>
${vtRow('10-30-2026', 'Theranos, Inc.', 'Health Care', '7&nbsp;', 'Social Security Numbers, Health Records')}
${vtRow('8-13--2026', 'Theranos Inc', 'Health Care', '2', 'Financial Account Codes')}
${vtRow('4-17-2026', 'Connected Lakes Credit Union', 'Financial Services', '8', 'Social Security Numbers, Financial Account Codes')}
${vtRow('5-02-2026', 'Taft Stettinius &amp; Hollister LLP', 'Other Commercial', '16&nbsp;', 'Social Security Numbers')}
</tbody></table>` : ''}
<p>Last updated on November 20, 2026</p>
${items.join('\n')}
<nav><a href="?page=1">2</a><a href="?page=${last}" title="Go to last page">Last</a></nav>
</body></html>`;

const MD_ROWS = (year) => ({
  2025: [
    { Title: 'Carruth Compliance Consulting; Lane ESD', Date_x0020_Received: '3/1/25', No_x0020_of_x0020_Maryland_x0020: '1', Information_x0020_Breached: 'Names, Social Security numbers', How_x0020_Breach_x0020_Occurred: 'Unauthorized access to files', Case_x0020_No_x002e_: 'ITU-376462.pdf' },
  ],
  2024: [
    { Title: 'Nikola Corporation', Date_x0020_Received: '7/9/2024', No_x0020_of_x0020_Maryland_x0020: '35', Information_x0020_Breached: "Names, Social Security numbers, driver's license numbers, and medical billing information", How_x0020_Breach_x0020_Occurred: 'An employee was treated for depression and clicked a phishing link', Case_x0020_No_x002e_: 'ITU-374099.pdf' },
    { Title: 'Nikolaus & Hohenadel LLP', Date_x0020_Received: '8/1/2024', No_x0020_of_x0020_Maryland_x0020: '2', Information_x0020_Breached: 'Names', How_x0020_Breach_x0020_Occurred: 'Lost laptop', Case_x0020_No_x002e_: 'ITU-374100.pdf' },
  ],
  2023: [
    { Title: 'Nikola Corporation', Date_x0020_Received: '2/3/2023', No_x0020_of_x0020_Maryland_x0020: '12', Information_x0020_Breached: 'Names, financial account information', How_x0020_Breach_x0020_Occurred: 'Ransomware attack on the company network', Case_x0020_No_x002e_: 'ITU-367781.pdf' },
  ],
  2022: [
    { Title: 'Lakeside Dental Group', Date_x0020_Received: '1/1/2022', No_x0020_of_x0020_Maryland_x0020: '4', Information_x0020_Breached: 'Names', How_x0020_Breach_x0020_Occurred: 'Email compromise', Case_x0020_No_x002e_: 'ITU-352396.pdf' },
  ],
}[year]);

/* A tiny hand-written PDF: each text item drawn at an absolute position, as the Indiana reports are. */
function makePdf(pages) {
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);
  const objects = [];
  const pageIds = pages.map((_, i) => 3 + i * 2);
  const fontId = 3 + pages.length * 2;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pages.forEach((items, i) => {
    const content = items.map(([s, x, y]) => `BT /F1 8 Tf 1 0 0 1 ${x} ${y} Tm (${esc(s)}) Tj ET`).join('\n');
    objects[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Contents ${pageIds[i] + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[pageIds[i] + 1] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const IN_HEADER_2026 = [['Row No.', 61, 548], ['Matter: Name', 239, 548], ['Notific Sent', 450, 548], ['Breach Occ', 525, 548], ['IN Affected', 598, 548], ['Total Affected', 671, 548]];
const inRow = (y, no, name, sent, occ, inAff, total) => [
  [String(no), no < 10 ? 87 : 82, y], [name, 95, y],
  ...(sent ? [[sent, 470, y]] : []), ...(occ ? [[occ, 542, y + 1]] : []),
  ...(inAff ? [[inAff, 643, y]] : []), ...(total ? [[total, 714, y]] : []),
];
const IN_2026 = makePdf([[
  ...IN_HEADER_2026,
  ...inRow(536, 1, 'Theranos Inc', '9/30/2026', '7/22/2026', '2', '184'),
  ...inRow(523, 2, 'Uber Technologies Inc', '5/1/2026', '4/8/2026', '6', '3001'),
  ...inRow(511, 3, 'Huber Heating and Cooling LLC', '6/11/2026', '3/19/2026', '37', '2518'),
  ...inRow(498, 4, 'Northwind Analytics Holdings of the Great Lakes and', '3/2/2026', '1/5/2026', '12', '3400'),
  ['Ohio Valley LLC', 95, 486],
  ...inRow(473, 5, 'Theranos Inc', '1/22/2026', '8/14/2025', '289', '131070'),
  ['1 of 1', 384, 26],
]]);
const IN_2025 = makePdf([[
  ['Matter: Name', 202, 547], ['Notific Sent', 426, 547], ['Breach Occ', 506, 547], ['IN Affected', 585, 547], ['Total Affected', 663, 547],
  ['180 Lakeshore Medical', 53, 533], ['2/24/2025', 446, 533], ['2/18/2025', 525, 533], ['9', 641, 533], ['837', 720, 533],
  ['Uber Technologies Inc', 53, 518], ['7/4/2025', 451, 519], ['7/1/2025', 530, 519], ['70', 636, 519], ['2435', 715, 519],
]]);
/** A report in a layout that cannot be read: rotated, no header line. */
const IN_ROTATED = makePdf([[['Row NO.', 81, 59], ['Matter: Name', 82, 237], ['1', 94, 89], ['Theranos Inc', 94, 97]]]);
const IN_LISTING = (links = true) => `<html><body><ul>
${links ? `<li><a href="/attorneygeneral/consumer-protection-division/id-theft-prevention/files/DB-Year-to-Date-Report-Novemver-2026.pdf">2026</a></li>
<li><a href="/attorneygeneral/consumer-protection-division/id-theft-prevention/files/DB-Year-to-Date-Report-2025.pdf">2025</a></li>
<li><a href="/attorneygeneral/consumer-protection-division/id-theft-prevention/files/DB-Year-to-Date-Reportdec-2024.pdf">2024&nbsp;</a></li>
<li><a href="/attorneygeneral/consumer-protection-division/id-theft-prevention/files/DB-Year-to-date-Report-2014.pdf">2014</a></li>
<li><a href="[ioID]8026AD70/2016_04_01_ITU_Breach(1).pdf">Breach notice form</a></li>` : '<li>Reports are being updated</li>'}
</ul></body></html>`;

/* ------------------------------------------------------------------ helpers */

describe('data classes and names', () => {
  test('data classes become general labels; health and other protected kinds are never named', () => {
    expect(dataClassLabels('SSN, MedTreatment, HealthID')).toEqual(['Social Security numbers', 'Sensitive personal details']);
    expect(dataClassLabels("Names, Social Security numbers, driver's license numbers, and medical billing information")).toEqual(["Social Security numbers", "Driver's license numbers", 'Names', 'Sensitive personal details']);
    expect(dataClassLabels('Username or email address, in combination with password')).toEqual(['Online account sign-in details']);
    expect(dataClassLabels('Biometric data')).toEqual(['Sensitive personal details']);
    expect(dataClassLabels('')).toEqual([]);
  });

  test('Vermont archive titles give the date and the organisation, whatever the spelling of the suffix', () => {
    expect(vermontArchiveTitle('2026-04-10 Buena Vista Management Services, LLC - Data Breach Notice to Consumers')).toEqual({ r: '2026-04-10', o: 'Buena Vista Management Services, LLC' });
    expect(vermontArchiveTitle('2022-09-30-University-of-Southern-California-Data-Breach-Notice-to-Consumers')).toEqual({ r: '2022-09-30', o: 'University of Southern California' });
    expect(vermontArchiveTitle('2026-03-27 Eurail BV-Date Brach Notice to Consumers')).toEqual({ r: '2026-03-27', o: 'Eurail BV' });
    expect(vermontArchiveTitle('2026-03-27  Mobilelink- Data Breach Notice to Consumers  .pdf')).toEqual({ r: '2026-03-27', o: 'Mobilelink' });
    expect(vermontArchiveTitle('2026-03-17 Kaplan North America Data Breach Notice to Consumers')).toEqual({ r: '2026-03-17', o: 'Kaplan North America' });
    expect(vermontArchiveTitle('Not a notice')).toBeNull();
  });

  test('an ordinary one-word company is only a possible namesake unless a known legal name is written', () => {
    const plainUber = targetOf(companyTask('Uber'), ctxFor('Travis Kalanick', 'Uber'));
    expect(gradeOrganisation(plainUber, 'Uber Technologies, Inc.')).toMatchObject({ match: 'possible', severity: 'low', extra: { excludeFromTimeline: true } });
    expect(gradeOrganisation(plainUber, 'Uber Technologies, Inc.').matchReasons.join(' ')).toMatch(/verify/);
    expect(gradeOrganisation(plainUber, 'Huber Plumbing Supply LLC')).toBeNull();
    const known = targetOf(companyTask('Uber'), uberCtx());
    expect(gradeOrganisation(known, 'Uber Technologies, Inc.')).toMatchObject({ grade: 'legal', match: 'company' });
    expect(gradeOrganisation(known, 'Uber Freight Brokers of Delmarva')).toBeNull();
    const theranos = targetOf(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(gradeOrganisation(theranos, 'Theranos, Inc.')).toMatchObject({ match: 'company' });
  });

  test('a person, or a name too general to match, is never searched', async () => {
    const calls = network([]);
    for (const c of breachRegistersMoreConnectors) {
      expect(await c.run(companyTask('Elizabeth Holmes'), ctxFor('Elizabeth Holmes', 'Theranos'))).toEqual({ findings: [], threads: [], notes: [] });
      const r = await c.run(companyTask('AI'), ctxFor('Elizabeth Holmes', 'Theranos'));
      expect(r.findings).toEqual([]);
      expect(r.notes.join(' ')).toMatch(/too short or too general/);
      expect(await c.run({ kind: 'subject', value: 'Theranos' }, ctxFor('Elizabeth Holmes', 'Theranos'))).toEqual({ findings: [], threads: [], notes: [] });
    }
    expect(calls).toHaveLength(0);
  });

  test('every source has the contract fields and only takes companies', () => {
    for (const c of breachRegistersMoreConnectors) {
      expect(c.id).toMatch(/^breach-registers-[a-z]+$/);
      expect(c.kinds).toEqual(['company']);
      expect(c.label).not.toMatch(/\b(api|endpoint|key|token|free|paid|tier|env)\b/i);
      expect(c.enabled()).toBe(true);
      expect(c.unavailableReason.length).toBeGreaterThan(10);
    }
  });
});

/* ------------------------------------------------------------------ Delaware */

describe('Delaware Attorney General', () => {
  const deRoute = (body = DE_ROWS) => [/data\.delaware\.gov\/resource\/dir6-wx8v\.json/, { body }];

  test('maps a notice, links its sample notice, and keeps only labels of the data', async () => {
    const calls = network([deRoute()]);
    const r = await delawareBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(calls[0].url).toMatch(/\$select=company_name/);
    expect(calls[0].headers['User-Agent']).toMatch(/diligence-research/);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f).toMatchObject({ source: 'breach-registers-delaware', category: 'exposure', match: 'company', severity: 'medium', date: '2026-07-30' });
    expect(f.url).toBe('https://attorneygeneral.delaware.gov/wp-content/uploads/sites/50/2026/07/Notification-DE-Theranos.pdf');
    expect(f.title).toBe('Theranos, Inc.: data breach notice filed with the Delaware Attorney General, reported 30 July 2026 (41 Delaware residents affected)');
    expect(f.data).toMatchObject({ organisation: 'Theranos, Inc.', affected: '41', totalAffected: '12,000', dataClasses: ['Social Security numbers', 'Sensitive personal details'] });
    expect(f.quote).not.toMatch(/health|medical|med ?treatment/i);
    for (const k of keysOf(f.data)) expect(k).not.toMatch(BANNED_KEYS);
    expect(r.notes[0]).toMatch(/Delaware Attorney General breach notices \(125 notices, .* were searched for Theranos: one record names it/);
  });

  test('a namesake by an ordinary word is "possible"; with the legal name known it is the company', async () => {
    network([deRoute()]);
    const plain = await delawareBreachNoticesConnector.run(companyTask('Uber'), ctxFor('Travis Kalanick', 'Uber'));
    expect(plain.findings.map((f) => [f.data.organisation, f.match])).toEqual([['Uber Technologies, Inc.', 'possible']]);
    expect(plain.findings[0].data.excludeFromTimeline).toBe(true);
    expect(plain.findings[0].matchReasons.join(' ')).toMatch(/verify it is the same company/);
    const known = await delawareBreachNoticesConnector.run(companyTask('Uber'), uberCtx());
    expect(known.findings.map((f) => [f.data.organisation, f.match])).toEqual([['Uber Technologies, Inc.', 'company']]);
    expect(known.notes[0]).toMatch(/searched for Uber or Uber Technologies, Inc\./);
  });

  test('says in plain words that nothing names the company, and refuses implausible dates and foreign links', async () => {
    network([deRoute()]);
    const none = await delawareBreachNoticesConnector.run(companyTask('Nikola'), ctxFor('Trevor Milton', 'Nikola'));
    expect(none.findings).toEqual([]);
    expect(none.notes[0]).toMatch(/none names it\. A company with no entry may still have had a breach\./);
    const wise = await delawareBreachNoticesConnector.run(companyTask('Wise Acre Bakery'), ctxFor('Trevor Milton', 'Nikola'));
    expect(wise.findings[0].date).toBeNull();
    expect(wise.findings[0].url).toBe('https://data.delaware.gov/d/dir6-wx8v');
    expect(wise.findings[0].data.dataClasses).toEqual(['Online account sign-in details']);
  });

  test('a list that is not a list, or far too short, fails the lookup instead of saying "no match"', async () => {
    network([deRoute({ error: true, message: 'query failed' })]);
    await expect(delawareBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow(/unexpected response/);
    __resetCacheForTests();
    network([deRoute(DE_ROWS.slice(0, 5))]);
    await expect(delawareBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow(/only 5 notices/);
    __resetCacheForTests();
    network([[/data\.delaware\.gov/, { status: 404, body: 'gone' }]]);
    await expect(delawareBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow();
  });

  test('the list is downloaded once and then read from the cache', async () => {
    const calls = network([deRoute()]);
    await delawareBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    await delawareBreachNoticesConnector.run(companyTask('Nikola'), ctxFor('Trevor Milton', 'Nikola'));
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ Vermont */

describe('Vermont Attorney General', () => {
  const archive0 = vtPage({ items: [vtArchiveItem('2026-04-10-buena-vista-management-services-llc-data-breach-notice-consumers', '2026-04-10 Buena Vista Management Services, LLC - Data Breach Notice to Consumers')], last: 1 });
  const archive1 = vtPage({ items: [vtArchiveItem('2023-02-01-theranos-inc-data-breach-notice-consumers', '2023-02-01-Theranos-Inc-Data-Breach-Notice-to-Consumers')], last: 1 });
  const routes = (page1 = archive1) => [
    [/security-breach-notices\?page=1$/, { body: page1 }],
    [/security-breach-notices(\?page=0)?$/, { body: archive0 }],
  ];

  test('reads the current table and the archived notices; rows without a page of their own are reported together', async () => {
    const calls = network(routes());
    const r = await vermontBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(calls.map((c) => c.url)).toEqual([
      'https://ago.vermont.gov/categories/security-breach-notices',
      'https://ago.vermont.gov/categories/security-breach-notices?page=0',
      'https://ago.vermont.gov/categories/security-breach-notices?page=1',
    ]);
    expect(r.partial).toBeUndefined();
    expect(r.findings.map((f) => f.title)).toEqual([
      'Theranos, Inc.: 2 data breach notices filed with the Vermont Attorney General, most recently reported 30 October 2026',
      'Theranos Inc: data breach notice filed with the Vermont Attorney General, reported 1 February 2023',
    ]);
    const [table, archived] = r.findings;
    expect(table.url).toBe('https://ago.vermont.gov/categories/security-breach-notices');
    expect(table.match).toBe('company');
    expect(table.data.notices.map((n) => [n.reported, n.affected])).toEqual([['2026-10-30', '7'], ['2026-08-13', '2']]);
    expect(table.quote).toMatch(/Type: Health Care\./);
    expect(table.quote).not.toMatch(/Health Records/);
    expect(archived.url).toBe('https://ago.vermont.gov/document/2023-02-01-theranos-inc-data-breach-notice-consumers');
    expect(r.notes[0]).toMatch(/Vermont Attorney General breach notices \(6 notices, 1 February 2023 to 30 October 2026\) were searched for Theranos: 2 records name it/);
  });

  test('entities are decoded and a neighbour is not matched', async () => {
    network(routes());
    const r = await vermontBreachNoticesConnector.run(companyTask('Taft Stettinius & Hollister'), ctxFor('Trevor Milton', 'Nikola'));
    expect(r.findings.map((f) => f.data.organisation)).toEqual(['Taft Stettinius & Hollister LLP']);
    const none = await vermontBreachNoticesConnector.run(companyTask('Connected'), ctxFor('Trevor Milton', 'Nikola'));
    expect(none.findings).toEqual([]);
  });

  test('archived pages that cannot be read leave the lookup partial, and say so', async () => {
    network(routes(vtPage({ items: [], last: 1 })));
    const r = await vermontBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(r.findings).toHaveLength(1);
    expect(r.partial).toEqual(['Vermont archived notices (2022 to April 2026) not searched']);
    expect(r.notes.join(' ')).toMatch(/archived breach notices \(2022 to April 2026\) could not be read, so only the notices from April 2026 on were searched/);
  });

  test('a page without its table fails the lookup', async () => {
    network([[/security-breach-notices/, { body: vtPage({ table: false, items: [] }) }]]);
    await expect(vermontBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow(/table was not found/);
  });

  test('archive listing parsing reads the pager', () => {
    const p = parseVermontArchivePage(archive0);
    expect(p).toEqual({ notices: [{ r: '2026-04-10', o: 'Buena Vista Management Services, LLC', s: '2026-04-10-buena-vista-management-services-llc-data-breach-notice-consumers' }], last: 1 });
  });
});

/* ------------------------------------------------------------------ Maryland */

describe('Maryland Attorney General', () => {
  const mdRoute = (fail = []) => [/oag\.maryland\.gov\/resources-info\/_api\/web\/lists\/getbytitle/, (url) => {
    const year = Number(/Notices-(\d{4})/.exec(decodeURIComponent(url))[1]);
    if (fail.includes(year)) return { status: 404, body: { 'odata.error': { message: { value: `List 'Security-Breach-Notices-${year}' does not exist` } } } };
    return { body: { value: MD_ROWS(year) } };
  }];

  test('reads every yearly list, groups one company\'s notices, keeps the case numbers and drops health wording', async () => {
    const calls = network([mdRoute()]);
    const r = await marylandBreachNoticesConnector.run(companyTask('Nikola'), ctxFor('Trevor Milton', 'Nikola'));
    expect(calls).toHaveLength(4);
    expect(calls[0].headers.Accept).toBe('application/json;odata=nometadata');
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.title).toBe('Nikola Corporation: 2 data breach notices filed with the Maryland Attorney General, most recently reported 9 July 2024');
    expect(f.match).toBe('company');
    expect(f.url).toBe('https://oag.maryland.gov/resources-info/Pages/security-breach-notices.aspx');
    expect(f.data.notices.map((n) => n.caseNumber)).toEqual(['ITU-374099', 'ITU-367781']);
    expect(f.quote).toMatch(/How it happened: Ransomware attack on the company network\./);
    expect(f.quote).not.toMatch(/depression|medical/i);
    expect(r.notes.join(' ')).toMatch(/Maryland publishes no breach notices after March 2025/);
    expect(r.partial).toBeUndefined();
  });

  test('a missing year leaves the lookup partial; no year at all fails it', async () => {
    network([mdRoute([2023])]);
    const r = await marylandBreachNoticesConnector.run(companyTask('Nikola'), ctxFor('Trevor Milton', 'Nikola'));
    expect(r.findings[0].title).toMatch(/^Nikola Corporation: data breach notice filed with the Maryland Attorney General, reported 9 July 2024 \(35 Maryland residents affected\)$/);
    expect(r.partial).toEqual(['Maryland notices for 2023 not searched']);
    expect(r.notes.join(' ')).toMatch(/The Maryland lists for 2023 could not be read/);
    __resetCacheForTests();
    network([mdRoute([2022, 2023, 2024, 2025])]);
    await expect(marylandBreachNoticesConnector.run(companyTask('Nikola'), ctxFor('Trevor Milton', 'Nikola'))).rejects.toThrow(/could not be read/);
  });

  test('an empty yearly list counts as unreadable, not as "no match"', async () => {
    network([[/getbytitle/, { body: { value: [] } }]]);
    await expect(marylandBreachNoticesConnector.run(companyTask('Nikola'), ctxFor('Trevor Milton', 'Nikola'))).rejects.toThrow(/is empty/);
  });

  test('entries separated by a semicolon are matched one by one', async () => {
    network([mdRoute()]);
    const r = await marylandBreachNoticesConnector.run(companyTask('Carruth Compliance Consulting'), ctxFor('Trevor Milton', 'Nikola'));
    expect(r.findings.map((f) => [f.data.organisation, f.match, f.date])).toEqual([['Carruth Compliance Consulting; Lane ESD', 'company', '2025-03-01']]);
  });
});

/* ------------------------------------------------------------------ Indiana */

describe('Indiana Attorney General', () => {
  const inRoutes = ({ listing = IN_LISTING(), y2024 = IN_ROTATED, y2026 = IN_2026 } = {}) => [
    [/security-breaches\/$/, { body: listing }],
    [/Novemver-2026\.pdf$/, { body: y2026 }],
    [/Report-2025\.pdf$/, { body: IN_2025 }],
    [/Reportdec-2024\.pdf$/, { body: y2024 }],
  ];

  test('reads the report table by column position, so the two counts are never confused', async () => {
    const pages = await pdfItems(IN_2026);
    const rows = parseIndianaReport(pages);
    expect(rows[0]).toEqual({ o: 'Theranos Inc', r: '2026-09-30', b: '2026-07-22', a: '2', t: '184' });
    expect(rows[3].o).toBe('Northwind Analytics Holdings of the Great Lakes and Ohio Valley LLC');
    expect(rows[4]).toEqual({ o: 'Theranos Inc', r: '2026-01-22', b: '2025-08-14', a: '289', t: '131,070' });
    expect(rows).toHaveLength(5);
    const older = parseIndianaReport(await pdfItems(IN_2025));
    expect(older.map((x) => x.o)).toEqual(['180 Lakeshore Medical', 'Uber Technologies Inc']);
    expect(() => parseIndianaReport([[{ s: 'Theranos Inc', x: 95, y: 500 }]])).toThrow(/layout that cannot be read/);
  });

  test('matches across the newest reports; a report in another layout leaves the lookup partial', async () => {
    const calls = network(inRoutes());
    const r = await indianaBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['', 'DB-Year-to-Date-Report-Novemver-2026.pdf', 'DB-Year-to-Date-Report-2025.pdf', 'DB-Year-to-Date-Reportdec-2024.pdf']);
    expect(calls.some((c) => /2014/.test(c.url))).toBe(false);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.title).toBe('Theranos Inc: 2 data breach notices filed with the Indiana Attorney General, most recently reported 30 September 2026');
    expect(f.url).toBe('https://www.in.gov/attorneygeneral/consumer-protection-division/id-theft-prevention/files/DB-Year-to-Date-Report-Novemver-2026.pdf');
    expect(f.data.notices.map((n) => [n.affected, n.totalAffected])).toEqual([['2', '184'], ['289', '131,070']]);
    expect(r.partial).toEqual(['Indiana reports for 2024 not searched']);
    expect(r.notes.join(' ')).toMatch(/Indiana's reports before 2024 use other layouts and were not searched/);
  });

  test('an ordinary-word company across two years: possible without its legal name, the company with it', async () => {
    network(inRoutes({ y2024: IN_2025 }));
    const plain = await indianaBreachNoticesConnector.run(companyTask('Uber'), ctxFor('Travis Kalanick', 'Uber'));
    expect(plain.findings.map((f) => f.match)).toEqual(['possible', 'possible', 'possible']);
    expect(plain.findings.map((f) => f.data.organisation)).not.toContain('Huber Heating and Cooling LLC');
    const known = await indianaBreachNoticesConnector.run(companyTask('Uber'), uberCtx());
    expect(known.findings.map((f) => f.match)).toEqual(['company', 'company', 'company']);
    expect(known.partial).toBeUndefined();
  });

  test('a page without report links, or reports that cannot be read, fail the lookup', async () => {
    network(inRoutes({ listing: IN_LISTING(false) }));
    await expect(indianaBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow(/no yearly report was found/);
    __resetCacheForTests();
    network([[/security-breaches\/$/, { body: IN_LISTING() }], [/\.pdf$/, { body: IN_ROTATED }]]);
    await expect(indianaBreachNoticesConnector.run(companyTask('Theranos'), ctxFor('Elizabeth Holmes', 'Theranos'))).rejects.toThrow(/could not be read/);
  });
});

/* ------------------------------------------------------------------ live (FOUNDER_LIVE=1 only) */

const live = process.env.FOUNDER_LIVE === '1' ? describe : describe.skip;
live('live registers (public test subjects)', () => {
  beforeEach(() => { setTransport(); __setVermontArchiveForTests({ maxPages: 1, gapMs: 1000 }); });
  test('Uber, with its legal name known, in each state', async () => {
    const ctx = { ...uberCtx(), deadline: Date.now() + 110000 };
    for (const c of breachRegistersMoreConnectors) {
      const r = await c.run(companyTask('Uber'), ctx);
      // eslint-disable-next-line no-console
      console.log(c.id, JSON.stringify({ findings: r.findings.map((f) => [f.title, f.match, f.url]), notes: r.notes, partial: r.partial }, null, 1));
      expect(Array.isArray(r.findings)).toBe(true);
    }
  }, 120000);
});
