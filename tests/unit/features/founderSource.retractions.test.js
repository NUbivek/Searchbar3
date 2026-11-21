/**
 * @jest-environment node
 *
 * Retracted papers (Crossref, with the Retraction Watch database): mapping,
 * identity grading (namesakes, initials, a one-word company), the privacy
 * rules and the failure paths. No network: fixtures follow the shape Crossref
 * served on 20 Nov 2026, with invented people, companies and papers.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor, addCompanyAlias } = require('../../../src/server/founder/identity');
const {
  retractionsConnector, retractionFindings, paperTitle, noticesOf, __resetRetractionsForTests, ROWS,
} = require('../../../src/server/founder/sources/retractions');

const ctxFor = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });
const subjectTask = (subject) => ({ kind: 'subject', value: subject.name, template: 'author', params: null, depth: 0, relation: null });

/* ------------------------------------------------------------- fixtures */

const author = (given, family, extra = {}) => ({ given, family, sequence: 'additional', affiliation: [], role: [{ role: 'author', vocabulary: 'crossref' }], ...extra });
const update = (doi, type, source, date, extra = {}) => ({
  DOI: doi, type, label: type === 'retraction' ? 'Retraction' : 'Expression of concern', source,
  updated: { 'date-parts': [date.split('-').map(Number)], 'date-time': `${date}T00:00:00Z`, timestamp: 1 }, ...extra,
});
const work = ({ doi, title, authors, updates, journal = 'Journal of Invented Results', issued = [2023, 11] }) => ({
  DOI: doi, title: [title], author: authors, 'update-to': updates, issued: { 'date-parts': [issued] }, 'container-title': [journal], type: 'journal-article',
});

// The subject's retracted paper: a Retraction Watch entry and the publisher's notice for the same paper.
const RETRACTED_RW = work({
  doi: '10.5555/notice.1001',
  title: 'Retraction: A Photoclick Hydrogel Platform for Muscle Tissue',
  authors: [
    author('Dana', 'Quillfeather', { sequence: 'first', affiliation: [{ name: 'Verdance Bio Inc., 12 Elm Street, Boston, MA 02110, USA' }] }),
    author('Marek', 'Zubrowski'),
  ],
  updates: [update('10.5555/paper.2002', 'retraction', 'retraction-watch', '2023-11-14', { 'record-id': '49920' })],
});
const RETRACTED_PUB = work({
  doi: '10.5555/notice.1002',
  title: 'Retraction Note: A Photoclick Hydrogel Platform for Muscle Tissue',
  authors: [author('Dana', 'Quillfeather', { sequence: 'first' }), author('Marek', 'Zubrowski')],
  updates: [update('10.5555/paper.2002', 'retraction', 'publisher', '2023-11-14')],
});
// A paper by the same full name, nothing else on it
const NAME_ONLY = work({
  doi: '10.5555/notice.3001',
  title: 'Retraction notice to "Soil Microbes in Alpine Meadows"',
  authors: [author('Dana J.', 'Quillfeather', { affiliation: [{ name: 'Alpine Research Station, Tirol' }] }), author('Ines', 'Varga')],
  updates: [update('10.5555/paper.4001', 'retraction', 'retraction-watch', '2019-04-11')],
  journal: 'Alpine Ecology',
});
// Fuzzy hits that are other people: another given name, initials only, the given name on a co-author
const NAMESAKES = [
  work({ doi: '10.5555/notice.5001', title: 'Retraction: Unrelated', authors: [author('Roisin', 'Quillfeather')], updates: [update('10.5555/paper.5002', 'retraction', 'retraction-watch', '2022-01-02')] }),
  work({ doi: '10.5555/notice.6001', title: 'Retraction: Initials Only', authors: [author('D.', 'Quillfeather')], updates: [update('10.5555/paper.6002', 'retraction', 'publisher', '2021-05-06')] }),
  work({ doi: '10.5555/notice.7001', title: 'Retraction: Someone Else', authors: [author('Dana M.', 'Snyderling')], updates: [update('10.5555/paper.7002', 'retraction', 'retraction-watch', '2020-03-04')] }),
];
const CONCERN = work({
  doi: '10.5555/notice.8001',
  title: 'Editorial Expression of Concern: Transformation of Cells by a Virus',
  authors: [author('Dana', 'Quillfeather', { ORCID: 'https://orcid.org/0000-0002-1825-0097' }), author('Ornella', 'Florentin')],
  updates: [update('10.5555/paper.8002', 'expression_of_concern', 'retraction-watch', '2025-06-18')],
  journal: 'Invented Nature',
});

