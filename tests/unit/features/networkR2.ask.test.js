/**
 * Network Map, round 2: the question engine speaks the page's vocabulary
 * (spec eval/network/design-2026-11-21/SPEC.md, section 6). Role questions
 * count the same people as the role chips; the engine knows the file's tags,
 * the map's industry labels, the file's cities and connection dates. All
 * people are invented (tests/fixtures/network).
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(), queryOne: jest.fn(), persistenceMode: jest.fn(() => 'pglite'), PersistenceUnavailableError: class extends Error {},
}));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null) }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [], fundingRounds: [] })) }));
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn(async () => null) }));

const fs = require('fs');
const path = require('path');
const { chatComplete } = require('../../../src/server/llm/providers');
const { parseLinkedInConnectionsCsv, parseGenericCsv, dedupeKey } = require('../../../src/utils/network/parseContacts');
const { classifyContact, FAMILIES } = require('../../../src/utils/network/roles');
const { industryOf, tagsOf, cityOf } = require('../../../src/utils/network/grouping');
const { seniority } = require('../../../src/utils/network/atlas');
const { profileNetwork } = require('../../../src/utils/network/insights');
const {
  parseQuestionRules, parseQuestion, scoreContacts, answerQuestion, vocabularyOf, understoodOf, ROLE_GROUPS,
} = require('../../../src/server/network/query');

const DIR = path.resolve(__dirname, '../../fixtures/network');
const load = (file) => {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const r = file.includes('linkedin') ? parseLinkedInConnectionsCsv(text) : parseGenericCsv(text);
  return r.contacts || r;
};
const FILES = ['vc-investor-linkedin.csv', 'founder-operator-linkedin.csv', 'sales-crm.csv', 'healthcare-academic.csv', 'lp-fundraising-list.csv', 'small-network-linkedin.csv'];
const S = Object.fromEntries(FILES.map((f) => [f, load(f)]));
const TODAY = '2026-11-21';
const ALL = { limit: Infinity, today: TODAY };

/** Ask with the rules only, as the page does, with the clock fixed. */
const ask = (file, question) => answerQuestion(S[file], { question, useLlm: false, today: TODAY });
/** Every person a question returns (no 100-row cap), as dedupe keys. */
const keysFor = (file, question) => {
  const list = S[file];
  const filters = parseQuestionRules(question, { vocab: vocabularyOf(list), today: TODAY, knownLocations: new Set(list.map((c) => c.location).filter(Boolean)) });
  return new Set(scoreContacts(list, filters, ALL).results.map((r) => r.contact.key));
};
const keysOf = (people) => new Set(people.map((c) => dedupeKey(c)));
const sorted = (set) => [...set].sort();

beforeEach(() => chatComplete.mockClear());

// ------------------------------------------------------------ roles = chips

