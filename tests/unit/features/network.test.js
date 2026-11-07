/**
 * Network Map: contact parsing (LinkedIn Connections.csv, generic CSV, X
 * following), dedupe and company normalisation, question parsing, scoring,
 * intro paths, the contacts store (mocked query()) and API auth.
 * All data here is synthetic.
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  persistenceMode: jest.fn(() => 'pglite'),
  PersistenceUnavailableError: class PersistenceUnavailableError extends Error {},
}));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null) }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn() }));
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn(async () => null) }));

const db = require('../../../src/server/db');
const { chatComplete } = require('../../../src/server/llm/providers');
const { buildCompanyProfile } = require('../../../src/server/companyProfile');
const {
  parseCsv, parseLinkedInConnectionsCsv, parseGenericCsv, parseXFollowing, rowsToContacts, isLinkedInConnectionsCsv,
  normalizeCompanyKey, companyMatch, dedupeContacts, dedupeKey, normalizeContact, parseDate, cleanProfileUrl,
} = require('../../../src/utils/network/parseContacts');
const {
  parseQuestionRules, parseQuestion, scoreContacts, introPaths, investorsFromProfile, answerQuestion, validateFilters,
} = require('../../../src/server/network/query');
const store = require('../../../src/server/network/store');
const { buildGraph } = require('../../../src/utils/network/graph');

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

const LINKEDIN_CSV = '﻿Notes:\r\n'
  + '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"\r\n'
  + '\r\n'
  + 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\r\n'
  + 'Ada,Testperson,https://www.linkedin.com/in/ada-testperson,,"Stripe, Inc.","Engineer, Payments",05 Nov 2026\r\n'
  + 'Bo,Samplename,https://www.linkedin.com/in/bo-samplename,bo@example.com,Acme Ventures,"Partner ""Seed""",12 Jan 2024\r\n'
  + 'Cy,Multiline,https://www.linkedin.com/in/cy-multiline,,Globex LLC,"Head of\nProduct",01 Feb 2020\r\n'
  + ',,,,,,\r\n';

describe('parseCsv', () => {
  test('handles quotes, escaped quotes, commas and newlines inside quotes, BOM and CRLF', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2']]);
  });

  test('detects semicolon and tab delimiters', () => {
    expect(parseCsv('Name;Company\nAda;Stripe')).toEqual([['Name', 'Company'], ['Ada', 'Stripe']]);
    expect(parseCsv('Name\tCompany\nAda\tStripe')).toEqual([['Name', 'Company'], ['Ada', 'Stripe']]);
  });
});

describe('LinkedIn Connections.csv', () => {
  test('skips the Notes lines and parses quoted commas', () => {
    expect(isLinkedInConnectionsCsv(LINKEDIN_CSV)).toBe(true);
    const { contacts, headerFound } = parseLinkedInConnectionsCsv(LINKEDIN_CSV);
    expect(headerFound).toBe(true);
    expect(contacts).toHaveLength(3);
    expect(contacts[0]).toEqual({
      name: 'Ada Testperson',
      firstName: 'Ada',
      lastName: 'Testperson',
      company: 'Stripe, Inc.',
      position: 'Engineer, Payments',
      email: '',
      profileUrl: 'https://www.linkedin.com/in/ada-testperson',
      location: '',
      connectedOn: '2026-11-05',
      source: 'linkedin',
      tags: [],
    });
    expect(contacts[1].position).toBe('Partner "Seed"');
    expect(contacts[1].email).toBe('bo@example.com');
    expect(contacts[2].position).toBe('Head of Product'); // whitespace collapsed
    expect(contacts[2].connectedOn).toBe('2020-02-01');
  });

  test('a file without the header is reported, not guessed', () => {
    const r = parseLinkedInConnectionsCsv('Notes:\nsomething else entirely\n');
    expect(r.headerFound).toBe(false);
    expect(r.contacts).toEqual([]);
  });
});

describe('generic CSV / spreadsheet rows', () => {
  test('maps common headers', () => {
    const csv = 'Full Name,Organization,Job Title,E-mail,LinkedIn URL,City,Country,Tags,Notes\n'
      + 'Dee Example,Initech Corp,VP Sales,DEE@EXAMPLE.COM,linkedin.com/in/dee-example,Austin,USA,"vip; fintech",met at demo day\n';
    const { contacts } = parseGenericCsv(csv);
    expect(contacts).toEqual([{
      name: 'Dee Example',
      firstName: '',
      lastName: '',
      company: 'Initech Corp',
      position: 'VP Sales',
      email: 'dee@example.com',
      profileUrl: 'https://linkedin.com/in/dee-example',
      location: 'Austin, USA',
      connectedOn: null,
      source: 'csv',
      tags: ['vip', 'fintech', 'met at demo day'],
    }]);
  });

  test('first/last columns and spreadsheet rows (as from xlsx sheet_to_json header:1)', () => {
    const rows = [['Contacts export'], ['First', 'Surname', 'Employer', 'Role'], ['Eve', 'Sample', 'Hooli', 'CTO']];
    const { contacts } = rowsToContacts(rows);
    expect(contacts[0]).toMatchObject({ name: 'Eve Sample', company: 'Hooli', position: 'CTO', source: 'csv' });
  });

  test('rejects unsafe profile URLs and invalid emails', () => {
    expect(cleanProfileUrl('javascript:alert(1)')).toBe('');
    expect(cleanProfileUrl('https://x.com/someone')).toBe('https://x.com/someone');
    const c = normalizeContact({ name: 'Z', email: 'not-an-email', profileUrl: 'data:text/html,hi' }, 'csv');
    expect(c.email).toBe('');
    expect(c.profileUrl).toBe('');
  });

  test('parses common date formats', () => {
    expect(parseDate('05 Nov 2026')).toBe('2026-11-05');
    expect(parseDate('2024-03-09')).toBe('2024-03-09');
    expect(parseDate('11/05/2026')).toBe('2026-11-05');
    expect(parseDate('Nov 5, 2026')).toBe('2026-11-05');
    expect(parseDate('31 Feb 2026')).toBeNull();
    expect(parseDate('soon')).toBeNull();
  });
});

describe('X following JSON', () => {
  test('maps X API users', () => {
    const { contacts } = parseXFollowing({ data: [{ id: '1', name: 'Fay Sample', username: 'faysample', description: 'Founder at Widgetly', location: 'London' }] });
    expect(contacts[0]).toMatchObject({
      name: 'Fay Sample', position: 'Founder at Widgetly', location: 'London', profileUrl: 'https://x.com/faysample', source: 'x', tags: ['@faysample'],
    });
  });
});

describe('dedupe and company normalisation', () => {
  test('normalizes company names for grouping', () => {
    expect(normalizeCompanyKey('Stripe, Inc.')).toBe('stripe');
    expect(normalizeCompanyKey('STRIPE')).toBe('stripe');
    expect(normalizeCompanyKey('The Goldman Sachs Group, Inc.')).toBe('goldman sachs group');
    expect(normalizeCompanyKey('Johnson & Johnson')).toBe('johnson and johnson');
    expect(normalizeCompanyKey('Acme Holdings Ltd.')).toBe('acme holdings');
    expect(normalizeCompanyKey('Globex L.L.C.')).toBe('globex');
    expect(normalizeCompanyKey('Société Générale SA')).toBe('societe generale');
    expect(normalizeCompanyKey('')).toBe('');
  });

  test('companyMatch: exact, or whole-word containment for multi-word names only', () => {
    expect(companyMatch('stripe', 'stripe')).toBe('exact');
    expect(companyMatch('goldman sachs asset management', 'goldman sachs')).toBe('contains');
    expect(companyMatch('goldman sachs', 'goldman sachs asset management')).toBe('within');
    expect(companyMatch('meta financial', 'meta')).toBeNull();
    expect(companyMatch('goldman sachsy', 'goldman sachs')).toBeNull();
  });

  test('dedupes by profile URL, then email, then name + company', () => {
    const list = [
      normalizeContact({ name: 'A One', profileUrl: 'https://www.linkedin.com/in/a-one/', company: '' }, 'linkedin'),
      normalizeContact({ name: 'A One', profileUrl: 'http://linkedin.com/in/a-one', company: 'Stripe' }, 'csv'),
      normalizeContact({ name: 'B Two', email: 'b@example.com' }, 'csv'),
      normalizeContact({ name: 'B. Two', email: 'B@Example.com', position: 'CEO' }, 'csv'),
      normalizeContact({ name: 'C Three', company: 'Stripe, Inc.' }, 'csv'),
      normalizeContact({ name: 'c three', company: 'Stripe' }, 'csv'),
      normalizeContact({ name: 'C Three', company: 'Globex' }, 'csv'),
    ];
    const out = dedupeContacts(list);
    expect(out).toHaveLength(4);
    expect(out[0].company).toBe('Stripe'); // missing field filled from the duplicate
    expect(out[1].position).toBe('CEO');
    expect(dedupeKey(list[0])).toBe(dedupeKey(list[1]));
  });
});

// ------------------------------------------------------------ question parsing

describe('parseQuestionRules', () => {
  test.each([
    ['Who do I know at Google?', { companies: ['Google'], intent: 'who-at' }],
    ['Who do I know that works at Google?', { companies: ['Google'], intent: 'who-at' }],
    ['people at Goldman Sachs', { companies: ['Goldman Sachs'], intent: 'who-at' }],
    ['Find software engineers in my network', { companies: [], roles: ['software engineers'], intent: 'role' }],
    ['Intro paths to Stripe', { companies: ['Stripe'], intent: 'intro-path' }],
    ['Can I get a warm intro to OpenAI?', { companies: ['OpenAI'], intent: 'intro-path' }],
    ['Who can introduce me to Acme Robotics?', { companies: ['Acme Robotics'], intent: 'intro-path' }],
    ['Find people in healthcare industry', { keywords: ['healthcare'], intent: 'general' }],
    ['Show me connections who might know about marketing', { roles: ['marketing'], intent: 'role' }],
    ['Who should I connect with for job opportunities in AI?', { keywords: ['ai'], locations: [], intent: 'general' }],
    ['founders in fintech', { roles: ['founders'], keywords: ['fintech'], intent: 'role' }],
    ['engineers at Stripe in London', { companies: ['Stripe'], roles: ['engineers'], locations: ['London'], intent: 'who-at' }],
    ['product managers based in SF', { roles: ['product managers'], locations: ['SF'] }],
  ])('%s', (q, expected) => {
    expect(parseQuestionRules(q)).toMatchObject(expected);
  });

  test('unrecognised questions fall back to keywords', () => {
    expect(parseQuestionRules('kubernetes')).toMatchObject({ keywords: ['kubernetes'], intent: 'general' });
  });

  test('uses the LLM only when rules find nothing specific, with only the question text', async () => {
    chatComplete.mockResolvedValueOnce({ text: '```json\n{"companies":[],"roles":["recruiters"],"keywords":[],"locations":[],"intent":"role"}\n```' });
    const out = await parseQuestion('who hires people like me');
    expect(out).toEqual({ parsedBy: 'llm', filters: { companies: [], roles: ['recruiters'], keywords: [], locations: [], intent: 'role' } });
    const sent = JSON.stringify(chatComplete.mock.calls[0][0]);
    expect(sent).toContain('who hires people like me');

    chatComplete.mockClear();
    await parseQuestion('Who do I know at Stripe?');
    expect(chatComplete).not.toHaveBeenCalled();
  });

  test('invalid LLM JSON falls back to rules', async () => {
    chatComplete.mockResolvedValueOnce({ text: 'sorry, I cannot help' });
    const out = await parseQuestion('who hires people like me');
    expect(out.parsedBy).toBe('rules');
    expect(validateFilters({ intent: 'intro-path' })).toBeNull();
    expect(validateFilters({ companies: ['X'], intent: 'bogus' }).intent).toBe('who-at');
  });
});

// ------------------------------------------------------------ scoring

const C = (name, company, position, extra = {}) => normalizeContact({ name, company, position, ...extra }, extra.source || 'linkedin');
const NETWORK = [
  C('Ana Exact', 'Stripe, Inc.', 'Software Engineer', { connectedOn: '2025-01-01' }),
  C('Ben Exact', 'Stripe', 'Account Executive', { connectedOn: '2026-01-01' }),
  C('Cal Related', 'Stripe Payments Europe', 'Product Manager'),
  C('Dan Former', 'Acme', 'Advisor, ex-Stripe'),
  C('Eli Other', 'Globex', 'Software Engineer', { location: 'London, UK' }),
  C('Fin Investor', 'Sequoia Capital', 'Partner'),
  C('Gus Investor', 'Benchmark', 'General Partner'),
  C('Hal Bank', 'First Fintech Bank', 'Founder & CEO'),
];

describe('scoreContacts', () => {
  test('company match ranks exact > related > title mention, with reasons', () => {
    const { results, total } = scoreContacts(NETWORK, { companies: ['Stripe'] });
    expect(total).toBe(4);
    expect(results.map((r) => r.contact.name)).toEqual(['Ben Exact', 'Ana Exact', 'Cal Related', 'Dan Former']);
    expect(results[0].score).toBe(100);
    expect(results[0].reasons[0]).toBe('Works at Stripe');
    expect(results[2].reasons[0]).toMatch(/looks related to Stripe/);
    expect(results[3].reasons[0]).toMatch(/Title mentions Stripe/);
  });

  test('roles and company combine with AND', () => {
    const { results } = scoreContacts(NETWORK, { companies: ['Stripe'], roles: ['software engineers'] });
    expect(results.map((r) => r.contact.name)).toEqual(['Ana Exact']);
    expect(results[0].reasons).toEqual(['Works at Stripe, Inc.', 'Title "Software Engineer" matches software engineers']);
  });

  test('role, keyword and location filters', () => {
    expect(scoreContacts(NETWORK, { roles: ['software engineers'] }).results.map((r) => r.contact.name).sort()).toEqual(['Ana Exact', 'Eli Other']);
    expect(scoreContacts(NETWORK, { roles: ['investors'] }).results.map((r) => r.contact.name).sort()).toEqual(['Fin Investor', 'Gus Investor']);
    // "Stripe Payments Europe" mentions payments, "First Fintech Bank" mentions fintech
    expect(scoreContacts(NETWORK, { keywords: ['fintech'] }).results.map((r) => r.contact.name).sort()).toEqual(['Cal Related', 'Hal Bank']);
    expect(scoreContacts(NETWORK, { roles: ['engineers'], locations: ['London'] }).results.map((r) => r.contact.name)).toEqual(['Eli Other']);
  });

  test('explains when location data is missing', () => {
    const out = scoreContacts([C('X', 'Y', 'Engineer')], { locations: ['Paris'] });
    expect(out.results).toEqual([]);
    expect(out.notes[0]).toMatch(/location/);
  });
});

describe('intro paths', () => {
  beforeEach(() => buildCompanyProfile.mockReset());

  test('groups direct contacts and contacts at investors', async () => {
    buildCompanyProfile.mockResolvedValue({
      investors: [{ name: 'Sequoia Capital', evidence: 'led round' }, { name: 'Nobody Ventures', evidence: 'participated' }],
      fundingRounds: [{ round: 'Series B', leadInvestors: ['Benchmark', 'Sequoia Capital'] }],
    });
    const out = await introPaths(NETWORK, 'Stripe');
    expect(buildCompanyProfile).toHaveBeenCalledWith('Stripe');
    expect(out.direct.map((r) => r.contact.name)).toEqual(['Ben Exact', 'Ana Exact', 'Cal Related', 'Dan Former']);
    expect(out.viaInvestors.map((g) => [g.investor, g.contacts.map((r) => r.contact.name)])).toEqual([
      ['Sequoia Capital', ['Fin Investor']],
      ['Benchmark', ['Gus Investor']],
    ]);
    expect(out.viaInvestors[1].evidence).toBe('led Series B');
    expect(out.investorsChecked).toEqual(['Sequoia Capital', 'Nobody Ventures', 'Benchmark']);
    expect(out.viaPastEmployees).toEqual([]);
  });

  test('profile failure still returns direct contacts', async () => {
    buildCompanyProfile.mockRejectedValue(new Error('offline'));
    const out = await introPaths(NETWORK, 'Stripe');
    expect(out.direct).toHaveLength(4);
    expect(out.viaInvestors).toEqual([]);
    expect(out.profileStatus).toBe('unavailable');
  });

  test('investorsFromProfile dedupes by normalised name', () => {
    expect(investorsFromProfile({ investors: [{ name: 'Sequoia Capital' }], fundingRounds: [{ leadInvestors: ['Sequoia Capital LLC'] }] }))
      .toHaveLength(1);
  });

  test('answerQuestion routes intro questions', async () => {
    buildCompanyProfile.mockResolvedValue({ investors: [], fundingRounds: [] });
    const out = await answerQuestion(NETWORK, { question: 'Intro paths to Stripe' });
    expect(out.intent).toBe('intro-path');
    expect(out.intro.target).toBe('Stripe');
    expect(out.results).toHaveLength(4);
  });
});

describe('buildGraph', () => {
  test('company nodes sized by contacts; large networks show companies only until expanded', () => {
    const small = buildGraph(NETWORK);
    expect(small.nodes.filter((n) => n.type === 'person')).toHaveLength(NETWORK.length);
    const stripe = small.nodes.find((n) => n.type === 'company' && n.key === 'stripe');
    expect(stripe.count).toBe(2);

    const big = buildGraph(NETWORK, { maxPeople: 3 });
    expect(big.large).toBe(true);
    expect(big.nodes.filter((n) => n.type === 'person')).toHaveLength(0);
    const expanded = buildGraph(NETWORK, { maxPeople: 3, expanded: new Set(['stripe']) });
    expect(expanded.nodes.filter((n) => n.type === 'person')).toHaveLength(2);
  });
});

// ------------------------------------------------------------ store

describe('network store (mocked query)', () => {
  beforeEach(() => {
    db.query.mockReset();
    db.persistenceMode.mockReturnValue('pglite');
    store.__resetForTests();
  });

  test('replaceContacts deletes the source then inserts parameterized multi-row batches of 500', async () => {
    db.query.mockImplementation(async (sql, params) => {
      if (/^INSERT/.test(sql.trim())) return new Array(params.length / 14).fill({ id: 'x' });
      if (/COUNT/.test(sql)) return [{ n: 0 }];
      return [];
    });
    const contacts = Array.from({ length: 1200 }, (_, i) => ({ name: `Person ${i}`, company: 'Stripe, Inc.', connectedOn: '05 Nov 2026' }));
    const out = await store.replaceContacts('user-1', 'linkedin', contacts);
    expect(out).toEqual({ saved: 1200, duplicates: 0, truncated: 0 });

    const calls = db.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(calls.filter((c) => c.startsWith('CREATE'))).toHaveLength(2);
    const del = db.query.mock.calls.find(([sql]) => sql.startsWith('DELETE'));
    expect(del[1]).toEqual(['user-1', 'linkedin']);
    const inserts = db.query.mock.calls.filter(([sql]) => sql.trim().startsWith('INSERT'));
    expect(inserts.map(([, p]) => p.length / 14)).toEqual([500, 500, 200]);
    const [sql, params] = inserts[0];
    expect(sql).toMatch(/ON CONFLICT \(user_id, dedupe_key\) DO NOTHING/);
    expect(sql).not.toMatch(/Person 0/); // values are parameters, never inlined
    expect(params.slice(0, 14)).toEqual([
      'user-1', 'linkedin', 'Person 0', null, null, 'Stripe, Inc.', 'stripe', null, null, null, null, '2026-11-05', '[]', 'n:person 0|stripe',
    ]);
  });

  test('replaceContacts caps the total at 30,000 per user', async () => {
    db.query.mockImplementation(async (sql, params) => {
      if (/^INSERT/.test(sql.trim())) return new Array(params.length / 14).fill({ id: 'x' });
      if (/COUNT/.test(sql)) return [{ n: 29990 }];
      return [];
    });
    const out = await store.replaceContacts('user-1', 'csv', Array.from({ length: 25 }, (_, i) => ({ name: `P${i}` })));
    expect(out).toEqual({ saved: 10, duplicates: 0, truncated: 15 });
  });

  test('listContacts maps rows; deleteAllContacts and countContacts', async () => {
    db.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id, source')) {
        return [{ id: 'u1', source: 'linkedin', name: 'Ana', first_name: 'Ana', last_name: null, company: 'Stripe', position: 'Eng', email: null, profile_url: 'https://www.linkedin.com/in/ana', location: null, connected_on: new Date('2026-11-05T00:00:00Z'), tags: '["a"]' }];
      }
      if (sql.startsWith('DELETE')) return [{ id: 1 }, { id: 2 }];
      if (sql.includes('COUNT(*)::int AS n FROM network_contacts WHERE user_id = $1') && !sql.includes('GROUP')) return [{ n: 7 }];
      return [];
    });
    const list = await store.listContacts('user-1');
    expect(list[0]).toEqual({
      id: 'u1', name: 'Ana', firstName: 'Ana', lastName: '', company: 'Stripe', position: 'Eng', email: '',
      profileUrl: 'https://www.linkedin.com/in/ana', location: '', connectedOn: '2026-11-05', source: 'linkedin', tags: ['a'],
    });
    expect(await store.deleteAllContacts('user-1')).toBe(2);
    expect(await store.countContacts('user-1')).toBe(7);
  });

  test('findContactsAtCompanies matches normalised keys and reports the matched input', async () => {
    db.query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM network_contacts') && sql.includes('ANY')) {
        expect(params[1]).toEqual(['stripe', 'goldman sachs']);
        expect(params[2]).toEqual(['%goldman sachs%']);
        return [
          { name: 'Ana', company: 'Stripe, Inc.', company_key: 'stripe', position: 'Eng', profile_url: null, connected_on: '2026-11-05', source: 'linkedin' },
          { name: 'Gil', company: 'Goldman Sachs Asset Management', company_key: 'goldman sachs asset management', position: 'VP', profile_url: 'https://www.linkedin.com/in/gil', connected_on: null, source: 'csv' },
          { name: 'Noise', company: 'Stripes Co', company_key: 'stripes', position: '', profile_url: null, connected_on: null, source: 'csv' },
        ];
      }
      return [];
    });
    const out = await store.findContactsAtCompanies('user-1', ['Stripe, Inc.', 'Goldman Sachs', 'stripe']);
    expect(out).toEqual([
      { name: 'Ana', company: 'Stripe, Inc.', position: 'Eng', profileUrl: '', connectedOn: '2026-11-05', source: 'linkedin', matchedCompany: 'Stripe, Inc.' },
      { name: 'Gil', company: 'Goldman Sachs Asset Management', position: 'VP', profileUrl: 'https://www.linkedin.com/in/gil', connectedOn: null, source: 'csv', matchedCompany: 'Goldman Sachs' },
    ]);
  });

  test('findContactsAtCompanies returns [] without a user, without persistence, or on errors', async () => {
    expect(await store.findContactsAtCompanies(null, ['Stripe'])).toEqual([]);
    db.persistenceMode.mockReturnValue('none');
    expect(await store.findContactsAtCompanies('user-1', ['Stripe'])).toEqual([]);
    db.persistenceMode.mockReturnValue('pglite');
    db.query.mockRejectedValue(new Error('db down'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await store.findContactsAtCompanies('user-1', ['Stripe'])).toEqual([]);
    console.warn.mockRestore();
    expect(db.query).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ API

describe('API auth and validation', () => {
  const contactsRoute = require('../../../src/pages/api/network/contacts').default;
  const queryRoute = require('../../../src/pages/api/network/query').default;

  beforeEach(() => {
    db.query.mockReset();
    store.__resetForTests();
  });

  test.each(['GET', 'POST', 'DELETE'])('%s /api/network/contacts is 401 when signed out', async (method) => {
    const res = mockRes();
    await contactsRoute({ method, query: {}, body: { source: 'linkedin', contacts: [] }, headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('unsupported method is 405', async () => {
    const res = mockRes();
    await contactsRoute({ method: 'PUT', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  test('signed-out query searches only the contacts sent with the request and never stores them', async () => {
    const res = mockRes();
    await queryRoute({
      method: 'POST',
      headers: {},
      body: { question: 'Who do I know at Stripe?', contacts: [{ name: 'Ana', company: 'Stripe', source: 'csv' }, { name: 'Bo', company: 'Globex', source: 'csv' }] },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.contactsFrom).toBe('request');
    expect(res.body.filters.companies).toEqual(['Stripe']);
    expect(res.body.results.map((r) => r.contact.name)).toEqual(['Ana']);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('query requires a question', async () => {
    const res = mockRes();
    await queryRoute({ method: 'POST', headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(400);
  });
});