const answer = (items, total = items.length) => ({ status: 'ok', 'message-type': 'work-list', 'message-version': '1.0.0', message: { 'total-results': total, items, 'items-per-page': ROWS } });

/** Fake network: the first route whose pattern is in the URL answers. A reply { status, body } sets the status. */
function network(routes) {
  const calls = [];
  setTransport(async (url) => {
    const plain = decodeURIComponent(String(url).replace(/\+/g, ' '));
    calls.push(plain);
    for (const [pattern, reply] of routes) {
      if (!plain.includes(pattern)) continue;
      const r = typeof reply === 'function' ? reply(url) : reply;
      const custom = r && typeof r.status === 'number' && !r.message;
      const status = custom ? r.status : 200;
      const body = custom ? r.body : r;
      return { status, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    }
    return { status: 404, headers: new Map(), url, text: async () => '{}' };
  });
  return calls;
}

beforeEach(() => __resetRetractionsForTests({ gap: 0 }));
afterEach(() => setTransport());

const subjectWith = (company = 'Verdance Bio') => createSubject({ name: 'Dana Quillfeather', company });

/* ------------------------------------------------------------- reading */

describe('reading Crossref works', () => {
  test('notices: only retractions and expressions of concern, with the retracted paper\'s DOI', () => {
    const item = { 'update-to': [update('10.5555/X', 'retraction', 'publisher', '2020-01-01'), update('10.5555/Y', 'correction', 'publisher', '2020-01-01')] };
    expect(noticesOf(item)).toEqual([{ doi: '10.5555/x', type: 'retraction', source: 'publisher', date: '2020-01-01' }]);
  });

  test('the paper title is read out of the notice title', () => {
    expect(paperTitle('Retraction Note: A Study of Things')).toBe('A Study of Things');
    expect(paperTitle('Retraction notice to "Soil Microbes in Alpine Meadows"')).toBe('Soil Microbes in Alpine Meadows');
    expect(paperTitle('Editorial Expression of Concern: Transformation of Cells')).toBe('Transformation of Cells');
    expect(paperTitle('WITHDRAWN: Note from the Editor')).toBe('Note from the Editor');
  });
});

/* ------------------------------------------------------------- the source */

describe('retractions source', () => {
  test('a paper whose author affiliation is the known company is likely; the two notices are one finding linked to the retracted paper', async () => {
    const subject = subjectWith();
    const calls = network([['query.author=Dana Quillfeather', answer([RETRACTED_RW, RETRACTED_PUB, ...NAMESAKES])]]);
    const out = await retractionsConnector.run(subjectTask(subject), ctxFor(subject));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/filter=update-type:retraction,update-type:expression_of_concern/);
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.match).toBe('likely');
    expect(f.matchReasons[0]).toMatch(/affiliation on the paper is Verdance Bio/);
    expect(f.url).toBe('https://doi.org/10.5555/paper.2002');
    expect(f.severity).toBe('medium');
    expect(f.date).toBe('2023-11-14');
    expect(f.title).toMatch(/^Retracted paper listing Dana Quillfeather as an author: A Photoclick Hydrogel Platform/);
    expect(f.data.noticeSources).toEqual(expect.arrayContaining(['Retraction Watch', 'the publisher']));
    expect(out.partial).toBeUndefined();
  });

  test('privacy: co-authors and the address inside an affiliation are never kept', async () => {
    const subject = subjectWith();
    network([['query.author', answer([RETRACTED_RW, NAME_ONLY, CONCERN])]]);
    const out = await retractionsConnector.run(subjectTask(subject), ctxFor(subject));
    const text = JSON.stringify(out);
    for (const banned of ['Zubrowski', 'Varga', 'Florentin', 'Elm Street', '02110', 'Tirol']) expect(text).not.toContain(banned);
    expect(out.threads).toEqual([]);
  });

  test('the full name alone is possible with "verify identity"; namesakes and initials are dropped; nothing is confirmed', async () => {
    const subject = subjectWith('Some Other Co');
    network([['query.author', answer([NAME_ONLY, ...NAMESAKES])]]);
    const out = await retractionsConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('possible');
    expect(out.findings[0].matchReasons[0]).toMatch(/verify identity/);
    expect(out.findings[0].quote).toMatch(/Author: Dana J\. Quillfeather/);
    expect(out.notes.join(' ')).toMatch(/verify identity/);
    expect(out.findings.some((f) => f.match === 'confirmed')).toBe(false);
  });

  test('a one-word ordinary company counts only as its whole name; every known name of the company counts', () => {
    const subject = subjectWith('Flow');
    const at = (name) => work({ doi: `10.5555/n.${name.length}`, title: 'Retraction: X Paper Title', authors: [author('Dana', 'Quillfeather', { affiliation: [{ name }] })], updates: [update(`10.5555/p.${name.length}`, 'retraction', 'publisher', '2020-01-01')] });
    expect(retractionFindings(subject, [at('Flow Cytometry Core, Invented University')])[0].match).toBe('possible');
    expect(retractionFindings(subject, [at('Flow')])[0].match).toBe('likely');
    const s2 = subjectWith('Verdance');
    addCompanyAlias(s2, { company: 'Verdance', alias: 'Verdance Biosciences Corp', origin: 'test' });
    expect(retractionFindings(s2, [at('Verdance Biosciences Corp, Cambridge, MA')])[0].match).toBe('likely');
  });

  test('a known school as the affiliation is likely', () => {
    const subject = subjectWith('Some Other Co');
    addAnchor(subject, 'schools', 'Stanford University');
    const item = work({ doi: '10.5555/n.1', title: 'Retraction: A Paper', authors: [author('Dana', 'Quillfeather', { affiliation: [{ name: 'Stanford University School of Medicine, Stanford, CA, USA' }] })], updates: [update('10.5555/p.1', 'retraction', 'publisher', '2020-01-01')] });
    const [f] = retractionFindings(subject, [item]);
    expect(f.match).toBe('likely');
    expect(f.data.affiliation).toBe('Stanford University');
  });

  test('an ORCID iD on a record already tied to the person is searched and ties the paper (likely); an expression of concern is low', async () => {
    const subject = subjectWith('Some Other Co');
    const earlier = [{ match: 'likely', source: 'academic-record', data: { orcid: '0000-0002-1825-0097' } }, { match: 'possible', data: { orcid: '0000-0003-0000-0001' } }];
    const calls = network([
      ['filter=orcid:0000-0002-1825-0097', answer([CONCERN])],
      ['query.author', answer([])],
    ]);
    const out = await retractionsConnector.run(subjectTask(subject), ctxFor(subject, earlier));
    expect(calls).toHaveLength(2);
    expect(calls.some((u) => u.includes('0000-0003-0000-0001'))).toBe(false);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('likely');
    expect(out.findings[0].matchReasons[0]).toMatch(/ORCID iD \(0000-0002-1825-0097\)/);
    expect(out.findings[0].severity).toBe('low');
    expect(out.findings[0].title).toMatch(/^Expression of concern on a paper/);
  });

  test('a paper already tied to the person (same DOI) is likely', () => {
    const subject = subjectWith('Some Other Co');
    const [f] = retractionFindings(subject, [NAME_ONLY], { tiedDois: new Set(['10.5555/paper.4001']) });
    expect(f.match).toBe('likely');
  });

  test('an ORCID link is searched only when the thread is trusted', async () => {
    const subject = subjectWith();
    const url = 'https://orcid.org/0000-0002-1825-0097';
    expect(retractionsConnector.plan({ kind: 'url', value: url, trusted: false }, subject)).toEqual([]);
    expect(retractionsConnector.plan({ kind: 'url', value: url, trusted: true }, subject)[0].template).toBe('orcid-id');
    const calls = network([['filter=orcid', answer([CONCERN])]]);
    expect(await retractionsConnector.run({ kind: 'url', value: url, template: 'orcid-id', params: null }, ctxFor(subject))).toEqual({ findings: [], threads: [], notes: [] });
    const out = await retractionsConnector.run({ kind: 'url', value: url, template: 'orcid-id', params: { trusted: true } }, ctxFor(subject));
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toMatch(/query\.author/);
    expect(out.findings[0].match).toBe('likely');
  });

  test('nothing found: the note says what was searched; no partial', async () => {
    const subject = subjectWith();
    network([['query.author', answer([])]]);
    const out = await retractionsConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/Searched Crossref's record of retractions .* Dana Quillfeather: no paper with an author of that full name was found/);
    expect(out.partial).toBeUndefined();
  });

  test('more results than were read: partial, and said', async () => {
    const subject = subjectWith();
    network([['query.author', answer([RETRACTED_RW], ROWS + 50)]]);
    const out = await retractionsConnector.run(subjectTask(subject), ctxFor(subject));
    expect(out.partial[0]).toMatch(/most relevant 100 of 150 read/);
    expect(out.findings).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- failures */

describe('failures are reported as failures', () => {
  test('a server error throws', async () => {
    const subject = subjectWith();
    network([['query.author', { status: 500, body: 'oops' }]]);
    await expect(retractionsConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow();
  });

  test('a changed format throws (no list of works, or works without retraction details)', async () => {
    const subject = subjectWith();
    network([['query.author', { status: 'ok', message: { items: 'nope' } }]]);
    await expect(retractionsConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/shape/);
    __resetRetractionsForTests({ gap: 0 });
    const bare = { ...RETRACTED_RW, 'update-to': undefined, 'updated-by': [{ DOI: 'x' }] };
    network([['query.author', answer([bare])]]);
    await expect(retractionsConnector.run(subjectTask(subject), ctxFor(subject))).rejects.toThrow(/format/);
  });

  test('one of two searches failing: the other is used, and the lookup is partial', async () => {
    const subject = subjectWith('Some Other Co');
    const earlier = [{ match: 'likely', data: { orcid: '0000-0002-1825-0097' } }];
    network([
      ['filter=orcid', { status: 500, body: 'oops' }],
      ['query.author', answer([NAME_ONLY])],
    ]);
    const out = await retractionsConnector.run(subjectTask(subject), ctxFor(subject, earlier));
    expect(out.findings).toHaveLength(1);
    expect(out.partial[0]).toMatch(/ORCID iD 0000-0002-1825-0097/);
    expect(out.notes.join(' ')).toMatch(/did not answer/);
  });

  test('a name without a first and last name is not searched, and says so', async () => {
    const subject = createSubject({ name: 'Quillfeather' });
    const calls = network([]);
    const out = await retractionsConnector.run(subjectTask(subject), ctxFor(subject));
    expect(calls).toHaveLength(0);
    expect(out.partial).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- contract */

test('obeys the source contract', () => {
  expect(retractionsConnector.id).toMatch(/^[a-z0-9-]+$/);
  expect(retractionsConnector.label).not.toMatch(/\b(api|endpoint|api key|token|free|paid|tier|env)\b/i);
  expect(retractionsConnector.kinds).toEqual(['subject', 'url']);
  const subject = createSubject({ name: 'Elizabeth Holmes', company: 'Theranos' });
  for (const p of retractionsConnector.plan({ kind: 'subject', value: 'Elizabeth Holmes' }, subject)) expect(p.template).toMatch(/^[a-z0-9.:_-]+$/i);
});
