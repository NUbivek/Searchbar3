/**
 * Watchlist alerts: classification, 90-day window, case-sensitive name
 * matching, backfill cap, cron runner and cron auth.
 */
jest.mock('../../../src/utils/sources/curatedIndex', () => ({ searchCuratedSources: jest.fn() }));
jest.mock('../../../src/utils/sources/hackernewsAlgolia', () => ({ searchHackerNews: jest.fn() }));
jest.mock('../../../src/server/store', () => ({ dueWatches: jest.fn(), recordWatchCheck: jest.fn() }));
jest.mock('../../../src/server/db', () => ({
  PersistenceUnavailableError: class PersistenceUnavailableError extends Error {},
  query: jest.fn(async () => []),
}));

const { searchCuratedSources } = require('../../../src/utils/sources/curatedIndex');
const { searchHackerNews } = require('../../../src/utils/sources/hackernewsAlgolia');
const store = require('../../../src/server/store');
const {
  classifyAlert, selectAlertItems, checkWatch, runDueWatchChecks, companyMatcher, BACKFILL_LIMIT,
  renderAlertDigest, sendAlertDigest, emailAlertsConfigured,
} = require('../../../src/server/watchlist');
const db = require('../../../src/server/db');
const cron = require('../../../src/pages/api/cron/watchlists');

const NOW = Date.parse('2026-11-06T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

describe('classifyAlert', () => {
  test.each([
    ['Mistral raises €1.7B Series C led by ASML', 'funding'],
    ['Mistral secures $600M at a $6B valuation', 'funding'],
    ['Anthropic hires former Stripe executive as CFO', 'people'],
    ['Mistral co-founder steps down', 'people'],
    ['Anthropic sued by music publishers over lyrics', 'filing'],
    ['Mistral files S-1 for IPO', 'filing'],
    ['EU regulators open probe into Anthropic deal', 'filing'],
    ['Mistral releases new open-weight model', 'press'],
    ['Mistral fine-tunes model for coding', 'press'],
  ])('%s -> %s', (title, kind) => {
    expect(classifyAlert({ title })).toBe(kind);
  });

  test('portfolio listings are portfolio regardless of title', () => {
    expect(classifyAlert({ title: 'Mistral raises (portfolio: Lightspeed)', type: 'portfolio_listing' })).toBe('portfolio');
  });
});

describe('selectAlertItems', () => {
  test('requires a case-sensitive, word-bounded mention of the company', () => {
    const items = [
      { title: 'Ramp raises $150M', url: 'https://a.com/1', publishedAt: daysAgo(1) },
      { title: 'Companies ramp up AI spending', url: 'https://a.com/2', publishedAt: daysAgo(1) },
      { title: 'Rampage of startups', url: 'https://a.com/3', publishedAt: daysAgo(1) },
      { title: 'Fintech news', content: 'Today Ramp announced a product', url: 'https://a.com/4', publishedAt: daysAgo(2) },
    ];
    const out = selectAlertItems('Ramp', items, { now: NOW });
    expect(out.map((a) => a.url)).toEqual(['https://a.com/1', 'https://a.com/4']);
  });

  test('an all-lowercase name also matches its capitalized form', () => {
    expect(companyMatcher('mistral')('Mistral ships Le Chat')).toBe(true);
    expect(companyMatcher('Mistral')('mistral wind')).toBe(false);
  });

  test('drops items older than 90 days and undated non-portfolio items', () => {
    const items = [
      { title: 'Mistral news fresh', url: 'https://a.com/new', publishedAt: daysAgo(10) },
      { title: 'Mistral news old', url: 'https://a.com/old', publishedAt: daysAgo(120) },
      { title: 'Mistral news undated', url: 'https://a.com/undated' },
      { title: 'Mistral (portfolio: Lightspeed)', url: 'https://lsvp.com/portfolio', type: 'portfolio_listing', publishedAt: null, sourceName: 'Lightspeed Portfolio' },
      { title: 'Mistral HN', url: 'https://hn.com/x', source: 'hackernews', timestamp: daysAgo(89) },
    ];
    const out = selectAlertItems('Mistral', items, { now: NOW });
    expect(out.map((a) => a.url)).toEqual(['https://a.com/new', 'https://hn.com/x', 'https://lsvp.com/portfolio']);
    expect(out[1].sourceName).toBe('Hacker News');
    expect(out[2]).toMatchObject({ kind: 'portfolio', publishedAt: null, sourceName: 'Lightspeed Portfolio' });
  });

  test('requires an http(s) link and dedupes by URL', () => {
    const items = [
      { title: 'Mistral A', url: 'https://a.com/1', publishedAt: daysAgo(1) },
      { title: 'Mistral A again', url: 'https://a.com/1', publishedAt: daysAgo(1) },
      { title: 'Mistral no link', url: '', publishedAt: daysAgo(1) },
      { title: 'Mistral js', url: 'javascript:alert(1)', publishedAt: daysAgo(1) },
    ];
    expect(selectAlertItems('Mistral', items, { now: NOW })).toHaveLength(1);
  });
});

describe('checkWatch', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    title: `Mistral update ${i}`, url: `https://news.com/${i}`, publishedAt: daysAgo(i + 1), sourceName: 'News',
  }));

  beforeEach(() => {
    searchCuratedSources.mockResolvedValue(many);
    searchHackerNews.mockResolvedValue([]);
  });

  test('first check backfills at most 10 most recent items', async () => {
    const out = await checkWatch({ id: 'w', company: 'Mistral', last_checked_at: null }, { now: NOW });
    expect(out).toHaveLength(BACKFILL_LIMIT);
    expect(out[0].url).toBe('https://news.com/0');
    expect(out[9].url).toBe('https://news.com/9');
  });

  test('later checks allow more items', async () => {
    const out = await checkWatch({ id: 'w', company: 'Mistral', last_checked_at: daysAgo(1) }, { now: NOW });
    expect(out.length).toBeGreaterThan(BACKFILL_LIMIT);
  });

  test('one failing source does not stop the other; both failing throws', async () => {
    searchHackerNews.mockRejectedValue(new Error('down'));
    await expect(checkWatch({ company: 'Mistral', last_checked_at: null }, { now: NOW })).resolves.toHaveLength(10);
    searchCuratedSources.mockRejectedValue(new Error('down'));
    await expect(checkWatch({ company: 'Mistral' }, { now: NOW })).rejects.toThrow('Sources unavailable');
  });
});

