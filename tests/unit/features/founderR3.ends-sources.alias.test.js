/** @jest-environment node */
// Round 3 ends: watchlist, court and enforcement sources take an 'alias' thread (another name of the person) and
// screen it the way they screen the person's own name. A typed other name grades like the main name; a name
// found in a record gives 'likely' at most, held so a later re-grade cannot raise it.
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addNameAlias } = require('../../../src/server/founder/identity');
const { holdAliasGrade, isTypedAlias } = require('../../../src/server/founder/sources/alias');
const S = require('../../../src/server/founder/sources/sanctions');
const { CONNECTORS } = require('../../../src/server/founder/sources');

function serve(routes) {
  setTransport(async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key](url) : null;
    const headers = { get: () => null };
    if (typeof r === 'string') return { status: 200, headers, url, text: async () => r };
    return { status: 404, headers, url, text: async () => 'not found' };
  });
}
beforeEach(() => { __resetCacheForTests(); });
afterEach(() => { setTransport(); });

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });

const UK = `<?xml version="1.0"?><Designations><DateGenerated>12/11/2026</DateGenerated>
<Designation><UniqueID>RUS0001</UniqueID><RegimeName>Russia</RegimeName><IndividualEntityShip>Individual</IndividualEntityShip><DateDesignated>15/03/2022</DateDesignated>
<UKStatementofReasons>Former president of Rusal.</UKStatementofReasons>
<Names><Name><Name1>Oleg</Name1><Name6>DERIPASKA</Name6><NameType>Primary Name</NameType></Name></Names></Designation>
</Designations>`;

describe('alias helper', () => {
  test('a typed other name is the person\'s; a found one is not', () => {
    const typed = createSubject({ name: 'Oleg Smith', company: 'Rusal', otherNames: ['Oleg Deripaska'] });
    expect(isTypedAlias(typed, 'Oleg Deripaska')).toBe(true);
    const found = createSubject({ name: 'Oleg Smith', company: 'Rusal' });
    addNameAlias(found, { alias: 'Oleg Deripaska', origin: 'wikidata-1' });
    expect(isTypedAlias(found, 'Oleg Deripaska')).toBe(false);
  });

  test('holdAliasGrade lowers confirmed to likely, fixed, for a found name only', () => {
    const found = createSubject({ name: 'Oleg Smith', company: 'Rusal' });
    const f = { id: 'x', match: 'confirmed', matchReasons: ['names Rusal'], data: {} };
    const held = holdAliasGrade({ kind: 'alias', value: 'Oleg Deripaska' }, found, f);
    expect(held.match).toBe('likely');
    expect(held.matchFixed).toBe(true);
    expect(held.matchReasons[0]).toMatch(/another name found in a linked record/);
    expect(holdAliasGrade({ kind: 'subject', value: 'Oleg Smith' }, found, f)).toBe(f);
  });
});

describe('withAliasHold', () => {
  const { withAliasHold } = require('../../../src/server/founder/sources/alias');
  const { makeFinding, makeThread } = require('../../../src/server/founder/finding');
  // A fake source: reads one record that names whoever it is asked about, beside the company typed
  const fake = withAliasHold(async (task, ctx) => ({
    findings: [makeFinding(ctx.subject, { source: 'fake', sourceLabel: 'Fake', category: 'litigation', title: `${ctx.subject.name}, founder of Rusal, was charged`, url: 'https://example.org/1' })],
    threads: [makeThread('company', 'Basic Element', 'named in the record', { trusted: true })],
    notes: [`asked as ${task.kind} for ${task.value}`],
  }));

  test('the source sees an ordinary lookup about the person, under the other name', async () => {
    const subject = createSubject({ name: 'Oleg Smith', company: 'Rusal', otherNames: ['Oleg Deripaska'] });
    const out = await fake({ kind: 'alias', value: 'Oleg Deripaska' }, ctxFor(subject));
    expect(out.notes).toEqual(['asked as subject for Oleg Deripaska']);
    expect(out.findings[0].title).toMatch(/^Oleg Deripaska/);
  });

  test('a typed other name: the record grades like the main name and its threads are followed', async () => {
    const subject = createSubject({ name: 'Oleg Smith', company: 'Rusal', otherNames: ['Oleg Deripaska'] });
    const out = await fake({ kind: 'alias', value: 'Oleg Deripaska' }, ctxFor(subject));
    expect(out.findings[0].match).toBe('confirmed');
    expect(out.threads[0].trusted).toBe(true);
  });

  test('a found other name: likely at most, held, and its threads are noted but not followed', async () => {
    const subject = createSubject({ name: 'Oleg Smith', company: 'Rusal' });
    addNameAlias(subject, { alias: 'Oleg Deripaska', origin: 'found:wikidata-1' });
    const out = await fake({ kind: 'alias', value: 'Oleg Deripaska' }, ctxFor(subject));
    expect(out.findings[0].match).toBe('likely');
    expect(out.findings[0].matchFixed).toBe(true);
    expect(out.findings[0].matchReasons[0]).toMatch(/another name found in a linked record/);
    expect(out.threads[0].trusted).toBe(false);
  });

  test('the real subject is left as it was, and other lookups pass through unchanged', async () => {
    const subject = createSubject({ name: 'Oleg Smith', company: 'Rusal' });
    await fake({ kind: 'alias', value: 'Oleg Deripaska' }, ctxFor(subject));
    expect(subject.name).toBe('Oleg Smith');
    const out = await fake({ kind: 'subject', value: 'Oleg Smith' }, ctxFor(subject));
    expect(out.notes).toEqual(['asked as subject for Oleg Smith']);
    expect(out.findings[0].match).toBe('confirmed');
    expect(withAliasHold(fake)).toBe(fake);
  });
});

