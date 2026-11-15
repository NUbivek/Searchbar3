/**
 * Academic record (ORCID, Crossref, theses.fr) and scholarly publications
 * (OpenAlex): mapping to findings, identity grading, school threads, the
 * privacy rules and the failure paths. No network: fixtures are cut from
 * real responses.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const {
  academicRecordConnector, publicationsConnector, personNameFits, sameSchool, __resetScholarForTests,
} = require('../../../src/server/founder/sources/scholar');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const subjectTask = (subject, template) => ({ kind: 'subject', value: subject.name, template, params: null, depth: 0, relation: null });
const schoolTask = (school) => ({ kind: 'school', value: school, template: 'school', params: null, depth: 1, relation: null });

/** Fake network: the first route whose pattern is in the URL answers. A reply { status, body } sets the status. */
function network(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    for (const [pattern, reply] of routes) {
      if (!url.includes(pattern)) continue;
      const r = typeof reply === 'function' ? reply(url) : reply;
      const custom = r && typeof r.status === 'number';
      const status = custom ? r.status : 200;
      const body = custom ? r.body : r;
      return { status, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    }
    return { status: 404, headers: new Map(), url, text: async () => '{}' };
  });
  return calls;
}

/* ------------------------------------------------------------- fixtures */

const ORCID_ID = '0000-0001-7866-0461';
const orcidSearch = {
  'expanded-result': [{
    'orcid-id': ORCID_ID, 'given-names': 'Arthur', 'family-names': 'Mensch', 'credit-name': null, 'other-name': [],
    email: ['arthur.private@example.org'],
    'institution-name': ['CNRS/ENS Paris', 'Inria Saclay - Île-de-France Research Centre', 'Université Paris-Sud', 'École Polytechnique'],
  }],
  'num-found': 1,
};
const selfSource = { 'source-orcid': { path: ORCID_ID }, 'source-client-id': null, 'source-name': { value: 'Arthur Mensch' }, 'assertion-origin-orcid': null };
const affiliation = (key, { role, department, organisation, start, end, source = selfSource }) => ({
  summaries: [{
    [key]: {
      source, 'role-title': role, 'department-name': department,
      'start-date': start ? { year: { value: start }, month: { value: '01' }, day: { value: '09' } } : null,
      'end-date': end ? { year: { value: end }, month: { value: '09' }, day: { value: '28' } } : null,
      organization: { name: organisation, address: { city: 'Orsay', region: 'Île-de-France', country: 'FR' } },
    },
  }],
});
const orcidEducations = {
  'affiliation-group': [
    affiliation('education-summary', { role: 'Engineer degree, master degree', department: 'Applied mathematics', organisation: 'École Polytechnique', start: '2011', end: '2015' }),
    affiliation('education-summary', { role: 'PhD degree', department: 'Computer science', organisation: 'Université Paris-Sud', start: '2015', end: '2018' }),
  ],
};
const orcidEmployments = {
  'affiliation-group': [
    affiliation('employment-summary', { role: 'Post-doc research', department: 'Mathématiques Appliquées', organisation: 'CNRS/ENS Paris', start: '2018', end: null }),
    affiliation('employment-summary', { role: 'PhD candidate', department: 'Parietal Team', organisation: 'Inria Saclay - Île-de-France Research Centre', start: '2015', end: '2018' }),
  ],
};
const orcidRoutes = [
  ['pub.orcid.org/v3.0/expanded-search', orcidSearch],
  [`${ORCID_ID}/educations`, orcidEducations],
  [`${ORCID_ID}/employments`, orcidEmployments],
];

