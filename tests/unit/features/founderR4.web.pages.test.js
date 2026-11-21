/**
 * @jest-environment node
 *
 * R4 (review 2026-11-21), the page reader (pages.js): a site read that fails is never an empty, clean-looking
 * result (http-sitread-silent-fail), and a robots file cut short by the step's deadline or a resting host
 * hands the lookup back to run again instead of dropping the page for the whole check (http-robots-cutshort-unknown).
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { createSubject } = require('../../../src/server/founder/identity');
const { pageReaderConnector } = require('../../../src/server/founder/sources/pages');
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');

const html = new Map([['content-type', 'text/html; charset=utf-8']]);
const answer = (url, status, text) => ({ status, headers: html, url, text: async () => text });
const ctx = (subject, extra = {}) => ({ subject, deadline: Date.now() + 30000, findings: () => [], done: () => [], ...extra });
const TEAM = '<html><head><title>Team - Merge</title></head><body><h3>Shensi Ding</h3><p>Shensi Ding is the co-founder and CEO of Merge. She previously worked at Expanse. Shensi Ding studied computer science at Columbia University.</p><p>Shensi Ding leads the company.</p></body></html>';
const subject = createSubject({ name: 'Shensi Ding', company: 'Merge' });
const site = { kind: 'domain', value: 'merge.dev', template: 'read.site' };

afterEach(() => { setTransport(); __resetCacheForTests(); });

describe('http-sitread-silent-fail', () => {
  test('a reset on /about does not stop /team from being read, and the failed path is named', async () => {
    setTransport(async (url) => {
      if (/robots\.txt$/.test(url)) return answer(url, 404, '');
      if (/\/about$/.test(url)) { const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET'; throw e; }
      if (/\/team$/.test(url)) return answer(url, 200, TEAM);
      return answer(url, 404, '');
    });
    const out = await pageReaderConnector.run(site, ctx(subject));
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.notes.join(' ')).toMatch(/\/about/);
    expect(out.notes.join(' ')).toMatch(/could not be read/);
  });

  test('a 403 on /about moves on to /team', async () => {
    setTransport(async (url) => {
      if (/robots\.txt$/.test(url)) return answer(url, 404, '');
      if (/\/about$/.test(url)) return answer(url, 403, 'no');
      if (/\/team$/.test(url)) return answer(url, 200, TEAM);
      return answer(url, 404, '');
    });
    const out = await pageReaderConnector.run(site, ctx(subject));
    expect(out.findings.some((f) => /Career/.test(f.title))).toBe(true);
    expect(out.notes.join(' ')).toMatch(/\/about: HTTP 403/);
  });

  test('every page failing throws, so the source counts as failed', async () => {
    setTransport(async (url) => {
      if (/robots\.txt$/.test(url)) return answer(url, 404, '');
      const e = new Error('read ECONNRESET'); throw e;
    });
    await expect(pageReaderConnector.run(site, ctx(subject))).rejects.toThrow(/could not be read/);
  });

  test('pages that answered 404 are not failures: an empty site read stays an empty result', async () => {
    setTransport(async (url) => answer(url, 404, ''));
    const out = await pageReaderConnector.run(site, ctx(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes).toEqual([]);
  });

  test('the step deadline before any page answered hands the lookup back as cut short', async () => {
    setTransport(async (url) => answer(url, 404, ''));
    await expect(pageReaderConnector.run(site, ctx(subject, { deadline: Date.now() + 1000 }))).rejects.toMatchObject({ code: 'deadline' });
  });

  test('a page that hangs until the deadline: the lookup throws a cut-short error, never an empty result', async () => {
    setTransport(async (url, init) => {
      if (/robots\.txt$/.test(url)) return answer(url, 404, '');
      return new Promise((resolve, reject) => {
        const sig = init?.signal;
        if (sig) sig.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    });
    await expect(pageReaderConnector.run(site, ctx(subject, { deadline: Date.now() + 4500 }))).rejects.toThrow();
  }, 15000);
});

describe('http-robots-cutshort-unknown', () => {
  test('a robots file slower than the deadline: the page lookup throws a cut-short error, not a "could not be read" note', async () => {
    setTransport(async (url) => {
      if (/robots\.txt$/.test(url)) { await new Promise((r) => setTimeout(r, 2500)); return answer(url, 200, ''); }
      return answer(url, 200, TEAM);
    });
    const error = await pageReaderConnector.run({ kind: 'url', value: 'https://bio.example.com/shensi', template: 'read', why: 'page about them' }, ctx(subject, { deadline: Date.now() + 1200 })).then(() => null, (e) => e);
    expect(error).toBeTruthy();
    expect(error.code === 'deadline' || /out of time/i.test(error.message)).toBe(true);
  });

  test('a robots file that fails for real (HTTP 500) still leaves the page alone with a note', async () => {
    setTransport(async (url) => {
      if (/robots\.txt$/.test(url)) return answer(url, 500, '');
      return answer(url, 200, TEAM);
    });
    const out = await pageReaderConnector.run({ kind: 'url', value: 'https://bio.example.com/shensi', template: 'read', why: 'page about them' }, ctx(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/robots file could not be read/);
  });
});
