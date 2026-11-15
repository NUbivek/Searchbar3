/**
 * Web archive connector, fixes from grading real reports (round 2):
 *  - item 1: a guessed address is never trusted (every line "possible", no threads), is skipped when the
 *    check already holds the person's address on that site, a copy tied by one anchor that shares lines
 *    with untied copies is a possibly merged profile, and threads are trusted only from copies that name
 *    an anchor themselves, never for a name first listed on an untied copy;
 *  - item 3: fragments, cut names, addresses and short words are not followed as employers; schools
 *    listed as employers become school threads;
 *  - item 13: a profile linked from a tied record is graded at least likely so its history is told; a
 *    bio or tagline that only grew is noted at info, not flagged.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const { archiveConnector, __resetArchiveCacheForTests, usableOrg, linkedSource, describeChange } = require('../../../src/server/founder/sources/archive');

const ctxFor = (subject, extra = {}) => ({ subject, deadline: Date.now() + 25000, known: () => ({}), ...extra });

function network(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    for (const [pattern, reply] of routes) {
      if (!(pattern instanceof RegExp ? pattern.test(url) : url.includes(pattern))) continue;
      const r = typeof reply === 'function' ? reply(url) : reply;
      const custom = r && typeof r.status === 'number';
      const body = custom ? r.body : r;
      return { status: custom ? r.status : 200, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    }
    return { status: 404, headers: new Map(), url, text: async () => 'not archived' };
  });
  return calls;
}

beforeEach(() => __resetArchiveCacheForTests());
afterEach(() => setTransport());

const HEAD = ['timestamp', 'endtimestamp', 'original', 'digest', 'length', 'groupcount'];
const cdx = (...rows) => [HEAD, ...rows];
const row = (ts, original, digest, length = 9000, count = 3) => [ts, ts, original, digest, String(length), String(count)];
const snapRoute = (pages) => [/\/web\/\d{14}id_\//, (url) => {
  const ts = url.match(/\/web\/(\d{14})id_/)[1];
  return pages[ts] ? pages[ts] : { status: 404, body: 'not archived' };
}];

/** A 2019+ LinkedIn public profile: name, headline, roles [title, org], schools, optional summary. */
const li = (name, headline, roles, schools = [], bio = '') => `<html><head><title>${name} | LinkedIn</title></head><body>
<h1 class="top-card-layout__title">${name}</h1><h2 class="top-card-layout__headline">${headline}</h2>
${bio ? `<div id="summary"><p class="description">${bio}</p></div>` : ''}
<ul>${roles.map(([t, o]) => `<li class="experience-item"><h3 class="experience-item__title">${t}</h3><h4 class="experience-item__subtitle">${o}</h4></li>`).join('')}</ul>
<ul>${schools.map((s) => `<li class="education__list-item"><h3 class="profile-section-card__title">${s}</h3></li>`).join('')}</ul></body></html>`;

describe('item 1: guessed addresses', () => {
  test('a guessed address whose copy names the company is still only "possible", told in two lines, and nothing on it is followed', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const addr = 'https://www.crunchbase.com/person/jane-roe';
    network([
      ['url=crunchbase.com%2Fperson%2Fjane-roe', cdx(row('20150101000000', addr, 'A'), row('20200101000000', addr, 'B'))],
      snapRoute({
        20150101000000: li('Jane Roe', 'Founder, Acmeworks', [['Founder', 'Acmeworks'], ['Director', 'Unrelated Media Group']], ['Some University']),
        20200101000000: li('Jane Roe', 'Founder, Acmeworks', [['Founder', 'Acmeworks'], ['Director', 'Unrelated Media Group']], ['Some University']),
      }),
    ]);
    const plan = archiveConnector.plan({ kind: 'subject', value: subject.name }, subject).find((p) => p.template === 'archive.crunchbase');
    const out = await archiveConnector.run({ kind: 'subject', value: subject.name, template: plan.template, params: plan.params, depth: 0 }, ctxFor(subject));
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) {
      expect(f.match).toBe('possible');
      expect(f.matchFixed).toBe(true);
    }
    expect(out.findings.some((f) => f.data.kind === 'change')).toBe(false);
    expect(out.threads).toEqual([]);
  });

  test('a guess on a site where a tied record already gave their address is not read', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const calls = network([['/cdx/search/cdx', cdx()]]);
    const plan = archiveConnector.plan({ kind: 'subject', value: subject.name }, subject).find((p) => p.template === 'archive.crunchbase');
    const ctx = ctxFor(subject, { knownUrls: () => ['https://www.crunchbase.com/person/jane-roe-2'] });
    const out = await archiveConnector.run({ kind: 'subject', value: subject.name, template: plan.template, params: plan.params, depth: 0 }, ctx);
    expect(calls).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.threads).toEqual([]);
  });
});

