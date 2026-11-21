/** @jest-environment node */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { __resetCacheForTests } = require('../../../src/server/founder/cache');
const { createSubject } = require('../../../src/server/founder/identity');
const S = require('../../../src/server/founder/sources/sanctions');

const {
  normalizeName, nameTokens, companyTokens, matchTier, matchPersonName, matchCompanyName, personVariants,
  screenIndex, reasonText, parseUsCsl, parseUn, parseUk, parseCanada, parseEu, parseOigResults, parseLeie, leieRows, parseEuMostWanted,
  sanctionsListsConnector, exclusionsConnector, offshoreLeaksConnector, wantedConnector, OFFSHORE_NOTE, LISTS,
} = S;

/* ------------------------------------------------------------------ */
/* Fixtures cut from the published files (14 Nov 2026)                */
/* ------------------------------------------------------------------ */

const CSL_HEADER = '_id,source,entity_number,type,programs,name,title,addresses,federal_register_notice,start_date,end_date,standard_order,license_requirement,license_policy,call_sign,vessel_type,gross_tonnage,gross_registered_tonnage,vessel_flag,vessel_owner,remarks,source_list_url,alt_names,citizenships,dates_of_birth,nationalities,places_of_birth,source_information_url,ids';
const cslRow = (o) => CSL_HEADER.split(',').map((k) => `"${String(o[k] ?? '').replace(/"/g, '""')}"`).join(',');
const CSL = [
  CSL_HEADER,
  cslRow({ _id: '1', source: 'Specially Designated Nationals (SDN) - Treasury Department', entity_number: '35096', type: 'Individual', programs: 'RUSSIA-EO14024', name: 'PUTIN, Vladimir Vladimirovich', title: 'President of the Russian Federation', alt_names: 'PUTIN, Vladimir', dates_of_birth: '1952-10-07', places_of_birth: 'Leningrad, Russia', addresses: 'Moscow, Russia', ids: 'Passport 1234567', start_date: '2022-02-25' }),
  cslRow({ _id: '2', source: 'Specially Designated Nationals (SDN) - Treasury Department', entity_number: '16106', type: 'Entity', programs: 'UKRAINE-EO13662; RUSSIA-EO14024', name: 'ROSOBORONEKSPORT OAO', alt_names: 'ROSOBORONEXPORT JSC; ROE', remarks: '(Linked To: STATE CORPORATION ROSTEC)' }),
  cslRow({ _id: '3', source: 'Entity List (EL) - Bureau of Industry and Security', entity_number: '', type: '', name: 'Stripe Logistics Trading FZE', source_list_url: 'https://www.bis.gov/entity-list', start_date: '2024-05-01' }),
  cslRow({ _id: '4', source: 'Specially Designated Nationals (SDN) - Treasury Department', entity_number: '777', type: 'Vessel', name: 'SEA STAR' }),
].join('\r\n') + '\r\n';

const UN = `<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST dateGenerated="2026-11-14T00:00:05.893Z">
  <INDIVIDUALS>
    <INDIVIDUAL>
      <FIRST_NAME>ERIC</FIRST_NAME><SECOND_NAME>BADEGE</SECOND_NAME>
      <UN_LIST_TYPE>DRC</UN_LIST_TYPE><REFERENCE_NUMBER>CDi.001</REFERENCE_NUMBER><LISTED_ON>2012-12-31</LISTED_ON>
      <COMMENTS1>He fled to Rwanda in March 2013.</COMMENTS1>
      <NATIONALITY><VALUE>Democratic Republic of the Congo</VALUE></NATIONALITY>
      <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Eric Badege Kabila, born 1 Jan. 1971 (passport no.03825239)</ALIAS_NAME></INDIVIDUAL_ALIAS>
      <INDIVIDUAL_DATE_OF_BIRTH><YEAR>1971</YEAR></INDIVIDUAL_DATE_OF_BIRTH>
    </INDIVIDUAL>
    <INDIVIDUAL>
      <FIRST_NAME>MOHAMMAD</FIRST_NAME><SECOND_NAME>HASSAN</SECOND_NAME><THIRD_NAME>AKHUND</THIRD_NAME>
      <UN_LIST_TYPE>Taliban</UN_LIST_TYPE><REFERENCE_NUMBER>TAi.002</REFERENCE_NUMBER><LISTED_ON>2001-01-25</LISTED_ON>
      <DESIGNATION><VALUE>First Deputy, Council of Ministers under the Taliban regime</VALUE></DESIGNATION>
    </INDIVIDUAL>
  </INDIVIDUALS>
  <ENTITIES>
    <ENTITY><FIRST_NAME>AL-QAIDA</FIRST_NAME><UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE><REFERENCE_NUMBER>QDe.004</REFERENCE_NUMBER><LISTED_ON>2001-10-06</LISTED_ON></ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>`;

const UK = `<?xml version="1.0" encoding="utf-8"?>
<Designations><DateGenerated>12/11/2026</DateGenerated>
<Designation><UniqueID>RUS0001</UniqueID><RegimeName>The Russia (Sanctions) (EU Exit) Regulations 2019</RegimeName><IndividualEntityShip>Individual</IndividualEntityShip><DateDesignated>15/03/2022</DateDesignated>
<UKStatementofReasons>Former president of Rusal. Deripaska is an involved person. He was born in Dzerzhinsk and lives in Moscow.</UKStatementofReasons>
<Names><Name><Name1>Oleg</Name1><Name2>Vladimirovich</Name2><Name6>DERIPASKA</Name6><NameType>Primary Name</NameType></Name><Name><Name1>Oleg</Name1><Name6>DERIPASKA</Name6><NameType>Alias</NameType></Name></Names>
<Addresses><Address><AddressLine1>1 Secret Street</AddressLine1></Address></Addresses>
<IndividualDetails><Individual><DOBs><DOB>02/01/1968</DOB></DOBs></Individual></IndividualDetails>
</Designation>
<Designation><UniqueID>RUS0100</UniqueID><RegimeName>The Russia (Sanctions) (EU Exit) Regulations 2019</RegimeName><IndividualEntityShip>Entity</IndividualEntityShip><DateDesignated>24/02/2022</DateDesignated>
<Names><Name><Name6>VTB Bank (Public Joint-Stock Company)</Name6><NameType>Primary Name</NameType></Name></Names>
</Designation>
<Designation><UniqueID>RUS0200</UniqueID><IndividualEntityShip>Ship</IndividualEntityShip><Names><Name><Name6>OCEAN QUEEN</Name6><NameType>Primary Name</NameType></Name></Names></Designation>
</Designations>`;