describe('sanctions lists under another name', () => {
  test('a typed other name is screened and grades like the main name', async () => {
    serve({ 'sanctionslist.fcdo.gov.uk': () => UK });
    const subject = createSubject({ name: 'Oleg Smith', company: 'Rusal', otherNames: ['Oleg Deripaska'] });
    const out = await S.sanctionsListsConnector.run({ kind: 'alias', value: 'Oleg Deripaska', template: 'list.uk' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('confirmed');
  });

  test('a name found in a record gives likely at most', async () => {
    serve({ 'sanctionslist.fcdo.gov.uk': () => UK });
    const subject = createSubject({ name: 'Oleg Smith', company: 'Rusal' });
    addNameAlias(subject, { alias: 'Oleg Deripaska', origin: 'wikidata-1' });
    const out = await S.sanctionsListsConnector.run({ kind: 'alias', value: 'Oleg Deripaska', template: 'list.uk' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('likely');
    expect(out.findings[0].matchFixed).toBe(true);
  });

  test('a clean screen under the other name says so', async () => {
    serve({ 'sanctionslist.fcdo.gov.uk': () => UK });
    const subject = createSubject({ name: 'Oleg Smith', company: 'Rusal', otherNames: ['Oleg Petrov'] });
    const out = await S.sanctionsListsConnector.run({ kind: 'alias', value: 'Oleg Petrov', template: 'list.uk' }, ctxFor(subject));
    expect(out.findings).toHaveLength(0);
    expect(out.notes.join(' ')).toMatch(/no match for Oleg Petrov/);
  });

  test('the wanted lists and Offshore Leaks take an alias lookup', async () => {
    serve({ 'api.fbi.gov': () => JSON.stringify({ items: [] }) });
    const subject = createSubject({ name: 'Oleg Smith', company: 'Rusal', otherNames: ['Oleg Petrov'] });
    expect(S.wantedConnector.kinds).toContain('alias');
    expect(S.offshoreLeaksConnector.kinds).toContain('alias');
    const out = await S.wantedConnector.run({ kind: 'alias', value: 'Oleg Petrov', template: 'wanted.fbi' }, ctxFor(subject));
    expect(out.notes.join(' ')).toMatch(/FBI wanted list: no match for Oleg Petrov/);
  });
});

describe('which sources take another name of the person', () => {
  const WANT = [
    // watchlists
    'sanctions-lists', 'us-exclusions', 'offshore-leaks', 'wanted-lists', 'mdb-debarment', 'us-bank-regulators', 'fincen-actions',
    'opensanctions-lists', 'asic-banned', 'fda-debarment', 'fara-registrations',
    // courts
    'court-dockets', 'court-records-open', 'uk-case-law', 'uk-gazette', 'canada-federal-courts', 'delaware-courts', 'eu-courts', 'us-tax-court',
    // enforcement
    'doj-press-releases', 'us-enforcement-actions', 'finra-brokercheck', 'us-agency-orders', 'ftc-cases', 'sfc-hk-enforcement', 'sec-filings', 'federal-register',
  ];
  test.each(WANT)('%s takes an alias thread', (id) => {
    const c = CONNECTORS.find((x) => x.id === id);
    expect(c).toBeTruthy();
    expect(c.kinds).toContain('alias');
  });

  test('plans for an alias are well formed and never carry the name in the pattern', () => {
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos', otherNames: ['Elizabeth Anne Holmes'] });
    for (const c of CONNECTORS.filter((x) => x.kinds.includes('alias') && typeof x.plan === 'function')) {
      const plans = c.plan({ kind: 'alias', value: 'Liz Holmes Evans', why: 'test' }, subject) || [];
      expect(Array.isArray(plans)).toBe(true);
      for (const p of plans) if (p.template) expect(p.template).not.toMatch(/holmes|evans|theranos/i);
    }
  });
});
