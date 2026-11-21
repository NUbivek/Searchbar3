/**
 * @jest-environment node
 */
const http = require('../../../src/server/founder/http');

const { request, getText, getJson, setTransport, htmlToText } = http;

const headersOf = (obj = {}) => new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), String(v)]));
const answer = (url, status = 200, text = 'ok', headers = {}) => ({ status, headers: headersOf(headers), url, text: async () => text });
/** A response whose body is a real stream of byte chunks, sent without Content-Length. */
const streamed = (url, chunks, headers = {}, onPull = () => {}) => {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      onPull(i);
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[i]);
      i += 1;
    },
  });
  return { status: 200, headers: headersOf(headers), url, body, text: async () => { throw new Error('text() must not be used'); } };
};

afterEach(() => setTransport());

describe('http R3: redirects are followed by hand', () => {
  test('each hop is opened by the client itself, at most five, and the final address is returned', async () => {
    const seen = [];
    setTransport(async (url, init) => {
      seen.push(url);
      expect(init.redirect).toBe('manual');
      const n = Number(/\/r(\d+)$/.exec(url)?.[1] ?? -1);
      if (n >= 0 && n < 3) return answer(url, 302, '', { location: `/r${n + 1}` });
      return answer(url, 200, 'landed');
    });
    const r = await request('https://a.example.org/r0');
    expect(r.text).toBe('landed');
    expect(r.url).toBe('https://a.example.org/r3');
    expect(seen).toEqual(['https://a.example.org/r0', 'https://a.example.org/r1', 'https://a.example.org/r2', 'https://a.example.org/r3']);
  });

  test('the first address goes out exactly as written (no re-encoding of apostrophes)', async () => {
    const seen = [];
    setTransport(async (url) => { seen.push(url); return answer(url); });
    await getText("https://decisions.example.ca/s?cont=%22Kevin%20O'Leary%22");
    expect(seen).toEqual(["https://decisions.example.ca/s?cont=%22Kevin%20O'Leary%22"]);
  });

  test('a sixth redirect is refused', async () => {
    let n = 0;
    setTransport(async (url) => { n += 1; return answer(url, 301, '', { location: `https://a.example.org/loop${n}` }); });
    await expect(request('https://a.example.org/start')).rejects.toMatchObject({ code: 'redirects' });
    expect(n).toBe(6); // the first request plus five hops
  });

  test('a redirect to a private, loopback or metadata address is never opened', async () => {
    for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:3009/api', 'http://[::1]/', 'http://10.0.0.5/', 'http://localhost/about', 'http://192.168.1.1/', 'http://100.64.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00:ec2::254]/', 'http://metadata.google.internal/', 'http://2130706433/']) {
      const seen = [];
      setTransport(async (url) => { seen.push(url); return answer(url, 302, '', { location: target }); });
      // eslint-disable-next-line no-await-in-loop
      await expect(request('https://short.example.org/x')).rejects.toMatchObject({ code: 'blocked', retryable: false });
      expect(seen).toEqual(['https://short.example.org/x']);
    }
  });

  test('the first address is checked too, and only http and https are opened', async () => {
    const seen = [];
    setTransport(async (url) => { seen.push(url); return answer(url); });
    await expect(request('http://127.0.0.1/')).rejects.toMatchObject({ code: 'blocked' });
    await expect(request('ftp://files.example.org/list.csv')).rejects.toMatchObject({ code: 'blocked' });
    await expect(request('http://user:pw@a.example.org/')).rejects.toMatchObject({ code: 'blocked' });
    expect(seen).toEqual([]);
  });

  test('a name that resolves into a private range is refused (resolver passed in, no network)', async () => {
    const seen = [];
    const lookup = async (host) => (host === 'evil.example.org' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
    setTransport(async (url) => { seen.push(url); return answer(url); }, { lookup });
    await expect(request('https://evil.example.org/')).rejects.toMatchObject({ code: 'blocked' });
    await expect(getText('https://good.example.org/')).resolves.toBe('ok');
    expect(seen).toEqual(['https://good.example.org/']);
  });

  test('checkTarget and addressProblem can be used on their own', async () => {
    expect(http.addressProblem('169.254.169.254')).toMatch(/link-local/);
    expect(http.addressProblem('::ffff:10.0.0.1')).toMatch(/private/);
    expect(http.addressProblem('8.8.8.8')).toBe('');
    expect(http.addressProblem('2606:4700:4700::1111')).toBe('');
    await expect(http.checkTarget('https://x.example.org/', { lookup: async () => [{ address: '::1', family: 6 }] })).rejects.toMatchObject({ code: 'blocked' });
    await expect(http.checkTarget('https://x.example.org/', { lookup: async () => [{ address: '1.1.1.1', family: 4 }] })).resolves.toBeInstanceOf(URL);
  });

  test('onHop sees every address and can refuse one before anything is sent to it', async () => {
    const seen = [];
    const hops = [];
    setTransport(async (url) => {
      seen.push(url);
      return url.includes('short') ? answer(url, 302, '', { location: 'https://www.linkedin.com/in/someone' }) : answer(url);
    });
    const onHop = (url, info) => { hops.push([url, info.hop, info.from]); return /linkedin\.com/.test(url) ? 'never opened' : true; };
    await expect(request('https://short.example.org/x', { onHop })).rejects.toMatchObject({ code: 'refused', hopUrl: 'https://www.linkedin.com/in/someone', message: 'never opened' });
    expect(seen).toEqual(['https://short.example.org/x']);
    expect(hops).toEqual([['https://short.example.org/x', 0, null], ['https://www.linkedin.com/in/someone', 1, 'https://short.example.org/x']]);
  });

  test('pacing applies to each hop host', async () => {
    setTransport(async (url) => (url.includes('start') ? answer(url, 302, '', { location: 'https://littlesis.org/b' }) : answer(url)), { paced: true });
    await getText('https://littlesis.org/a'); // books LittleSis's next slot 10 s ahead
    // The redirect lands on LittleSis again, whose turn is after this call's deadline
    await expect(getText('https://start.example.org/start', { deadline: Date.now() + 5000 })).rejects.toMatchObject({ code: 'deadline' });
  });

  test('a 303 after a POST continues as a GET without the body, and sign-in headers do not cross sites', async () => {
    const calls = [];
    setTransport(async (url, init) => {
      calls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization });
      return url.endsWith('/form') ? answer(url, 303, '', { location: 'https://other.example.org/result' }) : answer(url, 200, 'done');
    });
    await expect(getText('https://a.example.org/form', { method: 'POST', body: 'q=1', headers: { Authorization: 'x' } })).resolves.toBe('done');
    expect(calls[1]).toEqual({ url: 'https://other.example.org/result', method: 'GET', body: undefined, auth: undefined });
  });
});