const CA = `<?xml version="1.0" encoding="utf-8"?>
<data-set>
<record><Country-Pays>Russia / Russie</Country-Pays><Schedule-Annexe>1, Part 1</Schedule-Annexe><Item-NumeroDarticle>12</Item-NumeroDarticle><DateOfListing-DateDinscription>2022-02-24</DateOfListing-DateDinscription><LastName-NomDeFamille>PUTIN</LastName-NomDeFamille><GivenName-Prenom>Vladimir Vladimirovich</GivenName-Prenom><DateOfBirthOrShipBuildDate-DateDeNaissanceOuDateDeConstructionDuNavire>1952</DateOfBirthOrShipBuildDate-DateDeNaissanceOuDateDeConstructionDuNavire></record>
<record><Country-Pays>Russia / Russie</Country-Pays><EntityOrShip-EntiteOuNavire>Rosoboronexport JSC</EntityOrShip-EntiteOuNavire><Aliases-Alias>Rosoboronexport; ROE or Rosobor / Russian: x</Aliases-Alias><DateOfListing-DateDinscription>2022-03-03</DateOfListing-DateDinscription></record>
<record><EntityOrShip-EntiteOuNavire>SHIP ONE</EntityOrShip-EntiteOuNavire><ShipIMONumber-NumeroOMIDuNavire>9999999</ShipIMONumber-NumeroOMIDuNavire></record>
</data-set>`;

