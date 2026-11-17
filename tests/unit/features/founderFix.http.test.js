const { request, getText, setTransport, userAgent, USER_AGENT } = require('../../../src/server/founder/http');

const headersOf = (obj = {}) => new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), String(v)]));
const answer = (url, status = 200, text = 'ok', headers = {}) => ({ status, headers: headersOf(headers), url, text: async () => text });

afterEach(() => {
  setTransport();
  delete process.env.FOUNDER_HTTP_CONTACT;
});

describe('http: a host that says "slow down" is left alone', () => {
  test('a final 429 rests the host: the next call is turned down at once and sends nothing', async () => {
    const seen = [];
    setTransport(async (url) => { seen.push(url); return answer(url, url.endsWith('/a429') ? 429 : 200); }, { paced: true });
    await expect(getText('https://patents.google.com/a429', { retries: 0 })).rejects.toMatchObject({ status: 429 });
    const started = Date.now();
    await expect(getText('https://patents.google.com/b')).rejects.toThrow(/is being left alone/);
    expect(Date.now() - started).toBeLessThan(500);
    expect(seen).toEqual(['https://patents.google.com/a429']);
    // other hosts are not affected
    await expect(getText('https://example.org/x')).resolves.toBe('ok');
  });

  test('403 and 503 rest the host too; the rested call is retryable', async () => {
    setTransport(async (url) => answer(url, url.includes('forbid') ? 403 : 503), { paced: true });
    await expect(getText('https://a.example.org/forbid', { retries: 0 })).rejects.toMatchObject({ status: 403 });
    await expect(getText('https://a.example.org/next')).rejects.toMatchObject({ retryable: true });
    await expect(getText('https://b.example.org/down', { retries: 0 })).rejects.toMatchObject({ status: 503 });
    await expect(getText('https://b.example.org/next')).rejects.toThrow(/being left alone/);
  });

  test('an unpaced fake network is never rested', async () => {
    let n = 0;
    setTransport(async (url) => { n += 1; return answer(url, n === 1 ? 429 : 200); });
    await expect(getText('https://patents.google.com/a', { retries: 0 })).rejects.toMatchObject({ status: 429 });
    await expect(getText('https://patents.google.com/b')).resolves.toBe('ok');
  });
});

describe('http: turned-away calls do not book a slot', () => {
  test('calls that cannot start before their deadline leave the host queue as it was', async () => {
    setTransport(async (url) => answer(url), { paced: true });
    await getText('https://api.gdeltproject.org/first'); // books the next slot ~5.2 s ahead
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(getText('https://api.gdeltproject.org/late', { deadline: Date.now() + 3000 })).rejects.toThrow(/Out of time before the request could start/);
    }
    // Before the fix each rejection pushed the slot ~5.2 s further back, so this
    // call (deadline 7 s away) would also have been turned away.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const pending = getText('https://api.gdeltproject.org/ok', { deadline: Date.now() + 7000 });
      await jest.advanceTimersByTimeAsync(6000);
      await expect(pending).resolves.toBe('ok');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('http: user agent', () => {
  test('the default is generic, honest and carries no owner details', async () => {
    let sent = null;
    setTransport(async (url, init) => { sent = init.headers['User-Agent']; return answer(url); });
    await getText('https://example.org/');
    expect(sent).toBe(USER_AGENT);
    expect(sent).not.toMatch(/Mozilla|sec\.gov|@/);
  });

  test('a contact the owner declares is appended, cleaned of line breaks', async () => {
    process.env.FOUNDER_HTTP_CONTACT = 'https://research.example.com/bot\r\nX-Evil: 1';
    let sent = null;
    setTransport(async (url, init) => { sent = init.headers['User-Agent']; return answer(url); });
    await getText('https://example.org/');
    expect(sent).toBe(userAgent());
    expect(sent).toContain('+https://research.example.com/bot X-Evil: 1');
    expect(sent).not.toMatch(/[\r\n]/);
  });
});

describe('http: pacing for hosts with a published crawl delay', () => {
  test('LittleSis and The Gazette are spaced by their 10 second crawl delay', async () => {
    setTransport(async (url) => answer(url), { paced: true });
    for (const host of ['littlesis.org', 'www.thegazette.co.uk']) {
      // eslint-disable-next-line no-await-in-loop
      await getText(`https://${host}/a`);
      // a second call with only 5 s left cannot get its turn
      // eslint-disable-next-line no-await-in-loop
      await expect(getText(`https://${host}/b`, { deadline: Date.now() + 5000 })).rejects.toThrow(/Out of time before the request could start/);
    }
  });
});

describe('http: body size', () => {
  test('a declared Content-Length over the limit is refused without reading the body', async () => {
    let read = false;
    setTransport(async (url) => ({ status: 200, headers: headersOf({ 'content-length': 20 * 1024 * 1024 }), url, text: async () => { read = true; return 'x'; } }));
    await expect(request('https://lists.example.org/all.json')).rejects.toThrow(/larger than 8 MB/);
    expect(read).toBe(false);
  });

  test('a body within the limit is read as usual', async () => {
    setTransport(async (url) => answer(url, 200, 'small', { 'content-length': 5 }));
    await expect(getText('https://lists.example.org/small.json')).resolves.toBe('small');
  });
});
