/**
 * Deep founder check, core rules: privacy guardrails, identity grading and
 * the shared finding shape.
 */
const { redactPII, isBlockedUrl, isSensitive, mentionsMinor, sanitizeFinding } = require('../../../src/server/founder/guardrails');
const { createSubject, addAnchor, matchSubject, slugCandidates, exportAnchors, restoreSubject } = require('../../../src/server/founder/identity');
const { makeFinding, makeThread, connectorResult } = require('../../../src/server/founder/finding');
const { htmlToText, mapLimit, request, getJson, setTransport } = require('../../../src/server/founder/http');

describe('guardrails', () => {
  test('contact and locating details are removed from quoted text', () => {
    expect(redactPII('Reach Jane at jane.doe@example.com or (415) 555-0100.')).toBe('Reach Jane at [email removed] or [phone removed].');
    expect(redactPII('She lives at 1234 Elm Street, Apt 5B, Palo Alto.')).toBe('She lives at [address removed], Palo Alto.');
    expect(redactPII('SSN 123-45-6789 on file')).toMatch(/\[ID number removed\]/);
    expect(redactPII('born on March 3, 1984 in Lyon')).toBe('born in 1984 in Lyon');
    expect(redactPII('DOB: 03/03/1984')).toBe('DOB 1984');
    // ordinary numbers, years and money are untouched
    expect(redactPII('Raised $113 million in 2023 at a 2,000 million valuation, case 3:18-cr-00258.')).toBe('Raised $113 million in 2023 at a 2,000 million valuation, case 3:18-cr-00258.');
  });

  test('people-search, data-broker and leak hosts are blocked; ordinary hosts are not', () => {
    expect(isBlockedUrl('https://www.spokeo.com/Jane-Doe')).toBe(true);
    expect(isBlockedUrl('https://people.zoominfo.com/p/x')).toBe(true);
    expect(isBlockedUrl('https://doxbin.org/upload/x')).toBe(true);
    expect(isBlockedUrl('https://www.sec.gov/litigation')).toBe(false);
    expect(isBlockedUrl('https://www.linkedin.com/in/jane-doe')).toBe(false);
    expect(isBlockedUrl('not a url')).toBe(false);
  });

  test('protected matters and children are never reported; court records about misconduct are', () => {
    expect(isSensitive('He was diagnosed with cancer in 2020.')).toBe(true);
    expect(isSensitive('He was charged with securities fraud in 2020.')).toBe(false);
    expect(mentionsMinor('The couple and their daughter moved to Austin.')).toBe(true);
    expect(mentionsMinor('Her father ran the family steel business.')).toBe(false);
    expect(sanitizeFinding({ title: 'Profile', quote: 'Her 6-year-old son attends school nearby.', url: 'https://example.com/a', category: 'press' })).toBeNull();
    expect(sanitizeFinding({ title: 'Whitepages', quote: 'x', url: 'https://www.whitepages.com/name/x', category: 'press' })).toBeNull();
    const kept = sanitizeFinding({ title: 'U.S. v. Doe', quote: 'Defendant cited depression at sentencing; contact doe@example.com', url: 'https://www.courtlistener.com/docket/1/', category: 'litigation' });
    expect(kept.quote).toBe('Defendant cited depression at sentencing; contact [email removed]');
  });
});

describe('identity', () => {
  test('slugs a person commonly uses', () => {
    expect(slugCandidates('Arthur Mensch')).toEqual(expect.arrayContaining(['arthur-mensch', 'arthurmensch', 'arthur.mensch', 'amensch']));
    expect(slugCandidates("José María O'Neil")).toEqual(expect.arrayContaining(['jose-oneil', 'jose-maria-oneil']));
    expect(slugCandidates('Cher')).toEqual([]);
  });

  test('a record is graded by name plus what is known about the subject, never by name alone', () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    expect(matchSubject(subject, 'Elizabeth Holmes, founder of Theranos, Inc., was indicted.').level).toBe('confirmed');
    expect(matchSubject(subject, 'Elizabeth Holmes won the county bake-off.').level).toBe('possible');
    expect(matchSubject(subject, 'Theranos collapsed in 2018.').level).toBe('none');
    expect(matchSubject(subject, 'E. Holmes of Theranos').level).toBe('none'); // initials do not match
    // learning a school and a co-founder upgrades later records
    expect(addAnchor(subject, 'schools', 'Stanford University', 'f1')).toBe(true);
    expect(addAnchor(subject, 'people', 'Ramesh Balwani', 'f2')).toBe(true);
    expect(addAnchor(subject, 'people', 'Ramesh Balwani', 'f3')).toBe(false); // already known
    expect(addAnchor(subject, 'people', 'Elizabeth Holmes', 'f4')).toBe(false); // never herself
    expect(matchSubject(subject, 'Elizabeth Holmes dropped out of Stanford University at 19.')).toMatchObject({ level: 'likely' });
    expect(matchSubject(subject, 'Elizabeth Holmes and Ramesh Balwani were tried separately.').level).toBe('likely');
  });

  test('anchors survive being saved and restored between requests', () => {
    const subject = createSubject({ name: 'Adam Neumann', company: 'WeWork' });
    addAnchor(subject, 'companies', 'Flow', 'f9');
    addAnchor(subject, 'handles', 'adamneumann', 'f10');
    const saved = JSON.parse(JSON.stringify({ name: subject.name, company: subject.company, anchors: exportAnchors(subject) }));
    const again = restoreSubject(saved);
    expect(matchSubject(again, 'Adam Neumann raised $350 million for Flow.').level).toBe('confirmed');
    // a company named with an ordinary word only counts when it is written as a name
    expect(matchSubject(again, 'Adam Neumann, a plumber, fixed the cash flow problem.').level).not.toBe('confirmed');
    const stripe = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    expect(matchSubject(stripe, 'Patrick Collison wore a shirt with a blue stripe.').level).toBe('possible');
    expect(matchSubject(stripe, 'Patrick Collison, chief executive of Stripe, said so.').level).toBe('confirmed');
    expect(matchSubject(stripe, 'PATRICK COLLISON — STRIPE INC').level).toBe('confirmed');
    expect(matchSubject(stripe, 'Patrick Collison https://stripe.com/about').level).toBe('confirmed');
    expect(matchSubject(stripe, 'Patrick Collison linkedin.com/company/stripe').level).toBe('confirmed');
    const milton = createSubject({ name: 'Trevor Milton', company: 'dHybrid Systems' });
    expect(matchSubject(milton, 'Trevor Milton sold dHybrid to Worthington.').level).toBe('confirmed');
    expect(matchSubject(again, 'Posts by @adamneumann mention Adam Neumann.').level).toBe('likely');
  });
});

