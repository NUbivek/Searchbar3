/**
 * @jest-environment node
 *
 * Depth for ordinary founders: the seed lookups run first, the page reader opens more of the right pages
 * (company about/team pages, show notes, articles), falls back to the web archive's copy when a page turns
 * it away, reads the page's structured data, and never credits a colleague's facts to the person.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { createSubject } = require('../../../src/server/founder/identity');
const { buildProfile } = require('../../../src/server/founder/profile');
const { startState, stepDeepCheck, isSeedTask } = require('../../../src/server/founder/deepCheck');
const { pageReaderConnector, readPlanFor, readPage, MAX_PAGES, SITE_MAX_REQUESTS } = require('../../../src/server/founder/sources/pages');
const { webSearchConnector, SEED_TEMPLATES } = require('../../../src/server/founder/sources/web');
const { structuredData, personFacts, threadsFromFacts, associatesFromText } = require('../../../src/server/founder/extract');
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { recordStats, __resetLearningForTests } = require('../../../src/server/learning');
const { makeThread } = require('../../../src/server/founder/finding');

const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
const headers = new Map([['content-type', 'text/html']]);
const answer = (url, status, text) => ({ status, headers, url, text: async () => text });
const ctx = (extra = {}) => ({ subject, deadline: Date.now() + 30000, findings: () => [], done: () => [], ...extra });
const BIO = '<html><head><title>Jane Roe - Co-Founder, Acme</title></head><body><p>Jane Roe is the co-founder and CEO of Acme. She previously worked at Credit Suisse. She studied computer science at Columbia University.</p></body></html>';
const AVAILABLE = (ts) => JSON.stringify({ url: 'x', archived_snapshots: { closest: { status: '200', available: true, url: `http://web.archive.org/web/${ts}/x`, timestamp: ts } } });

afterEach(() => { setTransport(); __resetCacheForTests(); });

/* ------------------------------------------------------------------ the seed */

describe('the seed runs first', () => {
  beforeEach(() => __resetLearningForTests());

  test('the six profile lookups are the seed, and run before every other lookup of the first round', async () => {
    const calls = [];
    const web = { ...webSearchConnector, run: async (task) => { calls.push(`web:${task.template}`); return { findings: [] }; } };
    const other = { id: 'sanctions-lists', label: 'Sanctions', kinds: ['subject'], prior: 0.95, run: async () => { calls.push('sanctions'); return { findings: [] }; } };
    // learning that says the seed patterns never paid off must not push them back
    await recordStats('query', SEED_TEMPLATES.map((t) => ({ key: `web-search:${t}`, win: 0, ms: 100 })).flatMap((o) => [o, o, o, o]));
    const state = startState({ name: 'Jane Roe', company: 'Acme' });
    await stepDeepCheck(state, { connectors: [other, web], limits: { ...require('../../../src/server/founder/deepCheck').LIMITS, concurrency: 1 }, deadline: Date.now() + 8000 });
    const firstSix = calls.slice(0, SEED_TEMPLATES.length).map((c) => c.replace('web:', ''));
    expect(firstSix.sort()).toEqual([...SEED_TEMPLATES].sort());
    expect(calls.indexOf('sanctions')).toBeGreaterThanOrEqual(SEED_TEMPLATES.length);
  });

  test('a seed is a lookup about the person at depth 0 that our own pattern marks', () => {
    const plans = webSearchConnector.plan({ kind: 'subject', value: subject.name }, subject);
    expect(plans.filter((p) => p.params.seed).map((p) => p.template).sort()).toEqual([...SEED_TEMPLATES].sort());
    expect(isSeedTask({ kind: 'subject', depth: 0, params: { seed: true } })).toBe(true);
    expect(isSeedTask({ kind: 'subject', depth: 1, params: { seed: true } })).toBe(false);
    expect(isSeedTask({ kind: 'company', depth: 0, params: { seed: true } })).toBe(false);
  });
});

/* ------------------------------------------------------------------ what gets read */

