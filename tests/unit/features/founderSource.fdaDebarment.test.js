/**
 * @jest-environment node
 *
 * The FDA debarment list (fdaDebarment.js), with the network faked from the
 * shape the two FDA pages had on 20 Nov 2026 (shortened; the people are
 * invented). What matters most: the list holds only names and dates, so a hit
 * on a person is always a name match ('possible', "verify identity"); a page
 * that fails or has changed shape is a failure, never "no match"; the page's
 * footnotes (which give towns) are never kept.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const {
  fdaDebarmentConnector, parseFdaDebarment, listedPerson, readTerm, usDate, FDA_DEBARMENT_PAGE, FDA_EXPIRED_PAGE,
} = require('../../../src/server/founder/sources/fdaDebarment');

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const FIRMS_TABLE = (none) => `<h3>Firms</h3><div class="inset-column"><div class="table-responsive"><table class="Table table" style="width:100%;" border="1" cellpadding="2"><thead><tr><th style="width:178px;">Name of Firm</th><th style="width:135px;">Effective Date</th><th style="width:176px;">End/Term of Debarment</th><th style="width:188px;">FR Date.txt (MM/DD/YY)</th><th style="width:203px;">Volume Page.pdf</th></tr></thead><tbody>${none
  ? '<tr><td style="width:178px;">None as of this date</td><td style="width:135px;">&nbsp;</td><td style="width:176px;">&nbsp;</td><td style="width:188px;">&nbsp;</td><td style="width:203px;"><p>&nbsp;</p><p>&nbsp;</p></td></tr>'
  : '<tr><td>Quillon Pharmaceutical Laboratories, Inc.</td><td>03/02/2020</td><td>5 years %</td><td>03/02/2020</td><td><a href="https://www.federalregister.gov/documents/2020/03/02/2020-0001/quillon-debarment-order">85 FR 12000</a></td></tr>'
}</tbody></table></div></div>`;

const fr = (y, slug, cite) => `<a href="https://www.federalregister.gov/documents/${y}/01/01/${y}-0000/${slug}">${cite}</a>`;
const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const fillers = (n, prefix) => Array.from({ length: n }, (_, i) => row([`${prefix}last${i}`, `Filler${i}`, '01/01/2010', 'Permanent^', '01/01/2010', `75 FR ${1000 + i}`])).join('');

const PERSONS_ROWS = [
  row(['Quentley', 'Marisol J.', '05/15/2024', 'Permanent^', '05/15/2024', fr(2024, 'marisol-j-quentley-final-debarment-order', '89 FR 42474')]),
  row(['Pravik, a.k.a. Ed Morrow', 'Edwin', '11/14/2016', 'Permanent^', '11/14/2016', fr(2016, 'edwin-pravik', '81 FR 79501')]),
  row(['Tamsin a/k/a Tamzin', 'Orrin', '03/14/2025', 'Permanent^*', '03/14/2025', fr(2025, 'orrin-tamsin', '90 FR 12164')]),
  row(['Halvard, Jr.', 'Wendell', '10/21/2009', 'Permanent^', '10/21/2009', fr(2009, 'wendell-halvard', '74 FR 54051')]),
  row(['**Cobbleworth', 'Ione', '11/29/1993', 'Permanent^', '11/29/1993', '58 FR 62675~']),
  row(['', '', '', 'FR Correction', '05/05/1993', '58 FR 26814~']),
  // the date as the page writes it once: split over styled spans
  `<tr><td><span>Brisbane</span></td><td><span>Lowell</span></td><td><span style="color:#333">0</span><span>4</span><span>/</span><span>14</span><span>/2021</span></td><td>Permanent^</td><td>0  4  /  14  /2021</td><td>${fr(2021, 'lowell-brisbane', '86 FR 19625')}</td></tr>`,
  row(['Delacourt', 'Ferris NMI', '9/28/2018', '10 years %', '9/28/2018', `<a href="https://evil.example.com/x">83 FR 49095</a>`]),
].join('');

const CURRENT = `<html><body><h2>FDA Debarment List (Drug Product Applications)</h2>${FIRMS_TABLE(true)}<h3>Persons</h3><div class="inset-column"><div class="table-responsive"><table class="Table table" style="width:100%;" border="1" cellpadding="2"><thead><tr><th>Last Name</th><th>First &amp; Middle Names</th><th>Effective Date</th><th>End/Term of Debarment</th><th>FR Date.txt (MM/DD/YY)</th><th style="width:137px;">Volume Page.pdf</th></tr></thead><tbody>${PERSONS_ROWS}${fillers(60, 'C')}</tbody></table></div></div><h4>NOTATIONS:</h4><p>** Ms Ione Cobbleworth, of Larkspur Hollow, Oregon, USA (FDA Docket No. 93N-0000), is not to be confused with Dr. Ione Cobbleworth of another town.</p></body></html>`;

// The expired page: the persons header is a row of <td> cells inside the table body
const EXPIRED = `<html><body><h2>FDA Expired Debarment List (Drug Product Applications)</h2>${FIRMS_TABLE(true).replace('None as of this date', 'None at this time')}<h3>Persons</h3><table class="Table table"><tbody><tr><td>Last Name</td><td>First &amp; Middle Names</td><td>Effective Date</td><td>End/Term of Debarment</td><td>FR Date.txt (MM/DD/YY)</td><td>Volume Page.pdf</td></tr>${[
  row(['Varnell', 'Thaddeus', '02/27/2023', '5 Years%', '02/27/2023', fr(2023, 'thaddeus-varnell', '88 FR 12369')]),
  row(['', '', '02/29/2024', 'Sp.Termination (10/26/2025)+', '02/29/2024', '89 FR 14861']),
].join('')}${fillers(40, 'E')}</tbody></table></body></html>`;

const WITH_FIRM = CURRENT.replace(FIRMS_TABLE(true), FIRMS_TABLE(false));

/* ------------------------------------------------------------------ */
/* Fake network                                                        */
/* ------------------------------------------------------------------ */

