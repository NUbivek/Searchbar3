/**
 * Web archive connector: planning, reading several saved copies of one page,
 * the findings (snapshot, version and change shapes), identity grading,
 * threads and their `trusted` flag, privacy, request counts and the failure
 * paths. No network: the archive is faked with small fixtures cut from real
 * captures.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const {
  archiveConnector, pageOf, pickCaptures, nameIs, teamPageScore, __resetArchiveCacheForTests,
} = require('../../../src/server/founder/sources/archive');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 25000, known: () => ({}) });

/** Fake network: the first route whose pattern is in the URL answers. A reply { status, body } sets the status. */
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
    return { status: 404, headers: new Map(), url, text: async () => 'Wayback Machine has not archived that URL.' };
  });
  return calls;
}

beforeEach(() => __resetArchiveCacheForTests());
afterEach(() => setTransport());

/* ------------------------------------------------------------- fixtures */

const HEAD = ['timestamp', 'endtimestamp', 'original', 'digest', 'length', 'groupcount'];
const cdx = (...rows) => [HEAD, ...rows];
const row = (ts, original, digest, length = 9000, count = 3) => [ts, ts, original, digest, String(length), String(count)];

const cbOld = (title, school) => `<html><body><div id="col2_internal"><h1 class="h1_first">Elizabeth Holmes</h1>
<p>Elizabeth Holmes founded Theranos in 2003. Reach her at 650-555-0100 or eh.home@example.com.</p></div>
<div class="col1_content"><span class="col1_people_name">Theranos</span><span class="col1_people_title">${title}</span></div>
${school ? `<h2>Degrees</h2><div class="col1_content"><table><tr><td>${school.degree}</td><td>${school.name}</td></tr></table></div>` : ''}
</body></html>`;

const CB_ROWS = cdx(
  row('20101009020849', 'http://www.crunchbase.com:80/person/elizabeth-holmes', 'AAA'),
  row('20130512000000', 'http://www.crunchbase.com/person/elizabeth-holmes', 'BBB'),
  row('20170820012800', 'https://www.crunchbase.com/person/elizabeth-holmes', 'CCC'),
);
const CB_PAGES = {
  20101009020849: cbOld('Founder, CEO', { degree: 'Chemical Engineering', name: 'Stanford University' }),
  20130512000000: cbOld('Founder, CEO', { degree: 'Chemical Engineering', name: 'Stanford University' }),
  20170820012800: cbOld('Founder, CEO', { degree: 'Executive Program', name: 'Stanford University' }),
};
const snapRoute = (pages) => [/\/web\/\d{14}id_\//, (url) => {
  const ts = url.match(/\/web\/(\d{14})id_/)[1];
  return pages[ts] ? pages[ts] : { status: 404, body: 'not archived' };
}];

const LI_NAMESAKE = `<html><head><title>Elizabeth Holmes | LinkedIn</title></head><body>
<h1 class="top-card-layout__title">Elizabeth Holmes</h1><h2 class="top-card-layout__headline">Veterinary nurse at PawsLikeMe</h2>
<ul><li class="experience-item"><h3 class="experience-item__title">Veterinary nurse</h3><h4 class="experience-item__subtitle">PawsLikeMe</h4></li></ul></body></html>`;
const LI_OTHER = `<html><head><title>Jane Roe | LinkedIn</title></head><body>
<h1 class="top-card-layout__title">Jane Roe</h1><h2 class="top-card-layout__headline">CEO at Theranos</h2>
<ul><li class="experience-item"><h3 class="experience-item__title">CEO</h3><h4 class="experience-item__subtitle">Theranos</h4></li></ul></body></html>`;
const LI_WALL = '<html><head><title>Sign Up | LinkedIn</title></head><body><form action="/authwall"><h1>Join LinkedIn</h1></form></body></html>';

/* ------------------------------------------------------------- planning */