describe('findings', () => {
  const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });

  test('a finding is graded, cleaned and given a stable id; records that do not name the subject are dropped', () => {
    const f = makeFinding(subject, {
      source: 'doj', sourceLabel: 'US Department of Justice', category: 'regulatory', severity: 'high',
      title: 'Former Nikola CEO Trevor Milton Sentenced', quote: 'Trevor Milton, founder of Nikola, was sentenced. Press office: (212) 555-0199.',
      url: 'https://www.justice.gov/usao-sdny/pr/x', date: '2023-12-18T12:00:00Z',
    });
    expect(f).toMatchObject({ match: 'confirmed', severity: 'high', date: '2023-12-18', category: 'regulatory' });
    expect(f.quote).toMatch(/\[phone removed\]/);
    expect(f.id).toBe(makeFinding(subject, { source: 'doj', category: 'regulatory', title: 'Former Nikola CEO Trevor Milton Sentenced', url: 'https://www.justice.gov/usao-sdny/pr/x' }).id);
    expect(makeFinding(subject, { source: 'doj', category: 'regulatory', title: 'Unrelated press release', url: 'https://www.justice.gov/y' })).toBeNull();
    // a record about the company itself can be kept by stating the match
    expect(makeFinding(subject, { source: 'ransomware-live', category: 'exposure', title: 'Nikola listed on a leak site', url: 'https://www.ransomware.live/x', match: 'company' }).match).toBe('company');
    expect(() => makeFinding(subject, { source: 's', category: 'nope', title: 'Trevor Milton', url: 'https://x.test' })).toThrow(/category/);
    expect(makeFinding(subject, { source: 'wayback', category: 'archive', title: 'Trevor Milton', url: 'https://web.archive.org/x', date: '20190314120000' }).date).toBe('2019-03-14');
  });

  test('threads and connector results are normalised', () => {
    expect(makeThread('company', '  dHybrid   Systems ', 'earlier company')).toEqual({ kind: 'company', value: 'dHybrid Systems', why: 'earlier company' });
    expect(makeThread('planet', 'Mars')).toBeNull();
    expect(makeThread('associate', 'Ramesh Balwani', 'co-defendant', { trusted: true })).toMatchObject({ kind: 'associate', trusted: true });
    expect(connectorResult(null)).toEqual({ findings: [], threads: [], notes: [] });
    expect(connectorResult({ findings: [null, { id: 'a' }], notes: [1] })).toEqual({ findings: [{ id: 'a' }], threads: [], notes: ['1'] });
  });
});

test('words that mark a serious record', () => {
  const { severityFromText } = require('../../../src/server/founder/finding');
  for (const text of ['Grand jury indicts founder', 'Founder found guilty of fraud', 'Founder jailed for fraud', 'Pleads guilty to wire fraud', 'Two convictions upheld']) expect(severityFromText(text)).toBe('high');
  expect(severityFromText('Company sued by landlord')).toBe('medium');
  expect(severityFromText('Founder speaks at a conference')).toBe('info');
});

describe('http helpers', () => {
  test('htmlToText keeps visible text only', () => {
    expect(htmlToText('<html><head><style>p{}</style><script>var a=1</script></head><body><h1>Jane&nbsp;Doe</h1><p>CEO &amp; founder</p><!-- x --></body></html>')).toBe('Jane Doe\nCEO & founder');
  });
  test('mapLimit keeps order and turns failures into null', async () => {
    const out = await mapLimit([1, 2, 3, 4], 2, async (n) => { if (n === 3) throw new Error('x'); return n * 2; });
    expect(out).toEqual([2, 4, null, 8]);
  });
  test('a response larger than the limit is an error, never cut short; a list download raises the limit', async () => {
    const big = JSON.stringify({ names: 'x'.repeat(9 * 1024 * 1024) });
    setTransport(async (url) => ({ status: 200, headers: new Map(), url, text: async () => big }));
    await expect(request('https://lists.example.org/all.json')).rejects.toThrow(/larger than 8 MB/);
    const data = await getJson('https://lists.example.org/all.json', { maxBytes: 20 * 1024 * 1024 });
    expect(data.names.length).toBe(9 * 1024 * 1024);
    setTransport();
  });
  test('a failing source is retried once, then reported with its status', async () => {
    let calls = 0;
    setTransport(async (url) => { calls += 1; return { status: 503, headers: new Map(), url, text: async () => 'down' }; });
    await expect(request('https://flaky.example.org/x', { retries: 1 })).rejects.toMatchObject({ status: 503, retryable: true });
    expect(calls).toBe(2);
    setTransport();
  });
});