describe('which pages are read', () => {
  beforeEach(() => __resetLearningForTests());

  test('each kind of page has its own reading pattern, best yield first', () => {
    expect(readPlanFor({ why: 'team or bio page' })).toMatchObject({ template: 'read', prior: 0.78 });
    expect(readPlanFor({ why: 'podcast or interview page' })).toMatchObject({ template: 'read.talk' });
    expect(readPlanFor({ why: 'article naming them' })).toMatchObject({ template: 'read.press', prior: 0.6 });
    expect(pageReaderConnector.plan({ kind: 'domain', value: 'acme.dev' })).toEqual([expect.objectContaining({ template: 'read.site' })]);
    expect(pageReaderConnector.plan({ kind: 'domain', value: 'linkedin.com' })).toEqual([]);
    expect(pageReaderConnector.plan({ kind: 'domain', value: 'janeroe.substack.com' })).toEqual([]);
  });

  test('articles and show notes go to the page reader only; profiles and bio pages also to the web archive', async () => {
    const calls = [];
    const finder = {
      id: 'finder', label: 'Finder', kinds: ['subject'],
      run: async () => ({ findings: [], threads: [
        makeThread('url', 'https://techcrunch.com/2024/acme-raises', 'article naming them', { trusted: true }),
        makeThread('url', 'https://pod.test/episodes/jane-roe', 'podcast or interview page', { trusted: true }),
        makeThread('url', 'https://acme.dev/team/jane-roe', 'team or bio page', { trusted: true }),
      ] }),
    };
    const archive = { id: 'web-archive', label: 'Archive', kinds: ['url'], run: async (t) => { calls.push(`archive:${t.value}`); return { findings: [] }; } };
    const reader = { ...pageReaderConnector, run: async (t) => { calls.push(`reader:${t.template}:${t.value}`); return { findings: [] }; } };
    const state = startState({ name: 'Jane Roe', company: '' });
    for (let i = 0; i < 3 && state.phase === 'collect'; i += 1) await stepDeepCheck(state, { connectors: [finder, archive, reader], deadline: Date.now() + 5000 });
    expect(calls).toEqual(expect.arrayContaining([
      'reader:read.press:https://techcrunch.com/2024/acme-raises', 'reader:read.talk:https://pod.test/episodes/jane-roe', 'reader:read:https://acme.dev/team/jane-roe',
      'archive:https://acme.dev/team/jane-roe',
    ]));
    expect(calls.filter((c) => c.startsWith('archive:'))).toEqual(['archive:https://acme.dev/team/jane-roe']);
  });
});

/* ------------------------------------------------------------------ the company's own pages */

describe('a site\'s about and team pages', () => {
  test('existing pages that name the person are read, missing ones skipped, within the request limit', async () => {
    const seen = [];
    setTransport(async (url) => {
      seen.push(url);
      if (url.endsWith('/robots.txt')) return answer(url, 200, 'User-agent: *\nDisallow: /leadership');
      if (url === 'https://acme.dev/about') return answer(url, 200, '<title>About Acme</title><p>Acme was started in 2020 by Jane Roe and Bob Smith.</p><p>Jane Roe previously worked at Silver Lake. Jane Roe is the CEO.</p>');
      return answer(url, 404, 'not found');
    });
    const out = await pageReaderConnector.run({ kind: 'domain', value: 'acme.dev', template: 'read.site' }, ctx());
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings[0].quote).toMatch(/Silver Lake/);
    expect(out.findings[0].data).toMatchObject({ kind: 'bio', page: 'https://acme.dev/about' });
    // robots closes /leadership: never asked for
    expect(seen).not.toContain('https://acme.dev/leadership');
    expect(seen.filter((u) => !u.endsWith('/robots.txt')).length).toBeLessThanOrEqual(SITE_MAX_REQUESTS);
    expect(buildProfile(subject, out.findings).earlier.map((e) => e.org)).toContain('Silver Lake');
  });
});

/* ------------------------------------------------------------------ the web archive's copy */

