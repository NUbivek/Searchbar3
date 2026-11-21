/**
 * @jest-environment node
 *
 * Round 4 (review 2026-11-21), asked for by the sources-lists engineer: a list or register answer read from an
 * older copy (the refresh failed) is dated and partial, never an undated "no entry" as of today. The cache is
 * faked so that every copy is an older one; the network is faked as in the source tests.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
jest.mock('../../../src/server/founder/cache', () => {
  const actual = jest.requireActual('../../../src/server/founder/cache');
  return {
    ...actual,
    cachedEntry: jest.fn(async (key, ttl, loader) => ({ value: await loader({ deadline: Date.now() + 20000 }), at: Date.parse('2026-11-14T08:00:00Z'), fresh: false, ageMs: 1 })),
  };
});
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const O = require('../../../src/server/founder/sources/opensanctions');
const R = require('../../../src/server/founder/sources/registriesIntl');

afterEach(() => setTransport());

describe('opensanctions: a list read from an older copy', () => {
  const HEADER = '"id","schema","name","aliases","birth_date","countries","addresses","identifiers","sanctions","phones","emails","program_ids","dataset","first_seen","last_seen","last_change"';
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const filler = (name, n, schema) => Array.from({ length: n }, (_, i) => [`f${i}`, schema, `Filler Person${i} Example${i}`, '', '', '', '', '', '', '', '', '', name, '2024-03-04T17:09:51', '2026-11-20T00:33:15', '2025-09-15T18:27:02'].map(q).join(','));
  test('the "found no entry" note gives the list date and the screen is partial', async () => {
    const routes = {};
    for (const d of O.DATASETS) {
      const text = `${[HEADER, ...filler(d.name, 23, d.people ? 'Person' : 'LegalEntity')].join('\n')}\n`;
      routes[`/datasets/latest/${d.id}/index.json`] = JSON.stringify({ updated_at: '2026-11-13T20:44:06', target_count: 23, url: 'https://publisher.example.org/x', resources: [{ name: 'targets.simple.csv', url: `https://data.opensanctions.org/artifacts/${d.id}/v1/targets.simple.csv`, size: 5000 }] });
      routes[`/artifacts/${d.id}/v1/targets.simple.csv`] = text;
    }
    setTransport(async (url) => {
      const key = Object.keys(routes).find((k) => url.includes(k));
      return key ? { status: 200, headers: { get: () => null }, url, text: async () => routes[key] } : { status: 404, headers: { get: () => null }, url, text: async () => 'not found' };
    });
    const subject = createSubject({ name: 'Mark Quillfeather', company: 'Acme' });
    const out = await O.openSanctionsConnector.run({ kind: 'subject', value: subject.name, template: 'os.wanted', depth: 0 }, { subject, deadline: Date.now() + 20000 });
    expect(out.findings).toHaveLength(0);
    expect(out.notes.join(' ')).toMatch(/found no entry in: Interpol red notices \(list as of 2026-11-14\)/);
    expect(out.partial).toEqual(expect.arrayContaining([expect.stringMatching(/^Interpol red notices: list as of 2026-11-14$/)]));
  });
});

describe('registriesIntl: a register answer read from an older copy', () => {
  test('the Finnish "no company" note is dated and partial', async () => {
    setTransport(async (url) => ({ status: 200, ok: true, headers: new Map(), url, text: async () => JSON.stringify({ totalResults: 0, companies: [] }) }));
    R.__resetIntlForTests({ unpaced: true });
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const r = await R.fiTradeRegisterConnector.run({ kind: 'company', value: 'Nikola Trucks Oy', why: '' }, { subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => [] });
    expect(r.notes[0]).toMatch(/no company is registered under the exact name Nikola Trucks.*\(register answer as of 2026-11-14\)/);
    expect(r.partial).toEqual([expect.stringMatching(/answer as of 2026-11-14/)]);
  });
});
