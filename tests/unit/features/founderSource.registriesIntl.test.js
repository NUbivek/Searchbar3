/**
 * @jest-environment node
 *
 * The Norwegian, Czech and Finnish company registers (registriesIntl.js), with
 * the network faked from the shapes the registers served on 20 Nov 2026
 * (shortened, people invented). What matters most: a register is asked only
 * about a company that plausibly belongs to its country; an officer who only
 * shares the person's name is 'possible' and never 'confirmed'; birth dates and
 * addresses never reach a record; a register that answers in another shape or
 * refuses the search is a failure or a partial search, never "no match".
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const R = require('../../../src/server/founder/sources/registriesIntl');

const {
  noCompanyRegisterConnector: NO, czCompanyRegisterConnector: CZ, fiTradeRegisterConnector: FI, INTL_REGISTRY_CONNECTORS,
  parseBrregSearch, parseBrregRoles, parseAresExtract, parsePrhCompanies, planSigns, withoutForm, __resetIntlForTests,
} = R;

const respond = (body, status = 200) => ({ status, ok: status < 400, headers: new Map(), url: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function fakeNet(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, body: init && init.body ? String(init.body) : '' });
    const hit = routes.find(([part]) => url.includes(part));
    if (!hit) return respond('{"kod":"NENALEZENO"}', 404);
    const body = typeof hit[1] === 'function' ? hit[1](url, init) : hit[1];
    return body && body.__status ? respond(body.body || '', body.__status) : respond(body);
  });
  return calls;
}
const ctxFor = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });
const milton = () => createSubject({ name: 'Trevor Milton', company: 'Nikola' });
const everything = (r) => JSON.stringify(r);

beforeEach(() => { __resetCacheForTests(); __resetIntlForTests({ unpaced: true }); });
afterEach(() => setTransport());

/* ------------------------------------------------------------------ fixtures (real shapes, invented people) */

const noEntity = (o) => ({
  _links: { self: { href: 'https://data.brreg.no/enhetsregisteret/api/enheter/923780076' } },
  organisasjonsnummer: '923780076', navn: 'NIKOLA AS',
  organisasjonsform: { kode: 'AS', beskrivelse: 'Aksjeselskap' },
  forretningsadresse: { adresse: ['Testveien 12'], postnummer: '1358', poststed: 'JAR', kommune: 'BÆRUM', land: 'Norge', landkode: 'NO' },
  stiftelsesdato: '2019-10-08', registreringsdatoEnhetsregisteret: '2019-11-11', historiskeNavn: [], konkurs: false, underAvvikling: false,
  underTvangsavviklingEllerTvangsopplosning: false, naeringskode1: { kode: '00.000', beskrivelse: 'Uoppgitt' }, ...o,
});
const NO_SEARCH = { _embedded: { enheter: [
  noEntity({}),
  noEntity({ organisasjonsnummer: '914235731', navn: 'NIKOLA GROZNIK', organisasjonsform: { kode: 'ENK' }, epostadresse: 'someone@example.com', mobil: '974 66 366' }),
  noEntity({ organisasjonsnummer: '914000001', navn: 'NIKOLA INVEST AS', stiftelsesdato: '2014-08-27' }),
] }, page: { size: 20, totalElements: 3, totalPages: 1, number: 0 } };
const person = (fornavn, etternavn, kode, beskrivelse, extra = {}) => ({
  avregistrert: false, rekkefolge: 0, ...extra,
  person: { erDoed: false, fodselsdato: '1982-04-07', navn: { fornavn, etternavn, ...(extra.mellomnavn ? { mellomnavn: extra.mellomnavn } : {}) } },
  type: { kode, beskrivelse },
});
const NO_ROLES = { rollegrupper: [
  { type: { kode: 'DAGL', beskrivelse: 'Daglig leder/ adm.direktør' }, sistEndret: '2021-03-02', roller: [person('Kari', 'Nordvik', 'DAGL', 'Daglig leder/ adm.direktør')] },
  { type: { kode: 'STYR', beskrivelse: 'Styre' }, sistEndret: '2019-11-11', roller: [
    person('Trevor', 'Milton', 'LEDE', 'Styrets leder', { mellomnavn: 'Robert' }),
    person('Ola', 'Bakketun', 'MEDL', 'Styremedlem'),
  ] },
  { type: { kode: 'REGN', beskrivelse: 'Regnskapsfører' }, sistEndret: '2025-05-19', roller: [{ avregistrert: false, enhet: { organisasjonsnummer: '966456108', navn: ['ALTO ACCOUNTING AS'], organisasjonsform: { kode: 'AS' } }, type: { kode: 'REGN', beskrivelse: 'Regnskapsfører' } }] },
] };

