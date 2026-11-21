/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const { sanctionsListsConnector, exclusionsConnector, listingEnded, SAM_ACTIVE_ONLY_NOTE } = require('../../../src/server/founder/sources/sanctions');

const CSL_HEADER = '_id,source,entity_number,type,programs,name,title,addresses,federal_register_notice,start_date,end_date,standard_order,license_requirement,license_policy,call_sign,vessel_type,gross_tonnage,gross_registered_tonnage,vessel_flag,vessel_owner,remarks,source_list_url,alt_names,citizenships,dates_of_birth,nationalities,places_of_birth,source_information_url,ids';
const cslRow = (o) => CSL_HEADER.split(',').map((k) => `"${String(o[k] ?? '').replace(/"/g, '""')}"`).join(',');
const DPL = 'Denied Persons List (DPL) - Bureau of Industry and Security';
const CSL = [
  CSL_HEADER,
  cslRow({ _id: '1', source: DPL, type: 'Individual', name: 'QUILLFEATHER, Dana', start_date: '1998-03-03', end_date: '2003-03-03', source_list_url: 'https://www.bis.gov/dpl' }),
  cslRow({ _id: '2', source: DPL, type: 'Individual', name: 'VEXLEY, Pat', start_date: '2024-03-03', end_date: '2099-03-03', source_list_url: 'https://www.bis.gov/dpl' }),
].join('\r\n') + '\r\n';

const respond = (body, status = 200) => ({ status, headers: { get: () => null }, url: '', text: async () => body });
beforeEach(() => __resetCacheForTests());
afterEach(() => setTransport());
const ctxFor = (name) => ({ subject: createSubject({ name, company: '' }), deadline: Date.now() + 20000, known: () => ({}) });

describe('a screening list row whose listing has ended', () => {
  test('listingEnded reads only a past yyyy-mm-dd end date', () => {
    expect(listingEnded({ e: '2003-03-03' }, '2026-11-21')).toBe('2003-03-03');
    expect(listingEnded({ e: '2099-03-03' }, '2026-11-21')).toBe('');
    expect(listingEnded({ e: '' }, '2026-11-21')).toBe('');
    expect(listingEnded({}, '2026-11-21')).toBe('');
  });

  test('a lapsed denial order is reported as ended and medium, never as a current listing', async () => {
    setTransport(async (url) => (String(url).includes('data.trade.gov') ? respond(CSL) : respond('not found', 404)));
    const out = await sanctionsListsConnector.run({ kind: 'subject', value: 'Dana Quillfeather', template: 'list.us-csl', depth: 0 }, ctxFor('Dana Quillfeather'));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.severity).toBe('medium');
    expect(f.title).toMatch(/\(listing ended 2003-03-03\)/);
    expect(f.quote).toMatch(/Listing ended: 2003-03-03/);
    expect(f.data.ended).toBe('2003-03-03');
    expect(f.match).toBe('possible');
  });

  test('a listing still in force stays high', async () => {
    setTransport(async (url) => (String(url).includes('data.trade.gov') ? respond(CSL) : respond('not found', 404)));
    const out = await sanctionsListsConnector.run({ kind: 'subject', value: 'Pat Vexley', template: 'list.us-csl', depth: 0 }, ctxFor('Pat Vexley'));
    expect(out.findings[0].severity).toBe('high');
    expect(out.findings[0].title).not.toMatch(/ended/);
    expect(out.findings[0].data.ended).toBeUndefined();
  });
});

describe('SAM.gov screens say that only exclusions in force were screened', () => {
  test('a clean SAM.gov screen carries the note', async () => {
    setTransport(async (url) => (String(url).includes('sam.gov') ? respond(JSON.stringify({ page: { totalElements: 0 } })) : respond('not found', 404)));
    const out = await exclusionsConnector.run({ kind: 'subject', value: 'Dana Quillfeather', template: 'excl.sam', depth: 0 }, ctxFor('Dana Quillfeather'));
    expect(out.notes).toContain(SAM_ACTIVE_ONLY_NOTE);
    expect(out.notes.join(' ')).toMatch(/no match for Dana Quillfeather among exclusions in force/);
    expect(SAM_ACTIVE_ONLY_NOTE).not.toMatch(/\b(api|key|token|free|paid|tier|quota)\b/i);
  });
});
