/**
 * Rows saved before company spellings were merged keep their old company
 * key; a lookup must still find them (classify request to the store).
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), persistenceMode: jest.fn(() => 'neon') }));
const db = require('../../../src/server/db');
const store = require('../../../src/server/network/store');

beforeEach(() => { store.__resetForTests(); db.query.mockReset(); });

test('old keys are brought up to date once per user, and the match reads the company again', async () => {
  // The table as saved by the old code: "McKinsey & Company" kept "mckinsey and company".
  const table = [
    { name: 'Ann Old', company: 'McKinsey & Company', company_key: 'mckinsey and company', position: 'Partner' },
    { name: 'Ben New', company: 'McKinsey', company_key: 'mckinsey', position: 'Associate' },
  ];
  const updates = [];
  db.query.mockImplementation(async (sql, params) => {
    if (/SELECT DISTINCT company, company_key/.test(sql)) return table.map(({ company, company_key }) => ({ company, company_key }));
    if (/^\s*UPDATE network_contacts/.test(sql)) {
      updates.push(params);
      const [, companies, keys] = params;
      for (const r of table) { const i = companies.indexOf(r.company); if (i >= 0) r.company_key = keys[i]; }
      return [];
    }
    if (/FROM network_contacts/.test(sql) && /company_key = ANY/.test(sql)) return table.filter((r) => params[1].includes(r.company_key));
    return [];
  });
  const rows = await store.findContactsAtCompanies('user-1', ['McKinsey']);
  expect(rows.map((r) => r.name).sort()).toEqual(['Ann Old', 'Ben New']);
  expect(updates).toEqual([['user-1', ['McKinsey & Company'], ['mckinsey']]]);
  // Once per user: the second lookup does not read the keys again.
  await store.findContactsAtCompanies('user-1', ['McKinsey'], { detail: true });
  expect(db.query.mock.calls.filter(([sql]) => /SELECT DISTINCT company/.test(sql))).toHaveLength(1);
});

test('a failed refresh never stops the lookup', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  db.query.mockImplementation(async (sql) => {
    if (/SELECT DISTINCT company/.test(sql)) throw new Error('db busy');
    if (/company_key = ANY/.test(sql)) return [{ name: 'Old Row', company: 'Facebook', company_key: 'facebook', position: 'Engineer' }];
    return [];
  });
  // The SQL found the row; the JS check reads its company again ("Facebook" is Meta now).
  const rows = await store.findContactsAtCompanies('user-1', ['Meta']);
  expect(rows.map((r) => r.name)).toEqual(['Old Row']);
  console.warn.mockRestore();
});