describe('http R3: the body is read as a stream with a byte limit', () => {
  test('a chunked body with no Content-Length is dropped as soon as it passes the limit', async () => {
    const MB = new Uint8Array(1024 * 1024).fill(97);
    let pulled = 0;
    setTransport(async (url) => streamed(url, Array(21).fill(MB), {}, (i) => { pulled = i; }));
    await expect(request('https://big.example.org/', { maxBytes: 2 * 1024 * 1024 })).rejects.toMatchObject({ code: 'too-large' });
    expect(pulled).toBeLessThanOrEqual(4);
  });

  test('a streamed body within the limit is returned whole', async () => {
    const enc = new TextEncoder();
    setTransport(async (url) => streamed(url, [enc.encode('{"a":'), enc.encode('1}')], { 'content-type': 'application/json' }));
    await expect(getJson('https://api.example.org/x')).resolves.toEqual({ a: 1 });
  });

  test('getBytes returns the raw bytes with the same checks', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    setTransport(async (url) => streamed(url, [zip], { 'content-type': 'application/zip' }));
    const bytes = await http.getBytes('https://lists.example.org/list.zip');
    expect(Array.from(bytes)).toEqual(Array.from(zip));
    await expect(http.getBytes('http://127.0.0.1/list.zip')).rejects.toMatchObject({ code: 'blocked' });
  });
});

describe('http R3: text is decoded with the declared charset', () => {
  const latin1 = (s) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));

  test('a Latin-1 page declared in the header keeps its accented names', async () => {
    setTransport(async (url) => streamed(url, [latin1('<p>Jürgen Müller</p>')], { 'content-type': 'text/html; charset=ISO-8859-1' }));
    await expect(getText('https://team.example.de/')).resolves.toBe('<p>Jürgen Müller</p>');
  });

  test('a Latin-1 page declared only in its meta tag is decoded the same way', async () => {
    setTransport(async (url) => streamed(url, [latin1('<html><head><meta charset="windows-1252"></head><body>Zoë Ångström</body></html>')], { 'content-type': 'text/html' }));
    await expect(getText('https://team.example.fr/')).resolves.toContain('Zoë Ångström');
  });

  test('an undeclared page whose bytes are not UTF-8 falls back to windows-1252; UTF-8 stays UTF-8', async () => {
    setTransport(async (url) => streamed(url, [url.includes('old') ? latin1('José Núñez') : new TextEncoder().encode('José Núñez')], { 'content-type': 'text/html' }));
    await expect(getText('https://old.example.es/')).resolves.toBe('José Núñez');
    await expect(getText('https://new.example.es/')).resolves.toBe('José Núñez');
  });
});