const czSubject = (o) => ({
  ico: '06743412', obchodniJmeno: 'NIKOLA s.r.o.', pravniForma: '112', datumVzniku: '2018-01-08', datumAktualizace: '2026-11-20',
  sidlo: { kodStatu: 'CZ', nazevObce: 'Praha', nazevUlice: 'Testovací', cisloDomovni: 1670, psc: 14000 },
  seznamRegistraci: { stavZdrojeVr: 'AKTIVNI', stavZdrojeRes: 'AKTIVNI', stavZdrojeIr: 'NEEXISTUJICI' }, ...o,
});
const CZ_SEARCH = { pocetCelkem: 3, ekonomickeSubjekty: [
  czSubject({}),
  czSubject({ ico: '09221492', obchodniJmeno: 'NIKOLA CB s.r.o.' }),
  czSubject({ ico: '12345678', obchodniJmeno: 'Nikola Testová', pravniForma: '101' }),
] };
const fo = (jmeno, prijmeni) => ({ jmeno, prijmeni, titulPred: 'Ing.', datumNarozeni: '1982-04-07', adresa: { nazevObce: 'Brno', nazevUlice: 'Domácí', cisloDomovni: 7, textovaAdresa: 'Domácí 7, Brno' } });
const CZ_EXTRACT = { icoId: '06743412', zaznamy: [{
  ico: '06743412', primarniZaznam: true, stavSubjektu: 'AKTIVNI', rejstrik: 'OR',
  obchodniJmeno: [{ datumZapisu: '2018-01-08', datumVymazu: '2020-02-01', hodnota: 'NIKOLA spedice s.r.o.' }, { datumZapisu: '2020-02-01', hodnota: 'NIKOLA s.r.o.' }],
  adresy: [{ adresa: { textovaAdresa: 'Testovací 1670, Praha' } }],
  statutarniOrgany: [{ nazevOrganu: 'Statutární orgán', typOrganu: 'STATUTARNI_ORGAN', datumZapisu: '2018-01-08', clenoveOrganu: [
    // the same membership written twice: struck when an address changed, then written again
    { typAngazma: 'STATUTARNI_ORGAN_CLEN', nazevAngazma: 'Člen statutárního orgánu', fyzickaOsoba: fo('Trevor', 'Milton'), clenstvi: { funkce: { vznikFunkce: '2018-01-08', nazev: 'jednatel' } }, datumZapisu: '2018-01-08', datumVymazu: '2022-06-27' },
    { typAngazma: 'STATUTARNI_ORGAN_CLEN', nazevAngazma: 'Člen statutárního orgánu', fyzickaOsoba: fo('Trevor', 'Milton'), clenstvi: { funkce: { vznikFunkce: '2018-01-08', zanikFunkce: '2023-05-31', nazev: 'jednatel' } }, datumZapisu: '2022-06-27', datumVymazu: '2023-06-02' },
    { typAngazma: 'STATUTARNI_ORGAN_CLEN', nazevAngazma: 'Člen statutárního orgánu', fyzickaOsoba: fo('Jana', 'Dvořáčková'), clenstvi: { funkce: { vznikFunkce: '2023-05-31', nazev: 'jednatel' } }, datumZapisu: '2023-06-02' },
  ] }],
  ostatniOrgany: [{ nazevOrganu: 'Dozorčí rada', typOrganu: 'DOZORCI_RADA', clenoveOrganu: [
    { fyzickaOsoba: fo('Petr', 'Šťastný'), clenstvi: { clenstvi: { vznikClenstvi: '2019-03-01' }, funkce: { nazev: 'předseda dozorčí rady' } }, datumZapisu: '2019-03-05' },
  ] }],
}] };

