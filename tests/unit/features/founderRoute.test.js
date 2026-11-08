/**
 * /api/founder route: validation, name normalisation and backchannel
 * references (network gating and company list).
 */
jest.mock('../../../src/server/founderCheck', () => {
  const actual = jest.requireActual('../../../src/server/founderCheck');
  return { ...actual, runFounderCheck: jest.fn() };
});
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => null) }));
jest.mock('../../../src/server/network/store', () => ({
  countContacts: jest.fn(async () => 0),
  findContactsAtCompanies: jest.fn(async () => []),
}));

const handler = require('../../../src/pages/api/founder').default;
const { runFounderCheck } = require('../../../src/server/founderCheck');
const { getUserId } = require('../../../src/server/auth');
const store = require('../../../src/server/network/store');

function call(query, method = 'GET') {
  const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  return handler({ method, query }, res).then(() => res);
}

const RESULT = {
  name: 'Jane Doe', company: null, sources: [{ n: 1 }], currentRole: { role: 'CEO', company: 'Acme Robotics' },
  profiles: [{ company: 'Acme Robotics' }], pastCompanies: [{ company: 'Initech' }], timeline: [], litigation: [], press: [], mentions: [], education: [],
};

beforeEach(() => {
  runFounderCheck.mockReset().mockResolvedValue(RESULT);
  getUserId.mockReset().mockResolvedValue(null);
  store.countContacts.mockReset().mockResolvedValue(0);
  store.findContactsAtCompanies.mockReset().mockResolvedValue([]);
});

describe('/api/founder', () => {
  test('validation: 405, missing name, single word, too long', async () => {
    expect((await call({}, 'POST')).statusCode).toBe(405);
    expect((await call({})).statusCode).toBe(400);
    expect((await call({ name: 'Madonna' })).body.error).toMatch(/full name/);
    expect((await call({ name: 'A'.repeat(121) + ' B' })).statusCode).toBe(400);
    expect((await call({ name: 'Jane Doe', company: 'C'.repeat(121) })).statusCode).toBe(400);
    expect(runFounderCheck).not.toHaveBeenCalled();
  });

  test('quotes and possessives are stripped before the check runs', async () => {
    const res = await call({ name: '"Jane" Doe\'s' });
    expect(res.statusCode).toBe(200);
    expect(runFounderCheck).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jane Doe' }));
  });

  test('signed out: references unavailable with a sign-in reason', async () => {
    const res = await call({ name: 'Jane Doe' });
    expect(res.body.references).toEqual({ available: false, reason: expect.stringMatching(/Sign in/) });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('signed in with no imported network: says so instead of "nobody works there"', async () => {
    getUserId.mockResolvedValue('user-1');
    const res = await call({ name: 'Jane Doe' });
    expect(res.body.references.available).toBe(false);
    expect(res.body.references.reason).toMatch(/Import your network/);
    expect(store.findContactsAtCompanies).not.toHaveBeenCalled();
  });

  test('signed in with contacts: current role, profile and past companies are all checked; count reported', async () => {
    getUserId.mockResolvedValue('user-1');
    store.countContacts.mockResolvedValue(1240);
    store.findContactsAtCompanies.mockResolvedValue([{ name: 'Sam Ref', company: 'Initech', matchedCompany: 'Initech' }]);
    const res = await call({ name: 'Jane Doe', company: 'Acme Robotics, Inc.' });
    expect(store.findContactsAtCompanies).toHaveBeenCalledWith('user-1', ['Acme Robotics, Inc.', 'Acme Robotics', 'Initech']);
    expect(res.body.references).toEqual({ available: true, checked: 1240, companies: ['Acme Robotics, Inc.', 'Acme Robotics', 'Initech'], contacts: [expect.objectContaining({ name: 'Sam Ref' })] });
  });

  test('signed in with contacts but no company found: explains why nothing was matched', async () => {
    getUserId.mockResolvedValue('user-1');
    store.countContacts.mockResolvedValue(10);
    runFounderCheck.mockResolvedValue({ ...RESULT, currentRole: null, profiles: [], pastCompanies: [] });
    const res = await call({ name: 'Jane Doe' });
    expect(res.body.references).toEqual(expect.objectContaining({ available: true, contacts: [], reason: expect.stringMatching(/No company could be found/) }));
    expect(store.findContactsAtCompanies).not.toHaveBeenCalled();
  });

  test('a failing check returns 500 without leaking the error', async () => {
    runFounderCheck.mockRejectedValue(new Error('boom secret'));
    const res = await call({ name: 'Jane Doe' });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret/);
  });
});