let calls = [];
function serve(routes) {
  setTransport(async (url, init) => {
    calls.push({ url, init });
    // the expired page's address contains the current page's last words, so it is looked for first
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
    const r = key ? routes[key] : { status: 404, body: 'not found' };
    const headers = { get: () => null };
    if (typeof r === 'string') return { status: 200, headers, url, text: async () => r };
    return { status: r.status || 200, headers, url, text: async () => r.body };
  });
}
const CUR = 'compliance-actions-and-activities/fda-debarment-list-drug-product-applications';
const EXP = 'fda-expired-debarment-list-drug-product-applications';
const BOTH = { [CUR]: CURRENT, [EXP]: EXPIRED };

beforeEach(() => { __resetCacheForTests(); calls = []; });
afterEach(() => setTransport());

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const subjectTask = (subject) => ({ kind: 'subject', value: subject.name, template: 'fda.debarment', depth: 0 });

/* ------------------------------------------------------------------ */
/* Reading the pages                                                   */
/* ------------------------------------------------------------------ */

describe('reading the FDA pages', () => {
  test('names, aliases, suffixes, namesake warnings, corrections and split dates', () => {
    const index = parseFdaDebarment(CURRENT);
    const by = (n) => index.rows.find((r) => r.n === n);
    expect(by('Marisol J. Quentley')).toMatchObject({ t: 'person', d: '2024-05-15', e: 'Permanent', c: '89 FR 42474', u: expect.stringMatching(/^https:\/\/www\.federalregister\.gov\//) });
    expect(by('Edwin Pravik').a).toEqual(['Ed Morrow']);
    expect(by('Orrin Tamsin').a).toEqual(['Orrin Tamzin']);
    expect(by('Orrin Tamsin').k).toEqual(['mandatory debarment, section 306(a)', 'hearing requested and denied']);
    expect(by('Wendell Halvard')).toBeTruthy();
    expect(by('Ione Cobbleworth')).toMatchObject({ w: 1, c: '58 FR 62675', m: ['FR Correction, 1993-05-05, 58 FR 26814'] });
    expect(by('Lowell Brisbane').d).toBe('2021-04-14');
    // "NMI" (no middle initial) is not a name; a link to anywhere but the Federal Register is dropped
    expect(by('Ferris Delacourt')).toMatchObject({ e: '10 years', k: ['permissive debarment, section 306(b)'] });
    expect(by('Ferris Delacourt').u).toBeUndefined();
    // "None as of this date" is not a firm; the footnote's town is never kept
    expect(index.rows.some((r) => r.t === 'entity')).toBe(false);
    expect(JSON.stringify(index)).not.toMatch(/Larkspur|Oregon|Docket/);
  });

  test('the expired page: header in the table body, an early termination attached to its row', () => {
    const index = parseFdaDebarment(EXPIRED, { expired: true });
    expect(index.rows.find((r) => r.n === 'Thaddeus Varnell')).toMatchObject({ x: 1, e: '5 Years', m: ['2024-02-29, Sp.Termination (10/26/2025): special termination of debarment, 2024-02-29, 89 FR 14861'] });
  });

  test('a changed, cut-off or empty page is an error, never a short list', () => {
    expect(() => parseFdaDebarment('<html>Page not found</html>')).toThrow(/expected format/);
    expect(() => parseFdaDebarment(CURRENT.replace(/<h3>Persons[\s\S]*$/, ''))).toThrow(/expected format/);
    expect(() => parseFdaDebarment(CURRENT.replace(fillers(60, 'C'), ''))).toThrow(/too few entries/);
    expect(() => parseFdaDebarment(EXPIRED.replace(fillers(40, 'E'), ''), { expired: true })).toThrow(/too few entries/);
  });

  test('helpers', () => {
    expect(usDate('2/2/2010')).toBe('2010-02-02');
    expect(usDate('&nbsp;01/04/2021')).toBe('2021-01-04');
    expect(usDate('Permanent')).toBe('');
    expect(readTerm('Permanent ^#')).toEqual({ term: 'Permanent', kind: ['mandatory debarment, section 306(a)', 'acquiesced to debarment'] });
    expect(listedPerson('Pai, a.k.a. Lau, Daphne', 'Daphne')).toEqual({ name: 'Daphne Pai', aliases: ['Daphne Lau'], warned: false });
  });
});

/* ------------------------------------------------------------------ */
/* The source                                                          */
/* ------------------------------------------------------------------ */

describe('FDA debarment source', () => {
  test('a full-name hit is a name match only: possible, verify identity, never likely or confirmed; pages read once', async () => {
    serve(BOTH);
    // even with a company, nothing on the list can tie the record to the person
    const subject = createSubject({ name: 'Marisol Quentley', company: 'Quentley Therapeutics' });
    const out = await fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toMatchObject({ source: 'fda-debarment', category: 'sanctions', severity: 'high', match: 'possible', matchFixed: true, date: '2024-05-15' });
    expect(f.title).toMatch(/^FDA debarment: Marisol J\. Quentley: name match only, verify identity$/);
    expect(f.url).toMatch(/federalregister\.gov\/documents\/2024/);
    expect(f.quote).toMatch(/Federal Register: 89 FR 42474/);
    expect(out.notes.join(' ')).toMatch(/name match until the Federal Register notice/);
    expect(out.partial).toBeUndefined();
    expect(calls).toHaveLength(2);
    await fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject));
    expect(calls).toHaveLength(2);
  });

  test('aliases and the FDA\'s own namesake warning; no link means the list page', async () => {
    serve(BOTH);
    const subject = createSubject({ name: 'Ed Morrow', company: 'Acme' });
    const out = await fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings[0].quote).toMatch(/Also listed as: Ed Morrow/);
    const ione = createSubject({ name: 'Ione Cobbleworth', company: 'Acme' });
    const f = (await fdaDebarmentConnector.run(subjectTask(ione), ctxFor(ione))).findings[0];
    expect(f.quote).toMatch(/not to be confused with another person of the same name/);
    expect(f.quote).not.toMatch(/Larkspur/);
    expect(f.url).toBe(FDA_DEBARMENT_PAGE);
  });

  test('an ended debarment is found on the expired list and says so', async () => {
    serve(BOTH);
    const subject = createSubject({ name: 'Thaddeus Varnell', company: 'Acme' });
    const f = (await fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject))).findings[0];
    expect(f.title).toMatch(/^FDA debarment \(ended\): Thaddeus Varnell: name match only, verify identity/);
    expect(f.quote).toMatch(/debarments that have ended/);
    expect(f.data.listPage).toBe(FDA_EXPIRED_PAGE);
  });

  test('strict names: not on part of a name, not out of order', async () => {
    serve(BOTH);
    for (const name of ['Marisol Smith', 'Quentley Marisol', 'Marisol Quentley Diaz']) {
      const subject = createSubject({ name, company: 'Acme' });
      expect((await fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject))).findings).toEqual([]);
    }
  });

  test('no match is said in plain words', async () => {
    serve(BOTH);
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const out = await fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes).toContain('FDA debarment list: no match for Elizabeth Holmes among current or ended FDA debarments');
    const co = await fdaDebarmentConnector.run({ kind: 'company', value: 'Theranos', template: 'fda.debarment' }, ctxFor(subject));
    expect(co.notes[0]).toMatch(/^FDA debarment list: no firm is currently debarred, so there is no match for Theranos/);
  });

  test('a firm on the list matched on its whole name is a company record', async () => {
    serve({ ...BOTH, [CUR]: WITH_FIRM });
    const subject = createSubject({ name: 'Jane Roe', company: 'Quillon Pharmaceutical Laboratories' });
    const out = await fdaDebarmentConnector.run({ kind: 'company', value: 'Quillon Pharmaceutical Laboratories LLC', template: 'fda.debarment' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ match: 'company', matchFixed: true });
    expect((await fdaDebarmentConnector.run({ kind: 'company', value: 'Quillon Labs', template: 'fda.debarment' }, ctxFor(subject))).findings).toEqual([]);
  });

  test('the current list failing is an error; the expired list failing is partial', async () => {
    const subject = createSubject({ name: 'Marisol Quentley', company: 'Acme' });
    serve({ [CUR]: { status: 500, body: 'error' }, [EXP]: EXPIRED });
    await expect(fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
    __resetCacheForTests();
    serve({ [CUR]: '<html>Site maintenance</html>', [EXP]: EXPIRED });
    await expect(fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/expected format/);
    __resetCacheForTests();
    serve({ [CUR]: CURRENT, [EXP]: { status: 503, body: 'down' } });
    const out = await fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.partial).toEqual(['FDA expired debarment list']);
    expect(out.notes.join(' ')).toMatch(/expired debarment list: could not be read/);
  });

  test('a name too short to screen is partial, with no request made', async () => {
    serve(BOTH);
    const subject = createSubject({ name: 'Cher', company: '' });
    const out = await fdaDebarmentConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.partial).toEqual(['Cher: name too short to screen']);
    expect(calls).toHaveLength(0);
  });

  test('contract: id, plain label, kinds, plans', () => {
    const c = fdaDebarmentConnector;
    expect(c.id).toMatch(/^[a-z0-9-]+$/);
    expect(c.label).not.toMatch(/\b(api|endpoint|key|token|free|paid|tier|quota|env)\b/i);
    expect(c.kinds).toEqual(['subject', 'company']);
    for (const kind of c.kinds) {
      for (const p of c.plan({ kind, value: 'x' })) {
        expect(p.template).toMatch(/^[a-z0-9.:_-]+$/i);
        expect(p.prior).toBeGreaterThan(0);
      }
    }
  });
});