const fiCompany = (o) => ({
  businessId: { value: '2336509-6', registrationDate: '2010-06-14', source: '3' },
  names: [{ name: 'Nikola Trucks Oy', type: '1', registrationDate: '2010-06-14', version: 1, source: '1' }],
  mainBusinessLine: { type: '29100', descriptions: [{ languageCode: '1', description: 'Moottoriajoneuvojen valmistus' }, { languageCode: '3', description: 'Manufacture of motor vehicles' }] },
  website: { url: 'www.nikolatrucks.fi', registrationDate: '2024-10-03', source: '0' },
  companyForms: [{ type: '16', descriptions: [{ languageCode: '1', description: 'Osakeyhtiö' }, { languageCode: '3', description: 'Limited company' }], registrationDate: '2010-06-14', version: 1 }],
  companySituations: [], registeredEntries: [],
  addresses: [{ type: 1, street: 'Testikatu', postCode: '00530', postOffices: [{ city: 'HELSINKI', languageCode: '1' }] }],
  tradeRegisterStatus: '1', status: '2', registrationDate: '2010-06-14', lastModified: '2026-01-01T00:00:00', ...o,
});
const FI_SEARCH = { totalResults: 2, companies: [
  fiCompany({}),
  fiCompany({ businessId: { value: '0934628-6' }, names: [{ name: 'Helsingin Nikola Oy', type: '1', registrationDate: '1993-07-28', endDate: '2018-10-08' }], endDate: '2018-10-08', tradeRegisterStatus: '4' }),
] };

/* ------------------------------------------------------------------ the set */

describe('the three registers', () => {
  test('ids, labels and kinds follow the contract', () => {
    const BANNED = /\b(api|endpoint|key|token|free|paid|tier|quota|env)\b/i;
    expect(INTL_REGISTRY_CONNECTORS.map((c) => c.id)).toEqual(['no-company-register', 'cz-company-register', 'fi-trade-register']);
    for (const c of INTL_REGISTRY_CONNECTORS) {
      expect(c.label).not.toMatch(BANNED);
      expect(c.kinds).toEqual(['company']);
      expect(c.prior).toBeGreaterThan(0);
    }
  });

  test('legal forms come off a name, national or general', () => {
    expect(withoutForm('Nikola s.r.o.')).toBe('Nikola');
    expect(withoutForm('Nikola, spol. s r.o.')).toBe('Nikola');
    expect(withoutForm('Nikola a.s.')).toBe('Nikola');
    expect(withoutForm('Nikola Trucks Oy')).toBe('Nikola Trucks');
    expect(withoutForm('Nikola ASA')).toBe('Nikola');
    expect(withoutForm('Atlas')).toBe('Atlas');
  });
});

/* ------------------------------------------------------------------ plan: which register is asked */