describe('plan', () => {
  const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });

  test('subject: one lookup per page family, guessed from the name', () => {
    const plans = archiveConnector.plan({ kind: 'subject', value: subject.name }, subject);
    const t = plans.map((p) => p.template);
    expect(t).toEqual(expect.arrayContaining(['archive.crunchbase', 'archive.linkedin', 'archive.angel', 'archive.linkedin-pub', 'archive.aboutme', 'archive.indeed']));
    expect(plans.find((p) => p.template === 'archive.linkedin').params.pages).toEqual(['linkedin.com/in/elizabethholmes', 'linkedin.com/in/elizabeth-holmes']);
    expect(plans.find((p) => p.template === 'archive.linkedin-pub').params.prefix).toBe('linkedin.com/pub/elizabeth-holmes/');
  });

  test('url, handle and domain threads', () => {
    expect(archiveConnector.plan({ kind: 'url', value: 'https://www.linkedin.com/in/eholmes/?trk=x' }, subject)).toEqual([expect.objectContaining({ template: 'archive.linkedin', params: { pages: ['linkedin.com/in/eholmes'] } })]);
    expect(archiveConnector.plan({ kind: 'url', value: 'https://theranos.com/about/eah.shtml' }, subject)[0]).toMatchObject({ template: 'archive.page', params: { pages: ['theranos.com/about/eah.shtml'] } });
    expect(archiveConnector.plan({ kind: 'url', value: 'https://www.facebook.com/someone' }, subject)).toEqual([]);
    expect(archiveConnector.plan({ kind: 'handle', value: '@eholmes2003', why: 'Twitter handle' }, subject).map((p) => p.template)).toEqual(['archive.twitter']);
    expect(archiveConnector.plan({ kind: 'handle', value: 'eholmes' }, subject).map((p) => p.template)).toEqual(['archive.github', 'archive.twitter']);
    expect(archiveConnector.plan({ kind: 'domain', value: 'https://www.theranos.com/' }, subject)).toEqual([expect.objectContaining({ template: 'archive.team-page', params: { domain: 'theranos.com' } })]);
    expect(archiveConnector.plan({ kind: 'domain', value: 'linkedin.com' }, subject)).toEqual([]);
    expect(archiveConnector.plan({ kind: 'company', value: 'Theranos' }, subject)).toEqual([]);
  });

  test('pageOf normalises addresses the way the archive indexes them', () => {
    expect(pageOf('https://web.archive.org/web/2015id_/http://www.linkedin.com/pub/adam-neumann/7/2a/111?trk=pub')).toBe('linkedin.com/pub/adam-neumann/7/2a/111');
    expect(pageOf('https://x.com/patrickc')).toBe('twitter.com/patrickc');
    expect(pageOf('https://x.com/patrickc/status/1')).toBeNull();
    expect(pageOf('https://github.com/pc/repo')).toBeNull();
    expect(pageOf('https://www.crunchbase.com/person/elizabeth-holmes/timeline')).toBe('crunchbase.com/person/elizabeth-holmes');
  });
});

/* ------------------------------------------------------------- a page read over time */

