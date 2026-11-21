/**
 * Round 3 fixes in scholar.js (ORCID, OpenAlex), presence.js (Semantic Scholar, Stack Overflow, Bluesky) and
 * profiles.js (GitHub): namesakes through an organisation that only begins with the company's word, paper titles
 * read as employers, self-described accounts graded 'confirmed', and what these sources knew but never reported.
 * Fixtures are small cuts shaped like the real responses (fictional people unless named as public test subjects).
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));
const { setTransport } = require('../../../src/server/founder/http');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');
const { academicRecordConnector, publicationsConnector, dissertationFindings, __resetScholarForTests } = require('../../../src/server/founder/sources/scholar');
const { semanticScholarConnector, stackOverflowConnector, ownPostSeverity, __resetPresenceForTests } = require('../../../src/server/founder/sources/presence');
const { githubConnector, cityOf, __resetProfilesForTests } = require('../../../src/server/founder/sources/profiles');

const ctxFor = (subject, findings = []) => ({ subject, deadline: Date.now() + 20000, known: () => ({}), findings: () => findings });
const task = (kind, value, extra = {}) => ({ kind, value, template: null, params: null, depth: 1, relation: null, ...extra });

function network(routes) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push(url);
    calls.headers = init?.headers;
    for (const [pattern, reply] of routes) {
      if (!url.includes(pattern)) continue;
      const r = typeof reply === 'function' ? reply(url) : reply;
      const custom = r && typeof r.status === 'number';
      const body = custom ? r.body : r;
      return { status: custom ? r.status : 200, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    }
    return { status: 404, headers: new Map(), url, text: async () => '{}' };
  });
  return calls;
}
beforeEach(() => { __resetScholarForTests({ crossrefGapMs: 0 }); __resetPresenceForTests(); __resetProfilesForTests(); });
afterEach(() => { setTransport(); delete process.env.GITHUB_TOKEN; });

/* ------------------------------------------------------------ ORCID */

const self = (id) => ({ 'source-orcid': { path: id } });
const aff = (key, id, { role, department, organisation, start, end }) => ({ summaries: [{ [key]: {
  source: self(id), 'role-title': role, 'department-name': department,
  'start-date': start ? { year: { value: start } } : null, 'end-date': end ? { year: { value: end } } : null,
  organization: { name: organisation, address: { city: 'Somewhere' } },
} }] });
const ID = '0000-0002-1825-0097';