describe('plan(): a register is asked only about a company placed in its country', () => {
  const subject = milton();
  test('a US company that is not the one given costs no foreign lookup', () => {
    for (const c of INTL_REGISTRY_CONNECTORS) expect(c.plan({ kind: 'company', value: 'Theranos', why: 'board seat' }, subject)).toEqual([]);
  });
  test('the company given gets one late lookup that decides from the records', () => {
    const [p] = NO.plan({ kind: 'company', value: 'Nikola', why: 'the company given' }, subject);
    expect(p.template).toBe('intl.no.if-placed');
    expect(p.prior).toBeLessThan(0.2);
  });
  test('a national legal form, a national word or a national web address places it', () => {
    expect(NO.plan({ kind: 'company', value: 'Nikola AS', why: '' }, subject)[0].template).toBe('intl.no.company');
    expect(CZ.plan({ kind: 'company', value: 'Nikola s.r.o.', why: '' }, subject)[0].template).toBe('intl.cz.company');
    expect(FI.plan({ kind: 'company', value: 'Nikola Trucks Oy', why: '' }, subject)[0].template).toBe('intl.fi.company');
    expect(NO.plan({ kind: 'company', value: 'Hydrogen Motors', why: 'Norwegian company where a Trevor Milton is board member' }, subject)).toHaveLength(1);
    // the form of one country does not place it in another
    const other = createSubject({ name: 'Trevor Milton', company: 'Hyla Trucking' });
    expect(CZ.plan({ kind: 'company', value: 'Nikola AS', why: '' }, other)).toEqual([]);
    expect(FI.plan({ kind: 'company', value: 'Nikola AB', why: '' }, other)).toEqual([]);
    const s = milton();
    addAnchor(s, 'domains', 'hydrogenmotors.no');
    expect(planSigns('NO', { value: 'Hydrogen Motors' }, s)).toEqual(['its web address is on the .no domain']);
  });
  test('other thread kinds are never planned', () => {
    expect(NO.plan({ kind: 'subject', value: 'Trevor Milton' }, subject)).toEqual([]);
  });
});

