/**
 * Round 3, jobStore.js: one request at a time per check (a lease, in memory and in the database), copies
 * that are never shared between requests, the 72-hour retention enforced on read, and the lookups the
 * page needs to pick a check up again (latest job of a person, recent jobs of an account).
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  persistenceMode: jest.fn(() => 'none'),
}));

const db = require('../../../src/server/db');
const store = require('../../../src/server/founder/jobStore');

beforeEach(() => {
  store.__resetJobsForTests();
  db.query.mockReset().mockImplementation(async () => []);
  db.queryOne.mockReset().mockImplementation(async () => null);
  db.persistenceMode.mockReset().mockImplementation(() => 'none');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => console.warn.mockRestore());

describe('in memory', () => {
  test('two reads never share one state object, and a stale save is refused', async () => {
    const { id } = await store.createJob({ name: 'Ada Quill', owner: 'u1', state: { rev: 0, tasksRun: 0 } });
    const a = await store.getJob(id, { owner: 'u1' });
    const b = await store.getJob(id, { owner: 'u1' });
    expect(a.state).not.toBe(b.state);
    a.state.tasksRun = 5;
    expect((await store.getJob(id, { owner: 'u1' })).state.tasksRun).toBe(0); // nothing changes until saved
    a.state.rev = 1;
    expect(await store.saveJob(id, { state: a.state, expectRev: 0 })).toBe(true);
    b.state.rev = 1;
    expect(await store.saveJob(id, { state: b.state, expectRev: 0 })).toBe(false); // the other request got there first
    expect((await store.getJob(id, { owner: 'u1' })).state.tasksRun).toBe(5);
  });

  test('one request at a time holds a check; a save or a release ends the hold', async () => {
    const { id } = await store.createJob({ name: 'Ada Quill', owner: 'u1', state: { rev: 0 } });
    const first = await store.leaseJob(id, { owner: 'u1' });
    expect(first.job.state).toEqual({ rev: 0 });
    expect(await store.leaseJob(id, { owner: 'u1' })).toEqual({ busy: true });
    expect(await store.leaseJob(id, { owner: 'u2' })).toBeNull(); // another account never learns it exists
    await store.saveJob(id, { state: { rev: 1 }, expectRev: 0 });
    const second = await store.leaseJob(id, { owner: 'u1' });
    expect(second.job.state).toEqual({ rev: 1 });
    await store.releaseLease(id, second.leaseId);
    expect(await store.leaseJob(id, { owner: 'u1' })).toHaveProperty('job');
  });

  test('a lease that ran out can be taken again', async () => {
    const { id } = await store.createJob({ name: 'Ada Quill', owner: 'u1', state: {} });
    await store.leaseJob(id, { owner: 'u1', ms: -1 });
    expect(await store.leaseJob(id, { owner: 'u1' })).toHaveProperty('job');
  });

  test('a check past 72 hours is not served, even when no new check is started', async () => {
    const { id } = await store.createJob({ name: 'Ada Quill', owner: 'u1', state: {} });
    store.__ageJobForTests(id, 73 * 3600 * 1000);
    expect(await store.getJob(id, { owner: 'u1' })).toBeNull();
    expect(await store.listJobs('u1')).toEqual([]);
    expect(await store.leaseJob(id, { owner: 'u1' })).toBeNull();
  });

  test('the latest check of a person, and the recent checks of an account, scoped to the account', async () => {
    const one = await store.createJob({ name: 'Ada Quill', company: 'Acme', owner: 'u1', state: { report: { totals: { redFlags: 2 } } } });
    await store.saveJob(one.id, { state: { report: { totals: { redFlags: 2 } } }, status: 'done' });
    store.__ageJobForTests(one.id, 1000); // started a second earlier
    const two = await store.createJob({ name: 'Ada Quill', company: 'Acme', owner: 'u1', state: { phase: 'collect' } });
    await store.createJob({ name: 'Ada Quill', company: 'Acme', owner: 'u2', state: {} });
    expect((await store.findLatestJob('u1', { name: 'ada quill', company: 'ACME' })).id).toBe(two.id);
    expect((await store.findLatestJob('u1', { name: 'Ada Quill', company: 'Acme', status: 'done' })).id).toBe(one.id);
    expect(await store.findLatestJob('u1', { name: 'Ada Quill', company: '' })).toBeNull();
    const list = await store.listJobs('u1');
    expect(list.map((j) => j.id).sort()).toEqual([one.id, two.id].sort());
    expect(list.find((j) => j.id === one.id)).toMatchObject({ name: 'Ada Quill', company: 'Acme', status: 'done', redFlags: 2 });
    expect(list[0]).not.toHaveProperty('state');
  });
});

describe('with a database', () => {
  beforeEach(() => db.persistenceMode.mockImplementation(() => 'neon'));

  test('the lease is taken in one statement, and a check held elsewhere is busy, not missing', async () => {
    const row = { id: 'j1', user_id: 'u1', name: 'Ada Quill', company: null, status: 'running', state: { rev: 3, leaseUntil: 1, leaseId: 'x' }, created_at: new Date(), updated_at: new Date() };
    db.query.mockImplementation(async (sql) => (sql.includes('leaseUntil') && sql.startsWith('UPDATE') ? [row] : []));
    const got = await store.leaseJob('j1', { owner: 'u1' });
    expect(got.job.state).toEqual({ rev: 3 }); // the lease is never part of the state a caller sees
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/COALESCE\(\(state->>'leaseUntil'\)::bigint, 0\) < \$5/);
    expect(sql).toMatch(/updated_at > now\(\) - interval '72 hours'/);
    // held: no row taken, but the check exists
    db.query.mockImplementation(async () => []);
    db.queryOne.mockImplementation(async () => row);
    expect(await store.leaseJob('j1', { owner: 'u1' })).toEqual({ busy: true });
    db.queryOne.mockImplementation(async () => null);
    expect(await store.leaseJob('j1', { owner: 'u1' })).toBeNull();
  });

  test('reads are held to the retention period, and old rows are deleted on read, not only on start', async () => {
    await store.getJob('j1', { owner: 'u1' });
    expect(db.queryOne.mock.calls[0][0]).toMatch(/updated_at > now\(\) - interval '72 hours'/);
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM founder_jobs WHERE updated_at <'))).toBe(true);
    // a row older than that from a copy that did not filter is still not served
    db.queryOne.mockImplementation(async () => ({ id: 'j1', user_id: 'u1', name: 'A B', company: null, status: 'done', state: '{}', created_at: new Date(0), updated_at: new Date(Date.now() - 80 * 3600 * 1000) }));
    expect(await store.getJob('j1', { owner: 'u1' })).toBeNull();
  });

  test('a save writes the state without the lease, which ends it', async () => {
    await store.saveJob('j1', { state: { rev: 1, leaseUntil: 5, leaseId: 'x' }, expectRev: 0 });
    const [, params] = db.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'));
    expect(JSON.parse(params[1])).toEqual({ rev: 1 });
  });
});
