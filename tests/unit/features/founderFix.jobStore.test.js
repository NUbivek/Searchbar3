/**
 * jobStore fixes: text that Postgres JSONB refuses is cleaned before saving,
 * a failed database write or read is reported instead of swallowed, and with
 * a database no job is kept in (possibly stale) instance memory.
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  persistenceMode: jest.fn(() => 'neon'),
}));

const db = require('../../../src/server/db');
const { createJob, getJob, saveJob, recentJobCount, toStoredJson, __resetJobsForTests } = require('../../../src/server/founder/jobStore');

// What Postgres JSONB rejects: a \u0000 escape, or an escaped surrogate that is not part of a pair.
const jsonbRejects = (text) => /\\u0000/i.test(text)
  || /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/i.test(text)
  || /(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(text)
  || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
  || text.includes('\u0000');

beforeEach(() => {
  __resetJobsForTests();
  db.query.mockReset().mockImplementation(async () => []);
  db.queryOne.mockReset().mockImplementation(async () => null);
  db.persistenceMode.mockReset().mockImplementation(() => 'neon');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => console.warn.mockRestore());

describe('toStoredJson', () => {
  test('removes NUL and replaces half surrogate pairs, keeps whole emoji', () => {
    const state = { findings: [{ title: `${'a'.repeat(5)}\uD83D`, quote: 'x\u0000y', note: 'ok 😀', lone: '\uDE00z' }], n: 3 };
    const text = toStoredJson(state);
    expect(JSON.stringify(state)).toMatch(/\\u0000|\\ud83d/i); // the plain way would be refused
    expect(jsonbRejects(text)).toBe(false);
    const back = JSON.parse(text);
    expect(back.findings[0].quote).toBe('xy');
    expect(back.findings[0].note).toBe('ok 😀');
    expect(back.findings[0].title).toBe('aaaaa�');
    expect(back.findings[0].lone).toBe('�z');
    expect(back.n).toBe(3);
  });
});

describe('with a database', () => {
  test('createJob and saveJob send cleaned JSON', async () => {
    const { id } = await createJob({ name: 'Ada Lovelace', company: 'Engines', owner: 'u1', state: { quote: 'a\u0000b' } });
    const insert = db.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'));
    expect(jsonbRejects(insert[1][5])).toBe(false);
    await saveJob(id, { state: { title: 'cut \uD83D' } });
    const update = db.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'));
    expect(jsonbRejects(update[1][1])).toBe(false);
  });

  test('a failed save throws instead of reporting progress that was not saved', async () => {
    db.query.mockImplementation(async (sql) => { if (sql.startsWith('UPDATE')) throw new Error('invalid input syntax for type json'); return []; });
    await expect(saveJob('job1', { state: {} })).rejects.toMatchObject({ code: 'JOB_STORE_UNAVAILABLE' });
  });

  test('a failed insert throws, so no job id is handed out that cannot be found', async () => {
    db.query.mockImplementation(async (sql) => { if (sql.startsWith('INSERT')) throw new Error('down'); return []; });
    await expect(createJob({ name: 'Ada Lovelace', owner: 'u1', state: {} })).rejects.toMatchObject({ code: 'JOB_STORE_UNAVAILABLE' });
  });

  test('a failed retention clean-up does not stop the job', async () => {
    db.query.mockImplementation(async (sql) => { if (sql.startsWith('DELETE')) throw new Error('busy'); return []; });
    await expect(createJob({ name: 'Ada Lovelace', owner: 'u1', state: {} })).resolves.toHaveProperty('id');
  });

  test('a failed read throws instead of serving an older in-memory copy', async () => {
    const { id } = await createJob({ name: 'Ada Lovelace', owner: 'u1', state: { step: 1 } });
    await saveJob(id, { state: { step: 1 } });
    db.queryOne.mockImplementation(async () => { throw new Error('connection reset'); });
    await expect(getJob(id, { owner: 'u1' })).rejects.toMatchObject({ code: 'JOB_STORE_UNAVAILABLE' });
  });

  test('no job is kept in instance memory: a missing row is not found', async () => {
    const { id } = await createJob({ name: 'Ada Lovelace', owner: 'u1', state: { step: 1 } });
    expect(await getJob(id, { owner: 'u1' })).toBeNull();
    db.queryOne.mockImplementation(async () => { throw new Error('down'); });
    expect(await recentJobCount('u1')).toBe(0);
  });

  test('reads the row and still enforces the owner', async () => {
    db.queryOne.mockImplementation(async () => ({ id: 'j1', user_id: 'u1', name: 'Ada Lovelace', company: null, status: 'running', state: '{"step":2}', created_at: new Date(), updated_at: new Date() }));
    expect((await getJob('j1', { owner: 'u1' })).state).toEqual({ step: 2 });
    expect(await getJob('j1', { owner: 'u2' })).toBeNull();
  });
});

describe('without a database', () => {
  beforeEach(() => db.persistenceMode.mockImplementation(() => 'none'));

  test('jobs live in memory and are saved there', async () => {
    const { id } = await createJob({ name: 'Ada Lovelace', owner: 'u1', state: { step: 1 } });
    await saveJob(id, { state: { step: 2 }, status: 'done' });
    const job = await getJob(id, { owner: 'u1' });
    expect(job.state).toEqual({ step: 2 });
    expect(job.status).toBe('done');
    expect(await getJob(id, { owner: 'u2' })).toBeNull();
    expect(await recentJobCount('u1')).toBe(1);
    expect(db.query).not.toHaveBeenCalled();
  });
});
