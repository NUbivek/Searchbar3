/**
 * @jest-environment node
 *
 * US product safety recalls (recalls.js): NHTSA vehicle recalls and CPSC
 * consumer product recalls, with the network faked from the shapes the real
 * services returned on 2026-11-20 (shortened, invented firms and people).
 * What matters most: a firm that only shares words with the company is left
 * out, a one-word ordinary name stays 'possible', phone numbers, cities and
 * injury accounts never reach a record, and a failed or changed service is a
 * failure, never "no recall".
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addCompanyAlias } = require('../../../src/server/founder/identity');
const {
  nhtsaRecallsConnector, cpscRecallsConnector, RECALL_CONNECTORS, __resetRecallsForTests,
  nhtsaLike, firmName, titleFirms, recallGrade,
} = require('../../../src/server/founder/sources/recalls');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const respond = (body, status = 200) => ({ status, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function fakeNet(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push(String(url));
    const hit = routes.find(([part]) => (typeof part === 'function' ? part(String(url)) : String(url).includes(part)));
    if (!hit) return respond('not found', 404);
    const body = typeof hit[1] === 'function' ? hit[1](String(url)) : hit[1];
    return body && body.__status ? respond(body.body || '', body.__status) : respond(body);
  });
  return calls;
}

beforeEach(() => { __resetRecallsForTests({ unpaced: true }); __resetCacheForTests(); });
afterEach(() => setTransport());

const BANNED = /\b(api|endpoint|key|token|free|paid|tier|quota|env)\b/i;
const PHONE = /\d{3}[-. ]\d{3}[-. ]\d{4}/;

/* ------------------------------------------------------------------ fixtures (real shape, invented firms) */

const nhtsaRow = (over = {}) => ({
  report_received_date: '2025-02-07T00:00:00.000',
  nhtsa_id: '25V073000',
  recall_link: { url: 'https://www.nhtsa.gov/recalls?nhtsaId=25V073000', description: 'Go to Recall' },
  manufacturer: 'Kestrelline Motors, Inc.',
  subject: 'Mounting Bolts May Damage Hydrogen Tank',
  component: 'FUEL/PROPULSION SYSTEM',
  mfr_campaign_number: '24VDC1101',
  recall_type: 'Vehicle',
  potentially_affected: '95',
  defect_summary: 'Kestrelline Motors, Inc. (Kestrelline) is recalling certain 2024-2025 Tern trucks. The tank mounting bolts may be too long and damage the tank.',
  consequence_summary: 'A damaged tank can leak fuel, increasing the risk of a fire.',
  corrective_action: 'Dealers will replace the bolts, free of charge. Owners may contact customer service at 1-630-555-0142.',
  fire_risk_when_parked: 'No',
  do_not_drive: 'No',
  completion_rate: '100.00',
  ...over,
});

const cpscRecall = (over = {}) => ({
  RecallID: 10467,
  RecallNumber: '26067',
  RecallDate: '2025-11-06T00:00:00',
  Description: 'This recall involves Quorrel Original Series exercise bikes, model number QB02.',
  URL: 'https://www.cpsc.gov/Recalls/2026/Quorrel-Recalls-Original-Series-Exercise-Bikes-Due-to-Fall-and-Injury-Hazards',
  Title: 'Quorrel Recalls Original Series Exercise Bikes Due to Fall and Injury Hazards',
  ConsumerContact: 'Contact Quorrel toll-free at 866-555-0129 from 6 a.m. to 12 a.m. ET Monday through Friday.',
  LastPublishDate: '2025-11-06T00:00:00',
  Products: [{ Name: 'Quorrel Original Series Bike QB02', Description: '', Model: '', Type: '', CategoryID: '', NumberOfUnits: 'About 833,000' }],
  Inconjunctions: [],
  Images: [{ URL: 'https://www.cpsc.gov/s3fs-public/quorrel-1.png', Caption: 'Recalled bike' }],
  Injuries: [{ Name: 'Quorrel has received three reports of the seat post breaking, including two reports of injuries to a rider in Ohio named Pat Vexley.' }],
  Manufacturers: [],
  Retailers: [{ Name: 'Quorrel and sporting goods stores nationwide for about $2,495.', CompanyID: '' }],
  Importers: [{ Name: 'Quorrel Interactive Inc., of New York', CompanyID: '' }],
  Distributors: [],
  ManufacturerCountries: [{ Country: 'Taiwan' }],
  ProductUPCs: [],
  Hazards: [{ Name: "The bike's seat post can break during use, posing fall and injury hazards to the user.", HazardType: '', HazardTypeID: '' }],
  Remedies: [{ Name: 'Consumers should stop using the bikes and contact Quorrel for a free repair.' }],
  RemedyOptions: [{ Option: 'Repair' }],
  ...over,
});

