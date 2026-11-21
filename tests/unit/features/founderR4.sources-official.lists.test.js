/**
 * @jest-environment node
 *
 * Round 4 fixes for opensanctions.js and fdaDebarment.js (review 2026-11-21, by-owner/sources-official.json):
 *   sources-official-opensanctions-own-grader   a person's hit is graded by the shared gradeListedPerson: a variant
 *                                               of the name stays possible, and only a company the check was
 *                                               started with raises a hit (to likely at most)
 *   sources-official-company-legal-names        a company is screened under its learned legal names too
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addAnchor, addCompanyAlias } = require('../../../src/server/founder/identity');
const { openSanctionsConnector: c, DATASETS } = require('../../../src/server/founder/sources/opensanctions');
const { fdaDebarmentConnector } = require('../../../src/server/founder/sources/fdaDebarment');

const HEADER = '"id","schema","name","aliases","birth_date","countries","addresses","identifiers","sanctions","phones","emails","program_ids","dataset","first_seen","last_seen","last_change"';
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const row = (o) => [o.id, o.schema || 'LegalEntity', o.name, o.aliases || '', '', o.countries || '', '', '', o.sanctions ?? '""', '', '', '', o.dataset, '2024-03-04T17:09:51', '2026-11-20T00:33:15', '2025-09-15T18:27:02'].map(q).join(',');
const csv = (rows) => `${[HEADER, ...rows].join('\n')}\n`;
const filler = (ds, n, schema = 'LegalEntity') => Array.from({ length: n }, (_, i) => row({ id: `${ds}-f${i}`, schema, name: `Filler Person${i} Example${i}`, dataset: ds }));
const meta = (id, count) => JSON.stringify({
  updated_at: '2026-11-20T20:44:06', target_count: count, url: `https://publisher.example.org/${id}`,
  resources: [{ name: 'targets.simple.csv', url: `https://data.opensanctions.org/artifacts/${id}/v1/targets.simple.csv`, size: 5000 }],
});

const SEC_HARMED = csv([
  row({ id: 'NK-a', schema: 'Person', name: 'Maria Garcia Lopez', sanctions: 'Fraud in the sale of Acme Robotics securities', dataset: 'US SEC Actions Due to Harmed Investors' }),
  row({ id: 'NK-b', schema: 'Person', name: 'JANE ROE', sanctions: 'Unregistered sales while registered with Brightwater Securities', dataset: 'US SEC Actions Due to Harmed Investors' }),
  row({ id: 'NK-c', name: 'Ramp Business Corporation', countries: 'us', sanctions: 'Distribution to harmed investors', dataset: 'US SEC Actions Due to Harmed Investors' }),
  ...filler('US SEC Actions Due to Harmed Investors', 20),
]);

function serveLists(files) {
  const routes = {};
  for (const d of DATASETS) {
    const text = files[d.id] || csv(filler(d.name, 3, d.people ? 'Person' : 'LegalEntity'));
    routes[`/datasets/latest/${d.id}/index.json`] = meta(d.id, text.trim().split('\n').length - 1);
    routes[`/artifacts/${d.id}/v1/targets.simple.csv`] = text;
  }
  setTransport(async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const headers = { get: () => null };
    return key ? { status: 200, headers, url, text: async () => routes[key] } : { status: 404, headers, url, text: async () => 'not found' };
  });
}
const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });

beforeEach(() => { __resetCacheForTests(); });
afterEach(() => setTransport());

describe('sources-official-opensanctions-own-grader', () => {
  test('an entry under the name with an extra surname (tier 3) stays possible, even when the reason names the company', async () => {
    serveLists({ us_sec_harmed_investors: SEC_HARMED });
    const s = createSubject({ name: 'Maria Garcia', company: 'Acme Robotics' });
    const out = await c.run({ kind: 'subject', value: s.name, template: 'os.us-markets', depth: 0 }, ctxFor(s));
    const f = out.findings.find((x) => /Garcia Lopez/.test(x.title));
    expect(f).toBeTruthy();
    expect(f.match).toBe('possible');
    expect(f.title).toMatch(/verify identity/);
  });

  test('an employer learned from other records (not given) does not raise a name match', async () => {
    serveLists({ us_sec_harmed_investors: SEC_HARMED });
    const s = createSubject({ name: 'Jane Roe', company: 'Acme Rockets' });
    addAnchor(s, 'companies', 'Brightwater Securities', 'found');
    const out = await c.run({ kind: 'subject', value: s.name, template: 'os.us-markets', depth: 0 }, ctxFor(s));
    const f = out.findings.find((x) => /JANE ROE/i.test(x.title));
    expect(f).toBeTruthy();
    expect(f.match).toBe('possible');
  });
});

describe('sources-official-company-legal-names', () => {
  const ramp = () => {
    const s = createSubject({ name: 'Eric Glyman', company: 'Ramp' });
    addCompanyAlias(s, { company: 'Ramp', alias: 'Ramp Business Corporation', origin: 'form-d-1' });
    return s;
  };

  test('OpenSanctions: the learned legal name is screened and its whole-name hit is the company\'s record', async () => {
    serveLists({ us_sec_harmed_investors: SEC_HARMED });
    const out = await c.run({ kind: 'company', value: 'Ramp', template: 'os.us-markets', depth: 1 }, ctxFor(ramp()));
    const f = out.findings.find((x) => /Ramp Business Corporation/.test(x.title));
    expect(f).toBeTruthy();
    expect(f.match).toBe('company');
  });

  test('FDA debarment: a firm under the learned legal name is found and is the company\'s record', async () => {
    const firmRow = '<tr><td>Ramp Business Corporation</td><td>03/02/2020</td><td>5 years %</td><td>03/02/2020</td><td>85 FR 12000</td></tr>';
    const fill = (n, p) => Array.from({ length: n }, (_, i) => `<tr><td>${p}last${i}</td><td>Filler${i}</td><td>01/01/2010</td><td>Permanent^</td><td>01/01/2010</td><td>75 FR ${1000 + i}</td></tr>`).join('');
    const firms = `<h3>Firms</h3><table class="Table table"><thead><tr><th>Name of Firm</th><th>Effective Date</th><th>End/Term of Debarment</th><th>FR Date.txt (MM/DD/YY)</th><th>Volume Page.pdf</th></tr></thead><tbody>${firmRow}</tbody></table>`;
    const persons = (rows) => `<h3>Persons</h3><table class="Table table"><thead><tr><th>Last Name</th><th>First &amp; Middle Names</th><th>Effective Date</th><th>End/Term of Debarment</th><th>FR Date.txt (MM/DD/YY)</th><th>Volume Page.pdf</th></tr></thead><tbody>${rows}</tbody></table>`;
    const CURRENT = `<html><body><h2>FDA Debarment List (Drug Product Applications)</h2>${firms}${persons(fill(60, 'C'))}</body></html>`;
    const EXPIRED = `<html><body><h2>FDA Expired Debarment List (Drug Product Applications)</h2>${firms.replace(firmRow, '<tr><td>None at this time</td><td></td><td></td><td></td><td></td></tr>')}${persons(fill(40, 'E'))}</body></html>`;
    setTransport(async (url) => {
      const headers = { get: () => null };
      const body = url.includes('fda-expired-debarment-list') ? EXPIRED : url.includes('fda-debarment-list-drug-product-applications') ? CURRENT : null;
      return body ? { status: 200, headers, url, text: async () => body } : { status: 404, headers, url, text: async () => 'not found' };
    });
    const out = await fdaDebarmentConnector.run({ kind: 'company', value: 'Ramp', template: 'fda.debarment', depth: 1 }, ctxFor(ramp()));
    const f = out.findings.find((x) => /Ramp Business Corporation/.test(x.title));
    expect(f).toBeTruthy();
    expect(f.match).toBe('company');
  });
});