const DOI = '10.70675/4aed8559zd2baz40bdz81e2z796791336be9';
const crossrefMensch = {
  status: 'ok',
  message: {
    'total-results': 1583,
    items: [
      {
        publisher: "Agence Bibliographique de l'Enseignement Supérieur", DOI, type: 'dissertation',
        approved: { 'date-parts': [[2018, 9, 28]] }, title: ['Learning representations from functional MRI data'],
        author: [{ given: 'Arthur', family: 'Mensch', sequence: 'first', affiliation: [{ name: 'Université Paris-Saclay (ComUE)' }] }],
        degree: ['Doctorat ès Mathématiques et Informatique', 'PhD'], issued: { 'date-parts': [[null]] },
      },
      {
        publisher: "Agence Bibliographique de l'Enseignement Supérieur", DOI: '10.70675/476a3b23ze46ez4002z9ae4z91bd09be5c76', type: 'dissertation',
        approved: { 'date-parts': [[2020, 3, 13]] }, title: ['Unraveling the physiopathological actions of the newly discovered peptides in the brain'],
        author: [{ given: 'Maria', family: 'Mensch', sequence: 'first', affiliation: [{ name: "Université Côte d'Azur" }] }],
        degree: ['Doctorat ès Sciences de la vie et de la santé', 'PhD'], issued: { 'date-parts': [[null]] },
      },
    ],
  },
};
const thesesFrMensch = {
  totalHits: 1,
  theses: [{
    id: '2018SACLS300', titrePrincipal: 'Apprentissage de représentations en imagerie fonctionnelle', titreEN: 'Learning representations from functional MRI data',
    etabSoutenanceN: 'Université Paris-Saclay (ComUE)', dateSoutenance: '28/09/2018', datePremiereInscriptionDoctorat: null,
    auteurs: [{ nom: 'Mensch', prenom: 'Arthur' }], directeurs: [{ nom: 'Thirion', prenom: 'Bertrand' }],
    rapporteurs: [{ nom: 'Fadili', prenom: 'Jalal' }, { nom: 'Yu', prenom: 'Bin' }], president: { nom: 'Fadili', prenom: 'Jalal' },
    nnt: '2018SACLS300', doi: DOI, discipline: 'Mathématiques et Informatique', status: 'soutenue',
    partenairesDeRecherche: [{ nom: 'Equipe de recherche Parietal', type: 'Equipe de recherche' }, { nom: 'Université Paris-Sud (1970-2019)', type: "établissement opérateur d'inscription" }],
  }],
};
const crossrefJohnson = {
  status: 'ok',
  message: {
    'total-results': 670,
    items: [
      { DOI: '10.18130/v3950t', title: ['Neural Synchronization in Seizures'], author: [{ given: 'Sarah', family: 'Johnson', sequence: 'first', affiliation: [{ name: 'University of Virginia' }] }], publisher: 'University of Virginia', degree: ['PHD'], approved: { 'date-parts': [[2012, 4, 5]] } },
      { DOI: '10.18130/v31f84', title: ['Plantation Networks in the late Antebellum Deep South'], author: [{ given: 'Emilie', family: 'Johnson', sequence: 'first', affiliation: [{ name: 'University of Virginia' }] }], publisher: 'University of Virginia', degree: ['PHD'], approved: { 'date-parts': [[2013, 11, 26]] } },
      { DOI: '10.33915/etd.1', title: ['A study of rivers'], author: [{ given: 'Sarah', family: 'Johnson', sequence: 'first', affiliation: [] }], publisher: 'West Virginia University Libraries', degree: ['MFA'], approved: { 'date-parts': [[2003]] } },
    ],
  },
};

const openAlexMensch = {
  meta: { count: 3 },
  results: [
    {
      id: 'https://openalex.org/A5110691380', orcid: `https://orcid.org/${ORCID_ID}`, display_name: 'Arthur Mensch', display_name_alternatives: ['Arthur Mensch', 'Mensch, Arthur'],
      works_count: 19, cited_by_count: 35812, summary_stats: { h_index: 15 },
      affiliations: [
        { institution: { display_name: 'Google (United States)', country_code: 'US', type: 'company' }, years: [2022] },
        { institution: { display_name: 'University of Oxford', country_code: 'GB', type: 'education' }, years: [2023] },
        { institution: { display_name: 'Mistral AI (France)', country_code: 'FR', type: 'company' }, years: [2024] },
      ],
    },
    {
      id: 'https://openalex.org/A5061701877', orcid: `https://orcid.org/${ORCID_ID}`, display_name: 'Arthur Mensch', display_name_alternatives: ['Arthur Mensch'],
      works_count: 38, cited_by_count: 1288, summary_stats: { h_index: 20 },
      affiliations: [
        { institution: { display_name: 'Google (United States)', country_code: 'US', type: 'company' }, years: [2020] },
        { institution: { display_name: "Commissariat à l'Énergie Atomique et aux Énergies Alternatives", country_code: 'FR', type: 'government' }, years: [2021, 2020, 2018, 2017, 2016] },
      ],
    },
    {
      id: 'https://openalex.org/A5040583304', orcid: null, display_name: 'Arthur H. Mensch', display_name_alternatives: ['Arthur H. Mensch', 'Mensch, Arthur H.'],
      works_count: 4, cited_by_count: 320, summary_stats: { h_index: 3 },
      affiliations: [{ institution: { display_name: 'Yale University', country_code: 'US', type: 'education' }, years: [1968, 1967] }],
    },
    {
      id: 'https://openalex.org/A999', orcid: null, display_name: 'Arthur Menschel', display_name_alternatives: [], works_count: 2, cited_by_count: 1, summary_stats: { h_index: 1 },
      affiliations: [{ institution: { display_name: 'Mistral AI (France)', country_code: 'FR', type: 'company' }, years: [2024] }],
    },
  ],
};

beforeEach(() => __resetScholarForTests({ crossrefGapMs: 0 }));
afterEach(() => setTransport());

/* -------------------------------------------------------------- helpers */