/* ------------------------------------------------------------------ the set */

describe('the recall sources as a set', () => {
  test('two company-only connectors with unique ids and plain-English labels', () => {
    expect(RECALL_CONNECTORS).toHaveLength(2);
    expect(new Set(RECALL_CONNECTORS.map((c) => c.id)).size).toBe(2);
    for (const c of RECALL_CONNECTORS) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.label).not.toMatch(BANNED);
      expect(c.kinds).toEqual(['company']);
      expect(c.prior).toBeGreaterThan(0);
      expect(c.prior).toBeLessThanOrEqual(1);
      expect(typeof c.run).toBe('function');
    }
  });

  test('helpers: the search pattern, firm names without their city, firms a title names', () => {
    expect(nhtsaLike('Nikola')).toBe('%NIKOLA%');
    expect(nhtsaLike('Fisher-Price, Inc.')).toBe('%FISHER%PRICE%');
    expect(nhtsaLike("O'Hare % Motors")).toBe('%O%HARE%MOTORS%');
    expect(firmName('Quorrel Interactive Inc., of New York, N.Y.')).toBe('Quorrel Interactive Inc.');
    expect(firmName('Quorrel Interactive Inc. of New York')).toBe('Quorrel Interactive Inc.');
    expect(firmName('Bank of America')).toBe('Bank of America');
    expect(titleFirms('Quorrel Recalls Bikes Due to Fall Hazard')).toEqual(['Quorrel']);
    expect(titleFirms('Brindle Toys and Mattock Recall Play Yards')).toEqual(['Brindle Toys and Mattock', 'Brindle Toys', 'Mattock']);
    expect(titleFirms('Ladders Recalled by Wexmoor Due to Fall Hazard')).toEqual(['Wexmoor']);
    expect(titleFirms('Recall Alert: bike pedals')).toEqual([]);
  });

  test('a one-word ordinary name stays possible with a verify wording; a distinctive name is the company', () => {
    const flow = recallGrade('Flow', 'manufacturer Flow, Inc. is Flow');
    expect(flow.match).toBe('possible');
    expect(flow.matchReasons[0]).toMatch(/verify it is the same company/);
    expect(recallGrade('Kestrelline', 'x').match).toBe('company');
  });
});

/* ------------------------------------------------------------------ NHTSA */

