/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const O = require('../../../src/server/founder/sources/opensanctions');

const { openSanctionsConnector: c, parseTargets, readMetadata, listingReason, DATASETS, GROUPS, INTERPOL_NOTE } = O;

/* ------------------------------------------------------------------ */
/* Fixtures in the shape data.opensanctions.org served on 20 Nov 2026  */
/* (header and quoting as served; the people are invented)             */
/* ------------------------------------------------------------------ */

const HEADER = '"id","schema","name","aliases","birth_date","countries","addresses","identifiers","sanctions","phones","emails","program_ids","dataset","first_seen","last_seen","last_change"';
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const row = (o) => [o.id, o.schema || 'LegalEntity', o.name, o.aliases || '', o.birth || '', o.countries || '', o.addresses || '', o.identifiers || '', o.sanctions ?? '""', o.phones || '', o.emails || '', o.program || '', o.dataset, o.first || '2024-03-04T17:09:51', '2026-11-20T00:33:15', o.change || '2025-09-15T18:27:02'].map(q).join(',');
const csv = (rows) => `${[HEADER, ...rows].join('\n')}\n`;
const filler = (ds, n, schema = 'LegalEntity') => Array.from({ length: n }, (_, i) => row({ id: `${ds}-f${i}`, schema, name: `Filler Person${i} Example${i}`, dataset: ds }));

const INTERPOL = csv([
  row({ id: 'interpol-red-2019-11111', schema: 'Person', name: 'JANE QUILLFEATHER', birth: '1980-02-03', countries: 'ru', sanctions: 'Aggravated misappropriation by fraud, money-laundering', program: 'INTERPOL-RN', dataset: 'INTERPOL Red Notices' }),
  row({ id: 'interpol-red-2019-22222', schema: 'Person', name: 'ANNA JANE QUILLFEATHER', birth: '1990-02-03', countries: 'ua', sanctions: 'murder', dataset: 'INTERPOL Red Notices' }),
  row({ id: 'interpol-red-2019-33333', schema: 'Person', name: 'Otto Brannigan', countries: 'ua', sanctions: 'Murder of three minors', dataset: 'INTERPOL Red Notices' }),
  ...filler('INTERPOL Red Notices', 20, 'Person'),
]);

const WORLDBANK = csv([
  row({ id: 'NK-wb1', name: 'MR. KAZIMIR VELLACOURT #4471', countries: 'ru;se', addresses: 'LAST KNOWN ADDRESS: 1 Secret Lane, Stockholm', sanctions: 'Consultant Guidelines, 1.22(a)(i) - 2015-10-30 - 2999-12-31', dataset: 'WorldBank Debarred Providers' }),
  row({ id: 'NK-wb2', name: 'BRIGHTWATER PUMPS LIMITED', aliases: 'Brightwater Pumps Co.;布莱特沃特', countries: 'cn', sanctions: 'Cross Debarment: ADB - 2024-08-22 - 2027-07-22', dataset: 'WorldBank Debarred Providers' }),
  row({ id: 'NK-wb3', name: 'Halvorsen Grid Systems AS', countries: 'no', sanctions: 'Fraudulent Practice involving Halvorsen Grid Systems - 2023-01-01 - 2026-12-31', dataset: 'WorldBank Debarred Providers' }),
  ...filler('WorldBank Debarred Providers', 20),
]);

const FINRA_BARRED = csv([
  row({ id: 'NK-fb1', schema: 'Person', name: 'MARGUERITE DELACROIX-FENN', identifiers: '4561368', countries: 'us', sanctions: '', dataset: 'US FINRA Barred Individuals' }),
  ...filler('US FINRA Barred Individuals', 20, 'Person'),
]);
const SEC_HARMED = csv([
  row({ id: 'NK-sec1', name: 'Zephyrine Corporation', countries: 'us', dataset: 'US SEC Actions Due to Harmed Investors' }),
  row({ id: 'NK-sec2', name: 'Zephyrine Grantham', countries: 'us', sanctions: 'Fraud in the sale of Zephyrine Corporation securities', dataset: 'US SEC Actions Due to Harmed Investors' }),
  ...filler('US SEC Actions Due to Harmed Investors', 20),
]);

const meta = (id, count, extra = {}) => JSON.stringify({
  updated_at: '2026-11-20T20:44:06', target_count: count, url: `https://publisher.example.org/${id}`,
  resources: [
    { name: 'entities.ftm.json', url: `https://data.opensanctions.org/artifacts/${id}/v1/entities.ftm.json`, size: 1000 },
    { name: 'targets.simple.csv', url: `https://data.opensanctions.org/artifacts/${id}/v1/targets.simple.csv`, size: 5000 },
  ],
  ...extra,
});
const countRows = (text) => text.trim().split('\n').length - 1;