describe('ORCID', () => {
  test('an institution that only begins with the company word does not tie a namesake\'s record', async () => {
    const calls = network([
      ['expanded-search', { 'num-found': 2, 'expanded-result': [
        { 'orcid-id': ID, 'given-names': 'John', 'family-names': 'Smith', 'institution-name': ['University of Leeds', 'Mercury Insurance Group'] },
        { 'orcid-id': '0000-0001-0000-0002', 'given-names': 'John', 'family-names': 'Smith', 'institution-name': ['University of Lagos'] },
      ] }],
    ]);
    const subject = createSubject({ name: 'John Smith', company: 'Mercury' });
    const r = await academicRecordConnector.run(task('subject', 'John Smith', { template: 'orcid' }), ctxFor(subject));
    // neither record is read: nothing ties either to Mercury
    expect(calls.some((u) => u.includes('/educations'))).toBe(false);
    for (const f of r.findings) expect(f.match).toBe('possible');
  });

  test('qualifications, distinctions, invited positions and websites are read; structured fields for the profile', async () => {
    network([
      ['expanded-search', { 'num-found': 1, 'expanded-result': [{ 'orcid-id': ID, 'given-names': 'Jane', 'family-names': 'Roe', 'institution-name': ['Acme Robotics'] }] }],
      ['/educations', { 'affiliation-group': [aff('education-summary', ID, { role: 'PhD', department: 'Robotics', organisation: 'Stanford University', start: '2008', end: '2012' })] }],
      ['/employments', { 'affiliation-group': [aff('employment-summary', ID, { role: 'Chief executive', organisation: 'Acme Robotics', start: '2015' })] }],
      ['/qualifications', { 'affiliation-group': [aff('qualification-summary', ID, { role: 'Professional Engineer licence', organisation: 'State Board of Engineers', start: '2013' })] }],
      ['/distinctions', { 'affiliation-group': [aff('distinction-summary', ID, { role: 'Young Inventor Award', organisation: 'IEEE', start: '2019' })] }],
      ['/invited-positions', { 'affiliation-group': [aff('invited-position-summary', ID, { role: 'Visiting fellow', organisation: 'MIT', start: '2020', end: '2021' })] }],
      ['/researcher-urls', { 'researcher-url': [{ 'url-name': 'Home', url: { value: 'https://janeroe.dev/about' } }] }],
    ]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await academicRecordConnector.run(task('subject', 'Jane Roe', { template: 'orcid' }), ctxFor(subject));
    const edu = r.findings.find((f) => f.category === 'education');
    const career = r.findings.find((f) => f.category === 'career');
    expect(edu.data.education).toEqual([{ school: 'Stanford University', degree: 'PhD', field: 'Robotics', from: 2008, to: 2012 }]);
    expect(edu.data.qualifications).toEqual([{ org: 'State Board of Engineers', title: 'Professional Engineer licence', from: 2013, to: null }]);
    expect(career.data.employers).toEqual([{ org: 'Acme Robotics', title: 'Chief executive', from: 2015, to: null }]);
    expect(career.data.awards).toEqual([{ text: 'Young Inventor Award, IEEE', year: 2019 }]);
    expect(career.data.positions).toEqual([{ title: 'Visiting fellow (invited)', of: 'MIT', from: 2020, to: 2021 }]);
    expect(r.threads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'domain', value: 'janeroe.dev', trusted: true })]));
    expect(JSON.stringify(r)).not.toMatch(/Somewhere/);
  });

  test('the exact ORCID iD a tied entry links to is read without a name search, and is "likely"', async () => {
    const calls = network([
      ['/educations', { 'affiliation-group': [aff('education-summary', ID, { role: 'BS', organisation: 'Utah State University', end: '2002' })] }],
      ['/employments', { 'affiliation-group': [] }],
    ]);
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const url = `https://orcid.org/${ID}`;
    expect(academicRecordConnector.plan({ kind: 'url', value: url, trusted: true }).map((p) => p.template)).toEqual(['orcid-id']);
    expect(academicRecordConnector.plan({ kind: 'url', value: url, trusted: false })).toEqual([]);
    // the loop builds the task from the plan: the thread's trust travels in params
    const [planned] = academicRecordConnector.plan({ kind: 'url', value: url, trusted: true });
    const r = await academicRecordConnector.run(task('url', url, { template: planned.template, params: planned.params }), ctxFor(subject));
    expect(calls.some((u) => u.includes('expanded-search'))).toBe(false);
    expect(calls.some((u) => /\/(person|email|address)(?:$|[/?])/.test(u))).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ category: 'education', match: 'likely', matchFixed: true });
  });
});

/* ------------------------------------------------------------ OpenAlex */