describe('role questions count the same people as the role chips', () => {
  test.each(FILES)('"Which investors do I know?" on %s is exactly the investors family', async (file) => {
    const investors = S[file].filter((c) => classifyContact(c).family === 'investors');
    const out = await ask(file, 'Which investors do I know?');
    expect(out.parsedBy).toBe('rules');
    expect(out.total).toBe(investors.length);
    expect(sorted(keysFor(file, 'Which investors do I know?'))).toEqual(sorted(keysOf(investors)));
    // Where the chip shows, the answer is the chip.
    const p = profileNetwork(S[file], { today: TODAY });
    const chip = [...p.shortcuts, ...p.more].find((s) => s.id === 'role:investors');
    if (chip) expect(out.total).toBe(chip.count);
  });

  test('the investors counts are the read-out\'s numbers', async () => {
    expect((await ask('vc-investor-linkedin.csv', 'Which investors do I know?')).total).toBe(112);
    expect((await ask('lp-fundraising-list.csv', 'Which investors do I know?')).total).toBe(114);
    expect((await ask('small-network-linkedin.csv', 'Which investors do I know?')).total).toBe(7);
    // The CRM's "partner" tag no longer makes retail buyers investors.
    const crm = await ask('sales-crm.csv', 'Which investors do I know?');
    expect(crm.total).toBe(0);
    expect(crm.results).toEqual([]);
  });

  test('"Which {family} do I know?" counts every family on every sample file', () => {
    for (const file of FILES) {
      for (const fam of FAMILIES) {
        const want = keysOf(S[file].filter((c) => classifyContact(c).family === fam.key));
        const got = keysFor(file, `Which ${fam.many} do I know?`);
        expect([file, fam.key, sorted(got)]).toEqual([file, fam.key, sorted(want)]);
      }
    }
  });

  test('every role chip typed back as a question lists the chip\'s people', () => {
    for (const file of FILES) {
      const p = profileNetwork(S[file], { today: TODAY });
      for (const chip of [...p.shortcuts, ...p.more].filter((s) => s.type === 'role')) {
        const people = S[file].filter((c) => classifyContact(c).family === chip.id.slice('role:'.length));
        expect([file, chip.label, keysFor(file, `Which ${chip.short} do I know?`).size]).toEqual([file, chip.label, chip.count]);
        expect(sorted(keysFor(file, `Which ${chip.short} do I know?`))).toEqual(sorted(keysOf(people)));
      }
    }
  });

  test('chip phrases are read as one family, not as several roles', () => {
    expect(parseQuestionRules('Which sales and marketing people do I know?').roles).toEqual(['sales and marketing people']);
    expect(parseQuestionRules('Which founders and CEOs do I know?').roles).toEqual(['founders and CEOs']);
    expect(parseQuestionRules('Which product and design people do I know?').roles).toEqual(['product and design people']);
    expect(parseQuestionRules('Which researchers and academics do I know?').roles).toEqual(['researchers and academics']);
    // The narrower words still work, inside the family.
    expect(parseQuestionRules('software engineers at Stripe').roles).toEqual(['software engineers']);
    expect(parseQuestionRules('data engineers').roles).toEqual(['engineers']);
  });

  test('narrow role words stay inside the chip\'s family', () => {
    const file = 'vc-investor-linkedin.csv';
    const engineers = keysOf(S[file].filter((c) => classifyContact(c).family === 'engineers'));
    for (const k of keysFor(file, 'software engineers')) expect(engineers.has(k)).toBe(true);
    const product = keysOf(S[file].filter((c) => classifyContact(c).family === 'product'));
    for (const k of keysFor(file, 'designers')) expect(product.has(k)).toBe(true);
    for (const k of keysFor(file, 'product managers')) expect(product.has(k)).toBe(true);
  });

  test('"senior leaders" counts the senior leaders chip', () => {
    const file = 'vc-investor-linkedin.csv';
    const p = profileNetwork(S[file], { today: TODAY });
    const chip = [...p.shortcuts, ...p.more].find((s) => s.id === 'senior');
    expect(chip.count).toBe(201);
    expect(keysFor(file, 'Which senior leaders do I know?').size).toBe(201);
    expect(sorted(keysFor(file, 'senior leaders'))).toEqual(sorted(keysOf(S[file].filter((c) => seniority(c) === 0))));
  });

  test('role reasons say why in plain words', async () => {
    const out = await ask('vc-investor-linkedin.csv', 'Which investors do I know?');
    expect(out.results[0].reasons[0]).toMatch(/^Investor \((title ".+"|from their employer.*)\)$/);
  });

  test('a file with nobody of a family returns nobody', async () => {
    const out = await ask('healthcare-academic.csv', 'Which bankers do I know?');
    expect(out.total).toBe(0);
    expect(out.results).toEqual([]);
  });
});

// ------------------------------------------------------------ tags