describe('runDueWatchChecks', () => {
  test('checks due watches, records alerts, counts errors', async () => {
    store.dueWatches.mockResolvedValue([
      { id: '1', user_id: 'u', company: 'Mistral' },
      { id: '2', user_id: 'u', company: 'Anthropic' },
    ]);
    searchCuratedSources.mockImplementation(async (q) => {
      if (q === 'Anthropic') throw new Error('x');
      return [{ title: 'Mistral raises $1B', url: 'https://n.com/m', publishedAt: new Date().toISOString() }];
    });
    searchHackerNews.mockImplementation(async (q) => { if (q === 'Anthropic') throw new Error('y'); return []; });
    store.recordWatchCheck.mockResolvedValue(1);
    const r = await runDueWatchChecks({ limit: 25, olderThanMinutes: 360 });
    expect(store.dueWatches).toHaveBeenCalledWith(360, 25);
    expect(r).toMatchObject({ due: 2, checked: 1, alertsCreated: 1, errors: 1, emailsSent: 0, emailConfigured: false });
    expect(store.recordWatchCheck.mock.calls[0][1][0]).toMatchObject({ kind: 'funding', url: 'https://n.com/m' });
    expect(db.query).not.toHaveBeenCalled(); // no email configured: no lookups
  });

  test('emails one digest per user with new alerts when RESEND_API_KEY is set', async () => {
    const env = { ...process.env };
    process.env.RESEND_API_KEY = 're_test';
    process.env.NEXTAUTH_URL = 'https://hub.example';
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ id: 'email_1' }) }));
    global.fetch = fetchMock;
    try {
      store.dueWatches.mockResolvedValue([
        { id: 'w1', user_id: 'u1', company: 'Mistral' },
        { id: 'w2', user_id: 'u1', company: 'Ramp' },
        { id: 'w3', user_id: 'u2', company: 'Deel' },
      ]);
      searchCuratedSources.mockResolvedValue([{ title: 'Mistral raises $1B', url: 'https://n.com/m', publishedAt: new Date().toISOString() }]);
      searchHackerNews.mockResolvedValue([]);
      // Mistral and Deel create alerts; Ramp finds nothing new
      store.recordWatchCheck.mockImplementation(async (watch) => (watch.company === 'Ramp' ? 0 : 1));
      db.query.mockImplementation(async (sql, params) => {
        if (/FROM alerts/.test(sql)) return [{ kind: 'funding', title: `${params[0]} news`, url: `https://n.com/${params[0]}`, sourceName: 'News', publishedAt: '2026-11-06T00:00:00Z' }];
        if (/FROM users/.test(sql)) return params[0] === 'u1' ? [{ email: 'one@example.com' }] : [{ email: null }];
        return [];
      });
      const r = await runDueWatchChecks({ limit: 25, olderThanMinutes: 360 });
      expect(r).toMatchObject({ checked: 3, alertsCreated: 2, emailsSent: 1, emailErrors: 0, emailConfigured: true });
      expect(fetchMock).toHaveBeenCalledTimes(1); // u2 has no email address
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.resend.com/emails');
      expect(init.headers.Authorization).toBe('Bearer re_test');
      const body = JSON.parse(init.body);
      expect(body.to).toEqual(['one@example.com']);
      expect(body.subject).toBe('1 new alert: Mistral');
      expect(body.text).toMatch(/Mistral \(1\)[\s\S]*\[Funding\] w1 news \(News, 2026-11-06\)[\s\S]*https:\/\/n\.com\/w1[\s\S]*https:\/\/hub\.example\/watchlist/);
      expect(body.html).toMatch(/<a href="https:\/\/n\.com\/w1">w1 news<\/a>/);
      expect(body.text).not.toMatch(/Ramp/);
    } finally {
      process.env = env;
      delete global.fetch;
    }
  });

  test('a failed email is counted, never thrown, and the key is not logged', async () => {
    const env = { ...process.env };
    process.env.RESEND_API_KEY = 're_secret_value';
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      store.dueWatches.mockResolvedValue([{ id: 'w1', user_id: 'u1', company: 'Mistral' }]);
      searchCuratedSources.mockResolvedValue([{ title: 'Mistral raises $1B', url: 'https://n.com/m', publishedAt: new Date().toISOString() }]);
      searchHackerNews.mockResolvedValue([]);
      store.recordWatchCheck.mockResolvedValue(1);
      db.query.mockImplementation(async (sql) => (/FROM alerts/.test(sql) ? [{ kind: 'press', title: 't', url: 'https://n.com/t' }] : [{ email: 'a@b.c' }]));
      global.fetch = jest.fn(async () => ({ ok: false, status: 422, json: async () => ({ message: 'Invalid from address' }) }));
      const r = await runDueWatchChecks({});
      expect(r).toMatchObject({ emailsSent: 0, emailErrors: 1 });
      expect(JSON.stringify(errors.mock.calls)).not.toMatch(/re_secret_value/);
      expect(JSON.stringify(errors.mock.calls)).toMatch(/422: Invalid from address/);
    } finally {
      process.env = env;
      delete global.fetch;
      errors.mockRestore();
    }
  });
});