const EU_COLS = ['Entity_LogicalId', 'Entity_EU_ReferenceNumber', 'Entity_SubjectType', 'Entity_SubjectType_ClassificationCode', 'Entity_Regulation_Programme', 'Entity_Regulation_PublicationDate', 'Entity_Regulation_PublicationUrl', 'NameAlias_WholeName', 'NameAlias_Function', 'BirthDate_BirthDate', 'Address_Street'];
const euRow = (o) => EU_COLS.map((k) => `"${o[k] ?? ''}"`).join(';');
const EU = '﻿' + [
  EU_COLS.join(';'),
  euRow({ Entity_LogicalId: '13', Entity_EU_ReferenceNumber: 'EU.27.28', Entity_SubjectType: 'P', Entity_SubjectType_ClassificationCode: 'person', Entity_Regulation_Programme: 'UKR', Entity_Regulation_PublicationDate: '2022-04-08', Entity_Regulation_PublicationUrl: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L:2022:110I:FULL', NameAlias_WholeName: 'Oleg Vladimirovich Deripaska', NameAlias_Function: 'businessperson, owner of Russian Machines', BirthDate_BirthDate: '1968-01-02', Address_Street: 'Secret Street 1' }),
  euRow({ Entity_LogicalId: '13', Entity_EU_ReferenceNumber: 'EU.27.28', Entity_SubjectType: 'P', Entity_SubjectType_ClassificationCode: 'person', NameAlias_WholeName: 'Олег Дерипаска' }),
  euRow({ Entity_LogicalId: '14', Entity_EU_ReferenceNumber: 'EU.8.1', Entity_SubjectType: 'E', Entity_SubjectType_ClassificationCode: 'enterprise', Entity_Regulation_Programme: 'UKR', NameAlias_WholeName: 'VTB Bank' }),
].join('\n') + '\n';

const samResult = (o) => ({
  _id: o.id, title: o.title, classification: { code: o.cls || 'Individual' }, excludingAgency: o.agency || 'OPM', excludingAgencyDesc: o.agencyDesc || 'OFFICE OF PERSONNEL MANAGEMENT',
  exclusionType: 'Prohibition/Restriction', exclusionProgram: 'Reciprocal', activationDate: o.date || '2024-03-12', terminationDate: null,
  address: { zip: '94301', city: 'PALO ALTO', state: 'CA', country: 'USA', streetAddress: '1 Home Lane' },
});

const OIG_FORM = '<form><input type="hidden" name="__VIEWSTATE" value="abc" /><input type="hidden" name="__EVENTVALIDATION" value="def" /><input name="ctl00$cpExclusions$txtSPLastName" /></form>';
const OIG_RESULT = `<html><span>Source data updated on 11/10/2026</span><table class="leie_search_results" id="ctl00_cpExclusions_gvEmployees">
<tr><th>Last Name</th><th>First Name</th><th>Middle Name</th><th>General</th><th>Specialty</th><th>Exclusion</th><th></th></tr>
<tr><td>HOLMES</td><td>ELIZABETH</td><td>A</td><td>BUSINESS</td><td>THERANOS</td><td>1128a1</td><td><a>Verify</a></td></tr>
<tr><td>HOLMES</td><td>ELIZABETHA</td><td></td><td>NURSING</td><td>NURSE</td><td>1128b4</td><td><a>Verify</a></td></tr>
</table></html>`;

const LEIE_HEADER = 'LASTNAME,FIRSTNAME,MIDNAME,BUSNAME,GENERAL,SPECIALTY,UPIN,NPI,DOB,ADDRESS,CITY,STATE,ZIP,EXCLTYPE,EXCLDATE,REINDATE,WAIVERDATE,WVRSTATE';
const LEIE = [
  LEIE_HEADER,
  'HOLMES,ELIZABETH,A,,BUSINESS,THERANOS,,1234567890,19840203,1 HOME LANE,PALO ALTO,CA,94301,1128a1,20240312,00000000,00000000,',
  'HOLMES,ELIZABETHA,,,NURSING,NURSE,,0,19700101,2 ROAD,TOWN,OH,44101,1128b4,20200101,00000000,00000000,',
  ',,,"#1 MARKETING SERVICE, INC",OTHER BUSINESS,SOBER HOME,,0,,239 AVENUE,BROOKLYN,NY,11235,1128a1,20200101,00000000,00000000,',
  ...Array.from({ length: 1000 }, (_, i) => `FILLER${i},PERSON,,,NURSING,NURSE,,0,19700101,2 ROAD,TOWN,OH,44101,1128b4,20200101,00000000,00000000,`),
].join('\r\n') + '\r\n';

const ICIJ = {
  q0: { result: [
    { id: '33807', name: 'Adam Neumann', description: 'Officer node extracted from the Paradise Papers - Appleby data.', types: [{ name: 'Officer' }] },
    { id: '56024738', name: 'JUERGEN NEUMANN', description: 'Officer node extracted from the Paradise Papers - Malta corporate registry data.', types: [{ name: 'Officer' }] },
    { id: '999', name: 'Adam Neumann', description: 'Address node', types: [{ name: 'Address' }] },
  ] },
  q1: { result: [] },
};

const EU_MW = `<div class="view-content"><div class="views-row"><div class="views-field views-field-title"><span class="field-content">OSEI NTIAMOAH, Stephen</span></div><div class="views-field views-field-view-node"><span class="field-content">/index.php/osei-ntiamoah-stephen</span></div><div class="views-field views-field-field-status"><div class="field-content">Wanted</div></div><div class="views-field views-field-field-crime"><div class="field-content">Rape</div></div></div>
<div class="views-row"><div class="views-field views-field-title"><span class="field-content">IGNATOVA, Ruja</span></div><div class="views-field views-field-view-node"><span class="field-content">/index.php/ignatova-ruja</span></div><div class="views-field views-field-field-status"><div class="field-content">Wanted</div></div><div class="views-field views-field-field-crime"><div class="field-content">Fraud</div></div></div></div>`;

const FBI = { total: 3, items: [
  { title: 'RUJA IGNATOVA', aliases: ['Dr. Ruja Ignatova', 'Ruja Plamenova Ignatova', 'CryptoQueen'], description: 'Conspiracy to Commit Wire Fraud; Securities Fraud', subjects: ['Ten Most Wanted Fugitives'], person_classification: 'Main', poster_classification: 'ten', status: 'na', url: 'https://www.fbi.gov/wanted/topten/ruja-ignatova', publication: '2022-06-30T09:00:00', dates_of_birth_used: ['May 30, 1980'] },
  { title: 'RUJA PETROVA IGNATOVA', aliases: null, description: 'Missing', subjects: ['Kidnappings and Missing Persons'], person_classification: 'Victim', poster_classification: 'missing', url: 'https://www.fbi.gov/wanted/kidnap/x' },
  { title: 'RUJA IGNATOVSKA', aliases: [], subjects: ['White-Collar Crime'], person_classification: 'Main', poster_classification: 'default', url: 'https://www.fbi.gov/wanted/wcc/y' },
] };

/* ------------------------------------------------------------------ */
/* Fake network                                                        */
/* ------------------------------------------------------------------ */

const headers = (h = {}) => new Map(Object.entries(Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))));
let calls = [];
let routes = {};
function serve(table) {
  routes = table;
  setTransport(async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { status: 404, headers: headers(), url, text: async () => 'not found' };
    const r = await routes[key](url, init);
    if (typeof r === 'string') return { status: 200, headers: headers(), url, text: async () => r };
    return { status: r.status || 200, headers: headers(r.headers), url, text: async () => r.body };
  });
}
const json = (o) => JSON.stringify(o);
const LIST_ROUTES = {
  'data.trade.gov': () => CSL,
  'scsanctions.un.org': () => UN,
  'sanctionslist.fcdo.gov.uk': () => UK,
  'international.gc.ca': () => CA,
  'webgate.ec.europa.eu': () => EU,
};

const ctxFor = (name, company = '') => ({ subject: createSubject({ name, company }), deadline: Date.now() + 20000, known: () => ({}) });
const subjectTask = (name, template) => ({ kind: 'subject', value: name, template, depth: 0 });

beforeEach(() => { __resetCacheForTests(); calls = []; });
afterEach(() => setTransport());

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