describe('tags from the file', () => {
  const crm = 'sales-crm.csv';
  const tagged = (file, tag) => S[file].filter((c) => tagsOf(c).includes(tag));

  test('"prospects in New York" is the tag and the city together', async () => {
    const out = await ask(crm, 'prospects in New York');
    expect(out.filters).toMatchObject({ tags: ['prospect'], locations: ['New York'], roles: [], keywords: [] });
    const want = tagged(crm, 'prospect').filter((c) => cityOf(c) === 'New York');
    expect(want.length).toBeGreaterThan(0);
    expect(out.total).toBe(want.length);
    expect(sorted(keysFor(crm, 'prospects in New York'))).toEqual(sorted(keysOf(want)));
    expect(out.results[0].reasons).toEqual(expect.arrayContaining(['Tagged “prospect”', expect.stringMatching(/^Located in New York/)]));
    expect(out.understood).toEqual(['Tagged “prospect”', 'In New York']);
  });

  test('tag counts are the tag chips', async () => {
    expect((await ask(crm, 'Who are my prospects?')).total).toBe(107);
    expect((await ask(crm, 'customers')).total).toBe(73);
    expect((await ask(crm, 'Which decision makers do I know?')).total).toBe(62);
    expect((await ask(crm, 'champions at Marlowe Department Stores')).filters).toMatchObject({ tags: ['champion'], companies: ['Marlowe Department Stores'] });
    expect((await ask('lp-fundraising-list.csv', 'everyone tagged committed')).total).toBe(20);
    expect((await ask('lp-fundraising-list.csv', 'who is tagged "met 2026"')).total).toBe(23);
    expect((await ask('lp-fundraising-list.csv', 'who should I follow up with?')).total).toBe(15);
  });

  test('on a CRM, "partners" is the tag, not a job', async () => {
    const out = await ask(crm, 'Which partners do I know?');
    expect(out.filters.tags).toEqual(['partner']);
    expect(out.total).toBe(69);
  });

  test('tags that are not in the file return nobody, with a note', async () => {
    const none = await ask(crm, 'everyone tagged unicorn');
    expect(none.filters.tags).toEqual(['unicorn']);
    expect(none.total).toBe(0);
    expect(none.notes.join(' ')).toMatch(/Nobody in your network is tagged “unicorn”/);
    const linkedin = await ask('vc-investor-linkedin.csv', 'everyone tagged prospect');
    expect(linkedin.total).toBe(0);
    expect(linkedin.notes.join(' ')).toMatch(/no(ne of your contacts have)? tags/i);
    // Without the tag in the file, "prospects" is not a tag.
    expect(parseQuestionRules('prospects in New York', { vocab: vocabularyOf(S['vc-investor-linkedin.csv']) }).tags).toEqual([]);
  });
});

// ------------------------------------------------------------ industries

describe('the map\'s industry labels', () => {
  test('the industry chip typed back as a question lists the chip\'s people', () => {
    for (const file of FILES) {
      const p = profileNetwork(S[file], { today: TODAY });
      for (const chip of [...p.shortcuts, ...p.more].filter((s) => s.type === 'industry')) {
        const label = chip.id.slice('industry:'.length);
        const want = keysOf(S[file].filter((c) => industryOf(c) === label));
        const got = keysFor(file, `Who do I know ${chip.short}?`);
        expect([file, chip.label, sorted(got)]).toEqual([file, chip.label, sorted(want)]);
      }
    }
  });

  test('Big Tech, Software and Healthcare by the map\'s own labels', async () => {
    expect((await ask('founder-operator-linkedin.csv', 'Who do I know in Big Tech?')).total).toBe(124);
    const sw = await ask('vc-investor-linkedin.csv', 'people in software');
    expect(sw.filters).toMatchObject({ industries: ['Software'], keywords: [], locations: [] });
    expect(sw.total).toBe(66);
    // The audit's case: the map showed Healthcare, the engine found no founders there.
    const crm = S['sales-crm.csv'];
    const want = crm.filter((c) => industryOf(c) === 'Healthcare' && classifyContact(c).family === 'founders');
    const out = await ask('sales-crm.csv', 'Healthcare founders');
    expect(out.filters).toMatchObject({ industries: ['Healthcare'], roles: ['founders'], keywords: [] });
    expect(out.total).toBe(want.length);
    const healthcare = crm.filter((c) => industryOf(c) === 'Healthcare');
    expect(healthcare.length).toBeGreaterThan(50);
    expect((await ask('sales-crm.csv', 'Who do I know in healthcare?')).total).toBe(healthcare.length);
  });

  test('"&" may be typed as "and"; labels the file does not have stay out', () => {
    const vocab = { industries: ['Climate & energy'] };
    expect(parseQuestionRules('founders in climate and energy', { vocab }).industries).toEqual(['Climate & energy']);
    expect(parseQuestionRules('who works in Big Tech', { vocab: vocabularyOf(S['healthcare-academic.csv']) }).industries).toEqual([]);
  });
});

// ------------------------------------------------------------ cities