describe('alert digest', () => {
  test('renderAlertDigest escapes HTML and caps items per company', () => {
    const alerts = Array.from({ length: 12 }, (_, i) => ({ kind: 'press', title: `<b>Item ${i}</b>`, url: `https://n.com/${i}` }));
    const d = renderAlertDigest([{ company: 'Acme <Co>', alerts }], { baseUrl: 'https://hub.example/' });
    expect(d.total).toBe(12);
    expect(d.subject).toBe('12 new alerts: Acme <Co>');
    expect(d.html).toContain('Acme &lt;Co&gt;');
    expect(d.html).toContain('&lt;b&gt;Item 0&lt;/b&gt;');
    expect(d.html).not.toContain('<b>Item');
    expect(d.html).toContain('and 2 more');
    expect(d.text).toContain('and 2 more');
    expect(d.text).toContain('https://hub.example/watchlist');
  });

  test('sendAlertDigest refuses without a key and skips empty digests', async () => {
    const env = { ...process.env };
    delete process.env.RESEND_API_KEY;
    try {
      expect(emailAlertsConfigured()).toBe(false);
      await expect(sendAlertDigest({ to: 'a@b.c', companies: [] })).rejects.toThrow(/not enabled/);
      process.env.RESEND_API_KEY = 'x';
      const f = jest.fn();
      expect(await sendAlertDigest({ to: 'a@b.c', companies: [{ company: 'A', alerts: [] }] }, { fetchImpl: f })).toBe(false);
      expect(f).not.toHaveBeenCalled();
    } finally {
      process.env = env;
    }
  });
});

describe('cron auth', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  test('401 without the secret in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CRON_SECRET = 's3cret';
    const res = mockRes();
    await cron.default({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(401);
    const res2 = mockRes();
    await cron.default({ method: 'GET', headers: { authorization: 'Bearer wrong!' } }, res2);
    expect(res2.statusCode).toBe(401);
  });

  test('401 in production when CRON_SECRET is unset', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CRON_SECRET;
    const res = mockRes();
    await cron.default({ method: 'GET', headers: { authorization: 'Bearer undefined' } }, res);
    expect(res.statusCode).toBe(401);
  });

  test('runs with the right bearer token', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CRON_SECRET = 's3cret';
    store.dueWatches.mockResolvedValue([]);
    const res = mockRes();
    await cron.default({ method: 'GET', headers: { authorization: 'Bearer s3cret' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, due: 0, checked: 0 });
  });

  test('allowed without secret in development', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CRON_SECRET;
    expect(cron.isAuthorizedCron({ headers: {} })).toBe(true);
  });
});

describe('regressions from live data', () => {
  test('revenue figures are not funding', () => {
    expect(classifyAlert({ title: 'Learnings from Anthropic at $17 Billion in Quarterly Revenue' })).toBe('press');
  });
  test('same story with trailing slash/backslash is one alert', () => {
    const items = [
      { title: 'Introducing Mistral Large 4', url: 'https://mistral.ai/news/mistral-large-4/', publishedAt: daysAgo(3) },
      { title: 'Mistral Large 4', url: 'https://mistral.ai/news/mistral-large-4/\\', publishedAt: daysAgo(3) },
    ];
    const out = selectAlertItems('Mistral', items, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://mistral.ai/news/mistral-large-4/');
  });
});