describe('OpenAlex', () => {
  const author = (id, institution) => ({ id: `https://openalex.org/A${id}`, display_name: 'John Smith', works_count: 10, cited_by_count: 5, summary_stats: { h_index: 2 }, affiliations: [{ institution: { display_name: institution, type: 'education', country_code: 'US' }, years: [2019, 2020] }] });

  test('two namesakes at a known school are both held at "possible"', async () => {
    network([['api.openalex.org/authors', { results: [author(1, 'Stanford University'), author(2, 'Stanford University')] }], ['api.openalex.org/works', { results: [] }]]);
    const subject = createSubject({ name: 'John Smith' });
    addAnchor(subject, 'schools', 'Stanford University');
    const r = await publicationsConnector.run(task('subject', 'John Smith'), ctxFor(subject));
    const records = r.findings.filter((f) => f.category === 'ip');
    expect(records).toHaveLength(2);
    for (const f of records) expect(f).toMatchObject({ match: 'possible', matchFixed: true });
  });

  test('an affiliation that only begins with the company word does not confirm the record', async () => {
    network([['api.openalex.org/authors', { results: [author(1, 'Mercury Systems')] }], ['api.openalex.org/works', { results: [] }]]);
    const subject = createSubject({ name: 'John Smith', company: 'Mercury' });
    const r = await publicationsConnector.run(task('subject', 'John Smith'), ctxFor(subject));
    for (const f of r.findings) expect(f.match).toBe('possible');
  });

  test('a dissertation: likely when its ORCID iD is that of a tied record, possible otherwise; no affiliation strings', () => {
    const subject = createSubject({ name: 'Arthur Mensch', company: 'Mistral AI' });
    const works = [{
      id: 'https://openalex.org/W1', display_name: 'Stochastic optimization for brain imaging', publication_year: 2018, type: 'dissertation',
      authorships: [{ raw_author_name: 'Arthur Mensch', author: { display_name: 'Arthur Mensch', orcid: `https://orcid.org/${ID}` }, institutions: [{ display_name: 'Université Paris-Saclay' }], raw_affiliation_strings: ['1 rue Example, 91190 Gif'] }],
    }];
    const tied = dissertationFindings(subject, works, { tiedOrcids: [ID] });
    expect(tied).toHaveLength(1);
    expect(tied[0]).toMatchObject({ category: 'education', match: 'likely', date: '2018' });
    expect(tied[0].data.education).toEqual([{ school: 'Université Paris-Saclay', degree: null, field: null, from: null, to: 2018 }]);
    expect(JSON.stringify(tied)).not.toMatch(/rue Example/);
    expect(dissertationFindings(subject, works)[0].match).toBe('possible');
  });

  test('a failed dissertation search is said, never shown as none', async () => {
    network([['api.openalex.org/authors', { results: [] }], ['api.openalex.org/works', { status: 500, body: 'x' }]]);
    const subject = createSubject({ name: 'John Smith' });
    const r = await publicationsConnector.run(task('subject', 'John Smith'), ctxFor(subject));
    expect(r.notes.join(' ')).toMatch(/Dissertations on OpenAlex could not be searched/);
  });
});

/* ------------------------------------------------------------ Semantic Scholar, Stack Overflow, Bluesky */

describe('presence', () => {
  test('Semantic Scholar: a paper title with the company word is not an employer', async () => {
    network([['api.semanticscholar.org', { data: [{ authorId: '1', name: 'Jane Doe', affiliations: [], homepage: null, paperCount: 3, citationCount: 9, hIndex: 1, url: 'https://www.semanticscholar.org/author/1', papers: [{ title: 'Ramp metering strategies for urban freeways', year: 2019, venue: 'Ramp Engineering Journal' }] }] }]]);
    const subject = createSubject({ name: 'Jane Doe', company: 'Ramp' });
    const r = await semanticScholarConnector.run(task('subject', 'Jane Doe'), ctxFor(subject));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].match).toBe('possible');
    expect(r.findings[0].quote).toMatch(/Ramp metering/);
    expect(r.threads).toEqual([]);
  });

  test('Semantic Scholar: an affiliation naming the company is "likely" at most', async () => {
    network([['api.semanticscholar.org', { data: [{ authorId: '1', name: 'Jane Roe', affiliations: ['Acme Robotics'], paperCount: 3, citationCount: 9, hIndex: 1, url: 'https://www.semanticscholar.org/author/1', papers: [] }] }]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await semanticScholarConnector.run(task('subject', 'Jane Roe'), ctxFor(subject));
    expect(r.findings[0]).toMatchObject({ match: 'likely', matchFixed: true });
  });

  test('Stack Overflow: an account found by the name is "likely" at most, and says it is self-described', async () => {
    network([['/users?inname=', { items: [{ user_id: 7, display_name: 'Jane Roe', about_me: 'CEO at Acme Robotics', reputation: 10, creation_date: 1600000000, link: 'https://stackoverflow.com/users/7/jane-roe' }] }]]);
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    const r = await stackOverflowConnector.run(task('subject', 'Jane Roe'), ctxFor(subject));
    expect(r.findings[0]).toMatchObject({ match: 'likely', matchFixed: true });
    expect(r.findings[0].matchReasons.join(' ')).toMatch(/self-described/);
  });

  test('Bluesky: the person\'s own post about someone else\'s dispute is low, not an adverse matter of theirs', () => {
    const subject = createSubject({ name: 'Jane Roe', company: 'Acme Robotics' });
    expect(ownPostSeverity(subject, 'Good news: the lawsuit against our customer was dismissed today.')).toBe('low');
    const { severityFromText } = require('../../../src/server/founder/finding');
    const ours = ['We were charged with securities fraud by the SEC.', 'Acme Robotics was charged with fraud by the SEC.'];
    for (const post of ours) {
      expect(['medium', 'high']).toContain(severityFromText(post, subject));
      expect(ownPostSeverity(subject, post)).toBe(severityFromText(post, subject));
    }
  });
});