describe('when a page turns the reader away', () => {
  const run = (url = 'https://press.test/jane-roe') => pageReaderConnector.run({ kind: 'url', value: url, template: 'read' }, ctx());

  test.each([
    ['refuses it (403)', (url) => answer(url, 403, 'Forbidden')],
    ['asks for fewer requests (429)', (url) => answer(url, 429, 'Too many')],
    ['does not answer in time', () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }],
  ])('a page that %s is read from the archive\'s most recent copy, and the record says so', async (_, page) => {
    const seen = [];
    setTransport(async (url) => {
      seen.push(url);
      if (url.endsWith('/robots.txt')) return answer(url, 404, '');
      if (url.startsWith('https://archive.org/wayback/available')) return answer(url, 200, AVAILABLE('20260812234841'));
      if (url.startsWith('https://web.archive.org/web/20260812234841id_/')) return answer(url, 200, BIO);
      return page(url);
    });
    const out = await run();
    expect(seen).toEqual(expect.arrayContaining(['https://archive.org/wayback/available?url=https%3A%2F%2Fpress.test%2Fjane-roe', 'https://web.archive.org/web/20260812234841id_/https://press.test/jane-roe']));
    expect(out.findings.map((f) => f.category).sort()).toEqual(['career', 'education']);
    for (const f of out.findings) {
      expect(f.url).toBe('https://web.archive.org/web/20260812234841/https://press.test/jane-roe');
      expect(f.title).toMatch(/web archive's copy of 12 August 2026/);
      expect(f.data).toMatchObject({ kind: 'bio', page: 'https://press.test/jane-roe', archived: { date: '2026-08-12' } });
    }
    expect(out.notes[0]).toMatch(/read from the web archive's copy of 12 August 2026/);
  });

  test('a page robots.txt closes to the reader is never read, not even from the archive', async () => {
    const seen = [];
    setTransport(async (url) => { seen.push(url); return url.endsWith('/robots.txt') ? answer(url, 200, 'User-agent: *\nDisallow: /') : answer(url, 200, BIO); });
    const out = await run();
    expect(out.findings).toEqual([]);
    expect(seen).toEqual(['https://press.test/robots.txt']);
  });

  test('with no copy in the archive, nothing is read and the note says why', async () => {
    setTransport(async (url) => {
      if (url.endsWith('/robots.txt')) return answer(url, 404, '');
      if (url.startsWith('https://archive.org/wayback/available')) return answer(url, 200, '{"archived_snapshots":{}}');
      return answer(url, 403, 'Forbidden');
    });
    const out = await run();
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/web archive holds no copy/);
  });

  test('a missing page (404) is not looked up in the archive', async () => {
    const seen = [];
    setTransport(async (url) => { seen.push(url); return url.endsWith('/robots.txt') ? answer(url, 404, '') : answer(url, 404, 'gone'); });
    const out = await run();
    expect(out.findings).toEqual([]);
    expect(seen.some((u) => u.includes('archive.org'))).toBe(false);
  });

  test('no more than MAX_PAGES pages are opened in one check', async () => {
    const seen = [];
    setTransport(async (url) => { seen.push(url); return answer(url, 200, BIO); });
    const done = () => Array.from({ length: MAX_PAGES }, (_, i) => `page-reader|url|https://p${i}.test/x|read`);
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://new.test/jane', template: 'read' }, ctx({ done }));
    expect(out.notes[0]).toMatch(/pages already read/);
    expect(seen).toEqual([]);
  });
});

/* ------------------------------------------------------------------ structured data */