describe('item 1: copies of one page that may mix two people', () => {
  const addr = 'https://www.linkedin.com/in/janeroe';
  const pages = (newer) => ({
    20150101000000: li('Jane Roe', 'Director, Unrelated Media Group', [['Director', 'Unrelated Media Group']], [], ''),
    20200101000000: newer,
  });

  test('a copy tied by one anchor that shares a line with an untied copy: both held at possible, nothing trusted', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    network([
      ['/cdx/search/cdx', cdx(row('20150101000000', addr, 'A'), row('20200101000000', addr, 'B'))],
      snapRoute(pages(li('Jane Roe', 'Founder, Acmeworks', [['Founder', 'Acmeworks'], ['Director', 'Unrelated Media Group']]))),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, depth: 1 }, ctxFor(subject));
    for (const f of out.findings) expect(f.match).toBe('possible');
    expect(out.threads.filter((t) => t.trusted)).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/may mix two people/);
  });

  test('a copy tied by two anchors spreads its tie, but a name first listed on the untied copy is not trusted', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    addAnchor(subject, 'schools', 'Stanford University');
    network([
      ['/cdx/search/cdx', cdx(row('20150101000000', addr, 'A'), row('20200101000000', addr, 'B'))],
      snapRoute(pages(li('Jane Roe', 'Founder, Acmeworks', [['Founder', 'Acmeworks'], ['Director', 'Unrelated Media Group']], ['Stanford University']))),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, depth: 1 }, ctxFor(subject));
    expect(out.findings.find((f) => / as of 2015-01-01/.test(f.title)).match).toBe('confirmed');
    expect(out.findings.find((f) => / as of 2020-01-01/.test(f.title)).match).toBe('confirmed');
    expect(out.threads.find((t) => t.value === 'Acmeworks')).toMatchObject({ trusted: true });
    expect(out.threads.find((t) => t.value === 'Unrelated Media Group')).toMatchObject({ trusted: false });
  });

  test('a copy tied by one anchor that shares nothing with the untied copy keeps its grade and its threads', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    network([
      ['/cdx/search/cdx', cdx(row('20150101000000', addr, 'A'), row('20200101000000', addr, 'B'))],
      snapRoute(pages(li('Jane Roe', 'Founder, Acmeworks', [['Founder', 'Acmeworks'], ['Analyst', 'Bigbank Partners']]))),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, depth: 1 }, ctxFor(subject));
    expect(out.findings.find((f) => / as of 2020-01-01/.test(f.title)).match).toBe('confirmed');
    expect(out.findings.find((f) => / as of 2015-01-01/.test(f.title)).match).toBe('possible');
    expect(out.threads.find((t) => t.value === 'Bigbank Partners')).toMatchObject({ trusted: true });
    expect(out.threads.find((t) => t.value === 'Unrelated Media Group')).toMatchObject({ trusted: false });
  });
});

describe('item 3: what is followed as an employer', () => {
  test('usableOrg rejects fragments, cut names, addresses and short words', () => {
    expect(usableOrg('Lyc', ['Lycée Hoche'])).toBe(false);
    expect(usableOrg('Lycée H', [])).toBe(false);
    expect(usableOrg('https://unlockd.com', [])).toBe(false);
    expect(usableOrg('www.example.io', [])).toBe(false);
    expect(usableOrg('acme.com', [])).toBe(false);
    expect(usableOrg('We', [])).toBe(false);
    expect(usableOrg('NTT', [])).toBe(false);
    expect(usableOrg('Opt', [], ['Opt'])).toBe(false);
    expect(usableOrg('NTT', [], ['NTT'])).toBe(true);
    expect(usableOrg('Acmeworks', ['Acmeworks Labs'])).toBe(false);
    expect(usableOrg('Acmeworks Labs', ['Acmeworks'])).toBe(true);
    expect(usableOrg('Series A Capital', [])).toBe(true);
  });

  test('on a tied copy: fragments are dropped and a school listed as an employer becomes a school thread', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const addr = 'https://www.linkedin.com/in/janeroe';
    network([
      ['/cdx/search/cdx', cdx(row('20200101000000', addr, 'B'))],
      snapRoute({ 20200101000000: li('Jane Roe', 'Founder, Acmeworks', [['Founder', 'Acmeworks'], ['Student', 'Lycée Hoche'], ['Intern', 'Lyc'], ['Advisor', 'École H'], ['Partner', 'We'], ['Board', 'www.example.io']]) }),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, depth: 1 }, ctxFor(subject));
    const values = out.threads.map((t) => `${t.kind}:${t.value}`);
    expect(values).toContain('company:Acmeworks');
    expect(values).toContain('school:Lycée Hoche');
    expect(values.some((v) => /:Lyc$|École H|:We$|example\.io/.test(v))).toBe(false);
    expect(values).not.toContain('company:Lycée Hoche');
  });
});

