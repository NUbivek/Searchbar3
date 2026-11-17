/**
 * Web archive connector, fixes from grading real reports (round 4):
 *  - item 12 (this file's part): the archive's page for suspected abusive bot traffic, served in place of a
 *    listing or a saved copy, is reported as the archive turning automated requests away, not as a timeout
 *    or an unreadable answer, is never read as the person's page, and is not answered with more requests.
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
      const body = typeof reply === 'function' ? reply(url) : reply;
      return { status: 200, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    }
    return { status: 404, headers: new Map(), url, text: async () => 'not archived' };
  });
  return calls;
}

beforeEach(() => __resetArchiveCacheForTests());
afterEach(() => setTransport());

const WALL = '<html><head><title>Access limited</title></head><body><p>Your requests have been limited because of suspected abusive bot traffic. Please slow down.</p></body></html>';
const HEAD = ['timestamp', 'endtimestamp', 'original', 'digest', 'length', 'groupcount'];
const PROFILE = 'https://www.linkedin.com/in/janeroe';
const subject = () => createSubject({ name: 'Jane Roe' });

function runUrl(s) {
  const plan = archiveConnector.plan({ kind: 'url', value: PROFILE, why: 'given by the user' }, s)[0];
  return archiveConnector.run({ kind: 'url', value: PROFILE, template: plan.template, params: plan.params, depth: 0 }, ctxFor(s));
}

describe('archive: the bot-traffic wall is a refusal, not a timeout', () => {
  test('a listing answered with the wall says the archive turned automated requests away', async () => {
    network([['/cdx/search/cdx', WALL]]);
    const error = await runUrl(subject()).then(() => null, (e) => e);
    expect(error).toBeTruthy();
    expect(error.message).toMatch(/turned automated requests away/);
    expect(error.message).not.toMatch(/timed out|out of time|not JSON/i);
    expect(error.botWall).toBe(true);
  });

  test('a saved copy that is the wall is not read as the person’s page', async () => {
    network([
      ['/cdx/search/cdx', [HEAD, ['20200101000000', '20200101000000', PROFILE, 'D1', '9000', '2']]],
      [/\/web\/\d{14}id_\//, WALL],
    ]);
    const error = await runUrl(subject()).then(() => null, (e) => e);
    expect(error).toBeTruthy();
    expect(error.message).toMatch(/turned automated requests away/);
  });

  test('a site listing answered with the wall is not followed by guessed team addresses', async () => {
    const calls = network([['/web/timemap/json', WALL], ['/cdx/search/cdx', WALL]]);
    const s = subject();
    const plan = archiveConnector.plan({ kind: 'domain', value: 'example.com' }, s)[0];
    const error = await archiveConnector.run({ kind: 'domain', value: 'example.com', template: plan.template, params: plan.params, depth: 0 }, ctxFor(s)).then(() => null, (e) => e);
    expect(error && error.message).toMatch(/turned automated requests away/);
    expect(calls.filter((u) => u.includes('/cdx/search/cdx'))).toHaveLength(0);
  });

  test('other unreadable answers are still reported as unreadable', async () => {
    network([['/cdx/search/cdx', '<html><body>Something else entirely</body></html>']]);
    const error = await runUrl(subject()).then(() => null, (e) => e);
    expect(error && error.message).toMatch(/not JSON/);
    expect(error.botWall).toBeUndefined();
  });
});
