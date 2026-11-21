/**
 * @jest-environment node
 *
 * The list of sources as a whole: every one obeys the contract, ids are
 * unique, every thread kind has someone to handle it, and nothing a user
 * can read uses developer or pricing words.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { CONNECTORS, connectorById } = require('../../../src/server/founder/sources');
const { THREAD_KINDS } = require('../../../src/server/founder/finding');
const { createSubject } = require('../../../src/server/founder/identity');

const KINDS = ['subject', ...THREAD_KINDS];
const BANNED = /\b(api|endpoint|api key|token|free|paid|tier|env)\b/i;

describe('source registry', () => {
  test('there are sources, with unique ids', () => {
    expect(CONNECTORS.length).toBeGreaterThanOrEqual(25);
    const ids = CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(connectorById(ids[0])).toBe(CONNECTORS[0]);
  });

  test.each(CONNECTORS.map((c) => [c.id, c]))('%s obeys the contract', (id, c) => {
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(typeof c.label).toBe('string');
    expect(c.label.length).toBeGreaterThan(3);
    expect(c.label).not.toMatch(BANNED);
    expect(c.kinds.length).toBeGreaterThan(0);
    for (const kind of c.kinds) expect(KINDS).toContain(kind);
    expect(typeof c.run).toBe('function');
    if (c.prior !== undefined) { expect(c.prior).toBeGreaterThan(0); expect(c.prior).toBeLessThanOrEqual(1); }
    if (c.enabled) { expect(typeof c.enabled()).toBe('boolean'); expect(String(c.unavailableReason || '').length).toBeGreaterThan(10); expect(c.unavailableReason).not.toMatch(BANNED); }
  });

  test('every kind of thread has at least one source', () => {
    for (const kind of KINDS) expect(CONNECTORS.some((c) => c.kinds.includes(kind) && (!c.enabled || c.enabled()))).toBe(true);
  });

  test('plans are well formed, and a lookup about a relative or associate always involves the subject or is a watchlist screen', () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const samples = { subject: 'Elizabeth Holmes', company: 'Theranos', school: 'Stanford University', associate: 'Ramesh Balwani', relative: 'Christian Holmes', handle: 'eholmes', domain: 'theranos.com', url: 'https://www.linkedin.com/in/elizabeth-holmes', alias: 'Elizabeth Anne Holmes' };
    for (const c of CONNECTORS) {
      if (typeof c.plan !== 'function') continue;
      for (const kind of c.kinds) {
        const plans = c.plan({ kind, value: samples[kind], why: 'test', relation: kind === 'relative' ? 'father' : null }, subject) || [];
        expect(Array.isArray(plans)).toBe(true);
        for (const p of plans) {
          if (p.template) expect(p.template).toMatch(/^[a-z0-9.:_-]+$/i);
          if (p.prior !== undefined) { expect(p.prior).toBeGreaterThan(0); expect(p.prior).toBeLessThanOrEqual(1); }
          // a search about another person must name the subject too
          if ((kind === 'associate' || kind === 'relative') && p.params && typeof p.params.query === 'string') expect(p.params.query).toMatch(/Elizabeth Holmes/);
          // the query pattern is what learning keys on: it must not carry a person's name
          if (p.template) expect(p.template).not.toMatch(/holmes|balwani|theranos/i);
        }
      }
    }
  });

  test('only watchlists and joint lookups accept a relative or associate', () => {
    const allowed = new Set(['sanctions-lists', 'offshore-leaks', 'web-search', 'doj-press-releases', 'wanted-lists', 'us-exclusions', 'us-bank-regulators', 'fincen-actions', 'mdb-debarment', 'opensanctions-lists', 'asic-banned']);
    const takers = CONNECTORS.filter((c) => c.kinds.includes('relative') || c.kinds.includes('associate')).map((c) => c.id);
    for (const id of takers) expect(allowed.has(id)).toBe(true);
  });
});
