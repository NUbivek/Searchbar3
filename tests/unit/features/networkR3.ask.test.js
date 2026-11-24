/**
 * Network Map, round 3: the question engine after the independent review
 * (eval/network/review-2026-11-21/findings.json, ask-1 to ask-25, ask-m1,
 * ask-m2, ask-m4, ask-m5, page-m1) and ROUND2.md decisions 9 to 12.
 *
 * Every count here is worked out from the same classifiers the page uses
 * (familyOf, tagsOf, cityOf, the company keys), never pinned, so the tests
 * hold while the classification is being improved. All people are invented
 * (tests/fixtures/network).
 */
jest.mock('../../../src/server/db', () => ({
  query: jest.fn(), queryOne: jest.fn(), persistenceMode: jest.fn(() => 'pglite'), PersistenceUnavailableError: class extends Error {},
}));
jest.mock('../../../src/server/llm/providers', () => ({ chatComplete: jest.fn(async () => null) }));
jest.mock('../../../src/server/companyProfile', () => ({ buildCompanyProfile: jest.fn(async () => ({ investors: [], fundingRounds: [] })) }));
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => null) }));
jest.mock('../../../src/server/network/store', () => ({
  ...jest.requireActual('../../../src/server/network/store'),
  listContacts: jest.fn(async () => []),
}));

const fs = require('fs');
const path = require('path');
const { chatComplete } = require('../../../src/server/llm/providers');
const { getUserId } = require('../../../src/server/auth');
const store = require('../../../src/server/network/store');
const { parseLinkedInConnectionsCsv, parseGenericCsv, dedupeKey } = require('../../../src/utils/network/parseContacts');
const { classifyContact, familyOf, FAMILIES } = require('../../../src/utils/network/roles');
const { tagsOf, cityOf, companyKeyFor } = require('../../../src/utils/network/grouping');
const { seniority } = require('../../../src/utils/network/atlas');
const { profileNetwork } = require('../../../src/utils/network/insights');
const {
  parseQuestionRules, scoreContacts, answerQuestion, vocabularyOf, understoodOf, validateFilters, parseQuestion,
} = require('../../../src/server/network/query');

const DIR = path.resolve(__dirname, '../../fixtures/network');
const load = (file) => {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const r = file.includes('linkedin') ? parseLinkedInConnectionsCsv(text) : parseGenericCsv(text);
  return r.contacts || r;
};
const FILES = ['vc-investor-linkedin.csv', 'founder-operator-linkedin.csv', 'sales-crm.csv', 'healthcare-academic.csv', 'lp-fundraising-list.csv', 'small-network-linkedin.csv'];
const S = Object.fromEntries(FILES.map((f) => [f, load(f)]));
const VC = 'vc-investor-linkedin.csv';
const CRM = 'sales-crm.csv';
const HC = 'healthcare-academic.csv';
const LP = 'lp-fundraising-list.csv';
const SMALL = 'small-network-linkedin.csv';
const TODAY = '2026-11-21';

/** Ask as the page does: rules only unless said otherwise, the clock fixed. */
const ask = (file, question, more = {}) => answerQuestion(S[file], { question, useLlm: false, today: TODAY, ...more });
const keysOf = (people) => new Set(people.map((c) => dedupeKey(c)));
const sorted = (set) => [...set].sort();
const who = (file, test) => S[file].filter(test);
const atCompany = (file, label) => {
  const key = companyKeyFor({ company: label });
  return who(file, (c) => companyKeyFor(c) === key);
};
const nameRe = (re) => (c) => re.test(String(c.position || ''));

beforeEach(() => {
  chatComplete.mockReset();
  chatComplete.mockResolvedValue(null);
  getUserId.mockReset();
  getUserId.mockResolvedValue(null);
  store.listContacts.mockReset();
  store.listContacts.mockResolvedValue([]);
});

// ------------------------------------------------------------ every shortcut typed back