describe('name matching', () => {
  test('normalises accents, case, punctuation and "LAST, First"', () => {
    expect(normalizeName('Müller-Lüdenscheidt, José')).toBe('MULLER LUDENSCHEIDT JOSE');
    expect(normalizeName("O'Neil, J.")).toBe('ONEIL J');
    expect(normalizeName('Straße Øresund Łódź')).toBe('STRASSE ORESUND LODZ');
    expect(normalizeName('Олег')).toBe('');
    expect(nameTokens('HOLMES, Elizabeth')).toEqual(['ELIZABETH', 'HOLMES']);
    expect(nameTokens('Sam Bankman-Fried')).toEqual(['BANKMAN', 'FRIED', 'SAM']);
  });

  test('tier 1 is the same word set, tier 2 adds names, anything else is no match', () => {
    expect(matchTier(['A', 'B'], ['B', 'A'])).toBe(1);
    expect(matchTier(['A', 'B'], ['A', 'B', 'C'])).toBe(2);
    expect(matchTier(['A', 'B', 'C'], ['A', 'B'])).toBe(0);
    expect(matchTier([], ['A'])).toBe(0);
    expect(matchPersonName(['Elizabeth Holmes'], 'HOLMES, Elizabeth')).toBe(1);
    expect(matchPersonName(['Elizabeth Holmes'], 'ELIZABETH A HOLMES')).toBe(2);
    expect(matchPersonName(['Oleg Deripaska'], 'Oleg Vladimirovich DERIPASKA')).toBe(2);
  });

  test('never fuzzy: one letter off, a shared surname or a substring does not match', () => {
    expect(matchPersonName(['Elizabeth Holmes'], 'Elizabeth Holme')).toBe(0);
    expect(matchPersonName(['Elizabeth Holmes'], 'ELIZABETHA HOLMES')).toBe(0);
    expect(matchPersonName(['Elizabeth Holmes'], 'Rachel Holmes')).toBe(0);
    expect(matchPersonName(['Adam Neumann'], 'ADAMS NEUMANN-SMITH')).toBe(0);
  });

  test('a person name needs a first and a last name', () => {
    expect(matchPersonName(['Holmes'], 'HOLMES')).toBe(0);
    expect(matchPersonName(['E Holmes'], 'E HOLMES')).toBe(0);
  });

  test('a bracketed part of a listed person name is ignored; of a company name it is kept', () => {
    expect(matchPersonName(['Eric Badege'], 'Eric BADEGE (Colonel)')).toBe(1);
    expect(matchCompanyName('VTB Bank', 'PJSC VTB BANK (KIEV)')).toBe(false);
    expect(matchCompanyName('Mossack Fonseca & Co.', 'MOSSACK FONSECA & CO. (ISRAEL) LIMITED')).toBe(false);
    expect(matchCompanyName('Mossack Fonseca & Co.', 'MOSSACK FONSECA & CO.')).toBe(true);
  });

  test('middle initials are dropped as a variant', () => {
    expect(personVariants('Elizabeth A. Holmes')).toEqual(['Elizabeth A. Holmes', 'Elizabeth Holmes']);
    expect(personVariants('Adam Neumann')).toEqual(['Adam Neumann']);
  });

  test('companies match on the full name without legal form, never on part of it', () => {
    expect(companyTokens('Theranos, Inc.')).toEqual(['THERANOS']);
    expect(companyTokens('OOO Vega')).toEqual(['VEGA']);
    expect(companyTokens('Joint Stock Company Russian Agricultural Bank')).toEqual(['RUSSIAN', 'AGRICULTURAL', 'BANK']);
    expect(matchCompanyName('VTB Bank', 'VTB BANK PUBLIC JOINT STOCK COMPANY')).toBe(true);
    expect(matchCompanyName('Stripe', 'Stripe Logistics Trading FZE')).toBe(false);
    expect(matchCompanyName('Stripe, Inc.', 'STRIPE LLC')).toBe(true);
    expect(matchCompanyName('FT', 'FT LLC')).toBe(false);
  });

  test('screenIndex checks aliases, keeps people and companies apart and puts tier 1 first', () => {
    const index = { rows: [
      { n: 'DERIPASKA, Oleg Vladimirovich', t: 'person' },
      { n: 'Some Name', a: ['Oleg Deripaska'], t: 'person' },
      { n: 'Oleg Deripaska Holdings', t: 'entity' },
      { n: 'VTB Bank PJSC', t: 'entity' },
      { n: 'VTB Bank', t: 'person' },
    ] };
    const hits = screenIndex(index, ['Oleg Deripaska'], 'person');
    expect(hits.map((h) => [h.row.n, h.tier, h.alias])).toEqual([['Some Name', 1, true], ['DERIPASKA, Oleg Vladimirovich', 2, false]]);
    expect(screenIndex(index, ['VTB Bank'], 'company').map((h) => h.row.n)).toEqual(['VTB Bank PJSC']);
  });

  test('reasonText keeps the role and drops sentences with personal details or family', () => {
    expect(reasonText('Former president of Rusal. He was born in Dzerzhinsk. Holds passport 123.')).toBe('Former president of Rusal.');
    expect(reasonText('Minister of Defence. His son is a minor.')).toBe('Minister of Defence.');
  });
});

/* ------------------------------------------------------------------ */
/* List readers                                                        */
/* ------------------------------------------------------------------ */