describe('http R3: Retry-After', () => {
  test('a date is honoured as well as seconds', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    expect(http.retryAfterMs('Fri, 20 Nov 2026 12:02:00 GMT', now)).toBe(120000);
    expect(http.retryAfterMs('30', now)).toBe(30000);
    expect(http.retryAfterMs('Fri, 20 Nov 2026 11:00:00 GMT', now)).toBe(0);
    expect(http.retryAfterMs('', now)).toBe(0);
  });

  test('a 429 with a Retry-After date rests the host until that date', async () => {
    const until = new Date(Date.now() + 5 * 60000).toUTCString();
    setTransport(async (url) => answer(url, 429, '', { 'retry-after': until }), { paced: true });
    await expect(getText('https://slow.example.org/a', { retries: 0 })).rejects.toMatchObject({ status: 429 });
    const error = await getText('https://slow.example.org/b').catch((e) => e);
    expect(error.code).toBe('resting');
    expect(error.retryAt).toBeGreaterThan(Date.now() + 4 * 60000);
  });
});

describe('http R3: list downloads can retry a server error', () => {
  test('retryOn adds 500/502/504 to the statuses tried again', async () => {
    let n = 0;
    setTransport(async (url) => { n += 1; return answer(url, n === 1 ? 500 : 200, n === 1 ? 'oops' : 'csv'); });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const pending = getText('https://lists.example.org/ebrd.csv', { retryOn: [429, 500, 502, 503, 504] });
      await jest.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toBe('csv');
    } finally {
      jest.useRealTimers();
    }
    expect(n).toBe(2);
  });
});

describe('http R3: pacing for published crawl delays', () => {
  test('the UK ICO is spaced by its 6 second crawl delay', async () => {
    expect(http.HOST_GAP_MS['ico.org.uk']).toBe(6000);
    setTransport(async (url) => answer(url), { paced: true });
    await getText('https://ico.org.uk/api/search');
    await expect(getText('https://ico.org.uk/api/search?2', { deadline: Date.now() + 4000 })).rejects.toThrow(/Out of time before the request could start/);
  });
});

describe('http R3: htmlToText', () => {
  test.each([
    ['unclosed comment', '<!--'],
    ['unclosed script', '<script>'],
    ['unclosed style', '<style>'],
    ['lone angle brackets', '<'],
    ['carriage returns and spaces', '\r '],
  ])('runs in linear time on megabytes of %s', (_label, unit) => {
    const hostile = `<p>Jane Doe</p>${unit.repeat(Math.ceil((3 * 1024 * 1024) / unit.length))}`;
    const started = Date.now();
    const text = htmlToText(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text.startsWith('Jane Doe')).toBe(true);
  });

  test('keeps the old output for ordinary pages', () => {
    const html = '<html><head><style>p{}</style><script>var a="<p>x</p>";</script></head><body><!-- note --><h1>Team</h1><p>Jane&nbsp;Doe &amp; Co</p><br/>CEO<li>One</li><li>Two</li><SCRIPT type="x">bad()</SCRIPT >end</body></html>';
    expect(htmlToText(html)).toBe('Team\nJane Doe & Co\nCEO One\nTwo\nend');
  });

  test('decodes Latin-1 named entities and decodes only once', () => {
    expect(htmlToText('J&uuml;rgen M&uuml;ller, Ren&eacute;e &Aring;str&ouml;m')).toBe('Jürgen Müller, Renée Åström');
    expect(htmlToText('&amp;lt;b&amp;gt; &#252; &#xFC; &unknown;')).toBe('&lt;b&gt; ü ü &unknown;');
  });

  test('a literal "<" in text with no tag after it is kept', () => {
    expect(htmlToText('revenue < 5m and growing')).toBe('revenue < 5m and growing');
  });
});
