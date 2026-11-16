/**
 * Web archive connector, fixes from grading real reports (round 3):
 *  - item 3: a copy of a guessed address that names the company the user entered (or two anchors) keeps
 *    its grade, capped at "likely", so the page's history is told; a namesake's copy and a page that may
 *    mix two people stay "possible"; nothing on a guessed address is followed;
 *  - item 13: an employer the newer copy still names in its bio is not "no longer listed"; a title that
 *    only grew is noted at info; a current role that later shows an end date is a low "dates changed";
 *  - item 23: a handle given by a tied record (Wikidata) grades its pages as a linked profile; "TBA",
 *    "Option" and the like are not employers; French school names are schools.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const { archiveConnector, __resetArchiveCacheForTests, textNamesOrg } = require('../../../src/server/founder/sources/archive');

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

/** A 2019+ LinkedIn public profile: roles are [title, org, dates?]. */
const li = (name, headline, roles, schools = [], bio = '') => `<html><head><title>${name} | LinkedIn</title></head><body>
<h1 class="top-card-layout__title">${name}</h1><h2 class="top-card-layout__headline">${headline}</h2>
${bio ? `<div id="summary"><p class="description">${bio}</p></div>` : ''}
<ul>${roles.map(([t, o, d]) => `<li class="experience-item"><h3 class="experience-item__title">${t}</h3><h4 class="experience-item__subtitle">${o}</h4>${d ? `<p class="date-range">${d}</p>` : ''}</li>`).join('')}</ul>
<ul>${schools.map((s) => `<li class="education__list-item"><h3 class="profile-section-card__title">${s}</h3></li>`).join('')}</ul></body></html>`;

const GUESS = 'https://www.linkedin.com/in/janeroe';
async function runGuessed(subject, pages) {
  network([
    ['url=linkedin.com%2Fin%2Fjaneroe', cdx(...Object.keys(pages).map((ts, i) => row(ts, GUESS, `D${i}`)))],
    snapRoute(pages),
  ]);
  const plan = archiveConnector.plan({ kind: 'subject', value: subject.name }, subject).find((p) => p.template === 'archive.linkedin');
  return archiveConnector.run({ kind: 'subject', value: subject.name, template: plan.template, params: plan.params, depth: 0 }, ctxFor(subject));
}

describe('item 3: guessed addresses lifted by the given company', () => {
  test('copies naming the company the user entered are "likely", their history is told, and nothing is followed', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const out = await runGuessed(subject, {
      20150101000000: li('Jane Roe', 'Founder, Acmeworks', [['Founder', 'Acmeworks']]),
      20210101000000: li('Jane Roe', 'Former Founder, Acmeworks; Partner at Some Fund', [['Founder', 'Acmeworks'], ['Partner', 'Some Fund']]),
    });
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) {
      expect(f.match).toBe('likely');
      expect(f.matchFixed).toBe(true);
    }
    expect(out.findings[0].matchReasons.join(' ')).toMatch(/address guessed from the name, but this copy names Acmeworks/);
    const changes = out.findings.filter((f) => f.data.kind === 'change');
    expect(changes.length).toBeGreaterThan(0);
    expect(out.threads).toEqual([]);
  });

  test('a copy tied only by one company found along the way (not the one entered) stays "possible"', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    addAnchor(subject, 'companies', 'Othercorp', 'f12');
    const out = await runGuessed(subject, {
      20150101000000: li('Jane Roe', 'Engineer, Othercorp', [['Engineer', 'Othercorp']]),
      20210101000000: li('Jane Roe', 'Senior Engineer, Othercorp', [['Senior Engineer', 'Othercorp']]),
    });
    for (const f of out.findings) expect(f.match).toBe('possible');
    expect(out.findings.some((f) => f.data.kind === 'change')).toBe(false);
  });

  test('two anchors found along the way lift a copy to "likely", never "confirmed"', async () => {
    const subject = createSubject({ name: 'Jane Roe' });
    addAnchor(subject, 'companies', 'Othercorp', 'f12');
    addAnchor(subject, 'schools', 'Northfield University', 'f13');
    const out = await runGuessed(subject, {
      20210101000000: li('Jane Roe', 'Engineer, Othercorp', [['Engineer', 'Othercorp']], ['Northfield University']),
    });
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) expect(f.match).toBe('likely');
  });

  test('a lifted copy sharing a line with a copy that names no anchor may mix two people: every copy stays "possible"', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const out = await runGuessed(subject, {
      20150101000000: li('Jane Roe', 'Director, Unrelated Media Group', [['Director', 'Unrelated Media Group']]),
      20210101000000: li('Jane Roe', 'Founder, Acmeworks', [['Founder', 'Acmeworks'], ['Director', 'Unrelated Media Group']]),
    });
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) expect(f.match).toBe('possible');
    expect(out.findings.some((f) => f.data.kind === 'change')).toBe(false);
    expect(out.threads).toEqual([]);
  });
});