describe('every shortcut label typed as a question lists exactly that shortcut\'s people', () => {
  test.each(FILES)('%s: shortcuts and "More"', async (file) => {
    const p = profileNetwork(S[file], { today: TODAY });
    const all = [...p.shortcuts, ...p.more];
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      const out = await ask(file, s.label);
      const want = s.keys.map((id) => id.replace(/^p:/, ''));
      // The label, the count, and the very people.
      expect([s.label, out.total]).toEqual([s.label, s.count]);
      expect([s.label, sorted(new Set(out.keys))]).toEqual([s.label, sorted(new Set(want))]);
      expect([s.label, out.parsedBy, out.notes.filter((n) => /^Not used/.test(n))]).toEqual([s.label, 'rules', []]);
    }
  });

  test('role questions keep returning exactly the role families familyOf gives', () => {
    for (const file of FILES) {
      for (const fam of FAMILIES) {
        const people = who(file, (c) => familyOf(c).key === fam.key);
        // The family's own words, and its globe title when that is more than one word
        // (a one-word title such as "Finance" is also an industry word).
        for (const words of [fam.many, fam.title].filter((w) => w && (w === fam.many || /\s/.test(w)))) {
          const filters = parseQuestionRules(`Which ${words} do I know?`, { vocab: vocabularyOf(S[file]), today: TODAY });
          const got = scoreContacts(S[file], filters, { limit: Infinity, today: TODAY }).keys;
          expect([file, words, sorted(new Set(got))]).toEqual([file, words, sorted(keysOf(people))]);
        }
      }
    }
  });
});

// ------------------------------------------------------------ R8.9: everyone it found

describe('ask-1: a typed answer returns every match', () => {
  test('keys hold every match, uncapped, while the rows stay capped', async () => {
    const investors = who(VC, (c) => familyOf(c).key === 'investors');
    expect(investors.length).toBeGreaterThan(100);
    const out = await ask(VC, 'Which investors do I know?');
    expect(out.total).toBe(investors.length);
    expect(out.results.length).toBe(100);
    expect(out.keys.length).toBe(investors.length);
    expect(sorted(new Set(out.keys))).toEqual(sorted(keysOf(investors)));
    // Rank order: the capped rows are the first keys.
    expect(out.results.map((r) => r.contact.key)).toEqual(out.keys.slice(0, 100));
    const senior = await ask(VC, 'Which senior leaders do I know?');
    expect(senior.keys.length).toBe(who(VC, (c) => seniority(c) === 0).length);
  });

  test('intro paths count and key everyone at the company, not the first 100', async () => {
    const people = Array.from({ length: 130 }, (_, i) => ({ name: `Person ${i}`, company: 'Acme Robotics', position: 'Engineer', source: 'csv' }));
    const out = await answerQuestion(people, { target: 'Acme Robotics', today: TODAY });
    expect(out.intent).toBe('intro-path');
    expect(out.total).toBe(130);
    expect(out.keys.length).toBe(130);
    expect(out.results.length).toBe(100);
  });
});

// ------------------------------------------------------------ R8.10: nothing from the file reaches a model

