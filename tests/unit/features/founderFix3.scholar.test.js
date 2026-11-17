/**
 * Round-3 grading fix for the academic record (scholar.js, plan item 22):
 * a school named in two languages ("Paris-Saclay University" / "Université
 * Paris-Saclay") is one school, ENS Cachan is ENS Paris-Saclay, and a
 * defended thesis whose school, year and supervisor all match confirmed
 * records is graded 'confirmed'.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const { academicRecordConnector, sameSchool, __resetScholarForTests } = require('../../../src/server/founder/sources/scholar');

const schoolTask = (school) => ({ kind: 'school', value: school, template: 'school', params: null, depth: 1, relation: null });
const thesesTask = { kind: 'subject', value: 'Claire Dubreuil', template: 'theses', params: null, depth: 0, relation: null };

function network(routes) {
  setTransport(async (url) => {
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) return { status: 200, headers: new Map(), url, text: async () => JSON.stringify(body) };
    }
    return { status: 404, headers: new Map(), url, text: async () => '{}' };
  });
}

const thesis = {
  id: '2017SACLS111', titrePrincipal: 'Optimisation stochastique', titreEN: 'Stochastic optimisation at scale',
  etabSoutenanceN: 'Université Paris-Saclay (ComUE)', dateSoutenance: '12/10/2017', auteurs: [{ nom: 'Dubreuil', prenom: 'Claire' }],
  directeurs: [{ nom: 'Lantier', prenom: 'Mathieu' }], doi: '', discipline: 'Informatique', status: 'soutenue', partenairesDeRecherche: [],
};
const routes = [['expanded-search', { 'expanded-result': null, 'num-found': 0 }], ['theses.fr', { theses: [thesis] }], ['api.crossref.org', { message: { items: [] } }]];

// What other sources found earlier in the check, as the loop hands it over.
const wikidataEducation = {
  source: 'wikidata', category: 'education', match: 'confirmed', url: 'https://www.wikidata.org/wiki/Q1#P69',
  title: 'Claire Dubreuil: educated at Paris-Saclay University, doctorate (2014-2017)',
  quote: 'Claire Dubreuil: educated at Paris-Saclay University (academic degree doctorate; start time 2014; end time 2017)',
};
const namesSupervisor = {
  source: 'wikipedia', category: 'education', match: 'confirmed', url: 'https://en.wikipedia.org/wiki/X#Education',
  title: 'Claire Dubreuil: education as described on Wikipedia', quote: 'She completed a doctorate under Mathieu Lantier.',
};

beforeEach(() => __resetScholarForTests({ crossrefGapMs: 0 }));
afterEach(() => setTransport());

describe('one school in two languages', () => {
  test('a French name and its English translation are the same school', () => {
    expect(sameSchool('Paris-Saclay University', 'Université Paris-Saclay')).toBe(true);
    expect(sameSchool('Université Paris-Saclay (ComUE)', 'Paris-Saclay University')).toBe(true);
    expect(sameSchool('University of Montreal', 'Université de Montréal')).toBe(true);
  });

  test('ENS Cachan is ENS Paris-Saclay under any of its names', () => {
    expect(sameSchool('École normale supérieure de Cachan', 'ENS Paris-Saclay')).toBe(true);
    expect(sameSchool('ENS Cachan', 'École normale supérieure Paris-Saclay')).toBe(true);
    expect(sameSchool('ENS Cachan', 'Université Paris-Saclay')).toBe(false);
  });

  test('still narrow: word order alone, another kind of school, or other words do not make a match', () => {
    expect(sameSchool('University of Washington', 'Washington University')).toBe(false);
    expect(sameSchool('Université de Lyon', 'Lyon College')).toBe(false);
    expect(sameSchool('York University', 'Université de New York')).toBe(false);
    expect(sameSchool('Université Paris-Saclay', 'Paris University')).toBe(false);
  });

  test('a thesis filed under the French name answers a school thread in English, and no "nothing ties" note is written', async () => {
    network(routes);
    const subject = createSubject({ name: 'Claire Dubreuil' });
    addAnchor(subject, 'schools', 'Paris-Saclay University');
    const { findings, notes } = await academicRecordConnector.run(schoolTask('Paris-Saclay University'), { subject, deadline: Date.now() + 20000, known: () => ({}) });
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toBe('likely');
    expect(notes).toEqual([]);
  });

  test('an earlier thesis under the French name stops the "nothing ties" note', async () => {
    network([routes[0], ['theses.fr', { theses: [] }], routes[2]]);
    const subject = createSubject({ name: 'Claire Dubreuil' });
    const earlier = { source: 'academic-record', category: 'education', match: 'likely', url: 'https://theses.fr/x', title: 't', data: { institution: 'Université Paris-Saclay (ComUE)', institutions: [] } };
    const { notes } = await academicRecordConnector.run(schoolTask('Paris-Saclay University'), { subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => [earlier] });
    expect(notes).toEqual([]);
  });
});

describe('a thesis tied three ways is confirmed', () => {
  const run = async (earlier) => {
    network(routes);
    const subject = createSubject({ name: 'Claire Dubreuil' });
    addAnchor(subject, 'schools', 'Paris-Saclay University');
    return academicRecordConnector.run(thesesTask, { subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => earlier });
  };

  test('school and years of a confirmed education record, and a supervisor named in a confirmed record', async () => {
    const { findings } = await run([wikidataEducation, namesSupervisor]);
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toBe('likely');
    expect(findings[0].matchReasons[0]).toMatch(/Paris-Saclay University in 2017.*Mathieu Lantier/);
  });

  test('an ORCID education entry with matching years counts as the education record', async () => {
    const orcid = { source: 'academic-record', category: 'education', match: 'confirmed', url: 'https://orcid.org/0000-0000-0000-0001', title: 'ORCID', quote: '', data: { entries: [{ organisation: 'Université Paris-Saclay', start: '2014', end: '2017' }] } };
    const { findings } = await run([orcid, namesSupervisor]);
    expect(findings[0].match).toBe('likely');
  });

  test('without the supervisor, other years, or a confirmed grade, it is not confirmed', async () => {
    expect((await run([wikidataEducation])).findings[0].match).not.toBe('likely');
    const otherYears = { ...wikidataEducation, title: 'Claire Dubreuil: educated at Paris-Saclay University (2005-2008)', quote: '' };
    expect((await run([otherYears, namesSupervisor])).findings[0].match).not.toBe('likely');
    expect((await run([{ ...wikidataEducation, match: 'likely' }, { ...namesSupervisor, match: 'likely' }])).findings[0].match).not.toBe('likely');
    const noYears = { ...wikidataEducation, title: 'Claire Dubreuil: educated at Paris-Saclay University', quote: '' };
    expect((await run([noYears, namesSupervisor])).findings[0].match).not.toBe('likely');
  });

  test('a supervisor with only the surname in common does not count', async () => {
    const surnameOnly = { ...namesSupervisor, quote: 'She completed a doctorate under Pierre Lantier.' };
    expect((await run([wikidataEducation, surnameOnly])).findings[0].match).not.toBe('likely');
  });
});