const LI = 'https://www.linkedin.com/in/jane-roe';
async function runLinked(subject, pages) {
  network([
    ['url=linkedin.com%2Fin%2Fjane-roe', cdx(...Object.keys(pages).map((ts, i) => row(ts, LI, `L${i}`)))],
    snapRoute(pages),
  ]);
  const [plan] = archiveConnector.plan({ kind: 'url', value: LI, why: 'linked from their Crunchbase profile' }, subject);
  return archiveConnector.run({ kind: 'url', value: LI, template: plan.template, params: plan.params, depth: 1 }, ctxFor(subject));
}
const changesOf = (out) => out.findings.filter((f) => f.data.kind === 'change');

describe('item 13: role changes weighed as a reader would', () => {
  test('textNamesOrg sees an employer in a bio, split or joined, and not inside another word', () => {
    expect(textNamesOrg('Jane Roe is the Co-founder and CEO of Acmeworks.', 'Acmeworks, Inc.')).toBe(true);
    expect(textNamesOrg('co-founder of acme works', 'Acmeworks')).toBe(true);
    expect(textNamesOrg('works at Acmeworksfoundation', 'Acmeworks')).toBe(false);
    expect(textNamesOrg('anything', 'Co')).toBe(false);
  });

  test('a role missing from the newer roles list but named in its bio is not reported as removed', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const out = await runLinked(subject, {
      20170101000000: li('Jane Roe', 'Founder at Acmeworks', [['Co-Founder & CEO', 'Acmeworks', 'Jan 2010 - Present'], ['Advisor', 'Bluefin Labs', '2012 - Present']]),
      20190801000000: li('Jane Roe', 'Founder at Acmeworks', [['Advisor', 'Bluefin Labs', '2012 - Present']], [], 'Jane Roe is the Co-founder and CEO of Acmeworks.'),
    });
    const removed = changesOf(out).filter((f) => f.data.change === 'removed' && f.data.field === 'role');
    expect(removed).toEqual([]);
  });

  test('a role still missing everywhere on the newer copy is reported', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const out = await runLinked(subject, {
      20170101000000: li('Jane Roe', 'Founder at Acmeworks', [['Co-Founder', 'Acmeworks', '2010 - Present'], ['Advisor', 'Bluefin Labs', '2012 - Present']]),
      20190801000000: li('Jane Roe', 'Founder at Acmeworks', [['Co-Founder', 'Acmeworks', '2010 - Present']], [], 'Jane Roe builds companies.'),
    });
    const removed = changesOf(out).filter((f) => f.data.change === 'removed' && f.data.field === 'role');
    expect(removed.map((f) => f.data.before).join(' ')).toMatch(/Bluefin Labs/);
    expect(removed[0].severity).toBe('medium');
  });

  test('a title that only grew is info; with a current role later ended it is a low change of dates', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const grew = await runLinked(subject, {
      20170101000000: li('Jane Roe', 'Founder at Acmeworks', [['Co-Founder', 'Acmeworks', '2010 - 2015']]),
      20190801000000: li('Jane Roe', 'Founder at Acmeworks', [['Co-Founder & CEO', 'Acmeworks', '2010 - 2015']]),
    });
    const titleChange = changesOf(grew).find((f) => f.data.field === 'role' && f.data.change === 'changed');
    expect(titleChange).toBeTruthy();
    expect(titleChange.severity).toBe('info');

    __resetArchiveCacheForTests();
    const ended = await runLinked(subject, {
      20170101000000: li('Jane Roe', 'Founder at Acmeworks', [['Co-Founder', 'Acmeworks', '2010 - Present']]),
      20190801000000: li('Jane Roe', 'Founder at Acmeworks', [['Co-Founder & CEO', 'Acmeworks', '2010 - Sep 2019']]),
    });
    const datesChange = changesOf(ended).find((f) => f.data.field === 'role' && f.data.change === 'changed');
    expect(datesChange).toBeTruthy();
    expect(datesChange.severity).toBe('low');
    expect(datesChange.title).toMatch(/role dates changed/);
  });

  test('the same role shown as current and later with an end date is reported as a low change of dates', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const out = await runLinked(subject, {
      20170101000000: li('Jane Roe', 'Founder at Acmeworks', [['Co-Founder', 'Acmeworks', '2010 - Present']]),
      20190801000000: li('Jane Roe', 'Founder at Acmeworks', [['Co-Founder', 'Acmeworks', '2010 - Sep 2019']]),
    });
    const datesChange = changesOf(out).find((f) => f.data.field === 'role' && f.data.change === 'changed');
    expect(datesChange).toBeTruthy();
    expect(datesChange.severity).toBe('low');
    expect(datesChange.data.after).toMatch(/2019/);
  });
});