describe('structured data on a page', () => {
  const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
  const page = (head, body = '') => `<html><head><title>Jane Roe | Founder profile</title>${head}</head><body>${body}</body></html>`;

  test('a schema.org Person who is the subject gives role, employer, school and profile links, never contact fields', () => {
    const html = page(ld({ '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: 'Jane Roe', jobTitle: 'Co-Founder and CEO, Acme', worksFor: { '@type': 'Organization', name: 'Acme' }, alumniOf: [{ '@type': 'CollegeOrUniversity', name: 'Columbia University' }], sameAs: ['https://www.linkedin.com/in/janeroe', 'https://x.com/janeroe', 'https://janeroe.com'], email: 'jane@example.com', telephone: '+1 555 0100', birthDate: '1990-01-01', address: '1 Main St' } }),
      '<p>Welcome.</p>');
    const data = structuredData(html);
    expect(data.persons[0]).toEqual({ name: 'Jane Roe', titles: ['Co-Founder and CEO, Acme'], employers: ['Acme'], schools: ['Columbia University'], links: ['https://www.linkedin.com/in/janeroe', 'https://x.com/janeroe', 'https://janeroe.com'] });
    const out = readPage(subject, { url: 'https://profiles.test/jane-roe', html });
    const record = out.findings.find((f) => /page data/.test(f.title));
    expect(record).toMatchObject({ match: 'confirmed', category: 'career', data: { kind: 'bio', page: 'https://profiles.test/jane-roe' } });
    expect(record.quote).toBe('Jane Roe — job title: Co-Founder and CEO, Acme; works for: Acme; alumni of: Columbia University.');
    expect(JSON.stringify(out)).not.toMatch(/555|jane@example|1990|Main St/);
    const kinds = out.threads.map((t) => `${t.kind}:${t.value}:${t.trusted}`);
    expect(kinds).toEqual(expect.arrayContaining(['school:Columbia University:true', 'url:https://linkedin.com/in/janeroe:true', 'url:https://x.com/janeroe:true', 'handle:janeroe:true', 'url:https://janeroe.com:true']));
    const profile = buildProfile(subject, out.findings);
    expect(profile.education.map((e) => e.school)).toContain('Columbia University');
    expect(profile.headline).toMatch(/CEO/);
  });

  test('an organisation that lists the person among its founders gives the co-founders', () => {
    const html = page(ld({ '@type': 'Organization', name: 'Acme', founder: [{ '@type': 'Person', name: 'Jane Roe' }, { '@type': 'Person', name: 'Bob Smith' }] }), '<p>Jane Roe leads Acme.</p>');
    const out = readPage(subject, { url: 'https://acme.dev/about', html });
    expect(out.threads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'associate', value: 'Bob Smith', why: 'named as a co-founder', trusted: true })]));
  });

  test('the page\'s summary line is read when the body says little', () => {
    const html = page('<meta name="description" content="Jane Roe is the co-founder of Acme and previously worked at Expanse.">', '<p>Subscribe to our newsletter.</p>');
    const out = readPage(subject, { url: 'https://library.test/jane-roe', html });
    expect(out.findings[0].quote).toMatch(/previously worked at Expanse/);
    expect(buildProfile(subject, out.findings).earlier.map((e) => e.org)).toContain('Expanse');
  });

  test('a definition-list bio is read on a page about the person alone', () => {
    const html = page('', '<p>Jane Roe, Acme.</p><dl><dt>Education</dt><dd>Columbia University</dd><dt>Previously</dt><dd>Credit Suisse; Silver Lake</dd><dt>Phone</dt><dd>555 0100</dd></dl>');
    const out = readPage(subject, { url: 'https://speakers.test/jane-roe', html });
    const record = out.findings.find((f) => /page data/.test(f.title));
    expect(record.quote).toBe('Jane Roe — education: Columbia University; previously: Credit Suisse; Silver Lake.');
    expect(record.quote).not.toMatch(/555/);
  });

  test('a colleague\'s structured data is never credited to the person', () => {
    const html = `<html><head><title>Team - Acme</title>${ld({ '@type': 'Person', name: 'Bob Smith', worksFor: 'Google', alumniOf: 'Yale University', sameAs: ['https://www.linkedin.com/in/bobsmith'] })}</head><body><p>Jane Roe is the CEO of Acme.</p><dl><dt>Education</dt><dd>Yale University</dd></dl></body></html>`;
    const out = readPage(subject, { url: 'https://acme.dev/team', html });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/Google|Yale|bobsmith/);
    expect(buildProfile(subject, out.findings).earlier).toEqual([]);
  });

  test('a Person node with only a first name says nothing about who it is', () => {
    const facts = personFacts(createSubject({ name: 'Jane Roe' }), { persons: [{ name: 'Jane', titles: ['CEO'], employers: ['Initech'], schools: [], links: [] }], organizations: [], definitions: [] });
    expect(facts).toBeNull();
  });

  test('profile links from facts are only as trusted as the record', () => {
    const facts = personFacts(subject, structuredData(ld({ '@type': 'Person', name: 'Jane Roe', sameAs: 'https://github.com/janeroe' })));
    expect(threadsFromFacts(subject, facts, { trusted: false }).every((t) => t.trusted === false)).toBe(true);
  });
});

/* ------------------------------------------------------------------ co-founders in plain sentences */

test('"Jane Roe and Bob Smith started Acme" names a co-founder; two other people do not', () => {
  expect(associatesFromText(subject, 'Jane Roe and Bob Smith, started Acme in 2020 and grew it fast.').map((a) => a.name)).toEqual(['Bob Smith']);
  expect(associatesFromText(subject, 'Jane Roe and Bob Smith co-founded the company in 2019.').map((a) => a.name)).toEqual(['Bob Smith']);
  expect(associatesFromText(subject, 'Jane Roe said Tom Ray and Bob Smith started Initech.').map((a) => a.name)).toEqual([]);
  expect(associatesFromText(subject, 'Jane Roe and Bob Smith started working together.').map((a) => a.name)).toEqual([]);
});

/* ------------------------------------------------------------------ review fixes (regressions) */

