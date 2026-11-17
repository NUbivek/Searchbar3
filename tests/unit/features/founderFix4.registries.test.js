/**
 * Round 4 fixes for the company registers.
 * Item 12: state registers that did not answer in time are returned as `partial`, so coverage does not
 * read "searched, nothing found" for them.
 * Item 21: the French register is skipped when tied records place the person and company elsewhere and
 * nothing ties them to France; it still runs while no country is known.
 *
 * @jest-environment node
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { usStateRegistriesConnector, frCompaniesConnector, linkedCountries } = require('../../../src/server/founder/sources/registries');

afterEach(() => setTransport());
beforeEach(() => __resetCacheForTests());

const companyTask = (value, why = '') => ({ kind: 'company', value, depth: 1, template: null, params: null, why });
const subjectTask = (name) => ({ kind: 'subject', value: name, depth: 0, template: null, params: null });
const ctxFor = (name, company, findings = []) => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });

describe('US state registers: timeouts are reported as a partial search', () => {
  test('states that timed out are listed in result.partial; others answer normally', async () => {
    setTransport(async (url) => {
      if (/data\.(colorado|texas)\.gov/.test(url)) throw new Error('Timed out after 7000 ms');
      return { status: 200, headers: new Map(), url, text: async () => '[]' };
    });
    const out = await usStateRegistriesConnector.run(companyTask('Orbitex Robotics'), { ...ctxFor('Jane Roe', 'Orbitex Robotics'), deadline: Date.now() + 2000 });
    expect(out.partial).toEqual(['Colorado', 'Texas']);
    expect(out.notes.join(' ')).toMatch(/Colorado business register did not answer in time/);
  });

  test('no partial field when every state answered', async () => {
    setTransport(async (url) => ({ status: 200, headers: new Map(), url, text: async () => '[]' }));
    const out = await usStateRegistriesConnector.run(companyTask('Orbitex Robotics'), ctxFor('Jane Roe', 'Orbitex Robotics'));
    expect(out.partial).toBeUndefined();
  });
});

describe('French register only where France is not ruled out', () => {
  let calls;
  beforeEach(() => {
    calls = 0;
    setTransport(async (url) => { calls += 1; return { status: 200, headers: new Map(), url, text: async () => JSON.stringify({ results: [], total_results: 0 }) }; });
  });

  const american = { source: 'wikipedia', category: 'identity', match: 'confirmed', title: 'Jane Roe: American businesswoman (Wikipedia article)' };
  const usLei = { source: 'lei-register', category: 'corporate', match: 'company', title: 'LEI record', data: { jurisdiction: 'US-DE' } };
  const french = { source: 'wikidata', category: 'identity', match: 'likely', title: 'Jane Roe: French entrepreneur' };

  test('skipped, with no request, when tied records place the person and company in another country', async () => {
    const out = await frCompaniesConnector.run(companyTask('Orbitex Robotics'), ctxFor('Jane Roe', 'Orbitex Robotics', [american, usLei]));
    expect(calls).toBe(0);
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/not searched/);
    await frCompaniesConnector.run(subjectTask('Jane Roe'), ctxFor('Jane Roe', 'Orbitex Robotics', [american]));
    expect(calls).toBe(0);
  });

  test('runs while no country is known, and when a tied record says France', async () => {
    await frCompaniesConnector.run(subjectTask('Jane Roe'), ctxFor('Jane Roe', 'Orbitex Robotics'));
    expect(calls).toBe(1);
    await frCompaniesConnector.run(companyTask('Orbitex Robotics'), ctxFor('Jane Roe', 'Orbitex Robotics', [american, french]));
    expect(calls).toBe(2);
  });

  test('a French legal form or a French-register thread keeps the lookup, whatever else is known', async () => {
    await frCompaniesConnector.run(companyTask('Orbitex Robotics SAS'), ctxFor('Jane Roe', 'Orbitex', [american]));
    await frCompaniesConnector.run(companyTask('Orbitex Labs', 'French company where a Jane Roe is president'), ctxFor('Jane Roe', 'Orbitex', [american]));
    expect(calls).toBe(2);
  });

  test('a namesake record graded possible does not decide the country', () => {
    const c = linkedCountries(companyTask('Orbitex Robotics'), ctxFor('Jane Roe', 'Orbitex Robotics', [{ ...american, match: 'possible' }]));
    expect(c.size).toBe(0);
  });
});