describe('the model never sees the file', () => {
  test('ask-2: a lens found by the rules counts as found', async () => {
    chatComplete.mockResolvedValue({ text: '{"roles":["recruiters"]}' });
    // ("warm intro please" reads nothing on this file, which has no "warm" tag: the model may read it.)
    for (const q of ['who can help me raise', 'diligence on Stripe', 'who can help me source deals', 'Who can help with due diligence on fintech?']) {
      const out = await ask(VC, q, { useLlm: true });
      expect([q, out.parsedBy]).toEqual([q, 'rules']);
    }
    expect(chatComplete).not.toHaveBeenCalled();
  });

  const LONG = 'Ontario Teachers Pension Plan Board of Trustees Canada';
  const people = [
    ...Array.from({ length: 10 }, (_, i) => ({ name: `Allocator ${i}`, company: LONG, position: 'Portfolio Manager', source: 'csv' })),
    ...Array.from({ length: 3 }, (_, i) => ({ name: `Band ${i}`, company: 'The Who', position: 'Guitarist', source: 'csv' })),
    ...Array.from({ length: 4 }, (_, i) => ({ name: `Health ${i}`, company: 'Partners In Health', position: 'Program Officer', source: 'csv' })),
    ...Array.from({ length: 17 }, (_, i) => ({ name: `Other ${i}`, company: `Globex ${i}`, position: 'Analyst', source: 'csv' })),
  ];

  test('ask-3 / ask-22: intro paths take the company as data', async () => {
    for (const [target, n] of [[LONG, 10], ['The Who', 3], ['Partners In Health', 4]]) {
      const out = await answerQuestion(people, { target, useLlm: true, today: TODAY });
      expect([target, out.intent, out.parsedBy, out.intro.target, out.total]).toEqual([target, 'intro-path', 'target', target, n]);
    }
    expect(chatComplete).not.toHaveBeenCalled();
  });

  test('ask-m1: any company of the file, however long, is read after at, from, to, of, on', async () => {
    chatComplete.mockResolvedValue({ text: '{"keywords":["x"]}' });
    for (const q of [`Who do I know at ${LONG}?`, `people from ${LONG}`, `Intro paths to ${LONG}`, `the portfolio managers of ${LONG}`, `who knows about ${LONG}`]) {
      const out = await answerQuestion(people, { question: q, useLlm: true, today: TODAY });
      expect([q, out.parsedBy, out.filters.companies]).toEqual([q, 'rules', [LONG]]);
      expect([q, out.total]).toEqual([q, 10]);
    }
    const intro = await answerQuestion(people, { question: 'Intro paths to Partners In Health', useLlm: true, today: TODAY });
    expect([intro.intent, intro.intro.target, intro.total]).toEqual(['intro-path', 'Partners In Health', 4]);
    const band = await answerQuestion(people, { question: 'Who do I know at The Who?', useLlm: true, today: TODAY });
    expect([band.filters.companies, band.total]).toEqual([['The Who'], 3]);
    expect(chatComplete).not.toHaveBeenCalled();
  });

  test('a question the page built (fromPage) never goes to the model', async () => {
    chatComplete.mockResolvedValue({ text: '{"keywords":["x"]}' });
    const out = await answerQuestion(people, { question: 'tell me something interesting please', useLlm: true, fromPage: true, today: TODAY });
    expect(out.parsedBy).toBe('rules');
    expect(chatComplete).not.toHaveBeenCalled();
  });

  test('a typed question that names any company or tag of the file is read by the rules', async () => {
    chatComplete.mockResolvedValue({ text: '{"keywords":["x"]}' });
    for (const file of FILES) {
      const p = profileNetwork(S[file], { today: TODAY });
      for (const s of [...p.shortcuts, ...p.more].filter((x) => x.type === 'company' || x.type === 'tag')) {
        const name = s.short.replace(/^at |^tagged /, '').replace(/[“”]/g, '');
        await ask(file, `tell me about ${name} please`, { useLlm: true });
      }
    }
    expect(chatComplete).not.toHaveBeenCalled();
  });

  test('the model is still asked for a typed question the rules cannot read at all, with only its text', async () => {
    chatComplete.mockResolvedValue({ text: '{"roles":["recruiters"],"tags":["prospect","unicorn"],"connected":{"from":"2024-01-01","to":null}}' });
    const out = await parseQuestion('who hires people like me', { vocab: vocabularyOf(S[CRM]) });
    expect(out.parsedBy).toBe('llm');
    // ask-m5: the model's tags are kept when the file has them; a date range is kept.
    expect(out.filters.tags).toEqual(['prospect']);
    expect(out.filters.keywords).toEqual(['unicorn']);
    expect(out.filters.connected).toMatchObject({ kind: 'range', from: '2024-01-01', to: null });
    const sent = JSON.stringify(chatComplete.mock.calls[0][0]);
    expect(sent).toContain('who hires people like me');
    expect(sent).not.toMatch(/prospect|champion|Marlowe/);
    expect(validateFilters({ tags: ['warm'] }, { vocab: { tags: ['warm'] } }).tags).toEqual(['warm']);
  });
});

// ------------------------------------------------------------ R8.11: negation and "Not used"