describe('cities found in the file', () => {
  test('the place chip typed back as a question lists the chip\'s people', () => {
    for (const file of FILES) {
      const p = profileNetwork(S[file], { today: TODAY });
      for (const chip of [...p.shortcuts, ...p.more].filter((s) => s.type === 'place')) {
        expect([file, chip.label, keysFor(file, `Who do I know ${chip.short}?`).size]).toEqual([file, chip.label, chip.count]);
      }
    }
  });

  test('Seattle, Austin, New York and Toronto', async () => {
    expect((await ask('lp-fundraising-list.csv', 'Who do I know in Seattle?')).total).toBe(14);
    expect((await ask('healthcare-academic.csv', 'Who do I know in Austin?')).total).toBe(27);
    expect((await ask('sales-crm.csv', 'Who do I know in New York?')).total).toBe(63);
    expect((await ask('sales-crm.csv', 'who do I know in toronto')).total).toBe(58);
    // A country still matches the location text.
    expect((await ask('sales-crm.csv', 'Who do I know in Canada?')).total).toBe(58);
  });

  test('a city nobody is in returns nobody', async () => {
    const out = await ask('sales-crm.csv', 'Who do I know in Lisbon?');
    expect(out.total).toBe(0);
    const li = await ask('vc-investor-linkedin.csv', 'Who do I know in Seattle?');
    expect(li.total).toBe(0);
    expect(li.notes.join(' ')).toMatch(/location/);
  });
});

// ------------------------------------------------------------ dates

describe('when people were connected', () => {
  const vc = 'vc-investor-linkedin.csv';
  const inYear = (file, y) => S[file].filter((c) => String(c.connectedOn || '').startsWith(String(y)));

  test('"this year", "in 2024", "last year", "since 2025", "before 2014"', async () => {
    const thisYear = await ask(vc, 'people I connected with this year');
    expect(thisYear.filters.connected).toMatchObject({ kind: 'range', from: '2026-01-01', to: '2026-12-31', label: 'in 2026' });
    // The calendar year: the sample has dates after today's date too.
    expect(thisYear.total).toBe(inYear(vc, 2026).length);
    expect(thisYear.total).toBeGreaterThan(0);
    expect(thisYear.understood).toEqual(['Connected in 2026']);
    expect((await ask(vc, 'Who did I connect with in 2024?')).total).toBe(inYear(vc, 2024).length);
    expect((await ask(vc, 'connections from last year')).total).toBe(inYear(vc, 2025).length);
    expect((await ask(vc, 'people since 2025')).total).toBe(inYear(vc, 2025).length + inYear(vc, 2026).length);
    const early = S[vc].filter((c) => c.connectedOn && c.connectedOn < '2014-01-01').length;
    expect((await ask(vc, 'people I connected with before 2014')).total).toBe(early);
    // Newest first when only a date is asked.
    const days = thisYear.results.map((r) => r.contact.connectedOn);
    expect(days).toEqual([...days].sort().reverse());
    expect(thisYear.results[0].reasons).toEqual([expect.stringMatching(/^Connected [A-Z][a-z]{2} 2026$/)]);
  });

  test('"in the last 12 months" and "recently" are the recent chip', async () => {
    for (const file of FILES) {
      const p = profileNetwork(S[file], { today: TODAY });
      const chip = [...p.shortcuts, ...p.more].find((s) => s.id === 'recent');
      if (!chip) continue;
      expect([file, keysFor(file, 'Who did I connect with in the last 12 months?').size]).toEqual([file, chip.count]);
      expect(sorted(keysFor(file, 'recently'))).toEqual(sorted(chip.keys.map((id) => id.replace(/^p:/, ''))));
    }
    expect((await ask(vc, 'in the last 12 months')).total).toBe(79);
    expect((await ask(vc, 'people I met in the past year')).total).toBe(79);
  });

  test('an old export counts back from its newest date, and says so', async () => {
    const out = await ask('small-network-linkedin.csv', 'who did I connect with recently?');
    expect(out.total).toBe(7);
    expect(out.notes.join(' ')).toMatch(/newest connection is from [A-Z][a-z]{2} 20\d\d/);
  });

  test('dates combine with roles and companies', async () => {
    const want = S[vc].filter((c) => classifyContact(c).family === 'investors' && String(c.connectedOn).startsWith('2026'));
    expect((await ask(vc, 'investors I connected with this year')).total).toBe(want.length);
  });

  test('dates that match nobody, and files without dates', async () => {
    expect((await ask(vc, 'people I connected with in 1995')).total).toBe(0);
    const hc = await ask('healthcare-academic.csv', 'people I connected with this year');
    expect(hc.total).toBe(0);
    expect(hc.notes.join(' ')).toMatch(/connection date/);
  });
});

// ------------------------------------------------------------ the rest holds

