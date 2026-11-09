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

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../../../src/server/db');
const { chatComplete } = require('../../../src/server/llm/providers');
const { buildCompanyProfile } = require('../../../src/server/companyProfile');
const {
  parseCsv, parseLinkedInConnectionsCsv, parseGenericCsv, parseXFollowing, rowsToContacts, isLinkedInConnectionsCsv,
  normalizeCompanyKey, companyMatch, dedupeContacts, dedupeKey, normalizeContact, parseDate, cleanProfileUrl,
  parseContactsFile, detectDayFirst, MAX_CONTACTS,
} = require('../../../src/utils/network/parseContacts');
const {
  parseQuestionRules, parseQuestion, scoreContacts, introPaths, investorsFromProfile, answerQuestion, validateFilters,
  splitByCompanyMatch,
} = require('../../../src/server/network/query');
const store = require('../../../src/server/network/store');
const { buildGraph, MAX_PEOPLE_PER_EXPANDED_COMPANY } = require('../../../src/utils/network/graph');

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURES = '/private/tmp/claude-501/-Users-bivekadhikari--claude-spares-spare-uhSlqD/b8fe7f3b-1789-4754-bbb1-344a380b0722/scratchpad/fixtures';
/** A browser File stand-in for parseContactsFile. */
const fileLike = (name, content) => {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return { name, size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), text: async () => buf.toString('utf8') };
};

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
      relationship: 'direct',
      via: '',
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

  test('the LinkedIn upload button refuses a generic contacts CSV instead of saving it as LinkedIn data', async () => {
    const generic = 'Name,Organisation,Job Title,City\nDee Example,Initech Corp,VP Sales,Austin\n';
    const asLinkedIn = await parseContactsFile(fileLike('contacts.csv', generic), { kind: 'linkedin' });
    expect(asLinkedIn.headerFound).toBe(false);
    expect(asLinkedIn.reason).toBe('not-linkedin');
    expect(asLinkedIn.contacts).toEqual([]);
    // X JSON through the LinkedIn button is refused the same way
    const json = await parseContactsFile(fileLike('following.json', '{"data":[{"name":"F","username":"f"}]}'), { kind: 'linkedin' });
    expect(json.reason).toBe('not-linkedin');
    // the same file through the generic button imports as csv
    const auto = await parseContactsFile(fileLike('contacts.csv', generic), { kind: 'auto' });
    expect(auto.source).toBe('csv');
    expect(auto.contacts).toHaveLength(1);
    // a real export still imports as linkedin through either button
    for (const kind of ['linkedin', 'auto']) {
      const li = await parseContactsFile(fileLike('Connections.csv', LINKEDIN_CSV), { kind });
      expect(li.source).toBe('linkedin');
      expect(li.contacts).toHaveLength(3);
    }
  });

  test('parsers report in-file duplicates and the number dropped at the 30,000 limit', () => {
    const header = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n';
    const rows = Array.from({ length: MAX_CONTACTS + 5 }, (_, i) => `P${i},X,https://www.linkedin.com/in/p${i},,Co,,05 Nov 2026`);
    const out = parseLinkedInConnectionsCsv(header + rows.concat(rows.slice(0, 3)).join('\n'));
    expect(out.contacts).toHaveLength(MAX_CONTACTS);
    expect(out.duplicates).toBe(3);
    expect(out.truncated).toBe(5);
    const x = parseXFollowing({ data: Array.from({ length: 4 }, (_, i) => ({ name: `U${i % 2}`, username: `u${i % 2}` })) });
    expect(x).toMatchObject({ duplicates: 2, truncated: 0 });
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
      relationship: 'direct',
      via: '',
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

  test('slash dates: day-first when the first number is over 12, or when the file says so', () => {
    expect(parseDate('25/12/2026')).toBe('2026-12-25');
    expect(parseDate('11/05/2026', { dayFirst: true })).toBe('2026-05-11');
    expect(parseDate('13/13/2026')).toBeNull();
    expect(detectDayFirst(['01/02/2026', '25/12/2026'])).toBe(true);
    expect(detectDayFirst(['01/02/2026', '12/25/2026'])).toBe(false);
    // One unambiguous day-first row makes the whole file day-first.
    const csv = 'Name,Company,Connected On\nA,X,01/02/2026\nB,X,25/12/2026\n';
    expect(parseGenericCsv(csv).contacts.map((c) => c.connectedOn)).toEqual(['2026-02-01', '2026-12-25']);
    // Without that evidence the US order stays.
    expect(parseGenericCsv('Name,Company,Connected On\nA,X,01/02/2026\n').contacts[0].connectedOn).toBe('2026-01-02');
  });

  test('XLSX date cells keep their dates', async () => {
    const XLSX = require('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([['Name', 'Company', 'Connected On'], ['Ada', 'Stripe', new Date(2026, 10, 5)], ['Bo', 'Acme', '12 Jan 2024']], { cellDates: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
    const out = await parseContactsFile(fileLike('contacts.xlsx', buf), { kind: 'auto' });
    expect(out.source).toBe('csv');
    expect(out.contacts.map((c) => c.connectedOn)).toEqual(['2026-11-05', '2024-01-12']);
    // the audit fixture, if present
    if (fs.existsSync(path.join(FIXTURES, 'contacts.xlsx'))) {
      const fx = await parseContactsFile(fileLike('contacts.xlsx', fs.readFileSync(path.join(FIXTURES, 'contacts.xlsx'))), { kind: 'auto' });
      expect(fx.headerFound).toBe(true);
      expect(fx.contacts.some((c) => c.connectedOn)).toBe(true);
    }
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

  test('keeps non-Latin company names so they group and can be searched', () => {
    expect(normalizeCompanyKey('Яндекс')).toBe('яндекс');
    expect(normalizeCompanyKey('ЯНДЕКС, ООО')).toBe('яндекс ооо');
    expect(normalizeCompanyKey('株式会社トヨタ')).toBe('株式会社トヨタ');
    expect(normalizeCompanyKey('ガンダム')).toBe('ガンダム'); // dakuten is part of the script, not an accent
    expect(normalizeCompanyKey('Łódź SA')).toBe('łodz');
    const list = [C('Ivan', 'Яндекс', 'Engineer'), C('Olga', 'ЯНДЕКС', 'PM'), C('Ken', '株式会社トヨタ', 'Engineer')];
    const { buildGraph: bg } = require('../../../src/utils/network/graph');
    const companies = bg(list).nodes.filter((n) => n.type === 'company').map((n) => [n.key, n.count]);
    expect(companies).toEqual([['яндекс', 2], ['株式会社トヨタ', 1]]);
    expect(scoreContacts(list, { companies: ['Яндекс'] }).results.map((r) => r.contact.name)).toEqual(['Ivan', 'Olga']);
    expect(parseQuestionRules('Who do I know at 株式会社トヨタ?').companies).toEqual(['株式会社トヨタ']);
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

  test('questions naming several companies search all of them', () => {
    expect(parseQuestionRules('anyone at Stripe or Brex?').companies).toEqual(['Stripe', 'Brex']);
    expect(parseQuestionRules('people at Google, Meta and Apple').companies).toEqual(['Google', 'Meta', 'Apple']);
    expect(parseQuestionRules('engineers at Stripe/Adyen in London')).toMatchObject({ companies: ['Stripe', 'Adyen'], roles: ['engineers'], locations: ['London'] });
    expect(parseQuestionRules('Who do I know at Stripe, Inc.?').companies).toEqual(['Stripe, Inc']);
    const { results } = scoreContacts(NETWORK, { companies: ['Globex', 'Benchmark'] });
    expect(results.map((r) => r.contact.name).sort()).toEqual(['Eli Other', 'Gus Investor']);
  });

  test('lower-case place names count as locations', () => {
    expect(parseQuestionRules('who works in paris')).toMatchObject({ locations: ['Paris'], keywords: [] });
    expect(parseQuestionRules('engineers in new york')).toMatchObject({ roles: ['engineers'], locations: ['new york'] });
    expect(parseQuestionRules('people in fintech').locations).toEqual([]);
    expect(parseQuestionRules('investors in my network').locations).toEqual([]);
    // With the contacts' locations known, only real places are accepted.
    expect(parseQuestionRules('who works in paris', { knownLocations: new Set(['Paris, France']) }).locations).toEqual(['Paris']);
    expect(parseQuestionRules('who works in tech', { knownLocations: new Set(['Paris, France']) })).toMatchObject({ locations: [], keywords: ['tech'] });
  });

  test('uses the LLM only when rules find nothing specific, with only the question text', async () => {
    chatComplete.mockResolvedValueOnce({ text: '```json\n{"companies":[],"roles":["recruiters"],"keywords":[],"locations":[],"intent":"role"}\n```' });
    const out = await parseQuestion('who hires people like me');
    expect(out).toEqual({ parsedBy: 'llm', filters: { companies: [], roles: ['recruiters'], keywords: [], locations: [], intent: 'role', lens: null } });
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
    expect(out.direct.map((r) => r.contact.name)).toEqual(['Ben Exact', 'Ana Exact']);
    expect(out.possiblyRelated.map((r) => r.contact.name)).toEqual(['Cal Related', 'Dan Former']);
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
    expect(out.direct).toHaveLength(2);
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
    expect(out.results).toHaveLength(2);
  });

  test('"people at X" lists employees only; similar names and title mentions go under "possibly related"', async () => {
    const out = await answerQuestion(NETWORK, { question: 'Who do I know at Stripe?', useLlm: false });
    expect(out.results.map((r) => r.contact.name)).toEqual(['Ben Exact', 'Ana Exact']);
    expect(out.total).toBe(2);
    expect(out.possiblyRelated.results.map((r) => r.contact.name)).toEqual(['Cal Related', 'Dan Former']);
    expect(out.possiblyRelated.total).toBe(2);
    const scored = scoreContacts(NETWORK, { companies: ['Stripe'] });
    expect(scored.results.map((r) => r.companyMatch)).toEqual(['exact', 'exact', 'related', 'title']);
    expect(splitByCompanyMatch(scored).results).toHaveLength(2);
    // containment still counts as working there
    const gs = scoreContacts([C('Gil', 'Goldman Sachs Asset Management', 'VP')], { companies: ['Goldman Sachs'] });
    expect(splitByCompanyMatch(gs).results).toHaveLength(1);
    // questions without a company are unchanged
    const roles = await answerQuestion(NETWORK, { question: 'investors', useLlm: false });
    expect(roles.possiblyRelated).toBeUndefined();
    expect(roles.total).toBe(2);
  });

  test('lower-case locations are only accepted when some contact is there', async () => {
    const withParis = [C('Eli Other', 'Globex', 'Engineer', { location: 'Paris, France' })];
    const out = await answerQuestion(withParis, { question: 'who works in paris', useLlm: false });
    expect(out.filters.locations).toEqual(['Paris']);
    expect(out.results.map((r) => r.contact.name)).toEqual(['Eli Other']);
    const none = await answerQuestion(NETWORK, { question: 'who works in paris', useLlm: false });
    expect(none.filters.locations).toEqual([]);
  });

  test('signed-out contacts keep the browser\'s identity key so results map back to the graph', () => {
    const c = C('Mia', 'Stripe', 'Engineer');
    const { results } = scoreContacts([{ ...c, key: 'e:mia@example.com' }], { companies: ['Stripe'] });
    expect(results[0].contact.key).toBe('e:mia@example.com');
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

  test('an expanded company in a large network draws at most 150 people and says so', () => {
    const big = Array.from({ length: 400 }, (_, i) => C(`Person ${String(i).padStart(3, '0')}`, 'Megacorp', 'Engineer'));
    const list = [...big, ...NETWORK];
    const g = buildGraph(list, { maxPeople: 100, expanded: new Set(['megacorp']) });
    expect(MAX_PEOPLE_PER_EXPANDED_COMPANY).toBe(150);
    expect(g.nodes.filter((n) => n.type === 'person')).toHaveLength(150);
    const mega = g.nodes.find((n) => n.type === 'company' && n.key === 'megacorp');
    expect(mega).toMatchObject({ count: 400, shownPeople: 150, hiddenPeople: 250 });
    expect(g.cappedCompanies).toEqual([{ key: 'megacorp', label: 'Megacorp', shown: 150, hidden: 250 }]);
    expect(g.peopleShown).toBe(150);
    // small networks are never capped
    expect(buildGraph(list, { maxPeople: 10000 }).nodes.filter((n) => n.type === 'person')).toHaveLength(list.length);
    expect(buildGraph(list, { maxPeople: 10000 }).cappedCompanies).toEqual([]);
  });
});

// ------------------------------------------------------------ store

describe('network store (mocked query)', () => {
  beforeEach(() => {
    db.query.mockReset();
    db.persistenceMode.mockReturnValue('pglite');
    store.__resetForTests();
  });

  const mockStore = ({ others = 0 } = {}) => db.query.mockImplementation(async (sql, params) => {
    const text = sql.trim();
    if (/^INSERT/.test(text)) return new Array(params.length / 16).fill({ id: 'x' });
    if (/^WITH removed/.test(text)) return [{ saved: 0, duplicates: 0, contacts: [] }];
    if (/COUNT/.test(text)) return [{ n: others }];
    return [];
  });

  test('replaceContacts stages parameterized batches of 500 and swaps them in with one statement, never deleting first', async () => {
    mockStore();
    const contacts = Array.from({ length: 1200 }, (_, i) => ({ name: `Person ${i}`, company: 'Stripe, Inc.', connectedOn: '05 Nov 2026' }));
    const out = await store.replaceContacts('user-1', 'linkedin', contacts);
    expect(out).toEqual({ saved: 0, duplicates: 0, truncated: 0, contacts: [] });

    const calls = db.query.mock.calls.map(([sql]) => sql.trim());
    expect(calls.filter((c) => c.startsWith('CREATE'))).toHaveLength(2);
    // The only DELETE before the inserts purges leftovers of a crashed import, not the user's data.
    const firstInsert = calls.findIndex((c) => c.startsWith('INSERT'));
    const deletesBefore = calls.slice(0, firstInsert).filter((c) => c.startsWith('DELETE'));
    expect(deletesBefore).toHaveLength(1);
    expect(deletesBefore[0]).toMatch(/dedupe_key LIKE 'staged:%'/);
    expect(deletesBefore[0]).not.toMatch(/source/);
    const inserts = db.query.mock.calls.filter(([sql]) => sql.trim().startsWith('INSERT'));
    expect(inserts.map(([, p]) => p.length / 16)).toEqual([500, 500, 200]);
    const [sql, params] = inserts[0];
    expect(sql).toMatch(/ON CONFLICT \(user_id, dedupe_key\) DO NOTHING/);
    expect(sql).not.toMatch(/Person 0/); // values are parameters, never inlined
    expect(params.slice(0, 13)).toEqual([
      'user-1', 'linkedin', 'Person 0', null, null, 'Stripe, Inc.', 'stripe', null, null, null, null, '2026-11-05', '[]', 'direct', null,
    ]);
    expect(params[15]).toMatch(/^staged:[0-9a-f]{16}:n:person 0\|stripe$/);
    // The swap: delete old rows of the source, drop cross-source duplicates, activate the rest, all in one statement.
    const swap = calls[calls.length - 1];
    expect(swap).toMatch(/^WITH removed AS \(\s*DELETE FROM network_contacts WHERE user_id = \$1 AND source = \$2/);
    expect(swap).toMatch(/activated AS \(\s*UPDATE network_contacts/);
    expect(swap).toMatch(/SELECT COUNT\(\*\) FROM removed/);
    expect(db.query.mock.calls[db.query.mock.calls.length - 1][1]).toEqual(['user-1', 'linkedin', `${params[13].slice(0, 24)}%`, 24]);
  });

  test('replaceContacts caps the total at 30,000 per user', async () => {
    mockStore({ others: 29990 });
    const out = await store.replaceContacts('user-1', 'csv', Array.from({ length: 25 }, (_, i) => ({ name: `P${i}` })));
    expect(out).toMatchObject({ truncated: 15 });
    const inserts = db.query.mock.calls.filter(([sql]) => sql.trim().startsWith('INSERT'));
    expect(inserts[0][1].length / 16).toBe(10);
  });

  test('a failed batch cleans up its staged rows and rethrows', async () => {
    mockStore();
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (sql.trim().startsWith('INSERT')) throw new Error('connection lost');
      return base(sql, params);
    });
    await expect(store.replaceContacts('user-1', 'csv', [{ name: 'A' }])).rejects.toThrow('connection lost');
    const calls = db.query.mock.calls.map(([sql]) => sql.trim());
    expect(calls.some((c) => c.startsWith('WITH removed'))).toBe(false);
    const cleanup = db.query.mock.calls.filter(([sql]) => sql.trim().startsWith('DELETE') && /LIKE \$2/.test(sql));
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0][1][1]).toMatch(/^staged:[0-9a-f]{16}:%$/);
  });

  test('compactContact drops empty fields, id and split names', () => {
    expect(store.compactContact({
      id: 'x', name: 'Ana', firstName: 'Ana', lastName: '', company: 'Stripe', position: '', email: '', profileUrl: 'https://www.linkedin.com/in/ana',
      location: '', connectedOn: '2026-11-05', source: 'linkedin', tags: [],
    })).toEqual({ name: 'Ana', source: 'linkedin', company: 'Stripe', profileUrl: 'https://www.linkedin.com/in/ana', connectedOn: '2026-11-05' });
    expect(store.compactContact({ name: 'B', source: 'csv', email: 'b@x.io', tags: ['vip'] })).toEqual({ name: 'B', source: 'csv', email: 'b@x.io', tags: ['vip'] });
  });

  test('listContacts maps rows; deleteAllContacts and countContacts', async () => {
    db.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id, source')) {
        expect(sql).toMatch(/dedupe_key NOT LIKE 'staged:%'/); // rows of an import in progress are never read
        return [{ id: 'u1', source: 'linkedin', name: 'Ana', first_name: 'Ana', last_name: null, company: 'Stripe', position: 'Eng', email: null, profile_url: 'https://www.linkedin.com/in/ana', location: null, connected_on: new Date('2026-11-05T00:00:00Z'), tags: '["a"]' }];
      }
      if (sql.startsWith('DELETE')) return [{ id: 1 }, { id: 2 }];
      if (sql.includes('COUNT(*)::int AS n FROM network_contacts WHERE user_id = $1') && !sql.includes('GROUP')) return [{ n: 7 }];
      return [];
    });
    const list = await store.listContacts('user-1');
    expect(list[0]).toEqual({
      id: 'u1', name: 'Ana', firstName: 'Ana', lastName: '', company: 'Stripe', position: 'Eng', email: '',
      profileUrl: 'https://www.linkedin.com/in/ana', location: '', connectedOn: '2026-11-05', source: 'linkedin', tags: ['a'], relationship: 'direct', via: '',
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
      { name: 'Ana', company: 'Stripe, Inc.', position: 'Eng', profileUrl: '', connectedOn: '2026-11-05', source: 'linkedin', relationship: 'direct', via: '', matchedCompany: 'Stripe, Inc.' },
      { name: 'Gil', company: 'Goldman Sachs Asset Management', position: 'VP', profileUrl: 'https://www.linkedin.com/in/gil', connectedOn: null, source: 'csv', relationship: 'direct', via: '', matchedCompany: 'Goldman Sachs' },
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

// A real embedded Postgres (PGlite) through db.__setClientForTests. PGlite
// cannot start inside Jest's sandbox (it needs dynamic import), so the
// scenario runs in a child Node process that loads the real store through
// Babel, and reports back as JSON.
describe('network store (real PGlite)', () => {
  const runInNode = (body) => {
    const script = `
      const Module = require('module');
      const fs = require('fs');
      const babel = require('@babel/core');
      const ROOT = ${JSON.stringify(ROOT)};
      const origJs = Module._extensions['.js'];
      Module._extensions['.js'] = function (mod, filename) {
        if (!filename.startsWith(ROOT + '/src/')) return origJs(mod, filename);
        const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), { filename, babelrc: false, configFile: false, presets: [['@babel/preset-env', { targets: { node: 'current' } }]] });
        mod._compile(code, filename);
      };
      (async () => {
        const { PGlite } = require('@electric-sql/pglite');
        const pg = new PGlite(); await pg.waitReady;
        const db = require(ROOT + '/src/server/db');
        const base = { query: async (t, p = []) => (await pg.query(t, p)).rows, exec: async (t) => { await pg.exec(t); } };
        db.__setClientForTests(base);
        await db.query("INSERT INTO users (id) VALUES ('u1')");
        const store = require(ROOT + '/src/server/network/store');
        const out = {};
        ${body}
        process.stdout.write('@@' + JSON.stringify(out));
        await pg.close();
      })().catch((e) => { console.error(e); process.exit(1); });
    `;
    const stdout = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    return JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2));
  };

  test('a batch failure mid-import leaves the previous import untouched; a re-run then succeeds', () => {
    const out = runInNode(`
      out.first = await store.replaceContacts('u1', 'linkedin', [
        { name: 'A', company: 'Stripe', profileUrl: 'https://linkedin.com/in/a' }, { name: 'B', company: 'Яндекс' },
      ]);
      // same person already saved from linkedin: kept there, counted as duplicate
      out.csv = await store.replaceContacts('u1', 'csv', [
        { name: 'A', profileUrl: 'https://www.linkedin.com/in/a/' }, { name: 'C', company: 'Globex', email: 'c@x.io' },
      ]);
      let n = 0;
      db.__setClientForTests({ ...base, query: async (t, p) => { if (/^\\s*INSERT/.test(t)) { n += 1; if (n === 2) throw new Error('boom'); } return base.query(t, p); } });
      const many = Array.from({ length: 600 }, (_, i) => ({ name: 'P' + i, company: 'Stripe' }));
      try { await store.replaceContacts('u1', 'linkedin', many); out.failed = null; } catch (e) { out.failed = e.message; }
      db.__setClientForTests(base);
      out.afterFailure = (await store.listContacts('u1')).map((c) => c.name + ':' + c.source);
      out.staged = (await pg.query("SELECT COUNT(*)::int AS n FROM network_contacts WHERE dedupe_key LIKE 'staged:%'")).rows[0].n;
      out.stats = await store.contactStats('u1');
      const again = await store.replaceContacts('u1', 'linkedin', many);
      out.again = { saved: again.saved, duplicates: again.duplicates, returned: again.contacts.length, first: again.contacts[0] };
      out.count = await store.countContacts('u1');
      out.keyed = await store.findContactsAtCompanies('u1', ['Globex']);
      out.nonLatinKey = (await pg.query("SELECT company_key FROM network_contacts WHERE name = 'B'")).rows;
    `);
    expect(out.first).toMatchObject({ saved: 2, duplicates: 0, truncated: 0 });
    expect(out.first.contacts).toEqual([
      { name: 'A', source: 'linkedin', company: 'Stripe', profileUrl: 'https://linkedin.com/in/a' },
      { name: 'B', source: 'linkedin', company: 'Яндекс' },
    ]);
    expect(out.csv).toMatchObject({ saved: 1, duplicates: 1 });
    expect(out.failed).toBe('boom');
    expect(out.afterFailure).toEqual(['A:linkedin', 'B:linkedin', 'C:csv']);
    expect(out.staged).toBe(0);
    expect(out.stats.bySource).toEqual({ linkedin: 2, csv: 1, x: 0, attio: 0 });
    expect(out.again).toMatchObject({ saved: 600, duplicates: 0, returned: 600, first: { name: 'P0', source: 'linkedin', company: 'Stripe' } });
    expect(out.count).toBe(601);
    expect(out.keyed.map((c) => c.name)).toEqual(['C']);
    expect(out.nonLatinKey).toEqual([]); // B was replaced by the re-import
  });

  test('non-Latin company names get a company_key in the store', () => {
    const out = runInNode(`
      await store.replaceContacts('u1', 'csv', [{ name: 'Ivan', company: 'Яндекс' }, { name: 'Ken', company: '株式会社トヨタ' }]);
      out.keys = (await pg.query("SELECT name, company_key FROM network_contacts ORDER BY name")).rows;
      out.found = (await store.findContactsAtCompanies('u1', ['яндекс'])).map((c) => c.name);
    `);
    expect(out.keys).toEqual([{ name: 'Ivan', company_key: 'яндекс' }, { name: 'Ken', company_key: '株式会社トヨタ' }]);
    expect(out.found).toEqual(['Ivan']);
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

  test('query route allows up to 60s and keeps the browser\'s contact key', async () => {
    expect(require('../../../src/pages/api/network/query').config.maxDuration).toBe(60);
    const res = mockRes();
    await queryRoute({
      method: 'POST', headers: {},
      body: { question: 'Who do I know at Stripe?', llm: false, contacts: [{ key: 'e:ana@example.com', name: 'Ana', company: 'Stripe', source: 'csv' }, { key: 'nonsense', name: 'Bo', company: 'Stripe', source: 'csv' }] },
    }, res);
    expect(res.body.results.map((r) => r.contact.key)).toEqual(['e:ana@example.com', 'n:bo|stripe']);
  });

  test('GET /api/network/contacts returns the compact shape', async () => {
    const { getServerSession } = require('next-auth/next');
    getServerSession.mockResolvedValueOnce({ user: { id: 'user-1', email: 'u@example.com' } });
    db.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id, source')) {
        return [{ id: 'u1', source: 'linkedin', name: 'Ana', first_name: 'Ana', last_name: null, company: 'Stripe', position: null, email: null, profile_url: null, location: null, connected_on: null, tags: '[]' }];
      }
      return [];
    });
    const res = mockRes();
    await contactsRoute({ method: 'GET', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.contacts).toEqual([{ name: 'Ana', source: 'linkedin', company: 'Stripe' }]);
  });

  test('OAuth start routes redirect with an error code, not developer copy, when unconfigured', () => {
    const saved = { li: process.env.LINKEDIN_CLIENT_ID, ls: process.env.LINKEDIN_CLIENT_SECRET, tw: process.env.TWITTER_CLIENT_ID };
    delete process.env.LINKEDIN_CLIENT_ID; delete process.env.LINKEDIN_CLIENT_SECRET; delete process.env.TWITTER_CLIENT_ID;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const li = require('../../../src/pages/api/auth/linkedin/index').default;
      const tw = require('../../../src/pages/api/auth/twitter/index').default;
      for (const [handler, code] of [[li, 'linkedin_not_configured'], [tw, 'twitter_not_configured']]) {
        const res = mockRes();
        res.redirect = (url) => { res.redirected = url; return res; };
        handler({ method: 'GET', headers: { host: 'localhost:3007' }, query: {} }, res);
        expect(res.redirected).toBe(`/network?error=${code}`);
      }
    } finally {
      console.error.mockRestore();
      if (saved.li) process.env.LINKEDIN_CLIENT_ID = saved.li;
      if (saved.ls) process.env.LINKEDIN_CLIENT_SECRET = saved.ls;
      if (saved.tw) process.env.TWITTER_CLIENT_ID = saved.tw;
    }
  });

  test('token status routes report whether sign-in is configured', async () => {
    const saved = { li: process.env.LINKEDIN_CLIENT_ID, ls: process.env.LINKEDIN_CLIENT_SECRET, tw: process.env.TWITTER_CLIENT_ID };
    delete process.env.LINKEDIN_CLIENT_ID; delete process.env.LINKEDIN_CLIENT_SECRET; delete process.env.TWITTER_CLIENT_ID;
    try {
      const li = require('../../../src/pages/api/auth/linkedin/token').default;
      const tw = require('../../../src/pages/api/auth/twitter/token').default;
      let res = mockRes();
      await li({ method: 'GET', cookies: {}, headers: {} }, res);
      expect(res.body).toEqual({ isAuthenticated: false, configured: false });
      res = mockRes();
      await tw({ method: 'GET', headers: { 'x-forwarded-for': '10.0.0.9' }, connection: {} }, res);
      expect(res.body).toMatchObject({ authenticated: false, configured: false });
      process.env.LINKEDIN_CLIENT_ID = 'id'; process.env.LINKEDIN_CLIENT_SECRET = 'secret';
      res = mockRes();
      await li({ method: 'GET', cookies: {}, headers: {} }, res);
      expect(res.body).toEqual({ isAuthenticated: false, configured: true });
    } finally {
      delete process.env.LINKEDIN_CLIENT_ID; delete process.env.LINKEDIN_CLIENT_SECRET;
      if (saved.li) process.env.LINKEDIN_CLIENT_ID = saved.li;
      if (saved.ls) process.env.LINKEDIN_CLIENT_SECRET = saved.ls;
      if (saved.tw) process.env.TWITTER_CLIENT_ID = saved.tw;
    }
  });
});


describe('lenses: raise / source / diligence', () => {
  const { parseQuestionRules, scoreContacts, validateFilters } = require('../../../src/server/network/query');
  const cs = [
    { name: 'Ana LP', position: 'Chief Investment Officer', company: 'Yale Endowment' },
    { name: 'Vic VC', position: 'Partner', company: 'Sequoia Capital' },
    { name: 'Fay Founder', position: 'Founder & CEO', company: 'Fintech Co' },
    { name: 'Eng Eng', position: 'Software Engineer', company: 'Stripe' },
    { name: 'Rep Press', position: 'Reporter', company: 'Forbes' },
  ];

  test('questions map to a lens, with no stray keywords', () => {
    expect(parseQuestionRules('Who can help me raise a fund?')).toMatchObject({ lens: 'raise', intent: 'lens', keywords: [], roles: [] });
    expect(parseQuestionRules('Who sends me deal flow in fintech?')).toMatchObject({ lens: 'source', keywords: ['fintech'] });
    expect(parseQuestionRules('Who can diligence an AI company?')).toMatchObject({ lens: 'diligence', keywords: ['ai'] });
    expect(parseQuestionRules('Who do I know at Stripe?')).toMatchObject({ lens: null, intent: 'who-at' });
    expect(validateFilters({ companies: [], roles: [], keywords: [], locations: [], lens: 'bogus' })).toBeNull();
    expect(validateFilters({ companies: [], roles: [], keywords: [], locations: [], lens: 'raise' })).toMatchObject({ lens: 'raise', intent: 'lens' });
  });

  test('raise: LPs rank above VCs; founders and engineers are excluded', () => {
    const r = scoreContacts(cs, parseQuestionRules('Who can help me raise a fund?'));
    expect(r.results.map((x) => x.contact.name)).toEqual(['Ana LP', 'Vic VC']);
    expect(r.results[0]).toMatchObject({ role: 'lp', roleLabel: 'LP / allocator' });
  });

  test('source with an industry word: founders first, keyword required', () => {
    const r = scoreContacts(cs, parseQuestionRules('Who sends me deal flow in fintech?'));
    expect(r.results.map((x) => x.contact.name)).toEqual(['Fay Founder']);
  });

  test('diligence: experts and operators, LPs excluded', () => {
    const names = scoreContacts(cs, { lens: 'diligence' }).results.map((x) => x.contact.name);
    expect(names).toEqual(expect.arrayContaining(['Fay Founder', 'Eng Eng', 'Rep Press']));
    expect(names).not.toContain('Ana LP');
  });
});
