/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const fs = require('fs');
const path = require('path');
const { cachedEntry, __resetCacheForTests } = require('../../../src/server/founder/cache');

beforeEach(() => __resetCacheForTests());
afterEach(() => jest.restoreAllMocks());

test('an older copy standing in for a failed refresh is dated and marked not fresh', async () => {
  const first = await cachedEntry('t:list:v1', 1000, async () => ({ names: ['a'] }));
  expect(first.fresh).toBe(true);
  jest.spyOn(Date, 'now').mockReturnValue(first.at + 5000);
  const again = await cachedEntry('t:list:v1', 1000, async () => { throw new Error('down'); });
  expect(again.fresh).toBe(false);
  expect(again.at).toBe(first.at);
  expect(again.value).toEqual({ names: ['a'] });
});

test('none of this owner\'s sources reports a clean result from cached(), which drops the copy\'s date', () => {
  const dir = path.join(__dirname, '../../../src/server/founder/sources');
  for (const file of ['gdprFines.js', 'recalls.js', 'sanctions.js', 'debarment.js', 'government.js', 'retractions.js', 'academicMore.js']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    expect([file, /\bcached\(/.test(text)]).toEqual([file, false]);
  }
});
