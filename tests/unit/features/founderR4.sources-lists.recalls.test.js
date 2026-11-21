/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const { nhtsaRecallsConnector, cpscRecallsConnector, __resetRecallsForTests } = require('../../../src/server/founder/sources/recalls');
const { extendedName, whichName } = require('../../../src/server/founder/sources/government');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
let fail = false;
let rows = [];
beforeEach(() => {
  __resetRecallsForTests({ unpaced: true });
  __resetCacheForTests();
  fail = false;
  setTransport(async (url) => (fail ? respond('down', 404) : respond(String(url).includes('saferproducts') ? [] : rows)));
});
afterEach(() => { setTransport(); jest.restoreAllMocks(); });

const nhtsaRow = (over) => ({
  report_received_date: '2025-02-07T00:00:00.000', nhtsa_id: '25V073000', recall_link: { url: 'https://www.nhtsa.gov/recalls?nhtsaId=25V073000' },
  manufacturer: 'Rivian Automotive, LLC', subject: 'Seat belt may detach', component: 'SEAT BELTS', recall_type: 'Vehicle', potentially_affected: '95',
  consequence_summary: 'A detached belt increases the risk of injury in a crash.', fire_risk_when_parked: 'No', do_not_drive: 'No', ...over,
});

describe('a firm registered as the company name plus general words', () => {
  test('extendedName reads Rivian Automotive, Lucid USA and Fisker Group as possible forms of the company', () => {
    expect(whichName('Rivian Automotive, LLC', ['Rivian'])).toBe('');
    expect(extendedName('Rivian Automotive, LLC', ['Rivian'])).toBe('Rivian');
    expect(extendedName('Lucid USA, Inc.', ['Lucid'])).toBe('Lucid');
    expect(extendedName('Fisker Group Inc', ['Fisker'])).toBe('Fisker');
    expect(extendedName('Peloton Interactive, Inc.', ['Peloton'])).toBe('Peloton');
    // another business that only shares the first word
    expect(extendedName('Nikola Motor Works', ['Nikola'])).toBe('');
    expect(extendedName('Rivianna Foods Inc', ['Rivian'])).toBe('');
    expect(extendedName('Rivian Automotive, LLC', ['Ri'])).toBe('');
  });

  test('NHTSA recalls by "Rivian Automotive, LLC" are kept as a name match to verify, not left out as another maker', async () => {
    rows = [nhtsaRow(), nhtsaRow({ nhtsa_id: '24V100000', manufacturer: 'Rivianna Trailers Inc' })];
    const r = await nhtsaRecallsConnector.run({ kind: 'company', value: 'Rivian' }, ctxFor(createSubject({ name: 'Dana Quillfeather', company: 'Rivian' })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible');
    expect(r.findings[0].matchReasons.join(' ')).toMatch(/verify it is the same company/);
    const notes = r.notes.join(' ');
    expect(notes).not.toMatch(/no recall filed under that name was found/);
    expect(notes).not.toMatch(/Rivian Automotive/);
    expect(notes).toMatch(/Rivianna Trailers/);
  });
});

describe('an older cached answer standing in for a failed search', () => {
  test('NHTSA: a "no recall" from a stale copy is marked partial with its date', async () => {
    rows = [];
    const subject = createSubject({ name: 'Dana Quillfeather', company: 'Kestrelline' });
    const first = await nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline' }, ctxFor(subject));
    expect(first.partial).toBeUndefined();
    const later = Date.now() + 2 * 24 * 3600 * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    fail = true;
    const r = await nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline' }, { ...ctxFor(subject), deadline: later + 20000 });
    expect(r.partial && r.partial.join(' ')).toMatch(/as of \d{4}-\d{2}-\d{2}/);
    expect(r.notes.join(' ')).toMatch(/answer of \d{4}-\d{2}-\d{2} was used/);
  });

  test('CPSC: the same', async () => {
    const subject = createSubject({ name: 'Dana Quillfeather', company: 'Kestrelline' });
    await cpscRecallsConnector.run({ kind: 'company', value: 'Kestrelline' }, ctxFor(subject));
    const later = Date.now() + 2 * 24 * 3600 * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    fail = true;
    const r = await cpscRecallsConnector.run({ kind: 'company', value: 'Kestrelline' }, { ...ctxFor(subject), deadline: later + 20000 });
    expect(r.partial && r.partial.join(' ')).toMatch(/as of \d{4}-\d{2}-\d{2}/);
  });
});