describe('ask-4: "not", "except", "outside" leave people out', () => {
  test('companies, roles, tags and places', async () => {
    const google = atCompany(VC, 'Google');
    expect(google.length).toBeGreaterThan(0);
    const notGoogle = await ask(VC, 'not at Google');
    expect(notGoogle.total).toBe(S[VC].length - google.length);
    expect(notGoogle.understood).toEqual(['Not at Google']);

    const investors = who(VC, (c) => familyOf(c).key === 'investors');
    const exceptInv = await ask(VC, 'everyone except investors');
    expect(sorted(new Set(exceptInv.keys))).toEqual(sorted(keysOf(who(VC, (c) => familyOf(c).key !== 'investors'))));
    expect(exceptInv.total).toBe(S[VC].length - investors.length);

    const notChurned = await ask(CRM, 'customers not churned');
    const want = who(CRM, (c) => tagsOf(c).includes('customer') && !tagsOf(c).includes('churned'));
    expect(notChurned.total).toBe(want.length);
    expect(notChurned.total).toBeLessThan(who(CRM, (c) => tagsOf(c).includes('customer')).length);
    expect(notChurned.understood).toEqual(['Tagged “customer”', 'Not tagged “churned”']);

    const notNy = await ask(LP, 'investors not in New York');
    expect(notNy.total).toBe(who(LP, (c) => familyOf(c).key === 'investors' && cityOf(c) !== 'New York').length);
    const outside = await ask(LP, 'investors outside New York');
    expect(outside.total).toBe(notNy.total);
    const excluding = await ask(VC, 'investors excluding Google');
    expect(excluding.total).toBe(investors.filter((c) => companyKeyFor(c) !== companyKeyFor({ company: 'Google' })).length);
  });

  test('a company whose name holds "without" is still the company', async () => {
    const people = [{ name: 'A B', company: 'Doctors Without Borders', position: 'Nurse', source: 'csv' }, { name: 'C D', company: 'Globex', position: 'Nurse', source: 'csv' }];
    const out = await answerQuestion(people, { question: 'Who do I know at Doctors Without Borders?', useLlm: false });
    expect([out.filters.companies, out.total, out.filters.exclude]).toEqual([['Doctors Without Borders'], 1, undefined]);
  });
});

describe('ask-19: words the engine cannot use are named, not dropped', () => {
  test('"Not used: …"', async () => {
    const out = await ask(CRM, 'customers in New York who love golf');
    expect(out.notes[0]).toMatch(/^Not used: “love”, “golf”\.$/);
    expect(out.total).toBe(who(CRM, (c) => tagsOf(c).includes('customer') && cityOf(c) === 'New York').length);
  });

  test('"pension funds in Seattle" is the allocators in Seattle, not all of Seattle', async () => {
    const seattle = who(LP, (c) => cityOf(c) === 'Seattle');
    const out = await ask(LP, 'pension funds in Seattle');
    expect(out.total).toBe(seattle.filter((c) => classifyContact(c).role === 'lp').length);
    expect(out.total).toBeLessThan(seattle.length);
  });

  test('"in New York and Boston" reads both places', async () => {
    const out = await ask(CRM, 'customers in New York and Boston');
    expect(out.filters.locations).toEqual(['New York', 'Boston']);
    expect(out.total).toBe(who(CRM, (c) => tagsOf(c).includes('customer') && ['New York', 'Boston'].includes(cityOf(c))).length);
  });
});

describe('R8.12 / ask-11: tags in one question', () => {
  const has = (t) => (c) => tagsOf(c).includes(t);
  test('AND across kinds and for tags joined by "and"; OR for "or"', async () => {
    const churnedCustomers = await ask(CRM, 'churned customers');
    expect(churnedCustomers.total).toBe(who(CRM, (c) => has('churned')(c) && has('customer')(c)).length);
    expect(churnedCustomers.understood).toEqual(['Tagged “churned” and “customer”']);
    const either = await ask(CRM, 'prospects or customers');
    expect(either.total).toBe(who(CRM, (c) => has('prospect')(c) || has('customer')(c)).length);
    expect(either.understood).toEqual(['Tagged “prospect” or “customer”']);
    const both = await ask(CRM, 'prospects who are decision makers');
    expect(both.total).toBe(who(CRM, (c) => has('prospect')(c) && has('decision maker')(c)).length);
    const ny = await ask(CRM, 'prospects in New York');
    expect(ny.total).toBe(who(CRM, (c) => has('prospect')(c) && cityOf(c) === 'New York').length);
  });
});