describe('an article that names the person while telling someone else\'s career', () => {
  const adam = createSubject({ name: 'Adam Neumann', company: 'WeWork' });
  const ARTICLE = (title, extra = '') => `<html><head><title>${title}</title></head><body>`
    + '<p>Adam Neumann built one of the best-known office brands of the decade.</p>'
    + '<p>Investors still debate what Adam Neumann got right.</p>'
    + '<p>Adam Neumann is back with a housing venture.</p>'
    + '<p>Unlike Adam Neumann, who founded WeWork, Maria Lopez started Flexspace after eight years at Goldman Sachs and a degree from Stanford University.</p>'
    + `${extra}</body></html>`;

  test('the other person\'s school and employer are never credited to the subject', () => {
    for (const template of ['read.press', 'read']) {
      const out = readPage(adam, { url: 'https://news.test/flex-offices', html: ARTICLE('The rise of flexible offices'), template });
      expect(JSON.stringify(out.findings)).not.toMatch(/Stanford|Goldman/);
      const profile = buildProfile(adam, out.findings);
      expect(profile.education).toEqual([]);
      expect(profile.earlier.map((e) => e.org)).not.toContain('Goldman Sachs');
    }
  });

  test('a co-founder told in an aside or a possessive is not the subject either', () => {
    const html = ARTICLE('Office wars', "<p>Adam Neumann's co-founder, Miguel McKelvey, studied architecture at the University of Oregon.</p><p>Adam Neumann hired Rob Ray, who previously worked at Goldman Sachs.</p>");
    const out = readPage(adam, { url: 'https://news.test/office-wars', html, template: 'read.press' });
    expect(JSON.stringify(out.findings)).not.toMatch(/Oregon|Goldman/);
  });

  test('a sentence about the subject is kept; on an article whose title does not name them it is only possible', () => {
    const extra = '<p>Adam Neumann previously served in the Israeli Navy, years before WeWork. In 2002, Adam Neumann studied at Baruch College.</p>';
    const untitled = readPage(adam, { url: 'https://news.test/a', html: ARTICLE('Office wars', extra), template: 'read.press' });
    expect(untitled.findings.map((f) => f.quote).join(' ')).toMatch(/Israeli Navy/);
    expect(untitled.findings.find((f) => f.category === 'education')?.quote).toMatch(/Baruch College/);
    expect(untitled.findings.every((f) => f.match === 'possible' || f.match === 'none')).toBe(true);
    expect(buildProfile(adam, untitled.findings).education).toEqual([]);
    const titled = readPage(adam, { url: 'https://news.test/b', html: ARTICLE('Adam Neumann returns', extra), template: 'read.press' });
    expect(titled.findings.some((f) => f.match === 'confirmed' || f.match === 'likely')).toBe(true);
    expect(JSON.stringify(titled.findings)).not.toMatch(/Stanford|Goldman/);
  });
});