/* ------------------------------------------------------------ GitHub */

const ghUser = (over = {}) => ({ login: 'tmilton', type: 'User', name: 'Trevor Milton', company: 'Nikola', blog: 'https://trevormilton.example.org', location: 'Phoenix, Arizona', bio: 'Founder', twitter_username: 'nikolatrevor', public_repos: 0, followers: 0, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', ...over });

describe('GitHub', () => {
  test('a new, empty account claiming the name and company is "likely" at most and its links are not followed', async () => {
    network([
      ['search/users', { total_count: 1, items: [{ login: 'tmilton', type: 'User' }] }],
      ['/users/tmilton/orgs', []],
      ['/users/tmilton/repos', []],
      ['/users/tmilton', ghUser()],
    ]);
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const r = await githubConnector.run(task('subject', 'Trevor Milton'), ctxFor(subject));
    expect(r.findings[0]).toMatchObject({ match: 'likely', matchFixed: true });
    expect(r.findings[0].matchReasons.join(' ')).toMatch(/self-described/);
    expect(r.threads).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/new and shows no public work/);
  });

  test('membership of the company\'s organisation lets an account be followed; organisations, repositories, languages and city are kept', async () => {
    const calls = network([
      ['search/users', { total_count: 1, items: [{ login: 'tmilton', type: 'User' }] }],
      ['/users/tmilton/orgs', [{ login: 'nikola' }]],
      ['/users/tmilton/repos', [{ name: 'truck', language: 'Rust', stargazers_count: 12, fork: false, pushed_at: '2026-10-01T00:00:00Z' }, { name: 'forked', language: 'C', stargazers_count: 99, fork: true }]],
      ['/users/tmilton', ghUser()],
    ]);
    process.env.GITHUB_TOKEN = 'test-token-not-real';
    const subject = createSubject({ name: 'Trevor Milton', company: 'Nikola' });
    const r = await githubConnector.run(task('subject', 'Trevor Milton'), ctxFor(subject));
    const f = r.findings[0];
    expect(f.data).toMatchObject({ orgs: ['nikola'], languages: ['Rust'], city: 'Phoenix' });
    expect(f.data.topRepos).toEqual([{ name: 'truck', language: 'Rust', stars: 12, pushedAt: '2026-10-01', description: null }]);
    expect(r.threads.map((t) => t.kind)).toEqual(expect.arrayContaining(['handle']));
    expect(calls.headers.Authorization).toBe('Bearer test-token-not-real');
  });

  test('cityOf keeps the city only', () => {
    expect(cityOf('Berlin, Germany')).toBe('Berlin');
    expect(cityOf('221B Baker Street, London')).toBe('');
    expect(cityOf('')).toBe('');
  });
});