// ------------------------------------------------------------ reading companies and places

describe('companies and places', () => {
  test('ask-5: a date after a company is a date', async () => {
    const stripe = atCompany(VC, 'Stripe');
    for (const [q, label] of [['Who do I know at Stripe recently', 'recently'], ['Who do I know at Stripe last year', 'in 2025'], ['Who do I know at Stripe this year?', 'in 2026'], ['Who do I know at Stripe since 2020', 'since 2020']]) {
      const out = await ask(VC, q);
      expect([q, out.filters.companies, out.filters.connected?.label]).toEqual([q, ['Stripe'], label]);
      const range = scoreContacts(stripe, { connected: out.filters.connected }, { limit: Infinity, today: TODAY });
      expect([q, out.total]).toEqual([q, range.total]);
    }
    const eng = await ask(VC, 'engineers at Google connected in 2016');
    expect(eng.filters).toMatchObject({ companies: ['Google'], roles: ['engineers'] });
    expect(eng.total).toBe(atCompany(VC, 'Google').filter((c) => familyOf(c).key === 'engineers' && String(c.connectedOn).startsWith('2016')).length);
  });

  test('ask-6: a city typed alone is the place chip', async () => {
    const p = profileNetwork(S[CRM], { today: TODAY });
    for (const s of [...p.shortcuts, ...p.more].filter((x) => x.type === 'place')) {
      const city = s.short.slice(3);
      expect([city, (await ask(CRM, city)).total]).toEqual([city, s.count]);
    }
    expect((await ask(CRM, 'Austin')).total).toBe((await ask(CRM, 'in Austin')).total);
    expect((await ask(LP, 'Chicago')).total).toBe(who(LP, (c) => cityOf(c) === 'Chicago').length);
    expect((await ask(LP, 'Chicago')).total).toBeGreaterThan(0);
  });

  test('ask-7: a company typed alone is the company chip', async () => {
    for (const name of ['Marlowe Department Stores', 'Bayview Health System']) {
      const out = await ask(CRM, name);
      expect([name, out.filters.companies, out.total]).toEqual([name, [name], atCompany(CRM, name).length]);
    }
  });

  test('ask-8: a company after "in" is the company, unless it is a city of the file', async () => {
    expect((await ask(VC, 'who do I know in Stripe')).total).toBe(atCompany(VC, 'Stripe').length);
    expect((await ask(VC, 'people in Goldman Sachs')).total).toBe(atCompany(VC, 'Goldman Sachs').length);
    expect((await ask(VC, 'who do I know in Stripe')).notes.join(' ')).not.toMatch(/location/);
    expect((await ask(HC, 'Who do I know in Austin?')).filters.locations).toEqual(['Austin']);
  });

  test('ask-9: "in the UK" and "the United Kingdom"', async () => {
    const uk = (await ask(CRM, 'people in UK')).total;
    expect(uk).toBeGreaterThan(0);
    expect((await ask(CRM, 'Who is in the UK')).total).toBe(uk);
    expect((await ask(CRM, 'people in the United Kingdom')).total).toBe(uk);
    expect((await ask(CRM, 'who is in the uk')).total).toBe(uk);
  });

  test('ask-20 / ask-m4: companies after "of", "on" and "from"', async () => {
    const ceo = await ask(CRM, 'Who is the CEO of Marlowe Department Stores');
    expect(ceo.filters).toMatchObject({ companies: ['Marlowe Department Stores'], roles: ['ceos'] });
    expect(ceo.total).toBe(atCompany(CRM, 'Marlowe Department Stores').filter(nameRe(/\b(ceo|chief executive)\b/i)).length);
    const dd = await ask(VC, 'diligence on Stripe');
    expect(dd.filters.companies).toEqual(['Stripe']);
    expect(dd.total).toBeLessThanOrEqual(atCompany(VC, 'Stripe').length);
    const two = await ask(VC, 'people from Stripe and Google');
    expect([two.filters.companies, two.intent]).toEqual([['Stripe', 'Google'], 'who-at']);
    expect(two.total).toBe(atCompany(VC, 'Stripe').length + atCompany(VC, 'Google').length);
  });
});