describe('url: reading copies of one page', () => {
  test('snapshot, versions and a changed degree, with the change contract; at most 6 requests', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const calls = network([['/cdx/search/cdx', CB_ROWS], snapRoute(CB_PAGES)]);
    const task = { kind: 'url', value: 'https://www.crunchbase.com/person/elizabeth-holmes', template: 'archive.crunchbase', params: null, depth: 1 };
    const out = await archiveConnector.run(task, ctxFor(subject));
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls[0]).toContain('url=crunchbase.com%2Fperson%2Felizabeth-holmes');
    expect(calls[0]).toContain('filter=statuscode:200');
    expect(calls.slice(1).every((u) => /\/web\/\d{14}id_\/https?:\/\/www\.crunchbase\.com\/person/.test(u))).toBe(true);
    expect(calls.some((u) => u.includes(':80/'))).toBe(false);

    for (const f of out.findings) expect(f.category).toBe('archive');
    const page = out.findings.find((f) => /archived \d+ times/.test(f.title));
    // R3: one record per page: the latest version carries the capture counts (the separate summary record is folded in)
    expect(page.title).toBe('Crunchbase profile as of 2017-08-20: Founder, CEO, Theranos (archived 9 times between 2010-10 and 2017-08)');
    expect(page.data).toEqual({
      kind: 'snapshot', page: 'https://www.crunchbase.com/person/elizabeth-holmes', capturedAt: '2017-08-20', first: '2010-10-09', last: '2017-08-20', captures: 9, replay: 'https://web.archive.org/web/20170820012800/https://www.crunchbase.com/person/elizabeth-holmes',
      // R3: the version's own fields, for the profile to read as a record
      claims: { format: 'crunchbase', roles: [{ title: 'Founder, CEO', org: 'Theranos', dates: '' }], education: [{ school: 'Stanford University', degree: 'Executive Program', dates: '' }] },
    });
    expect(page.match).toBe('confirmed');

    // the 2010 version lists a degree the latest does not: it stays a record of its own
    const versions = out.findings.filter((f) => / as of /.test(f.title));
    expect(versions.map((f) => f.title)).toEqual([
      'Crunchbase profile as of 2017-08-20: Founder, CEO, Theranos (archived 9 times between 2010-10 and 2017-08)',
      'Crunchbase profile as of 2010-10-09: Founder, CEO, Theranos',
    ]);
    expect(versions[1].url).toBe('https://web.archive.org/web/20101009020849/http://www.crunchbase.com/person/elizabeth-holmes');
    expect(versions[1].data).toMatchObject({ kind: 'snapshot', page: 'https://www.crunchbase.com/person/elizabeth-holmes', capturedAt: '2010-10-09' });
    expect(versions[1].data.claims.education[0]).toMatchObject({ school: 'Stanford University' });
    expect(versions[1].quote).toContain('Chemical Engineering, Stanford University');

    const change = out.findings.find((f) => f.data.kind === 'change');
    expect(change.title).toBe('Crunchbase profile: degree changed from "Chemical Engineering, Stanford University" to "Executive Program, Stanford University" between 2013-05 and 2017-08');
    expect(change.quote).toBe('Before (2013-05-12): "Chemical Engineering, Stanford University" After (2017-08-20): "Executive Program, Stanford University"');
    expect(change.severity).toBe('medium');
    expect(change.match).toBe('confirmed');
    expect(change.url).toBe('https://web.archive.org/web/20170820012800/https://www.crunchbase.com/person/elizabeth-holmes');
    expect(change.date).toMatch(/^2017-08-20/);
    expect(change.data).toEqual({
      kind: 'change', page: 'https://www.crunchbase.com/person/elizabeth-holmes', field: 'education', change: 'changed',
      before: 'Chemical Engineering, Stanford University', after: 'Executive Program, Stanford University',
      fromDate: '2013-05-12', toDate: '2017-08-20',
      fromUrl: 'https://web.archive.org/web/20130512000000/http://www.crunchbase.com/person/elizabeth-holmes',
      toUrl: 'https://web.archive.org/web/20170820012800/https://www.crunchbase.com/person/elizabeth-holmes',
    });

    // threads: trusted employers and schools
    expect(out.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'school', value: 'Stanford University', trusted: true }),
    ]));
    expect(out.threads.find((t) => t.kind === 'company')).toMatchObject({ value: 'Theranos', trusted: true });
  });

  test('privacy: phone numbers and e-mail addresses on the page are never copied', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    network([['/cdx/search/cdx', CB_ROWS], snapRoute(CB_PAGES)]);
    const out = await archiveConnector.run({ kind: 'url', value: 'crunchbase.com/person/elizabeth-holmes', depth: 1 }, ctxFor(subject));
    const all = JSON.stringify(out);
    expect(all).not.toMatch(/650-555-0100|eh\.home@example\.com/);
  });

  test('a name-only page stays possible and its threads are not trusted', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    network([
      ['/cdx/search/cdx', cdx(row('20230101000000', 'https://www.linkedin.com/in/elizabeth-holmes/', 'X1'))],
      snapRoute({ 20230101000000: LI_NAMESAKE }),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: 'https://www.linkedin.com/in/elizabeth-holmes/', depth: 1 }, ctxFor(subject));
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) expect(f.match).toBe('possible');
    expect(out.threads.find((t) => t.value === 'PawsLikeMe')).toMatchObject({ trusted: false });
    expect(out.findings[0].title).toBe('LinkedIn profile as of 2023-01-01: Veterinary nurse at PawsLikeMe (archived 3 times in 2023-01)');
  });

  test('subject guesses: a namesake gets two possible lines and no history, and the other spelling is still tried', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const namesakeRows = cdx(row('20200101000000', 'https://www.linkedin.com/in/elizabethholmes', 'N1'), row('20230101000000', 'https://www.linkedin.com/in/elizabethholmes', 'N2'));
    const calls = network([
      ['url=linkedin.com%2Fin%2Felizabethholmes', namesakeRows],
      ['url=linkedin.com%2Fin%2Felizabeth-holmes', []],
      snapRoute({ 20200101000000: LI_NAMESAKE.replace('Veterinary nurse at PawsLikeMe', 'Nurse'), 20230101000000: LI_NAMESAKE }),
    ]);
    const plan = archiveConnector.plan({ kind: 'subject', value: subject.name }, subject).find((p) => p.template === 'archive.linkedin');
    const out = await archiveConnector.run({ kind: 'subject', value: subject.name, template: plan.template, params: plan.params, depth: 0 }, ctxFor(subject));
    // R3: one line (the page's summary is folded into its latest version)
    expect(out.findings).toHaveLength(1);
    for (const f of out.findings) expect(f.match).toBe('possible');
    expect(out.findings.some((f) => f.data.kind === 'change')).toBe(false);
    expect(calls.some((u) => u.includes('elizabeth-holmes'))).toBe(true);
    expect(out.threads.every((t) => t.trusted === false)).toBe(true);
  });

  test('a 2010 page that spells the employer in lower case ("we work") is still tied to the known company', async () => {
    const subject = createSubject({ name: 'Adam Neumann', company: 'WeWork' });
    const li2010 = `<html><body><div class="hresume"><h1 id="name"><span class="fn">adam neumann</span></h1><div id="headline"><p class="title">Founder, we work</p></div>
<div id="experience"><ul><li class="experience"><h3 class="title">Founder</h3><h4 class="org">we work</h4><p class="period">February 2010 — Present</p></li></ul></div></div></body></html>`;
    network([['/cdx/search/cdx', cdx(row('20101013183708', 'http://www.linkedin.com/pub/adam-neumann/21/205/204', 'L1', 9000, 1))], snapRoute({ 20101013183708: li2010 })]);
    const out = await archiveConnector.run({ kind: 'url', value: 'https://linkedin.com/pub/adam-neumann/21/205/204', depth: 1 }, ctxFor(subject));
    expect(out.findings[0]).toMatchObject({ title: 'LinkedIn profile as of 2010-10-13: Founder, we work (archived once, on 2010-10-13)', match: 'confirmed' });
    expect(out.threads.find((t) => t.value === 'we work')).toMatchObject({ trusted: true });
  });

  test('a page that is someone else\'s is dropped', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    network([['/cdx/search/cdx', cdx(row('20230101000000', 'https://www.linkedin.com/in/jane-roe/', 'X1'))], snapRoute({ 20230101000000: LI_OTHER })]);
    const out = await archiveConnector.run({ kind: 'url', value: 'linkedin.com/in/jane-roe', depth: 1 }, ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.threads).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/do not name Elizabeth Holmes/);
  });

  test('a sign-in wall copy is passed over for the nearest other month and noted', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const rows = cdx(
      row('20200101000000', 'https://www.linkedin.com/in/x', 'A'), row('20200601000000', 'https://www.linkedin.com/in/x', 'B'),
      row('20210101000000', 'https://www.linkedin.com/in/x', 'C'), row('20220101000000', 'https://www.linkedin.com/in/x', 'D'),
      row('20230101000000', 'https://www.linkedin.com/in/x', 'E'),
    );
    const calls = network([['/cdx/search/cdx', rows], snapRoute({
      20200101000000: LI_WALL, 20200601000000: LI_OTHER.replace(/Jane Roe/g, 'Elizabeth Holmes'), 20210101000000: LI_WALL, 20220101000000: LI_WALL, 20230101000000: LI_WALL,
    })]);
    const out = await archiveConnector.run({ kind: 'url', value: 'linkedin.com/in/x', depth: 1 }, ctxFor(subject));
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(out.notes.join(' ')).toMatch(/sign-in wall/);
    expect(out.findings.find((f) => / as of 2020-06-01/.test(f.title))).toMatchObject({ match: 'confirmed' });
  });

  test('a page the archive never saved returns nothing, with a note', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    network([['/cdx/search/cdx', []]]);
    const out = await archiveConnector.run({ kind: 'url', value: 'about.me/elizabethholmes', depth: 1 }, ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/no readable copy/);
  });

  test('failure: the archive is down -> run rejects', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    network([['/cdx/search/cdx', { status: 500, body: 'error' }]]);
    await expect(archiveConnector.run({ kind: 'url', value: 'crunchbase.com/person/elizabeth-holmes', depth: 1 }, ctxFor(subject))).rejects.toThrow(/HTTP 500/);
  });

  test('failure: the listing is not JSON -> run rejects', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    network([['/cdx/search/cdx', '<html>Temporarily Offline</html>']]);
    await expect(archiveConnector.run({ kind: 'url', value: 'crunchbase.com/person/elizabeth-holmes', depth: 1 }, ctxFor(subject))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------- name-shaped prefixes */

describe('subject: listing everything saved under a name', () => {
  test('old LinkedIn /pub/ addresses: the person\'s own page is confirmed and becomes a trusted url thread; namesakes stay possible', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const head = ['original', 'mimetype', 'timestamp', 'endtimestamp', 'groupcount', 'uniqcount'];
    const listing = [head,
      ['http://www.linkedin.com/pub/elizabeth-holmes/1/2/3', 'text/html', '20120101000000', '20150101000000', '12', '4'],
      ['http://www.linkedin.com/pub/elizabeth-holmes/9/8/7', 'text/html', '20130101000000', '20140101000000', '3', '2'],
      ['http://www.linkedin.com/pub/dir/elizabeth/holmes', 'text/html', '20130101000000', '20140101000000', '30', '2'],
    ];
    const own = LI_OTHER.replace(/Jane Roe/g, 'Elizabeth Holmes');
    const calls = network([['/web/timemap/json', listing], snapRoute({ 20150101000000: own, 20140101000000: LI_NAMESAKE })]);
    const plan = archiveConnector.plan({ kind: 'subject', value: subject.name }, subject).find((p) => p.template === 'archive.linkedin-pub');
    const out = await archiveConnector.run({ kind: 'subject', value: subject.name, template: plan.template, params: plan.params, depth: 0 }, ctxFor(subject));
    expect(calls[0]).toContain('matchType=prefix');
    expect(calls.length).toBeLessThanOrEqual(6);
    const confirmed = out.findings.filter((f) => f.match === 'confirmed');
    expect(confirmed.length).toBeGreaterThan(0);
    expect(confirmed[0].data.page).toBe('http://www.linkedin.com/pub/elizabeth-holmes/1/2/3');
    expect(out.threads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'url', value: 'https://linkedin.com/pub/elizabeth-holmes/1/2/3', trusted: true })]));
    const namesake = out.findings.filter((f) => /PawsLikeMe/.test(f.title));
    for (const f of namesake) expect(f.match).toBe('possible');
    expect(out.findings.some((f) => /archived \d+ times/.test(f.title) && /9\/8\/7/.test(f.data.page))).toBe(false); // a namesake gets no page summary
  });
});