describe('a lookup that fails is never reported as a site refusal', () => {
  const run = (deadline) => pageReaderConnector.run({ kind: 'url', value: 'https://slow.test/jane-roe', template: 'read' }, ctx({ deadline }));

  test('a page that times out only because the step is ending is handed back, not sent to the archive', async () => {
    const seen = [];
    setTransport(async (url) => {
      seen.push(url);
      if (url.endsWith('/robots.txt')) return answer(url, 404, '');
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(run(Date.now() + 3000)).rejects.toThrow(/Timed out/);
    expect(seen.some((u) => u.includes('archive.org'))).toBe(false);
  });

  test('when the archive cannot be checked, the lookup fails; it never says the archive holds no copy', async () => {
    setTransport(async (url) => {
      if (url.endsWith('/robots.txt')) return answer(url, 404, '');
      if (url.startsWith('https://archive.org/wayback/available')) return answer(url, 500, 'error');
      return answer(url, 403, 'Forbidden');
    });
    await expect(run(Date.now() + 30000)).rejects.toThrow(/turned the reader away \(HTTP 403\), and the web archive could not be checked/);
  });

  test('a page that did not answer and has no archive copy says it did not answer, not that it refused', async () => {
    setTransport(async (url) => {
      if (url.endsWith('/robots.txt')) return answer(url, 404, '');
      if (url.startsWith('https://archive.org/wayback/available')) return answer(url, 200, '{"archived_snapshots":{}}');
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const out = await run(Date.now() + 30000);
    expect(out.notes[0]).toMatch(/did not answer in time and the web archive holds no copy/);
  });

  test('a host being left alone is not read from the archive: the error goes back to the step loop with its retryAt', async () => {
    const seen = [];
    setTransport(async (url) => {
      seen.push(url);
      if (url.endsWith('/robots.txt')) return answer(url, 404, '');
      return answer(url, 503, 'busy');
    }, { paced: true });
    const go = (path) => pageReaderConnector.run({ kind: 'url', value: `https://resting.test/${path}`, template: 'read' }, ctx());
    await expect(go('a')).rejects.toThrow(/HTTP 503/);
    let error = null;
    try { await go('b'); } catch (e) { error = e; }
    expect(String(error?.message)).toMatch(/being left alone/);
    expect(error.retryAt).toBeGreaterThan(Date.now());
    expect(seen.some((u) => u.includes('archive.org'))).toBe(false);
    expect(seen).not.toContain('https://resting.test/b');
  });
});

describe('robots.txt after a redirect', () => {
  test('a same-site redirect into a path robots.txt closes is not read', async () => {
    setTransport(async (url) => {
      if (url.endsWith('/robots.txt')) return answer(url, 200, 'User-agent: *\nDisallow: /internal/');
      if (url === 'https://acme.dev/team') return answer('https://acme.dev/internal/team', 200, BIO);
      return answer(url, 404, '');
    });
    const one = await pageReaderConnector.run({ kind: 'url', value: 'https://acme.dev/team', template: 'read' }, ctx());
    expect(one.findings).toEqual([]);
    expect(one.notes[0]).toMatch(/does not allow automated reading/);
    const site = await pageReaderConnector.run({ kind: 'domain', value: 'acme.dev', template: 'read.site' }, ctx());
    expect(site.findings).toEqual([]);
  });
});

describe('the page limit holds while lookups run in parallel', () => {
  const sharedSpend = () => {
    const spent = {};
    return (key, n = 1, max = Infinity) => { if ((spent[key] || 0) + n > max) return false; spent[key] = (spent[key] || 0) + n; return true; };
  };

  test.each([
    ['pages that answer', (url) => answer(url, 200, BIO)],
    ['pages that turn the reader away (each read from the archive)', (url) => answer(url, 403, 'Forbidden')],
  ])('6 site lookups and 18 pages in one step make at most MAX_PAGES requests: %s', async (_, page) => {
    const seen = [];
    setTransport(async (url) => {
      if (url.endsWith('/robots.txt')) return answer(url, 404, '');
      seen.push(url);
      if (url.startsWith('https://archive.org/wayback/available')) return answer(url, 200, AVAILABLE('20260812234841'));
      if (url.startsWith('https://web.archive.org/')) return answer(url, 200, BIO);
      return page(url);
    });
    const shared = ctx({ spend: sharedSpend() });
    const tasks = [
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'domain', value: `site${i}.test`, template: 'read.site' })),
      ...Array.from({ length: 18 }, (_, i) => ({ kind: 'url', value: `https://p${i}.test/jane`, template: 'read' })),
    ];
    const outs = await Promise.all(tasks.map((t) => pageReaderConnector.run(t, { ...shared })));
    expect(seen.length).toBeLessThanOrEqual(MAX_PAGES);
    expect(outs.some((o) => (o.notes || []).some((n) => /pages already read/.test(n)))).toBe(true);
  });

  test('the check gives every lookup the same live counter, kept on the state across steps', async () => {
    const seenSpend = [];
    const probe = { id: 'probe', label: 'Probe', kinds: ['subject'], prior: 1, run: async (task, c) => { seenSpend.push(c.spend('probe:n', 2, 3), c.spend('probe:n', 2, 3)); return { findings: [] }; } };
    const state = startState({ name: 'Jane Roe', company: 'Acme' });
    await stepDeepCheck(state, { connectors: [probe], deadline: Date.now() + 5000 });
    expect(seenSpend).toEqual([true, false]);
    expect(JSON.parse(JSON.stringify(state)).spent).toEqual({ 'probe:n': 2 });
  });
});

describe('reading the page text stays fast and exact', () => {
  const { pageText } = require('../../../src/server/founder/sources/pages');

  test('a huge page of unclosed <nav> openers is read in linear time', () => {
    const big = '<nav class="x">menu '.repeat(150000); // ~3 MB
    const started = Date.now();
    pageText(big);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('only <nav> and <footer> blocks are left out, never custom elements like <nav-item>', () => {
    const text = pageText('<nav><a href="/">Home</a></nav><nav-item>Jane Roe is the CEO.</nav-item><footer-links>Founded 2020.</footer-links><p>Body.</p><footer class="f">Legal</footer>');
    expect(text).toMatch(/Jane Roe is the CEO/);
    expect(text).toMatch(/Founded 2020/);
    expect(text).not.toMatch(/Home|Legal/);
  });
});