// ------------------------------------------------------------ roles

describe('roles', () => {
  test('ask-10: a tag that is an everyday word ("warm") is the tag', async () => {
    const warm = who(LP, (c) => tagsOf(c).includes('warm'));
    expect((await ask(LP, 'warm')).total).toBe(warm.length);
    expect((await ask(LP, 'warm investors')).total).toBe(warm.filter((c) => familyOf(c).key === 'investors').length);
  });

  test('ask-12: nurses, surgeons and doctors are narrower than clinicians', async () => {
    const clinicians = who(HC, (c) => familyOf(c).key === 'clinicians');
    const nurses = await ask(HC, 'nurses');
    expect(nurses.total).toBe(clinicians.filter(nameRe(/\b(nurse|nursing|rn|np|crna|lpn)\b/i)).length);
    expect(nurses.total).toBeGreaterThan(0);
    expect(nurses.total).toBeLessThan(clinicians.length);
    expect(nurses.understood).toEqual(['Nurses']);
    expect((await ask(HC, 'which nurses do I know')).understood).toEqual(['Nurses']);
    expect((await ask(HC, 'surgeons')).total).toBeLessThan(clinicians.length);
    const all = await ask(HC, 'Which clinicians do I know?');
    expect([all.total, all.understood]).toEqual([clinicians.length, ['Clinicians']]);
  });

  test('ask-13: head of product, VPs and managing directors', async () => {
    const execs = (await ask(VC, 'executives')).total;
    const hop = await ask(VC, 'head of product');
    expect(hop.filters.roles).toEqual(['product managers']);
    expect(hop.total).toBeLessThan(execs);
    for (const [q, re] of [['VPs', /\b(vp|vice president|svp|evp)\b/i], ['managing directors', /\bmanaging director\b/i]]) {
      const out = await ask(VC, q);
      expect([q, out.total]).toEqual([q, who(VC, nameRe(re)).length]);
      expect(out.total).toBeLessThan(execs);
    }
  });

  test('ask-14: "senior people at Meta" is the senior people at Meta', async () => {
    const meta = atCompany(VC, 'Meta');
    const out = await ask(VC, 'senior people at Meta');
    expect(out.total).toBe(meta.filter((c) => seniority(c) === 0).length);
    expect(out.understood).toEqual(['At Meta', 'Senior leaders']);
  });

  test('ask-15: LPs, allocators, endowments and family offices are the allocators', async () => {
    for (const file of [VC, LP]) {
      const lps = who(file, (c) => classifyContact(c).role === 'lp');
      for (const q of ['LPs', 'allocators', 'endowment staff', 'family offices']) {
        const out = await ask(file, q);
        expect([file, q, out.total]).toEqual([file, q, lps.length]);
      }
    }
    expect((await ask(LP, 'LPs')).understood).toEqual(['LPs and allocators']);
  });

  test('ask-25: the answer names things as the user and the file do', async () => {
    expect((await ask(VC, 'Which CEOs do I know?')).understood).toEqual(['CEOs']);
    expect((await ask(CRM, 'who is in london')).understood).toEqual(['In London']);
    expect((await ask(VC, "who's at google")).understood).toEqual(['At Google']);
    expect(understoodOf({ roles: ['ctos'] })).toEqual(['CTOs']);
  });
});

// ------------------------------------------------------------ dates