describe('item 13: linked profiles and changes that only add', () => {
  test('linkedSource reads where a profile address came from', () => {
    expect(linkedSource('linked from their Crunchbase profile', 'twitter.com/janeroe')).toBe('their Crunchbase profile');
    expect(linkedSource('linkedin profile listed on Wikidata', 'linkedin.com/in/janeroe')).toBe('Wikidata');
    expect(linkedSource('their LinkedIn profile, found in the web archive', 'linkedin.com/pub/jane-roe/1/2/3')).toBeNull();
    expect(linkedSource('linked from their Crunchbase profile', 'example.com/about')).toBeNull();
    expect(linkedSource('', 'linkedin.com/in/janeroe')).toBeNull();
  });

  test('a profile linked from a tied record: name-only copies are "likely" and their history is diffed', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const addr = 'https://www.linkedin.com/in/janeroe';
    network([
      ['/cdx/search/cdx', cdx(row('20180101000000', addr, 'A'), row('20210101000000', addr, 'B'))],
      snapRoute({
        20180101000000: li('Jane Roe', 'Chief Executive Officer', []),
        20210101000000: li('Jane Roe', 'Investor and advisor', []),
      }),
    ]);
    const plan = archiveConnector.plan({ kind: 'url', value: addr, why: 'linked from their Crunchbase profile' }, subject)[0];
    expect(plan.params.linkedFrom).toBe('their Crunchbase profile');
    const out = await archiveConnector.run({ kind: 'url', value: addr, template: plan.template, params: plan.params, depth: 2 }, ctxFor(subject));
    const versions = out.findings.filter((f) => / as of /.test(f.title));
    expect(versions).toHaveLength(2);
    for (const f of versions) expect(f).toMatchObject({ match: 'likely', matchReasons: ['profile linked from their Crunchbase profile'] });
    const change = out.findings.find((f) => f.data.kind === 'change');
    expect(change).toBeTruthy();
    expect(change.match).toBe('likely');
    expect(out.threads.filter((t) => t.trusted)).toEqual([]);
  });

  test('the same page without a linking record stays possible', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const addr = 'https://www.linkedin.com/in/janeroe';
    network([
      ['/cdx/search/cdx', cdx(row('20180101000000', addr, 'A'), row('20210101000000', addr, 'B'))],
      snapRoute({ 20180101000000: li('Jane Roe', 'Chief Executive Officer', []), 20210101000000: li('Jane Roe', 'Investor and advisor', []) }),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, depth: 2 }, ctxFor(subject));
    for (const f of out.findings) expect(f.match).toBe('possible');
  });

  test('a linked profile does not lift a copy that lists employers the tied copies do not', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const addr = 'https://www.linkedin.com/in/janeroe';
    network([
      ['/cdx/search/cdx', cdx(row('20150101000000', addr, 'A'), row('20200101000000', addr, 'B'))],
      snapRoute({
        20150101000000: li('Jane Roe', 'Veterinary nurse', [['Nurse', 'Pawsome Clinic']]),
        20200101000000: li('Jane Roe', 'Founder, Acmeworks', [['Founder', 'Acmeworks']]),
      }),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, params: { pages: [addr], linkedFrom: 'their Crunchbase profile' }, depth: 2 }, ctxFor(subject));
    expect(out.findings.find((f) => / as of 2015-01-01/.test(f.title)).match).toBe('possible');
    expect(out.findings.find((f) => / as of 2020-01-01/.test(f.title)).match).toBe('confirmed');
    expect(out.findings.some((f) => f.data.kind === 'change')).toBe(false);
  });

  test('a bio that only grew is "bio expanded" at info; a tagline that only grew is info', async () => {
    expect(describeChange({ field: 'bio', change: 'changed', expanded: true })).toBe('bio expanded');
    expect(describeChange({ field: 'bio', change: 'changed' })).toBe('bio rewritten');
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const addr = 'https://www.linkedin.com/in/janeroe';
    const shortBio = 'Builder of tools for small labs.';
    const longBio = 'Builder of tools for small labs. Previously ran product teams across three continents, advised early stage founders on hiring, mentored engineers, and wrote about measurement science for trade magazines.';
    network([
      ['/cdx/search/cdx', cdx(row('20180101000000', addr, 'A'), row('20210101000000', addr, 'B'))],
      snapRoute({
        20180101000000: li('Jane Roe', 'Founder', [['Founder', 'Acmeworks']], [], shortBio),
        20210101000000: li('Jane Roe', 'Founder and Chairman', [['Founder', 'Acmeworks']], [], longBio),
      }),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, depth: 1 }, ctxFor(subject));
    const changes = out.findings.filter((f) => f.data.kind === 'change');
    const bio = changes.find((f) => f.data.field === 'bio');
    expect(bio).toBeTruthy();
    expect(bio.title).toMatch(/bio expanded/);
    expect(bio.severity).toBe('info');
    const headline = changes.find((f) => f.data.field === 'headline');
    expect(headline).toBeTruthy();
    expect(headline.severity).toBe('info');
  });
});