describe('list readers keep names only', () => {
  const PRIVATE = /1952|1968|1971|Leningrad|Moscow|Secret Street|Passport|passport|03825239|Dzerzhinsk|Congo/;

  test('US Consolidated Screening List', () => {
    const index = parseUsCsl(CSL);
    expect(index.rows).toHaveLength(3); // the vessel is skipped
    expect(index.rows[0]).toMatchObject({ n: 'PUTIN, Vladimir Vladimirovich', a: ['PUTIN, Vladimir'], t: 'person', p: 'RUSSIA-EO14024', i: '35096', d: '2022-02-25', r: 'President of the Russian Federation' });
    expect(index.rows[2].n).toBe('Stripe Logistics Trading FZE');
    expect(index.rows[2].t).toBeUndefined(); // the BIS lists do not say person or entity
    expect(index.urls[index.rows[2].u]).toBe('https://www.bis.gov/entity-list');
    expect(JSON.stringify(index)).not.toMatch(PRIVATE);
    expect(() => parseUsCsl(CSL.slice(0, -40))).toThrow(/incomplete/);
  });

  test('UN list', () => {
    const index = parseUn(UN);
    expect(index.asOf).toBe('2026-11-14');
    expect(index.rows.map((r) => [r.n, r.t])).toEqual([['ERIC BADEGE', 'person'], ['MOHAMMAD HASSAN AKHUND', 'person'], ['AL-QAIDA', 'entity']]);
    expect(index.rows[0].a).toBeUndefined(); // the alias carried birth and passport details: dropped whole
    expect(index.rows[1].r).toMatch(/First Deputy/);
    expect(JSON.stringify(index)).not.toMatch(PRIVATE);
    expect(() => parseUn(UN.replace('</CONSOLIDATED_LIST>', ''))).toThrow(/incomplete/);
  });

  test('UK list', () => {
    const index = parseUk(UK);
    expect(index.asOf).toBe('2026-11-12');
    expect(index.rows).toHaveLength(2);
    expect(index.rows[0]).toMatchObject({ n: 'Oleg Vladimirovich DERIPASKA', a: ['Oleg DERIPASKA'], t: 'person', i: 'RUS0001', d: '2022-03-15', r: 'Former president of Rusal. Deripaska is an involved person.' });
    expect(JSON.stringify(index)).not.toMatch(PRIVATE);
  });

  test('Canada list', () => {
    const index = parseCanada(CA);
    expect(index.rows).toHaveLength(2);
    expect(index.rows[0]).toMatchObject({ n: 'Vladimir Vladimirovich PUTIN', t: 'person', p: 'Russia', d: '2022-02-24', i: 'Schedule 1, Part 1, item 12' });
    expect(index.rows[1]).toMatchObject({ n: 'Rosoboronexport JSC', t: 'entity' });
    expect(index.rows[1].a).toEqual(['Rosoboronexport']);
    expect(JSON.stringify(index)).not.toMatch(PRIVATE);
  });

  test('EU list', () => {
    const index = parseEu(EU);
    expect(index.rows).toHaveLength(2);
    expect(index.rows[0]).toMatchObject({ n: 'Oleg Vladimirovich Deripaska', t: 'person', p: 'UKR', i: 'EU.27.28', r: 'businessperson, owner of Russian Machines' });
    expect(index.rows[0].a).toBeUndefined(); // Cyrillic alias dropped
    expect(index.urls[index.rows[0].u]).toMatch(/^https:\/\/eur-lex/);
    expect(index.rows[1]).toMatchObject({ n: 'VTB Bank', t: 'entity' });
    expect(JSON.stringify(index)).not.toMatch(PRIVATE);
  });
});

/* ------------------------------------------------------------------ */
/* 1. Sanctions lists                                                  */
/* ------------------------------------------------------------------ */

describe('sanctionsListsConnector', () => {
  test('identity and plan: one lookup per list for the subject', () => {
    expect(sanctionsListsConnector.id).toBe('sanctions-lists');
    expect(sanctionsListsConnector.kinds).toEqual(['subject', 'alias', 'company', 'associate', 'relative']);
    expect(sanctionsListsConnector.label).toBe('Sanctions lists (US, UN, EU, UK, Canada)');
    expect(sanctionsListsConnector.plan({ kind: 'subject' }).map((p) => p.template)).toEqual(['list.us-csl', 'list.un', 'list.eu', 'list.uk', 'list.ca']);
    expect(sanctionsListsConnector.plan({ kind: 'company' }).map((p) => p.template)).toEqual(['list.all']);
    expect(LISTS.find((l) => l.key === 'au').off).toBeTruthy();
  });

  test('a name-only hit is "possible", high severity, with the list in the title', async () => {
    serve(LIST_ROUTES);
    const out = await sanctionsListsConnector.run(subjectTask('Vladimir Putin', 'list.us-csl'), ctxFor('Vladimir Putin'));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toMatchObject({ source: 'sanctions-lists', category: 'sanctions', severity: 'high', match: 'possible', date: '2022-02-25', url: 'https://sanctionssearch.ofac.treas.gov/Details.aspx?id=35096' });
    expect(f.title).toBe('Name match on the US Consolidated Screening List: PUTIN, Vladimir Vladimirovich (RUSSIA-EO14024): verify identity');
    expect(f.quote).toMatch(/Listed name: PUTIN, Vladimir Vladimirovich/);
    expect(f.quote).toMatch(/Also listed as: PUTIN, Vladimir/);
    expect(f.quote).not.toMatch(/1952|Leningrad|Moscow|Passport/);
    expect(out.notes[0]).toMatch(/Not screened on this deployment: the Australia consolidated sanctions list/);
    expect(calls).toHaveLength(1);
  });

  test('a hit whose listed role names the subject\'s company is graded by makeFinding as confirmed', async () => {
    serve(LIST_ROUTES);
    const out = await sanctionsListsConnector.run(subjectTask('Oleg Deripaska', 'list.uk'), ctxFor('Oleg Deripaska', 'Rusal'));
    const f = out.findings[0];
    expect(f.match).toBe('confirmed');
    expect(f.title).toMatch(/verify identity$/);
    expect(f.url).toBe('https://search-uk-sanctions-list.service.gov.uk/designations/RUS0001/Individual');
    expect(f.quote).toMatch(/Former president of Rusal/);
    expect(f.quote).not.toMatch(/Dzerzhinsk|Moscow|1968|Secret/);
  });

  test('the EU list links to the regulation that listed the person', async () => {
    serve(LIST_ROUTES);
    const out = await sanctionsListsConnector.run(subjectTask('Oleg Deripaska', 'list.eu'), ctxFor('Oleg Deripaska'));
    expect(out.findings[0].url).toMatch(/^https:\/\/eur-lex\.europa\.eu/);
    expect(out.findings[0].title).toMatch(/^Name match on the EU consolidated sanctions list: Oleg Vladimirovich Deripaska \(UKR\)/);
  });

  test('a clean screen says which list was checked', async () => {
    serve(LIST_ROUTES);
    const out = await sanctionsListsConnector.run(subjectTask('Elizabeth Holmes', 'list.un'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(out.findings).toEqual([]);
    // The note says which copy of the list was read
    expect(out.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^UN Security Council sanctions list: no match for Elizabeth Holmes \(list as of \d{4}-\d{2}-\d{2}\)$/)]));
  });

  test('the list is loaded once and then served from the cache', async () => {
    serve(LIST_ROUTES);
    await sanctionsListsConnector.run(subjectTask('Elizabeth Holmes', 'list.ca'), ctxFor('Elizabeth Holmes'));
    await sanctionsListsConnector.run(subjectTask('Adam Neumann', 'list.ca'), ctxFor('Adam Neumann'));
    expect(calls).toHaveLength(1);
  });

  test('a company task matches the whole company name only, as "company"', async () => {
    serve(LIST_ROUTES);
    const ctx = ctxFor('Some Founder', 'VTB Bank');
    const hit = await sanctionsListsConnector.run({ kind: 'company', value: 'VTB Bank', template: 'list.all' }, ctx);
    expect(hit.findings.map((f) => [f.data.listKey, f.match])).toEqual([['eu', 'company'], ['uk', 'company']]);
    const clean = await sanctionsListsConnector.run({ kind: 'company', value: 'Stripe', template: 'list.all' }, ctxFor('Patrick Collison', 'Stripe'));
    expect(clean.findings).toEqual([]); // "Stripe Logistics Trading FZE" is not Stripe
    expect(clean.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^Sanctions lists \(US, UN, EU, UK, Canada\): no match for Stripe \(lists as of \d{4}-\d{2}-\d{2}\)$/)]));
  });

  test('an associate hit names who it is about and stays "possible"', async () => {
    serve(LIST_ROUTES);
    const out = await sanctionsListsConnector.run({ kind: 'associate', value: 'Eric Badege', relation: 'co-founder', template: 'list.all' }, ctxFor('Adam Neumann', 'WeWork'));
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) {
      expect(f.title).toMatch(/^Co-founder Eric Badege: name match on the /);
      expect(f.match).toBe('possible');
      expect(f.matchReasons).toEqual(['name match on an associate of the subject']);
    }
  });

  test('a one-word name is not screened', async () => {
    serve(LIST_ROUTES);
    const out = await sanctionsListsConnector.run({ kind: 'associate', value: 'Putin', template: 'list.all' }, ctxFor('Adam Neumann'));
    expect(out.findings).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('a list that cannot be read makes the lookup fail', async () => {
    serve({ ...LIST_ROUTES, 'scsanctions.un.org': () => ({ status: 500, body: 'down' }) });
    await expect(sanctionsListsConnector.run(subjectTask('Eric Badege', 'list.un'), ctxFor('Eric Badege'))).rejects.toThrow();
    serve({ ...LIST_ROUTES, 'international.gc.ca': () => CA.slice(0, 200) });
    __resetCacheForTests();
    await expect(sanctionsListsConnector.run(subjectTask('Eric Badege', 'list.ca'), ctxFor('Eric Badege'))).rejects.toThrow(/incomplete/);
  });

  test('the combined lookup reports a list it could not read and keeps the others', async () => {
    serve({ ...LIST_ROUTES, 'scsanctions.un.org': () => ({ status: 500, body: 'down' }) });
    const out = await sanctionsListsConnector.run({ kind: 'relative', value: 'Eric Badege', relation: 'brother', template: 'list.all' }, ctxFor('Adam Neumann'));
    expect(out.notes).toContain('UN Security Council sanctions list: could not be read, so Eric Badege was not screened against it');
  });
});

