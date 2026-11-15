/**
 * Patent and trademark connectors. The network is faked with rows cut from
 * real answers (Google Patents, USPTO patent search and USPTO trademark
 * search, 14 Nov 2026) for Trevor Milton / Nikola, Elizabeth Holmes /
 * Theranos and Stripe.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, matchSubject } = require('../../../src/server/founder/identity');
const { patentsConnector, trademarksConnector } = require('../../../src/server/founder/sources/ip');

const reply = (body, status = 200, headers = []) => ({ status, headers: new Map(headers), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });

// no test may reach the real network: a test that forgets to fake it fails at once
beforeEach(() => setTransport(async (url) => { throw new Error(`unexpected request to ${url}`); }));
afterEach(() => { setTransport(); delete process.env.FOUNDER_SOURCES_OFF; });

/* ------------------------------------------------------------------ patents */

const gp = (number, title, priority, filed, granted, inventor, assignee) => ({
  id: `patent/${number}/en`,
  rank: 0,
  patent: { title: ` ${title}`, snippet: ' A system is provided &hellip;', priority_date: priority, filing_date: filed, grant_date: granted, publication_date: granted || filed, inventor, assignee, publication_number: number, language: 'en' },
});
const gpAnswer = (results, { total = results.length, inventors = [] } = {}) => ({
  results: {
    total_num_results: total, total_num_pages: 1, many_results: false, num_page: 0,
    cluster: [results.length ? { result: results } : {}],
    summary: results.length ? { inventor: [{ key: 'Total', value: 1000 }, ...inventors.map(([key, value]) => ({ key, value }))] } : {},
  },
});

// inventor=Trevor Milton: his Nikola patents, his earlier filings, and other people who share the name
const BY_NAME = [
  gp('JP2022040109A', 'Ventilation systems and methods for internal cabins of vehicles', '2020-08-28', '2021-08-28', null, '<b>Milton Laib Trevor</b>', 'ザ・ボーイング・カンパニー'),
  gp('EP3960629A1', 'Ventilation systems and methods for internal cabins of vehicles', '2020-08-28', '2021-08-16', null, '<b>Trevor Milton</b> LAIB', 'The Boeing Company'),
  gp('US11613312B2', 'Systems, methods, and devices for an automobile door or window', '2015-12-30', '2021-03-02', '2023-03-28', '<b>Trevor R. Milton</b>', 'Nikola Corporation'),
  gp('ZA202007753B', 'Safety scalpel', '2018-05-31', '2020-12-11', null, '<b>Trevor John Milton</b>', 'Medi Safe Surgicals Pty Ltd'),
  gp('US20160369749A1', 'Compressed natural gas filter for natural gas vehicle', '2014-05-06', '2016-09-06', null, '<b>Trevor Milton</b>', 'dHybrid Systems, LLC'),
  gp('US9463408B2', 'Compressed natural gas filter for natural gas vehicle', '2014-05-06', '2014-05-06', '2016-10-11', '<b>Trevor Milton</b>', 'dHybrid Systems, LLC'),
  gp('US20120004824A1', 'Natural gas and diesel fuel blending system', '2009-11-30', '2010-11-30', null, '<b>Trevor Robert Milton</b>', 'Trevor Robert Milton'),
  gp('AU6579696A', 'Combined golf training and tee-off mat', '1995-09-26', '1996-09-20', null, '<b>Milton Trevor</b> Wicks', 'Milton Trevor Wicks'),
  gp('AU2511277A', 'Filling and sealing of flexible containers', '1976-05-13', '1976-05-13', null, '<b>Trevor Milton</b> Grace', 'Grace T M'),
];
// inventor=Trevor Milton, assignee=Nikola
const BY_COMPANY = [
  gp('US20210179202A1', 'Systems, methods, and devices for an automobile door or window', '2015-12-30', '2021-03-02', null, '<b>Trevor R. Milton</b>', '<b>Nikola</b> Corporation'),
  gp('US10899387B2', 'Vehicle frame arrangement', '2019-01-29', '2020-02-05', '2021-01-26', '<b>Trevor R. Milton</b>', '<b>Nikola</b> Motor Company Llc'),
  gp('MX387190B', 'SYSTEMS, METHODS AND DEVICES FOR A CAR WINDOW OR DOOR', '2015-12-30', '2016-12-30', null, '<b>Trevor R Milton</b>', '<b>Nikola</b> Corp'),
  gp('WO2017196801A1', 'Electric battery assembly', '2016-05-09', '2017-05-09', null, '<b>Trevor R. MILTON</b>', 'Bluegentech Llc'),
];
const COMPANY_INVENTORS = [['Trevor R. Milton', 823], ['Steve Jennes', 647], ['Markus Scholten', 352], ['Kevin M. LYNK', 235], ['Trevor R. MILTON', 117], ['Robert Dane Davis', 117], ['Robert Dane DAVIS', 58], ['ミルトン トレバー', 40]];

const usptoRow = (guid, title, filed, published, inventorsShort, assigneeName, familyId) => ({
  guid, type: 'USPAT', inventionTitle: title, applicationFilingDate: [`${filed}T00:00:00Z`], datePublished: `${published}T00:00:00Z`, inventorsShort, assigneeName, applicantName: assigneeName,
  familyIdentifierCur: familyId, primaryExaminer: 'Blankenship; Gregory A', inventorCity: ['Phoenix'], inventorState: ['AZ'],
});
const USPTO_ROWS = [
  usptoRow('US-11613312-B2', 'Systems, methods, and devices for an automobile door or window', '2021-03-02', '2023-03-28', 'Milton; Trevor R. et al.', ['NIKOLA CORPORATION'], 67685516),
  usptoRow('US-10858049-B2', 'Systems, methods, and devices for an automobile door or window', '2019-03-20', '2020-12-08', 'Milton; Trevor R. et al.', ['Nikola Corporation'], 67685516),
  usptoRow('US-10899387-B2', 'Vehicle frame arrangement', '2020-02-05', '2021-01-26', 'Milton; Trevor R. et al.', ['NIKOLA MOTOR COMPANY LLC'], 69181820),
  usptoRow('US-10336379-B2', 'Vehicle rear suspension system', '2016-12-01', '2019-07-02', 'Lynk; Kevin M. et al.', ['NIKOLA MOTOR COMPANY LLC', 'ARVINMERITOR TECHNOLOGY, LLC'], 62190778),
];

