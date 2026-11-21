/**
 * Web archive connector, review fixes:
 *  - each saved copy of a page is graded on its own text, so a namesake's copy
 *    of the same address neither borrows the founder's tie nor is diffed
 *    against the founder's copy, and its employers and schools are not trusted;
 *  - team-page changes are read within one address, never across two pages;
 *  - a guessed spelling with many copies leaves room to list the next spelling.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { archiveConnector, __resetArchiveCacheForTests } = require('../../../src/server/founder/sources/archive');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 25000, known: () => ({}) });

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

/** A 2019+ LinkedIn public profile: name, headline, roles [title, org], schools. */
const li = (name, headline, roles, schools = []) => `<html><head><title>${name} | LinkedIn</title></head><body>
<h1 class="top-card-layout__title">${name}</h1><h2 class="top-card-layout__headline">${headline}</h2>
<ul>${roles.map(([t, o]) => `<li class="experience-item"><h3 class="experience-item__title">${t}</h3><h4 class="experience-item__subtitle">${o}</h4></li>`).join('')}</ul>
<ul>${schools.map((s) => `<li class="education__list-item"><h3 class="profile-section-card__title">${s}</h3></li>`).join('')}</ul></body></html>`;

describe('one page, copies of two different people', () => {
  test('a namesake\'s older copy is not diffed against the founder\'s copy and its ties are not trusted', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const addr = 'https://www.linkedin.com/in/elizabethholmes';
    network([
      ['/cdx/search/cdx', cdx(row('20150101000000', addr, 'A'), row('20200101000000', addr, 'B'))],
      snapRoute({
        20150101000000: li('Elizabeth Holmes', 'CEO and Co-Founder, PawsLikeMe Inc.', [['CEO and Co-Founder', 'PawsLikeMe Inc.'], ['Director Product Management', 'Reed Elsevier']], ['Concordia University']),
        20200101000000: li('Elizabeth Holmes', 'Founder and CEO, Theranos', [['Founder and CEO', 'Theranos']], ['Stanford University']),
      }),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, depth: 1 }, ctxFor(subject));
    const changes = out.findings.filter((f) => f.data.kind === 'change');
    expect(changes.some((f) => /Reed Elsevier|PawsLikeMe|Concordia/.test(`${f.title} ${f.quote}`))).toBe(false);
    for (const t of out.threads.filter((x) => /Reed Elsevier|PawsLikeMe|Concordia/.test(x.value))) expect(t.trusted).toBe(false);
    expect(out.threads.find((t) => t.value === 'Theranos')).toMatchObject({ trusted: true });
    const founder = out.findings.find((f) => / as of 2020-01-01/.test(f.title));
    expect(founder.match).toBe('confirmed');
    const namesake = out.findings.find((f) => / as of 2015-01-01/.test(f.title));
    expect(namesake.match).toBe('possible');
    expect(out.notes.join(' ')).toMatch(/may be someone else's/);
  });

  test('a "Plumber, Dublin" copy and a Stripe copy: no confirmed change between them', async () => {
    const subject = createSubject({ name: 'Patrick Collison', company: 'Stripe' });
    const addr = 'https://www.linkedin.com/in/patrickcollison';
    network([
      ['/cdx/search/cdx', cdx(row('20140101000000', addr, 'A'), row('20200101000000', addr, 'B'))],
      snapRoute({
        20140101000000: li('Patrick Collison', 'Plumber', [['Plumber', 'Collison Plumbing Services']]),
        20200101000000: li('Patrick Collison', 'CEO at Stripe', [['CEO', 'Stripe']]),
      }),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, depth: 1 }, ctxFor(subject));
    expect(out.findings.some((f) => f.data.kind === 'change')).toBe(false);
    expect(out.findings.find((f) => / as of 2014-01-01/.test(f.title)).match).toBe('possible');
    expect(out.findings.find((f) => / as of 2020-01-01/.test(f.title)).match).toBe('confirmed');
    expect(out.threads.find((t) => /Plumbing/.test(t.value))).toMatchObject({ trusted: false });
  });

  test('an older copy that shares an employer with a tied copy is still part of the history', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const addr = 'https://www.linkedin.com/in/elizabethholmes';
    network([
      ['/cdx/search/cdx', cdx(row('20150101000000', addr, 'A'), row('20200101000000', addr, 'B'))],
      snapRoute({
        20150101000000: li('Elizabeth Holmes', 'Research assistant', [['Research assistant', 'Genome Lab Singapore']]),
        20200101000000: li('Elizabeth Holmes', 'Founder and CEO, Theranos', [['Founder and CEO', 'Theranos'], ['Research assistant', 'Genome Lab Singapore']]),
      }),
    ]);
    const out = await archiveConnector.run({ kind: 'url', value: addr, depth: 1 }, ctxFor(subject));
    const change = out.findings.find((f) => f.data.kind === 'change');
    expect(change).toBeTruthy();
    // tied by one anchor and sharing a line with an untied copy: may be a merged profile, so held at possible (fix2 item 1)
    expect(change.match).toBe('possible');
    // R3: the 2015 version says nothing the 2020 one does not, and is graded the same: folded into the page's record
    const page = out.findings.find((f) => f.data.kind === 'snapshot');
    expect(page.match).toBe('possible');
    expect(page.data.versions.map((v) => v.date)).toEqual(['2015-01-01']);
  });
});

