/**
 * Round-2 grading fixes for the academic record (scholar.js, plan item 17):
 * a French school is also looked up in theses.fr, renamed or merged schools
 * are the same school, and the "nothing ties the person to the school" note
 * is not written when an earlier thesis or ORCID record already does.
 */
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const { academicRecordConnector, sameSchool, __resetScholarForTests } = require('../../../src/server/founder/sources/scholar');

const schoolTask = (school) => ({ kind: 'school', value: school, template: 'school', params: null, depth: 1, relation: null });

function network(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) return { status: 200, headers: new Map(), url, text: async () => JSON.stringify(body) };
    }
    return { status: 404, headers: new Map(), url, text: async () => '{}' };
  });
  return calls;
}

const thesesFr = {
  totalHits: 1,
  theses: [{
    id: '2018SACLS300', titrePrincipal: 'Apprentissage de représentations en imagerie fonctionnelle', titreEN: 'Learning representations from functional MRI data',
    etabSoutenanceN: 'Université Paris-Saclay (ComUE)', dateSoutenance: '28/09/2018', auteurs: [{ nom: 'Mensch', prenom: 'Arthur' }],
    directeurs: [{ nom: 'Thirion', prenom: 'Bertrand' }], doi: '', discipline: 'Mathématiques et Informatique', status: 'soutenue',
    partenairesDeRecherche: [{ nom: 'Université Paris-Sud (1970-2019)', type: "établissement opérateur d'inscription" }],
  }],
};
const noOrcid = { 'expanded-result': null, 'num-found': 0 };
const noCrossref = { message: { items: [] } };

beforeEach(() => __resetScholarForTests({ crossrefGapMs: 0 }));
afterEach(() => setTransport());

describe('renamed and merged schools', () => {
  test('a school is the same under its former name', () => {
    expect(sameSchool('Université Paris-Sud', 'Université Paris-Saclay')).toBe(true);
    expect(sameSchool('Université Paris-Sud (1970-2019)', 'Université Paris-Saclay (ComUE)')).toBe(true);
    expect(sameSchool('Télécom ParisTech', 'Télécom Paris')).toBe(true);
    expect(sameSchool('Telecom ParisTech', 'Télécom Paris, Institut Polytechnique de Paris')).toBe(true);
    // still narrow
    expect(sameSchool('Université Paris-Saclay', 'Université Paris Cité')).toBe(false);
    expect(sameSchool('Université Paris-Sud', 'Sorbonne Université')).toBe(false);
    expect(sameSchool('Télécom Paris', 'Télécom SudParis')).toBe(false);
  });
});

describe('one school: French thesis registry', () => {
  test('a French school is looked up in theses.fr, and its thesis there ties the person to it', async () => {
    const calls = network([['expanded-search', noOrcid], ['theses.fr', thesesFr], ['api.crossref.org', noCrossref]]);
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    addAnchor(subject, 'schools', 'Université Paris-Saclay');
    const { findings, notes } = await academicRecordConnector.run(schoolTask('Université Paris-Saclay'), { subject, deadline: Date.now() + 20000, known: () => ({}) });
    expect(calls.some((u) => u.includes('theses.fr'))).toBe(true);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Doctoral thesis: Learning representations from functional MRI data (Université Paris-Saclay (ComUE), 2018)');
    expect(findings[0].match).toBe('likely');
    expect(findings[0].data.institutions).toEqual(['Université Paris-Saclay (ComUE)', 'Université Paris-Sud (1970-2019)']);
    expect(notes).toEqual([]);
  });

  test('a school known under its former name finds the thesis filed under the new one', async () => {
    network([['expanded-search', noOrcid], ['theses.fr', { theses: [{ ...thesesFr.theses[0], partenairesDeRecherche: [] }] }], ['api.crossref.org', noCrossref]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const { findings, notes } = await academicRecordConnector.run(schoolTask('Université Paris-Sud'), { subject, deadline: Date.now() + 20000, known: () => ({}) });
    expect(findings).toHaveLength(1);
    // the former name is not an anchor of the subject: a name-only record stays possible
    expect(findings[0].match).toBe('possible');
    expect(notes).toEqual([]);
  });

  test('a school outside France does not ask theses.fr', async () => {
    const calls = network([['expanded-search', noOrcid], ['api.crossref.org', noCrossref]]);
    const subject = createSubject({ name: 'Sarah Johnson' });
    await academicRecordConnector.run(schoolTask('Stanford University'), { subject, deadline: Date.now() + 20000, known: () => ({}) });
    expect(calls.some((u) => u.includes('theses.fr'))).toBe(false);
  });

  test('a namesake\'s thesis at another French school is not attributed', async () => {
    network([['expanded-search', noOrcid], ['theses.fr', { theses: [{ ...thesesFr.theses[0], etabSoutenanceN: 'Université de Lyon', partenairesDeRecherche: [] }] }], ['api.crossref.org', noCrossref]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const { findings, notes } = await academicRecordConnector.run(schoolTask('Université Paris-Saclay'), { subject, deadline: Date.now() + 20000, known: () => ({}) });
    expect(findings).toEqual([]);
    expect(notes[0]).toMatch(/^No thesis or ORCID entry ties Arthur Mensch to Université Paris-Saclay/);
  });
});

describe('one school: the "nothing ties" note', () => {
  const earlierThesis = {
    source: 'academic-record', category: 'education', match: 'likely',
    data: { registry: 'theses.fr', institution: 'Université Paris-Saclay (ComUE)', institutions: ['Université Paris-Saclay (ComUE)', 'Université Paris-Sud (1970-2019)'] },
  };

  test('is not written when a thesis found earlier in the check already names the school', async () => {
    network([['expanded-search', noOrcid], ['theses.fr', { theses: [] }], ['api.crossref.org', noCrossref]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const ctx = { subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => [earlierThesis] };
    expect((await academicRecordConnector.run(schoolTask('Université Paris-Saclay'), ctx)).notes).toEqual([]);
    // also under the school's former name, and from an ORCID record's entries
    expect((await academicRecordConnector.run(schoolTask('Université Paris-Sud'), ctx)).notes).toEqual([]);
    const orcid = { source: 'academic-record', data: { registry: 'ORCID', entries: [{ organisation: 'Télécom ParisTech' }] } };
    expect((await academicRecordConnector.run(schoolTask('Télécom Paris'), { ...ctx, findings: [orcid] })).notes).toEqual([]);
  });

  test('is still written when the earlier records are about other schools or from other sources', async () => {
    network([['expanded-search', noOrcid], ['api.crossref.org', noCrossref]]);
    const subject = createSubject({ name: 'Arthur Mensch' });
    const other = { source: 'web', data: { institution: 'Harvard University' } };
    const ctx = { subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => [earlierThesis, other] };
    const { notes } = await academicRecordConnector.run(schoolTask('Harvard University'), ctx);
    expect(notes[0]).toBe('No thesis or ORCID entry ties Arthur Mensch to Harvard University in the open academic registries. Most universities do not deposit theses there, so this neither confirms nor contradicts the claim.');
  });
});