/** Fake network for the patent sources. Each answer is a value, a reply() or a function of the request. */
function patentNetwork({ byName = gpAnswer(BY_NAME), byCompany = gpAnswer(BY_COMPANY, { inventors: COMPANY_INVENTORS }), session = reply({ userCase: { caseId: 4242 } }, 200, [['x-access-token', 'token-abc']]), uspto = { numFound: 25, patents: [USPTO_ROWS[0]] } } = {}) {
  const calls = [];
  setTransport(async (url, init) => {
    const inner = url.startsWith('https://patents.google.com/xhr/query') ? new URL(url).searchParams.get('url') : '';
    calls.push({ url, init, inner });
    const answer = inner ? (inner.includes('assignee=') ? byCompany : byName)
      : url === 'https://ppubs.uspto.gov/api/users/me/session' ? session
        : url === 'https://ppubs.uspto.gov/api/searches/searchWithBeFamily' ? uspto
          : reply('not found', 404);
    const value = typeof answer === 'function' ? answer(url, init) : answer;
    return { url, ...(value && typeof value.text === 'function' ? value : reply(value)) };
  });
  return calls;
}

const milton = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const runPatents = (subject) => patentsConnector.run({ kind: 'subject', value: subject.name }, ctxFor(subject));
const byNumber = (findings, number) => findings.find((f) => f.data?.publicationNumber === number || f.data?.publications?.includes(number));