/** Every list in a group served; the ones not given here are small, valid files with only filler. */
function routesFor(overrides = {}) {
  const files = { interpol_red_notices: INTERPOL, worldbank_debarred: WORLDBANK, us_finra_barred: FINRA_BARRED, us_sec_harmed_investors: SEC_HARMED };
  const routes = {};
  for (const d of DATASETS) {
    const text = files[d.id] || csv(filler(d.name, 3, d.people ? 'Person' : 'LegalEntity'));
    routes[`/datasets/latest/${d.id}/index.json`] = meta(d.id, countRows(text));
    routes[`/artifacts/${d.id}/v1/targets.simple.csv`] = text;
  }
  return { ...routes, ...overrides };
}

let calls = [];
function serve(routes) {
  setTransport(async (url, init) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key] : { status: 404, body: 'not found' };
    const headers = { get: () => null };
    if (typeof r === 'string') return { status: 200, headers, url, text: async () => r };
    return { status: r.status || 200, headers, url, text: async () => r.body };
  });
}

const ENV = { ...process.env };
beforeEach(() => { __resetCacheForTests(); calls = []; });
afterEach(() => { setTransport(); process.env = { ...ENV }; });

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000 });
const subjectTask = (subject, template) => ({ kind: 'subject', value: subject.name, template, depth: 0 });
const ds = (id) => DATASETS.find((d) => d.id === id);

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */

describe('switch', () => {
  test('off unless FOUNDER_SOURCES_ON names it', () => {
    delete process.env.FOUNDER_SOURCES_ON;
    expect(c.enabled()).toBe(false);
    process.env.FOUNDER_SOURCES_ON = 'something-else';
    expect(c.enabled()).toBe(false);
    process.env.FOUNDER_SOURCES_ON = 'other, opensanctions-lists';
    expect(c.enabled()).toBe(true);
    process.env.FOUNDER_SOURCES_OFF = 'opensanctions-lists';
    expect(c.enabled()).toBe(false);
    expect(c.unavailableReason).toBe('not enabled on this deployment');
    expect(c.id).toBe('opensanctions-lists');
  });

  test('leaves out the politically exposed persons and Medicaid files', () => {
    const ids = DATASETS.map((d) => d.id).join(' ');
    expect(ids).not.toMatch(/peps|medicaid/);
    expect(new Set(DATASETS.map((d) => d.id)).size).toBe(DATASETS.length);
  });
});

/* ------------------------------------------------------------------ */
/* Reading a list                                                      */
/* ------------------------------------------------------------------ */

