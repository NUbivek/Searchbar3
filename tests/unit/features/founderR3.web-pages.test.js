/**
 * @jest-environment node
 *
 * R3 (audit 2026-11-20), the page reader (pages.js): every redirect hop is judged before it is opened (robots,
 * the never-open list, private addresses); private, loopback and metadata addresses are never planned; a
 * consent or subscription wall is not read as the page; a file that is not a page is not read; the company's
 * legal name is read from its own site's footer and learned as a name of the company.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { createSubject } = require('../../../src/server/founder/identity');
const { pageReaderConnector, readable, readPage, isWallPage, legalNameFromFooter, MAX_HTML_CHARS } = require('../../../src/server/founder/sources/pages');
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { companyNames } = require('../../../src/server/founder/sources/web');

const html = new Map([['content-type', 'text/html; charset=utf-8']]);
const answer = (url, status, text, headers = html) => ({ status, headers, url, text: async () => text });
const redirect = (url, to) => ({ status: 302, headers: new Map([['location', to]]), url, text: async () => '' });
const ctx = (subject, extra = {}) => ({ subject, deadline: Date.now() + 30000, findings: () => [], done: () => [], ...extra });
const BIO = '<html><head><title>Shensi Ding - Co-Founder, Merge</title></head><body><p>Shensi Ding is the co-founder and CEO of Merge. She previously worked at Expanse. She studied computer science at Columbia University.</p></body></html>';
const AVAILABLE = (ts) => JSON.stringify({ url: 'x', archived_snapshots: { closest: { status: '200', available: true, url: `http://web.archive.org/web/${ts}/x`, timestamp: ts } } });

afterEach(() => { setTransport(); __resetCacheForTests(); });

describe('security-ssrf-page-reader / web-pages-ssrf: private addresses are never planned', () => {
  test('IP literals, localhost, private names and other ports are not readable', () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:3009/api/founder?name=x', 'http://localhost/about', 'http://[::1]/', 'http://192.168.1.1/', 'http://metadata.google.internal/computeMetadata', 'https://intranet/team', 'https://example.com:8443/about', 'http://user:pass@example.com/about', 'http://2130706433/']) {
      expect(readable(url)).toBe(false);
    }
    expect(readable('https://merge.dev/about')).toBe(true);
    expect(readable('https://merge.dev:443/about')).toBe(true);
  });

  test('a domain thread on a private address or another port plans no site read', () => {
    for (const value of ['10.0.0.5', '127.0.0.1', 'localhost', 'example.com:8080']) expect(pageReaderConnector.plan({ kind: 'domain', value })).toEqual([]);
    expect(pageReaderConnector.plan({ kind: 'domain', value: 'merge.dev' })).toHaveLength(1);
  });

  test('org-chart pages are read from search snippets only, never opened', () => {
    expect(readable('https://theorg.com/org/merge/org-chart/shensi-ding')).toBe(false);
  });
});

describe('loop-redirect-hops: each redirect hop is judged before it is opened', () => {
  const subject = createSubject({ name: 'Shensi Ding', company: 'Merge' });

  test('a link that redirects to LinkedIn: LinkedIn is never asked', async () => {
    const asked = [];
    setTransport(async (url) => {
      asked.push(url);
      if (/robots\.txt$/.test(url)) return answer(url, 404, '');
      if (url === 'https://short.example.com/x') return redirect(url, 'https://www.linkedin.com/in/shensi');
      return answer(url, 200, BIO);
    });
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://short.example.com/x', template: 'read', why: 'page about them' }, ctx(subject));
    expect(asked.some((u) => /linkedin\.com/.test(u))).toBe(false);
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/sent the reader to linkedin\.com/);
  });

  test('a redirect to the cloud metadata address is refused before any request is sent there', async () => {
    const asked = [];
    setTransport(async (url) => {
      asked.push(url);
      if (/robots\.txt$/.test(url)) return answer(url, 404, '');
      if (url === 'https://bio.example.com/jane') return redirect(url, 'http://169.254.169.254/latest/meta-data/');
      return answer(url, 200, 'secret');
    });
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://bio.example.com/jane', template: 'read', why: 'page about them' }, ctx(subject));
    expect(asked.some((u) => /169\.254/.test(u))).toBe(false);
    expect(out.findings).toEqual([]);
  });

  test('a same-site redirect into a path robots.txt closes is not opened', async () => {
    const asked = [];
    setTransport(async (url) => {
      asked.push(url);
      if (/robots\.txt$/.test(url)) return answer(url, 200, 'User-agent: *\nDisallow: /private/');
      if (url === 'https://site.example.com/team') return redirect(url, 'https://site.example.com/private/team');
      return answer(url, 200, BIO);
    });
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://site.example.com/team', template: 'read', why: 'team or bio page' }, ctx(subject));
    expect(asked).not.toContain('https://site.example.com/private/team');
    expect(out.notes.join(' ')).toMatch(/does not allow automated reading/);
  });
});

describe('web-consent-paywall-no-archive: a wall is not the page', () => {
  const subject = createSubject({ name: 'Shensi Ding', company: 'Merge' });
  const WALL = '<html><head><title>Before you continue</title></head><body><h1>We value your privacy</h1><p>We and our partners use cookies. Accept all cookies or manage your privacy settings.</p></body></html>';

  test('a consent page answered with 200: the archive\'s copy is read, and the note says so', async () => {
    setTransport(async (url) => {
      if (/robots\.txt$/.test(url)) return answer(url, 404, '');
      if (url.startsWith('https://archive.org/wayback/available')) return answer(url, 200, AVAILABLE('20240301000000'), new Map([['content-type', 'application/json']]));
      if (url.startsWith('https://web.archive.org/web/20240301000000id_/')) return answer(url, 200, BIO);
      return answer(url, 200, WALL);
    });
    expect(isWallPage(WALL)).toBe(true);
    expect(isWallPage(BIO)).toBe(false);
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://www.forbes.com/profile/shensi-ding/', template: 'read.press', why: 'article naming them' }, ctx(subject));
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings[0].data.archived.date).toBe('2024-03-01');
    expect(out.notes.join(' ')).toMatch(/consent or subscription page; the page was read from the web archive's copy of 1 March 2024/);
  });

  test('a wall with no archive copy: said, never shown as a clean page', async () => {
    setTransport(async (url) => {
      if (/robots\.txt$/.test(url)) return answer(url, 404, '');
      if (url.startsWith('https://archive.org/wayback/available')) return answer(url, 200, JSON.stringify({ archived_snapshots: {} }), new Map([['content-type', 'application/json']]));
      return answer(url, 200, WALL);
    });
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://www.forbes.com/profile/shensi-ding/', template: 'read.press', why: 'article naming them' }, ctx(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/consent or subscription page instead of the article and the web archive holds no copy; the page could not be read/);
  });

  test('a tied page that names nothing usable: a note, not silence', async () => {
    setTransport(async (url) => (/robots\.txt$/.test(url) ? answer(url, 404, '') : answer(url, 200, '<html><title>Podcast</title><body><p>Episode list.</p></body></html>')));
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://pod.example.com/episodes/74', template: 'read.talk', why: 'podcast or interview page' }, ctx(subject));
    expect(out.notes.join(' ')).toMatch(/opened but says nothing about Shensi Ding/);
  });

  test('a file that is not a web page is not read as one', async () => {
    setTransport(async (url) => (/robots\.txt$/.test(url) ? answer(url, 404, '') : answer(url, 200, '%PDF-1.4 Shensi Ding', new Map([['content-type', 'application/pdf']]))));
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://files.example.com/bio', template: 'read', why: 'team or bio page' }, ctx(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/not a web page/);
  });
});

describe('web-body-size / ReDoS: the page is read in linear time and up to a cap', () => {
  test('an unclosed <title> over megabytes takes milliseconds', () => {
    const subject = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    const big = `<html><head><title>${'a '.repeat(1500000)}`;
    const started = Date.now();
    readPage(subject, { url: 'https://x.example.com/', html: big });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(MAX_HTML_CHARS).toBe(1000000);
  });
});

describe('design decision 1: the legal name from the company\'s own site', () => {
  test('the footer gives the legal name only when it starts with the company\'s name', () => {
    expect(legalNameFromFooter('<footer>© 2024 Merge API, Inc. All rights reserved.</footer>', 'Merge')).toBe('Merge API, Inc.');
    expect(legalNameFromFooter('<footer>Copyright 2019-2024 Ramp Business Corporation</footer>', 'Ramp')).toBe('Ramp Business Corporation');
    expect(legalNameFromFooter('<footer>© 2024 Webflow, Inc.</footer>', 'Merge')).toBe('');
  });

  test('read from the about page of merge.dev: a record, an alias of the company, and a thread to search by', async () => {
    const subject = createSubject({ name: 'Shensi Ding', company: 'Merge' });
    setTransport(async (url) => {
      if (/robots\.txt$/.test(url)) return answer(url, 404, '');
      if (url === 'https://merge.dev/about') return answer(url, 200, `${BIO.replace('</body>', '<footer><p>© 2024 Merge API, Inc. All rights reserved.</p></footer></body>')}`);
      return answer(url, 404, '');
    });
    const out = await pageReaderConnector.run({ kind: 'domain', value: 'merge.dev', template: 'read.site', why: 'company website' }, ctx(subject));
    const legal = out.findings.find((f) => f.data?.kind === 'legal-name');
    expect(legal).toMatchObject({ category: 'corporate', match: 'company', data: { legalName: 'Merge API, Inc.', domain: 'merge.dev', company: 'Merge' } });
    expect(out.threads.find((t) => t.kind === 'company' && t.value === 'Merge API, Inc.')).toBeTruthy();
    expect(companyNames(subject, 'Merge')).toMatchObject({ legal: ['Merge API, Inc.'], domains: ['merge.dev'] });
  });
});