describe('what stays the same', () => {
  test('every example question on the at-a-glance card returns its own count', async () => {
    for (const file of FILES) {
      const p = profileNetwork(S[file], { today: TODAY });
      for (const q of p.questions) {
        const out = await ask(file, q.text);
        expect([file, q.text, out.total]).toEqual([file, q.text, q.count]);
      }
    }
  });

  test('company and intro-path questions keep their shape', async () => {
    const out = await ask('vc-investor-linkedin.csv', 'Who do I know at Stripe?');
    expect(out.intent).toBe('who-at');
    expect(out.total).toBe(22);
    expect(out.possiblyRelated).toBeDefined();
    const intro = await ask('vc-investor-linkedin.csv', 'Intro paths to Stripe');
    expect(intro.intent).toBe('intro-path');
    expect(intro.intro.target).toBe('Stripe');
    expect(intro.total).toBe(22);
  });

  test('lens words in typed questions still work', async () => {
    const out = await ask('vc-investor-linkedin.csv', 'Who can help me raise a fund?');
    expect(out.filters.lens).toBe('raise');
    expect(out.total).toBeGreaterThan(0);
    // An empty answer says whom it looked for, never the old preset names.
    const none = await answerQuestion([{ name: 'Ana', position: 'Software Engineer', company: 'Globex' }], { question: 'Who can help me raise a fund?', useLlm: false });
    expect(none.total).toBe(0);
    expect(none.notes.join(' ')).toMatch(/Nobody in your network looks like an investor/);
    expect(none.notes.join(' ')).not.toMatch(/\b(Raise|Source|Diligence)\b/);
  });

  test('the model is asked only when the rules find nothing, and gets only the question', async () => {
    for (const q of ['prospects in New York', 'everyone tagged committed', 'people I connected with this year', 'Who do I know in Big Tech?', 'Which sales and marketing people do I know?']) {
      const file = q.includes('prospects') ? 'sales-crm.csv' : q.includes('committed') ? 'lp-fundraising-list.csv' : 'founder-operator-linkedin.csv';
      await answerQuestion(S[file], { question: q, today: TODAY });
    }
    expect(chatComplete).not.toHaveBeenCalled();
    chatComplete.mockResolvedValueOnce({ text: '{"roles":["recruiters"],"intent":"role"}' });
    const out = await parseQuestion('who hires people like me', { vocab: vocabularyOf(S['sales-crm.csv']) });
    expect(out.parsedBy).toBe('llm');
    const sent = JSON.stringify(chatComplete.mock.calls[0][0]);
    expect(sent).toContain('who hires people like me');
    for (const c of S['sales-crm.csv'].slice(0, 20)) expect(sent).not.toContain(c.name);
    expect(sent).not.toMatch(/prospect|champion|Marlowe/);
  });

  test('every role group the rules can name counts somebody or nobody without error', () => {
    for (const g of ROLE_GROUPS) expect(() => scoreContacts(S['vc-investor-linkedin.csv'], { roles: [g.label] })).not.toThrow();
    expect(understoodOf({ companies: ['Stripe'], roles: ['investors'], tags: [], industries: [], locations: [], keywords: [], connected: null })).toEqual(['At Stripe', 'Investors']);
  });
});

// ------------------------------------------------------------ the route

describe('POST /api/network/query', () => {
  const route = require('../../../src/pages/api/network/query').default;
  const res = () => {
    const r = { statusCode: 200, headers: {}, body: null };
    r.status = (code) => { r.statusCode = code; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    return r;
  };

  test('signed out, the file\'s own tags, cities and families answer', async () => {
    const contacts = S['sales-crm.csv'].map((c) => ({ key: dedupeKey(c), name: c.name, company: c.company, position: c.position, location: c.location, profileUrl: c.profileUrl, connectedOn: c.connectedOn, source: c.source, tags: c.tags }));
    const r = res();
    await route({ method: 'POST', headers: {}, body: { question: 'prospects in New York', llm: false, contacts } }, r);
    expect(r.statusCode).toBe(200);
    expect(r.body.contactsFrom).toBe('request');
    expect(r.body.filters.tags).toEqual(['prospect']);
    expect(r.body.total).toBe(S['sales-crm.csv'].filter((c) => tagsOf(c).includes('prospect') && cityOf(c) === 'New York').length);
    expect(r.body.understood).toEqual(['Tagged “prospect”', 'In New York']);
    const r2 = res();
    await route({ method: 'POST', headers: {}, body: { question: 'Which sales and marketing people do I know?', llm: false, contacts } }, r2);
    expect(r2.body.total).toBe(S['sales-crm.csv'].filter((c) => classifyContact(c).family === 'sales').length);
    expect(chatComplete).not.toHaveBeenCalled();
  });
});