const teamPage = (people) => `<html><head><title>Leadership</title></head><body><h2>Leadership</h2>${people.map(([n, t]) => `<p>${n}</p><p>${t}</p><p>${n.split(' ')[0]} has led teams in laboratory science and software for many years at several companies.</p>`).join('')}</body></html>`;

describe('team pages', () => {
  test('two different pages of one domain are not compared as one page', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const head = ['original', 'mimetype', 'timestamp', 'endtimestamp', 'groupcount', 'uniqcount'];
    const listing = [head,
      ['http://www.theranos.com/leadership', 'text/html', '20150101000000', '20150101000000', '1', '1'],
      ['http://www.theranos.com/board', 'text/html', '20150601000000', '20150601000000', '1', '1'],
    ];
    network([['/web/timemap/json', listing], snapRoute({
      20150101000000: teamPage([['Elizabeth Holmes', 'Founder and CEO'], ['Sunny Balwani', 'President and COO']]),
      20150601000000: teamPage([['Elizabeth Holmes', 'Chairman of the Board'], ['George Shultz', 'Director']]),
    })]);
    const out = await archiveConnector.run({ kind: 'domain', value: 'theranos.com', depth: 1 }, ctxFor(subject));
    expect(out.findings.some((f) => /named on theranos\.com team pages/.test(f.title))).toBe(true);
    expect(out.findings.some((f) => f.data.kind === 'change' && f.data.field === 'headline')).toBe(false);
  });
});

describe('guessed spellings', () => {
  test('many copies at the first spelling still leave room to list the second spelling', async () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const addr = 'https://www.linkedin.com/in/elizabethholmes';
    const rows = ['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023'].map((y, i) => row(`${y}0101000000`, addr, `D${i}`, 9000 + i * 2000));
    const pages = Object.fromEntries(rows.map((r) => [r[0], li('Elizabeth Holmes', 'Vet nurse at PawsLikeMe', [['Vet nurse', 'PawsLikeMe']])]));
    const calls = network([
      ['url=linkedin.com%2Fin%2Felizabethholmes', cdx(...rows)],
      ['url=linkedin.com%2Fin%2Felizabeth-holmes', []],
      snapRoute(pages),
    ]);
    const plan = archiveConnector.plan({ kind: 'subject', value: subject.name }, subject).find((p) => p.template === 'archive.linkedin');
    const out = await archiveConnector.run({ kind: 'subject', value: subject.name, template: plan.template, params: plan.params, depth: 0 }, ctxFor(subject));
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls.some((u) => u.includes('url=linkedin.com%2Fin%2Felizabeth-holmes'))).toBe(true);
    for (const f of out.findings) expect(f.match).toBe('possible');
  });
});