describe('reading a list', () => {
  test('keeps name, aliases, reason and dates; never birth dates, addresses, identifiers or a person\'s nationality', () => {
    const index = parseTargets(WORLDBANK, ds('worldbank_debarred'), 23);
    const person = index.rows.find((r) => /VELLACOURT/.test(r.n));
    expect(person.n).toBe('KAZIMIR VELLACOURT');
    expect(person.t).toBeUndefined(); // LegalEntity: the list does not say person or firm
    expect(person).toMatchObject({ d: '2015-10-30', e: 'no end date', s: '2024-03-04', i: 'NK-wb1' });
    expect(person.k).toBeUndefined(); // the list does not say it is a company: no country kept
    const firm = index.rows.find((r) => r.n === 'BRIGHTWATER PUMPS LIMITED');
    expect(firm.a).toEqual(['Brightwater Pumps Co.']); // the name in another script is not an alias to compare
    expect(firm).toMatchObject({ d: '2024-08-22', e: '2027-07-22' });
    const text = JSON.stringify(index);
    expect(text).not.toMatch(/Secret Lane|Stockholm|ADDRESS/i);

    const interpol = parseTargets(INTERPOL, ds('interpol_red_notices'), 23);
    const j = interpol.rows.find((r) => r.n === 'JANE QUILLFEATHER');
    expect(j.t).toBe('person');
    expect(j.r).toMatch(/money-laundering/);
    expect(JSON.stringify(interpol)).not.toMatch(/1980-02-03|"ru"|RU\b/);
    const finra = parseTargets(FINRA_BARRED, ds('us_finra_barred'), 21);
    expect(JSON.stringify(finra)).not.toMatch(/4561368/);
  });

  test('a listing reason about a child is withheld', () => {
    const index = parseTargets(INTERPOL, ds('interpol_red_notices'), 23);
    expect(index.rows.find((r) => r.n === 'Otto Brannigan').r).toMatch(/^withheld/);
    expect(JSON.stringify(index)).not.toMatch(/minors/);
    expect(listingReason('""')).toBe('');
  });

  test('a changed format, a cut-off file or too few entries is an error, never an empty list', () => {
    expect(() => parseTargets('"id","name"\n"x","y"\n', ds('worldbank_debarred'))).toThrow(/expected format/);
    expect(() => parseTargets(WORLDBANK.slice(0, -40), ds('worldbank_debarred'))).toThrow(/incomplete/);
    expect(() => parseTargets(WORLDBANK, ds('worldbank_debarred'), 1409)).toThrow(/expected/);
    expect(() => parseTargets(`${HEADER}\n`, ds('worldbank_debarred'))).toThrow(/no entries/);
  });

  test('metadata: an empty list did not answer', () => {
    expect(() => readMetadata(JSON.parse(meta('sg_x', 0)), { name: 'Some list' })).toThrow(/empty/);
    expect(() => readMetadata({ nope: 1 }, { name: 'Some list' })).toThrow(/expected format/);
    const m = readMetadata(JSON.parse(meta('worldbank_debarred', 1409)), ds('worldbank_debarred'));
    expect(m).toMatchObject({ count: 1409, url: 'https://data.opensanctions.org/artifacts/worldbank_debarred/v1/targets.simple.csv' });
    // a file address on another host is not followed
    const odd = readMetadata(JSON.parse(meta('worldbank_debarred', 5, { resources: [{ name: 'targets.simple.csv', url: 'https://evil.example.com/x.csv' }] })), ds('worldbank_debarred'));
    expect(odd.url).toBe('https://data.opensanctions.org/datasets/latest/worldbank_debarred/targets.simple.csv');
  });
});

/* ------------------------------------------------------------------ */
/* Screening                                                           */
/* ------------------------------------------------------------------ */