describe('nhtsa-recalls (NHTSA vehicle recalls)', () => {
  const subject = () => createSubject({ name: 'Dana Quillfeather', company: 'Kestrelline Motors' });

  test('the exact manufacturer only; corrective action and phone numbers never requested or kept', async () => {
    const calls = fakeNet([['datahub.transportation.gov', [
      nhtsaRow(),
      nhtsaRow({ nhtsa_id: '24V844000', report_received_date: '2024-11-20T00:00:00.000', manufacturer: 'KESTRELLINE MOTORS INC', subject: 'Instrument Panel May Go Blank', component: 'ELECTRICAL SYSTEM', potentially_affected: '1,200', consequence_summary: 'A blank panel can increase the risk of a crash.', recall_link: { url: 'https://www.nhtsa.gov/recalls?nhtsaId=24V844000' } }),
      nhtsaRow({ nhtsa_id: '23E011000', manufacturer: 'Kestrelline Motorsport Parts LLC', subject: 'Brake pads may crack' }),
    ]]]);
    const r = await nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline Motors' }, ctxFor(subject()));
    expect(calls).toHaveLength(1);
    const asked = decodeURIComponent(calls[0]);
    expect(asked).toMatch(/upper\(manufacturer\) like '%KESTRELLINE%MOTORS%'/);
    expect(asked).not.toMatch(/corrective_action/);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.match).toBe('company');
    expect(f.title).toBe('2 vehicle safety recalls by Kestrelline Motors, Inc., 2024–2025');
    expect(f.quote).toMatch(/2 recalls filed with NHTSA 2024–2025, about 1,295 vehicles or parts potentially affected/);
    expect(f.quote).toMatch(/2025-02-07, recall 25V073000 \(fuel\/propulsion system\): Mounting Bolts May Damage Hydrogen Tank/);
    expect(f.url).toBe('https://www.nhtsa.gov/recalls?nhtsaId=25V073000');
    expect(f.date).toBe('2025-02-07');
    expect(f.severity).toBe('medium'); // a fire risk, no do-not-drive warning
    expect(JSON.stringify(f)).not.toMatch(PHONE);
    expect(JSON.stringify(f)).not.toMatch(/Motorsport|23E011000/);
    expect(r.notes.join(' ')).toMatch(/other manufacturers .*Kestrelline Motorsport Parts LLC.* were left out/);
    expect(r.partial).toBeUndefined();
  });

  test('a do-not-drive or park-outside warning makes it serious', async () => {
    fakeNet([['datahub.transportation.gov', [nhtsaRow({ do_not_drive: 'Yes' })]]]);
    const r = await nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline Motors' }, ctxFor(subject()));
    expect(r.findings[0].severity).toBe('high');
    expect(r.findings[0].quote).toMatch(/1 carried a do-not-drive or park-outside warning/);
  });

  test('a one-word ordinary company name stays possible', async () => {
    fakeNet([['datahub.transportation.gov', [nhtsaRow({ manufacturer: 'Flow, Inc.' })]]]);
    const r = await nhtsaRecallsConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'Dana Quillfeather', company: 'Flow' })));
    expect(r.findings.map((f) => f.match)).toEqual(['possible']);
    expect(r.findings[0].matchReasons.join(' ')).toMatch(/verify it is the same company/);
  });

  test('no recall: an empty answer is a plain note, not partial', async () => {
    fakeNet([['datahub.transportation.gov', []]]);
    const r = await nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline Motors' }, ctxFor(subject()));
    expect(r.findings).toEqual([]);
    expect(r.partial).toBeUndefined();
    expect(r.notes[0]).toMatch(/searched for a manufacturer named Kestrelline Motors; no recall filed under that name was found/);
    for (const n of r.notes) expect(n).not.toMatch(BANNED);
  });

  test('a refused request, an answer that is not a list, or a changed format is a failure', async () => {
    fakeNet([['datahub.transportation.gov', { __status: 400, body: '{"error":true,"message":"bad query"}' }]]);
    await expect(nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline Motors' }, ctxFor(subject()))).rejects.toThrow();
    __resetCacheForTests();
    fakeNet([['datahub.transportation.gov', { error: true, message: 'something changed' }]]);
    await expect(nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline Motors' }, ctxFor(subject()))).rejects.toThrow(/unexpected answer/);
    __resetCacheForTests();
    fakeNet([['datahub.transportation.gov', [{ recall_id: 'x', maker: 'Kestrelline Motors' }]]]);
    await expect(nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline Motors' }, ctxFor(subject()))).rejects.toThrow(/changed format/);
  });

  test('every known name is searched; one that fails makes the lookup partial', async () => {
    const s = createSubject({ name: 'Dana Quillfeather', company: 'Kestrel' });
    expect(addCompanyAlias(s, { company: 'Kestrel', alias: 'Kestrel Vehicle Systems Inc', origin: 'form-d-1' })).toBe(true);
    fakeNet([
      [(u) => decodeURIComponent(u).includes("'%KESTREL%VEHICLE%SYSTEMS%'"), [nhtsaRow({ manufacturer: 'Kestrel Vehicle Systems, Inc.' })]],
      [(u) => decodeURIComponent(u).includes("'%KESTREL%'"), { __status: 400, body: 'bad' }],
    ]);
    const r = await nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrel' }, ctxFor(s));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('company');
    expect(r.findings[0].matchReasons[0]).toMatch(/Kestrel Vehicle Systems Inc/);
    expect(r.partial).toEqual(['NHTSA vehicle recalls (the search for Kestrel did not answer)']);
  });

  test('a full page of results is partial; a search is cached for the day', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => nhtsaRow({ nhtsa_id: `20V${String(i).padStart(3, '0')}000`, manufacturer: 'Kestrelline Motors Inc' }));
    const calls = fakeNet([['datahub.transportation.gov', rows]]);
    const r = await nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline Motors' }, ctxFor(subject()));
    expect(r.findings[0].title).toMatch(/^200 vehicle safety recalls/);
    expect(r.partial[0]).toMatch(/latest 200 recalls/);
    await nhtsaRecallsConnector.run({ kind: 'company', value: 'Kestrelline Motors' }, ctxFor(subject()));
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ CPSC */

describe('cpsc-recalls (CPSC consumer product recalls)', () => {
  const subject = () => createSubject({ name: 'Dana Quillfeather', company: 'Quorrel' });

  test('recalls the firm announced; contact, injuries, retailers and the city never kept', async () => {
    const calls = fakeNet([
      ['RecallTitle=Quorrel', [
        cpscRecall(),
        cpscRecall({ RecallID: 9001, RecallNumber: '21129', RecallDate: '2021-05-05T00:00:00', Title: 'Quorrel Recalls Treadmills Due to Risk of Injury', URL: 'https://www.cpsc.gov/Recalls/2021/Quorrel-Recalls-Treadmills', Products: [{ Name: 'Tread', NumberOfUnits: 'About 1,050 (In addition, about 5,400 in Canada)' }] }),
        // another firm whose name starts with the same word
        cpscRecall({ RecallID: 9002, RecallNumber: '20001', Title: 'Quorrel Valley Toys Recalls Stacking Blocks Due to Choking Hazard', Importers: [{ Name: 'Quorrel Valley Toys LLC, of Dayton, Ohio' }] }),
      ]],
      ['Manufacturer=Quorrel', []],
    ]);
    const r = await cpscRecallsConnector.run({ kind: 'company', value: 'Quorrel' }, ctxFor(subject()));
    expect(calls).toHaveLength(2);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.match).toBe('company');
    expect(f.title).toBe('2 consumer product recalls by Quorrel, 2021–2025');
    expect(f.quote).toMatch(/2025-11-06, recall 26067: Quorrel Recalls Original Series Exercise Bikes .*\(About 833,000\)/);
    expect(f.quote).toMatch(/Hazard: The bike's seat post can break/);
    expect(f.url).toBe('https://www.cpsc.gov/Recalls/2026/Quorrel-Recalls-Original-Series-Exercise-Bikes-Due-to-Fall-and-Injury-Hazards');
    expect(f.date).toBe('2025-11-06');
    expect(f.severity).toBe('low');
    const all = JSON.stringify(f);
    expect(all).not.toMatch(PHONE);
    expect(all).not.toMatch(/New York|Vexley|Ohio|2,495|Valley Toys|s3fs-public/);
    expect(r.notes.join(' ')).toMatch(/Quorrel Valley Toys.* were left out/);
  });

  test('a listed importer counts; a retailer that only sold it does not', async () => {
    fakeNet([
      ['RecallTitle=', []],
      ['Manufacturer=Brindle', [
        cpscRecall({ Title: 'Play Yards Recalled Due to Entrapment Hazard', Importers: [{ Name: 'Brindle Goods Inc., of Austin, Texas' }] }),
        cpscRecall({ RecallNumber: '22002', RecallID: 2, Title: 'Lamps Recalled Due to Fire Hazard', Importers: [], Retailers: [{ Name: 'Brindle Goods stores nationwide' }] }),
      ]],
    ]);
    const r = await cpscRecallsConnector.run({ kind: 'company', value: 'Brindle Goods' }, ctxFor(createSubject({ name: 'Dana Quillfeather', company: 'Brindle Goods' })));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].title).toMatch(/^1 consumer product recall by Brindle Goods Inc\./);
    expect(r.findings[0].quote).toMatch(/Play Yards/);
    expect(r.findings[0].quote).not.toMatch(/Lamps|Austin/);
  });

  test('a one-word ordinary company name stays possible', async () => {
    fakeNet([['RecallTitle=Flow', [cpscRecall({ Title: 'Flow Recalls Water Bottles Due to Laceration Hazard', Importers: [] })]], ['Manufacturer=Flow', []]]);
    const r = await cpscRecallsConnector.run({ kind: 'company', value: 'Flow' }, ctxFor(createSubject({ name: 'Dana Quillfeather', company: 'Flow' })));
    expect(r.findings.map((f) => f.match)).toEqual(['possible']);
    expect(r.findings[0].matchReasons.join(' ')).toMatch(/verify it is the same company/);
  });

  test('no recall: a plain note saying what was searched', async () => {
    fakeNet([['saferproducts.gov', []]]);
    const r = await cpscRecallsConnector.run({ kind: 'company', value: 'Quorrel' }, ctxFor(subject()));
    expect(r.findings).toEqual([]);
    expect(r.partial).toBeUndefined();
    expect(r.notes[0]).toMatch(/CPSC recall notices were searched .* a firm named Quorrel; none was found/);
    for (const n of r.notes) expect(n).not.toMatch(BANNED);
  });

  test('an access-denied page, a non-list answer or a changed format is a failure', async () => {
    fakeNet([['saferproducts.gov', '<html><body>Access Denied</body></html>']]);
    await expect(cpscRecallsConnector.run({ kind: 'company', value: 'Quorrel' }, ctxFor(subject()))).rejects.toThrow(/not JSON/);
    __resetCacheForTests();
    fakeNet([['saferproducts.gov', { message: 'moved' }]]);
    await expect(cpscRecallsConnector.run({ kind: 'company', value: 'Quorrel' }, ctxFor(subject()))).rejects.toThrow(/unexpected answer/);
    __resetCacheForTests();
    fakeNet([['saferproducts.gov', [{ id: 1, name: 'Quorrel Recalls Bikes' }]]]);
    await expect(cpscRecallsConnector.run({ kind: 'company', value: 'Quorrel' }, ctxFor(subject()))).rejects.toThrow(/changed format/);
    __resetCacheForTests();
    // a busy service answers with one pseudo-record whose title is its error (seen live on 2026-11-20)
    fakeNet([['saferproducts.gov', [{ RecallID: 0, RecallNumber: null, RecallDate: null, Title: 'Error retrieving Recalls: The underlying provider failed on Open.', URL: null, Products: [], Hazards: [], Manufacturers: [], Importers: [] }]]]);
    await expect(cpscRecallsConnector.run({ kind: 'company', value: 'Quorrel' }, ctxFor(subject()))).rejects.toThrow(/reported an error/);
  });

  test('one of the two searches failing keeps the other\'s recalls and is partial', async () => {
    fakeNet([['RecallTitle=', [cpscRecall()]], ['Manufacturer=', { __status: 403, body: 'denied' }]]);
    const r = await cpscRecallsConnector.run({ kind: 'company', value: 'Quorrel' }, ctxFor(subject()));
    expect(r.findings).toHaveLength(1);
    expect(r.partial).toEqual(['CPSC product recalls (the manufacturer search for Quorrel did not answer)']);
  });

  test('a search is cached for the day', async () => {
    const calls = fakeNet([['RecallTitle=Quorrel', [cpscRecall()]], ['Manufacturer=Quorrel', []]]);
    await cpscRecallsConnector.run({ kind: 'company', value: 'Quorrel' }, ctxFor(subject()));
    await cpscRecallsConnector.run({ kind: 'company', value: 'Quorrel' }, ctxFor(subject()));
    expect(calls).toHaveLength(2);
  });
});