describe('dates', () => {
  const inRange = (file, from, to) => who(file, (c) => c.connectedOn && c.connectedOn >= from && c.connectedOn <= to).length;

  test('ask-16: "last month", "last week", "past year"', async () => {
    expect((await ask(VC, 'last month')).total).toBe((await ask(VC, 'in the last month')).total);
    expect((await ask(VC, 'last month')).total).toBeGreaterThan(0);
    expect((await ask(VC, 'last week')).filters.connected).toMatchObject({ kind: 'last', days: 7 });
    expect((await ask(VC, 'people I connected with past year')).total).toBe((await ask(VC, 'in the last 12 months')).total);
    // "last year" alone stays the calendar year.
    expect((await ask(VC, 'connections from last year')).total).toBe(inRange(VC, '2025-01-01', '2025-12-31'));
  });

  test('ask-21: the old-export chip\'s words', async () => {
    const out = await ask(SMALL, 'connected in the 12 months before this export');
    const p = profileNetwork(S[SMALL], { today: TODAY });
    const chip = [...p.shortcuts, ...p.more].find((s) => s.id === 'recent');
    expect(chip).toBeDefined();
    expect(out.total).toBe(chip.count);
    expect((await ask(SMALL, 'Who connected in the 12 months before this export?')).total).toBe(chip.count);
  });

  test('ask-23: quarters, ranges, bare years, early years', async () => {
    const q1 = await ask(VC, 'in Q1 2025');
    expect([q1.filters.locations, q1.total]).toEqual([[], inRange(VC, '2025-01-01', '2025-03-31')]);
    expect(q1.notes.join(' ')).not.toMatch(/location/);
    expect((await ask(VC, 'between 2020 and 2022')).total).toBe(inRange(VC, '2020-01-01', '2022-12-31'));
    expect((await ask(VC, 'my 2024 connections')).total).toBe(inRange(VC, '2024-01-01', '2024-12-31'));
    expect((await ask(VC, '2024')).total).toBe(inRange(VC, '2024-01-01', '2024-12-31'));
    expect((await ask(VC, 'people from 2024')).total).toBe(inRange(VC, '2024-01-01', '2024-12-31'));
    const old = await ask(VC, 'connected in 1985');
    expect([old.filters.keywords, old.filters.connected?.from, old.total]).toEqual([[], '1985-01-01', 0]);
  });
});

// ------------------------------------------------------------ the fallback

describe('the fallback', () => {
  test('ask-17: people of the file by name', async () => {
    const full = S[CRM][0].name;
    const out = await ask(CRM, `who knows ${full}`);
    expect(out.results.map((r) => r.contact.name)).toContain(full);
    expect((await ask(CRM, `Who is ${full}`)).total).toBeGreaterThan(0);
    const last = full.split(' ').pop();
    const find = await ask(CRM, `find ${last}`);
    expect(find.total).toBe(who(CRM, (c) => c.name.split(/\s+/).includes(last)).length);
  });

  test('ask-18: plurals find singular titles', async () => {
    const one = (await ask(HC, 'cardiologist')).total;
    expect(one).toBeGreaterThan(0);
    expect((await ask(HC, 'cardiologists')).total).toBe(one);
  });

  test('ask-m3 (decision 11): "diligence" alone asks for a company or a field when it would list most of the file', async () => {
    const out = await ask(CRM, 'who can help with diligence');
    expect(out.total).toBe(0);
    expect(out.notes.join(' ')).toMatch(/Name a company or a field/);
    expect(out.notes.join(' ')).not.toMatch(/\b(Raise|Source|Diligence)\b/);
  });
});

// ------------------------------------------------------------ the route