describe('screening', () => {
  test('plan: one lookup per group for the person, no wanted lists for a company, one lookup for a relative', () => {
    expect(c.plan({ kind: 'subject' }).map((p) => p.template)).toEqual(GROUPS.map((g) => `os.${g.key}`));
    expect(c.plan({ kind: 'company' }).map((p) => p.template)).not.toContain('os.wanted');
    expect(c.plan({ kind: 'relative' }).map((p) => p.template)).toEqual(['os.all']);
    for (const p of c.plan({ kind: 'subject' })) expect(p.template).toMatch(/^[a-z0-9.:_-]+$/i);
  });

  test('a name-only Interpol hit is possible, says verify identity, and says notices can be politically motivated', async () => {
    serve(routesFor());
    const subject = createSubject({ name: 'Jane Quillfeather', company: 'Unrelated Robotics' });
    const out = await c.run(subjectTask(subject, 'os.wanted'), ctxFor(subject));
    expect(out.findings).toHaveLength(1); // "Anna Jane Quillfeather" is not the same first and last name in order
    const f = out.findings[0];
    expect(f.match).toBe('possible');
    expect(f.title).toMatch(/verify identity/);
    expect(f.title).toMatch(/politically motivated/);
    expect(f.quote).toMatch(/Charge as stated by the requesting country: Aggravated misappropriation/);
    expect(f.quote).toContain(INTERPOL_NOTE);
    expect(f.url).toBe('https://www.opensanctions.org/entities/interpol-red-2019-11111/');
    expect(f.data).toMatchObject({ list: 'Interpol red notices', listedSince: '2024-03-04' });
    expect(`${f.title} ${f.quote}`).not.toMatch(/1980|\bRU\b/);
    expect(out.notes.join(' ')).toMatch(/politically motivated/);
    expect(out.notes.join(' ')).toMatch(/Searched for Jane Quillfeather and found no entry in: .*Hong Kong ICAC/);
    expect(out.partial).toBeUndefined();
  });

  test('a first name alone or another person with the same surname is not a hit', async () => {
    serve(routesFor());
    const subject = createSubject({ name: 'Mark Quillfeather', company: 'Acme' });
    const out = await c.run(subjectTask(subject, 'os.wanted'), ctxFor(subject));
    expect(out.findings).toHaveLength(0);
    expect(out.notes.join(' ')).toMatch(/found no entry in: Interpol red notices/);
  });

  test('a person\'s hit is raised to likely, never confirmed, when the listing names their company', async () => {
    serve(routesFor());
    const subject = createSubject({ name: 'Zephyrine Grantham', company: 'Zephyrine Corporation' });
    const out = await c.run(subjectTask(subject, 'os.us-markets'), ctxFor(subject));
    const f = out.findings.find((x) => /Grantham/.test(x.title));
    expect(f.match).toBe('likely');
    expect(f.title).not.toMatch(/verify identity/);
    for (const x of out.findings) expect(x.match).not.toBe('confirmed');
  });

  test('a person found under an honorific and an ID suffix, surname-first lists, with list dates', async () => {
    serve(routesFor());
    const subject = createSubject({ name: 'Kazimir Vellacourt', company: 'Acme' });
    const out = await c.run(subjectTask(subject, 'os.mdb'), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.match).toBe('possible');
    expect(f.quote).toMatch(/From: 2015-10-30/);
    expect(f.quote).toMatch(/Until: no end date/);
    expect(f.quote).not.toMatch(/Secret Lane|Country/);
  });

  test('a company: a whole two-word name is a company record; a one-word name stays possible', async () => {
    serve(routesFor());
    const subject = createSubject({ name: 'Jane Roe', company: 'Brightwater Pumps' });
    const out = await c.run({ kind: 'company', value: 'Brightwater Pumps', template: 'os.mdb' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('company');
    expect(out.findings[0].quote).toMatch(/Country: CN/);

    const one = await c.run({ kind: 'company', value: 'Zephyrine Corporation', template: 'os.us-markets' }, ctxFor(subject));
    const f = one.findings.find((x) => /Zephyrine Corporation/.test(x.title));
    expect(f.match).toBe('possible');
    expect(f.title).toMatch(/verify identity/);
    // a company is never screened against lists of people only
    expect(calls.some((u) => /us_finra_barred|us_fda_restricted/.test(u))).toBe(false);
  });

  test('an associate is screened by name only and stays possible', async () => {
    serve(routesFor());
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const out = await c.run({ kind: 'associate', value: 'Marguerite Delacroix-Fenn', relation: 'co-founder', template: 'os.all' }, ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].title).toMatch(/^Co-founder Marguerite Delacroix-Fenn: FINRA barred individuals/);
  });

  test('a list that is empty at the publisher is reported as not answered; the lookup is partial', async () => {
    serve(routesFor({ '/datasets/latest/hk_icac_wanted/index.json': meta('hk_icac_wanted', 0) }));
    const subject = createSubject({ name: 'Mark Quillfeather', company: 'Acme' });
    const out = await c.run(subjectTask(subject, 'os.wanted'), ctxFor(subject));
    expect(out.partial).toEqual(['Hong Kong ICAC wanted persons: did not answer']);
    expect(out.notes.join(' ')).toMatch(/Hong Kong ICAC wanted persons: could not be read .*empty.*not screened/);
    expect(out.notes.join(' ')).not.toMatch(/found no entry in: [^|]*Hong Kong ICAC/);
  });

  test('when no list of a group can be read, the lookup fails', async () => {
    serve({});
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    await expect(c.run(subjectTask(subject, 'os.mdb'), ctxFor(subject))).rejects.toThrow();
  });

  test('a changed file format makes the list fail, not come back clean', async () => {
    serve(routesFor({ '/artifacts/interpol_red_notices/v1/targets.simple.csv': '"id","label"\n"a","b"\n' }));
    const subject = createSubject({ name: 'Jane Quillfeather', company: 'Acme' });
    const out = await c.run(subjectTask(subject, 'os.wanted'), ctxFor(subject));
    expect(out.partial).toEqual(['Interpol red notices: did not answer']);
    expect(out.findings).toHaveLength(0);
  });

  test('each list is downloaded once and then served from the day\'s cache', async () => {
    serve(routesFor());
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    await c.run(subjectTask(subject, 'os.mdb'), ctxFor(subject));
    const first = calls.length;
    expect(first).toBe(DATASETS.filter((d) => d.group === 'mdb').length * 2);
    await c.run({ kind: 'relative', value: 'John Roe', relation: 'father', template: 'os.mdb' }, ctxFor(subject));
    expect(calls.length).toBe(first);
  });

  test('a name too short to screen is not reported as clean', async () => {
    serve(routesFor());
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme' });
    const out = await c.run({ kind: 'associate', value: 'Cher', template: 'os.all' }, ctxFor(subject));
    expect(out.partial).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