describe('name and school comparison', () => {
  test('a name fits when first and last names are equal and middle names are missing or abbreviated', () => {
    const holmes = createSubject({ name: 'Elizabeth Holmes' });
    expect(personNameFits(holmes, 'Elizabeth A. Holmes')).toBe(true);
    expect(personNameFits(holmes, 'Holmes, Elizabeth')).toBe(true);
    expect(personNameFits(holmes, 'Sarah Holmes')).toBe(false);
    expect(personNameFits(holmes, 'Elizabeth Holmes-Smith')).toBe(false);
    expect(personNameFits(createSubject({ name: 'Sam Bankman-Fried' }), 'Sam Fried')).toBe(false);
    expect(personNameFits(createSubject({ name: 'Yann LeCun' }), 'Yann Le Cun')).toBe(true);
    expect(personNameFits(createSubject({ name: 'Timothée Lacroix' }), 'Timothee LACROIX')).toBe(true);
  });

  test('two institution names are the same school only when one is the other, or a sub-unit of it', () => {
    expect(sameSchool('Stanford', 'Stanford University')).toBe(true);
    expect(sameSchool('Stanford University', 'Stanford University School of Medicine')).toBe(true);
    expect(sameSchool('Université Paris-Saclay', 'Université Paris-Saclay (ComUE)')).toBe(true);
    expect(sameSchool('West Virginia University', 'West Virginia University Libraries')).toBe(true);
    expect(sameSchool('Boise State University', 'Boise State University, Albertsons Library')).toBe(true);
    expect(sameSchool('York University', 'New York University')).toBe(false);
    expect(sameSchool('University of Washington', 'Washington University')).toBe(false);
    expect(sameSchool('University of California, Berkeley', 'University of California, Los Angeles')).toBe(false);
    expect(sameSchool('University', 'University College London')).toBe(false);
  });
});

/* ------------------------------------------------------- academic record */