/* ------------------------------------------------------------- company team pages */

const teamPage = (people) => `<html><head><title>Leadership</title></head><body><h2>Leadership</h2>${people.map(([n, t]) => `<p>${n}</p><p>${t}</p><p>${n.split(' ')[0]} has led teams in laboratory science and software for many years at several companies.</p>`).join('')}</body></html>`;

describe('domain: team pages over time', () => {
  test('first and last appearance, a retitled line, and a later copy without the person', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const head = ['original', 'mimetype', 'timestamp', 'endtimestamp', 'groupcount', 'uniqcount'];
    const listing = [head,
      ['http://www.theranos.com:80/leadership', 'text/html', '20100101000000', '20180901000000', '40', '6'],
      ['http://www.theranos.com/careers/team', 'text/html', '20120101000000', '20140101000000', '4', '1'],
    ];
    const calls = network([['/web/timemap/json', listing], snapRoute({
      20100101000000: teamPage([['Elizabeth Holmes', 'Advisor'], ['Sunny Balwani', 'President and COO']]),
      20140502000000: teamPage([['Elizabeth Holmes', 'Founder and CEO'], ['Sunny Balwani', 'President and COO']]),
      20180901000000: teamPage([['David Taylor', 'Chief Executive Officer'], ['Sunny Balwani', 'Board director'], ['Jane Roe', 'Chief Financial Officer']]),
    })]);
    // the middle copy is asked for by its date and redirected to the nearest one
    setTransport(async (url) => {
      calls.push(url);
      if (url.includes('/web/timemap/json')) return { status: 200, headers: new Map(), url, text: async () => JSON.stringify(listing) };
      const ts = url.match(/\/web\/(\d{14})id_/)[1];
      const real = ts.startsWith('2014') ? '20140502000000' : ts;
      const pages = {
        20100101000000: teamPage([['Elizabeth Holmes', 'Advisor'], ['Sunny Balwani', 'President and COO']]),
        20140502000000: teamPage([['Elizabeth Holmes', 'Founder and CEO'], ['Sunny Balwani', 'President and COO']]),
        20180901000000: teamPage([['David Taylor', 'Chief Executive Officer'], ['Sunny Balwani', 'Board director'], ['Jane Roe', 'Chief Financial Officer']]),
      };
      return pages[real]
        ? { status: 200, headers: new Map(), url: url.replace(ts, real), text: async () => pages[real] }
        : { status: 404, headers: new Map(), url, text: async () => '' };
    });
    const out = await archiveConnector.run({ kind: 'domain', value: 'theranos.com', depth: 1 }, ctxFor(subject));
    expect(calls[0]).toContain('matchType=domain');
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls.some((u) => /careers/.test(u) && /id_/.test(u))).toBe(false);
    const named = out.findings.find((f) => /named on theranos\.com team pages/.test(f.title));
    expect(named.title).toBe('Elizabeth Holmes named on theranos.com team pages in saved copies from 2010-01 to 2014-05');
    expect(named.match).toBe('confirmed');
    const retitled = out.findings.find((f) => f.data.kind === 'change' && f.data.field === 'headline');
    expect(retitled).toMatchObject({ severity: 'medium' });
    expect(retitled.data).toMatchObject({ before: 'Advisor', after: 'Founder and CEO', fromDate: '2010-01-01', toDate: '2014-05-02' });
    const gone = out.findings.find((f) => /no longer listed/.test(f.title));
    expect(gone.data).toMatchObject({ kind: 'change', change: 'removed', fromDate: '2014-05-02', toDate: '2018-09-01' });
  });

  test('when the whole-site listing times out, the usual team addresses are listed one by one', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const calls = network([
      ['/web/timemap/json', { status: 503, body: '<title>Internet Archive: Temporarily Offline</title>' }],
      ['url=theranos.com%2Fleadership', []],
      ['url=theranos.com%2Fteam', cdx(row('20120101000000', 'http://www.theranos.com/team', 'T1'))],
      snapRoute({ 20120101000000: teamPage([['Elizabeth Holmes', 'Founder and CEO'], ['Sunny Balwani', 'President']]) }),
    ]);
    const out = await archiveConnector.run({ kind: 'domain', value: 'theranos.com', depth: 1 }, ctxFor(subject));
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(out.notes.join(' ')).toMatch(/usual team page addresses/);
    expect(out.findings[0].title).toBe('Elizabeth Holmes named on a theranos.com team page saved on 2012-01-01');
  });

  test('team page scoring', () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    expect(teamPageScore('http://theranos.com/leadership', subject)).toBe(5);
    expect(teamPageScore('http://theranos.com/about/holmes.html', subject)).toBeGreaterThan(5);
    expect(teamPageScore('http://theranos.com/careers/team', subject)).toBe(0);
    expect(teamPageScore('http://theranos.com/style.css', subject)).toBe(0);
  });
});

/* ------------------------------------------------------------- helpers */

describe('helpers', () => {
  test('nameIs ignores case and middle initials, not different people', () => {
    const subject = createSubject({ name: 'Adam Neumann', company: 'WeWork' });
    expect(nameIs(subject, 'adam neumann')).toBe(true);
    expect(nameIs(subject, 'Adam J. Neumann, MBA')).toBe(true);
    expect(nameIs(subject, 'Adam Smith')).toBe(false);
  });

  test('pickCaptures: earliest, latest and the copies where the page changed', () => {
    const rows = [];
    for (let y = 2010; y <= 2021; y += 1) rows.push({ ts: `${y}0101000000`, length: y < 2015 ? 5000 : 12000, digest: `d${y}` });
    const picks = pickCaptures(rows, 4).map((r) => r.ts.slice(0, 4));
    expect(picks[0]).toBe('2010');
    expect(picks[picks.length - 1]).toBe('2021');
    expect(picks).toContain('2015');
    expect(picks).toHaveLength(4);
  });
});