describe('POST /api/network/query', () => {
  const route = require('../../../src/pages/api/network/query').default;
  const { __resetModelReadsForTests, MODEL_READS_PER_HOUR } = require('../../../src/pages/api/network/query');
  const res = () => {
    const r = { statusCode: 200, headers: {}, body: null };
    r.status = (code) => { r.statusCode = code; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    return r;
  };
  const send = (body) => S[CRM].map((c) => ({ key: dedupeKey(c), name: c.name, company: c.company, position: c.position, location: c.location, connectedOn: c.connectedOn, source: c.source, tags: c.tags, ...body }));
  const post = async (body) => { const r = res(); await route({ method: 'POST', headers: {}, body }, r); return r; };

  test('ask-m2: no contacts is 400 and the model is never called', async () => {
    chatComplete.mockResolvedValue({ text: '{"keywords":["x"]}' });
    const r = await post({ question: 'tell me something interesting please' });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).not.toMatch(/\b(API|key|token|free|paid|tier|quota)\b/i);
    expect(chatComplete).not.toHaveBeenCalled();
  });

  test('ask-m2: signed out, the model is not used at all', async () => {
    chatComplete.mockResolvedValue({ text: '{"keywords":["x"]}' });
    const r = await post({ question: 'tell me something interesting please', contacts: send({}) });
    expect(r.statusCode).toBe(200);
    expect(r.body.parsedBy).toBe('rules');
    expect(chatComplete).not.toHaveBeenCalled();
  });

  test('signed in, the model reads only typed questions, at most a few an hour', async () => {
    __resetModelReadsForTests();
    getUserId.mockResolvedValue('user-1');
    store.listContacts.mockResolvedValue(S[CRM]);
    chatComplete.mockResolvedValue({ text: '{"roles":["recruiters"]}' });
    const typed = await post({ question: 'who hires people like me' });
    expect([typed.body.contactsFrom, typed.body.parsedBy]).toEqual(['saved', 'llm']);
    expect(chatComplete).toHaveBeenCalledTimes(1);
    const built = await post({ question: 'who hires people like me', fromPage: true });
    expect(built.body.parsedBy).toBe('rules');
    const intro = await post({ target: 'Marlowe Department Stores' });
    expect([intro.body.parsedBy, intro.body.total]).toEqual(['target', atCompany(CRM, 'Marlowe Department Stores').length]);
    expect(chatComplete).toHaveBeenCalledTimes(1);
    for (let i = 1; i < MODEL_READS_PER_HOUR + 3; i += 1) await post({ question: 'who hires people like me' });
    expect(chatComplete).toHaveBeenCalledTimes(MODEL_READS_PER_HOUR);
  });

  test('page-m1: the question is answered over the people in view', async () => {
    getUserId.mockResolvedValue('user-1');
    const firm = S[CRM].slice(0, 40).map((c) => ({ ...c, relationship: 'firm', via: 'A colleague' }));
    const mixed = [...firm, ...S[CRM].slice(40).map((c, i) => ({ ...c, source: i % 2 ? 'csv' : 'attio' }))];
    store.listContacts.mockResolvedValue(mixed);
    const want = (test) => mixed.filter((c) => tagsOf(c).includes('prospect') && test(c));
    const all = await post({ question: 'prospects', llm: false });
    expect(all.body.total).toBe(want(() => true).length);
    const csvOnly = await post({ question: 'prospects', llm: false, filters: { sources: ['csv'] } });
    expect(csvOnly.body.total).toBe(want((c) => c.source === 'csv').length);
    expect(csvOnly.body.contactCount).toBe(mixed.filter((c) => c.source === 'csv').length);
    const direct = await post({ question: 'prospects', llm: false, filters: { directOnly: true } });
    expect(direct.body.total).toBe(want((c) => c.relationship !== 'firm').length);
    expect(direct.body.keys.length).toBe(direct.body.total);
    // Signed out, the same filters apply to the people sent.
    getUserId.mockResolvedValue(null);
    const out = await post({ question: 'prospects', llm: false, contacts: send({ relationship: 'firm' }).slice(0, 10).concat(send({}).slice(10)), filters: { directOnly: true } });
    expect(out.body.total).toBe(S[CRM].slice(10).filter((c) => tagsOf(c).includes('prospect')).length);
  });

  test('ask-24: "this year" is the user\'s year, from the browser\'s date', async () => {
    // The server's clock says 31 December; the user is already in the new year.
    jest.useFakeTimers({ now: Date.parse('2026-12-31T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      const r = await post({ question: 'people I connected with this year', llm: false, today: '2027-01-01', contacts: send({}) });
      expect(r.body.filters.connected).toMatchObject({ from: '2027-01-01', to: '2027-12-31' });
      // A date far from the server's is ignored.
      const odd = await post({ question: 'people I connected with this year', llm: false, today: '1999-01-01', contacts: send({}) });
      expect(odd.body.filters.connected.from).toBe('2026-01-01');
    } finally {
      jest.useRealTimers();
    }
  });
});
