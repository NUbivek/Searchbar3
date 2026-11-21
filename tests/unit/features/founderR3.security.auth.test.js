/**
 * Round 3, security (src/server/auth.js): an optional allow-list of accounts that may sign in, which changes
 * nothing while it is empty; sessions issued before the list was set stop counting as signed in; a refused
 * account is never written to the database; and a small hit counter that works across server instances.
 */
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn(async () => null) }));
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(async () => []),
  persistenceMode: jest.fn(() => 'none'),
}));

const { getServerSession } = require('next-auth/next');
const db = require('../../../src/server/db');
const auth = require('../../../src/server/auth');
const { createMockReq, createMockRes } = require('../api/testUtils');

const google = (email, verified = true) => ({
  user: { id: 'g1', email, name: 'Someone' },
  account: { provider: 'google', providerAccountId: '123' },
  profile: { email, email_verified: verified },
});

describe('security-open-signup: an optional allow-list of accounts', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.clearAllMocks(); db.persistenceMode.mockReturnValue('none'); });

  test('the list takes whole addresses and domains, in any case, separated by commas, spaces or semicolons', () => {
    const list = auth.parseAllowList(' Owner@Example.com; @partner.org , team.example.net\nbad entry@ ');
    expect(list.emails).toEqual(['owner@example.com']);
    expect(list.domains).toEqual(['partner.org', 'team.example.net']);
    expect(auth.emailAllowed('OWNER@example.com', list)).toBe(true);
    expect(auth.emailAllowed('a@partner.org', list)).toBe(true);
    expect(auth.emailAllowed('a@sub.partner.org', list)).toBe(false); // a domain means that domain only
    expect(auth.emailAllowed('a@evilpartner.org', list)).toBe(false);
    expect(auth.emailAllowed('owner@example.com.evil.io', list)).toBe(false);
    expect(auth.emailAllowed('', list)).toBe(false);
  });

  test('an empty list lets everyone sign in, as before', async () => {
    delete process.env.FOUNDER_ALLOWED_EMAILS;
    expect(auth.allowListActive()).toBe(false);
    expect(await auth.authOptions.callbacks.signIn(google('stranger@gmail.com'))).toBe(true);
  });

  test('with a list, an account outside it is refused and never recorded', async () => {
    process.env.FOUNDER_ALLOWED_EMAILS = 'owner@example.com';
    db.persistenceMode.mockReturnValue('neon');
    expect(await auth.authOptions.callbacks.signIn(google('stranger@gmail.com'))).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(await auth.authOptions.callbacks.signIn(google('owner@example.com'))).toBe(true);
    expect(db.query).toHaveBeenCalled();
  });

  test('with a list, an address Google has not verified is refused', async () => {
    process.env.FOUNDER_ALLOWED_EMAILS = 'owner@example.com';
    expect(await auth.authOptions.callbacks.signIn(google('owner@example.com', false))).toBe(false);
  });

  test('a session from before the list was set stops counting as signed in', async () => {
    process.env.FOUNDER_ALLOWED_EMAILS = '@example.com';
    getServerSession.mockResolvedValue({ user: { id: 'google:1', email: 'stranger@gmail.com' } });
    expect(await auth.getUserId(createMockReq(), createMockRes())).toBeNull();
    expect(await auth.getUserEmail(createMockReq(), createMockRes())).toBe('');
    getServerSession.mockResolvedValue({ user: { id: 'google:2', email: 'owner@example.com' } });
    expect(await auth.getUserId(createMockReq(), createMockRes())).toBe('google:2');
    delete process.env.FOUNDER_ALLOWED_EMAILS;
    getServerSession.mockResolvedValue({ user: { id: 'google:1', email: 'stranger@gmail.com' } });
    expect(await auth.getUserId(createMockReq(), createMockRes())).toBe('google:1');
  });

  test('requireFounderUser: 401 when signed out, 403 with a plain message for an account outside the list', async () => {
    process.env.FOUNDER_ALLOWED_EMAILS = 'owner@example.com';
    getServerSession.mockResolvedValue(null);
    const out = createMockRes();
    expect(await auth.requireFounderUser(createMockReq(), out)).toBeNull();
    expect(out.statusCode).toBe(401);
    getServerSession.mockResolvedValue({ user: { id: 'google:1', email: 'stranger@gmail.com' } });
    const refused = createMockRes();
    expect(await auth.requireFounderUser(createMockReq(), refused)).toBeNull();
    expect(refused.statusCode).toBe(403);
    expect(refused.body.error).toMatch(/not enabled for this account/);
    expect(refused.body.error).not.toMatch(/\b(api|key|token|free|paid|tier|quota)\b/i);
    getServerSession.mockResolvedValue({ user: { id: 'google:2', email: 'owner@example.com' } });
    expect(await auth.requireFounderUser(createMockReq(), createMockRes())).toBe('google:2');
  });
});

describe('takeSlot: a small hit counter', () => {
  afterEach(() => { jest.clearAllMocks(); db.persistenceMode.mockReturnValue('none'); });

  test('without a database it counts in memory and refuses past the limit', async () => {
    const who = `mem-${Math.random()}`;
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await auth.takeSlot('test-bucket', who, { max: 3, windowMs: 60000 }));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3].retryAfter).toBeGreaterThan(0);
    expect((await auth.takeSlot('test-bucket', `${who}-other`, { max: 3, windowMs: 60000 })).ok).toBe(true);
  });

  test('with a database it counts there, so every server instance sees the same count, and never stores the raw caller', async () => {
    db.persistenceMode.mockReturnValue('neon');
    db.query.mockImplementation(async (sql) => (/RETURNING/.test(sql) ? [{ tries: 7 }] : []));
    const out = await auth.takeSlot('debug', '203.0.113.9', { max: 6, windowMs: 3600000 });
    expect(out.ok).toBe(false);
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO learning_stats/.test(sql));
    expect(insert[1][0]).toBe('rate:debug');
    expect(JSON.stringify(insert[1])).not.toContain('203.0.113.9');
  });

  test('a database failure falls back to the in-memory count rather than letting everything through or nothing', async () => {
    db.persistenceMode.mockReturnValue('neon');
    db.query.mockRejectedValue(new Error('down'));
    const who = `fail-${Math.random()}`;
    expect((await auth.takeSlot('b', who, { max: 1, windowMs: 60000 })).ok).toBe(true);
    expect((await auth.takeSlot('b', who, { max: 1, windowMs: 60000 })).ok).toBe(false);
  });
});