describe('run(): not asked is said in a note, and nothing is fetched', () => {
  test('no sign at all', async () => {
    const calls = fakeNet([]);
    for (const c of INTL_REGISTRY_CONNECTORS) {
      const r = await c.run({ kind: 'company', value: 'Nikola', template: 'x.if-placed', why: 'the company given' }, ctxFor(milton()));
      expect(r.findings).toEqual([]);
      expect(r.notes.join(' ')).toMatch(/was not asked about Nikola: nothing found so far places it in/);
      expect(r.partial).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
  });
  test('a tied LEI record with the country\'s jurisdiction places it', async () => {
    const calls = fakeNet([['/roller', NO_ROLES], ['/enheter?', NO_SEARCH]]);
    const lei = { source: 'lei-register', match: 'company', category: 'corporate', title: 'LEI record: NIKOLA AS', quote: 'NIKOLA AS', url: 'https://search.gleif.org/x', data: { jurisdiction: 'NO' } };
    const r = await NO.run({ kind: 'company', value: 'Nikola', why: 'the company given' }, ctxFor(milton(), [lei]));
    expect(calls.length).toBeGreaterThan(0);
    expect(r.findings.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ Norway */

describe('no-company-register', () => {
  test('the person as an officer of a company tied to them: likely, with the role in data; never a birth date', async () => {
    const calls = fakeNet([['/roller', NO_ROLES], ['/enheter?', NO_SEARCH]]);
    const r = await NO.run({ kind: 'company', value: 'Nikola AS', why: '' }, ctxFor(milton()));
    // the search asks for companies only, never sole traders
    expect(calls[0].url).toMatch(/navn=Nikola&/);
    expect(decodeURIComponent(calls[0].url)).toMatch(/organisasjonsform=AS,ASA/);
    expect(decodeURIComponent(calls[0].url)).not.toMatch(/ENK/);
    const role = r.findings.find((f) => f.data?.person);
    expect(role.match).toBe('likely');
    expect(role.title).toBe('Trevor Milton: chair of the board of Nikola AS (Norwegian company register), current');
    expect(role.data).toMatchObject({ country: 'NO', company: 'Nikola AS', registerNumber: '923780076', person: 'Trevor Robert Milton', role: 'chair of the board', roleCode: 'LEDE', current: true, roleGroupLastChanged: '2019-11-11' });
    const company = r.findings.find((f) => !f.data?.person);
    expect(company.match).toBe('company');
    expect(company.url).toBe('https://virksomhet.brreg.no/oppslag/enheter/923780076');
    expect(company.quote).toMatch(/Kari Nordvik \(chief executive/);
    // co-officers become associates; the accounting firm does not
    expect(r.threads.map((t) => t.value).sort()).toEqual(['Kari Nordvik', 'Ola Bakketun']);
    expect(r.threads.every((t) => t.kind === 'associate' && t.trusted)).toBe(true);
    const text = everything(r);
    expect(text).not.toMatch(/1982|fodselsdato|Testveien|1358|974 66 366|example\.com|GROZNIK/);
    expect(r.findings.some((f) => f.match === 'confirmed')).toBe(false);
  });

  test('a namesake officer of a company not tied to the person: possible, "verify identity"', async () => {
    fakeNet([['/roller', NO_ROLES], ['/enheter?', NO_SEARCH]]);
    const subject = createSubject({ name: 'Trevor Milton', company: 'Hyla Trucking' });
    const r = await NO.run({ kind: 'company', value: 'Nikola AS', why: '' }, ctxFor(subject));
    const role = r.findings.find((f) => f.data?.person);
    expect(role.match).toBe('possible');
    expect(role.title).toMatch(/name match only, verify identity$/);
    expect(r.threads).toEqual([]);
    const company = r.findings.find((f) => !f.data?.person);
    // "Nikola" is one word of name: many unrelated companies share it
    expect(company.match).toBe('possible');
    expect(company.severity).toBe('info');
  });

  test('the person is not among the officers: said in plain words', async () => {
    fakeNet([['/roller', NO_ROLES], ['/enheter?', NO_SEARCH]]);
    const r = await NO.run({ kind: 'company', value: 'Nikola AS', why: '' }, ctxFor(createSubject({ name: 'Elizabeth Holmes', company: 'Nikola' })));
    expect(r.findings.some((f) => f.data?.person)).toBe(false);
    expect(r.notes.join(' ')).toMatch(/Elizabeth Holmes is not among the current officers of Nikola AS \(the register lists current roles only/);
  });

  test('no exact name: a note; more similar names than one page: partial', async () => {
    fakeNet([['/enheter?', { ...NO_SEARCH, _embedded: { enheter: [NO_SEARCH._embedded.enheter[2]] }, page: { totalElements: 1 } }]]);
    let r = await NO.run({ kind: 'company', value: 'Nikola AS', why: '' }, ctxFor(milton()));
    expect(r.findings).toEqual([]);
    expect(r.notes[0]).toMatch(/no company is registered under the exact name Nikola \(1 company with a similar name was not reported\)/);
    expect(r.partial).toBeUndefined();
    __resetCacheForTests();
    fakeNet([['/enheter?', { _embedded: { enheter: [NO_SEARCH._embedded.enheter[2]] }, page: { totalElements: 340 } }]]);
    r = await NO.run({ kind: 'company', value: 'Nikola AS', why: '' }, ctxFor(milton()));
    expect(r.partial).toHaveLength(1);
  });

  test('an answer in another shape, or no answer, is a failure, never "no match"', async () => {
    fakeNet([['/enheter?', { results: [] }]]);
    await expect(NO.run({ kind: 'company', value: 'Nikola AS', why: '' }, ctxFor(milton()))).rejects.toThrow(/unexpected format/);
    __resetCacheForTests();
    fakeNet([['/roller', { roles: [] }], ['/enheter?', NO_SEARCH]]);
    await expect(NO.run({ kind: 'company', value: 'Nikola AS', why: '' }, ctxFor(milton()))).rejects.toThrow(/officer list/);
    __resetCacheForTests();
    fakeNet([['/enheter?', { __status: 500 }]]);
    await expect(NO.run({ kind: 'company', value: 'Nikola AS', why: '' }, ctxFor(milton()))).rejects.toThrow();
    expect(() => parseBrregSearch({ page: { totalElements: 2 } })).toThrow();
  });

  test('the roles parser keeps names and roles only', () => {
    const officers = parseBrregRoles(NO_ROLES);
    expect(officers).toHaveLength(4);
    expect(officers.find((o) => o.roleCode === 'REGN')).toMatchObject({ name: 'Alto Accounting AS', person: false, adviser: true });
    expect(JSON.stringify(officers)).not.toMatch(/1982|erDoed/);
  });

  test('one lookup per company per day: the second ask is served from the cache', async () => {
    const calls = fakeNet([['/roller', NO_ROLES], ['/enheter?', NO_SEARCH]]);
    await NO.run({ kind: 'company', value: 'Nikola AS', why: '' }, ctxFor(milton()));
    const n = calls.length;
    await NO.run({ kind: 'company', value: 'Nikola ASA', why: '' }, ctxFor(milton()));
    expect(calls.length).toBe(n);
  });
});

/* ------------------------------------------------------------------ Czech Republic */

describe('cz-company-register', () => {
  test('the person\'s membership with start and end dates; rewritten entries are one spell; no birth date or address', async () => {
    const calls = fakeNet([['/ekonomicke-subjekty-vr/06743412', CZ_EXTRACT], ['/vyhledat', CZ_SEARCH]]);
    const r = await CZ.run({ kind: 'company', value: 'Nikola s.r.o.', why: '' }, ctxFor(milton()));
    const body = JSON.parse(calls[0].body);
    expect(body.obchodniJmeno).toBe('Nikola');
    expect(body.pravniForma).toContain('112');
    expect(body.pravniForma.some((f) => /^10\d$/.test(f))).toBe(false);
    const roles = r.findings.filter((f) => f.data?.person);
    expect(roles).toHaveLength(1);
    const [role] = roles;
    expect(role.match).toBe('likely');
    expect(role.title).toBe('Trevor Milton: managing director (jednatel) of NIKOLA s.r.o. (Czech company register), from 8 January 2018 until 31 May 2023');
    expect(role.data).toMatchObject({ country: 'CZ', registerNumber: '06743412', from: '2018-01-08', to: '2023-05-31', current: false, appointments: [{ role: 'managing director (jednatel)', appointed: '2018-01-08', resigned: '2023-05-31' }] });
    expect(role.date).toBe('2018-01-08');
    const company = r.findings.find((f) => !f.data?.person);
    expect(company.match).toBe('company');
    expect(company.quote).toMatch(/Earlier names: NIKOLA spedice s\.r\.o\./);
    expect(company.quote).toMatch(/Petr Šťastný \(chair of the supervisory board\)/);
    expect(company.url).toBe('https://ares.gov.cz/ekonomicke-subjekty?ico=06743412');
    expect(r.threads.map((t) => t.value).sort()).toEqual(['Jana Dvořáčková', 'Petr Šťastný']);
    expect(everything(r)).not.toMatch(/1982|Domácí|Brno|Testovací|datumNarozeni|Nikola Testová/);
  });

  test('accents are folded when the person is matched', async () => {
    fakeNet([['/ekonomicke-subjekty-vr/06743412', CZ_EXTRACT], ['/vyhledat', CZ_SEARCH]]);
    const r = await CZ.run({ kind: 'company', value: 'Nikola s.r.o.', why: '' }, ctxFor(createSubject({ name: 'Jana Dvorackova', company: 'Nikola' })));
    const role = r.findings.find((f) => f.data?.person);
    expect(role.data.person).toBe('Jana Dvořáčková');
    expect(role.data.current).toBe(true);
    expect(role.title).toMatch(/from 31 May 2023 to the present$/);
  });

  test('extract parser: struck and rewritten entries merge; a later spell after a gap stays apart', () => {
    const z = JSON.parse(JSON.stringify(CZ_EXTRACT));
    z.zaznamy[0].statutarniOrgany[0].clenoveOrganu.push({ fyzickaOsoba: fo('Trevor', 'Milton'), clenstvi: { funkce: { vznikFunkce: '2025-01-01', nazev: 'jednatel' } }, datumZapisu: '2025-01-03' });
    const { officers } = parseAresExtract(z);
    const spells = officers.filter((o) => o.name === 'Trevor Milton');
    expect(spells.map((s) => [s.from, s.to])).toEqual([['2025-01-01', null], ['2018-01-08', '2023-05-31']]);
    expect(() => parseAresExtract({ zaznamy: [] })).toThrow();
  });

  test('the register refuses a name too many companies share: partial, not "no match"', async () => {
    fakeNet([['/vyhledat', { __status: 400, body: '{"kod":"CHYBA_VSTUPU","subKod":"VYSTUP_PRILIS_MNOHO_VYSLEDKU"}' }]]);
    const r = await CZ.run({ kind: 'company', value: 'Nikola s.r.o.', why: '' }, ctxFor(milton()));
    expect(r.findings).toEqual([]);
    expect(r.partial).toHaveLength(1);
    expect(r.notes[0]).toMatch(/search was not completed/);
  });

  test('a company outside the public register: the record without officers, and a note', async () => {
    fakeNet([['/vyhledat', { pocetCelkem: 1, ekonomickeSubjekty: [czSubject({ seznamRegistraci: { stavZdrojeVr: 'NEEXISTUJICI' } })] }]]);
    const r = await CZ.run({ kind: 'company', value: 'Nikola s.r.o.', why: '' }, ctxFor(milton()));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].quote).toMatch(/Not in the public \(commercial\) register/);
    expect(r.notes.join(' ')).toMatch(/is not in the public register, so its officers could not be checked/);
  });

  test('a search answer in another shape throws', async () => {
    fakeNet([['/vyhledat', { subjekty: [] }]]);
    await expect(CZ.run({ kind: 'company', value: 'Nikola s.r.o.', why: '' }, ctxFor(milton()))).rejects.toThrow(/unexpected format/);
  });
});

/* ------------------------------------------------------------------ Finland */

describe('fi-trade-register', () => {
  test('one company under the exact name of two words: a company record, with no people and no address', async () => {
    fakeNet([['/companies?', FI_SEARCH]]);
    const r = await FI.run({ kind: 'company', value: 'Nikola Trucks Oy', why: '' }, ctxFor(milton()));
    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    expect(f.match).toBe('company');
    expect(f.matchReasons[0]).toMatch(/lists no people, so the tie rests on the name/);
    expect(f.title).toBe('Finnish trade register: Nikola Trucks Oy, registered 14 June 2010');
    expect(f.quote).toMatch(/business ID 2336509-6 — Legal form: Limited company/);
    expect(f.quote).toMatch(/Main line of business: Manufacture of motor vehicles/);
    expect(f.url).toBe('https://tietopalvelu.ytj.fi/yritys/2336509-6');
    expect(r.notes.join(' ')).toMatch(/lists no people, so Trevor Milton's role at Nikola Trucks cannot be checked there/);
    expect(everything(r)).not.toMatch(/Testikatu|00530/);
  });

  test('a bankrupt company is flagged; an earlier name is matched; a one-word name stays possible', async () => {
    const bankrupt = fiCompany({ names: [{ name: 'Nikola Oy', type: '1', registrationDate: '2015-01-01' }, { name: 'Vanha Nikola Oy', type: '1', registrationDate: '2010-01-01', endDate: '2014-12-31' }], companySituations: [{ type: 'KONK', registrationDate: '2026-11-12' }] });
    fakeNet([['/companies?', { totalResults: 1, companies: [bankrupt] }]]);
    const r = await FI.run({ kind: 'company', value: 'Vanha Nikola Oy', why: '' }, ctxFor(milton()));
    expect(r.findings[0].title).toMatch(/Nikola Oy, BANKRUPT/);
    expect(r.findings[0].match).toBe('company');
    expect(r.findings[0].severity).toBe('medium');
    __resetCacheForTests();
    fakeNet([['/companies?', { totalResults: 1, companies: [bankrupt] }]]);
    const one = await FI.run({ kind: 'company', value: 'Nikola Oy', why: '' }, ctxFor(milton()));
    expect(one.findings[0].match).toBe('possible');
    expect(one.findings[0].severity).toBe('info');
    expect(one.findings[0].title).toMatch(/verify it is the same company/);
  });

  test('an answer in another shape throws; an empty one is a note', async () => {
    expect(() => parsePrhCompanies({ results: [] })).toThrow();
    fakeNet([['/companies?', { totalResults: 0, companies: [] }]]);
    const r = await FI.run({ kind: 'company', value: 'Nikola Trucks Oy', why: '' }, ctxFor(milton()));
    expect(r.notes[0]).toMatch(/no company is registered under the exact name Nikola Trucks/);
    expect(r.partial).toBeUndefined();
  });
});