/* ------------------------------------------------------------------ */
/* 2. US exclusions                                                    */
/* ------------------------------------------------------------------ */

describe('exclusionsConnector', () => {
  test('identity and plan', () => {
    // Associates and relatives are screened too (round 3: watchlists-associates-not-on-exclusions)
    expect(exclusionsConnector).toMatchObject({ id: 'us-exclusions', label: 'US federal exclusion lists (SAM.gov, HHS OIG)', kinds: ['subject', 'alias', 'company', 'associate', 'relative'] });
    expect(exclusionsConnector.plan({ kind: 'subject' }).map((p) => p.template)).toEqual(['excl.sam', 'excl.leie']);
    expect(exclusionsConnector.plan({ kind: 'company' }).map((p) => p.template)).toEqual(['excl.sam']);
  });

  test('SAM.gov: name matches only, duplicates folded, no street address', async () => {
    serve({ 'sam.gov': (url, init) => {
      expect(init.headers.Accept).toBe('application/hal+json');
      return json({ page: { totalElements: 4 }, _embedded: { results: [
        samResult({ id: 'a1', title: 'ELIZABETH A HOLMES' }),
        samResult({ id: 'a2', title: 'ELIZABETH A HOLMES' }),
        samResult({ id: 'b1', title: 'TONEE HOLMES' }),
        samResult({ id: 'c1', title: 'ELIZABETH HOLMES', agency: 'TREAS-OFAC' }),
      ] } });
    } });
    const out = await exclusionsConnector.run(subjectTask('Elizabeth Holmes', 'excl.sam'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toMatchObject({ source: 'us-exclusions', category: 'sanctions', severity: 'high', match: 'possible', url: 'https://sam.gov/exclusion/a1/view', date: '2024-03-12' });
    expect(f.title).toBe('Name match on the SAM.gov exclusion list: ELIZABETH A HOLMES (OFFICE OF PERSONNEL MANAGEMENT, Prohibition/Restriction): verify identity');
    expect(f.quote).toMatch(/State: CA, USA/);
    expect(f.quote).not.toMatch(/Home Lane|94301|PALO ALTO/);
    expect(calls[0].url).toMatch(/q=elizabeth%20holmes&qMode=ALL/);
  });

  test('SAM.gov: a company is matched on its full name', async () => {
    serve({ 'sam.gov': () => json({ page: { totalElements: 2 }, _embedded: { results: [
      samResult({ id: 'x', title: 'THERANOS INC', cls: 'Firm' }),
      samResult({ id: 'y', title: 'THERANOS LABS HOLDINGS', cls: 'Firm' }),
    ] } }) });
    const out = await exclusionsConnector.run({ kind: 'company', value: 'Theranos, Inc.', template: 'excl.sam' }, ctxFor('Elizabeth Holmes', 'Theranos'));
    // "Theranos" is one word once the legal form is removed: held as possible, like the other lists (round 3)
    expect(out.findings.map((f) => [f.url, f.match])).toEqual([['https://sam.gov/exclusion/x/view', 'possible']]);
  });

  test('SAM.gov: nothing found is a note; a broken answer throws', async () => {
    serve({ 'sam.gov': () => json({ page: { totalElements: 0 } }) });
    const out = await exclusionsConnector.run(subjectTask('Patrick Collison', 'excl.sam'), ctxFor('Patrick Collison'));
    expect(out.notes).toEqual(['SAM.gov exclusion list: no match for Patrick Collison']);
    serve({ 'sam.gov': () => ({ status: 503, body: 'down' }) });
    await expect(exclusionsConnector.run(subjectTask('Patrick Collison', 'excl.sam'), ctxFor('Patrick Collison'))).rejects.toThrow();
  });

  test('HHS OIG: the official LEIE file is read once a day; birth dates and addresses are never kept', async () => {
    expect(parseOigResults(OIG_RESULT)).toHaveLength(2); // the old page reader is still exported
    const index = parseLeie(LEIE);
    expect(leieRows(index).rows.find((r) => /HOLMES/.test(r.n))).toEqual({ n: 'HOLMES, ELIZABETH A', t: 'person', g: 'BUSINESS', s: 'THERANOS', x: '1128a1', d: '2024-03-12' });
    expect(JSON.stringify(index)).not.toMatch(/19840203|1 HOME LANE|PALO ALTO|94301|1234567890/);
    expect(() => parseLeie(LEIE.slice(0, -30))).toThrow();
    expect(() => parseLeie('A,B\n1,2\n')).toThrow(/expected format/);
    serve({ 'oig.hhs.gov/exclusions/downloadables/UPDATED.csv': () => LEIE });
    const out = await exclusionsConnector.run(subjectTask('Elizabeth Holmes', 'excl.leie'), ctxFor('Elizabeth Holmes', 'Theranos'));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.title).toBe('Name match on the HHS OIG exclusion list: HOLMES, ELIZABETH A (1128a1): verify identity');
    // The listed specialty names the company the check was started with, but the list adds a middle initial:
    // likely at most (round 3)
    expect(f.match).toBe('likely');
    expect(f.quote).not.toMatch(/ELIZABETHA/);
    await exclusionsConnector.run(subjectTask('Arthur Mensch', 'excl.leie'), ctxFor('Arthur Mensch'));
    expect(calls).toHaveLength(1);
  });

  test('HHS OIG: no match is a clean screen with the list date; an unreadable file throws', async () => {
    serve({ 'oig.hhs.gov': () => LEIE });
    const out = await exclusionsConnector.run(subjectTask('Arthur Mensch', 'excl.leie'), ctxFor('Arthur Mensch'));
    expect(out.findings).toEqual([]);
    expect(out.notes).toEqual([expect.stringMatching(/^HHS OIG exclusion list: no match for Arthur Mensch \(list as of \d{4}-\d{2}-\d{2}\)$/)]);
    __resetCacheForTests();
    serve({ 'oig.hhs.gov': () => '<html>maintenance</html>' });
    await expect(exclusionsConnector.run(subjectTask('Arthur Mensch', 'excl.leie'), ctxFor('Arthur Mensch'))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 3. Offshore Leaks                                                   */
/* ------------------------------------------------------------------ */

describe('offshoreLeaksConnector', () => {
  test('one batched request; exact names only; leak named; note added', async () => {
    serve({ 'offshoreleaks.icij.org': () => ({ status: 201, body: json(ICIJ) }) });
    const out = await offshoreLeaksConnector.run(subjectTask('Adam Neumann'), ctxFor('Adam Neumann', 'WeWork'));
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body);
    expect(Object.values(body.queries).map((q) => q.type)).toEqual(['Officer', 'Intermediary']);
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toMatchObject({ source: 'offshore-leaks', category: 'leaks', severity: 'low', match: 'possible', url: 'https://offshoreleaks.icij.org/nodes/33807' });
    expect(f.title).toBe('Name match in the ICIJ Offshore Leaks database: Adam Neumann (officer, Paradise Papers - Appleby): verify identity');
    expect(f.quote).toMatch(/Paradise Papers - Appleby/);
    expect(out.notes).toEqual([OFFSHORE_NOTE]);
  });

  test('a company is searched as an entity and matched on its whole name', async () => {
    serve({ 'offshoreleaks.icij.org': () => json({ q0: { result: [
      { id: '1', name: 'WEWORK LIMITED', description: 'Entity node extracted from the Pandora Papers data.', types: [{ name: 'Entity' }] },
      { id: '2', name: 'WEWORK HOLDINGS ASIA LIMITED', description: 'Entity node extracted from the Pandora Papers data.', types: [{ name: 'Entity' }] },
    ] } }) });
    const out = await offshoreLeaksConnector.run({ kind: 'company', value: 'WeWork Inc.' }, ctxFor('Adam Neumann', 'WeWork'));
    expect(JSON.parse(calls[0].init.body).queries.q0.type).toBe('Entity');
    expect(out.findings.map((f) => [f.url, f.match])).toEqual([['https://offshoreleaks.icij.org/nodes/1', 'possible']]);
  });

  test('nothing found is a note; an unreadable answer throws', async () => {
    serve({ 'offshoreleaks.icij.org': () => json({ q0: { result: [] }, q1: { result: [] } }) });
    expect((await offshoreLeaksConnector.run(subjectTask('Arthur Mensch'), ctxFor('Arthur Mensch'))).notes).toEqual(['ICIJ Offshore Leaks database: no match for Arthur Mensch']);
    serve({ 'offshoreleaks.icij.org': () => json({ error: 'x' }) });
    await expect(offshoreLeaksConnector.run(subjectTask('Arthur Mensch'), ctxFor('Arthur Mensch'))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 4. Wanted lists                                                     */
/* ------------------------------------------------------------------ */

describe('wantedConnector', () => {
  test('identity', () => {
    expect(wantedConnector).toMatchObject({ id: 'wanted-lists', label: 'Wanted lists (FBI, EU Most Wanted)', kinds: ['subject', 'alias'] });
  });

  test('FBI: exact full name only; missing people and victims are never used', async () => {
    serve({ 'api.fbi.gov': () => json(FBI) });
    const out = await wantedConnector.run(subjectTask('Ruja Ignatova', 'wanted.fbi'), ctxFor('Ruja Ignatova', 'OneCoin'));
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toMatchObject({ source: 'wanted-lists', severity: 'high', url: 'https://www.fbi.gov/wanted/topten/ruja-ignatova', date: '2022-06-30', match: 'possible' });
    expect(f.title).toMatch(/^Name match on the FBI wanted list: RUJA IGNATOVA/);
    expect(JSON.stringify(f)).not.toMatch(/1980|Missing|Kidnap/);
  });

  test('FBI: no exact match is a clean screen', async () => {
    serve({ 'api.fbi.gov': () => json({ total: 1, items: [{ title: 'PATRICK SCOTT, JR.', person_classification: 'Main', url: 'https://www.fbi.gov/x' }] }) });
    const out = await wantedConnector.run(subjectTask('Patrick Collison', 'wanted.fbi'), ctxFor('Patrick Collison'));
    expect(out).toEqual({ findings: [], threads: [], notes: ['FBI wanted list: no match for Patrick Collison'] });
  });

  test('EU Most Wanted: reads the page and matches "LAST, First"', async () => {
    expect(parseEuMostWanted(EU_MW).rows.map((r) => r.n)).toEqual(['OSEI NTIAMOAH, Stephen', 'IGNATOVA, Ruja']);
    serve({ 'eumostwanted.eu': () => EU_MW });
    const out = await wantedConnector.run(subjectTask('Ruja Ignatova', 'wanted.eu'), ctxFor('Ruja Ignatova'));
    expect(out.findings[0]).toMatchObject({ url: 'https://eumostwanted.eu/ignatova-ruja', category: 'sanctions' });
    expect(out.findings[0].quote).toMatch(/Crime: Fraud/);
  });

  test('only the subject is searched', async () => {
    serve({});
    const out = await wantedConnector.run({ kind: 'associate', value: 'Ruja Ignatova', template: 'wanted.fbi' }, ctxFor('Adam Neumann'));
    expect(out.findings).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Review fixes                                                        */
/* ------------------------------------------------------------------ */

describe('review fixes: name order and Offshore Leaks scope', () => {
  test('a listed person whose middle name is the searched first name is not a match', () => {
    expect(S.personOrderMatch(['ELIZABETH', 'HOLMES'], ['RACHAEL', 'ELIZABETH', 'HOLMES'])).toBe(false);
    expect(matchPersonName(['Elizabeth Holmes'], 'RACHAEL ELIZABETH HOLMES')).toBe(0);
    expect(matchPersonName(['Elizabeth Holmes'], 'HOLMES, Rachael Elizabeth')).toBe(0);
    // Middle names added by the list, in either written order, still match at tier 2
    expect(matchPersonName(['Elizabeth Holmes'], 'HOLMES, Elizabeth Anne')).toBe(2);
    expect(matchPersonName(['Elizabeth Holmes'], 'Elizabeth Anne Holmes')).toBe(2);
    // Not tier 2 (Sam is no first name here); since round 3 it is a tier-3 variant (Samuel for Sam), always possible
    expect(matchPersonName(['Sam Bankman-Fried'], 'BANKMAN-FRIED, Samuel Sam')).toBe(3);
    expect(matchPersonName(['Sam Bankman-Fried'], 'BANKMAN-FRIED, Sam Benjamin')).toBe(2);
    // Tier 1 (the same words) is unchanged
    expect(matchPersonName(['Elizabeth Holmes'], 'HOLMES Elizabeth')).toBe(1);
  });

  test('screenIndex applies the same order check to the list files', () => {
    const index = { rows: [
      { n: 'RACHAEL ELIZABETH HOLMES', t: 'person' },
      { n: 'HOLMES, Elizabeth Anne', t: 'person' },
      { n: 'Elizabeth Anne Holmes', t: 'person' },
    ] };
    expect(screenIndex(index, ['Elizabeth Holmes'], 'person').map((h) => [h.row.n, h.tier])).toEqual([
      ['HOLMES, Elizabeth Anne', 2], ['Elizabeth Anne Holmes', 2],
    ]);
  });

  test('SAM.gov: a listed person with the subject first name as a middle name is not reported', async () => {
    serve({ 'sam.gov': () => json({ page: { totalElements: 1 }, _embedded: { results: [samResult({ id: 'x1', title: 'RACHAEL ELIZABETH HOLMES' })] } }) });
    const out = await exclusionsConnector.run(subjectTask('Elizabeth Holmes', 'excl.sam'), ctxFor('Elizabeth Holmes'));
    expect(out.findings).toEqual([]);
    expect(out.notes).toContain('SAM.gov exclusion list: no match for Elizabeth Holmes');
  });

  test('Offshore Leaks is never searched for an associate or relative', async () => {
    // another name of the person ('alias') is the person, not a related party
    expect(offshoreLeaksConnector.kinds).toEqual(['subject', 'alias', 'company']);
    serve({ 'offshoreleaks.icij.org': () => ({ status: 201, body: json(ICIJ) }) });
    for (const kind of ['associate', 'relative']) {
      const out = await offshoreLeaksConnector.run({ kind, value: 'Adam Neumann', relation: 'brother' }, ctxFor('Elizabeth Holmes'));
      expect(out.findings).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });
});
