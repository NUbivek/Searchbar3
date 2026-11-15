/**
 * Fixes to the knowledge connectors (sources/knowledge.js):
 *   - Wikipedia findings are not dated with the article's last edit;
 *   - the text the Wikipedia grade is read from never holds private-life sentences;
 *   - LittleSis political fundraising and donation ties are dropped, whatever category they are filed under;
 *   - a nonprofit whose name merely contains the surname is not called a family foundation;
 *   - the filings site's people search (closed to automated visitors) is never asked.
 * Fixtures are fictional people.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const K = require('../../../src/server/founder/sources/knowledge');

const YEAR = new Date().getUTCFullYear();
const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const ok = (url, body, status = 200) => ({ status, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function fakeNetwork(routes) {
  const calls = [];
  setTransport(async (url) => {
    calls.push(url);
    for (const [test, body, status] of routes) if (test(url)) return ok(url, typeof body === 'function' ? body(url) : body, status || 200);
    return ok(url, 'not found', 404);
  });
  return calls;
}
afterEach(() => {
  setTransport();
  K.__resetKnowledgeForTests();
});

describe('wikipedia: dates and the grading text', () => {
  const ARTICLE = [
    'Jane Roe is an American engineer and the founder of Acme Robotics. She previously worked at Globex as a director of engineering.',
    '',
    '== Legal issues ==',
    `In 2018, a federal grand jury indicted Roe on charges of wire fraud. A trial is scheduled for ${YEAR + 2}.`,
    '',
    'Roe was later named in a lawsuit by investors over statements about the company.',
    '',
    '== Personal life ==',
    'Roe married Sam Roe in 2010 and they live in Palo Alto. Her father, John Roe, is the chairman of Roe Industries.',
  ].join('\n');
  const page = { query: { pages: [{ title: 'Jane Roe', extract: ARTICLE, pageprops: { 'wikibase-shortdesc': 'American engineer' }, canonicalurl: 'https://en.wikipedia.org/wiki/Jane_Roe', revisions: [{ timestamp: '2026-11-10T08:00:00Z' }] }] } };

  test('a finding carries the year its own text gives, never the date of the last edit', async () => {
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe' }, ctxFor(subject));
    expect(r.findings.length).toBeGreaterThan(1);
    expect(r.findings.some((f) => f.date === '2026-11-10')).toBe(false);
    const indictment = r.findings.find((f) => /indicted/.test(f.quote));
    expect(indictment.date).toBe('2018'); // a year in the future is not the record's date
    const lawsuit = r.findings.find((f) => /lawsuit by investors/.test(f.quote));
    expect(lawsuit.date).toBeNull();
    expect(r.findings.find((f) => f.category === 'identity').date).toBeNull();
    expect(r.findings.every((f) => f.data.revisedAt === '2026-11-10T08:00:00Z')).toBe(true);
  });

  test('the text the grade is read from leaves out private life, and the grade still sees the company', async () => {
    fakeNetwork([[(u) => u.includes('wikipedia.org/w/api.php'), page]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.wikipediaConnector.run({ kind: 'url', value: 'https://en.wikipedia.org/wiki/Jane_Roe' }, ctxFor(subject));
    expect(JSON.stringify(r)).not.toMatch(/married|Palo Alto/);
    expect(r.findings.every((f) => f.match === 'confirmed')).toBe(true);
    expect(r.findings.every((f) => !f.gradeText || f.gradeText.length <= 4000)).toBe(true);
  });
});

describe('littlesis: political fundraising and donation ties are dropped', () => {
  const link = (kind, id, name) => `https://littlesis.org/${kind}/${id}-${name.replace(/ /g, '_')}`;
  const entity = (id, kind, name, attrs = {}) => ({ type: 'entities', id, attributes: { id, name, blurb: '', summary: '', primary_ext: kind === 'person' ? 'Person' : 'Org', types: [], aliases: [name], ...attrs }, links: { self: link(kind === 'person' ? 'person' : 'org', id, name) } });
  const rel = (id, category, [k1, id1, n1], [k2, id2, n2], attrs = {}) => ({
    type: 'relationships', id,
    attributes: { id, entity1_id: id1, entity2_id: id2, category_id: category, description1: null, description2: null, start_date: null, end_date: null, is_current: null, description: `${n1}  and  ${n2}`, category_attributes: null, ...attrs },
    self: `https://littlesis.org/relationships/${id}`, entity: link(k1, id1, n1), related: link(k2, id2, n2),
  });
  const JANE = ['person', 11, 'Jane Roe'];
  const RELS = [
    rel(1, 1, JANE, ['org', 50, 'Acme Robotics'], { description1: 'Chief Executive Officer', description: 'Jane Roe  had a position (Chief Executive Officer) at  Acme Robotics' }),
    rel(2, 9, JANE, ['person', 60, 'Paul Bundle'], { description1: 'Fundraiser Collaborator', description2: 'Fundraiser Collaborator', description: 'Jane Roe  and  Paul Bundle  have/had a professional relationship' }),
    rel(3, 9, JANE, ['person', 61, 'Rita Partner'], { description1: 'business partner', description2: 'business partner', description: 'Jane Roe  and  Rita Partner  have/had a professional relationship' }),
    rel(4, 1, JANE, ['org', 62, 'Doe for President'], { description1: 'National Finance Committee', description: 'Jane Roe  had a position (National Finance Committee) at  Doe for President' }),
    rel(5, 1, JANE, ['org', 63, 'Tech Forward PAC'], { description1: 'Treasurer', description: 'Jane Roe  had a position (Treasurer) at  Tech Forward PAC' }),
    rel(6, 3, JANE, ['org', 64, 'Sierra Club'], { description1: 'Bundler', description: 'Jane Roe  is/was a member of  Sierra Club' }),
    rel(7, 1, JANE, ['org', 65, 'Pac-12 Conference'], { description1: 'Board Member', description: 'Jane Roe  had a position (Board Member) at  Pac-12 Conference' }),
    rel(8, 1, JANE, ['org', 66, 'Teach For America'], { description1: 'Director', description: 'Jane Roe  had a position (Director) at  Teach For America' }),
  ];

  test('fundraiser, bundler, campaign committee and PAC ties never become findings or threads; ordinary roles stay', async () => {
    fakeNetwork([
      [(u) => u.includes('/api/entities/search?q=Jane%20Roe'), { data: [entity(11, 'person', 'Jane Roe', { blurb: 'Founder and CEO, Acme Robotics' })] }],
      [(u) => u.endsWith('/api/entities/11/relationships'), { data: RELS }],
    ]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await K.littleSisConnector.run({ kind: 'subject', value: 'Jane Roe' }, ctxFor(subject));
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/Paul Bundle|Fundraiser|Doe for President|Tech Forward PAC|Bundler|Sierra Club/);
    expect(r.threads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'associate', value: 'Rita Partner' })]));
    const titles = r.findings.map((f) => f.title);
    expect(titles).toEqual(expect.arrayContaining([
      'Jane Roe: Chief Executive Officer at Acme Robotics',
      'Jane Roe: Board Member at Pac-12 Conference',
      'Jane Roe: Director at Teach For America',
    ]));
  });
});

describe('nonprofit filings: surname in the name is not a family tie; no people search', () => {
  const filingXml = (officers, { family = 'false' } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<Return xmlns="http://www.irs.gov/efile"><ReturnHeader><TaxPeriodEndDt>2023-12-31</TaxPeriodEndDt><ReturnTypeCd>990</ReturnTypeCd></ReturnHeader>
<ReturnData><IRS990><FamilyOrBusinessRlnInd>${family}</FamilyOrBusinessRlnInd>
${officers.map(([n, t]) => `<Form990PartVIISectionAGrp><PersonNm>${n}</PersonNm><TitleTxt>${t}</TitleTxt></Form990PartVIISectionAGrp>`).join('')}
</IRS990></ReturnData></Return>`;
  const routes = (officers, opts) => [
    [(u) => u.includes('/api/v2/search.json'), { total_results: 1, organizations: [{ ein: 555, name: 'Robert Wood Johnson Foundation' }] }],
    [(u) => u.endsWith('/api/v2/organizations/555.json'), { organization: { ein: 555, name: 'Robert Wood Johnson Foundation', latest_object_id: '202405555' } }],
    [(u) => u.endsWith('/202405555_public.xml'), filingXml(officers, opts)],
  ];

  test('John Johnson on the board of the Robert Wood Johnson Foundation: a career record, not a family foundation', async () => {
    const calls = fakeNetwork(routes([['JOHN JOHNSON', 'TRUSTEE'], ['ALICE SMITH', 'CHAIR']]));
    const subject = createSubject({ name: 'John Johnson', company: 'Acme Robotics' });
    const r = await K.nonprofitFilingsConnector.run({ kind: 'subject', value: 'John Johnson' }, ctxFor(subject));
    expect(calls.some((u) => u.includes('name_search'))).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ category: 'career', severity: 'info', title: 'John Johnson: trustee of Robert Wood Johnson Foundation, a US nonprofit (2023 filing)' });
    expect(r.findings[0].title).not.toMatch(/family/i);
    expect(r.findings[0].data.orgSharesSurname).toBe(true);
  });

  test('the filing marks family ties but no other officer shares the surname: still not a family foundation', async () => {
    fakeNetwork(routes([['JOHN JOHNSON', 'TRUSTEE'], ['ALICE SMITH', 'CHAIR']], { family: 'true' }));
    const subject = createSubject({ name: 'John Johnson', company: 'Acme Robotics' });
    const r = await K.nonprofitFilingsConnector.run({ kind: 'subject', value: 'John Johnson' }, ctxFor(subject));
    expect(r.findings[0].category).toBe('career');
  });

  test('the filing marks family ties and another officer shares the surname: a family foundation lead', async () => {
    fakeNetwork(routes([['JOHN JOHNSON', 'TRUSTEE'], ['MARY JOHNSON', 'PRESIDENT']], { family: 'true' }));
    const subject = createSubject({ name: 'John Johnson', company: 'Acme Robotics' });
    const r = await K.nonprofitFilingsConnector.run({ kind: 'subject', value: 'John Johnson' }, ctxFor(subject));
    expect(r.findings[0]).toMatchObject({ category: 'related', severity: 'low' });
    expect(r.findings[0].title).toMatch(/^Family foundation: /);
    expect(r.notes[0]).toMatch(/Mary Johnson \(President\) shares a surname with the subject: unconfirmed/);
  });
});