describe('patentsConnector', () => {
  test('describes itself in plain words and works on the person only', () => {
    expect(patentsConnector.id).toBe('patents');
    expect(patentsConnector.kinds).toEqual(['subject']);
    expect(patentsConnector.label).not.toMatch(/\b(api|endpoint|free|paid|key|token)\b/i);
    expect(patentsConnector.enabled()).toBe(true);
    process.env.FOUNDER_SOURCES_OFF = 'patents';
    expect(patentsConnector.enabled()).toBe(false);
    expect(patentsConnector.unavailableReason).not.toMatch(/\b(api|endpoint|free|paid|key|token)\b/i);
  });

  test('one finding per patent family, graded from the assignee, plus a summary', async () => {
    patentNetwork();
    const subject = milton();
    const { findings, notes } = await runPatents(subject);
    const [summary, ...families] = findings;

    // Nikola: the door family (grant + application + Mexican filing), the frame, and the battery filing by Nikola's earlier name.
    // Name only: the dHybrid filter (application + grant) and the 2009 filing under his full name. Others are other people.
    expect(families.map((f) => f.data.publicationNumber)).toEqual(['US10899387B2', 'WO2017196801A1', 'US11613312B2', 'US9463408B2', 'US20120004824A1']);
    expect(families.map((f) => f.match)).toEqual(['confirmed', 'confirmed', 'confirmed', 'possible', 'possible']);
    for (const f of findings) expect(f).toMatchObject({ source: 'patents', category: 'ip', severity: 'info' });

    const door = byNumber(families, 'US11613312B2');
    expect(door.title).toBe('US11613312B2: Systems, methods, and devices for an automobile door or window');
    expect(door.quote).toBe('Inventor named: Trevor R. Milton (searched as Trevor Milton); assignee: Nikola Corporation; priority 2015-12-30; filed 2021-03-02; granted 2023-03-28; also published as US20210179202A1, MX387190B');
    expect(door.date).toBe('2015-12-30'); // the priority date
    expect(door.url).toBe('https://patents.google.com/patent/US11613312B2/en');
    expect(door.matchReasons).toEqual(['names Nikola']);
    expect(door.data).toMatchObject({ inventorAsRecorded: 'Trevor R. Milton', assignees: ['Nikola Corporation'], priorityDate: '2015-12-30', filingDate: '2021-03-02', grantDate: '2023-03-28', publications: ['US20210179202A1', 'MX387190B', 'US11613312B2'] });

    // a patent the search returns for the company but that prints another owner: tied to the company, and the record says why
    const battery = byNumber(families, 'WO2017196801A1');
    expect(battery.quote).toBe('Inventor named: Trevor R. Milton (searched as Trevor Milton); assignee: Bluegentech Llc (listed under assignee Nikola); priority 2016-05-09; filed 2017-05-09');
    expect(battery.match).toBe('confirmed');

    // a name-only record stays a possible namesake and cites the granted publication of its family
    const filter = byNumber(families, 'US9463408B2');
    expect(filter).toMatchObject({ match: 'possible', matchReasons: ['matched by name only'], date: '2014-05-06', url: 'https://patents.google.com/patent/US9463408B2/en' });
    expect(filter.quote).toBe('Inventor named: Trevor Milton; assignee: dHybrid Systems, LLC; priority 2014-05-06; filed 2014-05-06; granted 2016-10-11; also published as US20160369749A1');

    // other people: surname Laib, surname Grace, surname Wicks, and a Trevor John where the company's patents say Trevor R.
    const all = JSON.stringify(findings);
    for (const other of ['Boeing', 'Laib', 'Grace', 'Wicks', 'scalpel', 'Medi Safe']) expect(all).not.toContain(other);

    expect(summary.title).toBe('Trevor Milton: named inventor on 5 patent families (3 tied to a known company)');
    expect(summary.match).toBe('confirmed');
    expect(summary.date).toBeNull();
    expect(summary.url).toBe('https://patents.google.com/?inventor=Trevor+Milton&assignee=Nikola&sort=new');
    expect(summary.quote).toContain('Assignees on the 3 families tied to a known company: Nikola Motor Company Llc (1) / Bluegentech Llc (1) / Nikola Corporation (1).');
    expect(summary.quote).toContain('USPTO records list 25 granted US patents naming an inventor Trevor Milton with assignee Nikola.');
    expect(summary.quote).toContain('2 families match by name only and may belong to a namesake (assignees include dHybrid Systems, LLC / Trevor Robert Milton).');
    expect(summary.quote).toContain('Co-inventors on the Nikola patents: Steve Jennes, Markus Scholten, Kevin M. Lynk, Robert Dane Davis.');
    expect(summary.quote).toContain('Priority dates run from 2009-11-30 to 2019-01-29.');
    expect(summary.quote).toContain('1 record naming an inventor with a different middle name was left out.');
    expect(summary.data).toMatchObject({ families: 5, tiedToKnownCompany: 3, nameOnly: 2, countsAreMinimum: false, grantedUsPatents: 25 });
    expect(notes).toEqual([]);
  });

  test('asks each source once, by inventor name and by inventor with company', async () => {
    const calls = patentNetwork();
    await runPatents(milton());
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.inner).filter(Boolean).sort()).toEqual(['inventor=Trevor+Milton&assignee=Nikola&num=100&sort=new', 'inventor=Trevor+Milton&num=100&sort=new']);
    expect(calls[0].url).toBe('https://patents.google.com/xhr/query?url=inventor%3DTrevor%2BMilton%26num%3D100%26sort%3Dnew&exp=');
    const session = calls.find((c) => c.url.endsWith('/users/me/session'));
    expect(session.init).toMatchObject({ method: 'POST', body: '-1' });
    const search = calls.find((c) => c.url.endsWith('/searchWithBeFamily'));
    expect(search.init.headers['X-Access-Token']).toBe('token-abc');
    const body = JSON.parse(search.init.body);
    expect(body.query).toMatchObject({ caseId: 4242, q: '("Milton" NEAR2 "Trevor").in. AND ("nikola").as.', databaseFilters: [{ databaseName: 'USPAT', countryCodes: [] }] });
    expect(body).toMatchObject({ pageCount: 1, docFamilyFiltering: 'noFiltering' });
  });

  test('threads: other owners and co-inventors of confirmed patents are followed, a namesake\'s employer is not', async () => {
    patentNetwork();
    const { threads } = await runPatents(milton());
    expect(threads).toEqual([
      { kind: 'company', value: 'Bluegentech Llc', why: 'joint, earlier or later owner of a Nikola patent naming Trevor Milton as inventor', trusted: true },
      { kind: 'associate', value: 'Steve Jennes', why: 'co-inventor on Nikola patents', trusted: true },
      { kind: 'associate', value: 'Markus Scholten', why: 'co-inventor on Nikola patents', trusted: true },
      { kind: 'associate', value: 'Kevin Lynk', why: 'co-inventor on Nikola patents', trusted: true },
      { kind: 'associate', value: 'Robert Dane Davis', why: 'co-inventor on Nikola patents', trusted: true },
      { kind: 'company', value: 'dHybrid Systems, LLC', why: 'assignee on a patent naming an inventor Trevor Milton (name match only)', trusted: false },
    ]);
  });

  test('caps co-inventor threads at five and skips a misspelt copy of an owner already listed', async () => {
    const reassigned = [
      gp('US10000001B2', 'Sample analysis device', '2012-01-10', '2013-01-10', '2018-06-19', '<b>Elizabeth A. Holmes</b>', 'Labrador Diagnostics Llc'),
      gp('US10000002B2', 'Fluid transfer cartridge', '2012-02-10', '2013-02-10', '2018-06-26', '<b>Elizabeth A. Holmes</b>', 'Labrador Diagnostics Llc'),
      gp('US10000003B2', 'Sample collection vessel', '2012-03-10', '2013-03-10', '2018-07-03', '<b>Elizabeth A. Holmes</b>', 'Labrodor Diagnostics LLC'),
      gp('JP2015500001A', 'Sample analysis device', '2012-01-10', '2013-01-10', null, '<b>A Holmes Elizabeth</b>', 'セラノス アイピー カンパニー エルエルシー'),
      gp('US10000004B2', 'Assay reader', '2012-04-10', '2013-04-10', '2018-07-10', '<b>Elizabeth A. Holmes</b>', '<b>Theranos</b> Ip Company, Llc'),
    ];
    const inventors = [['Elizabeth A. Holmes', 752], ['Daniel Young', 277], ['Ian Gibbons', 158], ['Michael Chen', 148], ['Samartha Anekal', 148], ['A Holmes Elizabeth', 108], ['Young Daniel', 100], ['Sunny Balwani', 90], ['Timothy Smith', 80]];
    patentNetwork({ byName: gpAnswer([]), byCompany: gpAnswer(reassigned, { inventors }), uspto: { numFound: 96, patents: [] } });
    const { findings, threads } = await runPatents(createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' }));
    expect(findings.slice(1).every((f) => f.match === 'confirmed')).toBe(true);
    expect(byNumber(findings, 'JP2015500001A').data.publications).toEqual(['US10000001B2', 'JP2015500001A']); // "A Holmes Elizabeth" is her, same family
    expect(threads.filter((t) => t.kind === 'company').map((t) => t.value)).toEqual(['Labrador Diagnostics Llc']);
    expect(threads.filter((t) => t.kind === 'associate').map((t) => t.value)).toEqual(['Daniel Young', 'Ian Gibbons', 'Michael Chen', 'Samartha Anekal', 'Sunny Balwani']);
    expect(threads.every((t) => t.trusted)).toBe(true);
  });

  test('without a company every patent is a possible namesake and nothing is followed', async () => {
    const calls = patentNetwork();
    const subject = createSubject({ name: 'Trevor Milton' });
    const { findings, threads } = await runPatents(subject);
    expect(calls.map((c) => c.inner)).toEqual(['inventor=Trevor+Milton&num=100&sort=new']); // no company search, no USPTO count
    expect(findings.length).toBeGreaterThan(1);
    expect(findings.every((f) => f.match === 'possible')).toBe(true);
    expect(findings[0].title).toBe('Trevor Milton: named inventor on 4 patent families (none tied to a known company)');
    expect(byNumber(findings, 'ZA202007753B')).toBeTruthy(); // nothing says which middle name is his, so Trevor John stays in, as possible
    expect(threads.every((t) => t.kind === 'company' && t.trusted === false)).toBe(true);
    expect(threads.map((t) => t.value)).toEqual(expect.arrayContaining(['Nikola Corporation', 'dHybrid Systems, LLC']));
    expect(threads.map((t) => t.value)).not.toContain('Trevor Robert Milton'); // a person is not a company
  });

  test('a company learned earlier confirms its patents, and a name-only record can be re-graded from its own text', async () => {
    patentNetwork();
    const subject = milton();
    const before = byNumber((await runPatents(subject)).findings, 'US9463408B2');
    expect(before.match).toBe('possible');
    addAnchor(subject, 'companies', 'dHybrid Systems', 'found');
    expect(matchSubject(subject, `${before.title} ${before.quote}`).level).toBe('confirmed'); // what the loop does when it re-reads records
    // records written with a middle initial carry the searched name, so they can be re-read too
    const other = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const door = byNumber((await runPatents(other)).findings, 'US11613312B2');
    expect(matchSubject(other, `${door.title} ${door.quote}`).level).toBe('confirmed');
    patentNetwork();
    const after = byNumber((await runPatents(subject)).findings, 'US9463408B2');
    expect(after.match).toBe('confirmed');
  });

  test('a middle name given by the user rules out inventors with another one', async () => {
    const rows = [
      gp('US7291497B2', 'Medical device for analyte monitoring and drug delivery', '2003-09-11', '2004-09-10', '2007-11-06', '<b>Elizabeth A. Holmes</b>', 'Theranos, Inc.'),
      gp('US5102031A', 'Method for depositing braze alloy to base metal surfaces', '1991-03-11', '1991-03-11', '1992-04-07', '<b>Elizabeth J. Holmes</b>', 'General Motors Corporation'),
      gp('EM0001234', 'Analyzer housing', '2021-11-12', '2021-11-12', null, '<b>Elizabeth</b> Schilling <b>HOLMES</b> Laura', 'Beckman Coulter, Inc.'),
    ];
    patentNetwork({ byName: gpAnswer(rows) });
    const { findings } = await runPatents(createSubject({ name: 'Elizabeth Anne Holmes' }));
    expect(findings.map((f) => f.data?.publicationNumber).filter(Boolean)).toEqual(['US7291497B2']);
    expect(findings[0].quote).toContain('1 record naming an inventor with a different middle name was left out.');
  });

  test('says the counts are a minimum when a search has more records than were read', async () => {
    patentNetwork({ byName: gpAnswer(BY_NAME, { total: 646 }) });
    const { findings: [summary] } = await runPatents(milton());
    expect(summary.title).toBe('Trevor Milton: named inventor on at least 5 patent families (3 tied to a known company)');
    expect(summary.quote).toContain('Google Patents returns 646 results for inventor Trevor Milton; only the newest 100 of each search were read, so the counts here are a minimum.');
    expect(summary.data.countsAreMinimum).toBe(true);
  });

  test('lists at most 25 families, confirmed first then newest name-only, and says so', async () => {
    const many = Array.from({ length: 40 }, (_, i) => gp(`US${9000000 + i}B2`, `Widget number ${i} with part ${i * 7}`, `20${String(10 + (i % 10)).padStart(2, '0')}-01-${String(1 + (i % 28)).padStart(2, '0')}`, '2020-01-01', '2021-01-01', '<b>Trevor Milton</b>', i < 22 ? 'Nikola Corporation' : 'Other Widgets Inc.'));
    patentNetwork({ byName: gpAnswer(many), byCompany: gpAnswer([]) });
    const { findings, notes } = await runPatents(milton());
    expect(findings).toHaveLength(26); // summary + 25
    expect(findings.slice(1).filter((f) => f.match === 'confirmed')).toHaveLength(22);
    expect(findings.slice(1).filter((f) => f.match === 'possible')).toHaveLength(3);
    const confirmedDates = findings.slice(1, 23).map((f) => f.date);
    expect(confirmedDates).toEqual([...confirmedDates].sort().reverse()); // newest first
    expect(findings[0].title).toBe('Trevor Milton: named inventor on 40 patent families (22 tied to a known company)');
    expect(notes).toEqual(['Patents: the 25 most relevant of 40 patent families naming Trevor Milton are listed.']);
  });

  test('a patent title with a medical word is kept without the title', async () => {
    patentNetwork({ byName: gpAnswer([]), byCompany: gpAnswer([gp('US8007999B2', 'Real-time detection of HIV and cancer markers', '2006-05-10', '2007-05-09', '2011-08-30', '<b>Elizabeth A. Holmes</b>', '<b>Theranos</b>, Inc.')]) });
    const { findings } = await runPatents(createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' }));
    expect(findings[1].title).toBe('US8007999B2: patent record (title not shown)');
    expect(findings[1].match).toBe('confirmed');
  });

  test('never reads inventor city or state from the USPTO record', async () => {
    patentNetwork({ byName: reply('busy', 500), byCompany: reply('busy', 500), uspto: { numFound: 4, patents: USPTO_ROWS } });
    const out = JSON.stringify(await runPatents(milton()));
    for (const field of ['Phoenix', 'AZ', 'Blankenship']) expect(out).not.toContain(field);
  });

  test('Google Patents down: the USPTO list of granted US patents is used and says what it cannot show', async () => {
    const calls = patentNetwork({ byName: reply('busy', 500), byCompany: reply('busy', 500), uspto: { numFound: 25, patents: USPTO_ROWS } });
    const { findings, threads, notes } = await runPatents(milton());
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/searchWithBeFamily')).init.body).pageCount).toBe(25);
    expect(notes).toEqual(['Google Patents did not answer, so only granted US patents from the USPTO are listed.']);
    const [summary, ...families] = findings;
    // two grants of one family (the office's family number) are one finding; the patent that prints Kevin Lynk first cannot be checked
    // newest first: the frame family (filed 2020) before the door family (filed 2019)
    expect(families.map((f) => f.data.publications)).toEqual([['US10899387B2'], ['US11613312B2', 'US10858049B2']]);
    expect(families[1]).toMatchObject({ title: 'US10858049B2: Systems, methods, and devices for an automobile door or window', match: 'confirmed', date: '2019-03-20', url: 'https://patents.google.com/patent/US10858049B2/en' });
    expect(families[1].quote).toBe('Inventor named: Trevor R. Milton (searched as Trevor Milton); assignee: NIKOLA CORPORATION; filed 2019-03-20; granted 2020-12-08; also published as US11613312B2');
    expect(summary.title).toBe('Trevor Milton: named inventor on at least 2 patent families (2 tied to a known company)');
    expect(summary.quote).toContain('USPTO records list 25 granted US patents naming an inventor Trevor Milton with assignee Nikola; the newest 4 were read, and 1 that print another person as first-named inventor are not listed.');
    expect(summary.quote).toContain('Filing dates run from 2019-03-20 to 2020-02-05.');
    expect(JSON.stringify(findings)).not.toContain('Lynk');
    expect(threads).toEqual([]);
  });

  test('one of the two Google searches down: the other is used, with a note', async () => {
    patentNetwork({ byName: reply('busy', 500) });
    const first = await runPatents(milton());
    expect(first.notes).toEqual(['The patent search by name alone did not answer; only patents assigned to Nikola are listed.']);
    expect(first.findings.slice(1).map((f) => f.match)).toEqual(['confirmed', 'confirmed', 'confirmed']);

    patentNetwork({ session: reply('no', 500) }); // the USPTO count is optional
    const second = await runPatents(milton());
    expect(second.findings).toHaveLength(6);
    expect(second.findings[0].quote).not.toContain('USPTO');
    expect(second.findings[0].data.grantedUsPatents).toBeNull();
  });

  test('rejects when no patent source answers', async () => {
    patentNetwork({ byName: reply('busy', 500), byCompany: reply('busy', 500), session: reply('no', 500) });
    await expect(runPatents(milton())).rejects.toThrow(/HTTP 500/);
    patentNetwork({ byName: reply('<html>sorry</html>'), byCompany: reply('<html>sorry</html>'), session: reply({ userCase: {} }) });
    await expect(runPatents(milton())).rejects.toThrow();
    patentNetwork({ byName: reply({ unexpected: true }), session: reply('no', 500) });
    await expect(runPatents(createSubject({ name: 'Trevor Milton' }))).rejects.toThrow(/Unexpected answer/);
  });

  test('no patents under the name: nothing, without failing', async () => {
    patentNetwork({ byName: gpAnswer([]), byCompany: gpAnswer([]), uspto: { numFound: 0, patents: [] } });
    expect(await runPatents(milton())).toEqual({ findings: [], threads: [], notes: [] });
    // only other people: say why nothing is listed
    patentNetwork({ byName: gpAnswer([gp('ZA202007753B', 'Safety scalpel', '2018-05-31', '2020-12-11', null, '<b>Trevor John Milton</b>', 'Medi Safe Surgicals Pty Ltd')]), byCompany: gpAnswer([]) });
    const out = await runPatents(createSubject({ name: 'Trevor R. Milton', company: 'Nikola' }));
    expect(out.findings).toEqual([]);
    expect(out.notes).toEqual(['Patent records under the name Trevor R. Milton belong to inventors with a different middle name and were left out.']);
  });

  test('does nothing for a single-word name or a thread that is not the person', async () => {
    const calls = patentNetwork();
    expect(await patentsConnector.run({ kind: 'subject', value: 'Madonna' }, ctxFor(createSubject({ name: 'Madonna' })))).toEqual({ findings: [], threads: [], notes: [] });
    expect(await patentsConnector.run({ kind: 'associate', value: 'Steve Jennes' }, ctxFor(milton()))).toEqual({ findings: [], threads: [], notes: [] });
    expect(calls).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- trademarks */

const tm = (id, wordmark, owners, filed, { registered = null, registrationId = null, abandoned = null, cancelled = null, alive = false, classes = ['IC 036'] } = {}) => ({
  index: 'tmsearch-index', type: '_doc', id, score: null,
  source: { id, wordmark, ownerName: owners, filedDate: `${filed}T00:00:00`, registrationDate: registered, registrationId, abandonDate: abandoned, cancelDate: cancelled, alive, internationalClass: classes },
});
const tmAnswer = (hits, total = hits.length) => ({ took: 3, timedOut: false, hits: { totalValue: total, totalRelation: 'eq', maxScore: null, hits } });

const STRIPE_DE = 'STRIPE, INC. (CORPORATION; DELAWARE, USA)';
const STRIPE_LLC = 'STRIPE, LLC (LIMITED LIABILITY COMPANY; DELAWARE, USA)';
const STRIPE_HITS = [
  tm('73200001', 'STRIPE-A-LOT', ['STRIPE-A-LOT OF KANSAS CITY, INC. (CORPORATION; KANSAS, USA)'], '1979-02-02', { cancelled: '1990-01-01' }),
  tm('74230329', 'ACCUBRAILLE', ['Stripe, Inc. (CORPORATION; CALIFORNIA, USA)'], '1991-12-16', { registered: '1992-11-17', cancelled: '1999-05-24' }),
  tm('85214873', 'STRIPE', [STRIPE_DE, STRIPE_LLC], '2011-01-11', { registered: '2013-12-17', registrationId: '4451679', alive: true }),
  tm('85433001', 'EARTH MUSIC & ECOLOGY', ['STRIPE INTERNATIONAL INC. (CORPORATION; JAPAN)'], '2011-09-30', { abandoned: '2013-01-01' }),
  tm('86000002', 'STRIPE', [STRIPE_DE], '2013-07-01', { abandoned: '2014-09-01' }),
  tm('87370001', 'STRIPE IT RICH', ['Stripe, Edwardo (INDIVIDUAL; USA)'], '2017-03-15', { abandoned: '2018-01-01' }),
  tm('88072835', 'SORBET', ['Stripe, Inc. (CORPORATION; Delaware, USA)'], '2018-08-09', { registered: '2019-09-24', registrationId: '5869618', alive: true, classes: ['IC 009', 'IC 042.'] }),
  tm('90803481', 'LINK', [STRIPE_LLC], '2021-06-30', { alive: true }),
  tm('98466744', 'LEMON SQUEEZY', ['STRIPE, INC. (CORPORATION; CALIFORNIA, USA)', STRIPE_LLC], '2024-03-25', { registered: '2026-01-13', alive: true }),
  tm('99000003', 'BLUE STRIPE', ['BLUE STRIPE, LLC (LIMITED LIABILITY COMPANY; COLORADO, USA)'], '2025-02-02', { alive: true }),
];

function trademarkNetwork(answers) {
  const calls = [];
  const queue = Array.isArray(answers) ? [...answers] : [answers];
  setTransport(async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    return { url, ...(answer && typeof answer.text === 'function' ? answer : reply(answer)) };
  });
  return calls;
}
const collison = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
const runTrademarks = (company, subject = collison) => trademarksConnector.run({ kind: 'company', value: company }, ctxFor(subject));

describe('trademarksConnector', () => {
  test('describes itself in plain words and works on companies only', async () => {
    expect(trademarksConnector.id).toBe('trademarks');
    expect(trademarksConnector.kinds).toEqual(['company']);
    expect(trademarksConnector.label).not.toMatch(/\b(api|endpoint|free|paid|key|token)\b/i);
    const calls = trademarkNetwork(tmAnswer(STRIPE_HITS));
    expect(await trademarksConnector.run({ kind: 'subject', value: 'Patrick Collison' }, ctxFor(collison))).toEqual({ findings: [], threads: [], notes: [] });
    expect(await runTrademarks(' ')).toEqual({ findings: [], threads: [], notes: [] });
    expect(calls).toHaveLength(0);
    process.env.FOUNDER_SOURCES_OFF = 'patents,trademarks';
    expect(trademarksConnector.enabled()).toBe(false);
  });

  test('a summary with count, earliest filing date and live against dead, then the individual marks', async () => {
    trademarkNetwork(tmAnswer(STRIPE_HITS));
    const { findings, threads, notes } = await runTrademarks('Stripe');
    const [summary, ...marks] = findings;
    expect(summary.title).toBe('Stripe: 5 US trademark filings, earliest filed 2011-01-11; 4 live, 1 no longer live');
    expect(summary).toMatchObject({ source: 'trademarks', category: 'ip', match: 'company', severity: 'info', date: '2011-01-11', url: 'https://tsdr.uspto.gov/statusview/sn85214873' });
    expect(summary.matchReasons).toEqual(['trademark owner name matches Stripe']);
    expect(summary.quote).toBe('Owner on record: STRIPE, INC. (CORPORATION; DELAWARE, USA) / STRIPE, LLC (LIMITED LIABILITY COMPANY; DELAWARE, USA) / STRIPE, INC. (CORPORATION; CALIFORNIA, USA). Earliest filing: STRIPE, serial 85214873, filed 2011-01-11 (registered 2013-12-17, live). Latest filing: LEMON SQUEEZY, serial 98466744, filed 2024-03-25. 3 registered; 1 abandoned; 0 cancelled. Not counted, as they may belong to another company of the same name: 1 filing under the same name on 1991-12-16, years apart from the rest.');
    expect(summary.data).toMatchObject({ company: 'Stripe', filings: 5, live: 4, notLive: 1, earliestFiled: '2011-01-11', latestFiled: '2024-03-25', sameNameNotCounted: [{ owner: 'Stripe, Inc.', filings: 1, earliestFiled: '1991-12-16' }] });

    // one finding per distinct mark after the earliest: the second STRIPE filing is not repeated
    expect(marks.map((f) => f.title)).toEqual([
      'Trademark SORBET (serial 88072835): filed 2018-08-09; registered 2019-09-24, live',
      'Trademark LINK (serial 90803481): filed 2021-06-30; pending (live)',
      'Trademark LEMON SQUEEZY (serial 98466744): filed 2024-03-25; registered 2026-01-13, live',
    ]);
    expect(marks[0]).toMatchObject({ category: 'ip', match: 'company', severity: 'info', date: '2018-08-09', url: 'https://tsdr.uspto.gov/statusview/sn88072835' });
    expect(marks[0].quote).toBe('Owner: Stripe, Inc. (CORPORATION; Delaware, USA); filed 2018-08-09; registered 2019-09-24 (registration 5869618); status: live; classes: IC 009, IC 042');
    expect(marks[0].data).toMatchObject({ serial: '88072835', wordmark: 'SORBET', live: true, filed: '2018-08-09', registered: '2019-09-24', classes: ['IC 009', 'IC 042'] });
    expect(threads).toEqual([]);
    expect(notes).toEqual(['Trademarks: more than one owner may be using the name Stripe. The owner with the most filings is reported; not counted: 1 filing under the same name on 1991-12-16, years apart from the rest.']);
  });

  test('matches the whole owner name, never a word inside it, and never names a private owner', async () => {
    trademarkNetwork(tmAnswer(STRIPE_HITS));
    const out = JSON.stringify(await runTrademarks('Stripe'));
    for (const other of ['BLUE STRIPE', 'STRIPE INTERNATIONAL', 'EARTH MUSIC', 'STRIPE-A-LOT', 'Edwardo', 'STRIPE IT RICH', 'ACCUBRAILLE']) expect(out).not.toContain(other);
  });

  test('asks for owners whose name begins with the company name and never for address fields', async () => {
    const calls = trademarkNetwork(tmAnswer([]));
    await runTrademarks('Stripe, Inc.');
    await runTrademarks('Mistral AI');
    await runTrademarks('Cloud Kitchens');
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].body.query).toEqual({ span_first: { match: { span_term: { ownerName: 'stripe' } }, end: 1 } });
    expect(calls[0].body.sort).toEqual([{ filedDate: 'asc' }]);
    expect(calls[0].body._source).toEqual(['id', 'wordmark', 'ownerName', 'filedDate', 'registrationDate', 'registrationId', 'abandonDate', 'cancelDate', 'alive', 'internationalClass']);
    expect(JSON.stringify(calls[0].body)).not.toMatch(/ownerFullText|ownerNameAndAddress|attorney/i);
    // "Mistral AI": the shorter form is searched, so an owner recorded as "Mistral" or "Mistral AI" is seen
    expect(calls[1].body.query).toEqual({ span_first: { match: { span_term: { ownerName: 'mistral' } }, end: 1 } });
    // a generic first word is part of the name: "Cloud Kitchens" is not searched as "Kitchens"
    expect(calls[2].body.query).toEqual({ span_first: { match: { span_near: { clauses: [{ span_term: { ownerName: 'cloud' } }, { span_term: { ownerName: 'kitchens' } }], slop: 0, in_order: true } }, end: 2 } });
  });

  test('owners that differ only in legal form are one company when a mark lists both; another form on its own is left out', async () => {
    const corp = 'Nikola Corporation (CORPORATION; DELAWARE, USA)';
    trademarkNetwork(tmAnswer([
      tm('86617205', 'NIKOLA MOTOR COMPANY', [corp], '2015-05-01', { abandoned: '2022-08-22', classes: ['IC 012'] }),
      tm('86617159', 'NIKOLA', ['Nikola Corporation (LIMITED LIABILITY COMPANY; ARIZONA, USA)'], '2015-05-01', { abandoned: '2019-06-24' }),
      tm('86617100', 'NIKOLA', [corp, 'HYROAD NETWORKS LLC (LIMITED LIABILITY COMPANY; DELAWARE, USA)'], '2015-05-01', { registered: '2017-02-07', alive: true }),
      tm('87646686', 'NIKOLA POWER', ['Nikola LLC (LIMITED LIABILITY COMPANY; COLORADO, USA)'], '2017-10-16', { abandoned: '2025-03-03' }),
      tm('87573681', 'NATURAL SCULPTURE', ['Nikola Spasic (INDIVIDUAL; USA)'], '2017-08-17', { abandoned: '2018-06-01' }),
      tm('88199888', 'NIKOLA LABS', ['Nikola Labs Inc. (CORPORATION; DELAWARE, USA)'], '2018-11-20', { alive: true }),
    ]));
    const { findings, notes } = await runTrademarks('Nikola', createSubject({ name: 'Trevor Milton', company: 'Nikola' }));
    expect(findings[0].title).toBe('Nikola: 3 US trademark filings, earliest filed 2015-05-01; 1 live, 2 no longer live');
    expect(findings[0].quote).toContain('Not counted, as they may belong to another company of the same name: Nikola LLC (1 filing, earliest 2017-10-16).');
    expect(findings).toHaveLength(2); // the summary cites the earliest NIKOLA MOTOR COMPANY filing; NIKOLA is listed once
    expect(findings[1].title).toBe('Trademark NIKOLA (serial 86617159): filed 2015-05-01; abandoned 2019-06-24');
    expect(JSON.stringify(findings)).not.toMatch(/Spasic|NIKOLA LABS|NIKOLA POWER/);
    expect(notes).toHaveLength(1);
  });

  test('"WeWork" finds "WeWork Companies LLC"; a generic word more or less is accepted only for a single owner', async () => {
    trademarkNetwork(tmAnswer([
      tm('85081288', 'WE LIVE', ['WEWORK COMPANIES INC. (CORPORATION; DELAWARE, USA)'], '2010-07-09', { abandoned: '2014-03-31' }),
      tm('85868860', 'WEWORK', ['WEWORK COMPANIES INC. (CORPORATION; DELAWARE, USA)', 'WeWork Companies LLC (LIMITED LIABILITY COMPANY; DELAWARE, USA)'], '2013-03-06', { registered: '2017-01-10', alive: true }),
    ]));
    const wework = await runTrademarks('WeWork', createSubject({ name: 'Adam Neumann', company: 'WeWork' }));
    expect(wework.findings[0].title).toBe('WeWork: 2 US trademark filings, earliest filed 2010-07-09; 1 live, 1 no longer live');
    expect(wework.notes).toEqual([]);

    const mistralAi = 'Mistral AI (SOCIÉTÉ PAR ACTIONS SIMPLIFIÉE (SAS); FRANCE)';
    trademarkNetwork(tmAnswer([tm('79397874', 'MISTRAL AI', [mistralAi, 'Mistral AI (UNKNOWN; FRANCE)'], '2023-12-15', { registered: '2025-06-24', alive: true, classes: ['IC 009', 'IC 042'] })]));
    const mistral = await runTrademarks('Mistral', createSubject({ name: 'Arthur Mensch', company: 'Mistral' }));
    expect(mistral.findings).toHaveLength(1);
    expect(mistral.findings[0].title).toBe('Mistral: 1 US trademark filing, earliest filed 2023-12-15; 1 live, 0 no longer live');
    expect(mistral.findings[0].matchReasons).toEqual(['trademark owner Mistral AI matches Mistral apart from a generic word']);
    expect(mistral.findings[0].quote).toContain(`Owner on record: ${mistralAi}.`);

    // two different owners that are both "Mistral" plus a generic word: neither is taken
    trademarkNetwork(tmAnswer([
      tm('79397874', 'MISTRAL AI', [mistralAi], '2023-12-15', { alive: true }),
      tm('87000001', 'MISTRAL', ['Mistral Group, Inc. (CORPORATION; MARYLAND, USA)'], '2016-04-04', { alive: true }),
    ]));
    const unclear = await runTrademarks('Mistral', createSubject({ name: 'Arthur Mensch', company: 'Mistral' }));
    expect(unclear.findings).toEqual([]);
    expect(unclear.notes).toEqual(['Trademark owners with names close to Mistral could not be told apart (Mistral AI; Mistral Group, Inc.), so none was matched.']);
  });

  test('no owner with exactly that name: nothing is counted and the near misses are named (organisations only)', async () => {
    trademarkNetwork(tmAnswer([
      tm('86900001', 'FTX', ['FTX GAMES LTD (LIMITED LIABILITY COMPANY; CYPRUS)', 'TILTING POINT MEDIA LLC (LIMITED LIABILITY COMPANY; DELAWARE, USA)'], '2016-02-16', { abandoned: '2019-01-01' }),
      tm('90700001', 'FTX', ['FTX RECOVERY TRUST (TRUST; DELAWARE, USA)'], '2021-05-12', { alive: true }),
      tm('90700002', 'FTX FAN', ['Ftx Rivera (UNKNOWN; NOT PROVIDED)'], '2022-05-12', { alive: true }),
    ]));
    const { findings, notes } = await runTrademarks('FTX', createSubject({ name: 'Sam Bankman-Fried', company: 'FTX' }));
    expect(findings).toEqual([]);
    expect(notes).toEqual(['No US trademark owner is named exactly FTX. Owners with longer names were not counted, as they may be other companies: FTX GAMES LTD; FTX RECOVERY TRUST.']);
  });

  test('lists at most eight individual marks and says when the list may be incomplete', async () => {
    const hits = Array.from({ length: 14 }, (_, i) => tm(String(88000000 + i), `MARK ${i}`, [STRIPE_DE], `20${10 + i}-03-01`, { alive: i % 2 === 0 }));
    trademarkNetwork(tmAnswer(hits, 900));
    const { findings, notes } = await runTrademarks('Stripe');
    expect(findings).toHaveLength(9);
    expect(findings[0].title).toBe('Stripe: 14 US trademark filings, earliest filed 2010-03-01; 7 live, 7 no longer live');
    expect(findings.slice(1).map((f) => f.data.wordmark)).toEqual(['MARK 1', 'MARK 2', 'MARK 3', 'MARK 4', 'MARK 5', 'MARK 6', 'MARK 7', 'MARK 8']);
    expect(notes).toEqual(['The trademark list for Stripe may be incomplete: many owners have names that begin the same way.']);
  });

  test('a mark with a protected word is kept as a filing without the mark text', async () => {
    trademarkNetwork(tmAnswer([
      tm('88000001', 'STRIPE', [STRIPE_DE], '2011-01-11', { alive: true }),
      tm('88000002', 'HIV CARE PAY', [STRIPE_DE], '2012-01-11', { abandoned: '2013-02-02' }),
    ]));
    const { findings } = await runTrademarks('Stripe');
    expect(findings).toHaveLength(2);
    expect(findings[0].quote).not.toContain('HIV');
    expect(findings[0].title).toBe('Stripe: 2 US trademark filings, earliest filed 2011-01-11; 1 live, 1 no longer live');
    expect(findings[1].title).toBe('Trademark filing (serial 88000002): filed 2012-01-11; abandoned 2013-02-02');
    expect(findings[1].data).toEqual({ serial: '88000002', live: false, filed: '2012-01-11' });
  });

  test('a name with an accent or apostrophe is asked for once more by phrase', async () => {
    const calls = trademarkNetwork([tmAnswer([]), tmAnswer([tm('79000001', 'ELSEVE', ["L'Oréal (SOCIÉTÉ ANONYME; FRANCE)"], '2001-02-03', { registered: '2002-03-04', alive: true })])]);
    const { findings } = await runTrademarks("L'Oréal", createSubject({ name: 'Jean Dupont', company: "L'Oréal" }));
    expect(calls).toHaveLength(2);
    expect(calls[1].body.query).toEqual({ bool: { must: [{ match_phrase: { ownerName: "L'Oréal" } }] } });
    expect(findings[0].title).toBe("L'Oréal: 1 US trademark filing, earliest filed 2001-02-03; 1 live, 0 no longer live");
    // a plain name with no hits is not asked for twice
    const plain = trademarkNetwork(tmAnswer([]));
    expect(await runTrademarks('Stripe')).toEqual({ findings: [], threads: [], notes: [] });
    expect(plain).toHaveLength(1);
  });

  test('rejects when the trademark search fails or answers with something else', async () => {
    trademarkNetwork(reply('down', 500));
    await expect(runTrademarks('Stripe')).rejects.toThrow(/HTTP 500/);
    trademarkNetwork(reply({ error: '[prefix] query does not support [case_insensitive]', status: 400 }));
    await expect(runTrademarks('Stripe')).rejects.toThrow(/Unexpected answer/);
    trademarkNetwork(reply('<html>maintenance</html>'));
    await expect(runTrademarks('Stripe')).rejects.toThrow();
  });
});