describe('academic record: ORCID', () => {
  test('declares itself and plans one lookup per registry family', () => {
    expect(academicRecordConnector.id).toBe('academic-record');
    expect(academicRecordConnector.label).toBe('Academic record (ORCID, Crossref, theses.fr)');
    expect(academicRecordConnector.kinds).toEqual(['subject', 'school']);
    expect(academicRecordConnector.plan({ kind: 'subject', value: 'Arthur Mensch' }).map((p) => p.template)).toEqual(['orcid', 'theses']);
    expect(academicRecordConnector.plan({ kind: 'school', value: 'Stanford University' }).map((p) => p.template)).toEqual(['school']);
  });

  test('maps the degrees and jobs a person lists, and says they are self-reported', async () => {
    const calls = network(orcidRoutes);
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    const { findings, threads, notes } = await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject));

    expect(calls).toHaveLength(3);
    expect(decodeURIComponent(calls[0])).toContain('given-names:"Arthur" AND family-name:"Mensch"');
    expect(findings).toHaveLength(2);
    const education = findings.find((f) => f.category === 'education');
    expect(education.source).toBe('academic-record');
    expect(education.title).toBe('ORCID (self-reported): PhD degree, Université Paris-Sud, 2015-2018; Engineer degree, master degree, École Polytechnique, 2011-2015');
    expect(education.quote).toContain('Arthur Mensch: PhD degree, Computer science, Université Paris-Sud, 2015-2018');
    expect(education.url).toBe(`https://orcid.org/${ORCID_ID}`);
    expect(education.date).toBe('2018');
    expect(education.severity).toBe('info');
    expect(education.data).toMatchObject({ registry: 'ORCID', orcid: ORCID_ID, selfReported: true });
    expect(education.data.entries[0]).toEqual({ role: 'PhD degree', department: 'Computer science', organisation: 'Université Paris-Sud', start: '2015', end: '2018', selfReported: true });

    const career = findings.find((f) => f.category === 'career');
    expect(career.title).toBe('ORCID (self-reported): Post-doc research, CNRS/ENS Paris, from 2018; PhD candidate, Inria Saclay - Île-de-France Research Centre, 2015-2018');

    // The record names neither Mistral AI nor a known school: a namesake is possible, so nothing is followed.
    expect(findings.map((f) => f.match)).toEqual(['possible', 'possible']);
    expect(threads.map((t) => [t.kind, t.value, t.trusted])).toEqual([
      ['school', 'Université Paris-Sud', false], ['school', 'École Polytechnique', false],
    ]);
    expect(notes).toEqual([]);
  });

  test('a known school of the subject makes the record likely and its schools are followed', async () => {
    network(orcidRoutes);
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    addAnchor(subject, 'schools', 'École Polytechnique');
    const { findings, threads } = await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject));
    expect(findings.map((f) => f.match)).toEqual(['likely', 'likely']);
    expect(findings[0].matchReasons).toContain('names École Polytechnique');
    expect(threads.every((t) => t.kind === 'school' && t.trusted)).toBe(true);
  });

  test('an employer that is a known company confirms the record', async () => {
    network(orcidRoutes);
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Inria' });
    const { findings, threads } = await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject));
    expect(findings.map((f) => f.match)).toEqual(['confirmed', 'confirmed']);
    expect(threads.map((t) => t.trusted)).toEqual([true, true]);
  });

  test('an entry written by the institution is told apart from a self-reported one', async () => {
    const byUniversity = { 'source-orcid': null, 'source-client-id': { path: 'APP-123' }, 'source-name': { value: 'Université Paris-Sud' }, 'assertion-origin-orcid': null };
    network([
      ['expanded-search', orcidSearch],
      ['/educations', { 'affiliation-group': [affiliation('education-summary', { role: 'PhD', department: '', organisation: 'Université Paris-Sud', start: '2015', end: '2018', source: byUniversity })] }],
      ['/employments', { 'affiliation-group': [] }],
    ]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const { findings } = await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('ORCID (entered by the institution): PhD, Université Paris-Sud, 2015-2018');
    expect(findings[0].quote).toContain('[entered by Université Paris-Sud]');
    expect(findings[0].data.selfReported).toBe(false);
  });

  test('several namesakes and nothing to tell them apart: profiles are listed as possible and no record is read', async () => {
    const row = (id, institutions, given = 'Elizabeth') => ({ 'orcid-id': id, 'given-names': given, 'family-names': 'Holmes', 'credit-name': null, 'other-name': [], email: [], 'institution-name': institutions });
    const calls = network([['expanded-search', {
      'expanded-result': [
        row('0000-0002-1398-5617', []),
        row('0000-0002-2565-214X', ['Uniting Care Queensland', 'University of Queensland']),
        row('0000-0001-9128-8393', ['NOAA NMFS Northwest Fisheries Science Center', 'University of Washington']),
        row('0000-0003-0000-0001', ['University of Leeds'], 'Beth'),
      ],
      'num-found': 14,
    }]]);
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    const { findings, threads, notes } = await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject));
    expect(calls).toHaveLength(1);
    expect(findings).toHaveLength(2); // the profile with no institution and the one under another first name say nothing
    expect(findings.every((f) => f.match === 'possible' && f.category === 'identity')).toBe(true);
    expect(findings[0].title).toBe('ORCID (self-reported): a researcher profile under this name lists Uniting Care Queensland, University of Queensland');
    expect(findings[0].url).toBe('https://orcid.org/0000-0002-2565-214X');
    expect(threads).toEqual([]);
    expect(notes[0]).toMatch(/ORCID lists 14 researchers named Elizabeth Holmes/);
  });

  test('of several namesakes, only the one tied to a known school is read', async () => {
    const calls = network([
      ['expanded-search', {
        'expanded-result': [
          { 'orcid-id': '0000-0002-2565-214X', 'given-names': 'Arthur', 'family-names': 'Mensch', 'institution-name': ['University of Queensland'] },
          { 'orcid-id': ORCID_ID, 'given-names': 'Arthur', 'family-names': 'Mensch', 'institution-name': ['École Polytechnique', 'Inria Saclay - Île-de-France Research Centre'] },
        ],
        'num-found': 2,
      }],
      [`${ORCID_ID}/educations`, orcidEducations],
      [`${ORCID_ID}/employments`, orcidEmployments],
    ]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    addAnchor(subject, 'schools', 'École Polytechnique');
    const { findings, threads } = await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject));
    expect(calls.filter((u) => u.includes('0000-0002-2565-214X'))).toEqual([]);
    // Two people share the name and one school is all that ties this record to the subject:
    // a namesake who went to the same school cannot be ruled out, so it is held at possible.
    expect(findings.map((f) => [f.category, f.match, f.matchFixed])).toEqual([['education', 'possible', true], ['career', 'possible', true]]);
    expect(findings[0].matchReasons).toEqual(['names École Polytechnique, but 2 people on ORCID have this name and may share that school']);
    expect(threads.every((t) => t.trusted === false)).toBe(true);

    // A second thing known about the subject on the same record settles it.
    addAnchor(subject, 'schools', 'Université Paris-Sud');
    const two = await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject));
    expect(two.findings.map((f) => [f.match, f.matchFixed])).toEqual([['likely', undefined], ['likely', undefined]]);
    expect(two.threads.every((t) => t.trusted)).toBe(true);

    // So does a known company among the employers.
    const founder = createSubject({ name: 'Arthur Mensch', company: 'Inria' });
    const confirmed = await academicRecordConnector.run(subjectTask(founder, 'orcid'), ctxFor(founder));
    expect(confirmed.findings.map((f) => f.match)).toEqual(['confirmed', 'confirmed']);
  });

  test('a record under another name is dropped, and nothing is found without a first and last name', async () => {
    network([['expanded-search', { 'expanded-result': [{ 'orcid-id': ORCID_ID, 'given-names': 'Arturo', 'family-names': 'Mensch', 'institution-name': ['École Polytechnique'] }], 'num-found': 1 }]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    expect(await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
    const mononym = createSubject({ name: 'Madonna' });
    expect((await academicRecordConnector.run(subjectTask(mononym, 'orcid'), ctxFor(mononym))).findings).toEqual([]);
  });

  test('privacy: e-mail addresses, cities and exact dates in the registry never reach a finding', async () => {
    network(orcidRoutes);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const result = await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject));
    const dump = JSON.stringify(result);
    expect(dump).not.toMatch(/example\.org|@/);
    expect(dump).not.toMatch(/Orsay/);
    expect(dump).not.toMatch(/2018-09-28|2015-01-09/);
  });

  test('a health-related department is left out instead of losing the record', async () => {
    network([
      ['expanded-search', orcidSearch],
      ['/educations', { 'affiliation-group': [affiliation('education-summary', { role: 'PhD', department: 'Cancer biology', organisation: 'Université Paris-Sud', start: '2015', end: '2018' })] }],
      ['/employments', { 'affiliation-group': [] }],
    ]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const { findings } = await academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject));
    expect(findings).toHaveLength(1);
    expect(findings[0].quote).toBe('Arthur Mensch: PhD, Université Paris-Sud, 2015-2018');
  });

  test('the registry failing is an error, not an empty answer', async () => {
    network([['expanded-search', { status: 500, body: 'Internal Server Error' }]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    await expect(academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject))).rejects.toThrow(/HTTP 500/);

    network([['expanded-search', orcidSearch], ['/educations', { status: 500, body: 'x' }], ['/employments', { status: 500, body: 'x' }]]);
    await expect(academicRecordConnector.run(subjectTask(subject, 'orcid'), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
  });
});