describe('item 23: handles from tied records, non-employers, schools', () => {
  test('a GitHub handle listed on Wikidata is read as a linked profile: a copy with only the name is "likely"', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const plans = archiveConnector.plan({ kind: 'handle', value: 'jroe', why: 'github handle listed on Wikidata' }, subject);
    expect(plans.map((p) => p.template)).toEqual(['archive.github']);
    expect(plans[0].params.linkedFrom).toBe('Wikidata');
    expect(archiveConnector.plan({ kind: 'handle', value: 'jroe', why: 'github handle' }, subject)[0].params.linkedFrom).toBeUndefined();
    const addr = 'https://github.com/jroe';
    network([
      ['url=github.com%2Fjroe', cdx(row('20200101000000', addr, 'G1'))],
      snapRoute({ 20200101000000: '<html><body><span class="p-name vcard-fullname">Jane Roe</span><div class="p-note user-profile-bio">Machine learning research</div></body></html>' }),
    ]);
    const out = await archiveConnector.run({ kind: 'handle', value: 'jroe', why: 'github handle listed on Wikidata', template: plans[0].template, params: plans[0].params, depth: 1 }, ctxFor(subject));
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) expect(f.match).toBe('likely');
    expect(out.findings[0].matchReasons.join(' ')).toMatch(/linked from Wikidata/);
  });

  test('placeholders are not followed as employers, and French school names become school threads', async () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acmeworks' });
    const out = await runLinked(subject, {
      20210101000000: li('Jane Roe', 'Founder at Acmeworks', [['Founder', 'Acmeworks'], ['Next', 'TBA'], ['Major', 'Option'], ['Student', 'Ensae ParisTech'], ['Student', 'Sciences Po'], ['Engineer', 'Telecom Holdings']]),
    });
    const companies = out.threads.filter((t) => t.kind === 'company').map((t) => t.value);
    const schools = out.threads.filter((t) => t.kind === 'school').map((t) => t.value);
    expect(companies).toEqual(expect.arrayContaining(['Telecom Holdings']));
    expect(companies).not.toEqual(expect.arrayContaining(['TBA']));
    expect(companies).not.toEqual(expect.arrayContaining(['Option']));
    expect(companies).not.toContain('Ensae ParisTech');
    expect(companies).not.toContain('Sciences Po');
    expect(schools).toEqual(expect.arrayContaining(['Ensae ParisTech', 'Sciences Po']));
  });
});