describe('academic record: thesis registries', () => {
  test('a French doctorate is reported once, from the national registry, with its defence date', async () => {
    const calls = network([['api.crossref.org/works', crossrefMensch], ['theses.fr/api/v1/theses/recherche', thesesFrMensch]]);
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    const { findings, threads, notes } = await academicRecordConnector.run(subjectTask(subject, 'theses'), ctxFor(subject));

    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls.find((u) => u.includes('theses.fr')))).toContain('q=auteursNP:(Arthur AND Mensch)');
    expect(calls.find((u) => u.includes('crossref'))).toContain('filter=type%3Adissertation');
    expect(findings).toHaveLength(1); // the Crossref copy of the same thesis and Maria Mensch's thesis are not listed
    const [thesis] = findings;
    expect(thesis.title).toBe('Doctoral thesis: Learning representations from functional MRI data (Université Paris-Saclay (ComUE), 2018)');
    expect(thesis.category).toBe('education');
    expect(thesis.url).toBe('https://theses.fr/2018SACLS300');
    expect(thesis.date).toBe('2018-09-28');
    expect(thesis.severity).toBe('info');
    expect(thesis.quote).toContain('Arthur Mensch. Apprentissage de représentations en imagerie fonctionnelle');
    expect(thesis.quote).toContain('Soutenue le 28/09/2018. Sous la direction de Bertrand Thirion');
    expect(thesis.quote).not.toMatch(/Fadili|Bin Yu/); // the jury is not part of the finding
    expect(thesis.data).toMatchObject({ registry: 'theses.fr', defended: true, institution: 'Université Paris-Saclay (ComUE)', doi: DOI });
    expect(thesis.match).toBe('possible');
    expect(threads.map((t) => [t.kind, t.value, t.trusted])).toEqual([['school', 'Université Paris-Saclay', false]]);
    expect(notes).toEqual([]);
  });

  test('a thesis at a known school of the subject is likely theirs, and the school is followed', async () => {
    network([['api.crossref.org/works', crossrefMensch], ['theses.fr/api', thesesFrMensch]]);
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    addAnchor(subject, 'schools', 'Université Paris-Saclay');
    const { findings, threads } = await academicRecordConnector.run(subjectTask(subject, 'theses'), ctxFor(subject));
    expect(findings[0].match).toBe('likely');
    expect(threads[0]).toMatchObject({ kind: 'school', value: 'Université Paris-Saclay', trusted: true });
  });

  test('a thesis held only by Crossref: degree, university and year, linked by its DOI', async () => {
    network([['api.crossref.org/works', crossrefJohnson], ['theses.fr/api', { totalHits: 0, theses: [] }]]);
    const subject = createSubject({ name: 'Sarah Johnson', company: 'Acme Robotics' });
    const { findings } = await academicRecordConnector.run(subjectTask(subject, 'theses'), ctxFor(subject));
    expect(findings.map((f) => f.title)).toEqual([
      'Doctoral thesis: Neural Synchronization in Seizures (University of Virginia, 2012)',
      "Master's thesis: A study of rivers (West Virginia University, 2003)",
    ]);
    expect(findings[0].url).toBe('https://doi.org/10.18130/v3950t');
    expect(findings[0].date).toBe('2012-04-05');
    expect(findings[1].date).toBe('2003');
    expect(findings.every((f) => f.match === 'possible')).toBe(true);
  });

  test('a committee member listed as a further author did not write the thesis', async () => {
    network([
      ['api.crossref.org/works', { message: { items: [{
        DOI: '10.31390/gradschool_theses.5152', title: ['Effects of exchange production schedules'], publisher: 'Louisiana State University Libraries', degree: ['Master of Arts (MA)'],
        approved: { 'date-parts': [[2020, 4, 28]] },
        author: [{ given: 'Elizabeth', family: 'Holmes', sequence: 'additional' }, { given: 'Sarah', family: 'Holmes', sequence: 'first' }],
      }] } }],
      ['theses.fr/api', { totalHits: 0, theses: [] }],
    ]);
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    expect((await academicRecordConnector.run(subjectTask(subject, 'theses'), ctxFor(subject))).findings).toEqual([]);
  });

  test('a thesis in preparation is not reported as a doctorate', async () => {
    network([
      ['api.crossref.org/works', { message: { items: [] } }],
      ['theses.fr/api', { theses: [{ id: 's123456', titrePrincipal: 'Modèles génératifs', titreEN: null, etabSoutenanceN: 'Sorbonne université', dateSoutenance: null, datePremiereInscriptionDoctorat: '01/10/2023', auteurs: [{ nom: 'Mensch', prenom: 'Arthur' }], directeurs: [], discipline: 'Informatique', status: 'enCours' }] }],
    ]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const { findings } = await academicRecordConnector.run(subjectTask(subject, 'theses'), ctxFor(subject));
    expect(findings[0].title).toBe('Doctoral thesis in preparation: Modèles génératifs (Sorbonne université, registered 2023)');
    expect(findings[0].data.defended).toBe(false);
  });

  test('a thesis on a medical subject keeps its record but not its topic', async () => {
    network([
      ['api.crossref.org/works', { message: { items: [{ DOI: '10.1/x', title: ['Chemotherapy response in breast cancer'], publisher: 'University of Virginia', degree: ['PhD'], approved: { 'date-parts': [[2012]] }, author: [{ given: 'Sarah', family: 'Johnson', sequence: 'first' }] }] } }],
      ['theses.fr/api', { theses: [] }],
    ]);
    const subject = createSubject({ name: 'Sarah Johnson' });
    const { findings } = await academicRecordConnector.run(subjectTask(subject, 'theses'), ctxFor(subject));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Doctoral thesis (University of Virginia, 2012)');
    expect(JSON.stringify(findings[0])).not.toMatch(/cancer|chemotherapy/i);
  });

  test('one registry down is noted; both down is a failure', async () => {
    const subject = createSubject({ name: 'Arthur Mensch' });
    network([['api.crossref.org/works', { status: 500, body: 'x' }], ['theses.fr/api', thesesFrMensch]]);
    const partial = await academicRecordConnector.run(subjectTask(subject, 'theses'), ctxFor(subject));
    expect(partial.findings).toHaveLength(1);
    expect(partial.notes[0]).toMatch(/Crossref thesis registry did not answer/);

    network([['api.crossref.org/works', { status: 500, body: 'x' }], ['theses.fr/api', { status: 500, body: 'x' }]]);
    await expect(academicRecordConnector.run(subjectTask(subject, 'theses'), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
  });

  test('without a query pattern both halves run, and one half failing is noted', async () => {
    network([...orcidRoutes, ['api.crossref.org/works', crossrefMensch], ['theses.fr/api', thesesFrMensch]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const all = await academicRecordConnector.run(subjectTask(subject, null), ctxFor(subject));
    expect(all.findings.map((f) => f.category).sort()).toEqual(['career', 'education', 'education']);

    network([['expanded-search', { status: 500, body: 'x' }], ['api.crossref.org/works', crossrefMensch], ['theses.fr/api', thesesFrMensch]]);
    const half = await academicRecordConnector.run(subjectTask(subject, null), ctxFor(subject));
    expect(half.findings).toHaveLength(1);
    expect(half.notes).toContain('ORCID did not answer; only the thesis registries were searched.');
  });

  test('lookups take turns at Crossref', async () => {
    __resetScholarForTests({ crossrefGapMs: 150 });
    const starts = [];
    let inFlight = 0;
    let most = 0;
    setTransport(async (url) => {
      if (url.includes('crossref')) {
        starts.push(Date.now());
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
      }
      return { status: 200, headers: new Map(), url, text: async () => JSON.stringify(url.includes('crossref') ? { message: { items: [] } } : { theses: [], 'expanded-result': null }) };
    });
    const subject = createSubject({ name: 'Sarah Johnson' });
    await Promise.all(['University of Virginia', 'West Virginia University', 'Stanford University'].map((s) => academicRecordConnector.run(schoolTask(s), ctxFor(subject))));
    expect(starts).toHaveLength(3);
    expect(most).toBe(1);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(150);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(150);
  });
});

describe('academic record: one school', () => {
  test('a thesis granted by that school ties the subject to it', async () => {
    const calls = network([['expanded-search', { 'expanded-result': null, 'num-found': 0 }], ['api.crossref.org/works', crossrefJohnson]]);
    const subject = createSubject({ name: 'Sarah Johnson', company: 'Acme Robotics' });
    addAnchor(subject, 'schools', 'University of Virginia');
    const { findings, threads, notes } = await academicRecordConnector.run(schoolTask('University of Virginia'), ctxFor(subject));

    expect(decodeURIComponent(calls.find((u) => u.includes('orcid')))).toContain('q=given-names:"Sarah" AND family-name:"Johnson"&rows=50');
    const crossref = new URL(calls.find((u) => u.includes('crossref')));
    expect(crossref.searchParams.get('query.author')).toBe('Sarah Johnson');
    expect(crossref.searchParams.get('query.affiliation')).toBe('University of Virginia');
    // the thesis at West Virginia University is another school's
    expect(findings.map((f) => f.title)).toEqual(['Doctoral thesis: Neural Synchronization in Seizures (University of Virginia, 2012)']);
    expect(findings[0].match).toBe('likely');
    expect(findings[0].matchReasons).toEqual(['names University of Virginia']);
    expect(threads).toEqual([]);
    expect(notes).toEqual([]);
  });

  test('an ORCID record that lists the school is read; one that does not is ignored', async () => {
    const calls = network([...orcidRoutes, ['api.crossref.org/works', { message: { items: [] } }]]);
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    addAnchor(subject, 'schools', 'École Polytechnique');
    const listed = await academicRecordConnector.run(schoolTask('École Polytechnique'), ctxFor(subject));
    expect(calls).toHaveLength(4);
    expect(listed.findings.map((f) => [f.category, f.match])).toEqual([['education', 'likely'], ['career', 'likely']]);

    const other = await academicRecordConnector.run(schoolTask('Harvard University'), ctxFor(subject));
    expect(other.findings).toEqual([]);
    expect(other.notes[0]).toBe('No thesis or ORCID entry ties Arthur Mensch to Harvard University in the open academic registries. Most universities do not deposit theses there, so this neither confirms nor contradicts the claim.');
  });

  test('a namesake who went to the same school is not pinned on the subject', async () => {
    // Sixteen researchers are called Elizabeth Holmes; one of them (a fisheries scientist) studied at Stanford in the 1980s.
    const row = (id, institutions) => ({ 'orcid-id': id, 'given-names': 'Elizabeth', 'family-names': 'Holmes', 'credit-name': null, 'other-name': [], email: [], 'institution-name': institutions });
    const calls = network([
      ['expanded-search', { 'expanded-result': [
        row('0000-0002-2565-214X', ['Uniting Care Queensland', 'University of Queensland']),
        row('0000-0001-9128-8393', ['NOAA NMFS Northwest Fisheries Science Center', 'Stanford University', 'University of Washington']),
        row('0009-0007-9874-3070', ['University of Sheffield']),
      ], 'num-found': 16 }],
      ['0000-0001-9128-8393/educations', { 'affiliation-group': [
        affiliation('education-summary', { role: 'PhD', department: 'Zoology', organisation: 'University of Washington', start: null, end: '1995' }),
        affiliation('education-summary', { role: 'B.S.', department: 'Biology', organisation: 'Stanford University', start: null, end: '1988' }),
        affiliation('education-summary', { role: 'B.S.', department: 'Mechanical Engineering', organisation: 'Stanford University', start: null, end: '1988' }),
      ] }],
      ['0000-0001-9128-8393/employments', { 'affiliation-group': [affiliation('employment-summary', { role: 'Research Scientist', department: '', organisation: 'NOAA NMFS Northwest Fisheries Science Center', start: '1999', end: null })] }],
      ['api.crossref.org/works', { message: { items: [] } }],
    ]);
    const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
    addAnchor(subject, 'schools', 'Stanford University');
    const { findings, threads } = await academicRecordConnector.run(schoolTask('Stanford University'), ctxFor(subject));
    expect(calls).toHaveLength(4);
    expect(findings).toHaveLength(2);
    expect(findings[0].title).toBe('ORCID (self-reported): PhD, University of Washington, until 1995; B.S., Stanford University, until 1988');
    expect(findings.every((f) => f.match === 'possible' && f.matchFixed === true)).toBe(true);
    expect(findings[0].matchReasons).toEqual(['names Stanford University, but 16 people on ORCID have this name and may share that school']);
    expect(threads).toEqual([]);
  });

  test('a very common name: the registry is asked for the ones who list the school', async () => {
    const calls = network([
      ['affiliation-org-name', { 'expanded-result': [{ 'orcid-id': ORCID_ID, 'given-names': 'Arthur', 'family-names': 'Mensch', 'institution-name': ['École Polytechnique'] }], 'num-found': 1 }],
      ['expanded-search', { 'expanded-result': [{ 'orcid-id': '0000-0002-2565-214X', 'given-names': 'Arthur', 'family-names': 'Mensch', 'institution-name': ['University of Queensland'] }], 'num-found': 240 }],
      [`${ORCID_ID}/educations`, orcidEducations],
      [`${ORCID_ID}/employments`, orcidEmployments],
      ['api.crossref.org/works', { message: { items: [] } }],
    ]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    addAnchor(subject, 'schools', 'École Polytechnique');
    const { findings } = await academicRecordConnector.run(schoolTask('École Polytechnique'), ctxFor(subject));
    expect(calls.filter((u) => u.includes('expanded-search'))).toHaveLength(2);
    expect(findings.map((f) => [f.match, f.matchFixed])).toEqual([['possible', true], ['possible', true]]);
    expect(findings[0].matchReasons[0]).toMatch(/240 people on ORCID have this name/);
  });

  test('two doctorates under one name are two people: a thesis at a known school is then only possible', async () => {
    const thesis = (doi, title, school, year) => ({ DOI: doi, title: [title], author: [{ given: 'Sarah', family: 'Johnson', sequence: 'first', affiliation: [{ name: school }] }], publisher: school, degree: ['PhD'], approved: { 'date-parts': [[year]] } });
    network([
      ['expanded-search', { 'expanded-result': null, 'num-found': 0 }],
      ['api.crossref.org/works', { message: { items: [thesis('10.1/a', 'Neural Synchronization in Seizures', 'University of Virginia', 2012), thesis('10.1/b', 'River sediments', 'University of Leeds', 1998)] } }],
    ]);
    const subject = createSubject({ name: 'Sarah Johnson', company: 'Acme Robotics' });
    addAnchor(subject, 'schools', 'University of Virginia');
    const { findings } = await academicRecordConnector.run(schoolTask('University of Virginia'), ctxFor(subject));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ match: 'possible', matchFixed: true });
    expect(findings[0].matchReasons).toEqual(['names University of Virginia, but 2 people on the thesis registries have this name and may share that school']);
  });

  test('both registries down is a failure', async () => {
    network([['expanded-search', { status: 500, body: 'x' }], ['api.crossref.org/works', { status: 500, body: 'x' }]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    await expect(academicRecordConnector.run(schoolTask('École Polytechnique'), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
  });

  test('other kinds of thread are not handled', async () => {
    const calls = network([]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    expect(await academicRecordConnector.run({ kind: 'associate', value: 'Guillaume Lample' }, ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
    expect(calls).toEqual([]);
  });
});

/* ----------------------------------------------------------- publications */

describe('scholarly publications (OpenAlex)', () => {
  test('one finding per author, records that share an ORCID iD read as one, graded by where the papers place them', async () => {
    const calls = network([['api.openalex.org/authors', openAlexMensch]]);
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    const { findings, threads, notes } = await publicationsConnector.run(subjectTask(subject), ctxFor(subject));

    expect(publicationsConnector.id).toBe('publications');
    expect(publicationsConnector.kinds).toEqual(['subject']);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).searchParams.get('search')).toBe('Arthur Mensch');
    expect(findings).toHaveLength(2); // "Arthur Menschel" is someone else
    const [own, namesake] = findings;
    expect(own.category).toBe('ip');
    expect(own.source).toBe('publications');
    expect(own.match).toBe('confirmed');
    expect(own.matchReasons).toEqual(['names Mistral AI']);
    expect(own.title).toBe('Scholarly author record: Arthur Mensch, 57 works, 37,100 citations; papers place them at Mistral AI (France) 2024; University of Oxford 2023; Google (United States) 2020, 2022');
    expect(own.quote).toContain('2 author records sharing one ORCID iD');
    expect(own.quote).toContain("Commissariat à l'Énergie Atomique et aux Énergies Alternatives: 2016-2018, 2020-2021");
    expect(own.url).toBe('https://openalex.org/A5110691380');
    expect(own.date).toBe('2024');
    expect(own.data).toMatchObject({ works: 57, citations: 37100, hIndex: 20, orcid: ORCID_ID, openalex: ['https://openalex.org/A5110691380', 'https://openalex.org/A5061701877'] });
    expect(own.data.affiliations[0]).toEqual({ institution: 'Mistral AI (France)', type: 'company', country: 'FR', years: [2024] });

    expect(namesake.match).toBe('possible');
    expect(namesake.title).toContain('Arthur H. Mensch');
    expect(namesake.title).toContain('Yale University 1967-1968');
    expect(threads).toEqual([]);
    expect(notes).toEqual([]);
  });

  test('at most three author records; the rest are counted in a note', async () => {
    const author = (n) => ({ id: `https://openalex.org/A${n}`, orcid: null, display_name: 'Sarah Johnson', works_count: n, cited_by_count: n, affiliations: [{ institution: { display_name: `University ${n}`, type: 'education' }, years: [2000 + n] }] });
    network([['api.openalex.org/authors', { results: [1, 2, 3, 4, 5].map(author) }]]);
    const subject = createSubject({ name: 'Sarah Johnson' });
    const { findings, notes } = await publicationsConnector.run(subjectTask(subject), ctxFor(subject));
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.match === 'possible')).toBe(true);
    expect(notes).toEqual(['OpenAlex holds 2 more author records under the name Sarah Johnson that could not be tied to this person; they were left out.']);
  });

  test('a used-up daily allowance is a note, not a failure', async () => {
    const calls = network([['api.openalex.org/authors', { status: 429, body: '{"error":"Rate limit exceeded"}' }]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const result = await publicationsConnector.run(subjectTask(subject), ctxFor(subject));
    expect(result.findings).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatch(/daily allowance/);
    expect(result.notes[0]).not.toMatch(/\b(API|endpoint|free|paid|key|token)\b/i);
    expect(calls).toHaveLength(1); // not retried
  });

  test('the source failing is an error', async () => {
    const subject = createSubject({ name: 'Arthur Mensch' });
    network([['api.openalex.org/authors', { status: 500, body: 'x' }]]);
    await expect(publicationsConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/HTTP 500/);
    network([['api.openalex.org/authors', '<html>maintenance</html>']]);
    await expect(publicationsConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/not JSON/);
    network([['api.openalex.org/authors', { error: 'something' }]]);
    await expect(publicationsConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/without a list of authors/);
  });

  test('the answer for a name is remembered, so a repeat check does not spend the allowance again', async () => {
    const calls = network([['api.openalex.org/authors', openAlexMensch]]);
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    const first = await publicationsConnector.run(subjectTask(subject), ctxFor(subject));
    const second = await publicationsConnector.run(subjectTask(subject), ctxFor(subject));
    expect(calls).toHaveLength(1);
    expect(second.findings.map((f) => f.id)).toEqual(first.findings.map((f) => f.id));
  });

  test('only the person is looked up', async () => {
    const calls = network([['api.openalex.org/authors', openAlexMensch]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    expect((await publicationsConnector.run({ kind: 'company', value: 'Mistral AI' }, ctxFor(subject))).findings).toEqual([]);
    expect(calls).toEqual([]);
  });
});
